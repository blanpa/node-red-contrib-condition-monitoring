"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = require("../package.json");
const lock = require("../package-lock.json");

/**
 * Dockerfile and Dockerfile.gpu copy the module into the image without its own
 * node_modules; everything it requires comes from one explicit `npm install`
 * list. A dependency missing from that list is only noticed when a node needs
 * it at runtime (the images shipped without fft.js, ml-matrix, ml-pca, jpeg-js
 * and pngjs that way), and a stale pin runs a version nothing here tests.
 */
function installedPackages(dockerfile) {
    const text = fs.readFileSync(path.join(root, dockerfile), "utf8").replace(/\\\r?\n/g, " ");
    const pins = new Map();
    for (const line of text.split(/\r?\n/)) {
        if (!/^\s*RUN npm install\b/.test(line)) continue;
        for (const token of line.split(/\s+/)) {
            const match = /^(@?[^@\s]+)@(\d[^\s]*)$/.exec(token);
            if (match) pins.set(match[1], match[2]);
        }
    }
    return pins;
}

function lockedVersion(name) {
    return lock.packages["node_modules/" + name].version;
}

describe.each(["Dockerfile", "Dockerfile.gpu"])("%s npm install list", (dockerfile) => {
    const pins = installedPackages(dockerfile);

    it.each(Object.keys(pkg.dependencies))("installs the required dependency %s at the locked version", (name) => {
        expect(pins.get(name)).toBe(lockedVersion(name));
    });

    it("installs onnxruntime-node at the locked version", () => {
        expect(pins.get("onnxruntime-node")).toBe(lockedVersion("onnxruntime-node"));
    });

    it("installs a TF.js backend at the locked version", () => {
        const backend = pins.get("@tensorflow/tfjs-node") || pins.get("@tensorflow/tfjs-node-gpu");
        expect(backend).toBe(lockedVersion("@tensorflow/tfjs-node"));
    });
});
