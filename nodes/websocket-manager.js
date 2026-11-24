/**
 * WebSocket Manager for Real-Time Dashboards
 * ===========================================
 *
 * Provides WebSocket server for broadcasting anomaly detection results
 * to external dashboards and monitoring systems in real-time.
 *
 * Features:
 * - Singleton WebSocket server shared across nodes
 * - Topic-based subscriptions
 * - Automatic reconnection handling
 * - Statistics and health monitoring
 * - JSON message broadcasting
 */

"use strict";

const EventEmitter = require("events");
const crypto = require("crypto");

// Try to load ws module (optional dependency)
let WebSocketServer = null;
try {
    WebSocketServer = require("ws").Server;
} catch (err) {
    // ws module not installed
}

/**
 * Constant-time string comparison. Returns true only if both strings have the
 * same content. Designed to avoid leaking the token via timing differences
 * when an attacker probes multiple values.
 *
 * Both sides are hashed first so the comparison is always over two equal-size
 * digests: an early return on a length mismatch would tell a probing client
 * how long the token is.
 */
function timingSafeEqualStrings(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ha = crypto.createHash("sha256").update(a, "utf8").digest();
    const hb = crypto.createHash("sha256").update(b, "utf8").digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Broadcast backpressure. ws.send() never throws while the socket is OPEN; a
// client that stops reading simply accumulates every frame in process memory.
// Frames are skipped for a client whose outbound buffer is above the byte
// threshold, and a client that stays behind for this many broadcasts in a row
// is terminated.
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONSECUTIVE_SKIPS = 10;

// stop(): clients get this long to answer the close handshake before they are
// terminated. ws waits 30 s on its own, twice Node-RED's node close timeout.
const DEFAULT_CLOSE_GRACE_MS = 1000;

const WS_OPEN = 1;
const WS_CLOSED = 3;

class WebSocketManager extends EventEmitter {
    /**
     * @param {Object} options - Configuration options
     * @param {number} options.port - WebSocket server port (default: 1881)
     * @param {string} options.path - WebSocket path (default: /ws/condition-monitoring)
     * @param {number} options.heartbeatInterval - Heartbeat interval in ms (default: 30000)
     * @param {string|null} [options.authToken=null]
     *        Optional shared secret. When set, every connecting client must present the
     *        same token via either:
     *          - the `?token=...` query parameter on the WebSocket URL, or
     *          - the `Sec-WebSocket-Protocol` header (handy when the URL is logged).
     *        Connections without a matching token are closed with code 4401.
     * @param {string[]|null} [options.allowedOrigins=null]
     *        Optional list of allowed `Origin` header values. When set, browsers
     *        served from any other origin are refused (CSWSH protection).
     * @param {number} [options.maxClients=100]
     *        Maximum concurrent connections. Excess connections are closed with
     *        code 4009 so a misbehaving client cannot exhaust server memory.
     * @param {number} [options.maxMessageSize=65536]
     *        Maximum inbound message size in bytes (ws `maxPayload`). Larger
     *        frames close the connection with code 1009.
     * @param {number} [options.maxBufferedBytes=1048576]
     *        Broadcasts are skipped for a client whose outbound buffer
     *        (`ws.bufferedAmount`) is above this many bytes.
     * @param {number} [options.maxConsecutiveSkips=10]
     *        A client skipped this many broadcasts in a row is terminated.
     * @param {number} [options.closeGraceMs=1000]
     *        How long stop() waits for clients to answer the close handshake
     *        before terminating them.
     */
    constructor(options = {}) {
        super();

        const positiveInt = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);

        this.port = options.port || 1881;
        this.path = options.path || "/ws/condition-monitoring";
        this.heartbeatInterval = options.heartbeatInterval || 30000;
        this.maxClients = positiveInt(options.maxClients, 100);
        this.maxMessageSize = positiveInt(options.maxMessageSize, 65536);
        this.maxBufferedBytes = positiveInt(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES);
        this.maxConsecutiveSkips = positiveInt(options.maxConsecutiveSkips, DEFAULT_MAX_CONSECUTIVE_SKIPS);
        this.closeGraceMs = positiveInt(options.closeGraceMs, DEFAULT_CLOSE_GRACE_MS);
        // Cap per-client subscription sets so subscribe-spam with unique
        // topics cannot grow memory without bound.
        this.maxSubscriptionsPerClient = 256;
        this.authToken =
            typeof options.authToken === "string" && options.authToken.length > 0 ? options.authToken : null;
        this.allowedOrigins =
            Array.isArray(options.allowedOrigins) && options.allowedOrigins.length > 0
                ? options.allowedOrigins.slice()
                : null;

        this.server = null;
        this.clients = new Map(); // clientId -> { ws, subscriptions, lastPing }
        this.clientCounter = 0;
        this.heartbeatTimer = null;
        this.isRunning = false;
        // In-flight start(): several nodes share this manager and call start()
        // in the same tick, long before 'listening' flips isRunning.
        this.startPromise = null;

        // Statistics
        this.stats = {
            messagesPublished: 0,
            messagesSent: 0,
            // Broadcasts withheld from a client whose outbound buffer was full,
            // and clients terminated for staying behind (see broadcast()).
            messagesSkipped: 0,
            clientsDroppedBackpressure: 0,
            clientsTotal: 0,
            clientsCurrent: 0,
            errors: 0,
            startTime: null
        };
    }

    /**
     * Start the WebSocket server
     */
    start() {
        if (!WebSocketServer) {
            throw new Error('WebSocket support requires the "ws" package. Install with: npm install ws');
        }

        if (this.isRunning) {
            return Promise.resolve();
        }
        // A start is already under way: hand every caller the same promise
        // instead of opening a second server on the same port (EADDRINUSE).
        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = new Promise((resolve, reject) => {
            try {
                const wsServerOptions = {
                    port: this.port,
                    path: this.path,
                    maxPayload: this.maxMessageSize
                };
                // Origin allowlist: enforced *before* the WS upgrade completes.
                // (Token auth is enforced post-upgrade in _authorize so the client
                // receives an explicit 4401 close code with a reason, rather than a
                // bare HTTP 401 / abnormal-close at the handshake layer.)
                if (this.allowedOrigins) {
                    wsServerOptions.verifyClient = (info) => {
                        const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin);
                        if (!origin) return false;
                        return this.allowedOrigins.indexOf(origin) !== -1;
                    };
                }
                const server = new WebSocketServer(wsServerOptions);
                this.server = server;

                server.on("listening", () => {
                    this.isRunning = true;
                    this.startPromise = null;
                    this.stats.startTime = Date.now();
                    this._startHeartbeat();
                    this.emit("started", { port: this.port, path: this.path });
                    resolve();
                });

                server.on("connection", (ws, req) => {
                    if (!this._authorize(ws, req)) {
                        // _authorize already closed the socket and bumped stats.errors
                        return;
                    }
                    this._handleConnection(ws, req);
                });

                server.on("error", (err) => {
                    this.stats.errors++;
                    if (!this.isRunning) {
                        // Failed to come up (port in use, EACCES…). Settle the
                        // caller first and drop the dead server so a later
                        // start() can try again.
                        if (this.server === server) this.server = null;
                        this.startPromise = null;
                        try {
                            server.close();
                        } catch (_) {
                            /* never listened */
                        }
                        reject(err);
                    }
                    // A bare 'error' emit throws when nobody listens, which
                    // would turn a busy port into a crash of the whole runtime.
                    if (this.listenerCount("error") > 0) {
                        this.emit("error", err);
                    }
                });
            } catch (err) {
                this.startPromise = null;
                reject(err);
            }
        });
        return this.startPromise;
    }

    /**
     * Authorize an incoming connection. Closes the socket on failure and returns false.
     *
     * Token sources, in order of preference:
     *   1. `Sec-WebSocket-Protocol` header (`?token=foo` would be logged in proxies).
     *   2. URL query parameter `?token=foo`.
     *
     * Tokens are compared with a constant-time comparator to avoid timing oracles.
     */
    _extractToken(req) {
        if (!req) return null;
        let presented = null;
        const subProto = req.headers && req.headers["sec-websocket-protocol"];
        if (typeof subProto === "string" && subProto.length > 0) {
            presented = subProto.split(",")[0].trim();
        }
        if (!presented && req.url) {
            try {
                const u = new URL(req.url, "ws://localhost");
                presented = u.searchParams.get("token");
            } catch (_) {
                presented = null;
            }
        }
        return presented;
    }

    /**
     * Constant-time check of the token presented on a request against authToken.
     */
    _checkToken(req) {
        const presented = this._extractToken(req);
        if (presented && timingSafeEqualStrings(presented, this.authToken)) return true;
        // A client may use Sec-WebSocket-Protocol for a real subprotocol and
        // carry the token in the URL — the header must not shadow the query.
        const queryToken = this._extractQueryToken(req);
        return !!queryToken && timingSafeEqualStrings(queryToken, this.authToken);
    }

    _extractQueryToken(req) {
        if (!req || !req.url) return null;
        try {
            return new URL(req.url, "ws://localhost").searchParams.get("token");
        } catch (_) {
            return null;
        }
    }

    _authorize(ws, req) {
        if (!this.authToken) return true;

        if (!this._checkToken(req)) {
            this.stats.errors++;
            try {
                ws.close(4401, "Unauthorized");
            } catch (_) {
                /* ignore */
            }
            this.emit("authFailed", { ip: req.socket && req.socket.remoteAddress });
            return false;
        }
        return true;
    }

    /**
     * Handle new client connection
     */
    _handleConnection(ws, req) {
        if (this.clients.size >= this.maxClients) {
            this.stats.errors++;
            try {
                ws.close(4009, "Server at capacity");
            } catch (_) {
                /* ignore */
            }
            this.emit("clientRejected", {
                reason: "capacity",
                ip: req.socket && req.socket.remoteAddress
            });
            return;
        }

        const clientId = `client_${++this.clientCounter}`;
        const clientIp = req.socket.remoteAddress;

        const clientInfo = {
            ws: ws,
            id: clientId,
            ip: clientIp,
            subscriptions: new Set(["*"]), // Subscribe to all by default
            lastPing: Date.now(),
            connectedAt: Date.now(),
            // Backpressure bookkeeping (see broadcast())
            skippedMessages: 0,
            consecutiveSkips: 0
        };

        this.clients.set(clientId, clientInfo);
        this.stats.clientsTotal++;
        this.stats.clientsCurrent = this.clients.size;

        this.emit("clientConnected", { clientId, ip: clientIp });

        // Send welcome message
        this._sendToClient(clientId, {
            type: "welcome",
            clientId: clientId,
            serverTime: Date.now(),
            message: "Connected to Condition Monitoring WebSocket"
        });

        // Handle incoming messages
        ws.on("message", (data) => {
            this._handleMessage(clientId, data);
        });

        // Handle pong (heartbeat response)
        ws.on("pong", () => {
            clientInfo.lastPing = Date.now();
        });

        // Handle disconnect
        ws.on("close", () => {
            this.clients.delete(clientId);
            this.stats.clientsCurrent = this.clients.size;
            this.emit("clientDisconnected", { clientId });
        });

        // Handle errors
        ws.on("error", (err) => {
            this.stats.errors++;
            this.emit("clientError", { clientId, error: err.message });
        });
    }

    /**
     * Handle incoming message from client
     */
    _handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return;

        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case "subscribe": {
                    // Subscribe to specific topics (bounded per client)
                    const addTopic = (topic) => {
                        if (client.subscriptions.size < this.maxSubscriptionsPerClient) {
                            client.subscriptions.add(topic);
                        }
                    };
                    if (Array.isArray(message.topics)) {
                        message.topics.forEach(addTopic);
                    } else if (message.topic) {
                        addTopic(message.topic);
                    }
                    this._sendToClient(clientId, {
                        type: "subscribed",
                        subscriptions: Array.from(client.subscriptions)
                    });
                    break;
                }

                case "unsubscribe":
                    // Unsubscribe from topics
                    if (Array.isArray(message.topics)) {
                        message.topics.forEach((topic) => {
                            client.subscriptions.delete(topic);
                        });
                    } else if (message.topic) {
                        client.subscriptions.delete(message.topic);
                    }
                    this._sendToClient(clientId, {
                        type: "unsubscribed",
                        subscriptions: Array.from(client.subscriptions)
                    });
                    break;

                case "ping":
                    this._sendToClient(clientId, {
                        type: "pong",
                        timestamp: Date.now()
                    });
                    break;

                case "getStats":
                    this._sendToClient(clientId, {
                        type: "stats",
                        stats: this.getStats()
                    });
                    break;

                default:
                    this.emit("clientMessage", { clientId, message });
            }
        } catch (err) {
            this._sendToClient(clientId, {
                type: "error",
                message: "Invalid JSON message"
            });
        }
    }

    /**
     * Send message to specific client
     */
    _sendToClient(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WS_OPEN) return false;

        try {
            client.ws.send(JSON.stringify(message));
            return true;
        } catch (err) {
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Broadcast message to all subscribed clients
     * @param {string} topic - Message topic for filtering
     * @param {Object} data - Data to broadcast
     */
    broadcast(topic, data) {
        if (!this.isRunning) return;

        const message = {
            type: "data",
            topic: topic,
            timestamp: Date.now(),
            data: data
        };

        const messageStr = JSON.stringify(message);
        this.stats.messagesPublished++;

        for (const [clientId, client] of this.clients) {
            // Check if client is subscribed to this topic or to '*' (all)
            if (!client.subscriptions.has("*") && !client.subscriptions.has(topic)) continue;
            if (client.ws.readyState !== WS_OPEN) continue;

            // A client that is not reading gets no more frames queued on its
            // behalf; one that stays behind is cut off rather than allowed to
            // hold every broadcast in memory.
            if (client.ws.bufferedAmount > this.maxBufferedBytes) {
                client.skippedMessages++;
                client.consecutiveSkips++;
                this.stats.messagesSkipped++;
                if (client.consecutiveSkips >= this.maxConsecutiveSkips) {
                    this._dropClient(clientId, client, "backpressure");
                }
                continue;
            }
            client.consecutiveSkips = 0;

            try {
                client.ws.send(messageStr);
                this.stats.messagesSent++;
            } catch (err) {
                this.stats.errors++;
            }
        }
    }

    /**
     * Terminate a client that is not keeping up and forget it. The socket's
     * 'close' event may still fire afterwards; the delete there is a no-op.
     */
    _dropClient(clientId, client, reason) {
        try {
            client.ws.terminate();
        } catch (err) {
            /* already gone */
        }
        this.clients.delete(clientId);
        this.stats.clientsCurrent = this.clients.size;
        this.stats.clientsDroppedBackpressure++;
        this.emit("clientDropped", {
            clientId,
            reason,
            skippedMessages: client.skippedMessages,
            bufferedAmount: client.ws.bufferedAmount
        });
    }

    /**
     * Broadcast anomaly event
     * @param {Object} anomalyData - Anomaly detection result
     */
    broadcastAnomaly(anomalyData) {
        this.broadcast("anomaly", {
            ...anomalyData,
            eventType: "anomaly"
        });
    }

    /**
     * Broadcast health/status update
     * @param {Object} healthData - Health index or status data
     */
    broadcastHealth(healthData) {
        this.broadcast("health", {
            ...healthData,
            eventType: "health"
        });
    }

    /**
     * Broadcast signal analysis result
     * @param {Object} signalData - Signal analysis result
     */
    broadcastSignal(signalData) {
        this.broadcast("signal", {
            ...signalData,
            eventType: "signal"
        });
    }

    /**
     * Start heartbeat to detect dead connections
     */
    _startHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            const timeout = this.heartbeatInterval * 2;

            for (const [clientId, client] of this.clients) {
                if (now - client.lastPing > timeout) {
                    // Client hasn't responded, terminate connection
                    client.ws.terminate();
                    this.clients.delete(clientId);
                    this.stats.clientsCurrent = this.clients.size;
                    this.emit("clientTimeout", { clientId });
                } else if (client.ws.readyState === WS_OPEN) {
                    // Send ping
                    client.ws.ping();
                }
            }
        }, this.heartbeatInterval);

        // Don't keep process alive just for heartbeat
        if (this.heartbeatTimer.unref) {
            this.heartbeatTimer.unref();
        }
    }

    /**
     * Get server statistics.
     *
     * The per-client list (with remote IP addresses) is only included on
     * request: the plain statistics are also what any connected client gets
     * back for a `{"type": "getStats"}` message, and peers have no business
     * learning each other's addresses.
     *
     * @param {Object}  [options]
     * @param {boolean} [options.includeClients=false]  Add `clients` (id, ip,
     *        subscriptions, connectedAt, lastPing) — for server-side callers.
     */
    getStats(options) {
        const stats = {
            ...this.stats,
            uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
            isRunning: this.isRunning
        };
        if (options && options.includeClients === true) {
            stats.clients = Array.from(this.clients.entries()).map(([id, client]) => ({
                id: id,
                ip: client.ip,
                subscriptions: Array.from(client.subscriptions),
                connectedAt: client.connectedAt,
                lastPing: client.lastPing,
                skippedMessages: client.skippedMessages
            }));
        }
        return stats;
    }

    /**
     * Stop the WebSocket server.
     *
     * Clients are asked to close (1000); whichever has not completed the
     * handshake after `closeGraceMs` is terminated. The server's close
     * callback only fires once every connection is gone, and ws would wait
     * 30 s for a silent client — longer than Node-RED's 15 s node close
     * timeout, so a redeploy would log "close timed out" on every deploy.
     */
    stop() {
        return new Promise((resolve) => {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }

            // Close all client connections
            const sockets = Array.from(this.clients.values()).map((client) => client.ws);
            for (const ws of sockets) {
                try {
                    ws.close(1000, "Server shutting down");
                } catch (err) {
                    // Ignore close errors
                }
            }
            this.clients.clear();
            this.stats.clientsCurrent = 0;
            this.startPromise = null;

            let graceTimer = null;
            if (sockets.length > 0) {
                graceTimer = setTimeout(() => {
                    graceTimer = null;
                    for (const ws of sockets) {
                        if (ws.readyState === WS_CLOSED) continue;
                        try {
                            ws.terminate();
                        } catch (err) {
                            /* already gone */
                        }
                    }
                }, this.closeGraceMs);
                if (graceTimer.unref) graceTimer.unref();
            }

            const finish = () => {
                if (graceTimer) clearTimeout(graceTimer);
                this.isRunning = false;
                this.emit("stopped");
                resolve();
            };

            if (this.server) {
                const server = this.server;
                this.server = null;
                server.close(finish);
            } else {
                finish();
            }
        });
    }
}

