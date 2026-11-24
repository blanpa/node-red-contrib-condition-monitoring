"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const createModelDownloader = require("../nodes/ml-inference-download");

/**
 * Unit tests for the download module: the content sniffing that decides which
 * downloaded formats may be auto-selected, and the TF.js integrity pin that
 * has to cover the weight shards, not just model.json. Everything runs
 * against a tiny in-process HTTP server; no ML runtime is involved.
 */
describe("ml-inference-download", () => {
    let tmp;
    let downloader;

    const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-download-"));
        downloader = createModelDownloader({ MODELS_DIR: path.join(tmp, "ml-models"), mlflowApiRequest: jest.fn() });
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    describe("finalizeDownloadedModel", () => {
        const HDF5 = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
        const PICKLE = Buffer.from([0x80, 0x04, 0x95, 0x10, 0x00, 0x00]);
        const TFLITE = Buffer.concat([Buffer.from([0x1c, 0, 0, 0]), Buffer.from("TFL3"), Buffer.alloc(8)]);

        function artifact(bytes) {
            const p = path.join(tmp, "m1.model");
            fs.writeFileSync(p, bytes);
            return p;
        }

        it("never auto-selects a pickle, and removes the download", () => {
            const p = artifact(PICKLE);
            expect(() => downloader.finalizeDownloadedModel(p, "auto")).toThrow(/looks like a Python pickle/);
            expect(fs.readdirSync(tmp)).toEqual([]);
        });

        it("never auto-selects a legacy Keras .h5, and removes the download", () => {
            const p = artifact(HDF5);
            expect(() => downloader.finalizeDownloadedModel(p, "auto")).toThrow(/legacy Keras HDF5 \(\.h5\)/);
            expect(fs.readdirSync(tmp)).toEqual([]);
        });

        it("treats a missing type like auto for the .h5 refusal", () => {
            const p = artifact(HDF5);
            expect(() => downloader.finalizeDownloadedModel(p, undefined)).toThrow(/\.h5/);
            expect(fs.existsSync(path.join(tmp, "m1.h5"))).toBe(false);
        });

        it("keeps an .h5 when the operator chose Keras explicitly", () => {
            const p = artifact(HDF5);
            expect(downloader.finalizeDownloadedModel(p, "keras")).toBe(path.join(tmp, "m1.h5"));
            expect(fs.existsSync(path.join(tmp, "m1.h5"))).toBe(true);
        });

        it("keeps a pickle when the operator chose scikit-learn explicitly", () => {
            const p = artifact(PICKLE);
            expect(downloader.finalizeDownloadedModel(p, "sklearn")).toBe(path.join(tmp, "m1.pkl"));
        });

        it("still sniffs the executable-free formats for auto", () => {
            expect(downloader.finalizeDownloadedModel(artifact(TFLITE), "auto")).toBe(path.join(tmp, "m1.tflite"));
            expect(downloader.finalizeDownloadedModel(artifact('{"format":"graph-model"}'), "auto")).toBe(
                path.join(tmp, "m1.json")
            );
            expect(downloader.finalizeDownloadedModel(artifact(Buffer.from([0x08, 0x07, 0x12])), "auto")).toBe(
                path.join(tmp, "m1.onnx")
            );
        });
    });

    describe("downloadTfjsModel SHA-256 pin", () => {
        let server;
        let base;
        let files;
        let hits;

        const SHARD_NAME = "group1-shard1of1.bin";
        const modelJson = Buffer.from(
            JSON.stringify({
                format: "graph-model",
                weightsManifest: [{ paths: [SHARD_NAME], weights: [{ name: "w", shape: [2], dtype: "float32" }] }]
            })
        );
        const shard = Buffer.from(Float32Array.from([1.5, -2.25]).buffer);
        const otherShard = Buffer.from(Float32Array.from([9, 9]).buffer);
        // The documented definition: model.json, then the shards in manifest order.
        const pin = sha256(Buffer.concat([modelJson, shard]));

        beforeAll((done) => {
            server = http.createServer((req, res) => {
                hits.push(req.url);
                const body = files[req.url];
                if (!body) {
                    res.writeHead(404);
                    res.end("no");
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/octet-stream" });
                res.end(body);
            });
            server.listen(0, "127.0.0.1", () => {
                base = `http://127.0.0.1:${server.address().port}`;
                done();
            });
        });

        afterAll((done) => {
            server.close(done);
        });

        beforeEach(() => {
            hits = [];
            files = { "/model.json": modelJson, ["/" + SHARD_NAME]: shard };
        });

        function leftovers(dir) {
            // Anything with the staging suffix next to the target directory.
            const parent = path.dirname(dir);
            return fs.existsSync(parent) ? fs.readdirSync(parent).filter((n) => n.endsWith(".part")) : [];
        }

        it("accepts a pin over model.json + shards in manifest order", async () => {
            const dir = path.join(tmp, "pinned");
            const result = await downloader.downloadTfjsModel(base + "/model.json", "none", "", pin, dir);
            expect(result).toBe(path.join(dir, "model.json"));
            expect(fs.readFileSync(path.join(dir, "model.json")).equals(modelJson)).toBe(true);
            expect(fs.readFileSync(path.join(dir, SHARD_NAME)).equals(shard)).toBe(true);
            expect(leftovers(dir)).toEqual([]);
            expect(hits).toEqual(["/model.json", "/" + SHARD_NAME]);
        });

        it("rejects a pin that covers model.json alone (the previous definition)", async () => {
            const dir = path.join(tmp, "old-pin");
            const err = await downloader
                .downloadTfjsModel(base + "/model.json", "none", "", sha256(modelJson), dir)
                .catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe("ESHAMISMATCH");
            expect(err.message).toMatch(/model\.json \+ 1 shard\(s\)/);
            expect(fs.existsSync(dir)).toBe(false);
            expect(leftovers(dir)).toEqual([]);
        });

        it("rejects when a weight shard was swapped under an unchanged model.json", async () => {
            files["/" + SHARD_NAME] = otherShard;
            const dir = path.join(tmp, "swapped");
            const err = await downloader.downloadTfjsModel(base + "/model.json", "none", "", pin, dir).catch((e) => e);
            expect(err.code).toBe("ESHAMISMATCH");
            expect(fs.existsSync(dir)).toBe(false);
        });

        it("keeps the previously cached copy when a pinned re-download fails", async () => {
            const dir = path.join(tmp, "cached");
            await downloader.downloadTfjsModel(base + "/model.json", "none", "", pin, dir);

            files["/" + SHARD_NAME] = otherShard;
            await expect(
                downloader.downloadTfjsModel(base + "/model.json", "none", "", pin, dir)
            ).rejects.toMatchObject({ code: "ESHAMISMATCH" });

            expect(fs.readFileSync(path.join(dir, SHARD_NAME)).equals(shard)).toBe(true);
            expect(leftovers(dir)).toEqual([]);
        });

        it("downloads without a pin into the default cache location", async () => {
            const result = await downloader.downloadTfjsModel(base + "/model.json", "none", "", "");
            expect(result.startsWith(path.join(tmp, "ml-models", "cache", "tfjs"))).toBe(true);
            expect(fs.existsSync(path.join(path.dirname(result), SHARD_NAME))).toBe(true);
            expect(leftovers(path.dirname(result))).toEqual([]);
        });

        it("rejects a malformed pin before downloading anything", async () => {
            await expect(downloader.downloadTfjsModel(base + "/model.json", "none", "", "nothex", tmp)).rejects.toThrow(
                /64-char hex/
            );
            expect(hits).toEqual([]);
        });

        it("refuses a shard path that climbs out of the model directory", async () => {
            files["/model.json"] = Buffer.from(JSON.stringify({ weightsManifest: [{ paths: ["../evil.bin"] }] }));
            files["/evil.bin"] = shard;
            const dir = path.join(tmp, "nested", "escape");
            await expect(downloader.downloadTfjsModel(base + "/model.json", "none", "", "", dir)).rejects.toThrow(
                /outside the allowed/
            );
            expect(fs.existsSync(path.join(tmp, "nested", "evil.bin"))).toBe(false);
            expect(fs.existsSync(dir)).toBe(false);
            expect(leftovers(dir)).toEqual([]);
        });

        it("exposes sha256OfFiles with the documented concatenation semantics", async () => {
            const a = path.join(tmp, "a.bin");
            const b = path.join(tmp, "b.bin");
            fs.writeFileSync(a, modelJson);
            fs.writeFileSync(b, shard);
            await expect(downloader.sha256OfFiles([a, b])).resolves.toBe(pin);
            await expect(downloader.sha256OfFiles([b, a])).resolves.not.toBe(pin);
            await expect(downloader.sha256OfFile(a)).resolves.toBe(sha256(modelJson));
        });
    });
});
