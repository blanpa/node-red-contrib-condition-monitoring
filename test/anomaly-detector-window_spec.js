"use strict";

/**
 * The anomaly-detector's streaming path no longer re-reduces the whole window
 * on every message: `windowValues` is maintained in lockstep with `dataBuffer`
 * and a Welford accumulator supplies mean/σ in O(1).
 *
 * That is only safe if the O(1) figures stay identical to the O(n) ones in
 * utils/statistics — including *after* the window has fully turned over several
 * times, which is when Welford's reverse update drifts. These tests pin that
 * equivalence, plus the bookkeeping invariants the three structures must hold.
 */

const helper = require("node-red-node-test-helper");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");
const stats = require("../nodes/utils/statistics");

helper.init(require.resolve("node-red"));

const WINDOW = 20;

function flow(overrides) {
    return [
        Object.assign(
            {
                id: "n1",
                type: "anomaly-detector",
                name: "window",
                method: "zscore",
                zscoreThreshold: 3,
                zscoreWarning: 2,
                windowSize: WINDOW,
                hysteresisEnabled: false,
                wires: [["n2"], ["n3"]]
            },
            overrides || {}
        ),
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
}

function feed(node, value) {
    return new Promise((resolve) => {
        node.receive({ payload: value });
        // The node is synchronous for numeric payloads; yield once so send()
        // and the status update have run.
        setImmediate(resolve);
    });
}

// Deterministic, non-trivial sequence: a slow ramp with a periodic component,
// so mean and σ both move as the window slides. No Math.random() — a random
// baseline can cross the z threshold while σ is still tiny and route messages
// to the wrong output.
function sample(i) {
    return 50 + i * 0.37 + 8 * Math.sin(i / 3) + (i % 7) * 1.1;
}

describe("anomaly-detector sliding window", () => {
    beforeEach((done) => {
        helper.startServer(done);
    });
    afterEach((done) => {
        helper.unload().then(() => helper.stopServer(done));
    });

    it("keeps dataBuffer, windowValues and the accumulator in lockstep", async () => {
        await new Promise((resolve) => helper.load(anomalyDetectorNode, flow(), resolve));
        const n1 = helper.getNode("n1");

        // Well past a full turnover so the periodic rebuild has fired.
        for (let i = 0; i < WINDOW * 5; i++) {
            await feed(n1, sample(i));
            expect(n1.windowValues.length).toBe(n1.dataBuffer.length);
            expect(n1.running.count()).toBe(n1.dataBuffer.length);
            expect(n1.windowValues).toEqual(n1.dataBuffer.map((d) => d.value));
        }

        expect(n1.dataBuffer.length).toBe(WINDOW);
    });

    it("O(1) mean/σ match the canonical batch computation across many turnovers", async () => {
        await new Promise((resolve) => helper.load(anomalyDetectorNode, flow(), resolve));
        const n1 = helper.getNode("n1");

        for (let i = 0; i < WINDOW * 25; i++) {
            await feed(n1, sample(i));

            const values = n1.dataBuffer.map((d) => d.value);
            const batchMean = stats.calculateMean(values);
            const batchStdDev = stats.calculateStdDev(values, batchMean);

            // Tight tolerance: the periodic rebuild bounds Welford's reverse-update
            // drift to at most one window of removals, so this must stay near-exact.
            expect(n1.running.mean()).toBeCloseTo(batchMean, 9);
            expect(n1.running.stdDev()).toBeCloseTo(batchStdDev, 9);
        }
    });

    it("makes the same anomaly decision a batch recompute would make", async () => {
        // The output message does not expose mean/σ, so assert on what actually
        // matters: the routing decision the O(1) moments produce must match the
        // one the canonical O(n) computation produces, sample for sample.
        await new Promise((resolve) => helper.load(anomalyDetectorNode, flow(), resolve));
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        const n3 = helper.getNode("n3");

        const normal = [];
        const anomalous = [];
        n2.on("input", (msg) => normal.push(msg));
        n3.on("input", (msg) => anomalous.push(msg));

        const expected = [];
        for (let i = 0; i < WINDOW * 6; i++) {
            const value = sample(i);
            // The window the detector will see once this sample is appended.
            const windowAfter = n1.dataBuffer
                .map((d) => d.value)
                .concat([value])
                .slice(-WINDOW);

            if (windowAfter.length >= 2) {
                const abs = Math.abs(stats.calculateZScore(value, windowAfter).zScore);
                expected.push({
                    value,
                    isAnomaly: abs > 2, // zscoreWarning; anything above it is flagged
                    severity: abs > 3 ? "critical" : abs > 2 ? "warning" : "normal"
                });
            }
            await feed(n1, value);
        }

        const decided = normal
            .concat(anomalous)
            .filter((m) => m.severity !== undefined)
            .sort((a, b) => a.timestamp - b.timestamp);

        expect(decided.length).toBe(expected.length);
        // The run must exercise both branches, or the comparison proves nothing.
        expect(expected.some((e) => e.isAnomaly)).toBe(true);
        expect(expected.some((e) => !e.isAnomaly)).toBe(true);

        expected.forEach((exp) => {
            const got = decided.find((m) => m.payload === exp.value);
            expect(got).toBeDefined();
            expect(got.isAnomaly).toBe(exp.isAnomaly);
            expect(got.severity).toBe(exp.severity);
        });
    });

    it("resyncs the window on msg.reset", async () => {
        await new Promise((resolve) => helper.load(anomalyDetectorNode, flow(), resolve));
        const n1 = helper.getNode("n1");

        for (let i = 0; i < WINDOW * 2; i++) await feed(n1, sample(i));
        expect(n1.running.count()).toBe(WINDOW);

        n1.receive({ payload: 0, reset: true });
        await new Promise((r) => setImmediate(r));

        expect(n1.dataBuffer.length).toBe(0);
        expect(n1.windowValues.length).toBe(0);
        expect(n1.running.count()).toBe(0);
        expect(n1.running.mean()).toBe(0);
    });

    it("clamps windowSize to MAX_WINDOW_SIZE instead of the old 1e6", async () => {
        await new Promise((resolve) => helper.load(anomalyDetectorNode, flow({ windowSize: 5000000 }), resolve));
        expect(helper.getNode("n1").windowSize).toBe(100000);
    });

    it("throttles persistence on a monotonic sample count, not the capped buffer length", async () => {
        // windowSize % 10 === 0 used to make `dataBuffer.length % 10` fire on
        // *every* message once the buffer saturated.
        await new Promise((resolve) =>
            helper.load(anomalyDetectorNode, flow({ windowSize: 10, persistState: true }), resolve)
        );
        const n1 = helper.getNode("n1");

        // The persistence helper closes over the manager it assigned to
        // node.stateManager, so patch that object rather than replacing it.
        expect(n1.stateManager).toBeTruthy();
        const saves = [];
        n1.stateManager.setMultiple = (v) => saves.push(v);

        for (let i = 0; i < 30; i++) await feed(n1, sample(i));

        expect(n1.sampleCount).toBe(30);
        // 30 samples at one save per 10 — not 21 (every message past saturation).
        expect(saves.length).toBe(3);
    });

    it("throttles at the same rate for a window size that is not a multiple of 10", async () => {
        // The mirror case: `length % 10` would have fired *never* here.
        await new Promise((resolve) =>
            helper.load(anomalyDetectorNode, flow({ windowSize: 13, persistState: true }), resolve)
        );
        const n1 = helper.getNode("n1");

        expect(n1.stateManager).toBeTruthy();
        const saves = [];
        n1.stateManager.setMultiple = (v) => saves.push(v);

        for (let i = 0; i < 30; i++) await feed(n1, sample(i));

        expect(saves.length).toBe(3);
    });
});
