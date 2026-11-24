/**
 * multi-value-processor: input hygiene, Mahalanobis scoring, cross-correlation
 * and per-group buffers. Driven through the synchronous RED stub with seeded
 * data.
 */
const multiValueProcessorNode = require("../nodes/multi-value-processor.js");
const stats = require("../nodes/utils/statistics");
const { buildStubbedNode, feed, output, closeNode, settle, seededRandom } = require("./stub-runtime");

function build(config, seeded) {
    return buildStubbedNode(multiValueProcessorNode, Object.assign({ id: "n1" }, config), seeded);
}

describe("multi-value-processor hardening", function () {
    describe("debug logging", function () {
        it("processes messages with debug enabled (node.debug stays a function)", function () {
            const stub = build({ mode: "aggregate", debug: true });

            const res = feed(stub, { payload: [1, 2, 3] });

            expect(stub.errors).toEqual([]);
            expect(typeof stub.node.debug).toBe("function");
            expect(stub.node.debugEnabled).toBe(true);
            expect(res.out1.payload).toBe(2);
            expect(stub.debugLines.length).toBe(1);
        });

        it("logs Mahalanobis scoring with debug enabled", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", debug: true });
            const rng = seededRandom(1);
            for (let i = 0; i < 20; i++) feed(stub, { payload: [rng.gauss(), rng.gauss()] });

            expect(stub.errors).toEqual([]);
            expect(
                stub.debugLines.some(function (l) {
                    return l.indexOf("Mahalanobis: d=") === 0;
                })
            ).toBe(true);
        });
    });

    describe("analyze: non-finite input", function () {
        it("skips a NaN instead of blinding the detector for a whole window", function () {
            const stub = build({ mode: "analyze", windowSize: 50 });
            const rng = seededRandom(2);
            for (let i = 0; i < 30; i++) feed(stub, { payload: [10 + 0.1 * rng.gauss()] });

            const skipped = feed(stub, { payload: [NaN] });
            expect(skipped.all).toEqual([]);

            const res = feed(stub, { payload: [1000] });
            expect(res.out2).toBeDefined();
            expect(Number.isFinite(res.out2.payload[0].zScore)).toBe(true);
            expect(res.out2.payload[0].zScore).toBeGreaterThan(3);
        });

        it("reports skipped entries and keeps the remaining names aligned", function () {
            const stub = build({ mode: "analyze" });

            const msg = output(feed(stub, { payload: [10, null, "7", Infinity, 3] }));

            expect(
                msg.payload.map(function (r) {
                    return [r.valueName, r.value];
                })
            ).toEqual([
                ["value0", 10],
                ["value2", 7],
                ["value4", 3]
            ]);
            expect(msg.skippedValues).toEqual(["value1", "value3"]);
        });

        it("parses numeric strings in arrays instead of concatenating them", function () {
            const stub = build({ mode: "analyze" });
            let msg;
            for (let i = 0; i < 10; i++) msg = output(feed(stub, { payload: [10, "7"] }));

            expect(msg.payload[1].mean).toBe(7);
            expect(msg.skippedValues).toBeUndefined();
        });

        it("handles value names that collide with Object.prototype members", function () {
            const stub = build({ mode: "analyze" });
            let msg;
            for (let i = 0; i < 10; i++) {
                msg = output(feed(stub, { payload: JSON.parse('{"constructor":1,"toString":2,"__proto__":3}') }));
            }

            expect(stub.errors).toEqual([]);
            expect(
                msg.payload.map(function (r) {
                    return r.valueName;
                })
            ).toEqual(["constructor", "toString", "__proto__"]);
            expect(msg.payload[0].mean).toBe(1);
        });
    });

    describe("analyze: static thresholds", function () {
        it("checks the very first sample", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "threshold", maxThreshold: "100" });

            const res = feed(stub, { payload: { temp: 500 } });

            expect(res.out2).toBeDefined();
            expect(res.out2.payload[0].reason).toBe("Above maximum");
        });

        it("treats an unparseable limit as 'no limit'", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "threshold", minThreshold: "abc", maxThreshold: "" });

            expect(stub.node.minThreshold).toBeNull();
            expect(stub.node.maxThreshold).toBeNull();
            expect(feed(stub, { payload: [5] }).out1).toBeDefined();
        });
    });

    describe("analyze: Mahalanobis", function () {
        function noise(rng, dims) {
            const v = [];
            for (let k = 0; k < dims; k++) v.push(rng.gauss());
            return v;
        }

        it("flags a gross outlier even with a short window", function () {
            // With the sample included in its own covariance the distance was
            // capped at (n-1)/sqrt(n) = 2.85 for n = 10 — below the limit.
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 10 });
            const rng = seededRandom(3);
            for (let i = 0; i < 10; i++) feed(stub, { payload: noise(rng, 3) });

            const res = feed(stub, { payload: [1e6, 0, 0] });

            expect(res.out2).toBeDefined();
            expect(res.out2.payload[0].severity).toBe("critical");
            expect(res.out2.payload[0].mahalanobisDistance).toBeGreaterThan(1000);
        });

        it("scores against the history before the sample, starting at the 11th sample", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 50 });
            const rng = seededRandom(4);
            let msg;
            for (let i = 0; i < 10; i++) msg = output(feed(stub, { payload: noise(rng, 2) }));
            expect(msg.payload[0].mahalanobisDistance).toBeUndefined();

            msg = output(feed(stub, { payload: noise(rng, 2) }));
            expect(msg.payload[0].mahalanobisDistance).toBeGreaterThanOrEqual(0);
            expect(stub.node.mahalanobisBuffer.length).toBe(11);
        });

        it("derives the limit from the threshold, sensor count and history length", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 50, threshold: 3 });
            const rng = seededRandom(5);
            let msg;
            for (let i = 0; i < 51; i++) msg = output(feed(stub, { payload: noise(rng, 4) }));

            expect(msg.payload[0].mahalanobisThreshold).toBeCloseTo(Math.sqrt(stats.hotellingLimitFromZ(4, 50, 3)), 10);
            expect(msg.payload[0].mahalanobisWarningThreshold).toBeCloseTo(
                Math.sqrt(stats.hotellingLimitFromZ(4, 50, 2)),
                10
            );
        });

        it("keeps the critical false-alarm rate low on clean data, short window included", function () {
            [10, 100].forEach(function (windowSize) {
                const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: windowSize });
                const rng = seededRandom(6);
                let scored = 0;
                let critical = 0;
                for (let i = 0; i < 1500; i++) {
                    const r = output(feed(stub, { payload: noise(rng, 3) })).payload[0];
                    if (r.mahalanobisDistance !== undefined) {
                        scored++;
                        if (r.severity === "critical") critical++;
                    }
                }
                expect(scored).toBeGreaterThan(1400);
                expect(critical / scored).toBeLessThan(0.02);
            });
        });

        it("uses only complete samples when a sensor reports intermittently", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 100 });
            const rng = seededRandom(7);
            for (let i = 0; i < 80; i++) {
                const x = rng.gauss();
                const payload = { a: x, b: 2 * x + 0.05 * rng.gauss() };
                if (i % 2 === 1) delete payload.b;
                feed(stub, { payload: payload });
            }

            // On the learned relationship b = 2a: normal. Off it: anomaly.
            const onModel = feed(stub, { payload: { a: 1, b: 2 } });
            const offModel = feed(stub, { payload: { a: 1, b: -2 } });

            expect(onModel.out1).toBeDefined();
            expect(onModel.out1.payload[0].severity).toBe("normal");
            expect(offModel.out2).toBeDefined();
            expect(offModel.out2.payload[0].severity).toBe("critical");
        });

        it("clears the Mahalanobis history on reset and on close", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis" });
            const rng = seededRandom(8);
            for (let i = 0; i < 30; i++) feed(stub, { payload: noise(rng, 2) });
            expect(stub.node.mahalanobisBuffer.length).toBe(30);

            feed(stub, { reset: true });
            expect(stub.node.mahalanobisBuffer.length).toBe(0);

            for (let i = 0; i < 5; i++) feed(stub, { payload: noise(rng, 2) });
            stub.node.emit("close");
            expect(stub.node.mahalanobisBuffer.length).toBe(0);
        });
    });

    describe("correlate: cross-correlation", function () {
        function crossNode(extra) {
            return build(
                Object.assign(
                    { mode: "correlate", correlationMethod: "cross", sensor1: "x", sensor2: "y", windowSize: 200 },
                    extra
                )
            );
        }

        it("reports which signal leads the right way round", function () {
            const stub = crossNode();
            const rng = seededRandom(9);
            const xs = [];
            let msg;
            for (let i = 0; i < 200; i++) {
                xs.push(rng.gauss());
                // y repeats x three samples later: x leads
                msg = output(feed(stub, { payload: { x: xs[i], y: i >= 3 ? xs[i - 3] : 0 } }));
            }

            expect(msg.crossCorrelation.bestLag).toBe(3);
            expect(msg.crossCorrelation.interpretation).toBe("Signal X leads Signal Y by 3 samples");
            expect(msg.correlation).toBeGreaterThan(0.95);

            const reverse = crossNode();
            for (let i = 0; i < 200; i++) {
                msg = output(feed(reverse, { payload: { y: xs[i], x: i >= 3 ? xs[i - 3] : 0 } }));
            }
            expect(msg.crossCorrelation.bestLag).toBe(-3);
            expect(msg.crossCorrelation.interpretation).toBe("Signal Y leads Signal X by 3 samples");
        });

        it("recognises a strong negative relationship", function () {
            const stub = crossNode();
            const rng = seededRandom(10);
            let res;
            for (let i = 0; i < 200; i++) {
                const x = rng.gauss();
                res = feed(stub, { payload: { x: x, y: -x } });
            }

            expect(res.out1).toBeDefined();
            expect(res.out1.correlation).toBeCloseTo(-1, 6);
            expect(res.out1.crossCorrelation.bestLag).toBe(0);
            expect(res.out1.isAnomalous).toBe(false);
        });

        it("bounds the lag search (default cap and configured maxLag)", function () {
            const rng = seededRandom(11);
            const auto = crossNode({ windowSize: 2000 });
            const capped = crossNode({ windowSize: 2000, maxLag: 5 });
            let a;
            let c;
            for (let i = 0; i < 2000; i++) {
                const payload = { x: rng.gauss(), y: rng.gauss() };
                a = feed(auto, { payload: payload });
                c = feed(capped, { payload: payload });
            }

            expect(output(a).crossCorrelation.allLags.length).toBe(2 * 256 + 1);
            expect(output(c).crossCorrelation.allLags.length).toBe(11);
            output(a).crossCorrelation.allLags.forEach(function (l) {
                expect(Math.abs(l.correlation)).toBeLessThanOrEqual(1);
            });
        });
    });

    describe("aggregate", function () {
        it("handles arrays too large for Math.min.apply", function () {
            const stub = build({ mode: "aggregate", aggregateMethod: "max" });
            const big = new Array(200000).fill(1);
            big[123456] = 9;

            const res = feed(stub, { payload: big });

            expect(stub.errors).toEqual([]);
            expect(res.out1.payload).toBe(9);
            expect(res.out1.aggregation.all.min).toBe(1);
        });

        it("ignores non-finite values", function () {
            const stub = build({ mode: "aggregate", aggregateMethod: "mean" });

            const res = feed(stub, { payload: [1, Infinity, 3, NaN] });

            expect(res.out1.payload).toBe(2);
            expect(res.out1.aggregation.count).toBe(2);
        });
    });

    describe("per-group buffers", function () {
        it("keeps analyze baselines apart per group value", function () {
            const stub = build({ mode: "analyze", windowSize: 50, groupBy: "topic" });
            const rng = seededRandom(12);
            for (let i = 0; i < 40; i++) {
                feed(stub, { topic: "cold", payload: { t: 10 + 0.5 * rng.gauss() } });
                feed(stub, { topic: "hot", payload: { t: 900 + 0.5 * rng.gauss() } });
            }

            const own = feed(stub, { topic: "hot", payload: { t: 900 } });
            const foreign = feed(stub, { topic: "cold", payload: { t: 900 } });

            expect(own.out1).toBeDefined();
            expect(own.out1.group).toBe("hot");
            expect(foreign.out2).toBeDefined();
            expect(foreign.out2.group).toBe("cold");
            expect(stub.node.groups.get("hot").dataBuffers.t.length).toBe(41);
        });

        it("keeps correlation buffers apart per group value", function () {
            const stub = build({ mode: "correlate", sensor1: "x", sensor2: "y", groupBy: "payload.device" });
            const rng = seededRandom(13);
            let together;
            let opposed;
            for (let i = 0; i < 50; i++) {
                const x = rng.gauss();
                together = output(feed(stub, { payload: { device: "d1", x: x, y: x } }));
                opposed = output(feed(stub, { payload: { device: "d2", x: x, y: -x } }));
            }

            expect(together.correlation).toBeCloseTo(1, 6);
            expect(opposed.correlation).toBeCloseTo(-1, 6);
            expect(together.group).toBe("d1");
        });

        it("evicts the least recently used group and resets one group at a time", function () {
            const stub = build({ mode: "analyze", groupBy: "topic", maxGroups: 2 });
            ["a", "b", "a", "c"].forEach(function (topic) {
                feed(stub, { topic: topic, payload: [1] });
            });
            expect(Array.from(stub.node.groups.keys())).toEqual(["a", "c"]);

            feed(stub, { topic: "a", reset: true });
            expect(Array.from(stub.node.groups.keys())).toEqual(["c"]);
        });

        it("shares one set of buffers when groupBy is empty (legacy behaviour)", function () {
            const stub = build({ mode: "analyze" });
            feed(stub, { topic: "a", payload: [1] });
            const msg = output(feed(stub, { topic: "b", payload: [2] }));

            expect(stub.node.dataBuffers.value0.length).toBe(2);
            expect(msg.group).toBeUndefined();
        });
    });

    describe("split", function () {
        it("still emits one message per value through send()", function () {
            const stub = build({ mode: "split" });

            const res = feed(stub, { payload: [1, 2, 3], topic: "t" });

            expect(res.all.length).toBe(3);
            expect(
                res.all.map(function (m) {
                    return m[0].payload;
                })
            ).toEqual([1, 2, 3]);
            expect(res.all[2][0].topic).toBe("t");
        });
    });
    describe("analyze: streaming z-score", function () {
        // The z-score is read from a running accumulator instead of a pass over
        // the window (a ring buffer), and a sample is scored against the window
        // as it stood BEFORE it arrived — once that holds min(windowSize, 10) − 1
        // values. It must agree with the reference definition (population
        // mean / std-dev over that window) on every sample.
        function expectMatchesReference(windowSize, values, relTol) {
            const stub = build({ mode: "analyze", windowSize: windowSize });
            const minHistory = Math.max(2, Math.min(windowSize, 10) - 1);
            const window = [];
            let compared = 0;

            values.forEach(function (value) {
                const res = feed(stub, { payload: [value] });
                const result = output(res).payload[0];

                if (window.length < minHistory) {
                    expect(res.out1).toBeDefined();
                    expect(result.zScore).toBeUndefined();
                    expect(result.isAnomaly).toBe(false);
                    expect(result.severity).toBe("warmup");
                    expect(result.bufferSize).toBe(window.length);
                    expect(result.minRequired).toBe(minHistory);
                } else {
                    const mean = stats.calculateMean(window);
                    const stdDev = stats.calculateStdDev(window, mean);
                    const zScore = (value - mean) / stdDev; // the series never go flat
                    const scale = Math.max(1, Math.abs(mean));
                    expect(Math.abs(result.mean - mean)).toBeLessThanOrEqual(relTol * scale);
                    expect(Math.abs(result.stdDev - stdDev)).toBeLessThanOrEqual(relTol * Math.max(stdDev, 1e-12));
                    expect(Math.abs(result.zScore - zScore)).toBeLessThanOrEqual(
                        relTol * Math.max(1, Math.abs(zScore))
                    );
                    // Same routing decision
                    expect(result.isAnomaly).toBe(Math.abs(zScore) > 3);
                    expect(Boolean(res.out2)).toBe(Math.abs(zScore) > 3);
                    compared++;
                }

                window.push(value);
                if (window.length > windowSize) window.shift();
            });
            return compared;
        }

        it("matches the reference on noisy data with outliers, across many window turnovers", function () {
            const rng = seededRandom(20);
            const values = [];
            for (let i = 0; i < 3000; i++) {
                values.push(20 + rng.gauss() + (i % 97 === 96 ? 15 : 0));
            }

            expect(expectMatchesReference(50, values, 1e-9)).toBe(2991);
        });

        it("flags an outlier that a window of 4 could never flag when scored within the window", function () {
            // Within its own window |z| is capped at sqrt(n − 1) = 1.73
            const flat = build({ mode: "analyze", anomalyMethod: "zscore", windowSize: 4, threshold: 3 });
            let res;
            [10, 10, 10, 1000].forEach(function (v) {
                res = feed(flat, { payload: [v] });
            });
            expect(res.out2).toBeDefined();
            expect(res.out2.payload[0].isAnomaly).toBe(true);
            expect(res.out2.payload[0].mean).toBe(10);
            expect(res.out2.payload[0].stdDev).toBe(0);
            expect(res.out2.payload[0].zScore).toBeGreaterThan(3);
            expect(Number.isFinite(res.out2.payload[0].zScore)).toBe(true);

            const noisy = build({ mode: "analyze", anomalyMethod: "zscore", windowSize: 4, threshold: 3 });
            [10, 11, 10, 1000].forEach(function (v) {
                res = feed(noisy, { payload: [v] });
            });
            expect(res.out2).toBeDefined();
            expect(res.out2.payload[0].zScore).toBeCloseTo((1000 - 31 / 3) / stats.calculateStdDev([10, 11, 10]), 6);
        });

        it("flags 1000 after nine values near 10 (window 10, threshold 3)", function () {
            // Scored within a window of 10 this came out at exactly z = 3.000
            const stub = build({ mode: "analyze", anomalyMethod: "zscore", windowSize: 10, threshold: 3 });
            const rng = seededRandom(3);
            let res;
            for (let i = 0; i < 9; i++) res = feed(stub, { payload: [10 + 0.01 * rng.gauss()] });
            // The 9th sample still warms up (8 values before it); the 10th is
            // the first one scored — against the nine before it
            expect(res.out1.payload[0].severity).toBe("warmup");
            expect(res.out1.payload[0].bufferSize).toBe(8);

            res = feed(stub, { payload: [1000] });
            expect(res.out2).toBeDefined();
            expect(res.out2.payload[0].zScore).toBeGreaterThan(1000);
            expect(res.out2.hasAnomaly).toBe(true);
            expect(res.out2.anomalyCount).toBe(1);
        });

        it("scores IQR against the window before the sample too", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "iqr", windowSize: 10 });
            const baseline = [10, 10, 11, 10, 9, 10, 11, 10, 9];
            let res;
            baseline.forEach(function (v) {
                res = feed(stub, { payload: [v] });
            });
            expect(res.out1.payload[0].severity).toBe("warmup");
            expect(res.out1.payload[0].minRequired).toBe(9);

            res = feed(stub, { payload: [50] });
            const quartiles = stats.calculateQuartiles(baseline);
            expect(res.out2).toBeDefined();
            expect(res.out2.payload[0].q1).toBe(quartiles.q1);
            expect(res.out2.payload[0].q3).toBe(quartiles.q3);
            expect(res.out2.payload[0].isAnomaly).toBe(true);
        });

        it("reports the warm-up phase per value instead of a bare result", function () {
            const stub = build({ mode: "analyze", windowSize: 100 });
            const first = feed(stub, { payload: { temp: 20, pressure: 4 } });

            expect(first.out1).toBeDefined();
            expect(first.out1.hasAnomaly).toBe(false);
            expect(first.out1.payload[0]).toEqual({
                valueName: "temp",
                value: 20,
                isAnomaly: false,
                severity: "warmup",
                bufferSize: 0,
                minRequired: 9
            });
            expect(stub.statuses[stub.statuses.length - 1].text).toBe("warm-up 0/9");

            // A value seen for the first time warms up while the others are scored
            for (let i = 0; i < 9; i++) feed(stub, { payload: { temp: 20, pressure: 4 } });
            const mixed = output(feed(stub, { payload: { temp: 20, pressure: 4, flow: 1 } }));
            expect(mixed.payload[0].zScore).toBe(0);
            expect(mixed.payload[2].severity).toBe("warmup");
            expect(stub.statuses[stub.statuses.length - 1].text).toBe("3 values ok");
        });

        it("matches the reference through level shifts", function () {
            const rng = seededRandom(21);
            const values = [];
            for (let i = 0; i < 1500; i++) {
                values.push((i < 500 ? 0.001 : i < 1000 ? 5000 : -40) + 0.5 * rng.gauss());
            }

            expectMatchesReference(64, values, 1e-9);
        });

        it("matches the reference exactly when the spread is tiny next to the level", function () {
            // Ill-conditioned for a running sum: handled by the exact fallback
            const rng = seededRandom(22);
            const values = [];
            for (let i = 0; i < 600; i++) {
                values.push(1e9 + 0.01 * rng.gauss());
            }

            expectMatchesReference(40, values, 1e-12);
        });

        it("reports a z-score of exactly 0 on a flat signal, also after a level change", function () {
            const stub = build({ mode: "analyze", windowSize: 20 });
            const values = [];
            for (let i = 0; i < 30; i++) values.push(0.1 + 0.2); // not exactly representable
            for (let i = 0; i < 60; i++) values.push(7.3);

            const tail = values.map(function (value) {
                return output(feed(stub, { payload: [value] })).payload[0];
            });

            // Once the window holds only 7.3 again
            tail.slice(-30).forEach(function (r) {
                expect(r.zScore).toBe(0);
                expect(r.stdDev).toBe(0);
                expect(r.mean).toBeCloseTo(7.3, 12);
                expect(r.isAnomaly).toBe(false);
            });
        });

        it("keeps the accumulator in step with the buffer", function () {
            const stub = build({ mode: "analyze", windowSize: 25 });
            const rng = seededRandom(23);
            for (let i = 0; i < 140; i++) feed(stub, { payload: { a: rng.gauss(), b: 100 + rng.gauss() } });

            const state = stub.node.groups.get("");
            ["a", "b"].forEach(function (name) {
                const window = state.dataBuffers[name].toArray();
                expect(window.length).toBe(25);
                expect(state.moments[name].running.count()).toBe(25);
                expect(state.moments[name].running.mean()).toBeCloseTo(stats.calculateMean(window), 10);
                // Rebuilt at least once per window turnover
                expect(state.moments[name].removals).toBeLessThan(25);
            });
        });
    });

    describe("correlate: constant input", function () {
        ["pearson", "spearman", "cross"].forEach(function (method) {
            it(
                "reports an undefined correlation, not an anomaly, when both sensors are constant (" + method + ")",
                function () {
                    const stub = build({ mode: "correlate", correlationMethod: method, sensor1: "x", sensor2: "y" });
                    let res;
                    for (let i = 0; i < 20; i++) res = feed(stub, { payload: { x: 5, y: 5 }, topic: "t" });

                    expect(stub.errors).toEqual([]);
                    expect(res.out2).toBeUndefined();
                    expect(res.out1.correlation).toBeNull();
                    expect(res.out1.isAnomalous).toBe(false);
                    expect(res.out1.reason).toBe("zero variance: x and y constant over the window");
                    expect(res.out1.method).toBe(method);
                    expect(res.out1.stats).toEqual({ sensor1Mean: 5, sensor2Mean: 5, bufferSize: 20 });
                    expect(res.out1.crossCorrelation).toBeUndefined();
                    expect(res.out1.topic).toBe("t");
                }
            );
        });

        it("names the one sensor that is constant", function () {
            const stub = build({ mode: "correlate", sensor1: "x", sensor2: "y" });
            let res;
            for (let i = 0; i < 10; i++) res = feed(stub, { payload: { x: i, y: 3 } });

            expect(res.out1.correlation).toBeNull();
            expect(res.out1.reason).toBe("zero variance: y constant over the window");
        });

        it("goes back to a numeric correlation as soon as both sensors move", function () {
            const stub = build({ mode: "correlate", sensor1: "x", sensor2: "y", windowSize: 10 });
            for (let i = 0; i < 10; i++) feed(stub, { payload: { x: 5, y: 5 } });

            const res = feed(stub, { payload: { x: 6, y: 7 } });

            expect(res.out1.correlation).toBeCloseTo(1, 10);
            expect(res.out1.reason).toBeUndefined();
        });
    });

    describe("state persistence", function () {
        it("is off unless persistState is set", function () {
            const stub = build({ mode: "analyze" });
            for (let i = 0; i < 25; i++) feed(stub, { payload: [i] });

            expect(stub.node.stateManager).toBeUndefined();
            expect(stub.store).toEqual({});
        });

        it("restores analyze buffers, with debug enabled, and scores the next sample against them", async function () {
            const rng = seededRandom(24);
            const samples = [];
            for (let i = 0; i < 30; i++) samples.push(60 + 0.5 * rng.gauss());

            const first = build({ mode: "analyze", windowSize: 30, persistState: true }, {});
            await settle();
            samples.forEach(function (v) {
                feed(first, { payload: { temp: v } });
            });
            await closeNode(first.node);

            const saved = first.store.multiValueProcessorState;
            expect(saved.version).toBe(2);
            // Windows are stored as plain numbers (no per-sample timestamps)
            expect(saved.groups[""].dataBuffers.temp).toEqual(samples);

            // The same history without a restart gives the reference score
            const reference = build({ mode: "analyze", windowSize: 30 });
            samples.forEach(function (v) {
                feed(reference, { payload: { temp: v } });
            });
            const expected = output(feed(reference, { payload: { temp: 60.2 } })).payload[0];

            const second = build({ mode: "analyze", windowSize: 30, persistState: true, debug: true }, first.store);
            await settle();

            expect(second.warnings).toEqual([]);
            expect(second.node.dataBuffers.temp.length).toBe(30);
            expect(
                second.debugLines.some(function (l) {
                    return l.indexOf("Restored 30 buffered samples") === 0;
                })
            ).toBe(true);

            const res = feed(second, { payload: { temp: 60.2 } });
            expect(output(res).payload[0].zScore).toBeCloseTo(expected.zScore, 9);
            expect(output(res).payload[0].mean).toBeCloseTo(expected.mean, 9);

            // No relearning: a gross outlier is caught on the first message after it
            expect(feed(second, { payload: { temp: 90 } }).out2).toBeDefined();

            await closeNode(second.node);
        });

        it("restores correlation and Mahalanobis history per group", async function () {
            const config = { mode: "correlate", sensor1: "x", sensor2: "y", persistState: true, groupBy: "topic" };
            const first = build(config, {});
            await settle();
            const rng = seededRandom(25);
            for (let i = 0; i < 40; i++) {
                const x = rng.gauss();
                feed(first, { topic: "m1", payload: { x: x, y: x } });
                feed(first, { topic: "m2", payload: { x: x, y: -x } });
            }
            await closeNode(first.node);
            expect(Object.keys(first.store.multiValueProcessorState.groups).sort()).toEqual(["m1", "m2"]);

            const second = build(config, first.store);
            await settle();
            expect(second.node.groups.get("m1").correlationBuffer1.length).toBe(40);
            // Straight to a result — no "Buffering" phase
            const res = feed(second, { topic: "m2", payload: { x: 0.3, y: -0.3 } });
            expect(res.out1.correlation).toBeCloseTo(-1, 6);
            expect(res.out1.stats.bufferSize).toBe(41);
            await closeNode(second.node);

            const mahal = { mode: "analyze", anomalyMethod: "mahalanobis", persistState: true };
            const third = build(mahal, {});
            await settle();
            for (let i = 0; i < 30; i++) feed(third, { payload: { a: rng.gauss(), b: rng.gauss() } });
            await closeNode(third.node);

            const fourth = build(mahal, third.store);
            await settle();
            expect(fourth.node.mahalanobisBuffer.length).toBe(30);
            const scored = output(feed(fourth, { payload: { a: 0, b: 0 } })).payload[0];
            expect(scored.severity).toBe("normal");
            expect(feed(fourth, { payload: { a: 500, b: -500 } }).out2.payload[0].severity).toBe("critical");
            await closeNode(fourth.node);
        });

        it("persists a reset", async function () {
            const first = build({ mode: "analyze", persistState: true }, {});
            await settle();
            for (let i = 0; i < 15; i++) feed(first, { payload: [i] });
            feed(first, { reset: true });
            await closeNode(first.node);

            expect(first.store.multiValueProcessorState.groups).toEqual({});
        });

        it("ignores damaged entries instead of failing the restore", async function () {
            const stub = build(
                { mode: "analyze", persistState: true, windowSize: 5 },
                {
                    multiValueProcessorState: {
                        version: 2,
                        groups: {
                            "": {
                                dataBuffers: {
                                    ok: [1, 2, 3, 4, 5, 6, 7].map(function (v) {
                                        return { timestamp: v, value: v };
                                    }),
                                    bad: [{ timestamp: 1, value: null }, "junk"]
                                },
                                correlationBuffer1: [1, 2, 3],
                                correlationBuffer2: [1, 2],
                                mahalanobisBuffer: "nope"
                            }
                        }
                    }
                }
            );
            await settle();

            expect(stub.warnings).toEqual([]);
            // Trimmed to the configured window, newest kept; the old
            // `{timestamp, value}` layout is still read
            expect(stub.node.dataBuffers.ok.toArray()).toEqual([3, 4, 5, 6, 7]);
            expect(stub.node.dataBuffers.bad).toBeUndefined();
            expect(stub.node.correlationBuffer1).toEqual([]); // unpaired buffers are dropped
            expect(stub.node.mahalanobisBuffer).toEqual([]);

            await closeNode(stub.node);
        });
    });

    describe("input parsing (utils/sensor-value)", function () {
        const warnedTimestamp = 'Ignoring non-numeric field(s) "timestamp" (text or timestamp, not a sensor value)';

        it("does not monitor an ISO timestamp field as a sensor, and says so once", function () {
            const stub = build({ mode: "analyze", windowSize: 10 });
            let msg;
            for (let i = 0; i < 3; i++) {
                msg = output(feed(stub, { payload: { temp: 25 + i, timestamp: "2024-05-01T12:00:0" + i + "Z" } }));
            }

            expect(
                msg.payload.map(function (r) {
                    return r.valueName;
                })
            ).toEqual(["temp"]);
            expect(msg.skippedValues).toEqual(["timestamp"]);
            expect(Object.keys(stub.node.dataBuffers)).toEqual(["temp"]);
            expect(stub.warnings).toEqual([warnedTimestamp]);
        });

        it("rejects text with a numeric prefix in arrays and objects", function () {
            const stub = build({ mode: "analyze" });
            const arr = output(feed(stub, { payload: [10, "123abc", "7"] }));
            expect(
                arr.payload.map(function (r) {
                    return [r.valueName, r.value];
                })
            ).toEqual([
                ["value0", 10],
                ["value2", 7]
            ]);
            expect(arr.skippedValues).toEqual(["value1"]);

            const obj = output(feed(stub, { payload: { a: "65 °C", b: 3, deviceId: "pump-7" } }));
            expect(
                obj.payload.map(function (r) {
                    return r.valueName;
                })
            ).toEqual(["b"]);
            expect(obj.skippedValues).toEqual(["a", "deviceId"]);
            // Only the field that used to parse as a number is worth a warning
            expect(stub.warnings).toEqual([
                'Ignoring non-numeric field(s) "a" (text or timestamp, not a sensor value)'
            ]);
        });

        it("applies the same rule in correlate, aggregate and split", function () {
            const corr = build({ mode: "correlate", sensor1: "x", sensor2: "y" });
            feed(corr, { payload: { x: "1abc", y: 2 } });
            expect(corr.warnings).toEqual(["Missing or invalid sensor values: x, y"]);

            const agg = build({ mode: "aggregate", aggregateMethod: "sum" });
            expect(output(feed(agg, { payload: { a: 1, b: "2", ts: "2024-05-01", c: "3x" } })).payload).toBe(3);
            expect(agg.warnings.length).toBe(1);

            const split = build({ mode: "split", outputMode: "parallel" });
            const res = feed(split, { payload: { a: 1, ts: "2024-05-01T00:00:00Z", b: "2" } });
            expect(res.out1.payload).toEqual([1, 2]);
            expect(res.out1.valueNames).toEqual(["a", "b"]);

            const scalar = build({ mode: "split" });
            expect(feed(scalar, { payload: "12abc" }).all).toEqual([]);
            expect(scalar.errors).toEqual(["No valid numeric values found"]);
            expect(feed(scalar, { payload: "12" }).all[0][0].payload).toBe(12);
        });
    });

    describe("split: sequential clone", function () {
        it("keeps the per-element message shape of earlier releases", function () {
            const stub = build({ mode: "split", outputMode: "sequential" });
            const meta = { site: "A", tags: [1, 2] };
            const res = feed(stub, { payload: [5, 6], topic: "t", _msgid: "m1", meta: meta });

            expect(res.all.length).toBe(2);
            expect(res.all[0][0]).toEqual({
                topic: "t",
                _msgid: "m1",
                meta: meta,
                payload: 5,
                valueIndex: 0,
                valueName: "value0",
                totalValues: 2
            });
            expect(res.all[1][0]).toEqual({
                topic: "t",
                _msgid: "m1",
                meta: meta,
                payload: 6,
                valueIndex: 1,
                valueName: "value1",
                totalValues: 2
            });
            expect(res.all[1][1]).toBeNull();
            // Cloned, not the inbound object
            expect(res.all[0][0].meta).not.toBe(meta);

            const bare = build({ mode: "split", outputMode: "sequential", preserveOriginal: false });
            const r2 = feed(bare, { payload: { a: 1 }, topic: "t" });
            expect(r2.all[0][0]).toEqual({ payload: 1, valueIndex: 0, valueName: "a", totalValues: 1 });
        });

        it("splits a 5000-element array in well under 50 ms with preserveOriginal", function () {
            // Deep-cloning the whole message per element took ~400 ms here
            const stub = build({ mode: "split", outputMode: "sequential", preserveOriginal: true });
            const arr = Array.from({ length: 5000 }, function (_, i) {
                return i;
            });
            feed(stub, { payload: [1, 2], topic: "warm" });

            const t0 = process.hrtime.bigint();
            const res = feed(stub, { payload: arr, topic: "x", meta: { site: "A" } });
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;

            expect(res.all.length).toBe(5000);
            expect(res.all[4999][0].payload).toBe(4999);
            expect(res.all[4999][0].valueIndex).toBe(4999);
            expect(res.all[4999][0].totalValues).toBe(5000);
            expect(res.all[4999][0].topic).toBe("x");
            expect(res.all[4999][0].meta).toEqual({ site: "A" });
            expect(ms).toBeLessThan(50);
        });
    });

    describe("outputTopic", function () {
        const topic = "alarms";

        it("is applied in every mode, not only aggregate", function () {
            const split = build({ mode: "split", outputMode: "sequential", outputTopic: topic });
            expect(
                feed(split, { payload: [1, 2], topic: "in" }).all.map(function (m) {
                    return m[0].topic;
                })
            ).toEqual([topic, topic]);
            const parallel = build({ mode: "split", outputMode: "parallel", outputTopic: topic });
            expect(feed(parallel, { payload: [1, 2], topic: "in" }).out1.topic).toBe(topic);

            const analyze = build({ mode: "analyze", windowSize: 10, outputTopic: topic });
            let res;
            for (let i = 0; i < 10; i++) res = feed(analyze, { payload: [10], topic: "in" });
            expect(res.out1.topic).toBe(topic);
            res = feed(analyze, { payload: [1000], topic: "in" });
            expect(res.out2.topic).toBe(topic);

            const corr = build({ mode: "correlate", sensor1: "x", sensor2: "y", outputTopic: topic });
            expect(feed(corr, { payload: { x: 1, y: 1 }, topic: "in" }).out1.topic).toBe(topic); // warm-up
            feed(corr, { payload: { x: 2, y: 2 }, topic: "in" });
            expect(feed(corr, { payload: { x: 3, y: 3 }, topic: "in" }).out1.topic).toBe(topic); // result
            const flat = build({ mode: "correlate", sensor1: "x", sensor2: "y", outputTopic: topic });
            let r;
            for (let i = 0; i < 3; i++) r = feed(flat, { payload: { x: 1, y: 1 }, topic: "in" });
            expect(r.out1.reason).toMatch(/zero variance/); // undefined correlation
            expect(r.out1.topic).toBe(topic);

            const agg = build({ mode: "aggregate", outputTopic: topic });
            expect(feed(agg, { payload: [1, 2], topic: "in" }).out1.topic).toBe(topic);
        });

        it("keeps the inbound topic when empty", function () {
            const analyze = build({ mode: "analyze" });
            expect(feed(analyze, { payload: [1], topic: "in" }).out1.topic).toBe("in");
            const corr = build({ mode: "correlate", sensor1: "x", sensor2: "y" });
            expect(feed(corr, { payload: { x: 1, y: 1 }, topic: "in" }).out1.topic).toBe("in");
            const split = build({ mode: "split" });
            expect(feed(split, { payload: [1], topic: "in" }).all[0][0].topic).toBe("in");
        });
    });

    describe("correlate: warm-up", function () {
        it("emits a result object for the first two messages instead of nothing", function () {
            const stub = build({ mode: "correlate", sensor1: "x", sensor2: "y", windowSize: 20 });

            const first = feed(stub, { payload: { x: 1, y: 2 }, topic: "t", deviceId: "d1" });
            expect(first.out2).toBeUndefined();
            expect(first.out1).toEqual({
                payload: { x: 1, y: 2 },
                correlation: null,
                isAnomalous: false,
                severity: "warmup",
                bufferSize: 1,
                minRequired: 3,
                sensor1: "x",
                sensor2: "y",
                method: "pearson",
                stats: { sensor1Mean: 1, sensor2Mean: 2, bufferSize: 1 },
                topic: "t",
                deviceId: "d1"
            });
            expect(stub.statuses[stub.statuses.length - 1].text).toBe("Buffering: 1/20");

            const second = feed(stub, { payload: { x: 2, y: 4 } });
            expect(second.out1.severity).toBe("warmup");
            expect(second.out1.bufferSize).toBe(2);

            const third = feed(stub, { payload: { x: 3, y: 6 } });
            expect(third.out1.severity).toBeUndefined();
            expect(third.out1.correlation).toBeCloseTo(1, 10);
        });
    });

    describe("analyze: streaming covariance (Mahalanobis)", function () {
        // Reference: two-pass sample covariance of the complete rows
        function batchCovariance(buffer, names) {
            const rows = [];
            buffer.forEach(function (sample) {
                const row = names.map(function (n) {
                    return sample[n];
                });
                if (row.every(Number.isFinite)) rows.push(row);
            });
            const m = rows.length;
            const p = names.length;
            const means = new Array(p).fill(0);
            rows.forEach(function (row) {
                for (let i = 0; i < p; i++) means[i] += row[i] / m;
            });
            const cov = [];
            for (let i = 0; i < p; i++) cov.push(new Array(p).fill(0));
            rows.forEach(function (row) {
                for (let i = 0; i < p; i++) {
                    for (let j = 0; j < p; j++) cov[i][j] += ((row[i] - means[i]) * (row[j] - means[j])) / (m - 1);
                }
            });
            return { count: m, means: means, covariance: cov };
        }

        function expectAccumulatorMatches(stub, names, relTol) {
            const state = stub.node.groups.get("");
            const acc = state.mahalanobisCov;
            const ref = batchCovariance(state.mahalanobisBuffer, names);
            expect(acc.names).toEqual(names);
            expect(acc.running.count()).toBe(ref.count);
            const cov = acc.running.covariance();
            const means = acc.running.means();
            for (let i = 0; i < names.length; i++) {
                expect(Math.abs(means[i] - ref.means[i])).toBeLessThanOrEqual(
                    relTol * Math.max(1, Math.abs(ref.means[i]))
                );
                for (let j = 0; j < names.length; j++) {
                    expect(Math.abs(cov[i][j] - ref.covariance[i][j])).toBeLessThanOrEqual(
                        relTol * Math.max(1, Math.abs(ref.covariance[i][j]))
                    );
                }
            }
        }

        it("equals the batch covariance of the history to 1e-9 after every message, through turnovers and a level shift", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 40 });
            const rng = seededRandom(30);
            let compared = 0;
            for (let i = 0; i < 600; i++) {
                const x = rng.gauss();
                const shift = i >= 300 ? 50 : 0;
                feed(stub, { payload: { a: x + shift, b: 2 * x + 0.1 * rng.gauss(), c: rng.gauss() } });
                if (!stub.node.groups.get("").mahalanobisCov) continue; // not consulted before 10 samples
                expectAccumulatorMatches(stub, ["a", "b", "c"], 1e-9);
                compared++;
            }
            expect(compared).toBeGreaterThan(580);
            expect(stub.errors).toEqual([]);
        });

        it("scores exactly as the batch formula did (distance and limits unchanged)", function () {
            // The per-message numbers must not move: same seeded data as the
            // Mahalanobis false-alarm test, compared against a node that is
            // forced onto the exact path by a reset of the accumulator each time.
            const streaming = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 30 });
            const exact = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 30 });
            const rng = seededRandom(32);
            for (let i = 0; i < 300; i++) {
                const payload = [rng.gauss(), 5 + 2 * rng.gauss(), -3 + rng.gauss()];
                const a = output(feed(streaming, { payload: payload })).payload[0];
                const state = exact.node.groups.get("");
                if (state) state.mahalanobisCov = null; // rebuilt from the buffer: the two-pass result
                const b = output(feed(exact, { payload: payload })).payload[0];
                expect(a.severity).toBe(b.severity);
                if (a.mahalanobisDistance !== undefined) {
                    expect(a.mahalanobisDistance).toBeCloseTo(b.mahalanobisDistance, 9);
                    expect(a.mahalanobisThreshold).toBe(b.mahalanobisThreshold);
                }
            }
        });

        it("falls back to the exact covariance when the spread is tiny next to the level", function () {
            const stub = build({ mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 20 });
            const rng = seededRandom(31);
            let distances = 0;
            for (let i = 0; i < 60; i++) {
                const r = output(feed(stub, { payload: [1e9 + 0.01 * rng.gauss(), 1e9 + 0.01 * rng.gauss()] }))
                    .payload[0];
                if (r.mahalanobisDistance !== undefined) {
                    expect(Number.isFinite(r.mahalanobisDistance)).toBe(true);
                    distances++;
                }
            }
            expect(distances).toBe(50);
            expect(stub.errors).toEqual([]);
        });

        it("starts a fresh accumulator after a reset and after a restore", async function () {
            const stub = build(
                { mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 30, persistState: true },
                {}
            );
            await settle();
            const rng = seededRandom(33);
            for (let i = 0; i < 25; i++) feed(stub, { payload: { a: rng.gauss(), b: rng.gauss() } });
            expect(stub.node.groups.get("").mahalanobisCov.running.count()).toBe(25);

            feed(stub, { reset: true });
            expect(stub.node.groups.get("")).toBeUndefined();
            for (let i = 0; i < 12; i++) feed(stub, { payload: { a: rng.gauss(), b: rng.gauss() } });
            expectAccumulatorMatches(stub, ["a", "b"], 1e-9);
            expect(stub.node.groups.get("").mahalanobisCov.running.count()).toBe(12);
            await closeNode(stub.node);

            const restored = build(
                { mode: "analyze", anomalyMethod: "mahalanobis", windowSize: 30, persistState: true },
                stub.store
            );
            await settle();
            expect(restored.node.mahalanobisBuffer.length).toBe(12);
            expect(restored.node.groups.get("").mahalanobisCov).toBeNull();
            feed(restored, { payload: { a: 0, b: 0 } });
            expectAccumulatorMatches(restored, ["a", "b"], 1e-9);
            expect(restored.node.groups.get("").mahalanobisCov.running.count()).toBe(13);
            await closeNode(restored.node);
        });
    });
});
