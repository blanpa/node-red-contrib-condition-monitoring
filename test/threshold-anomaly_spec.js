const helper = require("node-red-node-test-helper");
const thresholdNode = require("../nodes/threshold-anomaly.js");

helper.init(require.resolve('node-red'));

describe('threshold-anomaly Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "threshold-anomaly", name: "Hydraulic Pressure Monitor" }];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'Hydraulic Pressure Monitor');
            done();
        });
    });

    it('should pass normal hydraulic pressure (within operating range)', function (done) {
        const flow = [
            // Hydraulic system: Operating range 150-250 bar
            { id: "n1", type: "threshold-anomaly", name: "threshold", minThreshold: 150, maxThreshold: 250, inclusive: false, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                // Normal operating pressure
                expect(msg.payload).toBe(195);
                expect(msg.isAnomaly).toBe(false);
                done();
            });
            
            n1.receive({ payload: 195 });
        });
    });

    it('should detect low hydraulic pressure (pump failure or leak)', function (done) {
        const flow = [
            { id: "n1", type: "threshold-anomaly", name: "threshold", minThreshold: 150, maxThreshold: 250, inclusive: false, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            n3.on("input", function (msg) {
                // Pressure dropped to 120 bar - indicates leak or pump wear
                expect(msg.payload).toBe(120);
                expect(msg.isAnomaly).toBe(true);
                expect(msg.reason).toContain("Below");
                done();
            });
            
            n1.receive({ payload: 120 });
        });
    });

    it('should detect high hydraulic pressure (blockage or valve stuck)', function (done) {
        const flow = [
            { id: "n1", type: "threshold-anomaly", name: "threshold", minThreshold: 150, maxThreshold: 250, inclusive: false, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            n3.on("input", function (msg) {
                // Pressure spike to 285 bar - relief valve may have failed
                expect(msg.payload).toBe(285);
                expect(msg.isAnomaly).toBe(true);
                expect(msg.reason).toContain("Above");
                done();
            });
            
            n1.receive({ payload: 285 });
        });
    });

    it('should detect motor current at trip level (overload protection)', function (done) {
        const flow = [
            // Motor rated 12A, trip at 15A (125% of rated)
            { id: "n1", type: "threshold-anomaly", name: "Motor Current", minThreshold: 2, maxThreshold: 15, inclusive: true, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            n3.on("input", function (msg) {
                // At trip level - motor overloaded
                expect(msg.payload).toBe(15);
                expect(msg.isAnomaly).toBe(true);
                done();
            });
            
            n1.receive({ payload: 15 });
        });
    });

    it('should detect bearing temperature at warning level', function (done) {
        const flow = [
            // Bearing: Warning at 80°C, Alarm at 90°C
            { id: "n1", type: "threshold-anomaly", name: "Bearing Temp", minThreshold: 20, maxThreshold: 80, inclusive: true, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            n3.on("input", function (msg) {
                // At warning threshold
                expect(msg.payload).toBe(80);
                expect(msg.isAnomaly).toBe(true);
                done();
            });
            
            n1.receive({ payload: 80 });
        });
    });

    it('should monitor oil level (low level alarm only)', function (done) {
        const flow = [
            // Oil tank: Only care about low level (min 20%)
            { id: "n1", type: "threshold-anomaly", name: "Oil Level", minThreshold: 20, maxThreshold: "", inclusive: false, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                // 95% full - no problem even though it's high
                expect(msg.payload).toBe(95);
                expect(msg.isAnomaly).toBe(false);
                done();
            });
            
            n1.receive({ payload: 95 });
        });
    });

    it('should monitor tank pressure (high pressure alarm only)', function (done) {
        const flow = [
            // Pressure vessel: Max 10 bar, no minimum concern
            { id: "n1", type: "threshold-anomaly", name: "Tank Pressure", minThreshold: "", maxThreshold: 10, inclusive: false, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                // Vacuum condition - no alarm needed
                expect(msg.payload).toBe(-0.5);
                expect(msg.isAnomaly).toBe(false);
                done();
            });
            
            n1.receive({ payload: -0.5 });
        });
    });

    it('should handle sensor communication failure', function (done) {
        const flow = [
            { id: "n1", type: "threshold-anomaly", name: "threshold", minThreshold: 0, maxThreshold: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            // Modbus communication error - no valid reading
            n1.receive({ payload: "COMM_ERROR" });
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    it('should detect coolant flow rate too low', function (done) {
        const flow = [
            // Coolant flow: Min 5 L/min required for adequate cooling
            { id: "n1", type: "threshold-anomaly", name: "Coolant Flow", minThreshold: 5, maxThreshold: 50, inclusive: false, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(thresholdNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            n3.on("input", function (msg) {
                // Flow dropped to 3.2 L/min - pump failing or blockage
                expect(msg.payload).toBe(3.2);
                expect(msg.isAnomaly).toBe(true);
                expect(msg.reason).toContain("Below");
                done();
            });
            
            n1.receive({ payload: 3.2 });
        });
    });
});
