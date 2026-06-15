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
let WebSocket = null;
let WebSocketServer = null;
try {
    const ws = require("ws");
    WebSocket = ws;
    WebSocketServer = ws.Server;
} catch (err) {
    // ws module not installed
}

/**
 * Constant-time string comparison. Returns true only if both strings have the
 * same length and the same content. Designed to avoid leaking the token via
 * timing differences when an attacker probes multiple values.
 */
function timingSafeEqualStrings(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

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
     */
    constructor(options = {}) {
        super();

        this.port = options.port || 1881;
        this.path = options.path || "/ws/condition-monitoring";
        this.heartbeatInterval = options.heartbeatInterval || 30000;
        this.maxClients = Number.isInteger(options.maxClients) && options.maxClients > 0 ? options.maxClients : 100;
        this.maxMessageSize =
            Number.isInteger(options.maxMessageSize) && options.maxMessageSize > 0 ? options.maxMessageSize : 65536;
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

        // Statistics
        this.stats = {
            messagesPublished: 0,
            messagesSent: 0,
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

        return new Promise((resolve, reject) => {
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
                this.server = new WebSocketServer(wsServerOptions);

                this.server.on("listening", () => {
                    this.isRunning = true;
                    this.stats.startTime = Date.now();
                    this._startHeartbeat();
                    this.emit("started", { port: this.port, path: this.path });
                    resolve();
                });

                this.server.on("connection", (ws, req) => {
                    if (!this._authorize(ws, req)) {
                        // _authorize already closed the socket and bumped stats.errors
                        return;
                    }
                    this._handleConnection(ws, req);
                });

                this.server.on("error", (err) => {
                    this.stats.errors++;
                    this.emit("error", err);
                    if (!this.isRunning) {
                        reject(err);
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
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
        return !!presented && timingSafeEqualStrings(presented, this.authToken);
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
            connectedAt: Date.now()
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
        if (!client || client.ws.readyState !== WebSocket.OPEN) return false;

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

        for (const client of this.clients.values()) {
            // Check if client is subscribed to this topic or to '*' (all)
            if (client.subscriptions.has("*") || client.subscriptions.has(topic)) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    try {
                        client.ws.send(messageStr);
                        this.stats.messagesSent++;
                    } catch (err) {
                        this.stats.errors++;
                    }
                }
            }
        }
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
                } else if (client.ws.readyState === WebSocket.OPEN) {
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
     * Get server statistics
     */
    getStats() {
        return {
            ...this.stats,
            uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
            isRunning: this.isRunning,
            clients: Array.from(this.clients.entries()).map(([id, client]) => ({
                id: id,
                ip: client.ip,
                subscriptions: Array.from(client.subscriptions),
                connectedAt: client.connectedAt,
                lastPing: client.lastPing
            }))
        };
    }

    /**
     * Stop the WebSocket server
     */
    stop() {
        return new Promise((resolve) => {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }

            // Close all client connections
            for (const client of this.clients.values()) {
                try {
                    client.ws.close(1000, "Server shutting down");
                } catch (err) {
                    // Ignore close errors
                }
            }
            this.clients.clear();

            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    this.emit("stopped");
                    resolve();
                });
            } else {
                this.isRunning = false;
                resolve();
            }
        });
    }
}

// Singleton instance
let globalWsManager = null;

/**
 * Get or create the global WebSocket manager.
 *
 * The first caller wins for security-sensitive options (`authToken`,
 * `allowedOrigins`, `port`). Later callers that pass a *different* value emit
 * a warning event so the operator notices misconfiguration instead of
 * silently inheriting the first node's settings.
 *
 * @param {Object} options - Configuration options
 */
function getWebSocketManager(options = {}) {
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
 * Shutdown the global WebSocket manager
 */
async function shutdownWebSocketManager() {
    if (globalWsManager) {
        await globalWsManager.stop();
        globalWsManager = null;
    }
}

module.exports = {
    WebSocketManager,
    getWebSocketManager,
    isWebSocketAvailable,
    shutdownWebSocketManager
};
