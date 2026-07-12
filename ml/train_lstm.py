"""
train_lstm.py  —  StampedeShield
Purpose : Train a 2-layer LSTM sequence classifier on field_data.csv.
          Exports two ONNX models:
            ml/lstm_model.onnx        (FP32 — for inspection / debugging)
            ml/lstm_model_int8.onnx   (INT8 quantized — deployed on QNN NPU)

Dataset columns used:
    Features : F1n, F2n, F3n, F4n, F5n, F6n  (pre-normalized 0-1 floats)
    Target   : label  (int  0=SAFE  1=WATCH  2=HIGH  3=CRITICAL)

Sequence length : 20 frames (≈ 2 s at 10 Hz)
Architecture    : LSTM(64 hidden, 2 layers) → Dropout(0.3) → Linear(4)

Usage:
    cd C:/Users/qcwor/Working-Project
    python -m ml.train_lstm
"""

from __future__ import annotations

import os
import math
import numpy as np
import pandas as pd
from pathlib import Path
from collections import Counter

# ── Torch imports ──────────────────────────────────────────────────────────────
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler

# ── ONNX + Quantization imports ───────────────────────────────────────────────
import onnx
import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType

# ──────────────────────────────────────────────────────────────────────────────
# Paths
# ──────────────────────────────────────────────────────────────────────────────
ROOT      = Path(__file__).resolve().parent.parent  # Working-Project/
CSV_PATH  = ROOT / "field_data.csv"
ML_DIR    = ROOT / "ml"
FP32_PATH = ML_DIR / "lstm_model.onnx"
INT8_PATH = ML_DIR / "lstm_model_int8.onnx"
REPORT    = ML_DIR / "training_report.txt"

# ──────────────────────────────────────────────────────────────────────────────
# Hyperparameters
# ──────────────────────────────────────────────────────────────────────────────
SEQ_LEN    = 20      # number of frames per window
STRIDE     = 1       # sliding window step
HIDDEN     = 64      # LSTM hidden size
LAYERS     = 2       # stacked LSTM layers
DROPOUT    = 0.3
BATCH      = 64
EPOCHS     = 25
LR         = 1e-3
LABELS     = ["SAFE", "WATCH", "HIGH", "CRITICAL"]
NUM_CLASSES = 4
FEATURE_COLS = ["F1n", "F2n", "F3n", "F4n", "F5n", "F6n"]


# ──────────────────────────────────────────────────────────────────────────────
# Dataset
# ──────────────────────────────────────────────────────────────────────────────
class FSRSequenceDataset(Dataset):
    """Sliding-window dataset from field_data.csv."""

    def __init__(self, df: pd.DataFrame, seq_len: int = SEQ_LEN, stride: int = STRIDE):
        feats  = df[FEATURE_COLS].values.astype(np.float32)
        labels = df["label"].values.astype(np.int64)

        self.X: list[np.ndarray] = []
        self.y: list[int]        = []

        for start in range(0, len(feats) - seq_len, stride):
            end = start + seq_len
            self.X.append(feats[start:end])          # (seq_len, 6)
            self.y.append(int(labels[end - 1]))       # label of the last frame

        self.X = np.stack(self.X)  # (N, seq_len, 6)
        self.y = np.array(self.y)

    def __len__(self):
        return len(self.y)

    def __getitem__(self, idx):
        return torch.tensor(self.X[idx]), torch.tensor(self.y[idx])


