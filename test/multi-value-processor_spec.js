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
});
