"""
Phase 0: Export PyTorch LSTM to ONNX for onnxruntime-web.

Run from the CV_to_StreetFighter directory:
    python ../street_fighter_live/export_model.py
"""

import sys
import os
import json
import pickle
import numpy as np
import torch

# Allow imports from the original project
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../CV_to_StreetFighter")

from Models.LSTM_v1.lstm_model import LSTMWindowClassifier

# ── Paths ────────────────────────────────────────────────────────────────────
CV_PROJECT = os.path.join(os.path.dirname(__file__), "../CV_to_StreetFighter")
MODEL_PATH = os.path.join(CV_PROJECT, "Models/LSTM_v1/phase2LSTM_128_1_FINAL.pth")
ENCODER_PATH = os.path.join(CV_PROJECT, "Models/LSTM_v1/label_encoder.pkl")

OUT_DIR = os.path.join(os.path.dirname(__file__), "public/model")
OUT_ONNX = os.path.join(OUT_DIR, "lstm_pose.onnx")
OUT_LABELS = os.path.join(OUT_DIR, "labels.json")

os.makedirs(OUT_DIR, exist_ok=True)

# ── Load label encoder ───────────────────────────────────────────────────────
print("Loading label encoder...")
with open(ENCODER_PATH, "rb") as f:
    label_encoder = pickle.load(f)

classes = list(label_encoder.classes_)
num_classes = len(classes)
print(f"  Classes ({num_classes}): {classes}")

# ── Load model ───────────────────────────────────────────────────────────────
print("Loading model weights...")
model = LSTMWindowClassifier(
    input_size=84,
    hidden_size=128,
    num_layers=1,
    num_classes=num_classes,
    dropout=0,  # no dropout at inference
)
model.load_state_dict(torch.load(MODEL_PATH, map_location="cpu"))
model.eval()

# ── Export to ONNX ───────────────────────────────────────────────────────────
# Input: (batch=1, sequence_length=5, features=84)
dummy_input = torch.zeros(1, 5, 84, dtype=torch.float32)

print(f"Exporting ONNX to {OUT_ONNX} ...")
torch.onnx.export(
    model,
    dummy_input,
    OUT_ONNX,
    opset_version=17,
    input_names=["pose_sequence"],
    output_names=["logits"],
    dynamic_axes={
        "pose_sequence": {0: "batch_size"},
        "logits": {0: "batch_size"},
    },
)
print("  Done.")

# ── Validate: compare PyTorch vs ONNX outputs ────────────────────────────────
print("Validating ONNX output against PyTorch...")
try:
    import onnxruntime as ort

    sess = ort.InferenceSession(OUT_ONNX, providers=["CPUExecutionProvider"])
    test_input = np.random.randn(1, 5, 84).astype(np.float32)

    with torch.no_grad():
        torch_out = model(torch.tensor(test_input)).numpy()

    onnx_out = sess.run(["logits"], {"pose_sequence": test_input})[0]

    max_diff = np.abs(torch_out - onnx_out).max()
    print(f"  Max output difference (PyTorch vs ONNX): {max_diff:.2e}")
    if max_diff < 1e-4:
        print("  PASS — outputs match.")
    else:
        print("  WARNING — outputs differ more than expected. Check the model.")
except ImportError:
    print("  onnxruntime not installed — skipping validation.")
    print("  Install with: pip install onnxruntime")

# ── Export label classes as JSON ─────────────────────────────────────────────
print(f"Writing labels to {OUT_LABELS} ...")
with open(OUT_LABELS, "w") as f:
    json.dump([str(c) for c in classes], f, indent=2)
print("  Done.")

print("\nPhase 0 complete. Files written:")
print(f"  {OUT_ONNX}")
print(f"  {OUT_LABELS}")