# ──────────────────────────────────────────────────────────────────────────────
# Model
# ──────────────────────────────────────────────────────────────────────────────
class CrowdLSTM(nn.Module):
    """
    2-layer LSTM → Linear classifier.

    Input  : (batch, seq_len=20, features=6)
    Output : (batch, 4)  raw logits
    """

    def __init__(
        self,
        input_size: int = 6,
        hidden: int = HIDDEN,
        num_layers: int = LAYERS,
        num_classes: int = NUM_CLASSES,
        dropout: float = DROPOUT,
    ):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size, hidden, num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
        )
        self.dropout = nn.Dropout(dropout)
        
        # Manual linear layer params to export directly as MatMul + Add in ONNX,
        # bypassing ONNX runtime's buggy replace_gemm_with_matmul transformation
        self.weight = nn.Parameter(torch.randn(num_classes, hidden))
        self.bias   = nn.Parameter(torch.zeros(num_classes))
        
        # Standard PyTorch nn.Linear initialization
        nn.init.kaiming_uniform_(self.weight, a=math.sqrt(5))
        fan_in, _ = nn.init._calculate_fan_in_and_fan_out(self.weight)
        bound = 1.0 / math.sqrt(fan_in) if fan_in > 0 else 0.0
        nn.init.uniform_(self.bias, -bound, bound)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, T, F)
        _, (h_n, _) = self.lstm(x)     # h_n shape: (num_layers, B, H)
        out = h_n[-1]                  # last layer hidden state -> (B, H)
        out = self.dropout(out)
        return torch.matmul(out, self.weight.t()) + self.bias            # (B, C)


# ──────────────────────────────────────────────────────────────────────────────
# Training helpers
# ──────────────────────────────────────────────────────────────────────────────
def make_weighted_sampler(dataset: FSRSequenceDataset) -> WeightedRandomSampler:
    """Create a sampler that over-samples rare classes so all classes are seen equally."""
    counts  = Counter(dataset.y.tolist())
    weights = np.array([1.0 / counts[int(lbl)] for lbl in dataset.y], dtype=np.float32)
    return WeightedRandomSampler(weights=weights, num_samples=len(weights), replacement=True)


