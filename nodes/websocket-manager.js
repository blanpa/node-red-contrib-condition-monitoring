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

const EventEmitter = require('events');

// Try to load ws module (optional dependency)
let WebSocket = null;
let WebSocketServer = null;
try {
    const ws = require('ws');
    WebSocket = ws;
    WebSocketServer = ws.Server;
} catch (err) {
    // ws module not installed
}

class WebSocketManager extends EventEmitter {
    /**
     * @param {Object} options - Configuration options
     * @param {number} options.port - WebSocket server port (default: 1881)
     * @param {string} options.path - WebSocket path (default: /ws/condition-monitoring)
     * @param {number} options.heartbeatInterval - Heartbeat interval in ms (default: 30000)
     */
    constructor(options = {}) {
        super();

        this.port = options.port || 1881;
        this.path = options.path || '/ws/condition-monitoring';
        this.heartbeatInterval = options.heartbeatInterval || 30000;

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
                this.server = new WebSocketServer({
                    port: this.port,
                    path: this.path
                });

                this.server.on('listening', () => {
                    this.isRunning = true;
                    this.stats.startTime = Date.now();
                    this._startHeartbeat();
                    this.emit('started', { port: this.port, path: this.path });
                    resolve();
                });

                this.server.on('connection', (ws, req) => {
                    this._handleConnection(ws, req);
                });

                this.server.on('error', (err) => {
                    this.stats.errors++;
                    this.emit('error', err);
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
     * Handle new client connection
     */
    _handleConnection(ws, req) {
        const clientId = `client_${++this.clientCounter}`;
        const clientIp = req.socket.remoteAddress;

        const clientInfo = {
            ws: ws,
            id: clientId,
            ip: clientIp,
            subscriptions: new Set(['*']), // Subscribe to all by default
            lastPing: Date.now(),
            connectedAt: Date.now()
        };

        this.clients.set(clientId, clientInfo);
        this.stats.clientsTotal++;
        this.stats.clientsCurrent = this.clients.size;

        this.emit('clientConnected', { clientId, ip: clientIp });

        // Send welcome message
        this._sendToClient(clientId, {
            type: 'welcome',
            clientId: clientId,
            serverTime: Date.now(),
            message: 'Connected to Condition Monitoring WebSocket'
        });

        // Handle incoming messages
        ws.on('message', (data) => {
            this._handleMessage(clientId, data);
        });

        // Handle pong (heartbeat response)
        ws.on('pong', () => {
            clientInfo.lastPing = Date.now();
        });

        // Handle disconnect
        ws.on('close', () => {
            this.clients.delete(clientId);
            this.stats.clientsCurrent = this.clients.size;
            this.emit('clientDisconnected', { clientId });
        });

        // Handle errors
        ws.on('error', (err) => {
            this.stats.errors++;
            this.emit('clientError', { clientId, error: err.message });
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
                case 'subscribe':
                    // Subscribe to specific topics
                    if (Array.isArray(message.topics)) {
                        message.topics.forEach(topic => {
                            client.subscriptions.add(topic);
                        });
                    } else if (message.topic) {
                        client.subscriptions.add(message.topic);
                    }
                    this._sendToClient(clientId, {
                        type: 'subscribed',
                        subscriptions: Array.from(client.subscriptions)
                    });
                    break;

                case 'unsubscribe':
                    // Unsubscribe from topics
                    if (Array.isArray(message.topics)) {
                        message.topics.forEach(topic => {
                            client.subscriptions.delete(topic);
                        });
                    } else if (message.topic) {
                        client.subscriptions.delete(message.topic);
                    }
                    this._sendToClient(clientId, {
                        type: 'unsubscribed',
                        subscriptions: Array.from(client.subscriptions)
                    });
                    break;

                case 'ping':
                    this._sendToClient(clientId, {
                        type: 'pong',
                        timestamp: Date.now()
                    });
                    break;

                case 'getStats':
                    this._sendToClient(clientId, {
                        type: 'stats',
                        stats: this.getStats()
                    });
                    break;

                default:
                    this.emit('clientMessage', { clientId, message });
            }

        } catch (err) {
            this._sendToClient(clientId, {
                type: 'error',
                message: 'Invalid JSON message'
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
            type: 'data',
            topic: topic,
            timestamp: Date.now(),
            data: data
        };

        const messageStr = JSON.stringify(message);
        this.stats.messagesPublished++;

        for (const [clientId, client] of this.clients) {
            // Check if client is subscribed to this topic or to '*' (all)
            if (client.subscriptions.has('*') || client.subscriptions.has(topic)) {
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
        this.broadcast('anomaly', {
            ...anomalyData,
            eventType: 'anomaly'
        });
    }

    /**
     * Broadcast health/status update
     * @param {Object} healthData - Health index or status data
     */
    broadcastHealth(healthData) {
        this.broadcast('health', {
            ...healthData,
            eventType: 'health'
        });
    }

    /**
     * Broadcast signal analysis result
     * @param {Object} signalData - Signal analysis result
     */
    broadcastSignal(signalData) {
        this.broadcast('signal', {
            ...signalData,
            eventType: 'signal'
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
                    this.emit('clientTimeout', { clientId });
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
            for (const [clientId, client] of this.clients) {
                try {
                    client.ws.close(1000, 'Server shutting down');
                } catch (err) {
                    // Ignore close errors
                }
            }
            this.clients.clear();

            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    this.emit('stopped');
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
 * Get or create the global WebSocket manager
 * @param {Object} options - Configuration options
 */
function getWebSocketManager(options = {}) {
    if (!globalWsManager) {
        globalWsManager = new WebSocketManager(options);
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
