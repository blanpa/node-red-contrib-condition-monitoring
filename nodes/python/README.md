# Python Scripts

This directory contains Python scripts for ML inference backends.

## Files

### python_bridge.py
Main Python bridge for ML inference. Communicates with Node.js via JSON over stdin/stdout.

**Supported frameworks:**
- TensorFlow Lite (`.tflite`)
- Keras (`.h5`, `.keras`)
- scikit-learn (`.pkl`, `.joblib`)

**Usage:** Automatically spawned by `python-bridge-manager.js`

### max_bridge.py
HTTP server for MAX Engine integration. Provides optimized ONNX inference.

**Endpoints:**
- `GET /health` - Health check
- `GET /status` - Server status
- `POST /load` - Load model
- `POST /predict` - Run inference
- `POST /unload` - Unload model

**Usage:** Run as Docker container or standalone server on port 8765

### coral_inference.py
Google Coral Edge TPU inference script for hardware-accelerated ML.

**Requirements:**
- Google Coral USB Accelerator or Dev Board
- PyCoral library
- TensorFlow Lite models compiled for Edge TPU

## Requirements

```bash
pip install numpy tensorflow tflite-runtime scikit-learn
# For Coral: pip install pycoral
```
