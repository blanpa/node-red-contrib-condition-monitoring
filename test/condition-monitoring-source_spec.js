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
                expect(n1).toBeDefined();
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
                    expect(typeof msg.payload).toBe("object");
                    expect(msg.payload.sensors).toBeDefined();
                    expect(typeof msg.payload.sensors.vibrationRMS).toBe("number");
                    expect(typeof msg.payload.sensors.temperature).toBe("number");
                    expect(msg.payload.health).toBeLessThanOrEqual(100);
                    expect(["normal", "warning", "alarm"]).toContain(msg.status);
                    expect(msg.payload.rul).toBeDefined();
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
                    expect(typeof msg.payload).toBe("number");
                    expect(msg.condition).toBeDefined();
                    expect(msg.condition.sensors.vibrationRMS).toBe(msg.payload);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({});
        });
    });
});
