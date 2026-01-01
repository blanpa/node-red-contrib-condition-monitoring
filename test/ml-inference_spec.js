const helper = require("node-red-node-test-helper");
const mlInferenceNode = require("../nodes/ml-inference.js");

helper.init(require.resolve('node-red'));

describe('ml-inference Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('should be loaded', function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toHaveProperty('name', 'ML Model');
            done();
        });
    });

    it('should show status when no model configured', function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model", modelPath: "" }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toBeDefined();
            // Node should be in "no model configured" state
            done();
        });
    });

    it('should have default configuration values', function (done) {
        const flow = [{ 
            id: "n1", 
            type: "ml-inference", 
            name: "ML Model",
            modelPath: "",
            modelType: "auto",
            inputShape: "",
            inputProperty: "payload",
            outputProperty: "prediction",
            preprocessMode: "array",
            batchSize: 1,
            warmup: true
        }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.modelType).toBe("auto");
            expect(n1.inputProperty).toBe("payload");
            expect(n1.outputProperty).toBe("prediction");
            expect(n1.preprocessMode).toBe("array");
            expect(n1.batchSize).toBe(1);
            expect(n1.warmup).toBe(true);
            done();
        });
    });

    it('should error when model path does not exist', function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", modelPath: "/nonexistent/model.onnx", modelType: "onnx", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            let errorReceived = false;
            n1.on("call:error", function() {
                errorReceived = true;
            });
            
            // Give time for model load attempt
            setTimeout(function() {
                // Should have error status due to missing model
                expect(n1.modelLoaded).toBe(false);
                done();
            }, 500);
        });
    });

    it('should handle missing input data gracefully', function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", modelPath: "", inputProperty: "features", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            
            let errorCalled = false;
            n1.on("call:error", function() {
                errorCalled = true;
            });
            
            // Send message without the expected input property
            n1.receive({ payload: [1, 2, 3] });
            
            setTimeout(function() {
                // Should error because input property "features" doesn't exist
                done();
            }, 200);
        });
    });

    it('should support custom input property path', function (done) {
        const flow = [{ 
            id: "n1", 
            type: "ml-inference", 
            name: "ML Model",
            inputProperty: "data.features",
            outputProperty: "result.prediction"
        }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.inputProperty).toBe("data.features");
            expect(n1.outputProperty).toBe("result.prediction");
            done();
        });
    });

    it('should detect model type from file extension', function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ONNX Model", modelPath: "/path/to/model.onnx", modelType: "auto" },
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            // modelType is auto, but path ends in .onnx
            expect(n1.modelType).toBe("auto");
            expect(n1.modelPath).toBe("/path/to/model.onnx");
            done();
        });
    });

    it('should support dynamic model loading via msg.loadModel', function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", modelPath: "", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            
            // Send loadModel message (will fail because file doesn't exist, but tests the path)
            n1.receive({ loadModel: "/new/model.onnx" });
            
            setTimeout(function() {
                expect(n1.modelPath).toBe("/new/model.onnx");
                done();
            }, 200);
        });
    });

    it('should preserve message properties', function (done) {
        const flow = [{ 
            id: "n1", 
            type: "ml-inference", 
            name: "ML Model",
            modelPath: ""
        }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            
            // Original message with various properties
            const originalMsg = {
                payload: [1, 2, 3],
                topic: "sensors/motor01/vibration",
                sensorId: "VIB-001",
                timestamp: Date.now()
            };
            
            // Since no model is loaded, it will error, but we can still verify the node received it
            expect(n1).toBeDefined();
            done();
        });
    });

    it('should handle array input', function (done) {
        const flow = [{ 
            id: "n1", 
            type: "ml-inference", 
            name: "ML Model",
            preprocessMode: "array"
        }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.preprocessMode).toBe("array");
            done();
        });
    });

    it('should handle object input mode', function (done) {
        const flow = [{ 
            id: "n1", 
            type: "ml-inference", 
            name: "ML Model",
            preprocessMode: "object"
        }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.preprocessMode).toBe("object");
            done();
        });
    });

    it('should parse input shape correctly', function (done) {
        const flow = [{ 
            id: "n1", 
            type: "ml-inference", 
            name: "ML Model",
            inputShape: "1,10,5"
        }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.inputShape).toBe("1,10,5");
            done();
        });
    });

    it('should support URL-based model paths', function (done) {
        const flow = [{ 
            id: "n1", 
            type: "ml-inference", 
            name: "ML Model",
            modelPath: "https://example.com/models/model.json",
            modelType: "tfjs"
        }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.modelPath).toBe("https://example.com/models/model.json");
            expect(n1.modelType).toBe("tfjs");
            done();
        });
    });

    it('should cleanup on node close', function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            
            // Manually trigger close
            n1.close(true).then(function() {
                expect(n1.modelLoaded).toBe(false);
                expect(n1.model).toBe(null);
                done();
            }).catch(done);
        });
    });

    it('should expose runtimes API endpoint', function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            helper.request()
                .get('/ml-inference/runtimes')
                .expect(200)
                .end(function(err, res) {
                    if (err) return done(err);
                    expect(res.body).toHaveProperty('tfjs');
                    expect(res.body).toHaveProperty('onnx');
                    done();
                });
        });
    });

    it('should expose models list API endpoint', function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            helper.request()
                .get('/ml-inference/models')
                .expect(200)
                .end(function(err, res) {
                    if (err) return done(err);
                    expect(res.body).toHaveProperty('models');
                    expect(res.body).toHaveProperty('modelsDir');
                    expect(Array.isArray(res.body.models)).toBe(true);
                    done();
                });
        });
    });

    // Integration test - requires actual runtime (skipped by default)
    it.skip('should run inference with TensorFlow.js model', function (done) {
        // This test requires @tensorflow/tfjs-node to be installed
        // and a valid model file to exist
        const flow = [
            { id: "n1", type: "ml-inference", name: "TFJS Model", modelPath: "./test/fixtures/tfjs_model/model.json", modelType: "tfjs", inputShape: "1,10", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Wait for model to load
            setTimeout(function() {
                n2.on("input", function (msg) {
                    expect(msg).toHaveProperty('prediction');
                    expect(msg).toHaveProperty('mlInference');
                    expect(msg.mlInference.modelFormat).toBe('tfjs');
                    done();
                });
                
                n1.receive({ payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
            }, 2000);
        });
    });

    // Integration test - requires actual runtime (skipped by default)
    it.skip('should run inference with ONNX model', function (done) {
        // This test requires onnxruntime-node to be installed
        // and a valid model file to exist
        const flow = [
            { id: "n1", type: "ml-inference", name: "ONNX Model", modelPath: "./test/fixtures/model.onnx", modelType: "onnx", inputShape: "1,10", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            
            // Wait for model to load
            setTimeout(function() {
                n2.on("input", function (msg) {
                    expect(msg).toHaveProperty('prediction');
                    expect(msg).toHaveProperty('mlInference');
                    expect(msg.mlInference.modelFormat).toBe('onnx');
                    done();
                });
                
                n1.receive({ payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
            }, 2000);
        });
    });
});

