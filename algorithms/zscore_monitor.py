"""
zscore_monitor.py  —  StampedeShield
Hardware: Snapdragon X Elite PC (Python 3.11 x86-64)
Purpose : Adaptive Z-Score monitor.  Unlike SPC/EWMA/CUSUM which use a fixed
          baseline, the Z-Score monitor computes μ and σ from the LAST N readings —
          making it self-calibrating and immune to concert/festival baseline shifts.

Inputs  (update): single float — spatial average of 6 sensors (ADC units)
Outputs: dict with z_score, rolling_mean, rolling_sigma, anomaly (|z|>3), soft_anomaly (|z|>2)
"""

from __future__ import annotations

import math
import threading
from collections import deque


class ZScoreMonitor:
    """
    Adaptive real-time Z-Score anomaly detector.

    Computes mean and std from a rolling window of the last ``window`` frames.
    This self-calibrating approach solves the fixed-baseline problem of SPC/EWMA:
    a naturally high-pressure event (concert, festival) adjusts the reference
    automatically so alarms fire only on genuine deviations from *that* event's normal.

    Args:
        window:        Rolling window length in frames (default: 30 = 3 s at 10 Hz).
        anomaly_z:     |z| threshold for hard anomaly (default: 3.0, same as SPC UCL).
        soft_anomaly_z:|z| threshold for early warning (default: 2.0).

    Zero-division protection: if rolling σ = 0 (all values identical),
    z_score returns 0.0 and neither alarm fires.
    """

    def __init__(
        self,
        window: int = 30,
        anomaly_z: float = 3.0,
        soft_anomaly_z: float = 2.0,
    ) -> None:
        self.window:         int   = window
        self.anomaly_z:      float = anomaly_z
        self.soft_anomaly_z: float = soft_anomaly_z

        self._history: deque[float] = deque(maxlen=window)
        self._lock = threading.Lock()

    def update(self, value: float) -> dict:
        """
        Add a new pressure reading and return the Z-Score analysis.

        Args:
            value: spatial-average ADC reading for this frame (Kalman-smoothed).

        Returns:
            dict with keys: z_score, rolling_mean, rolling_sigma,
            anomaly, soft_anomaly.
        """
        with self._lock:
            return self._update_unlocked(float(value))

    def _update_unlocked(self, value: float) -> dict:
        self._history.append(value)

        n = len(self._history)

        # Need at least 5 samples to compute a meaningful statistic
        if n < 5:
            return {
                "z_score":       0.0,
                "rolling_mean":  round(value, 2),
                "rolling_sigma": 0.0,
                "anomaly":       False,
                "soft_anomaly":  False,
            }

        mu    = sum(self._history) / n
        var   = sum((x - mu) ** 2 for x in self._history) / n
        sigma = math.sqrt(var)

        # Zero-sigma guard
        z = (value - mu) / sigma if sigma > 0.0 else 0.0

        return {
            "z_score":       round(z, 3),
            "rolling_mean":  round(mu, 2),
            "rolling_sigma": round(sigma, 2),
            "anomaly":       abs(z) > self.anomaly_z,
            "soft_anomaly":  abs(z) > self.soft_anomaly_z,
        }

    def reset(self) -> None:
        """Clear rolling history — call on venue change or recalibration."""
        with self._lock:
            self._history.clear()
