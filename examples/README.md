# Node-RED Condition Monitoring - Example Flows

This directory contains ready-to-use example flows demonstrating all nodes in the condition monitoring package.

## Overview of Examples

| Example | Nodes Used | Use Case | Complexity |
|---------|-----------|----------|------------|
| **Example 1** | Z-Score, Trend Prediction, Health Index, Rate of Change, Correlation, Multi-Value Splitter | Motor Monitoring | Medium |
| **Example 2** | FFT Analysis, Peak Detection, IQR, Moving Average | Bearing Vibration Analysis | High |
| **Example 3** | Threshold, Percentile, EMA, CUSUM, Multi-Value Anomaly | Process Monitoring (Pump) | Low |
| **Example 4** | Isolation Forest | ML Anomaly Detection | Low |
| **Example 5** | Vibration Features | Comprehensive Feature Extraction | Low |

## How to Import

### Method 1: Via Node-RED UI
1. Open Node-RED in your browser: `http://localhost:1880`
2. Click the menu → Import
3. Select the JSON file or paste its contents
4. Click "Import"

### Method 2: Via Command Line
```bash
# Copy example to Node-RED
cp example-1-motor-monitoring.json ~/.node-red/flows/
```

## Example 1: Motor Monitoring

**File:** `example-1-motor-monitoring.json`

### What it does:
- Simulates a motor with gradual degradation over time
- Monitors temperature, vibration, and power consumption
- Predicts remaining useful life (RUL)
- Calculates overall health index
- Detects rapid changes and correlation breakdowns

### Nodes Used:
- **Z-Score Anomaly** (3x) - Individual sensor anomaly detection
- **Trend Prediction** - RUL calculation for temperature
- **Rate of Change** - Detects rapid temperature changes
- **Health Index** - Overall motor health (0-100)
- **Correlation Anomaly** - Temperature vs Power relationship
- **Multi-Value Splitter** - Splits sensor data for parallel processing

### What to Watch For:
1. As the motor degrades, temperature rises gradually
2. **Trend Prediction** shows "time to threshold" decreasing
3. **Health Index** drops from 100% → 80% → 60% (degraded)
4. **Correlation** breaks when relationship between temp/power changes
5. **Rate of Change** triggers on rapid temperature spikes

### Expected Output:
```
Health Index: 100% → 85% → 70% → 55% (warning)
RUL: "48 hours until 85°C threshold"
Correlation: 0.95 → 0.82 → 0.65 (broken!)
```

---

## Example 2: Bearing Vibration Analysis

**File:** `example-2-bearing-vibration-analysis.json`

### What it does:
- Simulates bearing vibration with developing fault
- Performs frequency analysis to detect bearing defects
- Detects impulsive events (impacts)
- Uses multiple statistical methods

### Nodes Used:
- **FFT Analysis** - Frequency domain analysis (157 Hz bearing fault)
- **Peak Detection** - Impact event detection
- **IQR Anomaly** - Robust outlier detection
- **Moving Average Anomaly** - Trend-based detection

### What to Watch For:
1. **FFT Analysis** shows increasing peak at ~157 Hz (bearing fault frequency)
2. **Peak Detection** triggers more frequently as fault develops
3. **Crest Factor** increases (indicates impulsive behavior)
4. Rising vibration amplitude over time

### Expected Output:
```
FFT Peaks: [30 Hz (rotation), 157 Hz (fault, increasing)]
Impact Frequency: Increasing over time
Crest Factor: 2.5 → 3.2 → 4.5 (indicates fault)
```

### Bearing Fault Frequencies:
- **30 Hz**: Normal rotation speed
- **157 Hz**: Example bearing fault frequency (BPFO)
- **Harmonics**: Multiples indicate advanced damage

---

## Example 3: Process Monitoring (Pump System)

**File:** `example-3-process-monitoring.json`

### What it does:
- Simulates pump system with gradual leak development
- Monitors flow rate, pressure, and temperature
- Detects slow drifts and sudden transients
- Uses complementary detection methods

### Nodes Used:
- **Multi-Value Anomaly** - Analyzes all sensors together
- **Threshold Anomaly** - Hard limits for flow rate
- **CUSUM Anomaly** - Detects slow drift in flow
- **Percentile Anomaly** - Extreme pressure detection
- **EMA Anomaly** - Fast temperature spike detection

### What to Watch For:
1. Flow rate gradually decreases (leak simulation)
2. **CUSUM** detects the slow drift before threshold is violated
3. Occasional transients trigger **EMA** and **Percentile**
4. **Multi-Value** catches correlated anomalies across sensors

### Expected Output:
```
Flow: 100 → 95 → 90 → 85 (CUSUM drift detected)
Pressure: 120 → 115 → 110 (correlates with flow)
CUSUM Alert: "Drift detected after 200 samples"
Threshold: Triggered when flow < 80
```

---

## Example 4: Machine Learning Anomaly Detection

**File:** `example-4-isolation-forest-ml.json`

### What it does:
- Demonstrates Isolation Forest ML algorithm
- Handles data with multiple normal operating modes
- Automatically adapts to pattern changes
- No threshold tuning required

### Nodes Used:
- **Isolation Forest Anomaly** - ML-based detection

### What to Watch For:
1. System operates in 3 different modes (low/medium/high power)
2. Isolation Forest learns all three modes as "normal"
3. Random anomalies are detected regardless of mode
4. Anomaly score indicates severity

### Expected Output:
```
Mode 1: 50 ± 5 (steady)
Mode 2: 75 ± 10 (oscillating) 
Mode 3: 100 ± 15 (noisy)
Anomaly Score: Normal = 0.4, Anomaly = 0.8+
```

