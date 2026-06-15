"use strict";

const helper = require("node-red-node-test-helper");
const llmAnalyzerNode = require("../nodes/llm-analyzer.js");
const {
    fillTemplate,
    formatStatsLine,
    formatSamplesList,
    formatRecordsTable,
    formatPerColumnStats,
    parseCsvList,
    detectNumericColumns,
    extractJson,
    getNestedField,
    buildJsonInstruction,
    callAnthropic,
    callOpenAI,
    callGoogle,
    callOllama,
    callOpenAICompatible,
    getProvider,
    PROVIDERS,
    LlmHttpError
} = require("../nodes/utils/llm-providers.js");

helper.init(require.resolve("node-red"));

// ---------------------------------------------------------------------------
// utils/llm-providers — pure helpers
// ---------------------------------------------------------------------------
describe("llm-providers helpers", () => {
    describe("fillTemplate", () => {
        it("substitutes known placeholders", () => {
            expect(fillTemplate("Sensor {sensor} ({unit}) n={count}", { sensor: "p1", unit: "°C", count: 5 })).toBe(
                "Sensor p1 (°C) n=5"
            );
        });
        it("leaves unknown placeholders intact", () => {
            expect(fillTemplate("{a} and {b}", { a: "x" })).toBe("x and {b}");
        });
        it("returns empty string for non-string templates", () => {
            expect(fillTemplate(null, {})).toBe("");
            expect(fillTemplate(undefined, {})).toBe("");
        });
    });

    describe("formatStatsLine", () => {
        it("formats the typical block", () => {
            expect(formatStatsLine({ count: 6, mean: 3.5, stdDev: 1.7078, min: 1, max: 6, range: 5 })).toBe(
                "n=6 mean=3.5 stdDev=1.708 min=1 max=6 range=5"
            );
        });
        it("returns empty string on null", () => {
            expect(formatStatsLine(null)).toBe("");
        });
    });

    describe("formatSamplesList", () => {
        it("returns (empty) marker for empty arrays", () => {
            expect(formatSamplesList([])).toBe("(empty)");
        });
        it("caps at the requested max length, oldest-first", () => {
            const arr = [];
            for (let i = 1; i <= 150; i++) arr.push(i);
            const out = formatSamplesList(arr, 100);
            expect(out.startsWith("(showing last 100 of 150)")).toBe(true);
            // The last value listed must be 150 (newest); the first cap-window value is 51.
            const csv = out.split("\n")[1];
            const parts = csv.split(", ").map((n) => parseInt(n, 10));
            expect(parts[0]).toBe(51);
            expect(parts[parts.length - 1]).toBe(150);
        });
    });

    describe("parseCsvList", () => {
        it("splits, trims, and drops empty entries", () => {
            expect(parseCsvList("temp, pressure ,vibration ,, ")).toEqual(["temp", "pressure", "vibration"]);
        });
        it("returns [] for non-strings", () => {
            expect(parseCsvList(null)).toEqual([]);
            expect(parseCsvList(undefined)).toEqual([]);
        });
    });

    describe("detectNumericColumns", () => {
        it("picks finite numeric and numeric-string fields", () => {
            expect(detectNumericColumns({ temp: 65.2, pressure: "4.5", note: "ok", flag: true }).sort()).toEqual([
                "pressure",
                "temp"
            ]);
        });
        it("skips common timestamp/identifier fields by default", () => {
            const cols = detectNumericColumns({
                timestamp: 1700000000,
                time: 12345,
                id: 7,
                temp: 65,
                pressure: 4.5
            }).sort();
            expect(cols).toEqual(["pressure", "temp"]);
        });
        it("is case-insensitive about the skip list", () => {
            expect(detectNumericColumns({ Timestamp: 1, TS: 2, temp: 65 })).toEqual(["temp"]);
        });
        it("can be told to keep timestamp fields when an operator wants them", () => {
            const cols = detectNumericColumns(
                { timestamp: 1700000000, temp: 65 },
                { skipDefaultTimestamps: false }
            ).sort();
            expect(cols).toEqual(["temp", "timestamp"]);
        });
        it("returns [] for non-objects", () => {
            expect(detectNumericColumns(null)).toEqual([]);
            expect(detectNumericColumns([1, 2, 3])).toEqual([]);
        });
    });

    describe("formatRecordsTable", () => {
        it("renders one line per record with col=val pairs", () => {
            const out = formatRecordsTable(
                [
                    { temp: 65.2, pressure: 4.5 },
                    { temp: 65.4, pressure: 4.6 }
                ],
                ["temp", "pressure"]
            );
            expect(out).toBe("t=1 temp=65.2 pressure=4.5\nt=2 temp=65.4 pressure=4.6");
        });
        it("renders n/a for missing/non-numeric cells", () => {
            const out = formatRecordsTable([{ temp: 65, pressure: null }], ["temp", "pressure"]);
            expect(out).toBe("t=1 temp=65 pressure=n/a");
        });
        it("returns (empty) marker for empty input", () => {
            expect(formatRecordsTable([], ["a"])).toBe("(empty)");
            expect(formatRecordsTable([{ a: 1 }], [])).toBe("(no columns)");
        });
        it("caps at maxRows and tracks the original index", () => {
            const records = [];
            for (let i = 1; i <= 120; i++) records.push({ x: i });
            const out = formatRecordsTable(records, ["x"], 50);
            expect(out.startsWith("(showing last 50 of 120)")).toBe(true);
            // First shown record must be the 71st (120 - 50 = 70 dropped, t=71 first).
            const lines = out.split("\n");
            expect(lines[1]).toBe("t=71 x=71");
            expect(lines[lines.length - 1]).toBe("t=120 x=120");
        });
    });

    describe("formatPerColumnStats", () => {
        it("emits one aligned line per column", () => {
            const out = formatPerColumnStats({
                temp: { count: 30, mean: 68.6, stdDev: 3.6, min: 64.2, max: 75.9 },
                pressure: { count: 30, mean: 4.5, stdDev: 0, min: 4.5, max: 4.5 }
            });
            const lines = out.split("\n");
            expect(lines).toHaveLength(2);
            expect(lines[0]).toMatch(/temp:.*n=30 mean=68\.6 stdDev=3\.6 min=64\.2 max=75\.9/);
            expect(lines[1]).toMatch(/pressure:.*n=30 mean=4\.5 stdDev=0 min=4\.5 max=4\.5/);
        });
        it("returns (no columns) for empty input", () => {
            expect(formatPerColumnStats({})).toBe("(no columns)");
        });
    });

    describe("extractJson", () => {
        it("parses a clean JSON response directly", () => {
            const r = extractJson('{"score": 0.85}');
            expect(r.ok).toBe(true);
            expect(r.value).toEqual({ score: 0.85 });
        });

        it("parses a JSON response wrapped in markdown fences", () => {
            const r = extractJson('Here is the result:\n```json\n{"score": 0.85, "ok": true}\n```\n');
            expect(r.ok).toBe(true);
            expect(r.value).toEqual({ score: 0.85, ok: true });
        });

        it("parses a JSON response wrapped in plain prose", () => {
            const r = extractJson('Sure! Here you go: {"score": 0.85, "tags": ["a","b"]}. Hope that helps.');
            expect(r.ok).toBe(true);
            expect(r.value).toEqual({ score: 0.85, tags: ["a", "b"] });
        });

        it("respects strings that contain braces", () => {
            const r = extractJson('Reply: {"summary": "all good {within tolerance}", "score": 1}');
            expect(r.ok).toBe(true);
            expect(r.value).toEqual({ summary: "all good {within tolerance}", score: 1 });
        });

        it("parses a JSON array response", () => {
            const r = extractJson("Here's the list: [1, 2, 3]");
            expect(r.ok).toBe(true);
            expect(r.value).toEqual([1, 2, 3]);
        });

        it("returns ok=false with reason on truly broken input", () => {
            expect(extractJson("just a sentence with no braces.").ok).toBe(false);
            expect(extractJson("").ok).toBe(false);
            expect(extractJson(null).ok).toBe(false);
        });
    });

    describe("getNestedField", () => {
        it("returns the whole object for empty path", () => {
            const obj = { a: 1 };
            expect(getNestedField(obj, "")).toBe(obj);
        });
        it("walks dotted paths", () => {
            expect(getNestedField({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
        });
        it("supports numeric indices for arrays", () => {
            expect(getNestedField({ tags: ["x", "y", "z"] }, "tags.1")).toBe("y");
        });
        it("returns undefined when a segment misses", () => {
            expect(getNestedField({ a: 1 }, "a.b")).toBeUndefined();
            expect(getNestedField({ a: 1 }, "missing")).toBeUndefined();
        });
    });

    describe("buildJsonInstruction", () => {
        it("references the example schema verbatim when given", () => {
            const out = buildJsonInstruction('{"score": 0.5}');
            expect(out).toMatch(/single JSON object/);
            expect(out).toMatch(/Example structure:/);
            expect(out).toMatch(/"score": 0\.5/);
        });
        it("falls back to a generic instruction when schema is empty", () => {
            const out = buildJsonInstruction("");
            expect(out).toMatch(/single valid JSON object/);
            expect(out).not.toMatch(/Example structure:/);
        });
    });
});

// ---------------------------------------------------------------------------
// providers.callAnthropic — wire shape + error paths
// ---------------------------------------------------------------------------
describe("callAnthropic (with mocked fetch)", () => {
    function fakeResponse(body, status = 200) {
        return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body))
        });
    }

    it("posts to the default URL with the right headers and body", async () => {
        const calls = [];
        const fetchFn = (url, init) => {
            calls.push({ url, init });
            return fakeResponse({
                content: [{ type: "text", text: "All quiet." }],
                model: "claude-haiku-4-5-20251001",
                usage: { input_tokens: 12, output_tokens: 4 }
            });
        };
        const out = await callAnthropic({
            apiKey: "sk-ant-test",
            model: "claude-haiku-4-5-20251001",
            systemPrompt: "you are an analyst",
            userPrompt: "x=1 x=2",
            fetchFn
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(/api\.anthropic\.com/);
        expect(calls[0].init.method).toBe("POST");
        expect(calls[0].init.headers["x-api-key"]).toBe("sk-ant-test");
        expect(calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
        const sent = JSON.parse(calls[0].init.body);
        expect(sent.model).toBe("claude-haiku-4-5-20251001");
        expect(sent.max_tokens).toBe(1024);
        expect(sent.system).toBe("you are an analyst");
        expect(sent.messages).toEqual([{ role: "user", content: "x=1 x=2" }]);
        expect(out.text).toBe("All quiet.");
        expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    });

    it("respects an apiUrl override", async () => {
        let seenUrl = null;
        const fetchFn = (url) => {
            seenUrl = url;
            return fakeResponse({ content: [{ type: "text", text: "ok" }], usage: {} });
        };
        await callAnthropic({
            apiKey: "k",
            model: "m",
            userPrompt: "u",
            apiUrl: "http://127.0.0.1:9999/mock",
            fetchFn
        });
        expect(seenUrl).toBe("http://127.0.0.1:9999/mock");
    });

    it("surfaces 401 as an auth-class LlmHttpError", async () => {
        const fetchFn = () =>
            fakeResponse({ type: "error", error: { type: "authentication_error", message: "invalid key" } }, 401);
        await expect(callAnthropic({ apiKey: "k", model: "m", userPrompt: "u", fetchFn })).rejects.toMatchObject({
            name: "LlmHttpError",
            kind: "auth",
            status: 401
        });
    });

    it("surfaces 429 as a rate-limit-class error", async () => {
        const fetchFn = () => fakeResponse({ error: { message: "slow down" } }, 429);
        await expect(callAnthropic({ apiKey: "k", model: "m", userPrompt: "u", fetchFn })).rejects.toMatchObject({
            kind: "rate-limit",
            status: 429
        });
    });

    it("rejects responses missing content[]", async () => {
        const fetchFn = () => fakeResponse({ usage: {} });
        await expect(callAnthropic({ apiKey: "k", model: "m", userPrompt: "u", fetchFn })).rejects.toMatchObject({
            kind: "shape"
        });
    });

    it("rejects when apiKey is empty", async () => {
        await expect(callAnthropic({ apiKey: "", model: "m", userPrompt: "u", fetchFn: () => null })).rejects.toThrow(
            /apiKey/
        );
    });
});

// ---------------------------------------------------------------------------
// Test helper shared by the OpenAI / Gemini / Ollama / compatible suites.
// ---------------------------------------------------------------------------
function fakeRes(body, status = 200) {
    return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body))
    });
}