// Singleton instance, shared by every node that publishes to the WebSocket,
// plus the number of nodes currently holding it. The last one to let go stops
// the server and drops the instance, so the next deploy builds a new one from
// its own options: a changed token, port or origin list then takes effect
// without a Node-RED restart.
let globalWsManager = null;
let globalWsUsers = 0;

/**
 * Get or create the global WebSocket manager.
 *
 * Counts as one acquisition: pair every call with releaseWebSocketManager().
 *
 * While several nodes hold the manager, the first caller wins for
 * security-sensitive options (`authToken`, `allowedOrigins`, `port`). Later
 * callers that pass a *different* value emit a warning event so the operator
 * notices misconfiguration instead of silently inheriting the first node's
 * settings.
 *
 * @param {Object} options - Configuration options
 */
function getWebSocketManager(options = {}) {
    globalWsUsers++;
    if (!globalWsManager) {
        globalWsManager = new WebSocketManager(options);
        return globalWsManager;
    }
    const sensitive = ["authToken", "allowedOrigins", "port", "path"];
    for (const key of sensitive) {
        if (
            Object.prototype.hasOwnProperty.call(options, key) &&
            JSON.stringify(options[key]) !== JSON.stringify(globalWsManager[key])
        ) {
            globalWsManager.emit("optionMismatch", {
                key,
                requested: options[key],
                inUse: globalWsManager[key]
            });
        }
    }
    return globalWsManager;
}

