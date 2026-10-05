const helper = require("node-red-node-test-helper");
const cmSourceNode = require("../nodes/condition-monitoring-source.js");

helper.init(require.resolve("node-red"));

describe("condition-monitoring-source Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "condition-monitoring-source", name: "test cm-source" }];
        helper.load(cmSourceNode, flow, function () {
            const n1 = helper.getNode("n1");
            try {
                expect(n1.name).toBe("test cm-source");
                expect(n1.running).toBe(false); // autoStart defaults to false
                done();
            } catch (err) {
                done(err);
            }
        });
    });

    it("should emit a structured sample on a manual trigger", function (done) {
        const flow = [
            { id: "n1", type: "condition-monitoring-source", name: "src", noise: 0, wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];

        helper.load(cmSourceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                try {
                    // noise: 0 makes the first sample fully determined by the
                    // defaults (load 70 %, 0.06 %/h degradation, 2 h per sample).
                    expect(msg.payload.sensors).toEqual({
                        vibrationRMS: 1.747,
                        temperature: 57.64,
                        current: 11.702,
                        pressure: 4.598
                    });
                    expect(msg.payload.health).toBe(99.88);
                    expect(msg.payload.simHours).toBe(2);
                    expect(msg.payload.sampleCount).toBe(1);
                    expect(msg.payload.rpm).toBe(1500);
                    expect(msg.payload.shaftFrequencyHz).toBe(25);
                    expect(msg.payload.faults).toEqual([]);
                    expect(msg.status).toBe("normal");
                    expect(msg.alarm).toBe(false);
                    expect(msg.payload.rul).toEqual({ hours: 1664.67, label: "69.4 d", lossPerHour: 0.06 });
                    expect(msg.rul).toEqual(msg.payload.rul);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({});
        });
    });

    it("should produce higher vibration with an injected bearing fault", function (done) {
        const flow = [
            { id: "h1", type: "condition-monitoring-source", name: "healthy", noise: 0, wires: [["h2"]] },
            { id: "h2", type: "helper" }
        ];

        helper.load(cmSourceNode, flow, function () {
            const h1 = helper.getNode("h1");
            const h2 = helper.getNode("h2");
            const received = [];

            h2.on("input", function (msg) {
                received.push(msg);
                if (received.length === 1) {
                    // Inject a strong bearing fault at runtime and emit a second sample.
                    h1.receive({ config: { faults: { bearing: 0.85 }, degRate: 0.2 }, emit: true });
                } else if (received.length === 2) {
                    try {
                        const healthyVib = received[0].payload.sensors.vibrationRMS;
                        const faultVib = received[1].payload.sensors.vibrationRMS;
                        expect(faultVib).toBeGreaterThan(healthyVib);
                        expect(received[1].payload.faults.some((f) => f.type === "bearing")).toBe(true);
                        done();
                    } catch (err) {
                        done(err);
                    }
                }
            });

            h1.receive({});
        });
    });

    it("should reset simulated hours on reset command", function (done) {
        const flow = [
            {
                id: "n1",
                type: "condition-monitoring-source",
                name: "src",
                noise: 0,
                hoursPerSample: 2,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];

        helper.load(cmSourceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            let stage = "warmup";
            n2.on("input", function (msg) {
                if (stage === "afterReset") {
                    try {
                        // After reset, the first new sample advances by exactly one step.
                        expect(msg.payload.simHours).toBe(2);
                        done();
                    } catch (err) {
                        done(err);
                    }
                }
            });

            // Advance a few samples, then reset, then emit once more.
            n1.receive({});
            n1.receive({});
            n1.receive({});
            n1.receive({ payload: "reset" });
            stage = "afterReset";
            n1.receive({});
        });
    });

    it("should output only the vibration value in value mode", function (done) {
        const flow = [
            {
                id: "n1",
                type: "condition-monitoring-source",
                name: "src",
                noise: 0,
                outputFormat: "value",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];

        helper.load(cmSourceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                try {
                    expect(msg.payload).toBe(1.747);
                    expect(msg.condition.sensors.vibrationRMS).toBe(msg.payload);
                    expect(msg.condition.health).toBe(99.88);
                    expect(msg.health).toBe(99.88);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({});
        });
    });
});

describe("condition-monitoring-source hardening", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("describes active faults in English", function (done) {
        const flow = [
            {
                id: "n1",
                type: "condition-monitoring-source",
                noise: 0,
                faultImbalance: 0.2,
                faultMisalignment: 0.4,
                faultBearing: 0.8,
                faultLooseness: 0.1,
                degRate: 0,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(cmSourceNode, flow, function () {
            helper.getNode("n2").on("input", function (msg) {
                try {
                    expect(msg.payload.faults.map((f) => [f.type, f.description, f.severity, f.frequencyHz])).toEqual([
                        ["imbalance", "Imbalance (1× shaft frequency)", "low", 25],
                        ["misalignment", "Misalignment (2×)", "medium", 50],
                        ["bearing", "Bearing fault (~3.5× / BPFO)", "high", 87.5],
                        ["looseness", "Mechanical looseness (0.5×)", "low", 12.5]
                    ]);
                    // No degradation configured → RUL is reported as stable.
                    expect(msg.payload.rul).toEqual({ hours: null, label: "stable", lossPerHour: 0 });
                    done();
                } catch (err) {
                    done(err);
                }
            });
            helper.getNode("n1").receive({});
        });
    });

    it("a seeded stream replays identically after a reset", function (done) {
        const flow = [
            { id: "n1", type: "condition-monitoring-source", seed: 42, noise: 1, wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(cmSourceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const seen = [];
            helper.getNode("n2").on("input", function (msg) {
                seen.push(msg.payload.sensors);
                if (seen.length === 6) {
                    try {
                        expect(seen.slice(3)).toEqual(seen.slice(0, 3));
                        done();
                    } catch (err) {
                        done(err);
                    }
                }
            });
            n1.receive({});
            n1.receive({});
            n1.receive({});
            n1.receive({ payload: "reset" });
            n1.receive({});
            n1.receive({});
            n1.receive({});
        });
    });
});
