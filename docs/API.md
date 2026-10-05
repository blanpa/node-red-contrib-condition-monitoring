# API Reference

This document provides detailed API documentation for the internal components and interfaces of the condition monitoring package.

## Table of Contents

- [Python Bridge API](#python-bridge-api)
- [MAX Engine API](#max-engine-api)
- [Node Message Interfaces](#node-message-interfaces)
- [LLM Analyzer](#llm-analyzer)
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

**How a sample is scored.** A new value is compared with the window as it stood
*before* the value arrived, and only then added to it. (Scoring it against a
window that already contains it caps the z-score at `sqrt(n − 1)` — with a
window of 10 an outlier of any size reached exactly 3.0 and could never exceed a
threshold of 3.) While a baseline holds fewer than 10 values — or fewer than
`windowSize`, if that is smaller — its spread is too unstable to judge a
newcomer, so those first samples are scored within the window they are part of.
A departure from a perfectly flat baseline (σ = 0) is an anomaly with a very
large but finite score. The EMA method compares the value with the average
before the value moves it.

`msg.config` overrides that are not valid numbers are ignored (the configured
value stays in force) rather than silently disabling the check, and
`msg.method` reports the method actually used for the message.

With **Persist State** and a regime property, every regime's baseline is saved
and restored, not only the one that was active.

### Anomaly Detector: operating-point regimes

A machine that runs at several speeds or loads has several "normals". Set
**Regime Property** (`regimeProperty`) to a message property and the detector
keeps one independent baseline — window, EMA, CUSUM, hysteresis counters,
per-sensor buffers — per value of that property:

```javascript
// Node config
{ method: "zscore", windowSize: 100, regimeProperty: "regime", maxRegimes: 20 }

// Input
msg = { payload: 41.7, regime: "full-load" };

// Output — tagged with the baseline that judged it
msg = { payload: 41.7, isAnomaly: false, regime: "full-load", bufferSize: 57, ... };
```

- Nested paths work (`payload.speedClass`); a missing or empty value uses the
  default regime `""`.
- Every regime warms up on its own (the first samples pass through unjudged).
- `maxRegimes` (default 20) bounds memory; the least recently used regime is
  evicted beyond it.
- `msg.reset = true` clears the regime the message belongs to,
  `msg.reset = "all"` clears every regime.
- State persistence saves every regime.

### Anomaly Detector: per-device state

Set **Group By** (`groupBy`) to a message property such as `topic` to keep one
independent state per device — sliding window, EMA / CUSUM, hysteresis
counters and the per-sensor buffers of multi-sensor input:

```javascript
// Node config
{ method: "zscore", windowSize: 100, groupBy: "topic", maxGroups: 50 }

// Output — tagged with the device it was scored for
msg = { topic: "pump-02", group: "pump-02", isAnomaly: false, ... };
```

- Combines with the regime property: each device then has one baseline per
  operating point (`msg.group` and `msg.regime` are both set).
- Messages without a usable group value share one ungrouped state.
- `maxGroups` (default 50) bounds memory; with regimes the bound is
  `maxGroups × maxRegimes` states, least recently used evicted first.
- `msg.reset = true` clears the state the message belongs to,
  `msg.reset = "all"` clears everything.

### Anomaly Detector: CUSUM scale

`cusumMode` selects the unit of the CUSUM drift and thresholds:

- `"sigma"` (default for new nodes): each deviation from the target is divided
  by the standard deviation of the window first, so `cusumDrift: 0.5`,
  `cusumThreshold: 5` mean 0.5σ and 5σ on any signal.
- `"raw"` (flows saved before this setting existed): deviation, drift and
  thresholds are in the unit of the input, as in earlier releases.

The active mode is reported as `msg.mode`.

`msg.config` overrides (method, thresholds, hysteresis) apply to multi-sensor
object payloads as well as to single values.

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

`msg.payload` stays the raw sample that completed the window; the analysis is
attached as sibling properties.

```javascript
msg = {
  payload: 0.45,                 // the sample that triggered this result
  peaks: [
    { frequency: 46.875, magnitude: 0.24, amplitude: 0.96, normalized: 1 },
    { frequency: 140.6, magnitude: 0.08, amplitude: 0.32, normalized: 0.33 }
  ],
  dominantFrequency: 46.875,     // null when no peak passes the threshold
  dcOffset: 9.81,                // mean of the window, removed before the transform
  amplitudeScale: 4,             // amplitude = magnitude × this (2 / window coherent gain)
  features: {
    spectralCentroid: 85.2,      // Hz
    spectralSpread: 41.7,        // Hz
    rms: 0.42,
    crestFactor: 3.5,
    totalEnergy: 12.4
  },
  samplingRate: 1000,            // Hz
  fftSize: 256,
  windowFunction: "hann",        // hann | hamming | blackman | rectangular
  overlapPercent: 50
}
```

With **Output Format = `full`** the raw spectrum is added as two more top-level
arrays (omitted in the default `peaks` format to keep messages small):

```javascript
msg.frequencies = [0, 3.9, 7.8, ...];   // Hz, fftSize/2 bins
msg.magnitudes  = [0.01, 0.24, 0.03, ...];
```

- `magnitude` is `|X_k| / N` of the windowed signal, as in earlier releases.
  `amplitude` is the physical single-sided amplitude: a sine of amplitude 1
  reads 1 (multiply `msg.magnitudes` by `msg.amplitudeScale` for the same).
- The window mean is removed before the transform and reported as `dcOffset`,
  so a constant offset (gravity on an accelerometer, a 4–20 mA live zero) no
  longer hides the real lines behind the relative peak threshold.
- **Overlap** controls how often a sample-by-sample stream is analysed: once
  when the buffer first fills, then every `fftSize × (1 − overlap)` samples
  (50 % = every half window). An array payload is analysed once per message.
  The same applies to envelope and cepstrum mode.

### Signal Analyzer Output (Vibration Mode)

```javascript
msg = {
  payload: {
    rms: 3.0,
    peakToPeak: 6.0,
    peak: 3.0,
    crestFactor: 1.0,
    kurtosis: 1.0,
    skewness: 0.0,
    mean: 0.0,
    stdDev: 3.0,
    formFactor: 1.0,
    impulseFactor: 1.0,
    sampleEntropy: 0.12,
    autocorrelation: -1.0,
    periodicity: 0.98,
    healthScore: 62,             // 0-100

    // ISO 20816-3 assessment (`iso10816` is an alias of the same object)
    iso20816: {
      zone: "C",                 // A | B | C | D | N/A
      severity: "warning",       // good | acceptable | warning | critical | unknown
      recommendation: "Acceptable only for limited periods - schedule maintenance",
      rmsVelocity: 3.0,          // mm/s, converted from inputUnit
      machineClass: "group2_rigid", // group1_rigid | group1_flexible | group2_rigid | group2_flexible
                                    // | class1..class4 (legacy ISO 10816-1)
      standard: "ISO 20816-3",   // or "ISO 10816-1 (legacy)"
      limits: { ab: 1.4, bc: 2.8, cd: 4.5 },    // mm/s zone boundaries
      zoneProgress: 11.8,        // % through the current zone
      conversion: "spectral-integration", // none | scale | spectral-integration | single-frequency
      band: [10, 500],           // Hz band integrated (acceleration input only)
      isAlarm: false,
      isWarning: true,
      inputUnit: "g",            // mm_s | m_s | g | m_s2 | raw
      isValid: true              // false if the unit conversion is not applicable
    }
  },
  topic: "vibration-features",   // msg.topic is preserved when present
  timestamp: 1750000000000,
  windowSize: 20                 // samples actually used
}
```

Anomalies (crest factor above the configured threshold, or `|kurtosis| > 4`) are
routed to **output 2** with the same shape.

### Signal Analyzer Output (Envelope Mode)

```javascript
// Input: raw acceleration frame (array) or single samples; msg.rpm optional
msg = { payload: [...], rpm: 1450 };

// Output (output 1 = no fault, output 2 = fault)
msg = {
  payload: 0.12,
  envelope: { peaks: [{ frequency: 162.5, magnitude: 0.31, normalized: 0.8, noiseRatio: 42.1 }, ...], bandLow: 500, bandHigh: 5000 },
  shaftSpeed: 1450,              // RPM used for this analysis
  shaftFrequency: 24.17,         // Hz
  bearingFreqs: {                // typed-in values win, the rest is derived from geometry
    BPFO: 86.6, BPFI: 130.9, BSF: 56.9, FTF: 9.6,
    source: "geometry"           // manual | geometry | mixed | none
  },
  bearingFaults: [
    { type: "BPFI", harmonic: 1, description: "Inner Race Fault", expectedFreq: 130.9,
      detectedFreq: 131.2, magnitude: 0.31, severity: "medium" },
    { type: "BPFI-Sideband", harmonic: 1, sideband: -1, description: "Inner race fault modulated by shaft speed (BPFI×1 −1×1X)",
      expectedFreq: 106.7, detectedFreq: 107.0, magnitude: 0.14, severity: "low" },
    // also: BPFO | BSF | FTF | 1X | 2X | Looseness (harmonics: [1,2,3,4,...]) | SubSynchronous (order: 0.43)
  ],
  hasFault: true,
  faultCount: 2,
  timestamp: 1750000000000
}
```

Peaks are accepted only above `envelopePeakFloor` (default 8) × the local
spectral noise floor; matching tolerance is 5 % capped at 0.15 × shaft frequency
and floored at 1.5 bins; harmonics of a bearing line count only with the
fundamental; a line that also sits on a shaft harmonic carries
`coincidesWith1X: k`. Bearing geometry config keys: `bearingBalls`,
`bearingBallDiameter`, `bearingPitchDiameter`, `bearingContactAngle` (all
overridable through `msg.config`, as is `envelopePeakFloor`). Shaft speed resolution order: `msg.rpm`, `msg.shaftSpeed`,
`msg.config.shaftSpeed`, node setting.

### Signal Analyzer Output (Peaks Mode)

```javascript
msg = {
  payload: 8,                    // the current sample
  isPeak: true,                  // true -> routed to output 2
  peaks: [
    { index: 1, value: 5, timestamp: 1750000000000, direction: "positive" }
  ],
  peakCount: 1,
  stats: {
    averagePeakHeight: 5,
    maxPeakHeight: 5,
    minPeakHeight: 5,
    peakFrequency: 0.2           // peaks per sample
  },
  sampleCount: 5,                // samples seen in this buffer since start/reset
  timestamp: 1750000000000
}
```

**Min Peak Height** (`minPeakHeight`, or per message `msg.config.minPeakHeight`)
is the absolute height a positive peak must reach (a negative one must fall to
`−height`). Left empty, the threshold is automatic: mean ± 2σ of the window.

### Signal Analyzer: cepstrum and envelope notes

- A cepstral line is reported as the gear-mesh frequency *or* as one of its
  sidebands — whichever candidate is closest — never as several at once.
- **Cepstrum** quefrencies are those of the real cepstrum of the full spectrum:
  a harmonic family spaced 50 Hz apart peaks at 0.020 s. Gear-mesh matching
  needs the real shaft speed (node setting or `msg.rpm`); without one
  `gearFaults` stays empty and `shaftSpeed` is `0`.
- **Envelope** reports the band it actually used in `envelope.bandLow` /
  `bandHigh` and the filter in `envelope.filter` (`"butterworth"` or
  `"moving-average"`). An upper band edge at or above the Nyquist frequency is
  lowered to 90 % of it; a band that still does not fit falls back to a crude
  moving-average filter whose result is unreliable. Both cases log one warning.
- Bearing-fault `severity` is derived from how far the line stands above the
  local noise floor relative to the Peak Floor factor (more than 5× = `high`,
  more than 2× = `medium`), so it no longer depends on the sensor unit.

### Signal Analyzer: per-device buffers

By default the node keeps one buffer, so an interleaved stream from several
machines is blended into a single analysis. Set **Group By** (`groupBy`) to a
message property to keep an independent buffer per device:

```javascript
// Node config
{ mode: "fft", fftSize: 256, groupBy: "topic", maxGroups: 50 }

// Input — one node, many devices
msg = { topic: "pump-01/vibration", payload: 0.45 };

// Output — tagged with the buffer it was computed from
msg = { topic: "pump-01/vibration", group: "pump-01/vibration", peaks: [...], ... };
```

- `groupBy` accepts nested paths, e.g. `payload.deviceId`.
- Messages whose group property is missing or empty share one ungrouped buffer,
  and their `msg.group` is `""`.
- Each buffer fills independently: with `fftSize: 256` every device needs its own
  256 samples before it produces a first result.
- `maxGroups` (default 50) caps memory — the least recently used buffer is
  dropped once the limit is exceeded.
- `msg.reset = true` clears only the group the message belongs to;
  `msg.reset = "all"` clears every group.


### Trend Predictor Output (RUL Mode)

`msg.payload` stays the current value; the estimate is attached as sibling
properties.

```javascript
msg = {
  payload: 71.2,              // the current value
  rul: {
    value: 45.5,              // remaining useful life in `unit`; Infinity when no trend
    unit: "hours",            // hours | minutes | days | cycles (cycles = samples)
    lower: 38.2,              // two-sided interval at the configured level;
    upper: 52.8,              //   lower can be 0 ("could fail now")
    confidence: 0.93,         // R² of the fitted trend, 0 … 1
    confidenceLevel: 0.95,    // the level the interval was computed for (0.5 … 0.9999)
                              // interval = delta method on the trend-line crossing time (slope and
                              // level uncertainty); calibration on a noisy linear model gives roughly
                              // 75–80 % coverage for a 90 % band — indicative, not a guarantee
    status: "warning",        // "healthy", "warning", "critical", "failed", "stable"
    model: "linear",          // the model actually used: "linear", "exponential", "weibull"
    direction: "rising"       // "rising" | "falling"
  },
  degradation: {
    percent: 71.2,            // share of the way to the failure threshold
    rate: 0.23,               // change per sample, in the signal's own direction
    trend: "increasing"
  },
  thresholds: { failure: 100, warning: 80 },
  currentValue: 71.2,
  timestamp: 1750000000000,

  // Only with the Weibull model
  weibull: {
    beta: 2.5,                // configured shape parameter
    eta: 3600000000,          // configured characteristic life, in ms
    etaHours: 1000,
    equivalentAge: 2.1e9,     // ms, see below
    currentReliability: 0.29,
    hazardRate: 1.6e-9,
    mttf: 3.2e9,              // ms
    failureMode: "wear_out",
    bLife: { B1: 5.7e8, B5: 1.1e9, B10: 1.5e9, B50: 3.1e9 }   // ms
  }
}
```

- **Failure Direction** (`failureDirection`, per message
  `msg.config.failureDirection`): `"rising"` (default) for indicators that grow
  towards the threshold, `"falling"` for those that drop towards it (pressure,
  efficiency, a 100 → 0 health index). The warning threshold follows the same
  direction.
- **No trend** is a statistical decision: the result is `stable` (RUL
  `Infinity`) when the slope is within two standard errors of zero. A slow but
  clean drift on a fast-sampled signal is therefore detected, whatever the unit.
- **Exponential** fits `y = a·e^(bt)` (a straight line in `ln y`). It needs
  positive values rising to a positive threshold; otherwise the node uses the
  linear model and says so in `rul.model`.
- **Weibull** uses the configured β and η. The node does not know the asset's
  age, so it reads the degradation fraction `level / threshold` as the failed
  fraction and derives an *equivalent age* `η·(−ln(1−D))^(1/β)`; the RUL is the
  time from there to the age at which reliability drops to 10 %.
- The trend is fitted over **time**, not over the sample index: a gap in the
  data counts for as long as it lasted (`rul` results carry `timeBased: true`).
  When timestamps do not increase strictly the fit falls back to the index.
- **Group By** (`groupBy`, `maxGroups`) keeps one independent buffer per value
  of a message property, in every mode; outputs are tagged with `msg.group`.
  `msg.reset = true` clears the group of the message, `"all"` every group.
- `msg.config` overrides also apply to multi-sensor object payloads.
- **Cycles** counts samples. Timestamps come from `msg.timestamp` (ms, a `Date`
  or a date string) and default to the arrival time.
- Payloads must be finite numbers (or strings that are one); `"12abc"` and
  `"Infinity"` are rejected with a warning.

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

## LLM Analyzer

The `llm-analyzer` node buffers sensor samples, builds a prompt from them, calls a configurable LLM provider over plain HTTP (`fetch`, no SDK), and emits the analysis as `msg.payload`. Provider adapters live in `nodes/utils/llm-providers.js`. See `docs/SPEC-llm-analyzer.md` for design rationale.

### Supported Providers

| Provider | Default Endpoint | Authentication | Notes |
|----------|------------------|----------------|-------|
| `anthropic` | `https://api.anthropic.com/v1/messages` | `x-api-key` header | Native Messages API (`anthropic-version: 2023-06-01`) |
| `openai` | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` | Chat Completions API |
| `google` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `x-goog-api-key` header | `{model}` substituted from config; system prompt sent as `systemInstruction` |
| `ollama` | `http://localhost:11434/api/chat` | none (optional Bearer) | Local model runner; API key not required |
| `openai-compatible` | **none — `apiUrl` is required** | `Authorization: Bearer` | Generic Chat Completions adapter (Groq, Together, OpenRouter, DeepSeek, Mistral API, vLLM, LMStudio, …) |

All adapters normalize usage to `{ inputTokens, outputTokens }` and share one HTTP helper for abort/timeout and error mapping. An unknown provider name fails at deploy time with `node.error()` and a red status.

### Configuration Schema

Numeric fields are clamped to their valid range (out-of-range values are pinned, non-numeric values fall back to the default).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | `""` | Editor label only |
| `provider` | string | `"anthropic"` | One of `anthropic` \| `openai` \| `google` \| `ollama` \| `openai-compatible` |
| `model` | string | `"claude-haiku-4-5-20251001"` | Free-text model name passed to the provider |
| `apiUrl` | string | `""` | Empty = provider default endpoint. **Required** for `openai-compatible` |
| `triggerMode` | string | `"batch"` | `batch` \| `manual` \| `interval` |
| `batchSize` | number | `50` | Range 1–1000. Used only in `batch` mode |
| `intervalMs` | number | `60000` | Range 250–86400000 (24 h). Used only in `interval` mode |
| `maxOutputTokens` | number | `1024` | Range 16–8192. Sent as `max_tokens` (OpenAI/Anthropic), `generationConfig.maxOutputTokens` (Google), `options.num_predict` (Ollama) |
| `timeoutMs` | number | `30000` | Range 1000–300000 (5 min). Per-request abort timeout |
| `maxBufferSize` | number | `10000` | Range 1–1000000. Hard buffer cap (ring buffer, oldest dropped) |
| `maxSamplesInPrompt` | number | `100` | Range 1–10000. Cap on samples/records rendered into the prompt |
| `inputMode` | string | `"scalar"` | `scalar` (numbers) \| `record` (multi-column objects) |
| `columns` | string | `""` | Record mode only. Comma-separated column allowlist; empty = auto-detect numeric columns from the first record |
| `outputMode` | string | `"text"` | `text` \| `json` |
| `outputSchema` | string | `""` | JSON mode only. Example object whose shape the LLM is asked to mirror |
| `outputPath` | string | `""` | JSON mode only. Dot-notation path extracted into `msg.payload` (e.g. `"score"`, `"anomalies.0"`) |
| `systemPrompt` | string | `""` | Empty = built-in default system prompt |
| `userPromptTemplate` | string | `""` | Empty = built-in default template (differs per input mode). Supports `{word}` placeholders |
| `sensorName` | string | `""` | Metadata; fills the `{sensor}` placeholder |
| `unit` | string | `""` | Metadata; fills the `{unit}` placeholder |
| `passthroughOriginal` | boolean | `true` | If true, the triggering message's `payload` is copied to `msg.input` on the output |
| `persistState` | boolean | `false` | Persist buffer, detected columns, and lifetime counters across redeploys |

### Credential Handling

The API key is a Node-RED credential (`apiKey`, type `password`) — encrypted at rest in the credentials file, never stored in the flow JSON:

```javascript
RED.nodes.registerType("llm-analyzer", LlmAnalyzerNode, {
  credentials: {
    apiKey: { type: "password" }
  }
});
```

Resolution order at runtime:

1. `node.credentials.apiKey` (encrypted Node-RED credential) — preferred
2. `config.apiKey` inline property — dev/test backstop only (stored in plain text in the flow file)

The key is required for every provider except `ollama` (where an optional key is sent as `Authorization: Bearer` for hosted forwarders). If a required key is missing the node refuses to start: red `no API key` status plus `node.error()`. The same fail-fast applies to a missing `apiUrl` for `openai-compatible`.

### Trigger Modes

| Mode | Fires when | Notes |
|------|-----------|-------|
| `batch` | Buffer reaches `batchSize` on input | Status shows `buffering N/batchSize` |
| `manual` | Incoming message has `msg.flush === true` | `flush` is ignored in the other modes |
| `interval` | Every `intervalMs` (timer-driven) | Inputs only fill the buffer; ticks with an empty buffer are skipped |

A trigger with an empty buffer logs `node.warn()` and is skipped. Triggers arriving while a request is in flight are **queued, not dropped**: one pending re-fire slot is kept and drained after the current call returns (a `manual` trigger takes priority over a queued `batch`/`interval` one).

### Prompt Template Substitution

Templates are rendered with `fillTemplate()` (`nodes/utils/llm-providers.js`): every `{word}` token (`/\{(\w+)\}/g`) is replaced if the variable exists; **unknown placeholders are left verbatim** in the prompt.

Variables available in both modes: `{sensor}`, `{unit}`, `{count}`, `{stats}`, `{samples}`, `{records}`, `{columns}`.

| Placeholder | Scalar mode | Record mode |
|-------------|-------------|-------------|
| `{sensor}` | `sensorName` or `(unnamed)` | same |
| `{unit}` | `unit` or `(unitless)` | `unit` or empty string |
| `{count}` | Number of buffered samples | Number of buffered records |
| `{stats}` | One line: `n= mean= stdDev= min= max= range=` | Per-column multi-line block (`n= mean= stdDev= min= max=`) |
| `{samples}` | Comma-separated values (capped at `maxSamplesInPrompt`, newest kept, with a `(showing last N of M)` header when trimmed) | Alias for `{records}` so scalar templates still render |
| `{records}` | Alias for `{samples}` | Tabular block, one line per record: `t=1 temp=65 pressure=4.5 …` (same cap/trim rules) |
| `{columns}` | Empty string | Detected/configured column names joined with `, ` |

Stats are pre-computed by the node (mean/stdDev/min/max/range) so the LLM does not burn tokens recomputing them. In JSON output mode an instruction block (built by `buildJsonInstruction()`, including the `outputSchema` example if set) is appended to the system prompt — provider-native JSON modes are not used.

Record mode column detection: with an empty `columns` field, the **first** record received establishes the numeric column set, which is then frozen for the node's lifetime. Common timestamp/identifier fields (`timestamp`, `time`, `ts`, `_ts`, `epoch`, `datetime`, `date`, `id`, `_id` — case-insensitive) are skipped automatically; list columns explicitly to include them.

### Input Message

```javascript
msg = {
  // scalar mode: number | numeric string | number[]
  // record mode: object | object[]   e.g. { temp: 65, pressure: 4.5 }
  payload: 65.2,

  flush: true,                 // optional — manual mode only: fire now
  prompt: "…",                 // optional — replaces the user prompt template
                               //   ({word} substitution is still applied)
  systemPrompt: "…",           // optional — replaces the system prompt for this call
  model: "gpt-4o-mini",        // optional — per-message model override
  apiUrl: "http://mock:8080"   // optional — per-message endpoint override (tests/gateways);
                               // ignored unless "Allow msg.apiUrl override" is enabled, and then
                               // only accepted within the origin of the configured endpoint
}
```

Non-numeric scalar values and records without any numeric field in the column set are silently ignored (not buffered).

### Output Message

```javascript
msg = {
  payload: "<LLM response text>",  // text mode: string
                                   // json mode: parsed object, or the value at
                                   //            outputPath if one is configured
  usage: {                         // this call (normalized across providers)
    inputTokens: 124,
    outputTokens: 89
  },
  totalUsage: {                    // lifetime counters (reset on redeploy,
    inputTokens: 12400,            // persisted when persistState is on)
    outputTokens: 3100,
    callCount: 234
  },
  samples: [/* exact batch sent */],  // number[] (scalar) or object[] (record)
  sensor: "machine-A/temp",        // sensorName or null
  unit: "°C",                      // unit or null
  model: "claude-haiku-4-5-…",     // model reported by the provider
  durationMs: 1234,                // wall-clock time of the API call

  // JSON mode only:
  json: { /* full parsed object */ },
  rawResponse: "<raw LLM text>",

  // only if passthroughOriginal and a triggering msg exists:
  input: 65.2,                     // original msg.payload

  topic: "…",                      // passed through from the triggering msg
  _msgid: "…"                      // passed through from the triggering msg
}
```

### Buffer Behavior

- The buffer is drained (copied and cleared) on every fire; `msg.samples` carries the exact batch that was sent.
- `maxBufferSize` is a hard ring-buffer cap: when exceeded, the **oldest** entries are dropped and the drop count appears in the status line (`buffering 9999/10000 ⚠ 12 dropped`). Most relevant in `manual`/`interval` modes where the buffer can otherwise grow unbounded.
- `maxSamplesInPrompt` independently caps how many buffered values are rendered into the prompt (token-cost knob) — the newest N are kept, older ones are summarized only by the stats line.
- With `persistState: true`, the buffer, detected columns, and lifetime usage counters are saved every 30 s and on close (context key `llmAnalyzerState_<nodeId>` via the shared persistence helper) and restored after a redeploy.

### Timeouts and Errors

Each request runs under an `AbortController` armed with `timeoutMs`; on expiry the call is aborted and surfaces as a `timeout` error. All failures go through `node.error("llm-analyzer: …", msg)` — wire a `catch` node to handle them. **No payload-bearing message is emitted on failure.**

| Error kind | Cause |
|-----------|-------|
| `timeout` | Request exceeded `timeoutMs` |
| `network` | fetch/transport failure |
| `auth` | HTTP 401 / 403 |
| `rate-limit` | HTTP 429 |
| `http` | Any other non-2xx status |
| `shape` | Provider response missing expected fields |
| `blocked` | Google only — prompt blocked (`promptFeedback.blockReason`) |
| `config` | Missing key/URL/model, unknown provider |

JSON mode adds two error paths: an unparseable response (`json parse` status; the error message carries `msg.rawResponse`, `msg.usage`, `msg.model`) and a missing `outputPath` field (`path not found` status; error message additionally carries `msg.json`). The error kind is also shown in the node status (red ring).

### Status Indicator

| State | Visual |
|-------|--------|
| Idle | green dot — `ready` |
| Collecting | blue ring — `buffering 23/50` (plus `⚠ N dropped` after cap hits) |
| In-flight | yellow dot — `calling LLM` |
| Last call OK | green dot — `ok · 234 calls · 12.4kin/3.1kout · 1.2s` |
| Last call failed | red ring — error kind |

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
// Returns: { q1: 2.75, q2: 4.5, q3: 6.25, iqr: 3.5, median: 4.5 }
// (linear interpolation, the same definition as calculatePercentile / calculateMedian)

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
// Returns: { q1: 2.75, q3: 6.25, iqr: 3.5, lowerBound: -2.5, upperBound: 11.5, ... }
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
