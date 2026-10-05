module.exports = function (RED) {
    "use strict";
    const { copyPassthrough } = require("./utils/message");

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");

    const { clampInt, clampFloat } = require("./utils/config-validator");
    const groupState = require("./utils/group-state");

    const AGGREGATION_METHODS = ["weighted", "dynamic", "minimum", "average", "geometric"];

    // Health history kept per group (drives msg.healthTrend)
    const MAX_HISTORY = 100;

    // Values kept per sensor for the noise (coefficient of variation) estimate
    const MAX_RELIABILITY_VALUES = 50;

    // A change of less than this many points (on the 0-100 scale) between the
    // two halves of the recent history counts as "stable".
    const TREND_BAND = 2;

    function HealthIndexNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        /**
         * Turn a weights object (or its JSON text) into a Map of finite,
         * non-negative numbers. A Map — not a plain object — so that a sensor
         * called "constructor" or "toString" cannot pick up an inherited
         * property as its weight, and `__proto__` in the input is just a key.
         *
         * @returns {{weights: Map<string, number>, rejected: string[]}|null}
         *          null when the input is not a weights object at all
         */
        function parseWeights(raw) {
            let source = raw;
            if (typeof source === "string") {
                try {
                    source = JSON.parse(source);
                } catch (e) {
                    return null;
                }
            }
            if (typeof source !== "object" || source === null || Array.isArray(source)) {
                return null;
            }
            const weights = new Map();
            const rejected = [];
            Object.keys(source).forEach(function (name) {
                const entry = source[name];
                const weight = typeof entry === "string" && entry.trim() !== "" ? Number(entry) : entry;
                if (typeof weight === "number" && Number.isFinite(weight) && weight >= 0) {
                    weights.set(name, weight);
                } else {
                    rejected.push(name);
                }
            });
            return { weights: weights, rejected: rejected };
        }

        // Configuration - sensor weights
        let sensorWeights = new Map();
        const parsedWeights = parseWeights(config.sensorWeights || "{}");
        if (!parsedWeights) {
            node.warn("Invalid sensor weights configuration");
        } else {
            sensorWeights = parsedWeights.weights;
            if (parsedWeights.rejected.length > 0) {
                node.warn(
                    "Ignoring sensor weights that are not finite numbers >= 0 (weight 1 is used): " +
                        parsedWeights.rejected.join(", ")
                );
            }
        }

        let aggregationMethod = config.aggregationMethod || "weighted";
        if (!AGGREGATION_METHODS.includes(aggregationMethod)) {
            node.warn("Unknown aggregation method '" + aggregationMethod + "', using 'weighted'");
            aggregationMethod = "weighted";
        }
        const outputScale = config.outputScale || "0-100";
        const outputTopic = config.outputTopic || "";
        const debug = config.debug === true;
        const persistState = config.persistState === true;

        // Per-device grouping: one independent history / reliability record per
        // value of a message property (e.g. "topic"). Empty = one shared state
        // (default, legacy).
        node.groupBy = typeof config.groupBy === "string" ? config.groupBy.trim() : "";
        node.maxGroups = clampInt(config.maxGroups, 1, 10000, 50);

        // State: one entry per group, in least-recently-used order.
        const DEFAULT_GROUP = groupState.DEFAULT_GROUP;
        node.groups = new Map();

        // Monotonic sample counter driving the persistence throttle. It must NOT
        // be derived from the buffer length: the buffer is capped, so once it
        // saturates `length % N` is a constant — the throttle then fires on
        // every sample or on none, depending on the configured window size.
        node.sampleCount = 0;

        // Debug logging helper
        const debugLog = function (message) {
            if (debug && typeof node.debug === "function") {
                node.debug(message);
            }
        };

        // Group key of a message; DEFAULT_GROUP when grouping is off or the
        // message carries no usable value.
        function resolveGroupKey(msg) {
            return groupState.resolveGroupKey(RED, msg, node.groupBy);
        }

        function createGroupState(key) {
            return {
                key: key,
                healthHistory: [],
                lastHealthIndex: null,
                lastStatus: null,
                sensorReliability: new Map()
            };
        }

        // Fetch (or create) the state for a key. The map is kept in LRU order, so
        // an unbounded key space evicts the least recently used group.
        function getGroupState(key) {
            return groupState.getOrCreateGroup(node.groups, key, {
                create: createGroupState,
                max: node.maxGroups,
                lru: Boolean(node.groupBy),
                onEvict: function (evictedKey) {
                    debugLog(
                        "Evicted least recently used group '" + evictedKey + "' (maxGroups=" + node.maxGroups + ")"
                    );
                }
            });
        }

        // Backwards-compatible read-only view of the default (ungrouped) state.
        // With grouping enabled it only describes traffic without a group value.
        Object.defineProperty(node, "healthHistory", {
            configurable: true,
            get: function () {
                const state = node.groups.get(DEFAULT_GROUP);
                return state ? state.healthHistory : [];
            }
        });
        ["lastHealthIndex", "lastStatus"].forEach(function (prop) {
            Object.defineProperty(node, prop, {
                configurable: true,
                get: function () {
                    const state = node.groups.get(DEFAULT_GROUP);
                    return state ? state[prop] : null;
                }
            });
        });

        // Prefix status text with the group key so a shared node stays readable
        function groupText(state, text) {
            return node.groupBy && state.key !== DEFAULT_GROUP ? state.key + ": " + text : text;
        }

        function restoreReliability(target, saved) {
            if (!saved || typeof saved !== "object") {
                return;
            }
            Object.keys(saved).forEach(function (name) {
                const entry = saved[name];
                if (!entry || typeof entry !== "object") {
                    return;
                }
                target.sensorReliability.set(name, {
                    values: Array.isArray(entry.values) ? entry.values.filter(Number.isFinite) : [],
                    anomalyCount: Number.isFinite(entry.anomalyCount) ? entry.anomalyCount : 0,
                    totalCount: Number.isFinite(entry.totalCount) ? entry.totalCount : 0,
                    lastUpdate: entry.lastUpdate || Date.now()
                });
            });
        }

        // Initialize state persistence using helper
        // Note: We need to set persistState on node for the helper to work
        node.persistState = persistState;
        let persistence = null;
        persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "healthIndexState",
            saveInterval: 30000,
            debug: debug,
            onStateLoaded: function (state) {
                // v2 stores one entry per group; v1 stored a single flat history,
                // which restores into the default (ungrouped) bucket.
                const saved = state.groups || (Array.isArray(state.healthHistory) ? { "": state } : null);
                if (!saved) {
                    return;
                }

                let restored = 0;
                Object.keys(saved).forEach(function (key) {
                    const entry = saved[key];
                    if (!entry || !Array.isArray(entry.healthHistory) || entry.healthHistory.length === 0) {
                        return;
                    }
                    const target = getGroupState(key);
                    target.healthHistory = entry.healthHistory;
                    target.lastHealthIndex = entry.lastHealthIndex;
                    target.lastStatus = entry.lastStatus;
                    restoreReliability(target, entry.sensorReliability);
                    restored += entry.healthHistory.length;
                });

                if (!state.groups && persistence) {
                    // Migrated a v1 payload: drop the stale flat keys.
                    ["healthHistory", "lastHealthIndex", "lastStatus"].forEach(function (key) {
                        persistence.manager.delete(key);
                    });
                }

                if (restored > 0) {
                    debugLog("Restored " + restored + " health history entries from persistence");
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: "Restored (" + restored + " entries)"
                    });
                }
            },
            getStateToSave: function () {
                const groups = {};
                node.groups.forEach(function (state, key) {
                    if (state.healthHistory.length === 0) {
                        return;
                    }
                    const reliability = {};
                    state.sensorReliability.forEach(function (entry, name) {
                        if (name !== "__proto__") {
                            reliability[name] = entry;
                        }
                    });
                    groups[key] = {
                        healthHistory: state.healthHistory,
                        lastHealthIndex: state.lastHealthIndex,
                        lastStatus: state.lastStatus,
                        sensorReliability: reliability
                    };
                });
                return { version: 2, groups: groups };
            }
        });

        // Helper to persist current state
        function persistCurrentState() {
            if (persistence) {
                persistence.saveNow();
            }
        }

        // Scale conversion helper
        const scaleOutput = function (value) {
            if (outputScale === "0-1") {
                return value / 100;
            }
            return value; // Default 0-100
        };

        const scaleThreshold = scaleOutput;

        // The four thresholds only make sense in descending order
        // (healthy >= warning >= degraded >= critical). Sort them into it rather
        // than classify against a ladder whose rungs are out of order.
        function orderThresholds(healthy, warning, degraded, critical) {
            const sorted = [healthy, warning, degraded, critical].sort(function (a, b) {
                return b - a;
            });
            return {
                healthy: sorted[0],
                warning: sorted[1],
                degraded: sorted[2],
                critical: sorted[3],
                reordered:
                    sorted[0] !== healthy || sorted[1] !== warning || sorted[2] !== degraded || sorted[3] !== critical
            };
        }

        // Threshold configuration
        const configuredThresholds = orderThresholds(
            clampFloat(config.healthyThreshold, 0, 100, 80),
            clampFloat(config.warningThreshold, 0, 100, 60),
            clampFloat(config.degradedThreshold, 0, 100, 40),
            clampFloat(config.criticalThreshold, 0, 100, 20)
        );
        if (configuredThresholds.reordered) {
            node.warn(
                "Health thresholds were not in descending order (healthy >= warning >= degraded >= critical); using " +
                    [
                        configuredThresholds.healthy,
                        configuredThresholds.warning,
                        configuredThresholds.degraded,
                        configuredThresholds.critical
                    ].join(" / ")
            );
        }

        function clampThreshold(val, fallback) {
            const parsed = parseFloat(val);
            if (!Number.isFinite(parsed)) return fallback;
            return Math.max(0, Math.min(100, parsed));
        }

        // Warn once per distinct problem in msg.config, not once per message
        const warnedOverrides = new Set();
        function warnOnce(text) {
            if (!warnedOverrides.has(text) && warnedOverrides.size < 50) {
                warnedOverrides.add(text);
                node.warn(text);
            }
        }

        // Read a numeric field that may arrive as a number or a numeric string.
        function numericField(value) {
            if (typeof value === "number") return value;
            if (typeof value === "string" && value.trim() !== "") return Number(value);
            return NaN;
        }

        /**
         * Normalise one payload entry into a sensor record, or null when it
         * carries no usable information (null, undefined, NaN, free text …).
         * A bare finite number is a reading with no evidence against it.
         */
        function normaliseSensor(entry) {
            if (typeof entry === "number") {
                return Number.isFinite(entry) ? { value: entry } : null;
            }
            if (typeof entry === "string") {
                const parsed = entry.trim() !== "" ? Number(entry) : NaN;
                return Number.isFinite(parsed) ? { value: parsed } : null;
            }
            if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
                return entry;
            }
            return null;
        }

        node.on("input", function (msg, send, done) {
            // Node-RED >=1.0 passes send/done; shim for older runtimes.
            send =
                send ||
                function () {
                    node.send.apply(node, arguments);
                };
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };
            try {
                // Reset command: the message's own group when grouping is on and
                // the message names one, everything otherwise.
                if (msg.reset === true) {
                    const resetKey = resolveGroupKey(msg);
                    if (node.groupBy && resetKey !== DEFAULT_GROUP) {
                        node.groups.delete(resetKey);
                    } else {
                        node.groups.clear();
                    }
                    persistCurrentState();
                    node.status({ fill: "blue", shape: "ring", text: "reset" });
                    done();
                    return;
                }

                // Dynamic configuration via msg.config
                // Allows runtime override of node settings
                const cfg = typeof msg.config === "object" && msg.config !== null ? msg.config : {};
                const active = orderThresholds(
                    cfg.healthyThreshold !== undefined
                        ? clampThreshold(cfg.healthyThreshold, configuredThresholds.healthy)
                        : configuredThresholds.healthy,
                    cfg.warningThreshold !== undefined
                        ? clampThreshold(cfg.warningThreshold, configuredThresholds.warning)
                        : configuredThresholds.warning,
                    cfg.degradedThreshold !== undefined
                        ? clampThreshold(cfg.degradedThreshold, configuredThresholds.degraded)
                        : configuredThresholds.degraded,
                    cfg.criticalThreshold !== undefined
                        ? clampThreshold(cfg.criticalThreshold, configuredThresholds.critical)
                        : configuredThresholds.critical
                );

                let activeAggregationMethod = aggregationMethod;
                if (cfg.aggregationMethod !== undefined && cfg.aggregationMethod !== null) {
                    if (AGGREGATION_METHODS.includes(cfg.aggregationMethod)) {
                        activeAggregationMethod = cfg.aggregationMethod;
                    } else {
                        warnOnce(
                            "Ignoring unknown msg.config.aggregationMethod '" +
                                String(cfg.aggregationMethod) +
                                "' (using '" +
                                aggregationMethod +
                                "')"
                        );
                    }
                }

                let activeSensorWeights = sensorWeights;
                if (cfg.sensorWeights !== undefined && cfg.sensorWeights !== null) {
                    const override = parseWeights(cfg.sensorWeights);
                    if (!override) {
                        warnOnce("Ignoring msg.config.sensorWeights: not an object of weights");
                    } else {
                        activeSensorWeights = override.weights;
                        if (override.rejected.length > 0) {
                            warnOnce(
                                "Ignoring msg.config.sensorWeights entries that are not finite numbers >= 0: " +
                                    override.rejected.join(", ")
                            );
                        }
                    }
                }

                const payload = msg.payload;

                // Accept array or object of sensor values
                const sensorData = new Map();
                const skippedSensors = [];
                const addSensor = function (name, entry) {
                    const sensorInfo = normaliseSensor(entry);
                    // "__proto__" cannot be a key of the plain result objects
                    if (sensorInfo === null || name === "__proto__") {
                        skippedSensors.push(name);
                    } else {
                        sensorData.set(name, sensorInfo);
                    }
                };

                if (Array.isArray(payload)) {
                    // Array format: convert to object with indices as keys
                    payload.forEach((value, index) => {
                        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                            // Array of objects with sensor info
                            addSensor(String(value.valueName || value.name || `sensor${index}`), value);
                        } else {
                            addSensor(`sensor${index}`, value);
                        }
                    });
                } else if (typeof payload === "object" && payload !== null) {
                    Object.keys(payload).forEach(function (name) {
                        addSensor(name, payload[name]);
                    });
                } else {
                    node.warn("Payload must be an array or object");
                    done();
                    return;
                }

                const state = getGroupState(resolveGroupKey(msg));

                // Calculate health index (using active config from msg.config or node defaults)
                const healthResult = calculateHealthIndex(
                    state,
                    sensorData,
                    activeSensorWeights,
                    activeAggregationMethod
                );

                // No sensor contributed (empty payload, only unusable entries, or
                // every weight zero): that is "no data", not "perfectly healthy".
                // Emit nothing rather than a reassuring 100.
                if (healthResult.index === null) {
                    node.status({ fill: "grey", shape: "ring", text: groupText(state, "no valid sensor data") });
                    warnOnce("No usable sensor data in payload - no health index emitted");
                    done();
                    return;
                }

                debugLog(
                    "Health Index: " +
                        healthResult.index.toFixed(1) +
                        "%, Worst: " +
                        (healthResult.worstSensor ? healthResult.worstSensor.name : "N/A")
                );

                // Determine health status using configurable thresholds (active config)
                let status = "healthy";
                let statusColor = "green";

                if (healthResult.index < active.critical) {
                    status = "critical";
                    statusColor = "red";
                } else if (healthResult.index < active.degraded) {
                    status = "degraded";
                    statusColor = "red";
                } else if (healthResult.index < active.warning) {
                    status = "warning";
                    statusColor = "yellow";
                } else if (healthResult.index < active.healthy) {
                    status = "attention";
                    statusColor = "yellow";
                }

                // Scale the output values
                const scaledIndex = scaleOutput(healthResult.index);
                const scaledSensorScores = {};
                for (const [name, score] of Object.entries(healthResult.sensorScores)) {
                    scaledSensorScores[name] = scaleOutput(score);
                }

                // Prepare output. `method` and `thresholds` report what was
                // actually applied to this message, msg.config overrides included.
                const outputMsg = {
                    payload: scaledIndex,
                    healthIndex: scaledIndex,
                    status: status,
                    scale: outputScale,
                    sensorScores: scaledSensorScores,
                    worstSensor: healthResult.worstSensor
                        ? {
                              name: healthResult.worstSensor.name,
                              score: scaleOutput(healthResult.worstSensor.score),
                              reliability: healthResult.worstSensor.reliability
                          }
                        : null,
                    contributingFactors: healthResult.contributingFactors,
                    method: activeAggregationMethod,
                    thresholds: {
                        healthy: scaleThreshold(active.healthy),
                        warning: scaleThreshold(active.warning),
                        degraded: scaleThreshold(active.degraded),
                        critical: scaleThreshold(active.critical)
                    },
                    dynamicWeights: healthResult.dynamicWeights
                };
                if (skippedSensors.length > 0) {
                    outputMsg.skippedSensors = skippedSensors;
                }

                // Set topic if configured
                if (outputTopic) {
                    outputMsg.topic = outputTopic;
                }
                if (node.groupBy) {
                    outputMsg.group = state.key;
                }

                // Copy original message properties; keep the inbound topic when no
                // output topic is configured.
                copyPassthrough(outputMsg, msg, { preserveTopic: !outputTopic });

                // Set status
                const statusText =
                    outputScale === "0-1"
                        ? `Health: ${scaledIndex.toFixed(2)} (${status})`
                        : `Health: ${scaledIndex.toFixed(1)}% (${status})`;
                node.status({
                    fill: statusColor,
                    shape: "dot",
                    text: groupText(state, statusText)
                });

                // Track health history
                state.healthHistory.push({
                    timestamp: Date.now(),
                    index: scaledIndex,
                    status: status
                });

                // Limit history to last 100 entries
                if (state.healthHistory.length > MAX_HISTORY) {
                    state.healthHistory.shift();
                }

                state.lastHealthIndex = scaledIndex;
                state.lastStatus = status;

                // Persist state periodically (every 10th sample)
                node.sampleCount++;
                if (node.stateManager && node.sampleCount % 10 === 0) {
                    persistCurrentState();
                }

                // Add health trend to output
                outputMsg.healthTrend = calculateHealthTrend(state);

                // Send to different outputs based on status
                if (status === "critical" || status === "degraded" || status === "warning") {
                    send([null, outputMsg]); // Output 2: Degraded/Warning/Critical health
                } else {
                    send([outputMsg, null]); // Output 1: Healthy/Attention
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done("Error in health index calculation: " + err.message);
            }
        });

        // Calculate health trend from history
        function calculateHealthTrend(state) {
            const history = state.healthHistory;
            if (history.length < 3) {
                return { trend: "unknown", samples: history.length };
            }

            const recentHistory = history.slice(-10);
            const firstHalf = recentHistory.slice(0, Math.floor(recentHistory.length / 2));
            const secondHalf = recentHistory.slice(Math.floor(recentHistory.length / 2));

            const firstAvg = firstHalf.reduce((sum, h) => sum + h.index, 0) / firstHalf.length;
            const secondAvg = secondHalf.reduce((sum, h) => sum + h.index, 0) / secondHalf.length;

            // History holds the index in the OUTPUT scale, so the band has to be
            // in that scale too (2 points of 100 = 0.02 on the 0-1 scale).
            const diff = secondAvg - firstAvg;
            const band = scaleOutput(TREND_BAND);
            let trend = "stable";

            if (diff > band) {
                trend = "improving";
            } else if (diff < -band) {
                trend = "degrading";
            }

            return {
                trend: trend,
                recentAverage: secondAvg,
                previousAverage: firstAvg,
                change: diff,
                samples: history.length
            };
        }

        // Handle node close
        node.on("close", async function (done) {
            // Save state before closing if persistence enabled
            if (persistence) {
                await persistence.close();
            }

            node.groups.clear();
            node.status({});

            if (done) done();
        });

        // Calculate dynamic weight based on sensor reliability
        function calculateDynamicWeight(state, sensorName, sensorInfo, baseWeight) {
            let reliabilityFactor = 1.0;

            // Initialize sensor reliability tracking
            let reliability = state.sensorReliability.get(sensorName);
            if (!reliability) {
                reliability = {
                    values: [],
                    anomalyCount: 0,
                    totalCount: 0,
                    lastUpdate: Date.now()
                };
                state.sensorReliability.set(sensorName, reliability);
            }
            reliability.totalCount++;
            reliability.lastUpdate = Date.now();

            // Track anomalies. The rate is reported (anomalyRate) but deliberately
            // NOT used to reduce the weight: a sensor that is anomalous all the
            // time is the very fault this node exists to surface, and
            // down-weighting it made the index rise as the fault persisted.
            if (sensorInfo.isAnomaly === true || sensorInfo.isAnomaly === "true") {
                reliability.anomalyCount++;
            }

            // Track values for variance calculation
            const value = numericField(sensorInfo.value);
            if (Number.isFinite(value)) {
                reliability.values.push(value);
                // Keep last 50 values
                if (reliability.values.length > MAX_RELIABILITY_VALUES) {
                    reliability.values.shift();
                }
            }

            // Factor 1: Reduce weight for sensors with very high variance (noisy)
            if (reliability.values.length >= 10) {
                const mean = reliability.values.reduce((a, b) => a + b, 0) / reliability.values.length;
                const variance =
                    reliability.values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / reliability.values.length;
                const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 0;

                // High coefficient of variation (>0.5) reduces reliability
                if (cv > 0.5) {
                    reliabilityFactor *= Math.max(0.5, 1 - (cv - 0.5));
                }
            }

            // Factor 2: Confidence from sensor data
            const confidence = numericField(sensorInfo.confidence);
            if (Number.isFinite(confidence)) {
                reliabilityFactor *= Math.max(0, Math.min(1, confidence));
            }

            // Clamp reliability factor
            reliabilityFactor = Math.max(0.1, Math.min(1.0, reliabilityFactor));

            return {
                effectiveWeight: baseWeight * reliabilityFactor,
                reliabilityFactor: reliabilityFactor,
                anomalyRate: reliability.totalCount > 0 ? reliability.anomalyCount / reliability.totalCount : 0
            };
        }

        /**
         * @param {Object} state - group state (carries the reliability records)
         * @param {Map<string, Object>} sensorData - normalised sensor records
         * @param {Map<string, number>} weights - validated base weights
         * @param {string} method - one of AGGREGATION_METHODS
         * @returns {Object} result; `index` is null when no sensor contributed
         */
        function calculateHealthIndex(state, sensorData, weights, method) {
            const sensorScores = {};
            const contributingFactors = [];
            const dynamicWeights = {};
            const baseWeights = {};

            // Calculate individual sensor health scores
            sensorData.forEach(function (sensorInfo, sensorName) {
                let score = 100; // Start with perfect health

                // Check for anomaly flag
                if (sensorInfo.isAnomaly === true || sensorInfo.isAnomaly === "true") {
                    score -= 30;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: "anomaly detected",
                        impact: -30
                    });
                }

                // Check Z-score or similar normalized metric
                const zScore = Math.abs(numericField(sensorInfo.zScore));
                if (zScore > 3) {
                    score -= 40;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: `high z-score: ${zScore.toFixed(2)}`,
                        impact: -40
                    });
                } else if (zScore > 2) {
                    score -= 20;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: `elevated z-score: ${zScore.toFixed(2)}`,
                        impact: -20
                    });
                }

                // Check deviation percentage
                const devPercent = Math.abs(numericField(sensorInfo.deviationPercent));
                if (devPercent > 30) {
                    score -= 30;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: `high deviation: ${devPercent.toFixed(1)}%`,
                        impact: -30
                    });
                } else if (devPercent > 15) {
                    score -= 15;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: `moderate deviation: ${devPercent.toFixed(1)}%`,
                        impact: -15
                    });
                }

                // Check trend (if available)
                if (sensorInfo.trend === "increasing" && sensorInfo.slope > 0) {
                    score -= 10;
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: "increasing trend",
                        impact: -10
                    });
                }

                // Check confidence (reduce impact if low confidence)
                const rawConfidence = numericField(sensorInfo.confidence);
                if (Number.isFinite(rawConfidence) && rawConfidence < 0.5) {
                    // Low confidence sensor - reduce penalty impact
                    const confidence = Math.max(0, rawConfidence);
                    const confidenceFactor = confidence / 0.5;
                    const adjustment = Math.round((100 - score) * (1 - confidenceFactor) * 0.5);
                    score = Math.min(100, score + adjustment);
                    contributingFactors.push({
                        sensor: sensorName,
                        reason: `low confidence (${(confidence * 100).toFixed(0)}%)`,
                        impact: adjustment
                    });
                }

                // Ensure score stays within 0-100
                score = Math.max(0, Math.min(100, score));
                sensorScores[sensorName] = score;

                // Calculate dynamic weight for this sensor. An explicit weight
                // of 0 is honoured (the sensor is reported but not aggregated);
                // only a sensor without a configured weight defaults to 1.
                const baseWeight = weights.has(sensorName) ? weights.get(sensorName) : 1.0;
                baseWeights[sensorName] = baseWeight;
                dynamicWeights[sensorName] = calculateDynamicWeight(state, sensorName, sensorInfo, baseWeight);
            });

            // Aggregate scores. Sensors with base weight 0 are excluded from
            // every method — that is what a zero weight asks for.
            const included = Object.keys(sensorScores).filter(function (name) {
                return baseWeights[name] > 0;
            });
            let healthIndex = null;

            if (included.length === 0) {
                healthIndex = null;
            } else if (method === "weighted" || method === "dynamic") {
                // Weighted average; "dynamic" uses the reliability-adjusted weights
                let totalWeight = 0;
                let weightedSum = 0;

                included.forEach(function (sensorName) {
                    const effectiveWeight =
                        method === "dynamic" ? dynamicWeights[sensorName].effectiveWeight : baseWeights[sensorName];

                    weightedSum += sensorScores[sensorName] * effectiveWeight;
                    totalWeight += effectiveWeight;
                });

                healthIndex = totalWeight > 0 ? weightedSum / totalWeight : null;
            } else if (method === "minimum") {
                // Worst-case (minimum score)
                healthIndex = 100;
                included.forEach(function (sensorName) {
                    if (sensorScores[sensorName] < healthIndex) healthIndex = sensorScores[sensorName];
                });
            } else if (method === "average") {
                // Simple average
                let sum = 0;
                included.forEach(function (sensorName) {
                    sum += sensorScores[sensorName];
                });
                healthIndex = sum / included.length;
            } else if (method === "geometric") {
                // Geometric mean (emphasizes low scores). Summed in log space:
                // the plain product of 100s overflows beyond ~150 sensors.
                let logSum = 0;
                let hasZero = false;
                included.forEach(function (sensorName) {
                    if (sensorScores[sensorName] <= 0) {
                        hasZero = true;
                    } else {
                        logSum += Math.log(sensorScores[sensorName]);
                    }
                });
                healthIndex = hasZero ? 0 : Math.min(100, Math.exp(logSum / included.length));
            }

            // Find worst sensor (among those that count towards the index)
            let worstSensor = null;
            let worstScore = 100;

            included.forEach(function (sensorName) {
                const score = sensorScores[sensorName];
                if (score < worstScore) {
                    worstScore = score;
                    worstSensor = {
                        name: sensorName,
                        score: score,
                        reliability: dynamicWeights[sensorName] ? dynamicWeights[sensorName].reliabilityFactor : 1.0
                    };
                }
            });

            return {
                index: healthIndex,
                sensorScores: sensorScores,
                dynamicWeights: dynamicWeights,
                worstSensor: worstSensor,
                contributingFactors: contributingFactors
            };
        }
    }

    RED.nodes.registerType("health-index", HealthIndexNode);
};
