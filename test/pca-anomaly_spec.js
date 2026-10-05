const helper = require("node-red-node-test-helper");
const pcaAnomalyNode = require("../nodes/pca-anomaly.js");
const stats = require("../nodes/utils/statistics");
const { seededRandom } = require("./stub-runtime");

// Seeded per test: training data must not differ from run to run.
let rng;

function expectRelativelyClose(actual, expected) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-8 * Math.max(1, Math.abs(expected)));
}

/**
 * Whatever the training data, a scored message has to be internally
 * consistent: T² follows from the scores and eigenvalues it reports, the limit
 * follows from the configuration, and the flags follow from both.
 *
 * @param {object} msg
 * @param {{method: string, threshold: number, trainedOn: number}} expected
 */
function expectConsistentPca(msg, expected) {
    const pca = msg.pca;

    expect(pca.scores.length).toBe(pca.nComponents);
    expect(pca.eigenvalues.length).toBe(pca.nComponents);
    let t2 = 0;
    pca.scores.forEach(function (score, i) {
        expect(Number.isFinite(score)).toBe(true);
        if (pca.eigenvalues[i] > 1e-10) t2 += (score * score) / pca.eigenvalues[i];
        if (i > 0) expect(pca.eigenvalues[i]).toBeLessThanOrEqual(pca.eigenvalues[i - 1] + 1e-12);
    });
    expectRelativelyClose(pca.t2, t2);
    expect(pca.spe).toBeGreaterThanOrEqual(0);

    expectRelativelyClose(
        pca.t2Threshold,
        stats.hotellingLimitFromZ(pca.nComponents, expected.trainedOn, expected.threshold)
    );
    expect(pca.speThreshold).toBeGreaterThan(0);
    expect(pca.t2Anomaly).toBe(pca.t2 > pca.t2Threshold);
    expect(pca.speAnomaly).toBe(pca.spe > pca.speThreshold);

    expect(msg.method).toBe("pca-" + expected.method);
    expect(msg.isAnomaly).toBe(
        { t2: pca.t2Anomaly, spe: pca.speAnomaly, combined: pca.t2Anomaly || pca.speAnomaly }[expected.method]
    );

    expect(pca.explainedVariance).toBeGreaterThan(0);
    expect(pca.explainedVariance).toBeLessThanOrEqual(1 + 1e-12);
}

/** Contributions are sorted, capped and expressed as shares of the residual. */
function expectConsistentContributions(msg, maxShown) {
    expect(msg.sensorNames).toContain(msg.topContributor);
    if (!msg.contributions) return;
    expect(msg.contributions.length).toBeLessThanOrEqual(maxShown);
    expect(msg.contributions[0].sensor).toBe(msg.topContributor);
    msg.contributions.forEach(function (c, i) {
        expect(msg.sensorNames).toContain(c.sensor);
        expect(c.normalizedContribution).toBeGreaterThanOrEqual(0);
        expect(c.normalizedContribution).toBeLessThanOrEqual(1 + 1e-12);
        expect(c.percentContribution).toBe((c.normalizedContribution * 100).toFixed(1) + "%");
        if (i > 0) expect(c.contribution).toBeLessThanOrEqual(msg.contributions[i - 1].contribution);
    });
}

helper.init(require.resolve("node-red"));

