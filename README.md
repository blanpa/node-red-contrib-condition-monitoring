# node-red-contrib-condition-monitoring

A comprehensive Node-RED module for **anomaly detection**, **predictive maintenance**, and **time series analysis**.

[![npm version](https://img.shields.io/npm/v/node-red-contrib-condition-monitoring.svg)](https://www.npmjs.com/package/node-red-contrib-condition-monitoring)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-condition-monitoring.svg)](https://www.npmjs.com/package/node-red-contrib-condition-monitoring)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D2.0.0-red.svg)](https://nodered.org)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D14.0.0-green.svg)](https://nodejs.org)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-yellow.svg)](CHANGELOG.md)

---

## Project Status: v0.3.0 Beta

**Major release - Streamlined architecture with 8 powerful nodes**

- **8 Unified Nodes** - PCA and enhanced core nodes
- **Advanced Diagnostics** - Envelope spectrum, motor current analysis, gearbox cepstrum
- **Reliability Analysis** - Weibull distribution with B-life (B1, B5, B10, B50) integrated in Trend Predictor
- **Consolidated Design** - All functionality accessible through unified nodes (no redundant standalone nodes)

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

- **8 Powerful Nodes** - Complete condition monitoring toolkit
- **10 Anomaly Detection Methods** - Z-Score, IQR, Moving Average, Threshold, Percentile, EMA, CUSUM, Isolation Forest, PCA, Mahalanobis
- **Signal Analysis** - FFT, Vibration Features (RMS, Crest Factor, Kurtosis), Peak Detection, Envelope Analysis, Cepstrum, Autocorrelation (ACF), Sample Entropy, Periodicity Detection
- **Correlation Analysis** - Pearson, Spearman, Cross-Correlation with time lag detection
- **Gearbox Diagnostics** - Cepstrum analysis for gear mesh faults
- **Reliability Analysis** - Weibull distribution, B-life, MTTF, RUL
- **Trend Prediction** - Linear Regression, Exponential Smoothing, Rate of Change
- **Multi-Value Processing** - Split, Analyze, Correlate, Aggregate multiple sensors
- **ML Inference** - TensorFlow.js, ONNX, Keras, scikit-learn, TFLite, Google Coral

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

## Available Nodes (8 Nodes)

All nodes are in the **`condition-monitoring`** category.

### Core Analysis Nodes

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

**ML-based anomaly detection with online learning:**
- Unsupervised learning - no training labels required
- Detects complex, multivariate anomalies
- **3 learning modes:**
  - **Batch** - Retrain when buffer full
  - **Incremental** - Periodic retraining (configurable interval)
  - **Adaptive** - Auto-adjust threshold based on feedback
- Configurable number of trees and samples per tree

### 3. Multi-Value Processor

**4 modes for multi-sensor data:**

| Mode | Function |
|------|----------|
| **Split** | Extract individual values from arrays/objects |
| **Analyze** | Anomaly detection per value (Z-Score, IQR, Threshold, **Mahalanobis**) |
| **Correlate** | Pearson, Spearman, or **Cross-Correlation** between two sensors |
| **Aggregate** | Reduce to single value (Mean, Median, Min, Max, Sum, Range, StdDev) |

**Mahalanobis Distance:** Detects multivariate anomalies considering correlations between sensors.

**Cross-Correlation:** Finds time lag between sensors - detects propagation delays (e.g., temperature wave through pipe).

**Example:**
```
[Sensors] → [Multi-Value (Split)] → [Anomaly Detector] → ...
[Sensors] → [Multi-Value (Aggregate)] → Mean value for dashboard
```

### 4. Signal Analyzer

**5 modes for signal analysis:**

| Mode | Output |
|------|--------|
| **FFT** | Frequency peaks, spectral features |
| **Vibration** | RMS, Crest Factor, Kurtosis, Skewness, Health Score, Autocorrelation, Sample Entropy, Periodicity |
| **Peaks** | Local maxima/minima detection |
| **Envelope** | Bearing fault detection (BPFO, BPFI, BSF, FTF) |
| **Cepstrum** | Gearbox fault detection (GMF, sidebands) |

**Example:**
```
[Vibration Sensor] → [Signal Analyzer (Vibration)] → RMS, Crest Factor
                   → [Signal Analyzer (FFT)] → Frequency Peaks
                   → [Signal Analyzer (Envelope)] → Bearing faults
```

### 5. Trend Predictor

**3 modes for trend analysis:**

| Mode | Output |
|------|--------|
| **Prediction** | Future values, trend direction |
| **RUL** | Remaining Useful Life with confidence intervals |
| **Rate of Change** | First/second derivative, acceleration |

**RUL Features:**
- Configurable failure and warning thresholds
- Multiple time units (hours, minutes, days, cycles)
- Confidence intervals for predictions
- Status: healthy/warning/critical/failed
- **Degradation models:** Linear, Exponential, Weibull (reliability-based)

**Example:**
```
[Temperature] → [Trend Predictor (RUL)] → "RUL: 48.5h (95% confidence)"
```

### 6. Health Index

**Multi-sensor health aggregation:**
- Weighted combination of sensors
- 0-100% health score
- Configurable aggregation methods (Weighted, Minimum, Average, Geometric)
- **Visual threshold configuration** with slider-based UI
- Configurable status levels (healthy, warning, degraded, critical)
- Automatic worst sensor identification

### 7. ML Inference

**Machine Learning model inference with multiple runtime options:**

#### JavaScript Runtimes (npm install)
Work immediately after installation - no additional setup:
- **ONNX** (.onnx) - PyTorch, TensorFlow, scikit-learn models
- **TensorFlow.js** (model.json + .bin) - Keras, TensorFlow models

#### Python Runtimes (Docker/Python required)
Require Python environment with ML libraries:
- **TFLite** (.tflite) - Edge/mobile optimized models
- **Keras** (.keras, .h5) - Native Keras models
- **scikit-learn** (.pkl, .joblib) - Classic ML (Random Forest, SVM, etc.)

#### Hardware Accelerated
- **Google Coral / Edge TPU** - 10-100x faster inference

**Tip:** Use ONNX format for best compatibility across frameworks. The node automatically detects available runtimes and shows warnings for Python-dependent formats.

### 8. PCA Anomaly Detection

**Principal Component Analysis for multi-sensor anomaly detection:**
- Reduces high-dimensional data to principal components
- Detects anomalies using Hotelling's T² and SPE statistics
- **Auto-selects components** based on explained variance threshold
- **Contribution analysis** - identifies which sensor caused the anomaly

| Method | Use Case |
|--------|----------|
| **T²** | Variations within normal operating space |
| **SPE** | New patterns not seen during training |
| **Combined** | Both T² and SPE (recommended) |

---

## Which Node Should I Use?

### Quick Decision Tree

```
What do you want to detect?
├─ Simple threshold violations → Anomaly Detector (Threshold)
├─ Statistical outliers → Anomaly Detector (Z-Score/IQR)
├─ Gradual drift → Anomaly Detector (CUSUM)
├─ Complex patterns → Isolation Forest (with Online Learning)
├─ Multi-sensor anomalies → PCA Anomaly Detection
├─ Vibration issues → Signal Analyzer (Vibration/FFT)
├─ Bearing faults → Signal Analyzer (Envelope Mode)
├─ Gearbox faults → Signal Analyzer (Cepstrum)
├─ Multiple sensors → Multi-Value Processor
├─ Multivariate anomalies → Multi-Value Processor (Mahalanobis)
├─ Aggregate sensors → Multi-Value Processor (Aggregate Mode)
├─ Remaining Useful Life → Trend Predictor (RUL + Weibull)
├─ Future prediction → Trend Predictor (Prediction)
├─ Overall health → Health Index (Visual Thresholds)
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

### Trend Predictor (RUL Mode)

```javascript
// Input
msg.payload = 75.2;
msg.timestamp = Date.now();

// Output (RUL Mode)
{
  "payload": 75.2,
  "rul": {
    "value": 48.5,
    "unit": "hours",
    "lower": 42.1,          // Lower confidence bound
    "upper": 55.2,          // Upper confidence bound
    "confidence": 0.87,     // R-squared
    "status": "warning"     // healthy/warning/critical/failed
  },
  "degradation": {
    "percent": 75.2,        // % toward failure threshold
    "rate": 0.5,            // Degradation rate per sample
    "trend": "increasing"
  },
  "thresholds": {
    "failure": 100,
    "warning": 80
  }
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

### Optional - JavaScript ML Runtimes
- `@tensorflow/tfjs-node` - TensorFlow.js support
- `onnxruntime-node` - ONNX Runtime support

### Optional - Python ML Runtimes (Docker or manual)
For TFLite, Keras, and scikit-learn models:
```bash
pip install numpy tensorflow scikit-learn joblib tflite-runtime
# Use numpy<2 for tflite-runtime compatibility
pip install "numpy<2"
```
Or use the provided Docker image which includes all dependencies.

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

- [x] Consolidate nodes into unified components
- [x] ML Inference with Model Registry
- [x] Google Coral / Edge TPU support
- [x] PCA Anomaly Detection
- [x] Bearing fault detection via Signal Analyzer (Envelope Mode)
- [x] Motor current analysis via Signal Analyzer (FFT Mode)
- [x] Weibull reliability analysis
- [x] Cepstrum analysis for gearbox diagnostics
- [x] Mahalanobis distance for multivariate anomalies
- [ ] Dashboard UI components
- [ ] Pre-trained models for common use cases
- [ ] Real-time charting integration
- [ ] OPC-UA integration

---

**Made with ❤️ for the Node-RED community**
