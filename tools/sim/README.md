# Simulation scripts

Physically motivated simulations that drive the *real* nodes inside a Node-RED
test runtime. They are not part of `npm test` (they print reports rather than
assert), but they are how the envelope diagnostics, the ISO conversion, the
regime baselines and the RUL confidence band were calibrated. Run them from the
repository root:

```bash
node tools/sim/sim-bearing.js   # healthy / outer race / inner race / weak / looseness / variable speed
node tools/sim/sim-iso.js       # ISO 20816 rating from an accelerometer waveform, new vs old rule
node tools/sim/sim-regime.js    # two-speed pump, anomaly detection with and without regimes
node tools/sim/sim-rul.js       # Monte-Carlo coverage of the RUL confidence band
FLOORS=6,8,12 node tools/sim/sim-bearing.js   # sweep the envelope peak floor factor
```

`signals.js` holds the bearing model: each defect impact excites a damped
structural resonance, impacts repeat at the fault frequency with slip jitter,
inner-race impacts are amplitude-modulated at 1X (load zone), plus 1X unbalance,
broadband noise and an optional 1X impact train (looseness).

What the runs showed (September 2026, see CHANGELOG *Unreleased*):

- Envelope diagnostics: no false lines on healthy signals up to σ = 0.1 g; an
  outer-race defect yields BPFO only, an inner-race defect BPFI with ±1X
  sidebands only, looseness 1X harmonics only. A weak inner-race defect
  (0.08 g impacts in 0.05 g noise) is still found at the default peak floor of
  8 × local median, lost at 12.
- ISO rating: spectral integration lands within 2 % of the true velocity RMS;
  the former single-frequency rule over-reported by 14–55× as soon as bearing
  high-frequency content was present.
- Regimes: a two-speed pump produced 21–22 false alarms per 640 samples with a
  single baseline and 0–3 with regimes, and a growing fault was caught at
  +23–27 % wear instead of +23–53 %.
- RUL band: on a noisy linear wear model the 90 % band covered the true failure
  time in roughly 75–80 % of runs and the 99 % band in roughly 90 %; the point
  estimate carries a residual optimistic bias of about 2 %. Treat the band as
  indicative, not as a guarantee.
