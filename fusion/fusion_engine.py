"""
fusion_engine.py  —  StampedeShield
Hardware: Snapdragon X Elite PC (Python 3.11 x86-64)
Purpose : Complete multi-algorithm decision fusion engine.

Implements THREE strategies from Algorithm_Deep_Dive.md:

  Strategy A — Sequential  : SPC gates ML.  Fast path when crowd is calm.
  Strategy B — Parallel + Fusion : SPC + EWMA + CUSUM + Z-Score all run, output merged
               with weighted logic.  Contains 4 case branches from the deep-dive doc.
  Strategy C — ML Primary, SPC Safety Net (recommended for production).

Also exposes MultiAlgorithmStack — the pure statistical voting approach (no ML)
from Part 2 of Algorithm_Deep_Dive.md.  All algorithms run in parallel; alert on ≥2 votes.

Thread safety: a threading.Lock guards all shared mutable state.  The fusion engine
is safe to call from the serial-reader background thread.

Public API (all strategies accept the same arguments):
    engine = FusionEngine(strategy="C")
    result = engine.process(raw_sensors=[...], ml_result={...} | None)

Output dict structure is identical regardless of strategy so the dashboard/WebSocket
relay never needs to know which strategy is active.
"""

from __future__ import annotations

import time
import threading
from typing import Optional

from algorithms.spc_engine     import SPCEngine
from algorithms.ewma_monitor   import EWMAMonitor
from algorithms.cusum_monitor  import CUSUMMonitor
from algorithms.zscore_monitor import ZScoreMonitor
from algorithms.kalman_filter  import KalmanFilter1D


# ─────────────────────────────────────────────────────────────────────────────
# Shared constants
# ─────────────────────────────────────────────────────────────────────────────

STATUS_ORDER = ["SAFE", "WATCH", "HIGH", "CRITICAL"]
RISK_MAP     = {"SAFE": 5, "WATCH": 40, "HIGH": 75, "CRITICAL": 92}

# Sensor adjacency pairs — for spatial pattern labelling
_ADJACENCIES = {
    frozenset({1, 4}): "Cluster at F2+F5 (center column)",
    frozenset({2, 5}): "Cluster at F3+F6 (right column) — highest risk",
    frozenset({0, 3}): "Cluster at F1+F4 (left column)",
    frozenset({0, 1, 2}): "Full front row pressure",
    frozenset({3, 4, 5}): "Full rear row pressure",
}

_ACTIONS = {
    "SAFE":     "Monitor — no action required",
    "WATCH":    "Alert zone supervisor — increased crowd density detected",
    "HIGH":     "Deploy crowd control officers to zone immediately",
    "CRITICAL": "EVACUATE ZONE — deploy all officers and medical personnel NOW",
}


def _max_status(a: str, b: str) -> str:
    """Return the higher-severity status of the two."""
    return b if STATUS_ORDER.index(b) > STATUS_ORDER.index(a) else a


def _detect_spatial_pattern(sensor_violations: list[int], sensors: list[float], ucl: float) -> str:
    """
    Map violated sensor indices to a named spatial pattern string.

    Args:
        sensor_violations: list of sensor indices (0-based) whose value exceeded UCL.
        sensors:           current raw sensor readings.
        ucl:               upper control limit from the SPC engine.
    """
    v = frozenset(sensor_violations)

    if not v:
        return "No spatial anomaly"

    # Check named patterns
    for pattern_set, name in _ADJACENCIES.items():
        if pattern_set.issubset(v):
            return name

    if len(v) >= 4:
        return "Distributed crush — all zones"

    if len(v) == 1:
        idx = next(iter(v))
        return f"Isolated spike at F{idx + 1}"

    indices_str = "+".join(f"F{i + 1}" for i in sorted(v))
    return f"Multi-sensor pressure at {indices_str}"


def _build_recommended_action(status: str, algorithm_votes: int) -> str:
    base = _ACTIONS.get(status, "Monitor")
    if algorithm_votes >= 3:
        base = "CONSENSUS ALERT — " + base
    return base


# ─────────────────────────────────────────────────────────────────────────────
# Pure statistical multi-algorithm stack (no ML)
# ─────────────────────────────────────────────────────────────────────────────

