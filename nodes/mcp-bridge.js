/**
 * mcp-bridge node
 * ===============
 *
 * Exposes a single sensor's live time series to external MCP clients
 * (Claude Desktop, Cursor, claude.ai, …) through a shared MCP server
 * managed by `nodes/mcp-server-manager.js`.
 *
 * Per-node configuration:
 *   - sensorName (required, unique per manager)
 *   - bufferSize, persistState, unit, samplingHz
 *
 * Server-level configuration (only the *first* node's values are used —
 * subsequent nodes get an `optionMismatch` warning if they disagree):
 *   - serverPort, serverHost, serverPath
 *   - authToken (Node-RED credential, encrypted at rest)
 *
 * Inputs:
 *   - msg.payload     numeric value (or numeric string)
 *   - msg.timestamp   optional epoch-ms (default: Date.now())
 *   - msg.isAnomaly   optional, surfaced via `getMetadata`
 *   - msg.zScore      optional, surfaced via `getMetadata`
 *
 * The node does NOT emit on its outputs — it's a sink that feeds the
 * shared buffer. Operators wire it in parallel to the rest of their
 * pipeline (a `change`/`tee` upstream is the typical pattern).
 *
 * See docs/SPEC-mcp-bridge.md for the full contract.
 */

"use strict";

const persistenceHelper = require("./utils/persistence-helper");
const { getMcpManager, isMcpAvailable } = require("./mcp-server-manager");

