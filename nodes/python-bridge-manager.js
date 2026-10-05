/**
 * Python Bridge Manager
 * =====================
 *
 * Manages a persistent Python subprocess for ML inference.
 * Instead of spawning a new Python process for each inference,
 * this maintains a single long-running process and communicates via JSON over stdin/stdout.
 *
 * Performance improvement: ~10-100x faster inference for repeated calls.
 */

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const EventEmitter = require("events");

class PythonBridgeManager extends EventEmitter {
    constructor(options = {}) {
        super();

        this.pythonPath = options.pythonPath || "python3";
        this.bridgeScript = options.bridgeScript || path.join(__dirname, "python", "python_bridge.py");
        this.startupTimeout = options.startupTimeout || 30000;
        this.requestTimeout = options.requestTimeout || 60000;

        this.process = null;
        this.isReady = false;
        this.isShuttingDown = false;
        this.pendingRequests = new Map(); // id -> { resolve, reject, timeout }
        this.requestCounter = 0;
        this.readline = null;

        // Stats
        this.stats = {
            requestsProcessed: 0,
            errors: 0,
            avgResponseTime: 0,
            lastResponseTime: null
        };
    }

    /**
     * Start the Python bridge subprocess
     */
    async start() {
        if (this.process) {
            return; // Already started
        }

        return new Promise((resolve, reject) => {
            // Listen for the ready signal BEFORE spawning: a bridge that
            // prints its ready line within the spawn settle window would
            // otherwise never be seen and start() would always time out.
            let readyTimeout = null;
            // A child that dies before it signals ready (import error, bad
            // interpreter) must fail start() right away, not after the full
            // startup timeout.
            const onEarlyExit = (info) => {
                if (readyTimeout) clearTimeout(readyTimeout);
                this.removeListener("response", checkReady);
                this.removeListener("processExit", onEarlyExit);
                reject(
                    new Error(
                        "Python bridge exited during startup (code " +
                            info.code +
                            (info.signal ? ", signal " + info.signal : "") +
                            ")"
                    )
                );
            };
            const checkReady = (response) => {
                if (response.id === "ready" && response.success) {
                    if (readyTimeout) clearTimeout(readyTimeout);
                    this.removeListener("response", checkReady);
                    this.removeListener("processExit", onEarlyExit);
                    this.isReady = true;
                    this.emit("ready", response.result);
                    resolve(response.result);
                }
            };
            this.on("response", checkReady);

            // Honor an explicitly configured interpreter, then fall back.
            const candidates = [...new Set([this.pythonPath, "python3", "python"].filter(Boolean))];
            this._tryStart(candidates, 0, (err, pythonPath) => {
                if (err) {
                    this.removeListener("response", checkReady);
                    reject(err);
                    return;
                }

                this.pythonPath = pythonPath;

                // The ready line may already have arrived during the settle
                // window — only arm the timeout if we are still waiting.
                if (!this.isReady) {
                    this.on("processExit", onEarlyExit);
                    readyTimeout = setTimeout(() => {
                        this.removeListener("response", checkReady);
                        this.removeListener("processExit", onEarlyExit);
                        // The bridge never signalled ready, so a graceful shutdown
                        // (which writes a "shutdown" command to stdin and waits) is
                        // pointless and could leave the process running. Kill the
                        // spawned process directly instead.
                        const proc = this.process;
                        if (proc) {
                            try {
                                proc.kill("SIGKILL");
                            } catch (e) {
                                // Process may already be gone
                            }
                        }
                        if (this.readline) {
                            this.readline.close();
                            this.readline = null;
                        }
                        this.process = null;
                        this.isReady = false;
                        reject(new Error("Python bridge startup timeout"));
                    }, this.startupTimeout);
                }
            });
        });
    }

