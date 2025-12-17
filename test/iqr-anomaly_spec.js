const helper = require("node-red-node-test-helper");
const iqrNode = require("../nodes/iqr-anomaly.js");

helper.init(require.resolve('node-red'));

describe('iqr-anomaly Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "iqr-anomaly", name: "Compressor Vibration Monitor" }];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'Compressor Vibration Monitor');
            done();
        });
    });

    it('should pass through values during warmup period (< 4 samples)', function (done) {
        const flow = [
            { id: "n1", type: "iqr-anomaly", name: "iqr", multiplier: 1.5, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let count = 0;
            // First few readings after system startup - not enough data for IQR
            const startupReadings = [3.2, 3.4, 3.3];
            
            n2.on("input", function (msg) {
                count++;
                if (count === 3) {
                    expect(msg.payload).toBe(3.3);
                    done();
                }
            });
            
            startupReadings.forEach(val => n1.receive({ payload: val }));
        });
    });

    it('should detect normal compressor current variations', function (done) {
        const flow = [
            { id: "n1", type: "iqr-anomaly", name: "Compressor Current", multiplier: 1.5, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Compressor motor current (A) - normal load variations during operation
            // Typical reciprocating compressor shows ~10% variation during cycle
            const normalCurrents = [12.1, 12.5, 12.3, 12.8, 12.2, 12.6, 12.4, 12.7, 12.3, 12.5];
            let count = 0;
            
            n2.on("input", function (msg) {
                count++;
                if (count === normalCurrents.length) {
                    expect(msg.isAnomaly).toBe(false);
                    expect(msg).toHaveProperty('q1');
                    expect(msg).toHaveProperty('q3');
                    expect(msg).toHaveProperty('iqr');
                    expect(msg).toHaveProperty('lowerBound');
                    expect(msg).toHaveProperty('upperBound');
                    done();
                }
            });
            
            normalCurrents.forEach(val => n1.receive({ payload: val }));
        });
    });

    it('should detect current spike (mechanical jam or electrical fault)', function (done) {
        const flow = [
            { id: "n1", type: "iqr-anomaly", name: "Compressor Current", multiplier: 1.5, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Build up normal baseline - compressor drawing 12-13A
            const normalCurrents = [
                12.1, 12.5, 12.3, 12.8, 12.2, 12.6, 12.4, 12.7, 12.3, 12.5,
                12.4, 12.6, 12.2, 12.5, 12.3, 12.7, 12.4, 12.6, 12.5, 12.3
            ];
            normalCurrents.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(18.5);
                done();
            });
            
            // Anomaly: Current spike to 18.5A (+50%)
            // Indicates: Mechanical jam, liquid slugging, or failing motor winding
            n1.receive({ payload: 18.5 });
        });
    });

    it('should detect current drop (belt slip or coupling failure)', function (done) {
        const flow = [
            { id: "n1", type: "iqr-anomaly", name: "Compressor Current", multiplier: 1.5, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // Normal operating current
            const normalCurrents = [
                12.1, 12.5, 12.3, 12.8, 12.2, 12.6, 12.4, 12.7, 12.3, 12.5,
                12.4, 12.6, 12.2, 12.5, 12.3, 12.7, 12.4, 12.6, 12.5, 12.3
            ];
            normalCurrents.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(8.2);
                done();
            });
            
            // Anomaly: Current dropped to 8.2A (-35%)
            // Indicates: Belt slipping, coupling sheared, or unloaded condition
            n1.receive({ payload: 8.2 });
        });
    });

    it('should handle sensor malfunction (invalid data)', function (done) {
        const flow = [
            { id: "n1", type: "iqr-anomaly", name: "iqr", multiplier: 1.5, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            // CT sensor disconnected - returning invalid readings
            n1.receive({ payload: "open_circuit" });
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    it('should use stricter multiplier for critical equipment', function (done) {
        const flow = [
            // Multiplier 1.0 = stricter detection for critical turbine
            { id: "n1", type: "iqr-anomaly", name: "Turbine Vibration", multiplier: 1.0, windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Turbine vibration (mm/s) - very tight tolerance
            const normalVibration = [
                1.2, 1.3, 1.2, 1.4, 1.3, 1.2, 1.3, 1.4, 1.2, 1.3,
                1.3, 1.2, 1.4, 1.3, 1.2, 1.3, 1.4, 1.2, 1.3, 1.2
            ];
            normalVibration.forEach(val => n1.receive({ payload: val }));
            
            // With multiplier 1.0, even 1.8 mm/s might be flagged
            // With multiplier 3.0, only extreme values would be flagged
            n2.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(false);
                expect(msg.multiplier).toBe(1.0);
                done();
            });
            
            // 1.5 mm/s is still within acceptable range even with strict multiplier
            n1.receive({ payload: 1.5 });
        });
    });

    it('should detect process variable outlier in batch production', function (done) {
        const flow = [
            { id: "n1", type: "iqr-anomaly", name: "Batch pH", multiplier: 1.5, windowSize: 50, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(iqrNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // pH readings during fermentation - should stay in narrow range
            const normalPH = [
                6.8, 6.9, 6.8, 6.7, 6.9, 6.8, 6.8, 6.9, 6.7, 6.8,
                6.9, 6.8, 6.7, 6.8, 6.9, 6.8, 6.8, 6.7, 6.9, 6.8
            ];
            normalPH.forEach(val => n1.receive({ payload: val }));
            
            n3.on("input", function (msg) {
                expect(msg.isAnomaly).toBe(true);
                expect(msg.payload).toBe(5.2);
                done();
            });
            
            // Anomaly: pH dropped to 5.2 - contamination or acid spill
            n1.receive({ payload: 5.2 });
        });
    });
});
