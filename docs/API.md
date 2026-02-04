# API Reference

This document provides detailed API documentation for the internal components and interfaces of the condition monitoring package.

## Table of Contents

- [Python Bridge API](#python-bridge-api)
- [MAX Engine API](#max-engine-api)
- [Node Message Interfaces](#node-message-interfaces)
- [Shared Utilities](#shared-utilities)
- [State Persistence API](#state-persistence-api)

---

## Python Bridge API

The Python Bridge enables running Python-based ML models (TFLite, Keras, scikit-learn) from Node.js.

### PythonBridgeManager Class

```javascript
const { PythonBridgeManager, getGlobalBridge } = require('./python-bridge-manager');
```

#### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pythonPath` | string | `'python3'` | Path to Python interpreter |
| `bridgeScript` | string | `'./python_bridge.py'` | Path to bridge script |
| `startupTimeout` | number | `30000` | Startup timeout in ms |
| `requestTimeout` | number | `60000` | Request timeout in ms |

#### Methods

##### `start(): Promise<void>`

Start the Python bridge subprocess.

```javascript
const bridge = getGlobalBridge();
await bridge.start();
```

##### `loadModel(modelPath, modelId?): Promise<object>`

Load a model into memory.

```javascript
const result = await bridge.loadModel('/models/anomaly.pkl', 'anomaly-v1');
// Returns: { model_id: 'anomaly-v1', input_shape: [10], framework: 'sklearn' }
```

**Parameters:**
- `modelPath` (string): Path to the model file
- `modelId` (string, optional): Unique identifier for the model

**Supported formats:**
- `.pkl`, `.joblib` - scikit-learn models
- `.h5`, `.keras` - Keras models
- `.tflite` - TensorFlow Lite models

##### `predict(modelId, inputData): Promise<any>`

Run inference on a loaded model.

```javascript
const result = await bridge.predict('anomaly-v1', [0.5, 1.2, 0.8, 0.3]);
// Returns: { prediction: [0.92], confidence: 0.95 }
```

**Parameters:**
- `modelId` (string): Model identifier from loadModel
- `inputData` (array): Input data matching model's expected shape

##### `unloadModel(modelId): Promise<void>`

Unload a model from memory.

```javascript
await bridge.unloadModel('anomaly-v1');
```

##### `getStatus(): Promise<object>`

Get bridge and model status.

```javascript
const status = await bridge.getStatus();
// Returns: {
//   loaded_models: ['anomaly-v1'],
//   memory_usage_mb: 256,
//   frameworks: ['sklearn', 'keras', 'tflite']
// }
```

##### `ping(): Promise<object>`

Check if the bridge is responsive.

```javascript
await bridge.ping();
// Returns: { pong: true, timestamp: 1234567890 }
```

##### `stop(): Promise<void>`

Gracefully stop the Python bridge.

```javascript
await bridge.stop();
```

##### `getStats(): object`

Get request statistics.

```javascript
const stats = bridge.getStats();
// Returns: {
//   requestsProcessed: 150,
//   errors: 2,
//   avgResponseTime: 45.2,
//   lastResponseTime: 38,
//   isReady: true,
//   pendingRequests: 0
// }
```

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `ready` | `{ frameworks: [...] }` | Bridge is ready |
| `response` | Response object | Any response received |
| `stderr` | string | Python stderr output |
| `exit` | `{ code, signal }` | Process exited |
| `error` | Error | Processing error |

#### Global Bridge Functions

```javascript
// Get or create shared bridge instance
const bridge = getGlobalBridge();

// Shutdown shared instance
await shutdownGlobalBridge();
```

---

## MAX Engine API

The MAX Engine Bridge provides high-performance ONNX inference via an HTTP API.

### MaxBridgeManager Class

```javascript
const { MaxBridgeManager, getMaxBridge } = require('./max-bridge-manager');
```

#### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverUrl` | string | `'http://localhost:8765'` | MAX server URL |
| `requestTimeout` | number | `60000` | Request timeout in ms |
| `healthCheckInterval` | number | `30000` | Health check interval in ms |
| `retryAttempts` | number | `3` | Number of retry attempts |
| `retryDelay` | number | `1000` | Delay between retries in ms |

#### Methods

##### `checkHealth(): Promise<object>`

Check server health status.

```javascript
const health = await bridge.checkHealth();
// Returns: {
//   status: 'healthy',
//   loaded_models: 2,
//   memory_usage_mb: 512,
//   backend: 'max'  // or 'onnx'
// }
```

##### `getStatus(): Promise<object>`

Get detailed server status.

```javascript
const status = await bridge.getStatus();
// Returns: {
//   models: {
//     'anomaly-v1': { input_shape: [10], backend: 'max' }
//   },
//   uptime_seconds: 3600
// }
```

##### `loadModel(modelPath, modelId?, backend?): Promise<object>`

Load an ONNX model.

```javascript
const result = await bridge.loadModel(
  '/models/anomaly.onnx',
  'anomaly-detector',
  'auto'  // 'auto', 'max', or 'onnx'
);
// Returns: {
//   success: true,
//   model_id: 'anomaly-detector',
//   backend: 'max',
//   load_time_ms: 120
// }
```

**Parameters:**
- `modelPath` (string): Path to ONNX model file
- `modelId` (string, optional): Unique model identifier
- `backend` (string, optional): Preferred backend (`'auto'`, `'max'`, `'onnx'`)

##### `predict(modelId, inputData): Promise<object>`

Run single inference.

```javascript
const result = await bridge.predict('anomaly-detector', [0.5, 1.2, 0.8]);
// Returns: {
//   prediction: [[0.15, 0.85]],
//   inferenceTime: 5,
//   backend: 'max'
// }
```

##### `batchPredict(modelId, inputs): Promise<object>`

Run batch inference for multiple samples.

```javascript
const result = await bridge.batchPredict('anomaly-detector', [
  [0.5, 1.2, 0.8],
  [0.3, 0.9, 1.1],
  [0.7, 1.5, 0.6]
]);
// Returns: {
//   predictions: [[0.15, 0.85], [0.22, 0.78], [0.08, 0.92]],
//   batchSize: 3,
//   inferenceTime: 12,
//   perSampleTime: 4,
//   backend: 'max'
// }
```

##### `unloadModel(modelId): Promise<object>`

Unload a model.

```javascript
await bridge.unloadModel('anomaly-detector');
```

##### `startHealthCheck(): void`

Start periodic health monitoring.

```javascript
bridge.startHealthCheck();
bridge.on('unhealthy', (err) => console.error('Server down:', err));
```

##### `stopHealthCheck(): void`

Stop health monitoring.

##### `getStats(): object`

Get request statistics.

##### `destroy(): void`

Clean up resources and stop health checks.

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `health` | Health response | Health check passed |
| `unhealthy` | Error | Health check failed |
| `modelLoaded` | `{ modelId, backend, loadTime }` | Model loaded |
| `modelUnloaded` | `{ modelId }` | Model unloaded |

#### Global Functions

```javascript
// Get or create shared bridge
const bridge = getMaxBridge({ serverUrl: 'http://max:8765' });

// Check availability
const available = await isMaxBridgeAvailable();

// Shutdown
shutdownMaxBridge();
```

### MAX Engine HTTP Endpoints

When running the MAX Engine server directly:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | Server status |
| `/load` | POST | Load model |
| `/predict` | POST | Single prediction |
| `/batch_predict` | POST | Batch prediction |
| `/unload` | POST | Unload model |

---

## Node Message Interfaces

### Anomaly Detector Output

```javascript
// Output message structure
msg = {
  payload: 25.5,              // Original value
  isAnomaly: true,            // Final anomaly decision (after hysteresis)
  rawAnomaly: true,           // Raw detection result (before hysteresis)
  severity: "warning",        // "normal", "warning", "critical"
  method: "zscore",           // Detection method used
  bufferSize: 100,            // Current buffer size
  windowSize: 100,            // Configured window size

  // Hysteresis info
  hysteresis: {
    enabled: true,
    applied: false,           // Was hysteresis applied this sample?
    consecutiveAnomalies: 3,
    consecutiveNormals: 0
  },

  // Method-specific details (varies by method)
  zScore: 3.2,
  mean: 20.5,
  stdDev: 1.5,
  threshold: 3.0,
  warningThreshold: 2.0
}
```

### Multi-Sensor Input Format

```javascript
// Object format (recommended)
msg.payload = {
  temperature: 65.5,
  pressure: 4.2,
  vibration: 0.8
};

// Array of objects format
msg.payload = [
  { name: "temperature", value: 65.5 },
  { name: "pressure", value: 4.2 }
];
```

### ML Inference Input

```javascript
// Single value
msg.payload = 25.5;

// Array
msg.payload = [0.5, 1.2, 0.8, 0.3];

// Object with multiple features
msg.payload = {
  feature1: 0.5,
  feature2: 1.2,
  feature3: 0.8
};

// Dynamic model loading
msg.loadModel = {
  path: "/models/new-model.onnx",
  id: "new-model"
};
```

### ML Inference Output

```javascript
msg = {
  payload: [0.15, 0.85],      // Model output
  prediction: [0.15, 0.85],   // Same as payload
  modelId: "anomaly-v1",
  runtime: "onnx",            // "onnx", "tfjs", "python"
  inferenceTime: 5,           // ms
  inputShape: [1, 10]
}
```

### Signal Analyzer Output (FFT Mode)

```javascript
msg = {
  payload: {
    frequencies: [0, 50, 100, ...],    // Hz
    magnitudes: [0.1, 0.8, 0.3, ...],
    phases: [0, 1.2, -0.5, ...],       // radians
    peaks: [
      { frequency: 50, magnitude: 0.8, index: 10 },
      { frequency: 150, magnitude: 0.5, index: 30 }
    ],
    spectral: {
      centroid: 125.5,      // Hz
      crestFactor: 2.3,
      rms: 0.45
    }
  },
  sampleRate: 1000,           // Hz
  windowSize: 1024,
  windowFunction: "hann"
}
```

### Signal Analyzer Output (Vibration Mode)

```javascript
msg = {
  payload: {
    rms: 4.5,                 // mm/s
    peak: 12.3,
    crestFactor: 2.73,
    kurtosis: 3.2,
    skewness: 0.1,

    // ISO 10816-3 assessment
    iso10816: {
      machineClass: "II",     // I, II, III, IV
      zone: "B",              // A, B, C, D
      assessment: "Acceptable",
      thresholds: {
        A_B: 2.8,
        B_C: 7.1,
        C_D: 18.0
      }
    },

    healthScore: 78           // 0-100
  },
  severity: "warning"
}
```

### Trend Predictor Output (RUL Mode)

```javascript
msg = {
  payload: {
    rul: 45.5,                // Remaining useful life
    rulUnit: "hours",
    confidence: {
      lower: 38.2,
      upper: 52.8
    },
    status: "warning",        // "healthy", "warning", "critical", "failed"
    degradationRate: 0.23,
    model: "linear",          // "linear", "exponential", "weibull"

    // Weibull parameters (if applicable)
    weibull: {
      beta: 2.5,              // Shape parameter
      eta: 100,               // Scale parameter
      mttf: 88.6,             // Mean time to failure
      bLife: {
        B1: 23.5,
        B5: 38.2,
        B10: 48.9,
        B50: 83.3
      }
    }
  },

  warningThreshold: 72,
  failureThreshold: 24
}
```

### Health Index Output

```javascript
msg = {
  payload: 72.5,              // Health score 0-100
  healthIndex: 72.5,
  status: "warning",          // "healthy", "warning", "degraded", "critical"

  sensorHealths: {
    temperature: { health: 85, weight: 0.3 },
    vibration: { health: 60, weight: 0.5 },
    pressure: { health: 90, weight: 0.2 }
  },

  // Dynamic weighting info (if enabled)
  dynamicWeights: {
    temperature: { weight: 0.28, anomalyRate: 0.05 },
    vibration: { weight: 0.52, anomalyRate: 0.15 },
    pressure: { weight: 0.20, anomalyRate: 0.02 }
  },

  worstSensor: {
    name: "vibration",
    health: 60,
    reliability: 0.85
  },

  aggregationMethod: "weighted-average"
}
```

### Dynamic Configuration via msg.config

Most nodes support runtime configuration override:

```javascript
msg.config = {
  method: "iqr",              // Override detection method
  threshold: 2.5,             // Override threshold
  windowSize: 50,             // Override window size
  hysteresisEnabled: false    // Disable hysteresis
};
```

---

## Shared Utilities

### Statistics Module

```javascript
const stats = require('./utils/statistics');
```

#### Basic Statistics

```javascript
// Mean
const mean = stats.calculateMean([1, 2, 3, 4, 5]);
// Returns: 3

// Standard Deviation
const stdDev = stats.calculateStdDev([1, 2, 3, 4, 5]);
// Returns: 1.414...

// Median
const median = stats.calculateMedian([1, 2, 3, 4, 5]);
// Returns: 3

// Quartiles
const q = stats.calculateQuartiles([1, 2, 3, 4, 5, 6, 7, 8]);
// Returns: { q1: 2, q2: 4, q3: 6, iqr: 4, median: 4 }

// Percentile
const p95 = stats.calculatePercentile([1, 2, 3, 4, 5], 95);
// Returns: 4.8
```

#### Anomaly Detection Helpers

```javascript
// Z-Score
const result = stats.calculateZScore(10, [5, 6, 7, 8, 9]);
// Returns: { zScore: 1.41, mean: 7, stdDev: 1.58 }

// IQR Bounds
const bounds = stats.calculateIQRBounds([1, 2, 3, 4, 5, 6, 7, 8], 1.5);
// Returns: { q1, q3, iqr, lowerBound, upperBound }
```

#### Correlation

```javascript
// Pearson
const r = stats.calculatePearsonCorrelation([1, 2, 3], [2, 4, 6]);
// Returns: 1.0

// Spearman
const rho = stats.calculateSpearmanCorrelation([1, 2, 3], [3, 1, 2]);
// Returns: -0.5
```

#### Signal Processing

```javascript
// RMS
const rms = stats.calculateRMS([1, 2, 3, 4, 5]);
// Returns: 3.31...

// Crest Factor
const cf = stats.calculateCrestFactor([1, 2, 3, 4, 5]);
// Returns: 1.51...

// Moving Average
const ma = stats.calculateMovingAverage([1, 2, 3, 4, 5], 3);
// Returns: [1, 1.5, 2, 3, 4]

// EMA
const ema = stats.calculateEMA([1, 2, 3, 4, 5], 0.3);
// Returns: [1, 1.3, 1.81, 2.47, 3.23]
```

---

## State Persistence API

### NodeStateManager Class

```javascript
const { NodeStateManager } = require('./state-persistence');
```

#### Constructor

```javascript
const manager = new NodeStateManager(node, {
  stateKey: 'myState',        // Context key
  saveInterval: 30000,        // Auto-save interval (ms)
  autoSave: true,             // Enable auto-save
  saveOnChange: false         // Save on every change
});
```

#### Methods

```javascript
// Load persisted state
const state = await manager.load();

// Get value
const buffer = manager.get('dataBuffer', []);

// Set value
manager.set('dataBuffer', [1, 2, 3]);

// Set multiple values
manager.setMultiple({
  buffer: [1, 2, 3],
  mean: 2.0,
  stdDev: 1.0
});

// Check if key exists
if (manager.has('buffer')) { ... }

// Delete key
manager.delete('oldKey');

// Clear all state
manager.clear();

// Manual save
await manager.save();

// Cleanup (call in node.on('close'))
await manager.close();
```

#### Factory Functions

```javascript
const {
  createAnomalyStateManager,
  createMLStateManager,
  createSignalStateManager
} = require('./state-persistence');

// Pre-configured for specific node types
const anomalyState = createAnomalyStateManager(node);
const mlState = createMLStateManager(node);
const signalState = createSignalStateManager(node);
```

---

## Error Codes

Common error patterns used across nodes:

| Code Pattern | Description |
|--------------|-------------|
| `BRIDGE_NOT_READY` | Python/MAX bridge not initialized |
| `MODEL_NOT_LOADED` | Requested model not in memory |
| `INVALID_INPUT` | Input data format incorrect |
| `INFERENCE_FAILED` | Model prediction failed |
| `TIMEOUT` | Request exceeded timeout |
| `BUFFER_WARMUP` | Insufficient data in buffer |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_ENGINE_URL` | `http://localhost:8765` | MAX Engine server URL |
| `PYTHON_PATH` | `python3` | Python interpreter path |
| `PYTHONUNBUFFERED` | `1` | Disable Python output buffering |
