# Condition Monitoring & Predictive Maintenance — Landscape Review

> Terminology, standards, measurement techniques, analytics (from thresholds to
> remaining-useful-life models), market and adoption data, practical barriers,
> 2025/2026 trends, and a mapping of this toolkit's nodes onto the ISO 13374
> architecture. Compiled from public sources in September 2026; revised
> 9 October 2026 after a claim-by-claim verification pass — what changed and
> why is listed in section 9 of the follow-up review.
>
> Companion documents: [RESEARCH-pdm-cm.md](RESEARCH-pdm-cm.md) is a
> literature-grounded review of the *methods* (RUL, anomaly detection, LLM-based
> prognostics) with per-claim confidence votes;
> [RESEARCH-pdm-cm-followup.md](RESEARCH-pdm-cm-followup.md) (October 2026)
> answers that review's open questions and verifies this document. This document
> covers the wider landscape — norms, sensors, market, barriers — and stays
> deliberately lighter on algorithm detail.

---

## TL;DR

1. **Condition monitoring is the measurement; predictive maintenance is the
   decision.** CM delivers the current state, PdM forecasts the failure time and
   schedules the intervention. Under EN 13306, PdM is a subset of condition-based
   maintenance.
2. **The standards are mature and largely stable.** ISO 17359 (procedure),
   ISO 13374 (data processing in six blocks), ISO 13379-1 (diagnostics, new
   edition 2025), ISO 20816 (vibration severity) and ISO 13381-1 (prognostics,
   new edition 2025) form the skeleton.
3. **Vibration analysis remains the backbone**, complemented by motor current,
   thermography, oil and acoustic analysis. For rolling-element bearings, envelope
   analysis against BPFO/BPFI fault frequencies is the standard.
4. **The benefit is documented; adoption is stagnating.** Deloitte reports
   5–10 % lower maintenance cost, 10–20 % more uptime and 20–50 % less
   maintenance-planning time; PwC/Mainnovation an average 12 % cost saving.
   Wider ranges (10–40 % cost, 70–90 % downtime) circulate without a traceable
   primary source. Only 27 % of plants used PdM in 2025 (down from 30 %), and
   roughly 11 % reach the highest maturity level.
5. **The research frontier is shifting to foundation models, edge AI and
   LLM agents** that orchestrate deterministic diagnostic tools. This toolkit's
   Node-RED approach fits that direction well.

---

## 1. Terminology and positioning

**Condition monitoring (CM)** is the continuous or periodic acquisition of
machine state variables in order to detect deviations from the normal state
before they lead to a functional failure. Typical variables are vibration,
temperature, current, pressure, oil condition and acoustic emission.

**Predictive maintenance (PdM)** builds on it: from the trajectory of those
variables, the remaining degradation path is estimated and a maintenance date
derived that is as late as possible but before failure. The intermediate step is
*prognostics*; its result is the *remaining useful life* (RUL).

EN 13306 sorts the strategies as follows:

| Strategy                                       | Trigger for intervention                       | Typical example                                   | Data required                                  |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| **Corrective** (reactive, run-to-failure)      | Failure has occurred                           | Light bulbs, cheap redundant parts                | none                                           |
| **Predetermined** (preventive, time/cycle)     | Interval elapsed                               | Oil change every 2 000 h                          | operating hours, counters                      |
| **Condition-based** (CBM)                      | Measured value exceeds a limit                 | Vibration above ISO 20816 zone C                  | current condition data                         |
| **Predictive** (PdM, a subset of CBM)          | Forecast places failure inside a time window   | "Bearing will fail in 3–5 weeks"                  | condition *trajectories*, history, a model     |
| **Prescriptive** (extension)                   | As PdM, plus a recommended action              | "Reduce speed 10 %, replace in week 40"           | plus cost, operations and spare-parts data     |

**The P-F curve.** Between point P, where a defect first becomes measurable, and
the functional failure F lies the action window (the P-F interval). Vibration
techniques (ultrasound, envelope, then broadband spectrum/RMS) usually detect
bearing damage earliest; oil particles come next; temperature and audible noise
only shortly before failure; visible damage last. The goal of PdM is to detect as
close to P as possible and to schedule the intervention as close before F as
possible.

The umbrella research term is **Prognostics and Health Management (PHM)**. It
covers detection (is something different?), diagnosis (what is defective, where,
how severe?) and prognosis (how long until failure?). The three questions need
different data and different models — see section 5.

---

## 2. Standards landscape

The ISO series "Condition monitoring and diagnostics of machines" is maintained
by ISO/TC 108/SC 5. It is deliberately modular: one framework standard, several
technique standards, one data-architecture standard and one prognostics
standard.

