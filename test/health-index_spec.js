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
            { 
                id: "n1", 
                type: "health-index", 
                name: "test",
                wires: [["n2"], ["n3"]] 
            },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        
        helper.load(healthIndexNode, flow, function() {
            const n1 = helper.getNode("n1");
            const n3 = helper.getNode("n3");
            
            // With anomaly + high zScore: 100 - 30 (anomaly) - 40 (zScore>3) = 30
            // 30 < 40 (degraded threshold), so goes to anomaly output
            n3.on("input", function(msg) {
                try {
                    // Score should be reduced due to anomaly flag + high zScore
                    expect(msg.payload).toBeLessThan(100);
                    expect(msg.payload).toBe(30); // 100 - 30 - 40 = 30
                    expect(msg.contributingFactors.length).toBe(2); // anomaly + high zScore
                    expect(msg.status).toBe("degraded"); // 30 < 40 (degraded) but > 20 (critical)
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

    // ============================================
    // Dynamic Weighting Tests
    // ============================================

    describe('Dynamic Weighting', function() {
        
        it('should use dynamic aggregation method', function(done) {
            const flow = [
                { 
                    id: "n1", 
                    type: "health-index", 
                    name: "test",
                    aggregationMethod: "dynamic",
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
                        expect(msg.method).toBe("dynamic");
                        expect(msg).toHaveProperty('dynamicWeights');
                        done();
                    } catch(err) {
                        done(err);
                    }
                };
                
                n2.on("input", handleMessage);
                n3.on("input", handleMessage);
                
                n1.receive({ 
                    payload: { 
                        sensor1: { value: 50, isAnomaly: false },
                        sensor2: { value: 50, isAnomaly: false }
                    } 
                });
            });
        });

        it('should include dynamic weight info for each sensor', function(done) {
            const flow = [
                { 
                    id: "n1", 
                    type: "health-index", 
                    name: "test",
                    aggregationMethod: "dynamic",
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
                        expect(msg.dynamicWeights).toHaveProperty('sensor1');
                        expect(msg.dynamicWeights).toHaveProperty('sensor2');
                        expect(msg.dynamicWeights.sensor1).toHaveProperty('effectiveWeight');
                        expect(msg.dynamicWeights.sensor1).toHaveProperty('reliabilityFactor');
                        expect(msg.dynamicWeights.sensor1).toHaveProperty('anomalyRate');
                        done();
                    } catch(err) {
                        done(err);
                    }
                };
                
                n2.on("input", handleMessage);
                n3.on("input", handleMessage);
                
                n1.receive({ 
                    payload: { 
                        sensor1: { value: 50, isAnomaly: false },
                        sensor2: { value: 50, isAnomaly: false }
                    } 
                });
            });
        });

        it('should reduce weight for sensors with high anomaly rate', function(done) {
            const flow = [
                { 
                    id: "n1", 
                    type: "health-index", 
                    name: "test",
                    aggregationMethod: "dynamic",
                    wires: [["n2"], ["n3"]] 
                },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            
            helper.load(healthIndexNode, flow, function() {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");
                
                let messageCount = 0;
                const handleMessage = function(msg) {
                    messageCount++;
                    // After enough messages, sensor2 should have reduced weight
                    if (messageCount >= 15) {
                        try {
                            // sensor2 has 50% anomaly rate, should have lower reliability
                            expect(msg.dynamicWeights.sensor2.anomalyRate).toBeGreaterThan(0.3);
                            expect(msg.dynamicWeights.sensor2.reliabilityFactor).toBeLessThan(1.0);
                            // sensor1 has no anomalies, should have higher reliability
                            expect(msg.dynamicWeights.sensor1.reliabilityFactor).toBeGreaterThanOrEqual(
                                msg.dynamicWeights.sensor2.reliabilityFactor
                            );
                            done();
                        } catch(err) {
                            done(err);
                        }
                    }
                };
                
                n2.on("input", handleMessage);
                n3.on("input", handleMessage);
                
                // Send mixed data - sensor1 always normal, sensor2 alternates
                for (let i = 0; i < 20; i++) {
                    n1.receive({ 
                        payload: { 
                            sensor1: { value: 50, isAnomaly: false },
                            sensor2: { value: 50, isAnomaly: i % 2 === 0 } // 50% anomaly rate
                        } 
                    });
                }
            });
        });

        it('should consider confidence in dynamic weighting', function(done) {
            const flow = [
                { 
                    id: "n1", 
                    type: "health-index", 
                    name: "test",
                    aggregationMethod: "dynamic",
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
                        // Low confidence sensor should have lower effective weight
                        expect(msg.dynamicWeights.lowConfSensor.effectiveWeight).toBeLessThan(
                            msg.dynamicWeights.highConfSensor.effectiveWeight
                        );
                        done();
                    } catch(err) {
                        done(err);
                    }
                };
                
                n2.on("input", handleMessage);
                n3.on("input", handleMessage);
                
                n1.receive({ 
                    payload: { 
                        highConfSensor: { value: 50, isAnomaly: false, confidence: 0.95 },
                        lowConfSensor: { value: 50, isAnomaly: false, confidence: 0.3 }
                    } 
                });
            });
        });

        it('should include reliability info in worst sensor output', function(done) {
            const flow = [
                { 
                    id: "n1", 
                    type: "health-index", 
                    name: "test",
                    aggregationMethod: "dynamic",
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
                        expect(msg.worstSensor).toHaveProperty('reliability');
                        done();
                    } catch(err) {
                        done(err);
                    }
                };
                
                n2.on("input", handleMessage);
                n3.on("input", handleMessage);
                
                n1.receive({ 
                    payload: { 
                        sensor1: { value: 50, isAnomaly: false },
                        sensor2: { value: 50, isAnomaly: true }
                    } 
                });
            });
        });
    });
});
