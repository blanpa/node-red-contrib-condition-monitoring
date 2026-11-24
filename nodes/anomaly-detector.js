module.exports = function (RED) {
    "use strict";
    const { copyPassthrough } = require("./utils/message");

    // Upper bound for the sliding window. Every sample walks the live window —
    // and the order-statistic methods (IQR, percentile) sort it — so the ceiling
    // is a usability guard, not a formality: the old 1_000_000 let a single
    // message cost a million-element pass.
    const MAX_WINDOW_SIZE = 100000;

    // A sample is scored against the window *before* it once that window holds
    // this many values (or is full, for smaller windows). Below that the spread
    // estimate is too unstable to judge a newcomer against — two near-identical
    // readings would make the third look like a 4σ event — so the first few
    // samples of a baseline are scored within the window they are part of.
    const MIN_BASELINE = 10;

    // Upper bound for distinct sensor names in multi-sensor (object payload) mode.
    const MAX_SENSORS = 1000;

    // Import shared statistics utilities
    const stats = require("./utils/statistics");

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");

    // Import error handling utilities
    const errorHandler = require("./utils/error-handler");

    // Config validation: parse + range-clamp (0 stays 0 where it is valid)
    const { clampInt, clampFloat } = require("./utils/config-validator");

    // Per-group / per-regime state: key resolution and the field swapper
    const groupState = require("./utils/group-state");

    // Import WebSocket manager for real-time dashboards
    let WebSocketManager = null;
    try {
        WebSocketManager = require("./websocket-manager");
    } catch (err) {
        // WebSocket support not available
    }

    function AnomalyDetectorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Common Configuration
        this.method = config.method || "zscore"; // zscore, iqr, threshold, percentile, ema, cusum, moving-average
        this.windowSize = clampInt(config.windowSize, 2, MAX_WINDOW_SIZE, 100);

        // Z-Score specific
        this.zscoreThreshold = clampFloat(config.zscoreThreshold, 0.1, 1000, 3.0);
        this.zscoreWarning = clampFloat(config.zscoreWarning, 0.1, 1000, 2.0);

        // IQR specific
        this.iqrMultiplier = clampFloat(config.iqrMultiplier, 0.1, 100, 1.5);
        this.iqrWarningMultiplier = clampFloat(config.iqrWarningMultiplier, 0.1, 100, 1.2);

        // Threshold specific
        this.minThreshold =
            config.minThreshold !== "" && config.minThreshold !== undefined ? parseFloat(config.minThreshold) : null;
        this.maxThreshold =
            config.maxThreshold !== "" && config.maxThreshold !== undefined ? parseFloat(config.maxThreshold) : null;
        this.warningMargin = clampFloat(config.warningMargin, 0, 100, 10);

        // Percentile specific (0 is a valid percentile)
        this.lowerPercentile = clampFloat(config.lowerPercentile, 0, 100, 5.0);
        this.upperPercentile = clampFloat(config.upperPercentile, 0, 100, 95.0);

        // EMA specific
        this.emaAlpha = clampFloat(config.emaAlpha, 0.001, 1, 0.3);
        this.emaThreshold = clampFloat(config.emaThreshold, 0.1, 1000, 2.0);
        this.emaWarning = clampFloat(config.emaWarning, 0.1, 1000, 1.5);
        this.emaMethod = config.emaMethod || "stddev";

        // CUSUM specific
        this.cusumTarget =
            config.cusumTarget !== "" && config.cusumTarget !== undefined ? parseFloat(config.cusumTarget) : null;
        this.cusumThreshold = clampFloat(config.cusumThreshold, 0.1, 10000, 5.0);
        this.cusumWarning = clampFloat(config.cusumWarning, 0.1, 10000, 3.5);
        this.cusumDrift = clampFloat(config.cusumDrift, 0, 1000, 0.5);
        // "raw": deviation, drift and thresholds in the signal's own unit (the
        // historical behaviour, kept for existing flows). "sigma": deviations
        // are divided by the window's standard deviation first, so drift and
        // thresholds are in σ and one setting fits signals of any scale.
        this.cusumMode = config.cusumMode === "sigma" ? "sigma" : "raw";

        // Moving Average specific
        this.maThreshold = clampFloat(config.maThreshold, 0.1, 1000, 2.0);
        this.maWarning = clampFloat(config.maWarning, 0.1, 1000, 1.5);
        this.maMethod = config.maMethod || "stddev";

        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        // Kept off `this.debug`: that name is Node-RED's own logger method, and
        // overwriting it with a boolean breaks every node.debug(...) call —
        // including the one state persistence makes while restoring.
        this.debugEnabled = config.debug === true;
        this.persistState = config.persistState === true;

        // Operating-point regimes: keep one independent baseline (window,
        // EMA, CUSUM, hysteresis counters, per-sensor buffers) per value of a
        // message property such as "regime" or "payload.speedClass". A load or
        // speed change then switches baselines instead of reading as an anomaly.
        // Empty = a single baseline (default, legacy).
        this.regimeProperty = typeof config.regimeProperty === "string" ? config.regimeProperty.trim() : "";
        this.maxRegimes = clampInt(config.maxRegimes, 1, 1000, 20);

        // Per-device grouping: one independent set of baselines per value of a
        // message property (e.g. "topic"), so a single node can serve an
        // interleaved multi-device stream. Combines with regimes: each device
        // then has its own baseline per operating point. Empty = one shared
        // state (default, legacy).
        this.groupBy = typeof config.groupBy === "string" ? config.groupBy.trim() : "";
        this.maxGroups = clampInt(config.maxGroups, 1, 10000, 50);

        // Hysteresis settings - prevents alarm flickering
        this.hysteresisEnabled = config.hysteresisEnabled !== false; // Default: enabled
        this.hysteresisPercent = clampFloat(config.hysteresisPercent, 0, 100, 10); // deadband; 0 = none
        this.consecutiveCount = clampInt(config.consecutiveCount, 1, 1000, 1); // Consecutive samples to confirm

        // Adaptive Thresholds - learns from operator feedback
        this.adaptiveEnabled = config.adaptiveEnabled === true;
        this.adaptiveLearningRate = clampFloat(config.adaptiveLearningRate, 0.001, 1, 0.1); // How fast to adjust
        this.adaptiveMinSamples = clampInt(config.adaptiveMinSamples, 1, 100000, 10); // Min feedback before adjusting
        this.targetFalsePositiveRate = clampFloat(config.targetFalsePositiveRate, 0, 1, 0.05); // 5% target

        // Batch Processing Mode - for historical data analysis
        this.batchMode = config.batchMode === true;

        // WebSocket for real-time dashboards
        this.websocketEnabled = config.websocketEnabled === true;
        this.websocketPort = clampInt(config.websocketPort, 1, 65535, 1881);
        this.websocketTopic = config.websocketTopic || "anomaly-detector";
        // Optional auth: shared token + allowed origins. Recommended for any
        // deployment where the WS port is reachable from outside `localhost`.
        // The token is a Node-RED credential (encrypted, never part of a flow
        // export). A token in the plain config still works for flows written
        // before the credential existed, but travels with the flow file.
        const credentialToken =
            node.credentials && typeof node.credentials.websocketAuthToken === "string"
                ? node.credentials.websocketAuthToken.trim()
                : "";
        const inlineToken = typeof config.websocketAuthToken === "string" ? config.websocketAuthToken.trim() : "";
        if (inlineToken && !credentialToken && this.websocketEnabled) {
            node.warn(
                "websocketAuthToken is set in the node config, which stores it in plain text in flows.json " +
                    "and in every flow export. Move it to the WebSocket panel's credential field."
            );
        }
        this.websocketAuthToken = credentialToken || inlineToken || null;
        this.websocketAllowedOrigins = (function parseOrigins(raw) {
            if (!raw) return null;
            if (Array.isArray(raw)) return raw.filter((s) => typeof s === "string" && s.length > 0);
            if (typeof raw === "string") {
                const list = raw
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                return list.length > 0 ? list : null;
            }
            return null;
        })(config.websocketAllowedOrigins);

        // State
        this.dataBuffer = [];
        // Monotonic sample counter driving the persistence throttle. It must NOT
        // be derived from the buffer length: the buffer is capped, so once it
        // saturates `length % N` is a constant — the throttle then fires on
        // every sample or on none, depending on the configured window size.
        this.sampleCount = 0;
        // Live window kept in lockstep with dataBuffer.
        //
        //   windowValues — the bare numbers, so the hot path stops rebuilding
        //     the whole window with `.map()` on every single message.
        //   running      — a Welford accumulator giving mean/σ in O(1) for the
        //     moment-based methods (zscore / ema / cusum / moving-average).
        //     `remove()` drifts over long run-lengths (see utils/statistics), so
        //     it is rebuilt once per full window turnover: amortised O(1), and
        //     the drift can never span more than one window of removals.
        //
        // Everything that mutates the window must go through pushWindow() or
        // resyncWindow() — keeping three structures in sync by hand is how they
        // silently diverge.
        this.windowValues = [];
        this.running = new stats.RunningStats();
        this.runningRemovals = 0;
        this.lastAnomalyState = false; // Track previous anomaly state for hysteresis
        this.consecutiveAnomalies = 0; // Counter for consecutive anomalies
        this.consecutiveNormals = 0; // Counter for consecutive normal values

        // Adaptive Thresholds State
        this.adaptiveState = {
            feedbackHistory: [], // { timestamp, predicted, actual, value }
            truePositives: 0,
            falsePositives: 0,
            trueNegatives: 0,
            falseNegatives: 0,
            currentThresholdAdjustment: 0, // Cumulative adjustment to threshold
            lastAdjustmentTime: null
        };

        // WebSocket manager reference
        this.wsManager = null;

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debugEnabled && typeof node.debug === "function") {
                node.debug(message);
            }
        };
        this.ema = null;
        this.cusumPos = 0;
        this.cusumNeg = 0;
        this.initialized = false;

        // ---- Regime switching ----
        // The detector keeps its baseline as plain fields on `node` (the hot
        // path reads them directly). Rather than threading a state object
        // through every method, a regime change swaps those fields wholesale:
        // the outgoing regime's fields are parked in `node.regimes`, the
        // incoming regime's fields (or a fresh set) are assigned back. Regimes
        // are kept in least-recently-used order and evicted beyond maxRegimes.
        const REGIME_FIELDS = [
            "dataBuffer",
            "windowValues",
            "running",
            "runningRemovals",
            "ema",
            "cusumPos",
            "cusumNeg",
            "initialized",
            "lastAnomalyState",
            "consecutiveAnomalies",
            "consecutiveNormals",
            "sensorBuffers",
            "sensorMoments",
            "sensorStates",
            "sensorEma",
            "sensorCusum"
        ];
        const DEFAULT_REGIME = groupState.DEFAULT_GROUP;
        // Parked states, keyed by state key (see stateKeyOf). The active one
        // lives on the node itself and is not in this map.
        this.regimes = new Map();
        this.activeRegime = DEFAULT_REGIME;
        this.activeGroup = DEFAULT_REGIME;

        function freshRegimeState() {
            return {
                dataBuffer: [],
                windowValues: [],
                running: new stats.RunningStats(),
                runningRemovals: 0,
                ema: null,
                cusumPos: 0,
                cusumNeg: 0,
                initialized: false,
                lastAnomalyState: false,
                consecutiveAnomalies: 0,
                consecutiveNormals: 0,
                sensorBuffers: Object.create(null),
                sensorMoments: Object.create(null),
                sensorStates: Object.create(null),
                sensorEma: Object.create(null),
                sensorCusum: Object.create(null)
            };
        }

        const swapper = groupState.createStateSwapper(node, {
            fields: REGIME_FIELDS,
            fresh: freshRegimeState,
            parked: node.regimes,
            isEmpty: function () {
                return node.dataBuffer.length === 0 && Object.keys(node.sensorBuffers).length === 0;
            },
            max: function () {
                return node.maxRegimes * (node.groupBy ? node.maxGroups : 1);
            }
        });

        // One state per (group, regime). Without grouping the key is the plain
        // regime value, which keeps persisted state from earlier releases valid.
        const KEY_SEPARATOR = "\u001f";
        function stateKeyOf(group, regime) {
            return node.groupBy ? group + KEY_SEPARATOR + regime : regime;
        }

        // Select the state for this message's device and operating point.
        function switchRegime(msg) {
            const group = groupState.resolveGroupKey(RED, msg, node.groupBy);
            const regime = groupState.resolveGroupKey(RED, msg, node.regimeProperty);
            swapper.switchTo(stateKeyOf(group, regime));
            node.activeGroup = group;
            node.activeRegime = regime;
        }

        function resetAllRegimes() {
            swapper.resetAll();
            node.activeRegime = DEFAULT_REGIME;
            node.activeGroup = DEFAULT_REGIME;
        }

        /** Rebuild windowValues + the accumulator from the authoritative dataBuffer. */
        function resyncWindow() {
            node.windowValues = node.dataBuffer.map(function (d) {
                return d.value;
            });
            node.running.reset();
            node.runningRemovals = 0;
            for (let i = 0; i < node.windowValues.length; i++) {
                node.running.push(node.windowValues[i]);
            }
        }

        /** Append a sample to the live window, evicting the oldest once it is full. */
        function pushWindow(value) {
            node.dataBuffer.push({ timestamp: Date.now(), value: value });
            node.windowValues.push(value);
            node.running.push(value);

            if (node.dataBuffer.length > node.windowSize) {
                node.dataBuffer.shift();
                const dropped = node.windowValues.shift();
                node.running.remove(dropped);
                node.runningRemovals++;
                if (node.runningRemovals >= node.windowSize) {
                    resyncWindow();
                }
            }
        }

        /**
         * Mean/σ of the live window, straight from the accumulator.
         *
         * Returned as a `moments` hint to the moment-based detectors; they fall
         * back to the O(n) computation in utils/statistics when it is absent
         * (batch mode, multi-sensor mode), which stays the canonical definition.
         */
        function liveMoments() {
            return { mean: node.running.mean(), stdDev: node.running.stdDev(), n: node.running.count() };
        }

        // Initialize state persistence using helper
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "anomalyDetectorState",
            saveInterval: 30000,
            debug: node.debugEnabled,
            // The blob shape has not changed since the unversioned (pre-0.4.1)
            // writes, so those are adopted as they are.
            migrate: function (state, fromVersion) {
                return fromVersion === 0 ? state : null;
            },
            onStateLoaded: function (state) {
                if (state.dataBuffer && Array.isArray(state.dataBuffer)) {
                    node.dataBuffer = state.dataBuffer;
                    resyncWindow();
                }
                // The learned EMA / CUSUM state of the active baseline. Without
                // it the status would claim a restore while the detector
                // silently re-initialises: the first sample after a redeploy
                // becomes the new EMA and a jump against the old one is scored
                // "normal".
                if (state.ema !== undefined) node.ema = state.ema;
                if (Number.isFinite(state.cusumPos)) node.cusumPos = state.cusumPos;
                if (Number.isFinite(state.cusumNeg)) node.cusumNeg = state.cusumNeg;
                if (state.initialized !== undefined) node.initialized = state.initialized === true;
                // The flat keys above describe the state that was active when
                // it was saved; the parked ones come back alongside it.
                if (node.regimeProperty || node.groupBy) {
                    const activeKey =
                        typeof state.activeStateKey === "string"
                            ? state.activeStateKey
                            : typeof state.activeRegime === "string"
                              ? state.activeRegime
                              : DEFAULT_REGIME;
                    swapper.setActiveKey(activeKey);
                    if (typeof state.activeRegime === "string") node.activeRegime = state.activeRegime;
                    if (typeof state.activeGroup === "string") node.activeGroup = state.activeGroup;

                    if (state.regimes && typeof state.regimes === "object") {
                        const room = Math.max(0, node.maxRegimes * (node.groupBy ? node.maxGroups : 1) - 1);
                        Object.keys(state.regimes)
                            .slice(0, room)
                            .forEach(function (key) {
                                const saved = state.regimes[key];
                                if (!saved || !Array.isArray(saved.dataBuffer) || key === activeKey) return;
                                const bundle = freshRegimeState();
                                bundle.dataBuffer = saved.dataBuffer;
                                bundle.windowValues = saved.dataBuffer.map(function (d) {
                                    return d.value;
                                });
                                bundle.windowValues.forEach(function (v) {
                                    bundle.running.push(v);
                                });
                                if (saved.ema !== undefined) bundle.ema = saved.ema;
                                if (Number.isFinite(saved.cusumPos)) bundle.cusumPos = saved.cusumPos;
                                if (Number.isFinite(saved.cusumNeg)) bundle.cusumNeg = saved.cusumNeg;
                                bundle.initialized = saved.initialized === true;
                                node.regimes.set(key, bundle);
                            });
                    }
                }

                // Restore adaptive state
                if (state.adaptiveState && node.adaptiveEnabled) {
                    node.adaptiveState = state.adaptiveState;
                    debugLog(
                        "Restored adaptive state with " +
                            (state.adaptiveState.truePositives +
                                state.adaptiveState.falsePositives +
                                state.adaptiveState.trueNegatives +
                                state.adaptiveState.falseNegatives) +
                            " feedback samples"
                    );
                }

                if (node.dataBuffer.length > 0) {
                    debugLog("Restored " + node.dataBuffer.length + " buffered values from persistence");
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: node.method + " - restored (" + node.dataBuffer.length + ")"
                    });
                }
            },
            getStateToSave: function () {
                const state = {
                    dataBuffer: node.dataBuffer,
                    ema: node.ema,
                    cusumPos: node.cusumPos,
                    cusumNeg: node.cusumNeg,
                    initialized: node.initialized
                };
                if (node.adaptiveEnabled) {
                    state.adaptiveState = node.adaptiveState;
                }
                if (node.regimeProperty || node.groupBy) {
                    state.activeRegime = node.activeRegime;
                    state.activeGroup = node.activeGroup;
                    state.activeStateKey = swapper.activeKey();
                    state.regimes = {};
                    node.regimes.forEach(function (bundle, key) {
                        state.regimes[key] = {
                            dataBuffer: bundle.dataBuffer,
                            ema: bundle.ema,
                            cusumPos: bundle.cusumPos,
                            cusumNeg: bundle.cusumNeg,
                            initialized: bundle.initialized
                        };
                    });
                }
                return state;
            }
        });

        // Helper to persist current state
        function persistCurrentState() {
            if (persistence) {
                persistence.saveNow();
            }
        }

        // Initialize WebSocket if enabled
        if (node.websocketEnabled && WebSocketManager && WebSocketManager.isWebSocketAvailable()) {
            if (!node.websocketAuthToken) {
                node.warn(
                    "WebSocket output on port " +
                        node.websocketPort +
                        " has no auth token: every client that can reach the port can read the results. " +
                        "Set a token (and allowed origins) unless the port is only reachable locally."
                );
            }
            // Acquire the shared manager; released again in close. The last
            // node to release stops the server, so a redeploy with a changed
            // token / port / origin list comes up with the new settings.
            node.wsManager = WebSocketManager.getWebSocketManager({
                port: node.websocketPort,
                authToken: node.websocketAuthToken,
                allowedOrigins: node.websocketAllowedOrigins
            });
            // Surface mismatched WS configs at runtime — multiple nodes that disagree
            // about authToken/origins indicate an operator error worth flagging.
            // The manager is a process-wide singleton; the handlers are kept so
            // close can detach them (otherwise every redeploy leaks two listeners
            // that pin the closed node and its buffers).
            node.wsListeners = {
                optionMismatch: function (info) {
                    node.warn(
                        "WebSocket option mismatch (" +
                            info.key +
                            "): another node already configured this manager differently — first writer wins"
                    );
                },
                authFailed: function (info) {
                    node.warn("WebSocket auth failed from " + (info.ip || "unknown"));
                },
                clientDropped: function (info) {
                    node.warn(
                        "WebSocket client " +
                            info.clientId +
                            " dropped: not reading its messages (" +
                            info.skippedMessages +
                            " broadcasts skipped)"
                    );
                }
            };
            Object.keys(node.wsListeners).forEach(function (evt) {
                node.wsManager.on(evt, node.wsListeners[evt]);
            });
            if (!node.wsManager.isRunning) {
                node.wsManager
                    .start()
                    .then(function () {
                        debugLog("WebSocket server started on port " + node.websocketPort);
                    })
                    .catch(function (err) {
                        node.warn("Failed to start WebSocket server: " + err.message);
                    });
            }
        }

        // Initial status
        node.status({ fill: "blue", shape: "ring", text: node.method + " - waiting" });

        // Use shared statistics utilities (calculateZScore / calculateIQRBounds called via stats.* directly)
        const calculateMean = stats.calculateMean;
        const calculateStdDev = stats.calculateStdDev;
        const calculatePercentile = stats.calculatePercentileSorted;

        /**
         * Deviation of `value` in units of σ. All detectors score a new sample
         * against the window *before* it is added (see the input handler), so a
         * perfectly flat baseline has σ = 0; any departure from it is then an
         * arbitrarily large deviation, not "no deviation". The floor keeps the
         * result finite (and JSON-serialisable) in that case.
         */
        function sigmaDeviation(value, mean, stdDev) {
            const diff = value - mean;
            if (diff === 0) return 0;
            const floor = Math.max(Math.abs(mean) * 1e-9, 1e-12);
            return diff / Math.max(stdDev, floor);
        }

        // Z-Score method with configurable thresholds (for msg.config override)
        function detectZScoreWithConfig(value, values, threshold, warning, moments) {
            // Single source of truth for mean/stdDev — utils/statistics is the canonical
            // implementation. `moments` is the streaming shortcut for the live window
            // (O(1) Welford) and must agree with it.
            const mean = moments && moments.n >= 1 ? moments.mean : calculateMean(values);
            const stdDev = moments && moments.n >= 1 ? moments.stdDev : calculateStdDev(values, mean);
            const zScore = sigmaDeviation(value, mean, stdDev);
            const absZScore = Math.abs(zScore);

            let severity = "normal";
            let isAnomaly = false;

            if (absZScore > threshold) {
                severity = "critical";
                isAnomaly = true;
            } else if (absZScore > warning) {
                severity = "warning";
                isAnomaly = true;
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    zScore: zScore,
                    mean: mean,
                    stdDev: stdDev,
                    threshold: threshold,
                    warningThreshold: warning
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL z=" + zScore.toFixed(2)
                        : severity === "warning"
                          ? "warning z=" + zScore.toFixed(2)
                          : "μ=" + mean.toFixed(1) + " σ=" + stdDev.toFixed(2)
            };
        }

        // IQR method with configurable multiplier (for msg.config override)
        function detectIQRWithConfig(value, values, multiplier, warningMult) {
            // Bounds and quartiles come from the shared util (no duplicated quantile logic).
            const bounds = stats.calculateIQRBounds(values, multiplier);
            const quartiles = { q1: bounds.q1, q3: bounds.q3, iqr: bounds.iqr, median: bounds.median };
            // Warning band: the configured multiplier, never wider than the
            // critical one. Without one (msg.config override of the critical
            // multiplier only) it sits at 80 % of critical.
            const warningMultiplier = warningMult > 0 ? Math.min(warningMult, multiplier) : multiplier * 0.8;
            const lowerBound = bounds.lowerBound;
            const upperBound = bounds.upperBound;
            const lowerWarning = quartiles.q1 - warningMultiplier * quartiles.iqr;
            const upperWarning = quartiles.q3 + warningMultiplier * quartiles.iqr;

            let severity = "normal";
            let isAnomaly = false;

            if (value < lowerBound || value > upperBound) {
                severity = "critical";
                isAnomaly = true;
            } else if (value < lowerWarning || value > upperWarning) {
                severity = "warning";
                isAnomaly = true;
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    q1: quartiles.q1,
                    q3: quartiles.q3,
                    iqr: quartiles.iqr,
                    median: quartiles.median,
                    lowerBound: lowerBound,
                    upperBound: upperBound,
                    multiplier: multiplier
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL: " + value.toFixed(2)
                        : severity === "warning"
                          ? "warning: " + value.toFixed(2)
                          : "Q1=" + quartiles.q1.toFixed(1) + " Q3=" + quartiles.q3.toFixed(1)
            };
        }

        // Threshold method with configurable thresholds (for msg.config override)
        function detectThresholdWithConfig(value, minThreshold, maxThreshold) {
            let severity = "normal";
            let isAnomaly = false;
            let reason = null;

            // The warning band lies *inside* the limits, sized as a percentage of
            // the limit's magnitude — so it also works for negative limits
            // (multiplying a negative limit by 1 ± margin moves it the wrong way).
            const margin = node.warningMargin / 100;
            const minWarning = minThreshold !== null ? minThreshold + Math.abs(minThreshold) * margin : null;
            const maxWarning = maxThreshold !== null ? maxThreshold - Math.abs(maxThreshold) * margin : null;

            if (minThreshold !== null && value < minThreshold) {
                severity = "critical";
                isAnomaly = true;
                reason = "Below minimum (" + minThreshold + ")";
            } else if (minWarning !== null && value < minWarning) {
                severity = "warning";
                isAnomaly = true;
                reason = "Approaching minimum";
            }

            if (maxThreshold !== null && value > maxThreshold) {
                severity = "critical";
                isAnomaly = true;
                reason = reason ? reason + " AND above maximum" : "Above maximum (" + maxThreshold + ")";
            } else if (maxWarning !== null && value > maxWarning && severity !== "critical") {
                severity = "warning";
                isAnomaly = true;
                reason = reason ? reason + " AND approaching maximum" : "Approaching maximum";
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    minThreshold: minThreshold,
                    maxThreshold: maxThreshold,
                    reason: reason
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL: " + value
                        : severity === "warning"
                          ? "warning: " + value
                          : "OK: " + value
            };
        }

        // Percentile method. `cfg` carries the percentiles in use (node
        // settings with any msg.config override applied, see resolveActiveConfig).
        function detectPercentile(value, values, cfg) {
            const sorted = values.slice().sort((a, b) => a - b);
            const lowerBound = calculatePercentile(sorted, cfg.lowerPercentile);
            const upperBound = calculatePercentile(sorted, cfg.upperPercentile);

            const isAnomaly = value < lowerBound || value > upperBound;

            return {
                isAnomaly: isAnomaly,
                severity: isAnomaly ? "critical" : "normal",
                details: {
                    lowerPercentile: cfg.lowerPercentile,
                    upperPercentile: cfg.upperPercentile,
                    lowerBound: lowerBound,
                    upperBound: upperBound
                },
                statusText: isAnomaly
                    ? "ANOMALY: " + value.toFixed(2)
                    : "P" + cfg.lowerPercentile + "-P" + cfg.upperPercentile
            };
        }

        // EMA method. Thresholds come from `cfg` (see detectPercentile).
        function detectEMA(value, values, moments, cfg) {
            if (!node.initialized) {
                node.ema = value;
                node.initialized = true;
                return { isAnomaly: false, severity: "normal", details: { ema: value }, statusText: "initializing" };
            }

            // Deviation from the EMA as it stood *before* this sample: updating
            // first shrinks every deviation by (1 − α), and hides it entirely at α = 1.
            const previousEma = node.ema;
            const mean = moments ? moments.mean : calculateMean(values);
            const stdDev = moments ? moments.stdDev : calculateStdDev(values, mean);
            const deviation = Math.abs(value - previousEma);
            const deviationFactor = Math.abs(sigmaDeviation(value, previousEma, stdDev));
            node.ema = node.emaAlpha * value + (1 - node.emaAlpha) * previousEma;

            let severity = "normal";
            let isAnomaly = false;

            if (node.emaMethod === "stddev") {
                if (deviationFactor > cfg.emaThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationFactor > cfg.emaWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            } else {
                const deviationPercent = previousEma === 0 ? 0 : (deviation / Math.abs(previousEma)) * 100;
                if (deviationPercent > cfg.emaThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationPercent > cfg.emaWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    ema: node.ema,
                    deviation: deviation,
                    deviationFactor: deviationFactor,
                    alpha: node.emaAlpha
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL EMA=" + node.ema.toFixed(2)
                        : severity === "warning"
                          ? "warning EMA=" + node.ema.toFixed(2)
                          : "EMA=" + node.ema.toFixed(2)
            };
        }

        // CUSUM method. Drift and thresholds come from `cfg` (see detectPercentile).
        function detectCUSUM(value, values, moments, cfg) {
            const target =
                node.cusumTarget !== null ? node.cusumTarget : moments ? moments.mean : calculateMean(values);

            // σ mode: the deviation in units of the window's standard deviation
            let deviation = value - target;
            if (node.cusumMode === "sigma") {
                const stdDev = moments ? moments.stdDev : calculateStdDev(values, calculateMean(values));
                deviation = sigmaDeviation(value, target, stdDev);
            }
            node.cusumPos = Math.max(0, node.cusumPos + deviation - cfg.cusumDrift);
            node.cusumNeg = Math.max(0, node.cusumNeg - deviation - cfg.cusumDrift);

            const maxCusum = Math.max(node.cusumPos, node.cusumNeg);

            let severity = "normal";
            let isAnomaly = false;

            if (maxCusum > cfg.cusumThreshold) {
                severity = "critical";
                isAnomaly = true;
                // Reset after detection
                node.cusumPos = 0;
                node.cusumNeg = 0;
            } else if (maxCusum > cfg.cusumWarning) {
                severity = "warning";
                isAnomaly = true;
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    target: target,
                    cusumPos: node.cusumPos,
                    cusumNeg: node.cusumNeg,
                    cusumMax: maxCusum,
                    drift: cfg.cusumDrift,
                    mode: node.cusumMode
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL CUSUM=" + maxCusum.toFixed(2)
                        : severity === "warning"
                          ? "warning CUSUM=" + maxCusum.toFixed(2)
                          : "CUSUM=" + maxCusum.toFixed(2)
            };
        }

        // Moving Average method. Thresholds come from `cfg` (see detectPercentile).
        function detectMovingAverage(value, values, moments, cfg) {
            const movingAverage = moments ? moments.mean : calculateMean(values);
            const stdDev = moments ? moments.stdDev : calculateStdDev(values, movingAverage);
            const deviation = Math.abs(value - movingAverage);
            const deviationFactor = Math.abs(sigmaDeviation(value, movingAverage, stdDev));

            let severity = "normal";
            let isAnomaly = false;

            if (node.maMethod === "stddev") {
                if (deviationFactor > cfg.maThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationFactor > cfg.maWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            } else {
                const deviationPercent = movingAverage === 0 ? 0 : (deviation / Math.abs(movingAverage)) * 100;
                if (deviationPercent > cfg.maThreshold) {
                    severity = "critical";
                    isAnomaly = true;
                } else if (deviationPercent > cfg.maWarning) {
                    severity = "warning";
                    isAnomaly = true;
                }
            }

            return {
                isAnomaly: isAnomaly,
                severity: severity,
                details: {
                    movingAverage: movingAverage,
                    stdDev: stdDev,
                    deviation: deviation,
                    deviationFactor: deviationFactor
                },
                statusText:
                    severity === "critical"
                        ? "CRITICAL MA=" + movingAverage.toFixed(2)
                        : severity === "warning"
                          ? "warning MA=" + movingAverage.toFixed(2)
                          : "MA=" + movingAverage.toFixed(2)
            };
        }

        // Initialize multi-sensor buffers
        // (prototype-less: sensor names come straight from the payload, and a
        // sensor called "constructor" must not resolve to an inherited member)
        //
        //   sensorBuffers — the sliding window of each sensor (bare numbers)
        //   sensorMoments — its Welford accumulator + removal count, kept in
        //     lockstep the way windowValues/running are for the single value;
        //     see pushSensorWindow().
        node.sensorBuffers = Object.create(null);
        node.sensorMoments = Object.create(null);
        node.sensorStates = Object.create(null);
        node.sensorEma = Object.create(null);
        node.sensorCusum = Object.create(null);

        /**
         * Append a sample to one sensor's window, evicting the oldest once it
         * is full. Same scheme as pushWindow(): O(1) moments, rebuilt from the
         * window once per full turnover so the reverse update cannot drift.
         */
        function pushSensorWindow(sensorName, value) {
            const buffer = node.sensorBuffers[sensorName];
            const moments = node.sensorMoments[sensorName];
            buffer.push(value);
            moments.running.push(value);

            if (buffer.length > node.windowSize) {
                const dropped = buffer.shift();
                moments.running.remove(dropped);
                moments.removals++;
                if (moments.removals >= node.windowSize) {
                    moments.running.reset();
                    moments.removals = 0;
                    for (let i = 0; i < buffer.length; i++) {
                        moments.running.push(buffer[i]);
                    }
                }
            }
        }

        /** Mean/σ of one sensor's live window, straight from its accumulator. */
        function sensorMoments(sensorName) {
            const running = node.sensorMoments[sensorName].running;
            return { mean: running.mean(), stdDev: running.stdDev(), n: running.count() };
        }

        /**
         * Hysteresis shared by the single-value and the per-sensor path.
         *
         * Entering the anomaly state takes `consecutiveCount` anomalous samples
         * in a row (a normal sample in between restarts the count); leaving it
         * takes that many normal samples plus the configured deadband.
         *
         * @param {{lastAnomalyState:boolean, consecutiveAnomalies:number, consecutiveNormals:number}} state
         * @returns {{isAnomaly:boolean, applied:boolean}} `applied` = the raw verdict was overridden
         */
        function applyHysteresis(state, rawAnomaly, consecutiveCount) {
            let isAnomaly = false;
            let applied = false;
            if (rawAnomaly) {
                state.consecutiveAnomalies++;
                state.consecutiveNormals = 0;
                if (state.consecutiveAnomalies >= consecutiveCount || state.lastAnomalyState) {
                    isAnomaly = true;
                } else {
                    applied = true;
                }
            } else {
                state.consecutiveNormals++;
                state.consecutiveAnomalies = 0;
                if (state.lastAnomalyState) {
                    const exitCount = Math.max(
                        consecutiveCount,
                        Math.ceil(consecutiveCount * (1 + node.hysteresisPercent / 100))
                    );
                    if (state.consecutiveNormals < exitCount) {
                        isAnomaly = true; // stay in the anomaly state
                        applied = true;
                    }
                }
            }
            state.lastAnomalyState = isAnomaly;
            return { isAnomaly: isAnomaly, applied: applied };
        }

        /**
         * Process multi-sensor JSON input for anomaly detection
         * @param {Object} msg - The incoming message
         * @param {Object} sensorData - Object with sensor names as keys and values
         * @param {Function} send
         * @param {Object} active - the resolved configuration (see resolveActiveConfig)
         */
        function processMultiSensorInput(msg, sensorData, send, active) {
            const results = {};
            let anyAnomaly = false;
            let anyHysteresisApplied = false;
            let worstSeverity = "normal";
            const anomalySensors = [];
            const skippedSensors = [];

            const sensorNames = Object.keys(sensorData);
            const minRequired = active.method === "iqr" ? 4 : 2;

            sensorNames.forEach(function (sensorName) {
                const rawValue = sensorData[sensorName];
                const value = parseFloat(rawValue);

                // Validate value is a finite number (catches NaN, Infinity, -Infinity)
                if (!Number.isFinite(value)) {
                    skippedSensors.push({ name: sensorName, reason: "not a finite number", value: rawValue });
                    debugLog("Skipping sensor " + sensorName + ": value is not a finite number (" + rawValue + ")");
                    return;
                }

                // Initialize per-sensor buffers if needed
                if (!node.sensorBuffers[sensorName]) {
                    // Sensor names come from the payload; cap them so a stream
                    // of ever-new keys cannot grow the state without bound.
                    if (Object.keys(node.sensorBuffers).length >= MAX_SENSORS) {
                        skippedSensors.push({ name: sensorName, reason: "sensor limit reached", value: rawValue });
                        return;
                    }
                    node.sensorBuffers[sensorName] = [];
                    node.sensorMoments[sensorName] = { running: new stats.RunningStats(), removals: 0 };
                    node.sensorStates[sensorName] = {
                        lastAnomalyState: false,
                        consecutiveAnomalies: 0,
                        consecutiveNormals: 0
                    };
                    node.sensorEma[sensorName] = null;
                    node.sensorCusum[sensorName] = { pos: 0, neg: 0 };
                }

                // The window the sample is scored against: everything before it
                // (or, while the baseline is shorter than MIN_BASELINE, the
                // window it is part of) — the same rule, and the same O(1)
                // moments, as the single-value path. The detectors never
                // modify `values`, so the live window is handed over as is.
                const buffer = node.sensorBuffers[sensorName];
                let result = null;
                if (buffer.length >= Math.min(node.windowSize, MIN_BASELINE)) {
                    result = detectWith(active, value, buffer, sensorMoments(sensorName), sensorName);
                    pushSensorWindow(sensorName, value);
                } else {
                    pushSensorWindow(sensorName, value);
                    if (buffer.length >= minRequired) {
                        result = detectWith(active, value, buffer, sensorMoments(sensorName), sensorName);
                    }
                }

                // Minimum data check
                if (!result) {
                    results[sensorName] = {
                        value: value,
                        isAnomaly: false,
                        severity: "warmup",
                        bufferSize: buffer.length,
                        minRequired: minRequired
                    };
                    return;
                }

                // Per-sensor hysteresis — the same rules as the single-value path
                const sensorState = node.sensorStates[sensorName];
                let finalIsAnomaly = result.isAnomaly;
                let hysteresisApplied = false;
                if (active.hysteresisEnabled) {
                    const h = applyHysteresis(sensorState, result.isAnomaly, active.consecutiveCount);
                    finalIsAnomaly = h.isAnomaly;
                    hysteresisApplied = h.applied;
                    if (hysteresisApplied) anyHysteresisApplied = true;
                    if (finalIsAnomaly && !result.isAnomaly) {
                        result.severity = "warning"; // held by the exit deadband
                    }
                }

                results[sensorName] = {
                    value: value,
                    isAnomaly: finalIsAnomaly,
                    rawAnomaly: result.isAnomaly,
                    severity: finalIsAnomaly ? result.severity : "normal",
                    method: active.method,
                    bufferSize: buffer.length,
                    details: result.details || {}
                };
                if (active.hysteresisEnabled) {
                    results[sensorName].hysteresis = {
                        applied: hysteresisApplied,
                        consecutiveAnomalies: sensorState.consecutiveAnomalies,
                        consecutiveNormals: sensorState.consecutiveNormals
                    };
                }

                if (finalIsAnomaly) {
                    anyAnomaly = true;
                    anomalySensors.push(sensorName);
                    if (
                        result.severity === "critical" ||
                        (worstSeverity !== "critical" && result.severity === "warning")
                    ) {
                        worstSeverity = result.severity;
                    }
                }
            });

            // Check if any valid sensors were processed
            const validSensorCount = Object.keys(results).length;
            if (validSensorCount === 0) {
                errorHandler.handleNodeError(node, "No valid sensor readings in input", msg, "warn", {
                    statusText: "no valid sensors"
                });
                return;
            }

            // Build output message — the same envelope as the single-value
            // output: output topic, timestamp, hysteresis block, and every
            // inbound property that is not computed here rides along.
            const outMsg = {
                payload: results,
                isAnomaly: anyAnomaly,
                severity: anyAnomaly ? worstSeverity : "normal",
                anomalySensors: anomalySensors,
                sensorCount: validSensorCount,
                totalSensors: sensorNames.length,
                skippedSensors: skippedSensors.length > 0 ? skippedSensors : undefined,
                method: active.method,
                windowSize: node.windowSize,
                inputFormat: "multi-sensor",
                hysteresis: {
                    enabled: active.hysteresisEnabled,
                    applied: anyHysteresisApplied
                },
                timestamp: Date.now(),
                _msgid: msg._msgid
            };
            if (node.regimeProperty) outMsg.regime = node.activeRegime;
            if (node.groupBy) outMsg.group = node.activeGroup;
            if (node.outputTopic) outMsg.topic = node.outputTopic;
            copyPassthrough(outMsg, msg, { preserveTopic: !node.outputTopic });

            // Update status
            if (anyAnomaly) {
                node.status({
                    fill: worstSeverity === "critical" ? "red" : "yellow",
                    shape: "dot",
                    text: worstSeverity.toUpperCase() + ": " + anomalySensors.join(", ")
                });
                send([null, outMsg]);
            } else {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: validSensorCount + " sensors OK"
                });
                send([outMsg, null]);
            }
        }

        // EMA detection for specific sensor (isolated per-sensor state)
        function detectEMASensor(value, values, sensorName, moments, cfg) {
            // Swap in per-sensor state before detection
            const savedEma = node.ema;
            const savedInitialized = node.initialized;
            if (node.sensorEma[sensorName] !== null && node.sensorEma[sensorName] !== undefined) {
                node.ema = node.sensorEma[sensorName];
                node.initialized = true;
            } else {
                node.ema = null;
                node.initialized = false;
            }

            const result = detectEMA(value, values, moments, cfg);

            // Save per-sensor state and restore global
            node.sensorEma[sensorName] = node.ema;
            node.ema = savedEma;
            node.initialized = savedInitialized;
            return result;
        }

        // CUSUM detection for specific sensor (isolated per-sensor state)
        function detectCUSUMSensor(value, values, sensorName, moments, cfg) {
            // Swap in per-sensor state before detection
            const savedPos = node.cusumPos;
            const savedNeg = node.cusumNeg;
            if (node.sensorCusum[sensorName]) {
                node.cusumPos = node.sensorCusum[sensorName].pos;
                node.cusumNeg = node.sensorCusum[sensorName].neg;
            } else {
                node.cusumPos = 0;
                node.cusumNeg = 0;
            }

            const result = detectCUSUM(value, values, moments, cfg);

            // Save per-sensor state and restore global
            node.sensorCusum[sensorName] = { pos: node.cusumPos, neg: node.cusumNeg };
            node.cusumPos = savedPos;
            node.cusumNeg = savedNeg;
            return result;
        }

        /**
         * Score one sample with the resolved configuration — the one dispatch
         * shared by the single-value, multi-sensor and batch paths.
         *
         * @param {Object} active - see resolveActiveConfig
         * @param {number} value
         * @param {number[]} values - the window the sample is judged against
         * @param {{mean:number, stdDev:number, n:number}} [moments] - its
         *        mean/σ when already known (the streaming accumulators); the
         *        moment-based detectors fall back to the O(n) computation
         * @param {string} [sensorName] - selects the per-sensor EMA / CUSUM
         *        state in multi-sensor mode
         */
        function detectWith(active, value, values, moments, sensorName) {
            switch (active.method) {
                case "iqr":
                    return detectIQRWithConfig(value, values, active.iqrMultiplier, active.iqrWarning);
                case "threshold":
                    return detectThresholdWithConfig(value, active.minThreshold, active.maxThreshold);
                case "percentile":
                    return detectPercentile(value, values, active);
                case "ema":
                    return sensorName === undefined
                        ? detectEMA(value, values, moments, active)
                        : detectEMASensor(value, values, sensorName, moments, active);
                case "cusum":
                    return sensorName === undefined
                        ? detectCUSUM(value, values, moments, active)
                        : detectCUSUMSensor(value, values, sensorName, moments, active);
                case "moving-average":
                    return detectMovingAverage(value, values, moments, active);
                case "zscore":
                default:
                    return detectZScoreWithConfig(value, values, active.zscoreThreshold, active.zscoreWarning, moments);
            }
        }

        // ==========================================
        // ADAPTIVE THRESHOLDS - Learn from Feedback
        // ==========================================

        /**
         * Process operator feedback to adjust anomaly detection thresholds.
         * Uses confusion matrix tracking to calculate false positive/negative rates
         * and adjusts thresholds toward target error rate.
         *
         * @param {Object} feedback - Feedback object from operator
         * @param {boolean} feedback.predictedAnomaly - What the detector predicted
         * @param {boolean} feedback.wasAnomaly - What the operator confirms (ground truth)
         * @param {number} [feedback.value] - The sensor value for this detection
         * @returns {void}
         *
         * @example
         * // Send feedback that a detection was a false positive
         * msg.feedback = {
         *     predictedAnomaly: true,
         *     wasAnomaly: false,
         *     value: 42.5
         * };
         */
        function processAdaptiveFeedback(feedback) {
            if (!node.adaptiveEnabled) return;

            const state = node.adaptiveState;
            const entry = {
                timestamp: Date.now(),
                predicted: feedback.predictedAnomaly,
                actual: feedback.wasAnomaly,
                value: feedback.value
            };

            state.feedbackHistory.push(entry);

            // Keep only last 1000 feedback entries
            if (state.feedbackHistory.length > 1000) {
                state.feedbackHistory.shift();
            }

            // Update confusion matrix
            if (feedback.predictedAnomaly && feedback.wasAnomaly) {
                state.truePositives++;
            } else if (feedback.predictedAnomaly && !feedback.wasAnomaly) {
                state.falsePositives++;
            } else if (!feedback.predictedAnomaly && feedback.wasAnomaly) {
                state.falseNegatives++;
            } else {
                state.trueNegatives++;
            }

            // Calculate current false positive rate
            const totalPositives = state.truePositives + state.falsePositives;
            const totalNegatives = state.trueNegatives + state.falseNegatives;
            const totalSamples = totalPositives + totalNegatives;

            debugLog(
                "Adaptive feedback: TP=" +
                    state.truePositives +
                    " FP=" +
                    state.falsePositives +
                    " TN=" +
                    state.trueNegatives +
                    " FN=" +
                    state.falseNegatives
            );

            // Only adjust after minimum samples
            if (totalSamples < node.adaptiveMinSamples) {
                debugLog("Adaptive: waiting for more samples (" + totalSamples + "/" + node.adaptiveMinSamples + ")");
                return;
            }

            // Calculate false positive rate
            const falsePositiveRate = totalPositives > 0 ? state.falsePositives / totalPositives : 0;
            const falseNegativeRate =
                totalNegatives > 0 ? state.falseNegatives / (state.falseNegatives + state.trueNegatives) : 0;

            // Adjust threshold based on error rates
            let adjustment = 0;

            if (falsePositiveRate > node.targetFalsePositiveRate) {
                // Too many false positives - make threshold less sensitive (increase)
                adjustment = node.adaptiveLearningRate * (falsePositiveRate - node.targetFalsePositiveRate);
                debugLog(
                    "Adaptive: FP rate " +
                        (falsePositiveRate * 100).toFixed(1) +
                        "% > target, loosening threshold by " +
                        adjustment.toFixed(3)
                );
            } else if (falseNegativeRate > node.targetFalsePositiveRate * 2) {
                // Too many false negatives - make threshold more sensitive (decrease)
                adjustment = -node.adaptiveLearningRate * (falseNegativeRate - node.targetFalsePositiveRate);
                debugLog(
                    "Adaptive: FN rate " +
                        (falseNegativeRate * 100).toFixed(1) +
                        "% high, tightening threshold by " +
                        (-adjustment).toFixed(3)
                );
            }

            if (adjustment !== 0) {
                state.currentThresholdAdjustment += adjustment;
                // Limit adjustment range to ±50% of original threshold
                state.currentThresholdAdjustment = Math.max(-0.5, Math.min(0.5, state.currentThresholdAdjustment));
                state.lastAdjustmentTime = Date.now();

                debugLog(
                    "Adaptive: total threshold adjustment = " +
                        (state.currentThresholdAdjustment * 100).toFixed(1) +
                        "%"
                );
            }
        }

        /**
         * Get adaptive-adjusted threshold
         */
        function getAdaptiveThreshold(baseThreshold) {
            if (!node.adaptiveEnabled) return baseThreshold;
            const adjustment = node.adaptiveState.currentThresholdAdjustment;
            return baseThreshold * (1 + adjustment);
        }

        /**
         * Get adaptive statistics for output
         */
        function getAdaptiveStats() {
            const state = node.adaptiveState;
            const total = state.truePositives + state.falsePositives + state.trueNegatives + state.falseNegatives;

            return {
                enabled: node.adaptiveEnabled,
                feedbackCount: total,
                truePositives: state.truePositives,
                falsePositives: state.falsePositives,
                trueNegatives: state.trueNegatives,
                falseNegatives: state.falseNegatives,
                falsePositiveRate:
                    total > 0 ? state.falsePositives / Math.max(1, state.truePositives + state.falsePositives) : 0,
                precision:
                    state.truePositives + state.falsePositives > 0
                        ? state.truePositives / (state.truePositives + state.falsePositives)
                        : 1,
                recall:
                    state.truePositives + state.falseNegatives > 0
                        ? state.truePositives / (state.truePositives + state.falseNegatives)
                        : 1,
                thresholdAdjustment: state.currentThresholdAdjustment,
                lastAdjustmentTime: state.lastAdjustmentTime
            };
        }

        // Parse a per-message override; anything that is not a finite number
        // (NaN from a typo, null, an object) keeps the configured value.
        function finiteOr(raw, fallback) {
            if (raw === undefined || raw === null || raw === "") return fallback;
            const n = typeof raw === "number" ? raw : parseFloat(raw);
            return Number.isFinite(n) ? n : fallback;
        }
        function positiveOr(raw, fallback) {
            const n = finiteOr(raw, NaN);
            return n > 0 ? n : fallback;
        }

        // ==========================================
        // PER-MESSAGE CONFIGURATION (msg.config)
        // ==========================================

        const KNOWN_METHODS = ["zscore", "iqr", "threshold", "percentile", "ema", "cusum", "moving-average"];
        // Unknown msg.config.method values already reported (one warning each,
        // not one per message).
        const warnedMethods = new Set();

        function resolveMethod(requested) {
            if (requested === undefined || requested === null || requested === "") return node.method;
            if (KNOWN_METHODS.indexOf(requested) !== -1) return requested;
            const key = String(requested);
            if (!warnedMethods.has(key)) {
                warnedMethods.add(key);
                node.warn(
                    'msg.config.method "' +
                        key +
                        '" is not a detection method (' +
                        KNOWN_METHODS.join(", ") +
                        '); using "' +
                        node.method +
                        '"'
                );
            }
            return node.method;
        }

        // A percentile override must stay a percentile.
        function percentileOr(raw, fallback) {
            return Math.min(100, Math.max(0, finiteOr(raw, fallback)));
        }

        /**
         * The settings this message is scored with: the node configuration
         * with the message's `msg.config` overrides applied. A malformed
         * override (NaN, a non-positive threshold, an unknown method) keeps
         * the configured value instead of silently disabling the check.
         *
         * In batch mode the older per-message aliases `msg.method` and
         * `msg.threshold` are still honoured, after `msg.config`. They stay
         * batch-only: a streaming message that came out of another detector
         * carries a `method` property of its own.
         *
         * @param {Object} msg
         * @param {boolean} [batch=false]
         */
        function resolveActiveConfig(msg, batch) {
            const cfg = msg.config && typeof msg.config === "object" ? msg.config : {};
            const hasCfgMethod = cfg.method !== undefined && cfg.method !== null && cfg.method !== "";
            const method = resolveMethod(hasCfgMethod ? cfg.method : batch ? msg.method : undefined);

            // The legacy alias set only a critical z threshold; its warning
            // band sat at 67 % of it.
            const legacyThreshold = batch ? positiveOr(msg.threshold, null) : null;
            let zscoreThreshold = positiveOr(
                cfg.zscoreThreshold,
                legacyThreshold !== null ? legacyThreshold : node.zscoreThreshold
            );
            let zscoreWarning = positiveOr(
                cfg.zscoreWarning,
                legacyThreshold !== null ? legacyThreshold * 0.67 : node.zscoreWarning
            );
            // Apply adaptive threshold adjustment
            zscoreThreshold = getAdaptiveThreshold(zscoreThreshold);
            zscoreWarning = getAdaptiveThreshold(zscoreWarning);

            const iqrMultiplier = positiveOr(cfg.iqrMultiplier, node.iqrMultiplier);
            // Overriding only the critical multiplier drops the configured
            // warning multiplier (it may no longer lie inside the new band).
            const iqrWarning =
                cfg.iqrMultiplier !== undefined
                    ? positiveOr(cfg.iqrWarningMultiplier, 0)
                    : positiveOr(cfg.iqrWarningMultiplier, node.iqrWarningMultiplier);

            return {
                method: method,
                zscoreThreshold: zscoreThreshold,
                zscoreWarning: zscoreWarning,
                iqrMultiplier: iqrMultiplier,
                iqrWarning: iqrWarning,
                minThreshold: finiteOr(cfg.minThreshold, node.minThreshold),
                maxThreshold: finiteOr(cfg.maxThreshold, node.maxThreshold),
                lowerPercentile: percentileOr(cfg.lowerPercentile, node.lowerPercentile),
                upperPercentile: percentileOr(cfg.upperPercentile, node.upperPercentile),
                emaThreshold: positiveOr(cfg.emaThreshold, node.emaThreshold),
                emaWarning: positiveOr(cfg.emaWarning, node.emaWarning),
                cusumThreshold: positiveOr(cfg.cusumThreshold, node.cusumThreshold),
                cusumWarning: positiveOr(cfg.cusumWarning, node.cusumWarning),
                cusumDrift: Math.max(0, finiteOr(cfg.cusumDrift, node.cusumDrift)),
                maThreshold: positiveOr(cfg.maThreshold, node.maThreshold),
                maWarning: positiveOr(cfg.maWarning, node.maWarning),
                hysteresisEnabled:
                    cfg.hysteresisEnabled !== undefined ? cfg.hysteresisEnabled === true : node.hysteresisEnabled,
                consecutiveCount: Math.max(1, Math.floor(positiveOr(cfg.consecutiveCount, node.consecutiveCount)))
            };
        }

        // ==========================================
        // BATCH PROCESSING - Historical Data Analysis
        // ==========================================

        /**
         * Process a batch of historical values
         * @param {Array} values - Array of values or {timestamp, value} objects
         * @param {Object} active - the resolved configuration (see resolveActiveConfig)
         * @returns {Object} Batch analysis results
         */
        function processBatch(values, active) {
            if (!Array.isArray(values)) {
                throw new Error("batch mode expects msg.payload to be an array");
            }
            const results = [];
            let anomalyCount = 0;
            let warningCount = 0;
            let normalCount = 0;
            const anomalyIndices = [];

            // Only the stateless detectors can replay a batch; the stateful
            // ones (ema, cusum) are scored as z-score, and the result says so.
            const BATCH_METHODS = ["zscore", "iqr", "threshold", "percentile", "moving-average"];
            const requested = active.method;
            const effectiveMethod = BATCH_METHODS.indexOf(requested) !== -1 ? requested : "zscore";
            const batchConfig =
                effectiveMethod === requested ? active : Object.assign({}, active, { method: effectiveMethod });

            // Sliding window of the values *before* the one being scored
            const window = [];
            const minRequired = effectiveMethod === "iqr" ? 4 : 2;

            let count = 0;
            let sum = 0;
            let sumSq = 0;
            let min = Infinity;
            let max = -Infinity;

            for (let i = 0; i < values.length; i++) {
                const item = values[i];
                const isObject = typeof item === "object" && item !== null;
                const value = parseFloat(isObject ? item.value : item);
                const timestamp = isObject && item.timestamp !== undefined ? item.timestamp : Date.now();

                if (!Number.isFinite(value)) continue;

                count++;
                sum += value;
                sumSq += value * value;
                if (value < min) min = value;
                if (value > max) max = value;

                // Short baselines are scored within the window (see MIN_BASELINE)
                const scoreWithin = window.length < Math.min(node.windowSize, MIN_BASELINE);
                if (scoreWithin) {
                    window.push(value);
                }

                if (window.length < minRequired) {
                    results.push({
                        index: i,
                        value: value,
                        timestamp: timestamp,
                        isAnomaly: false,
                        severity: "warmup"
                    });
                } else {
                    const result = detectWith(batchConfig, value, window);

                    results.push({
                        index: i,
                        value: value,
                        timestamp: timestamp,
                        isAnomaly: result.isAnomaly,
                        severity: result.severity,
                        details: result.details
                    });

                    if (result.isAnomaly) {
                        anomalyIndices.push(i);
                        if (result.severity === "critical") {
                            anomalyCount++;
                        } else {
                            warningCount++;
                        }
                    } else {
                        normalCount++;
                    }
                }

                if (!scoreWithin) {
                    window.push(value);
                    if (window.length > node.windowSize) {
                        window.shift();
                    }
                }
            }

            // Statistics over all valid values (accumulated above: no spread
            // call, which overflows the stack on a large batch)
            const mean = count > 0 ? sum / count : 0;
            const stats = {
                count: count,
                mean: mean,
                stdDev: count > 1 ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0,
                min: count > 0 ? min : 0,
                max: count > 0 ? max : 0
            };

            return {
                results: results,
                summary: {
                    totalSamples: values.length,
                    anomalies: anomalyCount,
                    warnings: warningCount,
                    normal: normalCount,
                    anomalyRate: values.length > 0 ? (anomalyCount + warningCount) / values.length : 0,
                    anomalyIndices: anomalyIndices
                },
                statistics: stats,
                method: effectiveMethod,
                requestedMethod: requested,
                windowSize: node.windowSize,
                batchMode: true
            };
        }

        // ==========================================
        // WEBSOCKET BROADCAST
        // ==========================================

        /**
         * Broadcast result via WebSocket
         */
        function broadcastResult(result) {
            if (!node.wsManager || !node.wsManager.isRunning) return;

            try {
                node.wsManager.broadcast(node.websocketTopic, {
                    nodeId: node.id,
                    nodeName: node.name || "Anomaly Detector",
                    ...result
                });
            } catch (err) {
                debugLog("WebSocket broadcast error: " + err.message);
            }
        }

        node.on("input", function (msg, send, done) {
            // Node-RED >=1.0 passes send/done; shim for older runtimes.
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };
            send =
                send ||
                function () {
                    node.send.apply(node, arguments);
                };
            try {
                // ==========================================
                // FEEDBACK PROCESSING (Adaptive Thresholds)
                // ==========================================
                if (msg.feedback) {
                    processAdaptiveFeedback(msg.feedback);
                    const adaptiveStats = getAdaptiveStats();
                    node.status({
                        fill: "blue",
                        shape: "dot",
                        text:
                            "Feedback: " +
                            adaptiveStats.feedbackCount +
                            " samples, adj=" +
                            (adaptiveStats.thresholdAdjustment * 100).toFixed(1) +
                            "%"
                    });

                    // Send feedback confirmation
                    const feedbackMsg = {
                        payload: adaptiveStats,
                        topic: "adaptive-feedback",
                        _msgid: msg._msgid
                    };
                    send([feedbackMsg, null]);
                    done();
                    return;
                }

                // ==========================================
                // BATCH PROCESSING MODE
                // ==========================================
                if (
                    msg.batch === true ||
                    (node.batchMode &&
                        Array.isArray(msg.payload) &&
                        msg.payload.length > 1 &&
                        typeof msg.payload[0] !== "object")
                ) {
                    // Array of raw numbers for batch processing, scored with
                    // the same resolved configuration as the streaming paths
                    // (plus the legacy msg.method / msg.threshold aliases).
                    const batchResult = processBatch(msg.payload, resolveActiveConfig(msg, true));

                    const batchMsg = {
                        payload: batchResult,
                        topic: msg.topic || "batch-analysis",
                        _msgid: msg._msgid
                    };

                    // Broadcast via WebSocket
                    if (node.websocketEnabled) {
                        broadcastResult({
                            type: "batch",
                            ...batchResult.summary,
                            statistics: batchResult.statistics
                        });
                    }

                    node.status({
                        fill: batchResult.summary.anomalies > 0 ? "red" : "green",
                        shape: "dot",
                        text:
                            "Batch: " +
                            batchResult.summary.anomalies +
                            "/" +
                            batchResult.summary.totalSamples +
                            " anomalies"
                    });

                    // Output batch results (anomalies found = output 2, no anomalies = output 1)
                    if (batchResult.summary.anomalies > 0 || batchResult.summary.warnings > 0) {
                        send([null, batchMsg]);
                    } else {
                        send([batchMsg, null]);
                    }
                    done();
                    return;
                }

                // Dynamic configuration via msg.config: the node settings with
                // this message's overrides applied (every method's thresholds).
                const active = resolveActiveConfig(msg);

                // msg.reset === "all" clears every regime; msg.reset === true
                // clears the active one (which is the only one when no
                // regime property is configured).
                if (msg.reset === "all") {
                    resetAllRegimes();
                    node.status({ fill: "blue", shape: "ring", text: active.method + " - reset (all regimes)" });
                    done();
                    return;
                }

                // Reset function
                if (msg.reset === true) {
                    // The baseline of this message's operating point is the one
                    // being cleared.
                    switchRegime(msg);
                    node.dataBuffer = [];
                    resyncWindow();
                    node.sensorBuffers = Object.create(null); // For multi-sensor mode
                    node.sensorMoments = Object.create(null);
                    node.sensorStates = Object.create(null); // Hysteresis states per sensor
                    node.sensorEma = Object.create(null);
                    node.sensorCusum = Object.create(null);
                    node.ema = null;
                    node.cusumPos = 0;
                    node.cusumNeg = 0;
                    node.initialized = false;
                    node.lastAnomalyState = false;
                    node.consecutiveAnomalies = 0;
                    node.consecutiveNormals = 0;

                    // Reset adaptive state if requested
                    if (msg.resetAdaptive === true) {
                        node.adaptiveState = {
                            feedbackHistory: [],
                            truePositives: 0,
                            falsePositives: 0,
                            trueNegatives: 0,
                            falseNegatives: 0,
                            currentThresholdAdjustment: 0,
                            lastAdjustmentTime: null
                        };
                    }

                    node.status({ fill: "blue", shape: "ring", text: active.method + " - reset" });
                    done();
                    return;
                }

                // The baseline for a message's operating point is selected only
                // once its payload has passed validation: a rejected payload
                // carrying a fresh regime / group value must not create a state
                // (and evict a real baseline from the LRU map) on its way out.

                // Check if payload is JSON object or array (multi-sensor mode)
                if (typeof msg.payload === "object" && msg.payload !== null && !Array.isArray(msg.payload)) {
                    // JSON object input: { "sensor1": 25.5, "sensor2": 30.2, ... }
                    switchRegime(msg);
                    processMultiSensorInput(msg, msg.payload, send, active);
                    done();
                    return;
                } else if (Array.isArray(msg.payload) && msg.payload.length > 0 && typeof msg.payload[0] === "object") {
                    // Array of sensor objects: [{ name: "temp", value: 25.5 }, ...]
                    const sensorData = {};
                    msg.payload.forEach(function (item) {
                        if (item && item.name && item.value !== undefined) {
                            sensorData[item.name] = item.value;
                        }
                    });
                    switchRegime(msg);
                    processMultiSensorInput(msg, sensorData, send, active);
                    done();
                    return;
                }

                // SECURITY: Strict number validation
                // parseFloat("123abc") returns 123 which can be misleading
                let value;
                if (typeof msg.payload === "number") {
                    value = msg.payload;
                } else if (typeof msg.payload === "string") {
                    // Only accept strings that are purely numeric
                    const trimmed = msg.payload.trim();
                    if (trimmed === "" || !/^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(trimmed)) {
                        node.status({ fill: "red", shape: "ring", text: "invalid input" });
                        done("Payload is not a valid number: " + msg.payload);
                        return;
                    }
                    value = parseFloat(trimmed);
                } else {
                    node.status({ fill: "red", shape: "ring", text: "invalid input" });
                    done("Payload must be a number or numeric string, got: " + typeof msg.payload);
                    return;
                }

                if (!Number.isFinite(value)) {
                    node.status({ fill: "red", shape: "ring", text: "invalid input" });
                    done("Payload is not a finite number (NaN or Infinity)");
                    return;
                }

                // Select the baseline for this message's operating point.
                switchRegime(msg);

                // The sample is scored against the window as it stood *before*
                // it arrived (once that window is long enough, see MIN_BASELINE).
                // Scoring it against a window that already contains it lets an
                // outlier inflate its own baseline: the z-score is then capped
                // at sqrt(n − 1), so a small window could never reach a critical
                // threshold however extreme the value.
                const minRequired = active.method === "iqr" ? 4 : 2;

                let result = null;
                if (node.windowValues.length >= Math.min(node.windowSize, MIN_BASELINE)) {
                    result = detectWith(active, value, node.windowValues, liveMoments());
                    pushWindow(value);
                } else {
                    // Add to buffer
                    pushWindow(value);
                    // Baseline still too short (see MIN_BASELINE): score the
                    // sample within the window it is part of.
                    if (node.windowValues.length >= minRequired) {
                        result = detectWith(active, value, node.windowValues, liveMoments());
                    }
                }

                // Persist state periodically (every 10th sample to reduce overhead)
                node.sampleCount++;
                if (node.stateManager && node.sampleCount % 10 === 0) {
                    persistCurrentState();
                }

                if (!result) {
                    node.status({
                        fill: "yellow",
                        shape: "ring",
                        text: "warmup " + node.dataBuffer.length + "/" + minRequired
                    });
                    send(msg);
                    done();
                    return;
                }

                // Apply hysteresis to prevent alarm flickering
                let finalIsAnomaly = result.isAnomaly;
                let hysteresisApplied = false;

                if (active.hysteresisEnabled) {
                    // `node` itself carries the counters of the active regime
                    const h = applyHysteresis(node, result.isAnomaly, active.consecutiveCount);
                    finalIsAnomaly = h.isAnomaly;
                    hysteresisApplied = h.applied;
                }

                debugLog(
                    active.method +
                        ": value=" +
                        value +
                        ", rawAnomaly=" +
                        result.isAnomaly +
                        ", finalAnomaly=" +
                        finalIsAnomaly +
                        ", hysteresis=" +
                        hysteresisApplied +
                        ", consec_anom=" +
                        node.consecutiveAnomalies +
                        ", consec_norm=" +
                        node.consecutiveNormals
                );

                // Update status
                const statusColor =
                    result.severity === "critical" ? "red" : result.severity === "warning" ? "yellow" : "green";
                const statusShape = hysteresisApplied ? "ring" : "dot";
                node.status({ fill: statusColor, shape: statusShape, text: result.statusText });

                // Build output message
                const outputMsg = {
                    payload: value,
                    isAnomaly: finalIsAnomaly,
                    rawAnomaly: result.isAnomaly,
                    severity: result.severity,
                    method: active.method,
                    bufferSize: node.dataBuffer.length,
                    windowSize: node.windowSize,
                    hysteresis: {
                        enabled: active.hysteresisEnabled,
                        applied: hysteresisApplied,
                        consecutiveAnomalies: node.consecutiveAnomalies,
                        consecutiveNormals: node.consecutiveNormals
                    },
                    timestamp: Date.now()
                };
                if (node.regimeProperty) outputMsg.regime = node.activeRegime;
                if (node.groupBy) outputMsg.group = node.activeGroup;

                // Add adaptive threshold info
                if (node.adaptiveEnabled) {
                    outputMsg.adaptive = getAdaptiveStats();
                    outputMsg.adaptive.adjustedThreshold = active.zscoreThreshold;
                }

                // Broadcast via WebSocket for real-time dashboards
                if (node.websocketEnabled && node.wsManager) {
                    broadcastResult({
                        type: "single",
                        value: value,
                        isAnomaly: finalIsAnomaly,
                        severity: result.severity,
                        method: active.method,
                        details: result.details,
                        timestamp: outputMsg.timestamp
                    });
                }

                // Set topic if configured
                if (node.outputTopic) {
                    outputMsg.topic = node.outputTopic;
                }

                // Add method-specific details
                Object.assign(outputMsg, result.details);

                // Copy original message properties (payload included — this node
                // only sets outputMsg.payload in some branches); keep the inbound
                // topic when no output topic is configured.
                copyPassthrough(outputMsg, msg, {
                    includePayload: true,
                    preserveTopic: !node.outputTopic
                });

                // Output: normal to output 1, anomaly to output 2
                if (finalIsAnomaly) {
                    send([null, outputMsg]);
                } else {
                    send([outputMsg, null]);
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done("Error in anomaly detection: " + err.message);
            }
        });

        node.on("close", async function (done) {
            // Save state before closing if persistence enabled
            if (persistence) {
                await persistence.close();
            }

            // Hand the shared WebSocket manager back. Other nodes may still
            // hold it; the last release stops the server, and that is awaited
            // so the replacement node (same port) starts against a closed one.
            if (node.wsManager) {
                if (node.wsListeners) {
                    Object.keys(node.wsListeners).forEach(function (evt) {
                        node.wsManager.removeListener(evt, node.wsListeners[evt]);
                    });
                    node.wsListeners = null;
                }
                node.wsManager = null;
                try {
                    await WebSocketManager.releaseWebSocketManager();
                } catch (err) {
                    node.warn("Error stopping WebSocket server: " + err.message);
                }
            }

            node.dataBuffer = [];
            resyncWindow();
            node.ema = null;
            node.cusumPos = 0;
            node.cusumNeg = 0;
            node.initialized = false;
            node.lastAnomalyState = false;
            node.consecutiveAnomalies = 0;
            node.consecutiveNormals = 0;
            node.status({});

            if (done) done();
        });
    }

    RED.nodes.registerType("anomaly-detector", AnomalyDetectorNode, {
        credentials: {
            websocketAuthToken: { type: "password" }
        }
    });
};
