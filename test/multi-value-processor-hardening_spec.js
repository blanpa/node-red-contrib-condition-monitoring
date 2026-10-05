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
            feed(stub, { payload: JSON.parse('{"constructor":1,"toString":2,"__proto__":3}') });
            const msg = output(feed(stub, { payload: JSON.parse('{"constructor":1,"toString":2,"__proto__":3}') }));

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
                    if (r.severity !== undefined) {
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
        // the window. It must agree with the reference definition
        // (stats.calculateZScore over the window) on every sample.
        function expectMatchesReference(windowSize, values, relTol) {
            const stub = build({ mode: "analyze", windowSize: windowSize });
            const window = [];
            let compared = 0;

            values.forEach(function (value) {
                window.push(value);
                if (window.length > windowSize) window.shift();

                const res = feed(stub, { payload: [value] });
                const result = output(res).payload[0];
                if (window.length < 2) {
                    expect(result.zScore).toBeUndefined();
                    return;
                }

                const reference = stats.calculateZScore(value, window);
                const scale = Math.max(1, Math.abs(reference.mean));
                expect(Math.abs(result.mean - reference.mean)).toBeLessThanOrEqual(relTol * scale);
                expect(Math.abs(result.stdDev - reference.stdDev)).toBeLessThanOrEqual(
                    relTol * Math.max(reference.stdDev, 1e-12)
                );
                expect(Math.abs(result.zScore - reference.zScore)).toBeLessThanOrEqual(
                    relTol * Math.max(1, Math.abs(reference.zScore))
                );
                // Same routing decision
                expect(result.isAnomaly).toBe(Math.abs(reference.zScore) > 3);
                expect(Boolean(res.out2)).toBe(Math.abs(reference.zScore) > 3);
                compared++;
            });
            return compared;
        }

        it("matches the reference on noisy data with outliers, across many window turnovers", function () {
            const rng = seededRandom(20);
            const values = [];
            for (let i = 0; i < 3000; i++) {
                values.push(20 + rng.gauss() + (i % 97 === 96 ? 15 : 0));
            }

            expect(expectMatchesReference(50, values, 1e-9)).toBe(2999);
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
                const window = state.dataBuffers[name].map(function (d) {
                    return d.value;
                });
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
            const first = build({ mode: "analyze", windowSize: 30, persistState: true }, {});
            await settle();
            const rng = seededRandom(24);
            for (let i = 0; i < 30; i++) feed(first, { payload: { temp: 60 + 0.5 * rng.gauss() } });
            const reference = output(feed(first, { payload: { temp: 60.2 } })).payload[0];
            await closeNode(first.node);

            const saved = first.store.multiValueProcessorState;
            expect(saved.version).toBe(2);
            expect(saved.groups[""].dataBuffers.temp.length).toBe(30);

            // Drop the last sample so the restarted node sees the same history
            saved.groups[""].dataBuffers.temp.pop();
            const second = build({ mode: "analyze", windowSize: 30, persistState: true, debug: true }, first.store);
            await settle();

            expect(second.warnings).toEqual([]);
            expect(second.node.dataBuffers.temp.length).toBe(29);
            expect(
                second.debugLines.some(function (l) {
                    return l.indexOf("Restored 29 buffered samples") === 0;
                })
            ).toBe(true);

            const res = feed(second, { payload: { temp: 60.2 } });
            expect(output(res).payload[0].zScore).toBeCloseTo(reference.zScore, 9);
            expect(output(res).payload[0].mean).toBeCloseTo(reference.mean, 9);

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
            // Trimmed to the configured window, newest kept
            expect(
                stub.node.dataBuffers.ok.map(function (d) {
                    return d.value;
                })
            ).toEqual([3, 4, 5, 6, 7]);
            expect(stub.node.dataBuffers.bad).toBeUndefined();
            expect(stub.node.correlationBuffer1).toEqual([]); // unpaired buffers are dropped
            expect(stub.node.mahalanobisBuffer).toEqual([]);

            await closeNode(stub.node);
        });
    });
});