class MultiAlgorithmStack:
    """
    Runs SPC + EWMA + CUSUM + Z-Score in parallel on every frame.
    Fires an alert when at least 2 algorithms agree (vote-based consensus).

    This is the approach documented in Part 2 of Algorithm_Deep_Dive.md.
    Use when no LSTM model is available yet (e.g. first day of deployment).

    Args:
        baseline_mean:  Idle crowd pressure baseline (ADC units).
        baseline_sigma: Idle crowd pressure std deviation (ADC units).
    """

    def __init__(
        self,
        baseline_mean:  float = 10.0,
        baseline_sigma: float = 2.0,
    ) -> None:
        self.spc    = SPCEngine(window_size=60, baseline_mu=baseline_mean, baseline_sigma=baseline_sigma)
        self.ewma   = EWMAMonitor(lam=0.2,  baseline_mean=baseline_mean, baseline_sigma=baseline_sigma)
        self.cusum  = CUSUMMonitor(mu=baseline_mean, sigma=baseline_sigma)
        self.zscore = ZScoreMonitor(window=30)
        self.kalman = [KalmanFilter1D() for _ in range(6)]
        self._lock  = threading.Lock()

    def process(self, raw_sensors: list) -> dict:
        """
        Process one frame of raw sensor data (6 ADC values).

        Returns a dict containing per-algorithm results, vote count, consensus flag,
        final status, risk score, and recommended action.
        """
        with self._lock:
            smoothed = [self.kalman[i].update(float(raw_sensors[i])) for i in range(6)]
            avg = sum(smoothed) / 6

            spc_r    = self.spc.process(smoothed)
            ewma_r   = self.ewma.update(avg)
            cusum_r  = self.cusum.update(avg)
            zscore_r = self.zscore.update(avg)

            # ── Voting ─────────────────────────────────────────────────────────
            votes: list[str] = []
            if spc_r["spc_state"] != "Stable":
                votes.append("SPC")
            if ewma_r["out_of_control"]:
                votes.append("EWMA")
            if cusum_r["alarm_high"]:
                votes.append("CUSUM")
            if abs(zscore_r["z_score"]) > 2.5:
                votes.append("Z-Score")

            n_votes = len(votes)
            consensus_alert = n_votes >= 2

            # ── Status from votes ──────────────────────────────────────────────
            if n_votes >= 4:
                status, risk = "CRITICAL", 92
            elif n_votes == 3:
                status, risk = "HIGH",     75
            elif n_votes == 2:
                status, risk = "WATCH",    40
            else:
                # 1 vote — could be a transient false alarm, stay at WATCH cautiously
                if n_votes == 1:
                    status, risk = "WATCH", 30
                else:
                    status, risk = "SAFE",  5

            # Override: SPC Rule 1 (single point UCL breach) alone escalates immediately
            if spc_r["rule_fired"] == 1:
                status = _max_status(status, "HIGH")
                risk   = max(risk, 72)

            spatial = _detect_spatial_pattern(
                spc_r.get("sensor_violations", []),
                smoothed,
                spc_r["controlLimits"]["ucl"]
            )

            return {
                "status":              status,
                "risk_score":          risk,
                "timestamp_ms":        int(time.time() * 1000),
                "strategy":            "MultiAlgorithmVoting",
                "algorithm_votes":     n_votes,
                "algorithms_alarming": votes,
                "consensus_alert":     consensus_alert,
                "spatial_pattern":     spatial,
                "recommended_action":  _build_recommended_action(status, n_votes),
                "spc":    _slim_spc(spc_r),
                "ewma":   _slim_ewma(ewma_r),
                "cusum":  _slim_cusum(cusum_r),
                "zscore": _slim_zscore(zscore_r),
                "ml":     None,
            }


# ─────────────────────────────────────────────────────────────────────────────
# Full fusion engine — all 3 strategies
# ─────────────────────────────────────────────────────────────────────────────

