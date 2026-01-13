module.exports = function(RED) {
    "use strict";
    
    // Load high-performance FFT library (Radix-4 Cooley-Tukey algorithm)
    var FFT = null;
    try {
        FFT = require('fft.js');
    } catch (err) {
        // Fallback to naive implementation if fft.js not available
    }
    
    // Import state persistence
    var StatePersistence = null;
    try {
        StatePersistence = require('./state-persistence');
    } catch (err) {
        // State persistence not available
    }
    
    function SignalAnalyzerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // FFT instance cache for performance
        this.fftInstances = {};
        
        // Configuration
        this.mode = config.mode || "fft"; // fft, vibration, peaks, envelope, cepstrum
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
        
        // Envelope analysis settings (bearing fault detection)
        this.envelopeBandLow = parseFloat(config.envelopeBandLow) || 500;  // Hz
        this.envelopeBandHigh = parseFloat(config.envelopeBandHigh) || 5000; // Hz
        this.bearingBPFO = parseFloat(config.bearingBPFO) || 0;  // Ball Pass Freq Outer
        this.bearingBPFI = parseFloat(config.bearingBPFI) || 0;  // Ball Pass Freq Inner
        this.bearingBSF = parseFloat(config.bearingBSF) || 0;   // Ball Spin Freq
        this.bearingFTF = parseFloat(config.bearingFTF) || 0;   // Fundamental Train Freq
        this.shaftSpeed = parseFloat(config.shaftSpeed) || 0;   // RPM
        
        // Cepstrum analysis settings
        this.quefrencyRangeLow = parseFloat(config.quefrencyRangeLow) || 0.001;  // seconds
        this.quefrencyRangeHigh = parseFloat(config.quefrencyRangeHigh) || 0.1;  // seconds
        this.cepstrumThreshold = parseFloat(config.cepstrumThreshold) || 0.1;
        // Parse gear tooth count from comma-separated string
        this.gearTeeth = [];
        if (config.gearToothCount && config.gearToothCount.trim() !== "") {
            this.gearTeeth = config.gearToothCount.split(',').map(function(s) {
                return parseInt(s.trim());
            }).filter(function(n) {
                return !isNaN(n) && n > 0;
            });
        }
        
        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        this.persistState = config.persistState === true;
        
        // State
        this.buffer = [];
        this.timestamps = [];
        this.sampleCount = 0;
        this.lastProcessedIndex = 0;
        
        // State persistence manager
        this.stateManager = null;
        
        // Helper to persist current state
        function persistCurrentState() {
            if (node.stateManager && node.buffer.length > 0) {
                node.stateManager.setMultiple({
                    buffer: node.buffer,
                    timestamps: node.timestamps,
                    sampleCount: node.sampleCount,
                    lastProcessedIndex: node.lastProcessedIndex
                });
            }
        }
        
        // Initialize state persistence if enabled
        if (node.persistState && StatePersistence) {
            node.stateManager = new StatePersistence.NodeStateManager(node, {
                stateKey: 'signalAnalyzerState',
                saveInterval: 30000 // Save every 30 seconds
            });
            
            // Load persisted state on startup
            node.stateManager.load().then(function(state) {
                if (state.buffer && state.buffer.length > 0) {
                    node.buffer = state.buffer;
                    node.timestamps = state.timestamps || [];
                    node.sampleCount = state.sampleCount || 0;
                    node.lastProcessedIndex = state.lastProcessedIndex || 0;
                    
                    node.status({fill: "green", shape: "dot", text: node.mode + " - restored (" + node.buffer.length + " samples)"});
                    node.debug && node.warn("[DEBUG] Restored signal buffer from persistence: " + node.buffer.length + " samples");
                }
            }).catch(function(err) {
                node.debug && node.warn("[DEBUG] Failed to load persisted state: " + err.message);
            });
        }
        
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
        
        // FFT Implementation - uses fft.js (Radix-4 Cooley-Tukey) when available
        // Performance: O(n log n) vs O(n²) for naive DFT
        function performFFT(signal, fftSize, samplingRate, windowType) {
            var n = fftSize;
            
            // Ensure n is power of 2 (required by fft.js)
            if ((n & (n - 1)) !== 0) {
                // Find next power of 2
                n = Math.pow(2, Math.ceil(Math.log2(n)));
            }
            
            // Apply window function
            var windowedSignal = applyWindow(signal.slice(0, Math.min(signal.length, n)), windowType || node.windowFunction);
            
            // Pad to FFT size
            var paddedSignal = new Array(n);
            for (var i = 0; i < n; i++) {
                paddedSignal[i] = i < windowedSignal.length ? windowedSignal[i] : 0;
            }
            
            var magnitudes, frequencies;
            
            if (FFT) {
                // Use high-performance fft.js library (Radix-4 algorithm)
                // Cache FFT instances for different sizes
                if (!node.fftInstances[n]) {
                    node.fftInstances[n] = new FFT(n);
                }
                var fft = node.fftInstances[n];
                
                // fft.js requires interleaved complex format [re0, im0, re1, im1, ...]
                var complexInput = fft.toComplexArray(paddedSignal, null);
                var complexOutput = fft.createComplexArray();
                
                // Perform FFT
                fft.realTransform(complexOutput, paddedSignal);
                fft.completeSpectrum(complexOutput);
                
                // Extract magnitudes (only positive frequencies: 0 to n/2)
                magnitudes = new Array(n / 2);
                frequencies = new Array(n / 2);
                
                for (var k = 0; k < n / 2; k++) {
                    var re = complexOutput[2 * k];
                    var im = complexOutput[2 * k + 1];
                    magnitudes[k] = Math.sqrt(re * re + im * im) / n;
                    frequencies[k] = k * samplingRate / n;
                }
            } else {
                // Fallback to naive DFT (O(n²) - slow for large signals)
                debugLog("Using fallback DFT - install fft.js for better performance");
                
                magnitudes = new Array(n / 2);
                frequencies = new Array(n / 2);
                
                for (var k = 0; k < n / 2; k++) {
                    var sumReal = 0;
                    var sumImag = 0;
                    
                    for (var t = 0; t < n; t++) {
                        var angle = -2 * Math.PI * k * t / n;
                        sumReal += paddedSignal[t] * Math.cos(angle);
                        sumImag += paddedSignal[t] * Math.sin(angle);
                    }
                    
                    magnitudes[k] = Math.sqrt(sumReal * sumReal + sumImag * sumImag) / n;
                    frequencies[k] = k * samplingRate / n;
                }
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
            
            // Calculate Sample Entropy
            var sampleEntropy = calculateSampleEntropy(data, 2, 0.2 * stdDev);
            
            // Calculate Autocorrelation (first 10 lags)
            var autocorrelation = calculateAutocorrelation(data, 10);
            
            // Detect periodicity from autocorrelation peaks
            var periodicity = detectPeriodicity(autocorrelation);
            
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
                sampleEntropy: sampleEntropy,
                autocorrelation: autocorrelation,
                periodicity: periodicity,
                healthScore: healthScore
            };
        }
        
        // Sample Entropy - measures signal complexity/regularity
        // Lower values = more regular/predictable, Higher = more complex/random
        function calculateSampleEntropy(data, m, r) {
            var n = data.length;
            if (n < m + 1) return 0;
            
            // Count template matches for length m and m+1
            function countMatches(templateLength) {
                var count = 0;
                for (var i = 0; i < n - templateLength; i++) {
                    for (var j = i + 1; j < n - templateLength; j++) {
                        var match = true;
                        for (var k = 0; k < templateLength; k++) {
                            if (Math.abs(data[i + k] - data[j + k]) > r) {
                                match = false;
                                break;
                            }
                        }
                        if (match) count++;
                    }
                }
                return count;
            }
            
            var A = countMatches(m + 1);
            var B = countMatches(m);
            
            if (B === 0 || A === 0) return 0;
            return -Math.log(A / B);
        }
        
        // Autocorrelation Function (ACF) - detects periodicity
        function calculateAutocorrelation(data, maxLag) {
            var n = data.length;
            var mean = data.reduce(function(a, b) { return a + b; }, 0) / n;
            var variance = data.reduce(function(sum, val) { 
                return sum + (val - mean) * (val - mean); 
            }, 0) / n;
            
            if (variance === 0) return [];
            
            var acf = [];
            for (var lag = 0; lag <= Math.min(maxLag, n - 1); lag++) {
                var sum = 0;
                for (var i = 0; i < n - lag; i++) {
                    sum += (data[i] - mean) * (data[i + lag] - mean);
                }
                acf.push({
                    lag: lag,
                    value: sum / (n * variance)
                });
            }
            return acf;
        }
        
        // Detect periodicity from ACF peaks
        function detectPeriodicity(acf) {
            if (acf.length < 3) return { detected: false };
            
            // Find first significant peak after lag 0
            var peaks = [];
            for (var i = 2; i < acf.length - 1; i++) {
                if (acf[i].value > acf[i-1].value && 
                    acf[i].value > acf[i+1].value &&
                    acf[i].value > 0.3) { // Threshold for significance
                    peaks.push({ lag: acf[i].lag, strength: acf[i].value });
                }
            }
            
            if (peaks.length === 0) {
                return { detected: false, description: "No periodicity detected" };
            }
            
            return {
                detected: true,
                period: peaks[0].lag,
                strength: peaks[0].strength,
                allPeaks: peaks,
                description: "Periodic pattern detected at lag " + peaks[0].lag
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
        
        // Envelope Analysis for Bearing Fault Detection
        function performEnvelopeAnalysis(signal, samplingRate, bandLow, bandHigh) {
            var n = signal.length;
            
            // Step 1: Bandpass filter (simple FIR implementation)
            var filtered = bandpassFilter(signal, samplingRate, bandLow, bandHigh);
            
            // Step 2: Rectify (absolute value)
            var rectified = filtered.map(function(v) { return Math.abs(v); });
            
            // Step 3: Low-pass filter to get envelope (simple moving average)
            var envelopeWindowSize = Math.max(3, Math.floor(samplingRate / bandLow / 2));
            var envelope = [];
            for (var i = 0; i < rectified.length; i++) {
                var start = Math.max(0, i - Math.floor(envelopeWindowSize / 2));
                var end = Math.min(rectified.length, i + Math.floor(envelopeWindowSize / 2) + 1);
                var sum = 0;
                for (var j = start; j < end; j++) {
                    sum += rectified[j];
                }
                envelope.push(sum / (end - start));
            }
            
            return envelope;
        }
        
        // Simple bandpass filter using moving average difference
        function bandpassFilter(signal, samplingRate, lowCut, highCut) {
            var n = signal.length;
            
            // High-pass: subtract low-frequency component
            var lowWindow = Math.max(3, Math.floor(samplingRate / lowCut));
            var highFiltered = [];
            for (var i = 0; i < n; i++) {
                var start = Math.max(0, i - Math.floor(lowWindow / 2));
                var end = Math.min(n, i + Math.floor(lowWindow / 2) + 1);
                var sum = 0;
                for (var j = start; j < end; j++) {
                    sum += signal[j];
                }
                var lowFreq = sum / (end - start);
                highFiltered.push(signal[i] - lowFreq);
            }
            
            // Low-pass: smooth high frequencies
            var highWindow = Math.max(3, Math.floor(samplingRate / highCut));
            var bandpassed = [];
            for (var i = 0; i < n; i++) {
                var start = Math.max(0, i - Math.floor(highWindow / 2));
                var end = Math.min(n, i + Math.floor(highWindow / 2) + 1);
                var sum = 0;
                for (var j = start; j < end; j++) {
                    sum += highFiltered[j];
                }
                bandpassed.push(sum / (end - start));
            }
            
            return bandpassed;
        }
        
        // Detect bearing fault frequencies in envelope spectrum
        function detectBearingFaults(envelopePeaks, shaftFreq, bpfo, bpfi, bsf, ftf, tolerance) {
            tolerance = tolerance || 0.05; // 5% frequency tolerance
            var faults = [];
            
            var faultFreqs = [
                { name: 'BPFO', freq: bpfo, desc: 'Outer Race Fault' },
                { name: 'BPFI', freq: bpfi, desc: 'Inner Race Fault' },
                { name: 'BSF', freq: bsf, desc: 'Ball/Roller Fault' },
                { name: 'FTF', freq: ftf, desc: 'Cage Fault' },
                { name: '1X', freq: shaftFreq, desc: 'Shaft Imbalance' },
                { name: '2X', freq: shaftFreq * 2, desc: 'Misalignment' }
            ];
            
            envelopePeaks.forEach(function(peak) {
                faultFreqs.forEach(function(fault) {
                    if (fault.freq > 0) {
                        // Check fundamental and harmonics (up to 3x)
                        for (var harmonic = 1; harmonic <= 3; harmonic++) {
                            var targetFreq = fault.freq * harmonic;
                            var freqDiff = Math.abs(peak.frequency - targetFreq) / targetFreq;
                            
                            if (freqDiff <= tolerance) {
                                faults.push({
                                    type: fault.name,
                                    harmonic: harmonic,
                                    description: fault.desc,
                                    expectedFreq: targetFreq,
                                    detectedFreq: peak.frequency,
                                    magnitude: peak.magnitude,
                                    severity: peak.magnitude > 0.5 ? 'high' : (peak.magnitude > 0.2 ? 'medium' : 'low')
                                });
                            }
                        }
                    }
                });
            });
            
            return faults;
        }
        
        // Cepstrum Analysis for gearbox diagnostics
        function performCepstrum(signal, fftSize, samplingRate) {
            // Step 1: FFT of signal
            var fftResult = performFFT(signal, fftSize, samplingRate, 'hann');
            
            // Step 2: Log of magnitude spectrum
            var logSpectrum = fftResult.magnitudes.map(function(m) {
                return Math.log(Math.max(m, 1e-10)); // Avoid log(0)
            });
            
            // Step 3: Inverse FFT of log spectrum (approximation using DCT-like approach)
            var n = logSpectrum.length;
            var cepstrum = new Array(n);
            
            for (var q = 0; q < n; q++) {
                var sum = 0;
                for (var k = 0; k < n; k++) {
                    sum += logSpectrum[k] * Math.cos(2 * Math.PI * q * k / n);
                }
                cepstrum[q] = sum / n;
            }
            
            // Quefrencies (time-like domain)
            var quefrencies = new Array(n);
            for (var i = 0; i < n; i++) {
                quefrencies[i] = i / samplingRate; // in seconds
            }
            
            return { quefrencies: quefrencies, cepstrum: cepstrum };
        }
        
        // Find rahmonics (peaks in cepstrum)
        function findRahmonics(quefrencies, cepstrum, minQuefrency, maxQuefrency, peakThreshold) {
            var peaks = [];
            peakThreshold = peakThreshold || 0.1; // Default 10%
            
            // Skip the first few samples (aperiodic component)
            var startIdx = 5;
            var maxCepstrum = Math.max.apply(null, cepstrum.slice(startIdx).map(Math.abs));
            
            for (var i = startIdx + 1; i < cepstrum.length - 1; i++) {
                if (quefrencies[i] < minQuefrency || quefrencies[i] > maxQuefrency) continue;
                
                var current = Math.abs(cepstrum[i]);
                if (current > Math.abs(cepstrum[i-1]) && current > Math.abs(cepstrum[i+1])) {
                    var normalized = current / maxCepstrum;
                    if (normalized > peakThreshold) {
                        peaks.push({
                            quefrency: quefrencies[i],
                            fundamentalFrequency: 1 / quefrencies[i], // Hz
                            magnitude: cepstrum[i],
                            normalized: normalized
                        });
                    }
                }
            }
            
            peaks.sort(function(a, b) { return Math.abs(b.magnitude) - Math.abs(a.magnitude); });
            return peaks;
        }
        
        // Detect gear mesh frequencies and faults
        function detectGearFaults(rahmonics, shaftSpeed, gearTeeth) {
            var faults = [];
            var shaftFreq = shaftSpeed / 60;
            
            if (gearTeeth && gearTeeth.length > 0) {
                gearTeeth.forEach(function(teeth, idx) {
                    var gmf = shaftFreq * teeth; // Gear Mesh Frequency
                    var tolerance = 0.1; // 10%
                    
                    rahmonics.forEach(function(peak) {
                        var freqDiff = Math.abs(peak.fundamentalFrequency - gmf) / gmf;
                        if (freqDiff < tolerance) {
                            faults.push({
                                type: 'GMF',
                                gear: idx + 1,
                                teeth: teeth,
                                expectedFreq: gmf,
                                detectedFreq: peak.fundamentalFrequency,
                                magnitude: peak.normalized,
                                severity: peak.normalized > 0.5 ? 'high' : (peak.normalized > 0.25 ? 'medium' : 'low'),
                                description: 'Gear mesh frequency detected - possible gear wear'
                            });
                        }
                        
                        // Check sidebands (gear damage indicator)
                        for (var sb = 1; sb <= 3; sb++) {
                            var sideband = gmf + sb * shaftFreq;
                            freqDiff = Math.abs(peak.fundamentalFrequency - sideband) / sideband;
                            if (freqDiff < tolerance) {
                                faults.push({
                                    type: 'Sideband',
                                    gear: idx + 1,
                                    order: sb,
                                    expectedFreq: sideband,
                                    detectedFreq: peak.fundamentalFrequency,
                                    magnitude: peak.normalized,
                                    severity: peak.normalized > 0.3 ? 'high' : 'medium',
                                    description: 'Sideband detected - indicates gear damage or eccentricity'
                                });
                            }
                        }
                    });
                });
            }
            
            return faults;
        }
        
        // Process Cepstrum Analysis
        function processCepstrum(msg, value) {
            node.buffer.push(value);
            
            if (node.buffer.length < node.fftSize) {
                node.status({fill: "yellow", shape: "ring", text: "Cepstrum: " + node.buffer.length + "/" + node.fftSize});
                return null;
            }
            
            if (node.buffer.length > node.fftSize) {
                node.buffer.shift();
            }
            
            var shaftFreq = (node.shaftSpeed || 1800) / 60;
            var minQuefrency = node.quefrencyRangeLow || 0.001;
            var maxQuefrency = node.quefrencyRangeHigh || 0.1;
            
            // Perform cepstrum analysis
            var cepResult = performCepstrum(node.buffer, node.fftSize, node.samplingRate);
            
            // Find rahmonics (periodic components)
            var rahmonics = findRahmonics(cepResult.quefrencies, cepResult.cepstrum, minQuefrency, maxQuefrency, node.cepstrumThreshold);
            
            // Detect gear faults if teeth count provided
            var gearTeeth = msg.gearTeeth || node.gearTeeth || [];
            var gearFaults = detectGearFaults(rahmonics, node.shaftSpeed || 1800, gearTeeth);
            
            var hasAnomaly = gearFaults.length > 0;
            
            var outputMsg = {
                payload: value,
                cepstrum: {
                    rahmonics: rahmonics.slice(0, 10),
                    dominantQuefrency: rahmonics.length > 0 ? rahmonics[0].quefrency : null,
                    dominantFrequency: rahmonics.length > 0 ? rahmonics[0].fundamentalFrequency : null
                },
                gearFaults: gearFaults,
                shaftFrequency: shaftFreq,
                hasFault: hasAnomaly,
                faultCount: gearFaults.length,
                timestamp: Date.now()
            };
            
            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            var statusText = hasAnomaly 
                ? "FAULT: " + gearFaults[0].type
                : (rahmonics.length > 0 ? "Peak: " + rahmonics[0].fundamentalFrequency.toFixed(1) + " Hz" : "No peaks");
            var statusColor = hasAnomaly ? "red" : "green";
            node.status({fill: statusColor, shape: hasAnomaly ? "ring" : "dot", text: statusText});
            
            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }
        
        // Process Envelope Analysis
        function processEnvelope(msg, value) {
            node.buffer.push(value);
            
            if (node.buffer.length < node.fftSize) {
                node.status({fill: "yellow", shape: "ring", text: "Envelope: " + node.buffer.length + "/" + node.fftSize});
                return null;
            }
            
            if (node.buffer.length > node.fftSize) {
                node.buffer.shift();
            }
            
            // Calculate shaft frequency from RPM
            var shaftFreq = node.shaftSpeed / 60;
            
            // Perform envelope analysis
            var envelope = performEnvelopeAnalysis(
                node.buffer, 
                node.samplingRate, 
                node.envelopeBandLow, 
                node.envelopeBandHigh
            );
            
            // FFT of envelope
            var envelopeFFT = performFFT(envelope, node.fftSize, node.samplingRate, 'hann');
            var envelopePeaks = findSpectralPeaks(envelopeFFT.frequencies, envelopeFFT.magnitudes, 0.05);
            
            // Detect bearing faults
            var faults = detectBearingFaults(
                envelopePeaks,
                shaftFreq,
                node.bearingBPFO,
                node.bearingBPFI,
                node.bearingBSF,
                node.bearingFTF
            );
            
            var hasAnomaly = faults.length > 0;
            
            var outputMsg = {
                payload: value,
                envelope: {
                    peaks: envelopePeaks.slice(0, 10),
                    bandLow: node.envelopeBandLow,
                    bandHigh: node.envelopeBandHigh
                },
                bearingFaults: faults,
                shaftFrequency: shaftFreq,
                bearingFreqs: {
                    BPFO: node.bearingBPFO,
                    BPFI: node.bearingBPFI,
                    BSF: node.bearingBSF,
                    FTF: node.bearingFTF
                },
                hasFault: hasAnomaly,
                faultCount: faults.length,
                timestamp: Date.now()
            };
            
            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }
            
            Object.keys(msg).forEach(function(key) {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            var statusText = hasAnomaly 
                ? "FAULT: " + faults[0].type + " " + faults[0].harmonic + "X"
                : "No faults detected";
            var statusColor = hasAnomaly ? "red" : "green";
            node.status({fill: statusColor, shape: hasAnomaly ? "ring" : "dot", text: statusText});
            
            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
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
                    
                } else if (node.mode === "envelope") {
                    var value = parseFloat(msg.payload);
                    if (isNaN(value)) {
                        node.warn("Invalid payload: not a number");
                        return;
                    }
                    result = processEnvelope(msg, value);
                } else if (node.mode === "cepstrum") {
                    var value = parseFloat(msg.payload);
                    if (isNaN(value)) {
                        node.warn("Invalid payload: not a number");
                        return;
                    }
                    result = processCepstrum(msg, value);
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
        
        node.on('close', async function(done) {
            // Save state before closing if persistence enabled
            if (node.stateManager) {
                try {
                    persistCurrentState();
                    await node.stateManager.close();
                } catch (err) {
                    // Ignore persistence errors during shutdown
                }
            }
            
            node.buffer = [];
            node.timestamps = [];
            node.sampleCount = 0;
            node.fftInstances = {}; // Clear FFT instance cache
            node.status({});
            
            if (done) done();
        });
    }
    
    RED.nodes.registerType("signal-analyzer", SignalAnalyzerNode);
    
    // API endpoint to check FFT library availability
    RED.httpAdmin.get('/signal-analyzer/fft-status', function(req, res) {
        res.json({ 
            available: FFT !== null,
            library: FFT ? 'fft.js (Radix-4)' : 'fallback DFT',
            performance: FFT ? 'O(n log n)' : 'O(n²)'
        });
    });
};
