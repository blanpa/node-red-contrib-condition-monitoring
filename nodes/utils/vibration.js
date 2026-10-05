/**
 * Vibration-analysis helpers shared by the signal-analyzer node.
 *
 * Everything here is a pure function of its arguments so it can be unit-tested
 * without a Node-RED runtime.
 */
"use strict";

/**
 * Vibration-severity zone tables (RMS velocity in mm/s, 10–1000 Hz band).
 *
 * `group*` entries follow ISO 20816-3 (successor of ISO 10816-3; Table A.1 of
 * ISO 10816-3:2009 carried into the 2022 edition) for industrial machines with
 * rated power above 15 kW, rated by machine *group* and *foundation*.
 *
 * `class*` entries are the older ISO 10816-1 / ISO 2372 classes I–IV. They are
 * kept so existing flows keep evaluating exactly as before; new flows should use
 * a group entry.
 */
const ISO_SEVERITY_TABLES = Object.freeze({
    group1_rigid: Object.freeze({
        ab: 2.3,
        bc: 4.5,
        cd: 7.1,
        standard: "ISO 20816-3",
        label: "Group 1: large machines 300 kW – 50 MW, rigid foundation"
    }),
    group1_flexible: Object.freeze({
        ab: 3.5,
        bc: 7.1,
        cd: 11.0,
        standard: "ISO 20816-3",
        label: "Group 1: large machines 300 kW – 50 MW, flexible foundation"
    }),
    group2_rigid: Object.freeze({
        ab: 1.4,
        bc: 2.8,
        cd: 4.5,
        standard: "ISO 20816-3",
        label: "Group 2: medium machines 15 – 300 kW, rigid foundation"
    }),
    group2_flexible: Object.freeze({
        ab: 2.3,
        bc: 4.5,
        cd: 7.1,
        standard: "ISO 20816-3",
        label: "Group 2: medium machines 15 – 300 kW, flexible foundation"
    }),
    class1: Object.freeze({
        ab: 0.71,
        bc: 1.8,
        cd: 4.5,
        standard: "ISO 10816-1 (legacy)",
        label: "Class I: small machines up to 15 kW"
    }),
    class2: Object.freeze({
        ab: 1.12,
        bc: 2.8,
        cd: 7.1,
        standard: "ISO 10816-1 (legacy)",
        label: "Class II: medium machines 15 – 75 kW"
    }),
    class3: Object.freeze({
        ab: 1.8,
        bc: 4.5,
        cd: 11.2,
        standard: "ISO 10816-1 (legacy)",
        label: "Class III: large machines on rigid foundations"
    }),
    class4: Object.freeze({
        ab: 2.8,
        bc: 7.1,
        cd: 18.0,
        standard: "ISO 10816-1 (legacy)",
        label: "Class IV: large machines on flexible foundations"
    })
});

const DEFAULT_MACHINE_CLASS = "group2_rigid";

/** Evaluation band the standard prescribes for broadband velocity, in Hz. */
const ISO_BAND_LOW_HZ = 10;
const ISO_BAND_HIGH_HZ = 1000;

/**
 * Rate an RMS velocity against the zone table of a machine class.
 *
 * @param {number} rmsVelocity - broadband RMS velocity in mm/s
 * @param {string} machineClass - key of ISO_SEVERITY_TABLES
 * @param {string} inputUnit - unit the value was converted from ("raw" disables the rating)
 * @returns {object} zone / severity / recommendation / limits …
 */
function evaluateVibrationSeverity(rmsVelocity, machineClass, inputUnit) {
    const key = ISO_SEVERITY_TABLES[machineClass] ? machineClass : DEFAULT_MACHINE_CLASS;
    const table = ISO_SEVERITY_TABLES[key];

    if (inputUnit === "raw") {
        return {
            zone: "N/A",
            severity: "unknown",
            recommendation:
                "ISO 20816 not applicable - input unit is raw/dimensionless. Configure velocity or acceleration unit for proper evaluation.",
            rmsVelocity: rmsVelocity,
            machineClass: key,
            standard: table.standard,
            limits: null,
            zoneProgress: 0,
            isAlarm: false,
            isWarning: false,
            inputUnit: inputUnit,
            isValid: false
        };
    }

    const limits = { ab: table.ab, bc: table.bc, cd: table.cd };

    let zone, severity, recommendation;
    if (rmsVelocity <= limits.ab) {
        zone = "A";
        severity = "good";
        recommendation = "Newly commissioned machine condition - excellent";
    } else if (rmsVelocity <= limits.bc) {
        zone = "B";
        severity = "acceptable";
        recommendation = "Acceptable for unrestricted long-term operation";
    } else if (rmsVelocity <= limits.cd) {
        zone = "C";
        severity = "warning";
        recommendation = "Acceptable only for limited periods - schedule maintenance";
    } else {
        zone = "D";
        severity = "critical";
        recommendation = "Vibration causes damage - immediate action required";
    }

    // How far into the current zone the value sits (0-100 %)
    let zoneProgress;
    if (zone === "A") {
        zoneProgress = (rmsVelocity / limits.ab) * 100;
    } else if (zone === "B") {
        zoneProgress = ((rmsVelocity - limits.ab) / (limits.bc - limits.ab)) * 100;
    } else if (zone === "C") {
        zoneProgress = ((rmsVelocity - limits.bc) / (limits.cd - limits.bc)) * 100;
    } else {
        zoneProgress = Math.min(100, ((rmsVelocity - limits.cd) / limits.cd) * 100);
    }

    return {
        zone: zone,
        severity: severity,
        recommendation: recommendation,
        rmsVelocity: rmsVelocity,
        machineClass: key,
        standard: table.standard,
        limits: limits,
        zoneProgress: Math.min(100, Math.max(0, zoneProgress)),
        isAlarm: zone === "D",
        isWarning: zone === "C" || zone === "D",
        inputUnit: inputUnit,
        isValid: true
    };
}

