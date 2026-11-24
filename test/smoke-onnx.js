#!/usr/bin/env node
/**
 * ONNX inference smoke test (standalone, outside Jest).
 *
 * Jest's VM sandbox creates a separate V8 context whose Float32Array
 * fails onnxruntime-node's native instanceof check.  This script
 * verifies ONNX inference end-to-end using node-red-node-test-helper
 * in plain Node.js where the check succeeds.
 *
 * Two checks:
 *   1. a fixture model returns the expected number;
 *   2. examples/07-ml-inference-onnx.json works as imported — its own
 *      ml-inference config and function-node code classify every machine
 *      state with the model bundled in this package.
 *
 * Usage:  node test/smoke-onnx.js
 */

const helper = require("node-red-node-test-helper");
const mlInferenceNode = require("../nodes/ml-inference.js");
const path = require("path");
const fs = require("fs");
const os = require("os");

const modelPath = path.resolve(__dirname, "fixtures", "model.onnx");

if (!fs.existsSync(modelPath)) {
    console.error("Model not found. Run:  npm run test:generate-fixtures");
    process.exit(1);
}

let ort;
try {
    ort = require("onnxruntime-node");
} catch {
    console.log("SKIP — onnxruntime-node not installed");
    process.exit(0);
}

// The runtime allowlists only the model store, the bundled models and
// `conditionMonitoring.allowedModelPaths` — not the cwd. Allowlist the
// fixtures and use a throw-away user dir so the model store is not created
// in $HOME (same setup as test/ml-inference_spec.js).
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-smoke-onnx-"));

helper.init(require.resolve("node-red"), {
    userDir: userDir,
    conditionMonitoring: { allowedModelPaths: [path.dirname(modelPath)] }
});

// Example 07, as shipped: the node config is used unchanged, the two function
// nodes run their own code against a minimal stand-in for the function-node
// sandbox (msg + context are all they use).
const example = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "examples", "07-ml-inference-onnx.json"), "utf8")
);
// Editor placement (tab, position) is dropped; everything else is the config.
const { z: _tab, x: _x, y: _y, ...exampleConfig } = example.find((n) => n.type === "ml-inference");
const exampleFunction = (id) => new Function("msg", "context", example.find((n) => n.id === id).func);
const buildFeatures = exampleFunction("ex07-features");
const labelPrediction = exampleFunction("ex07-label");

function runExample(e1, e2, done) {
    const store = new Map();
    const context = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
    const seen = new Set();
    const ticks = 25; // five machine states, five ticks each
    let tick = 0;

    e2.on("input", function (msg) {
        const result = labelPrediction(msg, context);
        const verdict = result && result.payload;
        if (!verdict || verdict.fault !== verdict.simulated) {
            console.error("FAIL — example 07 tick", tick, "returned", JSON.stringify(verdict || msg.prediction));
            done(1);
            return;
        }
        seen.add(verdict.fault);
        tick++;
        if (tick < ticks) {
            e1.receive(buildFeatures({}, context));
        } else if (seen.size !== 5) {
            console.error("FAIL — example 07 covered only", Array.from(seen).join(", "));
            done(1);
        } else {
            console.log("PASS — example 07 classified", Array.from(seen).join(", "));
            done(0);
        }
    });

    e1.receive(buildFeatures({}, context));
}

helper.startServer(function () {
    const flow = [
        {
            id: "n1",
            type: "ml-inference",
            name: "ONNX Model",
            modelPath: modelPath,
            modelType: "onnx",
            inputShape: "1,10",
            wires: [["n2"]]
        },
        { id: "n2", type: "helper" },
        Object.assign({}, exampleConfig, { id: "e1", wires: [["e2"]] }),
        { id: "e2", type: "helper" }
    ];

    helper.load(mlInferenceNode, flow, function () {
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        const e1 = helper.getNode("e1");
        const e2 = helper.getNode("e2");

        for (const node of [n1, e1]) {
            node.on("call:error", function (call) {
                console.error("FAIL — node error:", call.firstArg);
                cleanup(1);
            });
        }

        // Poll until model is loaded
        const start = Date.now();
        const iv = setInterval(function () {
            if (n1.modelLoaded && e1.modelLoaded) {
                clearInterval(iv);

                n2.on("input", function (msg) {
                    if (!msg.prediction) {
                        console.error("FAIL — no prediction in output");
                        cleanup(1);
                        return;
                    }

                    const pred = Array.isArray(msg.prediction) ? msg.prediction.flat() : [msg.prediction];
                    const expected = 5.5; // sum(1..10) * 0.1
                    const actual = pred[0];

                    if (Math.abs(actual - expected) < 0.01) {
                        console.log("PASS — ONNX inference returned", actual, "(expected", expected + ")");
                        runExample(e1, e2, cleanup);
                    } else {
                        console.error("FAIL — expected", expected, "got", actual);
                        cleanup(1);
                    }
                });

                n1.receive({ payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
            } else if (Date.now() - start > 10000) {
                clearInterval(iv);
                console.error("FAIL — models did not load within 10s");
                cleanup(1);
            }
        }, 100);
    });
});

function cleanup(code) {
    const exit = () => {
        fs.rmSync(userDir, { recursive: true, force: true });
        process.exit(code);
    };
    helper
        .unload()
        .then(() => helper.stopServer(exit))
        .catch(exit);
}
