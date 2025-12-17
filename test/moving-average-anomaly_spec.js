const helper = require("node-red-node-test-helper");
const maNode = require("../nodes/moving-average-anomaly.js");

helper.init(require.resolve('node-red'));

describe('moving-average-anomaly Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "moving-average-anomaly", name: "Conveyor Belt Speed Monitor" }];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'Conveyor Belt Speed Monitor');
            done();
        });
    });

    it('should pass through values during warmup (window not full)', function (done) {
        const flow = [
            { id: "n1", type: "moving-average-anomaly", name: "ma", windowSize: 10, threshold: 2.0, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let count = 0;
            // Conveyor speed (m/min) during startup
            const startupReadings = [24.8, 25.1, 24.9, 25.2];
            
            n2.on("input", function (msg) {
                count++;
                if (count === startupReadings.length) {
                    expect(msg.payload).toBe(25.2);
                    done();
                }
            });
            
            startupReadings.forEach(val => n1.receive({ payload: val }));
        });
    });

    it('should calculate moving average of conveyor speed correctly', function (done) {
        const flow = [
            { id: "n1", type: "moving-average-anomaly", name: "Conveyor Speed", windowSize: 5, threshold: 10, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Belt speed (m/min) - setpoint 25 m/min with minor variations
            // Need 6 values: first 5 fill the window, 6th triggers moving average calculation
            const speeds = [24.8, 25.1, 24.9, 25.2, 25.0, 25.1];
            let count = 0;
            
            n2.on("input", function (msg) {
                count++;
                if (count === speeds.length && msg.movingAverage !== undefined) {
                    // Moving average of sliding window [25.1, 24.9, 25.2, 25.0, 25.1] = 25.06
                    expect(msg.movingAverage).toBeCloseTo(25.06, 1);
                    done();
                }
            });
            
            speeds.forEach(val => n1.receive({ payload: val }));
        });
    });

    it('should detect belt slippage (speed deviation)', function (done) {
        const flow = [
            { id: "n1", type: "moving-average-anomaly", name: "Belt Speed", windowSize: 10, threshold: 2.0, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Normal belt speed around 25 m/min
            const normalSpeeds = [
                24.8, 25.1, 24.9, 25.2, 25.0, 24.9, 25.1, 25.0, 24.8, 25.2
            ];
            normalSpeeds.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.method).toBe("stddev");
                done();
            });
            
            // Anomaly: Belt slipping - speed dropped to 18.5 m/min (-26%)
            // Indicates: Worn belt, low tension, or overloaded conveyor
            n1.receive({ payload: 18.5 });
        });
    });

    it('should detect flow rate anomaly using percentage method', function (done) {
        const flow = [
            // Alert if flow deviates >15% from moving average
            { id: "n1", type: "moving-average-anomaly", name: "Coolant Flow", windowSize: 10, threshold: 15, method: "percentage", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Coolant flow rate (L/min) - nominal 12 L/min
            const normalFlow = [
                11.8, 12.1, 11.9, 12.2, 12.0, 11.8, 12.1, 11.9, 12.0, 12.1
            ];
            normalFlow.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.method).toBe("percentage");
                expect(msg.deviationPercent).toBeGreaterThan(15);
                done();
            });
            
            // Anomaly: Flow dropped to 9.5 L/min (-20%)
            // Indicates: Filter clogged, pump cavitation, or leak
            n1.receive({ payload: 9.5 });
        });
    });

    it('should track sliding window for production rate monitoring', function (done) {
        const flow = [
            { id: "n1", type: "moving-average-anomaly", name: "Production Rate", windowSize: 5, threshold: 10, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let finalMsg = null;
            // Parts per hour from packaging line
            const productionRates = [120, 122, 118, 121, 119, 123, 120];
            
            n2.on("input", function (msg) {
                finalMsg = msg;
            });
            
            productionRates.forEach(val => n1.receive({ payload: val }));
            
            setTimeout(function() {
                // Window should contain last 5: [119, 121, 119, 123, 120]
                // Wait - actually [118, 121, 119, 123, 120] after sliding
                expect(finalMsg.movingAverage).toBeCloseTo(120.2, 1);
                done();
            }, 100);
        });
    });

    it('should handle sensor malfunction (invalid data)', function (done) {
        const flow = [
            { id: "n1", type: "moving-average-anomaly", name: "ma", windowSize: 5, threshold: 2.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            // Encoder fault - returning error code instead of value
            n1.receive({ payload: "ENC_FAULT" });
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    it('should detect air compressor discharge pressure instability', function (done) {
        const flow = [
            { id: "n1", type: "moving-average-anomaly", name: "Discharge Pressure", windowSize: 20, threshold: 2.5, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Compressor discharge pressure (bar) - setpoint 7.5 bar
            const normalPressure = [
                7.4, 7.5, 7.6, 7.4, 7.5, 7.5, 7.6, 7.4, 7.5, 7.6,
                7.5, 7.4, 7.6, 7.5, 7.4, 7.5, 7.6, 7.5, 7.4, 7.5
            ];
            normalPressure.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(5.8);
                done();
            });
            
            // Anomaly: Pressure dropped to 5.8 bar (-23%)
            // Indicates: Leak in system, unloader valve stuck, or demand exceeded capacity
            n1.receive({ payload: 5.8 });
        });
    });

    it('should monitor tank level with percentage threshold', function (done) {
        const flow = [
            { id: "n1", type: "moving-average-anomaly", name: "Tank Level", windowSize: 10, threshold: 10, method: "percentage", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(maNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Tank level (%) - steady state around 65%
            const normalLevel = [
                64, 65, 66, 64, 65, 66, 65, 64, 66, 65
            ];
            normalLevel.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(52);
                done();
            });
            
            // Anomaly: Level dropped suddenly to 52% (-20%)
            // Indicates: Drain valve opened, large batch withdrawal, or level sensor drift
            n1.receive({ payload: 52 });
        });
    });
});
