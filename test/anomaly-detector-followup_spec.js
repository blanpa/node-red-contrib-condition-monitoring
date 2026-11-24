/**
 * anomaly-detector: regressions from the post-v0.4.0 review.
 *
 *  - the learned EMA / CUSUM state of the *active* baseline is restored from
 *    persistence (only parked regimes used to get it back),
 *  - the multi-sensor output carries the same envelope as the single-value
 *    output (output topic, passthrough properties, timestamp, hysteresis),
 *  - msg.config covers every method's thresholds, validates the method and
 *    applies to batch mode,
 *  - the multi-sensor path scores with O(1) running moments that match the
 *    single-value path and the canonical O(n) computation,
 *  - a rejected payload does not create a regime state,
 *  - the WebSocket auth token comes from the node credentials.
 */
"use strict";

const helper = require("node-red-node-test-helper");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");
const stats = require("../nodes/utils/statistics");
const { STATE_VERSION } = require("../nodes/state-persistence");
const WebSocketManager = require("../nodes/websocket-manager");
const { buildStubbedNode, feed, output, closeNode, settle } = require("./stub-runtime");

function build(config, seeded) {
    return buildStubbedNode(anomalyDetectorNode, Object.assign({ id: "n1", hysteresisEnabled: false }, config), seeded);
}

// Deterministic, non-trivial series: ramp + periodic component, so mean and σ
// both move as the window slides (no Math.random — see CLAUDE.md).
function sample(i) {
    return 50 + i * 0.37 + 8 * Math.sin(i / 3) + (i % 7) * 1.1;
}

describe("anomaly-detector persistence restore of the active state", () => {
    it("restores ema and initialized, and scores the next sample against them", async () => {
        const cfg = {
            method: "ema",
            emaAlpha: 0.3,
            emaThreshold: 2,
            emaWarning: 1.5,
            windowSize: 30,
            persistState: true
        };

        // First life: 25 samples alternating 50 / 51, then a save on close.
        const first = build(cfg);
        await settle();
        for (let i = 0; i < 25; i++) feed(first, { payload: i % 2 === 0 ? 50 : 51 });
        expect(first.node.initialized).toBe(true);
        const savedEma = first.node.ema;
        expect(Number.isFinite(savedEma)).toBe(true);
        await closeNode(first.node);
        const blob = first.store.anomalyDetectorState;
        expect(blob).toBeTruthy();
        expect(blob.__v).toBe(STATE_VERSION);
        expect(blob.ema).toBeCloseTo(savedEma, 12);
        expect(blob.initialized).toBe(true);

        // Second life, seeded with that blob.
        const second = build(cfg, { anomalyDetectorState: blob });
        await settle();
        expect(second.node.dataBuffer.length).toBe(25);
        expect(second.node.ema).toBeCloseTo(savedEma, 12);
        expect(second.node.initialized).toBe(true);
        expect(second.statuses.some((s) => /restored \(25\)/.test(s.text))).toBe(true);

        // +20 on a flat baseline must be an anomaly — not "initializing".
        const out = output(feed(second, { payload: 70 }));
        expect(out.isAnomaly).toBe(true);
        expect(out.severity).toBe("critical");
        expect(out.ema).toBeCloseTo(0.3 * 70 + 0.7 * savedEma, 9);
    });

    it("restores cusumPos / cusumNeg instead of starting the sums from zero", async () => {
        const cfg = {
            method: "cusum",
            cusumMode: "raw",
            cusumTarget: 50,
            cusumDrift: 0,
            cusumThreshold: 100,
            cusumWarning: 100,
            windowSize: 20,
            persistState: true
        };
        const first = build(cfg);
        await settle();
        [50, 52, 52, 52].forEach((v) => feed(first, { payload: v }));
        expect(first.node.cusumPos).toBeCloseTo(6, 9);
        await closeNode(first.node);

        const second = build(cfg, { anomalyDetectorState: first.store.anomalyDetectorState });
        await settle();
        expect(second.node.cusumPos).toBeCloseTo(6, 9);
        expect(second.node.cusumNeg).toBe(0);

        const out = output(feed(second, { payload: 52 }));
        expect(out.cusumPos).toBeCloseTo(8, 9);
    });

    it("adopts an unversioned blob written by an older release", async () => {
        const cfg = { method: "ema", emaAlpha: 0.5, windowSize: 10, persistState: true };
        const legacyBlob = {
            dataBuffer: [1, 2, 3, 2, 1].map((v) => ({ timestamp: 0, value: v })),
            ema: 1.75,
            cusumPos: 0,
            cusumNeg: 0,
            initialized: true
        };
        const stub = build(cfg, { anomalyDetectorState: legacyBlob });
        await settle();
        expect(stub.node.dataBuffer.length).toBe(5);
        expect(stub.node.ema).toBe(1.75);
        expect(stub.node.initialized).toBe(true);
        expect(stub.warnings.filter((w) => /starting fresh/.test(w))).toEqual([]);
    });
});

