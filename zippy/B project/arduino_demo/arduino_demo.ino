/**
 * StampedeShield - Arduino FSR Sensor Telemetry Sketch
 * 
 * This code reads pressure values from six Force Sensitive Resistor (FSR) sensors
 * and transmits them over Serial (which maps to USB or Bluetooth SPP modules)
 * in a clean comma-separated CSV format expected by the StampedeShield Dashboard.
 * 
 * Data Format Transmitted:
 * F1,F2,F3,F4,F5,F6
 * e.g., "120,450,80,0,15,300"
 * 
 * --- HARDWARE SCHEMATIC ---
 * Connect 6 FSRs using a voltage divider configuration for each:
 * 
 * [VCC (5V)] --- [ FSR Sensor ] --- (Analog Pin A0..A5) --- [ 10k Ohm Resistor ] --- [ GND ]
 * 
 * FSR Sensor 1 -> Analog Pin A0
 * FSR Sensor 2 -> Analog Pin A1
 * FSR Sensor 3 -> Analog Pin A2
 * FSR Sensor 4 -> Analog Pin A3
 * FSR Sensor 5 -> Analog Pin A4
 * FSR Sensor 6 -> Analog Pin A5
 */

// Define analog input pins mapping
const int sensorPins[6] = {A0, A1, A2, A3, A4, A5};

// Sample rate setting: 10 Hz (every 100 milliseconds)
const unsigned long sampleInterval = 1000;
unsigned long lastSampleTime = 0;

// Filter threshold: ignore low noise values (below 15)
const int noiseThreshold = 15;

void setup() {
  // Start Serial connection at 9600 baud rate (matching the dashboard default)
  // If using Bluetooth modules like HC-05 / HC-06, ensure it is configured for 9600.
  Serial.begin(9600);
  
  // Configure analog pins as inputs (optional but good practice)
  for (int i = 0; i < 6; i++) {
    pinMode(sensorPins[i], INPUT);
  }
}

void loop() {
  unsigned long currentTime = millis();
  
  // Non-blocking timer check
  if (currentTime - lastSampleTime >= sampleInterval) {
    lastSampleTime = currentTime;
    
    int sensorValues[6];
    
    // Read all six sensors
    for (int i = 0; i < 6; i++) {
      int rawVal = analogRead(sensorPins[i]);
      
      // Apply noise threshold
      if (rawVal < noiseThreshold) {
        rawVal = 0;
      }
      
      sensorValues[i] = rawVal;
    }
    
    // Format output CSV: "F1,F2,F3,F4,F5,F6"
    for (int i = 0; i < 6; i++) {
      Serial.print(sensorValues[i]);
      if (i < 5) {
        Serial.print(",");
      }
    }
    // Print newline character to terminate packet
    Serial.println();
  }
}
