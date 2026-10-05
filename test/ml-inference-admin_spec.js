"use strict";

/**
 * Unit tests for the ml-inference admin routes, mounted on a bare express app
 * that carries the same body parsers Node-RED puts on its admin router. No
 * Node-RED runtime, no ML runtime, no Python required (the one test that wants
 * an interpreter skips itself when none is installed).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const childProcess = require("child_process");
const { spawnSync } = childProcess;
const express = require("express");
const bodyParser = require("body-parser");

const registerAdminRoutes = require("../nodes/ml-inference-admin");

const hasPython3 = (() => {
    try {
        const r = spawnSync("python3", ["--version"], { stdio: "ignore" });
        return !r.error && r.status === 0;
    } catch {
        return false;
    }
})();

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {
                    /* not JSON */
                }
                resolve({ status: res.statusCode, text, json });
            });
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

describe("ml-inference admin routes", () => {
    let tmpRoot;
    let modelsDir;
    let server;
    let port;
    const savedMetadata = [];
    const realSpawn = childProcess.spawn;

    function sidecarOf(modelPath) {
        return path.join(path.dirname(modelPath), path.basename(modelPath, path.extname(modelPath)) + "_metadata.json");
    }

    beforeAll((done) => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-mladmin-"));
        modelsDir = path.join(tmpRoot, "ml-models");

        const app = express();
        // Same parsers (and default 5mb limit) as @node-red/editor-api.
        app.use(bodyParser.json({ limit: "5mb" }));
        app.use(bodyParser.urlencoded({ limit: "5mb", extended: true }));

        const RED = {
            httpAdmin: app,
            settings: {},
            auth: { needsPermission: () => (req, res, next) => next() }
        };
        registerAdminRoutes(RED, {
            MODELS_DIR: modelsDir,
            nodeDir: path.join(__dirname, "..", "nodes"),
            loadModelMetadata: (p) => {
                try {
                    return JSON.parse(fs.readFileSync(sidecarOf(p), "utf8"));
                } catch {
                    return null;
                }
            },
            saveModelMetadata: (p, metadata) => {
                savedMetadata.push({ path: p, metadata });
                fs.writeFileSync(sidecarOf(p), JSON.stringify(metadata));
                return true;
            },
            mlflowApiRequest: async () => ({}),
            loadTensorFlowJS: () => null,
            loadONNXRuntime: () => null,
            getMaxBridge: () => ({ getStatus: async () => ({}) }),
            getPythonBridgeState: () => ({ bridge: null, ready: false, error: null })
        });

        server = app.listen(0, "127.0.0.1", () => {
            port = server.address().port;
            done();
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        savedMetadata.length = 0;
    });

    afterAll((done) => {
        server.close(() => {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            done();
        });
    });

    describe("interpreter probes without Python on PATH", () => {
        // A failed spawn emits 'error' AND 'close'. Answering from both used to
        // throw ERR_HTTP_HEADERS_SENT out of an event handler and kill Node-RED.
        // An uncaught exception here fails the Jest run, which is the assertion.
        // (Jest hands tests a copy of process.env, so the missing interpreter
        // is simulated by pointing every spawn at a command that does not exist.)
        function withoutPython() {
            return jest
                .spyOn(childProcess, "spawn")
                .mockImplementation((cmd, args, options) => realSpawn("ncm-no-such-python-interpreter", args, options));
        }

        it("coral-status answers exactly once", async () => {
            const spy = withoutPython();
            const res = await request(port, "GET", "/ml-inference/coral-status");
            expect(spy).toHaveBeenCalledTimes(1);
            expect(res.status).toBe(200);
            expect(res.json).toEqual({ available: false, count: 0 });
            await new Promise((resolve) => setTimeout(resolve, 200));
        });

        it("python-status tries each candidate once and answers exactly once", async () => {
            const spy = withoutPython();
            const res = await request(port, "GET", "/ml-inference/python-status");
            expect(res.status).toBe(200);
            expect(res.json).toEqual({ available: false, version: null, packages: [] });
            await new Promise((resolve) => setTimeout(resolve, 200));
            // python3, then python — not the 2+4 spawns the double-fired handlers caused.
            expect(spy).toHaveBeenCalledTimes(2);
        });
    });

    (hasPython3 ? it : it.skip)("python-status reports importable ML packages", async () => {
        // A stand-in "sklearn" package proves the probe script itself runs —
        // it used to die with an IndentationError and always report [].
        const fakeSite = path.join(tmpRoot, "site");
        fs.mkdirSync(path.join(fakeSite, "sklearn"), { recursive: true });
        fs.writeFileSync(path.join(fakeSite, "sklearn", "__init__.py"), "");
        jest.spyOn(childProcess, "spawn").mockImplementation((cmd, args, options) =>
            realSpawn(cmd, args, { ...options, env: { ...process.env, PYTHONPATH: fakeSite } })
        );

        const res = await request(port, "GET", "/ml-inference/python-status");
        expect(res.json.available).toBe(true);
        expect(res.json.version).toMatch(/^\d+\.\d+/);
        expect(res.json.packages).toContain("sklearn");
    });

    describe("upload", () => {
        it("refuses a multipart form instead of storing its envelope as the model", async () => {
            const boundary = "----testboundary";
            const body = Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="iforest.pkl"\r\n` +
                    `Content-Type: application/octet-stream\r\n\r\nREALMODELBYTES\r\n--${boundary}--\r\n`
            );
            const res = await request(port, "POST", "/ml-inference/upload", {
                headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
                body
            });
            expect(res.status).toBe(415);
            expect(fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir) : []).toEqual([]);
        });

        it("stores a raw upload byte-for-byte under its own name and type", async () => {
            const body = Buffer.from([0x80, 0x04, 0x95, 0x00, 0xff, 0x10]);
            const res = await request(port, "POST", "/ml-inference/upload", {
                headers: {
                    "Content-Type": "application/octet-stream",
                    "X-Filename": "iforest.pkl",
                    "Content-Length": body.length
                },
                body
            });
            expect(res.status).toBe(200);
            expect(res.json.name).toBe("iforest.pkl");
            expect(fs.readFileSync(res.json.path).equals(body)).toBe(true);
            expect(res.json.metadata.type).toBe("sklearn");
            expect(res.json.metadata.format).toBe("sklearn");
        });

        it("accepts TF.js parts one by one into a model directory, beyond the JSON body limit", async () => {
            const shard = Buffer.alloc(6 * 1024 * 1024, 7); // > Node-RED's 5mb apiMaxLength
            const dir = "tfjs_model_test";
            const shardRes = await request(port, "POST", "/ml-inference/upload", {
                headers: {
                    "Content-Type": "application/octet-stream",
                    "X-Filename": "group1-shard1of1.bin",
                    "X-Model-Dir": dir,
                    "Content-Length": shard.length
                },
                body: shard
            });
            expect(shardRes.status).toBe(200);
            expect(shardRes.json.metadata).toBeNull();

            const modelJson = Buffer.from(JSON.stringify({ format: "graph-model", weightsManifest: [] }));
            const jsonRes = await request(port, "POST", "/ml-inference/upload", {
                headers: {
                    "Content-Type": "application/octet-stream",
                    "X-Filename": "model.json",
                    "X-Model-Dir": dir,
                    "Content-Length": modelJson.length
                },
                body: modelJson
            });
            expect(jsonRes.status).toBe(200);
            expect(jsonRes.json.dir).toBe(path.join(modelsDir, dir));
            expect(jsonRes.json.metadata.type).toBe("tfjs");
            expect(fs.statSync(path.join(modelsDir, dir, "group1-shard1of1.bin")).size).toBe(shard.length);
            expect(fs.readFileSync(path.join(modelsDir, dir, "model.json")).equals(modelJson)).toBe(true);
        });

        it("keeps a traversal attempt in X-Model-Dir inside the model store", async () => {
            const body = Buffer.from("x");
            const res = await request(port, "POST", "/ml-inference/upload", {
                headers: {
                    "Content-Type": "application/octet-stream",
                    "X-Filename": "w.bin",
                    "X-Model-Dir": "../../escaped",
                    "Content-Length": body.length
                },
                body
            });
            expect(res.status).toBe(200);
            expect(res.json.path).toBe(path.join(modelsDir, "escaped", "w.bin"));
            expect(fs.existsSync(path.join(tmpRoot, "escaped"))).toBe(false);
        });
    });

    describe("model store listing and deletion", () => {
        it("lists every supported model type but not sidecars or the download cache", async () => {
            fs.mkdirSync(path.join(modelsDir, "cache", "hf"), { recursive: true });
            fs.writeFileSync(path.join(modelsDir, "net.keras"), "k");
            fs.writeFileSync(path.join(modelsDir, "clf.joblib"), "j");

            const res = await request(port, "GET", "/ml-inference/models");
            expect(res.status).toBe(200);
            const byName = Object.fromEntries(res.json.models.map((m) => [m.name, m.type]));
            expect(byName["iforest.pkl"]).toBe("sklearn");
            expect(byName["net.keras"]).toBe("keras");
            expect(byName["clf.joblib"]).toBe("sklearn");
            expect(byName["tfjs_model_test"]).toBe("tfjs");
            expect(byName).not.toHaveProperty("cache");
            expect(Object.keys(byName).some((n) => /_metadata\.json$/.test(n))).toBe(false);
        });

        it("deletes the metadata sidecar together with the model", async () => {
            const modelPath = path.join(modelsDir, "iforest.pkl");
            expect(fs.existsSync(sidecarOf(modelPath))).toBe(true);
            const res = await request(port, "DELETE", "/ml-inference/models/iforest.pkl");
            expect(res.status).toBe(200);
            expect(fs.existsSync(modelPath)).toBe(false);
            expect(fs.existsSync(sidecarOf(modelPath))).toBe(false);
        });
    });
});
