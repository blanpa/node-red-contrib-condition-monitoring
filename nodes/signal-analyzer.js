module.exports = function (RED) {
    "use strict";
    const { copyPassthrough } = require("./utils/message");

    // Admin-route auth guard (Node-RED does not apply adminAuth to httpAdmin routes)
    const { needsPermission } = require("./utils/admin-auth");

    // Import shared statistics utilities
    const stats = require("./utils/statistics");

    // Import state persistence helper
    const persistenceHelper = require("./utils/persistence-helper");

    // Config validation: parse + range-clamp (0 stays 0 where it is valid)
    const { clampInt, clampFloat } = require("./utils/config-validator");

    // ISO 20816 severity tables, bearing geometry, spectral integration
    const vibration = require("./utils/vibration");

    // Per-group state (Group By): key resolution and the LRU-bounded store
    const groupState = require("./utils/group-state");

    // Windowing, FFT, filters, peak picking, cepstrum and the bearing / gear
    // diagnosis rules: pure functions, unit-testable without a runtime
    const dsp = require("./utils/signal-processing");
    const {
        arrayMax,
        arrayMin,
        amplitudeScale,
        performFFT,
        findSpectralPeaks,
        findSignificantPeaks,
        calculateSpectralFeatures,
        calculateSampleEntropy,
        calculateAutocorrelation,
        detectPeriodicity,
        detectPeaks,
        calculatePeakStatistics,
        performEnvelopeAnalysis,
        detectBearingFaults,
        performCepstrum,
        findRahmonics,
        gearSidebandAnalysis,
        detectGearFaults
    } = dsp;

    function SignalAnalyzerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        this.mode = config.mode || "fft"; // fft, vibration, peaks, envelope, cepstrum
        this.windowSize = clampInt(config.windowSize, 2, 1048576, 256);

        // FFT settings
        this.fftSize = clampInt(config.fftSize, 2, 1048576, 256);
        this.samplingRate = clampFloat(config.samplingRate, 0.001, 1e9, 1000);
        this.peakThreshold = clampFloat(config.peakThreshold, 0, 1e12, 0.1);
        this.vibrationThreshold = clampFloat(config.vibrationThreshold, 0, 1e12, 6);
        this.outputFormat = config.outputFormat || "peaks";
        this.windowFunction = config.windowFunction || "hann";
        this.overlapPercent = clampInt(config.overlapPercent, 0, 99, 50);

        // Peak detection settings
        // null = automatic (mean ± 2σ of the window)
        this.minPeakHeight = (function (raw) {
            const n = raw !== "" && raw !== undefined && raw !== null ? parseFloat(raw) : NaN;
            return Number.isFinite(n) ? n : null;
        })(config.minPeakHeight);
        this.minPeakDistance = clampInt(config.minPeakDistance, 0, 1000000, 5);
        this.peakType = config.peakType || "both";

        // Vibration settings
        this.vibInputUnit = config.vibInputUnit || "mm_s"; // Input data unit for the ISO severity rating
        // Machine class for the ISO 20816-3 zone table. The config key keeps its
        // historical name so existing flows (class1..class4, ISO 10816-1 legacy
        // tables) load unchanged; new nodes default to a 20816-3 group.
        this.iso10816Class = vibration.ISO_SEVERITY_TABLES[config.iso10816Class]
            ? config.iso10816Class
            : vibration.DEFAULT_MACHINE_CLASS;

        // Envelope analysis settings (bearing fault detection)
        this.envelopeBandLow = clampFloat(config.envelopeBandLow, 0, 1e9, 500); // Hz
        this.envelopeBandHigh = clampFloat(config.envelopeBandHigh, 0, 1e9, 5000); // Hz
        // Peak significance in the envelope spectrum: a line must exceed this
        // multiple of the spectral noise floor (median magnitude). 8 keeps the
        // largest noise peak of a 16k-bin spectrum (~5σ ≈ 6× median) out.
        this.envelopePeakFloor = clampFloat(config.envelopePeakFloor, 1, 1000, 8);
        // Fault frequencies can be typed in directly (Hz) …
        this.bearingBPFO = clampFloat(config.bearingBPFO, 0, 1e9, 0); // Ball Pass Freq Outer
        this.bearingBPFI = clampFloat(config.bearingBPFI, 0, 1e9, 0); // Ball Pass Freq Inner
        this.bearingBSF = clampFloat(config.bearingBSF, 0, 1e9, 0); // Ball Spin Freq
        this.bearingFTF = clampFloat(config.bearingFTF, 0, 1e9, 0); // Fundamental Train Freq
        // … or derived from the bearing geometry and the current shaft speed.
        // A typed-in value wins over the derived one for that frequency.
        this.bearingBalls = clampInt(config.bearingBalls, 0, 1000, 0); // rolling elements
        this.bearingBallDiameter = clampFloat(config.bearingBallDiameter, 0, 1e6, 0); // d
        this.bearingPitchDiameter = clampFloat(config.bearingPitchDiameter, 0, 1e6, 0); // D
        this.bearingContactAngle = clampFloat(config.bearingContactAngle, 0, 90, 0); // degrees
        // Default shaft speed (RPM). Overridable per message via msg.rpm /
        // msg.shaftSpeed / msg.config.shaftSpeed for variable-speed drives.
        this.shaftSpeed = clampFloat(config.shaftSpeed, 0, 1e9, 0);

        // Cepstrum analysis settings
        this.quefrencyRangeLow = clampFloat(config.quefrencyRangeLow, 0, 1e9, 0.001); // seconds
        this.quefrencyRangeHigh = clampFloat(config.quefrencyRangeHigh, 0, 1e9, 0.1); // seconds
        this.cepstrumThreshold = clampFloat(config.cepstrumThreshold, 0, 1e12, 0.1);
        // Sideband Energy Ratio above which a gear is reported as damaged
        this.gearSerThreshold = clampFloat(config.gearSerThreshold, 0.01, 1000, 1);
        // Parse gear tooth count from comma-separated string
        this.gearTeeth = [];
        if (config.gearToothCount && config.gearToothCount.trim() !== "") {
            this.gearTeeth = config.gearToothCount
                .split(",")
                .map(function (s) {
                    return parseInt(s.trim());
                })
                .filter(function (n) {
                    return !isNaN(n) && n > 0;
                });
        }

        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        // Kept off `this.debug`: that name is Node-RED's own logger method, and
        // overwriting it with a boolean breaks every node.debug(...) call — state
        // persistence logs through it, so a clobbered logger silently threw and
        // discarded the restored buffer.
        this.debugEnabled = config.debug === true;
        this.persistState = config.persistState === true;

        // Per-device grouping: keep one independent buffer per value of a message
        // property (e.g. "topic"), so a single node can serve an interleaved
        // multi-device stream. Empty = one shared buffer (default, legacy).
        this.groupBy = typeof config.groupBy === "string" ? config.groupBy.trim() : "";
        this.maxGroups = clampInt(config.maxGroups, 1, 10000, 50);

        // State: one entry per group, in least-recently-used order.
        // Messages without a usable group value land in DEFAULT_GROUP.
        const DEFAULT_GROUP = groupState.DEFAULT_GROUP;
        this.groups = new Map();

        // Debug logging helper
        const debugLog = function (message) {
            if (node.debugEnabled && typeof node.debug === "function") {
                node.debug(message);
            }
        };

        // Resolve the group key of a message (missing / unusable values share
        // DEFAULT_GROUP, so ungrouped traffic still has a home).
        function resolveGroupKey(msg) {
            return groupState.resolveGroupKey(RED, msg, node.groupBy);
        }

        // Fetch (or create) the buffer state for a key. Groups are kept in LRU
        // order, so an unbounded topic space evicts the least recently used
        // buffer instead of growing without limit.
        function getGroupState(key) {
            return groupState.getOrCreateGroup(node.groups, key, {
                max: node.maxGroups,
                lru: !!node.groupBy,
                create: function (k) {
                    return {
                        key: k,
                        buffer: [],
                        timestamps: [],
                        sampleCount: 0,
                        lastProcessedIndex: 0,
                        pending: 0, // samples buffered since the last analysis (overlap hop)
                        analyzed: false
                    };
                },
                onEvict: function (oldest) {
                    debugLog("Evicted least recently used group '" + oldest + "' (maxGroups=" + node.maxGroups + ")");
                }
            });
        }

        // Backwards-compatible read-only view of the default (ungrouped) bucket.
        // Releases before per-group buffering exposed these directly on the node;
        // flows and tests that inspect them keep working. With grouping enabled
        // they only describe traffic that carried no group value.
        ["buffer", "timestamps"].forEach(function (prop) {
            Object.defineProperty(node, prop, {
                configurable: true,
                get: function () {
                    const state = node.groups.get(DEFAULT_GROUP);
                    return state ? state[prop] : [];
                }
            });
        });
        Object.defineProperty(node, "sampleCount", {
            configurable: true,
            get: function () {
                const state = node.groups.get(DEFAULT_GROUP);
                return state ? state.sampleCount : 0;
            }
        });

        // Prefix status text with the group key so a shared node stays readable
        function groupText(state, text) {
            return node.groupBy && state.key !== DEFAULT_GROUP ? state.key + ": " + text : text;
        }

        // Initialize state persistence using helper.
        // Declared with `let` so onStateLoaded — which only runs once the async
        // load resolves, i.e. after this assignment — can reach the manager.
        let persistence = null;
        persistence = persistenceHelper.initializeStatePersistence(node, {
            stateKey: "signalAnalyzerState",
            saveInterval: 30000,
            debug: node.debugEnabled,
            onStateLoaded: function (state) {
                // v2 stores one entry per group; v1 stored a single flat buffer,
                // which restores into the default (ungrouped) bucket.
                const saved = state.groups || (state.buffer ? { "": state } : null);
                if (!saved) {
                    return;
                }

                let restored = 0;
                Object.keys(saved).forEach(function (key) {
                    const entry = saved[key];
                    if (!entry || !Array.isArray(entry.buffer) || entry.buffer.length === 0) {
                        return;
                    }
                    const target = getGroupState(key);
                    target.buffer = entry.buffer;
                    target.timestamps = Array.isArray(entry.timestamps) ? entry.timestamps : [];
                    target.sampleCount = entry.sampleCount || 0;
                    target.lastProcessedIndex = entry.lastProcessedIndex || 0;
                    restored += entry.buffer.length;
                });

                if (!state.groups && persistence) {
                    // Migrated a v1 payload: drop the flat keys so the stored blob
                    // does not carry a stale copy of the buffer forever.
                    ["buffer", "timestamps", "sampleCount", "lastProcessedIndex"].forEach(function (key) {
                        persistence.manager.delete(key);
                    });
                }

                if (restored === 0) {
                    return;
                }

                const scope = node.groupBy ? " in " + node.groups.size + " groups" : "";
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: node.mode + " - restored (" + restored + " samples" + scope + ")"
                });
                debugLog("Restored signal buffer from persistence: " + restored + " samples" + scope);
            },
            getStateToSave: function () {
                const groups = {};
                let count = 0;
                node.groups.forEach(function (state, key) {
                    if (state.buffer.length === 0) {
                        return;
                    }
                    groups[key] = {
                        buffer: state.buffer,
                        timestamps: state.timestamps,
                        sampleCount: state.sampleCount,
                        lastProcessedIndex: state.lastProcessedIndex
                    };
                    count++;
                });
                return count > 0 ? { version: 2, groups: groups } : null;
            }
        });

        node.status({ fill: "blue", shape: "ring", text: node.mode + " mode" });

        // Use shared statistics utilities
        const calculateMean = stats.calculateMean;
        const calculateStdDev = stats.calculateStdDev;

        // Vibration Features
        function calculateVibrationFeatures(data, shaftSpeedRpm, isWaveform) {
            const n = data.length;
            const sumSquares = data.reduce(function (sum, val) {
                return sum + val * val;
            }, 0);
            const rms = Math.sqrt(sumSquares / n);

            const max = arrayMax(data);
            const min = arrayMin(data);
            const peakToPeak = max - min;
            const peak = Math.max(Math.abs(max), Math.abs(min));
            const crestFactor = rms !== 0 ? peak / rms : 0;

            const mean = calculateMean(data);
            const stdDev = calculateStdDev(data, mean);

            const m4 =
                data.reduce(function (sum, val) {
                    return sum + Math.pow(val - mean, 4);
                }, 0) / n;
            const kurtosis = stdDev !== 0 ? m4 / Math.pow(stdDev, 4) - 3 : 0;

            const m3 =
                data.reduce(function (sum, val) {
                    return sum + Math.pow(val - mean, 3);
                }, 0) / n;
            const skewness = stdDev !== 0 ? m3 / Math.pow(stdDev, 3) : 0;

            const meanAbs =
                data.reduce(function (sum, val) {
                    return sum + Math.abs(val);
                }, 0) / n;
            const formFactor = meanAbs !== 0 ? rms / meanAbs : 0;
            const impulseFactor = meanAbs !== 0 ? peak / meanAbs : 0;

            let healthScore = 100;
            if (crestFactor > 5) healthScore -= 20;
            if (Math.abs(kurtosis) > 3) healthScore -= 20;
            if (Math.abs(skewness) > 1) healthScore -= 10;
            healthScore = Math.max(0, Math.min(100, healthScore));

            // Calculate Sample Entropy
            const sampleEntropy = calculateSampleEntropy(data, 2, 0.2 * stdDev);

            // Calculate Autocorrelation (first 10 lags)
            const autocorrelation = calculateAutocorrelation(data, 10);

            // Detect periodicity from autocorrelation peaks
            const periodicity = detectPeriodicity(autocorrelation);

            // ISO 20816-3 / ISO 10816 vibration severity assessment. Acceleration
            // input is integrated to velocity in the 10–1000 Hz band when the
            // sampling rate allows it (see convertToVelocity).
            const inputUnit = node.vibInputUnit || "mm_s";
            const conversion = convertToVelocity(rms, inputUnit, shaftSpeedRpm, isWaveform ? data : null);
            const isoResult = vibration.evaluateVibrationSeverity(
                conversion.rmsVelocity,
                node.iso10816Class,
                inputUnit
            );
            isoResult.conversion = conversion.method;
            if (conversion.band) isoResult.band = conversion.band;
            if (conversion.frequency) isoResult.conversionFrequency = conversion.frequency;

            return {
                rms: rms,
                peakToPeak: peakToPeak,
                peak: peak,
                crestFactor: crestFactor,
                kurtosis: kurtosis,
                skewness: skewness,
                mean: mean,
                stdDev: stdDev,
                formFactor: formFactor,
                impulseFactor: impulseFactor,
                sampleEntropy: sampleEntropy,
                autocorrelation: autocorrelation,
                periodicity: periodicity,
                healthScore: healthScore,
                // `iso20816` is the primary name; `iso10816` is kept as an alias of
                // the same object so existing flows keep working.
                iso20816: isoResult,
                iso10816: isoResult
            };
        }

        /**
         * Convert a broadband RMS reading to RMS velocity in mm/s for the ISO
         * severity rating.
         *
         * Velocity input only needs scaling. Acceleration input is integrated
         * bin-wise in the frequency domain (v_k = a_k / 2πf_k) over the 10–1000 Hz
         * band the standard prescribes, which is exact for any spectral content.
         * That needs an actual waveform: `samples` is only passed when the
         * message carried a frame (array payload), never for a stream of scalar
         * readings, whose buffer is a time series of *values* and not a signal.
         * When there is no waveform, or the sampling rate cannot support the
         * band (Nyquist below 10 Hz, fewer than 16 samples), we fall back to the
         * single-frequency relation v = a / (2πf) at the shaft frequency —
         * correct only when the signal is dominated by 1X, so the result says
         * which path was taken.
         *
         * @returns {{rmsVelocity:number, method:string, band?:number[], frequency?:number}}
         */
        function convertToVelocity(rmsValue, inputUnit, shaftSpeedRpm, samples) {
            switch (inputUnit) {
                case "mm_s":
                    return { rmsVelocity: rmsValue, method: "none" };
                case "m_s":
                    return { rmsVelocity: rmsValue * 1000, method: "scale" };
                case "g":
                case "m_s2": {
                    const toMs2 = inputUnit === "g" ? 9.80665 : 1;
                    const spectral = integrateAccelerationToVelocity(samples, toMs2);
                    if (spectral) return spectral;
                    const rpm = shaftSpeedRpm > 0 ? shaftSpeedRpm : node.shaftSpeed;
                    const convFreq = rpm > 0 ? rpm / 60 : 50; // Hz
                    return {
                        rmsVelocity: (rmsValue * toMs2 * 1000) / (2 * Math.PI * convFreq),
                        method: "single-frequency",
                        frequency: convFreq
                    };
                }
                case "raw":
                default:
                    return { rmsVelocity: rmsValue, method: "none" };
            }
        }

        // Spectral integration of an acceleration buffer to velocity RMS (mm/s).
        // Uses the largest power-of-two tail of the buffer so the FFT needs no
        // zero padding (padding would scale the amplitudes down by L/N), and a
        // rectangular window so the bin energies stay uncorrected.
        function integrateAccelerationToVelocity(samples, toMs2) {
            const fs = node.samplingRate;
            if (!Array.isArray(samples) || samples.length < 16 || !(fs / 2 > vibration.ISO_BAND_LOW_HZ)) {
                return null;
            }
            let n = 1;
            while (n * 2 <= samples.length) n *= 2;
            const tail = samples.slice(samples.length - n);
            const mean = calculateMean(tail);
            const centred = new Array(n);
            for (let i = 0; i < n; i++) {
                centred[i] = (tail[i] - mean) * toMs2;
            }
            const spectrum = performFFT(centred, n, fs, "rectangular");
            const fHigh = Math.min(vibration.ISO_BAND_HIGH_HZ, fs / 2);
            const r = vibration.velocityRmsFromAccelerationSpectrum(
                spectrum.frequencies,
                spectrum.magnitudes,
                vibration.ISO_BAND_LOW_HZ,
                fHigh
            );
            if (r.bins === 0) return null;
            return { rmsVelocity: r.rms * 1000, method: "spectral-integration", band: [r.fLow, r.fHigh] };
        }

        /**
         * The band-pass band the envelope analysis can actually use at this
         * sampling rate. An upper edge at or above Nyquist is lowered to 90 % of
         * it; a band that still does not fit (lower edge above the upper one)
         * leaves only the crude moving-average fallback, whose result is not a
         * usable envelope spectrum. Either case is reported once — silently
         * analysing the wrong band is how a healthy-looking result hides a
         * misconfigured sampling rate.
         */
        function resolveEnvelopeBand(samplingRate) {
            const nyquist = samplingRate / 2;
            const low = node.envelopeBandLow;
            let high = node.envelopeBandHigh;
            let note = null;
            if (high >= nyquist) {
                high = 0.9 * nyquist;
                note = "upper band edge lowered from " + node.envelopeBandHigh + " Hz to " + high + " Hz";
            }
            const valid = low > 0 && low < high;
            if (!valid) {
                high = node.envelopeBandHigh;
                note =
                    "band " +
                    low +
                    "-" +
                    high +
                    " Hz does not fit below the Nyquist frequency; falling back to a crude moving-average filter, " +
                    "the result is unreliable";
            }
            if (note && !node.envelopeBandWarned) {
                node.envelopeBandWarned = true;
                node.warn(
                    "Envelope: " + note + " (sampling rate " + samplingRate + " Hz, Nyquist " + nyquist + " Hz)."
                );
            }
            return { low: low, high: high, filter: valid ? "butterworth" : "moving-average" };
        }

        // Process Cepstrum Analysis
        function processCepstrum(msg, state, value, shaftSpeedRpm) {
            state.buffer.push(value);

            if (state.buffer.length < node.fftSize) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: groupText(state, "Cepstrum: " + state.buffer.length + "/" + node.fftSize)
                });
                return null;
            }

            if (state.buffer.length > node.fftSize) {
                state.buffer.shift();
            }
            if (!dueForAnalysis(state)) return null;

            // 0 = unknown. Gear-mesh matching needs the real shaft speed;
            // assuming one would produce confident diagnoses from a guess.
            const rpm = shaftSpeedRpm > 0 ? shaftSpeedRpm : 0;
            const shaftFreq = rpm / 60;
            const minQuefrency = node.quefrencyRangeLow || 0.001;
            const maxQuefrency = node.quefrencyRangeHigh || 0.1;

            // Perform cepstrum analysis
            const cepResult = performCepstrum(state.buffer, node.fftSize, node.samplingRate);

            // Find rahmonics (periodic components)
            const rahmonics = findRahmonics(
                cepResult.quefrencies,
                cepResult.cepstrum,
                minQuefrency,
                maxQuefrency,
                node.cepstrumThreshold
            );

            // Detect gear faults if teeth count provided
            const gearTeeth = (Array.isArray(msg.gearTeeth) ? msg.gearTeeth : node.gearTeeth || []).filter(
                function (t) {
                    return Number.isFinite(t) && t > 0;
                }
            );
            // Gear condition from the sidebands around each mesh frequency
            const gears =
                rpm > 0
                    ? gearTeeth.map(function (teeth) {
                          return gearSidebandAnalysis(cepResult.frequencies, cepResult.magnitudes, shaftFreq, teeth);
                      })
                    : [];
            const gearFaults = detectGearFaults(gears, node.gearSerThreshold);
            if (rpm === 0 && gearTeeth.length > 0 && !node.gearSpeedWarned) {
                node.gearSpeedWarned = true;
                node.warn(
                    "Cepstrum: gear teeth are configured but the shaft speed is unknown - set it or send msg.rpm"
                );
            }

            const hasAnomaly = gearFaults.length > 0;

            const outputMsg = {
                payload: value,
                cepstrum: {
                    rahmonics: rahmonics.slice(0, 10),
                    dominantQuefrency: rahmonics.length > 0 ? rahmonics[0].quefrency : null,
                    dominantFrequency: rahmonics.length > 0 ? rahmonics[0].fundamentalFrequency : null
                },
                gears: gears.filter(Boolean).map(function (g) {
                    return {
                        teeth: g.teeth,
                        gmf: g.gmf,
                        detectedGmf: g.detectedGmf,
                        meshFound: g.meshFound,
                        resolved: g.resolved,
                        sidebandEnergyRatio: g.sidebandEnergyRatio,
                        sidebands: g.sidebands
                    };
                }),
                gearFaults: gearFaults,
                shaftSpeed: rpm,
                shaftFrequency: shaftFreq,
                hasFault: hasAnomaly,
                faultCount: gearFaults.length,
                timestamp: Date.now()
            };

            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            copyPassthrough(outputMsg, msg);

            const statusText = hasAnomaly
                ? "FAULT: " + gearFaults[0].type
                : rahmonics.length > 0
                  ? "Peak: " + rahmonics[0].fundamentalFrequency.toFixed(1) + " Hz"
                  : "No peaks";
            const statusColor = hasAnomaly ? "red" : "green";
            node.status({ fill: statusColor, shape: hasAnomaly ? "ring" : "dot", text: groupText(state, statusText) });

            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }

        /**
         * Resolve the bearing fault frequencies for this analysis: typed-in
         * values win, anything left at 0 is derived from the geometry when the
         * geometry and shaft speed allow it.
         */
        function resolveBearingFrequencies(shaftFreq, bearing) {
            const derived = vibration.bearingFaultFrequencies(
                shaftFreq,
                bearing.balls,
                bearing.ballDiameter,
                bearing.pitchDiameter,
                bearing.contactAngle
            );
            const out = { BPFO: 0, BPFI: 0, BSF: 0, FTF: 0 };
            let manual = 0;
            let geometry = 0;
            ["BPFO", "BPFI", "BSF", "FTF"].forEach(function (key) {
                if (bearing[key] > 0) {
                    out[key] = bearing[key];
                    manual++;
                } else if (derived) {
                    out[key] = derived[key];
                    geometry++;
                }
            });
            out.source = manual && geometry ? "mixed" : manual ? "manual" : geometry ? "geometry" : "none";
            return out;
        }

        // Process Envelope Analysis
        function processEnvelope(msg, state, value, shaftSpeedRpm, bearing, peakFloorFactor) {
            state.buffer.push(value);

            if (state.buffer.length < node.fftSize) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: groupText(state, "Envelope: " + state.buffer.length + "/" + node.fftSize)
                });
                return null;
            }

            if (state.buffer.length > node.fftSize) {
                state.buffer.shift();
            }
            if (!dueForAnalysis(state)) return null;

            // Shaft frequency from the per-message / configured RPM
            const shaftFreq = shaftSpeedRpm > 0 ? shaftSpeedRpm / 60 : 0;
            const bearingFreqs = resolveBearingFrequencies(shaftFreq, bearing);

            // Perform envelope analysis
            const band = resolveEnvelopeBand(node.samplingRate);
            const envelope = performEnvelopeAnalysis(state.buffer, node.samplingRate, band.low, band.high, debugLog);

            // FFT of the envelope with its mean removed: the envelope of a
            // rectified signal has a large DC component that would otherwise set
            // the peak-normalisation and hide the modulation lines behind it.
            const envMean = calculateMean(envelope);
            const envelopeAC = envelope.map(function (v) {
                return v - envMean;
            });
            const envelopeFFT = performFFT(envelopeAC, node.fftSize, node.samplingRate, "hann");
            const floorFactor = peakFloorFactor > 0 ? peakFloorFactor : node.envelopePeakFloor;
            const envelopePeaks = findSignificantPeaks(envelopeFFT.frequencies, envelopeFFT.magnitudes, floorFactor);
            const binWidth = envelopeFFT.frequencies.length > 1 ? envelopeFFT.frequencies[1] : 0;

            // Detect bearing faults
            const faults = detectBearingFaults(
                envelopePeaks,
                shaftFreq,
                bearingFreqs.BPFO,
                bearingFreqs.BPFI,
                bearingFreqs.BSF,
                bearingFreqs.FTF,
                0.05,
                binWidth,
                floorFactor
            );

            const hasAnomaly = faults.length > 0;

            const outputMsg = {
                payload: value,
                envelope: {
                    peaks: envelopePeaks.slice(0, 10),
                    bandLow: band.low,
                    bandHigh: band.high,
                    filter: state.buffer.length < 12 ? "moving-average" : band.filter
                },
                bearingFaults: faults,
                shaftSpeed: shaftSpeedRpm,
                shaftFrequency: shaftFreq,
                bearingFreqs: bearingFreqs,
                hasFault: hasAnomaly,
                faultCount: faults.length,
                timestamp: Date.now()
            };

            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            copyPassthrough(outputMsg, msg);

            const statusText = hasAnomaly
                ? "FAULT: " + faults[0].type + " " + faults[0].harmonic + "X"
                : "No faults detected";
            const statusColor = hasAnomaly ? "red" : "green";
            node.status({ fill: statusColor, shape: hasAnomaly ? "ring" : "dot", text: groupText(state, statusText) });

            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }

        /**
         * Whether a buffered-and-full group is due for another analysis.
         *
         * A frame (array payload) is analysed once per message. A stream of
         * single samples is analysed when the buffer first fills and then every
         * `hop` samples, the hop following from the configured overlap
         * (fftSize · (1 − overlap)). Without this every single sample triggered
         * a full transform of an almost identical buffer.
         */
        function dueForAnalysis(state) {
            if (!state.isFrame) {
                const hop = Math.max(1, Math.round(node.fftSize * (1 - node.overlapPercent / 100)));
                if (state.analyzed && state.pending < hop) return false;
            }
            state.pending = 0;
            state.analyzed = true;
            return true;
        }

        // Process FFT
        function processFFT(msg, state, value) {
            state.buffer.push(value);

            if (state.buffer.length < node.fftSize) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: groupText(state, "Buffering: " + state.buffer.length + "/" + node.fftSize)
                });
                return null;
            }

            if (state.buffer.length > node.fftSize) {
                state.buffer.shift();
            }

            if (!dueForAnalysis(state)) return null;

            debugLog(
                "FFT: window=" +
                    node.windowFunction +
                    ", size=" +
                    node.fftSize +
                    ", overlap=" +
                    node.overlapPercent +
                    "%"
            );
            // The mean is removed before the transform and reported separately.
            // A DC offset (gravity on an accelerometer, a 4-20 mA live zero)
            // otherwise dominates the spectrum, leaks into the first bins through
            // the window, and pushes every real line below the relative peak
            // threshold.
            const dcOffset = calculateMean(state.buffer);
            const centred = new Array(state.buffer.length);
            for (let i = 0; i < centred.length; i++) {
                centred[i] = state.buffer[i] - dcOffset;
            }
            const fftResult = performFFT(centred, node.fftSize, node.samplingRate, node.windowFunction);
            const peaks = findSpectralPeaks(fftResult.frequencies, fftResult.magnitudes, node.peakThreshold);
            const features = calculateSpectralFeatures(fftResult.frequencies, fftResult.magnitudes);
            // `magnitude` stays |X_k| / N as before; `amplitude` is the physical
            // single-sided amplitude (a sine of amplitude A reads A).
            const scale = amplitudeScale(node.windowFunction);
            peaks.forEach(function (p) {
                p.amplitude = p.magnitude * scale;
            });

            const outputMsg = {
                payload: value,
                peaks: peaks,
                dominantFrequency: peaks.length > 0 ? peaks[0].frequency : null,
                dcOffset: dcOffset,
                amplitudeScale: scale,
                features: features,
                samplingRate: node.samplingRate,
                fftSize: node.fftSize,
                windowFunction: node.windowFunction,
                overlapPercent: node.overlapPercent
            };

            // Set topic if configured
            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }

            if (node.outputFormat === "full") {
                outputMsg.frequencies = fftResult.frequencies;
                outputMsg.magnitudes = fftResult.magnitudes;
            }

            copyPassthrough(outputMsg, msg);

            const statusText = peaks.length > 0 ? "Peak: " + peaks[0].frequency.toFixed(1) + " Hz" : "No peaks";
            node.status({ fill: "green", shape: "dot", text: groupText(state, statusText) });

            return { normal: outputMsg, anomaly: null };
        }

        // Process Vibration with configurable threshold (for msg.config override)
        function processVibrationWithConfig(msg, state, values, vibrationThreshold, shaftSpeedRpm) {
            for (let i = 0; i < values.length; i++) state.buffer.push(values[i]);

            if (state.buffer.length > node.windowSize) {
                state.buffer = state.buffer.slice(-node.windowSize);
            }

            if (state.buffer.length < Math.min(10, node.windowSize)) {
                node.status({
                    fill: "yellow",
                    shape: "ring",
                    text: groupText(state, "Collecting: " + state.buffer.length + "/" + node.windowSize)
                });
                return null;
            }

            // A frame (array payload) is a waveform the ISO conversion may
            // integrate; a scalar stream is not, even though it fills the same buffer.
            const isWaveform = values.length >= 16;
            const features = calculateVibrationFeatures(state.buffer, shaftSpeedRpm, isWaveform);

            node.status({
                fill: "green",
                shape: "dot",
                text: groupText(state, "RMS: " + features.rms.toFixed(2) + " | CF: " + features.crestFactor.toFixed(2))
            });

            const outputMsg = {
                payload: features,
                topic: msg.topic || "vibration-features",
                timestamp: Date.now(),
                windowSize: state.buffer.length
            };

            copyPassthrough(outputMsg, msg);

            // Check for potential issues (vibrationThreshold overrides default crest factor check)
            const crestFactorThreshold = vibrationThreshold > 0 ? vibrationThreshold : 6;
            const hasAnomaly = features.crestFactor > crestFactorThreshold || Math.abs(features.kurtosis) > 4;

            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }

        // Process Peaks with configurable threshold (for msg.config override)
        function processPeaksWithConfig(msg, state, value, timestamp, peakThreshold) {
            state.sampleCount++;
            state.buffer.push(value);
            state.timestamps.push(timestamp);

            if (state.buffer.length > node.windowSize) {
                state.buffer.shift();
                state.timestamps.shift();
            }

            if (state.buffer.length < 3) {
                return null;
            }

            const peaks = detectPeaks(
                state.buffer,
                state.timestamps,
                peakThreshold,
                node.minPeakDistance,
                node.peakType
            );
            const stats = calculatePeakStatistics(peaks, state.buffer);

            const currentIndex = state.buffer.length - 1;
            const isPeak = peaks.some(function (p) {
                return p.index === currentIndex;
            });

            const outputMsg = {
                payload: value,
                isPeak: isPeak,
                peaks: peaks,
                peakCount: peaks.length,
                stats: stats,
                sampleCount: state.sampleCount,
                timestamp: timestamp
            };

            copyPassthrough(outputMsg, msg);

            const color = isPeak ? "yellow" : "green";
            node.status({
                fill: color,
                shape: isPeak ? "ring" : "dot",
                text: groupText(state, "Peaks: " + peaks.length)
            });

            return { normal: isPeak ? null : outputMsg, anomaly: isPeak ? outputMsg : null };
        }

        function positiveNumber(v) {
            const n = typeof v === "string" ? parseFloat(v) : v;
            return Number.isFinite(n) && n > 0 ? n : null;
        }

        // Per-message shaft speed (RPM). Order: msg.rpm, msg.shaftSpeed,
        // msg.config.shaftSpeed, node setting. 0 = unknown.
        function resolveShaftSpeed(msg, cfg) {
            return (
                positiveNumber(msg.rpm) ||
                positiveNumber(msg.shaftSpeed) ||
                positiveNumber(cfg.shaftSpeed) ||
                node.shaftSpeed ||
                0
            );
        }

        // Bearing frequencies / geometry, with msg.config overrides.
        function resolveBearingConfig(cfg) {
            const pick = function (key, fallback) {
                const v = cfg[key] !== undefined ? parseFloat(cfg[key]) : NaN;
                return Number.isFinite(v) && v >= 0 ? v : fallback;
            };
            return {
                BPFO: pick("bearingBPFO", node.bearingBPFO),
                BPFI: pick("bearingBPFI", node.bearingBPFI),
                BSF: pick("bearingBSF", node.bearingBSF),
                FTF: pick("bearingFTF", node.bearingFTF),
                balls: pick("bearingBalls", node.bearingBalls),
                ballDiameter: pick("bearingBallDiameter", node.bearingBallDiameter),
                pitchDiameter: pick("bearingPitchDiameter", node.bearingPitchDiameter),
                contactAngle: pick("bearingContactAngle", node.bearingContactAngle)
            };
        }

        node.on("input", function (msg, send, done) {
            try {
                // Dynamic configuration via msg.config
                // Allows runtime override of node settings
                const cfg = msg.config && typeof msg.config === "object" ? msg.config : {};
                const activeMode = cfg.mode || node.mode;
                const activeVibrationThreshold =
                    cfg.vibrationThreshold !== undefined ? parseFloat(cfg.vibrationThreshold) : node.vibrationThreshold;
                // Peak height for "peaks" mode: msg.config.minPeakHeight, the
                // legacy msg.config.peakThreshold override, then the node's
                // "Min Peak Height" (null = automatic).
                const overrideHeight = parseFloat(
                    cfg.minPeakHeight !== undefined ? cfg.minPeakHeight : cfg.peakThreshold
                );
                const activePeakHeight = Number.isFinite(overrideHeight) ? overrideHeight : node.minPeakHeight;
                // Shaft speed for this message (variable-speed drives): msg.rpm,
                // msg.shaftSpeed, msg.config.shaftSpeed, then the node setting.
                const activeShaftSpeed = resolveShaftSpeed(msg, cfg);
                const activeBearing = resolveBearingConfig(cfg);

                // msg.reset clears the buffer of the group this message belongs to;
                // msg.reset === "all" clears every group at once.
                if (msg.reset === "all") {
                    node.groups.clear();
                    node.status({ fill: "blue", shape: "ring", text: activeMode + " - reset (all groups)" });
                    done();
                    return;
                }

                const state = getGroupState(resolveGroupKey(msg));

                if (msg.reset === true) {
                    state.buffer = [];
                    state.timestamps = [];
                    state.sampleCount = 0;
                    state.lastProcessedIndex = 0;
                    state.pending = 0;
                    state.analyzed = false;
                    node.status({ fill: "blue", shape: "ring", text: groupText(state, activeMode + " - reset") });
                    done();
                    return;
                }

                let result = null;

                // For frame (array) payloads: buffer every finite sample but run the
                // expensive transform only once, on the most recent sample. Without this
                // a 2048-sample waveform frame would trigger 2048 full FFTs per message
                // (O(N²·logN)) and discard all but the last result.
                const bufferFrameReturnLast = function (payload) {
                    const arr = Array.isArray(payload) ? payload : [payload];
                    const finite = [];
                    for (let i = 0; i < arr.length; i++) {
                        const v = parseFloat(arr[i]);
                        if (Number.isFinite(v)) finite.push(v);
                    }
                    if (finite.length === 0) return null;
                    state.isFrame = Array.isArray(payload) && finite.length > 1;
                    state.pending = (state.pending || 0) + finite.length;
                    for (let i = 0; i < finite.length - 1; i++) {
                        state.buffer.push(finite[i]);
                        if (state.buffer.length > node.fftSize) state.buffer.shift();
                    }
                    return { last: finite[finite.length - 1] };
                };

                if (activeMode === "fft") {
                    // accept a single number or a whole waveform frame (array)
                    const framed = bufferFrameReturnLast(msg.payload);
                    if (!framed) {
                        node.warn("Invalid payload: not a finite number (or array of numbers)");
                        done();
                        return;
                    }
                    result = processFFT(msg, state, framed.last);
                } else if (activeMode === "vibration") {
                    let values = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
                    values = values.filter(function (v) {
                        return typeof v === "number" && Number.isFinite(v);
                    });
                    if (values.length === 0) {
                        node.warn("No valid numeric values found");
                        done();
                        return;
                    }
                    result = processVibrationWithConfig(msg, state, values, activeVibrationThreshold, activeShaftSpeed);
                } else if (activeMode === "peaks") {
                    const value = parseFloat(msg.payload);
                    const timestamp = msg.timestamp || Date.now();
                    if (!Number.isFinite(value)) {
                        node.warn("Invalid payload: not a finite number");
                        done();
                        return;
                    }
                    result = processPeaksWithConfig(msg, state, value, timestamp, activePeakHeight);
                } else if (activeMode === "envelope") {
                    const framed = bufferFrameReturnLast(msg.payload);
                    if (!framed) {
                        node.warn("Invalid payload: not a finite number (or array of numbers)");
                        done();
                        return;
                    }
                    const activePeakFloor =
                        cfg.envelopePeakFloor !== undefined
                            ? parseFloat(cfg.envelopePeakFloor)
                            : node.envelopePeakFloor;
                    result = processEnvelope(msg, state, framed.last, activeShaftSpeed, activeBearing, activePeakFloor);
                } else if (activeMode === "cepstrum") {
                    const framed = bufferFrameReturnLast(msg.payload);
                    if (!framed) {
                        node.warn("Invalid payload: not a finite number (or array of numbers)");
                        done();
                        return;
                    }
                    result = processCepstrum(msg, state, framed.last, activeShaftSpeed);
                }

                if (result) {
                    // Tag the output with the group it was computed from, so a shared
                    // node stays traceable downstream.
                    if (node.groupBy) {
                        if (result.normal) result.normal.group = state.key;
                        if (result.anomaly) result.anomaly.group = state.key;
                    }
                    if (result.anomaly) {
                        send([null, result.anomaly]);
                    } else if (result.normal) {
                        send([result.normal, null]);
                    }
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err);
            }
        });

        node.on("close", async function (done) {
            try {
                // Save state before closing if persistence enabled
                if (persistence) {
                    await persistence.close();
                }

                node.groups.clear();
                node.status({});
            } finally {
                // Always release the runtime: a close handler that never calls
                // done() stalls every deploy until Node-RED's close timeout.
                if (done) done();
            }
        });
    }

    RED.nodes.registerType("signal-analyzer", SignalAnalyzerNode);

    // API endpoint to check FFT library availability
    RED.httpAdmin.get("/signal-analyzer/fft-status", needsPermission(RED, "signal-analyzer.read"), function (req, res) {
        res.json({
            available: dsp.fftAvailable,
            library: dsp.fftAvailable ? "fft.js (Radix-4)" : "fallback DFT",
            performance: dsp.fftAvailable ? "O(n log n)" : "O(n²)"
        });
    });
};
