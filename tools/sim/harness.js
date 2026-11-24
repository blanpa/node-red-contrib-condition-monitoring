/* Minimal harness: run a node from this package inside a real Node-RED test runtime.
 * Must be run with the repository root as working directory (the test helper
 * locates node-red via the nearest package.json). */
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..", "..");
const helper = require("node-red-node-test-helper");
helper.init(require.resolve("node-red"));

function startServer() {
    return new Promise((res) => helper.startServer(res));
}
function stopServer() {
    return new Promise((res) => helper.stopServer(res));
}

/**
 * Load `nodeModule` with `config`, feed `messages` one by one, collect outputs.
 * Resolves with { normal: [...], anomaly: [...] } once `expected` outputs arrived
 * or `settleMs` passed without new output.
 */
async function run(nodeModule, config, messages, opts) {
    opts = Object.assign({ settleMs: 400, expected: Infinity }, opts || {});
    const flow = [
        Object.assign({ id: "n1", wires: [["n2"], ["n3"]] }, config),
        { id: "n2", type: "helper" },
        { id: "n3", type: "helper" }
    ];
    await new Promise((res, rej) => helper.load(nodeModule, flow, (e) => (e ? rej(e) : res())));
    const n1 = helper.getNode("n1");
    const out = { normal: [], anomaly: [] };
    let timer;
    let resolveDone;
    const done = new Promise((res) => (resolveDone = res));
    const total = () => out.normal.length + out.anomaly.length;
    const bump = () => {
        clearTimeout(timer);
        if (total() >= opts.expected) return resolveDone();
        timer = setTimeout(resolveDone, opts.settleMs);
    };
    helper.getNode("n2").on("input", (m) => {
        out.normal.push(m);
        bump();
    });
    helper.getNode("n3").on("input", (m) => {
        out.anomaly.push(m);
        bump();
    });
    bump();
    for (const m of messages) n1.receive(m);
    await done;
    clearTimeout(timer);
    await helper.unload();
    return out;
}

module.exports = { startServer, stopServer, run, REPO };
