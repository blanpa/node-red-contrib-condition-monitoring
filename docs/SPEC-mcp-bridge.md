# SPEC: `mcp-bridge` Node

**Status:** Draft (locked decisions). Implementation phased.
**Owner:** repo maintainers.
**Last updated:** 2026-05-06.

---

## 1. Goal

Make Node-RED's live sensor data accessible to external Large Language Model
clients (Claude Desktop, Cursor, claude.ai, Claude Code, …) through the
[Model Context Protocol](https://modelcontextprotocol.io). The node holds a
running buffer per sensor topic and exposes a small, well-defined set of
read-only **tools** that the LLM can call on demand. The LLM decides what to
do with the data — forecasting, anomaly explanation, root-cause discussion —
based on its own capabilities, prompted by the operator.

We **do not load any model** inside Node-RED. We do not call out to LLM APIs
ourselves. We are the data-plane, not the inference-plane.

## 2. Non-Goals

- No forecasting, no in-process LLM inference, no ONNX/TF.js/Python ML
  pipeline (those stay in `ml-inference`).
- No bidirectional control: the bridge exposes data only, never lets a
  remote client change a Node-RED flow, write to MQTT, or invoke other
  nodes.
- No auto-discovery of sensors via heuristics. Sensors register
  themselves by being routed into the node's input.
- No persistent vector DB, no RAG plumbing — the LLM client owns its
  context.

## 3. Locked Decisions

| # | Decision | Reason |
|---|----------|--------|
| D1 | **Transport: HTTP + SSE first, stdio in a follow-up phase** | Node-RED runs on edge gateways; operators run their LLM client on a different host. Stdio crosses no host boundary. |
| D2 | **Auth: single shared bearer token (`mcpAuthToken`)** stored as Node-RED credential | All exposed tools are read-only and side-effect-free. Two tiers were over-engineering. |
| D3 | **Singleton MCPServerManager** in `nodes/mcp-server-manager.js` | Mirrors the existing `WebSocketManager` pattern. The first `mcp-bridge` instance starts the server; subsequent instances register their sensors into the same server. |
| D4 | **Buffer persistence on by default** via existing `state-persistence` helper | Avoids cold-start after restart. `persistState: false` opts out. |
| D5 | **`@modelcontextprotocol/sdk` as `optionalDependency`** (mirrors `ws` / `@aws-sdk/client-s3`) | Users who don't enable the bridge don't pay the install cost. |
| D6 | **No model loading.** Period. | Architecture decision from concept review — keeps the node small, dodges privacy/regulation traps, and offloads ML evolution to upstream LLM vendors. |
| D7 | **Node name: `mcp-bridge`** | Short, neutral, sits next to `ml-inference` in the palette without confusion. |

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Node-RED Flow                                          │
│                                                         │
│   [MQTT/OPC-UA]   ─┐                                    │
│   [other in nodes]─┼─▶ [mcp-bridge node 1]              │
│                    │       └ topic: machine-A/temp      │
│                    │                                    │
│                    └─▶ [mcp-bridge node 2]              │
│                            └ topic: machine-B/vib       │
│                                                         │
│   Both nodes register into the same singleton manager:  │
│                                                         │
│     ┌────────────────────────────────────────────┐      │
│     │ MCPServerManager (singleton)               │      │
│     │  - HTTP+SSE on configurable port           │      │
│     │  - bearer-token gate                       │      │
│     │  - sensor registry                         │      │
│     │  - tool dispatcher (8 tools)               │      │
│     │  - delegates math to nodes/utils/statistics│      │
│     └────────────────────────────────────────────┘      │
└────────────┬────────────────────────────────────────────┘
             │ HTTP+SSE, Bearer auth
             ▼
   ┌─────────────────────────────────────┐
   │  Claude Desktop / Cursor / etc.     │
   │  (operator-owned, off-host)         │
   └─────────────────────────────────────┘
```

## 5. MCP Tool Surface

All tools are read-only; all responses are deterministic for a fixed buffer
state. Tool names use `camelCase` (consistent with the rest of the JS
codebase). Input schemas are JSON-Schema 2020-12.

### 5.1 `listSensors`

```json
{
  "name": "listSensors",
  "description": "List all sensors currently registered with the bridge.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

**Returns** (text content with JSON body):

```json
{
  "sensors": [
    {
      "name": "machine-A/temp",
      "samplingHz": 1.0,
      "lastUpdate": 1714987200000,
      "bufferSize": 1024,
      "samplesHeld": 1024,
      "unit": "°C"
    }
  ]
}
```

### 5.2 `getRecentSamples`

```json
{
  "name": "getRecentSamples",
  "description": "Return the most recent N samples for a sensor.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sensor": { "type": "string", "description": "Sensor name (topic)." },
      "n":      { "type": "integer", "minimum": 1, "maximum": 10000 }
    },
    "required": ["sensor", "n"]
  }
}
```

**Returns** `{ "samples": number[], "timestamps": number[], "unit"?: string }`. The
arrays are aligned and ordered oldest → newest.

### 5.3 `getRange`

```json
{
  "name": "getRange",
  "description": "Return all samples in the closed interval [from, to] (epoch ms).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sensor": { "type": "string" },
      "from":   { "type": "integer", "description": "epoch ms" },
      "to":     { "type": "integer", "description": "epoch ms" }
    },
    "required": ["sensor", "from", "to"]
  }
}
```

### 5.4 `getStats`

```json
{
  "name": "getStats",
  "description": "Descriptive statistics over the last `windowMin` minutes.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sensor":    { "type": "string" },
      "windowMin": { "type": "number", "minimum": 0, "default": 5 }
    },
    "required": ["sensor"]
  }
}
```

**Returns** `{ count, mean, stdDev, min, max, range, median, q1, q3 }` —
delegated to `nodes/utils/statistics.js`.

### 5.5 `getZScore`

```json
{
  "name": "getZScore",
  "description": "Z-score of the most recent sample relative to the buffer.",
  "inputSchema": {
    "type": "object",
    "properties": { "sensor": { "type": "string" } },
    "required": ["sensor"]
  }
}
```

**Returns** `{ value, zScore, mean, stdDev }`.

### 5.6 `findAnomalies`

```json
{
  "name": "findAnomalies",
  "description": "Indices+values where |z-score| exceeds `threshold` over the last `lookback` samples.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sensor":    { "type": "string" },
      "threshold": { "type": "number", "default": 3.0, "minimum": 0 },
      "lookback":  { "type": "integer", "minimum": 1, "maximum": 10000, "default": 500 }
    },
    "required": ["sensor"]
  }
}
```

**Returns** `{ anomalies: [{ index, timestamp, value, zScore }], threshold }`.

### 5.7 `correlate`

```json
{
  "name": "correlate",
  "description": "Pearson and Spearman correlation between two sensors over the overlapping window.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sensorA": { "type": "string" },
      "sensorB": { "type": "string" },
      "windowMin": { "type": "number", "default": 30, "minimum": 0 }
    },
    "required": ["sensorA", "sensorB"]
  }
}
```

**Returns** `{ pearson, spearman, sampleCount, windowMin }`. Returns `null`
for either coefficient if the overlap is too short or std-dev is zero.

### 5.8 `getMetadata`

```json
{
  "name": "getMetadata",
  "description": "Static metadata for a sensor (unit, sampling, last upstream anomaly flags).",
  "inputSchema": {
    "type": "object",
    "properties": { "sensor": { "type": "string" } },
    "required": ["sensor"]
  }
}
```

**Returns** `{ name, unit?, samplingHz?, lastIsAnomaly?, lastZScore?, registeredAt }`.

## 6. Node Configuration (Editor UI)

```
Sensor name (topic):       machine-A/temp        — required, must be unique
                                                   across the manager
Buffer size (samples):     1024                  — fixed-size ring buffer
Persist buffer across
restart:                   ☑                     — opt-out via uncheck
Sensor unit:               °C                    — optional, surfaced in
                                                   getMetadata
Sampling rate (Hz):        1.0                   — optional, surfaced

────────────────  Server settings (only first node sets these)  ────────────
HTTP port:                 3001                  — singleton, ignored after
                                                   first registration
Bearer token:              (credential)          — required to start the
                                                   server; mismatched values
                                                   from later nodes emit
                                                   `optionMismatch`
Bind address:              127.0.0.1             — `0.0.0.0` opt-in, with
                                                   warning
Allow origins (CORS):      (comma list)          — default empty = no CORS
```

## 7. Auth Contract

- Every MCP request must carry `Authorization: Bearer <token>`.
- Mismatch ⇒ HTTP 401, no body.
- Comparison via the same `timingSafeEqualStrings` helper used by
  `WebSocketManager` (PR2 hardening). Constant-time, length-checked.
- Empty/unset token disables the server entirely; the node logs a warning
  and stays in "configured but not running" state. We don't ship a default
  token to dodge "unconfigured-equals-public" pitfalls.

## 8. Persistence

- Buffer state lives in `state-persistence` under key
  `mcpBridge:<sensor>` (one key per sensor name).
- Save interval 60 s, save-on-shutdown via Node-RED's `close` hook.
- Restored on node start; sensor metadata is rebuilt from the first input
  message received after restart (samplingHz, unit etc.).
- Test plan: restart with a fully-loaded buffer, restart with a half-empty
  buffer, restart while the server is mid-request.

## 9. Out of Scope (now and forever, unless re-spec'd)

- Writing back to flows, MQTT, or Node-RED context.
- Dynamic tool definition / arbitrary JS evaluation.
- Server-Sent push of sensor updates without an explicit subscribe handshake.
  (May come later as a separate `subscribe` tool, but only after auth tiers
  exist.)
- Multi-tenant separation. One bridge = one operator-trust-domain.

## 10. Phases

Each phase ends with a green test suite + lint + format.

### Phase 0 — Spike (✅ acceptance: round-trip with mcp-inspector)

Standalone script `experiments/mcp-spike.js`. Installs `@modelcontextprotocol/sdk`
as optional dep. Starts an MCP server with one mocked tool that returns a
hardcoded sensor list. Manual testing: connect via `npx @modelcontextprotocol/inspector`
and call `listSensors`.

**Acceptance:**
- Spike script starts, prints the listening URL.
- `npx @modelcontextprotocol/inspector` lists the tool and gets a non-empty
  response when invoking it.
- README of `experiments/` documents the run command.

### Phase 1 — MVP

Real `mcp-bridge` Node-RED node. Singleton manager. Read-only tools:
`listSensors`, `getRecentSamples`, `getStats`, `getMetadata`. Bearer-token
auth. Unit tests + integration test (real Node-RED + real MCP client).

**Acceptance:**
- `mcp-bridge` registers, accepts input, buffers samples.
- All four tools callable through bearer-authenticated MCP request.
- Integration test deploys a flow with two `mcp-bridge` nodes, makes an MCP
  request, asserts both sensors appear in `listSensors`.
- Auth-fail test: missing/wrong token → 401.

### Phase 2 — Analytics tools

`getZScore`, `findAnomalies`, `correlate`, `getRange`. All delegate to
`utils/statistics`.

**Acceptance:**
- Each tool has a unit test verifying the math (delegated → already covered)
  *and* an MCP-level integration test verifying the wire schema.
- `correlate` returns `null` correctly for degenerate inputs (length<2,
  zero variance).

### Phase 3 — Persistence

Buffer survives Node-RED restart. Use `state-persistence` exactly like
`anomaly-detector`. Restart-while-busy isn't formally tested (out of scope for
v1) — documented as known caveat.

**Acceptance:**
- Integration test: deploy flow, push 100 samples, redeploy flow, confirm
  buffer still holds them.

### Phase 4 — Multi-topic routing

A single node can register N sensors via a topic-glob match (`machine-*/temp`),
not just a hardcoded sensor name.

**Acceptance:**
- One node with glob picks up two distinct topics, each surfaces as its
  own sensor in `listSensors`.

### Phase 5 (later) — stdio transport, audit log

Stdio for users who run Claude Desktop on the same host; structured audit
log of all incoming MCP calls with token-id (not value) and tool name.
Spec'd separately.

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| `@modelcontextprotocol/sdk` evolves quickly, breaks at minor versions | Pin in `optionalDependencies`; CI's `optional-runtimes` job catches breakage early |
| Bearer token leaked via flow.json export | Stored as Node-RED *credential* (encrypted at rest), never logged |
| Buffer unbounded on misconfigured node | Hard maximum 100k samples per sensor at the manager level |
| Operator binds to `0.0.0.0` without thinking | UI warns inline; README has a "do not expose to public networks" callout |
| LLM client crashes / hangs the server | Per-request 30s timeout + per-token rate limit (1 req/s default), like `ml-inference`'s fetch behaviour |
| Two nodes disagree on `port` / `bearer` / `bind` | Singleton emits `optionMismatch` event; node logs `warn` (mirrors `WebSocketManager` semantics) |

## 12. Test Plan Summary

| Layer | Suite | Covers |
|-------|-------|--------|
| Unit | `test/utils-statistics-prop_spec.js` (existing) | Math correctness underneath the tools |
| Unit | `test/mcp-bridge_spec.js` (new) | Buffer lifecycle, manager singleton, token compare |
| Integration | `test/integration/mcp-bridge-flow_spec.js` (new) | Real Node-RED + real MCP client, all 8 tools, auth, persistence |

CI thresholds stay as today: 0 ESLint errors, format clean, all suites green.

---

## Appendix A — Open Questions Carried Forward

These are *not* blockers for Phase 0/1 but should be answered before Phase 5.

1. Should we support **resources** (the other half of the MCP spec, for
   long-running streamed data) in addition to tools? Likely yes for
   live-tail use cases, but separate spec.
2. Should the audit log be queryable as its own MCP tool? Risks: leaks
   timing info; rejects as anti-pattern unless someone makes a strong
   case.
3. Is there value in surfacing Node-RED **status** (errors, restarts) as
   tool output? Probably yes, but only in Phase 6.
