"""
============================================================
  StampedeShield — Arduino App Lab Data Collector
  main.py  (runs ON the Arduino UNO Q's Linux side)
============================================================

  ARCHITECTURE (Arduino UNO Q):
    ┌────────────────────────────────────────────┐
    │  UNO Q Board                              │
    │  ┌───────────┐   Bridge   ┌───────────┐   │
    │  │ MCU sketch│◄─────────►│ THIS FILE │   │
    │  │ FSR read  │           │ Python    │   │
    │  └───────────┘           └───────────┘   │
    │                                    │         │
    │                              UDP over WiFi     │
    └────────────────────────────────────────────┘
              │  (WiFi 5 built-in on board)
              ▼
    ┌──────────────────┐
    │  PC / Laptop        │
    │  Node.js :4210 UDP  │  ← receives data from UNO Q
    │  Dashboard :3000    │
    └──────────────────┘

  HOW IT WORKS:
    1. MCU sketch registers: Bridge.provide("get_sensors", ...)
    2. This script calls:    Bridge.call("get_sensors")
    3. Gets back CSV string: "120,450,80,0,15,300"
    4. Sends UDP packet to PC's IP on port 4210
    5. Node.js on PC receives it and pushes to dashboard

  ⚠️  IMPORTANT: UDP_IP must be your PC's IP address (NOT 127.0.0.1)
      127.0.0.1 = the UNO Q board itself (wrong!)
      Run `ipconfig` on your Windows PC to find the correct IP.
      Example: 192.168.1.45

  LABEL THRESHOLDS (based on normalised max sensor value):
    0 = SAFE      → max_norm < 0.39
    1 = WATCH     → 0.39 ≤ max_norm < 0.58
    2 = HIGH      → 0.58 ≤ max_norm < 0.85
    3 = CRITICAL  → max_norm ≥ 0.85

  OUTPUT FILE:  field_data.csv
    Columns: timestamp_ms, F1, F2, F3, F4, F5, F6,
             label, label_name, F1n, F2n, F3n, F4n, F5n, F6n
============================================================
"""

from arduino.app_utils import App, Bridge
import time
import csv
import os
import socket

# ── CONFIGURATION ──────────────────────────────────────────────────
# Per-sensor maximum ADC values (measured at full pressure with 220Ω)
SENSOR_MAX   = [515.0, 1023.0, 575.0, 630.0, 570.0, 210.0]

LABEL_NAMES  = {0: "SAFE", 1: "WATCH", 2: "HIGH", 3: "CRITICAL"}

# Path to CSV output — matches field_data.csv used by ml/train_lstm.py
CSV_PATH     = "field_data.csv"

# Setup UDP socket to forward data to the PC over WiFi
# ⚠️  CHANGE THIS to your PC's actual IP address!
# ⚠️  Run `ipconfig` on your Windows PC and look for:
# ⚠️    "IPv4 Address" under your WiFi adapter.
# ⚠️  Example: 192.168.1.45
# ⚠️  DO NOT use 127.0.0.1 — that points to the UNO Q itself, not the PC!
UDP_IP     = "10.253.57.143"     # PC's WiFi IP — confirmed via ipconfig (Wireless LAN adapter WiFi)
UDP_PORT   = 4210               # Must match UDP_PORT in Node.js server.js
udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
# ───────────────────────────────────────────────────────────────────


def normalize(raw_vals: list) -> list:
    """Scale each raw ADC value (0–max) to 0.0–1.0."""
    return [min(1.0, v / mx) for v, mx in zip(raw_vals, SENSOR_MAX)]


def assign_label(raw_vals: list) -> int:
    """
    Classify crowd density from the highest normalised sensor value.

    Returns:
        0 = SAFE
        1 = WATCH
        2 = HIGH
        3 = CRITICAL
    """
    max_norm = max(normalize(raw_vals))

    if max_norm >= 0.85:
        return 3   # CRITICAL
    elif max_norm >= 0.58:
        return 2   # HIGH
    elif max_norm >= 0.39:
        return 1   # WATCH
    else:
        return 0   # SAFE


# ── CSV setup ──────────────────────────────────────────────────────
file_exists = os.path.exists(CSV_PATH)
csv_file    = open(CSV_PATH, "a", newline="", encoding="utf-8")
writer      = csv.writer(csv_file)

if not file_exists:
    writer.writerow([
        "timestamp_ms",
        "F1", "F2", "F3", "F4", "F5", "F6",
        "label", "label_name",
        "F1n", "F2n", "F3n", "F4n", "F5n", "F6n"
    ])
    csv_file.flush()
    print(f"Created new file: {CSV_PATH}")
else:
    print(f"Appending to existing file: {CSV_PATH}")

start_time  = time.time()
frame_count = 0


# ── Main polling loop ───────────────────────────────────────────────
def loop():
    global frame_count

    try:
        # Call the C++ function registered on the Arduino
        raw_str = Bridge.call("get_sensors")
        if not raw_str:
            return

        raw_vals = [int(v) for v in raw_str.split(",")]
        if len(raw_vals) != 6:
            return

        norm_vals = normalize(raw_vals)
        label     = assign_label(raw_vals)

        # Append row to CSV
        ts  = int((time.time() - start_time) * 1000)
        row = (
            [ts]
            + raw_vals
            + [label, LABEL_NAMES[label]]
            + [f"{v:.4f}" for v in norm_vals]
        )
        writer.writerow(row)
        csv_file.flush()

        # Forward raw CSV data locally to Node.js UDP port 4210
        try:
            packet = (raw_str.strip() + "\n").encode("ascii")
            udp_socket.sendto(packet, (UDP_IP, UDP_PORT))
        except Exception as e:
            print(f"[UDP FORWARD ERROR] {e}")

        frame_count += 1

        # Print summary every 10 frames (every ~1 second)
        if frame_count % 10 == 0:
            status = LABEL_NAMES[label]
            print(f"[Frame {frame_count:>5}]  Status: {status:<8}  "
                  f"Raw: {raw_vals}  "
                  f"Avg: {sum(raw_vals)/6:.0f}")

    except Exception as e:
        print(f"[ERROR] {e}")

    # Enforce 10 Hz polling rate
    time.sleep(0.1)


# ── Entry point ────────────────────────────────────────────────────
print("=" * 52)
print("  StampedeShield  —  App Lab Data Collector")
print("=" * 52)
print(f"  Output  : {CSV_PATH}")
print(f"  Rate    : 10 Hz  (100 ms/frame)")
print(f"  Labels  : {LABEL_NAMES}")
print("=" * 52)
print("  Press Ctrl+C in the App Lab to stop.\n")

App.run(user_loop=loop)