// ---------------------------------------------------------------------------
// callOpenAI — Chat Completions shape
// ---------------------------------------------------------------------------
describe("callOpenAI", () => {
    it("posts to the default URL with Authorization Bearer + correct body shape", async () => {
        const calls = [];
        const fetchFn = (url, init) => {
            calls.push({ url, init });
            return fakeRes({
                choices: [{ message: { role: "assistant", content: "OK" } }],
                model: "gpt-4o-mini",
                usage: { prompt_tokens: 50, completion_tokens: 4 }
            });
        };
        const out = await callOpenAI({
            apiKey: "sk-test",
            model: "gpt-4o-mini",
            systemPrompt: "be brief",
            userPrompt: "ping",
            fetchFn
        });
        expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
        expect(calls[0].init.headers["authorization"]).toBe("Bearer sk-test");
        const sent = JSON.parse(calls[0].init.body);
        expect(sent.model).toBe("gpt-4o-mini");
        expect(sent.max_tokens).toBe(1024);
        expect(sent.messages).toEqual([
            { role: "system", content: "be brief" },
            { role: "user", content: "ping" }
        ]);
        expect(out.text).toBe("OK");
        expect(out.usage).toEqual({ inputTokens: 50, outputTokens: 4 });
    });

    it("surfaces 401 as auth, 429 as rate-limit", async () => {
        const fetch401 = () => fakeRes({ error: { message: "bad key" } }, 401);
        await expect(callOpenAI({ apiKey: "k", model: "m", userPrompt: "u", fetchFn: fetch401 })).rejects.toMatchObject(
            { kind: "auth", status: 401 }
        );

        const fetch429 = () => fakeRes({ error: { message: "slow" } }, 429);
        await expect(callOpenAI({ apiKey: "k", model: "m", userPrompt: "u", fetchFn: fetch429 })).rejects.toMatchObject(
            { kind: "rate-limit", status: 429 }
        );
    });

    it("rejects responses missing choices[]", async () => {
        const fetchFn = () => fakeRes({ usage: {} });
        await expect(callOpenAI({ apiKey: "k", model: "m", userPrompt: "u", fetchFn })).rejects.toMatchObject({
            kind: "shape"
        });
    });
});

