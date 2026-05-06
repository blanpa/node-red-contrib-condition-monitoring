/**
 * Real Node-RED runtime harness for integration tests.
 *
 * Spins up a real Node-RED server (`require('node-red')`) on an ephemeral
 * port with this package's nodes loaded. Tests deploy flows via the runtime
 * API, send messages by addressing inject-replacement nodes directly, and
 * collect outputs from a "capture" function-node that pushes every message
 * into an in-memory buffer.
 *
 * Usage:
 *
 *   const harness = await startRed();
 *   await harness.deploy(flowJson);
 *   const out = await harness.collect({ from: 'capture-id', count: 1 });
 *   await harness.shutdown();
 *
 * The harness avoids the test-helper shortcuts: every node runs through the
 * full Node-RED registry, the runtime API is the same as production. That
 * way refactors that pass `helper`-driven tests but break real deployments
 * surface here.
 */

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const RED = require("node-red");
const express = require("express");

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

// Random port in the 21000–28999 range so that parallel Jest workers don't
// collide with each other on a fixed offset. We retry inside startRed() if
// the listen call comes back EADDRINUSE.
function nextPort() {
    return 21000 + Math.floor(Math.random() * 8000);
}

async function startRed(options = {}) {
    const port = options.port || nextPort();
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm-int-"));

    // Make Node-RED's auto-discovery find this package. Symlinks confuse the
    // loader (it computes realpath and ends up registering the package twice
    // when the same module is also visible from process.cwd()'s node_modules).
    // Instead we drop a thin "passthrough" package into userDir/node_modules:
    //   - a copied package.json so the loader picks up the node-red metadata
    //   - .js entry files that simply require() back into the source tree
    const userNodeModules = path.join(userDir, "node_modules");
    const passthrough = path.join(userNodeModules, "node-red-contrib-condition-monitoring");
    fs.mkdirSync(passthrough, { recursive: true });
    fs.mkdirSync(path.join(passthrough, "nodes"), { recursive: true });

    const srcPkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    fs.writeFileSync(path.join(passthrough, "package.json"), JSON.stringify(srcPkg, null, 2));

    // For every entry in node-red.nodes, write a tiny stub that re-exports
    // the real implementation. Same trick for the matching .html file: copy
    // it across so the editor metadata loads (Node-RED reads <name>.html next
    // to <name>.js to discover the type).
    for (const [, relPath] of Object.entries(srcPkg["node-red"].nodes)) {
        const stubPath = path.join(passthrough, relPath);
        const realPath = path.join(PACKAGE_ROOT, relPath).replace(/\\/g, "/");
        fs.mkdirSync(path.dirname(stubPath), { recursive: true });
        fs.writeFileSync(stubPath, `module.exports = require(${JSON.stringify(realPath)});\n`);
        const htmlSrc = realPath.replace(/\.js$/, ".html");
        const htmlDst = stubPath.replace(/\.js$/, ".html");
        if (fs.existsSync(htmlSrc)) {
            fs.copyFileSync(htmlSrc, htmlDst);
        }
    }

    fs.writeFileSync(
        path.join(userDir, "package.json"),
        JSON.stringify(
            {
                name: "ncm-int-test",
                version: "0.0.0",
                dependencies: { "node-red-contrib-condition-monitoring": "*" }
            },
            null,
            2
        )
    );

    const app = express();
    const server = http.createServer(app);

    const settings = {
        httpAdminRoot: "/red",
        httpNodeRoot: "/api",
        userDir,
        flowFile: "flows.json",
        logging: {
            console: {
                level: process.env.NCM_INT_LOG || "off",
                metrics: false,
                audit: false
            }
        },
        functionGlobalContext: {},
        // Confine path-validator allowlist to the temp userDir only — production
        // would extend it; for tests this is enough and lets us prove rejection.
        conditionMonitoring: {
            allowedModelPaths: [path.join(userDir, "models")]
        }
    };

    RED.init(server, settings);
    app.use(settings.httpAdminRoot, RED.httpAdmin);
    app.use(settings.httpNodeRoot, RED.httpNode);

    let listenPort = port;
    let attempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            await new Promise((resolve, reject) => {
                const onError = (err) => {
                    server.removeListener("listening", onListening);
                    reject(err);
                };
                const onListening = () => {
                    server.removeListener("error", onError);
                    resolve();
                };
                server.once("error", onError);
                server.once("listening", onListening);
                server.listen(listenPort, "127.0.0.1");
            });
            break;
        } catch (err) {
            if (err && err.code === "EADDRINUSE" && attempts++ < 20) {
                listenPort = nextPort();
                continue;
            }
            throw err;
        }
    }

    await RED.start();

    // After RED.start() the runtime continues to load palette nodes
    // asynchronously. Wait until at least one of our types shows up before
    // letting the test proceed; otherwise the first deploy() may race the
    // registry and fail with "unknown type".
    {
        const deadline = Date.now() + 10000;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let ours = false;
            try {
                const list = await RED.runtime.nodes.getNodeList({ user: { permissions: "*" } });
                ours = list.some(
                    (m) =>
                        m.module === "node-red-contrib-condition-monitoring" &&
                        Array.isArray(m.types) &&
                        m.types.length > 0
                );
            } catch (_) {
                // ignore — runtime not ready yet
            }
            if (ours) break;
            if (Date.now() > deadline) {
                throw new Error("condition-monitoring nodes never registered after RED.start()");
            }
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    const captures = new Map(); // captureId -> array of messages

    /**
     * Replace placeholders in a flow definition before deploy:
     *   - $RED_PORT  -> the runtime port (handy for ws-test connections)
     *   - $TMP_DIR   -> the per-test userDir (use for model paths etc.)
     */
    function expand(flow) {
        const json = JSON.stringify(flow)
            .split("$RED_PORT")
            .join(String(port))
            .split("$TMP_DIR")
            .join(userDir.replace(/\\/g, "/"));
        return JSON.parse(json);
    }

    /**
     * Deploy a flow via the runtime API. We wait for the runtime's
     * `flows:started` event (it fires after every node's onStart hook) so
     * subsequent inject() calls can rely on the nodes being live.
     */
    async function deploy(flow) {
        const expanded = expand(flow);
        const started = new Promise((resolve) => {
            const onStarted = () => {
                RED.events.removeListener("flows:started", onStarted);
                resolve();
            };
            RED.events.on("flows:started", onStarted);
        });
        await RED.runtime.flows.setFlows({
            user: { permissions: "*" },
            flows: { flows: expanded },
            deploymentType: "full"
        });
        await started;
        // Tiny extra settle for nodes whose onStart is itself async (e.g. WS bind).
        await new Promise((r) => setTimeout(r, 80));
        return expanded;
    }

    /**
     * Look up a deployed node by id, polling briefly to ride out the gap
     * between `flows:started` firing and node objects being registered.
     */
    async function getNodeAsync(nodeId, timeoutMs = 1500) {
        const start = Date.now();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const node = RED.nodes.getNode(nodeId);
            if (node) return node;
            if (Date.now() - start > timeoutMs) {
                throw new Error("node not found after " + timeoutMs + "ms: " + nodeId);
            }
            await new Promise((r) => setTimeout(r, 20));
        }
    }

    // Cache resolved nodes — receive() is sync once we have the object, the
    // async lookup is only needed the first time (right after deploy()).
    const nodeCache = new Map();

    /**
     * Inject a message into a specific node by id. The node must accept input
     * (most condition-monitoring nodes do). Returns once the input has been
     * dispatched — actual processing is asynchronous, callers wait via collect().
     */
    async function inject(nodeId, msg) {
        let node = nodeCache.get(nodeId);
        if (!node) {
            node = await getNodeAsync(nodeId);
            nodeCache.set(nodeId, node);
        }
        node.receive(msg);
    }

    /**
     * Subscribe to messages flowing into a given function node. Use this with
     * a `function` node whose body is `flow.set('captureId', '<id>'); ... return msg`
     * — see the helpers in this file for ready-made capture wiring.
     *
     * In practice we wire a tap: every flow has a final `function` node with
     * id starting `capture-` that calls `global.get('__ncmCapture')(id, msg)`.
     */
    function captureSink(captureId, msg) {
        const list = captures.get(captureId) || [];
        list.push(msg);
        captures.set(captureId, list);
    }

    // Expose the sink globally so capture function-nodes can push into it.
    RED.settings.functionGlobalContext.__ncmCapture = captureSink;

    /**
     * Wait until at least `count` messages have arrived on the given capture id,
     * or reject after `timeoutMs`. Returns the messages collected so far.
     */
    async function collect(captureId, count, timeoutMs = 1500) {
        const start = Date.now();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const list = captures.get(captureId) || [];
            if (list.length >= count) return list.slice();
            if (Date.now() - start > timeoutMs) {
                throw new Error(
                    "collect timeout for '" + captureId + "': got " + list.length + " of " + count + " messages"
                );
            }
            await new Promise((r) => setTimeout(r, 20));
        }
    }

    function reset(captureId) {
        if (captureId) captures.delete(captureId);
        else captures.clear();
    }

    async function shutdown() {
        try {
            await RED.stop();
        } catch (_) {
            /* ignore */
        }
        await new Promise((r) => server.close(() => r()));
        try {
            fs.rmSync(userDir, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    }

    /**
     * List node types currently registered with the runtime. Returns the
     * fully-qualified ids (e.g. "node-red-contrib-condition-monitoring/anomaly-detector").
     */
    async function listRegisteredTypes() {
        const list = await RED.runtime.nodes.getNodeList({ user: { permissions: "*" } });
        const types = [];
        for (const m of list) {
            if (Array.isArray(m.types)) types.push(...m.types);
        }
        return types;
    }

    return {
        port,
        userDir,
        deploy,
        inject,
        collect,
        reset,
        shutdown,
        getNode: (id) => RED.nodes.getNode(id),
        getNodeAsync,
        listRegisteredTypes,
        // Direct access for advanced flows that need to peek at runtime state.
        runtime: RED
    };
}

/**
 * Build a "capture" function node that pushes every input message to the
 * harness's in-memory buffer, then returns the message unchanged so chained
 * downstream nodes still see it.
 */
function captureNode(id, name) {
    return {
        id,
        type: "function",
        name: name || id,
        func: `const sink = global.get('__ncmCapture'); sink(${JSON.stringify(id)}, msg); return msg;`,
        outputs: 1,
        wires: [[]]
    };
}

/**
 * Convenience: build a tab + a list of node objects into a complete flow.
 */
function buildFlow(tabId, label, nodes) {
    return [{ id: tabId, type: "tab", label, disabled: false }, ...nodes.map((n) => Object.assign({ z: tabId }, n))];
}

module.exports = {
    startRed,
    captureNode,
    buildFlow
};
