# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.0] - 2026-06-12 - LLM Analyzer Node (Phase 1–5)

### ✨ New Node: `llm-analyzer`

A flow-time LLM analysis node that buffers samples and asks an LLM to
analyse them. The result flows back into the Node-RED pipeline as a
`msg.payload` — text in plain mode, structured object (or extracted
field) in JSON mode. Replaces the briefly-explored `mcp-bridge` (passive
MCP server, withdrawn the same release window in favour of this active
in-flow analyser).

**Five providers, one contract:**
- Anthropic (Claude — `x-api-key` header)
- OpenAI (GPT — Chat Completions)
- Google (Gemini — generateContent)
- Ollama (local — no key needed)
- OpenAI-compatible (Groq, Together, OpenRouter, DeepSeek, Mistral, vLLM, LMStudio …)

**Three trigger modes:**
- `batch` — fire when N samples accumulated
- `manual` — fire on `msg.flush === true`
- `interval` — fire every X ms on whatever's buffered

**Two input modes:**
- `scalar` — one numeric value (or array) per msg
- `record` — multi-sensor objects, auto-detects numeric columns
  (skipping common timestamp/id field names) or honours an explicit
  allowlist

**Two output modes:**
- `text` — `msg.payload` = LLM string
- `json` — operator pastes example JSON into the schema field; node
  appends an instruction to the system prompt and parses the response
  with a tolerant extractor (markdown fences, prose-wrapped objects,
  braces inside strings all handled). Optional `outputPath` (dot-notation)
  extracts a single nested field.

**Production hardening:**
- `maxBufferSize` — hard ring-buffer cap (default 10 000)
- `maxSamplesInPrompt` — token-cost knob (default 100)
- `persistState` — buffer + counters survive redeploys
- Lifetime cost tracking on `msg.totalUsage` + status line
- Concurrency-safe — triggers during in-flight calls are queued, never dropped

**Configuration is fully self-contained** — API keys via Node-RED
credentials (encrypted on disk), per-provider URL/model defaults adjust
automatically when the operator picks a provider. Editor UI matches the
rest of the `condition-monitoring` family (collapsible `cm-section`
cards, gradient headers, `#9482f1` family colour). A "Preview rendered
prompt" button shows the operator what will actually go to the LLM.

**Test coverage:** 82 unit tests + 3 integration tests against a real
Node-RED runtime via the existing harness.

**Demo stack:** `docker-compose.demo.yml` starts a Node-RED container
plus a small mock-Anthropic sidecar so the five demo flows
(temp / vib-with-anomaly / manual / multi-sensor / json-scorer) run
without needing a real API key.

See `docs/SPEC-llm-analyzer.md` for the full design contract.

### 🐛 Fixed (pre-release hardening pass)

- **ml-inference**: outgoing msg is now deep-cloned — a nested
  `outputProperty` previously mutated the original message
- **signal-analyzer**: input handler uses the `(msg, send, done)`
  signature so message tracking and catch-node correlation work
- **llm-analyzer**: error containment covers prompt building (a throw
  there left the node stuck in-flight); interval timer is unref'd
- **python-bridge**: ready-signal race on fast startup, ignored
  `pythonPath` option, dead SIGKILL fallback, candidate double-callback
- **max-bridge**: 4xx responses with JSON error bodies were retried
- **Memory bounds for long-running flows**: FFT instance cache eviction,
  training-data-collector hard buffer cap (2x bufferSize, with warning),
  persistence load failures surface as warnings instead of silent resets

### 🔒 Security / Robustness

- **websocket-manager**: `maxClients` connection cap (close 4009),
  `maxMessageSize` payload limit (64 KiB default), per-client
  subscription cap (256 topics)
- **Config validation**: shared `clampInt`/`clampFloat`
  (`nodes/utils/config-validator.js`) replaces the `parseInt(x) || default`
  pattern across all nodes — `0` is no longer silently turned into the
  default where it is a valid value

### 🧪 Testing & CI

- 68 new unit tests for websocket-manager, python-bridge-manager and
  max-bridge-manager (previously zero coverage)
- Jest coverage thresholds gate CI and publishing
- `--forceExit` removed from the test scripts (suite exits cleanly)
- npm publish workflow: `npm ci`, coverage+lint gates, tag↔package.json
  version check, `--provenance` attestation

