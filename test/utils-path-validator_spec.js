"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { validatePath, assertPath } = require("../nodes/utils/path-validator");

describe("utils/path-validator", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-pv-"));
    const allowed = path.join(tmpRoot, "models");
    fs.mkdirSync(allowed, { recursive: true });

    afterAll(() => {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch (_) {
            /* best effort */
        }
    });

    it("accepts a relative path under the allowlist", () => {
        const r = validatePath("./model.onnx", { allowedBases: [allowed], base: allowed });
        expect(r.ok).toBe(true);
        expect(r.resolved).toBe(path.join(allowed, "model.onnx"));
    });

    it("accepts an absolute path under the allowlist", () => {
        const target = path.join(allowed, "sub", "x.bin");
        const r = validatePath(target, { allowedBases: [allowed] });
        expect(r.ok).toBe(true);
        expect(r.resolved).toBe(path.normalize(target));
    });

    it("rejects ../ traversal", () => {
        const r = validatePath("../etc/passwd", { allowedBases: [allowed], base: allowed });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/outside the allowed directories/);
    });

    it("rejects an absolute path outside the allowlist", () => {
        const r = validatePath("/etc/passwd", { allowedBases: [allowed] });
        expect(r.ok).toBe(false);
    });

    it("does not consider a sibling prefix match as inside", () => {
        // /tmp/.../models vs /tmp/.../models-evil should not match.
        const sibling = allowed + "-evil";
        fs.mkdirSync(sibling, { recursive: true });
        const file = path.join(sibling, "x");
        fs.writeFileSync(file, "");
        const r = validatePath(file, { allowedBases: [allowed] });
        expect(r.ok).toBe(false);
    });

    it("rejects NUL byte in path", () => {
        const r = validatePath("model" + String.fromCharCode(0) + ".onnx", { allowedBases: [allowed] });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/NUL/);
    });

    it("rejects symlink that escapes the allowlist when followSymlinks=true", () => {
        const outside = path.join(tmpRoot, "outside.bin");
        fs.writeFileSync(outside, "secret");
        const link = path.join(allowed, "escape.bin");
        try {
            fs.symlinkSync(outside, link);
        } catch (e) {
            // symlinks may not be supported on this FS — skip
            return;
        }
        const r = validatePath(link, { allowedBases: [allowed], followSymlinks: true });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/outside the allowed directories/);
    });

    it("assertPath throws EPATHFORBIDDEN on rejection", () => {
        try {
            assertPath("../escape", { allowedBases: [allowed], base: allowed });
            throw new Error("expected throw");
        } catch (err) {
            expect(err.code).toBe("EPATHFORBIDDEN");
        }
    });

    it("assertPath returns the resolved path on success", () => {
        const got = assertPath("inner/m.onnx", { allowedBases: [allowed], base: allowed });
        expect(got).toBe(path.join(allowed, "inner", "m.onnx"));
    });

    it("rejects empty path / missing allowedBases", () => {
        expect(validatePath("", { allowedBases: [allowed] }).ok).toBe(false);
        expect(validatePath("x", { allowedBases: [] }).ok).toBe(false);
    });
});