def compute_class_accuracy(preds: np.ndarray, labels: np.ndarray) -> dict:
    acc = {}
    for i, name in enumerate(LABELS):
        mask    = labels == i
        if mask.sum() == 0:
            acc[name] = "N/A (no samples)"
        else:
            correct = (preds[mask] == i).sum()
            acc[name] = f"{correct}/{mask.sum()} = {100.*correct/mask.sum():.1f}%"
    return acc


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────
def main():
    ML_DIR.mkdir(exist_ok=True)
    device = torch.device("cpu")
    print(f"[train_lstm] Training device : {device}")
    print(f"[train_lstm] CSV             : {CSV_PATH}")

    # ── Load CSV ──────────────────────────────────────────────────────────────
    df = pd.read_csv(CSV_PATH)
    print(f"[train_lstm] Rows loaded     : {len(df):,}")
    print(f"[train_lstm] Class counts    : {df['label'].value_counts().to_dict()}")

    # ── Train / Val split (80/20, no shuffle to respect temporal order) ───────
    split  = int(0.80 * len(df))
    df_tr  = df.iloc[:split].reset_index(drop=True)
    df_val = df.iloc[split:].reset_index(drop=True)

    ds_train = FSRSequenceDataset(df_tr)
    ds_val   = FSRSequenceDataset(df_val)
    print(f"[train_lstm] Train sequences : {len(ds_train):,}")
    print(f"[train_lstm] Val   sequences : {len(ds_val):,}")

    sampler    = make_weighted_sampler(ds_train)
    loader_tr  = DataLoader(ds_train, batch_size=BATCH, sampler=sampler,  num_workers=0)
    loader_val = DataLoader(ds_val,   batch_size=BATCH, shuffle=False,    num_workers=0)

    # ── Class weights for loss (additional balance) ───────────────────────────
    counts       = Counter(ds_train.y.tolist())
    total        = sum(counts.values())
    class_w      = torch.tensor([total / (NUM_CLASSES * counts[i]) for i in range(NUM_CLASSES)], dtype=torch.float32)
    criterion    = nn.CrossEntropyLoss(weight=class_w)

    # ── Model ─────────────────────────────────────────────────────────────────
    model = CrowdLSTM().to(device)
    opt   = torch.optim.Adam(model.parameters(), lr=LR)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)

    print(f"\n[train_lstm] Starting training for {EPOCHS} epochs ...\n")
    best_val_acc  = 0.0
    best_state    = None

    for epoch in range(1, EPOCHS + 1):
        # ── Train ──────────────────────────────────────────────────────────────
        model.train()
        total_loss = 0.0
        for X_b, y_b in loader_tr:
            X_b, y_b = X_b.to(device), y_b.to(device)
            opt.zero_grad()
            logits = model(X_b)
            loss   = criterion(logits, y_b)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            opt.step()
            total_loss += loss.item()
        sched.step()

        # ── Validate ───────────────────────────────────────────────────────────
        model.eval()
        all_preds, all_lbls = [], []
        with torch.no_grad():
            for X_b, y_b in loader_val:
                logits = model(X_b.to(device))
                preds  = logits.argmax(dim=-1).cpu().numpy()
                all_preds.extend(preds.tolist())
                all_lbls.extend(y_b.numpy().tolist())

        all_preds = np.array(all_preds)
        all_lbls  = np.array(all_lbls)
        val_acc   = (all_preds == all_lbls).mean() * 100.0

        avg_loss = total_loss / len(loader_tr)
        print(f"  Epoch {epoch:3d}/{EPOCHS}  loss={avg_loss:.4f}  val_acc={val_acc:.1f}%")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state   = {k: v.clone() for k, v in model.state_dict().items()}

    print(f"\n[train_lstm] Best val accuracy : {best_val_acc:.1f}%")

    # ── Restore best model ────────────────────────────────────────────────────
    model.load_state_dict(best_state)
    model.eval()

    # ── Save training report ──────────────────────────────────────────────────
    class_acc = compute_class_accuracy(all_preds, all_lbls)
    report_lines = [
        "StampedeShield LSTM — Training Report",
        "=" * 45,
        f"Best overall val accuracy : {best_val_acc:.2f}%",
        "",
        "Per-class validation accuracy:",
    ] + [f"  {k}: {v}" for k, v in class_acc.items()]
    REPORT.write_text("\n".join(report_lines))
    print(f"[train_lstm] Training report saved -> {REPORT}")

    # ── Export FP32 ONNX ──────────────────────────────────────────────────────
    dummy = torch.zeros(1, SEQ_LEN, 6)   # (batch=1, seq=20, features=6)
    torch.onnx.export(
        model,
        dummy,
        str(FP32_PATH),
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        verbose=False,
    )
    print(f"[train_lstm] FP32 ONNX saved -> {FP32_PATH}")

    # ── Verify FP32 ONNX ──────────────────────────────────────────────────────
    onnx_model = onnx.load(str(FP32_PATH))
    onnx.checker.check_model(onnx_model)
    print(f"[train_lstm] FP32 model ONNX check : PASSED")

    # ── INT8 Dynamic Quantization ─────────────────────────────────────────────
    print(f"[train_lstm] Quantizing to INT8 (dynamic) ...")
    quantize_dynamic(
        model_input=str(FP32_PATH),
        model_output=str(INT8_PATH),
        weight_type=QuantType.QUInt8,
    )
    print(f"[train_lstm] INT8 ONNX saved -> {INT8_PATH}")

    # ── Quick sanity inference ────────────────────────────────────────────────
    sess = ort.InferenceSession(str(INT8_PATH), providers=["CPUExecutionProvider"])
    dummy_np = np.zeros((1, SEQ_LEN, 6), dtype=np.float32)
    out = sess.run(None, {"input": dummy_np})[0]  # (1, 4)
    pred_label = LABELS[int(out.argmax())]
    print(f"[train_lstm] Sanity inference output : {pred_label} (logits={out})")
    print(f"\n[train_lstm] SUCCESS: All done. INT8 model ready for NPU deployment.")


if __name__ == "__main__":
    main()
