"use strict";

const {
    parseSensorValue,
    parseSensorObject,
    isLenientNumeric,
    createSkippedFieldWarner
} = require("../nodes/utils/sensor-value");

describe("utils/sensor-value", () => {
    describe("parseSensorValue", () => {
        it("passes finite numbers through unchanged", () => {
            [0, -0, 1, -1.5, 1e-9, 6.02e23, Number.MAX_VALUE, -Number.MIN_VALUE].forEach((n) => {
                expect(parseSensorValue(n)).toBe(n);
            });
        });

        it("rejects NaN and the infinities", () => {
            expect(parseSensorValue(NaN)).toBeNull();
            expect(parseSensorValue(Infinity)).toBeNull();
            expect(parseSensorValue(-Infinity)).toBeNull();
        });

        it("accepts strings that are nothing but a number", () => {
            expect(parseSensorValue("7")).toBe(7);
            expect(parseSensorValue(" 7 ")).toBe(7);
            expect(parseSensorValue("-1.5")).toBe(-1.5);
            expect(parseSensorValue(".5")).toBe(0.5);
            expect(parseSensorValue("-.5")).toBe(-0.5);
            expect(parseSensorValue("1e5")).toBe(100000);
            expect(parseSensorValue("2.5E-3")).toBe(0.0025);
            expect(parseSensorValue("007")).toBe(7);
            expect(parseSensorValue("0")).toBe(0);
        });

        it("rejects text with a numeric prefix or a unit (what parseFloat accepted)", () => {
            ["123abc", "65 °C", "12 bar", "1,5", "5.", "0x10", "+5", "1e", "Infinity", "-Infinity", "NaN"].forEach(
                (s) => {
                    expect(parseSensorValue(s)).toBeNull();
                }
            );
        });

        it("rejects empty and blank strings", () => {
            expect(parseSensorValue("")).toBeNull();
            expect(parseSensorValue("   ")).toBeNull();
            expect(parseSensorValue("\t\n")).toBeNull();
        });

        it("rejects ISO date-like strings instead of reading the year", () => {
            ["2024-05-01", "2024-05-01T12:00:00Z", "2024-05-01 12:00:00", " 2024-05-01T12:00:00.000+02:00"].forEach(
                (s) => {
                    expect(parseSensorValue(s)).toBeNull();
                }
            );
        });

        it("rejects everything that is neither a number nor a string", () => {
            [null, undefined, true, false, [7], [], {}, { value: 7 }, () => 7, 7n, new Date(0)].forEach((raw) => {
                expect(parseSensorValue(raw)).toBeNull();
            });
        });

        it("agrees with anomaly-detector's regex on the accepted shapes", () => {
            // The expression is copied from anomaly-detector.js; these are the
            // strings its tests exercise.
            expect(parseSensorValue("42")).toBe(42);
            expect(parseSensorValue("-3.25")).toBe(-3.25);
            expect(parseSensorValue("not a number")).toBeNull();
        });
    });

    describe("isLenientNumeric", () => {
        it("is true only for strings the old lenient parsers read as numbers", () => {
            expect(isLenientNumeric("2024-05-01")).toBe(true);
            expect(isLenientNumeric("2024-05-01T12:00:00Z")).toBe(true);
            expect(isLenientNumeric("123abc")).toBe(true);
            expect(isLenientNumeric("65 °C")).toBe(true);
        });

        it("is false for strict numbers, text and non-strings", () => {
            expect(isLenientNumeric("7")).toBe(false);
            expect(isLenientNumeric("abc")).toBe(false);
            expect(isLenientNumeric("")).toBe(false);
            expect(isLenientNumeric(7)).toBe(false);
            expect(isLenientNumeric(null)).toBe(false);
            expect(isLenientNumeric(undefined)).toBe(false);
            expect(isLenientNumeric([1])).toBe(false);
        });
    });

    describe("parseSensorObject", () => {
        it("keeps the sensor values, in key order, and lists what it skipped", () => {
            const parsed = parseSensorObject({
                temp: 25,
                timestamp: "2024-05-01T12:00:00Z",
                pressure: "1013.2",
                deviceId: "pump-7",
                rpm: null,
                flow: NaN,
                ok: true
            });

            expect(parsed.names).toEqual(["temp", "pressure"]);
            expect(parsed.values).toEqual([25, 1013.2]);
            expect(parsed.skipped).toEqual(["timestamp", "deviceId", "rpm", "flow", "ok"]);
        });

        it("leaves skipKeys out of both lists", () => {
            const parsed = parseSensorObject(
                { device: "d1", temp: 25, ts: "2024-05-01", flow: 3 },
                { skipKeys: ["device", "ts"] }
            );

            expect(parsed.names).toEqual(["temp", "flow"]);
            expect(parsed.values).toEqual([25, 3]);
            expect(parsed.skipped).toEqual([]);
        });

        it("returns empty lists for anything that is not a plain object", () => {
            [null, undefined, 7, "7", [1, 2], true].forEach((raw) => {
                expect(parseSensorObject(raw)).toEqual({ names: [], values: [], skipped: [] });
            });
        });

        it("handles keys that collide with Object.prototype members", () => {
            const parsed = parseSensorObject(JSON.parse('{"constructor":1,"toString":"2","__proto__":3,"x":"nope"}'));

            expect(parsed.names).toEqual(["constructor", "toString", "__proto__"]);
            expect(parsed.values).toEqual([1, 2, 3]);
            expect(parsed.skipped).toEqual(["x"]);
        });

        it("does not report anything for an all-numeric object", () => {
            const parsed = parseSensorObject({ a: 1, b: "2" });
            expect(parsed.skipped).toEqual([]);
            expect(parsed.values).toEqual([1, 2]);
        });
    });

    describe("createSkippedFieldWarner", () => {
        function warner() {
            const warnings = [];
            const warn = createSkippedFieldWarner({
                warn: function (text) {
                    warnings.push(text);
                }
            });
            return { warn: warn, warnings: warnings };
        }

        it("warns once per field, and only about fields that used to parse as numbers", () => {
            const w = warner();
            const payload = { temp: 25, timestamp: "2024-05-01T12:00:00Z", deviceId: "pump-7", rpm: null };

            w.warn(payload, ["timestamp", "deviceId", "rpm"]);
            w.warn(payload, ["timestamp", "deviceId", "rpm"]);
            w.warn(payload, ["timestamp", "deviceId", "rpm"]);

            expect(w.warnings).toEqual([
                'Ignoring non-numeric field(s) "timestamp" (text or timestamp, not a sensor value)'
            ]);
        });

        it("names every new offending field of one message together, and later ones separately", () => {
            const w = warner();

            w.warn({ a: "123abc", b: "2024-01-01", c: "x" }, ["a", "b", "c"]);
            w.warn({ a: "123abc", d: "65 °C" }, ["a", "d"]);

            expect(w.warnings.length).toBe(2);
            expect(w.warnings[0]).toContain('"a", "b"');
            expect(w.warnings[0]).not.toContain('"c"');
            expect(w.warnings[1]).toContain('"d"');
            expect(w.warnings[1]).not.toContain('"a"');
        });

        it("stays silent when nothing was skipped", () => {
            const w = warner();
            w.warn({ a: 1 }, []);
            expect(w.warnings).toEqual([]);
        });
    });
});
