# Experiments

Throwaway scripts that prove a piece of architecture before it gets
spec'd or merged into the main palette. They are **not** packaged with
the npm release, **not** part of the test suite, and **not** loaded by
Node-RED.

Treat anything in here as: works on my machine, today, against the
versions in `package-lock`. Re-run before trusting.

## Contents

| File | What it proves | Spec |
|------|---------------|------|
| `mcp-spike.js` | The chosen `@modelcontextprotocol/sdk` version actually serves a tool over Streamable-HTTP with bearer auth, against curl and the official inspector. | [`docs/SPEC-mcp-bridge.md`](../docs/SPEC-mcp-bridge.md) — Phase 0 |

## Running `mcp-spike.js`

```bash
# Default port 3001, default token "spike". Override via env.
PORT=23001 MCP_TOKEN=mySpike node experiments/mcp-spike.js
```

Then either:

**curl smoke test** (paste in a different shell, kill the server with Ctrl-C
when done):

```bash
TOKEN=mySpike

# 1) discover tools
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/json, text/event-stream" \
     -H "Content-Type: application/json" \
     -X POST http://127.0.0.1:23001/mcp \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2) call listSensors
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/json, text/event-stream" \
     -H "Content-Type: application/json" \
     -X POST http://127.0.0.1:23001/mcp \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"listSensors","arguments":{}}}'
```

Both should return JSON with `result.content[0].text`. Auth failures
return HTTP 401 with no body.

**Or with the official inspector** (Node ≥ 18):

```bash
npx @modelcontextprotocol/inspector \
    --transport streamableHttp \
    --url http://127.0.0.1:23001/mcp \
    --header "Authorization: Bearer $TOKEN"
```

The inspector opens a web UI; the two registered tools show up under
*Tools* and can be invoked interactively.

## What the spike validated for the SPEC

- `McpServer.registerTool()` + `StreamableHTTPServerTransport` round-trip
  works on Node 20.20 with SDK 1.29.
- Stateless mode (`sessionIdGenerator: undefined`) is enough for the
  read-only tools we plan to ship — no session-state-machine needed yet.
- Bearer auth via plain HTTP header works; `timingSafeEqualStrings` from
  `nodes/websocket-manager.js` reuses cleanly.
- The wire shape we'll commit to in Phase 1: tools answer with
  `{ content: [{ type: "text", text: <JSON> }] }`, where the text is a
  pretty-printed JSON object. LLM clients are happy parsing that.

## What we deliberately skipped

- Per-session transports (the manager-singleton design will need them).
- Streaming responses (none of the planned tools need them).
- stdio transport (Phase 5).
- Persistence (Phase 3).
