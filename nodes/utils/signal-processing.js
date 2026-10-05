/**
 * Signal-processing primitives of the signal-analyzer node: windowing and FFT,
 * spectral peak picking, band-pass filtering and envelope extraction, the real
 * cepstrum, time-domain peak detection, and the bearing / gear diagnosis rules
 * applied to the resulting spectra.
 *
 * Everything here is a function of its arguments (the FFT instance cache is
 * the only module state), so it can be unit-tested without a Node-RED runtime.
 */
"use strict";

const stats = require("./statistics");
const calculateMean = stats.calculateMean;
const calculateStdDev = stats.calculateStdDev;

// High-performance FFT library (Radix-4 Cooley-Tukey). Optional: without it
// the transforms fall back to a naive O(n²) DFT.
let FFT = null;
try {
    FFT = require("fft.js");
} catch (err) {
    // fall back to the naive implementation
}

// fft.js instances by size, shared by every node (see getFftInstance)
const fftInstances = {};

// Max / min by loop: Math.max.apply(null, arr) passes every element as an
// argument and overflows the stack from roughly 10^5 elements on — well
// inside the allowed window and FFT sizes.
function arrayMax(arr) {
    let m = -Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
}

function arrayMin(arr) {
    let m = Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m;
}

// Factor that turns the two-sided, window-attenuated magnitudes of
// performFFT (|X_k| / N) into single-sided amplitudes: 2 for the folded
// negative frequencies, divided by the window's coherent gain.
const COHERENT_GAIN = { hann: 0.5, hamming: 0.54, blackman: 0.42, rectangular: 1 };
function amplitudeScale(windowType) {
    return 2 / (COHERENT_GAIN[windowType] || 1);
}

