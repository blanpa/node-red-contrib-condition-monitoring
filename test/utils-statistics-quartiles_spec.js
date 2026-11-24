/**
 * utils/statistics: quartiles, percentiles and the median share one definition
 * (linear interpolation between order statistics).
 */
const stats = require("../nodes/utils/statistics");

describe("statistics quartiles", function () {
    it("interpolates between order statistics", function () {
        expect(stats.calculateQuartiles([1, 2, 3, 4])).toEqual({ q1: 1.75, q2: 2.5, q3: 3.25, iqr: 1.5, median: 2.5 });
        expect(stats.calculateQuartiles([5, 1, 4, 2, 3])).toEqual({ q1: 2, q2: 3, q3: 4, iqr: 2, median: 3 });
    });

    it.each([[[1, 2, 3, 4]], [[7, 1, 9, 3, 12, 5, 8]], [[2.5, -1, 0, 10, 4.25, 4.25]], [[42]]])(
        "agrees with calculateMedian and calculatePercentile for %p",
        function (values) {
            const q = stats.calculateQuartiles(values);
            expect(q.median).toBeCloseTo(stats.calculateMedian(values), 12);
            expect(q.q1).toBeCloseTo(stats.calculatePercentile(values, 25), 12);
            expect(q.q3).toBeCloseTo(stats.calculatePercentile(values, 75), 12);
            expect(q.iqr).toBeCloseTo(q.q3 - q.q1, 12);
        }
    );

    it("returns zeros for an empty input and does not reorder the caller's array", function () {
        expect(stats.calculateQuartiles([])).toEqual({ q1: 0, q2: 0, q3: 0, iqr: 0, median: 0 });
        const values = [3, 1, 2];
        stats.calculateQuartiles(values);
        expect(values).toEqual([3, 1, 2]);
    });

    it("IQR bounds follow from the interpolated quartiles", function () {
        const b = stats.calculateIQRBounds([1, 2, 3, 4], 1.5);
        expect(b.lowerBound).toBeCloseTo(1.75 - 2.25, 12);
        expect(b.upperBound).toBeCloseTo(3.25 + 2.25, 12);
    });
});
