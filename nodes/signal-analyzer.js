module.exports = function(RED) {
    "use strict";
    
    function SignalAnalyzerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        this.mode = config.mode || "fft"; // fft, vibration, peaks
        this.windowSize = parseInt(config.windowSize) || 256;
        
        // FFT settings
        this.fftSize = parseInt(config.fftSize) || 256;
        this.samplingRate = parseFloat(config.samplingRate) || 1000;
        this.peakThreshold = parseFloat(config.peakThreshold) || 0.1;
        this.outputFormat = config.outputFormat || "peaks";
        this.windowFunction = config.windowFunction || "hann";
        this.overlapPercent = parseInt(config.overlapPercent) || 50;
        
        // Peak detection settings
        this.minPeakHeight = config.minPeakHeight !== "" && config.minPeakHeight !== undefined ? parseFloat(config.minPeakHeight) : null;
        this.minPeakDistance = parseInt(config.minPeakDistance) || 5;
        this.peakType = config.peakType || "both";
        
        // Vibration settings
        this.vibOutputMode = config.vibOutputMode || "all";
        
        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        
        // State
        this.buffer = [];
        this.timestamps = [];
        this.sampleCount = 0;
        this.lastProcessedIndex = 0;
        
        node.status({fill: "blue", shape: "ring", text: node.mode + " mode"});
        
        // Debug logging helper
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        
        // Helper functions
        function calculateMean(data) {
            return data.reduce((a, b) => a + b, 0) / data.length;
        }
        
        function calculateStdDev(data, mean) {
            var variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
            return Math.sqrt(variance);
        }
        
        // Window functions
        function applyWindow(signal, windowType) {
            var n = signal.length;
            var windowed = new Array(n);
            
            for (var i = 0; i < n; i++) {
                var w = 1.0;
                switch (windowType) {
                    case "hann":
                        w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
                        break;
                    case "hamming":
                        w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
                        break;
                    case "blackman":
                        w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
                        break;
                    case "rectangular":
                    default:
                        w = 1.0;
                        break;
                }
                windowed[i] = signal[i] * w;
            }
            return windowed;
        }
        
        // FFT Implementation
        function performFFT(signal, fftSize, samplingRate, windowType) {
            var n = fftSize;
            var paddedSignal = new Array(n);
            
            // Apply window function
            var windowedSignal = applyWindow(signal.slice(0, Math.min(signal.length, n)), windowType || node.windowFunction);
            
            for (var i = 0; i < n; i++) {
                if (i < windowedSignal.length) {
                    paddedSignal[i] = windowedSignal[i];
                } else {
                    paddedSignal[i] = 0;
                }
            }
            
            var real = new Array(n / 2);
            var imag = new Array(n / 2);
            
            for (var k = 0; k < n / 2; k++) {
                var sumReal = 0;
                var sumImag = 0;
                
                for (var t = 0; t < n; t++) {
                    var angle = -2 * Math.PI * k * t / n;
                    sumReal += paddedSignal[t] * Math.cos(angle);
                    sumImag += paddedSignal[t] * Math.sin(angle);
                }
                
                real[k] = sumReal;
                imag[k] = sumImag;
            }
            
            var magnitudes = new Array(n / 2);
            var frequencies = new Array(n / 2);
            
            for (var k = 0; k < n / 2; k++) {
                magnitudes[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) / n;
                frequencies[k] = k * samplingRate / n;
            }
            
            return { frequencies: frequencies, magnitudes: magnitudes };
        }
        
        function findSpectralPeaks(frequencies, magnitudes, threshold) {
            var peaks = [];
            var maxMagnitude = Math.max.apply(null, magnitudes);
            
            for (var i = 1; i < magnitudes.length - 1; i++) {
                if (magnitudes[i] > magnitudes[i-1] && 
                    magnitudes[i] > magnitudes[i+1] &&
                    magnitudes[i] / maxMagnitude > threshold) {
                    peaks.push({
                        frequency: frequencies[i],
                        magnitude: magnitudes[i],
                        normalized: magnitudes[i] / maxMagnitude
                    });
                }
            }
            
            peaks.sort(function(a, b) { return b.magnitude - a.magnitude; });
            return peaks;
        }
        
        function calculateSpectralFeatures(frequencies, magnitudes) {
            var n = magnitudes.length;
            var numerator = 0;
            var denominator = 0;
            
            for (var i = 0; i < n; i++) {
                numerator += frequencies[i] * magnitudes[i];
                denominator += magnitudes[i];
            }
            
            var spectralCentroid = denominator > 0 ? numerator / denominator : 0;
            
            var variance = 0;
            for (var i = 0; i < n; i++) {
                variance += Math.pow(frequencies[i] - spectralCentroid, 2) * magnitudes[i];
            }
            var spectralSpread = denominator > 0 ? Math.sqrt(variance / denominator) : 0;
            
            var sumSquares = magnitudes.reduce(function(sum, m) { return sum + m * m; }, 0);
            var rms = Math.sqrt(sumSquares / n);
            var peak = Math.max.apply(null, magnitudes);
            var crestFactor = rms > 0 ? peak / rms : 0;
            
            return {
                spectralCentroid: spectralCentroid,
                spectralSpread: spectralSpread,
                rms: rms,
                crestFactor: crestFactor,
                totalEnergy: sumSquares
            };
        }
        
        // Vibration Features
        function calculateVibrationFeatures(data) {
            var n = data.length;
            var sumSquares = data.reduce(function(sum, val) { return sum + val * val; }, 0);
            var rms = Math.sqrt(sumSquares / n);
            
            var max = Math.max.apply(null, data);
            var min = Math.min.apply(null, data);
            var peakToPeak = max - min;
            var peak = Math.max(Math.abs(max), Math.abs(min));
            var crestFactor = rms !== 0 ? peak / rms : 0;
            
            var mean = calculateMean(data);
            var stdDev = calculateStdDev(data, mean);
            
            var m4 = data.reduce(function(sum, val) { return sum + Math.pow(val - mean, 4); }, 0) / n;
            var kurtosis = stdDev !== 0 ? (m4 / Math.pow(stdDev, 4)) - 3 : 0;
            
            var m3 = data.reduce(function(sum, val) { return sum + Math.pow(val - mean, 3); }, 0) / n;
            var skewness = stdDev !== 0 ? m3 / Math.pow(stdDev, 3) : 0;
            
            var meanAbs = data.reduce(function(sum, val) { return sum + Math.abs(val); }, 0) / n;
            var formFactor = meanAbs !== 0 ? rms / meanAbs : 0;
            var impulseFactor = meanAbs !== 0 ? peak / meanAbs : 0;
            
            var healthScore = 100;
            if (crestFactor > 5) healthScore -= 20;
            if (Math.abs(kurtosis) > 3) healthScore -= 20;
            if (Math.abs(skewness) > 1) healthScore -= 10;
            healthScore = Math.max(0, Math.min(100, healthScore));
            
            return {
                rms: rms,
                peakToPeak: peakToPeak,
                peak: peak,
                crestFactor: crestFactor,
                kurtosis: kurtosis,
                skewness: skewness,
                mean: mean,
                stdDev: stdDev,
                formFactor: formFactor,
                impulseFactor: impulseFactor,
                healthScore: healthScore
            };
        }
        
        // Peak Detection
        function detectPeaks(data, times, minHeight, minDistance, peakType) {
            var peaks = [];
            var threshold = minHeight;
            
            if (threshold === null) {
                var mean = calculateMean(data);
                var stdDev = calculateStdDev(data, mean);
                threshold = mean + 2 * stdDev;
            }
            
            var lastPeakIndex = -minDistance;
            
            for (var i = 1; i < data.length - 1; i++) {
                var current = data[i];
                var prev = data[i - 1];
                var next = data[i + 1];
                
                var isPeak = false;
                var peakDirection = null;
                
                if ((peakType === "positive" || peakType === "both") &&
                    current > prev && current > next) {
                    if (minHeight === null || current >= threshold) {
                        isPeak = true;
                        peakDirection = "positive";
                    }
                }
                
                if ((peakType === "negative" || peakType === "both") &&
                    current < prev && current < next) {
                    if (minHeight === null || current <= -threshold) {
                        isPeak = true;
                        peakDirection = "negative";
                    }
                }
                
                if (isPeak && (i - lastPeakIndex >= minDistance)) {
                    peaks.push({
                        index: i,
                        value: current,
                        timestamp: times[i],
                        direction: peakDirection
                    });
                    lastPeakIndex = i;
                }
            }
            
            return peaks;
        }
        
        function calculatePeakStatistics(peaks, data) {
            if (peaks.length === 0) {
                return { averagePeakHeight: null, maxPeakHeight: null, minPeakHeight: null, peakFrequency: 0 };
            }
            
            var peakValues = peaks.map(function(p) { return Math.abs(p.value); });
            var sum = peakValues.reduce(function(a, b) { return a + b; }, 0);
            
            return {
                averagePeakHeight: sum / peakValues.length,
                maxPeakHeight: Math.max.apply(null, peakValues),
                minPeakHeight: Math.min.apply(null, peakValues),
                peakFrequency: peaks.length / data.length
            };
        }
        
        // Process FFT
        function processFFT(msg, value) {
            node.buffer.push(value);
            
            if (node.buffer.length < node.fftSize) {
                node.status({fill: "yellow", shape: "ring", text: "Buffering: " + node.buffer.length + "/" + node.fftSize});
                return null;
            }
            
            if (node.buffer.length > node.fftSize) {
                node.buffer.shift();
            }
            
            debugLog("FFT: window=" + node.windowFunction + ", size=" + node.fftSize + ", overlap=" + node.overlapPercent + "%");
            var fftResult = performFFT(node.buffer, node.fftSize, node.samplingRate, node.windowFunction);
            var peaks = findSpectralPeaks(fftResult.frequencies, fftResult.magnitudes, node.peakThreshold);
            var features = calculateSpectralFeatures(fftResult.frequencies, fftResult.magnitudes);
            
            var outputMsg = {
                payload: value,
                peaks: peaks,
                dominantFrequency: peaks.length > 0 ? peaks[0].frequency : null,
                features: features,
                samplingRate: node.samplingRate,
                fftSize: node.fftSize,
                windowFunction: node.windowFunction,
                overlapPercent: node.overlapPercent
            };
            
            // Set topic if configured
            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }
            
            if (node.outputFormat === "full") {
                outputMsg.frequencies = fftResult.frequencies;
                outputMsg.magnitudes = fftResult.magnitudes;
            }
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            var statusText = peaks.length > 0 ? "Peak: " + peaks[0].frequency.toFixed(1) + " Hz" : "No peaks";
            node.status({fill: "green", shape: "dot", text: statusText});
            
            return { normal: outputMsg, anomaly: null };
        }
        
        // Process Vibration
        function processVibration(msg, values) {
            node.buffer.push.apply(node.buffer, values);
            
            if (node.buffer.length > node.windowSize) {
                node.buffer = node.buffer.slice(-node.windowSize);
            }
            
            if (node.buffer.length < Math.min(10, node.windowSize)) {
                node.status({fill: "yellow", shape: "ring", text: "Collecting: " + node.buffer.length + "/" + node.windowSize});
                return null;
            }
            
            var features = calculateVibrationFeatures(node.buffer);
            
            node.status({fill: "green", shape: "dot", text: "RMS: " + features.rms.toFixed(2) + " | CF: " + features.crestFactor.toFixed(2)});
            
            var outputMsg = {
                payload: features,
                topic: msg.topic || "vibration-features",
                timestamp: Date.now(),
                windowSize: node.buffer.length
            };
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            // Check for potential issues
            var hasAnomaly = features.crestFactor > 6 || Math.abs(features.kurtosis) > 4;
            
            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }
        
        // Process Peaks
        function processPeaks(msg, value, timestamp) {
            node.sampleCount++;
            node.buffer.push(value);
            node.timestamps.push(timestamp);
            
            if (node.buffer.length > node.windowSize) {
                node.buffer.shift();
                node.timestamps.shift();
            }
            
            if (node.buffer.length < 3) {
                return null;
            }
            
            var peaks = detectPeaks(node.buffer, node.timestamps, node.minPeakHeight, node.minPeakDistance, node.peakType);
            var stats = calculatePeakStatistics(peaks, node.buffer);
            
            var currentIndex = node.buffer.length - 1;
            var isPeak = peaks.some(function(p) { return p.index === currentIndex; });
            
            var outputMsg = {
                payload: value,
                isPeak: isPeak,
                peaks: peaks,
                peakCount: peaks.length,
                stats: stats,
                sampleCount: node.sampleCount,
                timestamp: timestamp
            };
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            var color = isPeak ? "yellow" : "green";
            node.status({fill: color, shape: isPeak ? "ring" : "dot", text: "Peaks: " + peaks.length});
            
            return { normal: isPeak ? null : outputMsg, anomaly: isPeak ? outputMsg : null };
        }
        
        node.on('input', function(msg) {
            try {
                if (msg.reset === true) {
                    node.buffer = [];
                    node.timestamps = [];
                    node.sampleCount = 0;
                    node.status({fill: "blue", shape: "ring", text: node.mode + " - reset"});
                    return;
                }
                
                var result = null;
                
                if (node.mode === "fft") {
                    var value = parseFloat(msg.payload);
                    if (isNaN(value)) {
                        node.warn("Invalid payload: not a number");
                        return;
                    }
                    result = processFFT(msg, value);
                    
                } else if (node.mode === "vibration") {
                    var values = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
                    values = values.filter(function(v) { return typeof v === 'number' && !isNaN(v); });
                    if (values.length === 0) {
                        node.warn("No valid numeric values found");
                        return;
                    }
                    result = processVibration(msg, values);
                    
                } else if (node.mode === "peaks") {
                    var value = parseFloat(msg.payload);
                    var timestamp = msg.timestamp || Date.now();
                    if (isNaN(value)) {
                        node.warn("Invalid payload: not a number");
                        return;
                    }
                    result = processPeaks(msg, value, timestamp);
                }
                
                if (result) {
                    if (result.anomaly) {
                        node.send([null, result.anomaly]);
                    } else if (result.normal) {
                        node.send([result.normal, null]);
                    }
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Error in signal analysis: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.buffer = [];
            node.timestamps = [];
            node.sampleCount = 0;
            node.status({});
        });
    }
    
    RED.nodes.registerType("signal-analyzer", SignalAnalyzerNode);
};
