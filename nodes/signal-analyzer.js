module.exports = function (RED) {
    "use strict";

    // Import shared statistics utilities
    const stats = require("./utils/statistics");

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");

    // Config validation: parse + range-clamp (0 stays 0 where it is valid)
    const { clampInt, clampFloat } = require("./utils/config-validator");

    // Load high-performance FFT library (Radix-4 Cooley-Tukey algorithm)
    let FFT = null;
    try {
        FFT = require("fft.js");
    } catch (err) {
        // Fallback to naive implementation if fft.js not available
    }

    function SignalAnalyzerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // FFT instance cache for performance
        this.fftInstances = {};

        // Configuration
        this.mode = config.mode || "fft"; // fft, vibration, peaks, envelope, cepstrum
        this.windowSize = clampInt(config.windowSize, 2, 1048576, 256);

        // FFT settings
        this.fftSize = clampInt(config.fftSize, 2, 1048576, 256);
        this.samplingRate = clampFloat(config.samplingRate, 0.001, 1e9, 1000);
        this.peakThreshold = clampFloat(config.peakThreshold, 0, 1e12, 0.1);
        this.outputFormat = config.outputFormat || "peaks";
        this.windowFunction = config.windowFunction || "hann";
        this.overlapPercent = clampInt(config.overlapPercent, 0, 99, 50);

        // Peak detection settings
        this.minPeakHeight =
            config.minPeakHeight !== "" && config.minPeakHeight !== undefined ? parseFloat(config.minPeakHeight) : null;
        this.minPeakDistance = clampInt(config.minPeakDistance, 0, 1000000, 5);
        this.peakType = config.peakType || "both";

        // Vibration settings
        this.vibOutputMode = config.vibOutputMode || "all";
        this.vibInputUnit = config.vibInputUnit || "mm_s"; // Input data unit for ISO 10816
        this.iso10816Class = config.iso10816Class || "class2"; // ISO 10816 machine class

        // Envelope analysis settings (bearing fault detection)
        this.envelopeBandLow = clampFloat(config.envelopeBandLow, 0, 1e9, 500); // Hz
        this.envelopeBandHigh = clampFloat(config.envelopeBandHigh, 0, 1e9, 5000); // Hz
        this.bearingBPFO = clampFloat(config.bearingBPFO, 0, 1e9, 0); // Ball Pass Freq Outer
        this.bearingBPFI = clampFloat(config.bearingBPFI, 0, 1e9, 0); // Ball Pass Freq Inner
        this.bearingBSF = clampFloat(config.bearingBSF, 0, 1e9, 0); // Ball Spin Freq
        this.bearingFTF = clampFloat(config.bearingFTF, 0, 1e9, 0); // Fundamental Train Freq
        this.shaftSpeed = clampFloat(config.shaftSpeed, 0, 1e9, 0); // RPM

        // Cepstrum analysis settings
        this.quefrencyRangeLow = clampFloat(config.quefrencyRangeLow, 0, 1e9, 0.001); // seconds
        this.quefrencyRangeHigh = clampFloat(config.quefrencyRangeHigh, 0, 1e9, 0.1); // seconds
        this.cepstrumThreshold = clampFloat(config.cepstrumThreshold, 0, 1e12, 0.1);
        // Parse gear tooth count from comma-separated string
        this.gearTeeth = [];
        if (config.gearToothCount && config.gearToothCount.trim() !== "") {
            this.gearTeeth = config.gearToothCount
                .split(",")
                .map(function (s) {
                    return parseInt(s.trim());
                })
                .filter(function (n) {
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

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debug) {
                node.debug(message);
            }
        };

        // Initialize state persistence using helper
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "signalAnalyzerState",
            saveInterval: 30000,
            debug: node.debug,
            onStateLoaded: function (state) {
                if (state.buffer && state.buffer.length > 0) {
                    node.buffer = state.buffer;
                    node.timestamps = state.timestamps || [];
                    node.sampleCount = state.sampleCount || 0;
                    node.lastProcessedIndex = state.lastProcessedIndex || 0;

                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: node.mode + " - restored (" + node.buffer.length + " samples)"
                    });
                    debugLog("Restored signal buffer from persistence: " + node.buffer.length + " samples");
                }
            },
            getStateToSave: function () {
                if (node.buffer.length > 0) {
                    return {
                        buffer: node.buffer,
                        timestamps: node.timestamps,
                        sampleCount: node.sampleCount,
                        lastProcessedIndex: node.lastProcessedIndex
                    };
                }
                return null;
            }
        });

        node.status({ fill: "blue", shape: "ring", text: node.mode + " mode" });

        // Use shared statistics utilities
        const calculateMean = stats.calculateMean;
        const calculateStdDev = stats.calculateStdDev;

        // Window functions
        function applyWindow(signal, windowType) {
            const n = signal.length;
            const windowed = new Array(n);

            for (let i = 0; i < n; i++) {
                let w = 1.0;
                switch (windowType) {
                    case "hann":
                        w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
                        break;
                    case "hamming":
                        w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
                        break;
                    case "blackman":
                        w =
                            0.42 -
                            0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) +
                            0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
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

        /**
         * Perform Fast Fourier Transform on a signal.
         *
         * Uses fft.js (Radix-4 Cooley-Tukey algorithm) when available for
         * O(n log n) performance. Falls back to naive DFT O(n²) otherwise.
         *
         * @param {number[]} signal - Time-domain signal values
         * @param {number} fftSize - FFT size (will be rounded up to nearest power of 2)
         * @param {number} samplingRate - Sampling rate in Hz
         * @param {string} [windowType='hann'] - Window function: 'hann', 'hamming', 'blackman', 'rectangular'
         * @returns {{frequencies: number[], magnitudes: number[]}} Frequency and magnitude arrays
         *
         * @example
         * var result = performFFT(signalData, 256, 1000, 'hann');
         * // result.frequencies = [0, 3.9, 7.8, ...] Hz
         * // result.magnitudes = [0.5, 0.2, 0.8, ...]
         */
        function performFFT(signal, fftSize, samplingRate, windowType) {
            let n = fftSize;

            // Ensure n is power of 2 (required by fft.js)
            if ((n & (n - 1)) !== 0) {
                // Find next power of 2
                n = Math.pow(2, Math.ceil(Math.log2(n)));
            }

            // Apply window function
            const windowedSignal = applyWindow(
                signal.slice(0, Math.min(signal.length, n)),
                windowType || node.windowFunction
            );

            // Pad to FFT size
            const paddedSignal = new Array(n);
            for (let i = 0; i < n; i++) {
                paddedSignal[i] = i < windowedSignal.length ? windowedSignal[i] : 0;
            }

            let magnitudes, frequencies;

            if (FFT) {
                // Use high-performance fft.js library (Radix-4 algorithm)
                // Cache FFT instances for different sizes. Bounded: dynamic
                // msg.config can change the FFT size at runtime, so evict the
                // oldest entry rather than accumulating instances forever.
                if (!node.fftInstances[n]) {
                    const cached = Object.keys(node.fftInstances);
                    if (cached.length >= 8) {
                        delete node.fftInstances[cached[0]];
                    }
                    node.fftInstances[n] = new FFT(n);
                }
                const fft = node.fftInstances[n];

                // fft.js requires real-input transform; output is interleaved [re0, im0, ...]
                const complexOutput = fft.createComplexArray();

                // Perform FFT
                fft.realTransform(complexOutput, paddedSignal);
                fft.completeSpectrum(complexOutput);

                // Extract magnitudes (only positive frequencies: 0 to n/2)
                magnitudes = new Array(n / 2);
                frequencies = new Array(n / 2);

                for (let k = 0; k < n / 2; k++) {
                    const re = complexOutput[2 * k];
                    const im = complexOutput[2 * k + 1];
                    magnitudes[k] = Math.sqrt(re * re + im * im) / n;
                    frequencies[k] = (k * samplingRate) / n;
                }
            } else {
                // Fallback to naive DFT (O(n²) - slow for large signals)
                debugLog("Using fallback DFT - install fft.js for better performance");

                magnitudes = new Array(n / 2);
                frequencies = new Array(n / 2);

                for (let k = 0; k < n / 2; k++) {
                    let sumReal = 0;
                    let sumImag = 0;

                    for (let t = 0; t < n; t++) {
                        const angle = (-2 * Math.PI * k * t) / n;
                        sumReal += paddedSignal[t] * Math.cos(angle);
                        sumImag += paddedSignal[t] * Math.sin(angle);
                    }

                    magnitudes[k] = Math.sqrt(sumReal * sumReal + sumImag * sumImag) / n;
                    frequencies[k] = (k * samplingRate) / n;
                }
            }

            return { frequencies: frequencies, magnitudes: magnitudes };
        }

        function findSpectralPeaks(frequencies, magnitudes, threshold) {
            const peaks = [];
            if (magnitudes.length === 0) return peaks;
            const maxMagnitude = Math.max.apply(null, magnitudes);

            for (let i = 1; i < magnitudes.length - 1; i++) {
                if (
                    magnitudes[i] > magnitudes[i - 1] &&
                    magnitudes[i] > magnitudes[i + 1] &&
                    magnitudes[i] / maxMagnitude > threshold
                ) {
                    peaks.push({
                        frequency: frequencies[i],
                        magnitude: magnitudes[i],
                        normalized: magnitudes[i] / maxMagnitude
                    });
                }
            }

            peaks.sort(function (a, b) {
                return b.magnitude - a.magnitude;
            });
            return peaks;
        }

        function calculateSpectralFeatures(frequencies, magnitudes) {
            const n = magnitudes.length;
            let numerator = 0;
            let denominator = 0;

            for (let i = 0; i < n; i++) {
                numerator += frequencies[i] * magnitudes[i];
                denominator += magnitudes[i];
            }

            const spectralCentroid = denominator > 0 ? numerator / denominator : 0;

            let variance = 0;
            for (let i = 0; i < n; i++) {
                variance += Math.pow(frequencies[i] - spectralCentroid, 2) * magnitudes[i];
            }
            const spectralSpread = denominator > 0 ? Math.sqrt(variance / denominator) : 0;

            const sumSquares = magnitudes.reduce(function (sum, m) {
                return sum + m * m;
            }, 0);
            const rms = Math.sqrt(sumSquares / n);
            const peak = Math.max.apply(null, magnitudes);
            const crestFactor = rms > 0 ? peak / rms : 0;

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
            const n = data.length;
            const sumSquares = data.reduce(function (sum, val) {
                return sum + val * val;
            }, 0);
            const rms = Math.sqrt(sumSquares / n);

            const max = Math.max.apply(null, data);
            const min = Math.min.apply(null, data);
            const peakToPeak = max - min;
            const peak = Math.max(Math.abs(max), Math.abs(min));
            const crestFactor = rms !== 0 ? peak / rms : 0;

            const mean = calculateMean(data);
            const stdDev = calculateStdDev(data, mean);

            const m4 =
                data.reduce(function (sum, val) {
                    return sum + Math.pow(val - mean, 4);
                }, 0) / n;
            const kurtosis = stdDev !== 0 ? m4 / Math.pow(stdDev, 4) - 3 : 0;

            const m3 =
                data.reduce(function (sum, val) {
                    return sum + Math.pow(val - mean, 3);
                }, 0) / n;
            const skewness = stdDev !== 0 ? m3 / Math.pow(stdDev, 3) : 0;

            const meanAbs =
                data.reduce(function (sum, val) {
                    return sum + Math.abs(val);
                }, 0) / n;
            const formFactor = meanAbs !== 0 ? rms / meanAbs : 0;
            const impulseFactor = meanAbs !== 0 ? peak / meanAbs : 0;

            let healthScore = 100;
            if (crestFactor > 5) healthScore -= 20;
            if (Math.abs(kurtosis) > 3) healthScore -= 20;
            if (Math.abs(skewness) > 1) healthScore -= 10;
            healthScore = Math.max(0, Math.min(100, healthScore));

            // Calculate Sample Entropy
            const sampleEntropy = calculateSampleEntropy(data, 2, 0.2 * stdDev);

            // Calculate Autocorrelation (first 10 lags)
            const autocorrelation = calculateAutocorrelation(data, 10);

            // Detect periodicity from autocorrelation peaks
            const periodicity = detectPeriodicity(autocorrelation);

            // ISO 10816-3 Vibration Severity Assessment
            // Convert RMS to velocity in mm/s based on input unit
            const rmsVelocity_mm_s = convertToVelocity(rms, node.vibInputUnit || "mm_s");
            const iso10816 = evaluateISO10816(
                rmsVelocity_mm_s,
                node.iso10816Class || "class2",
                node.vibInputUnit || "mm_s"
            );

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
                healthScore: healthScore,
                iso10816: iso10816
            };
        }

        // Convert RMS value to velocity in mm/s for ISO 10816 evaluation
        // Assumes typical industrial frequency of ~50Hz for acceleration to velocity conversion
        function convertToVelocity(rmsValue, inputUnit) {
            const typicalFreq = 50; // Hz - typical industrial machine frequency

            switch (inputUnit) {
                case "mm_s":
                    // Already in mm/s - no conversion needed
                    return rmsValue;
                case "m_s":
                    // Convert m/s to mm/s
                    return rmsValue * 1000;
                case "g":
                    // Convert g (acceleration) to mm/s (velocity)
                    // v = a / (2 * π * f), where a is in m/s²
                    // g = 9.81 m/s², so: v(mm/s) = (g * 9810) / (2 * π * f)
                    return (rmsValue * 9810) / (2 * Math.PI * typicalFreq);
                case "m_s2":
                    // Convert m/s² (acceleration) to mm/s (velocity)
                    // v = a / (2 * π * f), then convert to mm/s
                    return (rmsValue * 1000) / (2 * Math.PI * typicalFreq);
                case "raw":
                default:
                    // Raw/dimensionless - return as-is but mark as unconverted
                    return rmsValue;
            }
        }

        // ISO 10816-3 Vibration Severity Evaluation
        // Based on ISO 10816-3:2009 for industrial machines with rated power > 15 kW
        // RMS velocity in mm/s
        function evaluateISO10816(rmsVelocity, machineClass, inputUnit) {
            // If input is raw/dimensionless, return a warning that ISO evaluation is not applicable
            if (inputUnit === "raw") {
                return {
                    zone: "N/A",
                    severity: "unknown",
                    recommendation:
                        "ISO 10816 not applicable - input unit is raw/dimensionless. Configure velocity or acceleration unit for proper evaluation.",
                    rmsVelocity: rmsVelocity,
                    machineClass: machineClass,
                    limits: null,
                    zoneProgress: 0,
                    isAlarm: false,
                    isWarning: false,
                    inputUnit: inputUnit,
                    isValid: false
                };
            }

            // ISO 10816-3 Zones (RMS velocity in mm/s)
            // Zone A: Newly commissioned machines
            // Zone B: Acceptable for unrestricted long-term operation
            // Zone C: Acceptable only for limited periods
            // Zone D: Vibration causes damage - immediate action required

            const thresholds = {
                // Class I: Small machines up to 15 kW
                class1: { ab: 0.71, bc: 1.8, cd: 4.5 },
                // Class II: Medium machines 15-75 kW, or up to 300 kW on special foundations
                class2: { ab: 1.12, bc: 2.8, cd: 7.1 },
                // Class III: Large machines on rigid foundations, > 75 kW
                class3: { ab: 1.8, bc: 4.5, cd: 11.2 },
                // Class IV: Large machines on soft foundations (e.g., turbines)
                class4: { ab: 2.8, bc: 7.1, cd: 18.0 }
            };

            const limits = thresholds[machineClass] || thresholds["class2"];

            let zone, severity, recommendation;

            if (rmsVelocity <= limits.ab) {
                zone = "A";
                severity = "good";
                recommendation = "Newly commissioned machine condition - excellent";
            } else if (rmsVelocity <= limits.bc) {
                zone = "B";
                severity = "acceptable";
                recommendation = "Acceptable for unrestricted long-term operation";
            } else if (rmsVelocity <= limits.cd) {
                zone = "C";
                severity = "warning";
                recommendation = "Acceptable only for limited periods - schedule maintenance";
            } else {
                zone = "D";
                severity = "critical";
                recommendation = "Vibration causes damage - immediate action required";
            }

            // Calculate how far into the zone we are (0-100%)
            let zoneProgress;
            if (zone === "A") {
                zoneProgress = (rmsVelocity / limits.ab) * 100;
            } else if (zone === "B") {
                zoneProgress = ((rmsVelocity - limits.ab) / (limits.bc - limits.ab)) * 100;
            } else if (zone === "C") {
                zoneProgress = ((rmsVelocity - limits.bc) / (limits.cd - limits.bc)) * 100;
            } else {
                zoneProgress = Math.min(100, ((rmsVelocity - limits.cd) / limits.cd) * 100);
            }

            return {
                zone: zone,
                severity: severity,
                recommendation: recommendation,
                rmsVelocity: rmsVelocity,
                machineClass: machineClass,
                limits: limits,
                zoneProgress: Math.min(100, Math.max(0, zoneProgress)),
                isAlarm: zone === "D",
                isWarning: zone === "C" || zone === "D",
                inputUnit: inputUnit,
                isValid: true
            };
        }

        // Sample Entropy - measures signal complexity/regularity
        // Lower values = more regular/predictable, Higher = more complex/random
        function calculateSampleEntropy(data, m, r) {
            const n = data.length;
            if (n < m + 1) return 0;

            // Count template matches for length m and m+1
            function countMatches(templateLength) {
                let count = 0;
                for (let i = 0; i < n - templateLength; i++) {
                    for (let j = i + 1; j < n - templateLength; j++) {
                        let match = true;
                        for (let k = 0; k < templateLength; k++) {
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

            const A = countMatches(m + 1);
            const B = countMatches(m);

            if (B === 0 || A === 0) return 0;
            return -Math.log(A / B);
        }

        // Autocorrelation Function (ACF) - detects periodicity
        function calculateAutocorrelation(data, maxLag) {
            const n = data.length;
            const mean =
                data.reduce(function (a, b) {
                    return a + b;
                }, 0) / n;
            const variance =
                data.reduce(function (sum, val) {
                    return sum + (val - mean) * (val - mean);
                }, 0) / n;

            if (variance === 0) return [];

            const acf = [];
            for (let lag = 0; lag <= Math.min(maxLag, n - 1); lag++) {
                let sum = 0;
                for (let i = 0; i < n - lag; i++) {
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
            const peaks = [];
            for (let i = 2; i < acf.length - 1; i++) {
                if (acf[i].value > acf[i - 1].value && acf[i].value > acf[i + 1].value && acf[i].value > 0.3) {
                    // Threshold for significance
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
            const peaks = [];
            let threshold = minHeight;

            if (threshold === null) {
                const mean = calculateMean(data);
                const stdDev = calculateStdDev(data, mean);
                threshold = mean + 2 * stdDev;
            }

            let lastPeakIndex = -minDistance;

            for (let i = 1; i < data.length - 1; i++) {
                const current = data[i];
                const prev = data[i - 1];
                const next = data[i + 1];

                let isPeak = false;
                let peakDirection = null;

                if ((peakType === "positive" || peakType === "both") && current > prev && current > next) {
                    if (minHeight === null || current >= threshold) {
                        isPeak = true;
                        peakDirection = "positive";
                    }
                }

                if ((peakType === "negative" || peakType === "both") && current < prev && current < next) {
                    if (minHeight === null || current <= -threshold) {
                        isPeak = true;
                        peakDirection = "negative";
                    }
                }

                if (isPeak && i - lastPeakIndex >= minDistance) {
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

            const peakValues = peaks.map(function (p) {
                return Math.abs(p.value);
            });
            const sum = peakValues.reduce(function (a, b) {
                return a + b;
            }, 0);

            return {
                averagePeakHeight: sum / peakValues.length,
                maxPeakHeight: Math.max.apply(null, peakValues),
                minPeakHeight: Math.min.apply(null, peakValues),
                peakFrequency: peaks.length / data.length
            };
        }

        // Envelope Analysis for Bearing Fault Detection
        function performEnvelopeAnalysis(signal, samplingRate, bandLow, bandHigh) {
            // Step 1: Bandpass filter (simple FIR implementation)
            const filtered = bandpassFilter(signal, samplingRate, bandLow, bandHigh);

            // Step 2: Rectify (absolute value)
            const rectified = filtered.map(function (v) {
                return Math.abs(v);
            });

            // Step 3: Low-pass filter to get envelope (simple moving average)
            const envelopeWindowSize = Math.max(3, Math.floor(samplingRate / bandLow / 2));
            const envelope = [];
            for (let i = 0; i < rectified.length; i++) {
                const start = Math.max(0, i - Math.floor(envelopeWindowSize / 2));
                const end = Math.min(rectified.length, i + Math.floor(envelopeWindowSize / 2) + 1);
                let sum = 0;
                for (let j = start; j < end; j++) {
                    sum += rectified[j];
                }
                envelope.push(sum / (end - start));
            }

            return envelope;
        }

        // Butterworth filter coefficient calculation
        // Based on bilinear transform of analog Butterworth filter
        function calculateButterworthCoefficients(cutoffFreq, samplingRate, order, filterType) {
            // Normalize frequency (0 to 1, where 1 = Nyquist)
            const nyquist = samplingRate / 2;
            let normalizedCutoff = cutoffFreq / nyquist;

            // Clamp to valid range
            normalizedCutoff = Math.max(0.001, Math.min(0.999, normalizedCutoff));

            // Pre-warp the cutoff frequency for bilinear transform
            const warpedCutoff = Math.tan((Math.PI * normalizedCutoff) / 2);

            // For 2nd order Butterworth (most common, good balance)
            // Transfer function: H(s) = 1 / (s^2 + sqrt(2)*s + 1)
            const sqrt2 = Math.sqrt(2);

            // Bilinear transform coefficients for 2nd order
            const k = warpedCutoff;
            const k2 = k * k;
            const sqrt2k = sqrt2 * k;

            let a0, a1, a2, b0, b1, b2;

            if (filterType === "lowpass") {
                // Low-pass Butterworth
                a0 = 1 + sqrt2k + k2;
                b0 = k2 / a0;
                b1 = (2 * k2) / a0;
                b2 = k2 / a0;
                a1 = (2 * (k2 - 1)) / a0;
                a2 = (1 - sqrt2k + k2) / a0;
            } else {
                // High-pass Butterworth
                a0 = 1 + sqrt2k + k2;
                b0 = 1 / a0;
                b1 = -2 / a0;
                b2 = 1 / a0;
                a1 = (2 * (k2 - 1)) / a0;
                a2 = (1 - sqrt2k + k2) / a0;
            }

            return {
                b: [b0, b1, b2], // Feedforward coefficients
                a: [1, a1, a2] // Feedback coefficients (a0 normalized to 1)
            };
        }

        // Apply IIR filter (Direct Form II Transposed)
        function applyIIRFilter(signal, coeffs) {
            const b = coeffs.b;
            const a = coeffs.a;
            const n = signal.length;
            const output = new Array(n);

            // Filter state variables (for Direct Form II Transposed)
            let z1 = 0,
                z2 = 0;

            for (let i = 0; i < n; i++) {
                const x = signal[i];

                // Output
                const y = b[0] * x + z1;

                // Update state
                z1 = b[1] * x - a[1] * y + z2;
                z2 = b[2] * x - a[2] * y;

                output[i] = y;
            }

            return output;
        }

        // Zero-phase filtering (forward-backward filtering)
        // Eliminates phase distortion by filtering forward then backward
        function filtfilt(signal, coeffs) {
            // Forward pass
            const forward = applyIIRFilter(signal, coeffs);

            // Reverse the signal
            const reversed = forward.slice().reverse();

            // Backward pass
            const backward = applyIIRFilter(reversed, coeffs);

            // Reverse again to get original order
            return backward.reverse();
        }

        // Butterworth bandpass filter
        // Implemented as cascade of highpass and lowpass filters
        function butterworthBandpass(signal, samplingRate, lowCut, highCut) {
            // Calculate coefficients for high-pass (removes frequencies below lowCut)
            const hpCoeffs = calculateButterworthCoefficients(lowCut, samplingRate, 2, "highpass");

            // Calculate coefficients for low-pass (removes frequencies above highCut)
            const lpCoeffs = calculateButterworthCoefficients(highCut, samplingRate, 2, "lowpass");

            // Apply zero-phase high-pass filter first
            const highPassed = filtfilt(signal, hpCoeffs);

            // Then apply zero-phase low-pass filter
            const bandPassed = filtfilt(highPassed, lpCoeffs);

            return bandPassed;
        }

        // Main bandpass filter function - uses Butterworth
        function bandpassFilter(signal, samplingRate, lowCut, highCut) {
            const n = signal.length;

            // Validate frequency parameters
            const nyquist = samplingRate / 2;
            if (lowCut >= highCut || lowCut <= 0 || highCut >= nyquist) {
                // Fall back to simple filter if parameters invalid
                debugLog(
                    "Bandpass: Invalid frequencies, using simple filter. low=" +
                        lowCut +
                        ", high=" +
                        highCut +
                        ", nyquist=" +
                        nyquist
                );
                return simpleBandpassFilter(signal, samplingRate, lowCut, highCut);
            }

            // Need minimum signal length for stable filtering
            if (n < 12) {
                return simpleBandpassFilter(signal, samplingRate, lowCut, highCut);
            }

            try {
                return butterworthBandpass(signal, samplingRate, lowCut, highCut);
            } catch (err) {
                debugLog("Butterworth filter failed, using simple filter: " + err.message);
                return simpleBandpassFilter(signal, samplingRate, lowCut, highCut);
            }
        }

        // Simple bandpass filter (fallback)
        function simpleBandpassFilter(signal, samplingRate, lowCut, highCut) {
            const n = signal.length;

            // High-pass: subtract low-frequency component
            const lowWindow = Math.max(3, Math.floor(samplingRate / lowCut));
            const highFiltered = [];
            for (let i = 0; i < n; i++) {
                const start = Math.max(0, i - Math.floor(lowWindow / 2));
                const end = Math.min(n, i + Math.floor(lowWindow / 2) + 1);
                let sum = 0;
                for (let j = start; j < end; j++) {
                    sum += signal[j];
                }
                const lowFreq = sum / (end - start);
                highFiltered.push(signal[i] - lowFreq);
            }

            // Low-pass: smooth high frequencies
            const highWindow = Math.max(3, Math.floor(samplingRate / highCut));
            const bandpassed = [];
            for (let i = 0; i < n; i++) {
                const start = Math.max(0, i - Math.floor(highWindow / 2));
                const end = Math.min(n, i + Math.floor(highWindow / 2) + 1);
                let sum = 0;
                for (let j = start; j < end; j++) {
                    sum += highFiltered[j];
                }
                bandpassed.push(sum / (end - start));
            }

            return bandpassed;
        }

        /**
         * Detect bearing fault frequencies in the envelope spectrum.
         *
         * Analyzes spectral peaks to identify characteristic bearing defect frequencies:
         * - BPFO: Ball Pass Frequency Outer race
         * - BPFI: Ball Pass Frequency Inner race
         * - BSF: Ball Spin Frequency
         * - FTF: Fundamental Train Frequency (cage)
         * Also checks for shaft-related frequencies (1X imbalance, 2X misalignment).
         *
         * @param {Array<{frequency: number, magnitude: number}>} envelopePeaks - Peaks from envelope spectrum
         * @param {number} shaftFreq - Shaft rotational frequency in Hz (RPM/60)
         * @param {number} bpfo - Ball Pass Frequency Outer race (from bearing geometry)
         * @param {number} bpfi - Ball Pass Frequency Inner race
         * @param {number} bsf - Ball Spin Frequency
         * @param {number} ftf - Fundamental Train Frequency
         * @param {number} [frequencyTolerance=0.05] - Tolerance for frequency matching (5% default)
         * @returns {Array<{type: string, harmonic: number, description: string, expectedFreq: number, detectedFreq: number, magnitude: number, severity: string}>}
         */
        function detectBearingFaults(envelopePeaks, shaftFreq, bpfo, bpfi, bsf, ftf, frequencyTolerance) {
            frequencyTolerance = frequencyTolerance || 0.05; // 5% frequency tolerance
            const faults = [];

            const faultFreqs = [
                { name: "BPFO", freq: bpfo, desc: "Outer Race Fault" },
                { name: "BPFI", freq: bpfi, desc: "Inner Race Fault" },
                { name: "BSF", freq: bsf, desc: "Ball/Roller Fault" },
                { name: "FTF", freq: ftf, desc: "Cage Fault" },
                { name: "1X", freq: shaftFreq, desc: "Shaft Imbalance" },
                { name: "2X", freq: shaftFreq * 2, desc: "Misalignment" }
            ];

            envelopePeaks.forEach(function (peak) {
                faultFreqs.forEach(function (fault) {
                    if (fault.freq > 0) {
                        // Check fundamental and harmonics (up to 3x)
                        for (let harmonic = 1; harmonic <= 3; harmonic++) {
                            const targetFreq = fault.freq * harmonic;
                            const freqDiff = Math.abs(peak.frequency - targetFreq) / targetFreq;

                            if (freqDiff <= frequencyTolerance) {
                                faults.push({
                                    type: fault.name,
                                    harmonic: harmonic,
                                    description: fault.desc,
                                    expectedFreq: targetFreq,
                                    detectedFreq: peak.frequency,
                                    magnitude: peak.magnitude,
                                    severity: peak.magnitude > 0.5 ? "high" : peak.magnitude > 0.2 ? "medium" : "low"
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
            const fftResult = performFFT(signal, fftSize, samplingRate, "hann");

            // Step 2: Log of magnitude spectrum
            const logSpectrum = fftResult.magnitudes.map(function (m) {
                return Math.log(Math.max(m, 1e-10)); // Avoid log(0)
            });

            // Step 3: Inverse FFT of log spectrum (approximation using DCT-like approach)
            const n = logSpectrum.length;
            const cepstrum = new Array(n);

            for (let q = 0; q < n; q++) {
                let sum = 0;
                for (let k = 0; k < n; k++) {
                    sum += logSpectrum[k] * Math.cos((2 * Math.PI * q * k) / n);
                }
                cepstrum[q] = sum / n;
            }

            // Quefrencies (time-like domain)
            const quefrencies = new Array(n);
            for (let i = 0; i < n; i++) {
                quefrencies[i] = i / samplingRate; // in seconds
            }

            return { quefrencies: quefrencies, cepstrum: cepstrum };
        }

        // Find rahmonics (peaks in cepstrum)
        function findRahmonics(quefrencies, cepstrum, minQuefrency, maxQuefrency, peakThreshold) {
            const peaks = [];
            peakThreshold = peakThreshold || 0.1; // Default 10%

            // Skip the first few samples (aperiodic component)
            const startIdx = 5;
            const maxCepstrum = Math.max.apply(null, cepstrum.slice(startIdx).map(Math.abs));

            for (let i = startIdx + 1; i < cepstrum.length - 1; i++) {
                if (quefrencies[i] < minQuefrency || quefrencies[i] > maxQuefrency) continue;

                const current = Math.abs(cepstrum[i]);
                if (current > Math.abs(cepstrum[i - 1]) && current > Math.abs(cepstrum[i + 1])) {
                    const normalized = current / maxCepstrum;
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

            peaks.sort(function (a, b) {
                return Math.abs(b.magnitude) - Math.abs(a.magnitude);
            });
            return peaks;
        }

        // Detect gear mesh frequencies and faults
        function detectGearFaults(rahmonics, shaftSpeed, gearTeeth) {
            const faults = [];
            const shaftFreq = shaftSpeed / 60;

            if (gearTeeth && gearTeeth.length > 0) {
                gearTeeth.forEach(function (teeth, idx) {
                    const gmf = shaftFreq * teeth; // Gear Mesh Frequency
                    const tolerance = 0.1; // 10%

                    rahmonics.forEach(function (peak) {
                        let freqDiff = Math.abs(peak.fundamentalFrequency - gmf) / gmf;
                        if (freqDiff < tolerance) {
                            faults.push({
                                type: "GMF",
                                gear: idx + 1,
                                teeth: teeth,
                                expectedFreq: gmf,
                                detectedFreq: peak.fundamentalFrequency,
                                magnitude: peak.normalized,
                                severity: peak.normalized > 0.5 ? "high" : peak.normalized > 0.25 ? "medium" : "low",
                                description: "Gear mesh frequency detected - possible gear wear"
                            });
                        }

                        // Check sidebands (gear damage indicator)
                        for (let sb = 1; sb <= 3; sb++) {
                            const sideband = gmf + sb * shaftFreq;
                            freqDiff = Math.abs(peak.fundamentalFrequency - sideband) / sideband;
                            if (freqDiff < tolerance) {
                                faults.push({
                                    type: "Sideband",
                                    gear: idx + 1,
                                    order: sb,
                                    expectedFreq: sideband,
                                    detectedFreq: peak.fundamentalFrequency,
                                    magnitude: peak.normalized,
                                    severity: peak.normalized > 0.3 ? "high" : "medium",
                                    description: "Sideband detected - indicates gear damage or eccentricity"
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
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: "Cepstrum: " + node.buffer.length + "/" + node.fftSize
                });
                return null;
            }

            if (node.buffer.length > node.fftSize) {
                node.buffer.shift();
            }

            const shaftFreq = (node.shaftSpeed || 1800) / 60;
            const minQuefrency = node.quefrencyRangeLow || 0.001;
            const maxQuefrency = node.quefrencyRangeHigh || 0.1;

            // Perform cepstrum analysis
            const cepResult = performCepstrum(node.buffer, node.fftSize, node.samplingRate);

            // Find rahmonics (periodic components)
            const rahmonics = findRahmonics(
                cepResult.quefrencies,
                cepResult.cepstrum,
                minQuefrency,
                maxQuefrency,
                node.cepstrumThreshold
            );

            // Detect gear faults if teeth count provided
            const gearTeeth = msg.gearTeeth || node.gearTeeth || [];
            const gearFaults = detectGearFaults(rahmonics, node.shaftSpeed || 1800, gearTeeth);

            const hasAnomaly = gearFaults.length > 0;

            const outputMsg = {
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

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            const statusText = hasAnomaly
                ? "FAULT: " + gearFaults[0].type
                : rahmonics.length > 0
                  ? "Peak: " + rahmonics[0].fundamentalFrequency.toFixed(1) + " Hz"
                  : "No peaks";
            const statusColor = hasAnomaly ? "red" : "green";
            node.status({ fill: statusColor, shape: hasAnomaly ? "ring" : "dot", text: statusText });

            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }

        // Process Envelope Analysis
        function processEnvelope(msg, value) {
            node.buffer.push(value);

            if (node.buffer.length < node.fftSize) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: "Envelope: " + node.buffer.length + "/" + node.fftSize
                });
                return null;
            }

            if (node.buffer.length > node.fftSize) {
                node.buffer.shift();
            }

            // Calculate shaft frequency from RPM
            const shaftFreq = node.shaftSpeed / 60;

            // Perform envelope analysis
            const envelope = performEnvelopeAnalysis(
                node.buffer,
                node.samplingRate,
                node.envelopeBandLow,
                node.envelopeBandHigh
            );

            // FFT of envelope
            const envelopeFFT = performFFT(envelope, node.fftSize, node.samplingRate, "hann");
            const envelopePeaks = findSpectralPeaks(envelopeFFT.frequencies, envelopeFFT.magnitudes, 0.05);

            // Detect bearing faults
            const faults = detectBearingFaults(
                envelopePeaks,
                shaftFreq,
                node.bearingBPFO,
                node.bearingBPFI,
                node.bearingBSF,
                node.bearingFTF
            );

            const hasAnomaly = faults.length > 0;

            const outputMsg = {
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

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            const statusText = hasAnomaly
                ? "FAULT: " + faults[0].type + " " + faults[0].harmonic + "X"
                : "No faults detected";
            const statusColor = hasAnomaly ? "red" : "green";
            node.status({ fill: statusColor, shape: hasAnomaly ? "ring" : "dot", text: statusText });

            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }

        // Process FFT
        function processFFT(msg, value) {
            node.buffer.push(value);

            if (node.buffer.length < node.fftSize) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: "Buffering: " + node.buffer.length + "/" + node.fftSize
                });
                return null;
            }

            if (node.buffer.length > node.fftSize) {
                node.buffer.shift();
            }

            debugLog(
                "FFT: window=" +
                    node.windowFunction +
                    ", size=" +
                    node.fftSize +
                    ", overlap=" +
                    node.overlapPercent +
                    "%"
            );
            const fftResult = performFFT(node.buffer, node.fftSize, node.samplingRate, node.windowFunction);
            const peaks = findSpectralPeaks(fftResult.frequencies, fftResult.magnitudes, node.peakThreshold);
            const features = calculateSpectralFeatures(fftResult.frequencies, fftResult.magnitudes);

            const outputMsg = {
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

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            const statusText = peaks.length > 0 ? "Peak: " + peaks[0].frequency.toFixed(1) + " Hz" : "No peaks";
            node.status({ fill: "green", shape: "dot", text: statusText });

            return { normal: outputMsg, anomaly: null };
        }

        // Process Vibration with configurable threshold (for msg.config override)
        function processVibrationWithConfig(msg, values, vibrationThreshold) {
            node.buffer.push.apply(node.buffer, values);

            if (node.buffer.length > node.windowSize) {
                node.buffer = node.buffer.slice(-node.windowSize);
            }

            if (node.buffer.length < Math.min(10, node.windowSize)) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: "Collecting: " + node.buffer.length + "/" + node.windowSize
                });
                return null;
            }

            const features = calculateVibrationFeatures(node.buffer);

            node.status({
                fill: "green",
                shape: "dot",
                text: "RMS: " + features.rms.toFixed(2) + " | CF: " + features.crestFactor.toFixed(2)
            });

            const outputMsg = {
                payload: features,
                topic: msg.topic || "vibration-features",
                timestamp: Date.now(),
                windowSize: node.buffer.length
            };

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            // Check for potential issues (vibrationThreshold overrides default crest factor check)
            const crestFactorThreshold = vibrationThreshold || 6;
            const hasAnomaly = features.crestFactor > crestFactorThreshold || Math.abs(features.kurtosis) > 4;

            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }

        // Process Peaks with configurable threshold (for msg.config override)
        function processPeaksWithConfig(msg, value, timestamp, peakThreshold) {
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

            const peaks = detectPeaks(node.buffer, node.timestamps, peakThreshold, node.minPeakDistance, node.peakType);
            const stats = calculatePeakStatistics(peaks, node.buffer);

            const currentIndex = node.buffer.length - 1;
            const isPeak = peaks.some(function (p) {
                return p.index === currentIndex;
            });

            const outputMsg = {
                payload: value,
                isPeak: isPeak,
                peaks: peaks,
                peakCount: peaks.length,
                stats: stats,
                sampleCount: node.sampleCount,
                timestamp: timestamp
            };

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            const color = isPeak ? "yellow" : "green";
            node.status({ fill: color, shape: isPeak ? "ring" : "dot", text: "Peaks: " + peaks.length });

            return { normal: isPeak ? null : outputMsg, anomaly: isPeak ? outputMsg : null };
        }

        node.on("input", function (msg, send, done) {
            try {
                // Dynamic configuration via msg.config
                // Allows runtime override of node settings
                const cfg = msg.config || {};
                const activeMode = cfg.mode || node.mode;
                const activeVibrationThreshold =
                    cfg.vibrationThreshold !== undefined ? parseFloat(cfg.vibrationThreshold) : node.vibrationThreshold;
                const activePeakThreshold =
                    cfg.peakThreshold !== undefined ? parseFloat(cfg.peakThreshold) : node.peakThreshold;

                if (msg.reset === true) {
                    node.buffer = [];
                    node.timestamps = [];
                    node.sampleCount = 0;
                    node.status({ fill: "blue", shape: "ring", text: activeMode + " - reset" });
                    done();
                    return;
                }

                let result = null;

                if (activeMode === "fft") {
                    const value = parseFloat(msg.payload);
                    if (!Number.isFinite(value)) {
                        node.warn("Invalid payload: not a finite number");
                        done();
                        return;
                    }
                    result = processFFT(msg, value);
                } else if (activeMode === "vibration") {
                    let values = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
                    values = values.filter(function (v) {
                        return typeof v === "number" && Number.isFinite(v);
                    });
                    if (values.length === 0) {
                        node.warn("No valid numeric values found");
                        done();
                        return;
                    }
                    result = processVibrationWithConfig(msg, values, activeVibrationThreshold);
                } else if (activeMode === "peaks") {
                    const value = parseFloat(msg.payload);
                    const timestamp = msg.timestamp || Date.now();
                    if (!Number.isFinite(value)) {
                        node.warn("Invalid payload: not a finite number");
                        done();
                        return;
                    }
                    result = processPeaksWithConfig(msg, value, timestamp, activePeakThreshold);
                } else if (activeMode === "envelope") {
                    const value = parseFloat(msg.payload);
                    if (!Number.isFinite(value)) {
                        node.warn("Invalid payload: not a finite number");
                        done();
                        return;
                    }
                    result = processEnvelope(msg, value);
                } else if (activeMode === "cepstrum") {
                    const value = parseFloat(msg.payload);
                    if (!Number.isFinite(value)) {
                        node.warn("Invalid payload: not a finite number");
                        done();
                        return;
                    }
                    result = processCepstrum(msg, value);
                }

                if (result) {
                    if (result.anomaly) {
                        send([null, result.anomaly]);
                    } else if (result.normal) {
                        send([result.normal, null]);
                    }
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err);
            }
        });

        node.on("close", async function (done) {
            // Save state before closing if persistence enabled
            if (persistence) {
                await persistence.close();
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
    RED.httpAdmin.get("/signal-analyzer/fft-status", function (req, res) {
        res.json({
            available: FFT !== null,
            library: FFT ? "fft.js (Radix-4)" : "fallback DFT",
            performance: FFT ? "O(n log n)" : "O(n²)"
        });
    });
};
