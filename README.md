# StampedeShield 🛡️

**Real-time crowd crush detection and early warning system** using FSR pressure sensor arrays, multi-algorithm statistical process control, LSTM deep learning, and a multi-platform dashboard.

---

## Overview

StampedeShield monitors crowd density and pressure in real time using an array of six Force Sensitive Resistors (FSRs). Sensor data flows through a layered processing pipeline — statistical monitors, a Kalman filter, and a quantized LSTM neural network — and is fused into a single crowd risk classification: **SAFE**, **WATCH**, **HIGH RISK**, or **CRITICAL**.

The system targets deployability on a **Snapdragon X Elite PC** (QNN/NPU acceleration) with a browser dashboard, Android mobile companion app, and optional Arduino hardware sender.

---

## Architecture

```
Arduino / UNO Q App Lab (Python)
        │  UDP :4210  (F1,F2,F3,F4,F5,F6)
        ▼
┌─────────────────────────────────────────┐
│  Node.js Telemetry Hub  (port 3000/8080)│  ← zippy/B project/server.js
│  • HTTP static server  → dashboard      │
│  • WebSocket server    → browser/Android│
│  • UDP listener        → sensor frames  │
│  • ML Bridge client    → ws :8081       │
└──────────────────┬──────────────────────┘
                   │  ws://localhost:8081
                   ▼
┌─────────────────────────────────────────┐
│  Python ML Bridge  (port 8081)          │  ← stampede_shield/ml_bridge.py
│  Per-connection pipeline:               │
│    1. Kalman Pre-Filter  (6x sensors)   │
│    2. LSTM Inference     (20-frame win) │
│    3. Strategy B Fusion                 │
│       SPC + EWMA + CUSUM + Z-Score      │
│       + LSTM → weighted risk score      │
└─────────────────────────────────────────┘
```

---

## Project Structure

```
Working-Project/
├── algorithms/              # Statistical monitoring algorithms (Python)
│   ├── spc_engine.py        # Statistical Process Control (4 Western Electric rules)
│   ├── ewma_monitor.py      # Exponentially Weighted Moving Average
│   ├── cusum_monitor.py     # Cumulative Sum control chart
│   ├── zscore_monitor.py    # Z-Score anomaly detector
│   └── kalman_filter.py     # 1D Kalman filter for FSR noise smoothing
│
├── fusion/
│   └── fusion_engine.py     # Multi-algorithm fusion (Strategy A / B / C)
│
├── ml/
│   ├── train_lstm.py        # LSTM training script (PyTorch → ONNX export)
│   ├── lstm_inference.py    # ONNX Runtime inference (QNN NPU / CPU INT8 / CPU FP32)
│   ├── lstm_model.onnx      # Trained FP32 model
│   └── lstm_model_int8.onnx # INT8 quantized model (deployed on NPU)
│
├── stampede_shield/
│   └── ml_bridge.py         # WebSocket bridge — Node.js <-> Python ML pipeline
│
├── zippy/
│   └── B project/
│       ├── server.js        # Node.js telemetry hub (HTTP + WS + UDP)
│       ├── app.js           # Front-end dashboard logic
│       ├── index.html       # Live dashboard UI
│       ├── spc.js           # JavaScript SPC engine (browser-side)
│       ├── style.css        # Dashboard styling
│       └── serial.js        # USB serial fallback for Arduino
│
├── app/                     # Android companion app (Kotlin / Jetpack Compose)
│   └── app/src/...
│
├── field_data.csv           # Labelled field sensor recordings (training data)
├── build_dataset.py         # Sliding-window dataset builder → X_real.npy / y_real.npy
└── requirements.txt         # Python dependencies
```

---

## Risk Classification

| Status        | Risk Score | Action                                                    |
|---------------|------------|-----------------------------------------------------------|
| SAFE          | 0–30       | Monitor — no action required                              |
| WATCH         | 31–60      | Alert zone supervisor — increased crowd density detected  |
| HIGH RISK     | 61–80      | Deploy crowd control officers to zone immediately         |
| CRITICAL      | 81–100     | EVACUATE ZONE — deploy all officers and medical personnel |

---

## Fusion Strategies

The `FusionEngine` supports three configurable strategies:

| Strategy | Description |
|----------|-------------|
| **A — Sequential** | SPC gates ML. Fast-path when crowd is calm. |
| **B — Parallel + Fusion** | SPC + EWMA + CUSUM + Z-Score all run simultaneously; outputs merged with weighted 4-case logic. |
| **C — ML Primary, SPC Safety Net** | LSTM is primary; SPC acts as a fallback. Recommended for production. |

---

## ML Model

- **Architecture:** 2-layer LSTM (64 hidden units) → Dropout(0.3) → Linear(4 classes)
- **Input:** 20-frame sliding window x 6 normalized FSR channels
- **Output:** `[SAFE, WATCH, HIGH, CRITICAL]` softmax probabilities
- **Export:** FP32 ONNX + INT8 quantized ONNX (via `onnxruntime.quantization`)
- **Runtime priority:** QNN NPU → CPU INT8 → CPU FP32

---

## Setup & Running

### 1. Python Backend

```bash
# Install dependencies
pip install -r requirements.txt

# Start the ML Bridge WebSocket server
python -m stampede_shield.ml_bridge
# — or —
python stampede_shield/ml_bridge.py
```

### 2. Node.js Telemetry Hub

```bash
cd "zippy/B project"
npm install
node server.js
```

Open the live dashboard at **http://localhost:3000**

### 3. (Optional) Retrain the LSTM Model

```bash
# Build the dataset from field_data.csv
python build_dataset.py

# Train and export ONNX models
python -m ml.train_lstm
```

---

## Data Flow (Detailed)

1. **Sensor source** — Arduino/UDP or USB serial sends `F1,F2,F3,F4,F5,F6` ADC values (0–1023) at ~10 Hz.
2. **Node.js hub** — receives UDP packets on port 4210, forwards raw frames to the Python ML Bridge over WebSocket (port 8081), and broadcasts enriched results to all dashboard/Android clients (port 8080).
3. **Kalman filter** — smooths per-sensor FSR noise before feeding the statistical monitors and LSTM.
4. **Statistical monitors** — SPC, EWMA, CUSUM, and Z-Score each independently assess the 6-sensor frame.
5. **LSTM inference** — accumulates 20 frames, then predicts a crowd class.
6. **Fusion engine** — combines all monitor outputs into a final `risk_score`, `crowd_status`, `recommended_action`, and spatial diagnostics.
7. **Dashboard / Android app** — renders real-time risk level, sensor heatmap, control charts, and alerts.

---

## Requirements

- **Python** >= 3.11
- **Node.js** >= 18
- **Android** API 26+ (for companion app)
- For NPU acceleration: `onnxruntime-qnn` (Snapdragon X Elite)

See [requirements.txt](requirements.txt) for the full Python dependency list.

---

## License

See [LICENSE](LICENSE).
