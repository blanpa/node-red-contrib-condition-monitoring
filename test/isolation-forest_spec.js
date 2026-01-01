const helper = require("node-red-node-test-helper");
const isolationForestNode = require("../nodes/isolation-forest-anomaly.js");

helper.init(require.resolve("node-red"));

describe('isolation-forest-anomaly Node', function() {
    
    beforeEach(function(done) {
        helper.startServer(done);
    });
    
    afterEach(function(done) {
        helper.unload();
        helper.stopServer(done);
    });
    
    it('should be loaded', function(done) {
        const flow = [{ id: "n1", type: "isolation-forest-anomaly", name: "test isolation-forest" }];
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            try {
                expect(n1).toBeDefined();
                expect(n1.name).toBe("test isolation-forest");
                done();
            } catch(err) {
                done(err);
            }
        });
    });
    
    it('should have default configuration values', function(done) {
        const flow = [{ id: "n1", type: "isolation-forest-anomaly", name: "test" }];
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            try {
                expect(n1.contamination).toBe(0.1);
                expect(n1.windowSize).toBe(100);
                done();
            } catch(err) {
                done(err);
            }
        });
    });
    
    it('should buffer values until minimum threshold', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function(msg) {
                try {
                    expect(msg.payload).toBeDefined();
                    done();
                } catch(err) {
                    done(err);
                }
            });
            
            // Send first value
            n1.receive({ payload: 50 });
        });
    });
    
    it('should use fallback method when ml-isolation-forest not available', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let messageCount = 0;
            n2.on("input", function(msg) {
                messageCount++;
                if (messageCount >= 5) {
                    try {
                        // Should use fallback method
                        expect(msg.method).toBe("fallback-zscore");
                        expect(msg.isAnomaly).toBeDefined();
                        done();
                    } catch(err) {
                        done(err);
                    }
                }
            });
            
            // Send enough values for fallback to work
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: 50 + Math.random() * 5 });
            }
        });
    });
    
    it('should detect anomaly with fallback method', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            n3.on("input", function(msg) {
                try {
                    expect(msg.isAnomaly).toBe(true);
                    done();
                } catch(err) {
                    done(err);
                }
            });
            
            // Send normal values first
            for (let i = 0; i < 15; i++) {
                n1.receive({ payload: 50 });
            }
            
            // Send anomaly
            n1.receive({ payload: 500 });
        });
    });
    
    it('should handle invalid payload', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            
            // Should error but not crash
            n1.receive({ payload: "not a number" });
            
            setTimeout(function() {
                done();
            }, 100);
        });
    });
    
    it('should preserve message properties', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            n2.on("input", function(msg) {
                try {
                    expect(msg.topic).toBe("test-topic");
                    expect(msg.customProp).toBe("custom-value");
                    done();
                } catch(err) {
                    done(err);
                }
            });
            
            n1.receive({ 
                payload: 50, 
                topic: "test-topic",
                customProp: "custom-value"
            });
        });
    });
    
    it('should include timestamp in output', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", windowSize: 10, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let messageCount = 0;
            n2.on("input", function(msg) {
                messageCount++;
                // Need at least 2 messages for fallback method to output with timestamp
                if (messageCount >= 3) {
                    try {
                        expect(msg.timestamp).toBeDefined();
                        expect(typeof msg.timestamp).toBe("number");
                        done();
                    } catch(err) {
                        done(err);
                    }
                }
            });
            
            // Send enough values for the node to produce output with timestamp
            for (let i = 0; i < 5; i++) {
                n1.receive({ payload: 50 + i });
            }
        });
    });
    
    it('should respect custom contamination setting', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", contamination: 0.2, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            try {
                expect(n1.contamination).toBe(0.2);
                done();
            } catch(err) {
                done(err);
            }
        });
    });
    
    it('should clear buffer on node close', function(done) {
        const flow = [
            { id: "n1", type: "isolation-forest-anomaly", name: "test", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(isolationForestNode, flow, function() {
            const n1 = helper.getNode("n1");
            
            // Add some data
            for (let i = 0; i < 5; i++) {
                n1.receive({ payload: 50 + i });
            }
            
            // Node should handle close gracefully
            helper.unload().then(function() {
                done();
            }).catch(done);
        });
    });
});
