"use strict";

/**
 * Security regression tests for the `ml-inference` admin routes, driven against
 * a real Node-RED runtime with the routes mounted under /red.
 *
 * These cover, in order of severity:
 *   - `POST /ml-inference/upload-tfjs` used a bare `path.join(modelDir, w.name)`
 *     on attacker-controlled JSON, so a weight named "../../x" wrote outside the
 *     model directory.
 *   - `POST /ml-inference/upload` buffered the request body with no ceiling.
 *   - `GET  /ml-inference/registries/mlflow/models` made the runtime fetch any
 *     URL it was handed with a caller-chosen bearer token, under read
 *     permission. The editor never called it; it is gone, and so is the
 *     equally unused `GET /ml-inference/models/:name/versions`.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");

const { startRed } = require("./red-runtime");

const MAX_UPLOAD = 4096;

function request(port, method, route, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                method,
                path: "/red" + route,
                // No connection reuse: the over-limit case destroys the socket
                // mid-body, and a pooled socket would carry that into the next
                // request.
                agent: false,
                headers: Object.assign(
                    payload ? { "Content-Length": payload.length, "Content-Type": "application/json" } : {},
                    headers || {}
                )
            },
            (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    // Not every response is JSON (res.download, error pages).
                    let json = null;
                    try {
                        json = JSON.parse(data);
                    } catch {
                        json = null;
                    }
                    resolve({ status: res.statusCode, body: data, json });
                });
            }
        );
        // A 413 destroys the request mid-stream; that is the expected outcome,
        // not a test failure.
        req.on("error", (err) => (err.code === "ECONNRESET" ? resolve({ status: 413, aborted: true }) : reject(err)));
        if (payload) req.write(payload);
        req.end();
    });
}

describe("integration: ml-inference admin routes", () => {
    let harness;
    let modelsDir;

    beforeAll(async () => {
        harness = await startRed({ settings: { mlInferenceMaxUploadBytes: MAX_UPLOAD } });
        modelsDir = path.join(harness.userDir, "ml-models");
    }, 40000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    });

    describe("upload-tfjs weight-name traversal", () => {
        it("confines a `../../` weight name to the model directory", async () => {
            const res = await request(harness.port, "POST", "/ml-inference/upload-tfjs", {
                body: JSON.stringify({
                    name: "trav_model",
                    modelJson: '{"format":"graph-model"}',
                    weights: [{ name: "../../escaped.bin", data: Buffer.from("pwned").toString("base64") }]
                })
            });

            expect(res.status).toBe(200);

            // Nothing may appear above the model's own directory.
            expect(fs.existsSync(path.join(harness.userDir, "escaped.bin"))).toBe(false);
            expect(fs.existsSync(path.join(modelsDir, "escaped.bin"))).toBe(false);
            expect(fs.existsSync(path.join(modelsDir, "trav_model", "escaped.bin"))).toBe(true);
        });

        it("confines an absolute weight path to the model directory", async () => {
            const outside = path.join(harness.userDir, "absolute_pwned.bin");
            const res = await request(harness.port, "POST", "/ml-inference/upload-tfjs", {
                body: JSON.stringify({
                    name: "abs_model",
                    modelJson: "{}",
                    weights: [{ name: outside, data: Buffer.from("x").toString("base64") }]
                })
            });

            expect(res.status).toBe(200);
            expect(fs.existsSync(outside)).toBe(false);
            expect(fs.existsSync(path.join(modelsDir, "abs_model", "absolute_pwned.bin"))).toBe(true);
        });

        it("rejects a weight name that is nothing but dots", async () => {
            const res = await request(harness.port, "POST", "/ml-inference/upload-tfjs", {
                body: JSON.stringify({
                    name: "dots_model",
                    modelJson: "{}",
                    weights: [{ name: "..", data: "" }]
                })
            });

            expect(res.status).toBe(400);
            expect(res.json.error).toMatch(/unsafe file name/i);
        });

        it("confines a `../` model name too", async () => {
            const res = await request(harness.port, "POST", "/ml-inference/upload-tfjs", {
                body: JSON.stringify({ name: "../hoisted", modelJson: "{}", weights: [] })
            });

            expect(res.status).toBe(200);
            expect(fs.existsSync(path.join(harness.userDir, "hoisted"))).toBe(false);
            expect(fs.existsSync(path.join(modelsDir, "hoisted"))).toBe(true);
        });
    });

    describe("upload body ceiling", () => {
        it("accepts a body inside the limit", async () => {
            const res = await request(harness.port, "POST", "/ml-inference/upload", {
                body: Buffer.alloc(MAX_UPLOAD - 512, 0x41),
                headers: { "Content-Type": "application/octet-stream", "x-filename": "small.onnx" }
            });

            expect(res.status).toBe(200);
            expect(fs.existsSync(path.join(modelsDir, "small.onnx"))).toBe(true);
        });

        it("refuses a body over the limit instead of buffering it", async () => {
            const res = await request(harness.port, "POST", "/ml-inference/upload", {
                body: Buffer.alloc(MAX_UPLOAD * 4, 0x42),
                headers: { "Content-Type": "application/octet-stream", "x-filename": "huge.onnx" }
            });

            expect(res.status).toBe(413);
            expect(fs.existsSync(path.join(modelsDir, "huge.onnx"))).toBe(false);
        });

        it("confines a traversing x-filename to the models directory", async () => {
            const res = await request(harness.port, "POST", "/ml-inference/upload", {
                body: Buffer.from("model-bytes"),
                headers: { "Content-Type": "application/octet-stream", "x-filename": "../../../evil.onnx" }
            });

            expect(res.status).toBe(200);
            expect(fs.existsSync(path.join(harness.userDir, "evil.onnx"))).toBe(false);
            expect(fs.existsSync(path.join(modelsDir, "evil.onnx"))).toBe(true);
        });
    });

    describe("removed routes stay removed", () => {
        let mock;
        let mockPort;
        let hits;

        beforeAll(async () => {
            hits = 0;
            mock = http.createServer((req, res) => {
                hits++;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ registered_models: [] }));
            });
            await new Promise((r) => mock.listen(0, "127.0.0.1", r));
            mockPort = mock.address().port;
        });

        afterAll(async () => {
            await new Promise((r) => mock.close(r));
        });

        it("the MLflow registry proxy is gone: 404, and the runtime contacts nobody", async () => {
            const res = await request(
                harness.port,
                "GET",
                "/ml-inference/registries/mlflow/models?registryUri=" +
                    encodeURIComponent(`http://127.0.0.1:${mockPort}/?`),
                { headers: { "x-mlflow-token": "s3cr3t" } }
            );

            expect(res.status).toBe(404);
            await new Promise((r) => setTimeout(r, 100));
            expect(hits).toBe(0);
        });

        it("the model versions route is gone: 404", async () => {
            const res = await request(harness.port, "GET", "/ml-inference/models/small.onnx/versions");
            expect(res.status).toBe(404);
        });
    });

    describe("model listing", () => {
        it("names models relative to the store and discloses no server path", async () => {
            const res = await request(harness.port, "GET", "/ml-inference/models");

            expect(res.status).toBe(200);
            expect(Object.keys(res.json)).toEqual(["models"]);
            expect(res.body).not.toContain(harness.userDir);
            const names = res.json.models.map((m) => m.name);
            expect(names).toContain("small.onnx");
            for (const m of res.json.models) {
                expect(m.path).toBe(m.name);
            }
        });
    });

    describe("every registered route responds", () => {
        // The routes live in their own module (ml-inference-admin.js) and take
        // their runtime state by injection. A missing dependency would only
        // surface as a ReferenceError when the route is actually hit — several
        // of these have no behavioural test of their own, so at minimum prove
        // each one runs to a response.
        const ROUTES = [
            "/ml-inference/model-catalog",
            "/ml-inference/runtimes",
            "/ml-inference/python-bridge",
            "/ml-inference/python-status",
            "/ml-inference/max-status",
            "/ml-inference/coral-status",
            "/ml-inference/models",
            "/ml-inference/registries"
        ];

        it.each(ROUTES)(
            "GET %s answers without a runtime error",
            async (route) => {
                const res = await request(harness.port, "GET", route);

                expect(res.status).toBeLessThan(500);
                expect(res.body).not.toMatch(/ReferenceError|is not defined|is not a function/);
            },
            20000
        );
    });

    describe("delete route", () => {
        it("cannot be walked out of the models directory", async () => {
            const bystander = path.join(harness.userDir, "bystander.txt");
            fs.writeFileSync(bystander, "do not delete me");

            const res = await request(
                harness.port,
                "DELETE",
                "/ml-inference/models/" + encodeURIComponent("../bystander.txt")
            );

            // Resolved to <modelsDir>/bystander.txt, which does not exist.
            expect(res.status).toBe(404);
            expect(fs.existsSync(bystander)).toBe(true);
        });
    });
});
