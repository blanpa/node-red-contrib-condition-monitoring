/**
 * JSON-over-HTTP client helpers
 * =============================
 *
 * The request/retry plumbing shared by the two HTTP inference bridges
 * (`max-bridge-manager.js` → MAX Engine server, `remote-python-bridge.js` →
 * inference container). Both speak small JSON documents over plain
 * http/https, want a per-request timeout and a bounded response, and share
 * one retry policy:
 *
 * - a connection error (the request never reached the server) is retried
 *   for every call;
 * - a timeout is never retried — the server may still be executing the
 *   request, and repeating a 60 s predict triples the load exactly when the
 *   server is already overloaded;
 * - a 5xx is retried only for the idempotent, cheap GET health/status calls;
 * - a 4xx is never retried: a bad request stays bad.
 *
 * The bridges keep what genuinely differs between them — statistics, sharding,
 * events and the shape of what they return — and delegate the wire work here.
 *
 * @module utils/json-http-client
 */

"use strict";

/** Default cap on a JSON response body (a prediction, a status document). */
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Error code set on a request that hit the idle timeout. */
const TIMEOUT_CODE = "EREQUESTTIMEOUT";

/** Error code set on a response that exceeded `maxResponseBytes`. */
const RESPONSE_TOO_LARGE_CODE = "ERESPONSETOOLARGE";

/**
 * Socket-level failures that mean the request did not reach the server's
 * application logic, so repeating it cannot run anything twice. (A kernel
 * ETIMEDOUT is the TCP handshake timing out, not our idle timeout above.)
 */
const CONNECTION_ERROR_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT"
]);

/**
 * @typedef {Object} JsonRequestOptions
 * @property {Object}  protocol   `require("http")` or `require("https")`.
 * @property {string}  hostname
 * @property {number|string} port
 * @property {string}  method
 * @property {string}  path
 * @property {*}       [data]     JSON-serialisable request body (omitted when falsy).
 * @property {Object}  [headers]  Extra request headers (e.g. Authorization).
 * @property {number}  timeoutMs  Socket timeout.
 * @property {string}  [timeoutMessage="Request timeout"]
 * @property {number}  [maxResponseBytes=16 MiB]
 *           Reject (and drop the connection) once the body exceeds this.
 * @property {boolean} [contentTypeAlways=false]
 *           Send `Content-Type: application/json` even without a body.
 * @property {boolean} [emptyBodyIsObject=false]
 *           Treat an empty response body as `{}` instead of invalid JSON.
 * @property {(responseTimeMs: number, success: boolean) => void} [onSettled]
 *           Called exactly once per request, for statistics. `success` is
 *           "an HTTP response below 400 arrived" (transport errors and
 *           timeouts report false).
 */

/**
 * Issue one HTTP request with an optional JSON body and parse the JSON reply.
 *
 * Rejects with an Error that carries `.statusCode` for HTTP errors (also when
 * the error body is not JSON), so callers can tell a client error from a
 * server/transport failure without parsing message strings. A timeout rejects
 * with `.code === "EREQUESTTIMEOUT"`, an oversized body with
 * `.code === "ERESPONSETOOLARGE"`.
 *
 * The body is serialised up front and sent with an explicit Content-Length:
 * without it Node uses chunked transfer-encoding, which minimal servers (the
 * stdlib http.server behind inference_server.py) do not decode.
 *
 * @param {JsonRequestOptions} options
 * @returns {Promise<*>} the parsed response body
 */