| Standard             | Subject                                                       | Why it matters                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ISO 17359:2018**   | General guidelines for CM programmes (framework)              | Procedure model: audit assets, rate criticality, map failure modes to symptoms, choose measurands, set alarm limits, diagnose, prognose, act, feed back.                                                              |
| **ISO 13374-1…4**    | Data processing, communication and presentation               | Parts 1:2003, 2:2007, 3:2012, 4:2015. Defines the six functional blocks DA → DM → SD → HA → PA → AG (section 4). Codifies MIMOSA's OSA-CBM block model: OSA-CBM was the main input to part 1 and is its implementation (last release 3.3.1, 2010). Widely used as the vocabulary of CM architectures; there is no conformance scheme. |
| **ISO 13379-1:2025, -2:2015** | Data interpretation and diagnostic techniques        | Symptom-to-fault mapping, diagnostic procedure, confidence factors. The 2025 edition of part 1 (replaces 2012) adds a recommended diagnostics procedure and moves the data-driven method descriptions into an informative annex; part 2 (data-driven techniques) is under revision. |
| **ISO 13381-1:2025** | Prognostics: general guidelines and requirements              | Third edition, September 2025 (replaces 2015; the title now says "and requirements"). Defines prognostics as the process and prognosis as the result, RUL, estimated time to failure, predictive horizon and confidence level, and requires a prognosis report. The reference point for any RUL estimate. |
| **ISO 20816** (parts 1, 2, 3, 4, 5, 8, 9, 21) | Vibration evaluation (replaces ISO 10816 / ISO 7919) | Zone limits A–D for housing and shaft vibration by machine group and mounting. The only standard-backed absolute limit values — the standard itself calls them guidelines and expects machine-specific ALARM/TRIP settings. ISO 10816-6 (reciprocating) and -7 (pumps) are still in force; a second edition of part 3 is at FDIS stage (2026). |
| **ISO 13373** (parts 1–5, 7, 9, 10) | Vibration CM: procedures, signal processing, diagnosis | Sensor placement, measurement chains, spectral techniques; part 3 (diagnosis), part 9 (electric motors), part 10 (2024, generators).                                                                                |
| **ISO 18436-1…8**    | Qualification and certification of CM personnel               | Categories I–IV for vibration analysts, thermography, tribology, acoustics (part 3 re-issued 2025; parts 2 and 8 in revision). Relevant because the "skills gap" is the most-cited adoption barrier.                    |
| **EN 13306:2017**    | Maintenance terminology                                       | Defines the strategies in section 1 normatively (trilingual, DIN EN). Under revision since 2025.                                                                                                                     |
| **ISO 55000/55001:2024** | Asset management                                          | Management system a CM programme is embedded in; evidence for audits and insurers.                                                                                                                                   |
| **IEC 62443**        | Industrial IT security                                        | As soon as CM data leaves a zone (edge → cloud), zone/conduit concepts apply. Cybersecurity is the third-largest adoption barrier.                                                                                    |

### ISO 20816: vibration zones

ISO 20816 rates broadband vibration velocity (RMS over at least 10–1 000 Hz;
the lower limit drops to 2 Hz for machines at or below 600 rpm) at the housing.
Four zones: **A** newly commissioned machine, **B** unrestricted long-term
operation, **C** restricted operation, plan maintenance, **D** damage likely.
Limits depend on machine group and foundation. Orientation values for part 3
(industrial machines above 15 kW):

| Group / mounting                                                        | A→B | B→C | C→D  |
| ----------------------------------------------------------------------- | --: | --: | ---: |
| Group 1 (large machines, 300 kW – 50 MW, or shaft height ≥ 315 mm), rigid | 2.3 | 4.5 |  7.1 |
| Group 1, flexible                                                       | 3.5 | 7.1 | 11.0 |
| Group 2 (medium machines, 15 – 300 kW, or shaft height 160–315 mm), rigid | 1.4 | 2.8 |  4.5 |
| Group 2, flexible                                                       | 2.3 | 4.5 |  7.1 |

Zone boundaries in mm/s RMS, guide values of ISO 20816-3:2022 (Annex A,
Tables A.1 rigid / A.2 flexible) as reproduced by three secondary sources;
unchanged from ISO 10816-3:2009. The standard calls them guidelines to be
applied with regard to the specific machine, expects operator-specific ALARM
and TRIP settings derived from history, and is being revised (FDIS 2026).

> **Rule of thumb.** Absolute limits (ISO 20816) and relative limits (trend
> against the machine's own baseline, usually a factor of 2–2.5 on RMS, or a
> z-score above 3) complement each other. Standard limits catch gross conditions;
> trend limits catch the early rise. A CM system should run both in parallel.

---

## 3. Measurement techniques

Which technique detects early enough depends on the failure mode. The table
orders the common techniques by what they see and where they sit on the P-F
curve.

| Technique                                     | Sensing                                                                         | Detects                                                                            | Early warning       | Limitations                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| **Vibration analysis**                        | Piezo/IEPE accelerometers (10 kHz+), increasingly MEMS (≈3–6 kHz)               | Unbalance, misalignment, looseness, bearing and gear damage, resonance, cavitation | very early          | Sensor placement and mounting are critical; variable-speed drives need order analysis           |
| **Envelope analysis** (HFRT)                  | As above, band-passed in the resonance range                                    | Bearing and gear damage via impact repetition frequencies                          | very early          | Needs bearing geometry or a fault-frequency table                                               |
| **Motor current signature analysis** (MCSA)   | Current transformers in the cabinet, no sensor on the machine                   | Broken rotor bars, eccentricity, bearing damage (indirect), load problems           | medium              | Electric drives only; bearing faults weaker than in vibration                                   |
| **Thermography / temperature**                | IR camera, PT100, thermocouple                                                  | Friction, electrical contact resistance, cooling problems, insulation faults        | medium to late      | Environment-dependent, emissivity; bearing temperature rises late                               |
| **Oil analysis / tribology**                  | Lab sample or online particle counter, moisture, viscosity                      | Wear particles (ferrography), contamination, additive depletion                     | early for gearboxes | Sampling interval; online sensors are expensive                                                 |
| **Acoustic emission / ultrasound**            | AE sensors (100 kHz – 1 MHz), ultrasonic microphones (20–100 kHz)               | Crack initiation, leaks, lubrication starvation, partial discharge                  | very early          | High data volume; interpretation needs experience                                               |
| **Process parameters**                        | Controller data (torque, pressure, flow, cycle time)                            | Performance degradation, clogging, tool wear                                       | medium              | Available without extra sensors, but strongly load- and recipe-dependent                        |
| **Image-based**                               | Camera, vision models                                                           | Corrosion, cracks, leaks, contamination, foreign objects                            | medium to late      | Lighting, visibility; labelling effort                                                          |

### Rolling-element bearings: fault frequencies

For bearings the diagnosis is deterministic. With shaft rotation frequency
`f_r`, number of rolling elements `n`, rolling-element diameter `d`, pitch
diameter `D` and contact angle `α`:

```
BPFO = n/2 · f_r · (1 − d/D · cos α)        outer race
BPFI = n/2 · f_r · (1 + d/D · cos α)        inner race
BSF  = D/(2d) · f_r · (1 − (d/D · cos α)²)  rolling element
FTF  = f_r/2 · (1 − d/D · cos α)            cage
```

