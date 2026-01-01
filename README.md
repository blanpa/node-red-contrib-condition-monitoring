# node-red-contrib-condition-monitoring

A comprehensive Node-RED module for **anomaly detection**, **predictive maintenance**, and **time series analysis**.

[![npm version](https://img.shields.io/npm/v/node-red-contrib-condition-monitoring.svg)](https://www.npmjs.com/package/node-red-contrib-condition-monitoring)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-condition-monitoring.svg)](https://www.npmjs.com/package/node-red-contrib-condition-monitoring)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D2.0.0-red.svg)](https://nodered.org)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D14.0.0-green.svg)](https://nodejs.org)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-yellow.svg)](CHANGELOG.md)

---

## Project Status: v0.2.0 Beta

**Major consolidation release - 18 nodes → 7 nodes**

- **Streamlined:** All functionality consolidated into 7 powerful nodes
- **Easier to Use:** Less confusion, clearer purpose per node
- **Same Features:** All original features preserved
- **Modern UI:** Consistent, collapsible configuration sections
- **Breaking Change:** See migration guide below

---

## Important Disclaimer

**This software is provided for condition monitoring and predictive maintenance purposes.**

- **NOT** a replacement for safety-critical systems
- **NOT** suitable as the sole means of safety decision-making
- **Should** be used as an additional monitoring layer
- **Always** validate results with domain experts
- **Follow** proper safety protocols and regulations for your industry

**Use at your own risk. See LICENSE file for full legal terms.**

## Features

- **7 Powerful Nodes** - Consolidated from 18 nodes for easier use
- **10 Anomaly Detection Methods** - Z-Score, IQR, Moving Average, Threshold, Percentile, EMA, CUSUM + Isolation Forest
- **Signal Analysis** - FFT, Vibration Features, Peak Detection
- **Trend Prediction** - Linear Regression, Exponential Smoothing, Rate of Change
- **Multi-Value Processing** - Split, Analyze, Correlate multiple sensors
- **ML Inference** - TensorFlow.js, ONNX, Google Coral support
- **Model Registry** - Hugging Face Hub, MLflow, Custom Registry integration

## Installation

```bash
npm install node-red-contrib-condition-monitoring
```

Or install directly from Node-RED:
1. Menu → Manage palette
2. Install tab
3. Search for `node-red-contrib-condition-monitoring`
4. Click install

## Quick Start

### With Docker Compose (Recommended)

```bash
# Start Node-RED with the module
docker-compose up -d

# Access at http://localhost:1880
```

### Import Example Flows

1. Open Node-RED: `http://localhost:1880`
2. Menu → Import → Examples
3. Select one of the example flows

## Available Nodes (7 Nodes)

All nodes are in the **`condition-monitoring`** category.

### 1. Anomaly Detector

**7 detection methods in one node:**

| Method | Best For |
|--------|----------|
| **Z-Score** | Normal distributions, general purpose |
| **IQR** | Robust to outliers, skewed data |
| **Threshold** | Fixed min/max limits |
| **Percentile** | Dynamic bounds based on data distribution |
| **EMA** | Recent changes, adaptive baseline |
| **CUSUM** | Drift detection, gradual shifts |
| **Moving Average** | Smoothed baseline comparison |

**Example:**
```
[MQTT Sensor] → [Anomaly Detector (Z-Score)] → [Normal] → [Dashboard]
                                              → [Anomaly] → [Alarm]
```

### 2. Isolation Forest

**ML-based anomaly detection:**
- Unsupervised learning
- Detects complex, multivariate anomalies
- No training labels required

### 3. Multi-Value Processor

**3 modes for multi-sensor data:**

| Mode | Function |
|------|----------|
| **Split** | Extract individual values from arrays/objects |
| **Analyze** | Anomaly detection per value (Z-Score, IQR, Threshold) |
| **Correlate** | Pearson/Spearman correlation between two sensors |

**Example:**
```
[Sensors] → [Multi-Value (Split)] → [Anomaly Detector] → ...
```

### 4. Signal Analyzer

**3 modes for signal analysis:**

| Mode | Output |
|------|--------|
| **FFT** | Frequency peaks, spectral features |
| **Vibration** | RMS, Crest Factor, Kurtosis, Skewness, Health Score |
| **Peaks** | Local maxima/minima detection |

**Example:**
```
[Vibration Sensor] → [Signal Analyzer (Vibration)] → RMS, Crest Factor
                   → [Signal Analyzer (FFT)] → Frequency Peaks
```

### 5. Trend Predictor

**2 modes for trend analysis:**

| Mode | Output |
|------|--------|
| **Prediction** | Future values, Remaining Useful Life (RUL) |
| **Rate of Change** | First/second derivative, acceleration |

**Example:**
```
[Temperature] → [Trend Predictor] → "Threshold reached in 48h"
```

### 6. Health Index

**Multi-sensor health aggregation:**
- Weighted combination of sensors
- 0-100% health score
- Configurable aggregation methods

### 7. ML Inference

**Machine Learning model inference:**
- TensorFlow.js models (.json + .bin)
- ONNX models (.onnx)
- Google Coral / Edge TPU (.tflite)
- Model Registry integration (Hugging Face, MLflow, Custom)

**⚠️ Requires custom Docker container** - See Docker setup below.

---

## Which Node Should I Use?

### Quick Decision Tree

```
What do you want to detect?
├─ Simple threshold violations → Anomaly Detector (Threshold)
├─ Statistical outliers → Anomaly Detector (Z-Score/IQR)
├─ Gradual drift → Anomaly Detector (CUSUM)
├─ Complex patterns → Isolation Forest
├─ Vibration issues → Signal Analyzer (Vibration/FFT)
├─ Multiple sensors → Multi-Value Processor
├─ Future prediction → Trend Predictor
├─ Overall health → Health Index
└─ Custom ML model → ML Inference
```

---

## Usage Examples

### Simple Temperature Monitoring

```
[MQTT] → [Anomaly Detector] → [Normal] → [Dashboard]
                             → [Anomaly] → [Email Alert]
```

### Motor Predictive Maintenance

```
[Sensors] → [Multi-Value (Split)] → [Anomaly Detector]
                                  → [Trend Predictor] → RUL Display
                                  → [Signal Analyzer (FFT)] → Frequency Chart
          → [Health Index] → Dashboard
```

### Bearing Vibration Analysis

```
[Vibration] → [Signal Analyzer (Vibration)] → Features
            → [Signal Analyzer (FFT)] → Frequencies
            → [Signal Analyzer (Peaks)] → Impacts
            → [Anomaly Detector (IQR)] → Outliers
```

### ML Anomaly Detection

```
[Features] → [ML Inference (Autoencoder)] → Reconstruction Error → [Anomaly Detector (Threshold)]
```

---

## Migration Guide (v0.x → v1.0)

### Node Mapping

| Old Node(s) | New Node | Notes |
|-------------|----------|-------|
| zscore-anomaly | anomaly-detector | Set `method: zscore` |
| iqr-anomaly | anomaly-detector | Set `method: iqr` |
| threshold-anomaly | anomaly-detector | Set `method: threshold` |
| percentile-anomaly | anomaly-detector | Set `method: percentile` |
| ema-anomaly | anomaly-detector | Set `method: ema` |
| cusum-anomaly | anomaly-detector | Set `method: cusum` |
| moving-average-anomaly | anomaly-detector | Set `method: moving-average` |
| multi-value-splitter | multi-value-processor | Set `mode: split` |
| multi-value-anomaly | multi-value-processor | Set `mode: analyze` |
| correlation-anomaly | multi-value-processor | Set `mode: correlate` |
| fft-analysis | signal-analyzer | Set `mode: fft` |
| vibration-features | signal-analyzer | Set `mode: vibration` |
| peak-detection | signal-analyzer | Set `mode: peaks` |
| trend-prediction | trend-predictor | Set `mode: prediction` |
| rate-of-change | trend-predictor | Set `mode: rate-of-change` |
| isolation-forest-anomaly | isolation-forest | (unchanged) |
| health-index | health-index | (unchanged) |
| ml-inference | ml-inference | (unchanged) |

### Configuration Mapping

**Anomaly Detector:**
```javascript
// Old (zscore-anomaly)
{ threshold: 3.0, warningThreshold: 2.0, windowSize: 100 }

// New (anomaly-detector)
{ method: "zscore", zscoreThreshold: 3.0, zscoreWarning: 2.0, windowSize: 100 }
```

---

## Node Configuration Examples

### Anomaly Detector (Z-Score)

```javascript
// Input
msg.payload = 42.5;

// Output
{
  "payload": 42.5,
  "isAnomaly": true,
  "severity": "critical",
  "method": "zscore",
  "zScore": 3.2,
  "mean": 35.0,
  "stdDev": 2.3,
  "threshold": 3.0,
  "warningThreshold": 2.0,
  "bufferSize": 100,
  "windowSize": 100
}
```

### Signal Analyzer (FFT)

```javascript
// Input (continuous stream)
msg.payload = 0.45;

// Output
{
  "payload": 0.45,
  "peaks": [
    { "frequency": 30, "magnitude": 0.5 },
    { "frequency": 157, "magnitude": 0.3 }
  ],
  "dominantFrequency": 30,
  "features": {
    "spectralCentroid": 85.2,
    "crestFactor": 3.5,
    "rms": 0.42
  }
}
```

### Trend Predictor (RUL)

```javascript
// Input
msg.payload = 75.2;
msg.timestamp = Date.now();

// Output
{
  "payload": 75.2,
  "trend": "increasing",
  "slope": 0.5,
  "predictedValues": [76.2, 76.7, 77.2, ...],
  "timeToThreshold": 172800000,
  "stepsToThreshold": 96
}
```

---

## Docker Setup

### For ML Inference Node

**The ML Inference node requires a Debian-based container with native dependencies.**

```bash
# Use the provided docker-compose.dev.yml
docker-compose -f docker-compose.dev.yml up

# This builds a custom image with:
# - Python 3 + build tools
# - TensorFlow.js Node bindings
# - ONNX Runtime Node bindings
```

### Standard Setup

```bash
# Production mode
docker-compose up

# Development mode (hot-reload)
docker-compose -f docker-compose.dev.yml up
```

---

## Dependencies

### Required
- Node-RED >= 2.0.0
- Node.js >= 14.0.0

### Core Dependencies
- `ml-isolation-forest` - For Isolation Forest node
- `simple-statistics` - For statistical functions

### Optional (ML Inference)
- `@tensorflow/tfjs-node` - TensorFlow.js support
- `onnxruntime-node` - ONNX Runtime support

---

## Documentation

- **[models/README.md](models/README.md)** - ML models guide and training instructions
- **[CHANGELOG.md](CHANGELOG.md)** - Version history and changes

---

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests if applicable
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Author

**blanpa**

---

## Roadmap

- [x] Consolidate 18 nodes → 7 nodes
- [x] ML Inference with Model Registry
- [x] Google Coral / Edge TPU support
- [ ] Dashboard UI components
- [ ] Pre-trained models for common use cases
- [ ] Real-time charting integration

---

**Made with ❤️ for the Node-RED community**