### 📚 Docs & Examples

- `examples/` with one importable flow per node (10 total)
- LLM Analyzer reference in `docs/API.md`, architecture section updated,
  SECURITY.md supported versions bumped to 0.3.x, README ToC

---

## [0.2.2] - 2026-01-18 - Predictive Maintenance Enhancement

### ✨ New Features

#### Anomaly Detector
- **Hysteresis (Anti-Flicker)** - Prevents rapid alarm on/off switching
  - Configurable consecutive samples before triggering alarm
  - Exit hysteresis percentage (deadband) for returning to normal state
  - New output properties: `rawAnomaly`, `hysteresis.applied`, `hysteresis.consecutiveAnomalies`
- **Multi-Sensor JSON Input** - Process multiple sensors in one message
  - Accepts JSON objects: `{ "temp": 65.2, "pressure": 4.5 }`
  - Maintains separate buffers and hysteresis states per sensor
  - Outputs combined result with `anomalySensors` array

#### Signal Analyzer
- **ISO 10816-3 Integration** - Vibration severity assessment
  - Machine classes I-IV (small to large machines)
  - Zones A-D (good, acceptable, warning, critical)
  - Automatic severity, recommendation, and alarm/warning flags
  - Zone progress percentage for trending
- **Butterworth Filter** - Improved envelope analysis
  - 2nd order IIR filter with bilinear transform
  - Zero-phase filtering (filtfilt) - no phase distortion
  - Automatic fallback to simple filter for edge cases

#### Health Index
- **Dynamic Weighted Aggregation** - Auto-adjusts sensor weights based on reliability
  - Tracks per-sensor anomaly rates and signal variance
  - Automatically downweights unreliable or noisy sensors
  - New output: `dynamicWeights` with `effectiveWeight`, `reliabilityFactor`, `anomalyRate`

#### Trend Predictor
- **Robust RUL Calculation** - More stable predictions with noisy data
  - Theil-Sen estimator for robust slope (resistant to outliers)
  - Median filter to remove spikes before trend analysis
  - Moving average smoothing for noise reduction
  - Weighted combination of robust and linear slope (70/30)
- **Multi-Sensor JSON Input** - Process multiple sensors in one message
  - Accepts JSON objects: `{ "motor_temp": 75.2, "bearing_vib": 2.5 }`
  - Calculates trends/RUL independently per sensor
  - Outputs `exceededSensors` array when thresholds are reached

### 🎨 UI Improvements

- Added placeholder text (hellgrau) to all input fields showing example values
- ISO 10816 machine class selector in Signal Analyzer vibration mode
- Hysteresis settings section in Anomaly Detector
- Dynamic weighting option in Health Index aggregation dropdown
- Updated help documentation for all new features

### 🧪 Testing

- **148 Tests** - Up from 83 (65 new tests added)
- Added tests for hysteresis behavior and state tracking
- Added tests for ISO 10816 zone evaluation
- Added tests for dynamic weight calculation
- Added tests for robust RUL slope calculation
- Added tests for multi-sensor JSON input (Anomaly Detector, Trend Predictor)

---

## [0.2.0] - 2026-01-07 - Major Consolidation Release

### 🚀 Breaking Changes

**18 nodes consolidated into 8 powerful nodes:**

| Old Nodes | New Node | Selection |
|-----------|----------|-----------|
| zscore-anomaly, iqr-anomaly, threshold-anomaly, percentile-anomaly, ema-anomaly, cusum-anomaly, moving-average-anomaly | **anomaly-detector** | `method` dropdown |
| multi-value-splitter, multi-value-anomaly, correlation-anomaly | **multi-value-processor** | `mode` dropdown |
| fft-analysis, vibration-features, peak-detection | **signal-analyzer** | `mode` dropdown |
| trend-prediction, rate-of-change | **trend-predictor** | `mode` dropdown |
| isolation-forest-anomaly | **isolation-forest-anomaly** | (unchanged) |
| health-index | **health-index** | (unchanged) |
| ml-inference | **ml-inference** | (unchanged) |
| (new) | **pca-anomaly** | Principal Component Analysis |

### 🚀 New Nodes

