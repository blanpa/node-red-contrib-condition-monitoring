const helper = require("node-red-node-test-helper");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mlInferenceNode = require("../nodes/ml-inference.js");

helper.init(require.resolve("node-red"));

const FIXTURES = path.join(__dirname, "fixtures");

// Check which runtimes and fixture models are available
const hasTFJS = (() => {
    try {
        require("@tensorflow/tfjs-node");
        return fs.existsSync(path.join(FIXTURES, "tfjs_model", "model.json"));
    } catch {
        return false;
    }
})();
const hasONNX = (() => {
    try {
        require("onnxruntime-node");
        return fs.existsSync(path.join(FIXTURES, "model.onnx"));
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
    // The runtime allowlists only the model store, the bundled models and
    // `conditionMonitoring.allowedModelPaths` — not the cwd or the user dir.
    // Give it a throw-away user dir (so the store is created there, not in
    // $HOME) and allowlist the fixtures explicitly.
    let userDir;
    beforeAll(function () {
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-mlspec-"));
        helper.settings({ userDir: userDir, conditionMonitoring: { allowedModelPaths: [FIXTURES] } });
    });
    afterAll(function () {
        fs.rmSync(userDir, { recursive: true, force: true });
    });

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

    /**
     * Install a stand-in ONNX session: records the feeds it is run with and
     * answers a 1x1 output. The shape check runs before the runtime is
     * touched, so the mismatch cases need no onnxruntime; building the feed
     * tensor does (hasONNX).
     */
    function installOnnxStub(node, session) {
        const feeds = [];
        node.model = Object.assign(
            {
                run: async function (f) {
                    feeds.push(f);
                    return { out: { data: Float32Array.from([0.25]), dims: [1, 1] } };
                }
            },
            session || {}
        );
        node.modelFormat = "onnx";
        node.inputNames = ["input"];
        node.outputNames = ["out"];
        node.modelLoaded = true;
        return feeds;
    }

    /** Messages node.warn() logged during helper.load() (constructor-time warnings). */
    function loggedWarnings() {
        const log = helper.log();
        return log.args.filter((a) => a[0] && a[0].level === log.WARN).map((a) => String(a[0].msg));
    }

    /** Wait until `node` has finished its startup load, one way or the other. */
    function whenSettled(node, timeoutMs) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const poll = setInterval(function () {
                if (node.modelLoaded || node.loadError) {
                    clearInterval(poll);
                    resolve();
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(poll);
                    reject(new Error("model load did not settle within " + timeoutMs + "ms"));
                }
            }, 25);
        });
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

    it("should refuse a path under the cwd or the user dir that is not allowlisted", async function () {
        // Both used to be allowlisted wholesale. The cwd is "/" under systemd's
        // defaults (= everything); the user dir holds flows_cred.json.
        const flow = [
            { id: "n1", type: "ml-inference", modelPath: path.join(process.cwd(), "does-not-exist.onnx") },
            { id: "n2", type: "ml-inference", modelPath: path.join(userDir, "secret.onnx") },
            // Relative: resolves against the cwd (not in the store, not bundled).
            { id: "n3", type: "ml-inference", modelPath: path.join("nodes", "does-not-exist.onnx") }
        ];
        await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
        for (const id of ["n1", "n2", "n3"]) {
            const n = helper.getNode(id);
            await whenSettled(n, 2000);
            expect(n.modelLoaded).toBe(false);
            expect(n.loadError && n.loadError.code).toBe("EPATHFORBIDDEN");
        }
    });

    it("should resolve a bare file name against the model store and models/<file> against the bundled models", async function () {
        // Both forms are what the editor writes into modelPath (model list / catalog).
        const store = path.join(userDir, "ml-models");
        fs.mkdirSync(store, { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, "model.onnx"), path.join(store, "store.onnx"));
        const flow = [
            { id: "n1", type: "ml-inference", modelPath: "store.onnx", modelType: "onnx" },
            { id: "n2", type: "ml-inference", modelPath: "models/bearing_fault_clf.onnx", modelType: "onnx" }
        ];
        await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
        for (const id of ["n1", "n2"]) {
            const n = helper.getNode(id);
            await whenSettled(n, 5000);
            if (n.loadError) {
                // Resolved and found; only the optional runtime is missing.
                expect(n.loadError.message).toMatch(/^ONNX Runtime not available/);
            } else {
                expect(n.modelLoaded).toBe(true);
            }
        }
    });

    it("should detect the model type from the file extension", function (done) {
        // Inside the allowlist (the fixtures dir is allowlisted above) but absent:
        // the error shows which loader was chosen.
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

    it("should accept typed arrays and Buffers, directly and under features/values/input", async function () {
        // `.values` is a METHOD on these; the property probe used to pick it up
        // and fail with "inputArray.flat is not a function".
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        const received = installStubModel(n1, () => [0]);
        const outputs = [];
        n2.on("input", (msg) => outputs.push(msg));

        const inputs = [
            Float32Array.from([1, 2, 3]),
            Buffer.from([4, 5]),
            { values: Float32Array.from([6, 7]) },
            { features: [8, 9], values: "not the data" },
            // `values` is not an array here: every value of the object is used
            { values: 10, other: 11 }
        ];
        for (const payload of inputs) {
            n1.receive({ payload: payload });
        }
        await new Promise((r) => setTimeout(r, 200));

        expect(outputs).toHaveLength(inputs.length);
        expect(received).toEqual([
            [1, 2, 3],
            [4, 5],
            [6, 7],
            [8, 9],
            [10, 11]
        ]);
    });

    it("should still deliver the prediction when MLflow stats run over image-sized tensors", async function () {
        // Math.max(...flat) threw RangeError at ~150k elements — inside the
        // inference try, so the already computed prediction was dropped.
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        const big = Array.from({ length: 200000 }, (_, i) => i % 10);
        installStubModel(n1, () => big.slice());
        const logged = [];
        n1.mlflowTracker = { runId: "run-1", logMetrics: (m) => logged.push(m) };
        n1.mlflowTrackingEnabled = true;
        n1.mlflowLogPredictions = true;
        n1.mlflowLogInputStats = true;
        const outputs = [];
        n2.on("input", (msg) => outputs.push(msg));

        n1.receive({ payload: big });
        await new Promise((r) => setTimeout(r, 500));

        expect(outputs).toHaveLength(1);
        expect(outputs[0].prediction).toHaveLength(200000);
        expect(outputs[0].mlInference.mlflowTracking).toEqual({
            experimentName: "node-red-ml-inference",
            runId: "run-1"
        });
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({
            input_min: 0,
            input_max: 9,
            input_mean: 4.5,
            prediction_min: 0,
            prediction_max: 9
        });
        expect(logged[0].input_std).toBeCloseTo(2.872, 3);
    });

    it("should not let a failing MLflow tracker veto a prediction", async function () {
        const flow = [
            { id: "n1", type: "ml-inference", name: "ML Model", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        const calls = recordCalls(n1);
        const warnings = [];
        n1.on("call:warn", (call) => warnings.push(String(call.args[0])));
        installStubModel(n1, () => [0.5]);
        n1.mlflowTracker = {
            runId: "run-2",
            logMetrics: () => {
                throw new Error("tracking server went away");
            }
        };
        n1.mlflowTrackingEnabled = true;
        const outputs = [];
        n2.on("input", (msg) => outputs.push(msg));

        n1.receive({ payload: [1, 2, 3] });
        await new Promise((r) => setTimeout(r, 200));

        expect(outputs).toHaveLength(1);
        expect(outputs[0].prediction).toEqual([0.5]);
        expect(calls.errors).toEqual([]);
        expect(warnings).toEqual(["[MLflowTracker] Failed to log metrics: tracking server went away"]);
    });

    describe("ONNX input shape", function () {
        it("fails the message when a fixed input shape does not match the input", async function () {
            // Used to warn and run the model on a [1,N] tensor instead.
            const flow = [
                { id: "n1", type: "ml-inference", name: "ML Model", inputShape: "1,5", wires: [["n2"]] },
                { id: "n2", type: "helper" }
            ];
            await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const calls = recordCalls(n1);
            const feeds = installOnnxStub(n1);
            let forwarded = 0;
            n2.on("input", () => forwarded++);

            n1.receive({ payload: [1, 2, 3, 4, 5, 6] });
            await new Promise((r) => setTimeout(r, 200));

            expect(forwarded).toBe(0);
            expect(feeds).toEqual([]);
            expect(calls.errors).toEqual([
                "Input shape [1,5] expects 5 values, got 6. Fix the node's Input Shape (use -1 for a dynamic dimension) or the input."
            ]);
        });

        conditionalIt(hasONNX)(
            "fills a dynamic dimension and takes the element type from the session",
            async function () {
                const flow = [
                    { id: "n1", type: "ml-inference", name: "Dyn", inputShape: "-1,5", wires: [["n3"]] },
                    { id: "n2", type: "ml-inference", name: "Int", inputShape: "1,5", wires: [["n3"]] },
                    { id: "n3", type: "helper" }
                ];
                await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
                const n1 = helper.getNode("n1");
                const n2 = helper.getNode("n2");
                const n3 = helper.getNode("n3");
                const dynFeeds = installOnnxStub(n1);
                const intFeeds = installOnnxStub(n2, {
                    inputMetadata: [{ name: "input", isTensor: true, type: "int64", shape: [1, 5] }]
                });
                const outputs = [];
                n3.on("input", (msg) => outputs.push(msg));

                n1.receive({ payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
                n2.receive({ payload: [1.7, 2.2, 3, 4, 5] });
                await new Promise((r) => setTimeout(r, 300));

                expect(outputs).toHaveLength(2);
                expect(dynFeeds).toHaveLength(1);
                expect(dynFeeds[0].input.dims).toEqual([2, 5]);
                expect(dynFeeds[0].input.type).toBe("float32");
                expect(intFeeds).toHaveLength(1);
                expect(intFeeds[0].input.type).toBe("int64");
                expect(Array.from(intFeeds[0].input.data, Number)).toEqual([1, 2, 3, 4, 5]);
            }
        );
    });

    describe("credentials", function () {
        const CREDENTIALS = ["urlAuthToken", "hfToken", "mlflowAuthToken", "customApiKey"];

        it("keeps the tokens out of the flow: editor defaults carry none, they are registered as credentials", function () {
            const html = fs.readFileSync(path.join(__dirname, "../nodes/ml-inference.html"), "utf8");
            const defaults = html.slice(html.indexOf("defaults: {"), html.indexOf("credentials: {"));
            for (const name of CREDENTIALS) {
                expect(defaults).not.toMatch(new RegExp("\\b" + name + "\\b"));
                // One password field per credential, with the id Node-RED binds credentials to.
                const inputs = html.match(new RegExp('id="node-input-' + name + '"', "g")) || [];
                expect(inputs).toHaveLength(1);
                expect(html).toMatch(new RegExp('<input type="password" id="node-input-' + name + '"'));
            }
            expect(html).toMatch(
                /credentials: \{\s*urlAuthToken: \{ type: "password" \},\s*hfToken: \{ type: "password" \},\s*mlflowAuthToken: \{ type: "password" \},\s*customApiKey: \{ type: "password" \}\s*\}/
            );
        });

        it("reads the tokens from the node credentials without warning", async function () {
            const flow = [{ id: "n1", type: "ml-inference", name: "ML Model" }];
            const creds = { urlAuthToken: "url-t", hfToken: "hf_x", mlflowAuthToken: "mlf-t", customApiKey: "key-x" };
            await new Promise((resolve) => helper.load(mlInferenceNode, flow, { n1: creds }, resolve));
            const n1 = helper.getNode("n1");
            expect(n1.urlAuthToken).toBe("url-t");
            expect(n1.hfToken).toBe("hf_x");
            expect(n1.mlflowAuthToken).toBe("mlf-t");
            expect(n1.customApiKey).toBe("key-x");
            expect(loggedWarnings().filter((w) => /plain text/.test(w))).toEqual([]);
        });

        it("still honours a token an old flow carries inline, and says so once", async function () {
            // Flows saved before the fields were credentials.
            const flow = [
                { id: "n1", type: "ml-inference", name: "Old", hfToken: "hf_plain", customApiKey: "k-plain" }
            ];
            await new Promise((resolve) => helper.load(mlInferenceNode, flow, resolve));
            const n1 = helper.getNode("n1");
            expect(n1.hfToken).toBe("hf_plain");
            expect(n1.customApiKey).toBe("k-plain");
            expect(n1.urlAuthToken).toBe("");
            const warnings = loggedWarnings().filter((w) => /plain text/.test(w));
            expect(warnings).toHaveLength(2);
            expect(warnings[0]).toMatch(/^ml-inference: hfToken is set in the node config/);
            expect(warnings[1]).toMatch(/^ml-inference: customApiKey is set in the node config/);
        });

        it("prefers the credential over an inline leftover", async function () {
            const flow = [{ id: "n1", type: "ml-inference", name: "Both", hfToken: "hf_plain" }];
            await new Promise((resolve) => helper.load(mlInferenceNode, flow, { n1: { hfToken: "hf_cred" } }, resolve));
            expect(helper.getNode("n1").hfToken).toBe("hf_cred");
            expect(loggedWarnings().filter((w) => /plain text/.test(w))).toEqual([]);
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
        const store = path.join(userDir, "ml-models");
        fs.mkdirSync(store, { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, "model.onnx"), path.join(store, "listed.onnx"));
        helper.load(mlInferenceNode, flow, function () {
            helper
                .request()
                .get("/ml-inference/models")
                .expect(200)
                .end(function (err, res) {
                    if (err) return done(err);
                    // No server paths in the response: models are named relative to the store.
                    expect(Object.keys(res.body)).toEqual(["models"]);
                    expect(JSON.stringify(res.body)).not.toContain(userDir);
                    expect(res.body.models.map((m) => m.name)).toContain("listed.onnx");
                    res.body.models.forEach(function (model) {
                        expect(typeof model.name).toBe("string");
                        expect(model.path).toBe(model.name);
                        expect(path.isAbsolute(model.path)).toBe(false);
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
