# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- **0.1.0** - Initial beta release (current) ✅
- **0.2.0 - 0.8.0** - Beta updates with bug fixes and improvements
- **0.9.0** - Release candidate (feature freeze)
- **1.0.0** - First stable release (target: Q2 2025)
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

