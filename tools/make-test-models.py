#!/usr/bin/env python3
"""Generate tiny deterministic ONNX models used by examples/test-suite.json.

    python3 tools/make-test-models.py        # writes into test-models/

Requires: pip install onnx  (only needed to (re)generate the artifacts).
The models are intentionally trivial (constant / elementwise) so the test
suite can validate exact, hand-derived outputs without training anything.
"""
import os
import onnx
from onnx import helper, TensorProto

OUT = os.path.join(os.path.dirname(__file__), "..", "test-models")
os.makedirs(OUT, exist_ok=True)


def save(model, name):
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model, os.path.join(OUT, name))
    print("wrote", name)


def times_two():
    """output = input * 2  (numeric ml-inference smoke test)."""
    inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 4])
    out = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 4])
    two = helper.make_tensor("two", TensorProto.FLOAT, [1], [2.0])
    g = helper.make_graph(
        [helper.make_node("Constant", [], ["twoc"], value=two),
         helper.make_node("Mul", ["input", "twoc"], ["output"])],
        "times_two", [inp], [out])
    save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)]), "times_two.onnx")


def segmentation():
    """Constant [1,3,4,4] logits -> argmax mask: left half class 1, right half class 2."""
    inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 4, 4])
    out = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, 4, 4])
    ch0 = [0.0] * 16
    ch1 = ([5, 5, 0, 0] * 4)   # class 1 wins on the left two columns
    ch2 = ([0, 0, 5, 5] * 4)   # class 2 wins on the right two columns
    vals = [float(v) for v in (ch0 + ch1 + ch2)]
    t = helper.make_tensor("seg", TensorProto.FLOAT, [1, 3, 4, 4], vals)
    g = helper.make_graph([helper.make_node("Constant", [], ["output"], value=t)],
                          "seg", [inp], [out])
    save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)]), "segmentation.onnx")


def detection():
    """Constant [1,2,6] decoded boxes: [x1,y1,x2,y2,score,class]."""
    inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 100, 100])
    out = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 2, 6])
    boxes = [10, 10, 40, 40, 0.9, 0,
             50, 20, 90, 70, 0.8, 1]
    t = helper.make_tensor("boxes", TensorProto.FLOAT, [1, 2, 6], [float(v) for v in boxes])
    g = helper.make_graph([helper.make_node("Constant", [], ["output"], value=t)],
                          "detect", [inp], [out])
    save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)]), "detection.onnx")


def _const_model(name, shape, values, in_shape=(1, 1)):
    """A graph whose output is a constant tensor (input is declared but ignored)."""
    inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, list(in_shape))
    out = helper.make_tensor_value_info("output", TensorProto.FLOAT, shape)
    t = helper.make_tensor("c", TensorProto.FLOAT, shape, [float(v) for v in values])
    g = helper.make_graph([helper.make_node("Constant", [], ["output"], value=t)], name, [inp], [out])
    save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)]), name + ".onnx")


def obb():
    # [1,1,7] = cx,cy,w,h,angle(rad),score,class  -> one rotated box (~30 deg)
    _const_model("obb", [1, 1, 7], [50, 50, 40, 20, 0.5236, 0.9, 0])


def instances():
    # [1,2,8,8] two binary masks: inst0 top-left 3x3 (area 9), inst1 bottom-right 4x4 (area 16)
    m0 = [1 if (h < 3 and w < 3) else 0 for h in range(8) for w in range(8)]
    m1 = [1 if (h >= 4 and w >= 4) else 0 for h in range(8) for w in range(8)]
    _const_model("instances", [1, 2, 8, 8], m0 + m1)


def polygons():
    # [1,1,4,2] one rectangle polygon -> area 50*30=1500, perimeter 2*(50+30)=160
    _const_model("polygons", [1, 1, 4, 2], [10, 10, 60, 10, 60, 40, 10, 40])


def keypoints():
    # [1,3,3] three keypoints (x,y,conf); kp2 below the 0.5 visibility threshold
    _const_model("keypoints", [1, 3, 3], [20, 20, 0.9, 40, 50, 0.8, 60, 20, 0.3])


def heatmap():
    # [1,1,4,4] gradient 0..15
    _const_model("heatmap", [1, 1, 4, 4], list(range(16)))


def anomaly():
    # [1,1,8,8] zeros except a 2x2 block of 1.0 (4 px) at rows 2-3, cols 2-3
    vals = [1.0 if (2 <= h <= 3 and 2 <= w <= 3) else 0.0 for h in range(8) for w in range(8)]
    _const_model("anomaly", [1, 1, 8, 8], vals)


def classification():
    # [1,4] class scores -> top class 1 @ 0.7
    _const_model("classification", [1, 4], [0.1, 0.7, 0.15, 0.05])


if __name__ == "__main__":
    times_two()
    segmentation()
    detection()
    obb()
    instances()
    polygons()
    keypoints()
    heatmap()
    anomaly()
    classification()
    print("done ->", os.path.normpath(OUT))
