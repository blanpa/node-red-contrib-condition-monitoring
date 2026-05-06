#!/usr/bin/env node
/**
 * Phase 0 spike for the `mcp-bridge` node (see docs/SPEC-mcp-bridge.md).
 *
 * Stands up a minimal MCP server with a single hardcoded `listSensors`
 * tool. Useful for two things:
 *
 *   1. Proving the chosen `@modelcontextprotocol/sdk` version actually
 *      works with our Node version + bearer-auth pattern + Streamable
 *      HTTP transport.
 *
 *   2. Giving you a target to point an MCP client at (mcp-inspector,
 *      Claude Desktop, Cursor) so we know the wire shape we'll be
 *      committing to in Phase 1.
 *
 * Run:
 *
 *     node experiments/mcp-spike.js
 *
 * The server prints its base URL and bearer token. Both can be set via
 * env (PORT, MCP_TOKEN). Defaults: 127.0.0.1:3001, token "spike".
 *
 * Test from another shell:
 *
 *     # 1) discover tools
 *     curl -s -H "Authorization: Bearer spike" \
 *          -H "Accept: application/json, text/event-stream" \
 *          -H "Content-Type: application/json" \
 *          -X POST http://127.0.0.1:3001/mcp \
 *          -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 *
 *     # 2) call listSensors
 *     curl -s -H "Authorization: Bearer spike" \
 *          -H "Accept: application/json, text/event-stream" \
 *          -H "Content-Type: application/json" \
 *          -X POST http://127.0.0.1:3001/mcp \
 *          -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"listSensors","arguments":{}}}'
 *
 * Or with the official inspector (Node ≥ 18):
 *
 *     npx @modelcontextprotocol/inspector \
 *         --transport streamableHttp \
 *         --url http://127.0.0.1:3001/mcp \
 *         --header "Authorization: Bearer spike"
 */

"use strict";

const crypto = require("crypto");
const http = require("http");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.MCP_TOKEN || "spike";

// Same constant-time comparator we ship in nodes/websocket-manager.js.
// Duplicated here so the spike is self-contained (it's not loaded by Node-RED).
function timingSafeEqualStrings(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// Hardcoded sensor catalog so we can prove the wire shape end-to-end.
// Phase 1 will replace this with a live registry that the actual
// mcp-bridge nodes register into.
const MOCK_SENSORS = [
    {
        name: "machine-A/temp",
        unit: "°C",
        samplingHz: 1.0,
        lastUpdate: Date.now(),
        bufferSize: 1024,
        samplesHeld: 1024
    },
    {
        name: "machine-B/vibration",
        unit: "mm/s",
        samplingHz: 100.0,
        lastUpdate: Date.now() - 5000,
        bufferSize: 8192,
        samplesHeld: 8192
    }
];

function buildServer() {
    const server = new McpServer(
        { name: "node-red-condition-monitoring-bridge", version: "0.0.0-spike" },
        { capabilities: { tools: {} } }
    );

    server.registerTool(
        "listSensors",
        {
            title: "List sensors",
            description: "List all sensors currently exposed by this Node-RED bridge.",
            inputSchema: {}
        },
        async () => ({
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ sensors: MOCK_SENSORS }, null, 2)
                }
            ]
        })
    );

    // A tiny canary tool so we can confirm input-schema parsing works.
    server.registerTool(
        "echo",
        {
            title: "Echo",
            description: "Return the message verbatim. Useful for checking the auth + transport pipe.",
            inputSchema: {
                message: z.string().describe("Anything goes; comes back unchanged.")
            }
        },
        async (args) => ({
            content: [{ type: "text", text: String(args.message) }]
        })
    );

    return server;
}

async function main() {
    const httpServer = http.createServer(async (req, res) => {
        // 1) bearer auth — uniform 401 on any failure.
        const auth = req.headers["authorization"] || "";
        const m = /^Bearer\s+(.+)$/.exec(auth);
        const presented = m ? m[1].trim() : null;
        if (!presented || !timingSafeEqualStrings(presented, TOKEN)) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("Unauthorized");
            return;
        }

        // 2) only the MCP route is exposed; everything else is a 404.
        if (req.url !== "/mcp") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
        }

        // 3) one transport per request keeps the spike stateless.
        // Phase 1 will switch to per-session transports backed by the
        // singleton manager.
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless mode
            enableJsonResponse: true
        });

        res.on("close", () => {
            transport.close();
            server.close();
        });

        try {
            await server.connect(transport);
            // Read the body up front so we can hand it to the transport.
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
            await transport.handleRequest(req, res, body);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[mcp-spike] handler error:", err);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Internal error");
            }
        }
    });

    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(PORT, HOST, () => {
            httpServer.removeListener("error", reject);
            resolve();
        });
    });

    // eslint-disable-next-line no-console
    console.log(
        [
            "[mcp-spike] listening on http://" + HOST + ":" + PORT + "/mcp",
            "[mcp-spike] bearer token: " + TOKEN,
            "[mcp-spike] tools registered: listSensors, echo",
            "",
            "Try:",
            "  npx @modelcontextprotocol/inspector --transport streamableHttp \\",
            "    --url http://" + HOST + ":" + PORT + "/mcp \\",
            '    --header "Authorization: Bearer ' + TOKEN + '"'
        ].join("\n")
    );

    const shutdown = () => {
        // eslint-disable-next-line no-console
        console.log("[mcp-spike] shutting down");
        httpServer.close(() => process.exit(0));
        // Hard exit if close hangs.
        setTimeout(() => process.exit(1), 2000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mcp-spike] fatal:", err);
    process.exit(1);
});
