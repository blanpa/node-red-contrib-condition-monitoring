/**
 * trend-predictor: regression tests for RUL behaviour that used to be wrong.
 *
 *  - the "debug" option must not clobber Node-RED's node.debug() logger,
 *  - falling indicators (health index, pressure) are supported,
 *  - the "cycles" unit counts samples, not milliseconds,
 *  - "no trend" is a statistical decision, not an absolute slope cut-off,
 *  - the exponential model is a real exponential fit,
 *  - a lower bound of 0 is reported as 0, non-finite input is rejected.
 */
const helper = require("node-red-node-test-helper");
const trendPredictorNode = require("../nodes/trend-predictor.js");

helper.init(require.resolve("node-red"));

const T0 = 1700000000000;

function run(extra, values, intervalMs, mapMsg) {
    const flow = [
        Object.assign(
            { id: "n1", type: "trend-predictor", mode: "rul", windowSize: 50, wires: [["n2"], ["n3"]] },
            extra
        ),
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
    return new Promise((resolve, reject) => {
        helper.load(trendPredictorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const out = [];
            helper.getNode("n2").on("input", (m) => out.push(m));
            helper.getNode("n3").on("input", (m) => out.push(m));
            n1.on("call:error", (call) => reject(new Error(String(call.firstArg))));
            values.forEach((v, i) => {
                const msg = { payload: v, timestamp: T0 + i * (intervalMs || 1000) };
                n1.receive(mapMsg ? mapMsg(msg, i) : msg);
            });
            setTimeout(() => resolve({ out, last: out[out.length - 1], node: n1 }), 100);
        });
    });
}