An inner-race defect shows as BPFI harmonics with sidebands spaced at `f_r`,
because the defect travels through the load zone with the shaft. A defect on a
stationary outer race shows BPFO harmonics without such sidebands; the
modulation follows whichever race rotates relative to the load, and a
rolling-element defect shows 2 × BSF modulated at the cage frequency FTF. This
pattern is why envelope analysis works well rule-based in practice. The harder
cases — variable speed, superimposed faults, gearboxes — are served first by
order tracking, cepstral pre-whitening and resonance-band selection; ML has
its measured advantage where many labelled bearings exist under fixed
conditions or when it is fed envelope or order spectra (section 5.2).

### Time-domain indicators

The usual indicators that precede any spectral analysis and suffice for many
applications: **RMS** (energy, sluggish), **peak** and **peak-to-peak**,
**crest factor** (peak/RMS; rises with early impact damage and falls again once
the damage becomes distributed), **kurtosis** (impulsiveness; raw kurtosis ≈ 3
for a healthy Gaussian signal, i.e. excess kurtosis ≈ 0 — `signal-analyzer`
reports the excess form, so its `|kurtosis| > 4` rule means raw kurtosis 7),
**skewness**. Kurtosis and crest factor are independent of the absolute level
and react early to impulsive damage, but neither is robust on its own: both
fall back as the damage spreads, and kurtosis fails for extended faults,
narrow bandwidth and overlapping impulse responses. The robust form is the
kurtosis of a resonance band chosen by spectral kurtosis, or the strength of
the fault line in the squared-envelope spectrum.

---

## 4. Data processing per ISO 13374

ISO 13374 splits a CM system into six functional blocks that build on each
other. The model is useful because it separates responsibilities cleanly: whoever
delivers raw data need not know how the prognosis is computed, and vice versa.
This toolkit's nodes are mapped onto the blocks below.

| Block  | Name                  | What it does                                                                      | Nodes in this toolkit                                              |
| ------ | --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **DA** | Data Acquisition      | Sensor → digital sample. Sample rate, calibration, timestamps.                    | MQTT/OPC UA nodes, `condition-monitoring-source`, `json-source`, `image-source` |
| **DM** | Data Manipulation     | Filtering, FFT, envelope, indicators, resampling, feature extraction.             | `signal-analyzer`, `multi-value-processor`, `image-preprocess`     |
| **SD** | State Detection       | Comparison against baseline or limit. "Normal" vs "deviating".                    | `anomaly-detector`, `isolation-forest-anomaly`, `pca-anomaly`      |
| **HA** | Health Assessment     | Diagnosis: which component, which fault, which severity. Health index.            | `signal-analyzer` (envelope mode: 1X/2X, BPFO/BPFI/BSF/FTF, gear-mesh sidebands), `health-index`, `ml-inference` (classification) |
| **PA** | Prognostic Assessment | Extrapolate the trajectory, estimate RUL with confidence.                         | `trend-predictor`, `ml-inference` (regression)                     |
| **AG** | Advisory Generation   | Recommended action, work order, explanation for the maintainer.                   | `llm-analyzer`, CMMS integration (flow-level)                      |

The mapping is not just documentation: it shows that diagnosis (HA) lives
inside the signal-processing node rather than in a block of its own, and that
**operating-point context** (speed/load classes) is not yet a first-class input
to any block.

### Where the blocks run: edge, gateway, cloud

The architecture question today is less "cloud or not" than **where the cut
lies**. Raw vibration at 20 kHz is too large to stream permanently. The usual
compromise:

- **Sensor / edge (DA, DM, often SD):** indicators and spectra are computed
  locally; raw data is stored only on alarm or as samples. Published TinyML
  bearing classifiers on Cortex-M-class microcontrollers reach 98–99 % on
  public datasets at 5–30 ms per inference in under 100 kB of flash;
  MLPerf-Tiny-style autoencoders run in about 0.1–1 ms and 20–200 µJ; a
  transfer-learned classifier on proprietary data on an ESP32-S3 reaches 88 %
  at 45 ms and 17.7 mJ.
- **Gateway / plant PC (SD, HA, PA):** Node-RED, Python sidecars, ONNX Runtime
  (which also ships ARM64 Linux builds, so Raspberry-Pi-class boards qualify).
  Contextualisation with process data (speed, load, recipe) from the controller,
  typically via OPC UA, happens here.
- **Cloud / platform (HA, PA, AG, training):** fleet comparison, model training,
  CMMS/ERP integration, dashboards. Transport is mostly MQTT (Sparkplug 3.0,
  now ISO/IEC 20237:2023, for topic structure and state management) or OPC UA
  PubSub.

For data exchange, **OPC UA** (semantics, companion specs, controller side) and
**MQTT** (lightweight transport toward the platform) have become the standard
pair. There is no OPC UA companion specification for condition monitoring as
such; OPC 40001-1 (Machinery) carries a Monitoring block whose health folder
reuses the NAMUR NE 107 device-health states. The Asset Administration Shell is
increasingly requested for asset description but is still rarely in production
in a CM context; IDTA has, however, published submodel templates for
Predictive Maintenance (02048, 2025, with an RUL entity and confidence
interval) and Time Series Data (02008), so there is now something to conform
to.

---

## 5. Analytics: from thresholds to remaining useful life

Method choice follows the question (detection, diagnosis, prognosis) and the
data available. The most common mistake in practice is starting with prognosis
when no failure history exists.

### 5.1 Detection (anomaly detection)

Needs normal data only. This is the realistic entry point for most assets
because failures are rare and poorly labelled.

