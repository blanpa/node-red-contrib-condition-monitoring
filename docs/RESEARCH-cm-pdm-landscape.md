# Condition Monitoring & Predictive Maintenance — Landscape Review

> Terminology, standards, measurement techniques, analytics (from thresholds to
> remaining-useful-life models), market and adoption data, practical barriers,
> 2025/2026 trends, and a mapping of this toolkit's nodes onto the ISO 13374
> architecture. Compiled from public sources in September 2026.
>
> Companion document: [RESEARCH-pdm-cm.md](RESEARCH-pdm-cm.md) is a
> literature-grounded review of the *methods* (RUL, anomaly detection, LLM-based
> prognostics) with per-claim confidence votes. This document covers the wider
> landscape — norms, sensors, market, barriers — and stays deliberately lighter on
> algorithm detail.

---

## TL;DR

1. **Condition monitoring is the measurement; predictive maintenance is the
   decision.** CM delivers the current state, PdM forecasts the failure time and
   schedules the intervention. Under EN 13306, PdM is a subset of condition-based
   maintenance.
2. **The standards are mature and largely stable.** ISO 17359 (procedure),
   ISO 13374 (data processing in six blocks), ISO 20816 (vibration severity) and
   ISO 13381-1 (prognostics, new edition 2025) form the skeleton.
3. **Vibration analysis remains the backbone**, complemented by motor current,
   thermography, oil and acoustic analysis. For rolling-element bearings, envelope
   analysis against BPFO/BPFI fault frequencies is the standard.
4. **The benefit is documented; adoption is stagnating.** Studies report 10–40 %
   lower maintenance cost and 20–50 % fewer unplanned stops. Yet only 27 % of
   plants used PdM in 2025 (down from 30 %), and roughly 11 % reach the highest
   maturity level.
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
| **ISO 13374-1…4**    | Data processing, communication and presentation               | Defines the six functional blocks DA → DM → SD → HA → PA → AG (section 4). Basis of MIMOSA OSA-CBM. Practically every CM software architecture follows this scheme.                                                   |
| **ISO 13379-1/-2**   | Data interpretation and diagnostic techniques                 | Symptom-to-fault mapping, diagnostic procedure; part 2 specifically for data-driven techniques.                                                                                                                      |
| **ISO 13381-1:2025** | Prognostics: general guidelines and requirements              | New edition 2025 (replaces 2015). Defines prognostics as the process and prognosis as the result, RUL and confidence statements. The reference point for any RUL estimate.                                            |
| **ISO 20816-1…9**    | Vibration evaluation (replaces ISO 10816 / ISO 7919)          | Zone limits A–D for housing and shaft vibration by machine class and mounting. The only normatively justified absolute limit values.                                                                                  |
| **ISO 13373-1…9**    | Vibration CM: procedures, signal processing, diagnosis        | Sensor placement, measurement chains, spectral techniques; part 3 (diagnosis), part 9 (electric motors).                                                                                                             |
| **ISO 18436-1…8**    | Qualification and certification of CM personnel               | Categories I–IV for vibration analysts, thermography, tribology, acoustics. Relevant because the "skills gap" is the most-cited adoption barrier.                                                                     |
| **EN 13306:2017**    | Maintenance terminology                                       | Defines the strategies in section 1 normatively (trilingual, DIN EN).                                                                                                                                                |
| **ISO 55000/55001**  | Asset management                                              | Management system a CM programme is embedded in; evidence for audits and insurers.                                                                                                                                   |
| **IEC 62443**        | Industrial IT security                                        | As soon as CM data leaves a zone (edge → cloud), zone/conduit concepts apply. Cybersecurity is the third-largest adoption barrier.                                                                                    |

### ISO 20816: vibration zones

ISO 20816 rates broadband vibration velocity (RMS, typically 10–1 000 Hz) at the
housing. Four zones: **A** newly commissioned machine, **B** unrestricted
long-term operation, **C** restricted operation, plan maintenance, **D** damage
likely. Limits depend on machine group and foundation. Orientation values for
part 3 (industrial machines above 15 kW):

| Group / mounting                                   | A→B | B→C | C→D  |
| -------------------------------------------------- | --: | --: | ---: |
| Group 1 (large machines, 300 kW – 50 MW), rigid    | 2.3 | 4.5 |  7.1 |
| Group 1, flexible                                  | 3.5 | 7.1 | 11.0 |
| Group 2 (medium machines, 15 – 300 kW), rigid      | 1.4 | 2.8 |  4.5 |
| Group 2, flexible                                  | 2.3 | 4.5 |  7.1 |

