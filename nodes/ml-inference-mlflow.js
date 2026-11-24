/**
 * ml-inference MLflow client
 * ==========================
 *
 * The MLflow REST plumbing of the ml-inference node: the small JSON request
 * helper used for the model registry (also by the admin routes) and the
 * `MLflowTracker` that logs inference metrics to an MLflow tracking server.
 *
 * Split out of `ml-inference.js` as a pure move — no node state lives here.
 * Not a node: it is not registered in package.json.
 *
 * @module ml-inference-mlflow
 */

"use strict";

const https = require("https");
const http = require("http");

/**
 * @param {Object} RED  The Node-RED runtime (only `RED.log` is used).
 * @returns {{ mlflowApiRequest: Function, MLflowTracker: Function }}
 */
module.exports = function createMlflowClient(RED) {
    // MLflow Registry API
    // Minimal MLflow REST request helper: picks http/https from the URL scheme
    // (registry URIs are commonly plain http, e.g. http://mlflow-server:5000)
    // and supports both GET (with query params) and POST (with a JSON body).
    // MLflow's registry API returns small JSON control-plane payloads; these
    // bounds keep a hostile or wedged endpoint from stalling/exhausting the runtime.
    const MAX_MLFLOW_RESPONSE_BYTES = 8 * 1024 * 1024;
    const MLFLOW_TIMEOUT_MS = 15000;

    function mlflowApiRequest(url, method, token, body) {
        return new Promise((resolve, reject) => {
            const isHttps = url.startsWith("https");
            const protocol = isHttps ? https : http;
            const urlObj = new URL(url);
            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: { "Content-Type": "application/json" }
            };
            if (token) options.headers["Authorization"] = "Bearer " + token;

            const req = protocol.request(options, (res) => {
                let data = "";
                let overflow = false;
                res.on("data", (chunk) => {
                    if (overflow) return;
                    data += chunk;
                    // JSON control-plane responses are small; refuse to buffer a
                    // hostile or misconfigured endpoint's unbounded stream.
                    if (data.length > MAX_MLFLOW_RESPONSE_BYTES) {
                        overflow = true;
                        res.destroy();
                        reject(new Error("MLflow response exceeds " + MAX_MLFLOW_RESPONSE_BYTES + " bytes"));
                    }
                });
                res.on("end", () => {
                    if (overflow) return;
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : {});
                        } catch (e) {
                            reject(new Error("Invalid JSON response from MLflow"));
                        }
                    } else {
                        reject(new Error(`MLflow API error: ${res.statusCode} ${res.statusMessage}`));
                    }
                });
            });
            req.on("error", reject);
            req.setTimeout(MLFLOW_TIMEOUT_MS, () => {
                req.destroy(new Error("MLflow request timed out after " + MLFLOW_TIMEOUT_MS + "ms"));
            });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    // ========================================
    // MLflow Tracking API - Performance Logging
    // ========================================

    /**
     * MLflow Tracking Manager - handles experiment/run lifecycle and metric logging
     */
    class MLflowTracker {
        constructor(trackingUri, experimentName, token) {
            this.trackingUri = trackingUri ? trackingUri.replace(/\/$/, "") : "";
            this.experimentName = experimentName || "node-red-ml-inference";
            this.token = token || "";
            this.experimentId = null;
            this.runId = null;
            this.metricsBuffer = [];
            this.bufferSize = 100; // Batch size for metric logging
            this.flushInterval = null;
            this.enabled = !!this.trackingUri;
            this.stepCounter = 0;
        }

        /**
         * Make HTTP request to MLflow API
         */
        async _request(method, endpoint, data = null) {
            if (!this.enabled) return null;

            return new Promise((resolve, reject) => {
                const url = `${this.trackingUri}${endpoint}`;
                const isHttps = url.startsWith("https");
                const protocol = isHttps ? https : http;

                const urlObj = new URL(url);
                const options = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || (isHttps ? 443 : 80),
                    path: urlObj.pathname + urlObj.search,
                    method: method,
                    headers: {
                        "Content-Type": "application/json"
                    }
                };

                if (this.token) {
                    options.headers["Authorization"] = "Bearer " + this.token;
                }

                const req = protocol.request(options, (res) => {
                    let responseData = "";
                    res.on("data", (chunk) => (responseData += chunk));
                    res.on("end", () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(responseData ? JSON.parse(responseData) : {});
                            } catch (e) {
                                resolve({});
                            }
                        } else {
                            reject(new Error(`MLflow API error: ${res.statusCode} - ${responseData}`));
                        }
                    });
                });

                req.on("error", reject);
                // Tracking is best effort: a black-holed MLflow host must not
                // hold a request (and with it a node's close handler) forever.
                req.setTimeout(MLFLOW_TIMEOUT_MS, () => {
                    req.destroy(new Error("MLflow request timed out after " + MLFLOW_TIMEOUT_MS + "ms"));
                });

                if (data) {
                    req.write(JSON.stringify(data));
                }
                req.end();
            });
        }

        /**
         * Get or create experiment by name
         */
        async getOrCreateExperiment() {
            if (!this.enabled) return null;

            try {
                // Try to get existing experiment
                const searchResult = await this._request(
                    "GET",
                    `/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(this.experimentName)}`
                );

                if (searchResult && searchResult.experiment) {
                    this.experimentId = searchResult.experiment.experiment_id;
                    return this.experimentId;
                }
            } catch (e) {
                // Experiment doesn't exist, create it
            }

            try {
                const createResult = await this._request("POST", "/api/2.0/mlflow/experiments/create", {
                    name: this.experimentName,
                    tags: [
                        { key: "source", value: "node-red-ml-inference" },
                        { key: "created_at", value: new Date().toISOString() }
                    ]
                });

                if (createResult && createResult.experiment_id) {
                    this.experimentId = createResult.experiment_id;
                    return this.experimentId;
                }
            } catch (e) {
                RED.log.warn("[MLflowTracker] Failed to create experiment: " + e.message);
            }

            return null;
        }

        /**
         * Start a new MLflow run for this node instance
         */
        async startRun(runName, tags = {}) {
            if (!this.enabled) return null;

            if (!this.experimentId) {
                await this.getOrCreateExperiment();
            }

            if (!this.experimentId) return null;

            try {
                const runTags = [
                    { key: "mlflow.runName", value: runName },
                    { key: "node_red.node_type", value: "ml-inference" },
                    { key: "node_red.start_time", value: new Date().toISOString() }
                ];

                // Add custom tags
                for (const [key, value] of Object.entries(tags)) {
                    runTags.push({ key: `node_red.${key}`, value: String(value) });
                }

                const result = await this._request("POST", "/api/2.0/mlflow/runs/create", {
                    experiment_id: this.experimentId,
                    start_time: Date.now(),
                    tags: runTags
                });

                if (result && result.run) {
                    this.runId = result.run.info.run_id;
                    this.stepCounter = 0;

                    // Start periodic flush
                    this._startFlushInterval();

                    return this.runId;
                }
            } catch (e) {
                RED.log.warn("[MLflowTracker] Failed to start run: " + e.message);
            }

            return null;
        }

        /**
         * Log a single metric (buffered)
         */
        logMetric(key, value, step = null) {
            if (!this.enabled || !this.runId) return;

            const metric = {
                key: key,
                value: typeof value === "number" ? value : parseFloat(value) || 0,
                timestamp: Date.now(),
                step: step !== null ? step : this.stepCounter++
            };

            this.metricsBuffer.push(metric);

            // Flush if buffer is full
            if (this.metricsBuffer.length >= this.bufferSize) {
                this.flush();
            }
        }

        /**
         * Log multiple metrics at once (buffered)
         */
        logMetrics(metrics, step = null) {
            if (!this.enabled || !this.runId) return;

            const currentStep = step !== null ? step : this.stepCounter++;

            for (const [key, value] of Object.entries(metrics)) {
                this.metricsBuffer.push({
                    key: key,
                    value: typeof value === "number" ? value : parseFloat(value) || 0,
                    timestamp: Date.now(),
                    step: currentStep
                });
            }

            if (this.metricsBuffer.length >= this.bufferSize) {
                this.flush();
            }
        }

        /**
         * Log parameters (not buffered - immediate)
         */
        async logParams(params) {
            if (!this.enabled || !this.runId) return;

            const paramList = [];
            for (const [key, value] of Object.entries(params)) {
                paramList.push({ key: key, value: String(value).substring(0, 500) }); // MLflow limit
            }

            try {
                await this._request("POST", "/api/2.0/mlflow/runs/log-batch", {
                    run_id: this.runId,
                    params: paramList
                });
            } catch (e) {
                RED.log.debug("[MLflowTracker] Failed to log params: " + e.message);
            }
        }

        /**
         * Flush metrics buffer to MLflow
         */
        async flush() {
            if (!this.enabled || !this.runId || this.metricsBuffer.length === 0) return;

            const metricsToSend = [...this.metricsBuffer];
            this.metricsBuffer = [];

            try {
                await this._request("POST", "/api/2.0/mlflow/runs/log-batch", {
                    run_id: this.runId,
                    metrics: metricsToSend
                });
            } catch (e) {
                RED.log.debug("[MLflowTracker] Failed to flush metrics: " + e.message);
                // Re-add metrics to buffer on failure (up to limit)
                this.metricsBuffer = [...metricsToSend.slice(-50), ...this.metricsBuffer].slice(0, this.bufferSize * 2);
            }
        }

        /**
         * Start periodic flush interval
         */
        _startFlushInterval() {
            if (this.flushInterval) return;

            // Flush every 10 seconds
            this.flushInterval = setInterval(() => {
                this.flush();
            }, 10000);
            if (this.flushInterval.unref) {
                this.flushInterval.unref();
            }
        }

        /**
         * End the current run
         */
        async endRun(status = "FINISHED") {
            if (!this.enabled || !this.runId) return;

            // Stop flush interval first: the awaits below may take a while
            // (or never return), and the timer must not outlive the run.
            if (this.flushInterval) {
                clearInterval(this.flushInterval);
                this.flushInterval = null;
            }

            // Final flush
            await this.flush();

            try {
                await this._request("POST", "/api/2.0/mlflow/runs/update", {
                    run_id: this.runId,
                    status: status,
                    end_time: Date.now()
                });
            } catch (e) {
                RED.log.debug("[MLflowTracker] Failed to end run: " + e.message);
            }

            this.runId = null;
        }

        /**
         * Clean up resources
         */
        destroy() {
            if (this.flushInterval) {
                clearInterval(this.flushInterval);
                this.flushInterval = null;
            }
            this.endRun("KILLED");
        }
    }

    return {
        mlflowApiRequest: mlflowApiRequest,
        MLflowTracker: MLflowTracker
    };
};
