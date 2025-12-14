# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- No unit tests yet (example-based testing only)
- API may change before v1.0 release
- Some features require validation in production environments

### 🔮 Planned for v1.0
- [ ] Comprehensive unit test suite
- [ ] Performance benchmarks
- [ ] Additional validation with real industrial data
- [ ] API stabilization
- [ ] npm package publication

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

