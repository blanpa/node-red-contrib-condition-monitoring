/**
 * trend-predictor: regression tests for results that used to be wrong.
 *
 *  - a clock step (NTP correction) in the timestamps produced a negative RUL
 *    labelled "critical", then a far too optimistic one,
 *  - a single spike at the failure threshold reported "failed" with full
 *    confidence and "stable" one sample later,
 *  - the prediction-mode trend label used an absolute slope cut-off (±0.01)
 *    and so depended on the unit of the signal,
 *  - the Output Topic setting was ignored by every scalar send path,
 *  - timestamps in epoch seconds were taken as milliseconds.
 */
const helper = require("node-red-node-test-helper");
const trendPredictorNode = require("../nodes/trend-predictor.js");

helper.init(require.resolve("node-red"));

const T0 = 1700000000000;

// Runs a flow and keeps the two outputs apart (the rul_spec helper merges them).
function run(config, messages) {
    const flow = [
        Object.assign({ id: "n1", type: "trend-predictor", wires: [["n2"], ["n3"]] }, config),
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
    return new Promise((resolve, reject) => {
        helper.load(trendPredictorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const out1 = [];
            const out2 = [];
            const warnings = [];
            const errors = [];
            helper.getNode("n2").on("input", (m) => out1.push(m));
            helper.getNode("n3").on("input", (m) => out2.push(m));
            n1.on("call:warn", (call) => warnings.push(String(call.firstArg)));
            n1.on("call:error", (call) => errors.push(String(call.firstArg)));
            try {
                messages.forEach((m) => n1.receive(m));
            } catch (e) {
                reject(e);
                return;
            }
            setTimeout(() => {
                const all = out1.concat(out2).sort((a, b) => a.timestamp - b.timestamp);
                resolve({ out1, out2, all, warnings, errors, last: all[all.length - 1], node: n1 });
            }, 150);
        });
    });
}

function series(values, intervalMs, extra) {
    return values.map((v, i) => Object.assign({ payload: v, timestamp: T0 + i * (intervalMs || 1000) }, extra || {}));
}

const RUL_MIN = { mode: "rul", windowSize: 50, failureThreshold: 100, rulUnit: "minutes" };

