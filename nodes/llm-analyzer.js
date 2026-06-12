/**
 * llm-analyzer node
 * =================
 *
 * Buffers samples, periodically asks an LLM to analyse them, emits the
 * answer as `msg.payload`. See docs/SPEC-llm-analyzer.md for the full
 * contract.
 */

"use strict";

const stats = require("./utils/statistics");
const providers = require("./utils/llm-providers");
const persistenceHelper = require("./utils/persistence-helper");

const DEFAULT_SYSTEM_PROMPT =
    "You are an industrial sensor analyst. Analyse the time-series batch you " +
    "are given and report anomalies, trends, and notable patterns. Answer in " +
    "three sentences or fewer. If nothing is unusual, say so explicitly.";

const DEFAULT_USER_TEMPLATE_SCALAR =
    "Sensor {sensor} ({unit}). Batch of {count} samples.\n" +
    "Stats: {stats}\n" +
    "Recent values (oldest first):\n" +
    "{samples}";

const DEFAULT_USER_TEMPLATE_RECORD =
    "Multi-sensor batch from {sensor} ({count} records, columns: {columns}).\n" +
    "Per-column stats:\n" +
    "{stats}\n" +
    "Recent records (oldest first):\n" +
    "{records}";

module.exports = function (RED) {
    function LlmAnalyzerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // ------------------------------------------------------------------
        // Configuration
        // ------------------------------------------------------------------
        node.provider = (config.provider || "anthropic").trim();
        node.model = (config.model || "claude-haiku-4-5-20251001").trim();
        node.apiUrl = (config.apiUrl || "").trim() || null;

        node.triggerMode = (config.triggerMode || "batch").trim();
        node.batchSize = clampInt(config.batchSize, 1, 1000, 50);
        node.intervalMs = clampInt(config.intervalMs, 250, 24 * 60 * 60 * 1000, 60000);
        node.maxOutputTokens = clampInt(config.maxOutputTokens, 16, 8192, 1024);
        node.timeoutMs = clampInt(config.timeoutMs, 1000, 5 * 60 * 1000, 30000);
        node.maxBufferSize = clampInt(config.maxBufferSize, 1, 1000000, 10000);
        node.maxSamplesInPrompt = clampInt(config.maxSamplesInPrompt, 1, 10000, 100);

        // Input mode: scalar (one number per msg, or numeric array) or
        // record (multi-column object per msg, e.g. {temp:65, pressure:4.5}).
        node.inputMode = (config.inputMode || "scalar").trim();
        node.columnsAllowlist = providers.parseCsvList(config.columns);

        node.systemPrompt = stringOr(config.systemPrompt, DEFAULT_SYSTEM_PROMPT);
        node.userPromptTemplate = stringOr(
            config.userPromptTemplate,
            node.inputMode === "record" ? DEFAULT_USER_TEMPLATE_RECORD : DEFAULT_USER_TEMPLATE_SCALAR
        );

        node.sensorName = (config.sensorName || "").trim();
        node.unit = (config.unit || "").trim();

        node.passthroughOriginal = config.passthroughOriginal !== false;
        node.persistState = config.persistState === true;

        // Output mode: "text" → msg.payload = LLM string (default).
        //              "json" → msg.payload = parsed object; if outputPath
        //                       is set, msg.payload = that field's value.
        node.outputMode = (config.outputMode || "text").trim();
        node.outputSchema = typeof config.outputSchema === "string" ? config.outputSchema : "";
        node.outputPath = (config.outputPath || "").trim();

        // Provider lookup (anthropic | openai | google | ollama | openai-compatible).
        // Test seam: callers (unit tests) may inject their own provider call.
        let providerMeta = null;
        try {
            providerMeta = providers.getProvider(node.provider);
        } catch (err) {
            node.status({ fill: "red", shape: "ring", text: "unknown provider" });
            node.error("llm-analyzer: " + err.message);
            return;
        }
        node.providerCall = config.providerCall || providerMeta.call;
        node.providerNeedsApiKey = providerMeta.needsApiKey;
        node.providerNeedsApiUrl = providerMeta.needsApiUrl === true;

        // API key from credentials, with an inline backstop for dev/test.
        const credKey =
            node.credentials && typeof node.credentials.apiKey === "string" ? node.credentials.apiKey.trim() : "";
        const inlineKey = (config.apiKey || "").trim();
        node.apiKey = credKey || inlineKey || null;

        // ------------------------------------------------------------------
        // Validation: refuse to half-start.
        // ------------------------------------------------------------------
        if (node.providerNeedsApiKey && !node.apiKey) {
            node.status({ fill: "red", shape: "ring", text: "no API key" });
            node.error("llm-analyzer: apiKey is required for provider '" + node.provider + "'");
            return;
        }
        if (node.providerNeedsApiUrl && !node.apiUrl) {
            node.status({ fill: "red", shape: "ring", text: "no API URL" });
            node.error("llm-analyzer: apiUrl is required for provider '" + node.provider + "' (no default endpoint)");
            return;
        }
        if (!["batch", "manual", "interval"].includes(node.triggerMode)) {
            node.status({ fill: "red", shape: "ring", text: "bad trigger mode" });
            node.error("llm-analyzer: triggerMode must be 'batch' | 'manual' | 'interval'");
            return;
        }
        if (!["scalar", "record"].includes(node.inputMode)) {
            node.status({ fill: "red", shape: "ring", text: "bad input mode" });
            node.error("llm-analyzer: inputMode must be 'scalar' | 'record'");
            return;
        }
        if (!["text", "json"].includes(node.outputMode)) {
            node.status({ fill: "red", shape: "ring", text: "bad output mode" });
            node.error("llm-analyzer: outputMode must be 'text' | 'json'");
            return;
        }

        // ------------------------------------------------------------------
        // State
        // ------------------------------------------------------------------
        // In scalar mode: numeric values, oldest-first.
        // In record mode: { col1: number|null, col2: number|null, … } objects.
        const buffer = [];
        // Counts samples dropped because of the buffer-size cap since the
        // last fire. Reset to 0 in fire(); displayed in the status line.
        let droppedSinceLastFire = 0;
        // Lifetime usage counters — surfaced in the status line and on each
        // outgoing msg as `msg.totalUsage`. Reset only on node redeploy.
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let callCount = 0;
        // Set on the FIRST record received in record mode (or eagerly from
        // the operator-supplied allowlist). Frozen for the rest of the
        // node's lifetime — the LLM gets a stable schema across batches.
        let detectedColumns = node.columnsAllowlist.length > 0 ? node.columnsAllowlist.slice() : null;
        let inFlight = false;
        // When a trigger arrives during an in-flight call we used to just
        // drop it. Now we record the *kind* of pending request so the
        // current call's finally-block can re-fire it. `null` = nothing
        // pending; "manual" = a flush msg arrived; "batch" / "interval" =
        // a buffer-driven trigger arrived.
        let pendingFire = null;
        let intervalHandle = null;
        let closed = false;

        // Apply the maxBufferSize cap: drop oldest if we've exceeded it.
        // O(k) where k = number to drop. For typical caps (< 100k) this is
        // a non-issue; if you push beyond that you have other problems.
        function applyBufferCap() {
            if (buffer.length > node.maxBufferSize) {
                const dropped = buffer.length - node.maxBufferSize;
                buffer.splice(0, dropped);
                droppedSinceLastFire += dropped;
            }
        }

        // Optional state persistence: when `persistState` is on, we save
        // the buffer + detected columns + lifetime counters every 30s and
        // on close. After a redeploy we restore them so a long-running
        // manual/interval flow doesn't lose its accumulated samples.
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "llmAnalyzerState_" + node.id,
            saveInterval: 30000,
            onStateLoaded: function (state) {
                if (Array.isArray(state.buffer)) {
                    const restored = state.buffer.slice(-node.maxBufferSize);
                    for (const v of restored) buffer.push(v);
                }
                if (Array.isArray(state.detectedColumns) && state.detectedColumns.length > 0) {
                    detectedColumns = state.detectedColumns.slice();
                }
                if (Number.isFinite(state.totalInputTokens)) totalInputTokens = state.totalInputTokens;
                if (Number.isFinite(state.totalOutputTokens)) totalOutputTokens = state.totalOutputTokens;
                if (Number.isFinite(state.callCount)) callCount = state.callCount;
            },
            getStateToSave: function () {
                return {
                    buffer: buffer.slice(),
                    detectedColumns: detectedColumns ? detectedColumns.slice() : null,
                    totalInputTokens,
                    totalOutputTokens,
                    callCount
                };
            }
        });

        function setStatus(state) {
            if (closed) return;
            switch (state.kind) {
                case "ready":
                    node.status({ fill: "green", shape: "dot", text: "ready" });
                    break;
                case "buffering": {
                    const cap = node.maxBufferSize;
                    const target = state.target || cap;
                    const warn = droppedSinceLastFire > 0 ? " ⚠ " + droppedSinceLastFire + " dropped" : "";
                    node.status({
                        fill: "blue",
                        shape: "ring",
                        text: "buffering " + buffer.length + "/" + target + warn
                    });
                    break;
                }
                case "calling":
                    node.status({ fill: "yellow", shape: "dot", text: "calling LLM" });
                    break;
                case "ok":
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text:
                            "ok · " +
                            callCount +
                            " calls · " +
                            formatTokenCount(totalInputTokens) +
                            "in/" +
                            formatTokenCount(totalOutputTokens) +
                            "out · " +
                            (state.durationMs / 1000).toFixed(1) +
                            "s"
                    });
                    break;
                case "error":
                    node.status({ fill: "red", shape: "ring", text: state.text || "error" });
                    break;
            }
        }
        setStatus({ kind: "ready" });

        // ------------------------------------------------------------------
        // Sample ingest
        // ------------------------------------------------------------------
        function ingestScalar(payload) {
            if (Array.isArray(payload)) {
                let added = 0;
                for (const v of payload) {
                    const n = toFinite(v);
                    if (n !== null) {
                        buffer.push(n);
                        added++;
                    }
                }
                return added;
            }
            const n = toFinite(payload);
            if (n === null) return 0;
            buffer.push(n);
            return 1;
        }

        function ingestRecord(record) {
            if (!record || typeof record !== "object" || Array.isArray(record)) return 0;

            // First record establishes the column schema if no allowlist
            // was configured. We auto-detect numeric fields once and lock
            // the set — subsequent records use the same columns so the
            // batch shape sent to the LLM is consistent.
            if (!detectedColumns) {
                detectedColumns = providers.detectNumericColumns(record);
                if (detectedColumns.length === 0) {
                    // Don't lock to an empty set — wait for a record with
                    // at least one numeric field.
                    detectedColumns = null;
                    return 0;
                }
            }

            const row = {};
            let anyValid = false;
            for (const col of detectedColumns) {
                const n = toFinite(record[col]);
                row[col] = n; // null for missing/non-numeric
                if (n !== null) anyValid = true;
            }
            if (!anyValid) return 0;
            buffer.push(row);
            return 1;
        }

        function ingest(payload) {
            let added;
            if (node.inputMode === "scalar") {
                added = ingestScalar(payload);
            } else if (Array.isArray(payload)) {
                added = 0;
                for (const r of payload) added += ingestRecord(r);
            } else {
                added = ingestRecord(payload);
            }
            applyBufferCap();
            return added;
        }

        // ------------------------------------------------------------------
        // The fire path: build prompt → call provider → emit msg
        // ------------------------------------------------------------------
        async function fire(originalMsg, send) {
            if (inFlight) {
                // Queue the request instead of dropping. The current call's
                // finally-block will re-fire after it returns. We only track
                // ONE pending request — multiple triggers during the same
                // in-flight call collapse into one re-fire (the buffer
                // already accumulates the data, so re-firing once drains it).
                const kind =
                    originalMsg && originalMsg.flush === true
                        ? "manual"
                        : node.triggerMode === "interval"
                          ? "interval"
                          : "batch";
                // 'manual' wins — it's an explicit operator request and
                // should not be downgraded by a passive batch/interval tick.
                if (pendingFire !== "manual") pendingFire = kind;
                return;
            }
            if (buffer.length === 0) {
                node.warn("llm-analyzer: trigger fired with empty buffer, skipping");
                return;
            }

            inFlight = true;
            // The try MUST start before prompt building: an exception anywhere
            // past this point would otherwise leave inFlight stuck at true and
            // reject the (un-awaited) fire() promise.
            try {
                const samples = buffer.slice();
                buffer.length = 0;
                droppedSinceLastFire = 0;
                setStatus({ kind: "calling" });

                // Build the prompt variables. Both modes fill {sensor}, {unit},
                // {count}; scalar mode adds {samples}+{stats}, record mode adds
                // {records}+{columns}+{stats} (per-column).
                let vars;
                if (node.inputMode === "record") {
                    const cols = detectedColumns || [];
                    const colStats = computePerColumnStats(samples, cols);
                    vars = {
                        sensor: node.sensorName || "(unnamed)",
                        unit: node.unit || "",
                        count: samples.length,
                        columns: cols.join(", "),
                        records: providers.formatRecordsTable(samples, cols, node.maxSamplesInPrompt),
                        stats: providers.formatPerColumnStats(colStats),
                        // {samples} kept available so a custom prompt template
                        // written for scalar mode still substitutes meaningfully.
                        samples: providers.formatRecordsTable(samples, cols, node.maxSamplesInPrompt)
                    };
                } else {
                    const stat = computeStatsBlock(samples);
                    vars = {
                        sensor: node.sensorName || "(unnamed)",
                        unit: node.unit || "(unitless)",
                        count: samples.length,
                        samples: providers.formatSamplesList(samples, node.maxSamplesInPrompt),
                        stats: providers.formatStatsLine(stat),
                        // {records}/{columns} empty in scalar mode so a record-
                        // mode template won't blow up if accidentally used.
                        records: providers.formatSamplesList(samples, node.maxSamplesInPrompt),
                        columns: ""
                    };
                }

                const overrideUserPrompt =
                    originalMsg && typeof originalMsg.prompt === "string" && originalMsg.prompt.length > 0
                        ? originalMsg.prompt
                        : node.userPromptTemplate;
                let overrideSystemPrompt =
                    originalMsg && typeof originalMsg.systemPrompt === "string" && originalMsg.systemPrompt.length > 0
                        ? originalMsg.systemPrompt
                        : node.systemPrompt;
                // JSON-mode: append the schema instruction to the system prompt.
                // We do NOT use provider-native JSON modes (response_format etc.)
                // — the prompt-side approach works across all five providers.
                if (node.outputMode === "json") {
                    overrideSystemPrompt =
                        (overrideSystemPrompt || "") + providers.buildJsonInstruction(node.outputSchema);
                }
                const overrideApiUrl =
                    originalMsg && typeof originalMsg.apiUrl === "string" && originalMsg.apiUrl.length > 0
                        ? originalMsg.apiUrl
                        : node.apiUrl;
                const overrideModel =
                    originalMsg && typeof originalMsg.model === "string" && originalMsg.model.length > 0
                        ? originalMsg.model
                        : node.model;

                const result = await node.providerCall({
                    apiKey: node.apiKey,
                    model: overrideModel,
                    systemPrompt: overrideSystemPrompt,
                    userPrompt: providers.fillTemplate(overrideUserPrompt, vars),
                    maxTokens: node.maxOutputTokens,
                    timeoutMs: node.timeoutMs,
                    apiUrl: overrideApiUrl
                });

                if (closed) return;

                // Build the payload according to output mode. JSON-parse
                // failures are an explicit error path so a downstream
                // catch-node can react — never silently downgrade to text.
                let payload = result.text;
                let json = null;
                if (node.outputMode === "json") {
                    const parsed = providers.extractJson(result.text);
                    if (!parsed.ok) {
                        setStatus({ kind: "error", text: "json parse" });
                        const errMsg = Object.assign({}, originalMsg || {}, {
                            rawResponse: result.text,
                            usage: result.usage,
                            model: result.model
                        });
                        node.error("llm-analyzer: " + parsed.reason + " — see msg.rawResponse", errMsg);
                        return;
                    }
                    json = parsed.value;
                    if (node.outputPath) {
                        const v = providers.getNestedField(json, node.outputPath);
                        if (v === undefined) {
                            setStatus({ kind: "error", text: "path not found" });
                            const errMsg = Object.assign({}, originalMsg || {}, {
                                rawResponse: result.text,
                                json,
                                usage: result.usage,
                                model: result.model
                            });
                            node.error(
                                "llm-analyzer: outputPath '" + node.outputPath + "' missing in JSON response",
                                errMsg
                            );
                            return;
                        }
                        payload = v;
                    } else {
                        payload = json;
                    }
                }

                // Update lifetime counters BEFORE emitting so the outgoing
                // msg reflects the post-call total (consistent with what the
                // status line will show).
                totalInputTokens += result.usage.inputTokens || 0;
                totalOutputTokens += result.usage.outputTokens || 0;
                callCount += 1;

                const out = {
                    payload,
                    usage: result.usage,
                    totalUsage: {
                        inputTokens: totalInputTokens,
                        outputTokens: totalOutputTokens,
                        callCount
                    },
                    samples,
                    sensor: node.sensorName || null,
                    unit: node.unit || null,
                    model: result.model,
                    durationMs: result.durationMs
                };
                if (node.outputMode === "json") {
                    // Always expose the parsed object + raw text so a
                    // downstream node can recover either if needed.
                    out.json = json;
                    out.rawResponse = result.text;
                }
                if (originalMsg) {
                    if (typeof originalMsg.topic === "string") out.topic = originalMsg.topic;
                    if (typeof originalMsg._msgid === "string") out._msgid = originalMsg._msgid;
                    if (node.passthroughOriginal && Object.prototype.hasOwnProperty.call(originalMsg, "payload")) {
                        out.input = originalMsg.payload;
                    }
                }
                send(out);
                setStatus({ kind: "ok", usage: result.usage, durationMs: result.durationMs });
            } catch (err) {
                if (closed) return;
                const cls = (err && err.kind) || "error";
                setStatus({ kind: "error", text: cls });
                // Surface to a catch-node. Use the (msg, done) form so the
                // catch-node can correlate to the upstream message.
                node.error("llm-analyzer: " + (err && err.message ? err.message : String(err)), originalMsg || {});
            } finally {
                inFlight = false;
                // Drain any trigger that arrived during the in-flight call.
                // Defer through setImmediate so we don't grow the call stack
                // on a hot loop, and so the operator's catch-node sees the
                // current call's error before the next one runs.
                if (!closed && pendingFire) {
                    const kind = pendingFire;
                    pendingFire = null;
                    if (buffer.length > 0) {
                        const synthMsg = kind === "manual" ? { flush: true } : null;
                        setImmediate(() => {
                            if (!closed) fire(synthMsg, (m) => node.send(m));
                        });
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Trigger wiring
        // ------------------------------------------------------------------
        node.on("input", function (msg, send, done) {
            try {
                const added = ingest(msg.payload);

                if (node.triggerMode === "batch") {
                    setStatus({ kind: "buffering", target: node.batchSize });
                    if (buffer.length >= node.batchSize) {
                        // Capture the *triggering* msg and fire async.
                        fire(msg, send);
                    }
                } else if (node.triggerMode === "manual") {
                    setStatus({ kind: "buffering" });
                    if (msg && msg.flush === true) {
                        fire(msg, send);
                    }
                } else if (node.triggerMode === "interval") {
                    setStatus({ kind: "buffering" });
                    // The interval timer drives firing; input only fills the buffer.
                }

                if (typeof done === "function") done();
                // added is unused but useful for debugging via node.warn().
                void added;
            } catch (err) {
                if (typeof done === "function") done(err);
                else node.error(err, msg);
            }
        });

        if (node.triggerMode === "interval") {
            intervalHandle = setInterval(() => {
                if (buffer.length === 0) return;
                fire(null, (m) => node.send(m));
            }, node.intervalMs);
            // Don't let a passive interval node hold the process open on shutdown.
            if (intervalHandle.unref) intervalHandle.unref();
        }

        node.on("close", function (removed, doneClose) {
            closed = true;
            if (intervalHandle) {
                clearInterval(intervalHandle);
                intervalHandle = null;
            }
            // Persist final state before tearing down so a redeploy keeps
            // the buffer and counters. Failures here are non-fatal — we'd
            // rather close cleanly than block on disk I/O.
            if (persistence && typeof persistence.saveNow === "function") {
                try {
                    persistence.saveNow();
                } catch (_) {
                    /* ignore */
                }
            }
            buffer.length = 0;
            if (typeof doneClose === "function") doneClose();
        });
    }

    RED.nodes.registerType("llm-analyzer", LlmAnalyzerNode, {
        credentials: {
            apiKey: { type: "password" }
        }
    });
};

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------
function toFinite(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function clampInt(raw, min, max, fallback) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

function stringOr(raw, fallback) {
    if (typeof raw === "string" && raw.trim().length > 0) return raw;
    return fallback;
}

function computeStatsBlock(values) {
    if (!values || values.length === 0) return { count: 0 };
    const mean = stats.calculateMean(values);
    const stdDev = stats.calculateStdDev(values, mean);
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return {
        count: values.length,
        mean,
        stdDev,
        min,
        max,
        range: max - min
    };
}

function formatTokenCount(n) {
    if (!Number.isFinite(n)) return "0";
    if (n < 10000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return (n / 1000000).toFixed(2).replace(/\.?0+$/, "") + "M";
}

function computePerColumnStats(records, columns) {
    const out = {};
    for (const col of columns) {
        const vs = [];
        for (const r of records) {
            const v = r && r[col];
            if (Number.isFinite(v)) vs.push(v);
        }
        out[col] = computeStatsBlock(vs);
    }
    return out;
}
