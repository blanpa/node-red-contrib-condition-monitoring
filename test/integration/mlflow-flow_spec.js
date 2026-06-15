"use strict";

/**
 * Regression tests for the MLflow model-registry integration of `ml-inference`.
 *
 * A mock MLflow REST server (plain HTTP) records every request, so we can assert
 * the node talks to the *correct* registry endpoints with the correct method and
 * protocol:
 *   - "latest" / stage  -> POST /api/2.0/mlflow/registered-models/get-latest-versions
 *   - specific version  -> GET  /api/2.0/mlflow/model-versions/get
 *   - the registry is reached over http:// (not hardcoded https)
 *
 * These guard the fixes for: hardcoded https (broke http registries) and the
 * non-existent `latest-versions/get` endpoint.
 */

const http = require("http");
const path = require("path");
const fs = require("fs");

const { startRed, buildFlow } = require("./red-runtime");

const ONNX_FIXTURE = path.resolve(__dirname, "..", "..", "nodes", "models", "bearing_fault_clf.onnx");

describe("integration: ml-inference MLflow registry resolution", () => {
    let harness;
    let mock;
    let mockPort;
    let requests;

    beforeAll(async () => {
        requests = [];
        const artifact = fs.readFileSync(ONNX_FIXTURE);

        mock = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                requests.push({ method: req.method, url: req.url, body });
                const json = (obj) => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(obj));
                };
                // --- Tracking API ---
                if (req.url.includes("experiments/get-by-name")) {
                    json({ experiment: { experiment_id: "1", name: "node-red-ml-inference" } });
                } else if (req.url.includes("experiments/create")) {
                    json({ experiment_id: "1" });
                } else if (req.url.includes("runs/create")) {
                    json({ run: { info: { run_id: "run-abc-123", experiment_id: "1" } } });
                } else if (req.url.includes("runs/log-batch")) {
                    json({});
                } else if (req.url.includes("runs/update")) {
                    json({});
                    // --- Registry API ---
                } else if (req.url.includes("registered-models/get-latest-versions")) {
                    json({
                        model_versions: [
                            {
                                name: "cm-model",
                                version: "3",
                                current_stage: "Production",
                                source: `http://127.0.0.1:${mockPort}/artifacts/model.onnx`
                            }
                        ]
                    });
                } else if (req.url.includes("model-versions/get")) {
                    json({
                        model_version: {
                            name: "cm-model",
                            version: "2",
                            source: `http://127.0.0.1:${mockPort}/artifacts/model.onnx`
                        }
                    });
                } else if (req.url.startsWith("/artifacts/")) {
                    res.writeHead(200, { "Content-Type": "application/octet-stream" });
                    res.end(artifact);
                } else {
                    res.writeHead(404);
                    res.end("{}");
                }
            });
        });
        await new Promise((r) => mock.listen(0, "127.0.0.1", r));
        mockPort = mock.address().port;

        harness = await startRed();
    }, 40000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
        if (mock) await new Promise((r) => mock.close(r));
    }, 20000);

    async function waitFor(predicate, timeoutMs = 8000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (requests.some(predicate)) return requests.find(predicate);
            await new Promise((r) => setTimeout(r, 50));
        }
        return null;
    }

    test("'latest' resolves via POST registered-models/get-latest-versions over http", async () => {
        requests.length = 0;
        const flow = buildFlow("mlf-tab", "mlflow latest", [
            {
                id: "mlf-node",
                type: "ml-inference",
                modelSource: "mlflow",
                modelType: "onnx",
                mlflowRegistryUri: `http://127.0.0.1:${mockPort}`,
                mlflowModelName: "cm-model",
                mlflowVersion: "latest",
                mlflowStage: "production",
                warmup: false,
                wires: [[]]
            }
        ]);
        await harness.deploy(flow);

        const latest = await waitFor((r) => r.url.includes("registered-models/get-latest-versions"));
        expect(latest).toBeTruthy();
        expect(latest.method).toBe("POST"); // GET would 404 — the old code used GET
        expect(JSON.parse(latest.body)).toMatchObject({ name: "cm-model", stages: ["production"] });

        // The artifact must then be fetched over http (proves the protocol fix).
        const artifactReq = await waitFor((r) => r.url.startsWith("/artifacts/"));
        expect(artifactReq).toBeTruthy();

        // The non-existent endpoint must never be hit.
        expect(requests.some((r) => r.url.includes("latest-versions/get?"))).toBe(false);
    }, 25000);

    test("a specific version resolves via GET model-versions/get", async () => {
        requests.length = 0;
        const flow = buildFlow("mlf-tab2", "mlflow version", [
            {
                id: "mlf-node2",
                type: "ml-inference",
                modelSource: "mlflow",
                modelType: "onnx",
                mlflowRegistryUri: `http://127.0.0.1:${mockPort}`,
                mlflowModelName: "cm-model",
                mlflowVersion: "2",
                warmup: false,
                wires: [[]]
            }
        ]);
        await harness.deploy(flow);

        const verReq = await waitFor((r) => r.url.includes("model-versions/get"));
        expect(verReq).toBeTruthy();
        expect(verReq.method).toBe("GET");
        expect(verReq.url).toContain("name=cm-model");
        expect(verReq.url).toContain("version=2");
    }, 25000);

    test("tracking: creates a run, logs params + metrics, ends the run on close", async () => {
        requests.length = 0;
        const modelPath = path.resolve(__dirname, "..", "fixtures", "model.onnx");
        const flow = buildFlow("mlf-track", "mlflow tracking", [
            {
                id: "mlf-track-node",
                type: "ml-inference",
                modelSource: "local",
                modelPath, // real fixture (allowlisted via process.cwd())
                modelType: "onnx",
                inputShape: "1,10",
                preprocessMode: "array",
                warmup: false,
                mlflowTrackingEnabled: true,
                mlflowTrackingUri: `http://127.0.0.1:${mockPort}`,
                mlflowExperimentName: "node-red-ml-inference",
                mlflowLogInferenceTime: true,
                mlflowBatchSize: 1, // flush each metric immediately (no 10s wait)
                wires: [[]]
            }
        ]);
        await harness.deploy(flow);

        // Run lifecycle: experiment lookup + run creation + params logged.
        const runCreate = await waitFor((r) => r.method === "POST" && r.url.includes("runs/create"));
        expect(runCreate).toBeTruthy();
        expect(
            requests.some((r) => r.url.includes("experiments/get-by-name") || r.url.includes("experiments/create"))
        ).toBe(true);
        const paramLog = await waitFor((r) => r.url.includes("runs/log-batch") && r.body.includes('"params"'));
        expect(paramLog).toBeTruthy();
        expect(JSON.parse(paramLog.body).run_id).toBe("run-abc-123");

        // Metric flush path: drive the live node's tracker directly. (Real ONNX
        // inference can't run inside jest's VM — onnxruntime rejects the tensor
        // because jest's sandboxed Float32Array is a different realm's constructor;
        // that path is covered by the standalone test/smoke-onnx.js.) bufferSize=1
        // means each logMetrics call flushes immediately to the mock.
        const node = harness.getNode("mlf-track-node");
        expect(node.mlflowTracker).toBeTruthy();
        node.mlflowTracker.logMetrics({ inference_time_ms: 12.5 });
        const metricLog = await waitFor(
            (r) =>
                r.url.includes("runs/log-batch") && r.body.includes('"metrics"') && r.body.includes("inference_time_ms")
        );
        expect(metricLog).toBeTruthy();
        expect(JSON.parse(metricLog.body).run_id).toBe("run-abc-123");

        // Closing the node (redeploy empty) ends the run.
        requests.length = 0;
        await harness.deploy([{ id: "empty-tab", type: "tab", label: "empty", disabled: false }]);
        const endRun = await waitFor((r) => r.method === "POST" && r.url.includes("runs/update"));
        expect(endRun).toBeTruthy();
        expect(JSON.parse(endRun.body)).toMatchObject({ run_id: "run-abc-123", status: "FINISHED" });
    }, 30000);
});