describe("pca-anomaly Node", function () {
    beforeEach(function (done) {
        rng = seededRandom(20260101);
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "pca-anomaly", name: "PCA Monitor" }];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty("name", "PCA Monitor");
            done();
        });
    });

    it("should have default configuration values", function (done) {
        const flow = [{ id: "n1", type: "pca-anomaly", name: "test" }];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty("nComponents", 2);
            expect(n1).toHaveProperty("windowSize", 100);
            expect(n1).toHaveProperty("threshold", 3.0);
            expect(n1).toHaveProperty("method", "t2");
            expect(n1).toHaveProperty("autoComponents", true);
            expect(n1).toHaveProperty("varianceThreshold", 0.95);
            done();
        });
    });

    it("should buffer values during training phase", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            let messageCount = 0;
            n2.on("input", function (msg) {
                messageCount++;
                // During training, messages are passed through but without PCA analysis
                if (messageCount < 10) {
                    expect(msg).not.toHaveProperty("pca");
                }
            });

            // Send training data (less than minimum required)
            for (let i = 0; i < 5; i++) {
                n1.receive({
                    payload: { sensor1: 10 + rng.next(), sensor2: 20 + rng.next(), sensor3: 30 + rng.next() }
                });
            }

            setTimeout(function () {
                done();
            }, 100);
        });
    });

    it("should train and detect anomalies after collecting enough data", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, threshold: 3.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            // Listen on both outputs
            const handler = function (msg) {
                if (msg.pca) {
                    // Only check after training
                    // windowSize 20: first fit, and first scored message, at sample 10
                    expectConsistentPca(msg, { method: "t2", threshold: 3.0, trainedOn: 10 });
                    expect(msg.bufferSize).toBe(10);
                    expect(msg.sensorNames).toEqual(["sensor1", "sensor2", "sensor3"]);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data (normal operation) - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        sensor1: 10 + rng.next() * 0.5,
                        sensor2: 20 + rng.next() * 0.5,
                        sensor3: 30 + rng.next() * 0.5
                    }
                });
            }

            // Send normal value after training
            n1.receive({ payload: { sensor1: 10.2, sensor2: 20.1, sensor3: 30.3 } });
        });
    });

    it("should detect anomaly with outlier values", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, threshold: 2.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            // Send training data (normal operation) - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        sensor1: 10 + rng.next() * 0.1,
                        sensor2: 20 + rng.next() * 0.1,
                        sensor3: 30 + rng.next() * 0.1
                    }
                });
            }

            // Listen on both outputs - the extreme value should be anomaly
            const handler = function (msg) {
                if (msg.pca && msg.isAnomaly) {
                    expect(msg.isAnomaly).toBe(true);
                    expect(msg.payload).toEqual({ sensor1: 100, sensor2: 20, sensor3: 30 });
                    expect(msg.pca.t2Anomaly).toBe(true);
                    expect(msg.pca.t2).toBeGreaterThan(msg.pca.t2Threshold * 100);
                    expectConsistentContributions(msg, 3);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send anomaly (sensor1 way off)
            n1.receive({ payload: { sensor1: 100, sensor2: 20, sensor3: 30 } });
        });
    });

    it("should handle array input", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca) {
                    expectConsistentPca(msg, { method: "t2", threshold: 3.0, trainedOn: 10 });
                    expect(msg.sensorNames).toEqual(["sensor0", "sensor1", "sensor2"]);
                    expect(Array.isArray(msg.payload)).toBe(true);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data as arrays - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: [10 + rng.next() * 0.5, 20 + rng.next() * 0.5, 30 + rng.next() * 0.5]
                });
            }

            n1.receive({ payload: [10.1, 20.2, 30.1] });
        });
    });

    it("should reset state when msg.reset is true", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            // Train the model
            for (let i = 0; i < 30; i++) {
                n1.receive({
                    payload: { sensor1: 10, sensor2: 20, sensor3: 30 }
                });
            }

            // Reset
            n1.receive({ reset: true });

            let messageCount = 0;
            n2.on("input", function (msg) {
                messageCount++;
                // After reset, should be in training phase again
                if (messageCount === 1) {
                    expect(msg).not.toHaveProperty("pca");
                    done();
                }
            });

            // Send new data - should be in training phase
            n1.receive({ payload: { sensor1: 10, sensor2: 20, sensor3: 30 } });
        });
    });

    it("should include contribution analysis for anomalies", function (done) {
        const flow = [
            {
                id: "n1",
                type: "pca-anomaly",
                name: "test",
                windowSize: 20,
                threshold: 1.5,
                showTopContributors: 3,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                // Check for any message with contributions (anomaly or not - we'll validate contents)
                if (msg.pca && msg.isAnomaly) {
                    expectConsistentContributions(msg, 3);
                    // Anomalies carry the full, unfiltered breakdown as well
                    expect(msg.allContributions.length).toBe(4);
                    const total = msg.allContributions.reduce(function (sum, c) {
                        return sum + c.normalizedContribution;
                    }, 0);
                    expect(total).toBeCloseTo(1, 10);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data with low variation - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        temp: 25 + i * 0.1,
                        pressure: 100 + i * 0.2,
                        vibration: 2 + i * 0.01,
                        current: 10 + i * 0.05
                    }
                });
            }

            // Send extreme anomaly (all values way off)
            n1.receive({ payload: { temp: 100, pressure: 500, vibration: 200, current: 100 } });
        });
    });

    it("should support different detection methods", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, method: "spe", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca) {
                    expectConsistentPca(msg, { method: "spe", threshold: 3.0, trainedOn: 10 });
                    // In "spe" mode a T² excursion alone must not raise the alarm
                    expect(msg.isAnomaly).toBe(msg.pca.speAnomaly);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        sensor1: 10 + rng.next() * 0.1,
                        sensor2: 20 + rng.next() * 0.1,
                        sensor3: 30 + rng.next() * 0.1
                    }
                });
            }

            n1.receive({ payload: { sensor1: 10.1, sensor2: 20.1, sensor3: 30.1 } });
        });
    });

    it("should auto-select number of components", function (done) {
        const flow = [
            {
                id: "n1",
                type: "pca-anomaly",
                name: "test",
                windowSize: 20,
                autoComponents: true,
                varianceThreshold: 0.95,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca) {
                    expectConsistentPca(msg, { method: "t2", threshold: 3.0, trainedOn: 10 });
                    // Enough components to reach the 95% target, out of 4 sensors
                    expect(msg.pca.explainedVariance).toBeGreaterThanOrEqual(0.95);
                    expect(msg.pca.nComponents).toBeGreaterThanOrEqual(1);
                    expect(msg.pca.nComponents).toBeLessThanOrEqual(4);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data with correlated sensors - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                const base = i + rng.next() * 2;
                n1.receive({
                    payload: {
                        sensor1: base,
                        sensor2: base * 2 + rng.next() * 0.5, // Correlated with sensor1
                        sensor3: rng.next() * 10, // Independent
                        sensor4: base + rng.next() * 0.5 // Correlated with sensor1
                    }
                });
            }

            n1.receive({ payload: { sensor1: 7, sensor2: 14, sensor3: 5, sensor4: 7 } });
        });
    });

    it("should preserve message properties", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            let pcaMessageReceived = false;
            const handler = function (msg) {
                if (msg.pca && msg.customProperty && !pcaMessageReceived) {
                    pcaMessageReceived = true;
                    expect(msg).toHaveProperty("customProperty", "test123");
                    expect(msg).toHaveProperty("machineId", "machine-01");
                    done();
                }
            };
            // Register handlers BEFORE sending data
            n2.on("input", handler);
            n3.on("input", handler);

            // Train - send samples
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        sensor1: 10 + i * 0.5 + rng.next(),
                        sensor2: 20 + i * 0.3 + rng.next(),
                        sensor3: 30 + i * 0.2 + rng.next()
                    }
                });
            }

            n1.receive({
                payload: { sensor1: 12, sensor2: 22, sensor3: 32 },
                customProperty: "test123",
                machineId: "machine-01"
            });
        });
    });

    it("should include timestamp and buffer size in output", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const beforeTime = Date.now();
            let pcaMessageReceived = false;

            const handler = function (msg) {
                if (msg.pca && !pcaMessageReceived) {
                    pcaMessageReceived = true;
                    expect(msg.timestamp).toBeGreaterThanOrEqual(beforeTime);
                    expect(msg.timestamp).toBeLessThanOrEqual(Date.now());
                    // First scored message is the 10th sample
                    expect(msg.bufferSize).toBe(10);
                    done();
                }
            };
            // Register handlers BEFORE sending data
            n2.on("input", handler);
            n3.on("input", handler);

            // Train - send samples one at a time with delay to ensure processing
            const samples = [];
            for (let i = 0; i < 15; i++) {
                samples.push({
                    sensor1: 10 + i * 0.5 + rng.next(),
                    sensor2: 20 + i * 0.3 + rng.next(),
                    sensor3: 30 + i * 0.2 + rng.next()
                });
            }
            samples.push({ sensor1: 12, sensor2: 22, sensor3: 32 }); // Final sample

            samples.forEach((s) => n1.receive({ payload: s }));
        });
    });

    it("should error on insufficient sensor values", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            let received = false;
            n2.on("input", function () {
                received = true;
            });
            n3.on("input", function () {
                received = true;
            });

            // Send only one sensor (need at least 2)
            n1.receive({ payload: { sensor1: 10 } });
            n1.receive({ payload: [10] });

            setTimeout(function () {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    it("should error on invalid payload", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            let received = false;
            n2.on("input", function () {
                received = true;
            });
            n3.on("input", function () {
                received = true;
            });

            n1.receive({ payload: "invalid" });
            n1.receive({ payload: 123 }); // Single number

            setTimeout(function () {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    // ============================================
    // ml-pca specific tests
    // ============================================

    it("should provide eigenvalues in output (ml-pca feature)", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca && msg.pca.eigenvalues) {
                    expect(Array.isArray(msg.pca.eigenvalues)).toBe(true);
                    expect(msg.pca.eigenvalues.length).toBeGreaterThan(0);
                    expectConsistentPca(msg, { method: "t2", threshold: 3.0, trainedOn: 10 });
                    // Eigenvalues should be positive
                    msg.pca.eigenvalues.forEach((ev) => {
                        expect(ev).toBeGreaterThanOrEqual(0);
                    });
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        sensor1: 10 + rng.next() * 2,
                        sensor2: 20 + rng.next() * 2,
                        sensor3: 30 + rng.next() * 2
                    }
                });
            }

            n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
        });
    });

    it("should provide explained variance ratio (ml-pca feature)", function (done) {
        const flow = [
            {
                id: "n1",
                type: "pca-anomaly",
                name: "test",
                windowSize: 20,
                autoComponents: true,
                varianceThreshold: 0.9,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca) {
                    // Three sensors driven by one factor: a single component
                    // already clears the 90% target
                    expect(msg.pca.nComponents).toBe(1);
                    expect(msg.pca.explainedVariance).toBeGreaterThanOrEqual(0.9);
                    expect(msg.pca.explainedVariance).toBeLessThanOrEqual(1 + 1e-12);
                    expectConsistentPca(msg, { method: "t2", threshold: 3.0, trainedOn: 10 });
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send correlated data (should result in fewer components needed)
            for (let i = 0; i < 15; i++) {
                const base = i + rng.next();
                n1.receive({
                    payload: {
                        sensor1: base,
                        sensor2: base * 2 + rng.next() * 0.1, // Highly correlated
                        sensor3: base * 3 + rng.next() * 0.1 // Highly correlated
                    }
                });
            }

            n1.receive({ payload: { sensor1: 7, sensor2: 14, sensor3: 21 } });
        });
    });

    it("should correctly identify top contributor sensor", function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, threshold: 1.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            let hasDone = false;
            const handler = function (msg) {
                if (msg.pca && msg.topContributor && !hasDone) {
                    hasDone = true;
                    expect(msg.sensorNames).toEqual(["temp", "pressure", "humidity"]);
                    expectConsistentContributions(msg, 3);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data with stable values
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        temp: 25 + rng.next() * 0.1,
                        pressure: 100 + rng.next() * 0.1,
                        humidity: 50 + rng.next() * 0.1
                    }
                });
            }

            // Send value after training - should have topContributor
            n1.receive({ payload: { temp: 25.5, pressure: 100.5, humidity: 50.5 } });
        });
    });

    it("should handle highly correlated sensors correctly", function (done) {
        const flow = [
            {
                id: "n1",
                type: "pca-anomaly",
                name: "test",
                windowSize: 30,
                autoComponents: true,
                varianceThreshold: 0.99,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca) {
                    // With perfectly correlated data, PCA should need fewer components
                    expect(msg.pca.nComponents).toBe(1);
                    expect(msg.pca.explainedVariance).toBeGreaterThan(0.99);
                    // windowSize 30: first fit at sample 15
                    expectConsistentPca(msg, { method: "t2", threshold: 3.0, trainedOn: 15 });
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send perfectly correlated data (all sensors move together)
            for (let i = 0; i < 20; i++) {
                const base = i * 2 + rng.next() * 0.01;
                n1.receive({
                    payload: {
                        sensor1: base,
                        sensor2: base,
                        sensor3: base
                    }
                });
            }

            n1.receive({ payload: { sensor1: 20, sensor2: 20, sensor3: 20 } });
        });
    });

    it("should calculate correct T² and SPE statistics", function (done) {
        const flow = [
            {
                id: "n1",
                type: "pca-anomaly",
                name: "test",
                windowSize: 20,
                method: "combined",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca) {
                    // T² should be non-negative
                    expect(msg.pca.t2).toBeGreaterThanOrEqual(0);
                    // SPE should be non-negative
                    expect(msg.pca.spe).toBeGreaterThanOrEqual(0);
                    // Thresholds should be set
                    expect(msg.pca.t2Threshold).toBeGreaterThan(0);
                    expect(msg.pca.speThreshold).toBeGreaterThan(0);
                    // Value, limit and flags agree with each other and the config
                    expectConsistentPca(msg, { method: "combined", threshold: 3.0, trainedOn: 10 });
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        sensor1: 10 + rng.next(),
                        sensor2: 20 + rng.next(),
                        sensor3: 30 + rng.next()
                    }
                });
            }

            n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
        });
    });

    it("should provide scores array matching nComponents", function (done) {
        const flow = [
            {
                id: "n1",
                type: "pca-anomaly",
                name: "test",
                windowSize: 20,
                nComponents: 2,
                autoComponents: false,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            const handler = function (msg) {
                if (msg.pca && msg.pca.scores) {
                    expect(Array.isArray(msg.pca.scores)).toBe(true);
                    // Fixed component count: exactly the configured 2
                    expect(msg.pca.nComponents).toBe(2);
                    expect(msg.pca.scores.length).toBe(2);
                    expectConsistentPca(msg, { method: "t2", threshold: 3.0, trainedOn: 10 });
                    // Each score should be a number
                    msg.pca.scores.forEach((score) => {
                        expect(typeof score).toBe("number");
                        expect(isNaN(score)).toBe(false);
                    });
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);

            // Send training data
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: {
                        sensor1: 10 + rng.next(),
                        sensor2: 20 + rng.next(),
                        sensor3: 30 + rng.next()
                    }
                });
            }

            n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
        });
    });
});
