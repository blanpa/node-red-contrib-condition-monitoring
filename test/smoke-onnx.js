#!/usr/bin/env node
/**
 * ONNX inference smoke test (standalone, outside Jest).
 *
 * Jest's VM sandbox creates a separate V8 context whose Float32Array
 * fails onnxruntime-node's native instanceof check.  This script
 * verifies ONNX inference end-to-end using node-red-node-test-helper
 * in plain Node.js where the check succeeds.
 *
 * Usage:  node test/smoke-onnx.js
 */

const helper = require("node-red-node-test-helper");
const mlInferenceNode = require("../nodes/ml-inference.js");
const path = require("path");
const fs = require("fs");

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

helper.init(require.resolve("node-red"));

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
        { id: "n2", type: "helper" }
    ];

    helper.load(mlInferenceNode, flow, function () {
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");

        n1.on("call:error", function (call) {
            console.error("FAIL — node error:", call.firstArg);
            cleanup(1);
        });

        // Poll until model is loaded
        const start = Date.now();
        const iv = setInterval(function () {
            if (n1.modelLoaded) {
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
                        cleanup(0);
                    } else {
                        console.error("FAIL — expected", expected, "got", actual);
                        cleanup(1);
                    }
                });

                n1.receive({ payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
            } else if (Date.now() - start > 10000) {
                clearInterval(iv);
                console.error("FAIL — model did not load within 10s");
                cleanup(1);
            }
        }, 100);
    });
});

function cleanup(code) {
    helper
        .unload()
        .then(() => helper.stopServer(() => process.exit(code)))
        .catch(() => process.exit(code));
}
