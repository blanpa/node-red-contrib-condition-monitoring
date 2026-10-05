const helper = require("node-red-node-test-helper");
const multiValueNode = require("../nodes/multi-value-processor.js");

helper.init(require.resolve("node-red"));

describe("multi-value-processor Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "multi-value-processor", name: "Multi-Value Test" }];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty("name", "Multi-Value Test");
            done();
        });
    });

    it("should split array values in sequential mode", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "split",
                outputMode: "sequential",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            let count = 0;
            n2.on("input", function (msg) {
                count++;
                if (count === 3) {
                    expect(msg.payload).toBe(30);
                    expect(msg.valueIndex).toBe(2);
                    expect(msg.totalValues).toBe(3);
                    done();
                }
            });

            n1.receive({ payload: [10, 20, 30] });
        });
    });

    it("should split object values", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "split",
                outputMode: "parallel",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                expect(Array.isArray(msg.payload)).toBe(true);
                expect(msg.payload.length).toBe(3);
                expect(msg.valueNames).toContain("temp");
                expect(msg.valueNames).toContain("pressure");
                expect(msg.valueNames).toContain("humidity");
                done();
            });

            n1.receive({ payload: { temp: 25.5, pressure: 1013, humidity: 60 } });
        });
    });

    it("should analyze values for anomalies", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "analyze",
                anomalyMethod: "zscore",
                threshold: 2.5,
                windowSize: 10,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            const n3 = helper.getNode("n3");

            let normalCount = 0;
            n2.on("input", function (msg) {
                normalCount++;
                if (normalCount < 10) return;
                try {
                    // 10th identical sample: flat baseline, nothing to flag
                    expect(msg.method).toBe("multi-zscore");
                    expect(msg.hasAnomaly).toBe(false);
                    expect(msg.anomalyCount).toBe(0);
                    expect(msg.payload).toEqual([
                        { valueName: "temp", value: 25, isAnomaly: false, zScore: 0, mean: 25, stdDev: 0 },
                        { valueName: "pressure", value: 1013, isAnomaly: false, zScore: 0, mean: 1013, stdDev: 0 }
                    ]);
                } catch (err) {
                    done(err);
                }
            });

            n3.on("input", function (msg) {
                try {
                    // 11th sample, window of 10: nine 25s and one 40.
                    // mean 26.5, sigma 4.5 -> z = 3; pressure unchanged.
                    expect(normalCount).toBe(10);
                    expect(msg.hasAnomaly).toBe(true);
                    expect(msg.anomalyCount).toBe(1);
                    expect(msg.payload[0].valueName).toBe("temp");
                    expect(msg.payload[0].mean).toBeCloseTo(26.5, 10);
                    expect(msg.payload[0].stdDev).toBeCloseTo(4.5, 10);
                    expect(msg.payload[0].zScore).toBeCloseTo(3, 10);
                    expect(msg.payload[0].isAnomaly).toBe(true);
                    expect(msg.payload[1].isAnomaly).toBe(false);
                    expect(msg.payload[1].zScore).toBe(0);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            // Send normal values to build baseline, then one excursion
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: { temp: 25, pressure: 1013 } });
            }
            n1.receive({ payload: { temp: 40, pressure: 1013 } });
        });
    });

    it("should reset buffers when msg.reset is true", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "analyze",
                windowSize: 10,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");

            for (let i = 0; i < 5; i++) {
                n1.receive({ payload: [10, 20, 30] });
            }

            n1.receive({ reset: true });

            // After reset, node should start fresh
            setTimeout(function () {
                done();
            }, 100);
        });
    });

    it("should calculate Pearson correlation", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "correlate",
                correlationMethod: "pearson",
                sensor1: "x",
                sensor2: "y",
                windowSize: 10,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                // Results start at the 3rd sample; judge the full window
                if (msg.stats.bufferSize < 10) return;
                try {
                    // y = 2x exactly
                    expect(msg.correlation).toBeCloseTo(1, 10);
                    expect(msg.isAnomalous).toBe(false);
                    expect(msg.method).toBe("pearson");
                    expect(msg.sensor1).toBe("x");
                    expect(msg.sensor2).toBe("y");
                    expect(msg.stats).toEqual({ sensor1Mean: 5.5, sensor2Mean: 11, bufferSize: 10 });
                    done();
                } catch (err) {
                    done(err);
                }
            });

            // Send perfectly correlated data (y = x)
            for (let i = 1; i <= 10; i++) {
                n1.receive({ payload: { x: i, y: i * 2 } });
            }
        });
    });

    it("should calculate Spearman correlation", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "correlate",
                correlationMethod: "spearman",
                sensor1: "x",
                sensor2: "y",
                windowSize: 10,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                if (msg.stats.bufferSize < 10) return;
                try {
                    // Monotonic but not linear: rank correlation is exactly 1,
                    // which is what sets it apart from Pearson (~0.975 here)
                    expect(msg.correlation).toBeCloseTo(1, 10);
                    expect(msg.isAnomalous).toBe(false);
                    expect(msg.method).toBe("spearman");
                    done();
                } catch (err) {
                    done(err);
                }
            });

            // Send monotonically related data
            for (let i = 1; i <= 10; i++) {
                n1.receive({ payload: { x: i, y: i * i } }); // Quadratic but monotonic
            }
        });
    });

    it("should calculate Cross-Correlation with time lag", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "correlate",
                correlationMethod: "cross",
                sensor1: "x",
                sensor2: "y",
                windowSize: 20,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                if (msg.stats.bufferSize < 20) return;
                try {
                    expect(msg.method).toBe("cross");
                    // y repeats x two samples later: x leads by 2
                    expect(msg.crossCorrelation.bestLag).toBe(2);
                    expect(msg.crossCorrelation.interpretation).toBe("Signal X leads Signal Y by 2 samples");
                    expect(msg.crossCorrelation.maxCorrelation).toBe(msg.correlation);
                    expect(msg.correlation).toBeGreaterThan(0.9);
                    expect(msg.isAnomalous).toBe(false);
                    // 20 samples -> lags -5..5
                    expect(
                        msg.crossCorrelation.allLags.map(function (l) {
                            return l.lag;
                        })
                    ).toEqual([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            // Send signals with a lag (y is delayed version of x)
            for (let i = 0; i < 20; i++) {
                const x = Math.sin(i * 0.5);
                const y = Math.sin((i - 2) * 0.5); // y lags x by 2 samples
                n1.receive({ payload: { x: x, y: y } });
            }
        });
    });

    it("should aggregate values with different methods", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "aggregate",
                aggregateMethod: "mean",
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                try {
                    expect(msg.payload).toBe(20); // Mean of [10, 20, 30]
                    expect(msg.aggregation.method).toBe("mean");
                    expect(msg.aggregation.value).toBe(20);
                    expect(msg.aggregation.count).toBe(3);
                    expect(msg.aggregation.all.stdDev).toBeCloseTo(Math.sqrt(200 / 3), 10);
                    delete msg.aggregation.all.stdDev;
                    expect(msg.aggregation.all).toEqual({ mean: 20, median: 20, min: 10, max: 30, sum: 60, range: 20 });
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({ payload: { a: 10, b: 20, c: 30 } });
        });
    });

    it("should detect anomalies with Mahalanobis distance", function (done) {
        const flow = [
            {
                id: "n1",
                type: "multi-value-processor",
                name: "test",
                mode: "analyze",
                anomalyMethod: "mahalanobis",
                threshold: 3.0,
                windowSize: 15,
                wires: [["n2"], ["n3"]]
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");

            let normalCount = 0;
            n2.on("input", function (msg) {
                normalCount++;
                try {
                    expect(msg.hasAnomaly).toBe(false);
                    expect(msg.method).toBe("multi-mahalanobis");
                    // Scored from the 11th sample on (10 complete samples of history)
                    expect(msg.payload[0].mahalanobisDistance === undefined).toBe(normalCount <= 10);
                    if (normalCount === 16) {
                        // In the middle of the baseline cloud
                        expect(msg.payload[0].severity).toBe("normal");
                        expect(msg.payload[0].mahalanobisDistance).toBeLessThan(1);
                        expect(msg.payload[0].mahalanobisDistance).toBe(msg.payload[1].mahalanobisDistance);
                        expect(msg.payload[0].mahalanobisThreshold).toBeGreaterThan(
                            msg.payload[0].mahalanobisWarningThreshold
                        );
                    }
                } catch (err) {
                    done(err);
                }
            });

            n3.on("input", function (msg) {
                try {
                    // Only the 17th sample breaks the pattern
                    expect(normalCount).toBe(16);
                    expect(msg.hasAnomaly).toBe(true);
                    expect(msg.anomalyCount).toBe(2); // a multivariate verdict applies to the whole sample
                    expect(msg.payload[0].severity).toBe("critical");
                    expect(msg.payload[0].mahalanobisDistance).toBeGreaterThan(msg.payload[0].mahalanobisThreshold);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            // Deterministic baseline cloud around (25, 1013)
            for (let i = 0; i < 15; i++) {
                n1.receive({
                    payload: { temp: 25 + 0.5 * Math.sin(i * 1.3), pressure: 1013 + 0.5 * Math.cos(i * 2.1) }
                });
            }

            // One sample at the centre, then one far outside
            n1.receive({ payload: { temp: 25, pressure: 1013 } });
            n1.receive({ payload: { temp: 60, pressure: 900 } });
        });
    });
});
