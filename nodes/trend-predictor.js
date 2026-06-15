module.exports = function (RED) {
    "use strict";

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");
    const { clampInt, clampFloat } = require("./utils/config-validator");

    function TrendPredictorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        this.mode = config.mode || "prediction"; // prediction, rate-of-change, rul
        this.method = config.method || "linear"; // linear, exponential
        this.predictionSteps = clampInt(config.predictionSteps, 1, 100000, 10);
        this.windowSize = clampInt(config.windowSize, 2, 1000000, 50);
        this.threshold =
            config.threshold !== "" && config.threshold !== undefined ? parseFloat(config.threshold) : null;

        // Rate of change settings
        this.rocMethod = config.rocMethod || "absolute"; // absolute, percentage
        this.timeWindow = clampInt(config.timeWindow, 1, 1000000, 1);
        this.rocThreshold =
            config.rocThreshold !== "" && config.rocThreshold !== undefined ? parseFloat(config.rocThreshold) : null;

        // RUL settings
        this.failureThreshold =
            config.failureThreshold !== "" && config.failureThreshold !== undefined
                ? parseFloat(config.failureThreshold)
                : null;
        this.warningThreshold =
            config.warningThreshold !== "" && config.warningThreshold !== undefined
                ? parseFloat(config.warningThreshold)
                : null;
        this.rulUnit = config.rulUnit || "hours"; // hours, minutes, days, cycles
        this.degradationModel = config.degradationModel || "linear"; // linear, exponential, weibull
        this.confidenceLevel = clampFloat(config.confidenceLevel, 0.5, 0.9999, 0.95);

        // Weibull settings
        this.weibullBeta = clampFloat(config.weibullBeta, 0.01, 100, 2.0); // Shape parameter (β)
        this.weibullEta = clampFloat(config.weibullEta, 0.001, 1e9, 1000); // Scale parameter (η) in hours

        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        this.persistState = config.persistState === true;

        // State
        this.buffer = [];

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debug) {
                node.debug(message);
            }
        };
        this.timestamps = [];
        this.previousValue = null;
        this.previousTimestamp = null;
        this.rocHistory = [];

        // Initialize state persistence using helper
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "trendPredictorState",
            saveInterval: 30000,
            debug: node.debug,
            onStateLoaded: function (state) {
                if (state.buffer && state.buffer.length > 0) {
                    node.buffer = state.buffer;
                    node.timestamps = state.timestamps || [];
                    node.previousValue = state.previousValue;
                    node.previousTimestamp = state.previousTimestamp;
                    node.rocHistory = state.rocHistory || [];

                    debugLog("Restored " + node.buffer.length + " buffered values from persistence");
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: node.mode + " - restored (" + node.buffer.length + ")"
                    });
                }
            },
            getStateToSave: function () {
                return {
                    buffer: node.buffer,
                    timestamps: node.timestamps,
                    previousValue: node.previousValue,
                    previousTimestamp: node.previousTimestamp,
                    rocHistory: node.rocHistory
                };
            }
        });

        // Helper to persist current state
        function persistCurrentState() {
            if (persistence) {
                persistence.saveNow();
            }
        }

        node.status({ fill: "blue", shape: "ring", text: node.mode + " mode" });

        // Linear Regression
        function linearRegression(data, steps) {
            const n = data.length;
            const x = [];
            for (let i = 0; i < n; i++) x.push(i);

            const meanX =
                x.reduce(function (a, b) {
                    return a + b;
                }, 0) / n;
            const meanY =
                data.reduce(function (a, b) {
                    return a + b;
                }, 0) / n;

            let numerator = 0;
            let denominator = 0;

            for (let i = 0; i < n; i++) {
                numerator += (x[i] - meanX) * (data[i] - meanY);
                denominator += Math.pow(x[i] - meanX, 2);
            }

            const slope = denominator !== 0 ? numerator / denominator : 0;
            const intercept = meanY - slope * meanX;

            const predictedValues = [];
            for (let i = 1; i <= steps; i++) {
                const futureX = n + i - 1;
                predictedValues.push(slope * futureX + intercept);
            }

            let trend = "stable";
            if (Math.abs(slope) > 0.01) {
                trend = slope > 0 ? "increasing" : "decreasing";
            }

            return {
                slope: slope,
                intercept: intercept,
                predictedValues: predictedValues,
                trend: trend
            };
        }

        // Exponential Smoothing
        function exponentialSmoothing(data, steps) {
            const alpha = 0.3;
            const beta = 0.1;

            let level = data[0];
            let trend = data.length > 1 ? data[1] - data[0] : 0;

            for (let i = 1; i < data.length; i++) {
                const prevLevel = level;
                level = alpha * data[i] + (1 - alpha) * (level + trend);
                trend = beta * (level - prevLevel) + (1 - beta) * trend;
            }

            const predictedValues = [];
            for (let i = 1; i <= steps; i++) {
                predictedValues.push(level + i * trend);
            }

            let trendDirection = "stable";
            if (Math.abs(trend) > 0.01) {
                trendDirection = trend > 0 ? "increasing" : "decreasing";
            }

            return {
                slope: trend,
                intercept: level,
                predictedValues: predictedValues,
                trend: trendDirection
            };
        }

        function calculateStepsToThreshold(predictedValues, threshold) {
            for (let i = 0; i < predictedValues.length; i++) {
                if (predictedValues[i] >= threshold) {
                    return i + 1;
                }
            }
            return null;
        }

        // Moving Average Smoothing - reduces noise before RUL calculation
        function smoothData(data, windowSize) {
            if (data.length < windowSize) {
                windowSize = data.length;
            }
            if (windowSize < 2) return data.slice();

            const smoothed = [];
            const halfWindow = Math.floor(windowSize / 2);

            for (let i = 0; i < data.length; i++) {
                const start = Math.max(0, i - halfWindow);
                const end = Math.min(data.length, i + halfWindow + 1);
                let sum = 0;
                for (let j = start; j < end; j++) {
                    sum += data[j];
                }
                smoothed.push(sum / (end - start));
            }
            return smoothed;
        }

        // Median filter - removes outliers before trend calculation
        function medianFilter(data, windowSize) {
            if (data.length < windowSize) return data.slice();
            if (windowSize < 3) windowSize = 3;
            if (windowSize % 2 === 0) windowSize++; // Ensure odd window size

            const filtered = [];
            const halfWindow = Math.floor(windowSize / 2);

            for (let i = 0; i < data.length; i++) {
                const start = Math.max(0, i - halfWindow);
                const end = Math.min(data.length, i + halfWindow + 1);
                const window = data.slice(start, end).sort(function (a, b) {
                    return a - b;
                });
                filtered.push(window[Math.floor(window.length / 2)]);
            }
            return filtered;
        }

        // Robust slope calculation using Theil-Sen estimator (median of slopes)
        function robustSlope(data) {
            if (data.length < 2) return 0;

            const slopes = [];
            // For efficiency, sample pairs if data is large
            const step = data.length > 50 ? Math.floor(data.length / 25) : 1;

            for (let i = 0; i < data.length; i += step) {
                for (let j = i + 1; j < data.length; j += step) {
                    if (j !== i) {
                        slopes.push((data[j] - data[i]) / (j - i));
                    }
                }
            }

            if (slopes.length === 0) return 0;

            // Return median slope
            slopes.sort(function (a, b) {
                return a - b;
            });
            return slopes[Math.floor(slopes.length / 2)];
        }

        // Weibull distribution functions
        function weibullReliability(t, beta, eta) {
            // R(t) = exp(-(t/eta)^beta)
            return Math.exp(-Math.pow(t / eta, beta));
        }

        function weibullHazard(t, beta, eta) {
            // h(t) = (beta/eta) * (t/eta)^(beta-1)
            return (beta / eta) * Math.pow(t / eta, beta - 1);
        }

        function weibullMTTF(beta, eta) {
            // MTTF = eta * Gamma(1 + 1/beta)
            // Approximation of Gamma function for 1 + 1/beta
            const x = 1 + 1 / beta;
            return eta * gammaApprox(x);
        }

        // Calculate B-Life (time at which X% of population has failed)
        function weibullBLife(beta, eta, percentFailed) {
            // B_x = eta * (-ln(1 - x/100))^(1/beta)
            return eta * Math.pow(-Math.log(1 - percentFailed / 100), 1 / beta);
        }

        // Interpret Weibull beta parameter
        function interpretBeta(beta) {
            if (beta < 1) {
                return {
                    phase: "infant_mortality",
                    trend: "decreasing failure rate",
                    recommendation: "Check manufacturing/installation quality"
                };
            } else if (beta === 1) {
                return {
                    phase: "useful_life",
                    trend: "constant failure rate",
                    recommendation: "Normal maintenance schedule"
                };
            } else if (beta < 4) {
                return {
                    phase: "wear_out",
                    trend: "increasing failure rate",
                    recommendation: "Preventive replacement recommended"
                };
            } else {
                return {
                    phase: "rapid_wear_out",
                    trend: "strongly increasing failure rate",
                    recommendation: "Time-based replacement critical"
                };
            }
        }

        function gammaApprox(z) {
            // Lanczos approximation for Gamma function
            if (!Number.isFinite(z) || z <= 0) return 1; // Safe fallback for invalid inputs
            if (z < 0.5) {
                const sinPiZ = Math.sin(Math.PI * z);
                if (sinPiZ === 0) return 1; // Avoid division by zero at integer values
                return Math.PI / (sinPiZ * gammaApprox(1 - z));
            }
            z -= 1;
            const g = 7;
            const c = [
                0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
                12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
            ];
            let x = c[0];
            for (let i = 1; i < g + 2; i++) {
                x += c[i] / (z + i);
            }
            const t = z + g + 0.5;
            const result = Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
            return Number.isFinite(result) ? result : 1;
        }

        // Estimate Weibull parameters from failure data using MLE
        function estimateWeibullParams(data, timestamps) {
            if (data.length < 3) return null;

            // Normalize data to represent degradation fraction (0 to 1)
            const maxVal = Math.max.apply(null, data);
            const minVal = Math.min.apply(null, data);
            const range = maxVal - minVal;

            if (range === 0) return null;

            // Use simple estimation based on degradation trend
            const n = data.length;
            const avgInterval = (timestamps[n - 1] - timestamps[0]) / (n - 1);

            // Calculate degradation rate
            const result = linearRegression(data, 1);
            const slope = result.slope;

            if (slope <= 0) return null;

            // Estimate eta (characteristic life) from degradation rate
            const currentDegradation = (data[n - 1] - minVal) / range;
            const timeElapsed = (n - 1) * avgInterval;

            // Estimate beta from variance of degradation
            const mean = data.reduce((a, b) => a + b, 0) / n;
            const variance = data.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
            const cv = Math.sqrt(variance) / mean; // Coefficient of variation

            // Beta estimation: higher CV suggests lower beta (more variable)
            const beta = cv > 0 ? Math.max(0.5, Math.min(5, 1 / cv)) : 2.0;

            // Eta estimation from current reliability
            const reliability = 1 - currentDegradation;
            if (reliability > 0 && reliability < 1) {
                const eta = timeElapsed / Math.pow(-Math.log(reliability), 1 / beta);
                return { beta: beta, eta: eta };
            }

            return null;
        }

        /**
         * Calculate Remaining Useful Life (RUL) with confidence intervals.
         *
         * Estimates time until a monitored value reaches a failure threshold using
         * one of several degradation models: linear, exponential, or Weibull.
         *
         * The function performs:
         * 1. Input validation (rejects NaN/Infinity values)
         * 2. Median filtering to remove outliers
         * 3. Moving average smoothing to reduce noise
         * 4. Robust slope estimation using Theil-Sen estimator
         * 5. RUL calculation based on selected degradation model
         * 6. Confidence interval estimation
         *
         * @param {number[]} data - Array of sensor readings (degradation indicator)
         * @param {number[]} timestamps - Array of timestamps (ms since epoch)
         * @param {number} failureThreshold - Value at which failure is defined
         * @param {string} method - Degradation model: 'linear', 'exponential', or 'weibull'
         * @param {number} confidenceLevel - Confidence level for intervals (e.g., 0.95)
         * @returns {Object|null} RUL result object or null if calculation fails
         * @returns {number} returns.rul - Estimated time to failure in ms
         * @returns {number} returns.rulLower - Lower confidence bound
         * @returns {number} returns.rulUpper - Upper confidence bound
         * @returns {number} returns.confidence - Confidence score (0-1)
         * @returns {string} returns.status - 'healthy', 'warning', 'critical', 'failed', or 'stable'
         * @returns {number} returns.percentDegraded - Percentage of degradation (0-100)
         * @returns {number} returns.degradationRate - Rate of degradation per sample
         * @returns {string} returns.trend - Trend direction: 'improving', 'stable', 'degrading'
         * @returns {Object} [returns.weibull] - Weibull-specific parameters (if method='weibull')
         */
        function calculateRUL(data, timestamps, failureThreshold, method, _confidenceLevel) {
            if (data.length < 5) return null;

            let n = data.length;
            let currentValue = data[n - 1];

            // STABILITY: Validate inputs to prevent NaN propagation
            if (!Number.isFinite(currentValue)) {
                debugLog("RUL: Current value is not finite: " + currentValue);
                return null;
            }

            if (!Number.isFinite(failureThreshold)) {
                debugLog("RUL: Failure threshold is not finite: " + failureThreshold);
                return null;
            }

            // STABILITY: Filter out any NaN/Infinity values from data
            const validData = [];
            const validTimestamps = [];
            for (let i = 0; i < data.length; i++) {
                if (Number.isFinite(data[i]) && Number.isFinite(timestamps[i])) {
                    validData.push(data[i]);
                    validTimestamps.push(timestamps[i]);
                }
            }

            if (validData.length < 5) {
                debugLog("RUL: Not enough valid data points after filtering: " + validData.length);
                return null;
            }

            // Use filtered data from here
            data = validData;
            timestamps = validTimestamps;
            n = data.length;
            currentValue = data[n - 1];

            // Already failed?
            if (currentValue >= failureThreshold) {
                return {
                    rul: 0,
                    confidence: 1.0,
                    status: "failed",
                    percentDegraded: 100,
                    model: method
                };
            }

            // Step 1: Apply median filter to remove outliers
            const filteredData = medianFilter(data, 5);

            // Step 2: Apply moving average smoothing to reduce noise
            const smoothingWindow = Math.max(3, Math.floor(n / 10));
            const smoothedData = smoothData(filteredData, smoothingWindow);

            // Step 3: Calculate robust slope using Theil-Sen estimator
            const robustSlopeValue = robustSlope(smoothedData);

            // Step 4: Also calculate standard linear regression for comparison
            const result = linearRegression(smoothedData, 1000);
            const linearSlopeValue = result.slope;

            // Use weighted average of robust and linear slope
            // Robust slope is more reliable but linear gives better R-squared
            const slope = 0.7 * robustSlopeValue + 0.3 * linearSlopeValue;

            // Use smoothed current value for more stable estimate
            const smoothedCurrentValue = smoothedData[n - 1];

            debugLog(
                "RUL: raw_slope=" +
                    linearSlopeValue.toFixed(4) +
                    ", robust_slope=" +
                    robustSlopeValue.toFixed(4) +
                    ", combined=" +
                    slope.toFixed(4)
            );

            // No degradation or improving
            // Use a small positive threshold to avoid false "stable" with noisy data
            const minSlope = 0.0001;
            if (slope <= minSlope) {
                return {
                    rul: Infinity,
                    confidence: 0.5,
                    status: "stable",
                    percentDegraded: (smoothedCurrentValue / failureThreshold) * 100,
                    trend: slope < -minSlope ? "improving" : "stable",
                    model: method,
                    smoothedValue: smoothedCurrentValue,
                    rawSlope: linearSlopeValue,
                    robustSlope: robustSlopeValue
                };
            }

            // Calculate average time between samples
            let avgInterval = 0;
            if (timestamps.length >= 2) {
                const totalTime = timestamps[n - 1] - timestamps[0];
                avgInterval = totalTime / (n - 1);
            } else {
                avgInterval = 1000; // Default 1 second
            }

            let timeToFailure, rulLower, rulUpper, confidence, weibullInfo;

            if (method === "weibull") {
                // Weibull-based RUL estimation
                const weibullParams = estimateWeibullParams(data, timestamps);

                if (weibullParams) {
                    const beta = weibullParams.beta;
                    const eta = weibullParams.eta;
                    const timeElapsed = (n - 1) * avgInterval;

                    // Current reliability
                    const currentReliability = weibullReliability(timeElapsed, beta, eta);

                    // Target reliability at failure (e.g., 10%)
                    const targetReliability = 0.1;

                    // Time to target reliability
                    const timeAtTarget = eta * Math.pow(-Math.log(targetReliability), 1 / beta);
                    timeToFailure = Math.max(0, timeAtTarget - timeElapsed);

                    // Confidence bounds (rough approximation)
                    const hazardRate = weibullHazard(timeElapsed, beta, eta);
                    const stdTime = 1 / (hazardRate * Math.sqrt(n));
                    rulLower = Math.max(0, timeToFailure - 1.96 * stdTime);
                    rulUpper = timeToFailure + 1.96 * stdTime;

                    // Confidence from R-squared of fit
                    confidence = Math.max(
                        0.3,
                        1 - Math.abs(currentReliability - (1 - currentValue / failureThreshold))
                    );

                    const betaInterpretation = interpretBeta(beta);
                    weibullInfo = {
                        beta: beta,
                        eta: eta,
                        currentReliability: currentReliability,
                        hazardRate: hazardRate,
                        mttf: weibullMTTF(beta, eta),
                        failureMode: betaInterpretation.phase,
                        interpretation: betaInterpretation,
                        bLife: {
                            B1: weibullBLife(beta, eta, 1),
                            B5: weibullBLife(beta, eta, 5),
                            B10: weibullBLife(beta, eta, 10),
                            B50: weibullBLife(beta, eta, 50)
                        }
                    };
                } else {
                    // Fall back to linear if Weibull estimation fails
                    method = "linear";
                }
            }

            if (method !== "weibull") {
                // Linear or exponential method - use smoothed value
                const stepsToFailure = (failureThreshold - smoothedCurrentValue) / slope;
                timeToFailure = stepsToFailure * avgInterval;

                // Calculate R-squared for confidence
                const yMean = data.reduce((a, b) => a + b, 0) / n;
                const ssTot = data.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);
                let ssRes = 0;
                for (let i = 0; i < n; i++) {
                    const predicted = result.intercept + result.slope * i;
                    ssRes += Math.pow(data[i] - predicted, 2);
                }
                confidence = ssTot > 0 ? 1 - ssRes / ssTot : 0;

                // Calculate prediction interval
                const stdError = Math.sqrt(ssRes / Math.max(1, n - 2));
                const zScore = 1.96;
                const margin = zScore * stdError * Math.sqrt(1 + 1 / n);

                // Use the same smoothed value as the point estimate so the interval
                // is centred on `rul` and actually brackets it.
                rulLower = ((failureThreshold - margin - smoothedCurrentValue) / slope) * avgInterval;
                rulUpper = ((failureThreshold + margin - smoothedCurrentValue) / slope) * avgInterval;
            }

            let status = "healthy";
            if (timeToFailure < avgInterval * 10) status = "critical";
            else if (timeToFailure < avgInterval * 50) status = "warning";

            // STABILITY: Ensure all returned values are valid numbers
            const rulResult = {
                rul: Number.isFinite(timeToFailure) ? timeToFailure : null,
                rulLower: Number.isFinite(rulLower) ? Math.max(0, rulLower) : null,
                rulUpper: Number.isFinite(rulUpper) ? rulUpper : null,
                confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
                status: status,
                percentDegraded: Number.isFinite(smoothedCurrentValue / failureThreshold)
                    ? Math.min(100, (smoothedCurrentValue / failureThreshold) * 100)
                    : null,
                degradationRate: Number.isFinite(slope) ? slope : null,
                trend: result.trend,
                model: method,
                weibull: weibullInfo,
                smoothedValue: Number.isFinite(smoothedCurrentValue) ? smoothedCurrentValue : null,
                rawSlope: Number.isFinite(linearSlopeValue) ? linearSlopeValue : null,
                robustSlope: Number.isFinite(robustSlopeValue) ? robustSlopeValue : null
            };

            // STABILITY: If RUL is null/invalid, treat as stable
            if (rulResult.rul === null) {
                rulResult.rul = Infinity;
                rulResult.status = "stable";
                rulResult.confidence = 0.3; // Low confidence for fallback
                debugLog("RUL: timeToFailure was invalid, treating as stable");
            }

            return rulResult;
        }

        // Process RUL mode with configurable thresholds (for msg.config override)
        function processRULWithConfig(msg, value, timestamp, failureThreshold, warningThreshold) {
            node.buffer.push(value);
            node.timestamps.push(timestamp);

            if (node.buffer.length > node.windowSize) {
                node.buffer.shift();
                node.timestamps.shift();
            }

            // Persist state periodically (every 10th sample to reduce overhead)
            if (node.stateManager && node.buffer.length % 10 === 0) {
                persistCurrentState();
            }

            if (node.buffer.length < 5) {
                node.status({ fill: "yellow", shape: "ring", text: "RUL: collecting " + node.buffer.length + "/5" });
                return null;
            }

            if (failureThreshold === null) {
                node.status({ fill: "red", shape: "ring", text: "RUL: no threshold set" });
                return null;
            }

            const rulResult = calculateRUL(
                node.buffer,
                node.timestamps,
                failureThreshold,
                node.degradationModel,
                node.confidenceLevel
            );

            if (!rulResult) return null;

            // Convert RUL to specified unit
            let rulValue = rulResult.rul;
            let unitLabel = "";
            if (rulResult.rul !== Infinity) {
                switch (node.rulUnit) {
                    case "minutes":
                        rulValue = rulResult.rul / 60000;
                        unitLabel = "min";
                        break;
                    case "hours":
                        rulValue = rulResult.rul / 3600000;
                        unitLabel = "h";
                        break;
                    case "days":
                        rulValue = rulResult.rul / 86400000;
                        unitLabel = "d";
                        break;
                    case "cycles":
                        rulValue = rulResult.rul; // Already in steps
                        unitLabel = "cycles";
                        break;
                }
            }

            const outputMsg = {
                payload: value,
                rul: {
                    value: rulValue,
                    unit: node.rulUnit,
                    lower: rulResult.rulLower
                        ? rulResult.rulLower /
                          (node.rulUnit === "hours"
                              ? 3600000
                              : node.rulUnit === "minutes"
                                ? 60000
                                : node.rulUnit === "days"
                                  ? 86400000
                                  : 1)
                        : null,
                    upper: rulResult.rulUpper
                        ? rulResult.rulUpper /
                          (node.rulUnit === "hours"
                              ? 3600000
                              : node.rulUnit === "minutes"
                                ? 60000
                                : node.rulUnit === "days"
                                  ? 86400000
                                  : 1)
                        : null,
                    confidence: rulResult.confidence,
                    status: rulResult.status
                },
                degradation: {
                    percent: rulResult.percentDegraded,
                    rate: rulResult.degradationRate,
                    trend: rulResult.trend
                },
                thresholds: {
                    failure: failureThreshold,
                    warning: warningThreshold
                },
                currentValue: value,
                timestamp: timestamp
            };

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            // Status display
            const statusColor =
                rulResult.status === "critical"
                    ? "red"
                    : rulResult.status === "warning"
                      ? "yellow"
                      : rulResult.status === "failed"
                        ? "red"
                        : "green";
            const statusText =
                rulResult.rul === Infinity
                    ? "RUL: ∞ (stable)"
                    : rulResult.rul === 0
                      ? "FAILED"
                      : "RUL: " +
                        rulValue.toFixed(1) +
                        unitLabel +
                        " (" +
                        (rulResult.confidence * 100).toFixed(0) +
                        "%)";

            node.status({
                fill: statusColor,
                shape: rulResult.status === "healthy" ? "dot" : "ring",
                text: statusText
            });

            const isAnomaly =
                rulResult.status === "critical" ||
                rulResult.status === "failed" ||
                (warningThreshold !== null && value >= warningThreshold);

            return { normal: isAnomaly ? null : outputMsg, anomaly: isAnomaly ? outputMsg : null };
        }

        // Process Trend Prediction with configurable parameters (for msg.config override)
        function processPredictionWithConfig(msg, value, timestamp, threshold, predictionSteps) {
            node.buffer.push(value);
            node.timestamps.push(timestamp);

            if (node.buffer.length > node.windowSize) {
                node.buffer.shift();
                node.timestamps.shift();
            }

            // Persist state periodically (every 10th sample to reduce overhead)
            if (node.stateManager && node.buffer.length % 10 === 0) {
                persistCurrentState();
            }

            if (node.buffer.length < 3) {
                node.status({ fill: "yellow", shape: "ring", text: "Buffering: " + node.buffer.length + "/3" });
                return null;
            }

            let prediction = null;
            if (node.method === "linear") {
                prediction = linearRegression(node.buffer, predictionSteps);
            } else {
                prediction = exponentialSmoothing(node.buffer, predictionSteps);
            }

            let timeToThreshold = null;
            let stepsToThreshold = null;

            if (threshold !== null && prediction) {
                stepsToThreshold = calculateStepsToThreshold(prediction.predictedValues, threshold);
                if (stepsToThreshold !== null && node.timestamps.length >= 2) {
                    const timeDiffs = [];
                    for (let i = 1; i < node.timestamps.length; i++) {
                        timeDiffs.push(node.timestamps[i] - node.timestamps[i - 1]);
                    }
                    const avgTimeDiff =
                        timeDiffs.reduce(function (a, b) {
                            return a + b;
                        }, 0) / timeDiffs.length;
                    timeToThreshold = stepsToThreshold * avgTimeDiff;
                }
            }

            const outputMsg = {
                payload: value,
                trend: prediction ? prediction.trend : null,
                slope: prediction ? prediction.slope : null,
                predictedValues: prediction ? prediction.predictedValues : [],
                timeToThreshold: timeToThreshold,
                stepsToThreshold: stepsToThreshold,
                bufferSize: node.buffer.length,
                method: node.method,
                timestamp: timestamp
            };

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            if (prediction) {
                const trendIcon = prediction.slope > 0 ? "↗" : prediction.slope < 0 ? "↘" : "→";
                let statusText = trendIcon + " " + prediction.slope.toFixed(3);
                if (timeToThreshold !== null) {
                    const hours = Math.floor(timeToThreshold / 3600000);
                    statusText += " | RUL: " + hours + "h";
                }
                node.status({ fill: "green", shape: "dot", text: statusText });
            }

            return { normal: outputMsg, anomaly: null };
        }

        // Process Rate of Change with configurable threshold (for msg.config override)
        function processRateOfChangeWithConfig(msg, value, timestamp, rocThreshold) {
            node.rocHistory.push({ value: value, timestamp: timestamp });

            const windowMs = node.timeWindow * 1000;
            node.rocHistory = node.rocHistory.filter(function (h) {
                return timestamp - h.timestamp <= windowMs;
            });

            let rateOfChange = null;
            let isAnomalous = false;
            let acceleration = null;

            if (node.previousValue !== null && node.previousTimestamp !== null) {
                const timeDiff = (timestamp - node.previousTimestamp) / 1000;
                const valueDiff = value - node.previousValue;

                if (timeDiff > 0) {
                    if (node.rocMethod === "absolute") {
                        rateOfChange = valueDiff / timeDiff;
                    } else if (node.rocMethod === "percentage") {
                        if (node.previousValue !== 0) {
                            rateOfChange = ((valueDiff / Math.abs(node.previousValue)) * 100) / timeDiff;
                        }
                    }
                }

                if (node.rocHistory.length >= 3) {
                    const rates = [];
                    for (let i = 1; i < node.rocHistory.length; i++) {
                        const dt = (node.rocHistory[i].timestamp - node.rocHistory[i - 1].timestamp) / 1000;
                        const dv = node.rocHistory[i].value - node.rocHistory[i - 1].value;
                        if (dt > 0) {
                            rates.push(dv / dt);
                        }
                    }

                    if (rates.length >= 2) {
                        const lastRate = rates[rates.length - 1];
                        const prevRate = rates[rates.length - 2];
                        const avgTimeDiff = windowMs / 1000 / node.rocHistory.length;
                        acceleration = (lastRate - prevRate) / avgTimeDiff;
                    }
                }

                if (rocThreshold !== null && rateOfChange !== null) {
                    isAnomalous = Math.abs(rateOfChange) > rocThreshold;
                }
            }

            node.previousValue = value;
            node.previousTimestamp = timestamp;

            const outputMsg = {
                payload: value,
                rateOfChange: rateOfChange,
                acceleration: acceleration,
                isAnomalous: isAnomalous,
                method: node.rocMethod,
                timeWindow: node.timeWindow,
                timestamp: timestamp
            };

            Object.keys(msg).forEach(function (key) {
                if (key !== "payload" && !Object.prototype.hasOwnProperty.call(outputMsg, key)) {
                    outputMsg[key] = msg[key];
                }
            });

            if (rateOfChange !== null) {
                const sign = rateOfChange >= 0 ? "+" : "";
                const color = isAnomalous ? "red" : "green";
                const unit = node.rocMethod === "percentage" ? "%/s" : "/s";
                node.status({ fill: color, shape: "dot", text: sign + rateOfChange.toFixed(3) + unit });
            }

            return { normal: isAnomalous ? null : outputMsg, anomaly: isAnomalous ? outputMsg : null };
        }

        // Multi-sensor state buffers
        node.sensorBuffers = {};
        node.sensorTimestamps = {};
        node.sensorPrevious = {};
        node.sensorRocHistory = {};

        // Process multi-sensor JSON input
        function processMultiSensorInput(msg, sensorData) {
            const results = {};
            let anyThresholdExceeded = false;
            const exceededSensors = [];
            const timestamp = msg.timestamp || Date.now();

            const sensorNames = Object.keys(sensorData);

            sensorNames.forEach(function (sensorName) {
                const value = parseFloat(sensorData[sensorName]);
                if (isNaN(value)) return;

                // Initialize per-sensor buffers if needed
                if (!node.sensorBuffers[sensorName]) {
                    node.sensorBuffers[sensorName] = [];
                    node.sensorTimestamps[sensorName] = [];
                    node.sensorPrevious[sensorName] = { value: null, timestamp: null };
                    node.sensorRocHistory[sensorName] = [];
                }

                // Add to sensor buffer
                node.sensorBuffers[sensorName].push(value);
                node.sensorTimestamps[sensorName].push(timestamp);
                if (node.sensorBuffers[sensorName].length > node.windowSize) {
                    node.sensorBuffers[sensorName].shift();
                    node.sensorTimestamps[sensorName].shift();
                }

                let sensorResult = {};

                if (node.mode === "prediction") {
                    if (node.sensorBuffers[sensorName].length >= 3) {
                        const regression = linearRegression(node.sensorBuffers[sensorName], node.predictionSteps);
                        sensorResult = {
                            value: value,
                            trend:
                                regression.slope > 0.01
                                    ? "increasing"
                                    : regression.slope < -0.01
                                      ? "decreasing"
                                      : "stable",
                            slope: regression.slope,
                            predictedValues: regression.predictedValues,
                            bufferSize: node.sensorBuffers[sensorName].length
                        };

                        if (node.threshold !== null) {
                            const stepsToThreshold =
                                regression.slope !== 0
                                    ? Math.ceil((node.threshold - value) / regression.slope)
                                    : Infinity;
                            sensorResult.stepsToThreshold = stepsToThreshold > 0 ? stepsToThreshold : 0;
                            if (
                                value >= node.threshold ||
                                (stepsToThreshold > 0 && stepsToThreshold <= node.predictionSteps)
                            ) {
                                anyThresholdExceeded = true;
                                exceededSensors.push(sensorName);
                            }
                        }
                    } else {
                        sensorResult = {
                            value: value,
                            trend: "warmup",
                            bufferSize: node.sensorBuffers[sensorName].length,
                            minRequired: 3
                        };
                    }
                } else if (node.mode === "rate-of-change") {
                    const prev = node.sensorPrevious[sensorName];
                    if (prev.value !== null) {
                        const deltaTime = (timestamp - prev.timestamp) / 1000;
                        const deltaValue = value - prev.value;
                        let roc = deltaTime > 0 ? deltaValue / deltaTime : 0;

                        if (node.rocMethod === "percentage" && prev.value !== 0) {
                            roc = (roc / Math.abs(prev.value)) * 100;
                        }

                        sensorResult = {
                            value: value,
                            rateOfChange: roc,
                            deltaValue: deltaValue,
                            deltaTime: deltaTime,
                            unit: node.rocMethod === "percentage" ? "%/s" : "/s"
                        };

                        if (node.rocThreshold !== null && Math.abs(roc) > node.rocThreshold) {
                            anyThresholdExceeded = true;
                            exceededSensors.push(sensorName);
                            sensorResult.thresholdExceeded = true;
                        }
                    } else {
                        sensorResult = { value: value, rateOfChange: null, warmup: true };
                    }
                    node.sensorPrevious[sensorName] = { value: value, timestamp: timestamp };
                } else if (node.mode === "rul") {
                    if (node.sensorBuffers[sensorName].length >= 5 && node.failureThreshold !== null) {
                        const rul = calculateRUL(
                            node.sensorBuffers[sensorName],
                            node.sensorTimestamps[sensorName],
                            node.failureThreshold,
                            node.degradationModel,
                            node.confidenceLevel
                        );
                        sensorResult = {
                            value: value,
                            rul: rul,
                            bufferSize: node.sensorBuffers[sensorName].length
                        };

                        if (rul && (rul.status === "critical" || rul.status === "failed")) {
                            anyThresholdExceeded = true;
                            exceededSensors.push(sensorName);
                        }
                    } else {
                        sensorResult = {
                            value: value,
                            rul: null,
                            warmup: true,
                            bufferSize: node.sensorBuffers[sensorName].length,
                            minRequired: 5
                        };
                    }
                }

                results[sensorName] = sensorResult;
            });

            // Build output message
            const outMsg = {
                payload: results,
                mode: node.mode,
                sensorCount: sensorNames.length,
                inputFormat: "multi-sensor",
                _msgid: msg._msgid
            };

            if (anyThresholdExceeded) {
                outMsg.thresholdExceeded = true;
                outMsg.exceededSensors = exceededSensors;
            }

            if (msg.topic) outMsg.topic = node.outputTopic || msg.topic;

            // Update status
            let statusText = sensorNames.length + " sensors";
            if (node.mode === "prediction") {
                statusText += " (trend)";
            } else if (node.mode === "rul") {
                statusText += " (RUL)";
            }

            if (anyThresholdExceeded) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "threshold: " + exceededSensors.join(", ")
                });
                node.send([null, outMsg]);
            } else {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: statusText
                });
                node.send([outMsg, null]);
            }
        }

        node.on("input", function (msg, send, done) {
            // Node-RED >=1.0 passes send/done; shim for older runtimes.
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };
            try {
                // Dynamic configuration via msg.config
                // Allows runtime override of node settings
                const cfg = msg.config || {};
                const activeMode = cfg.mode || node.mode;
                const activeThreshold = cfg.threshold !== undefined ? parseFloat(cfg.threshold) : node.threshold;
                const activeFailureThreshold =
                    cfg.failureThreshold !== undefined ? parseFloat(cfg.failureThreshold) : node.failureThreshold;
                const activeWarningThreshold =
                    cfg.warningThreshold !== undefined ? parseFloat(cfg.warningThreshold) : node.warningThreshold;
                const activeRocThreshold =
                    cfg.rocThreshold !== undefined ? parseFloat(cfg.rocThreshold) : node.rocThreshold;
                const activePredictionSteps =
                    cfg.predictionSteps !== undefined ? parseInt(cfg.predictionSteps) : node.predictionSteps;

                if (msg.reset === true) {
                    node.buffer = [];
                    node.timestamps = [];
                    node.previousValue = null;
                    node.previousTimestamp = null;
                    node.rocHistory = [];
                    node.sensorBuffers = {};
                    node.sensorTimestamps = {};
                    node.sensorPrevious = {};
                    node.sensorRocHistory = {};
                    node.status({ fill: "blue", shape: "ring", text: activeMode + " - reset" });
                    done();
                    return;
                }

                // Check if payload is JSON object (multi-sensor mode)
                if (typeof msg.payload === "object" && msg.payload !== null && !Array.isArray(msg.payload)) {
                    processMultiSensorInput(msg, msg.payload);
                    done();
                    return;
                }

                const value = parseFloat(msg.payload);
                const timestamp = msg.timestamp || Date.now();

                if (isNaN(value)) {
                    node.warn("Invalid payload: not a number");
                    done();
                    return;
                }

                let result = null;

                if (activeMode === "prediction") {
                    result = processPredictionWithConfig(msg, value, timestamp, activeThreshold, activePredictionSteps);
                } else if (activeMode === "rate-of-change") {
                    result = processRateOfChangeWithConfig(msg, value, timestamp, activeRocThreshold);
                } else if (activeMode === "rul") {
                    result = processRULWithConfig(
                        msg,
                        value,
                        timestamp,
                        activeFailureThreshold,
                        activeWarningThreshold
                    );
                }

                if (result) {
                    if (result.anomaly) {
                        node.send([null, result.anomaly]);
                    } else if (result.normal) {
                        node.send([result.normal, null]);
                    }
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done("Error in trend prediction: " + err.message);
            }
        });

        node.on("close", async function (done) {
            // Save state before closing if persistence enabled
            if (persistence) {
                await persistence.close();
            }

            node.buffer = [];
            node.timestamps = [];
            node.previousValue = null;
            node.previousTimestamp = null;
            node.rocHistory = [];
            node.status({});

            if (done) done();
        });
    }

    RED.nodes.registerType("trend-predictor", TrendPredictorNode);
};
