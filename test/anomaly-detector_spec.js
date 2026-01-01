const helper = require("node-red-node-test-helper");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");

helper.init(require.resolve('node-red'));

describe('anomaly-detector Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "anomaly-detector", name: "Motor Temperature Monitor" }];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'Motor Temperature Monitor');
            done();
        });
    });

    it('should pass through first value (cold start) with zscore method', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", zscoreThreshold: 3, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            n2.on("input", function (msg) {
                expect(msg.payload).toBe(45.2);
                done();
            });
            n1.receive({ payload: 45.2 });
        });
    });

    it('should detect anomaly with zscore method', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", zscoreThreshold: 2.5, zscoreWarning: 2.0, windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            const normalTemperatures = [
                45.2, 45.8, 46.1, 45.5, 45.9, 46.3, 45.7, 46.0, 45.4, 46.2,
                45.6, 46.1, 45.8, 45.9, 46.0, 45.7, 46.2, 45.5, 46.1, 45.8
            ];
            normalTemperatures.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(52.5);
                expect(Math.abs(msg.zScore)).toBeGreaterThan(2.5);
                done();
            });
            
            n1.receive({ payload: 52.5 });
        });
    });

    it('should detect anomaly with iqr method', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "iqr", iqrMultiplier: 1.5, windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            const normalValues = [
                10, 11, 10, 12, 11, 10, 11, 12, 10, 11,
                10, 11, 10, 12, 11, 10, 11, 12, 10, 11
            ];
            normalValues.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(50);
                done();
            });
            
            n1.receive({ payload: 50 });
        });
    });

    it('should detect anomaly with threshold method', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", minThreshold: 0, maxThreshold: 100, windowSize: 10, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Send some normal values first
            n1.receive({ payload: 50 });
            n1.receive({ payload: 50 });
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(150);
                done();
            });
            
            n1.receive({ payload: 150 });
        });
    });

    it('should detect anomaly with percentile method', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "percentile", lowerPercentile: 5, upperPercentile: 95, windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            const normalValues = [
                10, 11, 10, 12, 11, 10, 11, 12, 10, 11,
                10, 11, 10, 12, 11, 10, 11, 12, 10, 11
            ];
            normalValues.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(100);
                done();
            });
            
            n1.receive({ payload: 100 });
        });
    });

    it('should reset buffer when msg.reset is true', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", zscoreThreshold: 3.0, windowSize: 10, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: 50 });
            }
            
            n1.receive({ reset: true });
            
            n2.on("input", function (msg) {
                expect(msg.payload).toBe(25);
                done();
            });
            
            n1.receive({ payload: 25 });
        });
    });

    it('should include method and bufferSize in output', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", windowSize: 50, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: 50 + i });
            }
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('method');
                expect(msg).toHaveProperty('bufferSize');
                expect(msg).toHaveProperty('windowSize');
                expect(msg.method).toBe('zscore');
                done();
            });
            
            n1.receive({ payload: 55 });
        });
    });

    it('should handle invalid payload', function (done) {
        const flow = [
            { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(anomalyDetectorNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            n1.receive({ payload: "NaN" });
            n1.receive({ payload: "error" });
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });
});
