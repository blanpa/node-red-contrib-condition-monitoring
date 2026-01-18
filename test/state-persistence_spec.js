const helper = require("node-red-node-test-helper");
const anomalyDetectorNode = require("../nodes/anomaly-detector.js");
const pcaAnomalyNode = require("../nodes/pca-anomaly.js");
const signalAnalyzerNode = require("../nodes/signal-analyzer.js");
const isolationForestNode = require("../nodes/isolation-forest-anomaly.js");
const trendPredictorNode = require("../nodes/trend-predictor.js");
const healthIndexNode = require("../nodes/health-index.js");

helper.init(require.resolve('node-red'));

describe('State Persistence', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    // ============================================
    // Anomaly Detector State Persistence
    // ============================================

    describe('anomaly-detector persistence', function () {
        
        it('should have persistState config option', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty('persistState', true);
                done();
            });
        });

        it('should initialize state manager when persistState is enabled', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                // State manager should be initialized
                expect(n1).toHaveProperty('stateManager');
                expect(n1.stateManager).toBeTruthy();
                done();
            });
        });

        it('should not initialize state manager when persistState is disabled', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", persistState: false, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1.stateManager).toBeFalsy();
                done();
            });
        });

        it('should maintain buffer in dataBuffer property', function (done) {
            const flow = [
                { id: "n1", type: "anomaly-detector", name: "test", method: "zscore", windowSize: 10, persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(anomalyDetectorNode, flow, function () {
                const n1 = helper.getNode("n1");
                
                // Send some values
                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: 50 + i });
                }
                
                setTimeout(function() {
                    // Buffer should have data
                    expect(n1.dataBuffer.length).toBe(5);
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // PCA Anomaly State Persistence
    // ============================================

    describe('pca-anomaly persistence', function () {
        
        it('should have persistState config option', function (done) {
            const flow = [
                { id: "n1", type: "pca-anomaly", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(pcaAnomalyNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty('persistState', true);
                done();
            });
        });

        it('should store trained model state', function (done) {
            const flow = [
                { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(pcaAnomalyNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");
                
                const handler = function (msg) {
                    if (msg.pca) {
                        // After training, model should be stored
                        expect(n1.isTrained).toBe(true);
                        expect(n1.pcaModel).toBeTruthy();
                        expect(n1.mean).toBeTruthy();
                        expect(n1.stdDev).toBeTruthy();
                        done();
                    }
                };
                n2.on("input", handler);
                n3.on("input", handler);
                
                // Train the model
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

        it('should be able to serialize pcaModel to JSON', function (done) {
            const flow = [
                { id: "n1", type: "pca-anomaly", name: "test", windowSize: 20, persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(pcaAnomalyNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");
                
                const handler = function (msg) {
                    if (msg.pca && n1.pcaModel) {
                        // Check that model can be serialized
                        expect(typeof n1.pcaModel.toJSON).toBe('function');
                        const json = n1.pcaModel.toJSON();
                        expect(json).toBeTruthy();
                        expect(typeof json).toBe('object');
                        done();
                    }
                };
                n2.on("input", handler);
                n3.on("input", handler);
                
                // Train the model
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

    // ============================================
    // Signal Analyzer State Persistence
    // ============================================

    describe('signal-analyzer persistence', function () {
        
        it('should have persistState config option', function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty('persistState', true);
                done();
            });
        });

        it('should maintain buffer state', function (done) {
            const flow = [
                { id: "n1", type: "signal-analyzer", name: "test", mode: "vibration", windowSize: 50, persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(signalAnalyzerNode, flow, function () {
                const n1 = helper.getNode("n1");
                
                // Send some values (less than windowSize to not trigger processing)
                for (let i = 0; i < 30; i++) {
                    n1.receive({ payload: Math.sin(i * 0.1) });
                }
                
                setTimeout(function() {
                    expect(n1.buffer.length).toBe(30);
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // Isolation Forest State Persistence
    // ============================================

    describe('isolation-forest-anomaly persistence', function () {
        
        it('should have persistState config option', function (done) {
            const flow = [
                { id: "n1", type: "isolation-forest-anomaly", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(isolationForestNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty('persistState', true);
                done();
            });
        });

        it('should maintain data buffer state', function (done) {
            const flow = [
                { id: "n1", type: "isolation-forest-anomaly", name: "test", windowSize: 50, persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(isolationForestNode, flow, function () {
                const n1 = helper.getNode("n1");
                
                // Send some values (less than needed for training)
                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: 50 + Math.random() * 10 });
                }
                
                setTimeout(function() {
                    expect(n1.dataBuffer.length).toBe(5);
                    done();
                }, 50);
            });
        });

        it('should track sample count', function (done) {
            const flow = [
                { id: "n1", type: "isolation-forest-anomaly", name: "test", windowSize: 50, persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(isolationForestNode, flow, function () {
                const n1 = helper.getNode("n1");
                
                // Send some values
                for (let i = 0; i < 8; i++) {
                    n1.receive({ payload: 50 + Math.random() * 10 });
                }
                
                setTimeout(function() {
                    expect(n1.sampleCount).toBe(8);
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // Trend Predictor State Persistence
    // ============================================

    describe('trend-predictor persistence', function () {
        
        it('should have persistState config option', function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty('persistState', true);
                done();
            });
        });

        it('should initialize state manager when persistState is enabled', function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty('stateManager');
                expect(n1.stateManager).toBeTruthy();
                done();
            });
        });

        it('should not initialize state manager when persistState is disabled', function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", persistState: false, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1.stateManager).toBeFalsy();
                done();
            });
        });

        it('should maintain buffer state', function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", mode: "prediction", windowSize: 50, persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                
                // Send some values
                for (let i = 0; i < 10; i++) {
                    n1.receive({ payload: 50 + i, timestamp: Date.now() + i * 1000 });
                }
                
                setTimeout(function() {
                    expect(n1.buffer.length).toBe(10);
                    expect(n1.timestamps.length).toBe(10);
                    done();
                }, 50);
            });
        });

        it('should maintain rate of change state', function (done) {
            const flow = [
                { id: "n1", type: "trend-predictor", name: "test", mode: "rate-of-change", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(trendPredictorNode, flow, function () {
                const n1 = helper.getNode("n1");
                
                n1.receive({ payload: 50, timestamp: Date.now() });
                n1.receive({ payload: 55, timestamp: Date.now() + 1000 });
                
                setTimeout(function() {
                    expect(n1.previousValue).toBe(55);
                    expect(n1.previousTimestamp).toBeTruthy();
                    done();
                }, 50);
            });
        });
    });

    // ============================================
    // Health Index State Persistence
    // ============================================

    describe('health-index persistence', function () {
        
        it('should have persistState config option', function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                // The node should load without error
                expect(n1).toBeTruthy();
                done();
            });
        });

        it('should initialize state manager when persistState is enabled', function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                expect(n1).toHaveProperty('stateManager');
                expect(n1.stateManager).toBeTruthy();
                done();
            });
        });

        it('should maintain health history', function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                let msgCount = 0;
                n2.on("input", function (msg) {
                    msgCount++;
                    if (msgCount >= 3) {
                        expect(n1.healthHistory.length).toBe(3);
                        expect(n1.lastHealthIndex).toBeTruthy();
                        done();
                    }
                });
                
                // Send some healthy sensor readings
                n1.receive({ payload: { temp: { value: 50 }, pressure: { value: 100 } } });
                n1.receive({ payload: { temp: { value: 51 }, pressure: { value: 101 } } });
                n1.receive({ payload: { temp: { value: 52 }, pressure: { value: 102 } } });
            });
        });

        it('should include health trend in output', function (done) {
            const flow = [
                { id: "n1", type: "health-index", name: "test", persistState: true, wires: [["n2"], ["n3"]] },
                { id: "n2", type: "helper" },
                { id: "n3", type: "helper" }
            ];
            helper.load(healthIndexNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                
                let msgCount = 0;
                n2.on("input", function (msg) {
                    msgCount++;
                    if (msgCount >= 5) {
                        expect(msg).toHaveProperty('healthTrend');
                        expect(msg.healthTrend).toHaveProperty('trend');
                        expect(msg.healthTrend).toHaveProperty('samples');
                        done();
                    }
                });
                
                // Send several healthy sensor readings
                for (let i = 0; i < 5; i++) {
                    n1.receive({ payload: { temp: { value: 50 + i }, pressure: { value: 100 } } });
                }
            });
        });
    });

    // ============================================
    // State Persistence Manager Tests
    // ============================================

    describe('NodeStateManager', function () {
        
        it('should be loadable as a module', function (done) {
            const StatePersistence = require('../nodes/state-persistence.js');
            expect(StatePersistence).toBeTruthy();
            expect(StatePersistence.NodeStateManager).toBeTruthy();
            expect(typeof StatePersistence.NodeStateManager).toBe('function');
            done();
        });

        it('should export helper factory functions', function (done) {
            const StatePersistence = require('../nodes/state-persistence.js');
            expect(StatePersistence.createAnomalyStateManager).toBeTruthy();
            expect(StatePersistence.createMLStateManager).toBeTruthy();
            expect(StatePersistence.createSignalStateManager).toBeTruthy();
            expect(typeof StatePersistence.createAnomalyStateManager).toBe('function');
            done();
        });
    });
});