describe("trend-predictor RUL", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("keeps working with the debug option enabled", async () => {
        const values = Array.from({ length: 12 }, (_, i) => 10 + i);
        const { last, node } = await run({ failureThreshold: 100, debug: true }, values);
        expect(typeof node.debug).toBe("function");
        expect(last.rul.status).toBe("healthy");
    });

    it("reports the cycles unit in samples", async () => {
        // +1 per sample, one sample a minute, at 39 after 30 samples: 61 samples to 100
        const values = Array.from({ length: 30 }, (_, i) => 10 + i);
        const { last } = await run({ failureThreshold: 100, rulUnit: "cycles" }, values, 60000);
        expect(last.rul.value).toBeCloseTo(61, 6);
        expect(last.rul.lower).toBeCloseTo(61, 6);
        expect(last.rul.upper).toBeCloseTo(61, 6);
    });

    it("the same series in hours is the cycle count times the sample interval", async () => {
        const values = Array.from({ length: 30 }, (_, i) => 10 + i);
        const { last } = await run({ failureThreshold: 100, rulUnit: "hours" }, values, 60000);
        expect(last.rul.value).toBeCloseTo(61 / 60, 6);
    });

    it("detects a slow, clean drift instead of calling it stable", async () => {
        const values = Array.from({ length: 50 }, (_, i) => 50 + i * 0.00005);
        const { last } = await run({ failureThreshold: 100, rulUnit: "cycles" }, values);
        expect(last.rul.status).not.toBe("stable");
        expect(last.rul.value).toBeGreaterThan(900000);
        expect(last.rul.value).toBeLessThan(1100000);
    });

    it("reports stable when the slope is not distinguishable from the noise", async () => {
        const noise = [3, -4, 5, -2, 4, -5, 2, -3, 5, -4, 3, -5, 4, -2, 5, -3, 1, -1, 2, -4];
        const values = noise.map((e, i) => 50 + i * 0.01 + e);
        const { last } = await run({ failureThreshold: 100 }, values);
        expect(last.rul.status).toBe("stable");
        expect(last.rul.value).toBe(Infinity);
    });

    it("supports an indicator falling towards the threshold", async () => {
        // health index 100 -> 71, failure at 20: 51 more samples
        const values = Array.from({ length: 30 }, (_, i) => 100 - i);
        const { last } = await run({ failureThreshold: 20, failureDirection: "falling", rulUnit: "cycles" }, values);
        expect(last.rul.status).toBe("healthy");
        expect(last.rul.direction).toBe("falling");
        expect(last.rul.value).toBeCloseTo(51, 6);
        expect(last.degradation.rate).toBeCloseTo(-1, 6);
    });

    it("a falling indicator at or below the threshold has failed, one above it has not", async () => {
        const falling = { failureThreshold: 20, failureDirection: "falling" };
        let r = await run(falling, [24, 23, 22, 21, 20, 19]);
        expect(r.last.rul.status).toBe("failed");
        await helper.unload();
        // The default (rising) direction keeps its historical meaning
        r = await run({ failureThreshold: 20 }, [100, 99, 98, 97, 96, 95]);
        expect(r.last.rul.status).toBe("failed");
    });

    it("applies the warning threshold in the failure direction", async () => {
        const values = Array.from({ length: 10 }, (_, i) => 100 - i);
        const cfg = { failureThreshold: 20, warningThreshold: 95, failureDirection: "falling" };
        const flowOut = await run(cfg, values);
        // 100..96 are above the warning level, 95..91 at or below it
        const anomalies = flowOut.out.filter((m) => m.payload <= 95);
        expect(anomalies.length).toBe(5);
    });

    it("fits a real exponential for the exponential model", async () => {
        // y = 10 * 1.05^i; reaches 100 at i = ln(10)/ln(1.05) = 47.19
        const values = Array.from({ length: 30 }, (_, i) => 10 * Math.pow(1.05, i));
        const cfg = { failureThreshold: 100, rulUnit: "cycles" };
        const exp = await run(Object.assign({ degradationModel: "exponential" }, cfg), values);
        expect(exp.last.rul.model).toBe("exponential");
        expect(exp.last.rul.value).toBeCloseTo(Math.log(10) / Math.log(1.05) - 29, 4);
        await helper.unload();
        // The straight line through the same data overshoots by far
        const lin = await run(Object.assign({ degradationModel: "linear" }, cfg), values);
        expect(lin.last.rul.value).toBeGreaterThan(exp.last.rul.value * 1.5);
    });

    it("falls back to linear when the exponential model cannot apply", async () => {
        const values = Array.from({ length: 12 }, (_, i) => -5 + i);
        const { last } = await run({ failureThreshold: 100, degradationModel: "exponential" }, values);
        expect(last.rul.model).toBe("linear");
    });

    it("uses the configured Weibull shape and scale", async () => {
        const values = Array.from({ length: 20 }, (_, i) => 31 + i);
        const cfg = { failureThreshold: 100, degradationModel: "weibull", rulUnit: "hours", weibullBeta: 2 };
        const a = await run(Object.assign({ weibullEta: 1000 }, cfg), values);
        expect(a.last.rul.model).toBe("weibull");
        expect(a.last.weibull.beta).toBe(2);
        // D = 0.5: t_eq = η·sqrt(ln 2), target = η·sqrt(ln 10)
        const expected = 1000 * (Math.sqrt(Math.log(10)) - Math.sqrt(Math.log(2)));
        expect(a.last.rul.value).toBeCloseTo(expected, 3);
        await helper.unload();
        const b = await run(Object.assign({ weibullEta: 2000 }, cfg), values);
        expect(b.last.rul.value).toBeCloseTo(2 * expected, 3);
    });

    it("reports a lower bound of 0 as 0, not null", async () => {
        const noise = [3, -4, 5, -2, 4, -5, 2, -3, 5, -4, 3, -5, 4, -2, 5, -3];
        const values = noise.map((e, i) => 84 + i + e * 0.5);
        const { last } = await run({ failureThreshold: 100 }, values);
        expect(last.rul.status).not.toBe("stable");
        expect(last.rul.lower).toBe(0);
    });

    it("rejects non-finite and non-numeric payloads", async () => {
        const { out, node } = await run({ mode: "prediction" }, [1, "Infinity", "12abc", 2, 3, 4]);
        expect(node.buffer).toEqual([1, 2, 3, 4]);
        expect(Number.isFinite(out[out.length - 1].slope)).toBe(true);
    });

    it("prediction mode finds a threshold the series is falling towards", async () => {
        const values = Array.from({ length: 10 }, (_, i) => 100 - 2 * i);
        const { last } = await run({ mode: "prediction", threshold: 70, predictionSteps: 10 }, values);
        // at 82, -2 per step: 76 after 3 steps would still be above, 70 is reached at step 6
        expect(last.stepsToThreshold).toBe(6);
    });
});