    /**
     * Try starting Python with different commands
     */
    _tryStart(pythonCandidates, index, callback) {
        if (index >= pythonCandidates.length) {
            callback(new Error("Python not found. Install Python 3 with ML packages."));
            return;
        }

        const pythonPath = pythonCandidates[index];

        try {
            // Every handler below closes over `proc`, never `this.process`:
            // a late event from an old child must not touch the state of a
            // bridge that has since been restarted.
            const proc = spawn(pythonPath, [this.bridgeScript], {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, PYTHONUNBUFFERED: "1" }
            });
            this.process = proc;

            // Writes to a dying child fail asynchronously with EPIPE on the
            // stdin stream. Without a listener that is an unhandled 'error'
            // event, i.e. a crash of the whole Node-RED process.
            proc.stdin.on("error", (err) => {
                if (this.process !== proc) return;
                this._rejectAllPending(new Error("Python bridge stdin error: " + err.message));
            });

            // Set up readline for stdout
            this.readline = readline.createInterface({
                input: proc.stdout,
                crlfDelay: Infinity
            });

            this.readline.on("line", (line) => {
                this._handleResponse(line);
            });

            // Handle stderr (for debugging)
            proc.stderr.on("data", (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    this.emit("stderr", msg);
                }
            });

            // Handle process exit
            proc.on("exit", (code, signal) => {
                // stop() already detached this child (or a newer one took
                // its place): nothing of the current state belongs to it.
                if (this.process !== proc) return;

                this.isReady = false;
                this.process = null;

                this._rejectAllPending(new Error(`Python bridge exited with code ${code}`));

                // Internal: lets start() fail fast on an early death.
                this.emit("processExit", { code, signal });

                if (!this.isShuttingDown) {
                    this.emit("exit", { code, signal });
                }
            });

            // Each candidate attempt settles exactly once: either the spawn
            // error advances to the next candidate, or the settle timer
            // accepts this one. Without the guard, a late error event could
            // invoke the callback a second time with a stale pythonPath.
            let settled = false;

            proc.on("error", () => {
                // Process failed to start, try next python candidate
                if (this.process === proc) this.process = null;
                if (settled) return;
                settled = true;
                clearTimeout(settleTimer);
                this._tryStart(pythonCandidates, index + 1, callback);
            });