describe("anomaly-detector multi-sensor output envelope", () => {
    const cfg = { method: "threshold", maxThreshold: 50, warningMargin: 0, outputTopic: "alarms" };

    it("applies the output topic and keeps passthrough properties, like the single-value path", () => {
        const stub = build(cfg);
        const multi = output(feed(stub, { payload: { s: 10 }, deviceId: "pump-1", correlationId: "c-7" }));
        expect(multi.inputFormat).toBe("multi-sensor");
        expect(multi.topic).toBe("alarms"); // used to be set only when msg.topic existed
        expect(multi.deviceId).toBe("pump-1");
        expect(multi.correlationId).toBe("c-7");
        expect(typeof multi.timestamp).toBe("number");
        expect(multi.hysteresis).toEqual({ enabled: false, applied: false });

        // (the very first single value is the warm-up pass-through of the raw msg)
        feed(stub, { payload: 10 });
        const single = output(feed(stub, { payload: 10, deviceId: "pump-1", correlationId: "c-7" }));
        expect(single.topic).toBe("alarms");
        expect(single.deviceId).toBe("pump-1");
        ["topic", "deviceId", "correlationId", "timestamp", "hysteresis"].forEach((key) => {
            expect(Object.prototype.hasOwnProperty.call(multi, key)).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(single, key)).toBe(true);
        });
    });

    it("keeps the inbound topic when no output topic is configured", () => {
        const stub = build({ method: "threshold", maxThreshold: 50 });
        const out = output(feed(stub, { payload: { s: 10 }, topic: "line-3/press" }));
        expect(out.topic).toBe("line-3/press");
    });

    it("reports the per-sensor hysteresis counters", () => {
        const stub = build({ method: "threshold", maxThreshold: 50, warningMargin: 0, hysteresisEnabled: true });
        feed(stub, { payload: { s: 10 } });
        const out = output(feed(stub, { payload: { s: 99 } }));
        expect(out.hysteresis.enabled).toBe(true);
        expect(out.payload.s.hysteresis).toEqual({ applied: false, consecutiveAnomalies: 1, consecutiveNormals: 0 });
    });

    it("counts only the sensors that were scored in the status text", () => {
        const stub = build({ method: "threshold", maxThreshold: 50 });
        const out = output(feed(stub, { payload: { a: 1, b: "not-a-number", c: null } }));
        expect(out.sensorCount).toBe(1);
        expect(out.totalSensors).toBe(3);
        expect(stub.statuses[stub.statuses.length - 1].text).toBe("1 sensors OK");
    });
});

