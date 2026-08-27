"use strict";

const { copyPassthrough } = require("../nodes/utils/message");

describe("utils/message copyPassthrough", () => {
    it("copies unknown properties from the incoming message", () => {
        const out = { payload: { score: 1 } };
        copyPassthrough(out, { payload: 42, topic: "t/1", _msgid: "abc", correlationId: "c-9" });

        expect(out.topic).toBe("t/1");
        expect(out._msgid).toBe("abc");
        expect(out.correlationId).toBe("c-9");
    });

    it("never overwrites what the node already computed", () => {
        const out = { payload: { score: 1 }, topic: "configured" };
        copyPassthrough(out, { payload: 42, topic: "inbound" });

        expect(out.topic).toBe("configured");
        expect(out.payload).toEqual({ score: 1 });
    });

    it("leaves payload alone by default — the node's result is the payload", () => {
        const out = {};
        copyPassthrough(out, { payload: 42, topic: "t" });

        expect(Object.prototype.hasOwnProperty.call(out, "payload")).toBe(false);
        expect(out.topic).toBe("t");
    });

    it("copies payload with includePayload, but still does not clobber an existing one", () => {
        const empty = {};
        copyPassthrough(empty, { payload: 42 }, { includePayload: true });
        expect(empty.payload).toBe(42);

        const filled = { payload: "mine" };
        copyPassthrough(filled, { payload: 42 }, { includePayload: true });
        expect(filled.payload).toBe("mine");
    });

    it("preserveTopic forces the inbound topic through", () => {
        const out = { payload: 1, topic: "node-configured" };
        copyPassthrough(out, { payload: 2, topic: "inbound" }, { preserveTopic: true });
        expect(out.topic).toBe("inbound");
    });

    it("preserveTopic is a no-op when the incoming message has no topic", () => {
        const out = { payload: 1, topic: "node-configured" };
        copyPassthrough(out, { payload: 2 }, { preserveTopic: true });
        expect(out.topic).toBe("node-configured");
    });

    it("tolerates missing arguments", () => {
        expect(copyPassthrough(null, { a: 1 })).toBeNull();
        const out = {};
        expect(copyPassthrough(out, null)).toBe(out);
    });

    it("does not walk the prototype chain", () => {
        const msg = Object.create({ inherited: "nope" });
        msg.own = "yes";
        const out = {};
        copyPassthrough(out, msg);

        expect(out.own).toBe("yes");
        expect(Object.prototype.hasOwnProperty.call(out, "inherited")).toBe(false);
    });
});
