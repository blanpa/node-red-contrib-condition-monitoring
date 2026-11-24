/**
 * anomaly-detector: regression tests for scoring rules that used to be wrong.
 *
 *  - a sample is scored against the window before it (an outlier must not
 *    inflate its own baseline),
 *  - the "debug" option must not clobber Node-RED's node.debug() logger,
 *  - multi-sensor hysteresis counts *consecutive* anomalies,
 *  - the threshold warning band works for negative limits.
 */
const helper = require("node-red-node-test-helper");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");

helper.init(require.resolve("node-red"));

function flowWith(extra) {
    return [
        Object.assign(
            { id: "n1", type: "anomaly-detector", method: "zscore", hysteresisEnabled: false, wires: [["n2"], ["n3"]] },
            extra
        ),
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
}

// Feed payloads one by one and resolve with every output message, in order.
function run(extra, payloads, mapMsg) {
    return new Promise((resolve, reject) => {
        helper.load(anomalyDetectorNode, flowWith(extra), function () {
            const n1 = helper.getNode("n1");
            const out = [];
            const collect = (msg) => out.push(msg);
            helper.getNode("n2").on("input", collect);
            helper.getNode("n3").on("input", collect);
            n1.on("call:error", (call) => reject(new Error(String(call.firstArg))));
            payloads.forEach((p, i) => n1.receive(mapMsg ? mapMsg(p, i) : { payload: p }));
            setTimeout(() => resolve({ out, node: n1 }), 100);
        });
    });
}

describe("anomaly-detector scoring", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it.each([5, 10, 20])("flags an extreme outlier as critical with windowSize %i", async (windowSize) => {
        const baseline = Array.from({ length: 40 }, (_, i) => 20 + (i % 2) * 0.1);
        const { out } = await run({ windowSize, zscoreThreshold: 3 }, baseline.concat([1e6]));
        const last = out[out.length - 1];
        expect(last.payload).toBe(1e6);
        expect(last.severity).toBe("critical");
        // Scored within its own window the z-score is capped at sqrt(n - 1)
        expect(Math.abs(last.zScore)).toBeGreaterThan(Math.sqrt(windowSize));
    });

    it("treats a departure from a perfectly flat baseline as an anomaly with a finite score", async () => {
        const { out } = await run({ windowSize: 20 }, Array(20).fill(5).concat([5.5]));
        const last = out[out.length - 1];
        expect(last.isAnomaly).toBe(true);
        expect(Number.isFinite(last.zScore)).toBe(true);
    });

    it("keeps working with the debug option enabled", async () => {
        const { out, node } = await run({ debug: true, windowSize: 10 }, [1, 2, 3, 2, 1, 2]);
        expect(typeof node.debug).toBe("function");
        expect(out.length).toBe(6);
        expect(out[out.length - 1].zScore).toBeDefined();
    });

    it("EMA scores against the average before the sample moves it", async () => {
        const baseline = Array.from({ length: 30 }, (_, i) => 10 + (i % 2) * 0.2);
        const { out } = await run(
            { method: "ema", emaAlpha: 1, emaThreshold: 3, windowSize: 30 },
            baseline.concat([50])
        );
        // With alpha = 1 the updated EMA equals the sample; the old order hid every deviation.
        expect(out[out.length - 1].severity).toBe("critical");
    });

    it("multi-sensor hysteresis needs consecutive anomalies, like the single-value path", async () => {
        const cfg = {
            method: "threshold",
            maxThreshold: 50,
            warningMargin: 0,
            hysteresisEnabled: true,
            consecutiveCount: 3
        };
        const interleaved = [10, 10, 99, 10, 99, 10, 99];
        let r = await run(cfg, interleaved, (v) => ({ payload: { s: v } }));
        expect(r.out.map((m) => m.payload.s.isAnomaly)).toEqual(Array(7).fill(false));
        await helper.unload();
        r = await run(cfg, [10, 10, 99, 99, 99], (v) => ({ payload: { s: v } }));
        expect(r.out[r.out.length - 1].payload.s.isAnomaly).toBe(true);
    });

    it("places the threshold warning band inside negative limits", async () => {
        const cfg = { method: "threshold", minThreshold: -10, maxThreshold: -2, warningMargin: 10 };
        const { out } = await run(cfg, [-5, -5, -5, -2.1, -9.9, -1, -11]);
        expect(out.slice(2).map((m) => m.severity)).toEqual(["normal", "warning", "warning", "critical", "critical"]);
    });

    it("ignores a malformed msg.config override instead of disabling the check", async () => {
        const { out } = await run({ method: "threshold", maxThreshold: 50, warningMargin: 0 }, [1, 2, 99], (v) => ({
            payload: v,
            config: { maxThreshold: "abc" }
        }));
        expect(out[out.length - 1].severity).toBe("critical");
    });

    it("accepts a sensor named like an Object.prototype member", async () => {
        const { out } = await run({ windowSize: 10 }, [1, 2, 3], (v) => ({ payload: { constructor: v, toString: v } }));
        expect(out.length).toBe(3);
        expect(out[2].payload.constructor.value).toBe(3);
    });

    it("batch mode rejects a non-array payload and survives null entries", async () => {
        const { out } = await run({ windowSize: 10 }, [[1, 2, null, 3, 2, 1, 2, 3, 2, 1, 2, 500]], (v) => ({
            payload: v,
            batch: true
        }));
        expect(out.length).toBe(1);
        expect(out[0].payload.statistics.count).toBe(11);
        expect(out[0].payload.summary.anomalyIndices).toEqual([11]);
        expect(out[0].payload.method).toBe("zscore");
    });

    it("persists every regime, not only the active one", function (done) {
        helper.load(anomalyDetectorNode, flowWith({ regimeProperty: "regime", persistState: true }), function () {
            const n1 = helper.getNode("n1");
            for (let i = 0; i < 6; i++) n1.receive({ payload: 10 + (i % 2), regime: "low" });
            for (let i = 0; i < 4; i++) n1.receive({ payload: 90 + (i % 2), regime: "high" });
            setTimeout(function () {
                const saved = JSON.parse(
                    JSON.stringify(n1.stateManager.getAll ? n1.stateManager.getAll() : n1.stateManager.state)
                );
                expect(saved.activeRegime).toBe("high");
                expect(saved.dataBuffer.length).toBe(4);
                expect(saved.regimes.low.dataBuffer.length).toBe(6);
                done();
            }, 50);
        });
    });
});

