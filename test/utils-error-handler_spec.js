"use strict";

const errorHandler = require("../nodes/utils/error-handler");

function fakeNode(extra) {
    const node = Object.assign(
        {
            statuses: [],
            warns: [],
            errors: [],
            status(s) {
                this.statuses.push(s);
            },
            warn(w) {
                this.warns.push(w);
            },
            error(e) {
                this.errors.push(e);
            },
            // Node-RED nodes always have a debug() log METHOD.
            debug() {}
        },
        extra
    );
    return node;
}

describe("utils/error-handler", () => {
    it("INFO level stays quiet unless the node's debug flag is on", () => {
        const quiet = fakeNode();
        errorHandler.handleNodeError(quiet, "just fyi", null, errorHandler.ErrorLevel.INFO);
        // node.debug being a function (as on every real node) must NOT count as "debug on".
        expect(quiet.warns).toEqual([]);
        expect(quiet.statuses[0].fill).toBe("grey");

        const verbose = fakeNode({ debugEnabled: true });
        errorHandler.handleNodeError(verbose, "just fyi", null, errorHandler.ErrorLevel.INFO);
        expect(verbose.warns).toEqual(["[INFO] just fyi"]);

        // Legacy nodes that still store the flag as a boolean node.debug.
        const legacy = fakeNode({ debug: true });
        errorHandler.handleNodeError(legacy, "just fyi", null, errorHandler.ErrorLevel.INFO);
        expect(legacy.warns).toEqual(["[INFO] just fyi"]);
    });

    it("ERROR level reports through node.error and truncates the status text", () => {
        const node = fakeNode();
        errorHandler.handleNodeError(node, "x".repeat(60), { _msgid: "1" });
        expect(node.errors).toHaveLength(1);
        expect(node.statuses[0]).toMatchObject({ fill: "red", shape: "ring" });
        expect(node.statuses[0].text.length).toBe(25);
    });

    it("sanitizeObject removes own prototype-pollution keys", () => {
        const obj = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"ok":3}');
        errorHandler.sanitizeObject(obj);
        expect(Object.keys(obj)).toEqual(["ok"]);
        expect({}.polluted).toBeUndefined();
    });
});