// ---------------------------------------------------------------------------
// callGoogle — Gemini generateContent
// ---------------------------------------------------------------------------
describe("callGoogle", () => {
    it("substitutes {model} into the URL and appends ?key=", async () => {
        const calls = [];
        const fetchFn = (url, init) => {
            calls.push({ url, init });
            return fakeRes({
                candidates: [{ content: { parts: [{ text: "All good." }] } }],
                usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 3 },
                modelVersion: "gemini-2.0-flash"
            });
        };
        const out = await callGoogle({
            apiKey: "AIzaTest",
            model: "gemini-2.0-flash",
            systemPrompt: "system",
            userPrompt: "hello",
            fetchFn
        });
        expect(calls[0].url).toMatch(/\/v1beta\/models\/gemini-2\.0-flash:generateContent\?key=AIzaTest$/);
        const sent = JSON.parse(calls[0].init.body);
        expect(sent.systemInstruction).toEqual({ parts: [{ text: "system" }] });
        expect(sent.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
        expect(sent.generationConfig.maxOutputTokens).toBe(1024);
        expect(out.text).toBe("All good.");
        expect(out.usage).toEqual({ inputTokens: 30, outputTokens: 3 });
    });

    it("surfaces a blocked-prompt response as a 'blocked' error class", async () => {
        const fetchFn = () =>
            fakeRes({
                candidates: [],
                promptFeedback: { blockReason: "SAFETY" }
            });
        await expect(
            callGoogle({ apiKey: "k", model: "gemini-2.0-flash", userPrompt: "u", fetchFn })
        ).rejects.toMatchObject({ kind: "blocked" });
    });

    it("surfaces 401 as auth", async () => {
        const fetchFn = () => fakeRes({ error: { message: "bad key" } }, 401);
        await expect(
            callGoogle({ apiKey: "k", model: "gemini-2.0-flash", userPrompt: "u", fetchFn })
        ).rejects.toMatchObject({ kind: "auth" });
    });
});

