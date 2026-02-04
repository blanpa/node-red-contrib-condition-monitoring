# Troubleshooting Guide

This guide helps diagnose and resolve common issues with the condition monitoring package.

## Table of Contents

- [Installation Issues](#installation-issues)
- [Node Startup Problems](#node-startup-problems)
- [Anomaly Detection Issues](#anomaly-detection-issues)
- [ML Inference Problems](#ml-inference-problems)
- [Python Bridge Issues](#python-bridge-issues)
- [MAX Engine Issues](#max-engine-issues)
- [Performance Problems](#performance-problems)
- [Docker Issues](#docker-issues)
- [Debug Mode](#debug-mode)

---

## Installation Issues

### Problem: npm install fails with native module errors

**Symptoms:**
```
Error: Could not find any Python installation to use
gyp ERR! build error
```

**Solutions:**

1. **Install build tools:**
   ```bash
   # Ubuntu/Debian
   sudo apt-get install build-essential python3

   # macOS
   xcode-select --install

   # Windows
   npm install --global windows-build-tools
   ```

2. **Skip optional dependencies:**
   ```bash
   npm install --ignore-optional
   ```
   This skips `@tensorflow/tfjs-node` and `onnxruntime-node` which require native compilation.

3. **Use Docker** (recommended for production):
   ```bash
   docker-compose up -d
   ```

### Problem: tfjs-node or onnxruntime-node fails to install

**Solution:** These are optional dependencies. The package works without them:
- Without `onnxruntime-node`: Use Python bridge for ONNX models
- Without `tfjs-node`: Use TFLite via Python bridge

To force skip:
```bash
npm install --ignore-optional
```

---

## Node Startup Problems

### Problem: Node shows "error" status immediately

**Possible causes:**
1. Missing dependencies
2. Configuration error
3. Invalid model path

**Debug steps:**
1. Enable debug mode in node configuration
2. Check Node-RED debug panel for error messages
3. Check Node-RED logs: `~/.node-red/node-red.log`

### Problem: "Module not found" error

**Symptoms:**
```
Error: Cannot find module 'fft.js'
```

**Solution:**
```bash
cd ~/.node-red
npm install node-red-contrib-condition-monitoring --save
```

Or manually install missing dependency:
```bash
npm install fft.js
```

---

## Anomaly Detection Issues

### Problem: Too many false positives

**Causes and solutions:**

1. **Window size too small:**
   - Increase `windowSize` to capture more normal variation
   - Recommended: 100-500 for stable signals

2. **Threshold too sensitive:**
   - Z-Score: Increase threshold (try 3.0 or 3.5)
   - IQR: Increase multiplier (try 2.0 or 2.5)

3. **Hysteresis not enabled:**
   - Enable hysteresis to prevent alarm flickering
   - Set `consecutiveCount` to 2-5

4. **Signal has natural spikes:**
   - Use IQR method (more robust to outliers)
   - Or use percentile method with wider bounds

### Problem: Anomalies not detected

**Causes and solutions:**

1. **Threshold too high:**
   - Lower the threshold value
   - Z-Score: Try 2.0-2.5
   - IQR: Try 1.2-1.5

2. **Buffer in warmup state:**
   - Wait for buffer to fill (check `bufferSize` in output)
   - IQR needs at least 4 samples
   - Other methods need at least 2

3. **Wrong method for data type:**
   - For bounded data: Use threshold method
   - For normally distributed: Use Z-Score
   - For skewed data: Use IQR or percentile

### Problem: "warmup" status never changes

**Cause:** Not receiving enough messages

**Solutions:**
1. Verify data is flowing to the node
2. Check if input is valid number (`parseFloat(msg.payload)`)
3. Reduce window size temporarily for testing

### Problem: Hysteresis keeps alarm active too long

**Solution:** Adjust hysteresis parameters:
```javascript
// In node config or msg.config
{
  hysteresisEnabled: true,
  consecutiveCount: 2,        // Lower = faster trigger
  hysteresisPercent: 5        // Lower = faster clear
}
```

---

## ML Inference Problems

### Problem: "Model not loaded" error

**Solutions:**

1. **Check model path:**
   ```javascript
   // Absolute path recommended
   msg.loadModel = {
     path: "/data/models/my-model.onnx",
     id: "my-model"
   };
   ```

2. **Verify model exists:**
   ```bash
   ls -la /path/to/model.onnx
   ```

3. **Check file permissions:**
   ```bash
   chmod 644 /path/to/model.onnx
   ```

### Problem: "Invalid input shape" error

**Cause:** Input data doesn't match model's expected shape

**Debug:**
1. Check model's expected input shape in output message
2. Verify your input data dimensions

**Example fix:**
```javascript
// If model expects [1, 10] shape
msg.payload = [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]];
// NOT: msg.payload = [0.1, 0.2, ...]  (missing batch dimension)
```

### Problem: Slow inference performance

**Solutions:**

1. **Use persistent models:**
   - Load model once at startup
   - Reuse for multiple inferences

2. **Use MAX Engine for ONNX:**
   - Configure MAX Engine server
   - Set runtime to "max" in node config

3. **Use batch inference:**
   - Collect multiple samples
   - Send as batch array

4. **Check model size:**
   - Large models need more memory
   - Consider quantized models (TFLite)

---

## Python Bridge Issues

### Problem: "Python bridge not ready"

**Debug steps:**

1. **Check Python is installed:**
   ```bash
   python3 --version
   # or
   python --version
   ```

2. **Check required packages:**
   ```bash
   python3 -c "import numpy; import tensorflow; import sklearn"
   ```

3. **Install missing packages:**
   ```bash
   pip3 install numpy tensorflow scikit-learn tflite-runtime
   ```

4. **Check bridge script exists:**
   ```bash
   ls ~/.node-red/node_modules/node-red-contrib-condition-monitoring/nodes/python_bridge.py
   ```

### Problem: Python bridge crashes repeatedly

**Symptoms:**
- "Python bridge exited with code 1"
- Repeated restart attempts

**Solutions:**

1. **Check Python errors:**
   - Enable debug mode
   - Check stderr output in Node-RED logs

2. **Memory issues:**
   - Large models may exhaust memory
   - Check system memory usage
   - Reduce model size or use TFLite

3. **Package conflicts:**
   ```bash
   # Create clean virtual environment
   python3 -m venv ~/node-red-venv
   source ~/node-red-venv/bin/activate
   pip install numpy tensorflow scikit-learn
   ```

### Problem: Slow Python inference

**Solutions:**

1. **Ensure bridge is persistent:**
   - Bridge should start once and stay running
   - Check that models are cached (not reloaded per request)

2. **Use TFLite for faster inference:**
   - Convert Keras models to TFLite
   - Especially effective on edge devices

3. **Pre-warm models:**
   - Send a test inference at startup
   - This loads model into memory

---

## MAX Engine Issues

### Problem: Cannot connect to MAX Engine

**Symptoms:**
```
Error: connect ECONNREFUSED 127.0.0.1:8765
```

**Solutions:**

1. **Check server is running:**
   ```bash
   docker ps | grep max
   curl http://localhost:8765/health
   ```

2. **Start MAX Engine:**
   ```bash
   docker-compose -f docker-compose.dev.yml up -d max-engine
   ```

3. **Check environment variable:**
   ```bash
   export MAX_ENGINE_URL=http://localhost:8765
   ```

### Problem: Model loads but inference fails

**Debug:**
1. Check model compatibility (ONNX opset version)
2. Verify input shape matches model
3. Check MAX Engine logs:
   ```bash
   docker logs nodered-max-engine
   ```

### Problem: MAX Engine uses fallback ONNX runtime

**Cause:** MAX Engine not available, falling back to standard ONNX

**Solutions:**
1. Verify MAX Engine is properly installed in container
2. Check for GPU support if required
3. This may be acceptable - fallback still works

---

## Performance Problems

### Problem: High memory usage

**Solutions:**

1. **Reduce window sizes:**
   - Smaller buffers use less memory
   - Balance with detection accuracy

2. **Limit loaded models:**
   - Unload unused models
   - Use `msg.unloadModel = "model-id"`

3. **Disable state persistence:**
   - In-memory only (no disk persistence)
   - Data lost on restart

4. **Use circular buffers:**
   - Already implemented in nodes
   - Ensure windowSize is reasonable

### Problem: High CPU usage

**Causes:**
1. Too frequent messages (> 100/second per node)
2. Large FFT window sizes
3. Complex ML models

**Solutions:**
1. Add throttle node before processing
2. Reduce FFT window size (512 or 1024)
3. Use lighter models or batch processing

### Problem: Slow FFT processing

**Solutions:**

1. **Use power-of-2 window sizes:**
   - 256, 512, 1024, 2048
   - Non-power-of-2 falls back to slower algorithm

2. **Reduce window size if acceptable:**
   - 512 points is often sufficient
   - 2048+ only for high-resolution analysis

---

## Docker Issues

### Problem: Container won't start

**Debug:**
```bash
docker-compose logs nodered
docker-compose logs max-engine
```

### Problem: Models not found in container

**Cause:** Volume mount issue

**Solution:** Check docker-compose.yml:
```yaml
volumes:
  - ./models:/data/models:ro
```

### Problem: Node-RED can't reach MAX Engine

**Cause:** Network configuration

**Solution:** Use container name as hostname:
```javascript
// In node config or environment
MAX_ENGINE_URL=http://max-engine:8765
```

---

## Debug Mode

Enable debug mode for detailed logging:

### In Node Configuration

1. Open node settings
2. Enable "Debug" checkbox
3. Deploy

### Via msg.config

```javascript
msg.config = {
  debug: true
};
```

### What Debug Mode Shows

- Buffer sizes and content samples
- Detection thresholds and results
- Hysteresis state changes
- Model loading progress
- Inference timing

### Reading Debug Output

Debug messages appear:
1. In Node-RED debug panel (if using debug node)
2. In Node-RED console/logs
3. With prefix `[DEBUG]`

Example:
```
[DEBUG] zscore: value=25.5, rawAnomaly=true, finalAnomaly=false, hysteresis=true
[DEBUG] consec_anom=2, consec_norm=0, threshold=3
```

---

## Getting Help

If issues persist:

1. **Check existing issues:**
   https://github.com/blanpa/node-red-contrib-condition-monitoring/issues

2. **Create new issue with:**
   - Node-RED version
   - Node.js version
   - Package version
   - Error messages (full stack trace)
   - Node configuration
   - Sample input data

3. **Enable debug mode** and include relevant debug output

4. **Minimal reproduction:**
   - Create simple flow that reproduces issue
   - Export and attach flow JSON