#### PCA Anomaly Detection
- **Principal Component Analysis** for multi-sensor anomaly detection
- Automatic component selection based on variance threshold
- Contribution analysis identifies which sensors cause anomalies
- SPE (Squared Prediction Error) and T² (Hotelling's) statistics
- Ideal for correlated multi-sensor data (5+ sensors)

### ✨ New Features

#### ML Inference Node
- **6 Model Formats Supported:**
  - ONNX (.onnx) - PyTorch, TensorFlow exports
  - Keras (.keras, .h5) - Native Keras models
  - scikit-learn (.pkl, .joblib) - Classical ML
  - TFLite (.tflite) - Edge/IoT devices
  - TensorFlow SavedModel - Full TF format
  - Google Coral Edge TPU - Hardware acceleration
- **Model Registry Integration:**
  - Hugging Face Hub
  - MLflow Registry
  - Custom Registry API
  - URL-based loading with Bearer/Basic auth
- **Python Bridge** for Keras, sklearn, TFLite inference

#### Signal Analyzer
- **Envelope Analysis Mode** - Bearing fault detection using envelope spectrum
  - Bandpass filtering with configurable frequency range
  - Automatic detection of BPFO, BPFI, BSF, FTF fault frequencies
  - Harmonic analysis (up to 3x fundamental)
  - Configurable shaft speed and bearing parameters
- **Cepstrum Mode** - Gearbox fault detection using cepstrum (quefrency domain)
  - Detects gear mesh frequencies and sidebands
  - Rahmonic (cepstrum peak) detection
- **Vibration Mode Enhancements:**
  - **Autocorrelation (ACF)** - Detects periodicity in signals
  - **Sample Entropy** - Measures signal complexity/regularity
  - **Periodicity Detection** - Identifies periodic patterns with strength metric
- **`windowFunction`** - Hann, Hamming, Blackman, Rectangular
- **`overlapPercent`** - 0-90% overlap for continuous analysis

#### Trend Predictor
- **Dedicated RUL Mode** - Remaining Useful Life calculation with confidence intervals
  - Configurable failure and warning thresholds
  - Multiple time units (hours, minutes, days, cycles)
  - Confidence intervals based on R-squared
  - Status output: healthy/warning/critical/failed
  - Degradation rate and percentage tracking
- **Weibull reliability analysis** for RUL prediction
  - New degradation model option: Linear, Exponential, Weibull
  - Automatic Weibull parameter estimation (β, η)
  - **B-Life calculation** (B1, B5, B10, B50) - time when X% have failed
  - Failure mode classification with interpretation (infant_mortality, useful_life, wear_out, rapid_wear_out)
  - MTTF calculation

#### Multi-Value Processor
- **Aggregate Mode** - Reduce multiple values to single statistic
  - Methods: Mean, Median, Min, Max, Sum, Range, StdDev
  - Optional output of all statistics
  - Preserves original values when needed
- **Mahalanobis Distance** - Multivariate anomaly detection accounting for sensor correlations
  - New method in Analyze mode
  - **Severity levels** (normal, warning, critical) with dual thresholds
  - Covariance-aware anomaly threshold
- **Cross-Correlation** - Time lag detection between two sensors
  - Finds optimal lag and correlation strength
  - Detects propagation delays (e.g., temperature waves through pipes)
  - Interpretation of lag direction (which sensor leads/lags)

#### Isolation Forest
- **Online Learning Modes** - Adaptive anomaly detection
  - Batch mode (original behavior)
  - Incremental mode with configurable retrain interval
  - Adaptive mode with threshold auto-adjustment
  - Extended output with sample count and retrain info
- **`numEstimators`** - Number of isolation trees (default: 100)
- **`maxSamples`** - Samples per tree (default: 256)

#### Health Index
- **Visual Threshold Configuration** - Slider-based sensor weight editor
  - Interactive add/remove sensor controls
  - Visual threshold bar showing status zones
  - Configurable healthy/warning/degraded/critical thresholds
  - All thresholds now output in msg.thresholds

#### All Nodes
- **`outputTopic`** - Set custom msg.topic on output
- **`debug` mode** - Detailed logging to Node-RED debug

### 📦 Pre-trained Models

All models trained on realistic synthetic industrial data:

| Model | Format | Accuracy | Description |
|-------|--------|----------|-------------|
| sensor-onnx | ONNX | 99.2% | 5-sensor anomaly detection |
| onnx-anomaly | ONNX | 99.9% | 10-sensor correlation |
| pytorch-vibration | ONNX | 100% | Bearing fault detection |
| keras-anomaly | Keras | 98.8% | 5-sensor (.keras) |
| sklearn-rf | sklearn | 99.4% | Random Forest |
| sklearn-gb | sklearn | 99.5% | Gradient Boosting |
| sensor-tflite | TFLite | 98.5% | Edge-optimized |

### 🎨 UI Improvements

- **Modern Design** - Collapsible sections, consistent styling
- **Unified Category** - All nodes in "condition-monitoring"
- **Single Icon** - Consistent icon.png across all nodes
- **Z-Score Clarification** - Thresholds now clearly labeled as σ (standard deviations)

### 🧪 Testing

- **8 Test Suites** - One per node
- **83 Tests** - All passing
- **Jest Framework** with node-red-node-test-helper

### 📝 Documentation

- Updated README for 8-node architecture
- Comprehensive models/README.md
- Example flows in flows.json with 12 tabs

### 🔧 Technical

- Python bridge (python_bridge.py) for TFLite/Keras/sklearn
- Custom Dockerfile with Python ML dependencies
- Fixed duplicate ml-inference registration bug
- Improved ONNX input shape parsing

---

## [0.1.2] - 2024-12-17 - Quality & Testing Release

### ✨ New Features

#### Node Improvements
- **Severity Levels**: All anomaly nodes now output `severity` field with values:
  - `"normal"` - No anomaly detected
  - `"warning"` - Approaching threshold (configurable)
  - `"critical"` - Threshold exceeded
- **Node Status Display**: Live status showing:
  - Blue ring: Waiting for data
  - Yellow: Warmup phase (collecting data)
  - Green: Normal operation with current statistics
  - Yellow dot: Warning detected
  - Red dot: Critical anomaly detected
- **Reset Function**: Send `msg.reset = true` to clear buffer and restart learning
- **Buffer Info**: Output now includes `bufferSize` and `windowSize` for transparency

#### Improved Nodes
- `zscore-anomaly` - Added `warningThreshold` config option
- `threshold-anomaly` - Added `warningMargin` (%) for approach warnings
- `iqr-anomaly` - Added `warningMultiplier`, now outputs `median`
- `ema-anomaly` - Added `warningThreshold`, configurable `windowSize`
- `moving-average-anomaly` - Added `warningThreshold`, outputs `stdDev`
- `cusum-anomaly` - Added `warningThreshold`, outputs `cusumMax`

### 🧪 Testing

- **47 Unit Tests** - Comprehensive test suite with realistic industrial scenarios
- **Jest Framework** - Professional testing with node-red-node-test-helper
- **CI/CD Integration** - Tests run automatically on npm publish workflow
- **Realistic Test Data** - Tests use actual industrial values:
  - Motor temperature monitoring (45-47°C normal, 52.5°C anomaly)
  - Pump vibration analysis (2.3-2.7 mm/s normal, 4.2 mm/s bearing defect)
  - Hydraulic pressure monitoring (150-250 bar operating range)
  - Compressor current analysis (12-13A normal, 18.5A mechanical jam)
  - CNC spindle load monitoring (45-52% normal, 72% tool wear)

### 📦 Package Improvements

- **Icons Optimized**: Reduced from 2.8 MB to 55 KB (99.9% smaller)
- **Package Size**: 58 KB compressed, 287 KB unpacked
- **Dev Dependencies**: Added jest, node-red, node-red-node-test-helper

### 📝 Documentation

- **Updated Help Text**: Z-Score node now has comprehensive built-in documentation
- **Severity Levels**: Documented in node help panels
- **Reset Function**: Documented with examples

### 🔧 Technical Changes

- Improved message property preservation (no longer overwrites existing fields)
- Consistent output format across all anomaly detection nodes
- Better error handling with status display

---

## [0.1.1] - 2025-12-03 - Bug Fix Release

### 🐛 Fixed

- **Dependency Update**: Updated `ml-isolation-forest` from `^0.0.4` to `^0.1.0` to fix installation errors
  - Version 0.0.4 is no longer available on npm registry
  - Resolves `npm error code ETARGET` during installation
- **API Compatibility**: Updated Isolation Forest Anomaly node to work with new API
  - Changed from binary prediction (-1/1) to score-based detection
  - Implemented dynamic threshold calculation based on contamination parameter
  - Improved anomaly detection accuracy with adaptive scoring

### 📦 Dependencies

- `ml-isolation-forest`: `^0.0.4` → `^0.1.0`
- `simple-statistics`: `^7.8.2` (unchanged)

### ✅ Testing

- Verified npm installation works correctly
- Confirmed API compatibility with ml-isolation-forest 0.1.0
- Tested Isolation Forest node functionality

---

## [0.1.0] - 2024-11-16 - INITIAL BETA RELEASE

### 🎉 First Public Release

This is the initial beta release with all core features implemented and functional.

### 🚧 Status: Beta Testing

All features are working and ready for real-world testing. API may change before v1.0.0.

### ✨ Added

#### Anomaly Detection Nodes (10)
- **Z-Score Anomaly** - Statistical outlier detection using standard deviations
- **IQR Anomaly** - Interquartile range-based robust outlier detection
- **Moving Average Anomaly** - Trend-based anomaly detection with sliding window
- **Isolation Forest Anomaly** - ML-based anomaly detection for complex patterns
- **Threshold Anomaly** - Simple min/max boundary checking
- **Percentile Anomaly** - Rank-based extreme value detection
- **EMA Anomaly** - Exponential moving average for recent change detection
- **CUSUM Anomaly** - Cumulative sum for drift detection
- **Multi-Value Anomaly** - Combined sensor analysis
- **Multi-Value Splitter** - Array data splitting utility

#### Predictive Maintenance Nodes (7)
- **Trend Prediction** - Remaining Useful Life (RUL) calculation using linear regression
- **FFT Analysis** - Frequency domain analysis for vibration monitoring
- **Vibration Features** - Comprehensive feature extraction (RMS, Crest Factor, Kurtosis, Skewness)
- **Health Index** - Multi-sensor aggregation into 0-100% health score
- **Rate of Change** - Derivative analysis for rapid change detection
- **Peak Detection** - Impact and shock event counting
- **Correlation Anomaly** - Sensor relationship validation

#### Features
- Two category structure: "anomaly detection" and "predictive maintenance"
- Consistent yellow color scheme for all nodes
- Custom logo for brand recognition
- Comprehensive documentation for each node
- 5 complete example flows demonstrating all nodes
- Docker development environment

#### Documentation
- Complete README with decision guide ("Which Node Should I Use?")
- 5 example flows with detailed explanations
- Node-specific help documentation
- PAYLOAD_FORMAT.md for data structure specs
- MULTI_VALUE.md for multi-sensor usage
- DOCKER.md for containerized development
- NODE_COVERAGE.md showing example coverage
- IMPORT_GUIDE.md for getting started

### 📋 Dependencies
- `ml-isolation-forest` ^0.0.4 - Machine learning anomaly detection
- `simple-statistics` ^7.8.2 - Statistical calculations

### ⚠️ Known Limitations
- API may change before v1.0 release
- Some features require validation in production environments

### 🔮 Planned for v1.0
- [x] ~~Comprehensive unit test suite~~ (Added in v0.1.2 - 47 tests)
- [ ] Performance benchmarks
- [ ] Additional validation with real industrial data
- [ ] API stabilization
- [x] ~~npm package publication~~ (Published)

---

## Version Numbering

- **0.1.0** - Initial beta release ✅
- **0.1.1** - Bug fix release ✅
- **0.1.2** - Quality & Testing release ✅
- **0.2.0** - Major Consolidation release ✅
- **0.2.2** - Predictive Maintenance Enhancement (current) ✅
- **0.3.0 - 0.8.0** - Beta updates with bug fixes and improvements
- **0.9.0** - Release candidate (feature freeze)
- **1.0.0** - First stable release (target: Q2 2026)
- **1.x.x** - Stable releases with backward compatibility
- **2.0.0+** - Major releases (may include breaking changes)

---

## Contributing

During the testing phase, feedback is highly appreciated:
- Report bugs and issues
- Suggest improvements
- Share your use cases
- Contribute example flows

---

**Note:** This project is under active development. Use in production with caution and proper testing.
