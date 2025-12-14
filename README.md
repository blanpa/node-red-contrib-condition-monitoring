# node-red-contrib-condition-monitoring

A comprehensive Node-RED module for **anomaly detection**, **predictive maintenance**, and **time series analysis**.

[![npm version](https://img.shields.io/npm/v/node-red-contrib-condition-monitoring.svg)](https://www.npmjs.com/package/node-red-contrib-condition-monitoring)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-orange.svg)](CHANGELOG.md)
[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg)](CHANGELOG.md)

---

## Project Status: BETA (v0.1.1)

**This is the first public release - currently in beta testing.**

- **First Release:** All core features are implemented and functional
- **Beta Phase:** Undergoing real-world validation and testing
- **Feedback Welcome:** Please report issues and share your experience
- **API May Change:** Breaking changes possible before v1.0 stable release
- **Production Use:** Use with caution and proper testing in your environment
- **Goal:** Reach v1.0.0 stable after community feedback and validation

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

- **10 Anomaly Detection Methods** - Z-Score, IQR, Moving Average, Isolation Forest, Threshold, Percentile, EMA, CUSUM, Multi-Value
- **7 Predictive Maintenance Nodes** - Trend Prediction (RUL), FFT Analysis, Vibration Features, Health Index, Rate of Change, Peak Detection, Correlation Analysis
- **Real-time Processing** - Continuous data stream analysis
- **Ready-to-Use Examples** - 5 complete example flows in `/examples` directory
- **Fully Documented** - Built-in help for every node

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
3. Select one of the 4 example flows:
   - **Example 1:** Motor Monitoring (Z-Score, Trend Prediction, Health Index, Correlation)
   - **Example 2:** Bearing Vibration Analysis (FFT, Peak Detection, IQR)
   - **Example 3:** Process Monitoring (Threshold, CUSUM, EMA, Percentile)
   - **Example 4:** ML Anomaly Detection (Isolation Forest)

**See `/examples/README.md` for detailed documentation of all examples.**

## Available Nodes

### Anomaly Detection (10 Nodes)

| Node | Method | Best For | Output |
|------|--------|----------|--------|
| **Z-Score** | Statistical | General purpose anomalies | 2 outputs (normal/anomaly) |
| **IQR** | Quartile-based | Robust to outliers | 2 outputs |
| **Moving Average** | Trend-based | Gradual changes | 2 outputs |
| **Isolation Forest** | Machine Learning | Complex patterns | 2 outputs |
| **Threshold** | Min/Max limits | Hard boundaries | 2 outputs |
| **Percentile** | Rank-based | Dynamic thresholds | 2 outputs |
| **EMA** | Exponential smoothing | Recent changes | 2 outputs |
| **CUSUM** | Cumulative sum | Drift detection | 2 outputs |
| **Multi-Value Anomaly** | Any method | Multiple sensors | 2 outputs |
| **Multi-Value Splitter** | Utility | Split sensor arrays | 1 output |

### Predictive Maintenance (7 Nodes)

| Node | Function | Output | Use Case |
|------|----------|--------|----------|
| **Trend Prediction** | RUL calculation | Future values, time-to-threshold | "Motor fails in 48h" |
| **FFT Analysis** | Frequency analysis | Peaks, spectral features | Bearing fault detection |
| **Vibration Features** | Feature extraction | RMS, Crest Factor, Kurtosis, Skewness | Comprehensive vibration analysis |
| **Health Index** | Multi-sensor aggregation | 0-100 health score | Overall equipment status |
| **Rate of Change** | Derivative analysis | Speed of change, acceleration | Rapid temperature rise |
| **Peak Detection** | Impact detection | Peak events | Bearing impacts, shocks |
| **Correlation Anomaly** | Sensor relationship | Correlation coefficient | Temp vs Power relationship |

## Which Node Should I Use?

### For Anomaly Detection:

**Simple Use Cases:**
- **Hard boundaries (min/max)?** → **Threshold Anomaly**
  - Example: Temperature must stay between 20-80°C
  
- **Statistical outliers?** → **Z-Score** or **IQR Anomaly**
  - Z-Score: Best for normally distributed data
  - IQR: More robust, works with any distribution

**Trend & Drift Detection:**
- **Slow gradual changes?** → **CUSUM Anomaly**
  - Example: Pump flow slowly decreasing over days
  
- **Moving baseline?** → **Moving Average** or **EMA Anomaly**
  - Moving Average: Equal weight to all values in window
  - EMA: Recent values weighted more (faster response)

**Advanced Cases:**
- **Complex patterns, no clear rules?** → **Isolation Forest**
  - Machine learning approach, learns automatically
  
- **Extreme values only?** → **Percentile Anomaly**
  - Example: Detect only top 5% and bottom 5%

**Multiple Sensors:**
- **Analyze multiple sensors together?** → **Multi-Value Anomaly**
- **Split sensor array for separate processing?** → **Multi-Value Splitter**

---

### For Predictive Maintenance:

**Vibration Analysis:**
- **Time-domain features (RMS, Crest Factor, Kurtosis)?** → **Vibration Features**
  - Best for: Bearing condition, overall vibration health
  
- **Frequency analysis (FFT, harmonics)?** → **FFT Analysis**
  - Best for: Finding specific fault frequencies (bearing, gear defects)
  
- **Count impacts/shocks?** → **Peak Detection**
  - Best for: Impact counting, shock detection

**Trend & Prediction:**
- **Predict when threshold will be reached?** → **Trend Prediction**
  - Calculates Remaining Useful Life (RUL)
  - Example: "Temperature will exceed 100°C in 48 hours"
  
- **Measure rate of degradation?** → **Rate of Change**
  - Detects rapid changes (acceleration)
  - Example: "Temperature rising 5°C per hour"

**Health Assessment:**
- **Single health score from multiple sensors?** → **Health Index**
  - Combines temperature, vibration, pressure into 0-100% score
  
- **Validate sensor relationships?** → **Correlation Anomaly**
  - Example: Check if temperature and power consumption correlate correctly

---

### Quick Decision Tree:

```
Do you have historical data?
├─ NO  → Start with Threshold or Z-Score
└─ YES → Continue below

Is it vibration data?
├─ YES → Vibration Features + FFT Analysis + Peak Detection
└─ NO  → Continue below

Single sensor or multiple?
├─ SINGLE → Z-Score / Moving Average / CUSUM
└─ MULTIPLE → Multi-Value Splitter + Individual Analysis → Health Index

Need to predict failures?
└─ YES → Trend Prediction + Rate of Change + Health Index
```

## Usage Examples

### Simple Temperature Monitoring

```
[MQTT Sensor] → [Z-Score Anomaly] → [Normal] → [Dashboard]
                                   → [Anomaly] → [Alarm]
```

### Motor Predictive Maintenance

```
[Sensors] → [Multi-Value Splitter] → [Z-Score]
                                   → [Trend Prediction] → RUL Display
                                   → [FFT Analysis] → Frequency Chart
         → [Health Index] → Health Dashboard
```

### Bearing Vibration Analysis

```
[Vibration Sensor] → [Vibration Features] → RMS, Crest Factor, Kurtosis
                   → [FFT Analysis] → Frequency Peaks
                   → [Peak Detection] → Impact Counter
                   → [IQR Anomaly] → Outlier Detection
```

## Documentation

### Node-Specific Help
Each node has comprehensive built-in documentation:
1. Drag node to canvas
2. Select it
3. Click **Info** in sidebar
4. Read detailed docs with examples

### Additional Documentation
- **[examples/README.md](examples/README.md)** - Detailed guide for all 5 example flows
- **[PAYLOAD_FORMAT.md](PAYLOAD_FORMAT.md)** - Input format specifications
- **[MULTI_VALUE.md](MULTI_VALUE.md)** - Working with multiple sensors
- **[DOCKER.md](DOCKER.md)** - Docker deployment guide

## Node Configuration

### Example: Z-Score Anomaly

```javascript
// Input
msg.payload = 42.5;

// Output (Anomaly)
{
  "payload": 42.5,
  "zScore": 3.2,
  "mean": 35.0,
  "stdDev": 2.3,
  "isAnomaly": true,
  "threshold": 3.0
}
```

### Example: Trend Prediction

```javascript
// Input
msg.payload = 75.2;  // Temperature
msg.timestamp = Date.now();

// Output
{
  "payload": 75.2,
  "trend": "increasing",
  "slope": 0.5,
  "predictedValues": [76.2, 76.7, 77.2, ...],
  "timeToThreshold": 172800000,  // 48 hours in ms
  "stepsToThreshold": 96
}
```

### Example: FFT Analysis

```javascript
// Input (continuous stream at 1000 Hz)
msg.payload = 0.45;  // Vibration amplitude

// Output
{
  "payload": 0.45,
  "peaks": [
    { "frequency": 30, "magnitude": 0.5 },
    { "frequency": 157, "magnitude": 0.3 }  // Bearing fault!
  ],
  "dominantFrequency": 30,
  "features": {
    "spectralCentroid": 85.2,
    "crestFactor": 3.5,  // High = impulsive behavior
    "rms": 0.42
  }
}
```

## Learning Path

1. **Start Simple** - Import Example 3 (Process Monitoring)
2. **Learn Basics** - Understand threshold and Z-Score detection
3. **Advanced Methods** - Try FFT and Trend Prediction
4. **Combine Nodes** - Build complete predictive maintenance system

## Real-World Applications

- **Manufacturing** - Machine health monitoring, quality control
- **Energy** - Battery degradation, power quality monitoring
- **Automotive** - Vehicle diagnostics, fleet management
- **HVAC** - Climate system optimization, energy efficiency
- **Water Treatment** - Pump monitoring, leak detection
- **Aerospace** - Engine monitoring, structural health
- **Medical** - Equipment monitoring, vital sign analysis

## Technical Details

### Statistical Methods

| Method | Type | Complexity | Speed | Accuracy |
|--------|------|------------|-------|----------|
| Threshold | Rule-based | Low | Fast | Medium |
| Z-Score | Statistical | Low | Fast | High |
| IQR | Statistical | Medium | Fast | High |
| Percentile | Statistical | Medium | Fast | High |
| Moving Average | Trend | Low | Fast | Medium |
| EMA | Trend | Low | Fast | Medium |
| CUSUM | Cumulative | Medium | Fast | High |
| Isolation Forest | ML | High | Medium | Very High |

### Predictive Maintenance Capabilities

| Feature | Node | Output |
|---------|------|--------|
| RUL Estimation | Trend Prediction | Time until failure |
| Frequency Analysis | FFT Analysis | Fault frequencies |
| Overall Health | Health Index | 0-100 score |
| Change Speed | Rate of Change | Derivative |
| Impact Events | Peak Detection | Peak count |
| Sensor Validation | Correlation | Relationship strength |

## Development

### Run with Docker

```bash
# Development mode (with hot-reload)
docker-compose -f docker-compose.dev.yml up

# Production mode
docker-compose up
```

### Local Development

```bash
# Install dependencies
npm install

# Link to Node-RED
npm link
cd ~/.node-red
npm link node-red-contrib-condition-monitoring

# Restart Node-RED
node-red-restart
```

## Dependencies

### Required
- Node-RED >= 1.0.0
- Node.js >= 14.0.0

### Optional
- `ml-isolation-forest` - For Isolation Forest node (falls back to Z-Score if not available)
- `simple-statistics` - For advanced statistical functions

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

## Issues & Support

- **Bug Reports:** Open an issue on GitHub
- **Questions:** Check `/examples/README.md` first
- **Feature Requests:** Submit via GitHub issues

## Roadmap

- [ ] Dashboard UI components
- [ ] Export/import of trained models
- [ ] MQTT examples
- [ ] Real-time charting integration
- [ ] More ML algorithms (LSTM, Prophet)
- [ ] Automated reporting

## Show Your Support

If you find this useful, please consider:
- Starring the repository
- Sharing with others
- Reporting bugs
- Suggesting features

---

**Made with love for the Node-RED community**

**Get Started:** Import an example flow and start monitoring in minutes!
