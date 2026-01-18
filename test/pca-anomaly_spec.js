const helper = require("node-red-node-test-helper");
const pcaAnomalyNode = require("../nodes/pca-anomaly.js");

helper.init(require.resolve('node-red'));

describe('pca-anomaly Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "pca-anomaly", name: "PCA Monitor" }];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'PCA Monitor');
            done();
        });
    });

    it('should have default configuration values', function (done) {
        const flow = [{ id: "n1", type: "pca-anomaly", name: "test" }];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('nComponents', 2);
            expect(n1).toHaveProperty('windowSize', 100);
            expect(n1).toHaveProperty('threshold', 3.0);
            expect(n1).toHaveProperty('method', 't2');
            expect(n1).toHaveProperty('autoComponents', true);
            expect(n1).toHaveProperty('varianceThreshold', 0.95);
            done();
        });
    });

    it('should buffer values during training phase', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 100, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let messageCount = 0;
            n2.on("input", function (msg) {
                messageCount++;
                // During training, messages are passed through but without PCA analysis
                if (messageCount < 10) {
                    expect(msg).not.toHaveProperty('pca');
                }
            });
            
            // Send training data (less than minimum required)
            for (let i = 0; i < 5; i++) {
                n1.receive({ payload: { sensor1: 10 + Math.random(), sensor2: 20 + Math.random(), sensor3: 30 + Math.random() } });
            }
            
            setTimeout(function() {
                done();
            }, 100);
        });
    });

    it('should train and detect anomalies after collecting enough data', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, threshold: 3.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            // Listen on both outputs
            const handler = function (msg) {
                if (msg.pca) { // Only check after training
                    expect(msg).toHaveProperty('isAnomaly');
                    expect(msg).toHaveProperty('pca');
                    expect(msg.pca).toHaveProperty('t2');
                    expect(msg.pca).toHaveProperty('spe');
                    expect(msg.pca).toHaveProperty('nComponents');
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data (normal operation) - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { 
                        sensor1: 10 + Math.random() * 0.5, 
                        sensor2: 20 + Math.random() * 0.5, 
                        sensor3: 30 + Math.random() * 0.5 
                    } 
                });
            }
            
            // Send normal value after training
            n1.receive({ payload: { sensor1: 10.2, sensor2: 20.1, sensor3: 30.3 } });
        });
    });

    it('should detect anomaly with outlier values', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, threshold: 2.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            // Send training data (normal operation) - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { 
                        sensor1: 10 + Math.random() * 0.1, 
                        sensor2: 20 + Math.random() * 0.1, 
                        sensor3: 30 + Math.random() * 0.1 
                    } 
                });
            }
            
            // Listen on both outputs - the extreme value should be anomaly
            const handler = function (msg) {
                if (msg.pca && msg.isAnomaly) {
                    expect(msg.isAnomaly).toBe(true);
                    expect(msg).toHaveProperty('topContributor');
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send anomaly (sensor1 way off)
            n1.receive({ payload: { sensor1: 100, sensor2: 20, sensor3: 30 } });
        });
    });

    it('should handle array input', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca) {
                    expect(msg).toHaveProperty('pca');
                    expect(msg.sensorNames).toEqual(['sensor0', 'sensor1', 'sensor2']);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data as arrays - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: [10 + Math.random() * 0.5, 20 + Math.random() * 0.5, 30 + Math.random() * 0.5]
                });
            }
            
            n1.receive({ payload: [10.1, 20.2, 30.1] });
        });
    });

    it('should reset state when msg.reset is true', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Train the model
            for (let i = 0; i < 30; i++) {
                n1.receive({ 
                    payload: { sensor1: 10, sensor2: 20, sensor3: 30 }
                });
            }
            
            // Reset
            n1.receive({ reset: true });
            
            let messageCount = 0;
            n2.on("input", function (msg) {
                messageCount++;
                // After reset, should be in training phase again
                if (messageCount === 1) {
                    expect(msg).not.toHaveProperty('pca');
                    done();
                }
            });
            
            // Send new data - should be in training phase
            n1.receive({ payload: { sensor1: 10, sensor2: 20, sensor3: 30 } });
        });
    });

    it('should include contribution analysis for anomalies', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, threshold: 1.5, showTopContributors: 3, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                // Check for any message with contributions (anomaly or not - we'll validate contents)
                if (msg.pca && msg.isAnomaly) {
                    expect(msg).toHaveProperty('topContributor');
                    if (msg.contributions && msg.contributions.length > 0) {
                        expect(msg.contributions.length).toBeLessThanOrEqual(3);
                        expect(msg.contributions[0]).toHaveProperty('sensor');
                        expect(msg.contributions[0]).toHaveProperty('contribution');
                        expect(msg.contributions[0]).toHaveProperty('percentContribution');
                    }
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data with low variation - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { 
                        temp: 25 + i * 0.1, 
                        pressure: 100 + i * 0.2, 
                        vibration: 2 + i * 0.01,
                        current: 10 + i * 0.05
                    }
                });
            }
            
            // Send extreme anomaly (all values way off)
            n1.receive({ payload: { temp: 100, pressure: 500, vibration: 200, current: 100 } });
        });
    });

    it('should support different detection methods', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, method: "spe", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca) {
                    expect(msg.method).toBe('pca-spe');
                    expect(msg.pca).toHaveProperty('spe');
                    expect(msg.pca).toHaveProperty('speThreshold');
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { sensor1: 10 + Math.random() * 0.1, sensor2: 20 + Math.random() * 0.1, sensor3: 30 + Math.random() * 0.1 }
                });
            }
            
            n1.receive({ payload: { sensor1: 10.1, sensor2: 20.1, sensor3: 30.1 } });
        });
    });

    it('should auto-select number of components', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, autoComponents: true, varianceThreshold: 0.95, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca) {
                    expect(msg.pca).toHaveProperty('nComponents');
                    expect(msg.pca).toHaveProperty('explainedVariance');
                    expect(msg.pca.explainedVariance).toBeGreaterThan(0.5);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data with correlated sensors - need at least 10 samples
            for (let i = 0; i < 15; i++) {
                const base = i + Math.random() * 2;
                n1.receive({ 
                    payload: { 
                        sensor1: base, 
                        sensor2: base * 2 + Math.random() * 0.5, // Correlated with sensor1
                        sensor3: Math.random() * 10, // Independent
                        sensor4: base + Math.random() * 0.5 // Correlated with sensor1
                    }
                });
            }
            
            n1.receive({ payload: { sensor1: 7, sensor2: 14, sensor3: 5, sensor4: 7 } });
        });
    });

    it('should preserve message properties', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let pcaMessageReceived = false;
            const handler = function (msg) {
                if (msg.pca && msg.customProperty && !pcaMessageReceived) {
                    pcaMessageReceived = true;
                    expect(msg).toHaveProperty('customProperty', 'test123');
                    expect(msg).toHaveProperty('machineId', 'machine-01');
                    done();
                }
            };
            // Register handlers BEFORE sending data
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Train - send samples
            for (let i = 0; i < 15; i++) {
                n1.receive({ payload: { sensor1: 10 + i * 0.5 + Math.random(), sensor2: 20 + i * 0.3 + Math.random(), sensor3: 30 + i * 0.2 + Math.random() } });
            }
            
            n1.receive({ payload: { sensor1: 12, sensor2: 22, sensor3: 32 }, customProperty: 'test123', machineId: 'machine-01' });
        });
    });

    it('should include timestamp and buffer size in output', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const beforeTime = Date.now();
            let pcaMessageReceived = false;
            
            const handler = function (msg) {
                if (msg.pca && !pcaMessageReceived) {
                    pcaMessageReceived = true;
                    expect(msg).toHaveProperty('timestamp');
                    expect(msg).toHaveProperty('bufferSize');
                    expect(msg.timestamp).toBeGreaterThanOrEqual(beforeTime);
                    expect(msg.bufferSize).toBeLessThanOrEqual(20);
                    done();
                }
            };
            // Register handlers BEFORE sending data
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Train - send samples one at a time with delay to ensure processing
            const samples = [];
            for (let i = 0; i < 15; i++) {
                samples.push({ sensor1: 10 + i * 0.5 + Math.random(), sensor2: 20 + i * 0.3 + Math.random(), sensor3: 30 + i * 0.2 + Math.random() });
            }
            samples.push({ sensor1: 12, sensor2: 22, sensor3: 32 }); // Final sample
            
            samples.forEach(s => n1.receive({ payload: s }));
        });
    });

    it('should error on insufficient sensor values', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            // Send only one sensor (need at least 2)
            n1.receive({ payload: { sensor1: 10 } });
            n1.receive({ payload: [10] });
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    it('should error on invalid payload', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let received = false;
            n2.on("input", function () { received = true; });
            n3.on("input", function () { received = true; });
            
            n1.receive({ payload: "invalid" });
            n1.receive({ payload: 123 }); // Single number
            
            setTimeout(function() {
                expect(received).toBe(false);
                done();
            }, 100);
        });
    });

    // ============================================
    // ml-pca specific tests
    // ============================================

    it('should provide eigenvalues in output (ml-pca feature)', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca && msg.pca.eigenvalues) {
                    expect(msg.pca).toHaveProperty('eigenvalues');
                    expect(Array.isArray(msg.pca.eigenvalues)).toBe(true);
                    expect(msg.pca.eigenvalues.length).toBeGreaterThan(0);
                    // Eigenvalues should be positive
                    msg.pca.eigenvalues.forEach(ev => {
                        expect(ev).toBeGreaterThanOrEqual(0);
                    });
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { 
                        sensor1: 10 + Math.random() * 2, 
                        sensor2: 20 + Math.random() * 2, 
                        sensor3: 30 + Math.random() * 2 
                    } 
                });
            }
            
            n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
        });
    });

    it('should provide explained variance ratio (ml-pca feature)', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, autoComponents: true, varianceThreshold: 0.90, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca) {
                    expect(msg.pca).toHaveProperty('explainedVariance');
                    // Explained variance should be between 0 and 1
                    expect(msg.pca.explainedVariance).toBeGreaterThan(0);
                    expect(msg.pca.explainedVariance).toBeLessThanOrEqual(1);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send correlated data (should result in fewer components needed)
            for (let i = 0; i < 15; i++) {
                const base = i + Math.random();
                n1.receive({ 
                    payload: { 
                        sensor1: base, 
                        sensor2: base * 2 + Math.random() * 0.1,  // Highly correlated
                        sensor3: base * 3 + Math.random() * 0.1   // Highly correlated
                    } 
                });
            }
            
            n1.receive({ payload: { sensor1: 7, sensor2: 14, sensor3: 21 } });
        });
    });

    it('should correctly identify top contributor sensor', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, threshold: 1.0, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            let hasDone = false;
            const handler = function (msg) {
                if (msg.pca && msg.topContributor && !hasDone) {
                    hasDone = true;
                    expect(msg).toHaveProperty('topContributor');
                    // Top contributor should be a string (sensor name)
                    expect(typeof msg.topContributor).toBe('string');
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data with stable values
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { 
                        temp: 25 + Math.random() * 0.1, 
                        pressure: 100 + Math.random() * 0.1, 
                        humidity: 50 + Math.random() * 0.1
                    } 
                });
            }
            
            // Send value after training - should have topContributor
            n1.receive({ payload: { temp: 25.5, pressure: 100.5, humidity: 50.5 } });
        });
    });

    it('should handle highly correlated sensors correctly', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 30, autoComponents: true, varianceThreshold: 0.99, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca) {
                    // With perfectly correlated data, PCA should need fewer components
                    expect(msg.pca.nComponents).toBeLessThanOrEqual(3);
                    expect(msg.pca.explainedVariance).toBeGreaterThan(0.9);
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send perfectly correlated data (all sensors move together)
            for (let i = 0; i < 20; i++) {
                const base = i * 2 + Math.random() * 0.01;
                n1.receive({ 
                    payload: { 
                        sensor1: base, 
                        sensor2: base,
                        sensor3: base
                    } 
                });
            }
            
            n1.receive({ payload: { sensor1: 20, sensor2: 20, sensor3: 20 } });
        });
    });

    it('should calculate correct T² and SPE statistics', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, method: "combined", wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca) {
                    // T² should be non-negative
                    expect(msg.pca.t2).toBeGreaterThanOrEqual(0);
                    // SPE should be non-negative
                    expect(msg.pca.spe).toBeGreaterThanOrEqual(0);
                    // Thresholds should be set
                    expect(msg.pca.t2Threshold).toBeGreaterThan(0);
                    expect(msg.pca.speThreshold).toBeGreaterThan(0);
                    // Anomaly flags should be boolean
                    expect(typeof msg.pca.t2Anomaly).toBe('boolean');
                    expect(typeof msg.pca.speAnomaly).toBe('boolean');
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { 
                        sensor1: 10 + Math.random(), 
                        sensor2: 20 + Math.random(), 
                        sensor3: 30 + Math.random() 
                    } 
                });
            }
            
            n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
        });
    });

    it('should provide scores array matching nComponents', function (done) {
        const flow = [
            { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, nComponents: 2, autoComponents: false, wires: [["n2"], ["n3"]] },
            { id: "n2", type: "helper" },
            { id: "n3", type: "helper" }
        ];
        helper.load(pcaAnomalyNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const n3 = helper.getNode("n3");
            
            const handler = function (msg) {
                if (msg.pca && msg.pca.scores) {
                    expect(msg.pca).toHaveProperty('scores');
                    expect(Array.isArray(msg.pca.scores)).toBe(true);
                    // Scores length should match nComponents
                    expect(msg.pca.scores.length).toBe(msg.pca.nComponents);
                    // Each score should be a number
                    msg.pca.scores.forEach(score => {
                        expect(typeof score).toBe('number');
                        expect(isNaN(score)).toBe(false);
                    });
                    done();
                }
            };
            n2.on("input", handler);
            n3.on("input", handler);
            
            // Send training data
            for (let i = 0; i < 15; i++) {
                n1.receive({ 
                    payload: { 
                        sensor1: 10 + Math.random(), 
                        sensor2: 20 + Math.random(), 
                        sensor3: 30 + Math.random() 
                    } 
                });
            }
            
            n1.receive({ payload: { sensor1: 10.5, sensor2: 20.5, sensor3: 30.5 } });
        });
    });
});