describe("trend-predictor grouping, time base and multi-sensor overrides", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("fits the trend over time, not over the sample index", async () => {
        // +1 per minute, but sampled unevenly: a burst, a long gap, a burst.
        const minutes = [0, 1, 2, 3, 4, 5, 30, 31, 32, 33, 34, 35];
        const cfg = { failureThreshold: 100, rulUnit: "minutes" };
        const { last } = await run(cfg, minutes, 60000, (msg, i) => ({
            payload: 10 + minutes[i],
            timestamp: T0 + minutes[i] * 60000
        }));
        // at 45 after 35 min, +1/min: 55 minutes to 100. Fitted over the index
        // the 25-minute gap looks like a jump and the estimate is far too short.
        expect(last.rul.value).toBeCloseTo(55, 4);
        expect(last.degradation.rate).toBeCloseTo(35 / 11, 6); // per average step
    });

    it("falls back to the sample index when timestamps do not increase", async () => {
        const values = Array.from({ length: 12 }, (_, i) => 10 + i);
        const { last } = await run({ failureThreshold: 100, rulUnit: "cycles" }, values, 1000, (msg, i) => ({
            payload: msg.payload,
            timestamp: T0 + (i === 6 ? 5000 : i * 1000) // one duplicate
        }));
        expect(last.rul.status).toBe("healthy");
        expect(last.rul.value).toBeCloseTo(79, 6);
    });

    it("keeps one buffer per group value", async () => {
        const msgs = [];
        for (let i = 0; i < 12; i++) {
            msgs.push({ payload: 10 + i, topic: "rising" });
            msgs.push({ payload: 50, topic: "flat" });
        }
        const cfg = { failureThreshold: 100, rulUnit: "cycles", groupBy: "topic" };
        const { out, node } = await run(cfg, msgs, 1000, (msg, i) => ({
            payload: msgs[i].payload,
            topic: msgs[i].topic,
            timestamp: T0 + Math.floor(i / 2) * 1000
        }));
        const byGroup = (g) => out.filter((m) => m.group === g);
        expect(byGroup("rising").pop().rul.value).toBeCloseTo(79, 6);
        expect(byGroup("flat").pop().rul.status).toBe("stable");
        expect(node.groups.size).toBe(1); // one parked, one live
    });

    it("msg.reset clears only the group of the message, 'all' every group", async () => {
        const feed = [];
        for (let i = 0; i < 6; i++) {
            feed.push({ payload: i, topic: "a" });
            feed.push({ payload: i, topic: "b" });
        }
        feed.push({ reset: true, topic: "a" });
        feed.push({ payload: 99, topic: "b" });
        const { node } = await run({ mode: "prediction", groupBy: "topic" }, feed, 1000, (msg, i) => feed[i]);
        expect(node.activeGroup).toBe("b");
        expect(node.buffer.length).toBe(7);
        // the reset group holds nothing, so it is not kept around
        expect(node.groups.has("a")).toBe(false);
        node.receive({ reset: "all" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(node.groups.size).toBe(0);
        expect(node.buffer).toEqual([]);
    });

    it("applies msg.config overrides to multi-sensor payloads", async () => {
        const values = Array.from({ length: 8 }, (_, i) => ({ s: 10 + i }));
        const cfg = { mode: "prediction", threshold: 1000, predictionSteps: 5 };
        const plain = await run(cfg, values);
        expect(plain.last.thresholdExceeded).toBeUndefined();
        await helper.unload();
        const overridden = await run(cfg, values, 1000, (msg) => ({
            payload: msg.payload,
            timestamp: msg.timestamp,
            config: { threshold: 20 }
        }));
        // at 17, +1 per step: 20 is reached within 5 steps
        expect(overridden.last.thresholdExceeded).toBe(true);
        expect(overridden.last.payload.s.stepsToThreshold).toBe(3);
    });
});
