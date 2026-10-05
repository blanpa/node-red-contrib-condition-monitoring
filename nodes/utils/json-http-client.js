/**
 * JSON-over-HTTP client helpers
 * =============================
 *
 * The request/retry plumbing shared by the two HTTP inference bridges
 * (`max-bridge-manager.js` → MAX Engine server, `remote-python-bridge.js` →
 * inference container). Both speak small JSON documents over plain
 * http/https, want a per-request timeout, and retry transport and 5xx
 * failures but never a 4xx.
 *
 * The bridges keep what genuinely differs between them — statistics, sharding,
 * events and the shape of what they return — and delegate the wire work here.
 *
 * @module utils/json-http-client
 */

"use strict";

/**
 * @typedef {Object} JsonRequestOptions
 * @property {Object}  protocol   `require("http")` or `require("https")`.
 * @property {string}  hostname
 * @property {number|string} port
 * @property {string}  method
 * @property {string}  path
 * @property {*}       [data]     JSON-serialisable request body (omitted when falsy).
 * @property {number}  timeoutMs  Socket timeout.
 * @property {string}  [timeoutMessage="Request timeout"]
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
 * server/transport failure without parsing message strings.
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

        const payload = options.data ? Buffer.from(JSON.stringify(options.data)) : null;
        const headers = { Accept: "application/json" };
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
                let body = "";
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () => {
                    report(res.statusCode < 400);

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
            reject(new Error(options.timeoutMessage || "Request timeout"));
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

/**
 * Run `attempt()` up to `retryAttempts` times with a linearly growing delay
 * (`retryDelay * n`). Client errors are never retried: a bad request stays bad.
 *
 * @param {() => Promise<*>} attempt
 * @param {Object} options
 * @param {number} options.retryAttempts
 * @param {number} options.retryDelay  Base delay in ms.
 * @param {(err: Error) => boolean} [options.isFinal=isClientError]
 *        Return true for errors that must not be retried.
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
    isClientError
};
