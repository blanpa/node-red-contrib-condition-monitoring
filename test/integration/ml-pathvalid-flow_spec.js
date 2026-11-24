"use strict";

const path = require("path");
const fs = require("fs");

const { startRed, captureNode, buildFlow } = require("./red-runtime");

/**
 * End-to-end check that ml-inference refuses model paths outside the
 * configured allowlist. The harness pins `conditionMonitoring.allowedModelPaths`
 * to `<userDir>/models` only, so anything else (including a `..` traversal
 * back to the repo root, and an absolute `/etc/passwd`-style path) must be
 * rejected with code `EPATHFORBIDDEN`.
 *
 * Verifies PR2 (path-validator wired into every loadXxxModel path).
 */
describe("integration: ml-inference path validation", () => {
    let harness;
    const TAB = "ml-tab";

    beforeAll(async () => {
        harness = await startRed();
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 15000);

    async function deployWithModelPath(modelPath, modelType = "onnx") {
        const NODE = "ml-node";
        const CAP = "ml-cap";
        const flow = buildFlow(TAB, "ml validation", [
            {
                id: NODE,
                type: "ml-inference",
                name: "ml infer",
                modelSource: "local",
                modelType,
                modelPath,
                inputShape: "1,4",
                wires: [[CAP]]
            },
            captureNode(CAP, "ml capture")
        ]);
        await harness.deploy(flow);

        // initializeModel() runs async on deploy; give it a generous moment.
        const node = await harness.getNodeAsync(NODE, 3000);
        for (let i = 0; i < 30; i++) {
            if (node.loadError || node.modelLoaded) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        return node;
    }

    it("refuses a `..` traversal that escapes the allowed model dir", async () => {
        const node = await deployWithModelPath("../../../../etc/passwd");
        expect(node.modelLoaded).toBe(false);
        expect(node.loadError).toBeDefined();
        // Either the path-validator blocked it (EPATHFORBIDDEN) or the
        // resolver rejected it because the file isn't a model — the path
        // validator runs first, so we expect its error code.
        expect(node.loadError.code || node.loadError.message).toMatch(
            /EPATHFORBIDDEN|outside the allowed directories|Refusing to use path/
        );
    });

    it("refuses an absolute path outside the allowlist", async () => {
        const node = await deployWithModelPath("/etc/passwd");
        expect(node.modelLoaded).toBe(false);
        expect(node.loadError).toBeDefined();
        expect(node.loadError.code || node.loadError.message).toMatch(
            /EPATHFORBIDDEN|outside the allowed directories|Refusing to use path/
        );
    });

    it("accepts a path inside the configured allowlist (file may not exist, but path passes)", async () => {
        // Create a fake .onnx file in the allowed directory. ONNX runtime
        // isn't installed in the bare CI env, so loading itself will fail;
        // what we want to verify is that the failure is *not* the path
        // validator's rejection. The error must mention onnx/runtime, not
        // path-validation.
        const allowedDir = path.join(harness.userDir, "models");
        fs.mkdirSync(allowedDir, { recursive: true });
        const fakeModel = path.join(allowedDir, "fake.onnx");
        fs.writeFileSync(fakeModel, "not a real onnx file");

        const node = await deployWithModelPath(fakeModel);
        // We expect modelLoaded === false (the bytes aren't a real model),
        // but the rejection must NOT be from the path validator.
        expect(node.modelLoaded).toBe(false);
        if (node.loadError) {
            // Flexible: as long as it's not EPATHFORBIDDEN, we passed validation.
            expect(node.loadError.code).not.toBe("EPATHFORBIDDEN");
            expect(node.loadError.message).not.toMatch(/Refusing to use path|outside the allowed directories/);
        }
    });

    // The user dir and the process cwd were allowlisted wholesale up to 0.4.0.
    // The user dir holds flows_cred.json and settings.js; a cwd of "/" (systemd's
    // default WorkingDirectory) allowlisted the whole filesystem.
    it("refuses a path inside the Node-RED user dir that is not allowlisted", async () => {
        const node = await deployWithModelPath(path.join(harness.userDir, "flows_cred.onnx"));
        expect(node.modelLoaded).toBe(false);
        expect(node.loadError.code).toBe("EPATHFORBIDDEN");
    });

    it("refuses an existing model file under the process cwd that is not allowlisted", async () => {
        const underCwd = path.join(process.cwd(), "test", "fixtures", "model.onnx");
        expect(fs.existsSync(underCwd)).toBe(true);
        const node = await deployWithModelPath(underCwd);
        expect(node.modelLoaded).toBe(false);
        expect(node.loadError.code).toBe("EPATHFORBIDDEN");
    });

    it("accepts a bundled model by its catalog path (models/<file>)", async () => {
        // Relative paths resolve against the bundled models dir before the cwd.
        const node = await deployWithModelPath("models/bearing_fault_clf.onnx");
        if (node.loadError) {
            // Only the optional runtime may be missing.
            expect(node.loadError.code).not.toBe("EPATHFORBIDDEN");
            expect(node.loadError.message).toMatch(/^ONNX Runtime not available/);
        } else {
            expect(node.modelLoaded).toBe(true);
        }
    });
});