module.exports = function (RED) {
    function McpBridgeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Per-sensor configuration ------------------------------------------------
        node.sensorName = (config.sensorName || "").trim();
        node.bufferSize = parseInt(config.bufferSize) || 1024;
        node.unit = (config.unit || "").trim() || null;
        node.samplingHz = parseFloat(config.samplingHz) || null;
        node.persistState = config.persistState !== false;

        // Server-level configuration ---------------------------------------------
        node.serverPort = parseInt(config.serverPort) || 3001;
        node.serverHost = (config.serverHost || "127.0.0.1").trim();
        node.serverPath = (config.serverPath || "/mcp").trim();

        // Token comes from Node-RED credentials (encrypted), with a backstop
        // fall-through to plain config so dev flows still work.
        const credToken =
            node.credentials && typeof node.credentials.authToken === "string" ? node.credentials.authToken.trim() : "";
        const inlineToken = (config.authToken || "").trim();
        node.authToken = credToken || inlineToken || null;

        // ------------------------------------------------------------------------
        // Validation: missing sensor name or token kills this node early. We
        // refuse to half-start: a configured-but-not-running bridge that
        // silently swallows messages is worse than an explicit error.
        // ------------------------------------------------------------------------
        if (!node.sensorName) {
            node.status({ fill: "red", shape: "ring", text: "no sensor name" });
            node.error("mcp-bridge: sensorName is required");
            return;
        }
        if (!node.authToken) {
            node.status({ fill: "red", shape: "ring", text: "no auth token" });
            node.error("mcp-bridge: authToken is required (set the credential)");
            return;
        }
        if (!isMcpAvailable()) {
            node.status({ fill: "red", shape: "ring", text: "missing @modelcontextprotocol/sdk" });
            node.error('mcp-bridge: install the optional dep "@modelcontextprotocol/sdk"');
            return;
        }

        // ------------------------------------------------------------------------
        // Manager registration. The first node wins on server-level options;
        // later nodes that pass different values get the `optionMismatch`
        // event surfaced as a warning.
        // ------------------------------------------------------------------------
        const manager = getMcpManager({
            port: node.serverPort,
            host: node.serverHost,
            path: node.serverPath,
            authToken: node.authToken
        });

        const onMismatch = (info) => {
            node.warn(
                "MCP server option mismatch (" +
                    info.key +
                    "): " +
                    "another node already configured this manager differently. First writer wins."
            );
        };
        const onAuthFail = (info) => {
            // Quiet logging — too chatty for a busy public deployment, but
            // useful in dev. Aggregated counter lives in manager.stats.
            if (process.env.NCM_MCP_LOG_AUTH === "1") {
                node.warn("MCP auth failed from " + (info.ip || "unknown"));
            }
        };
        manager.on("optionMismatch", onMismatch);
        manager.on("authFailed", onAuthFail);

        const handle = manager.registerSensor({
            name: node.sensorName,
            bufferSize: node.bufferSize,
            unit: node.unit,
            samplingHz: node.samplingHz
        });

        // Start the server lazily on first registration. start() is idempotent
        // for already-running instances.
        if (!manager.isRunning) {
            manager.start().then(
                () => {
                    node.log("MCP server listening on http://" + manager.host + ":" + manager.port + manager.path);
                },
                (err) => {
                    node.error("Failed to start MCP server: " + err.message);
                    node.status({ fill: "red", shape: "ring", text: "server failed: " + err.message.slice(0, 18) });
                }
            );
        }

        node.status({ fill: "green", shape: "dot", text: node.sensorName + " (0)" });

        // ------------------------------------------------------------------------
        // Optional state persistence: serialize the buffer through the same
        // helper used by anomaly-detector et al.
        // ------------------------------------------------------------------------
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "mcpBridge:" + node.sensorName,
            saveInterval: 60000,
            debug: false,
            getStateToSave: function () {
                const e = handle.getEntry();
                if (!e) return null;
                // Snapshot the ring as oldest-first so restoration is order-correct.
                const cap = e.buffer.length;
                const have = e.samplesHeld;
                const start = (e.head - have + cap) % cap;
                const values = new Array(have);
                const stamps = new Array(have);
                for (let i = 0; i < have; i++) {
                    const idx = (start + i) % cap;
                    values[i] = e.buffer[idx];
                    stamps[i] = e.timestamps[idx];
                }
                return {
                    values,
                    stamps,
                    unit: e.unit,
                    samplingHz: e.samplingHz,
                    lastIsAnomaly: e.lastIsAnomaly,
                    lastZScore: e.lastZScore
                };
            },
            onStateLoaded: function (state) {
                if (!state || !Array.isArray(state.values)) return;
                for (let i = 0; i < state.values.length; i++) {
                    handle.push(state.values[i], state.stamps[i], {
                        isAnomaly: state.lastIsAnomaly,
                        zScore: state.lastZScore
                    });
                }
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: node.sensorName + " (" + state.values.length + " restored)"
                });
            }
        });

        // ------------------------------------------------------------------------
        // Input: parse value, optionally lift metadata, push into the manager.
        // We deliberately do not forward to outputs — a bridge node sinks.
        // ------------------------------------------------------------------------
        let writesSinceStatus = 0;
        node.on("input", function (msg, send, done) {
            try {
                let value = msg.payload;
                if (typeof value === "string") value = parseFloat(value);
                if (typeof value !== "number" || !Number.isFinite(value)) {
                    node.status({ fill: "yellow", shape: "ring", text: "non-numeric payload" });
                    if (done) done();
                    return;
                }
                const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
                const meta = {};
                if (typeof msg.isAnomaly === "boolean") meta.isAnomaly = msg.isAnomaly;
                if (typeof msg.zScore === "number" && Number.isFinite(msg.zScore)) meta.zScore = msg.zScore;
                handle.push(value, ts, meta);

                // Status-update batching: reflecting every sample is noise on
                // high-rate inputs.
                writesSinceStatus++;
                if (writesSinceStatus >= 10 || writesSinceStatus === 1) {
                    const e = handle.getEntry();
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: node.sensorName + " (" + (e ? e.samplesHeld : 0) + ")"
                    });
                    writesSinceStatus = 0;
                }
                if (done) done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error: " + err.message.slice(0, 22) });
                if (done) done(err);
                else node.error(err, msg);
            }
        });

        // ------------------------------------------------------------------------
        // Cleanup: drop the sensor from the manager on undeploy. Don't stop
        // the manager itself — other bridge nodes may still depend on it.
        // ------------------------------------------------------------------------
        node.on("close", function (removed, done) {
            try {
                handle.unregister();
                manager.removeListener("optionMismatch", onMismatch);
                manager.removeListener("authFailed", onAuthFail);
                if (persistence && typeof persistence.saveNow === "function") {
                    persistence.saveNow();
                }
            } catch (err) {
                if (done) return done(err);
            }
            if (done) done();
        });
    }

    RED.nodes.registerType("mcp-bridge", McpBridgeNode, {
        credentials: {
            authToken: { type: "password" }
        }
    });
};