class FusionEngine:
    """
    Multi-strategy fusion engine combining statistical algorithms with ML inference.

    Choose a strategy at init time:
        "A" — Sequential   : SPC gates ML; ML only runs when SPC detects anomaly.
        "B" — Parallel     : All algorithms + ML run every frame; output merged with
                             weighted 4-case fusion logic.
        "C" — ML Primary   : ML is primary; SPC/EWMA/CUSUM are safety nets that can
                             ONLY escalate, never suppress.  (Recommended for production.)

    Args:
        strategy:       "A", "B", or "C" (default: "C").
        baseline_mean:  Idle crowd pressure (ADC units).
        baseline_sigma: Idle standard deviation (ADC units).
    """

    def __init__(
        self,
        strategy: str = "B",
        baseline_mean:  float = 10.0,
        baseline_sigma: float = 2.0,
    ) -> None:
        if strategy not in ("A", "B", "C"):
            raise ValueError(f"strategy must be 'A', 'B', or 'C'; got '{strategy}'")
        self.strategy = strategy

        self.spc    = SPCEngine(window_size=60, baseline_mu=baseline_mean, baseline_sigma=baseline_sigma)
        self.ewma   = EWMAMonitor(lam=0.2,  baseline_mean=baseline_mean, baseline_sigma=baseline_sigma)
        self.cusum  = CUSUMMonitor(mu=baseline_mean, sigma=baseline_sigma)
        self.zscore = ZScoreMonitor(window=30)
        self.kalman = [KalmanFilter1D() for _ in range(6)]

        self._lock = threading.Lock()

    # ── Public entry point ────────────────────────────────────────────────────

    def process(self, raw_sensors: list, ml_result: Optional[dict] = None) -> dict:
        """
        Fuse one frame of sensor data with (optional) LSTM inference output.

        Args:
            raw_sensors: list of 6 raw ADC values from Arduino (int or float, 0–1023).
            ml_result:   dict returned by LSTMInferenceEngine.push_frame(), or None
                         during the first 19-frame LSTM warmup period.

        Returns:
            Complete fused output dict.  Keys are identical regardless of strategy.
        """
        with self._lock:
            return self._process_locked(raw_sensors, ml_result)

    # ── Internal dispatch ─────────────────────────────────────────────────────

    def _process_locked(self, raw_sensors: list, ml_result: Optional[dict]) -> dict:
        # Step 1 — Kalman smooth each sensor
        smoothed = [self.kalman[i].update(float(raw_sensors[i])) for i in range(6)]
        avg = sum(smoothed) / 6

        # Step 2 — Run all statistical algorithms
        spc_r    = self.spc.process(smoothed)
        ewma_r   = self.ewma.update(avg)
        cusum_r  = self.cusum.update(avg)
        zscore_r = self.zscore.update(avg)

        # Step 3 — Strategy-specific fusion
        if self.strategy == "A":
            status, risk, reason = self._strategy_a(spc_r, ewma_r, ml_result)
        elif self.strategy == "B":
            status, risk, reason = self._strategy_b(spc_r, ewma_r, cusum_r, zscore_r, ml_result)
        else:  # "C"
            status, risk, reason = self._strategy_c(spc_r, ewma_r, cusum_r, zscore_r, ml_result)

        # Step 4 — Count alarming algorithms (for transparency)
        alarming: list[str] = []
        if spc_r["spc_state"] != "Stable":
            alarming.append("SPC")
        if ewma_r["out_of_control"]:
            alarming.append("EWMA")
        if cusum_r["alarm_high"]:
            alarming.append("CUSUM")
        if zscore_r["soft_anomaly"]:
            alarming.append("Z-Score")
        if ml_result and ml_result.get("label") in ("HIGH", "CRITICAL"):
            alarming.append("LSTM")

        spatial = _detect_spatial_pattern(
            spc_r.get("sensor_violations", []),
            smoothed,
            spc_r["controlLimits"]["ucl"]
        )

        return {
            "status":              status,
            "risk_score":          int(risk),
            "fusion_reason":       reason,
            "timestamp_ms":        int(time.time() * 1000),
            "strategy":            f"Strategy{self.strategy}",
            "spc":                 _slim_spc(spc_r),
            "ewma":                _slim_ewma(ewma_r),
            "cusum":               _slim_cusum(cusum_r),
            "zscore":              _slim_zscore(zscore_r),
            "ml":                  ml_result,
            "algorithm_votes":     len(alarming),
            "algorithms_alarming": alarming,
            "spatial_pattern":     spatial,
            "recommended_action":  _build_recommended_action(status, len(alarming)),
        }

    # ─────────────────────────────────────────────────────────────────────────
    # Strategy A — Sequential: SPC gates ML
    # ─────────────────────────────────────────────────────────────────────────

    def _strategy_a(self, spc_r, ewma_r, ml_result) -> tuple[str, int, str]:
        """
        SPC acts as fast pre-filter.  Only trust ML when SPC already detected something.

        - If SPC says Stable → output SAFE; skip ML (saves NPU compute).
        - If SPC is Drifting/Out-of-Control AND ML result is available → trust ML.
        - If SPC is alerting but ML is still warming up → use SPC status directly.
        """
        if spc_r["spc_state"] == "Stable":
            return "SAFE", 5, "spc_stable_gate"

        # SPC detected something — use ML if available
        if ml_result is not None:
            label = ml_result["label"]
            risk  = RISK_MAP[label]
            return label, risk, "spc_gate_ml_primary"

        # ML warming up — use SPC's own crowd status
        spc_status = spc_r["crowdStatus"]
        status_map = {"SAFE": "SAFE", "WATCH": "WATCH", "HIGH RISK": "CRITICAL"}
        status = status_map.get(spc_status, "WATCH")
        return status, spc_r["riskScore"], "spc_gate_no_ml"

    # ─────────────────────────────────────────────────────────────────────────
    # Strategy B — Parallel + Fusion (4-case weighted logic)
    # ─────────────────────────────────────────────────────────────────────────

    def _strategy_b(self, spc_r, ewma_r, cusum_r, zscore_r, ml_result) -> tuple[str, int, str]:
        """
        SPC + EWMA + CUSUM + Z-Score + ML all run every frame.
        Output merged with the 4-case fusion logic from Algorithm_Deep_Dive.md § Strategy B.

        Handles ML warmup by falling back to multi-algorithm vote.
        """
        spc_risk   = float(spc_r["riskScore"])
        spc_status = _spc_to_standard(spc_r["crowdStatus"])

        # ── ML warmup fallback ─────────────────────────────────────────────────
        if ml_result is None:
            votes = sum([
                spc_r["spc_state"] != "Stable",
                ewma_r["out_of_control"],
                cusum_r["alarm_high"],
                abs(zscore_r["z_score"]) > 2.5
            ])
            if votes >= 3: return "CRITICAL", 88, "warmup_4algo_vote"
            if votes >= 2: return "HIGH",     72, "warmup_4algo_vote"
            if votes >= 1: return "WATCH",    38, "warmup_4algo_vote"
            return "SAFE", 5, "warmup_safe"

        ml_label = ml_result["label"]
        ml_conf  = float(ml_result.get("confidence", 0.5))
        ml_risk  = float(RISK_MAP[ml_label])

        # ── Case 1: Both SPC and ML agree ─────────────────────────────────────
        if spc_status == ml_label:
            return ml_label, int(ml_risk), "consensus"

        # ── Case 2: SPC says CRITICAL but ML says SAFE (false alarm) ──────────
        if spc_status == "CRITICAL" and ml_label == "SAFE" and ml_conf > 0.85:
            return "WATCH", 35, "ml_override_spc_false_alarm"

        # ── Case 3: SPC says SAFE but ML says HIGH/CRITICAL (early detection) ─
        if spc_status == "SAFE" and ml_label in ("HIGH", "CRITICAL") and ml_conf > 0.80:
            return ml_label, int(ml_risk), "ml_early_detection"

        # ── Case 4: Low ML confidence → trust SPC more ────────────────────────
        if ml_conf < 0.60:
            blended = round(0.7 * spc_risk + 0.3 * ml_risk)
            return spc_status, blended, "spc_dominant"

        # ── Default: weighted blend ────────────────────────────────────────────
        blended = round(0.4 * ml_risk + 0.6 * spc_risk)
        if   blended >= 85: status = "CRITICAL"
        elif blended >= 70: status = "HIGH"
        elif blended >= 30: status = "WATCH"
        else:               status = "SAFE"
        return status, int(blended), "weighted_blend"

    # ─────────────────────────────────────────────────────────────────────────
    # Strategy C — ML Primary, SPC+EWMA+CUSUM as safety nets (RECOMMENDED)
    # ─────────────────────────────────────────────────────────────────────────

    def _strategy_c(self, spc_r, ewma_r, cusum_r, zscore_r, ml_result) -> tuple[str, int, str]:
        """
        ML is the primary decision maker.  Statistical algorithms can ONLY escalate
        the status — they can never suppress it.

        Implements exactly the logic from Algorithm_Deep_Dive.md § Strategy C plus
        the extended safety nets from the master implementation prompt:

          Safety net 1: SPC Rule 1 (instant UCL breach) escalates SAFE/WATCH → HIGH.
          Safety net 2: EWMA drift + ML=WATCH → escalate to HIGH.
          Safety net 3: CUSUM persistence + ML=HIGH + high ML confidence → CRITICAL.

        Suppression rule (false alarm): SPC=CRITICAL + ML=SAFE with ≥88% conf → WATCH.

        Handles ML warmup by falling back to 4-algo vote.
        """
        # ── ML warmup fallback ─────────────────────────────────────────────────
        if ml_result is None:
            votes = sum([
                spc_r["spc_state"] != "Stable",
                ewma_r["out_of_control"],
                cusum_r["alarm_high"],
                zscore_r["soft_anomaly"]
            ])
            if votes >= 3: return "CRITICAL", 88, "warmup_algo_vote"
            if votes >= 2: return "HIGH",     72, "warmup_algo_vote"
            if votes >= 1: return "WATCH",    38, "warmup_algo_vote"
            return "SAFE", 5, "warmup_safe"

        ml_label = ml_result["label"]
        ml_conf  = float(ml_result.get("confidence", 0.5))

        base_status = ml_label
        base_risk   = float(RISK_MAP[ml_label])
        reason      = "ml_primary"

        # ── Suppression: SPC says CRITICAL but ML says SAFE with high confidence
        # (concert/festival fixed-baseline false alarm)
        if (spc_r["spc_state"] == "Out of Control"
                and ml_label == "SAFE"
                and ml_conf > 0.88):
            base_status = "WATCH"
            base_risk   = max(base_risk, 30.0)
            reason      = "ml_suppressed_spc_false_alarm"
            # Do NOT run escalation nets after suppression
            return base_status, int(base_risk), reason

        # ── Safety net 1: SPC Rule 1 instant spike — escalate if ML hasn't caught up
        if spc_r["rule_fired"] == 1 and base_status in ("SAFE", "WATCH"):
            base_status = _max_status(base_status, "HIGH")
            base_risk   = max(base_risk, 72.0)
            reason      = "spc_rule1_escalation"

        # ── Safety net 2: EWMA drift + ML=WATCH → HIGH
        if ewma_r["out_of_control"] and base_status == "WATCH":
            base_status = "HIGH"
            base_risk   = max(base_risk, 71.0)
            reason      = "ewma_drift_escalation"

        # ── Safety net 3: CUSUM persistence + ML=HIGH + confident → CRITICAL
        if (cusum_r["alarm_high"]
                and base_status == "HIGH"
                and ml_conf > 0.75):
            base_status = "CRITICAL"
            base_risk   = max(base_risk, 90.0)
            reason      = "cusum_persistence_escalation"

        return base_status, int(base_risk), reason


