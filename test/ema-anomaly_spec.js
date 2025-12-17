const helper = require("node-red-node-test-helper");
const emaNode = require("../nodes/ema-anomaly.js");

helper.init(require.resolve('node-red'));

describe('ema-anomaly Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "ema-anomaly", name: "CNC Spindle Load Monitor" }];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'CNC Spindle Load Monitor');
            done();
        });
    });

    it('should initialize EMA with first spindle load reading', function (done) {
        const flow = [
            { id: "n1", type: "ema-anomaly", name: "ema", alpha: 0.3, threshold: 2.0, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function (msg) {
                // First spindle load reading after tool change
                expect(msg.payload).toBe(45);
                done();
            });
            
            // Spindle load % during aluminum milling
            n1.receive({ payload: 45 });
        });
    });

    it('should track spindle load during normal machining cycle', function (done) {
        const flow = [
            { id: "n1", type: "ema-anomaly", name: "Spindle Load", alpha: 0.3, threshold: 10, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let count = 0;
            // Spindle load (%) during roughing operation - varies with cut depth
            const normalLoad = [45, 48, 52, 47, 50, 53, 48, 51, 49, 52];
            
            n2.on("input", function (msg) {
                count++;
                if (count === normalLoad.length) {
                    expect(msg).toHaveProperty('ema');
                    // EMA should be tracking around 49-50%
                    expect(msg.ema).toBeGreaterThan(45);
                    expect(msg.ema).toBeLessThan(55);
                    done();
                }
            });
            
            normalLoad.forEach(val => n1.receive({ payload: val }));
        });
    });

    it('should detect tool wear (gradual load increase)', function (done) {
        const flow = [
            { id: "n1", type: "ema-anomaly", name: "Spindle Load", alpha: 0.2, threshold: 2.0, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Build up baseline during normal cutting
            const normalLoad = [
                45, 47, 46, 48, 45, 47, 46, 48, 45, 47,
                46, 48, 45, 47, 46, 48, 45, 47, 46, 48
            ];
            normalLoad.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.method).toBe("ema-stddev");
                done();
            });
            
            // Anomaly: Spindle load jumped to 72% - tool is dull
            // Normal range 45-48%, sudden jump indicates worn cutting edge
            n1.receive({ payload: 72 });
        });
    });

    it('should detect tool breakage (sudden load drop)', function (done) {
        const flow = [
            { id: "n1", type: "ema-anomaly", name: "Spindle Load", alpha: 0.2, threshold: 2.0, method: "stddev", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Normal cutting load
            const normalLoad = [
                45, 47, 46, 48, 45, 47, 46, 48, 45, 47,
                46, 48, 45, 47, 46, 48, 45, 47, 46, 48
            ];
            normalLoad.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(12);
                done();
            });
            
            // Anomaly: Load dropped to 12% - tool broke, no longer cutting
            n1.receive({ payload: 12 });
        });
    });

    it('should detect power consumption anomaly using percentage method', function (done) {
        const flow = [
            // Power monitoring - alert if >25% deviation from EMA
            { id: "n1", type: "ema-anomaly", name: "Power", alpha: 0.3, threshold: 25, method: "percentage", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Power consumption (kW) during production
            const normalPower = [85, 87, 84, 88, 86, 85, 87, 86, 84, 88];
            normalPower.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.method).toBe("ema-percentage");
                expect(msg.deviationPercent).toBeGreaterThan(25);
                done();
            });
            
            // Anomaly: Power spiked to 125 kW (+45%)
            // Indicates: Mechanical binding, process upset, or electrical fault
            n1.receive({ payload: 125 });
        });
    });

    it('should handle sensor communication error', function (done) {
        const flow = [
            { id: "n1", type: "ema-anomaly", name: "ema", alpha: 0.3, threshold: 2.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            // PLC communication timeout
            n1.receive({ payload: "timeout" });
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    it('should preserve OPC-UA node metadata', function (done) {
        const flow = [
            // Use small windowSize so we get full output quickly
            { id: "n1", type: "ema-anomaly", name: "ema", alpha: 0.3, threshold: 2.0, method: "stddev", windowSize: 5, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Send enough values to fill window and get proper output with metadata
            const values = [45, 47, 46, 48, 45, 47];
            let lastMsg = null;
            
            n2.on("input", function (msg) {
                lastMsg = msg;
            });
            
            values.forEach(val => {
                n1.receive({ payload: val, nodeId: "ns=2;s=CNC.Spindle.Load", sourceTimestamp: "2024-01-15T10:30:00Z", quality: "Good" });
            });
            
            setTimeout(function() {
                expect(lastMsg.nodeId).toBe("ns=2;s=CNC.Spindle.Load");
                expect(lastMsg.sourceTimestamp).toBe("2024-01-15T10:30:00Z");
                expect(lastMsg.quality).toBe("Good");
                done();
            }, 100);
        });
    });

    it('should detect HVAC chiller performance degradation', function (done) {
        const flow = [
            { id: "n1", type: "ema-anomaly", name: "Chiller COP", alpha: 0.2, threshold: 15, method: "percentage", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(emaNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Coefficient of Performance - efficiency metric
            const normalCOP = [4.2, 4.3, 4.1, 4.4, 4.2, 4.3, 4.1, 4.2, 4.3, 4.2];
            normalCOP.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(3.2);
                done();
            });
            
            // Anomaly: COP dropped to 3.2 (-25%)
            // Indicates: Refrigerant leak, fouled condenser, or compressor issue
            n1.receive({ payload: 3.2 });
        });
    });
});
