# Architecture Overview

This document describes the architecture of the `node-red-contrib-condition-monitoring` package, including node relationships, data flow patterns, and system design decisions.

## Table of Contents

- [System Overview](#system-overview)
- [Node Categories](#node-categories)
- [Data Flow Patterns](#data-flow-patterns)
- [Runtime Components](#runtime-components)
- [State Management](#state-management)
- [Extension Points](#extension-points)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Node-RED Condition Monitoring Package                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐       │
│  │  Data Input      │───▶│  Processing      │───▶│  Output/Action   │       │
│  │  (Sensors, APIs) │    │  Nodes           │    │  (Alerts, DB)    │       │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘       │
│                                 │                                            │
│                    ┌────────────┴────────────┐                              │
│                    ▼                         ▼                              │
│           ┌───────────────┐         ┌───────────────┐                       │
│           │ State         │         │ ML Inference  │                       │
│           │ Persistence   │         │ Runtimes      │                       │
│           └───────────────┘         └───────────────┘                       │
│                                            │                                 │
│                          ┌─────────────────┼─────────────────┐              │
│                          ▼                 ▼                 ▼              │
│                    ┌──────────┐     ┌──────────┐     ┌──────────┐          │
│                    │ ONNX     │     │ TF.js    │     │ Python   │          │
│                    │ Runtime  │     │ Runtime  │     │ Bridge   │          │
│                    └──────────┘     └──────────┘     └──────────┘          │
│                                                             │               │
│                                                      ┌──────┴──────┐       │
│                                                      ▼             ▼       │
│                                               ┌──────────┐  ┌──────────┐   │
│                                               │ TFLite   │  │ Keras    │   │
│                                               │ Sklearn  │  │ MAX      │   │
│                                               └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Node Categories

### 1. Anomaly Detection Nodes

These nodes identify unusual patterns in sensor data.

| Node | Purpose | Methods |
|------|---------|---------|
| **anomaly-detector** | Single/multi-sensor statistical anomaly detection | Z-Score, IQR, Threshold, Percentile, EMA, CUSUM, Moving Average |
| **isolation-forest** | ML-based unsupervised anomaly detection | Isolation Forest algorithm |
| **pca-anomaly** | Multivariate anomaly detection | PCA with Hotelling's T² and SPE |

```
┌─────────────────────────────────────────────────────────────────┐
│                     Anomaly Detection Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Sensor Data ──▶ [Buffer] ──▶ [Statistical Analysis] ──▶ Score │
│        │              │                   │                │     │
│        │              │                   │                ▼     │
│        │              ▼                   ▼         ┌──────────┐ │
│        │         Window Size        Method-specific │ Hysteresis│ │
│        │         Management         Parameters      │ Filter   │ │
│        │                                           └──────────┘ │
│        │                                                  │     │
│        │                                                  ▼     │
│        │                                         ┌─────────────┐│
│        └────────────────────────────────────────▶│ Output 1:   ││
│                                                  │ Normal      ││
│                                                  ├─────────────┤│
│                                                  │ Output 2:   ││
│                                                  │ Anomaly     ││
│                                                  └─────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 2. Signal Processing Nodes

Analyze vibration and frequency data for predictive maintenance.

| Node | Purpose | Modes |
|------|---------|-------|
| **signal-analyzer** | Advanced signal processing | FFT, Vibration Analysis, Peak Detection, Envelope Analysis, Cepstrum |

```
┌─────────────────────────────────────────────────────────────────┐
│                    Signal Analyzer Modes                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Raw Signal ──┬──▶ [FFT Mode] ──▶ Frequency Spectrum            │
│               │                   Peak Frequencies               │
│               │                   Spectral Features              │
│               │                                                  │
│               ├──▶ [Vibration Mode] ──▶ RMS, Crest Factor       │
│               │                        Kurtosis, Skewness        │
│               │                        ISO 10816-3 Assessment    │
│               │                                                  │
│               ├──▶ [Peak Detection] ──▶ Local Maxima/Minima     │
│               │                                                  │
│               ├──▶ [Envelope Analysis] ──▶ Bearing Fault        │
│               │                           Detection              │
│               │                                                  │
│               └──▶ [Cepstrum] ──▶ Gearbox Fault Detection       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3. Predictive Maintenance Nodes

Forecast equipment health and remaining useful life.

| Node | Purpose | Features |
|------|---------|----------|
| **trend-predictor** | Trend analysis and RUL prediction | Linear/Exponential/Weibull degradation models |
| **health-index** | Multi-sensor health aggregation | Weighted average, Dynamic weighting, Geometric mean |

```
┌─────────────────────────────────────────────────────────────────┐
│                    RUL Prediction Pipeline                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Historical Data ──▶ [Trend Analysis] ──▶ Degradation Rate      │
│                              │                    │              │
│                              ▼                    ▼              │
│                     ┌────────────────┐   ┌────────────────┐     │
│                     │ Theil-Sen      │   │ Weibull        │     │
│                     │ Robust Fit     │   │ Analysis       │     │
│                     └────────────────┘   └────────────────┘     │
│                              │                    │              │
│                              └────────┬──────────┘              │
│                                       ▼                          │
│                              ┌────────────────┐                  │
│                              │ RUL Estimate   │                  │
│                              │ + Confidence   │                  │
│                              └────────────────┘                  │
│                                       │                          │
│                                       ▼                          │
│                     ┌────────────────────────────────┐          │
│                     │ Status: healthy/warning/       │          │
│                     │         critical/failed        │          │
│                     └────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### 4. Multi-Sensor Processing Nodes

Handle multiple data streams simultaneously.

| Node | Purpose | Modes |
|------|---------|-------|
| **multi-value-processor** | Process multiple sensor values | Split, Analyze, Correlate, Aggregate |

### 5. Machine Learning Nodes

Integrate trained ML models for inference.

| Node | Purpose | Runtimes |
|------|---------|----------|
| **ml-inference** | Run ML model predictions | ONNX, TensorFlow.js, TFLite, Keras, scikit-learn, MAX Engine |
| **training-data-collector** | Collect labeled training data | CSV, JSONL, JSON with S3 upload |

---

## Data Flow Patterns

### Pattern 1: Single Sensor Monitoring

```
[Sensor Input] ──▶ [anomaly-detector] ──┬──▶ [Normal Path]
                                        │
                                        └──▶ [Anomaly Alert]
```

### Pattern 2: Multi-Sensor Correlation

```
┌─────────────┐
│ Sensor A    │──┐
└─────────────┘  │
                 ├──▶ [multi-value-processor] ──▶ [Correlation Analysis]
┌─────────────┐  │           (correlate mode)
│ Sensor B    │──┘
└─────────────┘
```

### Pattern 3: Predictive Maintenance Pipeline

```
[Vibration Sensor] ──▶ [signal-analyzer] ──▶ [health-index] ──▶ [trend-predictor]
                       (vibration mode)     (aggregation)       (RUL mode)
                              │                   │                   │
                              ▼                   ▼                   ▼
                         ISO 10816-3        Health Score         Days to
                         Assessment           (0-100)           Failure
```

### Pattern 4: ML-Augmented Detection

```
[Sensor Data] ──▶ [training-data-collector] ──▶ [External Training]
                         │                              │
                         │                              ▼
                         │                      [Trained Model]
                         │                              │
                         └──▶ [ml-inference] ◀─────────┘
                                    │
                                    ▼
                            [Prediction Output]
```

---

## Runtime Components

### Python Bridge Architecture

The Python Bridge enables using Python-based ML models (TFLite, Keras, scikit-learn).

```
┌─────────────────────────────────────────────────────────────────┐
│                    Python Bridge Architecture                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Node-RED Process                    Python Subprocess           │
│  ┌──────────────────┐               ┌──────────────────┐        │
│  │                  │               │                  │        │
│  │  ml-inference    │◀── JSON ────▶│  python_bridge.py│        │
│  │  node            │    stdin/     │                  │        │
│  │                  │    stdout     │  - Model Loading │        │
│  └──────────────────┘               │  - Inference     │        │
│          │                          │  - Preprocessing │        │
│          │                          │                  │        │
│          ▼                          └──────────────────┘        │
│  ┌──────────────────┐                       │                   │
│  │ python-bridge-   │                       │                   │
│  │ manager.js       │◀──────────────────────┘                   │
│  │                  │                                           │
│  │ - Process mgmt   │         Model Cache                       │
│  │ - Request queue  │         ┌──────────────────┐              │
│  │ - Auto-restart   │────────▶│ Loaded Models    │              │
│  │ - Health check   │         │ (in-memory)      │              │
│  └──────────────────┘         └──────────────────┘              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Persistent subprocess (not spawned per-request)
- Model caching for fast inference
- Automatic restart on crash
- Request queuing and timeout handling

### MAX Engine Integration

For optimized ONNX inference using Modular's MAX Engine.

```
┌─────────────────────────────────────────────────────────────────┐
│                    MAX Engine Architecture                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ml-inference node                  MAX Engine Server            │
│  ┌──────────────────┐              ┌──────────────────┐         │
│  │                  │              │                  │         │
│  │  max-bridge-     │◀── HTTP ───▶│  HTTP API        │         │
│  │  manager.js      │    REST      │  Port 8765       │         │
│  │                  │              │                  │         │
│  └──────────────────┘              │  - /predict      │         │
│                                    │  - /load_model   │         │
│                                    │  - /health       │         │
│                                    │                  │         │
│                                    └──────────────────┘         │
│                                            │                    │
│                                            ▼                    │
│                                    ┌──────────────────┐         │
│                                    │ MAX Engine Core  │         │
│                                    │ (Optimized ONNX) │         │
│                                    └──────────────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## State Management

### State Persistence System

Nodes can persist their state across Node-RED restarts using the `state-persistence` module.

```
┌─────────────────────────────────────────────────────────────────┐
│                    State Persistence Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Node Instance                                                   │
│  ┌──────────────────┐                                           │
│  │                  │                                           │
│  │  - dataBuffer    │──┐                                        │
│  │  - statistics    │  │    NodeStateManager                    │
│  │  - thresholds    │  │    ┌──────────────────┐                │
│  │                  │  ├───▶│                  │                │
│  └──────────────────┘  │    │  - Serialize     │                │
│                        │    │  - Auto-save     │                │
│                        │    │  - Load/Restore  │                │
│                        │    │                  │                │
│                        │    └──────────────────┘                │
│                        │            │                           │
│                        │            ▼                           │
│                        │    ┌──────────────────┐                │
│                        │    │ Node-RED Context │                │
│                        │    │ Storage          │                │
│                        │    │ (file/memory)    │                │
│                        │    └──────────────────┘                │
│                        │                                        │
└────────────────────────┴────────────────────────────────────────┘
```

**Supported State Types:**
- Data buffers (arrays with timestamps)
- Calculated statistics
- Training state (for adaptive algorithms)
- Model metadata
- Float32Array/Float64Array (serialized automatically)

---

## Extension Points

### Adding New Detection Methods

1. Add method implementation in the node's detection function
2. Add configuration options in the HTML file
3. Add method to the switch statement in `on('input', ...)`
4. Update tests in `test/*_spec.js`

### Adding New ML Runtimes

1. Add runtime detection in `ml-inference.js`
2. Implement inference logic (or add to Python bridge)
3. Update model loading in bridge manager
4. Add configuration UI in HTML

### Using Shared Utilities

```javascript
// Import shared statistics functions
const stats = require('./utils/statistics');

// Use in your node
const mean = stats.calculateMean(values);
const { zScore, stdDev } = stats.calculateZScore(value, buffer);
const quartiles = stats.calculateQuartiles(values);
```

---

## File Structure

```
node-red-contrib-condition-monitoring/
├── nodes/
│   ├── anomaly-detector.js      # Statistical anomaly detection
│   ├── anomaly-detector.html    # UI configuration
│   ├── isolation-forest-anomaly.js
│   ├── multi-value-processor.js
│   ├── signal-analyzer.js       # FFT, vibration analysis
│   ├── trend-predictor.js       # RUL prediction
│   ├── health-index.js          # Health aggregation
│   ├── ml-inference.js          # ML model inference
│   ├── pca-anomaly.js           # PCA-based detection
│   ├── training-data-collector.js
│   ├── python-bridge-manager.js # Python subprocess manager
│   ├── max-bridge-manager.js    # MAX Engine client
│   ├── state-persistence.js     # State management
│   ├── python_bridge.py         # Python inference server
│   └── utils/
│       └── statistics.js        # Shared statistical functions
├── test/
│   └── *_spec.js                # Jest test files
├── docs/
│   ├── ARCHITECTURE.md          # This file
│   ├── API.md                   # API documentation
│   └── TROUBLESHOOTING.md       # Common issues
├── package.json
├── jest.config.js
└── docker-compose.yml
```

---

## Design Decisions

### Why Dual Outputs?

All anomaly detection nodes use dual outputs (normal/anomaly) instead of a single output with a flag. This allows:
- Direct routing without switch nodes
- Clear visual flow in the editor
- Separate processing paths for normal vs anomaly data

### Why Hysteresis?

Industrial sensors often produce noisy data that can cause rapid alarm flickering. Hysteresis prevents this by:
- Requiring consecutive anomalies before triggering
- Requiring more consecutive normals to clear (asymmetric threshold)
- Providing deadband configuration

### Why Persistent Python Bridge?

Spawning a new Python process per inference request would be too slow (~500ms startup). The persistent bridge:
- Starts once and stays running
- Keeps models loaded in memory
- Reduces inference latency to ~10-50ms
- Handles multiple nodes sharing the same bridge

### Why Multiple ML Runtimes?

Different deployment scenarios require different runtimes:
- **ONNX**: Best for cross-platform deployment
- **TensorFlow.js**: No Python dependency, runs in Node.js
- **TFLite**: Optimized for edge devices
- **Keras/sklearn**: Direct Python model support
- **MAX Engine**: Hardware-optimized inference