| Method                                                         | Assumption                                          | Strengths                                                        | Weaknesses                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Fixed threshold, ISO zones                                     | Absolute level is meaningful                        | Explainable, standards-compliant, no training phase              | Too late for early damage, ignores operating point                                                 |
| z-score, moving average, EMA, IQR, percentile                  | Stationary normal state, univariate                 | Trivial to operate, computable online                            | Baseline drift; load changes create false alarms; per-feature 3σ limits on vibration features gave the highest false-alarm rate in a direct comparison — apply σ rules to detector scores or use extreme-value (POT) thresholds |
| CUSUM, EWMA control chart                                      | Small, persistent shift                             | Detects creeping trends earlier than thresholds                  | Parameters (k, h) must match the signal statistics                                                 |
| Mahalanobis distance, PCA reconstruction error                 | Multivariate, approximately Gaussian/linear         | Accounts for correlations (e.g. current vs speed), compact       | Nonlinear relationships; covariance must be estimated                                              |
| Isolation Forest, One-Class SVM, LOF                           | Anomalies are "easy to isolate"                     | No distribution assumption, robust with many features            | Scores hard to interpret, no temporal structure                                                    |
| Autoencoder, LSTM forecast error, Transformer                  | Normal behaviour is learnable, sequence structure   | Complex nonlinear patterns, multi-sensor                         | Training data, compute, drift, explainability                                                      |
| Time-series foundation models (Chronos-2, TimesFM, Moirai)     | Zero-shot forecast as the normal model              | No per-asset training, usable immediately                        | Industrial vibration barely present in pretraining; zero-shot models score below sub-sequence PCA and windowed kNN on time-series anomaly benchmarks and are strong only on point anomalies |

### 5.2 Diagnosis (fault classification)

Needs labelled examples per fault type. The literature is dominated by CNNs on
spectrograms or envelope spectra, often with transfer learning from test-rig data
(CWRU, Paderborn) to the target machine — the common *research* route, not an
evidenced *deployment* route: standard domain-adaptation methods have scored
below plain source-only training on Paderborn artificial-to-real transfers, and
CNNs have been shown to learn the test rig's frequency-response profile. In
practice, **physics-based diagnosis** (fault frequencies, sidebands, harmonics)
remains the first choice for bearings and gearboxes because it needs no training
data and is explainable. ML has its measured advantage with many labelled
bearings under fixed conditions or when fed envelope or order spectra; under
varying speed and load its accuracy drops sharply, and that regime is better
served by order-tracked envelope analysis.

### 5.3 Prognosis (RUL)

Needs run-to-failure trajectories or a degradation model. Three families:

- **Physics-based:** Paris' law for crack growth, Lundberg–Palmgren / ISO 281
  for bearing life, Arrhenius for insulation. Good when the mechanism is known,
  poor under mixed loading.
- **Statistical:** Weibull analysis (failure distribution from history), trend
  extrapolation of a health index with a confidence band, particle filters,
  hidden Markov models for degradation stages. The pragmatic standard when a
  monotonic indicator exists.
- **Data-driven:** LSTM/GRU, temporal CNN, Transformer, increasingly with
  uncertainty estimation (quantiles, Bayesian, ensembles). Almost all benchmarks
  run on C-MAPSS or PRONOSTIA; transfer to real fleets remains the open
  question. Recent work couples foundation models and LLM-based transfer learning
  with signal processing.

> **Important for usefulness.** An RUL without a confidence interval is worthless
> for planning. ISO 13381-1 requires the uncertainty to be stated, and recent
> literature links RUL estimation to cost-optimal replacement: the replacement
> time sits where failure risk and remaining part value balance, not at the most
> likely RUL.

### 5.4 What the 2025 surveys agree on

- **Label scarcity** is the central problem. Weak supervision, semi-supervision
  and synthetic fault data are the research answers; in practice it means
  unlocking maintenance logs and CMMS work orders as a label source. LLM agents
  have been demonstrated on synthetic maintenance logs; they handle generic
  noise but not domain errors such as wrong dates or misaligned identifiers.
- **Domain shift** (test rig → plant, machine A → machine B) is the weak spot of
  nearly all deep-learning results.
- **Explainability** is necessary but not sufficient for acceptance by the
  maintainer: reviews find that explanations can build or erode trust depending
  on their form, and almost no XAI-for-PdM paper has tested them with
  maintenance staff. Physics-anchored, stable explanations (which fault
  frequency matched, which feature moved) are the defensible form.
- **Concept drift** from recipe changes, seasons and repairs: baselines must be
  re-tracked without "learning in" the damage itself.

---

## 6. Public datasets

For benchmarks, tests and teaching. All are test-rig or simulation data; no model
that is good only here is thereby validated for operation.

| Dataset                 | Origin                                  | Content                                                                                   | Task                     | Note                                                                                       |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| **CWRU Bearing**        | Case Western Reserve University         | Vibration 12/48 kHz, seeded bearing faults (inner, outer, ball, 4–5 sizes), 4 loads       | Fault classification     | Most cited; the > 99 % results come from leaky segment-wise splits (bearing-wise splits give 62–75 % macro-AUROC) and much of the data is atypical. Sanity checks only. |
| **IMS Bearing**         | NASA / Univ. of Cincinnati              | 3 run-to-failure runs, 4 bearings, 20 kHz, over weeks                                     | Anomaly, RUL             | Real degradation, natural failure. Good test basis for trend and anomaly methods.          |
| **PRONOSTIA / FEMTO**   | FEMTO-ST, PHM Challenge 2012            | 17 accelerated run-to-failure runs, 3 operating points (1 800 / 1 650 / 1 500 rpm)        | RUL                      | Standard RUL benchmark for bearings; short runs, high variance.                            |
| **C-MAPSS**             | NASA                                    | Simulated turbofan engines, 21 sensors, 4 sub-sets (FD001–FD004)                          | RUL                      | *The* deep-learning RUL benchmark. N-CMAPSS (2021) is the more realistic successor.        |
| **Paderborn Bearing**   | Univ. of Paderborn                      | Vibration + motor current, real and artificial damage                                     | Classification, MCSA     | One of the few datasets with current and vibration in parallel.                            |
| **MFPT**                | Machinery Failure Prevention Technology | Bearing faults at several loads                                                           | Classification           | Small; complements CWRU.                                                                   |
| **AI4I 2020 PdM**       | UCI                                     | 10 000 synthetic machine cycles with failure modes                                        | Classification           | Tabular, good for tutorials, physically weak.                                              |
| **Microsoft Azure PdM** | Microsoft                               | Telemetry, errors, maintenance; 1 000 machines in Microsoft's modelling guide (the Kaggle copy has 100), calendar year 2015 | Classification | Synthetic but with a realistic data structure (logs + telemetry).                          |