# ─────────────────────────────────────────────────────────────────────────────
# Helper functions — slim the per-algorithm dicts for the output payload
# ─────────────────────────────────────────────────────────────────────────────

def _spc_to_standard(crowd_status: str) -> str:
    """Convert JS-style crowdStatus to standard 4-level label."""
    return {
        "SAFE":      "SAFE",
        "WATCH":     "WATCH",
        "HIGH RISK": "CRITICAL",
    }.get(crowd_status, "WATCH")


def _slim_spc(r: dict) -> dict:
    return {
        "state":             r["spc_state"],
        "reason":            r["spc_reason"],
        "rule_fired":        r.get("rule_fired"),
        "current_avg":       r["current_avg"],
        "spatial_std_dev":   r["spatial_std_dev"],
        "control_limits":    r["control_limits"],
        "sensor_violations": r.get("sensor_violations", []),
    }


def _slim_ewma(r: dict) -> dict:
    return {
        "ewma_value":    r["ewma_value"],
        "out_of_control":r["out_of_control"],
        "deviation":     r["deviation_from_mean"],
        "trend":         r["ewma_trend"],
    }


def _slim_cusum(r: dict) -> dict:
    return {
        "S_high":    r["S_high"],
        "S_low":     r["S_low"],
        "alarm_high":r["alarm_high"],
    }


def _slim_zscore(r: dict) -> dict:
    return {
        "z_score":    r["z_score"],
        "anomaly":    r["anomaly"],
        "rolling_mean": r["rolling_mean"],
    }
