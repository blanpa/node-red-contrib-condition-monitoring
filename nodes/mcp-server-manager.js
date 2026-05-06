/**
 * MCP Server Manager (singleton)
 * ==============================
 *
 * Mirrors the design of `nodes/websocket-manager.js`:
 *
 *   - First `mcp-bridge` node to register starts the HTTP server.
 *   - Every additional node registers its sensor into the existing server.
 *   - Mismatched server-level options between later registrants emit
 *     `optionMismatch` (operator misconfiguration signal).
 *
 * The manager owns:
 *
 *   - The HTTP server with bearer-token gate.
 *   - The sensor registry: name -> { buffer, ringHead, samplesHeld, unit, samplingHz, ... }.
 *   - The MCP server instance + tool dispatch.
 *
 * The bridge nodes themselves only own their per-sensor configuration and
 * their input handler — they push samples in via `pushSample()`.
 *
 * Phase 1 ships these tools (see docs/SPEC-mcp-bridge.md):
 *
 *   - listSensors
 *   - getRecentSamples
 *   - getStats
 *   - getMetadata
 *
 * Phase 2 adds: getZScore, findAnomalies, correlate, getRange.
 *
 * @module nodes/mcp-server-manager
 */

"use strict";

const crypto = require("crypto");
const http = require("http");
const EventEmitter = require("events");

const stats = require("./utils/statistics");

// Lazy-loaded to keep this module importable when the optional MCP SDK
// is not installed. We only really need it when start() is actually called.
let McpServer = null;
let StreamableHTTPServerTransport = null;
let z = null;
let mcpAvailable = null; // tri-state: null=unknown, true=loaded, false=not installed