Zone boundaries in mm/s RMS, guide values per ISO 20816-3 as reported in
secondary sources. The values of the current edition of the standard are
binding; the standard also allows operator-specific limits derived from history.

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
| **Envelope analysis** (HFRT, SPM)             | As above, band-passed in the resonance range                                    | Bearing and gear damage via impact repetition frequencies                          | very early          | Needs bearing geometry or a fault-frequency table                                               |
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
because the defect travels through the load zone with the shaft. An outer-race
defect shows clean BPFO harmonics without sidebands. This pattern is why
envelope analysis works well rule-based in practice, and why ML adds value
mainly in the harder cases (variable speed, superimposed faults, gearboxes).

### Time-domain indicators

The usual indicators that precede any spectral analysis and suffice for many
applications: **RMS** (energy, sluggish), **peak** and **peak-to-peak**,
**crest factor** (peak/RMS; rises with early impact damage and falls again once
the damage becomes distributed), **kurtosis** (impulsiveness, healthy ≈ 3,
impact damage well above), **skewness**. Kurtosis plus crest factor is one of the
most robust early indicators for bearing damage because both are independent of
the absolute level.

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
  locally; raw data is stored only on alarm or as samples. TinyML models on
  microcontrollers now classify bearing states at roughly 88 % accuracy in under
  50 ms and a few millijoules per inference.
- **Gateway / plant PC (SD, HA, PA):** Node-RED, Python sidecars, ONNX runtime.
  Contextualisation with process data (speed, load, recipe) from the controller,
  typically via OPC UA, happens here.
- **Cloud / platform (HA, PA, AG, training):** fleet comparison, model training,
  CMMS/ERP integration, dashboards. Transport is mostly MQTT (Sparkplug B for
  topic structure and state management) or OPC UA PubSub.

For data exchange, **OPC UA** (semantics, companion specs, controller side) and
**MQTT** (lightweight transport toward the platform) have become the standard
pair. The Asset Administration Shell is increasingly requested for asset
description but is still rarely in production in a CM context.

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
| z-score, moving average, EMA, IQR, percentile                  | Stationary normal state, univariate                 | Trivial to operate, computable online                            | Baseline drift; load changes create false alarms                                                   |
| CUSUM, EWMA control chart                                      | Small, persistent shift                             | Detects creeping trends earlier than thresholds                  | Parameters (k, h) must match the signal statistics                                                 |
| Mahalanobis distance, PCA reconstruction error                 | Multivariate, approximately Gaussian/linear         | Accounts for correlations (e.g. current vs speed), compact       | Nonlinear relationships; covariance must be estimated                                              |
| Isolation Forest, One-Class SVM, LOF                           | Anomalies are "easy to isolate"                     | No distribution assumption, robust with many features            | Scores hard to interpret, no temporal structure                                                    |
| Autoencoder, LSTM forecast error, Transformer                  | Normal behaviour is learnable, sequence structure   | Complex nonlinear patterns, multi-sensor                         | Training data, compute, drift, explainability                                                      |
| Time-series foundation models (Chronos-2, TimesFM, Moirai)     | Zero-shot forecast as the normal model              | No per-asset training, usable immediately                        | Industrial vibration barely present in pretraining; early studies show mixed anomaly results       |

### 5.2 Diagnosis (fault classification)

Needs labelled examples per fault type. The literature is dominated by CNNs on
spectrograms or envelope spectra, often with transfer learning from test-rig data
(CWRU, Paderborn) to the target machine. In practice, **physics-based diagnosis**
(fault frequencies, sidebands, harmonics) remains the first choice for bearings
and gearboxes because it needs no training data and is explainable. ML pays off
when speed and load vary strongly or many fault types overlap.

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
  are now used to clean such logs.
- **Domain shift** (test rig → plant, machine A → machine B) is the weak spot of
  nearly all deep-learning results.
- **Explainability** decides acceptance by the maintainer. An alarm without a
  "why" gets ignored.
- **Concept drift** from recipe changes, seasons and repairs: baselines must be
  re-tracked without "learning in" the damage itself.

---

## 6. Public datasets

For benchmarks, tests and teaching. All are test-rig or simulation data; no model
that is good only here is thereby validated for operation.

