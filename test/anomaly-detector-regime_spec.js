/**
 * anomaly-detector: operating-point regimes. One baseline per value of a
 * message property, so a machine that legitimately runs at two load levels
 * does not alarm on every switch between them.
 */
const helper = require("node-red-node-test-helper");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");

helper.init(require.resolve("node-red"));

function flowWith(extra) {
    return [
        Object.assign(
            {
                id: "n1",
                type: "anomaly-detector",
                method: "zscore",
                zscoreThreshold: 3,
                windowSize: 50,
                hysteresisEnabled: false,
                wires: [["n2"], ["n3"]]
            },
            extra
        ),
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
}

// Deterministic "noise": a small triangle wave around a base level
function level(base, i) {
    return base + ((i % 7) - 3) * 0.05;
}

describe("anomaly-detector regimes", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("without a regime property a load change reads as an anomaly (baseline behaviour)", function (done) {
        helper.load(anomalyDetectorNode, flowWith({}), function () {
            const n1 = helper.getNode("n1");
            let anomalies = 0;
            let received = 0;
            const finish = function () {
                if (++received < 60) return;
                expect(anomalies).toBeGreaterThan(0);
                done();
            };
            helper.getNode("n2").on("input", finish);
            helper.getNode("n3").on("input", function () {
                anomalies++;
                finish();
            });
            for (let i = 0; i < 40; i++) n1.receive({ payload: level(10, i), regime: "low" });
            for (let i = 0; i < 20; i++) n1.receive({ payload: level(50, i), regime: "high" });
        });
    });

    it("with a regime property each operating point keeps its own baseline", function (done) {
        helper.load(anomalyDetectorNode, flowWith({ regimeProperty: "regime" }), function () {
            const n1 = helper.getNode("n1");
            const seen = { low: 0, high: 0 };
            const anomalies = [];
            let received = 0;
            const total = 40 + 40 + 20 + 20 + 1;
            const finish = function (msg) {
                if (msg.regime) seen[msg.regime]++;
                if (++received < total) return;
                try {
                    // Alternating between the two levels never trips the alarm …
                    expect(anomalies.filter((a) => a.tag !== "spike")).toEqual([]);
                    // … but a genuine outlier inside the "high" regime does.
                    expect(anomalies.some((a) => a.tag === "spike" && a.regime === "high")).toBe(true);
                    expect(seen.low).toBeGreaterThan(0);
                    expect(seen.high).toBeGreaterThan(0);
                    done();
                } catch (e) {
                    done(e);
                }
            };
            helper.getNode("n2").on("input", finish);
            helper.getNode("n3").on("input", function (msg) {
                anomalies.push({ tag: msg.tag, regime: msg.regime });
                finish(msg);
            });
            for (let i = 0; i < 40; i++) n1.receive({ payload: level(10, i), regime: "low" });
            for (let i = 0; i < 40; i++) n1.receive({ payload: level(50, i), regime: "high" });
            for (let i = 0; i < 20; i++) n1.receive({ payload: level(10, i), regime: "low" });
            for (let i = 0; i < 20; i++) n1.receive({ payload: level(50, i), regime: "high" });
            n1.receive({ payload: 80, regime: "high", tag: "spike" });
        });
    });

    it("reports bufferSize per regime and evicts the least recently used regime", function (done) {
        helper.load(anomalyDetectorNode, flowWith({ regimeProperty: "regime", maxRegimes: 2 }), function () {
            const n1 = helper.getNode("n1");
            const sizes = [];
            let received = 0;
            const finish = function (msg) {
                sizes.push({ regime: msg.regime, size: msg.bufferSize });
                if (++received < 13) return;
                try {
                    // a: 5 samples, b: 5 samples, then c evicts a (LRU), then a
                    // comes back fresh: its first sample is a warm-up pass-through
                    // (no bufferSize), the second reports a buffer of 2 — not 7.
                    const last = sizes[sizes.length - 1];
                    expect(last).toEqual({ regime: "a", size: 2 });
                    expect(sizes[4]).toEqual({ regime: "a", size: 5 });
                    expect(sizes[9]).toEqual({ regime: "b", size: 5 });
                    done();
                } catch (e) {
                    done(e);
                }
            };
            helper.getNode("n2").on("input", finish);
            helper.getNode("n3").on("input", finish);
            for (let i = 0; i < 5; i++) n1.receive({ payload: level(10, i), regime: "a" });
            for (let i = 0; i < 5; i++) n1.receive({ payload: level(20, i), regime: "b" });
            n1.receive({ payload: 30, regime: "c" });
            n1.receive({ payload: 10, regime: "a" });
            n1.receive({ payload: 10.1, regime: "a" });
        });
    });

    it("msg.reset === 'all' clears every regime, msg.reset === true only the active one", function (done) {
        helper.load(anomalyDetectorNode, flowWith({ regimeProperty: "regime" }), function () {
            const n1 = helper.getNode("n1");
            const sizes = [];
            let received = 0;
            const finish = function (msg) {
                sizes.push({ regime: msg.regime, size: msg.bufferSize });
                if (++received < 9) return;
                try {
                    // after reset:true on "a": a restarts (warm-up pass-through,
                    // then a buffer of 2), b keeps its 3 samples and grows to 4
                    expect(sizes[6]).toEqual({ regime: "a", size: undefined });
                    expect(sizes[7]).toEqual({ regime: "a", size: 2 });
                    expect(sizes[8]).toEqual({ regime: "b", size: 4 });
                    done();
                } catch (e) {
                    done(e);
                }
            };
            helper.getNode("n2").on("input", finish);
            helper.getNode("n3").on("input", finish);
            for (let i = 0; i < 3; i++) n1.receive({ payload: level(10, i), regime: "a" });
            for (let i = 0; i < 3; i++) n1.receive({ payload: level(20, i), regime: "b" });
            n1.receive({ reset: true, regime: "a" });
            n1.receive({ payload: 10, regime: "a" });
            n1.receive({ payload: 10.1, regime: "a" });
            n1.receive({ payload: 20, regime: "b" });
        });
    });

    it("works for multi-sensor JSON input as well", function (done) {
        helper.load(anomalyDetectorNode, flowWith({ regimeProperty: "payload.load" }), function () {
            const n1 = helper.getNode("n1");
            let anomalies = 0;
            let received = 0;
            const finish = function (msg) {
                expect(msg.regime).toBeDefined();
                if (++received < 60) return;
                expect(anomalies).toBe(0);
                done();
            };
            helper.getNode("n2").on("input", finish);
            helper.getNode("n3").on("input", function (msg) {
                anomalies++;
                finish(msg);
            });
            for (let i = 0; i < 30; i++) n1.receive({ payload: { temp: level(40, i), load: "idle" } });
            for (let i = 0; i < 30; i++) n1.receive({ payload: { temp: level(75, i), load: "full" } });
        });
    });
});