describe("anomaly-detector msg.config coverage", () => {
    it("honours emaThreshold / emaWarning overrides", () => {
        const cfg = { method: "ema", emaAlpha: 0.3, emaThreshold: 2, emaWarning: 1.5, windowSize: 20 };
        const series = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 10 : 10.2));

        const plain = build(cfg);
        series.forEach((v) => feed(plain, { payload: v }));
        expect(output(feed(plain, { payload: 10.6 })).severity).toBe("critical");

        const overridden = build(cfg);
        series.forEach((v) => feed(overridden, { payload: v }));
        const out = output(feed(overridden, { payload: 10.6, config: { emaThreshold: 100, emaWarning: 50 } }));
        expect(out.severity).toBe("normal");
        expect(out.isAnomaly).toBe(false);
    });

    it("honours percentile and CUSUM overrides", () => {
        const pct = build({ method: "percentile", lowerPercentile: 5, upperPercentile: 95, windowSize: 20 });
        for (let i = 0; i < 20; i++) feed(pct, { payload: i });
        const narrow = output(feed(pct, { payload: 18, config: { lowerPercentile: 40, upperPercentile: 60 } }));
        expect(narrow.isAnomaly).toBe(true);
        expect(narrow.upperPercentile).toBe(60);
        const wide = output(feed(pct, { payload: 18 }));
        expect(wide.isAnomaly).toBe(false);

        const cusum = build({ method: "cusum", cusumMode: "raw", cusumTarget: 0, cusumDrift: 0, cusumThreshold: 100 });
        feed(cusum, { payload: 0 });
        const out = output(feed(cusum, { payload: 3, config: { cusumThreshold: 2, cusumWarning: 1 } }));
        expect(out.severity).toBe("critical");
        expect(out.cusumMax).toBeCloseTo(3, 9);
    });

    it("ignores an unknown method, warning once, and never reports it on the output", () => {
        const stub = build({ method: "threshold", maxThreshold: 50, warningMargin: 0 });
        const outs = [1, 2, 99].map((v) => output(feed(stub, { payload: v, config: { method: "foo" } })));
        // the first sample is the warm-up pass-through of the raw msg
        expect(outs.slice(1).map((o) => o.method)).toEqual(["threshold", "threshold"]);
        expect(outs[2].severity).toBe("critical");
        const warnings = stub.warnings.filter((w) => /"foo"/.test(w));
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toMatch(/not a detection method/);
    });

    it("applies msg.config to batch mode and still honours the legacy aliases", () => {
        const cfg = { method: "zscore", windowSize: 10, minThreshold: 0, maxThreshold: 100 };
        const values = [50, 50, 50, 50, 50, 150];

        const viaConfig = output(feed(build(cfg), { payload: values, batch: true, config: { method: "threshold" } }));
        expect(viaConfig.payload.method).toBe("threshold");
        expect(viaConfig.payload.summary.anomalyIndices).toEqual([5]);
        expect(viaConfig.payload.results[5].details.maxThreshold).toBe(100);

        const viaLegacy = output(feed(build(cfg), { payload: values, batch: true, method: "threshold" }));
        expect(viaLegacy.payload.method).toBe("threshold");
        expect(viaLegacy.payload.summary.anomalyIndices).toEqual([5]);

        // msg.config wins over the alias
        const both = output(
            feed(build(cfg), { payload: values, batch: true, method: "threshold", config: { method: "zscore" } })
        );
        expect(both.payload.method).toBe("zscore");

        // Legacy critical-threshold alias: z = 5 here, flagged at the default 3, not at 10.
        const series = [];
        for (let i = 0; i < 10; i++) series.push(i % 2 === 0 ? 20 : 20.1);
        series.push(20.3);
        const strict = output(feed(build(cfg), { payload: series, batch: true }));
        expect(strict.payload.summary.anomalies).toBe(1);
        const loose = output(feed(build(cfg), { payload: series, batch: true, threshold: 10 }));
        expect(loose.payload.summary.anomalies + loose.payload.summary.warnings).toBe(0);
        expect(loose.payload.results[10].details.threshold).toBe(10);
    });
});

