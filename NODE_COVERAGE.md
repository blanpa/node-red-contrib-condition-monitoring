# Node Coverage in Examples

This document shows which nodes are used in which example flows, ensuring all 16 nodes are demonstrated.

## ✅ Complete Coverage Summary

All **17 nodes** are covered across **5 example flows**.

---

## Example 1: Motor Monitoring
**File:** `examples/example-1-motor-monitoring.json`

### Nodes Used (6):
1. ✅ **Z-Score Anomaly** (×3) - Temperature, Vibration, Power
2. ✅ **Trend Prediction** - Temperature RUL calculation
3. ✅ **Rate of Change** - Rapid temperature change detection
4. ✅ **Health Index** - Overall motor health aggregation
5. ✅ **Correlation Anomaly** - Temperature vs Power relationship
6. ✅ **Multi-Value Splitter** - Split sensor data for parallel processing

### What it Demonstrates:
- Multi-sensor monitoring
- Predictive maintenance with RUL
- Health score calculation
- Sensor correlation validation

---

## Example 2: Bearing Vibration Analysis
**File:** `examples/example-2-bearing-vibration-analysis.json`

### Nodes Used (4):
7. ✅ **FFT Analysis** - Frequency domain analysis
8. ✅ **Peak Detection** - Impact event detection
9. ✅ **IQR Anomaly** - Robust outlier detection
10. ✅ **Moving Average Anomaly** - Trend-based detection

### What it Demonstrates:
- Vibration frequency analysis
- Bearing fault detection (157 Hz)
- Impact counting
- Multiple detection methods comparison

---

## Example 3: Process Monitoring (Pump System)
**File:** `examples/example-3-process-monitoring.json`

### Nodes Used (5):
11. ✅ **Threshold Anomaly** - Flow rate boundaries
12. ✅ **CUSUM Anomaly** - Slow drift detection
13. ✅ **Percentile Anomaly** - Extreme pressure detection
14. ✅ **EMA Anomaly** - Quick temperature spike detection
15. ✅ **Multi-Value Anomaly** - Combined sensor analysis

### What it Demonstrates:
- Process monitoring
- Leak detection (CUSUM)
- Multiple complementary detection methods
- Transient event handling

---

## Example 4: Machine Learning Anomaly Detection
**File:** `examples/example-4-isolation-forest-ml.json`

### Nodes Used (1):
16. ✅ **Isolation Forest Anomaly** - ML-based complex pattern detection

### What it Demonstrates:
- Machine learning approach
- Multi-modal data handling
- No threshold tuning required
- Automatic pattern learning

---

## Example 5: Vibration Feature Extraction
**File:** `examples/example-5-vibration-feature-extraction.json`

### Nodes Used (1):
17. ✅ **Vibration Features** - Comprehensive vibration analysis (RMS, Crest Factor, Kurtosis, Skewness)

### What it Demonstrates:
- Feature extraction from vibration signals
- Two output modes (all-in-one and separate)
- Health score calculation
- Automatic feature interpretation
- Bearing defect simulation and detection

---

## Complete Node List with Coverage

| # | Node Name | Example 1 | Example 2 | Example 3 | Example 4 | Example 5 |
|---|-----------|:---------:|:---------:|:---------:|:---------:|:---------:|
| 1 | Z-Score Anomaly | ✅ (×3) | | | | |
| 2 | IQR Anomaly | | ✅ | | | |
| 3 | Moving Average Anomaly | | ✅ | | | |
| 4 | Isolation Forest Anomaly | | | | ✅ | |
| 5 | Threshold Anomaly | | | ✅ | | |
| 6 | Percentile Anomaly | | | ✅ | | |
| 7 | EMA Anomaly | | | ✅ | | |
| 8 | CUSUM Anomaly | | | ✅ | | |
| 9 | Multi-Value Anomaly | | | ✅ | | |
| 10 | Multi-Value Splitter | ✅ | | | | |
| 11 | Trend Prediction | ✅ | | | | |
| 12 | FFT Analysis | | ✅ | | | |
| 13 | Health Index | ✅ | | | | |
| 14 | Rate of Change | ✅ | | | | |
| 15 | Peak Detection | | ✅ | | | |
| 16 | Correlation Anomaly | ✅ | | | | |
| 17 | Vibration Features | | | | | ✅ (×2) |