---

## 7. Market, benefit and maturity

### Market size

Market researchers agree only on the direction. The spread is so wide that the
individual numbers are worth little; the spread itself is the information.

| Source                      | Market 2026 (USD bn) | CAGR | Target                 |
| --------------------------- | -------------------: | ---: | ---------------------- |
| MarketsandMarkets           |                 13.9 | 11 % | USD 24 bn by 2031      |
| Grand View Research         |                 17.5 | 28 % | USD 98 bn by 2033      |
| Mordor Intelligence         |                 18.9 | 34 % | USD 82 bn by 2031      |
| Precedence Research         |                 11.7 | 26 % | USD 94 bn by 2035      |
| Research and Markets (TBRC) |                 15.3 | 29 % | USD 42 bn by 2030      |

Figures as shown on the respective report pages on 9 October 2026, rounded.
Market definitions (software, sensors, services) and base years differ;
cross-source comparisons are not reliable.

### Benefit

The most robust numbers come from consultancy studies (Deloitte, PwC/Mainnovation)
and surveys of maintenance professionals:

| Metric                                                | Value                        | Source                                              |
| ----------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Maintenance cost reduction                            | 5–10 %; ≈ 12 % on average    | Deloitte 2017; PwC/Mainnovation 2018                |
| Reduction of maintenance planning time                | 20–50 %                      | Deloitte 2017                                       |
| Uptime gain                                           | 10–20 %; ≈ 9 % on average    | Deloitte 2017; PwC/Mainnovation 2018                |
| Extended asset life                                   | ≈ 20 % among firms targeting it | PwC/Mainnovation 2018                            |
| Cost of unplanned downtime, large plant, per year     | ≈ USD 253 m                  | Siemens, True Cost of Downtime 2024                 |
| Cost per hour of downtime, automotive                 | ≈ USD 2.3 m                  | Siemens 2024                                        |
| Downtime hours per plant and year                     | ≈ 326 h (25 incidents/month) | Siemens 2024                                        |

The wider ranges that circulate — 10–40 % lower maintenance cost, 50 % or even
70–90 % less unplanned downtime — appear on market-report pages without a
footnote and are usually attributed to McKinsey Global Institute (2015); the
primary could not be read, so they are not in the table.

### Maturity: the PwC/Mainnovation model

The four-level model from the study "Predictive Maintenance 4.0" (268 companies
in DE, BE, NL) is the customary maturity scale in the German-speaking region:

| Level | Name                        | Description                                                                                                        |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1     | Visual inspection           | Periodic inspection, maintainer's experience. No data.                                                             |
| 2     | Instrumented inspection     | Handheld instruments (vibration, IR), route-based, expert interpretation.                                           |
| 3     | Real-time CM                | Permanently installed sensors, continuous monitoring, alarms on limits.                                             |
| 4     | PdM 4.0 (≈ 11 % of firms)   | Big data, ML, prediction of failure time and recommended action. Uptime is the most-cited goal.                    |

The majority of manufacturing firms sit at levels 1 and 2. That is the actual
market gap: not better models for level 4, but an affordable path from level 2
to 3.

### Adoption 2025

| Metric (survey of maintenance professionals, US/Canada) | 2024 | 2025 |
| ------------------------------------------------------- | ---: | ---: |
| Predictive maintenance part of the strategy             | 30 % | 27 % |
| Preventive maintenance part of the strategy             |    – | 71 % |
| Reactive / run-to-failure                               |    – | 38 % |
| AI fully or partially implemented                       |    – | 32 % |
| AI in pilot or evaluation                               |    – | 26 % |
| Expect to implement AI by 2026                          |    – | 65 % |

MaintainX, "State of Industrial Maintenance 2025" (1 320 respondents; strategy
shares are multiple answers). The slight decline in PdM is attributed to cost
and skills shortage, not to disappointment with the technology. A 2026 edition
(2 234 respondents) uses different metrics and is not mixed in here.

For Germany: per the VDMA's 2025 member survey (quoted in its April 2026
position paper), over 80 % of machine builders attribute medium or high
strategic importance to AI, 43 % already use it and a further 48 % plan to by
2028; 45 % name missing personnel and 42 % poor data quality as the main
hurdles. Per Fraunhofer ISI (2024, as quoted by the VDMA), only 13 % of
machine-building firms used AI in their own production. The VDMA position paper
"Industrial AI" (April 2026) names data availability and quality,
interoperability between heterogeneous systems and integration into existing
production and IT systems as the central barriers.

---

## 8. Barriers in practice

The barriers have been the same for years, and they are mostly not technical.
The percentages are the MaintainX 2025 answers on barriers to *AI adoption*
(US/Canada); the European studies report the same ranking qualitatively.

| Barrier                             | Where it concretely fails                                                                         | What helps                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Budget** (25 % name it first)     | Sensors + cabling + platform per asset; ROI only visible after the first avoided failure          | Use criticality analysis (ISO 17359) to limit scope to the few assets that cause most of the downtime cost (a common rule of thumb says 5–10 % of assets for 80 % of the cost); wireless MEMS sensors |
| **Skills** (24 %)                   | ISO 18436 Cat. II/III vibration analysts are rare; data scientists don't know the machines        | Tools that encode domain knowledge (fault frequencies, ISO zones) instead of pure ML black boxes; explanations in the alarm                       |
| **Cybersecurity** (22 %)            | OT network must not reach the cloud; sensor gateways as a new attack surface                      | Edge-first architecture, IEC 62443 zones, unidirectional data flows, hardened admin interfaces                                                   |
| **Data quality**                    | No time synchronisation, no context data (load, recipe), sensor drift, gaps                       | Log context from the controller; plausibility checks as a dedicated block (DM)                                                                   |
| **Missing labels**                  | Failures are rare, maintenance logs are free text                                                 | Start with anomaly detection; structure logs, feed findings back to alarms                                                                       |
| **Integration**                     | CM island without CMMS/ERP link; an alarm creates no work order                                   | Take the AG block seriously: alarm → ticket with finding, priority, spare part                                                                    |
| **False alarms**                    | Static limits under variable operation; every false alarm costs trust                             | Operating-point-dependent baselines, alarm confirmation over several cycles, hysteresis                                                          |
| **Acceptance**                      | Maintainers experience the system as surveillance or competition                                  | Design maintainers as users: findings in their language, their feedback as labels                                                                |

