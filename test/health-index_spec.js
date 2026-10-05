const helper = require("node-red-node-test-helper");
const healthIndexNode = require("../nodes/health-index.js");

helper.init(require.resolve("node-red"));

describe("health-index Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "health-index", name: "test health-index" }];
        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");
            try {
                expect(n1).toBeDefined();
                expect(n1.name).toBe("test health-index");
                done();
            } catch (err) {
                done(err);
            }
        });
    });

    it("should calculate health index from object payload", function (done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];

        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                try {
                    // Nothing flagged on either sensor: a clean 100
                    expect(msg.payload).toBe(100);
                    expect(msg.healthIndex).toBe(100);
                    expect(msg.status).toBe("healthy");
                    expect(msg.scale).toBe("0-100");
                    expect(msg.sensorScores).toEqual({ temp: 100, vibration: 100 });
                    expect(msg.worstSensor).toBeNull();
                    expect(msg.contributingFactors).toEqual([]);
                    expect(msg.thresholds).toEqual({ healthy: 80, warning: 60, degraded: 40, critical: 20 });
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({
                payload: {
                    temp: { value: 25, isAnomaly: false },
                    vibration: { value: 0.5, isAnomaly: false }
                }
            });
        });
    });

    it("should detect anomalies and reduce health score", function (done) {
        const flow = [
            {
                id: "n1",
                type: "health-index",
                name: "test",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];

        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");

            // With anomaly + high zScore: 100 - 30 (anomaly) - 40 (zScore>3) = 30
            // 30 < 40 (degraded threshold), so goes to anomaly output
            n3.on("input", function (msg) {
                try {
                    // Score should be reduced due to anomaly flag + high zScore
                    expect(msg.payload).toBeLessThan(100);
                    expect(msg.payload).toBe(30); // 100 - 30 - 40 = 30
                    expect(msg.contributingFactors.length).toBe(2); // anomaly + high zScore
                    expect(msg.status).toBe("degraded"); // 30 < 40 (degraded) but > 20 (critical)
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({
                payload: {
                    temp: { value: 25, isAnomaly: true, zScore: 4.0 }
                }
            });
        });
    });

    it("should calculate weighted average correctly", function (done) {
        const flow = [
            {
                id: "n1",
                type: "health-index",
                name: "test",
                sensorWeights: '{"sensor1": 2.0, "sensor2": 1.0}',
                aggregationMethod: "weighted",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];

        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                try {
                    expect(msg.method).toBe("weighted");
                    expect(msg.sensorScores).toEqual({ sensor1: 70, sensor2: 100 });
                    // (70 x 2 + 100 x 1) / 3 — a plain average would give 85
                    expect(msg.payload).toBeCloseTo(80, 10);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({
                payload: {
                    sensor1: { value: 50, isAnomaly: true },
                    sensor2: { value: 50, isAnomaly: false }
                }
            });
        });
    });

    it("should use minimum aggregation method", function (done) {
        const flow = [
            {
                id: "n1",
                type: "health-index",
                name: "test",
                aggregationMethod: "minimum",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];

        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            let received = false;
            const handleMessage = function (msg) {
                if (received) return;
                received = true;
                try {
                    expect(msg.method).toBe("minimum");
                    done();
                } catch (err) {
                    done(err);
                }
            };

            n2.on("input", handleMessage);
            n3.on("input", handleMessage);

            n1.receive({
                payload: {
                    sensor1: { value: 50 },
                    sensor2: { value: 50, isAnomaly: true }
                }
            });
        });
    });

    it("should handle array payload", function (done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];

        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                try {
                    expect(msg.payload).toBe(100);
                    // Named from each entry's valueName
                    expect(msg.sensorScores).toEqual({ temp: 100, pressure: 100 });
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({
                payload: [
                    { valueName: "temp", value: 25, isAnomaly: false },
                    { valueName: "pressure", value: 1013, isAnomaly: false }
                ]
            });
        });
    });

    it("should identify worst sensor", function (done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];

        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            let received = false;
            const handleMessage = function (msg) {
                if (received) return;
                received = true;
                try {
                    // anomaly (-30) and z-score above 3 (-40)
                    expect(msg.worstSensor).toEqual({ name: "badSensor", score: 30, reliability: 1 });
                    expect(msg.sensorScores).toEqual({ goodSensor: 100, badSensor: 30 });
                    expect(msg.payload).toBe(65);
                    expect(msg.status).toBe("attention");
                    expect(
                        msg.contributingFactors.map(function (f) {
                            return [f.sensor, f.impact];
                        })
                    ).toEqual([
                        ["badSensor", -30],
                        ["badSensor", -40]
                    ]);
                    done();
                } catch (err) {
                    done(err);
                }
            };

            n2.on("input", handleMessage);
            n3.on("input", handleMessage);

            n1.receive({
                payload: {
                    goodSensor: { value: 50, isAnomaly: false },
                    badSensor: { value: 50, isAnomaly: true, zScore: 5.0 }
                }
            });
        });
    });

    it("should warn on invalid payload", function (done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];

        helper.load(healthIndexNode, flow, function () {
            const n1 = helper.getNode("n1");

            // Should warn but not crash
            n1.receive({ payload: "invalid" });

            setTimeout(function () {
                done();
            }, 100);
        });
    });

    // ============================================
    // Dynamic Weighting Tests
    // ============================================

    describe("Dynamic Weighting", function () {
        it("should use dynamic aggregation method", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "health-index",
                    name: "test",
                    aggregationMethod: "dynamic",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];

            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");

                let received = false;
                const handleMessage = function (msg) {
                    if (received) return;
                    received = true;
                    try {
                        expect(msg.method).toBe("dynamic");
                        expect(msg.payload).toBe(100);
                        expect(Object.keys(msg.dynamicWeights)).toEqual(["sensor1", "sensor2"]);
                        done();
                    } catch (err) {
                        done(err);
                    }
                };

                n2.on("input", handleMessage);
                n3.on("input", handleMessage);

                n1.receive({
                    payload: {
                        sensor1: { value: 50, isAnomaly: false },
                        sensor2: { value: 50, isAnomaly: false }
                    }
                });
            });
        });

        it("should include dynamic weight info for each sensor", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "health-index",
                    name: "test",
                    aggregationMethod: "dynamic",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];

            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");

                let received = false;
                const handleMessage = function (msg) {
                    if (received) return;
                    received = true;
                    try {
                        // First sample, no weights configured, nothing flagged
                        const pristine = { effectiveWeight: 1, reliabilityFactor: 1, anomalyRate: 0 };
                        expect(msg.dynamicWeights).toEqual({ sensor1: pristine, sensor2: pristine });
                        done();
                    } catch (err) {
                        done(err);
                    }
                };

                n2.on("input", handleMessage);
                n3.on("input", handleMessage);

                n1.receive({
                    payload: {
                        sensor1: { value: 50, isAnomaly: false },
                        sensor2: { value: 50, isAnomaly: false }
                    }
                });
            });
        });

        // A persistently anomalous sensor is the fault to surface, not an
        // unreliable one to mute: the rate is reported, the weight is untouched.
        it("should report the anomaly rate without reducing the weight of an anomalous sensor", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "health-index",
                    name: "test",
                    aggregationMethod: "dynamic",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];

            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");

                let messageCount = 0;
                const handleMessage = function (msg) {
                    messageCount++;
                    if (messageCount === 20) {
                        try {
                            // sensor2 has a 50% anomaly rate ...
                            expect(msg.dynamicWeights.sensor2.anomalyRate).toBeCloseTo(0.5, 5);
                            expect(msg.dynamicWeights.sensor1.anomalyRate).toBe(0);
                            // ... and keeps its full weight
                            expect(msg.dynamicWeights.sensor2.reliabilityFactor).toBe(1);
                            expect(msg.dynamicWeights.sensor2.effectiveWeight).toBe(1);
                            done();
                        } catch (err) {
                            done(err);
                        }
                    }
                };

                n2.on("input", handleMessage);
                n3.on("input", handleMessage);

                // Send mixed data - sensor1 always normal, sensor2 alternates
                for (let i = 0; i < 20; i++) {
                    n1.receive({
                        payload: {
                            sensor1: { value: 50, isAnomaly: false },
                            sensor2: { value: 50, isAnomaly: i % 2 === 0 } // 50% anomaly rate
                        }
                    });
                }
            });
        });

        it("should consider confidence in dynamic weighting", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "health-index",
                    name: "test",
                    aggregationMethod: "dynamic",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];

            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");

                let received = false;
                const handleMessage = function (msg) {
                    if (received) return;
                    received = true;
                    try {
                        // Low confidence sensor should have lower effective weight
                        expect(msg.dynamicWeights.lowConfSensor.effectiveWeight).toBeLessThan(
                            msg.dynamicWeights.highConfSensor.effectiveWeight
                        );
                        done();
                    } catch (err) {
                        done(err);
                    }
                };

                n2.on("input", handleMessage);
                n3.on("input", handleMessage);

                n1.receive({
                    payload: {
                        highConfSensor: { value: 50, isAnomaly: false, confidence: 0.95 },
                        lowConfSensor: { value: 50, isAnomaly: false, confidence: 0.3 }
                    }
                });
            });
        });

        it("should include reliability info in worst sensor output", function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "health-index",
                    name: "test",
                    aggregationMethod: "dynamic",
                    wires: [["n2"], ["n3"]]
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];

            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");

                let received = false;
                const handleMessage = function (msg) {
                    if (received) return;
                    received = true;
                    try {
                        expect(msg.worstSensor).toEqual({ name: "sensor2", score: 70, reliability: 1 });
                        expect(msg.dynamicWeights.sensor2.anomalyRate).toBe(1);
                        done();
                    } catch (err) {
                        done(err);
                    }
                };

                n2.on("input", handleMessage);
                n3.on("input", handleMessage);

                n1.receive({
                    payload: {
                        sensor1: { value: 50, isAnomaly: false },
                        sensor2: { value: 50, isAnomaly: true }
                    }
                });
            });
        });
    });
});
