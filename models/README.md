# Machine Learning Models

This directory contains trained ML models for use with the `ml-inference` Node-RED node.

All models are trained on **realistic synthetic industrial data** simulating:
- Temperature sensors (60-80°C with daily cycles)
- Pressure sensors (4-6 bar with pump cycles)
- Vibration sensors (1-3 mm/s ISO 10816 compliant)
- Flow sensors (90-110 L/min)
- Motor current sensors (15-20A)

## Available Models

### ONNX Models (.onnx)

| Model | Input | Accuracy | Description |
|-------|-------|----------|-------------|
| `sensor-onnx/model.onnx` | 5 values | 99.2% | 5-sensor industrial anomaly detection |
| `sensor-anomaly-onnx/model.onnx` | 5 values | 99.2% | Alias for sensor-onnx |
| `onnx-anomaly/model.onnx` | 10 values | 99.9% | Multi-sensor with cross-correlation |
| `pytorch-vibration/model.onnx` | 8 values | 100% | Bearing fault detection from vibration features |
| `defect-detector-onnx/model.onnx` | 64 values | N/A | Simple defect classification |

### Keras Models (.keras, .h5)

| Model | Input | Accuracy | Description |
|-------|-------|----------|-------------|
| `keras-anomaly/model.keras` | 5 values | 98.8% | Keras 3 format (.keras) |
| `keras-h5-anomaly/model.h5` | 5 values | 98.8% | Legacy HDF5 format (.h5) |

### scikit-learn Models (.pkl, .joblib)

| Model | Input | Accuracy | Description |
|-------|-------|----------|-------------|
| `sklearn-rf/model.pkl` | 5 values | 99.4% | Random Forest classifier |
| `sklearn-gb/model.joblib` | 5 values | 99.5% | Gradient Boosting classifier |

### TFLite Models (.tflite)

| Model | Input | Accuracy | Description |
|-------|-------|----------|-------------|
| `sensor-tflite/model.tflite` | 5 values | 98.5% | Edge-optimized for IoT/Coral |

### TensorFlow SavedModel

| Model | Input | Description |
|-------|-------|-------------|
| `sensor-savedmodel/saved_model/` | 5 values | Full TensorFlow format |

## Supported Formats

| Format | Extension | Runtime | Use Case |
|--------|-----------|---------|----------|
| **ONNX** | `.onnx` | ONNX Runtime (Node.js) | Cross-platform, PyTorch exports |
| **Keras** | `.keras` | Python Bridge | Keras 3 native format |
| **Keras HDF5** | `.h5` | Python Bridge | Legacy Keras/TensorFlow |
| **scikit-learn** | `.pkl`, `.joblib` | Python Bridge | Classical ML (RF, SVM, etc.) |
| **TFLite** | `.tflite` | Python Bridge | Mobile, Edge TPU, IoT |
| **SavedModel** | `saved_model/` | TensorFlow.js | TensorFlow Serving |
| **TensorFlow.js** | `model.json` + `.bin` | TensorFlow.js | Browser, Node.js |

## Usage in Node-RED

Configure the `ml-inference` node with:

```
Model Type: Auto-detect (or specific type)
Model Path: /data/models/<model-folder>/<model-file>
Input Shape: 1,5 (for 5-sensor models)
```

### Example Paths (Docker)

```plaintext
# ONNX
/data/models/sensor-onnx/model.onnx

# Keras
/data/models/keras-anomaly/model.keras

# scikit-learn
/data/models/sklearn-rf/model.pkl

# TFLite
/data/models/sensor-tflite/model.tflite
```

## Input Data Format

All models expect normalized input values in the range 0-1:

```javascript
// 5-sensor model (temp, pressure, vibration, flow, current)
msg.payload = [0.52, 0.41, 0.58, 0.44, 0.56];

// 8-feature vibration model (RMS, Peak, Crest, Kurtosis, Skewness, DomFreq, Centroid, BandEnergy)
msg.payload = [0.3, 0.4, 0.35, 0.32, 0.1, 0.25, 0.4, 0.45];

// 10-sensor model  
msg.payload = [0.52, 0.41, 0.58, 0.44, 0.56, 0.49, 0.47, 0.53, 0.46, 0.54];
```

## Output Interpretation

```javascript
// Binary classification output
msg.prediction = [[0.85]];  // 85% probability of anomaly

// Threshold interpretation
if (msg.prediction[0][0] > 0.5) {
  // Anomaly detected
}
```

## Training Your Own Models

Use the provided training scripts in `/scripts/`:

```bash
# Activate virtual environment
source .venv/bin/activate

# Train all models with realistic data
python scripts/train_realistic_models.py
```

### PyTorch to ONNX

```python
import torch

model = YourModel()
model.eval()

dummy_input = torch.randn(1, input_size)
torch.onnx.export(
    model, 
    dummy_input, 
    "model.onnx",
    input_names=['input'],
    output_names=['output'],
    dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    opset_version=13
)
```

### Keras Model

```python
from tensorflow import keras

model = keras.Sequential([...])
model.compile(optimizer='adam', loss='binary_crossentropy')
model.fit(X_train, y_train)

# Save in Keras 3 format
model.save('model.keras')

# Or legacy HDF5 format
model.save('model.h5')
```

### scikit-learn Model

```python
from sklearn.ensemble import RandomForestClassifier
import joblib

model = RandomForestClassifier(n_estimators=100)
model.fit(X_train, y_train)

# Save with joblib (recommended)
joblib.dump(model, 'model.joblib')

# Or pickle
import pickle
with open('model.pkl', 'wb') as f:
    pickle.dump(model, f)
```

### TensorFlow to TFLite

```python
import tensorflow as tf

model = tf.keras.models.load_model('model.keras')

converter = tf.lite.TFLiteConverter.from_keras_model(model)
converter.optimizations = [tf.lite.Optimize.DEFAULT]
tflite_model = converter.convert()

with open('model.tflite', 'wb') as f:
    f.write(tflite_model)
```

## Directory Structure

```
models/
├── sensor-onnx/
│   ├── model.onnx
│   └── metadata.json
├── onnx-anomaly/
│   ├── model.onnx
│   └── metadata.json
├── pytorch-vibration/
│   ├── model.onnx
│   └── metadata.json
├── keras-anomaly/
│   ├── model.keras
│   └── metadata.json
├── keras-h5-anomaly/
│   ├── model.h5
│   └── metadata.json
├── sklearn-rf/
│   ├── model.pkl
│   └── metadata.json
├── sklearn-gb/
│   ├── model.joblib
│   └── metadata.json
├── sensor-tflite/
│   ├── model.tflite
│   └── metadata.json
├── sensor-savedmodel/
│   ├── saved_model/
│   │   ├── saved_model.pb
│   │   └── variables/
│   └── metadata.json
└── README.md
```

## Google Coral Edge TPU

TFLite models can be used with Google Coral for hardware acceleration.

**Requirements:**
- Google Coral USB Accelerator or Dev Board
- PyCoral library installed
- INT8 quantized TFLite model

**Usage:**
```
Model Type: Coral Edge TPU
Model Path: /data/models/sensor-tflite/model.tflite
```

## Python Bridge

Keras, scikit-learn, and TFLite models use a Python bridge for inference.

**Docker Requirements (already included in docker-compose.dev.yml):**
```dockerfile
RUN pip3 install numpy tensorflow keras scikit-learn joblib tflite-runtime
```

**Local Requirements:**
```bash
pip install numpy tensorflow keras scikit-learn joblib tflite-runtime
```
