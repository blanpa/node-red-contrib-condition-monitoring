/**
 * LLM provider adapters for the `llm-analyzer` node.
 *
 * Each adapter implements the same contract:
 *
 *     async function callXxx({ apiKey, model, systemPrompt, userPrompt,
 *                              maxTokens, timeoutMs, apiUrl, fetchFn }) {
 *         return { text, usage: { inputTokens, outputTokens },
 *                  model, durationMs, raw };
 *     }
 *
 * `fetchFn` is injectable — tests pass a stub instead of stubbing the
 * global. `apiUrl` is overridable so an integration test can point at a
 * mock HTTP server without monkey-patching anything.
 *
 * Phase 2 ships five providers:
 *   - anthropic            (Claude — native Messages API)
 *   - openai               (Chat Completions API)
 *   - google               (Gemini — generateContent API)
 *   - ollama               (local — /api/chat)
 *   - openai-compatible    (any OpenAI-shape endpoint: Groq, Together,
 *                           OpenRouter, DeepSeek, Mistral, vLLM, LMStudio…)
 */

"use strict";

const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
const DEFAULT_OLLAMA_URL = "http://localhost:11434/api/chat";
const ANTHROPIC_VERSION = "2023-06-01";

class LlmHttpError extends Error {
    constructor(message, opts) {
        super(message);
        this.name = "LlmHttpError";
        this.status = opts && opts.status;
        this.kind = (opts && opts.kind) || "http";
    }
}

// ---------------------------------------------------------------------------
// Shared HTTP helper
// ---------------------------------------------------------------------------

/**
 * Run a single fetch with abort/timeout, parse the body as JSON, and map HTTP
 * status to an LlmHttpError class. Each provider adapter owns body shape and
 * response parsing — this only handles the wire mechanics.
 *
 * @returns {Promise<{parsed:any, rawText:string, durationMs:number, status:number}>}
 */
async function _httpCall({ url, headers, body, timeoutMs, fetchFn, providerLabel }) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    let res;
    try {
        res = await fetchFn(url, {
            method: "POST",
            headers,
            body: typeof body === "string" ? body : JSON.stringify(body),
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(t);
        if (err && err.name === "AbortError") {
            throw new LlmHttpError("LLM call timed out after " + timeoutMs + "ms", { kind: "timeout" });
        }
        throw new LlmHttpError("network error: " + (err && err.message), { kind: "network" });
    }
    clearTimeout(t);

    const durationMs = Date.now() - startedAt;
    const rawText = await res.text();
    let parsed = null;
    try {
        parsed = rawText ? JSON.parse(rawText) : null;
    } catch (_) {
        // leave parsed null on non-JSON
    }

    if (!res.ok) {
        const detail =
            (parsed && parsed.error && (parsed.error.message || parsed.error)) ||
            (parsed && parsed.message) ||
            rawText ||
            "(no body)";
        throw new LlmHttpError(providerLabel + " API " + res.status + ": " + String(detail).slice(0, 400), {
            status: res.status,
            kind: res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate-limit" : "http"
        });
    }

    return { parsed, rawText, durationMs, status: res.status };
}

function _validateCommon(args, providerLabel, requireApiKey = true) {
    if (!args || typeof args !== "object") {
        throw new TypeError(providerLabel + ": args object required");
    }
    const fetchFn = args.fetchFn || globalThis.fetch;
    if (typeof fetchFn !== "function") {
        throw new LlmHttpError("global fetch unavailable — Node 18+ required", { kind: "config" });
    }
    if (requireApiKey && (typeof args.apiKey !== "string" || args.apiKey.length === 0)) {
        throw new LlmHttpError("apiKey is required", { kind: "config" });
    }
    if (typeof args.model !== "string" || args.model.length === 0) {
        throw new LlmHttpError("model is required", { kind: "config" });
    }
    if (typeof args.userPrompt !== "string" || args.userPrompt.length === 0) {
        throw new LlmHttpError("userPrompt is required", { kind: "config" });
    }
    return fetchFn;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic(args) {
    const fetchFn = _validateCommon(args, "anthropic");
    const url = (args.apiUrl && String(args.apiUrl).trim()) || DEFAULT_ANTHROPIC_URL;
    const maxTokens = Number.isFinite(args.maxTokens) ? args.maxTokens : 1024;
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30000;

    const body = {
        model: args.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: args.userPrompt }]
    };
    if (args.systemPrompt) body.system = args.systemPrompt;

    const { parsed, durationMs } = await _httpCall({
        url,
        headers: {
            "x-api-key": args.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            accept: "application/json"
        },
        body,
        timeoutMs,
        fetchFn,
        providerLabel: "Anthropic"
    });

    if (!parsed || !Array.isArray(parsed.content)) {
        throw new LlmHttpError("Anthropic response missing content[]", { kind: "shape" });
    }
    const text = parsed.content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
    const usage = parsed.usage || {};
    return {
        text,
        usage: {
            inputTokens: Number(usage.input_tokens) || 0,
            outputTokens: Number(usage.output_tokens) || 0
        },
        model: parsed.model || args.model,
        durationMs,
        raw: parsed
    };
}