// Cached fft.js instance for a power-of-two size. Bounded: the size can
// differ between modes, so evict the oldest entry rather than
// accumulating instances forever.
function getFftInstance(n) {
    if (!fftInstances[n]) {
        const cached = Object.keys(fftInstances);
        if (cached.length >= 8) {
            delete fftInstances[cached[0]];
        }
        fftInstances[n] = new FFT(n);
    }
    return fftInstances[n];
}

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
                w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
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
    const windowedSignal = applyWindow(signal.slice(0, Math.min(signal.length, n)), windowType || "hann");

    // Pad to FFT size
    const paddedSignal = new Array(n);
    for (let i = 0; i < n; i++) {
        paddedSignal[i] = i < windowedSignal.length ? windowedSignal[i] : 0;
    }

    let magnitudes, frequencies;

    if (FFT) {
        // Use high-performance fft.js library (Radix-4 algorithm)
        const fft = getFftInstance(n);

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
    const maxMagnitude = arrayMax(magnitudes);
    if (!(maxMagnitude > 0)) return peaks;

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

/**
 * Local maxima that stand out from the *local* spectral noise floor.
 *
 * The envelope spectrum of band-limited noise is far from white — it is
 * concentrated below the envelope low-pass and near zero above it — so a
 * global statistic would be meaningless. The floor at each bin is the
 * 30th percentile of the magnitudes in a window of ±W bins around it. A
 * Hann-windowed line spans 3–4 bins; a low percentile (rather than the
 * median) keeps the floor honest even when a dense harmonic series
 * (looseness at coarse resolution) occupies most of the window. For
 * Rayleigh-distributed noise p30 ≈ 0.85 σ and the largest of N noise bins
 * reaches ≈ sqrt(2 ln N) σ (≈ 4.4 σ for 16k bins ≈ 5.2 × p30), so a factor
 * of 8 (≈ 6.8 σ) admits no noise peak while a genuine modulation line
 * still clears it. Peaks are sorted by magnitude; `normalized` is relative
 * to the strongest.
 */
function findSignificantPeaks(frequencies, magnitudes, floorFactor) {
    const peaks = [];
    const N = magnitudes.length;
    if (N < 3) return peaks;
    const W = Math.max(16, Math.round(0.004 * N));
    const floorAt = function (i) {
        const lo = Math.max(1, i - W);
        const hi = Math.min(N - 1, i + W);
        const win = magnitudes.slice(lo, hi + 1).sort(function (a, b) {
            return a - b;
        });
        return win[Math.floor(win.length * 0.3)];
    };
    // Sorting a 2W window for every local maximum costs O(N·W·log W) —
    // seconds for a 64k spectrum. The floor varies slowly (that is the
    // point of it), so large spectra evaluate it on a grid of W/4 bins
    // and reuse the nearest grid value; small ones stay exact.
    const step = N > 4096 ? Math.max(1, Math.floor(W / 4)) : 1;
    const grid = step > 1 ? new Array(Math.ceil(N / step)) : null;
    const localFloor = function (i) {
        if (!grid) return floorAt(i);
        const g = Math.min(grid.length - 1, Math.round(i / step));
        if (grid[g] === undefined) grid[g] = floorAt(Math.min(N - 1, g * step));
        return grid[g];
    };
    let maxMagnitude = 0;
    for (let i = 1; i < N - 1; i++) {
        const m = magnitudes[i];
        if (!(m > magnitudes[i - 1] && m >= magnitudes[i + 1])) continue;
        const floor = localFloor(i);
        if (!(m > floor * floorFactor)) continue;
        peaks.push({ frequency: frequencies[i], magnitude: m, noiseRatio: floor > 0 ? m / floor : Infinity });
        if (m > maxMagnitude) maxMagnitude = m;
    }
    peaks.forEach(function (p) {
        p.normalized = maxMagnitude > 0 ? p.magnitude / maxMagnitude : 0;
    });
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
    const peak = arrayMax(magnitudes);
    const crestFactor = rms > 0 ? peak / rms : 0;

    return {
        spectralCentroid: spectralCentroid,
        spectralSpread: spectralSpread,
        rms: rms,
        crestFactor: crestFactor,
        totalEnergy: sumSquares
    };
}

// Sample Entropy - measures signal complexity/regularity
// Lower values = more regular/predictable, Higher = more complex/random
// NOTE: this is O(n²); cap the analysis length so a large windowSize
// (up to ~1M samples) cannot stall the flow on every message. We use the
// most recent SAMPEN_MAX samples, which is statistically sufficient.
const SAMPEN_MAX = 2000;
function calculateSampleEntropy(input, m, r) {
    const data = input.length > SAMPEN_MAX ? input.slice(input.length - SAMPEN_MAX) : input;
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

// Peak Detection. `minHeight` null = automatic: a positive peak must
// exceed mean + 2σ of the window, a negative one fall below mean − 2σ.
// A given height h means >= h for positive and <= −h for negative peaks.
function detectPeaks(data, times, minHeight, minDistance, peakType) {
    const peaks = [];
    let upper = minHeight;
    let lower = minHeight !== null ? -minHeight : null;

    if (minHeight === null) {
        const mean = calculateMean(data);
        const stdDev = calculateStdDev(data, mean);
        upper = mean + 2 * stdDev;
        lower = mean - 2 * stdDev;
    }

    let lastPeakIndex = -minDistance;

    for (let i = 1; i < data.length - 1; i++) {
        const current = data[i];
        const prev = data[i - 1];
        const next = data[i + 1];

        let isPeak = false;
        let peakDirection = null;

        if ((peakType === "positive" || peakType === "both") && current > prev && current > next) {
            if (current >= upper) {
                isPeak = true;
                peakDirection = "positive";
            }
        }

        if ((peakType === "negative" || peakType === "both") && current < prev && current < next) {
            if (current <= lower) {
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
        maxPeakHeight: arrayMax(peakValues),
        minPeakHeight: arrayMin(peakValues),
        peakFrequency: peaks.length / data.length
    };
}

// Envelope Analysis for Bearing Fault Detection
function performEnvelopeAnalysis(signal, samplingRate, bandLow, bandHigh, logger) {
    // Step 1: Bandpass filter (simple FIR implementation)
    const filtered = bandpassFilter(signal, samplingRate, bandLow, bandHigh, logger);

    // Step 2: Rectify (absolute value)
    const rectified = filtered.map(function (v) {
        return Math.abs(v);
    });

    // Step 3: Low-pass filter to get envelope (centred moving average,
    // from a prefix sum so the cost does not grow with the window)
    const envelopeWindowSize = Math.max(3, Math.floor(samplingRate / bandLow / 2));
    const half = Math.floor(envelopeWindowSize / 2);
    const prefix = new Array(rectified.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < rectified.length; i++) {
        prefix[i + 1] = prefix[i] + rectified[i];
    }
    const envelope = new Array(rectified.length);
    for (let i = 0; i < rectified.length; i++) {
        const start = Math.max(0, i - half);
        const end = Math.min(rectified.length, i + half + 1);
        envelope[i] = (prefix[end] - prefix[start]) / (end - start);
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
function bandpassFilter(signal, samplingRate, lowCut, highCut, logger) {
    const n = signal.length;
    const log = typeof logger === "function" ? logger : function () {};

    // Validate frequency parameters
    const nyquist = samplingRate / 2;
    if (lowCut >= highCut || lowCut <= 0 || highCut >= nyquist) {
        // Fall back to simple filter if parameters invalid
        log(
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
        log("Butterworth filter failed, using simple filter: " + err.message);
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
 * Diagnose the envelope spectrum against the expected line frequencies.
 *
 * Matching rules (all learned from simulated impact trains, see
 * test/signal-analyzer-diagnostics_spec.js):
 *  - Tolerance is 5 % of the target but never more than 0.15 × shaft
 *    frequency (neighbouring bearing lines and ±1X sidebands are that
 *    close) and never less than 1.5 spectral bins.
 *  - Harmonics of a bearing line count only when its fundamental is
 *    present; a lone "3 × BPFO" is far more often 2 × BPFI or a shaft
 *    harmonic than an outer-race defect without fundamental.
 *    The one exception is the rolling-element line: a ball defect shows at
 *    2 × BSF, so that line is accepted without its fundamental.
 *  - BPFI sidebands are only looked for around BPFI harmonics that were
 *    actually found (a sideband without its carrier is not a sideband).
 *  - A bearing line that also sits on a shaft harmonic is flagged
 *    `coincidesWith1X`, so a looseness pattern is not misread as a bearing.
 *
 * @param {Array<{frequency:number, magnitude:number}>} envelopePeaks
 * @param {number} shaftFreq - Hz (0 = unknown)
 * @param {number} bpfo @param {number} bpfi @param {number} bsf @param {number} ftf - Hz (0 = unknown)
 * @param {number} [frequencyTolerance=0.05] - relative tolerance
 * @param {number} [binWidth=0] - spectral resolution in Hz
 * @param {number} [floorFactor=0] - noise-floor multiple the peaks had to clear
 */
function detectBearingFaults(
    envelopePeaks,
    shaftFreq,
    bpfo,
    bpfi,
    bsf,
    ftf,
    frequencyTolerance,
    binWidth,
    floorFactor
) {
    frequencyTolerance = frequencyTolerance || 0.05;
    binWidth = binWidth > 0 ? binWidth : 0;
    const faults = [];

    const toleranceHz = function (target) {
        let tol = target * frequencyTolerance;
        if (shaftFreq > 0) tol = Math.min(tol, 0.15 * shaftFreq);
        return Math.max(tol, 1.5 * binWidth);
    };
    const findPeak = function (target) {
        if (!(target > 0)) return null;
        const tol = toleranceHz(target);
        let best = null;
        envelopePeaks.forEach(function (peak) {
            if (Math.abs(peak.frequency - target) <= tol && (!best || peak.magnitude > best.magnitude)) {
                best = peak;
            }
        });
        return best;
    };
    // Severity from how far the line stands above the local noise floor,
    // relative to the significance factor it had to clear anyway. An
    // absolute magnitude would depend on the sensor unit (g, m/s², mm/s)
    // and gain; it is only the fallback for peaks without a noise ratio.
    const severityOf = function (peak) {
        if (floorFactor > 0 && peak.noiseRatio !== undefined) {
            const excess = peak.noiseRatio / floorFactor;
            return excess > 5 ? "high" : excess > 2 ? "medium" : "low";
        }
        return peak.magnitude > 0.5 ? "high" : peak.magnitude > 0.2 ? "medium" : "low";
    };
    const shaftOrderOf = function (freq) {
        if (!(shaftFreq > 0)) return 0;
        const k = Math.round(freq / shaftFreq);
        return k >= 1 && Math.abs(freq - k * shaftFreq) <= toleranceHz(k * shaftFreq) ? k : 0;
    };
    const push = function (entry, peak) {
        entry.detectedFreq = peak.frequency;
        entry.magnitude = peak.magnitude;
        entry.severity = severityOf(peak);
        faults.push(entry);
    };

    // Bearing lines: fundamental first, harmonics only with the fundamental
    const bearingLines = [
        { name: "BPFO", freq: bpfo, desc: "Outer Race Fault" },
        { name: "BPFI", freq: bpfi, desc: "Inner Race Fault" },
        { name: "BSF", freq: bsf, desc: "Ball/Roller Fault" },
        { name: "FTF", freq: ftf, desc: "Cage Fault" }
    ];
    const found = {};
    bearingLines.forEach(function (line) {
        if (!(line.freq > 0)) return;
        const fundamental = findPeak(line.freq);
        // A rolling-element defect strikes the outer and the inner race once
        // each per ball revolution, so its envelope line usually sits at
        // 2 × BSF, with BSF itself weak or absent. For BSF the second harmonic
        // therefore counts as an anchor of its own (unless it is a shaft
        // harmonic); the even harmonics are then followed instead.
        const evenAnchor =
            !fundamental && line.name === "BSF" && !shaftOrderOf(2 * line.freq) ? findPeak(2 * line.freq) : null;
        if (!fundamental && !evenAnchor) return;
        const harmonics = fundamental ? [1, 2, 3] : [2, 4];
        found[line.name] = [];
        harmonics.forEach(function (h) {
            const target = line.freq * h;
            const peak = h === 1 ? fundamental : h === 2 && evenAnchor ? evenAnchor : findPeak(target);
            if (!peak) return;
            found[line.name].push(h);
            const entry = { type: line.name, harmonic: h, description: line.desc, expectedFreq: target };
            const k = shaftOrderOf(target);
            if (k) entry.coincidesWith1X = k;
            push(entry, peak);
        });
    });

    // Shaft lines (1X imbalance, 2X misalignment) and their harmonics, as before
    [
        { name: "1X", freq: shaftFreq, desc: "Shaft Imbalance" },
        { name: "2X", freq: shaftFreq * 2, desc: "Misalignment" }
    ].forEach(function (line) {
        if (!(line.freq > 0)) return;
        for (let h = 1; h <= 3; h++) {
            const target = line.freq * h;
            const peak = findPeak(target);
            if (peak) push({ type: line.name, harmonic: h, description: line.desc, expectedFreq: target }, peak);
        }
    });

    if (shaftFreq > 0) {
        // An inner-race defect runs through the load zone once per
        // revolution, so BPFI and its harmonics carry sidebands spaced at
        // ±1X. BPFI *with* sidebands is a much firmer diagnosis than the
        // line alone; an outer-race defect shows no such modulation.
        if (found.BPFI) {
            found.BPFI.forEach(function (h) {
                const centre = bpfi * h;
                for (let k = -2; k <= 2; k++) {
                    if (k === 0) continue;
                    const target = centre + k * shaftFreq;
                    const peak = findPeak(target);
                    if (!peak) continue;
                    push(
                        {
                            type: "BPFI-Sideband",
                            harmonic: h,
                            sideband: k,
                            description:
                                "Inner race fault modulated by shaft speed (BPFI×" +
                                h +
                                (k > 0 ? " +" : " −") +
                                Math.abs(k) +
                                "×1X)",
                            expectedFreq: target
                        },
                        peak
                    );
                }
            });
        }

        // Mechanical looseness: a long series of 1X harmonics (often up to
        // 10X, sometimes with half-order components).
        const LOOSENESS_MAX_HARMONIC = 10;
        const LOOSENESS_MIN_HARMONICS = 4;
        const present = [];
        let strongest = null;
        for (let h = 1; h <= LOOSENESS_MAX_HARMONIC; h++) {
            const hit = findPeak(shaftFreq * h);
            if (hit) {
                present.push(h);
                if (!strongest || hit.magnitude > strongest.magnitude) strongest = hit;
            }
        }
        if (present.length >= LOOSENESS_MIN_HARMONICS) {
            push(
                {
                    type: "Looseness",
                    harmonic: present.length,
                    harmonics: present,
                    description: "Mechanical looseness - " + present.length + " harmonics of 1X present",
                    expectedFreq: shaftFreq
                },
                strongest
            );
        }

        // Sub-synchronous component between 0.38X and 0.48X: oil whirl in a
        // fluid-film bearing, or rubbing. The cage frequency (FTF) of a
        // rolling bearing sits in the same range, so a peak that matches a
        // configured FTF is the cage, not a whirl.
        envelopePeaks.forEach(function (peak) {
            const order = peak.frequency / shaftFreq;
            if (order < 0.38 || order > 0.48) return;
            if (ftf > 0 && Math.abs(peak.frequency - ftf) <= toleranceHz(ftf)) return;
            push(
                {
                    type: "SubSynchronous",
                    harmonic: 1,
                    order: Math.round(order * 100) / 100,
                    description: "Sub-synchronous component at " + order.toFixed(2) + "X - oil whirl or rub",
                    expectedFreq: 0.43 * shaftFreq
                },
                peak
            );
        });
    }

    return faults;
}

/**
 * Real cepstrum for gearbox diagnostics: the inverse transform of the
 * log magnitude spectrum, c[q] = (1/N) Σ_{k=0}^{N-1} ln|X_k| · cos(2πqk/N).
 *
 * The sum runs over the *full* (symmetric) N-point spectrum. performFFT
 * only returns the lower half, so the upper half is mirrored back in;
 * transforming the half spectrum on its own places every rahmonic at half
 * its true quefrency. The log spectrum is real and even, so one forward
 * FFT of it yields the cepstrum in its real parts.
 */
function performCepstrum(signal, fftSize, samplingRate) {
    // Step 1: FFT of signal
    const fftResult = performFFT(signal, fftSize, samplingRate, "hann");
    const half = fftResult.magnitudes.length;
    const N = half * 2;

    // Step 2: Log of magnitude spectrum, mirrored to full length
    const logSpectrum = new Array(N);
    for (let k = 0; k < half; k++) {
        logSpectrum[k] = Math.log(Math.max(fftResult.magnitudes[k], 1e-10)); // Avoid log(0)
    }
    logSpectrum[half] = logSpectrum[half - 1]; // Nyquist bin (not part of the half spectrum)
    for (let k = 1; k < half; k++) {
        logSpectrum[N - k] = logSpectrum[k];
    }

    // Step 3: Inverse FFT of the log spectrum
    const cepstrum = new Array(half);
    if (FFT && N >= 2) {
        const fft = getFftInstance(N);
        const out = fft.createComplexArray();
        fft.realTransform(out, logSpectrum);
        for (let q = 0; q < half; q++) {
            cepstrum[q] = out[2 * q] / N;
        }
    } else {
        for (let q = 0; q < half; q++) {
            let sum = 0;
            for (let k = 0; k < N; k++) {
                sum += logSpectrum[k] * Math.cos((2 * Math.PI * q * k) / N);
            }
            cepstrum[q] = sum / N;
        }
    }

    // Quefrencies (time-like domain)
    const quefrencies = new Array(half);
    for (let i = 0; i < half; i++) {
        quefrencies[i] = i / samplingRate; // in seconds
    }

    // The spectrum the cepstrum was computed from is handed back as well
    // (the gear sideband analysis reads it, which saves a second transform).
    return {
        quefrencies: quefrencies,
        cepstrum: cepstrum,
        frequencies: fftResult.frequencies,
        magnitudes: fftResult.magnitudes
    };
}

// Find rahmonics (peaks in cepstrum)
function findRahmonics(quefrencies, cepstrum, minQuefrency, maxQuefrency, peakThreshold) {
    const peaks = [];
    peakThreshold = peakThreshold || 0.1; // Default 10%

    // Skip the first few samples (aperiodic component)
    const startIdx = 5;
    if (cepstrum.length <= startIdx + 1) return peaks;
    const maxCepstrum = arrayMax(cepstrum.slice(startIdx).map(Math.abs));
    // No usable energy -> no peaks (avoids divide-by-zero / NaN normalization)
    if (!(maxCepstrum > 0)) return peaks;

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

/**
 * Sideband analysis of one gear from an amplitude spectrum.
 *
 * A healthy gear pair produces the gear-mesh frequency (GMF = shaft frequency
 * × teeth) and its harmonics. Damage or eccentricity on a gear modulates the
 * mesh once per revolution of its shaft, which shows as sidebands at
 * GMF ± k × shaft frequency. The Sideband Energy Ratio (SER) — the summed
 * amplitude of the first sidebands on both sides divided by the amplitude of
 * the mesh line — is the customary scalar for it: well below 1 on a healthy
 * mesh, rising with damage.
 *
 * (The cepstrum cannot make this call from a peak list: the mesh harmonics
 * always produce a rahmonic family, and for an integer tooth count one of its
 * members sits exactly on the shaft period where the sideband family would
 * show — healthy and damaged gears look alike there.)
 *
 * The mesh line is searched within ±1 % of its expected position (speed
 * error), and the sidebands relative to where it was actually found. A line
 * counts only when it clears three times the local noise floor.
 *
 * @param {number[]} frequencies - bin centre frequencies (Hz)
 * @param {number[]} magnitudes - spectrum magnitudes (any consistent scale)
 * @param {number} shaftHz - rotation frequency of the gear's shaft
 * @param {number} teeth
 * @param {number} [sidebandCount=6] - sidebands evaluated on each side
 * @returns {object|null} null when the mesh frequency lies outside the spectrum
 */
function gearSidebandAnalysis(frequencies, magnitudes, shaftHz, teeth, sidebandCount) {
    const count = sidebandCount > 0 ? sidebandCount : 6;
    const n = magnitudes.length;
    if (n < 8 || !(shaftHz > 0) || !(teeth > 0)) return null;
    const binWidth = frequencies[1] - frequencies[0];
    const gmf = shaftHz * teeth;
    if (!(gmf > 0) || gmf + shaftHz >= frequencies[n - 1]) return null;

    // Sidebands are one shaft frequency apart; they need a few bins between them
    const resolved = shaftHz / binWidth >= 4;
    const halfSpacing = Math.max(1, Math.floor((0.4 * shaftHz) / binWidth));
    const peakNear = function (freq, tolBins) {
        const centre = Math.round(freq / binWidth);
        let best = -1;
        for (let k = Math.max(1, centre - tolBins); k <= Math.min(n - 1, centre + tolBins); k++) {
            if (best < 0 || magnitudes[k] > magnitudes[best]) best = k;
        }
        return best;
    };

    // Local noise floor: median magnitude across the band the sidebands span
    const lo = Math.max(1, Math.round((gmf - (count + 1) * shaftHz) / binWidth));
    const hi = Math.min(n - 1, Math.round((gmf + (count + 1) * shaftHz) / binWidth));
    const band = magnitudes.slice(lo, hi + 1).sort(function (a, b) {
        return a - b;
    });
    const noiseFloor = band.length ? band[Math.floor(band.length / 2)] : 0;
    const significant = 3 * noiseFloor;

    const meshTol = Math.min(halfSpacing, Math.max(2, Math.round((0.01 * gmf) / binWidth)));
    const meshBin = peakNear(gmf, meshTol);
    const gmfAmplitude = meshBin >= 0 ? magnitudes[meshBin] : 0;
    const detectedGmf = meshBin >= 0 ? frequencies[meshBin] : null;
    const meshFound = gmfAmplitude > significant && gmfAmplitude > 0;

    const sidebands = [];
    let sidebandSum = 0;
    if (meshFound && resolved) {
        const spacing = (shaftHz * detectedGmf) / gmf; // same relative speed error as the mesh line
        const sideTol = Math.min(halfSpacing, 2);
        for (let k = 1; k <= count; k++) {
            [-1, 1].forEach(function (side) {
                const target = detectedGmf + side * k * spacing;
                if (!(target > 0) || target >= frequencies[n - 1]) return;
                const bin = peakNear(target, sideTol);
                // above the noise, and at least 1 % of the mesh line (window
                // leakage of a clean spectrum is not a sideband)
                if (bin < 0 || !(magnitudes[bin] > significant) || magnitudes[bin] < 0.01 * gmfAmplitude) return;
                sidebands.push({ order: side * k, frequency: frequencies[bin], amplitude: magnitudes[bin] });
                sidebandSum += magnitudes[bin];
            });
        }
    }

    return {
        teeth: teeth,
        gmf: gmf,
        detectedGmf: detectedGmf,
        gmfAmplitude: gmfAmplitude,
        meshFound: meshFound,
        resolved: resolved,
        noiseFloor: noiseFloor,
        sidebands: sidebands,
        sidebandEnergyRatio: meshFound && resolved ? sidebandSum / gmfAmplitude : null
    };
}

/**
 * Gear faults from the per-gear sideband analyses: a gear whose Sideband
 * Energy Ratio exceeds `threshold` is reported (twice the threshold = high).
 *
 * @param {Array<object|null>} gears - results of gearSidebandAnalysis, in gear order
 * @param {number} [threshold=1]
 */
function detectGearFaults(gears, threshold) {
    const limit = threshold > 0 ? threshold : 1;
    const faults = [];
    (gears || []).forEach(function (g, idx) {
        if (!g || !(g.sidebandEnergyRatio > limit)) return;
        faults.push({
            type: "Sideband",
            gear: idx + 1,
            teeth: g.teeth,
            expectedFreq: g.gmf,
            detectedFreq: g.detectedGmf,
            magnitude: g.sidebandEnergyRatio,
            sidebandEnergyRatio: g.sidebandEnergyRatio,
            sidebandCount: g.sidebands.length,
            severity: g.sidebandEnergyRatio > 2 * limit ? "high" : "medium",
            description:
                "Gear mesh modulated at shaft speed (sideband energy ratio " +
                g.sidebandEnergyRatio.toFixed(2) +
                ") - gear damage or eccentricity on this shaft"
        });
    });
    return faults;
}

module.exports = {
    fftAvailable: FFT !== null,
    arrayMax,
    arrayMin,
    amplitudeScale,
    applyWindow,
    performFFT,
    findSpectralPeaks,
    findSignificantPeaks,
    calculateSpectralFeatures,
    calculateSampleEntropy,
    calculateAutocorrelation,
    detectPeriodicity,
    detectPeaks,
    calculatePeakStatistics,
    performEnvelopeAnalysis,
    calculateButterworthCoefficients,
    applyIIRFilter,
    filtfilt,
    butterworthBandpass,
    bandpassFilter,
    simpleBandpassFilter,
    detectBearingFaults,
    performCepstrum,
    findRahmonics,
    gearSidebandAnalysis,
    detectGearFaults
};
