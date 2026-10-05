/**
 * pca-anomaly: numerical correctness, feature alignment, retraining,
 * per-group models and persistence. Driven through the synchronous RED stub
 * with seeded data, so every assertion is deterministic.
 */
const pcaAnomalyNode = require("../nodes/pca-anomaly.js");
const stats = require("../nodes/utils/statistics");
const { buildStubbedNode, feed, output, closeNode, settle, seededRandom } = require("./stub-runtime");

function build(config, seeded) {
    return buildStubbedNode(pcaAnomalyNode, Object.assign({ id: "n1" }, config), seeded);
}

// Four sensors driven by two latent factors: a ≈ b, d ≈ c - a.
function correlatedSample(rng) {
    const x = rng.gauss();
    const y = rng.gauss();
    return { a: x, b: x + 0.3 * rng.gauss(), c: y, d: y - x + 0.2 * rng.gauss() };
}

function train(stub, rng, count, extra) {
    let last;
    for (let i = 0; i < count; i++) {
        last = feed(stub, Object.assign({ payload: correlatedSample(rng) }, extra));
    }
    return last;
}

describe("pca-anomaly hardening", function () {
    describe("debug logging", function () {
        it("trains and scores with debug enabled (node.debug stays a function)", function () {
            const stub = build({ windowSize: 40, debug: true });
            const rng = seededRandom(1);

            const last = train(stub, rng, 60);

            expect(stub.errors).toEqual([]);
            expect(typeof stub.node.debug).toBe("function");
            expect(stub.node.debugEnabled).toBe(true);
            expect(output(last)).toHaveProperty("pca");
            expect(
                stub.debugLines.some(function (l) {
                    return l.indexOf("PCA trained on") === 0;
                })
            ).toBe(true);
        });
    });

    describe("SPE / reconstruction", function () {
        it("reconstructs exactly when every component is kept (SPE = 0)", function () {
            const stub = build({ windowSize: 60, method: "spe", autoComponents: false, nComponents: 3 });
            const rng = seededRandom(2);
            let scored = 0;

            for (let i = 0; i < 200; i++) {
                const x = rng.gauss();
                const res = feed(stub, { payload: [x, 2 * x + 0.3 * rng.gauss(), rng.gauss() + 0.5 * x] });
                const msg = output(res);
                if (msg.pca) {
                    scored++;
                    expect(msg.pca.nComponents).toBe(3);
                    expect(msg.pca.spe).toBeLessThan(1e-20);
                    expect(msg.isAnomaly).toBe(false);
                    msg.contributions &&
                        msg.contributions.forEach(function (c) {
                            expect(Math.abs(c.reconstructedValue - c.originalValue)).toBeLessThan(1e-9);
                        });
                }
            }
            expect(scored).toBeGreaterThan(100);
        });

        it("flags a broken sensor relationship through SPE and names the sensor", function () {
            const stub = build({ windowSize: 100, method: "spe" });
            const rng = seededRandom(3);
            train(stub, rng, 300);

            // b normally tracks a; here it runs the other way
            const res = feed(stub, { payload: { a: 1.5, b: -1.5, c: 0.2, d: -1.3 } });

            expect(res.out2).toBeDefined();
            expect(res.out2.pca.speAnomaly).toBe(true);
            expect(["a", "b"]).toContain(res.out2.topContributor);
        });
    });

    describe("feature alignment", function () {
        function trained() {
            const stub = build({ windowSize: 40, method: "combined" });
            const rng = seededRandom(4);
            for (let i = 0; i < 60; i++) {
                const x = rng.gauss();
                feed(stub, { payload: { temp: 50 + x, pressure: 1000 + 10 * x + rng.gauss() } });
            }
            return stub;
        }

        it("matches values by name, whatever the key order", function () {
            const stub = trained();
            const ordered = output(feed(stub, { payload: { temp: 50.4, pressure: 1003 } }));
            const swapped = output(feed(stub, { payload: { pressure: 1003, temp: 50.4 } }));

            expect(swapped.isAnomaly).toBe(false);
            expect(swapped.pca.t2).toBeCloseTo(ordered.pca.t2, 10);
            expect(swapped.sensorNames).toEqual(["temp", "pressure"]);
        });

        it("ignores extra keys", function () {
            const stub = trained();
            const res = feed(stub, { payload: { temp: 50.4, pressure: 1003, rpm: 1480 } });

            expect(res.error).toBeUndefined();
            expect(output(res).pca).toBeDefined();
            expect(output(res).isAnomaly).toBe(false);
        });

        it("skips a sample that lacks a trained feature instead of misaligning it", function () {
            const stub = trained();
            const res = feed(stub, { payload: { temp: 50.4, pressure: "n/a" } });

            expect(res.all).toEqual([]);
            expect(res.error).toMatch(/pressure/);
        });

        it("does not shift array columns when an entry is not finite", function () {
            const stub = build({ windowSize: 40 });
            const rng = seededRandom(5);
            for (let i = 0; i < 60; i++) {
                const x = rng.gauss();
                feed(stub, { payload: [x, 100 + x, 5 * rng.gauss()] });
            }

            // Previously [NaN, 100, 0] was filtered to [100, 0] and scored as
            // sensor0 = 100, sensor1 = 0.
            const res = feed(stub, { payload: [NaN, 100, 0] });

            expect(res.all).toEqual([]);
            expect(res.error).toMatch(/sensor0/);
        });
    });

    describe("control limits", function () {
        it("derives the T² limit from the threshold, components and training size", function () {
            const limits = [2, 3, 5].map(function (threshold) {
                const stub = build({ windowSize: 100, threshold: threshold });
                train(stub, seededRandom(6), 130);
                const state = stub.node.groups.get("");
                expect(state.trainedOn).toBe(100);
                expect(state.t2Threshold).toBeCloseTo(stats.hotellingLimitFromZ(state.nComponents, 100, threshold), 10);
                return state.t2Threshold;
            });

            // The old empirical percentile gave the training maximum for any
            // threshold above ~2.3, i.e. the setting had no effect.
            expect(limits[1]).toBeGreaterThan(limits[0] * 1.3);
            expect(limits[2]).toBeGreaterThan(limits[1] * 1.5);
        });

        it("keeps the false-alarm rate on stationary data low", function () {
            const stub = build({ windowSize: 200, method: "combined" });
            const rng = seededRandom(7);
            let scored = 0;
            let alarms = 0;

            for (let i = 0; i < 4000; i++) {
                const msg = output(feed(stub, { payload: correlatedSample(rng) }));
                if (msg.pca) {
                    scored++;
                    if (msg.isAnomaly) alarms++;
                }
            }

            expect(scored).toBeGreaterThan(3500);
            // 3-sigma on two statistics: ~0.3% expected
            expect(alarms / scored).toBeLessThan(0.015);
        });

        it("does not raise SPE alarms from rounding noise when nothing is discarded", function () {
            // Three independent sensors at 95% variance keep all three
            // components: SPE is identically zero and must never alarm.
            const stub = build({ windowSize: 100, method: "spe" });
            const rng = seededRandom(8);
            let alarms = 0;

            for (let i = 0; i < 600; i++) {
                const msg = output(feed(stub, { payload: [rng.gauss(), rng.gauss(), rng.gauss()] }));
                if (msg.pca && msg.pca.nComponents === 3 && msg.isAnomaly) alarms++;
            }

            expect(alarms).toBe(0);
        });
    });

    describe("retraining", function () {
        function fits(stub) {
            return stub.debugLines.filter(function (l) {
                return l.indexOf("PCA trained on") === 0;
            });
        }

        it("fits on half a window, refits on the full window, then every window (retrainMode window)", function () {
            const stub = build({ windowSize: 100, debug: true });
            train(stub, seededRandom(9), 420);

            const lines = fits(stub);
            expect(lines[0]).toMatch(/^PCA trained on 50 samples/);
            expect(lines[1]).toMatch(/^PCA trained on 100 samples/);
            expect(lines.length).toBeGreaterThanOrEqual(4);
        });

        it("freezes the model after the full-window fit when retrainMode is off", function () {
            const stub = build({ windowSize: 100, debug: true, retrainMode: "off" });
            train(stub, seededRandom(9), 420);

            expect(fits(stub).length).toBe(2);
        });

        it("keeps anomalous samples out of the training window", function () {
            const stub = build({ windowSize: 100 });
            const rng = seededRandom(10);
            train(stub, rng, 150);

            const before = stub.node.groups.get("").dataBuffer.slice();
            for (let i = 0; i < 30; i++) {
                const res = feed(stub, { payload: { a: 40, b: -40, c: 40, d: 40 } });
                expect(res.out2).toBeDefined();
            }

            expect(stub.node.groups.get("").dataBuffer).toEqual(before);
        });

        it("trains even when the window is smaller than the 10-sample minimum", function () {
            const stub = build({ windowSize: 6 });
            const last = train(stub, seededRandom(11), 12);

            expect(output(last)).toHaveProperty("pca");
        });
    });

    describe("per-group models", function () {
        it("keeps one independent model per group value", function () {
            const stub = build({ windowSize: 40, groupBy: "topic" });
            const rng = seededRandom(12);

            for (let i = 0; i < 80; i++) {
                const x = rng.gauss();
                feed(stub, { topic: "pump-01", payload: { p: 10 + x, q: 20 + x + 0.1 * rng.gauss() } });
                feed(stub, { topic: "pump-02", payload: { p: 500 + 5 * x, q: -300 - 5 * x + rng.gauss() } });
            }

            expect(Array.from(stub.node.groups.keys())).toEqual(["pump-01", "pump-02"]);
            expect(stub.node.groups.get("pump-01").mean[0]).toBeCloseTo(10, 0);
            expect(stub.node.groups.get("pump-02").mean[0]).toBeCloseTo(500, -1);

            // Normal for pump-02, absurd for pump-01
            const own = feed(stub, { topic: "pump-02", payload: { p: 500, q: -300 } });
            const foreign = feed(stub, { topic: "pump-01", payload: { p: 500, q: -300 } });

            expect(own.out1).toBeDefined();
            expect(own.out1.group).toBe("pump-02");
            expect(foreign.out2).toBeDefined();
            expect(foreign.out2.group).toBe("pump-01");
        });

        it("evicts the least recently used group beyond maxGroups", function () {
            const stub = build({ windowSize: 40, groupBy: "topic", maxGroups: 2 });

            ["a", "b", "a", "c"].forEach(function (topic) {
                feed(stub, { topic: topic, payload: [1, 2] });
            });

            expect(Array.from(stub.node.groups.keys())).toEqual(["a", "c"]);
        });

        it("resets only the group a reset message names", function () {
            const stub = build({ windowSize: 40, groupBy: "topic" });
            feed(stub, { topic: "a", payload: [1, 2] });
            feed(stub, { topic: "b", payload: [1, 2] });

            feed(stub, { topic: "a", reset: true });
            expect(Array.from(stub.node.groups.keys())).toEqual(["b"]);

            feed(stub, { reset: true });
            expect(stub.node.groups.size).toBe(0);
        });

        it("shares one model when groupBy is empty (legacy behaviour)", function () {
            const stub = build({ windowSize: 40 });
            feed(stub, { topic: "a", payload: [1, 2] });
            feed(stub, { topic: "b", payload: [1, 2] });

            expect(Array.from(stub.node.groups.keys())).toEqual([""]);
            expect(stub.node.dataBuffer.length).toBe(2);
            expect(output(feed(stub, { topic: "a", payload: [1, 2] })).group).toBeUndefined();
        });
    });

    describe("state persistence", function () {
        async function trainedStore(config) {
            const stub = build(Object.assign({ windowSize: 40, persistState: true }, config));
            await settle();
            train(stub, seededRandom(13), 60, { topic: "pump-01" });
            const reference = output(feed(stub, { topic: "pump-01", payload: { a: 0.5, b: 0.4, c: -0.2, d: -0.8 } }));
            await closeNode(stub.node);
            return { store: stub.store, reference: reference };
        }

        it("restores a trained model, with debug enabled, and scores the next sample with it", async function () {
            const saved = await trainedStore({});
            expect(saved.store.pcaAnomalyState.version).toBe(2);

            const stub = build({ windowSize: 40, persistState: true, debug: true }, saved.store);
            await settle();

            expect(stub.warnings).toEqual([]);
            expect(stub.node.isTrained).toBe(true);
            expect(
                stub.debugLines.some(function (l) {
                    return l.indexOf("[Persistence] Loaded state") === 0;
                })
            ).toBe(true);

            const msg = output(feed(stub, { payload: { a: 0.5, b: 0.4, c: -0.2, d: -0.8 } }));
            expect(msg.pca.t2).toBeCloseTo(saved.reference.pca.t2, 8);
            expect(msg.pca.spe).toBeCloseTo(saved.reference.pca.spe, 8);
            expect(msg.pca.t2Threshold).toBeCloseTo(saved.reference.pca.t2Threshold, 8);

            await closeNode(stub.node);
        });

        it("restores one model per group", async function () {
            const saved = await trainedStore({ groupBy: "topic" });
            expect(Object.keys(saved.store.pcaAnomalyState.groups)).toEqual(["pump-01"]);

            const stub = build({ windowSize: 40, persistState: true, groupBy: "topic" }, saved.store);
            await settle();

            expect(stub.node.groups.get("pump-01").isTrained).toBe(true);
            expect(stub.node.isTrained).toBe(false); // nothing in the ungrouped bucket

            await closeNode(stub.node);
        });

        it("migrates the flat v1 layout into the default group", async function () {
            const saved = await trainedStore({});
            const entry = saved.store.pcaAnomalyState.groups[""];
            const v1 = {
                dataBuffer: entry.dataBuffer.map(function (d) {
                    return { timestamp: d.timestamp, values: d.values, names: entry.featureNames };
                }),
                mean: entry.mean,
                stdDev: entry.stdDev,
                pcaModelJSON: entry.pcaModelJSON,
                isTrained: true,
                t2Threshold: 1,
                speThreshold: 1,
                nComponents: 4
            };

            const stub = build({ windowSize: 40, persistState: true }, { pcaAnomalyState: v1 });
            await settle();

            const state = stub.node.groups.get("");
            expect(state.isTrained).toBe(true);
            expect(state.featureNames).toEqual(["a", "b", "c", "d"]);
            // Limits are recomputed from the model, not taken from the old blob
            expect(state.t2Threshold).toBeGreaterThan(5);

            await closeNode(stub.node);
            expect(stub.store.pcaAnomalyState.version).toBe(2);
            expect(stub.store.pcaAnomalyState.pcaModelJSON).toBeUndefined();
            expect(stub.store.pcaAnomalyState.groups[""].pcaModelJSON).toBeTruthy();
        });

        it("persists a reset, so the old model does not come back after a restart", async function () {
            const saved = await trainedStore({});

            const stub = build({ windowSize: 40, persistState: true }, saved.store);
            await settle();
            expect(stub.node.isTrained).toBe(true);
            feed(stub, { reset: true });
            await closeNode(stub.node);

            expect(stub.store.pcaAnomalyState.groups).toEqual({});

            const restarted = build({ windowSize: 40, persistState: true }, stub.store);
            await settle();
            expect(restarted.node.isTrained).toBe(false);
            await closeNode(restarted.node);
        });
    });
});
