/**
 * StampedeShield - SPC and Risk Analysis Engine
 */

class SPCEngine {
  constructor(windowSize = 60) {
    this.windowSize = windowSize;
    this.history = []; // Array of arrays: [ [F1..F6], ... ]
    this.meanHistory = []; // Array of numbers: [ average_t1, average_t2, ... ]
    
    // User-adjustable baseline settings (can be tuned via UI)
    this.baselineMean = 10;
    this.baselineSigma = 2;
    
    // Tracking persistence of elevated pressure (in number of consecutive samples)
    this.elevatedSamplesCount = 0;
  }

  setBaseline(mean, sigma) {
    this.baselineMean = Math.max(10, mean);
    this.baselineSigma = Math.max(1, sigma);
  }

  /**
   * Processes a new frame of sensor readings [F1, F2, F3, F4, F5, F6] (values typically 0-1023).
   * Returns a comprehensive analysis object.
   */
  processReading(sensors) {
    // 1. Maintain rolling history window
    this.history.push([...sensors]);
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }

    // 2. Compute basic summary statistics for current frame
    const sum = sensors.reduce((a, b) => a + b, 0);
    const currentAvg = sum / 6;
    const currentMax = Math.max(...sensors);
    
    this.meanHistory.push(currentAvg);
    if (this.meanHistory.length > this.windowSize) {
      this.meanHistory.shift();
    }

    // 3. Compute pressure variance and spatial distribution
    // Variance among the 6 sensors (spatial variance)
    const spatialMean = currentAvg;
    const spatialVariance = sensors.reduce((acc, val) => acc + Math.pow(val - spatialMean, 2), 0) / 6;
    const spatialStdDev = Math.sqrt(spatialVariance);

    // Number of active sensors above a mild threshold (e.g. noise floor + 50)
    const activeSensorsCount = sensors.filter(v => v > (this.baselineMean + 50)).length;

    // Spatial clustering / cohesion (are adjacent sensors pressed together?)
    // Layout:
    // F1  F2  F3
    // F4  F5  F6
    const adjacencies = [
      [0, 1], [1, 2],         // Horizontal Top: (F1,F2), (F2,F3)
      [3, 4], [4, 5],         // Horizontal Bottom: (F4,F5), (F5,F6)
      [0, 3], [1, 4], [2, 5]  // Vertical: (F1,F4), (F2,F5), (F3,F6)
    ];
    let clusterScore = 0;
    const threshold = this.baselineMean + 150; // threshold for a "pressed" state
    adjacencies.forEach(([i, j]) => {
      if (sensors[i] > threshold && sensors[j] > threshold) {
        clusterScore += 1; // Increment cohesion score
      }
    });

    // 4. Compute temporal statistics (Trend & Growth Rate)
    let trendSlope = 0; // Slope of linear trend over the last 15 samples
    const trendLength = Math.min(this.meanHistory.length, 15);
    if (trendLength >= 5) {
      const subset = this.meanHistory.slice(-trendLength);
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (let i = 0; i < trendLength; i++) {
        sumX += i;
        sumY += subset[i];
        sumXY += i * subset[i];
        sumXX += i * i;
      }
      // Simple linear regression slope
      const denominator = (trendLength * sumXX - sumX * sumX);
      trendSlope = denominator !== 0 ? (trendLength * sumXY - sumX * sumY) / denominator : 0;
    }

    // Pressure growth rate over the last 5 samples (approx 0.5s at 10Hz)
    let growthRate = 0;
    if (this.meanHistory.length >= 5) {
      const recent = this.meanHistory[this.meanHistory.length - 1];
      const older = this.meanHistory[this.meanHistory.length - 5];
      growthRate = recent - older;
    }

    // 5. Compute Persistence
    // How long has pressure been elevated above Upper Control Limit (UCL) or Warning Limit?
    const warningThreshold = this.baselineMean + 1.5 * this.baselineSigma;
    if (currentAvg > warningThreshold) {
      this.elevatedSamplesCount++;
    } else {
      // Allow gradual decay of persistence rather than instant drop to zero, representing crowd dampening
      this.elevatedSamplesCount = Math.max(0, this.elevatedSamplesCount - 2);
    }

    // 6. SPC Rules Evaluation (Western Electric-like rules for Process Status)
    let spcStatus = "Stable"; // "Stable", "Drifting", "Out of Control"
    let spcReason = "Normal variation. System is statistically stable within standard control limits.";
    
    const ucl = this.baselineMean + 3 * this.baselineSigma; // +3σ
    const lcl = Math.max(0, this.baselineMean - 3 * this.baselineSigma); // -3σ
    
    // Rule 1: A single point exceeds UCL (+3σ)
    const rule1Violated = currentAvg > ucl;

