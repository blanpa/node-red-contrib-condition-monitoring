#!/usr/bin/env python3
"""Train a small vibration fault classifier (pure NumPy) → ONNX.

A bundled, MIT-licensed "common use case" model: given 5 normalized vibration
order-features it classifies the dominant machine fault.

    Input  [1,5] = [rms, amp_1x, amp_2x, amp_3.5x, amp_0.5x]   (each ~0..1)
    Output [1,5] = logits for classes
                   [healthy, imbalance, misalignment, bearing, looseness]

Maps to condition-monitoring-source: imbalance→1×, misalignment→2×,
bearing→~3.5× (BPFO), looseness→0.5×. Realised as Gemm→Relu→Gemm so ONNX
Runtime sees a real MLP.

    python3 tools/train-bearing-clf.py      # writes nodes/models/bearing_fault_clf.onnx

Requires (host): numpy, onnx.
"""
import os
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

rng = np.random.default_rng(11)
OUT = os.path.join(os.path.dirname(__file__), "..", "nodes", "models")
os.makedirs(OUT, exist_ok=True)
CLASSES = ["healthy", "imbalance", "misalignment", "bearing", "looseness"]
# which order-feature (index 1..4) each fault drives; healthy drives none
DRIVE = {1: 1, 2: 2, 3: 3, 4: 4}  # class -> feature index


def sample(cls):
    f = np.clip(rng.normal(0.12, 0.05, 5), 0, 1)  # low baseline (incl. rms at f[0])
    if cls != 0:
        idx = DRIVE[cls]
        f[idx] = np.clip(rng.uniform(0.55, 1.0), 0, 1)  # dominant order
        f[0] = np.clip(0.3 + 0.6 * f[idx] + rng.normal(0, 0.05), 0, 1.5)  # rms rises with severity
    return f.astype(np.float32)


def dataset(n):
    X, Y = [], []
    for i in range(n):
        c = i % 5
        X.append(sample(c)); Y.append(c)
    return np.array(X, np.float32), np.array(Y)


Xtr, Ytr = dataset(2500)
n_in, n_hid, n_out = 5, 16, 5
W1 = rng.normal(0, 0.4, (n_hid, n_in)).astype(np.float32); b1 = np.zeros(n_hid, np.float32)
W2 = rng.normal(0, 0.4, (n_out, n_hid)).astype(np.float32); b2 = np.zeros(n_out, np.float32)
vs = {k: np.zeros_like(v) for k, v in dict(W1=W1, b1=b1, W2=W2, b2=b2).items()}
lr, mom, M = 0.3, 0.9, Xtr.shape[0]
Yoh = np.eye(n_out, dtype=np.float32)[Ytr]
for epoch in range(800):
    Z1 = Xtr @ W1.T + b1; A1 = np.maximum(Z1, 0)
    Z2 = A1 @ W2.T + b2; Z2 -= Z2.max(1, keepdims=True)
    P = np.exp(Z2); P /= P.sum(1, keepdims=True)
    dZ2 = (P - Yoh) / M
    dW2 = dZ2.T @ A1; db2 = dZ2.sum(0)
    dZ1 = (dZ2 @ W2) * (Z1 > 0); dW1 = dZ1.T @ Xtr; db1 = dZ1.sum(0)
    for name, p, g in (("W2", W2, dW2), ("b2", b2, db2), ("W1", W1, dW1), ("b1", b1, db1)):
        vs[name] *= mom; vs[name] += g; p -= lr * vs[name]
    if epoch % 200 == 0 or epoch == 799:
        acc = (P.argmax(1) == Ytr).mean()
        print(f"epoch {epoch:3d}  acc {acc:.4f}")

Xv, Yv = dataset(500)
pred = (np.maximum(Xv @ W1.T + b1, 0) @ W2.T + b2).argmax(1)
print(f"val acc {(pred == Yv).mean():.4f}")

# --- export ONNX: Gemm(transB) -> Relu -> Gemm(transB) ----------------------
inits = [numpy_helper.from_array(W1, "W1"), numpy_helper.from_array(b1, "b1"),
         numpy_helper.from_array(W2, "W2"), numpy_helper.from_array(b2, "b2")]
nodes = [
    helper.make_node("Gemm", ["input", "W1", "b1"], ["h"], transB=1),
    helper.make_node("Relu", ["h"], ["hr"]),
    helper.make_node("Gemm", ["hr", "W2", "b2"], ["output"], transB=1),
]
graph = helper.make_graph(nodes, "bearing_fault_clf",
                          [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 5])],
                          [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 5])],
                          initializer=inits)
m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)]); m.ir_version = 9
onnx.checker.check_model(m)
onnx.save(m, os.path.join(OUT, "bearing_fault_clf.onnx"))
print("wrote nodes/models/bearing_fault_clf.onnx  classes:", ",".join(CLASSES))
