"use strict";

const http = require("http");

const { startRed, captureNode, buildFlow } = require("./red-runtime");

/**
 * End-to-end: real Node-RED, real `llm-analyzer` node, real HTTP client
 * (the production code path uses global fetch). The Anthropic endpoint is
 * mocked locally so no network call leaves the box.
 *
 * Verifies Phase 1 of the SPEC: prompt shape, batch trigger, output payload,
 * and error handling routed to a catch-node.
 */

function startMockAnthropic() {
    let nextStatus = 200;
    let nextBody = {
        content: [{ type: "text", text: "Looks normal." }],
        model: "claude-haiku-4-5-20251001",
        usage: { input_tokens: 25, output_tokens: 7 }
    };
    const requests = [];

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            try {
                parsed = JSON.parse(raw);
            } catch (_) {
                parsed = null;
            }
            requests.push({
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: parsed,
                rawBody: raw
            });
            res.statusCode = nextStatus;
            res.setHeader("content-type", "application/json");
            res.end(typeof nextBody === "string" ? nextBody : JSON.stringify(nextBody));
        });
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolve({
                url: "http://127.0.0.1:" + addr.port + "/v1/messages",
                requests,
                setNext: (status, body) => {
                    nextStatus = status;
                    nextBody = body;
                },
                shutdown: () =>
                    new Promise((r) => {
                        server.close(() => r());
                    })
            });
        });
    });
}

describe("integration: llm-analyzer end-to-end", () => {
    let harness;
    let mock;

    beforeAll(async () => {
        mock = await startMockAnthropic();
        harness = await startRed();
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
        if (mock) await mock.shutdown();
    }, 15000);

    afterEach(() => {
        // Reset any prior captures and the mock's response queue.
        if (harness) harness.reset();
        mock.requests.length = 0;
        mock.setNext(200, {
            content: [{ type: "text", text: "Looks normal." }],
            model: "claude-haiku-4-5-20251001",
            usage: { input_tokens: 25, output_tokens: 7 }
        });
    });

    it("batch mode: 5 inputs → exactly one LLM call → response routed downstream", async () => {
        const TAB = "llm-tab-batch";
        const NODE = "llm-batch";
        const CAP = "cap-batch";
        const flow = buildFlow(TAB, "llm batch", [
            {
                id: NODE,
                type: "llm-analyzer",
                name: "batch",
                provider: "anthropic",
                model: "claude-haiku-4-5-20251001",
                apiUrl: mock.url,
                apiKey: "sk-ant-test-key",
                triggerMode: "batch",
                batchSize: 5,
                sensorName: "machine-A/temp",
                unit: "°C",
                wires: [[CAP]]
            },
            captureNode(CAP, "capture")
        ]);
        await harness.deploy(flow);

        for (let i = 1; i <= 5; i++) {
            await harness.inject(NODE, { payload: 70 + i });
        }

        const captured = await harness.collect(CAP, 1, 8000);
        expect(captured).toHaveLength(1);
        expect(captured[0].payload).toBe("Looks normal.");
        expect(captured[0].usage).toEqual({ inputTokens: 25, outputTokens: 7 });
        expect(captured[0].samples).toEqual([71, 72, 73, 74, 75]);

        // Exactly one outbound HTTP call to the mock.
        expect(mock.requests).toHaveLength(1);
        const req = mock.requests[0];
        expect(req.method).toBe("POST");
        expect(req.headers["x-api-key"]).toBe("sk-ant-test-key");
        expect(req.headers["anthropic-version"]).toBe("2023-06-01");
        expect(req.body.model).toBe("claude-haiku-4-5-20251001");
        // Sensor metadata propagated into the user prompt.
        expect(req.body.messages[0].content).toMatch(/machine-A\/temp/);
        // Stats injected — mean of 71..75 is 73.
        expect(req.body.messages[0].content).toMatch(/mean=73/);
    }, 20000);

    it("manual mode: msg.flush=true triggers analysis with whatever is in the buffer", async () => {
        const TAB = "llm-tab-manual";
        const NODE = "llm-manual";
        const CAP = "cap-manual";
        const flow = buildFlow(TAB, "llm manual", [
            {
                id: NODE,
                type: "llm-analyzer",
                name: "manual",
                provider: "anthropic",
                apiUrl: mock.url,
                apiKey: "sk-ant-manual",
                triggerMode: "manual",
                sensorName: "pump-3",
                unit: "bar",
                wires: [[CAP]]
            },
            captureNode(CAP, "capture")
        ]);
        await harness.deploy(flow);

        // Fill buffer without flushing.
        await harness.inject(NODE, { payload: 1.0 });
        await harness.inject(NODE, { payload: 1.1 });
        await harness.inject(NODE, { payload: 1.2 });

        // Brief settle — should still be zero requests.
        await new Promise((r) => setTimeout(r, 100));
        expect(mock.requests).toHaveLength(0);

        // Flush, with a custom per-message prompt.
        await harness.inject(NODE, {
            payload: 1.3,
            flush: true,
            prompt: "Three sentences about {sensor} batch of {count} samples."
        });

        const captured = await harness.collect(CAP, 1, 8000);
        expect(captured).toHaveLength(1);
        expect(captured[0].samples).toEqual([1.0, 1.1, 1.2, 1.3]);
        expect(mock.requests).toHaveLength(1);
        // The msg.prompt override must replace the default user prompt.
        expect(mock.requests[0].body.messages[0].content).toBe("Three sentences about pump-3 batch of 4 samples.");
    }, 20000);

    it("HTTP 401 from upstream → catch-node sees the error, no payload-bearing output", async () => {
        const TAB = "llm-tab-err";
        const NODE = "llm-err";
        const CAP_OK = "cap-err-ok";
        const CAP_ERR = "cap-err-catch";
        // Catch node wired to the analyzer; routes errors to CAP_ERR.
        const flow = buildFlow(TAB, "llm error", [
            {
                id: NODE,
                type: "llm-analyzer",
                name: "err",
                provider: "anthropic",
                apiUrl: mock.url,
                apiKey: "sk-ant-bad",
                triggerMode: "manual",
                sensorName: "x",
                unit: "y",
                wires: [[CAP_OK]]
            },
            { id: "catch1", type: "catch", scope: [NODE], uncaught: false, wires: [[CAP_ERR]] },
            captureNode(CAP_OK, "ok-capture"),
            captureNode(CAP_ERR, "err-capture")
        ]);
        await harness.deploy(flow);

        mock.setNext(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });

        await harness.inject(NODE, { payload: 5 });
        await harness.inject(NODE, { payload: 6, flush: true });

        // Wait for the catch-node to receive the error msg.
        const errs = await harness.collect(CAP_ERR, 1, 8000);
        expect(errs).toHaveLength(1);
        expect(typeof errs[0].error).toBe("object");
        expect(String(errs[0].error.message)).toMatch(/401/);

        // No payload-bearing output should reach the OK capture.
        const okList = await harness.collect(CAP_OK, 0, 200).catch(() => []);
        expect(okList).toEqual([]);
    }, 20000);
});