// ---------------------------------------------------------------------------
// OpenAI (Chat Completions API)
// ---------------------------------------------------------------------------

async function callOpenAI(args) {
    return _callOpenAIShape(args, {
        defaultUrl: DEFAULT_OPENAI_URL,
        providerLabel: "OpenAI",
        requireApiKey: true,
        requireApiUrl: false
    });
}

/**
 * Generic OpenAI-compatible adapter — anything that speaks the
 * Chat Completions schema (Groq, Together, OpenRouter, DeepSeek,
 * Mistral API, vLLM, LMStudio, …). The user must supply `apiUrl`
 * pointing at the provider's chat-completions endpoint.
 */
async function callOpenAICompatible(args) {
    return _callOpenAIShape(args, {
        defaultUrl: null, // user MUST supply apiUrl
        providerLabel: "OpenAI-compatible",
        requireApiKey: true,
        requireApiUrl: true
    });
}

async function _callOpenAIShape(args, opts) {
    const fetchFn = _validateCommon(args, opts.providerLabel, opts.requireApiKey);
    const url = (args.apiUrl && String(args.apiUrl).trim()) || opts.defaultUrl;
    if (!url) {
        throw new LlmHttpError(opts.providerLabel + ": apiUrl is required (no default endpoint)", {
            kind: "config"
        });
    }
    const maxTokens = Number.isFinite(args.maxTokens) ? args.maxTokens : 1024;
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30000;

    const messages = [];
    if (args.systemPrompt) messages.push({ role: "system", content: args.systemPrompt });
    messages.push({ role: "user", content: args.userPrompt });

    const body = {
        model: args.model,
        messages,
        max_tokens: maxTokens
    };

    const headers = {
        "content-type": "application/json",
        accept: "application/json"
    };
    if (args.apiKey) headers["authorization"] = "Bearer " + args.apiKey;

    const { parsed, durationMs } = await _httpCall({
        url,
        headers,
        body,
        timeoutMs,
        fetchFn,
        providerLabel: opts.providerLabel
    });

    if (!parsed || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
        throw new LlmHttpError(opts.providerLabel + " response missing choices[]", { kind: "shape" });
    }
    const choice = parsed.choices[0];
    const text =
        (choice && choice.message && typeof choice.message.content === "string" && choice.message.content) || "";
    const usage = parsed.usage || {};
    return {
        text,
        usage: {
            inputTokens: Number(usage.prompt_tokens) || 0,
            outputTokens: Number(usage.completion_tokens) || 0
        },
        model: parsed.model || args.model,
        durationMs,
        raw: parsed
    };
}

// ---------------------------------------------------------------------------
// Google (Gemini — generateContent API)
// ---------------------------------------------------------------------------

