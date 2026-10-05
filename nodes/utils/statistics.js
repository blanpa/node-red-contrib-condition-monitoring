/**
 * Shared Statistics Utilities
 * ===========================
 *
 * Common statistical functions used across condition monitoring nodes.
 * Centralizes calculations to reduce code duplication and ensure consistency.
 *
 * @module utils/statistics
 */

"use strict";

/**
 * Calculate the arithmetic mean of an array of numbers
 * @param {number[]} values - Array of numeric values
 * @returns {number} The arithmetic mean
 * @throws {Error} If values array is empty
 */
function calculateMean(values) {
    if (!values || values.length === 0) {
        throw new Error("Cannot calculate mean of empty array");
    }
    return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Calculate the standard deviation of an array of numbers (population variance)
 * @param {number[]} values - Array of numeric values
 * @param {number} [mean] - Pre-calculated mean (optional, will be calculated if not provided)
 * @returns {number} The standard deviation
 */
function calculateStdDev(values, mean) {
    if (!values || values.length === 0) return 0;
    const m = mean !== undefined ? mean : calculateMean(values);
    let sumSq = 0;
    for (let i = 0; i < values.length; i++) {
        const d = values[i] - m;
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / values.length);
}

/**
 * Calculate the sample standard deviation (Bessel's correction)
 * @param {number[]} values - Array of numeric values
 * @param {number} [mean] - Pre-calculated mean (optional)
 * @returns {number} The sample standard deviation
 */
function calculateSampleStdDev(values, mean) {
    if (!values || values.length < 2) return 0;
    const m = mean !== undefined ? mean : calculateMean(values);
    let sumSq = 0;
    for (let i = 0; i < values.length; i++) {
        const d = values[i] - m;
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Calculate variance of an array of numbers (population variance)
 * @param {number[]} values - Array of numeric values
 * @param {number} [mean] - Pre-calculated mean (optional)
 * @returns {number} The variance
 */
function calculateVariance(values, mean) {
    if (!values || values.length === 0) return 0;
    const m = mean !== undefined ? mean : calculateMean(values);
    let sumSq = 0;
    for (let i = 0; i < values.length; i++) {
        const d = values[i] - m;
        sumSq += d * d;
    }
    return sumSq / values.length;
}

/**
 * Calculate the median of an array of numbers
 * @param {number[]} values - Array of numeric values
 * @returns {number} The median value
 */
function calculateMedian(values) {
    if (!values || values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Calculate quartiles (Q1, Q2/median, Q3) and IQR.
 *
 * Uses the same linearly interpolated percentile as calculatePercentile (the
 * "linear" / R-7 definition, the default of NumPy and Excel's QUARTILE.INC), so
 * q2 equals calculateMedian and q1 / q3 equal the 25th / 75th percentile. An
 * earlier version picked the element at floor(n·p), which disagreed with both:
 * for [1, 2, 3, 4] it gave q1 = 2, median = 3, q3 = 4.
 *
 * @param {number[]} values - Array of numeric values
 * @returns {{q1: number, q2: number, q3: number, iqr: number, median: number}} Quartile statistics
 */
function calculateQuartiles(values) {
    if (!values || values.length === 0) {
        return { q1: 0, q2: 0, q3: 0, iqr: 0, median: 0 };
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const q1 = calculatePercentileSorted(sorted, 25);
    const q2 = calculatePercentileSorted(sorted, 50);
    const q3 = calculatePercentileSorted(sorted, 75);

    return { q1: q1, q2: q2, q3: q3, iqr: q3 - q1, median: q2 };
}

/**
 * Calculate a specific percentile of an array
 * @param {number[]} values - Array of numeric values (will be sorted internally)
 * @param {number} percentile - Percentile to calculate (0-100)
 * @returns {number} The percentile value
 */
function calculatePercentile(values, percentile) {
    if (!values || values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return calculatePercentileSorted(sorted, percentile);
}

/**
 * Calculate a specific percentile from a pre-sorted array
 * @param {number[]} sorted - Pre-sorted array of numeric values
 * @param {number} percentile - Percentile to calculate (0-100)
 * @returns {number} The percentile value
 */
function calculatePercentileSorted(sorted, percentile) {
    if (!sorted || sorted.length === 0) return 0;
    const index = (percentile / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Calculate the Z-score of a value relative to a dataset
 * @param {number} value - The value to calculate Z-score for
 * @param {number[]} values - Reference dataset
 * @returns {{zScore: number, mean: number, stdDev: number}} Z-score and statistics
 */
function calculateZScore(value, values) {
    if (!values || values.length < 2) {
        return { zScore: 0, mean: value, stdDev: 0 };
    }
    const mean = calculateMean(values);
    const stdDev = calculateStdDev(values, mean);
    const zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
    return { zScore, mean, stdDev };
}

/**
 * Calculate IQR bounds for anomaly detection
 * @param {number[]} values - Array of numeric values
 * @param {number} [multiplier=1.5] - IQR multiplier for bounds
 * @returns {{q1: number, q3: number, iqr: number, lowerBound: number, upperBound: number}} IQR statistics and bounds
 */
function calculateIQRBounds(values, multiplier = 1.5) {
    const quartiles = calculateQuartiles(values);
    return {
        ...quartiles,
        lowerBound: quartiles.q1 - multiplier * quartiles.iqr,
        upperBound: quartiles.q3 + multiplier * quartiles.iqr
    };
}

/**
 * Calculate Pearson correlation coefficient between two arrays
 * @param {number[]} x - First array of values
 * @param {number[]} y - Second array of values
 * @returns {number|null} Correlation coefficient (-1 to 1) or null if invalid
 */
function calculatePearsonCorrelation(x, y) {
    const n = x.length;
    if (n !== y.length || n === 0) return null;

    const meanX = calculateMean(x);
    const meanY = calculateMean(y);

    let covariance = 0;
    let stdX = 0;
    let stdY = 0;

    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        covariance += dx * dy;
        stdX += dx * dx;
        stdY += dy * dy;
    }

    stdX = Math.sqrt(stdX);
    stdY = Math.sqrt(stdY);

    if (stdX === 0 || stdY === 0) return 0;
    // Pearson r is mathematically bounded to [-1, 1]; floating-point
    // cancellation with extreme-magnitude inputs can push the quotient
    // slightly outside, so clamp.
    const r = covariance / (stdX * stdY);
    return Math.max(-1, Math.min(1, r));
}

/**
 * Get ranks of values for Spearman correlation
 * @param {number[]} values - Array of numeric values
 * @returns {number[]} Array of ranks
 */
function getRanks(values) {
    const indexed = values.map((value, index) => ({ value, index }));
    indexed.sort((a, b) => a.value - b.value);

    const ranks = new Array(values.length);
    let i = 0;

    while (i < indexed.length) {
        let j = i;
        while (j < indexed.length && indexed[j].value === indexed[i].value) {
            j++;
        }
        const avgRank = (i + j + 1) / 2;
        for (let k = i; k < j; k++) {
            ranks[indexed[k].index] = avgRank;
        }
        i = j;
    }

    return ranks;
}

/**
 * Calculate Spearman rank correlation coefficient
 * @param {number[]} x - First array of values
 * @param {number[]} y - Second array of values
 * @returns {number|null} Spearman correlation coefficient or null if invalid
 */
function calculateSpearmanCorrelation(x, y) {
    const ranksX = getRanks(x);
    const ranksY = getRanks(y);
    return calculatePearsonCorrelation(ranksX, ranksY);
}

/**
 * Calculate skewness of a distribution.
 *
 * Adjusted Fisher–Pearson coefficient G1 (what Excel SKEW / pandas `.skew()`
 * report). The n/((n-1)(n-2)) factor belongs with the *sample* standard
 * deviation; pairing it with the population one inflates the result by
 * (n/(n-1))^1.5.
 *
 * @param {number[]} values - Array of numeric values
 * @returns {number} Skewness value
 */
function calculateSkewness(values) {
    if (!values || values.length < 3) return 0;
    const n = values.length;
    const mean = calculateMean(values);
    const stdDev = calculateSampleStdDev(values, mean);
    if (stdDev === 0) return 0;

    let sum = 0;
    for (let i = 0; i < n; i++) {
        const z = (values[i] - mean) / stdDev;
        sum += z * z * z;
    }
    return (n / ((n - 1) * (n - 2))) * sum;
}

/**
 * Calculate kurtosis of a distribution.
 *
 * Sample excess kurtosis G2 (Excel KURT / pandas `.kurt()`); like G1 above it
 * is defined on the sample standard deviation.
 *
 * @param {number[]} values - Array of numeric values
 * @returns {number} Kurtosis value (excess kurtosis, 0 for normal distribution)
 */
function calculateKurtosis(values) {
    if (!values || values.length < 4) return 0;
    const n = values.length;
    const mean = calculateMean(values);
    const stdDev = calculateSampleStdDev(values, mean);
    if (stdDev === 0) return 0;

    let sum = 0;
    for (let i = 0; i < n; i++) {
        const z = (values[i] - mean) / stdDev;
        const z2 = z * z;
        sum += z2 * z2;
    }
    const factor = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
    const nm1 = n - 1;
    const correction = (3 * nm1 * nm1) / ((n - 2) * (n - 3));

    return factor * sum - correction;
}

/**
 * Chi-squared quantile for a confidence level given as a one-sided normal
 * z-score (Wilson–Hilferty approximation).
 *
 * The detector nodes expose a "sigma-like" threshold; this turns it into the
 * matching control limit for a statistic that is chi-squared distributed with
 * `df` degrees of freedom (squared Mahalanobis distance, Hotelling's T², SPE),
 * so the same threshold means the same false-alarm rate regardless of how many
 * dimensions are monitored. `df` may be fractional. Accurate to a few percent
 * for df >= 1.
 *
 * @param {number} df - Degrees of freedom (> 0)
 * @param {number} z - Normal quantile of the confidence level (e.g. 3 ≈ 99.87%)
 * @returns {number} Chi-squared quantile (0 when df is not positive)
 */
function chiSquaredQuantileFromZ(df, z) {
    if (!Number.isFinite(df) || df <= 0 || !Number.isFinite(z)) return 0;
    const a = 2 / (9 * df);
    const base = 1 - a + z * Math.sqrt(a);
    return base <= 0 ? 0 : df * base * base * base;
}

/**
 * F-distribution quantile for a confidence level given as a one-sided normal
 * z-score (Paulson's approximation, the F counterpart of Wilson–Hilferty).
 *
 * @param {number} d1 - Numerator degrees of freedom (> 0)
 * @param {number} d2 - Denominator degrees of freedom (> 0)
 * @param {number} z - Normal quantile of the confidence level
 * @returns {number} F quantile, or Infinity when d2 is too small for the
 *          requested confidence to have a finite, trustworthy limit
 */
function fQuantileFromZ(d1, d2, z) {
    if (!(d1 > 0) || !(d2 > 0) || !Number.isFinite(z)) return Infinity;
    const a = 1 - 2 / (9 * d2);
    const b = 1 - 2 / (9 * d1);
    const c = 2 / (9 * d2);
    const d = 2 / (9 * d1);
    // Solve (a·w − b)² = z²(c·w² + d) for w = F^(1/3)
    const qa = a * a - z * z * c;
    if (qa <= 0) return Infinity;
    const disc = a * a * b * b - qa * (b * b - z * z * d);
    if (disc < 0) return Infinity;
    const w = (a * b + Math.sqrt(disc)) / qa;
    return w <= 0 ? 0 : w * w * w;
}

/**
 * Control limit for the squared Mahalanobis distance / Hotelling's T² of a NEW
 * observation against a mean and covariance estimated from `n` reference
 * samples in `p` dimensions:
 *
 *     p (n + 1)(n − 1) / (n (n − p)) · F(p, n − p)
 *
 * With plenty of reference data this converges to the chi-squared quantile;
 * with little data it is considerably wider, because the covariance estimate
 * itself is uncertain — using the chi-squared limit there raises a steady
 * stream of false alarms. Falls back to the chi-squared quantile when `n` is
 * unknown, and returns Infinity when there are too few samples (n − p < 1 or
 * the F quantile does not exist) for any finite limit to be justified.
 *
 * @param {number} p - Number of dimensions / retained components
 * @param {number} n - Number of reference samples
 * @param {number} z - Normal quantile of the confidence level (e.g. 3)
 * @returns {number} Limit for the SQUARED distance
 */
function hotellingLimitFromZ(p, n, z) {
    if (!(p > 0) || !Number.isFinite(z)) return 0;
    if (!Number.isFinite(n)) return chiSquaredQuantileFromZ(p, z);
    if (n - p < 1) return Infinity;
    return ((p * (n + 1) * (n - 1)) / (n * (n - p))) * fQuantileFromZ(p, n - p, z);
}

/**
 * Calculate Root Mean Square (RMS)
 * @param {number[]} values - Array of numeric values
 * @returns {number} RMS value
 */
function calculateRMS(values) {
    if (!values || values.length === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < values.length; i++) {
        sumSquares += values[i] * values[i];
    }
    return Math.sqrt(sumSquares / values.length);
}

/**
 * Calculate Crest Factor (peak to RMS ratio)
 * @param {number[]} values - Array of numeric values
 * @returns {number} Crest factor
 */
function calculateCrestFactor(values) {
    if (!values || values.length === 0) return 0;
    const rms = calculateRMS(values);
    if (rms === 0) return 0;
    let peak = 0;
    for (let i = 0; i < values.length; i++) {
        const a = values[i] < 0 ? -values[i] : values[i];
        if (a > peak) peak = a;
    }
    return peak / rms;
}

/**
 * Calculate moving average using a rolling-sum (O(n) total)
 * @param {number[]} values - Array of numeric values
 * @param {number} windowSize - Size of the moving window
 * @returns {number[]} Array of moving averages, one per input position
 */
function calculateMovingAverage(values, windowSize) {
    if (!values || values.length === 0 || windowSize < 1) return [];
    const result = new Array(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= windowSize) {
            sum -= values[i - windowSize];
        }
        const count = i < windowSize ? i + 1 : windowSize;
        result[i] = sum / count;
    }
    return result;
}

/**
 * Calculate exponential moving average
 * @param {number[]} values - Array of numeric values
 * @param {number} alpha - Smoothing factor (0-1)
 * @returns {number[]} Array of EMA values
 */
function calculateEMA(values, alpha) {
    if (!values || values.length === 0) return [];
    const result = [values[0]];
    for (let i = 1; i < values.length; i++) {
        result.push(alpha * values[i] + (1 - alpha) * result[i - 1]);
    }
    return result;
}

/**
 * Online running statistics (Welford's algorithm).
 *
 * Maintains count, mean and variance of a stream in O(1) per update.
 * Numerically stable and avoids re-iterating a sliding buffer for every sample.
 *
 * @example
 * const r = new RunningStats();
 * r.push(42);
 * r.push(43);
 * r.mean();    // 42.5
 * r.stdDev();  // population std dev
 */
class RunningStats {
    constructor() {
        this.n = 0;
        this._mean = 0;
        this._m2 = 0; // sum of squared differences from current mean
    }

    /** Add a sample. Non-finite values are ignored. */
    push(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        this.n++;
        const delta = value - this._mean;
        this._mean += delta / this.n;
        const delta2 = value - this._mean;
        this._m2 += delta * delta2;
    }

    /**
     * Remove a previously pushed sample (Welford's reverse update).
     *
     * Be aware: the reverse update is *less* numerically stable than the
     * forward update. On streams whose magnitude varies sharply (e.g. a
     * single large value followed by many zeros) the std-dev can drift
     * by a few ULPs of the magnitude over thousands of remove operations.
     * Property-based tests in `test/utils-statistics-prop_spec.js` allow a
     * relative tolerance of ~1e-3 for that reason.
     *
     * Callers that need bit-exact reproducibility on a sliding window can
     * call `reset()` once the buffer fully turns over and re-push the live
     * window from scratch.
     */
    remove(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        if (this.n <= 1) {
            this.n = 0;
            this._mean = 0;
            this._m2 = 0;
            return;
        }
        const newN = this.n - 1;
        const newMean = (this._mean * this.n - value) / newN;
        // m2_new = m2_old - (x - mean_old) * (x - mean_new)
        this._m2 -= (value - this._mean) * (value - newMean);
        if (this._m2 < 0) this._m2 = 0; // guard against floating-point drift
        this._mean = newMean;
        this.n = newN;
    }

    count() {
        return this.n;
    }
    mean() {
        return this.n === 0 ? 0 : this._mean;
    }
    /** Population variance (1/n). */
    variance() {
        return this.n === 0 ? 0 : this._m2 / this.n;
    }
    /** Sample variance (1/(n-1), Bessel-corrected). */
    sampleVariance() {
        return this.n < 2 ? 0 : this._m2 / (this.n - 1);
    }
    stdDev() {
        return Math.sqrt(this.variance());
    }
    sampleStdDev() {
        return Math.sqrt(this.sampleVariance());
    }
    reset() {
        this.n = 0;
        this._mean = 0;
        this._m2 = 0;
    }
}

/**
 * Validate that a value is a finite number
 * @param {*} value - Value to validate
 * @returns {boolean} True if value is a finite number
 */
function isValidNumber(value) {
    return typeof value === "number" && isFinite(value);
}

/**
 * Filter array to only valid numbers
 * @param {*[]} values - Array that may contain non-numeric values
 * @returns {number[]} Array with only valid numbers
 */
function filterValidNumbers(values) {
    if (!Array.isArray(values)) return [];
    return values.filter(isValidNumber);
}

module.exports = {
    // Basic statistics
    calculateMean,
    calculateStdDev,
    calculateSampleStdDev,
    calculateVariance,
    calculateMedian,
    calculateQuartiles,
    calculatePercentile,
    calculatePercentileSorted,

    // Anomaly detection helpers
    calculateZScore,
    calculateIQRBounds,
    chiSquaredQuantileFromZ,
    fQuantileFromZ,
    hotellingLimitFromZ,

    // Correlation
    calculatePearsonCorrelation,
    calculateSpearmanCorrelation,
    getRanks,

    // Distribution shape
    calculateSkewness,
    calculateKurtosis,

    // Signal processing basics
    calculateRMS,
    calculateCrestFactor,
    calculateMovingAverage,
    calculateEMA,

    // Streaming
    RunningStats,

    // Validation
    isValidNumber,
    filterValidNumbers
};
