"use strict";

const { mulberry32 } = require("../nodes/utils/seeded-random");
const { isIsoDateLike, clampInt, clampFloat, stringOr } = require("../nodes/utils/config-validator");

describe("utils/seeded-random", () => {
    it("produces the pinned mulberry32 sequence for a seed", () => {
        const first3 = (seed) => {
            const rng = mulberry32(seed);
            return [rng(), rng(), rng()];
        };
        expect(first3(1)).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
        expect(first3(42)).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
        expect(first3(-3)).toEqual([0.5127934608608484, 0.46524663479067385, 0.09994429117068648]);
        // Seeds are reduced to 32 bits: 2**32 + 5 behaves like 5.
        expect(first3(4294967301)).toEqual(first3(5));
        expect(first3(4294967301)).toEqual([0.6897749109193683, 0.7727432732935995, 0.21976301027461886]);
    });

    it("independent generators with the same seed do not share state", () => {
        const a = mulberry32(9);
        const b = mulberry32(9);
        const fromA = [a(), a(), a()];
        expect([b(), b(), b()]).toEqual(fromA);
    });

    it("stays inside [0, 1)", () => {
        const rng = mulberry32(123);
        for (let i = 0; i < 2000; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe("utils/config-validator", () => {
    it("isIsoDateLike matches ISO dates / timestamps only", () => {
        for (const yes of ["2024-05-01", " 2024-05-01 ", "2024-05-01T12:30:00Z", "2024-05-01 12:30"]) {
            expect(isIsoDateLike(yes)).toBe(true);
        }
        for (const no of [
            "65 °C",
            "2024",
            "2024-05",
            "2024-1234-A",
            "2024-05-011",
            "-2024-05-01",
            "",
            20240501,
            null
        ]) {
            expect(isIsoDateLike(no)).toBe(false);
        }
    });

    it("clampInt / clampFloat / stringOr: fallback when unparseable, clamp otherwise, 0 stays 0", () => {
        expect(clampInt("0", 0, 10, 5)).toBe(0);
        expect(clampInt("abc", 0, 10, 5)).toBe(5);
        expect(clampInt(-4, 0, 10, 5)).toBe(0);
        expect(clampInt("99", 0, 10, 5)).toBe(10);
        expect(clampInt("7.9", 0, 10, 5)).toBe(7);
        expect(clampFloat("0.25", 0, 1, 0.5)).toBe(0.25);
        expect(clampFloat(undefined, 0, 1, 0.5)).toBe(0.5);
        expect(clampFloat(Infinity, 0, 1, 0.5)).toBe(0.5);
        expect(clampFloat(3, 0, 1, 0.5)).toBe(1);
        expect(stringOr("  ", "dflt")).toBe("dflt");
        expect(stringOr(" x ", "dflt")).toBe(" x ");
        expect(stringOr(5, "dflt")).toBe("dflt");
    });
});