function requestJson(options) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let reported = false;
        const report = function (success) {
            if (reported) return;
            reported = true;
            if (typeof options.onSettled === "function") {
                options.onSettled(Date.now() - startTime, success);
            }
        };

        const maxBytes =
            typeof options.maxResponseBytes === "number" && options.maxResponseBytes > 0
                ? options.maxResponseBytes
                : DEFAULT_MAX_RESPONSE_BYTES;

        const payload = options.data ? Buffer.from(JSON.stringify(options.data)) : null;
        const headers = Object.assign({ Accept: "application/json" }, options.headers || {});
        if (payload || options.contentTypeAlways) {
            headers["Content-Type"] = "application/json";
        }
        if (payload) {
            headers["Content-Length"] = payload.length;
        }

        const req = options.protocol.request(
            {
                hostname: options.hostname,
                port: options.port,
                path: options.path,
                method: options.method,
                headers: headers,
                timeout: options.timeoutMs
            },
            (res) => {
                const chunks = [];
                let received = 0;
                let aborted = false;
                res.on("data", (chunk) => {
                    if (aborted) return;
                    received += chunk.length;
                    if (received > maxBytes) {
                        aborted = true;
                        const tooLarge = new Error(
                            `Response exceeds ${maxBytes} bytes: ${options.method} ${options.path}`
                        );
                        tooLarge.code = RESPONSE_TOO_LARGE_CODE;
                        tooLarge.statusCode = res.statusCode;
                        report(false);
                        req.destroy();
                        reject(tooLarge);
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    if (aborted) return;
                    report(res.statusCode < 400);

                    const body = Buffer.concat(chunks).toString("utf8");
                    let parsed;
                    try {
                        parsed = body || !options.emptyBodyIsObject ? JSON.parse(body) : {};
                    } catch (e) {
                        const parseErr = new Error(`Invalid JSON response: ${body.substring(0, 100)}`);
                        // An HTML 404 from a proxy is still a client error —
                        // keep the status so the retry layer does not hammer it.
                        if (res.statusCode >= 400) parseErr.statusCode = res.statusCode;
                        reject(parseErr);
                        return;
                    }

                    if (res.statusCode >= 400) {
                        const httpErr = new Error((parsed && parsed.error) || `HTTP ${res.statusCode}`);
                        httpErr.statusCode = res.statusCode;
                        reject(httpErr);
                    } else {
                        resolve(parsed);
                    }
                });
            }
        );

        req.on("error", (err) => {
            report(false);
            reject(err);
        });

        req.on("timeout", () => {
            req.destroy();
            report(false);
            const timeoutErr = new Error(options.timeoutMessage || "Request timeout");
            timeoutErr.code = TIMEOUT_CODE;
            reject(timeoutErr);
        });

        if (payload) req.write(payload);
        req.end();
    });
}

/** True for an error that carries an HTTP 4xx status. */
function isClientError(err) {
    const status = err && err.statusCode;
    return typeof status === "number" && status >= 400 && status < 500;
}

/** True for an error that carries an HTTP 5xx status. */
function isServerError(err) {
    const status = err && err.statusCode;
    return typeof status === "number" && status >= 500;
}

/** True for a request that hit the idle timeout (see `requestJson`). */
function isTimeoutError(err) {
    return !!(err && err.code === TIMEOUT_CODE);
}

/**
 * True for a socket-level failure that means the request never reached the
 * server — the only kind of failure a non-idempotent call may be retried on.
 */
function isConnectionError(err) {
    return !!(err && err.statusCode === undefined && CONNECTION_ERROR_CODES.has(err.code));
}

/**
 * Build the `isFinal` predicate for `withRetry` that implements the shared
 * bridge policy: connection errors are retried, timeouts and 4xx never, 5xx
 * only when the caller declares the request idempotent and cheap.
 *
 * @param {Object}  [options]
 * @param {boolean} [options.retryServerErrors=false]
 *        Also retry 5xx. Use only for GET health/status: a 5xx from /predict
 *        is the model failing, and repeating it just repeats the work.
 * @returns {(err: Error) => boolean}
 */
function retryPolicy(options) {
    const retryServerErrors = !!(options && options.retryServerErrors);
    return function isFinal(err) {
        if (isConnectionError(err)) return false;
        if (retryServerErrors && isServerError(err)) return false;
        return true;
    };
}

/**
 * Run `attempt()` up to `retryAttempts` times with a linearly growing delay
 * (`retryDelay * n`). Client errors are never retried: a bad request stays bad.
 *
 * @param {() => Promise<*>} attempt
 * @param {Object} options
 * @param {number} options.retryAttempts
 * @param {number} options.retryDelay  Base delay in ms.
 * @param {(err: Error) => boolean} [options.isFinal=isClientError]
 *        Return true for errors that must not be retried. See `retryPolicy`
 *        for the predicate the bridges use.
 * @returns {Promise<*>}
 */
async function withRetry(attempt, options) {
    const isFinal = typeof options.isFinal === "function" ? options.isFinal : isClientError;
    let lastError;

    for (let n = 0; n < options.retryAttempts; n++) {
        try {
            return await attempt();
        } catch (err) {
            lastError = err;
            if (isFinal(err)) {
                throw err;
            }
            if (n < options.retryAttempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, options.retryDelay * (n + 1)));
            }
        }
    }

    throw lastError;
}

module.exports = {
    requestJson,
    withRetry,
    retryPolicy,
    isClientError,
    isServerError,
    isConnectionError,
    isTimeoutError,
    DEFAULT_MAX_RESPONSE_BYTES,
    TIMEOUT_CODE,
    RESPONSE_TOO_LARGE_CODE
};
