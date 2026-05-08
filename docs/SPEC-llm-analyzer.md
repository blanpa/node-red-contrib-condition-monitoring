# SPEC — `llm-analyzer` Node

**Status**: Phase 1 (MVP) + Phase 2 (multi-provider) + Phase 3 (record mode) + Phase 4 (JSON output) + Phase 5 (buffer caps + persistence + cost tracking + concurrency safety) implemented.
**Replaces**: `mcp-bridge` (passive MCP server) — withdrawn 2026-05-06.

## Why this exists

Operators want to ship live sensor data into an LLM and get back a
plain-text analysis (anomalies, trends, "explain this batch") that
flows back into the rest of the Node-RED pipeline. The retired
`mcp-bridge` solved a different problem (operator chats *with* an
external LLM client), produced no Node-RED output, and required the
operator to switch to Claude Desktop. The new node turns the LLM call
into a normal in-flow step:

```
sensor → [batch buffer N] → [build prompt] → LLM API → msg.payload = "<analysis>"
                                                       msg.usage    = { in, out }
                                                       msg.samples  = [..N..]
```

## Decisions (Phase 1)

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | **Five providers** (Phase 2): `anthropic`, `openai`, `google`, `ollama`, `openai-compatible`. | The first four cover the dominant API shapes; `openai-compatible` is a generic adapter that picks up Groq, Together, OpenRouter, DeepSeek, Mistral, vLLM, LMStudio, and any future host that speaks Chat Completions — for one bit of code. |
| D2 | **Plain `fetch`**, no SDK dependency. | Each provider's HTTP API is small enough that an SDK adds dependency surface area without payoff. Node ≥ 18 has `fetch`. |
| D3 | **Three trigger modes**: `batch` (collect N, then fire), `manual` (only when `msg.flush === true`), `interval` (every X ms, fire on whatever's in the buffer). | Covers the three use cases operators ask for: throughput-bounded, ad-hoc, and time-bounded reports. |
| D4 | **Stats are pre-computed** and injected into the prompt. | Saves tokens; an LLM does not need to recompute mean/stdDev from raw samples. |
| D5 | **`msg.prompt` overrides** the user-prompt template (after substitution). `msg.systemPrompt` overrides system. | Lets a `change`-node pick a different prompt per shift / context without redeploying. |
| D6 | **API key via Node-RED credentials** (encrypted-at-rest), with an inline-config backstop for tests/dev only. | Same pattern as `mcp-bridge` had. |
| D7 | **Output as `msg.payload` text by default**; structured-JSON output deferred to Phase 2. | Phase 1 keeps schema design out of scope. |
| D8 | **`apiUrl` is overridable** (config + `msg.apiUrl`). | So integration tests can point at a local mock server without touching `fetch`. |

## Configuration

| Field | Default | Notes |
|-------|---------|-------|
| `provider` | `anthropic` | one of `anthropic` \| `openai` \| `google` \| `ollama` \| `openai-compatible` |
| `model` | `claude-haiku-4-5-20251001` | text input — operator can override |
| `apiUrl` | *empty → provider default (see below)* | required for `openai-compatible`; optional override otherwise |
| `triggerMode` | `batch` | `batch` \| `manual` \| `interval` |
| `batchSize` | `50` | only used when `triggerMode === "batch"` |
| `intervalMs` | `60000` | only used when `triggerMode === "interval"` |
| `maxOutputTokens` | `1024` | passed to provider as `max_tokens` |
| `timeoutMs` | `30000` | per-request abort timeout |
| `systemPrompt` | *built-in default (see below)* | textarea |
| `userPromptTemplate` | *built-in default (see below)* | textarea, supports `{samples}`, `{stats}`, `{sensor}`, `{unit}`, `{count}` |
| `sensorName` | empty | metadata, fills `{sensor}` placeholder |
| `unit` | empty | metadata, fills `{unit}` placeholder |
| `passthroughOriginal` | `true` | if true, output preserves original `msg.payload` as `msg.input` |
| **credential** `apiKey` | — | encrypted on disk |

### Default prompts

```
SYSTEM:
You are an industrial sensor analyst. Analyse the time-series batch you
are given and report anomalies, trends, and notable patterns. Answer in
three sentences or fewer. If nothing is unusual, say so explicitly.

USER (template):
Sensor {sensor} ({unit}). Batch of {count} samples.
Stats: {stats}
Recent values (oldest first):
{samples}
```

## Inputs

| `msg.*` | Type | Effect |
|---------|------|--------|
| `payload` | `number` \| `string` (numeric) \| `number[]` | Single value pushed into batch buffer; or array spread into buffer. |
| `flush` | `true` | (manual mode only) trigger the LLM call now with the current buffer. Ignored in `batch`/`interval` modes. |
| `prompt` | `string` | Replace the *user* prompt entirely (substitution still applied). |
| `systemPrompt` | `string` | Replace the *system* prompt. |
| `apiUrl` | `string` | Per-message API URL override (testing). |
| `model` | `string` | Per-message model override. |

## Outputs (single output pin)

```js
{
    payload:   "<LLM response text>",
    usage:     { inputTokens: N, outputTokens: M },
    samples:   [ ...the batch that was sent... ],
    sensor:    "machine-A/temp",
    unit:      "°C",
    model:     "claude-haiku-4-5-...",
    durationMs: 1234,
    input:     <original msg.payload, only if passthroughOriginal>,
    topic:     <pass-through>,
    _msgid:    <pass-through>
}
```

On API error: `node.error("llm-analyzer: <message>", originalMsg)` so a
catch-node can pick it up. The node does **not** emit a payload-bearing
output on error.

## Status indicator

| State | Visual |
|-------|--------|
| idle / waiting for input | green dot — `ready` |
| collecting batch | blue ring — `buffering 23/50` |
| in-flight request | yellow dot — `calling LLM` |
| last call OK | green dot — `ok 124in/89out · 1.2s` |
| last call failed | red ring — `<error class>` |

## Provider defaults

| Provider | Default endpoint | API-key | Notes |
|----------|------------------|---------|-------|
| `anthropic` | `https://api.anthropic.com/v1/messages` | `x-api-key` header | Native Messages API. |
| `openai` | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` | Chat Completions. |
| `google` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `?key=` query param | Substitutes `{model}` from config; `systemInstruction` shape. |
| `ollama` | `http://localhost:11434/api/chat` | none (or optional Bearer) | Local model runner; works offline. |
| `openai-compatible` | **REQUIRED** to be set | `Authorization: Bearer` | Generic adapter — Groq, Together, OpenRouter, DeepSeek, Mistral API, vLLM, LMStudio, … |

## Phases

- **Phase 1** ✅ — three trigger modes, plain text output, prompt template + `msg.prompt` override, real test coverage with mocked HTTP.
- **Phase 2** ✅ — five providers (Anthropic, OpenAI, Google Gemini, Ollama, OpenAI-compatible) sharing one HTTP helper for abort/timeout/error mapping. Each adapter normalises usage to `{ inputTokens, outputTokens }`.
- **Phase 3** ✅ — Multi-sensor record mode: `inputMode: "record"` accepts object-payloads (`{temp:65, pressure:4.5, …}`) or arrays of them, auto-detects numeric columns (with sensible timestamp/id skipping) or honours an explicit `columns` allowlist, computes per-column stats, and ships a tabular view to the LLM. Enables cross-sensor correlation in one call (e.g. "temp spiked AND pressure dropped → leak").
- **Phase 4** ✅ — Structured JSON output: `outputMode: "json"` appends a schema instruction to the system prompt (provider-agnostic — works on all five). Response is parsed with a tolerant extractor (handles plain JSON, markdown fences, prose-wrapped objects, and braces inside strings). Optional `outputPath` extracts a single nested field as `msg.payload` for direct use in switch / threshold nodes downstream.
- **Phase 5** ✅ — Production hardening:
  - **Buffer caps**: `maxBufferSize` (hard cap, ring-buffer drops oldest) + `maxSamplesInPrompt` (token-cost knob).
  - **State persistence**: when `persistState: true`, buffer + detected columns + lifetime counters survive redeploys via the shared `state-persistence` module.
  - **Cost tracking**: per-call `msg.usage` and lifetime `msg.totalUsage = { inputTokens, outputTokens, callCount }`; status line shows `ok · 234 calls · 12.4kin/3.1kout · 1.2s`.
  - **Concurrency safety**: triggers arriving during an in-flight call are queued (one slot, "manual" beats "batch"/"interval") instead of being dropped — no silent data loss when the provider is slow.
- **Phase 6** (deferred) — Tool-use: the LLM gets a small set of cheap tools (`getStats`, `getRecentSamples`) and may call them mid-response. Useful when the operator's prompt asks something the static prompt cannot pre-compute.
- **Phase 7** (deferred) — Streaming token output (one msg per chunk) and provider-native JSON mode (`response_format: json_schema`) for stricter validation.

## Record mode — input/output

Setting | Behaviour
---|---
`inputMode: "scalar"` | Default. `msg.payload` = number / numeric string / number-array. Buffer holds flat numbers. Prompt vars: `{count}`, `{stats}` (single line), `{samples}` (CSV).
`inputMode: "record"` | `msg.payload` = object (or array of objects). Buffer holds `{col: number, …}` rows. Prompt vars: `{count}`, `{columns}`, `{stats}` (per-column block), `{records}` (tabular).
`columns: ""` (record mode only) | Empty → auto-detect numeric columns from the first record received. Non-empty (e.g. `"temp, pressure"`) → operator-supplied allowlist; non-listed fields are ignored. Useful to drop a `timestamp` column.

The default user-prompt template differs per mode (see `nodes/llm-analyzer.js`'s `DEFAULT_USER_TEMPLATE_SCALAR` / `_RECORD`). Operators can write their own template referencing any subset of the placeholders; both `{stats}` and `{samples}` are populated in both modes (with mode-appropriate content) so a custom template doesn't break when the mode changes.

## Test plan

### Unit (`test/llm-analyzer_spec.js`)

- batch trigger fires at exactly N samples, not at N-1 or N+1
- manual trigger fires only on `msg.flush === true`
- interval trigger fires roughly every `intervalMs` (use Jest fake timers)
- prompt-template substitution covers all placeholders
- `msg.prompt` and `msg.systemPrompt` override correctly
- `passthroughOriginal` preserves the upstream payload
- API error → `node.error()`, no payload output
- timeout aborts the request

### Integration (`test/integration/llm-analyzer-flow_spec.js`)

A local mock HTTP server (no SDK, no real API call) replays a canned
Anthropic response. The flow `inject → llm-analyzer → capture` is
deployed in a real Node-RED runtime via the existing `red-runtime.js`
harness. We assert:

- N injects of numeric payloads → exactly one LLM call, captured request body matches expected shape
- response → `msg.payload` (text) and `msg.usage` (token counts)
- `msg.flush=true` in manual mode triggers a fire with whatever's in the buffer
- HTTP 401 from the mock → catch-node sees the error
