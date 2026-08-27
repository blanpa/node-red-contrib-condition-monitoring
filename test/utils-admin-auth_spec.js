"use strict";

/**
 * `utils/admin-auth` guards every route this package registers on
 * `RED.httpAdmin`. Node-RED does not apply `adminAuth` to those routes on its
 * own, so a missing guard silently exposes them — these tests pin both the
 * delegation and the fail-closed fallback.
 */

const { needsPermission } = require("../nodes/utils/admin-auth");

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

describe("utils/admin-auth", () => {
    it("delegates to RED.auth.needsPermission and returns its middleware", () => {
        const calls = [];
        const middleware = function () {};
        const RED = {
            auth: {
                needsPermission(scope) {
                    calls.push(scope);
                    return middleware;
                }
            }
        };

        expect(needsPermission(RED, "ml-inference.write")).toBe(middleware);
        expect(calls).toEqual(["ml-inference.write"]);
    });

    it("fails closed with 401 when RED.auth is unavailable", () => {
        const res = fakeRes();
        const mw = needsPermission({}, "ml-inference.read");
        const next = jest.fn();

        mw({}, res, next);

        expect(res.statusCode).toBe(401);
        expect(res.body.error).toContain("ml-inference.read");
        // The critical part: it must not fall through to the handler.
        expect(next).not.toHaveBeenCalled();
    });

    it("fails closed when RED itself is missing or auth is not a function", () => {
        for (const RED of [null, undefined, {}, { auth: {} }, { auth: { needsPermission: "nope" } }]) {
            const res = fakeRes();
            needsPermission(RED, "x.read")({}, res, jest.fn());
            expect(res.statusCode).toBe(401);
        }
    });
});

describe("httpAdmin routes are guarded", () => {
    // A missing guard is invisible at runtime until someone probes the port, so
    // assert it structurally across every node file that registers routes.
    const fs = require("fs");
    const path = require("path");

    const NODES_DIR = path.resolve(__dirname, "..", "nodes");

    it("every RED.httpAdmin registration passes through needsPermission", () => {
        const offenders = [];

        for (const file of fs.readdirSync(NODES_DIR).filter((f) => f.endsWith(".js"))) {
            const src = fs.readFileSync(path.join(NODES_DIR, file), "utf8");
            // Match a registration and the text up to the start of its handler.
            const re = /RED\.httpAdmin\.(get|post|put|delete)\(([\s\S]{0,400}?)(?:function|async function|\(req)/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                if (!m[2].includes("needsPermission(")) {
                    offenders.push(file + ": " + m[2].replace(/\s+/g, " ").trim().slice(0, 80));
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it("registers at least the routes we expect (guards against the regex silently matching nothing)", () => {
        let count = 0;
        for (const file of fs.readdirSync(NODES_DIR).filter((f) => f.endsWith(".js"))) {
            const src = fs.readFileSync(path.join(NODES_DIR, file), "utf8");
            count += (src.match(/RED\.httpAdmin\.(get|post|put|delete)\(/g) || []).length;
        }
        expect(count).toBeGreaterThanOrEqual(18);
    });
});
