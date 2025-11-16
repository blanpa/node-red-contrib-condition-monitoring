# How to Import Examples into Node-RED

Quick guide to get started with the example flows.

## 📥 Method 1: Direct Import (Recommended)

### Step-by-Step:

1. **Open Node-RED**
   ```
   http://localhost:1880
   ```

2. **Access Import Menu**
   - Click the menu icon (☰) in top-right corner
   - Select **"Import"**

3. **Import Example**
   - Click **"select a file to import"**
   - Navigate to: `node-red-contrib-condition-monitoring/examples/`
   - Select one of the example JSON files:
     - `example-1-motor-monitoring.json`
     - `example-2-bearing-vibration-analysis.json`
     - `example-3-process-monitoring.json`
     - `example-4-isolation-forest-ml.json`

4. **Deploy**
   - Click **"Import"** button
   - Click **"Deploy"** button (top-right)
   - Watch the debug sidebar for output!

---

## 📋 Method 2: Copy-Paste

1. Open example JSON file in text editor
2. Copy entire contents (Ctrl+A, Ctrl+C)
3. In Node-RED: Menu (☰) → Import
4. Paste into text area
5. Click "Import"
6. Click "Deploy"

---

## 🚀 Quick Start Guide

### Import Order (Recommended):

1. **Start with Example 3** (Easiest)
   - Simple threshold and detection
   - Easy to understand output

2. **Try Example 1** (Motor Monitoring)
   - Shows predictive maintenance
   - Multiple sensors
   - Health index calculation

3. **Advanced: Example 2** (Vibration)
   - FFT frequency analysis
   - High-frequency data
   - Impact detection

4. **ML: Example 4** (Isolation Forest)
   - Machine learning approach
   - Automatic pattern learning

---

## 📊 What to Expect

### After Importing:

1. **New Tab Appears**
   - Tab name = Example name
   - Contains complete flow

2. **Auto-Start**
   - Simulation starts automatically after deploy
   - Data flows every 0.5-1 second

3. **Debug Output**
   - Open debug sidebar (bug icon on right)
   - Watch for anomaly alerts (marked with ⚠️)

4. **Node Status**
   - Nodes show status below them
   - Green = Running normally
   - Yellow/Red = Anomaly detected

---

## 🎯 Understanding the Examples

### Example 1: Motor Monitoring
```
Expected Timeline:
0-2 min:   Normal operation (green)
2-5 min:   Degradation starts (yellow)
5-10 min:  Health declining (orange)
10+ min:   Critical state (red)
```

**Watch For:**
- Health Index dropping from 100% to 60%
- RUL (Remaining Useful Life) countdown
- Temperature trend increasing
- Correlation breaking

### Example 2: Bearing Vibration
```
High-Frequency Data:
- 50 samples per second
- FFT processes every 256 samples
- Bearing fault at ~157 Hz
```

**Watch For:**
- FFT peaks array in debug
- Impact detection frequency increasing
- Vibration amplitude rising

### Example 3: Process Monitoring
```
Pump System:
- Flow: 100 → 90 (leak)
- Pressure: 120 → 110 (leak)
- Temperature: 55 → 65 (wear)
```

**Watch For:**
- CUSUM detecting slow drift
- Threshold violations
- EMA catching spikes
- Multi-value anomalies

### Example 4: Machine Learning
```
Operating Modes:
- Mode 1: Low power (50)
- Mode 2: Medium (75)
- Mode 3: High (100)
```

**Watch For:**
- ML learning all three modes
- Anomaly score > 0.8
- Random spikes detected

---

## 🔧 Troubleshooting

### Issue: No nodes visible
**Fix:** Install the package first
```bash
cd ~/.node-red
npm install node-red-contrib-condition-monitoring
# Then restart Node-RED
```

### Issue: Import fails
**Fix:** Check JSON file is valid
- Open file in text editor
- Ensure it starts with `[` and ends with `]`
- No syntax errors