async function callGoogle(args) {
    const fetchFn = _validateCommon(args, "Google");
    const baseUrl = (args.apiUrl && String(args.apiUrl).trim()) || DEFAULT_GOOGLE_URL;
    // Default URL has a `{model}` placeholder; substitute. If user provided a
    // full URL with `{model}` they get the same treatment, which is a feature.
    const url =
        baseUrl.replace("{model}", encodeURIComponent(args.model)) +
        (baseUrl.indexOf("?") === -1 ? "?" : "&") +
        "key=" +
        encodeURIComponent(args.apiKey);
    const maxTokens = Number.isFinite(args.maxTokens) ? args.maxTokens : 1024;
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30000;

    const body = {
        contents: [{ role: "user", parts: [{ text: args.userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens }
    };
    if (args.systemPrompt) {
        body.systemInstruction = { parts: [{ text: args.systemPrompt }] };
    }

    const { parsed, durationMs } = await _httpCall({
        url,
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        timeoutMs,
        fetchFn,
        providerLabel: "Google"
    });

    if (!parsed || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
        // Gemini returns `promptFeedback` with a blocking reason in some cases.
        const blockReason = parsed && parsed.promptFeedback && parsed.promptFeedback.blockReason;
        throw new LlmHttpError(
            "Google response missing candidates[]" + (blockReason ? " (blocked: " + blockReason + ")" : ""),
            { kind: blockReason ? "blocked" : "shape" }
        );
    }
    const cand = parsed.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts
        .filter((p) => p && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
    const meta = parsed.usageMetadata || {};
    return {
        text,
        usage: {
            inputTokens: Number(meta.promptTokenCount) || 0,
            outputTokens: Number(meta.candidatesTokenCount) || 0
        },
        model: parsed.modelVersion || args.model,
        durationMs,
        raw: parsed
    };
}

// ---------------------------------------------------------------------------
// Ollama (local)
// ---------------------------------------------------------------------------

async function callOllama(args) {
    // Ollama doesn't require an API key. Some hosted forwarders do — accept
    // an optional apiKey and add it as Bearer if present.
    const fetchFn = _validateCommon(args, "Ollama", false);
    const url = (args.apiUrl && String(args.apiUrl).trim()) || DEFAULT_OLLAMA_URL;
    const maxTokens = Number.isFinite(args.maxTokens) ? args.maxTokens : 1024;
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30000;

    const messages = [];
    if (args.systemPrompt) messages.push({ role: "system", content: args.systemPrompt });
    messages.push({ role: "user", content: args.userPrompt });

    const body = {
        model: args.model,
        messages,
        stream: false,
        options: { num_predict: maxTokens }
    };

    const headers = { "content-type": "application/json", accept: "application/json" };
    if (args.apiKey) headers["authorization"] = "Bearer " + args.apiKey;

    const { parsed, durationMs } = await _httpCall({
        url,
        headers,
        body,
        timeoutMs,
        fetchFn,
        providerLabel: "Ollama"
    });

    if (!parsed || !parsed.message || typeof parsed.message.content !== "string") {
        throw new LlmHttpError("Ollama response missing message.content", { kind: "shape" });
    }
    return {
        text: parsed.message.content,
        usage: {
            inputTokens: Number(parsed.prompt_eval_count) || 0,
            outputTokens: Number(parsed.eval_count) || 0
        },
        model: parsed.model || args.model,
        durationMs,
        raw: parsed
    };
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const PROVIDERS = {
    anthropic: { call: callAnthropic, defaultUrl: DEFAULT_ANTHROPIC_URL, needsApiKey: true, label: "Anthropic" },
    openai: { call: callOpenAI, defaultUrl: DEFAULT_OPENAI_URL, needsApiKey: true, label: "OpenAI" },
    google: { call: callGoogle, defaultUrl: DEFAULT_GOOGLE_URL, needsApiKey: true, label: "Google (Gemini)" },
    ollama: { call: callOllama, defaultUrl: DEFAULT_OLLAMA_URL, needsApiKey: false, label: "Ollama" },
    "openai-compatible": {
        call: callOpenAICompatible,
        defaultUrl: null,
        needsApiKey: true,
        needsApiUrl: true,
        label: "OpenAI-compatible (Groq / Together / OpenRouter / …)"
    }
};

function getProvider(name) {
    const meta = PROVIDERS[name];
    if (!meta) {
        throw new LlmHttpError("unknown provider: " + String(name), { kind: "config" });
    }
    return meta;
}

// ---------------------------------------------------------------------------
// Prompt helpers (unchanged)
// ---------------------------------------------------------------------------

function formatStatsLine(s) {
    if (!s || typeof s !== "object") return "";
    const fmt = (n) => {
        if (!Number.isFinite(n)) return "n/a";
        return parseFloat(n.toPrecision(4)).toString();
    };
    const parts = [];
    if (Number.isFinite(s.count)) parts.push("n=" + s.count);
    if (Number.isFinite(s.mean)) parts.push("mean=" + fmt(s.mean));
    if (Number.isFinite(s.stdDev)) parts.push("stdDev=" + fmt(s.stdDev));
    if (Number.isFinite(s.min)) parts.push("min=" + fmt(s.min));
    if (Number.isFinite(s.max)) parts.push("max=" + fmt(s.max));
    if (Number.isFinite(s.range)) parts.push("range=" + fmt(s.range));
    return parts.join(" ");
}

function formatSamplesList(samples, maxValues) {
    if (!Array.isArray(samples) || samples.length === 0) return "(empty)";
    const cap = Number.isFinite(maxValues) && maxValues > 0 ? maxValues : 100;
    const used = samples.length > cap ? samples.slice(samples.length - cap) : samples;
    const head = samples.length > cap ? "(showing last " + cap + " of " + samples.length + ")\n" : "";
    return (
        head + used.map((v) => (Number.isFinite(v) ? parseFloat(v.toPrecision(6)).toString() : String(v))).join(", ")
    );
}

function _fmt4(n) {
    return Number.isFinite(n) ? parseFloat(n.toPrecision(4)).toString() : "n/a";
}

function _fmt6(n) {
    return Number.isFinite(n) ? parseFloat(n.toPrecision(6)).toString() : "n/a";
}

/**
 * Format a batch of multi-sensor records as a compact tabular block for
 * the prompt. Each row becomes one line: `t=N col1=val1 col2=val2 …`.
 * Records longer than `maxRows` are tail-trimmed (newest kept).
 *
 * @param {Array<Object>} records
 * @param {Array<string>} columns
 * @param {number} [maxRows=100]
 */
function formatRecordsTable(records, columns, maxRows) {
    if (!Array.isArray(records) || records.length === 0) return "(empty)";
    if (!Array.isArray(columns) || columns.length === 0) return "(no columns)";
    const cap = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : 100;
    const offset = Math.max(0, records.length - cap);
    const used = records.slice(offset);
    const head = records.length > cap ? "(showing last " + cap + " of " + records.length + ")\n" : "";
    const lines = used.map((r, idx) => {
        const parts = columns.map((c) => {
            const v = r && r[c];
            return c + "=" + _fmt6(v);
        });
        return "t=" + (offset + idx + 1) + " " + parts.join(" ");
    });
    return head + lines.join("\n");
}

/**
 * Format per-column stats as a multi-line block:
 *
 *   temp:      n=30 mean=68.6 stdDev=3.6 min=64.2 max=75.9
 *   pressure:  n=30 mean=4.5  stdDev=0.0 min=4.5  max=4.5
 *
 * Column names are right-padded so values align — easier for the LLM to
 * spot anomalies across columns at a glance.
 *
 * @param {Object<string, {count,mean,stdDev,min,max,range?}>} colStats
 */
function formatPerColumnStats(colStats) {
    if (!colStats || typeof colStats !== "object") return "";
    const cols = Object.keys(colStats);
    if (cols.length === 0) return "(no columns)";
    const labelWidth = Math.min(20, Math.max(...cols.map((c) => c.length)) + 1);
    const lines = cols.map((col) => {
        const s = colStats[col] || {};
        const parts = [
            "n=" + (Number.isFinite(s.count) ? s.count : "0"),
            "mean=" + _fmt4(s.mean),
            "stdDev=" + _fmt4(s.stdDev),
            "min=" + _fmt4(s.min),
            "max=" + _fmt4(s.max)
        ];
        return "  " + (col + ":").padEnd(labelWidth + 1) + parts.join(" ");
    });
    return lines.join("\n");
}

/**
 * Parse a comma-separated list ("a, b , c") into a trimmed array of names.
 * Empty input → []. Used by the columns allowlist field.
 */
function parseCsvList(raw) {
    if (typeof raw !== "string") return [];
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

// Common timestamp/identifier field names that are numeric but rarely
// useful as a "sensor" reading. The auto-detector skips these by default
// so a typical SCADA snapshot like {timestamp, temp, pressure} doesn't
// pollute the LLM's stats with an epoch number. Operators can still
// include them via the explicit columns allowlist.
const DEFAULT_SKIP_FIELDS = new Set(["timestamp", "time", "ts", "_ts", "epoch", "datetime", "date", "id", "_id"]);

/**
 * Auto-detect numeric columns in a record. A column is numeric if its value
 * is a finite number, OR a string that parses to a finite number. Used when
 * the operator hasn't supplied a `columns` allowlist — the FIRST record
 * received establishes the column set, and subsequent records use the same.
 *
 * Common timestamp/identifier names (`timestamp`, `time`, `id`, …) are
 * skipped by default so a SCADA snapshot doesn't accidentally include an
 * epoch number as a "sensor".
 */
function detectNumericColumns(record, opts) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const skipDefault = !opts || opts.skipDefaultTimestamps !== false;
    const extraSkip = opts && Array.isArray(opts.skip) ? new Set(opts.skip) : null;
    const cols = [];
    for (const [k, v] of Object.entries(record)) {
        const lower = k.toLowerCase();
        if (skipDefault && DEFAULT_SKIP_FIELDS.has(lower)) continue;
        if (extraSkip && extraSkip.has(k)) continue;
        if (typeof v === "number" && Number.isFinite(v)) {
            cols.push(k);
        } else if (typeof v === "string") {
            const n = parseFloat(v);
            if (Number.isFinite(n)) cols.push(k);
        }
    }
    return cols;
}

function fillTemplate(template, vars) {
    if (typeof template !== "string") return "";
    return template.replace(/\{(\w+)\}/g, (whole, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole;
    });
}

/**
 * Try hard to find a JSON object inside an LLM response. LLMs often wrap
 * the JSON in prose ("Here's the result: { … }") or in a fenced block
 * (```json\n{ … }\n```). We try, in order:
 *
 *   1. Direct `JSON.parse(text)` — works when the model behaved.
 *   2. Strip a markdown fence (```...``` or ```json...```) and parse the inside.
 *   3. Find the first top-level `{...}` or `[...]` substring and parse that.
 *
 * Returns `{ ok: true, value }` on success, `{ ok: false, reason }` on
 * failure. The caller decides whether to surface as `node.error()` or
 * fall back to text mode.
 */
function extractJson(text) {
    if (typeof text !== "string") {
        return { ok: false, reason: "non-string response" };
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return { ok: false, reason: "empty response" };
    }

    // 1. Direct.
    try {
        return { ok: true, value: JSON.parse(trimmed) };
    } catch (_) {
        /* fall through */
    }

    // 2. Markdown fence: ```json\n…\n``` or ```\n…\n```.
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fence && fence[1]) {
        try {
            return { ok: true, value: JSON.parse(fence[1].trim()) };
        } catch (_) {
            /* fall through */
        }
    }

    // 3. First balanced { … } or [ … ] substring. We do a naive bracket
    // scan that respects strings — good enough for typical LLM output.
    const candidate = _findFirstBalanced(trimmed);
    if (candidate) {
        try {
            return { ok: true, value: JSON.parse(candidate) };
        } catch (_) {
            /* fall through */
        }
    }

    return { ok: false, reason: "no parseable JSON in response" };
}

function _findFirstBalanced(s) {
    const startIdx = (() => {
        const obj = s.indexOf("{");
        const arr = s.indexOf("[");
        if (obj < 0) return arr;
        if (arr < 0) return obj;
        return Math.min(obj, arr);
    })();
    if (startIdx < 0) return null;
    const open = s[startIdx];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = startIdx; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (escaped) {
                escaped = false;
            } else if (c === "\\") {
                escaped = true;
            } else if (c === '"') {
                inStr = false;
            }
            continue;
        }
        if (c === '"') {
            inStr = true;
        } else if (c === open) {
            depth++;
        } else if (c === close) {
            depth--;
            if (depth === 0) {
                return s.slice(startIdx, i + 1);
            }
        }
    }
    return null;
}

/**
 * Look up a dot-notated path inside a nested object. Numeric segments are
 * treated as array indices, so `"anomalies.0"` works on `{anomalies:[…]}`.
 *
 * Returns `undefined` if any segment misses; the caller treats this as
 * "field not found" and surfaces an error rather than silently sending
 * `undefined` downstream.
 */
function getNestedField(obj, path) {
    if (typeof path !== "string" || path.length === 0) return obj;
    let cur = obj;
    const parts = path.split(".");
    for (const part of parts) {
        if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
        const key = /^\d+$/.test(part) ? parseInt(part, 10) : part;
        cur = cur[key];
    }
    return cur;
}

/**
 * Build the JSON-mode addendum that gets appended to the system prompt.
 * The example schema is shown verbatim — operators write a concrete
 * example object and we ask the LLM to mirror its shape.
 */
function buildJsonInstruction(schemaText) {
    const safe = (typeof schemaText === "string" ? schemaText : "").trim();
    if (safe.length === 0) {
        return (
            "\n\nYou MUST respond with a single valid JSON object. " +
            "Do not include any prose, markdown, or text outside of the JSON."
        );
    }
    return (
        "\n\nYou MUST respond with a single JSON object that matches the " +
        "structure of this example (same field names, same types). Fill " +
        "the values based on your analysis of the data. Do not include " +
        "any prose, markdown, or text before or after the JSON.\n\n" +
        "Example structure:\n" +
        safe
    );
}

module.exports = {
    callAnthropic,
    callOpenAI,
    callGoogle,
    callOllama,
    callOpenAICompatible,
    PROVIDERS,
    getProvider,
    formatStatsLine,
    formatSamplesList,
    formatRecordsTable,
    formatPerColumnStats,
    parseCsvList,
    detectNumericColumns,
    fillTemplate,
    extractJson,
    getNestedField,
    buildJsonInstruction,
    LlmHttpError,
    DEFAULT_ANTHROPIC_URL,
    DEFAULT_OPENAI_URL,
    DEFAULT_GOOGLE_URL,
    DEFAULT_OLLAMA_URL
};
