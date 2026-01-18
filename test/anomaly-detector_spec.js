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

    describe('Hysteresis (Anti-Flicker)', function () {
        
        it('should include hysteresis info in output', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", 
                  maxThreshold: 100, warningMargin: 0, hysteresisEnabled: true, consecutiveCount: 1,
                  wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                // Need to fill warmup buffer first (minRequired = 2)
                n1.receive({ payload: 40 }); // warmup 1
                
                n2.on("input", function (msg) {
                    expect(msg).toHaveProperty('hysteresis');
                    expect(msg.hysteresis).toHaveProperty('enabled');
                    expect(msg.hysteresis).toHaveProperty('consecutiveAnomalies');
                    expect(msg.hysteresis).toHaveProperty('consecutiveNormals');
                    done();
                });
                
                n1.receive({ payload: 50 }); // warmup 2 - now outputs
            });
        });

        it('should track consecutive anomaly count', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", 
                  maxThreshold: 100, warningMargin: 0, hysteresisEnabled: true, consecutiveCount: 1,
                  wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n3 = helper.getNode("n3");
                
                // Fill warmup buffer first
                n1.receive({ payload: 40 }); // warmup
                n1.receive({ payload: 50 }); // warmup done
                
                n3.on("input", function (msg) {
                    // After entering anomaly state, check that consecutive counter is tracked
                    expect(msg.hysteresis.consecutiveAnomalies).toBeGreaterThan(0);
                    done();
                });
                
                // Send anomaly
                n1.receive({ payload: 110 });
            });
        });

        it('should track consecutive normal count after anomaly', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", 
                  maxThreshold: 100, warningMargin: 0, hysteresisEnabled: true, consecutiveCount: 1, 
                  hysteresisPercent: 100,
                  wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");
                
                let msgCount = 0;
                
                // Fill warmup buffer first
                n1.receive({ payload: 40 }); // warmup
                
                // Enter anomaly state
                n1.receive({ payload: 110 });
                
                // Listen on both outputs to track messages
                const checkMsg = function(msg) {
                    msgCount++;
                    // After first normal following anomaly, consecutiveNormals should be > 0
                    if (msgCount >= 2 && msg.hysteresis.consecutiveNormals > 0) {
                        expect(msg.hysteresis.consecutiveNormals).toBeGreaterThan(0);
                        done();
                    }
                };
                
                n2.on("input", checkMsg);
                n3.on("input", checkMsg);
                
                // Send normal value - due to hysteresis, may still go to anomaly output
                setTimeout(function() {
                    n1.receive({ payload: 50 });
                }, 50);
            });
        });

        it('should include rawAnomaly flag in output', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", 
                  maxThreshold: 100, warningMargin: 0, hysteresisEnabled: true, consecutiveCount: 1,
                  wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                // Fill warmup buffer first
                n1.receive({ payload: 40 }); // warmup
                
                n2.on("input", function (msg) {
                    // rawAnomaly should always be included
                    expect(msg).toHaveProperty('rawAnomaly');
                    expect(msg.rawAnomaly).toBe(false); // This is a normal value
                    expect(msg.isAnomaly).toBe(false);
                    done();
                });
                
                // Send normal value
                n1.receive({ payload: 50 });
            });
        });
    });

    // ============================================
    // Multi-Sensor JSON Input Tests
    // ============================================

    describe('Multi-Sensor JSON Input', function () {
        
        it('should process JSON object with multiple sensors', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", 
                  zscoreThreshold: 3, windowSize: 10, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                let messageCount = 0;
                n2.on("input", function (msg) {
                    messageCount++;
                    if (messageCount >= 5) {
                        expect(msg).toHaveProperty('payload');
                        expect(msg).toHaveProperty('isAnomaly');
                        expect(msg).toHaveProperty('sensorCount');
                        expect(msg).toHaveProperty('inputFormat', 'multi-sensor');
                        expect(msg.payload).toHaveProperty('temperature');
                        expect(msg.payload).toHaveProperty('pressure');
                        expect(msg.payload.temperature).toHaveProperty('value');
                        expect(msg.payload.temperature).toHaveProperty('isAnomaly');
                        done();
                    }
                });
                
                // Send JSON sensor data
                for (let i = 0; i < 10; i++) {
                    n1.receive({ 
                        payload: {
                            temperature: 65 + Math.random() * 2,
                            pressure: 4.5 + Math.random() * 0.5,
                            vibration: 2.0 + Math.random() * 0.3
                        }
                    });
                }
            });
        });

        it('should detect anomaly in one sensor while others are normal', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", 
                  zscoreThreshold: 2, windowSize: 10, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n3 = helper.getNode("n3"); // Anomaly output
                
                n3.on("input", function (msg) {
                    expect(msg.isAnomaly).toBe(true);
                    expect(msg.anomalySensors).toContain('temperature');
                    expect(msg.payload.temperature.isAnomaly).toBe(true);
                    expect(msg.payload.pressure.isAnomaly).toBe(false);
                    done();
                });
                
                // Build up baseline with normal values
                for (let i = 0; i < 15; i++) {
                    n1.receive({ 
                        payload: {
                            temperature: 65 + Math.random() * 0.5,
                            pressure: 4.5 + Math.random() * 0.1
                        }
                    });
                }
                
                // Send anomalous temperature
                n1.receive({ 
                    payload: {
                        temperature: 95, // Anomaly
                        pressure: 4.5    // Normal
                    }
                });
            });
        });

        it('should track separate buffers per sensor', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", 
                  zscoreThreshold: 3, windowSize: 5, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                let msgCount = 0;
                n2.on("input", function (msg) {
                    msgCount++;
                    if (msgCount === 5) {
                        // After 5 messages, each sensor should have bufferSize of 5
                        expect(msg.payload.sensor1.bufferSize).toBe(5);
                        expect(msg.payload.sensor2.bufferSize).toBe(5);
                        done();
                    }
                });
                
                for (let i = 0; i < 5; i++) {
                    n1.receive({ 
                        payload: {
                            sensor1: 10 + i,
                            sensor2: 20 + i
                        }
                    });
                }
            });
        });

        it('should output anomalySensors array with affected sensors', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", 
                  minThreshold: 0, maxThreshold: 100, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n3 = helper.getNode("n3");
                
                n3.on("input", function (msg) {
                    expect(msg.anomalySensors).toBeInstanceOf(Array);
                    expect(msg.anomalySensors).toContain('temp');
                    expect(msg.anomalySensors).not.toContain('pressure');
                    done();
                });
                
                // Fill buffer
                n1.receive({ payload: { temp: 50, pressure: 50 } });
                n1.receive({ payload: { temp: 50, pressure: 50 } });
                
                // temp exceeds threshold
                n1.receive({ 
                    payload: {
                        temp: 150,    // Above max threshold
                        pressure: 50  // Normal
                    }
                });
            });
        });
    });

    // ============================================
    // Dynamic Configuration via msg.config Tests
    // ============================================

    describe('Dynamic Configuration (msg.config)', function () {
        
        it('should override threshold via msg.config', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", 
                  zscoreThreshold: 3.0, windowSize: 10, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n3 = helper.getNode("n3"); // Anomaly output
                
                n3.on("input", function (msg) {
                    // With lowered threshold (1.5), this should be an anomaly
                    expect(msg.isAnomaly).toBe(true);
                    done();
                });
                
                // Build baseline
                for (let i = 0; i < 10; i++) {
                    n1.receive({ payload: 50 });
                }
                
                // Send value with lowered threshold via msg.config
                // This value would be normal with threshold 3.0, but anomaly with 1.5
                n1.receive({ 
                    payload: 55,  // ~2 std devs away
                    config: { zscoreThreshold: 1.5, zscoreWarning: 1.0 }
                });
            });
        });

        it('should override method via msg.config', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", 
                  windowSize: 10, minThreshold: 0, maxThreshold: 100, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n3 = helper.getNode("n3");
                
                n3.on("input", function (msg) {
                    // Should detect anomaly using threshold method
                    expect(msg.isAnomaly).toBe(true);
                    done();
                });
                
                // Build buffer
                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: 50 });
                }
                
                // Override to threshold method and send value above max
                n1.receive({ 
                    payload: 150,
                    config: { method: "threshold", maxThreshold: 100 }
                });
            });
        });

        it('should use node defaults when msg.config is not provided', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", 
                  minThreshold: 0, maxThreshold: 100, windowSize: 5, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n3 = helper.getNode("n3");
                
                n3.on("input", function (msg) {
                    expect(msg.isAnomaly).toBe(true);
                    expect(msg.severity).toBe("critical");
                    done();
                });
                
                // Fill buffer
                n1.receive({ payload: 50 });
                n1.receive({ payload: 50 });
                
                // Should use node defaults (maxThreshold: 100)
                n1.receive({ payload: 150 });
            });
        });

        it('should override hysteresis settings via msg.config', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "threshold", 
                  minThreshold: 0, maxThreshold: 100, hysteresisEnabled: true, 
                  consecutiveCount: 3, windowSize: 5, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n3 = helper.getNode("n3");
                
                n3.on("input", function (msg) {
                    // With hysteresis disabled via msg.config, should trigger immediately
                    expect(msg.isAnomaly).toBe(true);
                    done();
                });
                
                // Fill buffer
                n1.receive({ payload: 50 });
                n1.receive({ payload: 50 });
                
                // Disable hysteresis via msg.config - should trigger on first anomaly
                n1.receive({ 
                    payload: 150,
                    config: { hysteresisEnabled: false }
                });
            });
        });
    });
});
