"""
lstm_inference.py  —  StampedeShield
Purpose : NPU-accelerated LSTM inference engine using ONNX Runtime.

Provider priority:
    1. QnnExecutionProvider    — Qualcomm Hexagon NPU  (Snapdragon X Elite)
    2. CUDAExecutionProvider   — NVIDIA GPU fallback
    3. CPUExecutionProvider    — CPU fallback (always available)

The engine automatically selects the best available provider at startup
and prints which backend it is using.

Public API:
    engine = LSTMInferenceEngine()
    result = engine.push_frame([f1n, f2n, f3n, f4n, f5n, f6n])
    # Returns: {"label": "SAFE"|"WATCH"|"HIGH"|"CRITICAL", "confidence": float}
    # Returns: None during the first SEQ_LEN-frame warmup period.

Input values should be the PRE-NORMALIZED sensor readings (0.0–1.0),
i.e., the raw ADC value divided by 515.0 (max expected value with 220Ω resistor).
"""

from __future__ import annotations

import os
import threading
import numpy as np
from pathlib import Path
from collections import deque
from typing import Optional

import onnxruntime as ort

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────
SEQ_LEN      = 20
NUM_FEATURES = 6
LABELS       = ["SAFE", "WATCH", "HIGH", "CRITICAL"]
ADC_MAX      = 515.0   # approximate maximum ADC reading with 220Ω pull-down

ML_DIR       = Path(__file__).resolve().parent
INT8_PATH    = ML_DIR / "lstm_model_int8.onnx"
FP32_PATH    = ML_DIR / "lstm_model.onnx"


def _pick_model_path() -> Path:
    """Prefer quantized INT8 model; fall back to FP32 if INT8 not yet built."""
    if INT8_PATH.exists():
        return INT8_PATH
    if FP32_PATH.exists():
        print("[LSTMInference] WARNING: INT8 model not found; using FP32 fallback.")
        return FP32_PATH
    raise FileNotFoundError(
        f"No ONNX model found in {ML_DIR}. "
        "Run `python -m ml.train_lstm` first to train and export the model."
    )


def _build_session(model_path: Path) -> tuple[ort.InferenceSession, str]:
    """
    Build ONNX Runtime inference session with best available provider.
    Returns (session, provider_name_used).
    """
    # QNN provider options — point at Qualcomm HTP (Hexagon) backend
    qnn_options = {
        "backend_path": r"QnnHtp.dll",   # QNN SDK must be in PATH
        "profiling_level": "off",
        "enable_htp_fp16_precision": "1",  # Use FP16 internally on NPU for speed
    }

    provider_candidates = [
        ("QnnExecutionProvider",  [qnn_options]),
        ("CUDAExecutionProvider", [{}]),
        ("CPUExecutionProvider",  [{}]),
    ]

    available = {p[0] for p in ort.get_all_providers()}

    for name, opts in provider_candidates:
        if name not in available and name != "CPUExecutionProvider":
            continue
        try:
            sess = ort.InferenceSession(
                str(model_path),
                providers=[name, "CPUExecutionProvider"],
                provider_options=opts + [{}],
            )
            actual = sess.get_providers()[0]
            return sess, actual
        except Exception as exc:
            print(f"[LSTMInference] Provider {name} failed: {exc}. Trying next…")

    raise RuntimeError("Could not create ONNX Runtime session with any provider.")


# ──────────────────────────────────────────────────────────────────────────────
# Inference Engine
# ──────────────────────────────────────────────────────────────────────────────
class LSTMInferenceEngine:
    """
    NPU-accelerated LSTM inference engine for StampedeShield.

    Thread-safe: a threading.Lock guards the sliding window buffer and
    session calls so the engine can be safely called from the serial
    reader thread and the WebSocket broadcast thread simultaneously.

    Args:
        model_path: Optional path to ONNX model file.
                    Defaults to ml/lstm_model_int8.onnx.
        seq_len:    Sequence (window) length in frames. Must match the
                    trained model. Default: 20.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        seq_len: int = SEQ_LEN,
    ) -> None:
        self._seq_len = seq_len
        self._lock    = threading.Lock()

        # Sliding window buffer: deque of lists, each list = 6 floats (normalized)
        self._window: deque[list[float]] = deque(maxlen=seq_len)

        # Load model
        path = Path(model_path) if model_path else _pick_model_path()
        print(f"[LSTMInference] Loading model: {path.name}")

        self._session, self._provider = _build_session(path)
        self._input_name = self._session.get_inputs()[0].name

        print(f"[LSTMInference] Ready -- provider: {self._provider}")

    # ── Public API ─────────────────────────────────────────────────────────────

    def push_frame(self, smoothed_sensors: list) -> Optional[dict]:
        """
        Accept one frame of 6 Kalman-smoothed RAW ADC values (0–1023 range).
        Normalizes them internally before feeding the LSTM.

        Returns:
            None  — during the first seq_len-frame warmup.
            dict  — {"label": str, "confidence": float} once warmed up.
        """
        with self._lock:
            # Normalize raw ADC → 0.0–1.0 (same scale as training data F1n–F6n)
            normalized = [min(1.0, float(v) / ADC_MAX) for v in smoothed_sensors]
            self._window.append(normalized)

            if len(self._window) < self._seq_len:
                return None  # still warming up

            return self._infer()

    def push_normalized_frame(self, normalized_sensors: list) -> Optional[dict]:
        """
        Accept one frame of 6 already-normalized values (0.0–1.0).
        Use this when the caller has already divided by ADC_MAX.
        """
        with self._lock:
            self._window.append([float(v) for v in normalized_sensors])
            if len(self._window) < self._seq_len:
                return None
            return self._infer()

    def reset(self) -> None:
        """Clear the sliding window (call on sensor reconnect / venue change)."""
        with self._lock:
            self._window.clear()

    @property
    def is_warmed_up(self) -> bool:
        return len(self._window) >= self._seq_len

    @property
    def frames_until_ready(self) -> int:
        return max(0, self._seq_len - len(self._window))

    @property
    def provider(self) -> str:
        """Name of the execution provider actually being used."""
        return self._provider

    # ── Internal ───────────────────────────────────────────────────────────────

    def _infer(self) -> dict:
        """Run one forward pass. Caller must hold self._lock."""
        # Build input array: (1, seq_len, 6) float32
        x = np.array(list(self._window), dtype=np.float32).reshape(1, self._seq_len, NUM_FEATURES)

        # Run on NPU/CPU
        logits = self._session.run(None, {self._input_name: x})[0]  # (1, 4)

        # Softmax for probabilities
        e       = np.exp(logits - logits.max())
        probs   = (e / e.sum())[0]

        best_idx    = int(probs.argmax())
        label       = LABELS[best_idx]
        confidence  = float(probs[best_idx])

        return {
            "label":        label,
            "confidence":   round(confidence, 4),
            "probabilities": {
                "SAFE":     round(float(probs[0]), 4),
                "WATCH":    round(float(probs[1]), 4),
                "HIGH":     round(float(probs[2]), 4),
                "CRITICAL": round(float(probs[3]), 4),
            },
        }
