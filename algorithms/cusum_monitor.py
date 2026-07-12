"""
cusum_monitor.py  —  StampedeShield
Hardware: Snapdragon X Elite PC (Python 3.11 x86-64)
Purpose : CUSUM (Cumulative Sum) control chart.
          Most sensitive method for detecting small, persistent upward shifts in crowd
          pressure — accumulates evidence across frames instead of reacting per-frame.

Formula:
    S_high = max(0, S_high_prev + (X_t - μ) - K)
    S_low  = max(0, S_low_prev  - (X_t - μ) - K)
    Alarm  when S_high > H  or  S_low > H

Inputs  (update): single float — spatial average of the 6 sensors (ADC units, 0–1023)
Outputs: dict with S_high, S_low, threshold, alarm_high, alarm_low, accumulation_rate
"""

from __future__ import annotations

import threading


class CUSUMMonitor:
    """
    Two-sided CUSUM chart for StampedeShield crowd pressure monitoring.

    Args:
        mu:       Target / baseline mean pressure (ADC units).
        sigma:    Baseline standard deviation (ADC units).
        K_factor: Allowance multiplier.  K = K_factor × σ.  Typical: 0.5.
        H_factor: Decision threshold multiplier.  H = H_factor × σ.  Typical: 4.0.

    Zero-division protection: if sigma = 0, K defaults to 0.1 and H to 1.0 so the
    monitor still raises alarms (any non-zero deviation immediately accumulates).
    """

    def __init__(
        self,
        mu: float = 10.0,
        sigma: float = 2.0,
        K_factor: float = 0.5,
        H_factor: float = 4.0,
    ) -> None:
        self.mu:    float = float(mu)
        self.sigma: float = max(0.0, float(sigma))

        if self.sigma > 0:
            self.K: float = K_factor * self.sigma
            self.H: float = H_factor * self.sigma
        else:
            self.K = 0.1   # zero-sigma guard
            self.H = 1.0

        self.S_high: float = 0.0   # cumulative sum for upward shift
        self.S_low:  float = 0.0   # cumulative sum for downward shift
        self._prev_S_high: float = 0.0  # for accumulation_rate

        self._lock = threading.Lock()

    def update(self, value: float) -> dict:
        """
        Incorporate one new pressure reading.

        Args:
            value: spatial-average ADC reading for this frame (Kalman-smoothed).

        Returns:
            dict with keys: S_high, S_low, threshold, alarm_high, alarm_low,
            accumulation_rate (Δ S_high since last call — rate of accumulation).
        """
        with self._lock:
            return self._update_unlocked(float(value))

    def _update_unlocked(self, value: float) -> dict:
        deviation = value - self.mu

        prev = self.S_high

        # Two-sided CUSUM update
        self.S_high = max(0.0, self.S_high + deviation - self.K)
        self.S_low  = max(0.0, self.S_low  - deviation - self.K)

        accumulation_rate = self.S_high - prev

        return {
            "S_high":            round(self.S_high, 2),
            "S_low":             round(self.S_low, 2),
            "threshold":         round(self.H, 2),
            "alarm_high":        self.S_high > self.H,
            "alarm_low":         self.S_low  > self.H,
            "accumulation_rate": round(accumulation_rate, 3),
        }

    def reset(self) -> None:
        """Reset cumulative sums to zero — call after a confirmed alarm is acted on."""
        with self._lock:
            self.S_high = 0.0
            self.S_low  = 0.0
