/**
 * json-source (CM JSON Source)
 *
 * A generic structured-data (JSON record) simulator — for driving the nodes that
 * consume objects/records: multi-value-processor, health-index, pca-anomaly,
 * anomaly-detector (multi-sensor), training-data-collector, llm-analyzer (record).
 *
 * You define the fields as a JSON spec; each numeric field is simulated as
 *   value = mean + trend * sampleCount + gaussianNoise(std)   (clamped to min/max)
 * String/constant fields pass through unchanged. Optional anomaly injection
 * spikes a random numeric field now and then. Deterministic via an optional seed.
 *
 * Field spec (JSON object: name -> spec):
 *   "temperature": { "mean": 60, "noise": 2, "trend": 0.05, "min": 0, "max": 120 }
 *   "asset": "pump-01"          // constant string
 *   "rpm": 1500                 // constant number
 *
 * Output: msg.payload = { field: value, ... }, msg.sampleCount, msg.anomalyInjected?
 * Control: msg.payload/msg.command "start"|"stop"|"reset" · msg.config {...}
 */

module.exports = function (RED) {
    "use strict";

    const { clampInt, clampFloat } = require("./utils/config-validator");
    const { mulberry32 } = require("./utils/seeded-random");

    const DEFAULT_FIELDS = {
        temperature: { mean: 60, noise: 2, trend: 0.05, min: 0, max: 150 },
        pressure: { mean: 4.5, noise: 0.15, min: 0 },
        vibration: { mean: 2.0, noise: 0.3, trend: 0.02, min: 0 },
        asset: "pump-01"
    };

    const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

    // Validate a fields spec: must be a plain (non-array) object. Drops
    // prototype-pollution keys. Returns null if the input is not usable.
    function sanitizeFields(fields) {
        if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
            return null;
        }
        const clean = {};
        for (const key of Object.keys(fields)) {
            if (FORBIDDEN_KEYS.indexOf(key) !== -1) continue;
            clean[key] = fields[key];
        }
        return clean;
    }

    function JsonSourceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        try {
            node.fields = config.fields ? sanitizeFields(JSON.parse(config.fields)) : DEFAULT_FIELDS;
            if (!node.fields) {
                node.warn("json-source: fields must be a JSON object, using defaults");
                node.fields = DEFAULT_FIELDS;
            }
        } catch (e) {
            node.warn("json-source: invalid fields JSON, using defaults");
            node.fields = DEFAULT_FIELDS;
        }
        node.anomalyChance = clampFloat(config.anomalyChance, 0, 1, 0);
        node.anomalyMag = clampFloat(config.anomalyMag, 0, 1000, 6);
        node.intervalMs = clampInt(config.intervalMs, 50, 86400000, 1000);
        node.autoStart = config.autoStart === true;
        node.outputProperty = config.outputProperty || "payload";
        node.outputTopic = config.outputTopic || "";
        const seed = parseInt(config.seed, 10);
        node.seedBase = Number.isFinite(seed) ? seed : null;

        node.sampleCount = 0;
        node.timer = null;
        node.running = false;

        // Gaussian (Box–Muller) from a uniform RNG
        function gauss(rng) {
            let u = 0,
                v = 0;
            while (u === 0) u = rng();
            while (v === 0) v = rng();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        }

        function buildRecord() {
            const rng = node.seedBase !== null ? mulberry32(node.seedBase + node.sampleCount) : Math.random;
            const out = {};
            const numericFields = [];
            for (const key of Object.keys(node.fields)) {
                const spec = node.fields[key];
                if (typeof spec === "number") {
                    out[key] = spec;
                } else if (typeof spec === "string") {
                    out[key] = spec;
                } else if (spec && typeof spec === "object") {
                    const mean = clampFloat(spec.mean, -1e12, 1e12, 0);
                    const noise = clampFloat(spec.noise, 0, 1e12, 0);
                    const trend = clampFloat(spec.trend, -1e12, 1e12, 0);
                    let val = mean + trend * node.sampleCount + gauss(rng) * noise;
                    // Non-numeric bounds are ignored — Math.max("abc", v) is NaN
                    // and would poison the whole field.
                    const lo = clampFloat(spec.min, -Number.MAX_VALUE, Number.MAX_VALUE, null);
                    const hi = clampFloat(spec.max, -Number.MAX_VALUE, Number.MAX_VALUE, null);
                    if (lo !== null) val = Math.max(lo, val);
                    if (hi !== null) val = Math.min(hi, val);
                    out[key] = +val.toFixed(4);
                    numericFields.push({ key: key, noise: noise || 1 });
                } else {
                    out[key] = spec;
                }
            }
            // optional anomaly injection: spike one numeric field
            let injected = null;
            if (node.anomalyChance > 0 && numericFields.length && rng() < node.anomalyChance) {
                const f = numericFields[Math.floor(rng() * numericFields.length)];
                out[f.key] = +(out[f.key] + node.anomalyMag * f.noise * (rng() < 0.5 ? -1 : 1)).toFixed(4);
                injected = f.key;
            }
            return { record: out, injected: injected };
        }

        function emit(send) {
            node.sampleCount++;
            const r = buildRecord();
            const msg = { topic: node.outputTopic || "json-source", sampleCount: node.sampleCount };
            try {
                RED.util.setMessageProperty(msg, node.outputProperty, r.record, true);
            } catch (e) {
                msg[node.outputProperty] = r.record;
            }
            if (r.injected) msg.anomalyInjected = r.injected;
            send(msg);
            node.status({
                fill: r.injected ? "yellow" : "green",
                shape: node.running ? "dot" : "ring",
                text:
                    (r.injected ? "anomaly: " + r.injected : Object.keys(r.record).length + " fields") +
                    " · #" +
                    node.sampleCount
            });
        }

        function start() {
            if (node.timer) return;
            node.running = true;
            node.timer = setInterval(() => {
                // An exception escaping a timer callback is an uncaught
                // exception for the whole runtime — contain it here.
                try {
                    emit((m) => node.send(m));
                } catch (err) {
                    stop();
                    node.status({ fill: "red", shape: "ring", text: "error - stopped" });
                    node.error("json-source: " + err.message);
                }
            }, node.intervalMs);
        }
        function stop() {
            const wasRunning = node.running;
            node.running = false;
            if (node.timer) {
                clearInterval(node.timer);
                node.timer = null;
            }
            // The last emit left a "running" (dot) status behind.
            if (wasRunning) node.status({ fill: "grey", shape: "ring", text: "stopped · #" + node.sampleCount });
        }

        node.on("input", function (msg, send, done) {
            send = send || ((m) => node.send(m));
            const cmd = (
                typeof msg.payload === "string" ? msg.payload : typeof msg.command === "string" ? msg.command : ""
            ).toLowerCase();
            if (msg.config && typeof msg.config === "object") {
                if (msg.config.anomalyChance !== undefined)
                    node.anomalyChance = clampFloat(msg.config.anomalyChance, 0, 1, node.anomalyChance);
                if (msg.config.fields !== undefined) {
                    const clean = sanitizeFields(msg.config.fields);
                    if (clean) node.fields = clean;
                    else node.warn("json-source: ignored invalid msg.config.fields (must be an object)");
                }
            }
            if (cmd === "stop" || msg.stop === true) {
                stop();
                if (done) done();
                return;
            }
            if (cmd === "reset" || msg.reset === true) {
                node.sampleCount = 0;
                if (done) done();
                return;
            }
            if (cmd === "start" || msg.start === true) {
                start();
                if (done) done();
                return;
            }
            emit(send);
            if (done) done();
        });

        node.on("close", function (done) {
            stop();
            node.status({});
            if (done) done();
        });

        if (node.autoStart) start();
    }

    RED.nodes.registerType("json-source", JsonSourceNode);
};
