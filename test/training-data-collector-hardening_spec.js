"use strict";

/**
 * Regression tests for the training-data-collector hardening pass: exports that
 * cannot overwrite or race each other, usable time-series CSV, bounded disk
 * usage, failure backoff, and S3 keys kept out of the flow file.
 */

const helper = require("node-red-node-test-helper");
const collectorNode = require("../nodes/training-data-collector.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

helper.init(require.resolve("node-red"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("training-data-collector hardening", () => {
    let userDir;
    let dataDir;

    beforeEach((done) => {
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdc-hardening-"));
        dataDir = path.join(userDir, "training-data");
        helper.startServer(done);
    });

    afterEach((done) => {
        helper.unload().then(() => {
            helper.stopServer(() => {
                fs.rmSync(userDir, { recursive: true, force: true });
                done();
            });
        });
    });

    function load(cfg, credentials) {
        const flow = [
            Object.assign(
                {
                    id: "n1",
                    type: "training-data-collector",
                    datasetName: "ds",
                    mode: "batch",
                    autoSave: true,
                    bufferSize: 100,
                    flushOnDeploy: false,
                    exportFormat: "jsonl",
                    compressionEnabled: false,
                    shuffleOnExport: false,
                    includeMetadata: false,
                    splitTrain: 100,
                    splitVal: 0,
                    splitTest: 0,
                    wires: [["n2"]]
                },
                cfg
            ),
            { id: "n2", type: "helper" }
        ];
        return new Promise((resolve) => {
            helper.settings({ userDir });
            helper.load(collectorNode, flow, credentials ? { n1: credentials } : {}, () => {
                const n1 = helper.getNode("n1");
                const seen = [];
                helper.getNode("n2").on("input", (m) => seen.push(m));
                resolve({ n1, seen });
            });
        });
    }

    function dataFiles() {
        return fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => !f.endsWith(".part")) : [];
    }

    function readText(name) {
        const raw = fs.readFileSync(path.join(dataDir, name));
        return (name.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8");
    }

    function allJsonlValues() {
        const values = [];
        for (const name of dataFiles()) {
            for (const line of readText(name).split("\n")) {
                if (line.trim()) values.push(JSON.parse(line).features[0]);
            }
        }
        return values.sort((a, b) => a - b);
    }

    it("auto-saves within the same second/millisecond get distinct files — nothing is overwritten", async () => {
        const { n1 } = await load({ bufferSize: 5 });
        for (let i = 0; i < 50; i++) n1.receive({ payload: i });
        await sleep(400);
        expect(dataFiles().length).toBe(10);
        expect(allJsonlValues()).toEqual(Array.from({ length: 50 }, (_, i) => i));
        expect(n1.dataBuffer.length).toBe(0);
    });

    it("samples arriving while a (gzip) export is being written are neither lost nor exported twice", async () => {
        const { n1 } = await load({ bufferSize: 200, compressionEnabled: true, compressionThreshold: 1 });
        let sent = 0;
        for (let burst = 0; burst < 10; burst++) {
            for (let i = 0; i < 100; i++) n1.receive({ payload: sent++ });
            await new Promise((r) => setImmediate(r));
        }
        await sleep(600);
        const onDisk = allJsonlValues();
        const inBuffer = n1.dataBuffer.map((s) => s.values[0]);
        const all = onDisk.concat(inBuffer).sort((a, b) => a - b);
        expect(all).toEqual(Array.from({ length: 1000 }, (_, i) => i));
        expect(dataFiles().every((f) => f.endsWith(".jsonl.gz"))).toBe(true);
    });

    it("time-series mode writes the window values into the CSV (flattened per step)", async () => {
        const { n1, seen } = await load({
            mode: "timeseries",
            windowSize: 3,
            windowOverlap: 0,
            autoSave: false,
            exportFormat: "csv"
        });
        for (let i = 0; i < 6; i++) n1.receive({ payload: { a: i, b: i * 10 } });
        await sleep(30);
        n1.receive({ action: "export" });
        await sleep(200);
        expect(seen[0].payload.success).toBe(true);
        const lines = readText(dataFiles()[0]).trim().split("\n");
        expect(lines[0]).toBe("timestamp,t0_a,t0_b,t1_a,t1_b,t2_a,t2_b,label,severity");
        expect(lines[1].split(",").slice(1)).toEqual(["0", "0", "1", "10", "2", "20", "normal", "0"]);
        expect(lines[2].split(",").slice(1)).toEqual(["3", "30", "4", "40", "5", "50", "normal", "0"]);
    });

    it("a small window with a high overlap still slides (window stays bounded)", async () => {
        const { n1 } = await load({
            mode: "timeseries",
            windowSize: 10,
            windowOverlap: 95,
            autoSave: false,
            bufferSize: 100000
        });
        for (let i = 0; i < 300; i++) n1.receive({ payload: i });
        await sleep(50);
        expect(n1.windowBuffer.length).toBeLessThan(10);
        expect(n1.dataBuffer[n1.dataBuffer.length - 1].features.length).toBe(10);
    });

    it("a failing auto-save backs off instead of re-exporting on every message, and keeps the data", async () => {
        fs.writeFileSync(dataDir, "a file where the directory should be");
        const { n1 } = await load({ bufferSize: 5 });
        const errors = [];
        n1.error = (e) => errors.push(String(e));
        for (let i = 0; i < 30; i++) {
            n1.receive({ payload: i });
            await sleep(1);
        }
        await sleep(100);
        expect(errors.length).toBe(1);
        // 2x bufferSize hard cap still applies while the export is failing.
        expect(n1.dataBuffer.length).toBe(10);
        expect(n1.dataBuffer[n1.dataBuffer.length - 1].values[0]).toBe(29);
    });

    it("quotes CSV cells that contain commas, quotes or newlines", async () => {
        const { n1 } = await load({ autoSave: false, exportFormat: "csv", includeTimestamp: false });
        n1.receive({ payload: { temp: 1 }, label: 'hot, "very"' });
        await sleep(20);
        n1.receive({ action: "export" });
        await sleep(200);
        const lines = readText(dataFiles()[0]).trim().split("\n");
        expect(lines[0]).toBe("temp,label,severity");
        expect(lines[1]).toBe('1,"hot, ""very""",0');
    });

    it("honours the editor's splitTrain/splitVal/splitTest percentages", async () => {
        const { n1, seen } = await load({ autoSave: false, splitTrain: 50, splitVal: 50, splitTest: 0 });
        for (let i = 0; i < 10; i++) n1.receive({ payload: i });
        await sleep(20);
        n1.receive({ action: "export" });
        await sleep(200);
        expect(seen[0].payload.splits).toEqual({ train: 5, val: 5, test: 0 });
    });

    it("streaming mode appends in order, rotates at maxStreamFileMB and prunes to maxFiles", async () => {
        const { n1 } = await load({
            mode: "streaming",
            autoSave: false,
            maxStreamFileMB: 0.0003, // ~315 bytes → a handful of lines per file
            maxFiles: 2
        });
        for (let i = 0; i < 40; i++) n1.receive({ payload: i });
        await sleep(500);
        const files = dataFiles();
        const rotated = files.filter((f) => /^ds_stream_\d{4}-.*\.jsonl$/.test(f));
        expect(files).toContain("ds_stream.jsonl");
        expect(rotated.length).toBe(2);
        for (const f of files) {
            expect(fs.statSync(path.join(dataDir, f)).size).toBeLessThanOrEqual(0.0003 * 1024 * 1024);
        }
        // The newest lines are in the live file, in arrival order.
        const live = readText("ds_stream.jsonl")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l).features[0]);
        expect(live[live.length - 1]).toBe(39);
        expect(live).toEqual(live.slice().sort((a, b) => a - b));
    });

    it("without the new limits configured, the stream file is never rotated (old flows unchanged)", async () => {
        const { n1 } = await load({ mode: "streaming", autoSave: false });
        for (let i = 0; i < 40; i++) n1.receive({ payload: i });
        await sleep(300);
        expect(dataFiles()).toEqual(["ds_stream.jsonl"]);
        expect(readText("ds_stream.jsonl").trim().split("\n")).toHaveLength(40);
    });

    it("'clear' forgets the locked feature schema; resetRul rejects a non-numeric value", async () => {
        const { n1, seen } = await load({ autoSave: false, labelMode: "rul", rulStartValue: 50 });
        n1.receive({ payload: { a: 1, b: 2 } });
        n1.receive({ action: "clear" });
        n1.receive({ payload: { x: 1 } });
        n1.receive({ action: "resetRul", rulValue: "abc" });
        await sleep(50);
        expect(n1.featureNames).toEqual(["x"]);
        expect(n1.dataBuffer).toHaveLength(1);
        expect(seen[seen.length - 1].payload.rul).toBe(50);
    });

    it("does not turn a date-shaped string into the feature value 2024", async () => {
        const { n1 } = await load({ autoSave: false });
        n1.receive({ payload: { day: "2024-05-01", stamp: "2024-05-01T10:00:00Z", temp: "65.5", vib: 0.4 } });
        await sleep(30);
        expect(n1.featureNames).toEqual(["temp", "vib"]);
        expect(n1.dataBuffer[0].features).toEqual({ temp: 65.5, vib: 0.4 });
    });

    it("an explicitly selected date field counts as non-numeric (warned, 0) rather than 2024", async () => {
        const { n1 } = await load({
            autoSave: false,
            featureSource: "custom",
            featureFields: "payload.day,payload.temp"
        });
        const warnings = [];
        n1.warn = (w) => warnings.push(String(w));
        n1.receive({ payload: { day: "2024-05-01", temp: 65 } });
        await sleep(30);
        expect(n1.dataBuffer[0].features).toEqual({ "payload.day": 0, "payload.temp": 65 });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("payload.day");
    });

    it("the unused removeOutliers / outlierThreshold options are gone from runtime and editor", async () => {
        const { n1 } = await load({ autoSave: false, removeOutliers: true, outlierThreshold: 2 });
        // A flow that still carries the keys loads and collects everything.
        for (const v of [1, 1, 1, 1, 1000]) n1.receive({ payload: v });
        await sleep(30);
        expect(n1.dataBuffer).toHaveLength(5);
        expect(n1).not.toHaveProperty("removeOutliers");
        expect(n1).not.toHaveProperty("outlierThreshold");
        const html = fs.readFileSync(path.join(__dirname, "../nodes/training-data-collector.html"), "utf8");
        expect(html).not.toMatch(/removeOutliers|outlierThreshold/);
    });

    it("msg.payload.features === null is skipped, not thrown", async () => {
        const { n1 } = await load({ autoSave: false, featureSource: "payload.features" });
        const errors = [];
        n1.error = (e) => errors.push(e);
        n1.receive({ payload: { features: null } });
        await sleep(30);
        expect(errors).toHaveLength(0);
        expect(n1.dataBuffer).toHaveLength(0);
    });

    it("keeps S3 keys out of the flow: editor defaults carry none, they are registered as credentials", () => {
        const html = fs.readFileSync(path.join(__dirname, "../nodes/training-data-collector.html"), "utf8");
        const defaults = html.slice(html.indexOf("defaults: {"), html.indexOf("credentials: {"));
        expect(defaults).not.toMatch(/s3AccessKeyId|s3SecretAccessKey/);
        expect(html).toMatch(
            /credentials: \{\s*s3AccessKeyId: \{ type: "text" \},\s*s3SecretAccessKey: \{ type: "password" \}/
        );
    });

    const hasAwsSdk = (() => {
        try {
            require.resolve("@aws-sdk/client-s3");
            return true;
        } catch {
            return false;
        }
    })();

    (hasAwsSdk ? it : it.skip)(
        "builds the S3 client from node credentials, env vars or the default chain",
        async () => {
            const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
            delete process.env.AWS_ACCESS_KEY_ID;
            delete process.env.AWS_SECRET_ACCESS_KEY;
            try {
                let { n1 } = await load(
                    { s3Enabled: true, s3Bucket: "bucket" },
                    { s3AccessKeyId: "AKIANODE", s3SecretAccessKey: "node-secret" }
                );
                expect((await n1.s3Client.config.credentials()).accessKeyId).toBe("AKIANODE");
                await helper.unload();

                process.env.AWS_ACCESS_KEY_ID = "AKIAENV";
                process.env.AWS_SECRET_ACCESS_KEY = "env-secret";
                ({ n1 } = await load({ s3Enabled: true, s3Bucket: "bucket" }));
                expect((await n1.s3Client.config.credentials()).accessKeyId).toBe("AKIAENV");
                await helper.unload();

                // Plain-text keys left in an old flow are never used.
                delete process.env.AWS_ACCESS_KEY_ID;
                delete process.env.AWS_SECRET_ACCESS_KEY;
                ({ n1 } = await load({
                    s3Enabled: true,
                    s3Bucket: "bucket",
                    s3AccessKeyId: "AKIAFLOW",
                    s3SecretAccessKey: "flow-secret"
                }));
                // Default chain: a client exists (resolving it would hit the network, so it is not resolved here).
                expect(n1.s3Client.constructor.name).toBe("S3Client");
            } finally {
                if (saved.id !== undefined) process.env.AWS_ACCESS_KEY_ID = saved.id;
                if (saved.secret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
            }
        }
    );

    it("download route serves dataset files but refuses a symlink pointing outside the data dir", async () => {
        await load({ autoSave: false });
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, "ok.csv"), "a,b\n1,2");
        const secret = path.join(userDir, "secret.txt");
        fs.writeFileSync(secret, "top secret");
        fs.symlinkSync(secret, path.join(dataDir, "leak.csv"));

        const ok = await helper.request().get("/training-data-collector/download/ok.csv");
        expect(ok.status).toBe(200);
        expect(ok.text).toBe("a,b\n1,2");

        const leak = await helper.request().get("/training-data-collector/download/leak.csv");
        expect(leak.status).toBe(400);

        const list = await helper.request().get("/training-data-collector/datasets");
        expect(list.body.datasets.map((d) => d.name)).toEqual(["ok.csv"]);
    });
});