/**
 * Characteristic rolling-element bearing fault frequencies from geometry.
 *
 *   BPFO = n/2 · f_r · (1 − d/D · cos α)        outer race
 *   BPFI = n/2 · f_r · (1 + d/D · cos α)        inner race
 *   BSF  = D/(2d) · f_r · (1 − (d/D · cos α)²)  rolling element
 *   FTF  = f_r/2 · (1 − d/D · cos α)            cage
 *
 * @param {number} shaftFreq - shaft rotation frequency in Hz
 * @param {number} n - number of rolling elements
 * @param {number} d - rolling-element diameter (any unit, same as D)
 * @param {number} D - pitch diameter
 * @param {number} [alphaDeg=0] - contact angle in degrees
 * @returns {{BPFO:number,BPFI:number,BSF:number,FTF:number}|null} null when the geometry is unusable
 */
function bearingFaultFrequencies(shaftFreq, n, d, D, alphaDeg) {
    if (!(shaftFreq > 0) || !(n > 0) || !(d > 0) || !(D > 0) || d >= D) {
        return null;
    }
    const alpha = ((Number.isFinite(alphaDeg) ? alphaDeg : 0) * Math.PI) / 180;
    const ratio = (d / D) * Math.cos(alpha);
    return {
        BPFO: (n / 2) * shaftFreq * (1 - ratio),
        BPFI: (n / 2) * shaftFreq * (1 + ratio),
        BSF: (D / (2 * d)) * shaftFreq * (1 - ratio * ratio),
        FTF: (shaftFreq / 2) * (1 - ratio)
    };
}

/**
 * Broadband RMS velocity from an acceleration spectrum by bin-wise integration
 * (v_k = a_k / (2π f_k)), restricted to [fLow, fHigh].
 *
 * `magnitudes` must be the two-sided-scaled magnitudes |X_k| / N of a
 * *rectangular-windowed* real signal in m/s², as produced by the
 * signal-analyzer's FFT (single-sided amplitude is therefore 2·m_k, and the RMS
 * contribution of one bin is (2·m_k)² / 2 = 2·m_k²).
 *
 * @param {number[]} frequencies - bin centre frequencies in Hz
 * @param {number[]} magnitudes - |X_k| / N in m/s²
 * @param {number} [fLow=10]
 * @param {number} [fHigh=1000]
 * @returns {{rms:number, bins:number, fLow:number, fHigh:number}} rms in m/s
 */
function velocityRmsFromAccelerationSpectrum(frequencies, magnitudes, fLow, fHigh) {
    const lo = Number.isFinite(fLow) ? fLow : ISO_BAND_LOW_HZ;
    const hi = Number.isFinite(fHigh) ? fHigh : ISO_BAND_HIGH_HZ;
    let sum = 0;
    let bins = 0;
    for (let k = 0; k < magnitudes.length; k++) {
        const f = frequencies[k];
        if (!(f >= lo) || f > hi || f <= 0) continue;
        const v = magnitudes[k] / (2 * Math.PI * f);
        sum += 2 * v * v;
        bins++;
    }
    return { rms: Math.sqrt(sum), bins: bins, fLow: lo, fHigh: hi };
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation,
 * relative error < 1.15e-9). Used to turn a confidence level into a z-score.
 *
 * @param {number} p - probability in (0, 1)
 * @returns {number} z with Φ(z) = p; ±Infinity at the bounds, NaN outside
 */
function normalQuantile(p) {
    if (!(p > 0 && p < 1)) {
        if (p === 0) return -Infinity;
        if (p === 1) return Infinity;
        return NaN;
    }
    const a = [
        -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
        2.506628277459239
    ];
    const b = [
        -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1
    ];
    const c = [
        -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
        2.938163982698783
    ];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pLow = 0.02425;
    const pHigh = 1 - pLow;
    let q, r;
    if (p < pLow) {
        q = Math.sqrt(-2 * Math.log(p));
        return (
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        );
    }
    if (p <= pHigh) {
        q = p - 0.5;
        r = q * q;
        return (
            ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
            (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
        );
    }
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
        -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
}

/**
 * Two-sided z-score for a confidence level, e.g. 0.95 → 1.96, 0.99 → 2.576.
 * Out-of-range levels fall back to 95 %.
 */
function zScoreForConfidence(level) {
    if (!(level > 0 && level < 1)) return 1.959963984540054;
    return normalQuantile(1 - (1 - level) / 2);
}

module.exports = {
    ISO_SEVERITY_TABLES,
    DEFAULT_MACHINE_CLASS,
    ISO_BAND_LOW_HZ,
    ISO_BAND_HIGH_HZ,
    evaluateVibrationSeverity,
    bearingFaultFrequencies,
    velocityRmsFromAccelerationSpectrum,
    normalQuantile,
    zScoreForConfidence
};
