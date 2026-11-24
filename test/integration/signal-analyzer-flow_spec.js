"use strict";

const { startRed, captureNode, buildFlow } = require("./red-runtime");

/**
 * End-to-end test for the signal-analyzer FFT mode.
 *
 * We feed a 50 Hz sine wave (sampling at 1024 Hz) through the node and
 * expect the dominant peak to come back near 50 Hz. This proves the
 * fft.js fast path is wired correctly — that path was touched in PR1
 * (the unused `complexInput` stub was removed; if the call sequence got
 * broken the spectrum would come out as zeros / a wrong peak).
 */
describe("integration: signal-analyzer FFT flow", () => {
    let harness;
    const TAB = "sig-tab";
    const ANALYZER = "sig-analyzer";
    const CAP = "sig-cap";
    const GROUPED = "sig-grouped";
    const GROUPED_CAP = "sig-grouped-cap";
    const VIB = "sig-vibration";
    const VIB_NORMAL_CAP = "sig-vibration-normal-cap";
    const VIB_ALARM_CAP = "sig-vibration-alarm-cap";

    beforeAll(async () => {
        harness = await startRed();
        const flow = buildFlow(TAB, "signal fft", [
            {
                id: ANALYZER,
                type: "signal-analyzer",
                name: "fft analyzer",
                mode: "fft",
                fftSize: 256,
                samplingRate: 1024,
                windowFunction: "hann",
                outputFormat: "peaks",
                peakThreshold: 0.05,
                wires: [[CAP], []]
            },
            captureNode(CAP, "fft capture"),
            {
                id: GROUPED,
                type: "signal-analyzer",
                name: "per-topic analyzer",
                mode: "fft",
                fftSize: 128,
                samplingRate: 1024,
                windowFunction: "hann",
                outputFormat: "peaks",
                peakThreshold: 0.05,
                groupBy: "topic",
                maxGroups: 10,
                wires: [[GROUPED_CAP], []]
            },
            captureNode(GROUPED_CAP, "per-topic capture"),
            {
                id: VIB,
                type: "signal-analyzer",
                name: "vibration analyzer",
                mode: "vibration",
                // windowSize left at its default: a frame is analysed whole regardless
                samplingRate: 10000,
                vibInputUnit: "m_s2",
                iso10816Class: "group2_rigid",
                outputTopic: "machine/vibration",
                wires: [[VIB_NORMAL_CAP], [VIB_ALARM_CAP]]
            },
            captureNode(VIB_NORMAL_CAP, "vibration normal capture"),
            captureNode(VIB_ALARM_CAP, "vibration alarm capture")
        ]);
        await harness.deploy(flow);
    }, 30000);

    afterAll(async () => {
        if (harness) await harness.shutdown();
    }, 15000);

    it("locates the dominant frequency of a 50 Hz sine wave", async () => {
        const fs = 1024;
        const f = 50;
        const N = 256;

        // Drip-feed exactly N samples — the analyzer needs the buffer to
        // fill before it emits anything. We send N+1 to push past the
        // threshold by one sample (the buffer trims after the first emit).
        for (let i = 0; i <= N; i++) {
            const t = i / fs;
            const v = Math.sin(2 * Math.PI * f * t);
            await harness.inject(ANALYZER, { payload: v });
        }

        const out = await harness.collect(CAP, 1, 3000);
        expect(out.length).toBeGreaterThanOrEqual(1);
        const last = out[out.length - 1];

        expect(typeof last.dominantFrequency).toBe("number");
        // FFT bin width = 1024/256 = 4 Hz, so the peak should land within
        // one bin of the true 50 Hz.
        expect(Math.abs(last.dominantFrequency - 50)).toBeLessThanOrEqual(4);

        // peaks array sanity-checks
        expect(Array.isArray(last.peaks)).toBe(true);
        expect(last.peaks.length).toBeGreaterThanOrEqual(1);
        expect(typeof last.peaks[0].frequency).toBe("number");
        expect(typeof last.peaks[0].magnitude).toBe("number");
        expect(last.peaks[0].magnitude).toBeGreaterThan(0);

        // Spectral feature object is present
        expect(last.features).toBeDefined();
        expect(typeof last.features).toBe("object");
    }, 30000);

    /**
     * End-to-end test for per-device buffering (issue #25).
     *
     * Two devices publish on separate topics into ONE analyzer node. Each carries a
     * different sine frequency, so a shared buffer would blend both tones and neither
     * result could report its own frequency. Both tones sit exactly on an FFT bin
     * (bin width = 1024/128 = 8 Hz), keeping the assertion deterministic.
     */
    it("keeps one buffer per topic and reports each device's own frequency", async () => {
        const fs = 1024;
        const N = 128;
        const devices = [
            { topic: "pump-01/vibration", freq: 48 },
            { topic: "pump-02/vibration", freq: 192 }
        ];

        // Interleave both devices, exactly N samples each. With per-topic buffers
        // each device fills its own buffer and emits exactly once.
        for (let i = 0; i < N; i++) {
            for (const dev of devices) {
                const v = Math.sin((2 * Math.PI * dev.freq * i) / fs);
                await harness.inject(GROUPED, { topic: dev.topic, payload: v });
            }
        }

        const out = await harness.collect(GROUPED_CAP, 2, 5000);
        expect(out.length).toBe(2);

        for (const dev of devices) {
            const result = out.find((m) => m.group === dev.topic);
            expect(result).toBeDefined();
            // Topic is preserved alongside the group tag
            expect(result.topic).toBe(dev.topic);
            // Within one bin of this device's own tone — proof the buffers never mixed
            expect(Math.abs(result.dominantFrequency - dev.freq)).toBeLessThanOrEqual(8);
        }
    }, 60000);

    /**
     * End-to-end test for vibration mode on a waveform frame.
     *
     * A 4096-sample acceleration frame at 10 kHz carrying 1 m/s² at 25 Hz
     * (1500 rpm imbalance) is 4.50 mm/s RMS velocity — ISO 20816-3 zone D for
     * a group 2 machine on a rigid foundation. The frame must be analysed
     * whole (the default window size of 256 used to cut it down and read
     * 2.65 mm/s, zone B), the alarm must reach output 2, and the output topic
     * must be applied. A quiet frame goes to output 1.
     */
    it("rates a 25 Hz acceleration frame as ISO zone D on the alarm output", async () => {
        const fs = 10000;
        const N = 4096;
        const frame = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * 25 * i) / fs));
        await harness.inject(VIB, { payload: frame, topic: "in" });

        const alarm = await harness.collect(VIB_ALARM_CAP, 1, 5000);
        expect(alarm.length).toBe(1);
        const iso = alarm[0].payload.iso20816;
        expect(iso.conversion).toBe("spectral-integration");
        expect(Math.abs(iso.rmsVelocity - 4.5) / 4.5).toBeLessThan(0.05);
        expect(iso.zone).toBe("D");
        expect(iso.isAlarm).toBe(true);
        expect(alarm[0].windowSize).toBe(N);
        expect(alarm[0].topic).toBe("machine/vibration");
        expect(alarm[0].payload.crestFactor).toBeCloseTo(Math.SQRT2, 1);

        const quiet = frame.map((v) => v * 0.1);
        await harness.inject(VIB, { payload: quiet, topic: "in" });
        const normal = await harness.collect(VIB_NORMAL_CAP, 1, 5000);
        expect(normal.length).toBe(1);
        expect(normal[0].payload.iso20816.zone).toBe("A");
        expect(normal[0].topic).toBe("machine/vibration");
    }, 30000);
});