| Dataset                 | Origin                                  | Content                                                                                   | Task                     | Note                                                                                       |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| **CWRU Bearing**        | Case Western Reserve University         | Vibration 12/48 kHz, seeded bearing faults (inner, outer, ball, 3 sizes), 4 loads         | Fault classification     | Most cited but "too easy": many methods exceed 99 %. Sanity checks only.                   |
| **IMS Bearing**         | NASA / Univ. of Cincinnati              | 3 run-to-failure runs, 4 bearings, 20 kHz, over weeks                                     | Anomaly, RUL             | Real degradation, natural failure. Good test basis for trend and anomaly methods.          |
| **PRONOSTIA / FEMTO**   | FEMTO-ST, PHM Challenge 2012            | 17 accelerated run-to-failure runs, 3 operating points (1 800 / 1 650 / 1 500 rpm)        | RUL                      | Standard RUL benchmark for bearings; short runs, high variance.                            |
| **C-MAPSS**             | NASA                                    | Simulated turbofan engines, 21 sensors, 4 sub-sets (FD001–FD004)                          | RUL                      | *The* deep-learning RUL benchmark. N-CMAPSS (2021) is the more realistic successor.        |
| **Paderborn Bearing**   | Univ. of Paderborn                      | Vibration + motor current, real and artificial damage                                     | Classification, MCSA     | One of the few datasets with current and vibration in parallel.                            |
| **MFPT**                | Machinery Failure Prevention Technology | Bearing faults at several loads                                                           | Classification           | Small; complements CWRU.                                                                   |
| **AI4I 2020 PdM**       | UCI                                     | 10 000 synthetic machine cycles with failure modes                                        | Classification           | Tabular, good for tutorials, physically weak.                                              |
| **Microsoft Azure PdM** | Microsoft                               | Telemetry, errors, maintenance, 100 machines, 1 year                                      | Classification           | Synthetic but with a realistic data structure (logs + telemetry).                          |

---

## 7. Market, benefit and maturity

### Market size

Market researchers agree only on the direction. The spread is so wide that the
individual numbers are worth little; the spread itself is the information.

| Source               | Market 2026 (USD bn) | CAGR | Target                 |
| -------------------- | -------------------: | ---: | ---------------------- |
| MarketsandMarkets    |             ≈ 14–18  | 34 % | 2031                   |
| Grand View Research  |                 ≈ 15 | 28 % | USD 98 bn by 2033      |
| Mordor Intelligence  |                 15.3 | 29 % | USD 42 bn by 2030      |
| Precedence Research  |                 ≈ 16 | 22 % | USD 97 bn by 2035      |
| Research and Markets |                 ≈ 20 | 11 % | USD 24 bn by 2031      |

Rounded figures from the respective reports (2026). Market definitions
(software, sensors, services) differ; cross-source comparisons are not reliable.

### Benefit

The most robust numbers come from consultancy studies (Deloitte, PwC/Mainnovation)
and surveys of maintenance professionals:

| Metric                                                | Value                        | Source                                              |
| ----------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Maintenance cost reduction                            | 10–40 %                      | Deloitte, PwC                                       |
| Reduction of unplanned downtime                       | 20–50 %                      | Deloitte; up to 70–90 % at high maturity (Mordor)   |
| Uptime gain                                           | 10–20 %                      | Deloitte                                            |
| Extended asset life                                   | 10–20 %                      | Industry studies                                    |
| Cost of unplanned downtime, large plant, per year     | ≈ USD 253 m                  | Siemens, True Cost of Downtime 2024                 |
| Cost per hour of downtime, automotive                 | ≈ USD 2.3 m                  | Siemens 2024                                        |
| Downtime hours per plant and year                     | ≈ 326 h (25 incidents/month) | Siemens 2024                                        |

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

| Metric (survey of maintenance professionals, US-heavy) | 2024 | 2025 |
| ------------------------------------------------------ | ---: | ---: |
| Plants using predictive maintenance                    | 30 % | 27 % |
| Preventive maintenance as primary strategy             |    – | 71 % |
| Reactive / run-to-failure (multiple answers)           |    – | 38 % |
| AI fully or partially implemented                      |    – | 32 % |
| AI in pilot or evaluation                              |    – | 26 % |
| Plan to adopt AI within 12 months                      |    – | 65 % |

MaintainX, "State of Industrial Maintenance 2025". The slight decline in PdM is
attributed to cost and skills shortage, not to disappointment with the
technology.

For Germany: per a 2024 VDMA survey, over 60 % of mid-sized machine builders see
intelligent maintenance as one of the most important digitalisation levers. At
the same time, per Fraunhofer ISI (2024), only 13 % of machine-building firms
used AI in their own production. The VDMA position paper "Industrial AI"
(April 2026) names data integration, missing standards, interoperability and
employee acceptance as the central barriers.

---

## 8. Barriers in practice

The barriers have been the same for years, and they are mostly not technical.

