/**
 * trend-predictor: the configured confidence level must actually widen or
 * narrow the RUL interval (it used to be hard-wired to 1.96 σ).
 */
const helper = require("node-red-node-test-helper");
const trendPredictorNode = require("../nodes/trend-predictor.js");

helper.init(require.resolve("node-red"));

const HOUR_MS = 3600000;

// Deterministic noisy ramp: 10 → ~40 over 30 samples, ±1 wobble
function ramp(i) {
    return 10 + i + ((i % 3) - 1);
}

function runRul(confidenceLevel, cb) {
    const flow = [
        {
            id: "n1",
            type: "trend-predictor",
            mode: "rul",
            windowSize: 30,
            failureThreshold: 100,
            degradationModel: "linear",
            rulUnit: "hours",
            confidenceLevel: confidenceLevel,
            wires: [["n2"], ["n3"]]
        },
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
    helper.load(trendPredictorNode, flow, function () {
        const n1 = helper.getNode("n1");
        const finish = function (msg) {
            // RUL mode emits nothing until five samples are buffered; wait for
            // the tagged last message instead of counting.
            if (msg.last && msg.rul) cb(msg.rul);
        };
        helper.getNode("n2").on("input", finish);
        helper.getNode("n3").on("input", finish);
        const t0 = Date.UTC(2026, 0, 1);
        for (let i = 0; i < 30; i++) {
            n1.receive({ payload: ramp(i), timestamp: t0 + i * HOUR_MS, last: i === 29 });
        }
    });
}

describe("trend-predictor confidence level", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("reports the level it used", function (done) {
        runRul(0.99, function (rul) {
            expect(rul.confidenceLevel).toBe(0.99);
            expect(Number.isFinite(rul.value)).toBe(true);
            expect(rul.lower).toBeLessThan(rul.value);
            expect(rul.upper).toBeGreaterThan(rul.value);
            done();
        });
    });

    it("widens the interval at 99 % compared with 90 %", function (done) {
        runRul(0.9, function (r90) {
            helper.unload().then(function () {
                runRul(0.99, function (r99) {
                    try {
                        expect(r90.confidenceLevel).toBe(0.9);
                        expect(r99.confidenceLevel).toBe(0.99);
                        // Same data, same point estimate …
                        expect(r99.value).toBeCloseTo(r90.value, 6);
                        // … wider band. Ratio of half-widths ≈ z99/z90 = 2.576/1.645.
                        const w90 = r90.upper - r90.lower;
                        const w99 = r99.upper - r99.lower;
                        expect(w99).toBeGreaterThan(w90);
                        expect(w99 / w90).toBeCloseTo(2.5758 / 1.6449, 1);
                        done();
                    } catch (e) {
                        done(e);
                    }
                });
            });
        });
    });
});