describe("anomaly-detector multi-sensor hot path", () => {
    it("scores with the same z-score as the single-value path, and as the O(n) reference", () => {
        const WINDOW = 20;
        const cfg = { method: "zscore", zscoreThreshold: 3, zscoreWarning: 2, windowSize: WINDOW };
        const single = build(cfg);
        const multi = build(cfg);

        let compared = 0;
        for (let i = 0; i < WINDOW * 8; i++) {
            const value = sample(i);
            // The window the detector scores against: the samples before this
            // one, or — while that baseline is shorter than 10 — including it.
            const before = (multi.node.sensorBuffers.s || []).slice();
            const reference = before.length >= Math.min(WINDOW, 10) ? before : before.concat([value]).slice(-WINDOW);

            const s = output(feed(single, { payload: value }));
            const m = output(feed(multi, { payload: { s: value } }));
            if (s.zScore === undefined) {
                // single: warm-up pass-through of the raw msg; multi: a warm-up result
                expect(m.payload.s.severity).toBe("warmup");
                continue;
            }
            expect(m.payload.s.bufferSize).toBe(s.bufferSize);
            compared++;
            const d = m.payload.s.details;
            expect(d.zScore).toBeCloseTo(s.zScore, 9);
            expect(d.mean).toBeCloseTo(s.mean, 9);
            expect(d.stdDev).toBeCloseTo(s.stdDev, 9);
            expect(m.payload.s.isAnomaly).toBe(s.isAnomaly);
            expect(m.payload.s.severity).toBe(s.severity);

            const canonical = stats.calculateZScore(value, reference);
            expect(d.zScore).toBeCloseTo(canonical.zScore, 9);
        }
        expect(compared).toBeGreaterThan(WINDOW * 7);
        // Well past several full turnovers, with the periodic rebuild exercised.
        const moments = multi.node.sensorMoments.s;
        expect(moments.running.count()).toBe(WINDOW);
        expect(multi.node.sensorBuffers.s.length).toBe(WINDOW);
    });

    it("keeps one accumulator per sensor", () => {
        const stub = build({ method: "zscore", windowSize: 5 });
        for (let i = 0; i < 7; i++) feed(stub, { payload: { a: i, b: 100 + 2 * i } });
        expect(stub.node.sensorMoments.a.running.mean()).toBeCloseTo(4, 12); // 2..6
        expect(stub.node.sensorMoments.b.running.mean()).toBeCloseTo(108, 12); // 104..112
        expect(stub.node.sensorBuffers.a).toEqual([2, 3, 4, 5, 6]);
    });
});

describe("anomaly-detector regime selection after validation", () => {
    it("does not create a regime state for a rejected payload", () => {
        const stub = build({ method: "zscore", regimeProperty: "regime", maxRegimes: 2 });
        for (let i = 0; i < 3; i++) feed(stub, { payload: 10 + i, regime: "r1" });
        expect(stub.node.activeRegime).toBe("r1");

        const r = feed(stub, { payload: "abc", regime: "junk" });
        expect(r.error).toMatch(/not a valid number/);
        expect(stub.node.activeRegime).toBe("r1");
        expect(stub.node.regimes.size).toBe(0);
        expect(stub.node.dataBuffer.length).toBe(3);

        feed(stub, { payload: { s: "nan" }, regime: "junk2" });
        // An object payload is structurally valid and selects its regime …
        expect(stub.node.activeRegime).toBe("junk2");
        // … but the garbage payload has not been admitted into any window.
        expect(stub.node.regimes.get("r1").dataBuffer.length).toBe(3);
        expect(Object.keys(stub.node.sensorBuffers)).toEqual([]);
    });

    it("msg.reset still targets the regime named by the message", () => {
        const stub = build({ method: "zscore", regimeProperty: "regime" });
        for (let i = 0; i < 3; i++) feed(stub, { payload: 10 + i, regime: "r1" });
        for (let i = 0; i < 2; i++) feed(stub, { payload: 90 + i, regime: "r2" });
        feed(stub, { payload: 0, reset: true, regime: "r1" });
        expect(stub.node.activeRegime).toBe("r1");
        expect(stub.node.dataBuffer.length).toBe(0);
        expect(stub.node.regimes.get("r2").dataBuffer.length).toBe(2);
    });
});