---

## 9. Trends 2025/2026

### Edge AI and TinyML

Indicator computation and first-stage classification are moving into the sensor.
MEMS accelerometers with an integrated microcontroller and radio (BLE, LoRaWAN,
Wi-Fi) cut the cost per measurement point drastically and solve the cabling
problem that has blocked maturity level 3. Multimodal nodes (vibration +
acoustics + thermography) with local inference are the current state of research.

### Time-series foundation models

Chronos-2 (Amazon, October 2025), TimesFM (Google, 3.0 in August 2026) and
Moirai (Salesforce, 2.0 in August 2025) deliver zero-shot forecasts that beat
statistical baselines on many datasets. As a normal model for anomaly detection
(forecast error = anomaly score) they are attractive because per-asset training
disappears. Evidence for industrial vibration is still thin, and what exists is
sobering: on the TSB-AD benchmark zero-shot Chronos and TimesFM score below
Isolation Forest and far below sub-sequence PCA, and a model's score drops
sharply on data that was provably absent from its pretraining — pretraining-data
contamination inflates published benchmark results.

### LLM agents with diagnostic tools

The clearest new line: LLMs do not compute themselves, they **orchestrate**
deterministic tools (FFT, envelope, RUL models) via the Model Context Protocol
(MCP). The PHMForge benchmark (arXiv 2604.01532, v3 August 2026; Columbia,
Georgia Tech and IBM Research; a preprint by the tool builders) with 99
scenarios and 39 MCP tools reports a best single configuration at 80.8 % pass@1,
the next at 64.6 %, and open-weight models at 36–80 % on a subset; removing the
tools on the battery-RUL scenarios drops the pass-all-three-runs rate from 5/5
to 1/5. Tool-sequencing errors dominate, but schema-invalid calls and truncated
arrays also occur with smaller models. In parallel: "Predictive Maintenance
MCP" (Applied Sciences 2026), a single-author proof of concept with spectral,
envelope and anomaly tools and a self-reported CWRU benchmark; LLM agents for
cleaning maintenance logs, shown on synthetic logs; and an agent "from
prediction to prescription" (PHME 2024) that was scored on fault classification
only. No independent replication of any of these exists.

### Digital twins

A 2025 systematic review organises DT-driven PdM by architecture (data
acquisition, model/simulation, analytics, decision) and names as gaps: real-time
capability, model validation, scaling across heterogeneous assets, missing
standards. In practice, "twins" are mostly simulation models that supply
synthetic fault data for training, rather than complete replicas.

### Further lines

- **Uncertainty quantification** as mandatory: RUL with quantiles, conformal
  prediction, physics-constrained probabilistic models.
- **Weak/self-supervision** and contrastive pretraining on unlabelled vibration
  data to lower label demand.
- **Reinforcement learning** for maintenance scheduling of whole fleets (multiple
  objectives: cost, availability, safety).
- **Prescriptive maintenance** as both a marketing and a research term:
  recommendation plus spare-part and staff dispatch.
- **Regulation (dates as of October 2026):** EU AI Act — general application
  2 August 2026; the high-risk obligations were deferred by the 2026 Digital
  Omnibus to 2 December 2027 (Annex III use cases) and 2 August 2028 (Annex I,
  AI as a safety component of machinery); the Article 50 transparency duties
  apply from August 2026. Cyber Resilience Act — reporting duties from
  11 September 2026, main obligations from 11 December 2027. NIS2 —
  transposition deadline 17 October 2024. Machinery Regulation (EU) 2023/1230
  — applies from 14 January 2027 and puts self-evolving safety components under
  third-party assessment. For CM software this means evidence of data
  provenance, access control and update capability.

---

## 10. Implications for this toolkit

Measured against this landscape, the toolkit sits at an interesting spot: it
serves exactly the gap between maturity levels 2 and 3 where most plants are
stuck, with a tool (Node-RED) that is already common in OT environments. The
gaps below were verified against the code in September 2026; the ones marked
**done** were closed in the same pass (see CHANGELOG, *Unreleased*).

- **SD (detection) is well covered.** The method range from z-score to Isolation
  Forest and PCA covers the whole table in 5.1 except foundation models.
  Hysteresis, consecutive-sample confirmation and operator-feedback threshold
  adaptation are in `anomaly-detector`. **Done:** operating-point-dependent
  baselines — one baseline per value of a message property (`regimeProperty`),
  so a load change does not read as an anomaly.
- **DM / HA (signal processing and diagnosis):** `signal-analyzer` has RMS,
  crest factor, kurtosis, envelope analysis with BPFO/BPFI/BSF/FTF matching,
  1X/2X shaft checks, gear-mesh sidebands and cepstrum. Verified gaps:
  - **Done:** the vibration-severity table was labelled ISO 10816-3 but carried
    the ISO 10816-1 / ISO 2372 class I–IV limits. It now rates by ISO 20816-3
    machine group and foundation (section 2); the old classes stay as a
    labelled legacy option.
  - **Done:** bearing fault frequencies can be derived from geometry (`n`, `d`,
    `D`, `α`, section 3); typed-in values still win.
  - **Done:** BPFI ±1X sidebands, looseness (four or more 1X harmonics) and
    sub-synchronous components (0.38–0.48X, unless they match the cage
    frequency) are classified.
  - **Done:** shaft speed is accepted per message (`msg.rpm`), the prerequisite
    for variable-speed drives. Order tracking (resampling to the shaft angle)
    remains open.
  - **Done:** the acceleration-to-velocity conversion for the ISO rating
    integrates the spectrum bin-wise over 10–1 000 Hz instead of applying
    `v = a / (2πf)` at the shaft frequency.
