const helper = require("node-red-node-test-helper");
const zscoreNode = require("../nodes/zscore-anomaly.js");

helper.init(require.resolve('node-red'));

describe('zscore-anomaly Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "zscore-anomaly", name: "Motor Temperature Monitor" }];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'Motor Temperature Monitor');
            done();
        });
    });

    it('should pass through first value (cold start)', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 3, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            n2.on("input", function (msg) {
                // First temperature reading from motor - 45.2°C
                expect(msg.payload).toBe(45.2);
                done();
            });
            n1.receive({ payload: 45.2 });
        });
    });

    it('should detect normal motor temperature fluctuations', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 3, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Realistic motor temperature readings (°C) - normal operation with sensor noise
            // Motor running at steady state, slight variations due to ambient temp and load
            const normalTemperatures = [45.2, 45.8, 46.1, 45.5, 45.9, 46.3, 45.7, 46.0, 45.4, 46.2];
            let count = 0;
            
            n2.on("input", function (msg) {
                count++;
                if (count === normalTemperatures.length) {
                    expect(msg.isAnomaly).toBe(false);
                    expect(msg).toHaveProperty('zScore');
                    expect(msg).toHaveProperty('mean');
                    expect(msg).toHaveProperty('stdDev');
                    // Mean should be around 45.8°C
                    expect(msg.mean).toBeCloseTo(45.81, 1);
                    done();
                }
            });
            
            normalTemperatures.forEach(val => n1.receive({ payload: val }));
        });
    });

    it('should detect motor overheating (gradual temperature rise)', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 2.5, windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Build up normal baseline - motor running at 45-47°C
            const normalTemperatures = [
                45.2, 45.8, 46.1, 45.5, 45.9, 46.3, 45.7, 46.0, 45.4, 46.2,
                45.6, 46.1, 45.8, 45.9, 46.0, 45.7, 46.2, 45.5, 46.1, 45.8
            ];
            normalTemperatures.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                // Overheating detected - bearing failure beginning
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(52.5);
                expect(Math.abs(msg.zScore)).toBeGreaterThan(2.5);
                done();
            });
            
            // Anomaly: Temperature spike to 52.5°C (+15% above normal)
            // This indicates potential bearing failure or blocked ventilation
            n1.receive({ payload: 52.5 });
        });
    });

    it('should detect sudden temperature drop (sensor failure or power loss)', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 2.5, windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Normal operating temperatures
            const normalTemperatures = [
                45.2, 45.8, 46.1, 45.5, 45.9, 46.3, 45.7, 46.0, 45.4, 46.2,
                45.6, 46.1, 45.8, 45.9, 46.0, 45.7, 46.2, 45.5, 46.1, 45.8
            ];
            normalTemperatures.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(25.3);
                done();
            });
            
            // Anomaly: Sudden drop to ambient temperature
            // Could indicate: sensor disconnected, motor stopped unexpectedly, or thermal paste failure
            n1.receive({ payload: 25.3 });
        });
    });

    it('should handle invalid payload (sensor communication error)', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 3, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            // Simulate corrupted sensor data
            n1.receive({ payload: "NaN" });
            n1.receive({ payload: "error" });
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    it('should preserve MQTT topic and sensor metadata', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 3, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n1.receive({ 
                payload: 45.2, 
                topic: "factory/line1/motor03/temperature",
                sensorId: "PT100-M03",
                unit: "°C"
            });
            
            n2.on("input", function (msg) {
                expect(msg.topic).toBe("factory/line1/motor03/temperature");
                expect(msg.sensorId).toBe("PT100-M03");
                expect(msg.unit).toBe("°C");
                done();
            });
            
            n1.receive({ 
                payload: 45.8, 
                topic: "factory/line1/motor03/temperature",
                sensorId: "PT100-M03",
                unit: "°C"
            });
        });
    });

    it('should detect vibration anomaly in pump bearing', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "Pump Vibration", threshold: 2.5, windowSize: 30, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Normal vibration readings (mm/s RMS) for a centrifugal pump
            // ISO 10816 Class II: Good condition < 2.8 mm/s
            const normalVibration = [
                2.3, 2.5, 2.4, 2.6, 2.3, 2.5, 2.4, 2.7, 2.4, 2.5,
                2.6, 2.4, 2.5, 2.3, 2.6, 2.5, 2.4, 2.7, 2.5, 2.4,
                2.3, 2.6, 2.5, 2.4, 2.5, 2.6, 2.4, 2.5, 2.3, 2.6
            ];
            normalVibration.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(4.2);
                done();
            });
            
            // Anomaly: Vibration spike to 4.2 mm/s (+75%)
            // Indicates: bearing defect, misalignment, or imbalance
            n1.receive({ payload: 4.2 });
        });
    });

    it('should provide severity level (warning vs critical)', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 3.0, windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Build baseline with tight distribution
            const normalValues = [
                50, 50, 50, 50, 50, 50, 50, 50, 50, 50,
                50, 50, 50, 50, 50, 50, 50, 50, 50, 50
            ];
            normalValues.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg).toHaveProperty('severity');
                expect(['warning', 'critical']).toContain(msg.severity);
                done();
            });
            
            // Send value that triggers anomaly
            n1.receive({ payload: 100 });
        });
    });

    it('should reset buffer when msg.reset is true', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 3.0, windowSize: 10, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Fill buffer with values
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: 50 });
            }
            
            // Reset the node
            n1.receive({ reset: true });
            
            // After reset, first value should pass through without anomaly detection
            n2.on("input", function (msg) {
                // After reset, buffer is empty so value passes through
                expect(msg.payload).toBe(25);
                done();
            });
            
            n1.receive({ payload: 25 });
        });
    });

    it('should include bufferSize and windowSize in output', function (done) {
        const flow = [
            { id: "n1", type: "zscore-anomaly", name: "zscore", threshold: 3.0, windowSize: 50, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(zscoreNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Send some values
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: 50 + i });
            }
            
            n2.on("input", function (msg) {
                expect(msg).toHaveProperty('bufferSize');
                expect(msg).toHaveProperty('windowSize');
                expect(msg.windowSize).toBe(50);
                expect(msg.bufferSize).toBeLessThanOrEqual(50);
                done();
            });
            
            n1.receive({ payload: 55 });
        });
    });
});