describe("anomaly-detector grouping, CUSUM scale and multi-sensor overrides", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("keeps one baseline per group value", async () => {
        // Two devices at very different levels, interleaved: with a shared
        // window every sample would sit ~1σ from a bimodal mean and the real
        // outlier on pump-b (60 vs. its level of 50) would be invisible.
        const msgs = [];
        for (let i = 0; i < 30; i++) {
            msgs.push({ payload: 10 + (i % 2) * 0.2, topic: "pump-a" });
            msgs.push({ payload: 50 + (i % 2) * 0.2, topic: "pump-b" });
        }
        msgs.push({ payload: 60, topic: "pump-b" });
        const { out, node } = await run({ groupBy: "topic", windowSize: 20 }, msgs, (m) => m);
        const last = out[out.length - 1];
        expect(last.group).toBe("pump-b");
        expect(last.severity).toBe("critical");
        expect(last.mean).toBeCloseTo(50.1, 6);
        expect(out.slice(0, -1).every((m) => m.isAnomaly !== true)).toBe(true);
        // one live state plus one parked
        expect(node.regimes.size).toBe(1);
    });

    it("without Group By the same stream shares one window (legacy behaviour)", async () => {
        const msgs = [];
        for (let i = 0; i < 30; i++) {
            msgs.push({ payload: 10, topic: "pump-a" });
            msgs.push({ payload: 50, topic: "pump-b" });
        }
        msgs.push({ payload: 60, topic: "pump-b" });
        const { out } = await run({ windowSize: 20 }, msgs, (m) => m);
        const last = out[out.length - 1];
        expect(last.group).toBeUndefined();
        expect(last.mean).toBeCloseTo(30, 6);
        expect(last.severity).toBe("normal");
    });

    it("combines groups with regimes and persists both", function (done) {
        helper.load(
            anomalyDetectorNode,
            flowWith({ groupBy: "topic", regimeProperty: "regime", persistState: true }),
            function () {
                const n1 = helper.getNode("n1");
                for (let i = 0; i < 4; i++) n1.receive({ payload: 10 + i, topic: "a", regime: "low" });
                for (let i = 0; i < 3; i++) n1.receive({ payload: 90 + i, topic: "a", regime: "high" });
                for (let i = 0; i < 3; i++) n1.receive({ payload: 20 + i, topic: "b", regime: "low" });
                setTimeout(function () {
                    try {
                        const saved = JSON.parse(JSON.stringify(n1.stateManager.getAll()));
                        expect(saved.activeGroup).toBe("b");
                        expect(saved.activeRegime).toBe("low");
                        expect(saved.dataBuffer.map((d) => d.value)).toEqual([20, 21, 22]);
                        const parked = Object.keys(saved.regimes).map((k) => saved.regimes[k].dataBuffer.length);
                        expect(parked.sort()).toEqual([3, 4]);
                        done();
                    } catch (e) {
                        done(e);
                    }
                }, 50);
            }
        );
    });

    it("CUSUM in σ mode is independent of the signal's scale", async () => {
        // The same shape at two scales; a sustained +2σ shift after the baseline.
        const shape = [];
        for (let i = 0; i < 40; i++) shape.push(i % 2 ? 1 : -1);
        for (let i = 0; i < 6; i++) shape.push(2 + (i % 2 ? 1 : -1));
        const cfg = {
            method: "cusum",
            cusumMode: "sigma",
            cusumDrift: 0.5,
            cusumThreshold: 5,
            cusumWarning: 3.5,
            windowSize: 40
        };
        const small = await run(
            cfg,
            shape.map((v) => 100 + v * 0.01)
        );
        await helper.unload();
        const large = await run(
            cfg,
            shape.map((v) => 100 + v * 1000)
        );
        const flags = (r) => r.out.map((m) => m.severity || "warmup");
        expect(flags(small)).toEqual(flags(large));
        expect(
            flags(small)
                .slice(0, 40)
                .every((s) => s === "normal" || s === "warmup")
        ).toBe(true);
        expect(flags(small).slice(40)).toContain("critical");
        expect(small.out[small.out.length - 1].mode).toBe("sigma");
    });

    it("CUSUM stays in signal units unless σ mode is selected", async () => {
        const { out } = await run(
            { method: "cusum", cusumThreshold: 5, cusumDrift: 0.5, windowSize: 20 },
            Array(12).fill(1).concat([10])
        );
        const last = out[out.length - 1];
        expect(last.mode).toBe("raw");
        // 10 − mean(1) − drift(0.5) = 8.5 > 5: critical, and the sum resets
        expect(last.severity).toBe("critical");
        expect(last.cusumMax).toBeCloseTo(8.5, 6);
    });

    it("applies msg.config overrides to multi-sensor payloads", async () => {
        const cfg = { method: "threshold", maxThreshold: 50, warningMargin: 0 };
        const plain = await run(cfg, [{ s: 10 }, { s: 10 }, { s: 60 }]);
        expect(plain.out[2].payload.s.severity).toBe("critical");
        await helper.unload();
        const overridden = await run(cfg, [{ s: 10 }, { s: 10 }, { s: 60 }], (p) => ({
            payload: p,
            config: { maxThreshold: 100 }
        }));
        expect(overridden.out[2].payload.s.isAnomaly).toBe(false);
        expect(overridden.out[2].payload.s.details.maxThreshold).toBe(100);
    });
});
