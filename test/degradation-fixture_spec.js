/**
 * Runs trend-predictor and anomaly-detector against a *real* bearing
 * run-to-failure trend (PRONOSTIA / FEMTO-ST Bearing1_1, reduced to per-snapshot
 * indicators by tools/build-pronostia-fixture.js) instead of synthetic ramps.
 *
 * The trend is deterministic, so every assertion below is about the shape of a
 * real degradation curve: flat for most of the life, then a sharp rise in RMS
 * and kurtosis over the last ~15 %.
 */
const helper = require("node-red-node-test-helper");
const trendPredictorNode = require("../nodes/trend-predictor.js");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");
const fixture = require("./fixtures/pronostia-bearing1_1-trend.json");

helper.init(require.resolve("node-red"));

const points = fixture.points;
const HOUR_MS = 3600000;

describe("PRONOSTIA Bearing1_1 fixture", function () {
    it("is the reduced real run-to-failure trend", function () {
        expect(points.length).toBeGreaterThanOrEqual(50);
        expect(points[0].index).toBe(1);
        expect(points[points.length - 1].index).toBe(fixture.totalSnapshots);
        // healthy start: kurtosis near 3, RMS well under 1 g
        expect(points[0].h.kurtosis).toBeGreaterThan(2);
        expect(points[0].h.kurtosis).toBeLessThan(4);
        expect(points[0].h.rms).toBeLessThan(1);
        // failure end: RMS an order of magnitude up, strongly impulsive
        const last = points[points.length - 1];
        expect(last.h.rms).toBeGreaterThan(5 * points[0].h.rms);
        expect(last.h.kurtosis).toBeGreaterThan(8);
    });

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("anomaly-detector (z-score) stays quiet through the healthy life and fires in the final phase", function (done) {
        const flow = [
            {
                id: "n1",
                type: "anomaly-detector",
                method: "zscore",
                zscoreThreshold: 3,
                windowSize: 20,
                hysteresisEnabled: false,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const anomalies = [];
            const lastIndex = points[points.length - 1].index;
            const finish = function (msg) {
                if (msg.snapshot !== lastIndex) return;
                try {
                    // The RMS drifts down and back up during the first ~40 % of
                    // the life without ever leaving 3σ; the real degradation onset
                    // (≈ 1 250 of 2 803 snapshots) is where the first alarms sit.
                    const cutoff = points[Math.floor(points.length * 0.4)].index;
                    expect(anomalies.filter((i) => i < cutoff)).toEqual([]);
                    expect(anomalies.length).toBeGreaterThan(0);
                    // The final collapse (RMS ×4 within three snapshots) must fire.
                    const tail = points.slice(-3).map((p) => p.index);
                    expect(anomalies.some((i) => tail.includes(i))).toBe(true);
                    done();
                } catch (e) {
                    done(e);
                }
            };
            helper.getNode("n2").on("input", finish);
            helper.getNode("n3").on("input", function (msg) {
                anomalies.push(msg.snapshot);
                finish(msg);
            });
            points.forEach(function (p) {
                n1.receive({ payload: p.h.rms, snapshot: p.index });
            });
        });
    });

    it("trend-predictor (RUL, linear) reports a finite, shrinking RUL once degradation sets in", function (done) {
        const failureRms = 5.0; // g, reached by the last snapshots
        const flow = [
            {
                id: "n1",
                type: "trend-predictor",
                mode: "rul",
                windowSize: 12,
                failureThreshold: failureRms,
                degradationModel: "linear",
                rulUnit: "hours",
                confidenceLevel: 0.9,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(trendPredictorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const results = [];
            const lastIndex = points[points.length - 1].index;
            const finish = function (msg) {
                if (msg && msg.rul) results.push({ index: msg.snapshot, rul: msg.rul });
                // RUL mode emits nothing for the first four samples, so wait for
                // the tagged last snapshot rather than counting messages.
                if (msg.snapshot !== lastIndex) return;
                try {
                    const finite = results.filter((r) => Number.isFinite(r.rul.value) && r.rul.value > 0);
                    expect(finite.length).toBeGreaterThan(5);
                    // Every finite estimate carries the configured level and a band around it
                    finite.forEach(function (r) {
                        expect(r.rul.confidenceLevel).toBe(0.9);
                        if (r.rul.lower !== null && r.rul.upper !== null) {
                            expect(r.rul.lower).toBeLessThanOrEqual(r.rul.value + 1e-9);
                            expect(r.rul.upper).toBeGreaterThanOrEqual(r.rul.value - 1e-9);
                        }
                    });
                    // Compare the last two finite estimates from the steep phase:
                    // the later one must be shorter.
                    const late = finite.filter((r) => r.index >= points[Math.floor(points.length * 0.85)].index);
                    expect(late.length).toBeGreaterThanOrEqual(2);
                    expect(late[late.length - 1].rul.value).toBeLessThan(late[0].rul.value);
                    // The final snapshot is at/over the threshold -> failed
                    const last = results[results.length - 1];
                    expect(["failed", "critical"]).toContain(last.rul.status);
                    done();
                } catch (e) {
                    done(e);
                }
            };
            helper.getNode("n2").on("input", finish);
            helper.getNode("n3").on("input", finish);
            const t0 = Date.UTC(2026, 0, 1);
            points.forEach(function (p) {
                // Snapshots are 500 s apart in the fixture; feed them as hours so RUL is legible
                n1.receive({ payload: p.h.rms, timestamp: t0 + (p.t_s / 500) * HOUR_MS, snapshot: p.index });
            });
        });
    });
});