### Advantages:
- No threshold tuning needed
- Handles multi-modal data
- Adapts to changing patterns
- Works with complex relationships

---

## Node Coverage Summary

### All 16 Nodes Demonstrated:

#### Anomaly Detection (10 nodes):
1. **Z-Score** - Example 1
2. **IQR** - Example 2
3. **Moving Average** - Example 2
4. **Isolation Forest** - Example 4
5. **Threshold** - Example 3
6. **Percentile** - Example 3
7. **EMA** - Example 3
8. **CUSUM** - Example 3
9. **Multi-Value Anomaly** - Example 3
10. **Multi-Value Splitter** - Example 1

#### Predictive Maintenance (6 nodes):
11. **Trend Prediction** - Example 1
12. **FFT Analysis** - Example 2
13. **Health Index** - Example 1
14. **Rate of Change** - Example 1
15. **Peak Detection** - Example 2
16. **Correlation Anomaly** - Example 1

---

## Tips for Using Examples

### 1. Start Simple
Begin with **Example 3** (Process Monitoring) - it's the easiest to understand.

### 2. Adjust Simulation Speed
Change the inject node interval:
- Fast: `0.1s` - Quick demonstration
- Normal: `1s` - Realistic timing
- Slow: `5s` - Easy to observe changes

### 3. Enable/Disable Debug Nodes
- Green = Active (shows output)
- Gray = Inactive (quiet)
- Right-click debug nodes to toggle

### 4. Modify Thresholds
Experiment with different values:
```javascript
// Make more sensitive
threshold: 2.0  // instead of 3.0

// Make less sensitive  
threshold: 4.0
```

### 5. Add Your Own Sensors
Replace function nodes with real data:
```javascript
// Instead of simulation
msg.payload = {
    temperature: msg.payload.temp,  // From real sensor
    vibration: msg.payload.vib
};
```

---

## Troubleshooting

### Issue: Nodes not showing up
**Solution:** Restart Node-RED
```bash
docker-compose restart
```

### Issue: Too many debug messages
**Solution:** Disable "normal" debug nodes, keep only "anomaly" ones

### Issue: Isolation Forest not working
**Solution:** Check if `ml-isolation-forest` package is installed
```bash
cd ~/.node-red
npm install ml-isolation-forest
```

### Issue: FFT shows no peaks
**Solution:** 
- Increase sampling rate
- Adjust `peakThreshold` (lower = more sensitive)
- Increase buffer size (more samples)

---

## Learn More

### Node Documentation
Each node has built-in help:
1. Drag node to canvas
2. Select it
3. Click "Info" button in sidebar
4. Read detailed documentation

### Combine Examples
Mix and match nodes from different examples:
- FFT + Trend Prediction = Frequency-based RUL
- Health Index + All anomaly types = Comprehensive monitoring
- Correlation + Rate of Change = Multi-sensor validation

---

## Next Steps

1. **Import all examples** to see different approaches
2. **Run them** and watch the debug output
3. **Modify simulators** to match your use case
4. **Add your real sensors** replacing function nodes
5. **Connect to dashboards** (use node-red-dashboard)
6. **Set up alerts** (email, Telegram, etc.)

---

## Example 5: Vibration Feature Extraction

**File:** `example-5-vibration-feature-extraction.json`

### What it does:
- Generates realistic vibration signals with simulated bearing defect
- Extracts comprehensive vibration features (RMS, Crest Factor, Kurtosis, etc.)
- Demonstrates both output modes (all-in-one and separate)
- Monitors health indicators and triggers alerts
- Shows feature interpretation for fault diagnosis

### Nodes Used:
- **Vibration Features** (2x) - All-in-one mode and separate outputs mode

### What to Watch For:
1. **First 10 seconds:** Normal operation
   - Crest Factor: 2-4 (normal)
   - Kurtosis: ~0 (normal distribution)
   - Health Score: 90-100%

2. **After 10 seconds:** Bearing defect simulation starts
   - Crest Factor increases (>6 = impulsive)
   - Kurtosis spikes (>3 = peaked, indicates impacts)
   - Health Score drops (<70%)
   - Alerts triggered in debug output

3. **Feature Outputs:**
   - **All Features mode:** Single comprehensive object (good for dashboards)
   - **Separate mode:** 6 individual outputs for downstream processing

### Key Features Explained:
- **RMS:** Overall vibration energy level
- **Peak-to-Peak:** Total amplitude range
- **Crest Factor:** Peak/RMS ratio (>6 indicates impulsive behavior)
- **Kurtosis:** Measures "spikiness" (>3 indicates defects/impacts)
- **Skewness:** Measures asymmetry (indicates wear direction)
- **Health Score:** Simplified 0-100% condition indicator

### Use Cases:
- Bearing condition monitoring
- Gearbox fault detection
- Motor imbalance detection
- Feature trending for predictive maintenance
- ML model input preparation

---

## Real-World Applications

These examples can be adapted for:

- **Manufacturing:** Machine health monitoring
- **Energy:** Battery degradation prediction
- **Automotive:** Vehicle diagnostics
- **Healthcare:** Medical equipment monitoring
- **HVAC:** Climate system optimization
- **Water Treatment:** Pump and valve monitoring
- **Electrical:** Power quality monitoring

---

## Support

For questions or issues:
1. Check node documentation (Info icon)
2. Review this README
3. Examine example flows
4. Check Node-RED logs: `docker logs node-red-condition-monitoring`

---

**Happy Monitoring!**

