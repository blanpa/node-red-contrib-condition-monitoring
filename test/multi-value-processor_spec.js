const helper = require("node-red-node-test-helper");
const multiValueNode = require("../nodes/multi-value-processor.js");

helper.init(require.resolve('node-red'));

describe('multi-value-processor Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "multi-value-processor", name: "Multi-Value Test" }];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'Multi-Value Test');
            done();
        });
    });

    it('should split array values in sequential mode', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "split", outputMode: "sequential", wires: [["n2"], ["n3"]] },
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

    it('should split object values', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "split", outputMode: "parallel", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(Array.isArray(msg.payload)).toBe(true);
                expect(msg.payload.length).toBe(3);
                expect(msg.valueNames).toContain('temp');
                expect(msg.valueNames).toContain('pressure');
                expect(msg.valueNames).toContain('humidity');
                done();
            });
            
            n1.receive({ payload: { temp: 25.5, pressure: 1013, humidity: 60 } });
        });
    });

    it('should analyze values for anomalies', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "analyze", anomalyMethod: "zscore", threshold: 2.5, windowSize: 10, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Send normal values to build baseline
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: { temp: 25, pressure: 1013 } });
            }
            
            n2.on("input", function (msg) {
                expect(Array.isArray(msg.payload)).toBe(true);
                expect(msg).toHaveProperty('hasAnomaly');
                expect(msg).toHaveProperty('anomalyCount');
                done();
            });
            
            n1.receive({ payload: { temp: 25, pressure: 1013 } });
        });
    });

    it('should reset buffers when msg.reset is true', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "analyze", windowSize: 10, wires: [["n2"], ["n3"]] },
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
            setTimeout(function() {
                done();
            }, 100);
        });
    });

    it('should calculate Pearson correlation', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "correlate", correlationMethod: "pearson", sensor1: "x", sensor2: "y", windowSize: 10, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('correlation');
                expect(typeof msg.correlation).toBe('number');
                expect(msg.correlation).toBeGreaterThan(0.9); // Strong positive correlation
                expect(msg.method).toBe('pearson');
                done();
            });
            
            // Send perfectly correlated data (y = x)
            for (let i = 1; i <= 10; i++) {
                n1.receive({ payload: { x: i, y: i * 2 } });
            }
        });
    });

    it('should calculate Spearman correlation', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "correlate", correlationMethod: "spearman", sensor1: "x", sensor2: "y", windowSize: 10, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('correlation');
                expect(typeof msg.correlation).toBe('number');
                expect(msg.method).toBe('spearman');
                done();
            });
            
            // Send monotonically related data
            for (let i = 1; i <= 10; i++) {
                n1.receive({ payload: { x: i, y: i * i } }); // Quadratic but monotonic
            }
        });
    });

    it('should calculate Cross-Correlation with time lag', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "correlate", correlationMethod: "cross", sensor1: "x", sensor2: "y", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('correlation');
                expect(msg).toHaveProperty('crossCorrelation');
                expect(msg.crossCorrelation).toHaveProperty('bestLag');
                expect(msg.crossCorrelation).toHaveProperty('maxCorrelation');
                expect(msg.crossCorrelation).toHaveProperty('interpretation');
                expect(typeof msg.crossCorrelation.bestLag).toBe('number');
                expect(msg.method).toBe('cross');
                done();
            });
            
            // Send signals with a lag (y is delayed version of x)
            for (let i = 0; i < 20; i++) {
                const x = Math.sin(i * 0.5);
                const y = Math.sin((i - 2) * 0.5); // y lags x by 2 samples
                n1.receive({ payload: { x: x, y: y } });
            }
        });
    });

    it('should aggregate values with different methods', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "aggregate", aggregationMethod: "mean", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('aggregation');
                expect(msg.aggregation).toHaveProperty('method', 'mean');
                expect(msg.aggregation).toHaveProperty('value');
                expect(msg.aggregation.value).toBeCloseTo(20, 1); // Mean of [10, 20, 30]
                done();
            });
            
            n1.receive({ payload: { a: 10, b: 20, c: 30 } });
        });
    });

    it('should detect anomalies with Mahalanobis distance', function (done) {
        const flow = [
            { id: "n1", type: "multi-value-processor", name: "test", mode: "analyze", anomalyMethod: "mahalanobis", threshold: 3.0, windowSize: 15, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(multiValueNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                expect(Array.isArray(msg.payload)).toBe(true);
                expect(msg).toHaveProperty('hasAnomaly');
                done();
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send normal values to build baseline
            for (let i = 0; i < 15; i++) {
                n1.receive({ payload: { temp: 25 + Math.random(), pressure: 1013 + Math.random() } });
            }
            
            // Send one more to trigger output
            n1.receive({ payload: { temp: 25.5, pressure: 1013.5 } });
        });
    });
});
