/**
 * ============================================================
 *  StampedeShield — Arduino App Lab Sketch
 *  Board: Arduino UNO Q  (via Arduino App Lab / Router Bridge)
 * ============================================================
 *
 *  PURPOSE:
 *    Reads 6 FSR pressure sensors (A0–A5) and exposes the
 *    values to the Python side (main.py) via the App Lab Bridge.
 *    Python calls get_sensors() 10x/sec to collect field_data.csv
 *    which is then used to train the LSTM model.
 *
 *  WIRING (repeat for each FSR):
 *
 *    5V ──── [ FSR ] ──── A0  (or A1, A2, A3, A4, A5)
 *                              │
 *                        [ 220Ω resistor ]
 *                              │
 *                            GND
 *
 *    Sensor  │ Pin
 *    ────────┼──────
 *     F1     │  A0
 *     F2     │  A1
 *     F3     │  A2
 *     F4     │  A3
 *     F5     │  A4
 *     F6     │  A5
 *
 *  HOW IT WORKS:
 *    - Bridge.provide("get_sensors", get_sensors) registers the
 *      function so Python can call Bridge.call("get_sensors")
 *    - Returns comma-separated string: "F1,F2,F3,F4,F5,F6"
 *      e.g. "120,450,80,0,15,300"
 * ============================================================
 */

#include <Arduino_RouterBridge.h>

const uint8_t sensorPins[6]      = {A0, A1, A2, A3, A4, A5};
const unsigned long SAMPLE_INTERVAL = 100;   // 10 Hz polling rate

int values[6] = {0, 0, 0, 0, 0, 0};

// ── Expose sensor readings as CSV string to Python via Bridge ─
String get_sensors() {
  String out = "";
  for (int i = 0; i < 6; i++) {
    out += String(values[i]);
    if (i < 5) out += ",";
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
void setup() {
  Bridge.begin();
  Monitor.begin(115200);
  while (!Monitor);

  Monitor.println("======================================");
  Monitor.println("  StampedeShield - App Lab Monitor");
  Monitor.println("======================================");

  for (int i = 0; i < 6; i++) {
    pinMode(sensorPins[i], INPUT);
  }

  // Register get_sensors so Python can call it via Bridge
  Bridge.provide("get_sensors", get_sensors);

  Monitor.println("Bridge ready. Python can now call get_sensors()");
}

// ─────────────────────────────────────────────────────────────
void loop() {
  static unsigned long lastSample = 0;

  if (millis() - lastSample >= SAMPLE_INTERVAL) {
    lastSample = millis();

    // Read all 6 FSR sensors
    for (int i = 0; i < 6; i++) {
      int val = analogRead(sensorPins[i]);
      if (val < 3) val = 0;   // noise floor filter
      values[i] = val;
    }

    // Live display in Monitor
    Monitor.print("FSR1: ");  Monitor.print(values[0]);  Monitor.print(" | ");
    Monitor.print("FSR2: ");  Monitor.print(values[1]);  Monitor.print(" | ");
    Monitor.print("FSR3: ");  Monitor.print(values[2]);  Monitor.print(" | ");
    Monitor.print("FSR4: ");  Monitor.print(values[3]);  Monitor.print(" | ");
    Monitor.print("FSR5: ");  Monitor.print(values[4]);  Monitor.print(" | ");
    Monitor.print("FSR6: ");  Monitor.println(values[5]);
  }
}