    // Rule 2: 4 out of 5 consecutive points are beyond +1σ (Zone B or Zone A)
    let rule2Violated = false;
    const oneSigmaLimit = this.baselineMean + 1.0 * this.baselineSigma;
    if (this.meanHistory.length >= 5) {
      const last5 = this.meanHistory.slice(-5);
      const pointsAboveOneSigma = last5.filter(val => val > oneSigmaLimit).length;
      if (pointsAboveOneSigma >= 4) {
        rule2Violated = true;
      }
    }

    // Rule 3: Steady drift - 7 or more consecutive points continuously increasing
    let rule3Violated = false;
    if (this.meanHistory.length >= 7) {
      const last7 = this.meanHistory.slice(-7);
      let isIncreasing = true;
      for (let i = 1; i < 7; i++) {
        if (last7[i] <= last7[i - 1]) {
          isIncreasing = false;
          break;
        }
      }
      if (isIncreasing) {
        rule3Violated = true;
      }
    }

    // Rule 4: Sustained shift - 8 consecutive points are on one side of the mean (above baseline mean)
    let rule4Violated = false;
    if (this.meanHistory.length >= 8) {
      const last8 = this.meanHistory.slice(-8);
      const pointsAboveMean = last8.filter(val => val > this.baselineMean).length;
      if (pointsAboveMean === 8) {
        rule4Violated = true;
      }
    }

    // Classify SPC status based on rules
    if (rule1Violated || (this.elevatedSamplesCount > 30)) {
      spcStatus = "Out of Control";
      spcReason = rule1Violated 
        ? "CRITICAL: Average pressure exceeded Upper Control Limit (+3σ)." 
        : "CRITICAL: Pressure remained elevated above warning limit for sustained duration.";
    } else if (rule2Violated || rule3Violated || rule4Violated) {
      spcStatus = "Drifting";
      if (rule2Violated) {
        spcReason = "WARNING: Shift detected (4 of 5 samples exceed +1σ Zone B boundary).";
      } else if (rule3Violated) {
        spcReason = "WARNING: Upward trend detected (6+ samples continuously increasing).";
      } else {
        spcReason = "WARNING: Process drift detected (8 consecutive samples remain above baseline mean).";
      }
    }

    // 7. Calculate Risk Score (0% - 100%)
    // Combine multiple components:
    // a. Pressure magnitude relative to maximum realistic limit (approx 900)
    const maxLimit = 850;
    const avgPressureComponent = Math.min(1.0, Math.max(0, currentAvg - this.baselineMean) / (maxLimit - this.baselineMean));
    
    // b. Spatial distribution: percentage of active sensors (max 6)
    const spatialComponent = activeSensorsCount / 6;

    // c. Cluster component (cohesion of adjacent nodes, max score of 7 adjacencies)
    const clusterComponent = Math.min(1.0, clusterScore / 4);

    // d. Persistence component (elevated count, capped at 40 samples ~ 4 seconds)
    const persistenceComponent = Math.min(1.0, this.elevatedSamplesCount / 40);

    // e. Trend component (slope, capped at 15 N/sample)
    const trendComponent = Math.min(1.0, Math.max(0, trendSlope) / 12);

    // Weighted Risk Calculation
    // Magnified by growth rate if pressure is spiking rapidly
    let rawRisk = (
      (avgPressureComponent * 0.30) + 
      (spatialComponent * 0.15) + 
      (clusterComponent * 0.15) + 
      (persistenceComponent * 0.25) + 
      (trendComponent * 0.15)
    ) * 100;

    // If growth rate is positive and high, add dynamic risk loading
    if (growthRate > 5) {
      rawRisk += Math.min(15, (growthRate - 5) * 1.5);
    }

    const riskScore = Math.min(100, Math.max(0, Math.round(rawRisk)));

    // 8. Overall Crowd Status Determination
    let crowdStatus = "SAFE";
    let crowdStatusDesc = "Pressure levels and spatial distributions are within safe boundaries.";

    if (riskScore >= 70 || spcStatus === "Out of Control") {
      crowdStatus = "HIGH RISK";
      crowdStatusDesc = "DANGER: Extreme compression detected! Immediate emergency crowd control required.";
    } else if (riskScore >= 30 || spcStatus === "Drifting") {
      crowdStatus = "WATCH";
      crowdStatusDesc = "ALERT: Pressure building up or shifting. Operator should monitor closely.";
    }

    return {
      currentAvg,
      currentMax,
      spatialStdDev,
      activeSensorsCount,
      clusterScore,
      trendSlope,
      growthRate,
      elevatedSamplesCount: this.elevatedSamplesCount,
      spcStatus,
      spcReason,
      riskScore,
      crowdStatus,
      crowdStatusDesc,
      controlLimits: {
        lcl,
        ucl,
        mean: this.baselineMean
      }
    };
  }
}

// Export for Node environment (if run in local node tests) or make globally available in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SPCEngine;
} else {
  window.SPCEngine = SPCEngine;
}