| Barrier                             | Where it concretely fails                                                                         | What helps                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Budget** (25 % name it first)     | Sensors + cabling + platform per asset; ROI only visible after the first avoided failure          | Use criticality analysis (ISO 17359) to limit scope to the 5–10 % of assets causing 80 % of downtime cost; wireless MEMS sensors                  |
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

Chronos-2 (Amazon, October 2025), TimesFM (Google) and Moirai (Salesforce)
deliver zero-shot forecasts that beat statistical baselines on many datasets. As
a normal model for anomaly detection (forecast error = anomaly score) they are
attractive because per-asset training disappears. Evidence for industrial
vibration is still thin; known weaknesses are strongly seasonal patterns and
unclear pretraining-data provenance, which can distort benchmarks.

### LLM agents with diagnostic tools

The clearest new line: LLMs do not compute themselves, they **orchestrate**
deterministic tools (FFT, envelope, RUL models) via the Model Context Protocol
(MCP). The PHMForge benchmark (2026) with 99 scenarios and 39 MCP tools shows
frontier models reaching roughly 81 % pass@1; replacing the tools with pure text
retrieval drops RUL accuracy on battery scenarios from 100 % to 20 %. The
remaining failures are planning errors (when to call which tool), not invocation
errors. In parallel: "Predictive Maintenance MCP" as an open server with
spectral, envelope and anomaly tools; LLM agents for cleaning maintenance logs;
agentic systems moving from prediction to prescription.

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
- **Regulation:** EU AI Act (high-risk classification only for safety
  components), Cyber Resilience Act for connected products, NIS2 for operators.
  For CM software this means evidence of data provenance, access control and
  update capability.

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
  with the result. Still open: cost-optimal replacement timing (section 5.3)
  as a node output.
- **AG (advisory):** `llm-analyzer` sits right on the trend line of section 9.
  The research says clearly that value arises when the LLM receives structured
  findings from the other nodes (indicators, zones, fault-frequency hits, RUL
  with band) as tool outputs and formulates a work order from them, not when it
  interprets raw data. An example flow that chains signal-analyzer →
  trend-predictor → llm-analyzer with the JSON output schema would make that
  concrete.
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
  foundation-model-based detector.

---

## Caveats

- Market figures come from publicly accessible summaries of the named reports,
  not the full versions, and use differing market definitions.
- ISO 20816 zone limits are guide values from secondary sources; the current
  edition of the standard is binding.
- The PwC/Mainnovation study (2018), the ISO 13381-1:2025 text and two MDPI
  reviews were reachable only through secondary sources at the time of writing.
- The MaintainX adoption survey is US-heavy; German figures come from VDMA and
  Fraunhofer ISI and are not directly comparable.

---

## Sources

All sources accessed September 2026.

**Standards**

- ISO 17359:2018 — https://standards.iteh.ai/catalog/standards/iso/c664dc56-e63a-41c3-a056-f39595d15752/iso-17359-2018
- ISO 13374-2 — https://standards.globalspec.com/std/1019392/iso-13374-2
- ISO 13381-1:2025 — https://www.iso.org/obp/ui/#iso:std:iso:13381:-1:en
- ISO 13373-2:2016 — https://www.boutique.afnor.org/en-gb/standard/iso-1337322016/condition-monitoring-and-diagnostics-of-machines-vibration-condition-monito/xs026876/126171
- EN 13306:2017 — https://standards.iteh.ai/catalog/standards/cen/5af77559-ca38-483a-9310-823e8c517ee7/en-13306-2017
- Springer, ISO Standards for Condition Monitoring (book chapter) — https://link.springer.com/chapter/10.1007/978-1-84628-814-2_65
- SSG Insight, Navigating ISO Standards for CBM — https://ssginsight.com/about-us/news-events/navigating-iso-standards-for-condition-based-maintenance/

**Methods and surveys**

