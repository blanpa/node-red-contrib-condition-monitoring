#!/usr/bin/env python3
"""Train a small defect-segmentation CNN (pure NumPy) and export it to ONNX.

The model is a per-pixel MLP (3 -> 8 -> 2) realised as two 1x1 convolutions, so
ONNX Runtime sees a real Conv->Relu->Conv graph that maps [1,3,H,W] -> [1,2,H,W]
logits (background / defect). It genuinely learns from synthetic data: bright
circular "defects" on darker, noisy backgrounds.

    python3 tools/train-defect-seg.py

Outputs:
    test-models/defect_seg.onnx   the trained model
    test-models/samples.json      one defect + one clean 32x32 sample (0..255 RGB)

Requires (host): numpy, onnx.
"""
import os, json
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

rng = np.random.default_rng(7)
H = W = 32
OUT = os.path.join(os.path.dirname(__file__), "..", "test-models")
os.makedirs(OUT, exist_ok=True)


def make_image(defect=True):
    """Return (img HxWx3 in 0..1, mask HxW 0/1)."""
    base = rng.uniform(0.05, 0.35, size=3)
    img = np.clip(base[None, None, :] + rng.normal(0, 0.04, (H, W, 3)), 0, 1)
    mask = np.zeros((H, W), np.int64)
    if defect:
        cy, cx = rng.integers(8, 24, size=2)
        r = rng.integers(4, 8)
        yy, xx = np.mgrid[0:H, 0:W]
        sel = (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r
        bright = rng.uniform(0.75, 1.0, size=3)
        img[sel] = np.clip(bright + rng.normal(0, 0.04, (sel.sum(), 3)), 0, 1)
        mask[sel] = 1
    return img.astype(np.float32), mask


def dataset(n):
    X, Y = [], []
    for i in range(n):
        img, mask = make_image(defect=(i % 2 == 0))
        X.append(img.reshape(-1, 3))
        Y.append(mask.reshape(-1))
    return np.concatenate(X), np.concatenate(Y)


# --- training (per-pixel MLP, full-batch gradient descent + momentum) --------
Xtr, Ytr = dataset(240)
n_in, n_hid, n_out = 3, 8, 2
W1 = (rng.normal(0, 0.5, (n_hid, n_in))).astype(np.float32)
b1 = np.zeros(n_hid, np.float32)
W2 = (rng.normal(0, 0.5, (n_out, n_hid))).astype(np.float32)
b2 = np.zeros(n_out, np.float32)
vW1 = np.zeros_like(W1); vb1 = np.zeros_like(b1); vW2 = np.zeros_like(W2); vb2 = np.zeros_like(b2)
lr, mom = 0.5, 0.9
M = Xtr.shape[0]
Yoh = np.eye(n_out, dtype=np.float32)[Ytr]

for epoch in range(600):
    Z1 = Xtr @ W1.T + b1
    A1 = np.maximum(Z1, 0)
    Z2 = A1 @ W2.T + b2
    Z2 -= Z2.max(1, keepdims=True)
    P = np.exp(Z2); P /= P.sum(1, keepdims=True)
    # gradients
    dZ2 = (P - Yoh) / M
    dW2 = dZ2.T @ A1; db2 = dZ2.sum(0)
    dA1 = dZ2 @ W2; dZ1 = dA1 * (Z1 > 0)
    dW1 = dZ1.T @ Xtr; db1 = dZ1.sum(0)
    for p, g, v in ((W2, dW2, vW2), (b2, db2, vb2), (W1, dW1, vW1), (b1, db1, vb1)):
        v *= mom; v += g; p -= lr * v
    if epoch % 150 == 0 or epoch == 599:
        acc = (P.argmax(1) == Ytr).mean()
        loss = -np.log(P[np.arange(M), Ytr] + 1e-9).mean()
        print(f"epoch {epoch:3d}  loss {loss:.4f}  pixel-acc {acc:.4f}")

# IoU on a fresh validation set
Xv, Yv = dataset(60)
Z1 = np.maximum(Xv @ W1.T + b1, 0)
pred = (Z1 @ W2.T + b2).argmax(1)
inter = ((pred == 1) & (Yv == 1)).sum(); union = ((pred == 1) | (Yv == 1)).sum()
print(f"val defect IoU {inter / max(union,1):.4f}  pixel-acc {(pred==Yv).mean():.4f}")

# --- export to ONNX (Conv 1x1 -> Relu -> Conv 1x1) ---------------------------
w1 = W1.reshape(n_hid, n_in, 1, 1).astype(np.float32)
w2 = W2.reshape(n_out, n_hid, 1, 1).astype(np.float32)
inits = [
    numpy_helper.from_array(w1, "w1"), numpy_helper.from_array(b1.astype(np.float32), "b1"),
    numpy_helper.from_array(w2, "w2"), numpy_helper.from_array(b2.astype(np.float32), "b2"),
]
nodes = [
    helper.make_node("Conv", ["input", "w1", "b1"], ["h"], kernel_shape=[1, 1]),
    helper.make_node("Relu", ["h"], ["hr"]),
    helper.make_node("Conv", ["hr", "w2", "b2"], ["output"], kernel_shape=[1, 1]),
]
graph = helper.make_graph(nodes, "defect_seg",
                          [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, H, W])],
                          [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 2, H, W])],
                          initializer=inits)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 9
onnx.checker.check_model(model)
onnx.save(model, os.path.join(OUT, "defect_seg.onnx"))
print("wrote defect_seg.onnx")

# --- save one defect + one clean sample for the test flow --------------------
dimg, _ = make_image(defect=True)
cimg, _ = make_image(defect=False)
json.dump({
    "width": W, "height": H,
    "defect": (dimg.reshape(-1) * 255).round().astype(int).tolist(),
    "clean": (cimg.reshape(-1) * 255).round().astype(int).tolist(),
}, open(os.path.join(OUT, "samples.json"), "w"))
print("wrote samples.json")
