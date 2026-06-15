const fs = require("fs");
const path = require("path");

const NODES_DIR = path.join(__dirname, "..", "nodes");
const catalog = JSON.parse(fs.readFileSync(path.join(NODES_DIR, "model-catalog.json"), "utf8"));

describe("model-catalog.json", () => {
    it("has a versioned models array", () => {
        expect(catalog.version).toBe(1);
        expect(Array.isArray(catalog.models)).toBe(true);
        expect(catalog.models.length).toBeGreaterThan(0);
    });

    it("every entry has the required fields", () => {
        const ids = new Set();
        for (const m of catalog.models) {
            expect(typeof m.id).toBe("string");
            expect(m.id.length).toBeGreaterThan(0);
            expect(ids.has(m.id)).toBe(false); // unique id
            ids.add(m.id);
            expect(typeof m.useCase).toBe("string");
            expect(typeof m.task).toBe("string");
            expect(["url", "bundled"]).toContain(m.source);
            expect(typeof m.license).toBe("string");
            expect(m.input && typeof m.input).toBe("object");
            expect(Array.isArray(m.input.shape)).toBe(true);
            expect(m.output && typeof m.output).toBe("object");
            expect(typeof m.output.annotation).toBe("string");
        }
    });

    it("url entries carry an https url and a 64-char sha256", () => {
        for (const m of catalog.models.filter((x) => x.source === "url")) {
            expect(m.url).toMatch(/^https:\/\//);
            expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it("bundled entries reference a file that ships in nodes/models/", () => {
        for (const m of catalog.models.filter((x) => x.source === "bundled")) {
            expect(typeof m.file).toBe("string");
            const p = path.join(NODES_DIR, "models", m.file);
            expect(fs.existsSync(p)).toBe(true);
            expect(fs.statSync(p).size).toBeGreaterThan(0);
        }
    });

    it("referenced label files exist in nodes/labels/", () => {
        for (const m of catalog.models) {
            if (m.output && typeof m.output.labels === "string") {
                const p = path.join(NODES_DIR, "labels", m.output.labels + ".txt");
                expect(fs.existsSync(p)).toBe(true);
            }
        }
    });
});