- **PA (prognosis):** `trend-predictor` emits `rul`, `rulLower` and `rulUpper`
  for linear, exponential and Weibull models. **Done:** the configured
  `confidenceLevel` is honoured (it used to be hard-wired to 1.96 σ) and reported
  with the result. Qualified in October 2026: the band is a delta-method
  interval on the crossing time that omits the level–slope covariance, and the
  Monte-Carlo check in `tools/sim` shows it under-covers (≈ 75–80 % at a
  nominal 90 %); the Weibull model reads the degradation fraction as the failed
  fraction and reports the distance to the unconditional B90 age, not the
  conditional RUL of the reliability literature. Still open: a calibrated
  band, conditional Weibull RUL and cost-optimal replacement timing (section
  5.3) as node outputs — see the follow-up review, section 4.
- **AG (advisory):** `llm-analyzer` sits right on the trend line of section 9.
  The benchmark evidence (the PHMForge tool ablation) supports giving the LLM
  structured findings from the other nodes (indicators, zones, fault-frequency
  hits, RUL with band) as tool outputs to formulate a work order from, rather
  than raw data; there is no evidence yet that this improves actual maintenance
  decisions. An example flow that chains signal-analyzer → trend-predictor →
  llm-analyzer with the JSON output schema would make that concrete.
- **Datasets:** **Done:** a reduced PRONOSTIA Bearing1_1 run-to-failure trend
  is a committed fixture (`tools/build-pronostia-fixture.js`) and drives
  anomaly-detector and trend-predictor tests with a real degradation curve. The
  first lesson from real data: a 3σ z-score on a 20-sample window fires at the
  true degradation onset (≈ 45 % of the life), not only at the collapse —
  useful, but earlier than a synthetic ramp would suggest.
- **Security:** the hardened admin routes and the path allowlist directly
  address the third-largest adoption barrier. **Done:** the README's Security
  section now says so for operators under NIS2 or IEC 62443.
- **Open:** concept-drift monitoring and a consistent severity field across all
  anomaly nodes (both already on the README roadmap), order tracking, a
  foundation-model-based detector. The follow-up review (section 8) ranks these
  and the gaps it found — kurtogram band selection, cepstral pre-whitening,
  health-indicator quality metrics, a calibrated RUL band — by evidence
  strength.

---

## Caveats

- Market figures come from publicly accessible summaries of the named reports,
  not the full versions, and use differing market definitions. The September
  2026 version of this document had three vendor rows swapped and credited
  Deloitte with ranges Deloitte never published; both were corrected in
  October 2026.
- ISO 20816 zone limits are guide values from secondary sources (three
  independent reproductions agree); Annex A of ISO 20816-3:2022 itself was not
  read. The standard calls the values guidelines, not binding limits.
- The PwC/Mainnovation study (2018), the ISO 13381-1:2025 text, the Fraunhofer
  ISI figure and two MDPI reviews were reachable only through secondary
  sources at the time of writing and again in October 2026.
- The MaintainX adoption survey is US/Canada; German figures come from VDMA and
  Fraunhofer ISI and are not directly comparable.

---

## Sources

All sources accessed September 2026; identifiers and figures re-verified on
9 October 2026 (see the follow-up review, section 9).

**Standards**

- ISO 17359:2018 — https://standards.iteh.ai/catalog/standards/iso/c664dc56-e63a-41c3-a056-f39595d15752/iso-17359-2018
- ISO 13374-2 — https://standards.globalspec.com/std/1019392/iso-13374-2
- ISO 13379-1:2025 — https://www.iso.org/standard/88027.html
- ISO 13381-1:2025 — https://www.iso.org/standard/88029.html
- ISO 20816-3:2022 — https://www.iso.org/standard/78311.html
- MIMOSA, OSA-CBM — https://www.mimosa.org/mimosa-osa-cbm/
- ISO/IEC 20237:2023 (Sparkplug 3.0) — https://www.iso.org/standard/86204.html
- IDTA 02048 Submodel Predictive Maintenance (2025) — https://industrialdigitaltwin.org/wp-content/uploads/2025/06/IDTA-02048_Submodel_PredictiveMaintenance.pdf
- ISO 13373-2:2016 — https://www.boutique.afnor.org/en-gb/standard/iso-1337322016/condition-monitoring-and-diagnostics-of-machines-vibration-condition-monito/xs026876/126171
- EN 13306:2017 — https://standards.iteh.ai/catalog/standards/cen/5af77559-ca38-483a-9310-823e8c517ee7/en-13306-2017
- Springer, ISO Standards for Condition Monitoring (book chapter) — https://link.springer.com/chapter/10.1007/978-1-84628-814-2_65
- SSG Insight, Navigating ISO Standards for CBM — https://ssginsight.com/about-us/news-events/navigating-iso-standards-for-condition-based-maintenance/

**Methods and surveys**

- Application-Wise Review of ML-Based Predictive Maintenance (Applied Sciences 2025) — https://www.mdpi.com/2076-3417/15/9/4898
- A Survey of Predictive Maintenance Methods: Prognostics via Classification and Regression (2025) — https://www.researchgate.net/publication/393022844
- Weak Supervision: A Survey on Predictive Maintenance (WIREs 2025) — https://wires.onlinelibrary.wiley.com/doi/full/10.1002/widm.70022
- Choo & Shin, Integrating ML-Based RUL Predictions with Cost-Optimal Block Replacement (IJPHM 16(1), 2025) — https://papers.phmsociety.org/index.php/ijphm/article/view/4242
- RUL Prediction: Multidimensional Signal Processing and Transfer Learning Based on LLMs — https://arxiv.org/pdf/2410.03134
- Foundation Models for Anomaly Detection: Vision and Challenges (AI Magazine 2025) — https://onlinelibrary.wiley.com/doi/full/10.1002/aaai.70045
- Time Series Foundational Models: Their Role in Anomaly Detection and Prediction — https://arxiv.org/pdf/2412.19286
- Are Time Series Foundation Models good for Energy Anomaly Detection? (ACM e-Energy 2025; compares TimeGPT and MOMENT only) — https://dl.acm.org/doi/abs/10.1145/3679240.3734633
- Liu & Paparrizos, TSB-AD time-series anomaly detection benchmark (NeurIPS 2024 Datasets & Benchmarks) — https://proceedings.neurips.cc/paper_files/paper/2024/file/c3f3c690b7a99fba16d0efd35cb83b2c-Paper-Datasets_and_Benchmarks_Track.pdf · https://github.com/TheDatumOrg/TSB-AD
- eoda, Vergleich Foundation Models Chronos, Moirai, TimesFM — https://www.eoda.de/blog/foundation-models-chronos-moirai-timesfm/
- The 2026 Time Series Toolkit: 5 Foundation Models — https://machinelearningmastery.com/the-2026-time-series-toolkit-5-foundation-models-for-autonomous-forecasting/
- ML and DL Algorithms for Bearing Fault Diagnostics, Comprehensive Review — https://arxiv.org/pdf/1901.08247
- Evaluation of Current Signature in Bearing Defects by Envelope Analysis (Energies 2019) — https://www.mdpi.com/1996-1073/12/21/4029

