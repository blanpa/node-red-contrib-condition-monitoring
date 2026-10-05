/**
 * isolation-forest-anomaly: forest construction, threshold calibration,
 * retraining, per-group state and persistence.
 *
 * The forest itself is randomised (tree splits and subsamples), so input data
 * is seeded and assertions are either structural or leave a wide margin.
 */
const isolationForestNode = require("../nodes/isolation-forest-anomaly.js");
const { buildStubbedNode, feed, output, closeNode, settle, seededRandom } = require("./stub-runtime");

function build(config, seeded) {
    return buildStubbedNode(isolationForestNode, Object.assign({ id: "n1" }, config), seeded);
}

function feedNoise(stub, rng, count, extra) {
    const results = [];
    for (let i = 0; i < count; i++) {
        results.push(output(feed(stub, Object.assign({ payload: rng.gauss() }, extra))));
    }
    return results;
}

describe("isolation-forest-anomaly hardening", function () {
    describe("debug logging", function () {
        it("trains the forest with debug enabled instead of silently falling back to z-score", function () {
            const stub = build({ debug: true });
            const results = feedNoise(stub, seededRandom(1), 60);

            expect(stub.errors).toEqual([]);
            expect(typeof stub.node.debug).toBe("function");
            expect(stub.node.isTrained).toBe(true);
            expect(results[59].method).toBe("isolation-forest");
            expect(
                stub.debugLines.some(function (l) {
                    return l.indexOf("Training Isolation Forest") === 0;
                })
            ).toBe(true);
        });
    });

    describe("forest construction", function () {
        it("honours numEstimators and maxSamples", function () {
            const stub = build({ numEstimators: 7, maxSamples: 16, windowSize: 100 });
            feedNoise(stub, seededRandom(2), 120);

            expect(stub.node.model.trees.length).toBe(7);
            expect(stub.node.model.subsampleSize).toBe(16);
        });

        it("caps the subsample at the amount of data available", function () {
            const stub = build({ maxSamples: 256, windowSize: 50 });
            feedNoise(stub, seededRandom(3), 60);

            expect(stub.node.model.subsampleSize).toBe(50);
        });

        it("treats an unknown learning mode as incremental, a missing one as batch", function () {
            expect(build({ learningMode: "online" }).node.learningMode).toBe("incremental");
            expect(build({}).node.learningMode).toBe("batch");
        });
    });

    describe("threshold", function () {
        it("does not flag a flat signal", function () {
            const stub = build({ windowSize: 50 });
            let anomalies = 0;
            for (let i = 0; i < 300; i++) {
                if (output(feed(stub, { payload: 5 })).isAnomaly) anomalies++;
            }

            expect(anomalies).toBe(0);
        });

        it("flags the first departure from a flat signal", function () {
            const stub = build({ windowSize: 50 });
            for (let i = 0; i < 100; i++) feed(stub, { payload: 5 });

            const res = feed(stub, { payload: 9 });

            expect(res.out2).toBeDefined();
            expect(res.out2.isAnomaly).toBe(true);
        });

        it("flags a value far outside a tight, drifting training cluster", function () {
            // The case from examples/test-suite.json: the forest is fitted on the
            // first ten samples, and 500 follows the same branches as the largest
            // of them — without the out-of-range rule it only ties the threshold.
            const stub = build({ contamination: 0.1, windowSize: 100, numEstimators: 100, learningMode: "batch" });
            for (let i = 0; i < 40; i++) feed(stub, { payload: 50 + i * 0.01 });
            const result = output(feed(stub, { payload: 500 }));
            expect(result.method).toBe("isolation-forest");
            expect(result.isAnomaly).toBe(true);
            expect(result.payload).toBe(500);
        });

        it("never puts the threshold below 0.5 and keeps it fixed between fits", function () {
            const stub = build({ windowSize: 100, learningMode: "batch" });
            const results = feedNoise(stub, seededRandom(4), 199);

            // Fits happen at sample 10 and again at sample 100
            const between = results.slice(100, 199).map(function (m) {
                return m.threshold;
            });
            expect(new Set(between).size).toBe(1);
            results.slice(10).forEach(function (m) {
                expect(m.threshold).toBeGreaterThanOrEqual(0.5);
                expect(m.isAnomaly).toBe(m.anomalyScore > m.threshold);
            });
        });

        it("flags far fewer samples at a low contamination setting", function () {
            const rate = function (contamination) {
                const stub = build({ windowSize: 200, contamination: contamination });
                const results = feedNoise(stub, seededRandom(5), 1200).slice(200);
                return (
                    results.filter(function (m) {
                        return m.isAnomaly;
                    }).length / results.length
                );
            };

            const low = rate(0.01);
            const high = rate(0.3);
            expect(low).toBeLessThan(0.08);
            expect(high).toBeGreaterThan(0.15);
            expect(high).toBeLessThan(0.5);
        });

        it("detects a gross outlier in noisy data", function () {
            const stub = build({ windowSize: 200 });
            feedNoise(stub, seededRandom(6), 400);

            const res = feed(stub, { payload: 1000 });

            expect(res.out2).toBeDefined();
            expect(res.out2.anomalyScore).toBeGreaterThan(res.out2.threshold);
        });

        it("lets the threshold follow recent scores in adaptive mode only", function () {
            const adaptive = build({ windowSize: 100, learningMode: "adaptive", retrainInterval: 1000 });
            const results = feedNoise(adaptive, seededRandom(7), 199).slice(100);
            const thresholds = new Set(
                results.map(function (m) {
                    return m.threshold;
                })
            );

            expect(thresholds.size).toBeGreaterThan(1);
            expect(adaptive.node.scoreBuffer.length).toBeGreaterThan(0);

            const batch = build({ windowSize: 100, learningMode: "batch" });
            feedNoise(batch, seededRandom(7), 199);
            expect(batch.node.scoreBuffer.length).toBe(0);
        });
    });

    describe("retraining", function () {
        it("refits when the window is first full and then once per window in batch mode", function () {
            const stub = build({ windowSize: 100, learningMode: "batch" });
            const results = feedNoise(stub, seededRandom(8), 350);

            expect(results[98].lastRetrain).toBe(10);
            expect(results[99].lastRetrain).toBe(100);
            expect(results[198].lastRetrain).toBe(100);
            expect(results[199].lastRetrain).toBe(200);
            expect(results[349].lastRetrain).toBe(300);
        });

        it("refits every retrainInterval samples in incremental mode", function () {
            const stub = build({ windowSize: 100, learningMode: "incremental", retrainInterval: 25 });
            const results = feedNoise(stub, seededRandom(9), 90);

            expect(results[33].lastRetrain).toBe(10);
            expect(results[34].lastRetrain).toBe(35);
            expect(results[59].lastRetrain).toBe(60);
        });
    });

    describe("message handling", function () {
        it("keeps topic and extra properties on the z-score fallback output", function () {
            const stub = build({});
            feed(stub, { payload: 1, topic: "t" });
            const res = feed(stub, { payload: 2, topic: "t", deviceId: "d1" });

            expect(output(res).method).toBe("fallback-zscore");
            expect(output(res).topic).toBe("t");
            expect(output(res).deviceId).toBe("d1");
        });

        it("does not let an incoming property overwrite a computed field", function () {
            const stub = build({ windowSize: 50 });
            feedNoise(stub, seededRandom(10), 60);

            const msg = output(feed(stub, { payload: 0.1, threshold: "from-upstream", sampleCount: -1 }));

            expect(typeof msg.threshold).toBe("number");
            expect(msg.sampleCount).toBe(61);
        });

        it("clears its state on msg.reset", function () {
            const stub = build({ windowSize: 50 });
            feedNoise(stub, seededRandom(11), 60);
            expect(stub.node.isTrained).toBe(true);

            const res = feed(stub, { reset: true });

            expect(res.all).toEqual([]);
            expect(stub.node.isTrained).toBe(false);
            expect(stub.node.dataBuffer.length).toBe(0);
        });
    });

    describe("per-group forests", function () {
        it("keeps one independent buffer and forest per group value", function () {
            const stub = build({ windowSize: 100, groupBy: "topic" });
            const rng = seededRandom(12);

            for (let i = 0; i < 150; i++) {
                feed(stub, { topic: "cold", payload: 10 + rng.gauss() });
                feed(stub, { topic: "hot", payload: 900 + rng.gauss() });
            }

            expect(Array.from(stub.node.groups.keys())).toEqual(["cold", "hot"]);
            expect(stub.node.groups.get("cold").dataBuffer.length).toBe(100);

            // 900 is ordinary for "hot" and far out for "cold"
            const foreign = feed(stub, { topic: "cold", payload: 900 });
            expect(foreign.out2).toBeDefined();
            expect(foreign.out2.group).toBe("cold");
            expect(stub.node.groups.get("hot").dataBuffer.length).toBe(100);
        });

        it("evicts the least recently used group beyond maxGroups", function () {
            const stub = build({ groupBy: "topic", maxGroups: 2 });
            ["a", "b", "a", "c"].forEach(function (topic) {
                feed(stub, { topic: topic, payload: 1 });
            });

            expect(Array.from(stub.node.groups.keys())).toEqual(["a", "c"]);
        });

        it("mixes all topics into one buffer when groupBy is empty (legacy behaviour)", function () {
            const stub = build({});
            feed(stub, { topic: "a", payload: 1 });
            feed(stub, { topic: "b", payload: 2 });

            expect(stub.node.dataBuffer.length).toBe(2);
        });
    });

    describe("state persistence", function () {
        function v1State(count) {
            const rng = seededRandom(13);
            const dataBuffer = [];
            for (let i = 0; i < count; i++) {
                dataBuffer.push({ timestamp: 1000 + i, value: rng.gauss() });
            }
            return {
                dataBuffer: dataBuffer,
                scoreBuffer: [],
                anomalyThreshold: 0.6,
                sampleCount: count,
                lastRetrainCount: 10,
                isTrained: true
            };
        }

        it("restores the buffer and rebuilds the forest, with debug enabled", async function () {
            const stub = build(
                { windowSize: 50, persistState: true, debug: true },
                { isolationForestState: v1State(50) }
            );
            await settle();

            expect(stub.warnings).toEqual([]);
            expect(stub.errors).toEqual([]);
            expect(stub.node.dataBuffer.length).toBe(50);
            expect(stub.node.sampleCount).toBe(50);
            expect(stub.node.isTrained).toBe(true);
            expect(
                stub.debugLines.some(function (l) {
                    return l.indexOf("[Persistence] Loaded state") === 0;
                })
            ).toBe(true);

            // Scored by the forest straight away — no second warm-up
            expect(output(feed(stub, { payload: 0.2 })).method).toBe("isolation-forest");

            await closeNode(stub.node);

            // Saved back per group, with the stale flat keys dropped
            const saved = stub.store.isolationForestState;
            expect(saved.version).toBe(2);
            expect(saved.groups[""].dataBuffer.length).toBe(50);
            expect(saved.dataBuffer).toBeUndefined();
        });

        it("saves and restores one buffer per group", async function () {
            const first = build({ windowSize: 50, persistState: true, groupBy: "topic" }, {});
            await settle();
            const rng = seededRandom(14);
            for (let i = 0; i < 30; i++) {
                feed(first, { topic: "pump-01", payload: rng.gauss() });
                feed(first, { topic: "pump-02", payload: 100 + rng.gauss() });
            }
            await closeNode(first.node);

            expect(Object.keys(first.store.isolationForestState.groups).sort()).toEqual(["pump-01", "pump-02"]);

            const second = build({ windowSize: 50, persistState: true, groupBy: "topic" }, first.store);
            await settle();

            expect(second.node.groups.get("pump-01").dataBuffer.length).toBe(30);
            expect(second.node.groups.get("pump-02").isTrained).toBe(true);
            expect(second.node.groups.get("pump-02").dataBuffer[0].value).toBeGreaterThan(90);

            await closeNode(second.node);
        });
    });
});