---

## Node Categories

### Anomaly Detection Nodes (10)
- **Statistical:** Z-Score, IQR, Percentile
- **Trend-based:** Moving Average, EMA, CUSUM
- **Boundary-based:** Threshold
- **ML-based:** Isolation Forest
- **Multi-sensor:** Multi-Value Anomaly, Multi-Value Splitter

### Predictive Maintenance Nodes (7)
- **RUL Estimation:** Trend Prediction
- **Frequency Analysis:** FFT Analysis
- **Feature Extraction:** Vibration Features
- **Health Assessment:** Health Index
- **Change Detection:** Rate of Change
- **Event Detection:** Peak Detection
- **Validation:** Correlation Anomaly

---

## Usage Distribution

### Most Frequently Used Nodes:
1. **Z-Score** - 3 instances (most versatile)
2. All others - 1 instance each

### By Category:
- **Anomaly Detection:** 10 nodes across 3 examples
- **Predictive Maintenance:** 7 nodes across 3 examples

---

## How to Test Complete Coverage

### Quick Test:
```bash
# Import all 5 examples into Node-RED
# Deploy each flow
# Watch debug output for 1-2 minutes per flow
```

### Verification Checklist:
- [ ] Example 1: Motor shows health degradation
- [ ] Example 1: RUL prediction appears
- [ ] Example 2: FFT shows frequency peaks
- [ ] Example 2: Impacts detected
- [ ] Example 3: CUSUM detects drift
- [ ] Example 3: Threshold violations occur
- [ ] Example 4: ML anomalies detected
- [ ] Example 5: Vibration features extracted
- [ ] Example 5: Health alerts triggered after 10s

---

## Additional Combinations

While all nodes are covered individually, here are some powerful combinations:

### Combo 1: Complete Bearing Monitor
```
Vibration → FFT Analysis → Frequency peaks
         → Peak Detection → Impact count
         → IQR Anomaly → Statistical outliers
         → Trend Prediction → RUL estimation
         → Health Index → Overall score
```

### Combo 2: Full Motor Analysis
```
Multi-Sensor → Multi-Value Splitter → Individual Z-Score
            → Multi-Value Anomaly → Combined analysis
            → Correlation → Sensor validation
            → Health Index → Overall health
            → Trend Prediction → Failure prediction
```

### Combo 3: Process Validation
```
Process Data → Threshold → Hard limits
            → CUSUM → Drift detection
            → EMA → Spike detection
            → Percentile → Extreme values
            → Rate of Change → Rapid changes
```

---

## Node Testing Status

| Node | Unit Tested | Integration Tested | Example Tested | Status |
|------|:-----------:|:------------------:|:--------------:|:------:|
| All Anomaly Detection | ⚠️ | ⚠️ | ✅ | Ready |
| All Predictive Maintenance | ⚠️ | ⚠️ | ✅ | Ready |

**Legend:**
- ✅ Complete
- ⚠️ To be added
- ❌ Not available

---

## Future Examples

Potential additional examples to create:
- **Example 6:** HVAC System (all EMA, Correlation, Health Index)
- **Example 7:** Battery Monitoring (Trend Prediction, CUSUM, Rate of Change)
- **Example 8:** Quality Control (Threshold, Percentile, Multi-Value)
- **Example 9:** Network Monitoring (Z-Score, Moving Average, Peak Detection)

---

**Summary:** All 17 nodes are covered across 5 well-designed example flows, each focusing on a specific real-world use case.

