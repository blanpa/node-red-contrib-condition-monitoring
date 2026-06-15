module.exports = function (RED) {
    "use strict";

    // Config validation: parse + range-clamp (0 stays 0 where it is valid)
    const { clampInt, clampFloat } = require("./utils/config-validator");

    // Standardized error handling + prototype-pollution sanitizer
    const errorHandler = require("./utils/error-handler");

    /**
     * Deterministic pseudo-random generator (mulberry32).
     * Used when a seed is configured so simulations are reproducible.
     *
     * @param {number} seed - 32-bit integer seed
     * @returns {function(): number} Generator returning floats in [0, 1)
     */
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Characteristic vibration order (× shaft frequency) per fault type.
    const FAULT_DEFS = [
        { key: "imbalance", order: 1.0, gain: 2.6, label: "Unwucht (1× Drehfrequenz)" },
        { key: "misalignment", order: 2.0, gain: 2.1, label: "Ausrichtungsfehler (2×)" },
        { key: "bearing", order: 3.5, gain: 4.2, label: "Lagerschaden (~3.5× / BPFO)" },
        { key: "looseness", order: 0.5, gain: 1.6, label: "Mechanische Lockerung (0.5×)" }
    ];

    function ConditionMonitoringSourceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // ----------------------------- Configuration -----------------------------
        node.assetType = config.assetType || "pump";
        node.rpm = clampFloat(config.rpm, 1, 100000, 1500);
        node.load = clampFloat(config.load, 0, 100, 70);
        node.degRate = clampFloat(config.degRate, 0, 100, 0.06); // % health loss per simulated hour
        node.noise = clampFloat(config.noise, 0, 1, 0.3);

        node.intervalMs = clampInt(config.intervalMs, 50, 86400000, 1000); // real time between samples
        node.hoursPerSample = clampFloat(config.hoursPerSample, 0.0001, 1000000, 2); // simulated hours per sample

        node.faults = {
            imbalance: clampFloat(config.faultImbalance, 0, 1, 0),
            misalignment: clampFloat(config.faultMisalignment, 0, 1, 0),
            bearing: clampFloat(config.faultBearing, 0, 1, 0),
            looseness: clampFloat(config.faultLooseness, 0, 1, 0)
        };

        node.warnThreshold = clampFloat(config.warnThreshold, 0, 100000, 4.5); // mm/s RMS
        node.alarmThreshold = clampFloat(config.alarmThreshold, 0, 100000, 7.1); // mm/s RMS

        node.autoStart = config.autoStart === true;
        node.onFailure = config.onFailure || "reset"; // reset | stop | continue
        node.outputFormat = config.outputFormat || "object"; // object | value | waveform
        node.sampleRate = clampInt(config.sampleRate, 64, 1000000, 2560); // Hz, for waveform mode
        node.frameSize = clampInt(config.frameSize, 16, 1048576, 2048); // samples per waveform frame
        node.outputTopic = config.outputTopic || "";
        node.debugEnabled = config.debug === true;

        // Optional seed for reproducible streams (empty = non-deterministic).
        const seedParsed = parseInt(config.seed, 10);
        node.rng = Number.isFinite(seedParsed) ? mulberry32(seedParsed) : Math.random;

        // ------------------------------- Runtime state ---------------------------
        node.simHours = 0;
        node.health = 100;
        node.sampleCount = 0;
        node.running = false;
        node.timer = null;

        const debugLog = function (message) {
            if (node.debugEnabled) {
                node.log(message);
            }
        };

        // --------------------------- Simulation primitives ------------------------

        // Health loss per simulated hour: degradation × load factor × fault factor.
        function lossPerHour() {
            const loadFactor = 0.3 + (node.load / 100) * 1.0;
            const faultTotal =
                node.faults.imbalance + node.faults.misalignment + node.faults.bearing + node.faults.looseness;
            return Math.max(0, node.degRate) * loadFactor * (1 + faultTotal * 1.5);
        }

        // Estimate remaining useful life (RUL) from current health and slope.
        function estimateRUL() {
            const lph = lossPerHour();
            if (lph <= 0) {
                return { hours: null, label: "stabil", lossPerHour: 0 };
            }
            const hours = node.health / lph;
            let label;
            if (hours >= 48) {
                label = (hours / 24).toFixed(1) + " d";
            } else {
                label = hours.toFixed(1) + " h";
            }
            return { hours: +hours.toFixed(2), label: label, lossPerHour: +lph.toFixed(4) };
        }

        function noiseValue(amplitude) {
            return (node.rng() - 0.5) * 2 * amplitude * node.noise;
        }

        // Build the list of active fault signatures relative to shaft frequency.
        function detectFaults(shaftFreq, deg) {
            const list = [];
            FAULT_DEFS.forEach(function (def) {
                const severity = node.faults[def.key];
                if (severity > 0.05) {
                    const amplitude = severity * (0.5 + deg) * 3;
                    list.push({
                        type: def.key,
                        description: def.label,
                        order: def.order,
                        frequencyHz: +(shaftFreq * def.order).toFixed(2),
                        amplitude: +amplitude.toFixed(3),
                        severity: severity > 0.6 ? "high" : severity > 0.3 ? "medium" : "low"
                    });
                }
            });
            return list;
        }

        /**
         * Advance the simulation by one sample and compute all derived sensor
         * values, fault signatures, health and RUL.
         *
         * @returns {Object} A structured sample.
         */
        function computeSample() {
            node.simHours += node.hoursPerSample;
            const lph = lossPerHour();
            node.health = Math.max(0, node.health - lph * node.hoursPerSample);
            node.sampleCount++;

            const deg = (100 - node.health) / 100;
            const f = node.faults;

            const vibration = Math.max(
                0.05,
                0.9 +
                    node.load * 0.012 +
                    deg * 6 +
                    (f.imbalance * 2.6 + f.misalignment * 2.1 + f.bearing * 4.2 + f.looseness * 1.6) +
                    noiseValue(0.6)
            );
            const temperature = 38 + node.load * 0.28 + deg * 32 + f.bearing * 9 + f.misalignment * 2 + noiseValue(2);
            const current =
                7.5 + node.load * 0.06 + (f.misalignment * 1.6 + f.looseness * 1.1 + deg * 1.5) + noiseValue(0.3);
            const pressure = Math.max(0, 4.6 - deg * 1.6 - f.looseness * 0.4 + noiseValue(0.15));

            const shaftFreq = node.rpm / 60;
            const faultSignatures = detectFaults(shaftFreq, deg);

            let level = "normal";
            if (vibration >= node.alarmThreshold) {
                level = "alarm";
            } else if (vibration >= node.warnThreshold) {
                level = "warning";
            }

            const rul = estimateRUL();

            return {
                asset: node.assetType,
                timestamp: Date.now(),
                simHours: +node.simHours.toFixed(2),
                sampleCount: node.sampleCount,
                health: +node.health.toFixed(2),
                status: level,
                rul: rul,
                rpm: node.rpm,
                shaftFrequencyHz: +shaftFreq.toFixed(2),
                sensors: {
                    vibrationRMS: +vibration.toFixed(3),
                    temperature: +temperature.toFixed(2),
                    current: +current.toFixed(3),
                    pressure: +pressure.toFixed(3)
                },
                units: { vibrationRMS: "mm/s", temperature: "°C", current: "A", pressure: "bar" },
                faults: faultSignatures,
                thresholds: { warn: node.warnThreshold, alarm: node.alarmThreshold }
            };
        }

        /*
         * Synthesize a realistic time-domain vibration frame (so the
         * signal-analyzer node can actually run FFT / envelope / kurtosis on it).
         * Components sit at their characteristic orders of the shaft frequency:
         *   imbalance 1×, misalignment 2× (+1×), looseness 0.5×/1.5×/2.5×,
         *   bearing: a structural resonance rung as an impact train at BPFO (3.5×).
         * The whole frame is scaled so its RMS equals the trended vibration RMS.
         */
        function buildWaveform(vibrationRMS, shaftFreq, deg) {
            const Fs = node.sampleRate;
            const N = node.frameSize;
            const f = shaftFreq;
            const fl = node.faults;
            const g = (s) => s * (0.5 + deg);
            const TWO_PI = 2 * Math.PI;
            const bpfo = 3.5 * f; // bearing outer-race ball-pass frequency
            const res = Math.min(Fs / 2.5, 24 * f); // structural resonance excited by impacts
            const Tb = bpfo > 0 ? 1 / bpfo : 0;
            const buf = new Array(N);
            for (let n = 0; n < N; n++) {
                const t = n / Fs;
                let x = 0.3 * Math.sin(TWO_PI * f * t); // residual running speed (1×)
                x += g(fl.imbalance) * 2.6 * Math.sin(TWO_PI * f * t); // imbalance → 1×
                x += g(fl.misalignment) * (2.1 * Math.sin(TWO_PI * 2 * f * t) + 0.8 * Math.sin(TWO_PI * f * t)); // misalignment → 2×
                x +=
                    g(fl.looseness) *
                    1.6 *
                    (Math.sin(TWO_PI * 0.5 * f * t) +
                        0.6 * Math.sin(TWO_PI * 1.5 * f * t) +
                        0.4 * Math.sin(TWO_PI * 2.5 * f * t)); // looseness → sub/harmonics
                if (g(fl.bearing) > 0 && Tb > 0) {
                    const phase = t % Tb; // time since last impact
                    x += g(fl.bearing) * 4.2 * Math.sin(TWO_PI * res * phase) * Math.exp(-phase * res * 0.6); // ring-down impact train
                }
                x += (node.rng() - 0.5) * 2 * (0.4 + deg) * (0.5 + node.noise); // broadband noise
                buf[n] = x;
            }
            // scale the frame so its RMS matches the trended vibration RMS (mm/s)
            let ss = 0;
            for (let n = 0; n < N; n++) ss += buf[n] * buf[n];
            const rms = Math.sqrt(ss / N) || 1;
            const k = vibrationRMS / rms;
            for (let n = 0; n < N; n++) buf[n] = +(buf[n] * k).toFixed(5);
            return buf;
        }

        // Map a computed sample to an outgoing Node-RED message.
        function buildMessage(sample) {
            const msg = {
                topic: node.outputTopic || node.assetType,
                payload: node.outputFormat === "value" ? sample.sensors.vibrationRMS : sample,
                status: sample.status,
                health: sample.health,
                rul: sample.rul,
                alarm: sample.status === "alarm",
                timestamp: sample.timestamp
            };
            if (node.outputFormat === "value") {
                // Keep the rich detail accessible without occupying payload.
                msg.condition = sample;
            } else if (node.outputFormat === "waveform") {
                // Emit a raw vibration time-signal for the signal-analyzer node.
                const deg = (100 - sample.health) / 100;
                msg.payload = buildWaveform(sample.sensors.vibrationRMS, sample.shaftFrequencyHz, deg);
                msg.samplingRate = node.sampleRate;
                msg.condition = sample;
            }
            return msg;
        }

        function updateStatus(sample) {
            const fill = sample.status === "alarm" ? "red" : sample.status === "warning" ? "yellow" : "green";
            node.status({
                fill: fill,
                shape: node.running ? "dot" : "ring",
                text:
                    "H:" +
                    sample.health.toFixed(0) +
                    "% | RMS:" +
                    sample.sensors.vibrationRMS.toFixed(2) +
                    " | RUL:" +
                    sample.rul.label
            });
        }

        // Apply the failure policy once health reaches zero.
        function applyFailurePolicy(sample) {
            if (sample.health > 0) return;
            if (node.onFailure === "reset") {
                debugLog("Health reached 0 — resetting to 100%");
                node.health = 100;
                node.simHours = 0;
            } else if (node.onFailure === "stop") {
                debugLog("Health reached 0 — stopping stream");
                stop();
            }
            // "continue" leaves health pinned at 0
        }

        function emitSample(send) {
            const sample = computeSample();
            send(buildMessage(sample));
            updateStatus(sample);
            applyFailurePolicy(sample);
            return sample;
        }

        // ------------------------------ Stream control ---------------------------
        function start() {
            if (node.running) return;
            node.running = true;
            node.timer = setInterval(function () {
                try {
                    emitSample(node.send.bind(node));
                } catch (err) {
                    errorHandler.handleNodeError(node, "CM source tick error: " + err.message, null);
                }
            }, node.intervalMs);
            node.status({ fill: "green", shape: "dot", text: "streaming (" + node.intervalMs + " ms)" });
            debugLog("Stream started");
        }

        function stop() {
            if (node.timer) {
                clearInterval(node.timer);
                node.timer = null;
            }
            node.running = false;
            node.status({ fill: "grey", shape: "ring", text: "stopped" });
            debugLog("Stream stopped");
        }

        function resetState() {
            node.simHours = 0;
            node.health = 100;
            node.sampleCount = 0;
            node.status({ fill: "blue", shape: "ring", text: "reset" });
            debugLog("Simulation reset");
        }

        // Apply runtime overrides from msg.config (range-clamped, pollution-safe).
        function applyOverrides(cfg) {
            errorHandler.sanitizeObject(cfg);
            if (cfg.assetType !== undefined) node.assetType = String(cfg.assetType);
            if (cfg.rpm !== undefined) node.rpm = clampFloat(cfg.rpm, 1, 100000, node.rpm);
            if (cfg.load !== undefined) node.load = clampFloat(cfg.load, 0, 100, node.load);
            if (cfg.degRate !== undefined) node.degRate = clampFloat(cfg.degRate, 0, 100, node.degRate);
            if (cfg.noise !== undefined) node.noise = clampFloat(cfg.noise, 0, 1, node.noise);
            if (cfg.hoursPerSample !== undefined)
                node.hoursPerSample = clampFloat(cfg.hoursPerSample, 0.0001, 1000000, node.hoursPerSample);
            if (cfg.warnThreshold !== undefined)
                node.warnThreshold = clampFloat(cfg.warnThreshold, 0, 100000, node.warnThreshold);
            if (cfg.alarmThreshold !== undefined)
                node.alarmThreshold = clampFloat(cfg.alarmThreshold, 0, 100000, node.alarmThreshold);

            if (cfg.faults && typeof cfg.faults === "object") {
                errorHandler.sanitizeObject(cfg.faults);
                ["imbalance", "misalignment", "bearing", "looseness"].forEach(function (k) {
                    if (cfg.faults[k] !== undefined) {
                        node.faults[k] = clampFloat(cfg.faults[k], 0, 1, node.faults[k]);
                    }
                });
            }

            // Live interval change requires restarting the timer.
            if (cfg.intervalMs !== undefined) {
                node.intervalMs = clampInt(cfg.intervalMs, 50, 86400000, node.intervalMs);
                if (node.running) {
                    stop();
                    start();
                }
            }
        }

        // ------------------------------- Input handler ---------------------------
        node.on("input", function (msg, send, done) {
            // Node-RED 1.0+ provides send/done; fall back for older runtimes.
            send = send || node.send.bind(node);
            done =
                done ||
                function (err) {
                    if (err) node.error(err, msg);
                };

            try {
                const command =
                    typeof msg.payload === "string"
                        ? msg.payload.toLowerCase()
                        : msg.command
                          ? String(msg.command).toLowerCase()
                          : "";

                if (msg.reset === true || command === "reset") {
                    resetState();
                    done();
                    return;
                }
                if (msg.stop === true || command === "stop") {
                    stop();
                    done();
                    return;
                }
                if (msg.start === true || command === "start") {
                    start();
                    done();
                    return;
                }

                // Runtime reconfiguration without emitting a sample.
                if (msg.config && typeof msg.config === "object") {
                    applyOverrides(msg.config);
                    if (msg.emit !== true) {
                        done();
                        return;
                    }
                }

                // Any other input triggers a single manual sample.
                emitSample(send);
                done();
            } catch (err) {
                errorHandler.handleNodeError(node, "CM source error: " + err.message, msg);
                done(err);
            }
        });

        node.on("close", function (done) {
            if (node.timer) {
                clearInterval(node.timer);
                node.timer = null;
            }
            node.running = false;
            node.status({});
            if (done) done();
        });

        // Begin streaming immediately if configured.
        if (node.autoStart) {
            start();
        } else {
            node.status({ fill: "grey", shape: "ring", text: "idle — send 'start' or inject" });
        }
    }

    RED.nodes.registerType("condition-monitoring-source", ConditionMonitoringSourceNode);
};
