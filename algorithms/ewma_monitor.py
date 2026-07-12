"""
ewma_monitor.py  —  StampedeShield
Hardware: Snapdragon X Elite PC (Python 3.11 x86-64)
Purpose : EWMA (Exponentially Weighted Moving Average) control chart.
          Catches small sustained pressure drift that SPC Rule 1 misses.

Inputs  (update):
    value — single float (typically the spatial average of all 6 sensors,
            already Kalman-smoothed).  Units: ADC counts (0–1023).

Outputs: dict with ewma_value, ucl, lcl, out_of_control, deviation_from_mean,
         ewma_trend ("rising"|"falling"|"stable").
"""

from __future__ import annotations

import math
import threading
from collections import deque
from typing import Optional


class EWMAMonitor:
    """
    EWMA control chart for sustained crowd pressure drift detection.

    The EWMA statistic is:
        Z_t = λ · X_t + (1 − λ) · Z_{t−1}

    Control limits:
        UCL = μ + L · σ · √(λ / (2 − λ))
        LCL = max(0, μ − L · σ · √(λ / (2 − λ)))

    The factor √(λ / (2−λ)) makes EWMA limits ~33 % narrower than SPC ±3σ
    at λ = 0.2, giving it superior sensitivity to small sustained shifts.

    Args:
        lam:            Smoothing factor λ (0–1).  0.2 is the recommended default.
        L:              Control limit multiplier (equivalent to k·σ in SPC).
        baseline_mean:  μ — expected idle pressure (ADC units).
        baseline_sigma: σ — expected idle standard deviation.

    Zero-division protection: if λ = 2.0 (impossible in practice), the factor
    defaults to 1.0.  If σ = 0, all limits equal μ and any non-μ value triggers.
    """

    def __init__(
        self,
        lam: float = 0.2,
        L: float = 3.0,
        baseline_mean: float = 10.0,
        baseline_sigma: float = 2.0,
    ) -> None:
        self.lam:   float = lam
        self.L:     float = L
        self.mu:    float = float(baseline_mean)
        self.sigma: float = max(0.0, float(baseline_sigma))

        # Initial EWMA value = baseline mean
        self.ewma: float = self.mu

        # EWMA control limits (narrower than SPC by the factor below)
        denom = 2.0 - lam
        factor = math.sqrt(lam / denom) if denom != 0 else 1.0
        spread = L * self.sigma * factor
        self.ucl: float = self.mu + spread
        self.lcl: float = max(0.0, self.mu - spread)

        # Rolling buffer for trend detection (last 5 EWMA values)
        self._recent: deque[float] = deque(maxlen=5)

        self._lock = threading.Lock()

    def update(self, value: float) -> dict:
        """
        Incorporate one new pressure reading and return the EWMA analysis.

        Args:
            value: spatial-average ADC reading for this frame (Kalman-smoothed).

        Returns:
            dict with keys: ewma_value, ucl, lcl, out_of_control,
            deviation_from_mean, ewma_trend.
        """
        with self._lock:
            return self._update_unlocked(float(value))

    def _update_unlocked(self, value: float) -> dict:
        # Update EWMA statistic
        self.ewma = self.lam * value + (1.0 - self.lam) * self.ewma
        self._recent.append(self.ewma)

        out_of_control = (self.ewma > self.ucl) or (self.ewma < self.lcl)

        # Trend: compare first vs last of the 5-value buffer
        trend = "stable"
        if len(self._recent) >= 5:
            delta = self._recent[-1] - self._recent[0]
            if delta > 2.0:
                trend = "rising"
            elif delta < -2.0:
                trend = "falling"

        return {
            "ewma_value":        round(self.ewma, 2),
            "ucl":               round(self.ucl, 2),
            "lcl":               round(self.lcl, 2),
            "out_of_control":    out_of_control,
            "deviation_from_mean": round(self.ewma - self.mu, 2),
            "ewma_trend":        trend,
        }

    def reset(self) -> None:
        """Reset EWMA state to baseline mean (call on venue-change / recalibration)."""
        with self._lock:
            self.ewma = self.mu
            self._recent.clear()
