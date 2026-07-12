"""
spc_engine.py  —  StampedeShield
Hardware: Snapdragon X Elite PC (Python 3.11 x86-64), QNN access for ensemble host.
Purpose : Exact Python port of the original spc.js SPCEngine class.
          Logic is preserved 1-to-1; only language syntax changed.

Inputs  (processReading / process):
    sensors — list of 6 raw (or Kalman-smoothed) ADC values (0–1023)

Output dict keys (identical names to the JS version, plus extras for Python fusion):
    currentAvg, currentMax, spatialStdDev, activeSensorsCount, clusterScore,
    trendSlope, growthRate, elevatedSamplesCount,
    spcStatus ("Stable"|"Drifting"|"Out of Control"),
    spcReason, ruleFired (1|2|3|4|None),
    riskScore (0–100), crowdStatus ("SAFE"|"WATCH"|"HIGH RISK"),
    crowdStatusDesc, controlLimits {ucl, lcl, mean},
    sensorViolations [list of sensor indices above UCL]
"""

from __future__ import annotations

import math
import threading
from typing import Optional


class SPCEngine:
    """
    Statistical Process Control engine — Python port of spc.js.

    The logic mirrors the original JavaScript SPCEngine exactly:

    1.  Maintain a rolling history window (default 60 frames).
    2.  Compute spatial statistics (mean, max, std-dev, cluster score, active count).
    3.  Compute temporal statistics (trend slope via linear regression, growth rate).
    4.  Track persistence of elevated pressure (elevatedSamplesCount).
    5.  Evaluate 4 Western Electric rules on the rolling mean history.
    6.  Compute a weighted risk score (0–100) identical to the JS formula.
    7.  Classify crowdStatus from riskScore / spcStatus.

    Thread safety: a ``threading.Lock`` guards all mutable state so the engine can
    be called from the serial-reader background thread concurrently with the fusion
    engine reading results.

    Args:
        window_size:     Number of frames in the rolling history (same as JS windowSize).
        baseline_mu:     Optional fixed baseline mean.  If None, auto-computed from
                         the first ``window_size`` frames then locked.
        baseline_sigma:  Optional fixed baseline sigma.  Same auto-lock behaviour.
    """

    # ── Sensor layout adjacencies (identical to JS) ──────────────────────────
    #   F1  F2  F3
    #   F4  F5  F6  (0-indexed: F1=0, F2=1, … F6=5)
    _ADJACENCIES = [
        (0, 1), (1, 2),          # Horizontal Top:    (F1,F2), (F2,F3)
        (3, 4), (4, 5),          # Horizontal Bottom: (F4,F5), (F5,F6)
        (0, 3), (1, 4), (2, 5),  # Vertical:          (F1,F4), (F2,F5), (F3,F6)
    ]

    def __init__(
        self,
        window_size: int = 60,
        baseline_mu: Optional[float] = None,
        baseline_sigma: Optional[float] = None,
    ) -> None:
        self.windowSize = window_size

        # Rolling buffers (mirroring JS arrays)
        self.history: list[list[float]] = []        # [ [F1..F6], … ]
        self.meanHistory: list[float] = []          # [ avg_t1, avg_t2, … ]

        # Baseline (can be set externally, or auto-locked from warm-up data)
        self._baseline_locked: bool = False
        if baseline_mu is not None and baseline_sigma is not None:
            self.baselineMean: float = max(10.0, float(baseline_mu))
            self.baselineSigma: float = max(1.0, float(baseline_sigma))
            self._baseline_locked = True
        else:
            self.baselineMean = 10.0
            self.baselineSigma = 2.0

        self.elevatedSamplesCount: int = 0

        # Auto-lock warm-up accumulators
        self._warmup_buffer: list[float] = []

        self._lock = threading.Lock()

    # ── Public API ────────────────────────────────────────────────────────────

    def set_baseline(self, mean: float, sigma: float) -> None:
        """Override baseline mean and sigma manually (mirrors JS setBaseline)."""
        with self._lock:
            self.baselineMean = max(10.0, float(mean))
            self.baselineSigma = max(1.0, float(sigma))
            self._baseline_locked = True

    # Alias to match original JS camelCase name (used in tests / legacy code)
    setBaseline = set_baseline

    def process(self, sensors: list) -> dict:
        """
        Process one frame of 6 sensor readings.

        Args:
            sensors: list/tuple of 6 ADC values (0–1023), raw or Kalman-smoothed.

        Returns:
            Comprehensive analysis dict.  All keys intentionally match the JS output
            plus additional Python-only keys (ruleFired, sensorViolations).
        """
        with self._lock:
            return self._process_unlocked([float(v) for v in sensors])

    # Alias: old code that calls processReading still works
    processReading = process

    # ── Internal implementation ───────────────────────────────────────────────

    def _process_unlocked(self, sensors: list[float]) -> dict:
        # ── 1. Warm-up / baseline auto-lock ──────────────────────────────────
        if not self._baseline_locked:
            self._warmup_buffer.append(sum(sensors) / 6)
            if len(self._warmup_buffer) >= self.windowSize:
                self.baselineMean = sum(self._warmup_buffer) / len(self._warmup_buffer)
                variance = sum((v - self.baselineMean) ** 2 for v in self._warmup_buffer) / len(self._warmup_buffer)
                self.baselineSigma = max(1.0, math.sqrt(variance))
                self._baseline_locked = True
                print(f"SPC baseline locked: mu={self.baselineMean:.1f}, sigma={self.baselineSigma:.1f}")

        # ── 2. Rolling history ────────────────────────────────────────────────
        self.history.append(list(sensors))
        if len(self.history) > self.windowSize:
            self.history.pop(0)

        # ── 3. Basic frame statistics ─────────────────────────────────────────
        currentAvg: float = sum(sensors) / 6
        currentMax: float = max(sensors)

        self.meanHistory.append(currentAvg)
        if len(self.meanHistory) > self.windowSize:
            self.meanHistory.pop(0)

        # ── 4. Spatial statistics ─────────────────────────────────────────────
        spatialVariance = sum((v - currentAvg) ** 2 for v in sensors) / 6
        spatialStdDev = math.sqrt(spatialVariance)

        activeSensorsCount = sum(1 for v in sensors if v > (self.baselineMean + 50))

        # Cluster score: adjacent pairs both above threshold
        threshold = self.baselineMean + 150
        clusterScore = 0
        for i, j in self._ADJACENCIES:
            if sensors[i] > threshold and sensors[j] > threshold:
                clusterScore += 1

        # ── 5. Temporal statistics (trend slope + growth rate) ────────────────
        trendSlope: float = 0.0
        trendLength = min(len(self.meanHistory), 15)
        if trendLength >= 5:
            subset = self.meanHistory[-trendLength:]
            sumX = sumY = sumXY = sumXX = 0.0
            for i, val in enumerate(subset):
                sumX  += i
                sumY  += val
                sumXY += i * val
                sumXX += i * i
            denom = trendLength * sumXX - sumX * sumX
            trendSlope = (trendLength * sumXY - sumX * sumY) / denom if denom != 0 else 0.0

        growthRate: float = 0.0
        if len(self.meanHistory) >= 5:
            growthRate = self.meanHistory[-1] - self.meanHistory[-5]

        # ── 6. Persistence ───────────────────────────────────────────────────
        warningThreshold = self.baselineMean + 1.5 * self.baselineSigma
        if currentAvg > warningThreshold:
            self.elevatedSamplesCount += 1
        else:
            self.elevatedSamplesCount = max(0, self.elevatedSamplesCount - 2)

        # ── 7. Control limits ────────────────────────────────────────────────
        ucl = self.baselineMean + 3 * self.baselineSigma
        lcl = max(0.0, self.baselineMean - 3 * self.baselineSigma)

        # ── 8. Western Electric Rules ─────────────────────────────────────────
        # Rule 1: single point above UCL
        rule1Violated = currentAvg > ucl

        # Rule 2: 4 of last 5 above +1σ
        rule2Violated = False
        oneSigmaLimit = self.baselineMean + self.baselineSigma
        if len(self.meanHistory) >= 5:
            last5 = self.meanHistory[-5:]
            if sum(1 for v in last5 if v > oneSigmaLimit) >= 4:
                rule2Violated = True

        # Rule 3: 7 consecutive monotonically increasing
        rule3Violated = False
        if len(self.meanHistory) >= 7:
            last7 = self.meanHistory[-7:]
            rule3Violated = all(last7[i] > last7[i - 1] for i in range(1, 7))

        # Rule 4: 8 consecutive above baseline mean
        rule4Violated = False
        if len(self.meanHistory) >= 8:
            last8 = self.meanHistory[-8:]
            if sum(1 for v in last8 if v > self.baselineMean) == 8:
                rule4Violated = True

        # ── 9. SPC status classification ─────────────────────────────────────
        spcStatus: str = "Stable"
        spcReason: str = "Normal variation. System is statistically stable within standard control limits."
        ruleFired: Optional[int] = None

        # Per-sensor violations (extra info not in original JS)
        sensorViolations: list[int] = [i for i, v in enumerate(sensors) if v > ucl]

        if rule1Violated or (self.elevatedSamplesCount > 30):
            spcStatus = "Out of Control"
            if rule1Violated:
                spcReason = "CRITICAL: Average pressure exceeded Upper Control Limit (+3σ)."
                ruleFired = 1
            else:
                spcReason = "CRITICAL: Pressure remained elevated above warning limit for sustained duration."
        elif rule2Violated or rule3Violated or rule4Violated:
            spcStatus = "Drifting"
            if rule2Violated:
                spcReason = "WARNING: Shift detected (4 of 5 samples exceed +1σ Zone B boundary)."
                ruleFired = 2
            elif rule3Violated:
                spcReason = "WARNING: Upward trend detected (6+ samples continuously increasing)."
                ruleFired = 3
            else:
                spcReason = "WARNING: Process drift detected (8 consecutive samples remain above baseline mean)."
                ruleFired = 4

        # ── 10. Weighted risk score (identical formula to JS) ─────────────────
        maxLimit = 850.0
        avgPressureComponent = min(1.0, max(0.0, (currentAvg - self.baselineMean) / (maxLimit - self.baselineMean)))
        spatialComponent     = activeSensorsCount / 6.0
        clusterComponent     = min(1.0, clusterScore / 4.0)
        persistenceComponent = min(1.0, self.elevatedSamplesCount / 40.0)
        trendComponent       = min(1.0, max(0.0, trendSlope) / 12.0)

        rawRisk = (
            avgPressureComponent  * 0.30 +
            spatialComponent      * 0.15 +
            clusterComponent      * 0.15 +
            persistenceComponent  * 0.25 +
            trendComponent        * 0.15
        ) * 100.0

        if growthRate > 5:
            rawRisk += min(15.0, (growthRate - 5) * 1.5)

        riskScore: int = int(min(100, max(0, round(rawRisk))))

        # ── 11. Crowd status (identical thresholds to JS) ─────────────────────
        crowdStatus: str = "SAFE"
        crowdStatusDesc: str = "Pressure levels and spatial distributions are within safe boundaries."

        if riskScore >= 70 or spcStatus == "Out of Control":
            crowdStatus = "HIGH RISK"
            crowdStatusDesc = "DANGER: Extreme compression detected! Immediate emergency crowd control required."
        elif riskScore >= 30 or spcStatus == "Drifting":
            crowdStatus = "WATCH"
            crowdStatusDesc = "ALERT: Pressure building up or shifting. Operator should monitor closely."

        # ── 12. Return dict (all JS keys preserved, Python extras added) ───────
        return {
            # ── JS-identical keys ──────────────────────────────────────────────
            "currentAvg":           round(currentAvg, 2),
            "currentMax":           round(currentMax, 2),
            "spatialStdDev":        round(spatialStdDev, 2),
            "activeSensorsCount":   activeSensorsCount,
            "clusterScore":         clusterScore,
            "trendSlope":           round(trendSlope, 4),
            "growthRate":           round(growthRate, 2),
            "elevatedSamplesCount": self.elevatedSamplesCount,
            "spcStatus":            spcStatus,
            "spcReason":            spcReason,
            "riskScore":            riskScore,
            "crowdStatus":          crowdStatus,
            "crowdStatusDesc":      crowdStatusDesc,
            "controlLimits": {
                "ucl":  round(ucl, 2),
                "lcl":  round(lcl, 2),
                "mean": round(self.baselineMean, 2),
            },
            # ── Python-only extras (used by fusion engine) ─────────────────────
            "spc_state":         spcStatus,          # snake_case alias
            "spc_reason":        spcReason,
            "rule_fired":        ruleFired,
            "current_avg":       round(currentAvg, 2),
            "spatial_std_dev":   round(spatialStdDev, 2),
            "control_limits": {
                "ucl":  round(ucl, 2),
                "cl":   round(self.baselineMean, 2),
                "lcl":  round(lcl, 2),
            },
            "sensor_violations": sensorViolations,
            "risk_contribution": float(riskScore),
        }
