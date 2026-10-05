const helper = require("node-red-node-test-helper");
const fs = require("fs");
const path = require("path");
const mlInferenceNode = require("../nodes/ml-inference.js");

helper.init(require.resolve("node-red"));

// Check which runtimes and fixture models are available
const hasTFJS = (() => {
    try {
        require("@tensorflow/tfjs-node");
        return fs.existsSync(path.join(__dirname, "fixtures", "tfjs_model", "model.json"));
    } catch {
        return false;
    }
})();
const _hasONNX = (() => {
    try {
        require("onnxruntime-node");
        return fs.existsSync(path.join(__dirname, "fixtures", "model.onnx"));
    } catch {
        return false;
    }
})();
const conditionalIt = (condition) => (condition ? it : it.skip);

// What GET /ml-inference/runtimes must report on this install.
function canRequire(name) {
    try {
        require(name);
        return true;
    } catch {
        return false;
    }
}
const canLoadTFJS = canRequire("@tensorflow/tfjs-node") || canRequire("@tensorflow/tfjs");
const canLoadONNX = canRequire("onnxruntime-node");

describe("ml-inference Node", function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.name).toBe("ML Model");
            expect(n1.type).toBe("ml-inference");
            done();
        });
    });

    /** Collect the first argument of every node.error() / node.status() call (helper spy events). */
    function recordCalls(node) {
        const calls = { errors: [], statuses: [] };
        node.on("call:error", (call) =>
            calls.errors.push(String((call.args[0] && call.args[0].message) || call.args[0]))
        );
        node.on("call:status", (call) => calls.statuses.push(call.args[0]));
        return calls;
    }

    /**
     * Install a stand-in model so the message path can be tested without any
     * ML runtime: bridge-style handles are just `{ predict() }`.
     */
    function installStubModel(node, predict) {
        const received = [];
        node.model = {
            predict: async function (input) {
                received.push(input);
                return predict(input);
            }
        };
        node.modelFormat = "keras";
        node.modelLoaded = true;
        return received;
    }

    it("should report 'no model configured' and reject messages when nothing is configured", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", modelPath: "", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const calls = recordCalls(n1);
            let forwarded = 0;
            n2.on("input", () => forwarded++);

            expect(n1.modelLoaded).toBe(false);
            expect(n1.model).toBeNull();
            expect(n1.loadError).toBeNull();

            n1.receive({ payload: [1, 2, 3] });

            setTimeout(function () {
                expect(calls.errors).toEqual(["No model path configured"]);
                expect(calls.statuses).toContainEqual({ fill: "red", shape: "dot", text: "No model path configured" });
                expect(forwarded).toBe(0);
                done();
            }, 100);
        });
    });

    it("should apply defaults when the flow carries no settings", function (done) {
        const flow = [{ id: "n1", type: "ml-inference" }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.modelSource).toBe("local");
            expect(n1.modelPath).toBe("");
            expect(n1.modelType).toBe("auto");
            expect(n1.inputShape).toBe("");
            expect(n1.inputProperty).toBe("payload");
            expect(n1.outputProperty).toBe("prediction");
            expect(n1.preprocessMode).toBe("array");
            expect(n1.warmup).toBe(true);
            expect(n1.autoUpdate).toBe(false);
            expect(n1.updateCheckInterval).toBe(3600);
            expect(n1.mlflowBatchSize).toBe(100);
            expect(n1.modelSha256).toBeNull();
            done();
        });
    });

    it("should still load a flow that carries the removed batchSize setting", function (done) {
        // batchSize was parsed but never used; flows saved by older versions keep the key.
        const flow = [{ id: "n1", type: "ml-inference", name: "Old Flow", batchSize: 32, warmup: false }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.name).toBe("Old Flow");
            expect(n1.warmup).toBe(false);
            expect(n1.batchSize).toBeUndefined();
            done();
        });
    });

    it("should clamp out-of-range numeric settings", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", updateCheckInterval: -5, mlflowBatchSize: "abc", modelSha256: "nope" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1.updateCheckInterval).toBe(1);
            expect(n1.mlflowBatchSize).toBe(100);
            expect(n1.modelSha256).toBeNull();
            done();
        });
    });

    it("should refuse a model path outside the allowlist", function (done) {
        const flow = [
            {
                id: "n1",
                type: "ml-inference",
                name: "ML Model",
                modelPath: "/nonexistent/model.onnx",
                modelType: "onnx",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const calls = recordCalls(n1);

            // Give time for model load attempt
            setTimeout(function () {
                expect(n1.modelLoaded).toBe(false);
                expect(n1.model).toBeNull();
                expect(n1.loadError.code).toBe("EPATHFORBIDDEN");
                expect(n1.loadError.message).toMatch(/outside the allowed directories: \/nonexistent\/model\.onnx$/);

                // ...and a message sent now reports why there is no model.
                n1.receive({ payload: [1, 2, 3] });
                setTimeout(function () {
                    const refused =
                        "Refusing to use path: path is outside the allowed directories: /nonexistent/model.onnx";
                    expect(calls.errors).toEqual(["Failed to load model: " + refused, "Model not loaded: " + refused]);
                    done();
                }, 100);
            }, 500);
        });
    });

    it("should report input that is missing at the configured property", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", inputProperty: "features", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const calls = recordCalls(n1);
            const received = installStubModel(n1, () => [[1]]);
            let forwarded = 0;
            n2.on("input", () => forwarded++);

            // Send message without the expected input property
            n1.receive({ payload: [1, 2, 3] });

            setTimeout(function () {
                expect(calls.errors).toEqual(["Input data not found at msg.features"]);
                expect(received).toEqual([]);
                expect(forwarded).toBe(0);
                done();
            }, 100);
        });
    });

    it("should read and write nested input/output property paths", function (done) {
        const flow = [
            {
                id: "n1",
                type: "ml-inference",
                name: "ML Model",
                inputProperty: "data.features",
                outputProperty: "result.prediction",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const received = installStubModel(n1, (input) => [input.reduce((a, b) => a + b, 0)]);

            n2.on("input", function (msg) {
                try {
                    expect(received).toEqual([[1, 2, 3]]);
                    expect(msg.result).toEqual({ prediction: [6] });
                    expect(msg.data).toEqual({ features: [1, 2, 3] });
                    expect(msg).not.toHaveProperty("prediction");
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({ data: { features: [1, 2, 3] } });
        });
    });

    it("should detect the model type from the file extension", function (done) {
        // Inside the allowlist (cwd) but absent: the error shows which loader was chosen.
        const flow = [
            {
                id: "n1",
                type: "ml-inference",
                modelPath: path.join("test", "fixtures", "does-not-exist.onnx"),
                modelType: "auto"
            },
            { id: "n2", type: "ml-inference", modelPath: path.join("test", "fixtures", "does-not-exist.bin") }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            setTimeout(function () {
                expect(n1.modelLoaded).toBe(false);
                // "ONNX model file not found" with the runtime, "ONNX Runtime not available" without.
                expect(n1.loadError.message).toMatch(/^ONNX (model file not found|Runtime not available)/);
                expect(n2.loadError.message).toBe("Could not detect model type. Please specify tfjs or onnx.");
                done();
            }, 500);
        });
    });

    it("should switch to the path given in msg.loadModel", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", modelPath: "", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            let forwarded = 0;
            n2.on("input", () => forwarded++);

            // The file does not exist (and lies outside the allowlist): the
            // load is attempted with the new path and fails for that reason.
            n1.receive({ loadModel: "/new/model.onnx" });

            setTimeout(function () {
                expect(n1.modelPath).toBe("/new/model.onnx");
                expect(n1.modelLoaded).toBe(false);
                expect(n1.loadError.code).toBe("EPATHFORBIDDEN");
                // A load command is consumed, not forwarded.
                expect(forwarded).toBe(0);
                done();
            }, 200);
        });
    });

    it("should preserve message properties and attach inference metadata", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", inputShape: "1,3", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            installStubModel(n1, () => [[0.1, 0.9]]);

            const originalMsg = {
                payload: [1, 2, 3],
                topic: "sensors/motor01/vibration",
                sensorId: "VIB-001",
                timestamp: 1700000000000
            };
            const before = Date.now();

            n2.on("input", function (msg) {
                try {
                    expect(msg.payload).toEqual([1, 2, 3]);
                    expect(msg.topic).toBe("sensors/motor01/vibration");
                    expect(msg.sensorId).toBe("VIB-001");
                    expect(msg.timestamp).toBe(1700000000000);
                    expect(msg.prediction).toEqual([[0.1, 0.9]]);

                    const meta = msg.mlInference;
                    expect(meta.modelFormat).toBe("keras");
                    expect(meta.inputShape).toBe("1,3");
                    expect(meta.invalidInputs).toBe(0);
                    expect(meta.mlflowTracking).toBeNull();
                    expect(meta.inferenceTime).toBeGreaterThanOrEqual(0);
                    expect(meta.inferenceTime).toBeLessThan(1000);
                    expect(meta.timestamp).toBeGreaterThanOrEqual(before);
                    expect(meta.timestamp).toBeLessThanOrEqual(Date.now());
                    // The incoming message object itself is not mutated.
                    expect(originalMsg).not.toHaveProperty("prediction");
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive(originalMsg);
        });
    });

    it("should flatten nested array input and coerce numeric strings", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", preprocessMode: "array", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const received = installStubModel(n1, () => [0]);

            n2.on("input", function (msg) {
                try {
                    expect(received).toEqual([[1, 2, 3.5, 4, 0]]);
                    // null is not a number: it goes in as 0 and is counted.
                    expect(msg.mlInference.invalidInputs).toBe(1);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({ payload: [[1, 2], ["3.5", [4]], null] });
        });
    });

    it("should use an object's values in object input mode", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", preprocessMode: "object", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const received = installStubModel(n1, () => [0]);

            n2.on("input", function (msg) {
                try {
                    expect(received).toEqual([[20.5, 1013, 45]]);
                    expect(msg.mlInference.invalidInputs).toBe(0);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({ payload: { temperature: 20.5, pressure: "1013", humidity: 45 } });
        });
    });

    it("should prefer features/values/input over all keys outside object mode", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const received = installStubModel(n1, () => [0]);

            n2.on("input", function () {
                try {
                    expect(received).toEqual([[7, 8, 9]]);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({ payload: { features: [7, 8, 9], label: "ignored" } });
        });
    });

    it("should keep the configured input shape and URL model path", function (done) {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", inputShape: "1,10,5" },
            {
                id: "n2",
                type: "ml-inference",
                name: "URL Model",
                modelSource: "url",
                // Never fetched: a .invalid host cannot resolve.
                modelPath: "https://models.invalid/model.json",
                modelType: "tfjs"
            }
        ];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            expect(n1.inputShape).toBe("1,10,5");
            expect(n2.modelSource).toBe("url");
            expect(n2.modelPath).toBe("https://models.invalid/model.json");
            expect(n2.modelType).toBe("tfjs");
            done();
        });
    });

    it("should cleanup on node close", function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            const n1 = helper.getNode("n1");

            // Manually trigger close
            n1.close(true)
                .then(function () {
                    expect(n1.modelLoaded).toBe(false);
                    expect(n1.model).toBe(null);
                    done();
                })
                .catch(done);
        });
    });

    it("should expose runtimes API endpoint", function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            helper
                .request()
                .get("/ml-inference/runtimes")
                .expect(200)
                .end(function (err, res) {
                    if (err) return done(err);
                    expect(res.body).toEqual({ tfjs: canLoadTFJS, onnx: canLoadONNX });
                    done();
                });
        });
    });

    it("should expose models list API endpoint", function (done) {
        const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
        helper.load(mlInferenceNode, flow, function () {
            helper
                .request()
                .get("/ml-inference/models")
                .expect(200)
                .end(function (err, res) {
                    if (err) return done(err);
                    expect(Object.keys(res.body).sort()).toEqual(["models", "modelsDir"]);
                    expect(Array.isArray(res.body.models)).toBe(true);
                    expect(path.basename(res.body.modelsDir)).toBe("ml-models");
                    expect(path.isAbsolute(res.body.modelsDir)).toBe(true);
                    // The route creates the store on first use.
                    expect(fs.statSync(res.body.modelsDir).isDirectory()).toBe(true);
                    res.body.models.forEach(function (model) {
                        expect(typeof model.name).toBe("string");
                        expect(path.dirname(model.path)).toBe(res.body.modelsDir);
                        expect(["onnx", "tflite", "keras", "sklearn", "tfjs"]).toContain(model.type);
                    });
                    done();
                });
        });
    });

    // Helper: poll until the node's model is loaded, then invoke callback
    function waitForModel(node, timeout, callback) {
        const start = Date.now();
        const interval = setInterval(function () {
            if (node.modelLoaded) {
                clearInterval(interval);
                callback();
            } else if (Date.now() - start > timeout) {
                clearInterval(interval);
                callback(new Error("Model did not load within " + timeout + "ms"));
            }
        }, 100);
    }

    // Integration test - runs when @tensorflow/tfjs-node and fixture model are available
    conditionalIt(hasTFJS)(
        "should run inference with TensorFlow.js model",
        function (done) {
            const flow = [
                {
                    id: "n1",
                    type: "ml-inference",
                    name: "TFJS Model",
                    modelPath: path.resolve(__dirname, "fixtures", "tfjs_model"),
                    modelType: "tfjs",
                    inputShape: "1,10",
                    wires: [["n2"]]
                },
                { id: "n2", type: "helper" }
            ];
            helper.load(mlInferenceNode, flow, function () {
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");

                waitForModel(n1, 8000, function (err) {
                    if (err) return done(err);

                    n2.on("input", function (msg) {
                        expect(Array.isArray(msg.prediction)).toBe(true);
                        expect(msg.prediction.flat(Infinity).every((v) => Number.isFinite(v))).toBe(true);
                        expect(msg.payload).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
                        expect(msg.mlInference.modelFormat).toBe("tfjs");
                        expect(msg.mlInference.inputShape).toBe("1,10");
                        expect(msg.mlInference.invalidInputs).toBe(0);
                        done();
                    });

                    n1.receive({ payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
                });
            });
        },
        15000
    );

    // ONNX integration test — skipped in Jest due to onnxruntime-node's native Float32Array
    // type check being incompatible with Jest's VM sandbox.
    // Use `node test/fixtures/generate-models.js` to verify ONNX inference works.
    it.skip("should run inference with ONNX model (run via node test/smoke-onnx.js)", function () {});
});
