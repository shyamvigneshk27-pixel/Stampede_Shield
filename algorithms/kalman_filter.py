"""
kalman_filter.py  —  StampedeShield
Hardware: runs on Snapdragon X Elite PC (Python 3.11 x86-64) AND OnePlus 15 (Python 3.11 ARM64)
Purpose : 1-D Kalman filter for optimal noise smoothing of one FSR ADC channel.
          Instantiate 6 of these — one per sensor — before feeding values to any
          statistical algorithm or the LSTM inference engine.

Inputs : raw ADC measurement (float, 0–1023)
Outputs: optimal smoothed pressure estimate (float)
Units  : ADC counts (same as input; no unit conversion performed here)
"""

from __future__ import annotations


class KalmanFilter1D:
    """
    Scalar (1-D) Kalman filter for FSR pressure noise smoothing.

    The filter models:
      - **Process noise (Q):** how much true pressure can change between two
        consecutive 100 ms frames.  Typical: 1.0 ADC units.
      - **Measurement noise (R):** electrical noise on the FSR ADC line.
        Interlink FSR 406 at mid-range with 220 Ω pull-down ≈ ±1 ADC units,
        so R = 1.0 (variance = std²). Default: 1.0 for a conservative estimate.

    The filter guarantees zero division protection: if P_pred + R == 0
    (which cannot happen in normal use), the Kalman gain defaults to 0.5.

    Args:
        process_noise:      Q — expected frame-to-frame pressure change variance.
        measurement_noise:  R — sensor electrical noise variance.
        initial_estimate:   Starting state estimate (ADC counts).  Use the first
                            raw reading or the expected idle baseline (≈10).
    """

    def __init__(
        self,
        process_noise: float = 1.0,
        measurement_noise: float = 1.0,
        initial_estimate: float = 10.0,
    ) -> None:
        self.Q: float = process_noise        # process noise covariance
        self.R: float = measurement_noise    # measurement noise covariance
        self.x: float = initial_estimate     # state estimate (true pressure)
        self.P: float = 1.0                  # estimate error covariance

    def update(self, measurement: float) -> float:
        """
        Process one ADC reading and return the optimal smoothed estimate.

        Args:
            measurement: raw ADC value from one FSR sensor (0–1023, float or int)

        Returns:
            Smoothed pressure estimate (float, same unit as input).
        """
        measurement = float(measurement)

        # ── Predict ──────────────────────────────────────────────────────────
        P_pred: float = self.P + self.Q           # predicted covariance

        # ── Kalman Gain ───────────────────────────────────────────────────────
        denom: float = P_pred + self.R
        K: float = P_pred / denom if denom != 0.0 else 0.5   # zero-div guard

        # ── Update ────────────────────────────────────────────────────────────
        self.x = self.x + K * (measurement - self.x)
        self.P = (1.0 - K) * P_pred

        return self.x

    def reset(self, initial_estimate: float = 10.0) -> None:
        """Reset filter state — call this when a sensor is reconnected or swapped."""
        self.x = float(initial_estimate)
        self.P = 1.0