describe("anomaly-detector WebSocket credentials", () => {
    helper.init(require.resolve("node-red"));

    // Random per-suite base port so parallel Jest workers don't collide.
    const BASE_PORT = 26000 + Math.floor(Math.random() * 2000);
    let portCounter = 0;
    function nextPort() {
        return BASE_PORT + portCounter++;
    }

    function flowWith(extra) {
        return [
            Object.assign(
                {
                    id: "n1",
                    type: "anomaly-detector",
                    method: "zscore",
                    websocketEnabled: true,
                    websocketPort: nextPort(),
                    wires: [[], []]
                },
                extra
            )
        ];
    }

    /** Messages node.warn() logged during helper.load() (constructor-time warnings). */
    function loggedWarnings() {
        const log = helper.log();
        return log.args.filter((a) => a[0] && a[0].level === log.WARN).map((a) => String(a[0].msg));
    }

    beforeEach((done) => {
        helper.startServer(done);
    });

    afterEach(async () => {
        await helper.unload();
        await WebSocketManager.shutdownWebSocketManager();
        await new Promise((resolve) => helper.stopServer(resolve));
    });

    it("takes the auth token from the node credentials and the origins from the config", async () => {
        const flow = flowWith({ websocketAllowedOrigins: " https://dash.example , http://localhost:3000 " });
        await new Promise((resolve) =>
            helper.load(anomalyDetectorNode, flow, { n1: { websocketAuthToken: "from-creds" } }, resolve)
        );
        const n1 = helper.getNode("n1");
        expect(n1.websocketAuthToken).toBe("from-creds");
        expect(n1.websocketAllowedOrigins).toEqual(["https://dash.example", "http://localhost:3000"]);
        // … and both reached the manager
        expect(n1.wsManager.authToken).toBe("from-creds");
        expect(n1.wsManager.allowedOrigins).toEqual(["https://dash.example", "http://localhost:3000"]);
        expect(WebSocketManager.getWebSocketManagerUsers()).toBe(1);
        expect(loggedWarnings().filter((w) => /no auth token|plain text/.test(w))).toEqual([]);

        // Closing the node releases the manager and stops the server.
        const manager = n1.wsManager;
        await new Promise((r) => setTimeout(r, 50));
        await helper.unload();
        expect(WebSocketManager.getWebSocketManagerUsers()).toBe(0);
        expect(manager.isRunning).toBe(false);
    });

    it("still accepts a legacy inline token, with a plain-text warning", async () => {
        await new Promise((resolve) =>
            helper.load(anomalyDetectorNode, flowWith({ websocketAuthToken: "inline-token" }), resolve)
        );
        const n1 = helper.getNode("n1");
        expect(n1.websocketAuthToken).toBe("inline-token");
        expect(n1.wsManager.authToken).toBe("inline-token");
        expect(loggedWarnings().some((w) => /plain text/.test(w))).toBe(true);
    });

    it("prefers the credential over an inline token", async () => {
        await new Promise((resolve) =>
            helper.load(
                anomalyDetectorNode,
                flowWith({ websocketAuthToken: "inline-token" }),
                { n1: { websocketAuthToken: "from-creds" } },
                resolve
            )
        );
        expect(helper.getNode("n1").websocketAuthToken).toBe("from-creds");
    });

    it("warns when WebSocket output has no token at all", async () => {
        await new Promise((resolve) => helper.load(anomalyDetectorNode, flowWith({}), resolve));
        expect(helper.getNode("n1").websocketAuthToken).toBeNull();
        expect(loggedWarnings().some((w) => /no auth token/.test(w))).toBe(true);
    });
});
