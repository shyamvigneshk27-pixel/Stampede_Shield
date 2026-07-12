# build_dataset.py
import numpy as np
import pandas as pd

WINDOW = 20
STEP = 5
SENSOR_MAX = [515.0, 1023.0, 575.0, 630.0, 570.0, 210.0]

def build():
    df = pd.read_csv("field_data.csv")
    raw = df[["F1", "F2", "F3", "F4", "F5", "F6"]].values.astype(np.float32)
    
    # Normalize per-sensor
    sensors = np.clip(raw / np.array(SENSOR_MAX, dtype=np.float32), 0.0, 1.0)
    labels = df["label"].values.astype(np.int64)
    
    X, y = [], []
    for start in range(0, len(sensors) - WINDOW, STEP):
        X.append(sensors[start : start + WINDOW])
        y.append(labels[start + WINDOW - 1])
        
    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.int64)
    
    # Shuffle
    idx = np.random.permutation(len(X))
    np.save("X_real.npy", X[idx])
    np.save("y_real.npy", y[idx])
    print(f"Created dataset. X: {X.shape}, y: {y.shape}")

if __name__ == "__main__":
    build()