// ---------------------------------------------------------------------------
// callOllama — local /api/chat
// ---------------------------------------------------------------------------
describe("callOllama", () => {
    it("works without an API key and parses prompt_eval_count / eval_count", async () => {
        const calls = [];
        const fetchFn = (url, init) => {
            calls.push({ url, init });
            return fakeRes({
                model: "llama3.2",
                message: { role: "assistant", content: "hi from ollama" },
                prompt_eval_count: 17,
                eval_count: 8
            });
        };
        const out = await callOllama({
            // no apiKey — ollama must accept it
            model: "llama3.2",
            systemPrompt: "be brief",
            userPrompt: "hi",
            fetchFn
        });
        expect(calls[0].url).toBe("http://localhost:11434/api/chat");
        expect(calls[0].init.headers["authorization"]).toBeUndefined();
        const sent = JSON.parse(calls[0].init.body);
        expect(sent.stream).toBe(false);
        expect(sent.options.num_predict).toBe(1024);
        expect(out.text).toBe("hi from ollama");
        expect(out.usage).toEqual({ inputTokens: 17, outputTokens: 8 });
    });

    it("attaches Bearer header when apiKey is provided (hosted forwarder case)", async () => {
        let seenAuth = null;
        const fetchFn = (_, init) => {
            seenAuth = init.headers["authorization"];
            return fakeRes({ message: { content: "ok" } });
        };
        await callOllama({
            apiKey: "secret-token",
            model: "llama3.2",
            userPrompt: "hi",
            apiUrl: "https://hosted-ollama.example/api/chat",
            fetchFn
        });
        expect(seenAuth).toBe("Bearer secret-token");
    });

    it("rejects responses without message.content", async () => {
        const fetchFn = () => fakeRes({ done: true });
        await expect(callOllama({ model: "m", userPrompt: "u", fetchFn })).rejects.toMatchObject({ kind: "shape" });
    });
});

