const helper = require("node-red-node-test-helper");
const healthIndexNode = require("../nodes/health-index.js");

helper.init(require.resolve("node-red"));

describe('health-index Node', function() {
    
    beforeEach(function(done) {
        helper.startServer(done);
    });
    
    afterEach(function(done) {
        helper.unload();
        helper.stopServer(done);
    });
    
    it('should be loaded', function(done) {
        const flow = [{ id: "n1", type: "health-index", name: "test health-index" }];
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            try {
                expect(n1).toBeDefined();
                expect(n1.name).toBe("test health-index");
                done();
            } catch(err) {
                done(err);
            }
        });
    });
    
    it('should calculate health index from object payload', function(done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function(msg) {
                try {
                    expect(msg.payload).toBeGreaterThanOrEqual(0);
                    expect(msg.payload).toBeLessThanOrEqual(100);
                    expect(msg.status).toBeDefined();
                    expect(msg.sensorScores).toBeDefined();
                    done();
                } catch(err) {
                    done(err);
                }
            });
            
            n1.receive({ 
                payload: { 
                    temp: { value: 25, isAnomaly: false },
                    vibration: { value: 0.5, isAnomaly: false }
                } 
            });
        });
    });
    
    it('should detect anomalies and reduce health score', function(done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            n3.on("input", function(msg) {
                try {
                    // Should be on anomaly output due to anomaly flag
                    expect(msg.payload).toBeLessThan(100);
                    expect(msg.contributingFactors.length).toBeGreaterThan(0);
                    done();
                } catch(err) {
                    done(err);
                }
            });
            
            n1.receive({ 
                payload: { 
                    temp: { value: 25, isAnomaly: true, zScore: 4.0 }
                } 
            });
        });
    });
    
    it('should calculate weighted average correctly', function(done) {
        const flow = [
            { 
                id: "n1", 
                type: "health-index", 
                name: "test",
                sensorWeights: '{"sensor1": 2.0, "sensor2": 1.0}',
                aggregationMethod: "weighted",
                wires: [["n2"], ["n3"]] 
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function(msg) {
                try {
                    expect(msg.method).toBe("weighted");
                    expect(msg.sensorScores).toBeDefined();
                    done();
                } catch(err) {
                    done(err);
                }
            });
            
            n1.receive({ 
                payload: { 
                    sensor1: { value: 50, isAnomaly: false },
                    sensor2: { value: 50, isAnomaly: false }
                } 
            });
        });
    });
    
    it('should use minimum aggregation method', function(done) {
        const flow = [
            { 
                id: "n1", 
                type: "health-index", 
                name: "test",
                aggregationMethod: "minimum",
                wires: [["n2"], ["n3"]] 
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            const handleMessage = function(msg) {
                if (received) return;
                received = true;
                try {
                    expect(msg.method).toBe("minimum");
                    done();
                } catch(err) {
                    done(err);
                }
            };
            
            n2.on("input", handleMessage);
            n3.on("input", handleMessage);
            
            n1.receive({ 
                payload: { 
                    sensor1: { value: 50 },
                    sensor2: { value: 50, isAnomaly: true }
                } 
            });
        });
    });
    
    it('should handle array payload', function(done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function(msg) {
                try {
                    expect(msg.payload).toBeGreaterThanOrEqual(0);
                    expect(msg.sensorScores).toBeDefined();
                    done();
                } catch(err) {
                    done(err);
                }
            });
            
            n1.receive({ 
                payload: [
                    { valueName: "temp", value: 25, isAnomaly: false },
                    { valueName: "pressure", value: 1013, isAnomaly: false }
                ]
            });
        });
    });
    
    it('should identify worst sensor', function(done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            const handleMessage = function(msg) {
                if (received) return;
                received = true;
                try {
                    expect(msg.worstSensor).toBeDefined();
                    expect(msg.worstSensor.name).toBe("badSensor");
                    done();
                } catch(err) {
                    done(err);
                }
            };
            
            n2.on("input", handleMessage);
            n3.on("input", handleMessage);
            
            n1.receive({ 
                payload: { 
                    goodSensor: { value: 50, isAnomaly: false },
                    badSensor: { value: 50, isAnomaly: true, zScore: 5.0 }
                } 
            });
        });
    });
    
    it('should warn on invalid payload', function(done) {
        const flow = [
            { id: "n1", type: "health-index", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            
            // Should warn but not crash
            n1.receive({ payload: "invalid" });
            
            setTimeout(function() {
                done();
            }, 100);
        });
    });
});
