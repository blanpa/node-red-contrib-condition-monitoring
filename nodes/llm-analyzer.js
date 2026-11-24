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
const { clampInt, stringOr, isIsoDateLike } = require("./utils/config-validator");

// Retry backoff for retryable provider failures (timeout / network / 429 / 5xx):
// base * 2^(failures-1), capped. A server-sent Retry-After wins when longer.
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 5 * 60 * 1000;
// How often a dirty buffer is flushed to the context store (persistState).
const PERSIST_INTERVAL_MS = 30000;
// Most buffered samples written per persist. The context store rewrites the
// whole blob each time; 100k numbers is ~1 MB, which is as much as a 30 s
// cadence should cost. Larger buffers keep their newest samples.
const MAX_PERSISTED_SAMPLES = 100000;
// Default model for the Anthropic provider. Undated id: Anthropic serves the
// current snapshot behind it, so a new node never starts on a retired one.
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

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
        node.model = (config.model || DEFAULT_ANTHROPIC_MODEL).trim();
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

        // Per-message endpoint override (msg.apiUrl) is OFF unless explicitly
        // enabled: the adapters attach the API key to whatever URL they are
        // given, so an unguarded override lets any upstream message exfiltrate
        // the credential. Even when enabled it is pinned to the origin of the
        // configured (or provider-default) endpoint.
        node.allowMsgApiUrl = config.allowMsgApiUrl === true || config.allowMsgApiUrl === "true";
        // Per-message prompt / system prompt / model overrides are OFF unless
        // explicitly enabled, for the same reason: any upstream payload that
        // forwards its fields (MQTT JSON, http-in body) could otherwise swap
        // the operator's system prompt or pick a pricier model. A missing key
        // (nodes saved before 0.4.1) means off — deliberately, as the old
        // default was the unsafe one.
        node.allowMsgOverrides = config.allowMsgOverrides === true || config.allowMsgOverrides === "true";

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

        // API key. Credentials are the supported path: Node-RED keeps them out of
        // the flow file and out of every flow export. `config.apiKey` is an inline
        // backstop for dev/test that still works, but a key stored there travels
        // with the flow — so say so loudly, the same way training-data-collector
        // does for S3 credentials.
        const credKey =
            node.credentials && typeof node.credentials.apiKey === "string" ? node.credentials.apiKey.trim() : "";
        const inlineKey = (config.apiKey || "").trim();
        if (inlineKey && !credKey) {
            node.warn(
                "llm-analyzer: apiKey is set in the node config, which stores it in plain text in flows.json " +
                    "and in every flow export. Move it to the node's credential field."
            );
        }
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
        if (node.apiUrl) {
            const checked = providers.parseHttpUrl(node.apiUrl);
            if (!checked.ok) {
                node.status({ fill: "red", shape: "ring", text: "bad API URL" });
                node.error("llm-analyzer: apiUrl is invalid — " + checked.reason);
                return;
            }
        }
        // Origin every request must stay on. Null only for a provider with no
        // default endpoint and no configured URL, which was rejected above.
        const baseEndpoint = node.apiUrl || providerMeta.defaultUrl || null;

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
        // The batch taken out of the buffer for the current call. Still the
        // node's data until the provider has answered: a persistence snapshot
        // taken mid-call (redeploy) must include it, and a close mid-call puts
        // it back into the buffer.
        let inFlightSamples = null;
        // When a trigger arrives during an in-flight call we used to just
        // drop it. Now we record the *kind* of pending request so the
        // current call's finally-block can re-fire it. `null` = nothing
        // pending; "manual" = a flush msg arrived; "batch" / "interval" =
        // a buffer-driven trigger arrived. The msg that carried the trigger
        // is kept too, so its topic / overrides reach the re-fired call.
        let pendingFire = null;
        let pendingFireMsg = null;
        let intervalHandle = null;
        let closed = false;
        // Retry state: consecutive retryable failures, the earliest time the
        // next automatic call may start, the timer that makes it, and the
        // msg whose batch is being retried.
        let consecutiveFailures = 0;
        let retryNotBefore = 0;
        let retryTimer = null;
        let retryMsg = null;
        // Cancels the in-flight HTTP request when the node closes.
        let abortController = null;
        let msgApiUrlWarned = false;
        let msgOverridesWarned = false;

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
        // manual/interval flow doesn't lose its accumulated samples. The
        // manager's auto-save is the only writer: markDirty() tells it to
        // pull a fresh snapshot on its next tick.
        const persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "llmAnalyzerState_" + node.id,
            saveInterval: PERSIST_INTERVAL_MS,
            maxPersistedItems: Math.min(node.maxBufferSize, MAX_PERSISTED_SAMPLES),
            onStateLoaded: function (state) {
                if (Array.isArray(state.buffer)) {
                    // The load is asynchronous: samples may already have
                    // arrived. Restored (older) samples go in front of them.
                    const arrived = buffer.splice(0, buffer.length);
                    for (const v of state.buffer) buffer.push(v);
                    for (const v of arrived) buffer.push(v);
                    applyBufferCap();
                    droppedSinceLastFire = 0;
                }
                if (Array.isArray(state.detectedColumns) && state.detectedColumns.length > 0) {
                    detectedColumns = state.detectedColumns.slice();
                }
                if (Number.isFinite(state.totalInputTokens)) totalInputTokens = state.totalInputTokens;
                if (Number.isFinite(state.totalOutputTokens)) totalOutputTokens = state.totalOutputTokens;
                if (Number.isFinite(state.callCount)) callCount = state.callCount;
            },
            getStateToSave: function () {
                // A batch that is out with the provider is still unconsumed
                // data: a snapshot taken during the call (redeploy) keeps it
                // in front of whatever arrived since.
                const pending = inFlightSamples ? inFlightSamples.concat(buffer) : buffer.slice();
                return {
                    buffer: pending,
                    detectedColumns: detectedColumns ? detectedColumns.slice() : null,
                    totalInputTokens,
                    totalOutputTokens,
                    callCount
                };
            }
        });

        function markDirty() {
            if (persistence) persistence.markDirty();
        }

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
                case "backoff":
                    node.status({
                        fill: "yellow",
                        shape: "ring",
                        text: (state.text || "error") + " · retry in " + Math.ceil(state.delayMs / 1000) + "s"
                    });
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
            if (added > 0) markDirty();
            return added;
        }

        // Puts a drained batch back in front of the buffer (still subject to
        // maxBufferSize): after a transient failure, or when the node closed
        // while the call was out so the persisted snapshot keeps the batch.
        function restoreSamples(samples) {
            const arrived = buffer.splice(0, buffer.length);
            for (const v of samples) buffer.push(v);
            for (const v of arrived) buffer.push(v);
            applyBufferCap();
            inFlightSamples = null;
            markDirty();
        }

        // Per-message prompt / model overrides, honoured only with the opt-in.
        // Without it a present override is ignored and reported once.
        function msgOverride(originalMsg, field) {
            if (!originalMsg || typeof originalMsg[field] !== "string" || originalMsg[field].length === 0) {
                return null;
            }
            if (node.allowMsgOverrides) return originalMsg[field];
            if (!msgOverridesWarned) {
                msgOverridesWarned = true;
                node.warn(
                    "llm-analyzer: msg." +
                        field +
                        " ignored — per-message prompt/model overrides are disabled. " +
                        "Enable 'Allow msg.prompt / msg.systemPrompt / msg.model overrides' in the node to use them."
                );
            }
            return null;
        }

        // Resolve the endpoint for one call. msg.apiUrl is honoured only when
        // the operator opted in, and only on the configured endpoint's origin.
        function resolveApiUrl(originalMsg) {
            const requested =
                originalMsg && typeof originalMsg.apiUrl === "string" && originalMsg.apiUrl.length > 0
                    ? originalMsg.apiUrl
                    : null;
            if (!requested) return node.apiUrl;
            if (!node.allowMsgApiUrl) {
                if (!msgApiUrlWarned) {
                    msgApiUrlWarned = true;
                    node.warn(
                        "llm-analyzer: msg.apiUrl ignored — per-message endpoint override is disabled. " +
                            "Enable 'Allow msg.apiUrl override' in the node to use it."
                    );
                }
                return node.apiUrl;
            }
            if (!providers.isSameOrigin(requested, baseEndpoint)) {
                throw new providers.LlmHttpError(
                    "msg.apiUrl rejected: it must be an http(s) URL on the same origin as the configured endpoint",
                    { kind: "config" }
                );
            }
            return requested;
        }

        function clearRetryTimer() {
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
        }

        // After a retryable failure: wait, then try the (restored) batch again
        // with the msg that triggered it, so its topic and overrides carry over.
        // Manual mode never retries on its own — the operator flushes again.
        function scheduleRetry(err, originalMsg) {
            consecutiveFailures += 1;
            let delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, consecutiveFailures - 1));
            if (err && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > delayMs) {
                delayMs = Math.min(RETRY_MAX_MS, err.retryAfterMs);
            }
            retryNotBefore = Date.now() + delayMs;
            clearRetryTimer();
            if (node.triggerMode !== "manual") {
                retryMsg = originalMsg || null;
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    const msg = retryMsg;
                    retryMsg = null;
                    if (!closed && buffer.length > 0) fire(msg, (m) => node.send(m), { isRetry: true });
                }, delayMs);
                if (retryTimer.unref) retryTimer.unref();
            }
            return delayMs;
        }

        // ------------------------------------------------------------------
        // The fire path: build prompt → call provider → emit msg
        // ------------------------------------------------------------------
        async function fire(originalMsg, send, opts) {
            const isManual = !!(originalMsg && originalMsg.flush === true);
            // During a backoff window only an explicit flush or the retry timer
            // itself may call the provider; passive triggers just keep buffering.
            if (!inFlight && !isManual && !(opts && opts.isRetry) && Date.now() < retryNotBefore) {
                return;
            }
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
                if (pendingFire !== "manual") {
                    pendingFire = kind;
                    pendingFireMsg = originalMsg || null;
                }
                return;
            }
            if (buffer.length === 0) {
                node.warn("llm-analyzer: trigger fired with empty buffer, skipping");
                return;
            }

            inFlight = true;
            // Set once the batch has been taken out of the buffer, so a
            // retryable failure can put it back.
            let samples = null;
            // The try MUST start before prompt building: an exception anywhere
            // past this point would otherwise leave inFlight stuck at true and
            // reject the (un-awaited) fire() promise.
            try {
                // Resolve (and possibly reject) the endpoint BEFORE draining the
                // buffer, so a refused msg.apiUrl does not cost the batch.
                const overrideApiUrl = resolveApiUrl(originalMsg);

                samples = buffer.slice();
                buffer.length = 0;
                inFlightSamples = samples;
                droppedSinceLastFire = 0;
                markDirty();
                clearRetryTimer();
                setStatus({ kind: "calling" });
                const promptSamples = samples;

                // Build the prompt variables. Both modes fill {sensor}, {unit},
                // {count}; scalar mode adds {samples}+{stats}, record mode adds
                // {records}+{columns}+{stats} (per-column).
                let vars;
                if (node.inputMode === "record") {
                    const cols = detectedColumns || [];
                    const colStats = computePerColumnStats(promptSamples, cols);
                    vars = {
                        sensor: node.sensorName || "(unnamed)",
                        unit: node.unit || "",
                        count: promptSamples.length,
                        columns: cols.map(providers.sanitizeColumnName).join(", "),
                        records: providers.formatRecordsTable(promptSamples, cols, node.maxSamplesInPrompt),
                        stats: providers.formatPerColumnStats(colStats),
                        // {samples} kept available so a custom prompt template
                        // written for scalar mode still substitutes meaningfully.
                        samples: providers.formatRecordsTable(promptSamples, cols, node.maxSamplesInPrompt)
                    };
                } else {
                    const stat = computeStatsBlock(promptSamples);
                    vars = {
                        sensor: node.sensorName || "(unnamed)",
                        unit: node.unit || "(unitless)",
                        count: promptSamples.length,
                        samples: providers.formatSamplesList(promptSamples, node.maxSamplesInPrompt),
                        stats: providers.formatStatsLine(stat),
                        // {records}/{columns} empty in scalar mode so a record-
                        // mode template won't blow up if accidentally used.
                        records: providers.formatSamplesList(promptSamples, node.maxSamplesInPrompt),
                        columns: ""
                    };
                }

                const overrideUserPrompt = msgOverride(originalMsg, "prompt") || node.userPromptTemplate;
                let overrideSystemPrompt = msgOverride(originalMsg, "systemPrompt") || node.systemPrompt;
                // JSON-mode: append the schema instruction to the system prompt.
                // We do NOT use provider-native JSON modes (response_format etc.)
                // — the prompt-side approach works across all five providers.
                if (node.outputMode === "json") {
                    overrideSystemPrompt =
                        (overrideSystemPrompt || "") + providers.buildJsonInstruction(node.outputSchema);
                }
                const overrideModel = msgOverride(originalMsg, "model") || node.model;

                const result = await node.providerCall({
                    apiKey: node.apiKey,
                    model: overrideModel,
                    systemPrompt: overrideSystemPrompt,
                    userPrompt: providers.fillTemplate(overrideUserPrompt, vars),
                    maxTokens: node.maxOutputTokens,
                    timeoutMs: node.timeoutMs,
                    apiUrl: overrideApiUrl,
                    signal: (abortController = new AbortController()).signal
                });

                if (closed) {
                    // The answer arrived after the node went away: nobody can
                    // use it, and the batch goes back so the shutdown snapshot
                    // (or a later one) still has it.
                    restoreSamples(samples);
                    return;
                }

                // The call succeeded as far as the provider is concerned: the
                // batch is consumed and the tokens are spent, whatever happens
                // to the response below. Count them BEFORE parsing so a JSON
                // failure still shows up in the lifetime totals.
                samples = null;
                inFlightSamples = null;
                consecutiveFailures = 0;
                retryNotBefore = 0;
                const usage = result.usage || {};
                totalInputTokens += usage.inputTokens || 0;
                totalOutputTokens += usage.outputTokens || 0;
                callCount += 1;
                markDirty();
                const truncated = result.truncated === true;
                const truncationHint = truncated
                    ? " (response was cut off at maxOutputTokens=" + node.maxOutputTokens + " — raise it)"
                    : "";
                if (typeof result.text !== "string" || result.text.length === 0) {
                    node.warn(
                        "llm-analyzer: provider returned an empty response" +
                            (result.finishReason ? " (finish reason: " + result.finishReason + ")" : "")
                    );
                }

                // Build the payload according to output mode. JSON-parse
                // failures are an explicit error path so a downstream
                // catch-node can react — never silently downgrade to text.
                let payload = result.text;
                let json = null;
                if (node.outputMode === "json") {
                    const parsed = providers.extractJson(result.text);
                    if (!parsed.ok) {
                        setStatus({ kind: "error", text: truncated ? "json truncated" : "json parse" });
                        const errMsg = Object.assign({}, originalMsg || {}, {
                            rawResponse: result.text,
                            usage: result.usage,
                            model: result.model,
                            finishReason: result.finishReason || null
                        });
                        node.error(
                            "llm-analyzer: " + parsed.reason + truncationHint + " — see msg.rawResponse",
                            errMsg
                        );
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

                const out = {
                    payload,
                    usage: result.usage,
                    totalUsage: {
                        inputTokens: totalInputTokens,
                        outputTokens: totalOutputTokens,
                        callCount
                    },
                    samples: promptSamples,
                    sensor: node.sensorName || null,
                    unit: node.unit || null,
                    model: result.model,
                    durationMs: result.durationMs
                };
                if (result.finishReason) out.finishReason = result.finishReason;
                if (truncated) out.truncated = true;
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
                if (closed) {
                    // Aborted by close (or failed while closing): the batch
                    // was never answered, keep it for the next instance.
                    if (samples) restoreSamples(samples);
                    return;
                }
                const cls = (err && err.kind) || "error";
                let suffix = "";
                if (samples && providers.isRetryableError(err)) {
                    // Transient failure: the batch goes back to the FRONT of
                    // the buffer (still subject to maxBufferSize) and the next
                    // attempt waits out a backoff instead of hammering a
                    // provider that is already rate-limiting or down.
                    restoreSamples(samples);
                    const delayMs = scheduleRetry(err, originalMsg);
                    setStatus({ kind: "backoff", text: cls, delayMs });
                    suffix =
                        " — batch kept (" +
                        samples.length +
                        " samples), " +
                        (node.triggerMode === "manual" ? "flush again to retry" : "retrying") +
                        " in " +
                        Math.ceil(delayMs / 1000) +
                        "s";
                } else {
                    setStatus({ kind: "error", text: cls });
                }
                // Surface to a catch-node. Use the (msg, done) form so the
                // catch-node can correlate to the upstream message.
                node.error(
                    "llm-analyzer: " + (err && err.message ? err.message : String(err)) + suffix,
                    originalMsg || {}
                );
            } finally {
                inFlight = false;
                // Consumed, restored, or deliberately dropped by now — never
                // still "in flight".
                inFlightSamples = null;
                abortController = null;
                // Drain any trigger that arrived during the in-flight call.
                // Defer through setImmediate so we don't grow the call stack
                // on a hot loop, and so the operator's catch-node sees the
                // current call's error before the next one runs.
                if (!closed && pendingFire) {
                    const kind = pendingFire;
                    const queuedMsg = pendingFireMsg;
                    pendingFire = null;
                    pendingFireMsg = null;
                    if (buffer.length > 0) {
                        const refireMsg =
                            kind === "manual" ? Object.assign({}, queuedMsg || {}, { flush: true }) : queuedMsg;
                        setImmediate(() => {
                            if (!closed) fire(refireMsg, (m) => node.send(m));
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
                    if (!inFlight && Date.now() >= retryNotBefore) {
                        setStatus({ kind: "buffering", target: node.batchSize });
                    }
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
            clearRetryTimer();
            retryMsg = null;
            pendingFire = null;
            pendingFireMsg = null;
            // Don't leave a request running (for up to timeoutMs) after the
            // node is gone; its result would be discarded anyway.
            if (abortController) {
                try {
                    abortController.abort();
                } catch (_) {
                    /* ignore */
                }
            }
            const finish = function () {
                buffer.length = 0;
                if (typeof doneClose === "function") doneClose();
            };
            // Persist final state before tearing down so a redeploy keeps
            // the buffer and counters. persistence.close() snapshots the
            // state synchronously, stops the manager's auto-save timer and
            // WAITS for the write — without that wait the next instance loads
            // before this one has saved. The snapshot includes a batch that
            // is still out with the provider (getStateToSave), so the abort
            // above cannot cost it. Failures are non-fatal: we'd rather
            // close cleanly than block on disk I/O.
            if (persistence && typeof persistence.close === "function") {
                Promise.resolve()
                    .then(() => persistence.close())
                    .catch(() => {})
                    .then(finish);
            } else {
                finish();
            }
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
        // Lenient on purpose ("65 °C" → 65), but a date is not a reading:
        // parseFloat("2024-05-01") would otherwise yield 2024.
        if (isIsoDateLike(v)) return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
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
