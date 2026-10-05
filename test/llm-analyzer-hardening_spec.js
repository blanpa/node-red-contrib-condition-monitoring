"use strict";

/**
 * Regression tests for the llm-analyzer hardening pass: request timeouts that
 * cover the body, cancellable calls, retry/backoff that keeps the batch, the
 * opt-in + origin-pinned msg.apiUrl override, and persistence that actually
 * reaches the context store.
 */

const helper = require("node-red-node-test-helper");
const llmAnalyzerNode = require("../nodes/llm-analyzer.js");
const providers = require("../nodes/utils/llm-providers");

helper.init(require.resolve("node-red"));

function fakeRes(body, status = 200, headers) {
    return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (headers && headers[k.toLowerCase()]) || null },
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body))
    });
}

describe("llm-providers hardening", () => {
    it("times out when the server sends headers and then stalls the body", async () => {
        const fetchFn = () => Promise.resolve({ ok: true, status: 200, text: () => new Promise(() => {}) });
        const started = Date.now();
        await expect(
            providers.callAnthropic({ apiKey: "k", model: "m", userPrompt: "x", timeoutMs: 80, fetchFn })
        ).rejects.toMatchObject({ kind: "timeout" });
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it("an external abort signal cancels the call with kind 'aborted'", async () => {
        const ctl = new AbortController();
        const fetchFn = (url, init) =>
            new Promise((_, reject) => {
                init.signal.addEventListener("abort", () =>
                    reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
                );
            });
        const p = providers.callOllama({ model: "m", userPrompt: "x", timeoutMs: 5000, fetchFn, signal: ctl.signal });
        ctl.abort();
        await expect(p).rejects.toMatchObject({ kind: "aborted" });
    });

    it("exposes Retry-After on a 429 and classifies retryable errors", async () => {
        const fetchFn = () => fakeRes({ error: { message: "slow down" } }, 429, { "retry-after": "7" });
        let err;
        try {
            await providers.callOpenAI({ apiKey: "k", model: "m", userPrompt: "x", fetchFn });
        } catch (e) {
            err = e;
        }
        expect(err.kind).toBe("rate-limit");
        expect(err.retryAfterMs).toBe(7000);
        expect(providers.isRetryableError(err)).toBe(true);
        expect(providers.isRetryableError(new providers.LlmHttpError("x", { status: 503 }))).toBe(true);
        expect(providers.isRetryableError(new providers.LlmHttpError("x", { kind: "timeout" }))).toBe(true);
        expect(providers.isRetryableError(new providers.LlmHttpError("x", { status: 400 }))).toBe(false);
        expect(providers.isRetryableError(new providers.LlmHttpError("x", { status: 401, kind: "auth" }))).toBe(false);
        expect(providers.isRetryableError(new providers.LlmHttpError("x", { kind: "config" }))).toBe(false);
    });

    it("parseRetryAfter handles seconds, HTTP dates and garbage", () => {
        expect(providers.parseRetryAfter("2")).toBe(2000);
        expect(providers.parseRetryAfter("Wed, 21 Oct 2015 07:28:10 GMT", Date.parse("2015-10-21T07:28:00Z"))).toBe(
            10000
        );
        expect(providers.parseRetryAfter("soon")).toBeNull();
        expect(providers.parseRetryAfter(null)).toBeNull();
    });

    it("openai sends max_completion_tokens, openai-compatible keeps max_tokens", async () => {
        const bodies = [];
        const fetchFn = (url, init) => {
            bodies.push(JSON.parse(init.body));
            return fakeRes({ choices: [{ message: { content: "ok" }, finish_reason: "length" }] });
        };
        const a = await providers.callOpenAI({ apiKey: "k", model: "m", userPrompt: "x", maxTokens: 77, fetchFn });
        await providers.callOpenAICompatible({
            apiKey: "k",
            model: "m",
            userPrompt: "x",
            maxTokens: 77,
            apiUrl: "https://example.test/v1/chat/completions",
            fetchFn
        });
        expect(bodies[0].max_completion_tokens).toBe(77);
        expect(bodies[0].max_tokens).toBeUndefined();
        expect(bodies[1].max_tokens).toBe(77);
        expect(bodies[1].max_completion_tokens).toBeUndefined();
        expect(a.finishReason).toBe("length");
        expect(a.truncated).toBe(true);
    });

    it("anthropic and google report the finish reason and truncation", async () => {
        const a = await providers.callAnthropic({
            apiKey: "k",
            model: "m",
            userPrompt: "x",
            fetchFn: () => fakeRes({ content: [{ type: "text", text: "{" }], stop_reason: "max_tokens" })
        });
        expect(a.finishReason).toBe("max_tokens");
        expect(a.truncated).toBe(true);
        const g = await providers.callGoogle({
            apiKey: "k",
            model: "m",
            userPrompt: "x",
            fetchFn: () => fakeRes({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })
        });
        expect(g.finishReason).toBe("STOP");
        expect(g.truncated).toBe(false);
    });

    it("detectNumericColumns skips ISO-date-shaped strings but keeps lenient numeric strings", () => {
        expect(
            providers.detectNumericColumns({
                created: "2024-05-01",
                measuredAt: "2024-05-01T12:30:00Z",
                logged: "2024-05-01 12:30:00",
                temp: "65 °C",
                pressure: 4.5,
                serial: "2024-1234-A", // not a date shape: stays lenient
                note: "n/a"
            })
        ).toEqual(["temp", "pressure", "serial"]);
    });

    it("parseHttpUrl / isSameOrigin only accept http(s) and compare scheme+host+port", () => {
        expect(providers.parseHttpUrl("https://api.example.com/v1").ok).toBe(true);
        expect(providers.parseHttpUrl("file:///etc/passwd").ok).toBe(false);
        expect(providers.parseHttpUrl("not a url").ok).toBe(false);
        expect(providers.parseHttpUrl("").ok).toBe(false);
        expect(providers.isSameOrigin("https://a.test/x", "https://a.test/y?z=1")).toBe(true);
        expect(providers.isSameOrigin("https://a.test:8443/x", "https://a.test/y")).toBe(false);
        expect(providers.isSameOrigin("http://a.test/x", "https://a.test/y")).toBe(false);
        expect(providers.isSameOrigin("https://evil.test/x", "https://a.test/y")).toBe(false);
        expect(providers.isSameOrigin("https://a.test.evil.test/x", "https://a.test/y")).toBe(false);
    });
});

describe("llm-analyzer node hardening", () => {
    beforeEach(function (done) {
        helper.startServer(done);
    });
    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    function okProvider(text = "fine") {
        const calls = [];
        const fn = async (args) => {
            calls.push(args);
            return { text, usage: { inputTokens: 10, outputTokens: 5 }, model: args.model, durationMs: 1, raw: {} };
        };
        fn.calls = calls;
        return fn;
    }

    function load(cfg, cb) {
        const flow = [
            Object.assign({ id: "n1", type: "llm-analyzer", name: "x", triggerMode: "manual", wires: [["n2"]] }, cfg),
            { id: "n2", type: "helper" }
        ];
        helper.load(llmAnalyzerNode, flow, { n1: { apiKey: "secret-key" } }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            const seen = [];
            n2.on("input", (m) => seen.push(m));
            cb(n1, seen);
        });
    }

    it("ignores msg.apiUrl unless the override is enabled", (done) => {
        const provider = okProvider();
        load({ apiUrl: "https://gateway.test/v1/messages", providerCall: provider }, (n1, seen) => {
            n1.receive({ payload: 1, flush: true, apiUrl: "https://attacker.test/steal" });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(provider.calls[0].apiUrl).toBe("https://gateway.test/v1/messages");
                done();
            }, 50);
        });
    });

    it("with the override enabled, accepts a same-origin msg.apiUrl", (done) => {
        const provider = okProvider();
        load(
            { apiUrl: "https://gateway.test/v1/messages", allowMsgApiUrl: true, providerCall: provider },
            (n1, seen) => {
                n1.receive({ payload: 1, flush: true, apiUrl: "https://gateway.test/v2/messages" });
                setTimeout(() => {
                    expect(seen).toHaveLength(1);
                    expect(provider.calls[0].apiUrl).toBe("https://gateway.test/v2/messages");
                    done();
                }, 50);
            }
        );
    });

    it("with the override enabled, rejects a cross-origin msg.apiUrl and keeps the batch", (done) => {
        const provider = okProvider();
        load(
            { apiUrl: "https://gateway.test/v1/messages", allowMsgApiUrl: true, providerCall: provider },
            (n1, seen) => {
                n1.receive({ payload: 1 });
                n1.receive({ payload: 2, flush: true, apiUrl: "https://attacker.test/steal" });
                setTimeout(() => {
                    expect(provider.calls).toHaveLength(0);
                    expect(seen).toHaveLength(0);
                    n1.receive({ payload: 3, flush: true });
                    setTimeout(() => {
                        expect(provider.calls).toHaveLength(1);
                        expect(seen[0].samples).toEqual([1, 2, 3]);
                        done();
                    }, 50);
                }, 50);
            }
        );
    });

    it("pins the override to the provider default origin when no apiUrl is configured", (done) => {
        const provider = okProvider();
        load({ allowMsgApiUrl: true, providerCall: provider }, (n1, seen) => {
            n1.receive({ payload: 1, flush: true, apiUrl: "http://127.0.0.1:9/internal" });
            setTimeout(() => {
                expect(provider.calls).toHaveLength(0);
                n1.receive({ payload: 2, flush: true, apiUrl: "https://api.anthropic.com/v1/messages?beta=1" });
                setTimeout(() => {
                    expect(provider.calls).toHaveLength(1);
                    expect(seen).toHaveLength(1);
                    done();
                }, 50);
            }, 50);
        });
    });

    it("refuses to start with a non-http(s) configured apiUrl", (done) => {
        const provider = okProvider();
        load({ apiUrl: "file:///etc/passwd", providerCall: provider }, (n1, seen) => {
            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(provider.calls).toHaveLength(0);
                expect(seen).toHaveLength(0);
                done();
            }, 50);
        });
    });

    it("a retryable failure puts the batch back; a later flush sends it again", (done) => {
        let n = 0;
        const calls = [];
        const provider = async (args) => {
            calls.push(args);
            if (++n === 1) throw new providers.LlmHttpError("LLM call timed out", { kind: "timeout" });
            return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, model: "m", durationMs: 1 };
        };
        load({ providerCall: provider }, (n1, seen) => {
            n1.receive({ payload: 1 });
            n1.receive({ payload: 2, flush: true });
            setTimeout(() => {
                expect(calls).toHaveLength(1);
                expect(seen).toHaveLength(0);
                n1.receive({ payload: 3, flush: true });
                setTimeout(() => {
                    expect(calls).toHaveLength(2);
                    expect(seen).toHaveLength(1);
                    expect(seen[0].samples).toEqual([1, 2, 3]);
                    done();
                }, 50);
            }, 50);
        });
    });

    it("batch mode backs off after a rate limit instead of calling on every new batch", (done) => {
        const calls = [];
        const provider = async (args) => {
            calls.push(args);
            throw new providers.LlmHttpError("429", { kind: "rate-limit", status: 429, retryAfterMs: 60000 });
        };
        load({ triggerMode: "batch", batchSize: 2, providerCall: provider }, (n1) => {
            for (let i = 0; i < 10; i++) n1.receive({ payload: i });
            setTimeout(() => {
                // One attempt; the other four full batches wait out the backoff.
                expect(calls).toHaveLength(1);
                done();
            }, 80);
        });
    });

    it("a non-retryable failure drops the batch (it would fail identically again)", (done) => {
        let n = 0;
        const provider = async () => {
            if (++n === 1) throw new providers.LlmHttpError("bad request", { kind: "http", status: 400 });
            return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, model: "m", durationMs: 1 };
        };
        load({ providerCall: provider }, (n1, seen) => {
            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                n1.receive({ payload: 2, flush: true });
                setTimeout(() => {
                    expect(seen).toHaveLength(1);
                    expect(seen[0].samples).toEqual([2]);
                    done();
                }, 50);
            }, 50);
        });
    });

    it("counts the tokens of a response whose JSON could not be parsed", (done) => {
        let n = 0;
        const provider = async () => ({
            text: ++n === 1 ? "{ not json" : '{"a":1}',
            usage: { inputTokens: 100, outputTokens: 20 },
            model: "m",
            truncated: n === 1,
            finishReason: n === 1 ? "max_tokens" : "end_turn",
            durationMs: 1
        });
        load({ outputMode: "json", providerCall: provider }, (n1, seen) => {
            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(0);
                n1.receive({ payload: 2, flush: true });
                setTimeout(() => {
                    expect(seen).toHaveLength(1);
                    expect(seen[0].totalUsage).toEqual({ inputTokens: 200, outputTokens: 40, callCount: 2 });
                    expect(seen[0].finishReason).toBe("end_turn");
                    done();
                }, 50);
            }, 50);
        });
    });

    it("scalar mode does not ingest a date string as the number 2024, but still reads '65 °C'", (done) => {
        load({ providerCall: okProvider() }, (n1, seen) => {
            n1.receive({ payload: "2024-05-01" });
            n1.receive({ payload: "2024-05-01T08:00:00.000Z" });
            n1.receive({ payload: ["2024-05-02", "66.5 °C", 67] });
            n1.receive({ payload: "65 °C", flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toEqual([66.5, 67, 65]);
                done();
            }, 50);
        });
    });

    it("record mode does not lock a timestamp-like column in as a sensor", (done) => {
        load({ inputMode: "record", providerCall: okProvider() }, (n1, seen) => {
            n1.receive({ payload: { sampledOn: "2024-05-01", temp: 65, pressure: "4.5 bar" }, flush: true });
            setTimeout(() => {
                expect(seen).toHaveLength(1);
                expect(seen[0].samples).toEqual([{ temp: 65, pressure: 4.5 }]);
                done();
            }, 50);
        });
    });

    it("passes an abort signal to the provider and aborts it on close", (done) => {
        let signal = null;
        const provider = (args) => {
            signal = args.signal;
            return new Promise(() => {});
        };
        load({ providerCall: provider }, (n1) => {
            n1.receive({ payload: 1, flush: true });
            setTimeout(() => {
                expect(signal).toBeInstanceOf(AbortSignal);
                expect(signal.aborted).toBe(false);
                n1.close().then(() => {
                    expect(signal.aborted).toBe(true);
                    done();
                });
            }, 30);
        });
    });

    it("persistState: close writes the buffer to the context store and stops the save timer", (done) => {
        load({ persistState: true, providerCall: okProvider() }, (n1) => {
            const writes = [];
            // Record what reaches the store, whichever store the manager targets.
            n1.context = () => ({
                get: (key, store, cb) => cb(null, undefined),
                set: (key, value, store, cb) => {
                    writes.push({ key, value });
                    cb(null);
                }
            });
            setTimeout(() => {
                n1.receive({ payload: 1 });
                n1.receive({ payload: 2 });
                n1.receive({ payload: 3 });
                n1.close().then(() => {
                    expect(writes).toHaveLength(1);
                    expect(writes[0].key).toBe("llmAnalyzerState_n1");
                    expect(writes[0].value.buffer).toEqual([1, 2, 3]);
                    expect(n1.stateManager.saveTimer).toBeNull();
                    done();
                });
            }, 30);
        });
    });
});
