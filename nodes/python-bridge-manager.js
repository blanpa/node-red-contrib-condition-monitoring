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

// Defaults for the crash guard and the backpressure cap (see the constructor).
const DEFAULT_CRASH_BACKOFF_MS = 30000;
const DEFAULT_MAX_CRASH_RESTARTS = 5;
const DEFAULT_CRASH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;

/**
 * Record of the crashes of one logical bridge. It lives outside the instance
 * on purpose: ml-inference drops the singleton on every `exit`
 * (forgetPythonBridge → shutdownGlobalBridge), so the next predict() gets a
 * brand-new PythonBridgeManager — an instance field would start from zero
 * with every respawn, which is exactly the storm this guards against.
 */
function createCrashLedger() {
    return { lastCrashAt: 0, crashes: [] };
}

class PythonBridgeManager extends EventEmitter {
    constructor(options = {}) {
        super();

        this.pythonPath = options.pythonPath || "python3";
        this.bridgeScript = options.bridgeScript || path.join(__dirname, "python", "python_bridge.py");
        this.startupTimeout = options.startupTimeout || 30000;
        this.requestTimeout = options.requestTimeout || 60000;

        // Backpressure: the Python loop is single-threaded and cannot cancel a
        // request Node has already given up on, so every timed-out request is
        // still executed. Beyond this many in-flight requests, sendCommand()
        // rejects immediately (EBUSY) instead of growing the backlog.
        this.maxPendingRequests =
            typeof options.maxPendingRequests === "number" ? options.maxPendingRequests : DEFAULT_MAX_PENDING_REQUESTS;

        // Crash guard. A model that segfaults the interpreter on load or on
        // predict would otherwise cost one respawn (a full TensorFlow import)
        // per incoming message: after a crash the next start() is refused for
        // `crashBackoffMs`, and after `maxCrashRestarts` crashes within
        // `crashWindowMs` it stays refused until the window has passed (or
        // Node-RED is restarted).
        this.crashBackoffMs =
            typeof options.crashBackoffMs === "number" ? options.crashBackoffMs : DEFAULT_CRASH_BACKOFF_MS;
        this.maxCrashRestarts =
            typeof options.maxCrashRestarts === "number" ? options.maxCrashRestarts : DEFAULT_MAX_CRASH_RESTARTS;
        this.crashWindowMs =
            typeof options.crashWindowMs === "number" ? options.crashWindowMs : DEFAULT_CRASH_WINDOW_MS;
        this.crashLedger = options.crashLedger || createCrashLedger();

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
     * Note a crash of a bridge that had been ready. Trims the ledger to the
     * crash window so an old, unrelated crash does not count forever.
     */
    _recordCrash(now = Date.now()) {
        const ledger = this.crashLedger;
        ledger.lastCrashAt = now;
        ledger.crashes = ledger.crashes.filter((t) => now - t < this.crashWindowMs);
        ledger.crashes.push(now);
    }

    /**
     * The error that forbids a restart right now, or null. Checked by start().
     */
    _restartRefusal(now = Date.now()) {
        const ledger = this.crashLedger;
        if (!ledger.lastCrashAt) return null;

        const recent = ledger.crashes.filter((t) => now - t < this.crashWindowMs);
        if (this.maxCrashRestarts > 0 && recent.length >= this.maxCrashRestarts) {
            const waitMs = this.crashWindowMs - (now - ledger.lastCrashAt);
            const err = new Error(
                `Python bridge crashed ${recent.length} times within ${Math.round(this.crashWindowMs / 60000)} min; ` +
                    `not restarting it for another ${Math.ceil(waitMs / 1000)} s ` +
                    "(check the model and the Python stderr log, or restart Node-RED to retry now)"
            );
            err.code = "EBRIDGELOCKOUT";
            return err;
        }

        const sinceCrash = now - ledger.lastCrashAt;
        if (sinceCrash < this.crashBackoffMs) {
            const err = new Error(
                `Python bridge crashed ${Math.round(sinceCrash / 1000)} s ago; ` +
                    `not restarting it for another ${Math.ceil((this.crashBackoffMs - sinceCrash) / 1000)} s`
            );
            err.code = "EBRIDGEBACKOFF";
            return err;
        }
        return null;
    }

    /** Forget earlier crashes (a deliberate, clean stop ends the series). */
    resetCrashLedger() {
        this.crashLedger.lastCrashAt = 0;
        this.crashLedger.crashes = [];
    }

    /**
     * Start the Python bridge subprocess
     */
    async start() {
        if (this.process) {
            return; // Already started
        }

        const refusal = this._restartRefusal();
        if (refusal) {
            throw refusal;
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

                // A death after ready is a crash and arms the restart
                // backoff. A death before ready is a start() failure, which
                // the caller already backs off on its own.
                if (this.isReady && !this.isShuttingDown) {
                    this._recordCrash();
                }

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
        if (this.maxPendingRequests > 0 && this.pendingRequests.size >= this.maxPendingRequests) {
            const busy = new Error(
                `Python bridge busy: ${this.pendingRequests.size} requests pending (limit ${this.maxPendingRequests})`
            );
            busy.code = "EBUSY";
            throw busy;
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
        // A deliberate stop of a running bridge (deploy, runtime shutdown) is
        // not a crash: the next start is a fresh series.
        this.resetCrashLedger();

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

// Crash history of the shared subprocess bridge; survives the singleton being
// dropped and recreated after a crash (see createCrashLedger).
const globalCrashLedger = createCrashLedger();

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
            globalBridge = new PythonBridgeManager({ crashLedger: globalCrashLedger });
        }
    }
    return globalBridge;
}

/** Forget the shared bridge's crash history (tests; an explicit operator reset). */
function resetGlobalCrashLedger() {
    globalCrashLedger.lastCrashAt = 0;
    globalCrashLedger.crashes = [];
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
    createCrashLedger,
    getGlobalBridge,
    shutdownGlobalBridge,
    resetGlobalCrashLedger
};