describe("trend-predictor robustness", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    describe("time base", function () {
        // 1 Hz stream rising 1/sample from 20: 41 s to the threshold at the end
        const values = Array.from({ length: 40 }, (_, i) => 20 + i);

        it("never emits a negative RUL or 'critical' across a +1 h clock step", async () => {
            const clean = await run(RUL_MIN, series(values));
            await helper.unload();
            const stepped = await run(
                RUL_MIN,
                values.map((v, i) => ({ payload: v, timestamp: T0 + i * 1000 + (i >= 20 ? 3600000 : 0) }))
            );
            expect(stepped.errors).toEqual([]);
            // the pre-step line extrapolated over an hour that never happened
            // used to put the crossing 58 minutes in the past, 14 messages long
            stepped.all.forEach((m) => {
                expect(m.rul.value === Infinity || m.rul.value >= 0).toBe(true);
                expect(m.rul.status).not.toBe("critical");
                expect(m.rul.status).not.toBe("inconsistent");
            });
            expect(stepped.out2.length).toBe(0);
            // the step is one ordinary interval: same estimate as the clean stream
            expect(stepped.last.rul.value).toBeCloseTo(clean.last.rul.value, 6);
            expect(stepped.last.rul.status).toBe(clean.last.rul.status);
            expect(stepped.last.rul.timeBased).toBe(true);
            expect(stepped.last.rul.intervalOutliers).toBe(1);
            // warned once, not once per message
            expect(stepped.warnings.filter((w) => /clock step/.test(w)).length).toBe(1);
        });

        it("still fits a genuine data gap as elapsed time", async () => {
            // +1 per minute, a 25-minute outage in between: the value moved on
            const minutes = [0, 1, 2, 3, 4, 5, 30, 31, 32, 33, 34, 35];
            const { last, warnings } = await run(
                RUL_MIN,
                minutes.map((m) => ({ payload: 10 + m, timestamp: T0 + m * 60000 }))
            );
            // at 45 after 35 min, +1/min: 55 minutes to 100
            expect(last.rul.value).toBeCloseTo(55, 4);
            expect(last.rul.intervalOutliers).toBe(1);
            expect(warnings.filter((w) => /data gap/.test(w)).length).toBe(1);
        });

        it("reads epoch-second timestamps as seconds, once warned", async () => {
            // 12 samples a minute apart, in seconds
            const values = Array.from({ length: 12 }, (_, i) => 10 + i);
            const inSeconds = await run(
                RUL_MIN,
                values.map((v, i) => ({ payload: v, timestamp: 1700000000 + i * 60 }))
            );
            expect(inSeconds.warnings.filter((w) => /epoch seconds/.test(w)).length).toBe(1);
            // at 21, +1/min: 79 minutes to 100 (read as ms it was 79 × 60 000 minutes)
            expect(inSeconds.last.rul.value).toBeCloseTo(79, 6);
            await helper.unload();
            // a small monotonic counter is left alone
            const counter = await run(
                Object.assign({}, RUL_MIN, { rulUnit: "cycles" }),
                values.map((v, i) => ({ payload: v, timestamp: i }))
            );
            expect(counter.warnings).toEqual([]);
            expect(counter.last.rul.value).toBeCloseTo(79, 6);
        });

        it("reports 'inconsistent' instead of a negative RUL when the fit is already past the threshold", async () => {
            // a steep rise that stalls just under the threshold: the trend line's
            // level at the last sample is above 100, the samples are not
            const values = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99, 99, 99];
            const { all, out2, errors } = await run(
                { mode: "rul", windowSize: 50, failureThreshold: 100, rulUnit: "cycles" },
                series(values)
            );
            expect(errors).toEqual([]);
            const last = all[all.length - 1];
            expect(last.rul.status).toBe("inconsistent");
            expect(last.rul.value).toBeNull();
            expect(last.rul.lower).toBeNull();
            all.forEach((m) => {
                if (m.rul.value !== null) expect(m.rul.value).toBeGreaterThanOrEqual(0);
            });
            // not routed to the critical output
            expect(out2.some((m) => m.rul.status === "inconsistent")).toBe(false);
        });
    });

    describe("single-sample decisions", function () {
        it("does not report 'failed' on a single spike at the threshold", async () => {
            const values = [10, 11, 12, 13, 14, 15, 16, 17, 150, 18, 19];
            const { all, out2 } = await run({ mode: "rul", windowSize: 50, failureThreshold: 100 }, series(values));
            expect(all.map((m) => m.rul.status)).not.toContain("failed");
            expect(out2.some((m) => m.payload === 150)).toBe(false);
            // a genuine crossing is still reported, one sample later
            await helper.unload();
            const crossing = await run(
                { mode: "rul", windowSize: 50, failureThreshold: 100 },
                series([90, 92, 94, 96, 98, 100, 102, 104])
            );
            const statuses = crossing.all.map((m) => m.payload + ":" + m.rul.status);
            expect(statuses).toContain("102:failed");
            expect(statuses).toContain("104:failed");
        });

        it("tests the warning threshold on the median of the last three samples", async () => {
            const values = [10, 11, 12, 13, 14, 95, 15, 16, 17, 18];
            const { out2 } = await run(
                { mode: "rul", windowSize: 50, failureThreshold: 200, warningThreshold: 90 },
                series(values)
            );
            expect(out2.map((m) => m.payload)).toEqual([]);
        });
    });

    describe("trend label", function () {
        it("labels a slow drift of a 0-1 index as decreasing", async () => {
            const { last } = await run(
                { mode: "prediction", windowSize: 50 },
                series(Array.from({ length: 20 }, (_, i) => 0.5 - i * 0.005))
            );
            expect(last.trend).toBe("decreasing");
            expect(last.slope).toBeCloseTo(-0.005, 9);
        });

        it("labels a noisy flat signal in large units as stable", async () => {
            const noise = [3, -4, 5, -2, 4, -5, 2, -3, 5, -4, 3, -5, 4, -2, 5, -3, 1, -1, 2, -4];
            const { last } = await run({ mode: "prediction", windowSize: 50 }, series(noise.map((e) => 1000 + e)));
            // |slope| 0.064 per sample is more than the old ±0.01 cut-off, but
            // well within two standard errors (0.29)
            expect(Math.abs(last.slope)).toBeGreaterThan(0.01);
            expect(last.trend).toBe("stable");
        });

        it("uses the same test for exponential smoothing and multi-sensor payloads", async () => {
            const falling = Array.from({ length: 20 }, (_, i) => 0.5 - i * 0.005);
            const holt = await run({ mode: "prediction", method: "exponential", windowSize: 50 }, series(falling));
            expect(holt.last.trend).toBe("decreasing");
            await helper.unload();
            const multi = await run(
                { mode: "prediction", windowSize: 50 },
                series(falling.map((v) => ({ hi: v, flat: 1000 })))
            );
            expect(multi.last.payload.hi.trend).toBe("decreasing");
            expect(multi.last.payload.flat.trend).toBe("stable");
        });
    });

    describe("output topic", function () {
        const topic = { outputTopic: "forced-topic" };
        const values = Array.from({ length: 12 }, (_, i) => 10 + i);

        it("is applied in every scalar mode", async () => {
            const prediction = await run(
                Object.assign({ mode: "prediction" }, topic),
                series(values, 1000, { topic: "in" })
            );
            expect(prediction.last.topic).toBe("forced-topic");
            await helper.unload();
            const rul = await run(Object.assign({}, RUL_MIN, topic), series(values, 1000, { topic: "in" }));
            expect(rul.last.topic).toBe("forced-topic");
            await helper.unload();
            const roc = await run(
                Object.assign({ mode: "rate-of-change" }, topic),
                series(values, 1000, { topic: "in" })
            );
            expect(roc.last.topic).toBe("forced-topic");
        });

        it("is applied to multi-sensor payloads whether or not the message had a topic", async () => {
            const withTopic = await run(
                Object.assign({ mode: "prediction" }, topic),
                series(
                    values.map((v) => ({ s: v })),
                    1000,
                    { topic: "in" }
                )
            );
            expect(withTopic.last.topic).toBe("forced-topic");
            await helper.unload();
            const without = await run(
                Object.assign({ mode: "prediction" }, topic),
                series(values.map((v) => ({ s: v })))
            );
            expect(without.last.topic).toBe("forced-topic");
        });

        it("keeps the incoming topic when no output topic is configured", async () => {
            const { last } = await run({ mode: "prediction" }, series(values, 1000, { topic: "in" }));
            expect(last.topic).toBe("in");
        });
    });
});
