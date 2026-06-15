#!/usr/bin/env bash
#
# Fetch + generate every model and sample image used by examples/test-suite.json
# into ./test-models/ (which is .gitignored). Run from anywhere.
#
#   bash tools/fetch-models.sh
#
# Downloads (pretrained ONNX + sample photos):
#   squeezenet.onnx     ImageNet classifier        (ONNX Model Zoo)
#   yolov10n.onnx       COCO detector, NMS-free     (HF onnx-community)
#   yolov8n-pose.onnx   COCO 17-keypoint pose        (HF Xenova)
#   depth.onnx          Depth-Anything-v2-small q8   (HF onnx-community)
#   dog.jpg, person.jpg, imagenet_classes.txt
# Generates (need: pip install numpy onnx):
#   times_two/segmentation/detection/obb/instances/polygons/keypoints/
#   heatmap/anomaly/classification.onnx   (tiny deterministic test models)
#   defect_seg.onnx + samples.json        (trained-in-NumPy defect segmenter)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-models

dl() { echo "  ↓ $2"; curl -fsSL -m 300 -o "test-models/$2" "$1"; }

echo "Downloading pretrained models + images…"
dl "https://github.com/onnx/models/raw/main/validated/vision/classification/squeezenet/model/squeezenet1.1-7.onnx" squeezenet.onnx
dl "https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx" yolov10n.onnx
dl "https://huggingface.co/Xenova/yolov8n-pose/resolve/main/onnx/model.onnx" yolov8n-pose.onnx
dl "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx" depth.onnx
dl "https://raw.githubusercontent.com/pytorch/hub/master/images/dog.jpg" dog.jpg
dl "https://raw.githubusercontent.com/ultralytics/yolov5/master/data/images/zidane.jpg" person.jpg
dl "https://raw.githubusercontent.com/pytorch/hub/master/imagenet_classes.txt" imagenet_classes.txt

echo "Generating deterministic test models (needs numpy + onnx)…"
python3 tools/make-test-models.py
python3 tools/train-defect-seg.py
python3 tools/train-bearing-clf.py        # → nodes/models/bearing_fault_clf.onnx (bundled)

echo "Bundling catalog models into nodes/models/ …"
mkdir -p nodes/models
cp -f test-models/defect_seg.onnx nodes/models/defect_seg.onnx

echo
echo "Done. Downloaded models in ./test-models/, bundled (catalog) models in ./nodes/models/. Next:"
echo "  node tools/build-test-suite.js        # regenerate examples/test-suite.json"
echo "  NODE_RED_PORT=1890 docker compose -p cm-latest up -d"