            // If we get here without error, the process started
            // Wait a moment to ensure it's running
            const settleTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                if (this.process === proc && !proc.killed) {
                    callback(null, pythonPath);
                } else {
                    this._tryStart(pythonCandidates, index + 1, callback);
                }
            }, 100);
        } catch (err) {
            this._tryStart(pythonCandidates, index + 1, callback);
        }
    }

    /**
     * Handle a response line from Python
     */
    _handleResponse(line) {
        let response;
        try {
            response = JSON.parse(line);
        } catch (err) {
            response = null;
        }
        if (!response || typeof response !== "object") {
            // Not a protocol line — a library printed to stdout. That is noise,
            // not a failure: report it, but never as a bare 'error' event,
            // which throws (and takes Node-RED down) when nobody listens.
            const protocolError = new Error(`Failed to parse response: ${line}`);
            this.emit("protocolError", protocolError);
            if (this.listenerCount("error") > 0) {
                this.emit("error", protocolError);
            }
            return;
        }

        const id = response.id;

        // Emit for general listeners
        this.emit("response", response);

        // Resolve pending request
        if (this.pendingRequests.has(id)) {
            const pending = this.pendingRequests.get(id);
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(id);

            // Update stats
            this.stats.requestsProcessed++;
            this.stats.lastResponseTime = Date.now() - pending.startTime;
            this.stats.avgResponseTime =
                (this.stats.avgResponseTime * (this.stats.requestsProcessed - 1) + this.stats.lastResponseTime) /
                this.stats.requestsProcessed;

            if (response.success) {
                pending.resolve(response.result);
            } else {
                this.stats.errors++;
                pending.reject(new Error(response.error || "Unknown error"));
            }
        }
    }

    /**
     * Reject every in-flight request (process died, pipe broke, bridge stopped).
     */
    _rejectAllPending(err) {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(err);
        }
        this.pendingRequests.clear();
    }

    /**
     * Send a command to Python and wait for response
     */
    async sendCommand(command, params = {}) {
        if (!this.isReady) {
            throw new Error("Python bridge not ready");
        }
        if (!command || typeof command !== "string") {
            throw new Error("command must be a non-empty string");
        }

        const id = `req_${++this.requestCounter}`;
        const message = JSON.stringify({ id, command, ...params }) + "\n";

        return new Promise((resolve, reject) => {
            const startTime = Date.now();

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timeout: ${command}`));
            }, this.requestTimeout);

            this.pendingRequests.set(id, { resolve, reject, timeout, startTime });

            try {
                this.process.stdin.write(message);
            } catch (err) {
                clearTimeout(timeout);
                this.pendingRequests.delete(id);
                reject(err);
            }
        });
    }

    /**
     * Load a model
     */
    async loadModel(modelPath, modelId = null) {
        if (!modelPath || typeof modelPath !== "string") {
            throw new Error("modelPath must be a non-empty string");
        }
        return this.sendCommand("load_model", { model_path: modelPath, model_id: modelId });
    }

    /**
     * Run inference
     */
    async predict(modelId, inputData) {
        if (!modelId || typeof modelId !== "string") {
            throw new Error("modelId must be a non-empty string");
        }
        if (!Array.isArray(inputData)) {
            throw new Error("inputData must be an array");
        }
        return this.sendCommand("predict", { model_id: modelId, input_data: inputData });
    }

    /**
     * Unload a model
     */
    async unloadModel(modelId) {
        return this.sendCommand("unload_model", { model_id: modelId });
    }

    /**
     * Get status
     */
    async getStatus() {
        return this.sendCommand("status");
    }

    /**
     * Ping to check if bridge is alive
     */
    async ping() {
        return this.sendCommand("ping");
    }

    /**
     * Stop the Python bridge
     */
    async stop() {
        if (!this.process) {
            return;
        }

        this.isShuttingDown = true;

        try {
            await this.sendCommand("shutdown");
        } catch (err) {
            // Ignore errors during shutdown
        }

        // Give it a moment to shutdown gracefully
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (this.process) {
            // Capture the reference: this.process is nulled below, so the
            // force-kill fallback must not depend on it.
            const proc = this.process;
            try {
                proc.kill("SIGTERM");
            } catch (e) {
                // Process may already be gone
            }

            // Force kill after 2 seconds if SIGTERM didn't end it
            const killTimer = setTimeout(() => {
                if (proc.exitCode === null && !proc.killed) {
                    proc.kill("SIGKILL");
                }
            }, 2000);
            if (killTimer.unref) killTimer.unref();
        }

        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }

        // Detaching the child here makes its (possibly late) exit event a
        // no-op, so anything still pending has to be settled now.
        this.process = null;
        this.isReady = false;
        this._rejectAllPending(new Error("Python bridge stopped"));
        this.isShuttingDown = false;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            isReady: this.isReady,
            pendingRequests: this.pendingRequests.size
        };
    }
}

// Singleton instance for shared use across nodes
let globalBridge = null;

/**
 * Get or create the global Python bridge instance.
 *
 * Transport is chosen once, at first use:
 * - If `CM_INFERENCE_URL` is set, return a RemotePythonBridge that talks to a
 *   separate inference container (nodes/python/inference_server.py) over HTTP.
 *   This keeps the ML runtime out of the Node-RED process/image.
 * - Otherwise return the in-process subprocess bridge (default, unchanged).
 *
 * Both expose the same async surface (start/loadModel/predict/unloadModel/stop),
 * so ml-inference's keras/sklearn/tflite paths work either way.
 */
function getGlobalBridge() {
    if (!globalBridge) {
        const remoteUrl = process.env.CM_INFERENCE_URL;
        if (remoteUrl) {
            const { RemotePythonBridge } = require("./remote-python-bridge");
            globalBridge = new RemotePythonBridge({ serverUrl: remoteUrl });
        } else {
            globalBridge = new PythonBridgeManager();
        }
    }
    return globalBridge;
}

/**
 * Shutdown the global bridge (call on Node-RED shutdown)
 */
async function shutdownGlobalBridge() {
    // Drop the singleton BEFORE awaiting: stop() takes half a second or more,
    // and a caller arriving in that window must get a fresh bridge instead of
    // the one that is on its way out.
    const bridge = globalBridge;
    globalBridge = null;
    if (bridge) {
        await bridge.stop();
    }
}

module.exports = {
    PythonBridgeManager,
    getGlobalBridge,
    shutdownGlobalBridge
};