/**
 * Check if WebSocket support is available
 */
function isWebSocketAvailable() {
    return WebSocketServer !== null;
}

/**
 * Give up one acquisition made with getWebSocketManager(). The last release
 * stops the server and forgets the instance. Resolves once the server has
 * closed (so a caller's close handler can await it before Node-RED starts
 * the replacement node on the same port).
 */
async function releaseWebSocketManager() {
    if (globalWsUsers === 0) return;
    globalWsUsers--;
    if (globalWsUsers > 0 || !globalWsManager) return;
    const manager = globalWsManager;
    // Detach first: a node starting while this one is still closing must get
    // a fresh instance, not the one being torn down.
    globalWsManager = null;
    await manager.stop();
}

/**
 * Shutdown the global WebSocket manager regardless of who still holds it
 * (test teardown; a release-per-acquire is the production path).
 */
async function shutdownWebSocketManager() {
    globalWsUsers = 0;
    if (globalWsManager) {
        const manager = globalWsManager;
        globalWsManager = null;
        await manager.stop();
    }
}

/** Number of nodes currently holding the global manager (diagnostics, tests). */
function getWebSocketManagerUsers() {
    return globalWsUsers;
}

module.exports = {
    WebSocketManager,
    getWebSocketManager,
    releaseWebSocketManager,
    getWebSocketManagerUsers,
    isWebSocketAvailable,
    shutdownWebSocketManager,
    timingSafeEqualStrings
};