function tryLoadMcpDeps() {
    if (mcpAvailable !== null) return mcpAvailable;
    try {
        // The MCP SDK + zod are optional dependencies — if a user never enables
        // the bridge, neither will be installed. Hence the require-and-catch.
        ({ McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js"));
        ({ StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js"));
        ({ z } = require("zod"));
        mcpAvailable = true;
    } catch (_) {
        mcpAvailable = false;
    }
    return mcpAvailable;
}

/**
 * Constant-time string compare. Identical helper to the one in
 * websocket-manager.js — duplicated rather than re-exported so a refactor
 * of either file can move forward without coupling.
 */
function timingSafeEqualStrings(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/**
 * Hard cap to keep a misconfigured node from eating memory. The node UI
 * advertises 1024 as default and lets the operator pick higher; we still
 * refuse anything beyond MAX_BUFFER_SIZE.
 */
const MAX_BUFFER_SIZE = 100000;

class MCPServerManager extends EventEmitter {
    /**
     * @param {Object} options
     * @param {number} [options.port=3001]      HTTP listen port
     * @param {string} [options.host="127.0.0.1"] Bind address
     * @param {string|null} options.authToken   Required bearer token
     * @param {string} [options.path="/mcp"]    HTTP path
     */
    constructor(options = {}) {
        super();
        this.port = options.port || 3001;
        this.host = options.host || "127.0.0.1";
        this.path = options.path || "/mcp";
        this.authToken =
            typeof options.authToken === "string" && options.authToken.length > 0 ? options.authToken : null;

        // sensor name -> { buffer, head, samplesHeld, unit, samplingHz, lastUpdate, registeredAt }
        this.sensors = new Map();
        this.httpServer = null;
        this.isRunning = false;

        this.stats = {
            requestsHandled: 0,
            authFailures: 0,
            toolCalls: 0,
            errors: 0,
            startTime: null
        };
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    async start() {
        if (this.isRunning) return;
        if (!tryLoadMcpDeps()) {
            throw new Error(
                'MCP support requires the "@modelcontextprotocol/sdk" package. ' +
                    "Install with: npm install @modelcontextprotocol/sdk"
            );
        }
        if (!this.authToken) {
            // Documented refusal: better to not start than to ship an open
            // listener that leaks sensor data.
            throw new Error("MCPServerManager refuses to start without an authToken");
        }

        this.httpServer = http.createServer((req, res) => this._handleRequest(req, res));

        await new Promise((resolve, reject) => {
            const onError = (err) => {
                this.httpServer.removeListener("listening", onListening);
                reject(err);
            };
            const onListening = () => {
                this.httpServer.removeListener("error", onError);
                resolve();
            };
            this.httpServer.once("error", onError);
            this.httpServer.once("listening", onListening);
            this.httpServer.listen(this.port, this.host);
        });

        this.isRunning = true;
        this.stats.startTime = Date.now();
        this.emit("started", { port: this.port, host: this.host, path: this.path });
    }

    async stop() {
        if (!this.isRunning) return;
        this.isRunning = false;
        await new Promise((resolve) => {
            if (!this.httpServer) return resolve();
            this.httpServer.close(() => resolve());
        });
        this.httpServer = null;
        this.emit("stopped");
    }

    // ---------------------------------------------------------------------
    // Sensor registry
    // ---------------------------------------------------------------------

    /**
     * Register a sensor with the manager. Returns an opaque handle that the
     * bridge node uses to push samples. Re-registering the same name with a
     * different bufferSize replaces the old entry — useful when a flow is
     * re-deployed.
     *
     * @param {Object} cfg
     * @param {string} cfg.name        Unique sensor identifier (the topic).
     * @param {number} cfg.bufferSize  Ring-buffer capacity (clamped at MAX_BUFFER_SIZE).
     * @param {string} [cfg.unit]
     * @param {number} [cfg.samplingHz]
     * @returns {{ name: string, push: function, getEntry: function, unregister: function }}
     */
    registerSensor(cfg) {
        if (!cfg || typeof cfg.name !== "string" || cfg.name.length === 0) {
            throw new Error("registerSensor: cfg.name is required");
        }
        const bufferSize = Math.min(Math.max(1, parseInt(cfg.bufferSize) || 1024), MAX_BUFFER_SIZE);
        const entry = {
            name: cfg.name,
            buffer: new Float64Array(bufferSize),
            timestamps: new Float64Array(bufferSize),
            head: 0, // next write index
            samplesHeld: 0,
            unit: cfg.unit || null,
            samplingHz: typeof cfg.samplingHz === "number" && cfg.samplingHz > 0 ? cfg.samplingHz : null,
            lastUpdate: null,
            registeredAt: Date.now(),
            // Last upstream tagging surfaced by getMetadata.
            lastIsAnomaly: null,
            lastZScore: null
        };
        this.sensors.set(cfg.name, entry);

        // Hand back a handle, not the raw entry — keeps the bridge node honest.
        return {
            name: cfg.name,
            push: (value, timestamp, meta) => this.pushSample(cfg.name, value, timestamp, meta),
            getEntry: () => this.sensors.get(cfg.name) || null,
            unregister: () => this.unregisterSensor(cfg.name)
        };
    }

    unregisterSensor(name) {
        this.sensors.delete(name);
    }

    /**
     * Append a sample to a sensor's ring buffer. Non-finite values are dropped
     * (a misbehaving upstream should not corrupt the buffer or take the server
     * down). Optional metadata (`isAnomaly`, `zScore`) feeds `getMetadata`.
     */
    pushSample(name, value, timestamp, meta) {
        const e = this.sensors.get(name);
        if (!e) return false;
        if (typeof value !== "number" || !Number.isFinite(value)) return false;
        const ts = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
        e.buffer[e.head] = value;
        e.timestamps[e.head] = ts;
        e.head = (e.head + 1) % e.buffer.length;
        if (e.samplesHeld < e.buffer.length) e.samplesHeld++;
        e.lastUpdate = ts;
        if (meta && typeof meta === "object") {
            if (typeof meta.isAnomaly === "boolean") e.lastIsAnomaly = meta.isAnomaly;
            if (typeof meta.zScore === "number" && Number.isFinite(meta.zScore)) e.lastZScore = meta.zScore;
        }
        return true;
    }

    /**
     * Snapshot helper: copy the live ring buffer into an oldest-first array.
     * Bounded by both samplesHeld and the requested `n`. Used by every tool
     * that reads samples — single source of truth so timestamp/value alignment
     * cannot drift across tools.
     */
    _readOldestFirst(entry, n) {
        const have = entry.samplesHeld;
        const take = Math.min(typeof n === "number" && n > 0 ? n : have, have);
        const buf = entry.buffer;
        const ts = entry.timestamps;
        const cap = buf.length;
        // The oldest sample is at (head - samplesHeld) mod cap.
        const start = (entry.head - have + cap) % cap;
        // The first sample of the take window starts (have - take) entries
        // *after* `start` so we get the most recent `take` samples.
        const offset = (start + (have - take)) % cap;
        const values = new Array(take);
        const stamps = new Array(take);
        for (let i = 0; i < take; i++) {
            const idx = (offset + i) % cap;
            values[i] = buf[idx];
            stamps[i] = ts[idx];
        }
        return { values, timestamps: stamps };
    }

    // ---------------------------------------------------------------------
    // Tool implementations (called by both the MCP server and the unit tests)
    // ---------------------------------------------------------------------

    toolListSensors() {
        const out = [];
        for (const e of this.sensors.values()) {
            out.push({
                name: e.name,
                unit: e.unit,
                samplingHz: e.samplingHz,
                lastUpdate: e.lastUpdate,
                bufferSize: e.buffer.length,
                samplesHeld: e.samplesHeld
            });
        }
        return { sensors: out };
    }

    toolGetRecentSamples({ sensor, n }) {
        const e = this.sensors.get(sensor);
        if (!e) return { error: "unknown sensor: " + sensor };
        const slice = this._readOldestFirst(e, n);
        return { sensor, samples: slice.values, timestamps: slice.timestamps, unit: e.unit };
    }

    toolGetStats({ sensor, windowMin }) {
        const e = this.sensors.get(sensor);
        if (!e) return { error: "unknown sensor: " + sensor };
        // windowMin in minutes — translate to a sample count when samplingHz known,
        // otherwise just take everything we have. Falsy windowMin → all samples.
        let take = e.samplesHeld;
        if (typeof windowMin === "number" && windowMin > 0 && e.samplingHz) {
            take = Math.min(Math.ceil(windowMin * 60 * e.samplingHz), e.samplesHeld);
        }
        const { values } = this._readOldestFirst(e, take);
        if (values.length === 0) {
            return { sensor, count: 0, mean: null, stdDev: null, min: null, max: null };
        }
        const mean = stats.calculateMean(values);
        const stdDev = stats.calculateStdDev(values, mean);
        const q = stats.calculateQuartiles(values);
        let min = values[0];
        let max = values[0];
        for (let i = 1; i < values.length; i++) {
            if (values[i] < min) min = values[i];
            if (values[i] > max) max = values[i];
        }
        return {
            sensor,
            count: values.length,
            mean,
            stdDev,
            min,
            max,
            range: max - min,
            median: q.median,
            q1: q.q1,
            q3: q.q3
        };
    }

    toolGetMetadata({ sensor }) {
        const e = this.sensors.get(sensor);
        if (!e) return { error: "unknown sensor: " + sensor };
        return {
            name: e.name,
            unit: e.unit,
            samplingHz: e.samplingHz,
            bufferSize: e.buffer.length,
            samplesHeld: e.samplesHeld,
            registeredAt: e.registeredAt,
            lastUpdate: e.lastUpdate,
            lastIsAnomaly: e.lastIsAnomaly,
            lastZScore: e.lastZScore
        };
    }

    // ---------------------------------------------------------------------
    // HTTP / MCP request handling
    // ---------------------------------------------------------------------

    _authorize(req, res) {
        const auth = req.headers["authorization"] || "";
        const m = /^Bearer\s+(.+)$/.exec(auth);
        const presented = m ? m[1].trim() : null;
        if (!presented || !timingSafeEqualStrings(presented, this.authToken)) {
            this.stats.authFailures++;
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("Unauthorized");
            this.emit("authFailed", { ip: req.socket && req.socket.remoteAddress });
            return false;
        }
        return true;
    }

    _buildMcpServer() {
        const server = new McpServer(
            { name: "node-red-condition-monitoring-bridge", version: "1.0.0" },
            { capabilities: { tools: {} } }
        );

        // Tool runners may signal a recoverable error in two ways:
        //   - throw — caught here, surfaces as MCP `isError: true`
        //   - return { error: <string> } — also surfaces as `isError: true`,
        //     because that's what an LLM client expects when the tool tells
        //     it "I can't do this with these arguments" (unknown sensor,
        //     empty buffer, etc.).
        const wrap = (toolName, runner) => async (args) => {
            this.stats.toolCalls++;
            try {
                const result = runner(args || {});
                const isErr = result && typeof result === "object" && typeof result.error === "string";
                const envelope = { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                if (isErr) envelope.isError = true;
                return envelope;
            } catch (err) {
                this.stats.errors++;
                this.emit("toolError", { tool: toolName, message: err.message });
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
                    isError: true
                };
            }
        };

        server.registerTool(
            "listSensors",
            {
                title: "List sensors",
                description: "List all sensors currently registered with this bridge.",
                inputSchema: {}
            },
            wrap("listSensors", () => this.toolListSensors())
        );

        server.registerTool(
            "getRecentSamples",
            {
                title: "Get recent samples",
                description: "Return the most recent N samples (oldest-first) for a sensor.",
                inputSchema: {
                    sensor: z.string().describe("Sensor name as registered."),
                    n: z.number().int().min(1).max(MAX_BUFFER_SIZE).describe("Maximum samples to return.")
                }
            },
            wrap("getRecentSamples", (args) => this.toolGetRecentSamples(args))
        );

        server.registerTool(
            "getStats",
            {
                title: "Get statistics",
                description: "Descriptive statistics over a recent time window.",
                inputSchema: {
                    sensor: z.string(),
                    windowMin: z
                        .number()
                        .min(0)
                        .optional()
                        .describe("Window in minutes; if omitted or 0, uses every buffered sample.")
                }
            },
            wrap("getStats", (args) => this.toolGetStats(args))
        );

        server.registerTool(
            "getMetadata",
            {
                title: "Get sensor metadata",
                description: "Static metadata + last upstream tagging for a sensor.",
                inputSchema: { sensor: z.string() }
            },
            wrap("getMetadata", (args) => this.toolGetMetadata(args))
        );

        return server;
    }

    async _handleRequest(req, res) {
        this.stats.requestsHandled++;
        if (!this._authorize(req, res)) return;
        if (req.url !== this.path) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
        }

        // Stateless mode: build a fresh server per request. Phase 5 may move
        // to per-session transports; for read-only tools this is fine.
        const server = this._buildMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });

        res.on("close", () => {
            try {
                transport.close();
            } catch (_) {
                /* ignore */
            }
            try {
                server.close();
            } catch (_) {
                /* ignore */
            }
        });

        try {
            await server.connect(transport);
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
            await transport.handleRequest(req, res, body);
        } catch (err) {
            this.stats.errors++;
            this.emit("requestError", { message: err.message });
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Internal error");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Singleton glue
// ---------------------------------------------------------------------------

let globalMcpManager = null;

/**
 * Get or create the global MCP server manager.
 *
 * The first caller's `port`, `host`, `path` and `authToken` win. Later callers
 * that pass conflicting values get an `optionMismatch` event so the operator
 * notices misconfiguration; the singleton itself is not reconfigured.
 *
 * @param {Object} options
 * @returns {MCPServerManager}
 */
function getMcpManager(options = {}) {
    if (!globalMcpManager) {
        globalMcpManager = new MCPServerManager(options);
        return globalMcpManager;
    }
    const sensitive = ["authToken", "port", "host", "path"];
    for (const key of sensitive) {
        if (
            Object.prototype.hasOwnProperty.call(options, key) &&
            JSON.stringify(options[key]) !== JSON.stringify(globalMcpManager[key])
        ) {
            globalMcpManager.emit("optionMismatch", {
                key,
                requested: options[key],
                inUse: globalMcpManager[key]
            });
        }
    }
    return globalMcpManager;
}

function isMcpAvailable() {
    return tryLoadMcpDeps();
}

async function shutdownMcpManager() {
    if (globalMcpManager) {
        await globalMcpManager.stop();
        globalMcpManager = null;
    }
}

module.exports = {
    MCPServerManager,
    getMcpManager,
    isMcpAvailable,
    shutdownMcpManager,
    timingSafeEqualStrings,
    MAX_BUFFER_SIZE
};
