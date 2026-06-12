"use strict";

const WebSocket = require("ws");

const {
    WebSocketManager,
    getWebSocketManager,
    isWebSocketAvailable,
    shutdownWebSocketManager
} = require("../nodes/websocket-manager");

// Random per-suite base port plus a per-test counter so parallel Jest workers
// don't collide (same approach as test/integration/websocket-auth-flow_spec.js;
// the manager treats port 0 as "use the default 1881", so ws's ephemeral-port
// support cannot be used here).
const BASE_PORT = 24000 + Math.floor(Math.random() * 2000);
let portCounter = 0;
function nextPort() {
    return BASE_PORT + portCounter++;
}

const WS_PATH = "/ws/condition-monitoring";

/** Wait for a single event on an EventEmitter, with a timeout. */
function once(emitter, event, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}" event`)), timeoutMs);
        emitter.once(event, (payload) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

describe("WebSocketManager", () => {
    let manager = null;
    const clients = [];

    /** Create a WS client wrapper with a message queue and helper promises. */
    function makeClient(port, path = WS_PATH) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        const queue = [];
        const waiters = [];

        ws.on("message", (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch (_) {
                msg = { type: "_unparseable", raw: data.toString() };
            }
            const waiter = waiters.shift();
            if (waiter) waiter(msg);
            else queue.push(msg);
        });

        const client = {
            ws,
            opened: new Promise((resolve, reject) => {
                ws.once("open", resolve);
                ws.once("error", reject);
            }),
            closed: new Promise((resolve) => {
                ws.once("close", (code, reason) => resolve({ code, reason: reason ? reason.toString() : "" }));
            }),
            next(timeoutMs = 3000) {
                if (queue.length > 0) return Promise.resolve(queue.shift());
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("timed out waiting for WS message")), timeoutMs);
                    waiters.push((msg) => {
                        clearTimeout(timer);
                        resolve(msg);
                    });
                });
            },
            send(payload) {
                ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
            }
        };
        clients.push(client);
        return client;
    }

    /** Start a fresh manager on its own port. */
    async function startManager(options = {}) {
        manager = new WebSocketManager({ port: nextPort(), ...options });
        await manager.start();
        return manager;
    }

    /** Connect a client and consume the welcome message. */
    async function connect(mgr) {
        const client = makeClient(mgr.port);
        await client.opened;
        const welcome = await client.next();
        return { client, welcome };
    }

    afterEach(async () => {
        for (const client of clients.splice(0)) {
            try {
                client.ws.terminate();
            } catch (_) {
                /* already closed */
            }
        }
        if (manager) {
            await manager.stop();
            manager = null;
        }
        await shutdownWebSocketManager();
    });

    it("reports ws support as available", () => {
        expect(isWebSocketAvailable()).toBe(true);
    });

    describe("lifecycle", () => {
        it("starts, sets isRunning and emits 'started'", async () => {
            manager = new WebSocketManager({ port: nextPort() });
            expect(manager.isRunning).toBe(false);
            const startedPromise = once(manager, "started");
            await manager.start();
            const info = await startedPromise;
            expect(manager.isRunning).toBe(true);
            expect(info.port).toBe(manager.port);
            expect(info.path).toBe(WS_PATH);
        });

        it("resolves immediately on double start", async () => {
            await startManager();
            await expect(manager.start()).resolves.toBeUndefined();
            expect(manager.isRunning).toBe(true);
        });

        it("stops, clears clients and emits 'stopped'", async () => {
            await startManager();
            const { client } = await connect(manager);
            const stoppedPromise = once(manager, "stopped");
            await manager.stop();
            await stoppedPromise;
            expect(manager.isRunning).toBe(false);
            expect(manager.clients.size).toBe(0);
            const closeInfo = await client.closed;
            expect(closeInfo.code).toBe(1000);
        });

        it("resolves stop() when never started", async () => {
            manager = new WebSocketManager({ port: nextPort() });
            await expect(manager.stop()).resolves.toBeUndefined();
        });

        it("rejects start() when the port is already in use", async () => {
            await startManager();
            const second = new WebSocketManager({ port: manager.port });
            second.on("error", () => {
                /* swallow the duplicate emit */
            });
            await expect(second.start()).rejects.toThrow(/EADDRINUSE|address/i);
        });
    });

    describe("connections", () => {
        it("sends a welcome message and tracks client stats", async () => {
            await startManager();
            const { client, welcome } = await connect(manager);

            expect(welcome.type).toBe("welcome");
            expect(welcome.clientId).toBe("client_1");
            expect(typeof welcome.serverTime).toBe("number");

            let stats = manager.getStats();
            expect(stats.clientsTotal).toBe(1);
            expect(stats.clientsCurrent).toBe(1);
            expect(stats.clients[0].subscriptions).toEqual(["*"]);

            const disconnected = once(manager, "clientDisconnected");
            client.ws.close();
            await disconnected;

            stats = manager.getStats();
            expect(stats.clientsTotal).toBe(1);
            expect(stats.clientsCurrent).toBe(0);
        });

        it("emits clientConnected with the client id", async () => {
            await startManager();
            const connectedPromise = once(manager, "clientConnected");
            await connect(manager);
            const info = await connectedPromise;
            expect(info.clientId).toBe("client_1");
        });
    });

    describe("inbound message handling", () => {
        it("answers ping with pong", async () => {
            await startManager();
            const { client } = await connect(manager);
            client.send({ type: "ping" });
            const reply = await client.next();
            expect(reply.type).toBe("pong");
            expect(typeof reply.timestamp).toBe("number");
        });

        it("answers getStats with server statistics", async () => {
            await startManager();
            const { client } = await connect(manager);
            client.send({ type: "getStats" });
            const reply = await client.next();
            expect(reply.type).toBe("stats");
            expect(reply.stats.isRunning).toBe(true);
            expect(reply.stats.clientsCurrent).toBe(1);
        });

        it("replies with an error message on invalid JSON", async () => {
            await startManager();
            const { client } = await connect(manager);
            client.send("this is { not json");
            const reply = await client.next();
            expect(reply.type).toBe("error");
            expect(reply.message).toBe("Invalid JSON message");
        });

        it("emits clientMessage for unknown message types", async () => {
            await startManager();
            const { client } = await connect(manager);
            const messagePromise = once(manager, "clientMessage");
            client.send({ type: "customThing", value: 42 });
            const info = await messagePromise;
            expect(info.clientId).toBe("client_1");
            expect(info.message).toEqual({ type: "customThing", value: 42 });
        });
    });

    describe("subscriptions", () => {
        it("subscribes to a single topic", async () => {
            await startManager();
            const { client } = await connect(manager);
            client.send({ type: "subscribe", topic: "health" });
            const reply = await client.next();
            expect(reply.type).toBe("subscribed");
            expect(reply.subscriptions.sort()).toEqual(["*", "health"]);
        });

        it("subscribes to an array of topics", async () => {
            await startManager();
            const { client } = await connect(manager);
            client.send({ type: "subscribe", topics: ["health", "anomaly"] });
            const reply = await client.next();
            expect(reply.type).toBe("subscribed");
            expect(reply.subscriptions.sort()).toEqual(["*", "anomaly", "health"]);
        });

        it("unsubscribes from a single topic", async () => {
            await startManager();
            const { client } = await connect(manager);
            client.send({ type: "unsubscribe", topic: "*" });
            const reply = await client.next();
            expect(reply.type).toBe("unsubscribed");
            expect(reply.subscriptions).toEqual([]);
        });

        it("unsubscribes from an array of topics", async () => {
            await startManager();
            const { client } = await connect(manager);
            client.send({ type: "subscribe", topics: ["a", "b", "c"] });
            await client.next();
            client.send({ type: "unsubscribe", topics: ["a", "c", "*"] });
            const reply = await client.next();
            expect(reply.type).toBe("unsubscribed");
            expect(reply.subscriptions).toEqual(["b"]);
        });
    });

    describe("broadcast", () => {
        it("delivers to the default '*' subscription regardless of topic", async () => {
            await startManager();
            const { client } = await connect(manager);
            manager.broadcast("any-topic-at-all", { value: 7 });
            const msg = await client.next();
            expect(msg.type).toBe("data");
            expect(msg.topic).toBe("any-topic-at-all");
            expect(msg.data).toEqual({ value: 7 });
            expect(typeof msg.timestamp).toBe("number");
        });

        it("filters by topic after unsubscribing from '*'", async () => {
            await startManager();
            const { client } = await connect(manager);

            client.send({ type: "unsubscribe", topic: "*" });
            await client.next();
            client.send({ type: "subscribe", topic: "health" });
            const sub = await client.next();
            expect(sub.subscriptions).toEqual(["health"]);

            manager.broadcast("anomaly", { skip: true });
            manager.broadcast("health", { keep: true });

            // Messages are delivered in order, so the first data frame we see
            // must be the matching "health" one if filtering works.
            const msg = await client.next();
            expect(msg.topic).toBe("health");
            expect(msg.data).toEqual({ keep: true });

            const stats = manager.getStats();
            expect(stats.messagesPublished).toBe(2);
            expect(stats.messagesSent).toBe(1);
        });

        it("is a no-op when the server is not running", () => {
            manager = new WebSocketManager({ port: nextPort() });
            expect(() => manager.broadcast("health", { x: 1 })).not.toThrow();
            expect(manager.getStats().messagesPublished).toBe(0);
        });

        it("broadcastAnomaly tags the payload with eventType anomaly", async () => {
            await startManager();
            const { client } = await connect(manager);
            manager.broadcastAnomaly({ score: 5 });
            const msg = await client.next();
            expect(msg.topic).toBe("anomaly");
            expect(msg.data).toEqual({ score: 5, eventType: "anomaly" });
        });
    });

    describe("hardening", () => {
        it("rejects connections above maxClients with code 4009", async () => {
            await startManager({ maxClients: 2 });
            await connect(manager);
            await connect(manager);

            const rejectedPromise = once(manager, "clientRejected");
            const third = makeClient(manager.port);
            const closeInfo = await third.closed;
            const rejected = await rejectedPromise;

            expect(closeInfo.code).toBe(4009);
            expect(rejected.reason).toBe("capacity");
            expect(manager.clients.size).toBe(2);
            expect(manager.getStats().clientsTotal).toBe(2);
        });

        it("closes the connection when a message exceeds maxMessageSize", async () => {
            await startManager({ maxMessageSize: 256 });
            const { client } = await connect(manager);
            client.send("x".repeat(1024));
            const closeInfo = await client.closed;
            expect(closeInfo.code).toBe(1009);
        });

        it("caps per-client subscriptions at maxSubscriptionsPerClient", async () => {
            await startManager();
            expect(manager.maxSubscriptionsPerClient).toBe(256);

            const { client, welcome } = await connect(manager);
            const topics = [];
            for (let i = 0; i < 300; i++) topics.push(`topic_${i}`);
            client.send({ type: "subscribe", topics });
            const reply = await client.next();

            // Default "*" plus 255 added topics — the cap stops further growth.
            expect(reply.subscriptions.length).toBe(256);
            const serverSide = manager.clients.get(welcome.clientId);
            expect(serverSide.subscriptions.size).toBe(256);
            expect(serverSide.subscriptions.size).toBeLessThanOrEqual(manager.maxSubscriptionsPerClient);
            expect(serverSide.subscriptions.has("topic_299")).toBe(false);
        });
    });

    describe("singleton helpers", () => {
        it("getWebSocketManager returns the same instance", () => {
            const a = getWebSocketManager({ port: nextPort() });
            const b = getWebSocketManager();
            expect(b).toBe(a);
        });

        it("emits optionMismatch when a later caller requests a different port", () => {
            const firstPort = nextPort();
            const instance = getWebSocketManager({ port: firstPort });
            const mismatches = [];
            instance.on("optionMismatch", (info) => mismatches.push(info));

            // Same value: no warning.
            getWebSocketManager({ port: firstPort });
            expect(mismatches).toEqual([]);

            const otherPort = nextPort();
            const again = getWebSocketManager({ port: otherPort, authToken: "different-token" });
            expect(again).toBe(instance);
            expect(instance.port).toBe(firstPort);

            const keys = mismatches.map((m) => m.key).sort();
            expect(keys).toEqual(["authToken", "port"]);
            const portMismatch = mismatches.find((m) => m.key === "port");
            expect(portMismatch.requested).toBe(otherPort);
            expect(portMismatch.inUse).toBe(firstPort);
        });

        it("shutdownWebSocketManager stops and resets the singleton", async () => {
            const port = nextPort();
            const instance = getWebSocketManager({ port });
            await instance.start();
            expect(instance.isRunning).toBe(true);

            await shutdownWebSocketManager();
            expect(instance.isRunning).toBe(false);

            const fresh = getWebSocketManager({ port: nextPort() });
            expect(fresh).not.toBe(instance);
        });
    });
});
