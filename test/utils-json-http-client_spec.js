"use strict";

const http = require("http");

const {
    requestJson,
    withRetry,
    retryPolicy,
    isClientError,
    isServerError,
    isConnectionError,
    isTimeoutError
} = require("../nodes/utils/json-http-client");

describe("utils/json-http-client", () => {
    let server;
    let port;
    let handler;
    const seen = [];

    beforeAll((done) => {
        server = http.createServer((req, res) => {
            let raw = "";
            req.on("data", (c) => (raw += c));
            req.on("end", () => {
                seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
                handler(req, res);
            });
        });
        server.listen(0, "127.0.0.1", () => {
            port = server.address().port;
            done();
        });
    });

    afterAll((done) => {
        if (server.closeAllConnections) server.closeAllConnections();
        server.close(done);
    });

    beforeEach(() => {
        seen.length = 0;
        handler = (req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        };
    });

    function call(extra) {
        return requestJson(
            Object.assign(
                { protocol: http, hostname: "127.0.0.1", port, method: "POST", path: "/x", timeoutMs: 2000 },
                extra
            )
        );
    }

    it("sends the body as JSON with an explicit Content-Length and parses the reply", async () => {
        const settled = [];
        const data = { model_id: "m", input_data: [1, 2, 3] };
        const result = await call({ data, onSettled: (ms, ok) => settled.push(ok) });

        expect(result).toEqual({ ok: true });
        expect(seen).toHaveLength(1);
        expect(JSON.parse(seen[0].body)).toEqual(data);
        expect(seen[0].headers["content-type"]).toBe("application/json");
        expect(seen[0].headers["content-length"]).toBe(String(Buffer.byteLength(JSON.stringify(data))));
        expect(seen[0].headers["transfer-encoding"]).toBeUndefined();
        expect(settled).toEqual([true]);
    });

    it("sends Content-Type on a body-less request only when asked to", async () => {
        await call({ method: "GET" });
        await call({ method: "GET", contentTypeAlways: true });
        expect(seen[0].headers["content-type"]).toBeUndefined();
        expect(seen[1].headers["content-type"]).toBe("application/json");
    });

    it("rejects an HTTP error with its status code and the server's error text", async () => {
        handler = (req, res) => {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not loaded" }));
        };
        const settled = [];
        const err = await call({ onSettled: (ms, ok) => settled.push(ok) }).catch((e) => e);
        expect(err.message).toBe("not loaded");
        expect(err.statusCode).toBe(404);
        expect(isClientError(err)).toBe(true);
        expect(settled).toEqual([false]);
    });

    it("keeps the status code when the error body is not JSON", async () => {
        handler = (req, res) => {
            res.writeHead(502);
            res.end("<html>Bad Gateway</html>");
        };
        const err = await call().catch((e) => e);
        expect(err.message).toBe("Invalid JSON response: <html>Bad Gateway</html>");
        expect(err.statusCode).toBe(502);
        expect(isClientError(err)).toBe(false);
    });

    it("treats an empty 200 body as {} only with emptyBodyIsObject", async () => {
        handler = (req, res) => {
            res.writeHead(200);
            res.end();
        };
        await expect(call({ emptyBodyIsObject: true })).resolves.toEqual({});
        await expect(call()).rejects.toThrow("Invalid JSON response: ");
    });

    it("times out with the configured message and reports the request exactly once", async () => {
        handler = () => {
            /* never answer */
        };
        const settled = [];
        const err = await call({
            timeoutMs: 80,
            timeoutMessage: "Request timeout: POST /x",
            onSettled: (ms, ok) => settled.push(ok)
        }).catch((e) => e);
        expect(err.message).toBe("Request timeout: POST /x");
        // The code is what lets the retry policy refuse to repeat it.
        expect(err.code).toBe("EREQUESTTIMEOUT");
        expect(isTimeoutError(err)).toBe(true);
        expect(isConnectionError(err)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 50));
        // destroy() also raises a socket error — that must not count twice.
        expect(settled).toEqual([false]);
    });

    it("forwards extra headers (the bridges' bearer token)", async () => {
        await call({ headers: { Authorization: "Bearer s3cret" } });
        expect(seen[0].headers.authorization).toBe("Bearer s3cret");
        expect(seen[0].headers.accept).toBe("application/json");
    });

    it("rejects a response above maxResponseBytes, drops the connection and reports once", async () => {
        handler = (req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            // Well above the cap, in several chunks.
            const chunk = Buffer.alloc(64 * 1024, 0x61);
            for (let i = 0; i < 8; i++) res.write(chunk);
            res.end('"');
        };
        const settled = [];
        const err = await call({ maxResponseBytes: 100 * 1024, onSettled: (ms, ok) => settled.push(ok) }).catch(
            (e) => e
        );
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe("ERESPONSETOOLARGE");
        expect(err.message).toMatch(/exceeds 102400 bytes/);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toEqual([false]);
    });

    it("applies a 16 MiB response cap by default", async () => {
        handler = (req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write("[");
            const chunk = Buffer.alloc(1024 * 1024, 0x31);
            for (let i = 0; i < 17; i++) res.write(chunk);
            res.end("]");
        };
        const err = await call().catch((e) => e);
        expect(err.code).toBe("ERESPONSETOOLARGE");
    });

    it("classifies a refused connection as a connection error", async () => {
        const probe = http.createServer();
        await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const deadPort = probe.address().port;
        await new Promise((resolve) => probe.close(resolve));

        const err = await call({ port: deadPort }).catch((e) => e);
        expect(err.code).toBe("ECONNREFUSED");
        expect(isConnectionError(err)).toBe(true);
        expect(isTimeoutError(err)).toBe(false);
    });

    describe("retryPolicy", () => {
        const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        const timeout = Object.assign(new Error("Request timeout"), { code: "EREQUESTTIMEOUT" });
        const badRequest = Object.assign(new Error("bad"), { statusCode: 400 });
        const serverErr = Object.assign(new Error("boom"), { statusCode: 500 });
        const garbage = new Error("Invalid JSON response: <html>");

        it("retries only connection errors for non-idempotent calls (predict)", () => {
            const isFinal = retryPolicy();
            expect(isFinal(refused)).toBe(false);
            expect(isFinal(timeout)).toBe(true);
            expect(isFinal(badRequest)).toBe(true);
            expect(isFinal(serverErr)).toBe(true);
            expect(isFinal(garbage)).toBe(true);
        });

        it("also retries 5xx for idempotent calls (health/status), but still never a timeout", () => {
            const isFinal = retryPolicy({ retryServerErrors: true });
            expect(isFinal(refused)).toBe(false);
            expect(isFinal(serverErr)).toBe(false);
            expect(isFinal(timeout)).toBe(true);
            expect(isFinal(badRequest)).toBe(true);
            expect(isServerError(serverErr)).toBe(true);
            expect(isServerError(badRequest)).toBe(false);
        });

        it("does not mistake an HTTP error for a connection error", () => {
            const withStatus = Object.assign(new Error("x"), { code: "ECONNRESET", statusCode: 502 });
            expect(isConnectionError(withStatus)).toBe(false);
        });
    });

    describe("withRetry", () => {
        it("retries a failing attempt and returns the first success", async () => {
            let calls = 0;
            const result = await withRetry(
                async () => {
                    if (++calls < 3) throw new Error("ECONNRESET");
                    return "done";
                },
                { retryAttempts: 3, retryDelay: 1 }
            );
            expect(result).toBe("done");
            expect(calls).toBe(3);
        });

        it("gives up after retryAttempts with the last error", async () => {
            let calls = 0;
            await expect(
                withRetry(
                    async () => {
                        throw new Error("fail #" + ++calls);
                    },
                    { retryAttempts: 2, retryDelay: 1 }
                )
            ).rejects.toThrow("fail #2");
        });

        it("does not retry a client error, nor anything isFinal accepts", async () => {
            let calls = 0;
            const clientErr = Object.assign(new Error("bad request"), { statusCode: 400 });
            await expect(
                withRetry(
                    async () => {
                        calls++;
                        throw clientErr;
                    },
                    { retryAttempts: 5, retryDelay: 1 }
                )
            ).rejects.toBe(clientErr);
            expect(calls).toBe(1);

            calls = 0;
            await expect(
                withRetry(
                    async () => {
                        calls++;
                        throw new Error("HTTP 418");
                    },
                    { retryAttempts: 5, retryDelay: 1, isFinal: (e) => e.message.includes("HTTP 4") }
                )
            ).rejects.toThrow("HTTP 418");
            expect(calls).toBe(1);
        });
    });
});