// ---------------------------------------------------------------------------
// callOpenAICompatible — apiUrl is mandatory; otherwise behaves like OpenAI
// ---------------------------------------------------------------------------
describe("callOpenAICompatible", () => {
    it("requires apiUrl (no default endpoint)", async () => {
        await expect(
            callOpenAICompatible({ apiKey: "k", model: "m", userPrompt: "u", fetchFn: () => null })
        ).rejects.toMatchObject({ kind: "config" });
    });

    it("hits the user-provided URL with the OpenAI body shape", async () => {
        let seenUrl = null;
        const fetchFn = (url) => {
            seenUrl = url;
            return fakeRes({
                choices: [{ message: { content: "via groq" } }],
                usage: { prompt_tokens: 10, completion_tokens: 2 }
            });
        };
        const out = await callOpenAICompatible({
            apiKey: "gsk_test",
            model: "llama-3.3-70b-versatile",
            userPrompt: "hi",
            apiUrl: "https://api.groq.com/openai/v1/chat/completions",
            fetchFn
        });
        expect(seenUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
        expect(out.text).toBe("via groq");
    });
});

// ---------------------------------------------------------------------------
// Provider registry / dispatcher
// ---------------------------------------------------------------------------
describe("provider registry", () => {
    it("lists the five expected providers", () => {
        expect(Object.keys(PROVIDERS).sort()).toEqual(["anthropic", "google", "ollama", "openai", "openai-compatible"]);
    });

    it("getProvider returns the right adapter", () => {
        expect(getProvider("anthropic").call).toBe(callAnthropic);
        expect(getProvider("openai").call).toBe(callOpenAI);
        expect(getProvider("google").call).toBe(callGoogle);
        expect(getProvider("ollama").call).toBe(callOllama);
        expect(getProvider("openai-compatible").call).toBe(callOpenAICompatible);
    });

    it("ollama is the only provider that does not require an API key", () => {
        const noKeyProviders = Object.entries(PROVIDERS)
            .filter(([, m]) => m.needsApiKey === false)
            .map(([k]) => k);
        expect(noKeyProviders).toEqual(["ollama"]);
    });

    it("openai-compatible is the only provider that requires apiUrl", () => {
        const needsUrl = Object.entries(PROVIDERS)
            .filter(([, m]) => m.needsApiUrl === true)
            .map(([k]) => k);
        expect(needsUrl).toEqual(["openai-compatible"]);
    });

    it("getProvider throws for an unknown name", () => {
        expect(() => getProvider("nope")).toThrow(/unknown provider/);
    });
});

// ---------------------------------------------------------------------------
// llm-analyzer node: trigger modes, validation, output shape
// ---------------------------------------------------------------------------
describe("llm-analyzer node", () => {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    function mockProviderOk(textOut = "fine") {
        const calls = [];
        const fn = async (args) => {
            calls.push(args);
            return {
                text: textOut,
                usage: { inputTokens: 10, outputTokens: 5 },
                model: args.model,
                durationMs: 42,
                raw: {}
            };
        };
        fn.calls = calls;
        return fn;
    }

    function mockProviderErr(err) {
        return async () => {
            throw err;
        };
    }

    it("refuses to start without an API key", (done) => {
        const flow = [{ id: "n1", type: "llm-analyzer", name: "x", triggerMode: "batch", batchSize: 5 }];
        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toBeDefined();
            done();
        });
    });

    it("refuses an unknown provider name", (done) => {
        const flow = [
            { id: "n1", type: "llm-analyzer", name: "x", provider: "made-up", apiKey: "k", triggerMode: "batch" }
        ];
        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toBeDefined();
            done();
        });
    });

    it("ollama provider does NOT require an API key (loads cleanly without one)", (done) => {
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                provider: "ollama",
                model: "llama3.2",
                triggerMode: "manual",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        // Inject a no-op providerCall so we never actually hit the network.
        flow[0].providerCall = async () => ({
            text: "hi",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "llama3.2",
            durationMs: 1,
            raw: {}
        });
        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));
            n1.receive({ payload: 42, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].payload).toBe("hi");
                done();
            }, 50);
        });
    });

    it("openai-compatible refuses to start without apiUrl", (done) => {
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                provider: "openai-compatible",
                apiKey: "k",
                triggerMode: "manual"
                // intentionally no apiUrl
            }
        ];
        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            expect(n1).toBeDefined();
            done();
        });
    });

    it("batch mode fires exactly when buffer reaches batchSize", (done) => {
        const provider = mockProviderOk("response-1");
        // We pass providerCall via flow def; the node honours it for tests.
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "batch",
                batchSize: 3,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        // node-red-node-test-helper does not pass arbitrary extra config keys to
        // the constructor by default. Patch by extending the flow object so the
        // node constructor sees `providerCall`.
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: 1 });
            n1.receive({ payload: 2 });
            // not fired yet
            setTimeout(() => {
                expect(seen).toHaveLength(0);
                expect(provider.calls).toHaveLength(0);
                n1.receive({ payload: 3 });
                // fire is async — wait one tick for the await chain.
                setTimeout(() => {
                    expect(provider.calls).toHaveLength(1);
                    expect(seen).toHaveLength(1);
                    expect(seen[0].payload).toBe("response-1");
                    expect(seen[0].usage).toEqual({ inputTokens: 10, outputTokens: 5 });
                    expect(seen[0].samples).toEqual([1, 2, 3]);
                    expect(seen[0].durationMs).toBe(42);
                    done();
                }, 50);
            }, 30);
        });
    });

    it("manual mode fires only on msg.flush=true and uses the current buffer", (done) => {
        const provider = mockProviderOk("manual-response");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: 10 });
            n1.receive({ payload: 20 });
            n1.receive({ payload: 30 });
            // fill but do not flush
            setTimeout(() => {
                expect(seen).toHaveLength(0);
                n1.receive({ payload: 40, flush: true });
                setTimeout(() => {
                    expect(provider.calls).toHaveLength(1);
                    expect(seen[0].samples).toEqual([10, 20, 30, 40]);
                    expect(seen[0].payload).toBe("manual-response");
                    done();
                }, 50);
            }, 30);
        });
    });

    it("substitutes prompt placeholders and honours msg.prompt override", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                sensorName: "pump-3",
                unit: "bar",
                userPromptTemplate: "default for {sensor}",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            n1.receive({ payload: 1 });
            n1.receive({ payload: 2, flush: true });
            setTimeout(() => {
                expect(provider.calls).toHaveLength(1);
                // built-in default user prompt fired (no msg.prompt) → must include sensor name
                expect(provider.calls[0].userPrompt).toMatch(/pump-3/);

                // Now override via msg.prompt — placeholders are still substituted.
                n1.receive({ payload: 9, prompt: "Explain {sensor} batch ({count})", flush: true });
                setTimeout(() => {
                    expect(provider.calls).toHaveLength(2);
                    expect(provider.calls[1].userPrompt).toBe("Explain pump-3 batch (1)");
                    done();
                }, 30);
            }, 30);
        });
    });

    it("on API error: surfaces via node.error(), no output emitted", (done) => {
        const provider = mockProviderErr(
            new LlmHttpError("Anthropic API 401: invalid key", { status: 401, kind: "auth" })
        );
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            const errs = [];
            // Patch node.error to capture without polluting stderr
            const origError = n1.error.bind(n1);
            n1.error = (e, m) => {
                errs.push({ e, m });
                origError(e, m);
            };
            n1.receive({ payload: 7 });
            n1.receive({ payload: 8, flush: true });
            setTimeout(() => {
                expect(errs.length).toBeGreaterThan(0);
                expect(String(errs[0].e)).toMatch(/401/);
                expect(seen).toHaveLength(0);
                done();
            }, 50);
        });
    });

    it("passthroughOriginal preserves upstream payload as msg.input", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                passthroughOriginal: true,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: 99, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].input).toBe(99);
                done();
            }, 50);
        });
    });

    it("array payloads are spread into the buffer", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "batch",
                batchSize: 5,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: [1, 2, 3, 4, 5] });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toEqual([1, 2, 3, 4, 5]);
                done();
            }, 50);
        });
    });

    it("record mode: auto-detects numeric columns from the first record + fires at batchSize", (done) => {
        const provider = mockProviderOk("multi-sensor analysis");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "batch",
                batchSize: 3,
                inputMode: "record",
                sensorName: "machine-A",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            // First record sets the column schema (auto-detected: temp + pressure).
            n1.receive({ payload: { temp: 65.0, pressure: 4.5, note: "string-skipped" } });
            n1.receive({ payload: { temp: 65.2, pressure: 4.6 } });
            n1.receive({ payload: { temp: 65.4, pressure: 4.5 } });
            setTimeout(() => {
                expect(provider.calls).toHaveLength(1);
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toHaveLength(3);
                expect(seen[0].samples[0]).toEqual({ temp: 65.0, pressure: 4.5 });
                // The user prompt must contain the auto-detected column names + per-column stats.
                const prompt = provider.calls[0].userPrompt;
                expect(prompt).toMatch(/columns: temp, pressure/);
                expect(prompt).toMatch(/temp:.*n=3 mean=65\.2/);
                expect(prompt).toMatch(/pressure:.*n=3 mean=4\.5/);
                expect(prompt).toMatch(/t=1 temp=65 pressure=4\.5/);
                done();
            }, 50);
        });
    });

    it("record mode: explicit columns allowlist overrides auto-detect (e.g. excludes timestamp)", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "batch",
                batchSize: 2,
                inputMode: "record",
                columns: "temp, pressure",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            n1.receive({ payload: { timestamp: 1700000000, temp: 65, pressure: 4.5, vibration: 0.2 } });
            n1.receive({ payload: { timestamp: 1700000001, temp: 66, pressure: 4.5, vibration: 0.3 } });
            setTimeout(() => {
                expect(provider.calls).toHaveLength(1);
                const prompt = provider.calls[0].userPrompt;
                expect(prompt).toMatch(/columns: temp, pressure\)/);
                // timestamp + vibration MUST NOT appear as columns in the stats block.
                expect(prompt).not.toMatch(/timestamp:/);
                expect(prompt).not.toMatch(/vibration:/);
                done();
            }, 50);
        });
    });

    it("record mode: array payload is spread record-by-record", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "batch",
                batchSize: 5,
                inputMode: "record",
                columns: "a, b",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            // One msg, payload is a 5-record array — like a DB query result.
            n1.receive({
                payload: [
                    { a: 1, b: 10 },
                    { a: 2, b: 20 },
                    { a: 3, b: 30 },
                    { a: 4, b: 40 },
                    { a: 5, b: 50 }
                ]
            });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toHaveLength(5);
                done();
            }, 50);
        });
    });

    it("record mode: rejects records with no valid numeric fields, doesn't crash the buffer", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "batch",
                batchSize: 2,
                inputMode: "record",
                columns: "x",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: { x: "bogus" } }); // dropped
            n1.receive({ payload: { x: NaN } }); // dropped
            n1.receive({ payload: { x: 7 } });
            n1.receive({ payload: { x: 9 } });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toEqual([{ x: 7 }, { x: 9 }]);
                done();
            }, 50);
        });
    });

    it("output mode 'json': appends a schema instruction to the system prompt and parses the LLM response", (done) => {
        const provider = mockProviderOk('{"severity":"warning","score":0.85}');
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                outputMode: "json",
                outputSchema: '{"severity":"warning","score":0.5}',
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                // System prompt got the JSON instruction appended.
                expect(provider.calls).toHaveLength(1);
                expect(provider.calls[0].systemPrompt).toMatch(/single JSON object/);
                expect(provider.calls[0].systemPrompt).toMatch(/"severity":"warning"/);

                expect(seen).toHaveLength(1);
                // Without outputPath: payload IS the parsed object.
                expect(seen[0].payload).toEqual({ severity: "warning", score: 0.85 });
                expect(seen[0].json).toEqual({ severity: "warning", score: 0.85 });
                expect(seen[0].rawResponse).toBe('{"severity":"warning","score":0.85}');
                done();
            }, 50);
        });
    });

    it("output mode 'json' with outputPath: extracts the named field as msg.payload", (done) => {
        const provider = mockProviderOk('{"score": 0.92, "anomalies": ["leak", "drift"]}');
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                outputMode: "json",
                outputSchema: '{"score":0.5,"anomalies":["..."]}',
                outputPath: "score",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].payload).toBe(0.92);
                // Whole parsed object still accessible via msg.json.
                expect(seen[0].json).toEqual({ score: 0.92, anomalies: ["leak", "drift"] });
                done();
            }, 50);
        });
    });

    it("output mode 'json' with outputPath: dot-notation walks into arrays", (done) => {
        const provider = mockProviderOk('{"anomalies":["leak","drift","noise"]}');
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                outputMode: "json",
                outputSchema: '{"anomalies":["..."]}',
                outputPath: "anomalies.1",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(seen[0].payload).toBe("drift");
                done();
            }, 50);
        });
    });

    it("output mode 'json': bad JSON in response → node.error, no payload emitted", (done) => {
        const provider = mockProviderOk("Sorry, I couldn't extract any anomalies.");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                outputMode: "json",
                outputSchema: '{"score":0}',
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));
            const errs = [];
            const orig = n1.error.bind(n1);
            n1.error = (e, m) => {
                errs.push({ e, m });
                orig(e, m);
            };

            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(0);
                expect(errs).toHaveLength(1);
                expect(String(errs[0].e)).toMatch(/no parseable JSON/);
                expect(errs[0].m.rawResponse).toMatch(/Sorry/);
                done();
            }, 50);
        });
    });

    it("output mode 'json': missing outputPath in response → node.error, no payload emitted", (done) => {
        const provider = mockProviderOk('{"severity":"warning"}');
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                outputMode: "json",
                outputSchema: '{"severity":"x","score":0}',
                outputPath: "score",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));
            const errs = [];
            const orig = n1.error.bind(n1);
            n1.error = (e, m) => {
                errs.push({ e, m });
                orig(e, m);
            };

            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(0);
                expect(errs).toHaveLength(1);
                expect(String(errs[0].e)).toMatch(/outputPath 'score' missing/);
                expect(errs[0].m.json).toEqual({ severity: "warning" });
                done();
            }, 50);
        });
    });

    it("maxBufferSize: scalar mode drops oldest beyond the cap (ring-buffer)", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                maxBufferSize: 5,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            // Push 8 values into a cap-5 buffer; oldest 3 must drop.
            for (let i = 1; i <= 8; i++) n1.receive({ payload: i });
            n1.receive({ payload: 9, flush: true });
            // Cap = 5; total pushed = 9 → oldest 4 dropped → buffer = [5,6,7,8,9]
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toEqual([5, 6, 7, 8, 9]);
                done();
            }, 50);
        });
    });

    it("maxBufferSize: record mode drops oldest beyond the cap", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                inputMode: "record",
                columns: "x",
                maxBufferSize: 3,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            for (let i = 1; i <= 6; i++) n1.receive({ payload: { x: i * 10 } });
            n1.receive({ payload: { x: 70 }, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toEqual([{ x: 50 }, { x: 60 }, { x: 70 }]);
                done();
            }, 50);
        });
    });

    it("maxSamplesInPrompt: caps how many values land in the prompt body", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                maxBufferSize: 1000,
                maxSamplesInPrompt: 5,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            for (let i = 1; i <= 50; i++) n1.receive({ payload: i });
            n1.receive({ payload: 51, flush: true });
            setTimeout(() => {
                expect(provider.calls).toHaveLength(1);
                const prompt = provider.calls[0].userPrompt;
                // The samples block should mention "(showing last 5 of 51)" because
                // formatSamplesList caps the listing at maxSamplesInPrompt=5.
                expect(prompt).toMatch(/\(showing last 5 of 51\)/);
                done();
            }, 50);
        });
    });

    it("usage tracking: msg.totalUsage accumulates across calls", (done) => {
        // Provider returns increasing token usage on each call so we can
        // verify the running sum, not just one call.
        let n = 0;
        const provider = async () => {
            n++;
            return {
                text: "ok",
                usage: { inputTokens: 10 * n, outputTokens: 2 * n },
                model: "m",
                durationMs: 1,
                raw: {}
            };
        };
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(seen[0].totalUsage).toEqual({ inputTokens: 10, outputTokens: 2, callCount: 1 });
                n1.receive({ payload: 2, flush: true });
                setTimeout(() => {
                    expect(seen).toHaveLength(2);
                    expect(seen[1].totalUsage).toEqual({ inputTokens: 30, outputTokens: 6, callCount: 2 });
                    done();
                }, 50);
            }, 50);
        });
    });

    it("concurrency: a flush during an in-flight call queues a follow-up fire (no data loss)", (done) => {
        // Provider is intentionally slow so we can fire a 2nd flush while
        // the 1st is still pending. The slow promise resolves manually.
        let resolveFirst;
        const firstCall = new Promise((r) => {
            resolveFirst = r;
        });
        let calls = 0;
        const samplesSeen = [];
        const provider = async (_args) => {
            calls++;
            if (calls === 1) {
                samplesSeen.push("first call");
                await firstCall;
                return {
                    text: "first",
                    usage: { inputTokens: 1, outputTokens: 1 },
                    model: "m",
                    durationMs: 1,
                    raw: {}
                };
            }
            samplesSeen.push("second call");
            return {
                text: "second",
                usage: { inputTokens: 2, outputTokens: 2 },
                model: "m",
                durationMs: 1,
                raw: {}
            };
        };
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "manual",
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const out = [];
            n2.on("input", (msg) => out.push(msg));

            // First trigger — kicks off the slow first call.
            n1.receive({ payload: 10 });
            n1.receive({ payload: 11, flush: true });
            // Inputs arriving DURING the in-flight call.
            setTimeout(() => {
                n1.receive({ payload: 20 });
                n1.receive({ payload: 21, flush: true }); // queued, NOT dropped
                // Now release the first call.
                resolveFirst();
                setTimeout(() => {
                    expect(calls).toBe(2);
                    expect(out).toHaveLength(2);
                    expect(out[0].payload).toBe("first");
                    expect(out[0].samples).toEqual([10, 11]);
                    // Second call must include the samples that arrived during in-flight.
                    expect(out[1].payload).toBe("second");
                    expect(out[1].samples).toEqual([20, 21]);
                    done();
                }, 80);
            }, 30);
        });
    });

    it("non-numeric payloads are dropped silently", (done) => {
        const provider = mockProviderOk("ok");
        const flow = [
            {
                id: "n1",
                type: "llm-analyzer",
                name: "x",
                apiKey: "k",
                triggerMode: "batch",
                batchSize: 3,
                wires: [["n2"]]
            },
            { id: "n2", type: "helper" }
        ];
        flow[0].providerCall = provider;

        helper.load(llmAnalyzerNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (msg) => seen.push(msg));

            n1.receive({ payload: "not a number" });
            n1.receive({ payload: NaN });
            n1.receive({ payload: 1 });
            n1.receive({ payload: "2.5" }); // numeric string accepted
            n1.receive({ payload: 3 });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toEqual([1, 2.5, 3]);
                done();
            }, 50);
        });
    });
});