### Issue: Too many debug messages
**Fix:** Disable "normal" debug nodes
- Right-click debug node
- Select "Disable"
- Keep only ⚠️ anomaly debug nodes enabled

### Issue: FFT shows no output
**Fix:** Wait for buffer to fill
- FFT needs 256 samples
- At 50Hz = ~5 seconds wait time
- Check node status for "Buffering: X/256"

### Issue: Isolation Forest not working
**Fix:** Install dependency
```bash
cd ~/.node-red
npm install ml-isolation-forest
node-red-restart
```

---

## 📝 Customization Tips

### Adjust Simulation Speed

**Make it faster:**
```javascript
// In inject node, change repeat interval
"repeat": "0.1"  // 10x per second
```

**Make it slower:**
```javascript
"repeat": "5"  // Every 5 seconds
```

### Change Thresholds

Double-click any anomaly detection node:
- Increase threshold = Less sensitive
- Decrease threshold = More sensitive

### Add Your Own Data

Replace function node with real sensor:
```javascript
// Before (simulation)
msg.payload = Math.random() * 100;

// After (real sensor)
msg.payload = msg.payload.temperature;  // From MQTT, HTTP, etc.
```

---

## 🎓 Learning Path

### Beginner (15 minutes):
1. Import Example 3
2. Deploy and watch debug
3. Understand threshold detection
4. Try adjusting thresholds

### Intermediate (30 minutes):
1. Import Example 1
2. Understand multi-sensor monitoring
3. Watch health index decline
4. Learn about RUL prediction

### Advanced (1 hour):
1. Import Example 2
2. Understand FFT analysis
3. Learn frequency-based detection
4. Explore spectral features

### Expert (2 hours):
1. Import all 4 examples
2. Modify simulators
3. Combine nodes from different examples
4. Build custom monitoring solution

---

## 📚 Next Steps

After importing examples:

1. **Read Node Documentation**
   - Select any node
   - Click ℹ️ icon in sidebar
   - Read detailed help

2. **Explore Examples README**
   - Open `/examples/README.md`
   - Detailed explanation of each example
   - Learn use cases and patterns

3. **Check Node Coverage**
   - See `NODE_COVERAGE.md`
   - Understand which nodes are where
   - Learn node combinations

4. **Build Your Own**
   - Start with example as template
   - Replace simulator with real data
   - Add your own logic

---

## ✅ Verification Checklist

After importing, verify:

- [ ] Tab appears with example name
- [ ] Nodes are visible (not gray/missing)
- [ ] Deploy succeeds (no errors)
- [ ] Debug sidebar shows output
- [ ] Inject node is repeating
- [ ] Node status indicators active
- [ ] Anomalies detected over time

---

## 🎨 Visual Guide

```
Node-RED Interface:
┌─────────────────────────────────────────┐
│ [≡] Menu                    [Deploy]    │ ← Click Deploy
├─────────────────────────────────────────┤
│  Tabs: [Flow 1] [Example 1] ...        │ ← Your examples
├─────────────────────────────────────────┤
│                                         │
│  [Inject] → [Function] → [Anomaly]     │ ← Flow
│                              ↓          │
│                          [Debug]        │
│                                         │
└─────────────────────────────────────────┘
                                        │
                                        ↓
┌─────────────────────────────┐
│ Debug Sidebar (right)       │ ← Watch here
│ ⚠️ Anomaly detected!        │
│ ✓ Normal: 42.5             │
│ ⚠️ Health: 65%             │
└─────────────────────────────┘
```

---

## 🔗 Useful Links

- **Main README:** `../README.md` - Overview
- **Examples README:** `./README.md` - Detailed examples
- **Node Coverage:** `../NODE_COVERAGE.md` - All nodes
- **Payload Format:** `../PAYLOAD_FORMAT.md` - Data format
- **Docker Guide:** `../DOCKER.md` - Deployment

---

**Ready to Start?**

1. Open Node-RED: `http://localhost:1880`
2. Import Example 3 (easiest)
3. Click Deploy
4. Watch the magic happen! 🎉