- Application-Wise Review of ML-Based Predictive Maintenance (Applied Sciences 2025) — https://www.mdpi.com/2076-3417/15/9/4898
- A Survey of Predictive Maintenance Methods: Prognostics via Classification and Regression (2025) — https://www.researchgate.net/publication/393022844
- Weak Supervision: A Survey on Predictive Maintenance (WIREs 2025) — https://wires.onlinelibrary.wiley.com/doi/full/10.1002/widm.70022
- Integrating ML-Based RUL Predictions with Cost-Optimal Block Replacement (IJPHM) — http://papers.phmsociety.org/index.php/ijphm/article/view/4242
- RUL Prediction: Multidimensional Signal Processing and Transfer Learning Based on LLMs — https://arxiv.org/pdf/2410.03134
- Foundation Models for Anomaly Detection: Vision and Challenges (AI Magazine 2025) — https://onlinelibrary.wiley.com/doi/full/10.1002/aaai.70045
- Time Series Foundational Models: Their Role in Anomaly Detection and Prediction — https://arxiv.org/pdf/2412.19286
- Are Time Series Foundation Models good for Energy Anomaly Detection? (ACM e-Energy 2025) — https://dl.acm.org/doi/abs/10.1145/3679240.3734633
- eoda, Vergleich Foundation Models Chronos, Moirai, TimesFM — https://www.eoda.de/blog/foundation-models-chronos-moirai-timesfm/
- The 2026 Time Series Toolkit: 5 Foundation Models — https://machinelearningmastery.com/the-2026-time-series-toolkit-5-foundation-models-for-autonomous-forecasting/
- ML and DL Algorithms for Bearing Fault Diagnostics, Comprehensive Review — https://arxiv.org/pdf/1901.08247
- Evaluation of Current Signature in Bearing Defects by Envelope Analysis (Energies 2019) — https://www.mdpi.com/1996-1073/12/21/4029

**LLM agents, digital twins, edge**

- PHMForge: Evaluating LLM Agents on Industrial Prognostics through MCP-Native Tools — https://arxiv.org/html/2604.01532
- Predictive Maintenance MCP (Applied Sciences 2026) — https://www.mdpi.com/2076-3417/16/6/2812
- From Prediction to Prescription: LLM Agent for Context-Aware Maintenance Decision Support (PHME) — https://papers.phmsociety.org/index.php/phme/article/view/4114
- Cleaning Maintenance Logs with LLM Agents — https://arxiv.org/abs/2511.05311
- Self-Evolving Multi-Agent Network for IIoT Predictive Maintenance — https://arxiv.org/pdf/2602.16738
- Systematic Review of Digital Twin-Driven Predictive Maintenance — https://arxiv.org/pdf/2509.24443
- Edge-deployable TinyML with transfer learning for bearing fault diagnosis (Sci. China Tech. Sci. 2025) — https://link.springer.com/article/10.1007/s11431-025-3072-9
- Multimodal TinyML-Based PdM Architecture for IIoT (Sensors 2026) — https://www.mdpi.com/1424-8220/26/14/4536
- Low-Power Vibration-Based PdM using Neural Networks: A Survey — https://arxiv.org/pdf/2408.00516

**Datasets**

- Review of Public Data Sets for Prognostics and Health Management — https://www.researchgate.net/publication/331822028
- Performance Benchmarking of Prognostic Methods for CMAPSS (IJPHM) — https://papers.phmsociety.org/index.php/ijphm/article/download/2236/1223

**Market, adoption, barriers**

- MaintainX, 25 Maintenance Stats, Trends and Insights for 2026 — https://www.getmaintainx.com/blog/maintenance-stats-trends-and-insights
- Reliamag, The Real Cost of Unplanned Downtime in Manufacturing (2026) — https://reliamag.com/articles/cost-unplanned-downtime-manufacturing/
- PwC / Mainnovation, Predictive Maintenance 4.0, Beyond the hype (2018) — https://www.pwc.de/de/industrielle-produktion/pwc-predictive-maintenance-4-0.pdf
- Deloitte Insights, Industry 4.0 and predictive technologies for asset maintenance — https://www.deloitte.com/us/en/insights/industry/manufacturing-industrial-products/industry-4-0/using-predictive-technologies-for-asset-maintenance.html
- VDMA position paper Industrial AI (April 2026) — https://www.vdma.eu/documents/34570/76845115/2026_04%20VDMA-Positionspapier%20Industrial%20AI.pdf
- Fraunhofer IML, Predictive Maintenance — https://www.iml.fraunhofer.de/de/abteilungen/b2/anlagenmanagement/predictive-maintenance.html
- Market reports: MarketsandMarkets — https://www.marketsandmarkets.com/Market-Reports/operational-predictive-maintenance-market-8656856.html · Grand View Research — https://www.grandviewresearch.com/industry-analysis/predictive-maintenance-market · Mordor Intelligence — https://www.mordorintelligence.com/industry-reports/predictive-maintenance-market · Precedence Research — https://www.precedenceresearch.com/predictive-maintenance-market · Research and Markets — https://www.researchandmarkets.com/reports/5767408/predictive-maintenance-market-report
- node-red-contrib-condition-monitoring on the Node-RED Flow Library — https://flows.nodered.org/node/node-red-contrib-condition-monitoring
