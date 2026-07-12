"""
stampede_shield/ml_bridge.py  —  StampedeShield Python ML Bridge
=================================================================

WebSocket server on port 8081.
Accepts sensor frames from Node.js server.js and returns enriched
ML + fusion analysis packets.

Architecture:
    Node.js  →  { type:"sensor_frame", sensors:[int×6] }
             →  ws://localhost:8081
             ←  { type:"ml_result", status, risk_score, ...all fields... }

Per-connection MLSession maintains independent state:
    Step 1  Kalman Pre-Filter   6× KalmanFilter1D — smooths FSR noise
    Step 2  LSTM Inference      20-frame sliding window
                                None for first 19 frames (warm-up)
                                Provider: QNN NPU → CPU INT8 → CPU FP32
    Step 3  Strategy B Fusion   SPC + EWMA + CUSUM + Z-Score + LSTM
                                4-case weighted fusion logic

Start command:
    python -m stampede_shield.ml_bridge
    — or —
    python stampede_shield/ml_bridge.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Optional

# Add project root so sibling packages resolve
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import websockets

from algorithms.kalman_filter  import KalmanFilter1D
from fusion.fusion_engine      import FusionEngine
from ml.lstm_inference         import LSTMInferenceEngine

# ── Configuration ──────────────────────────────────────────────
ML_BRIDGE_HOST = "localhost"
ML_BRIDGE_PORT = 8081
# ───────────────────────────────────────────────────────────────


class MLSession:
    """
    Per-connection ML processing session.

    Each time Node.js connects a fresh session is created so that
    the Kalman filters and LSTM window start from a clean state.

    Public API:
        result_dict, smoothed_list = session.process(raw_sensors)
    """

    def __init__(self) -> None:
        print("[MLSession] Initialising new session ...")

        # Step 1 — 6 independent Kalman filters (one per sensor)
        self.kalman: list[KalmanFilter1D] = [KalmanFilter1D() for _ in range(6)]

        # Step 3 — Strategy B fusion engine
        self.fusion = FusionEngine(
            strategy="B",
            baseline_mean=10.0,
            baseline_sigma=2.0,
        )

        # Step 2 — LSTM inference (optional: runs only if model file exists)
        self.lstm: Optional[LSTMInferenceEngine] = None
        try:
            self.lstm = LSTMInferenceEngine()
        except FileNotFoundError as exc:
            print(f"[MLSession] WARNING: LSTM model not found — {exc}")
            print("[MLSession] Running without LSTM (warmup algo-vote only).")

        print("[MLSession] SUCCESS: Ready")

    # ── Core pipeline ─────────────────────────────────────────

    def process(self, raw_sensors: list) -> tuple[dict, list[float]]:
        """
        Full 3-step pipeline for a single sensor frame.

        Args:
            raw_sensors: list of 6 raw ADC integers (0–1023)

        Returns:
            (fused_dict, smoothed_sensors_list)
        """
        # Step 1 — Kalman smooth
        smoothed: list[float] = [
            self.kalman[i].update(float(raw_sensors[i]))
            for i in range(6)
        ]

        # Step 2 — LSTM (returns None during first 19-frame warm-up)
        ml_result: Optional[dict] = None
        if self.lstm is not None:
            ml_result = self.lstm.push_frame(smoothed)

        # Step 3 — Strategy B fusion
        fused = self.fusion.process(raw_sensors=smoothed, ml_result=ml_result)

        return fused, smoothed

    @property
    def lstm_ready(self) -> bool:
        return self.lstm is not None and self.lstm.is_warmed_up


# ── WebSocket connection handler ────────────────────────────────

async def handle_connection(websocket):
    """
    Called for every new Node.js connection.
    Creates a fresh MLSession and processes sensor_frame messages.
    """
    addr = websocket.remote_address
    print(f"[Bridge] Node.js connected from {addr[0]}:{addr[1]}")
    session = MLSession()

    try:
        async for raw_msg in websocket:

            # ── Parse incoming message ────────────────────────
            try:
                data = json.loads(raw_msg)
            except json.JSONDecodeError:
                continue

            if data.get("type") != "sensor_frame":
                continue

            sensors = data.get("sensors")
            if not isinstance(sensors, list) or len(sensors) != 6:
                continue

            # ── Run ML pipeline, measure latency ─────────────
            t0 = time.perf_counter()
            fused, smoothed = session.process(sensors)
            bridge_ms = round((time.perf_counter() - t0) * 1000, 2)

            # ── Build response packet ─────────────────────────
            result = {
                "type":               "ml_result",
                # Core decision
                "status":             fused.get("status",           "SAFE"),
                "risk_score":         fused.get("risk_score",       0),
                "fusion_reason":      fused.get("fusion_reason",    ""),
                "strategy":           fused.get("strategy",         "StrategyB"),
                # Algorithm ensemble
                "algorithm_votes":    fused.get("algorithm_votes",  0),
                "algorithms_alarming":fused.get("algorithms_alarming", []),
                "spatial_pattern":    fused.get("spatial_pattern",  ""),
                "recommended_action": fused.get("recommended_action",""),
                # Per-algorithm detail
                "spc":                fused.get("spc"),
                "ewma":               fused.get("ewma"),
                "cusum":              fused.get("cusum"),
                "zscore":             fused.get("zscore"),
                "ml":                 fused.get("ml"),
                # Sensor data
                "smoothed_sensors":   [round(v, 2) for v in smoothed],
                # Meta
                "lstm_ready":         session.lstm_ready,
                "bridge_ms":          bridge_ms,
            }

            await websocket.send(json.dumps(result))

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:
        print(f"[Bridge] Unexpected error from {addr}: {exc}")
    finally:
        print(f"[Bridge] Node.js {addr[0]}:{addr[1]} disconnected")


# ── Entry point ─────────────────────────────────────────────────

async def main():
    print("\n" + "=" * 58)
    print("  StampedeShield  —  Python ML Bridge  v1")
    print("=" * 58)
    print(f"  WebSocket server : ws://{ML_BRIDGE_HOST}:{ML_BRIDGE_PORT}")
    print(f"  Pipeline         : Kalman -> LSTM (20fr) -> Strategy B")
    print(f"  Awaiting Node.js connection ...\n")

    async with websockets.serve(
        handle_connection,
        ML_BRIDGE_HOST,
        ML_BRIDGE_PORT,
        ping_interval=20,
        ping_timeout=10,
    ):
        await asyncio.Future()   # run until Ctrl+C


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Bridge] Stopped.")