**LLM agents, digital twins, edge**

- PHMForge: Evaluating LLM Agents on Industrial Prognostics through MCP-Native Tools (arXiv 2604.01532, v3 August 2026, preprint) — https://arxiv.org/abs/2604.01532
- Di Maggio, Predictive Maintenance MCP (Applied Sciences 16(6):2812, 2026) — https://www.mdpi.com/2076-3417/16/6/2812
- Deng et al., From Prediction to Prescription: LLM Agent for Context-Aware Maintenance Decision Support (PHME 2024) — https://papers.phmsociety.org/index.php/phme/article/view/4114
- Dimidov et al., Cleaning Maintenance Logs with LLM Agents (PHMAP 2025; arXiv 2511.05311) — https://arxiv.org/abs/2511.05311
- Self-Evolving Multi-Agent Network for IIoT Predictive Maintenance — https://arxiv.org/pdf/2602.16738
- Systematic Review of Digital Twin-Driven Predictive Maintenance — https://arxiv.org/pdf/2509.24443
- Gao et al., An edge-deployable TinyML approach enhanced by transfer learning for efficient bearing fault diagnosis (Sci. China Technol. Sci. 68(12), 2025; ESP32-S3, proprietary data) — https://link.springer.com/article/10.1007/s11431-025-3072-9
- Garay et al., A Multimodal TinyML-Based Predictive Maintenance Architecture for Industrial IoT in the 6G Era (Sensors 26(14):4536, 2026; INT8 autoencoder on a Cortex-M4F) — https://www.mdpi.com/1424-8220/26/14/4536
- Low-Power Vibration-Based PdM using Neural Networks: A Survey — https://arxiv.org/pdf/2408.00516

**Datasets**

- Review of Public Data Sets for Prognostics and Health Management — https://www.researchgate.net/publication/331822028
- Ramasso & Saxena, Performance Benchmarking and Analysis of Prognostic Methods for CMAPSS Datasets (IJPHM 5(2), 2014) — https://papers.phmsociety.org/index.php/ijphm/article/view/2236
- Case Western Reserve University Bearing Data Center, apparatus and procedures — https://engineering.case.edu/bearingdatacenter/apparatus-and-procedures
- Microsoft, Predictive Maintenance Modelling Guide (data) — https://github.com/microsoft/SQL-Server-R-Services-Samples/blob/master/PredictiveMaintenanceModelingGuide/README.md

**Market, adoption, barriers**

- MaintainX, State of Industrial Maintenance 2025 (report page, May 2025) — https://www.getmaintainx.com/state-of-industrial-maintenance-2025
- MaintainX, 25 maintenance stats you need for 2026 (blog, October 2025, relays the 2025 report) — https://www.getmaintainx.com/blog/maintenance-stats-trends-and-insights
- Siemens, The True Cost of Downtime 2024 — https://assets.new.siemens.com/siemens/assets/api/uuid:1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf
- Reliamag, The Real Cost of Unplanned Downtime in Manufacturing (2026) — https://reliamag.com/articles/cost-unplanned-downtime-manufacturing/
- PwC / Mainnovation, Predictive Maintenance 4.0, Beyond the hype (2018; PDF blocks automated access, figures via consultancy.nl) — https://www.pwc.de/de/industrielle-produktion/pwc-predictive-maintenance-4-0.pdf · https://www.consultancy.nl/nieuws/20216/predictive-maintenance-wint-terrein-en-levert-koplopers-efficiencywinst-op
- Deloitte Insights, Making maintenance smarter: Predictive maintenance and the digital supply network (2017) — https://www.deloitte.com/us/en/insights/industry/manufacturing-industrial-products/industry-4-0/using-predictive-technologies-for-asset-maintenance.html
- VDMA position paper Industrial AI (April 2026; quotes the VDMA 2025 member survey and Fraunhofer ISI 2024) — https://www.vdma.eu/documents/34570/76845115/2026_04%20VDMA-Positionspapier%20Industrial%20AI.pdf
- European Commission, AI Act regulatory framework and timeline — https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai
- Regulation (EU) 2026/1744 (Digital Omnibus on AI) — https://eur-lex.europa.eu/eli/reg/2026/1744/oj
- European Commission, Cyber Resilience Act — https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act
- European Commission, NIS2 Directive — https://digital-strategy.ec.europa.eu/en/policies/nis2-directive
- Regulation (EU) 2023/1230 (Machinery) — https://eur-lex.europa.eu/eli/reg/2023/1230/oj/eng
- Market reports: MarketsandMarkets — https://www.marketsandmarkets.com/Market-Reports/operational-predictive-maintenance-market-8656856.html · Grand View Research — https://www.grandviewresearch.com/industry-analysis/predictive-maintenance-market · Mordor Intelligence — https://www.mordorintelligence.com/industry-reports/predictive-maintenance-market · Precedence Research — https://www.precedenceresearch.com/predictive-maintenance-market · Research and Markets — https://www.researchandmarkets.com/reports/5767408/predictive-maintenance-market-report
- node-red-contrib-condition-monitoring on the Node-RED Flow Library — https://flows.nodered.org/node/node-red-contrib-condition-monitoring
