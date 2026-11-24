# Predictive Maintenance & Condition Monitoring — Follow-up Review (October 2026)

> This document answers the four open questions and the declared coverage gaps
> of the methods review ([RESEARCH-pdm-cm.md](RESEARCH-pdm-cm.md), June 2026):
> the relative diagnostic value of FFT, envelope, cepstrum and wavelet/EMD and
> the standards the toolkit should conform to; whether the tabular "EIF + kNN
> suffice" finding replicates on time-series and vibration data; RUL evaluation,
> leakage, metrics, health-indicator quality, Weibull, similarity-based and
> cost-optimal replacement; and the maturity of LLM agents and edge/TinyML
> deployment. It adds concept drift, domain shift and explainability, and it
> verifies the claims of the landscape review
> ([RESEARCH-cm-pdm-landscape.md](RESEARCH-cm-pdm-landscape.md), September
> 2026), correcting what is wrong. It does not repeat what those two documents
> already say; it answers, deepens and corrects.
>
> **Method:** 8 topic researchers, ~250 web fetches; every claim carries a
> confidence (high/medium/low) and a verification tag — *primary* when read from
> the primary source, *secondary* when from an abstract, snippet or
> vendor/secondary reproduction (several publisher sites returned HTTP 403).
> Unlike the June 2026 review there was no separate adversarial vote;
> contradictions found between sources are reported as such. Toolkit statements
> were checked against the code at v0.4.0 on the same day.
>
> Compiled 9 October 2026.

---

## TL;DR

1. **Vibration diagnostics are settled science, and the toolkit's pipeline
   lacks three of the reference steps.** The (squared) envelope spectrum is the
   reference method for localized bearing faults; cepstrum pre-whitening and
   resonance-band selection each rescue ≈ 5–9 percentage points of hard CWRU
   records; order tracking is step one of the Randall/Antoni chain and the
   strongest-evidenced gap. Under leakage-free (bearing-wise) evaluation no
   end-to-end CNN beats physics-based envelope diagnosis — CWRU accuracies
   collapse from ≈ 100 % to 53–66 %. Wavelet/EMD/VMD front-ends have no
   independent evidence of benefit.
2. **Two factual errors in the standards table, none in the zone values.**
   ISO 13379-1:2012 is withdrawn (ISO 13379-1:2025 replaces it); the ISO 20816
   series is parts 1, 2, 3, 4, 5, 8, 9, 21, not "1…9". ISO 13381-1:2025 is
   confirmed. The ISO 20816-3 zone boundaries in `vibration.js` match three
   independent reproductions and the 2022 foreword ("merged and editorially
   revised") but are not primary-verified. IDTA published a Predictive
   Maintenance AAS submodel (02048) in June 2025; Sparkplug 3.0 is ISO/IEC
   20237:2023; no ISO 13374 certification exists.
3. **"EIF + kNN suffice" does not replicate on time series.** On TSB-AD
   (NeurIPS 2024) Isolation Forest scores VUS-PR 0.30 (univariate) / 0.20
   (multivariate), EIF 0.21, against Sub-PCA 0.42, PCA 0.31 and a tuned
   Matrix-Profile kNN 0.44 / 0.35 (April 2026). What validates the toolkit is
   its PCA/SPE detector, not Isolation Forest; the missing piece is a windowed
   kNN, not a local-density (LOF) detector. Point-adjusted F1 is discredited
   (random scores reach 0.93–0.97); report VUS-PR or AUC-PR.
4. **The `trend-predictor` band is not a prediction interval.** It is a
   delta-method confidence interval for the *mean* crossing time that omits the
   level–slope covariance, uses z instead of t and ignores process noise; the
   toolkit's own Monte-Carlo shows the 90 % band covering ≈ 75–80 % of true
   failure times. The Weibull branch reports distance to the unconditional B90
   age, not the conditional RUL. Cost-optimal replacement has a closed form
   (age-replacement first-order condition) and a one-step rule
   (replace if P(RUL ≤ Δt) > C_p/C_f).
5. **No independent evidence that LLMs improve maintenance decisions.** The
   PHMForge 80.8 % pass@1 is one configuration of a v3 preprint by the tool
   builders; the frontier agent ceiling is 65–81 % with 20–35 % orchestration or
   overstatement failures and a 68 % human-identified hallucination rate in
   audited traces. Advisory drafting from structured findings is defensible;
   tool orchestration by the model is not. The Digital Omnibus (Regulation (EU)
   2026/1744, in force 27 Jul 2026) moved high-risk deadlines to 2 Dec 2027
   (Annex III) and 2 Aug 2028 (Annex I); Article 50 transparency applies from
   2 Aug 2026.
6. **The "88 % / 50 ms / a few mJ" TinyML sentence conflates two papers and
   is wrong on hardware and energy**: the 88.28 % / 45 ms / 17.7 mJ result is an
   ESP32-S3 transfer-learning classifier on proprietary data; published
   Cortex-M bearing classifiers reach 98–99 % at 5–30 ms, and MLPerf-Tiny-class
   autoencoders run in 0.1–1 ms at 20–200 µJ. `@tensorflow/tfjs-node` has had no
   stable release since 21 Oct 2024; Google archived `pycoral` and `libedgetpu`
   in 2025; `onnxruntime-node` is CPU-only on Linux arm64 and INT8 is slower
   than FP32 on a Pi 4.
7. **The methods review's drift recommendation contradicts its own source**,
   which prefers meta-statistic/block-based detectors over KS/MMD and warns
   against score-based drift detection; a distribution shift must never
   auto-trigger a refresh because degradation also shifts the distribution.
   The landscape fact-check found 22 corrections, led by a Deloitte
   misattribution (Deloitte says 5–10 % cost, 10–20 % uptime, 20–50 %
   *planning time*) and a market table whose vendor rows are scrambled.

---

## 1. Vibration diagnostics: which technique for which fault

**Finding (confidence: high · verified: primary).** Every primary source read
treats the (squared) envelope spectrum as the reference method for localized
bearing faults and the raw spectrum as uninformative early on: bearing fault
frequencies "cannot be seen in either the time history or the spectrum" of the
raw vibration, while the envelope of a band around a structural resonance
recovers them (B&K BO 0501); envelope analysis is "by far the most successful
method for rolling element bearing diagnostics" and additive fault lines in the
raw spectrum appear "usually only in the later stages of fault development"
(Randall, Antoni & Gryllias, ISMA 2016). Random slip of ≈ 0.75 % already
smears the higher harmonics in the raw spectrum but not in the envelope
spectrum (Randall & Antoni 2011, secondary). On the Smith & Randall CWRU
benchmark (MSSP 2015; counts tallied from a transcript, ±2 records) the
full-band squared-envelope spectrum clearly diagnoses **40 of 60 (67 %)** 12 kHz
drive-end records and **32 of 52 (62 %)** 48 kHz records; the best of three
methods raises this to 44/60 (73 %) and 37/52 (71 %). Ball faults are "by far
the most difficult" (0 of 12 at 48 kHz with any method); "much of the CWRU data
is atypical". Kiakojouri & Wang (Sensors 2025) re-tabulate the same benchmark as
78.5 / 73.4 / 10.9 % diagnosable for drive-end outer / inner / ball faults.

**Finding (confidence: high · verified: primary).** The only leakage-free deep-
learning benchmark found (Vieira et al., MSSP 258:114640, 2026; bearing-wise
splits, 100 repetitions, Macro-AUROC) shows that the physics preprocessing
carries the transferable information: on Paderborn a WDCNN scores 59.5 % on raw
time windows, 61.9 % on FFT input and **80.2 % on envelope-spectrum input**; on
CWRU 63.2 / 70.9 / 74.5 %, and a **Random Forest on handcrafted features reaches
84.4 %**, above every CNN variant. The same models reach 99.8–100 % with
segment-wise or condition-wise leakage. Earlier evidence agrees (Hendriks et al.
2022; Zhao et al., ISA Trans. 2020: CWRU/SEU/XJTU-SY "can reach 100 %" with basic
models, so they cannot discriminate methods). A simulation-trained 1-D CNN with
cepstrum pre-whitening reaches 88.4 % on CWRU drive-end and 86 % correct class
on a Safran accessory-gearbox ground test, but only 55.6 % on CWRU fan-end outer
race (Kiakojouri & Wang 2025). Learning-based diagnosis "can drastically
decrease under varying working conditions" (Latil et al., IJPHM 2025, abstract).
"ML beats physics" is therefore demonstrated only on leaky splits or with ML *on
top of* physics features.

**Finding (confidence: high · verified: primary).** Resonance-band selection
matters where the full-band envelope fails (≈ one third of CWRU drive-end
records, strong masking, low SNR). The fast kurtogram (Antoni, MSSP 2007) is the
de-facto automated default — Randall's tutorial shows the kurtosis of the
signal rising from −0.61 (order-tracked raw) to 2.2 (after discrete-component
removal) to **14.1 after spectral-kurtosis band filtering** — but kurtosis-based
selection fails for extended spalls (an inner-race spall over ≈ 30 % of the race
"would not be detectable using a kurtogram", while the spectral correlation at
shaft speed rose 25 dB), for carrier-modulated faults, for insufficient
bandwidth and for overlapping impulse responses (ISMA 2016). Post-2016 tools
validate bands by the strength of the *target* cyclic lines in the envelope
spectrum (log-cycligram, Smith et al., MSSP 2019, abstract); the sum of the
squared-envelope-spectrum peaks equals the fourth-order moment of the
band-passed analytic signal (Borghesani et al., MSSP 2014, secondary), i.e.
kurtosis and SES line strength are two views of one quantity. Vendor guidance
prefers a flat, non-resonant band for *trending* and gives 400 Hz-wide examples
at 2.6–11.6 kHz with a resolution rule of 5–10× finer than the wanted
discrimination (B&K BO 0501). On CWRU, cepstrum pre-whitening (M2) and
DRS + SK band selection (M3) performed about equally (my tally 42 vs 43 of 60).

**Finding (confidence: high · verified: primary).** The cepstrum has two proven
uses: measuring the spacing of large harmonic/sideband families (local gear
tooth faults → sidebands at the faulty gear's rotation frequency; the first
rahmonic carries most of the information and the spacing estimate "is very
accurate because it is the average … over the whole spectrum"; close-ratio gears
of 20 vs 21 teeth are separable), and editing: cepstrum pre-whitening (real
cepstrum set to zero = unit-magnitude spectrum with original phase) or
selective liftering (ACEP) of harmonic families before envelope analysis
(Randall, MSSP 97:3–19, 2017). CPW was the single most successful preprocessing
on the hard CWRU records (48 kHz inner race: 8/12 → 11/12 clear). Its weakness
is low SNR — it flattens the resonance that carries the bearing energy — where
selective editing wins: ACEP still detects at −16 dB SNR against a −11 dB limit
for CPW, while above −4 dB CPW gives stronger lines (Peeters et al., ISMA 2016).
The analytic cepstrum (Hilbert magnitude) is needed for zoomed spectra and
planetary gears where the rahmonic can sit at a zero crossing. Cepstral editing
needs no shaft-speed input to *find* a spacing, only to *name* the gear; under
speed variation both cepstral editing and TSA need order tracking first.

**Finding (confidence: medium · verified: secondary).** No independent
benchmark was found in which wavelet/WPT, EMD/EEMD or VMD beats a properly
configured (pre-whitened, band-selected, order-tracked) envelope analysis on
non-CWRU data. The decomposition literature is single-method papers on
CWRU/XJTU-SY that tune VMD's K and α with metaheuristics (grids such as
α ∈ [100, 10⁶], K ∈ [4, 10]; whale, grey-wolf, cuckoo, RIME optimizers) and
compare against EMD-family baselines, not against the envelope reference.
Documented weaknesses: EMD/EEMD mode mixing and noise sensitivity (EEMD "did not
completely remove the interference signal … and increased the calculation
time"); VMD's K/α sensitivity ("duplicate modes", poor ADMM convergence for
large α); wavelets' non-adaptive basis choice. On IMS Set 2 a wavelet method
detected the outer-race fault at ≈ 3.8 running days versus ≈ 3.54 days for a
spectrum-structure method — a ranking within hours on one record (arXiv
1511.03174, preprint). The MCSFormer wavelet-Transformer result flagged in the
methods review remains an unreplicated preprint.

**Finding (confidence: high · verified: primary).** Order tracking is step one
of the reference chain ("1 order tracking; 2 DRS, SANC or linear prediction;
3 MED; 4 SK; 5 envelope analysis"); 0.1 % speed fluctuation already shifts a
1 024-point record by one sample for TSA (Randall 2010). Under a speed sweep
"the conventional envelope spectrum is smeared, and the BPFO cannot be
identified"; on a locomotive bearing conventional envelope analysis showed no
bearing frequencies (bearing judged healthy) while the tacholess order spectrum
revealed BPFO, harmonics and load sidebands of a confirmed spall; fault-order
amplitude gains of 4.1–9.7 dB (Zhao et al., Sensors 2013). For VFD drives the
inverter signature in the vibration serves as a pseudo-tachometer with 0.9–2.1 %
RMS speed error versus 3.6–58.8 % from low-frequency shaft harmonics; after
resampling "BPFI visible without smearing up to the fourth harmonic" (Sawalhi,
Sensors 2025). Residual slip of ≈ 1 % and a 1–2 % spread of kinematic
frequencies across bearing makes (Lessmeier et al. 2016) mean a tolerance band
of ≈ ±2 % of the nominal order remains necessary after tracking. A derived (not
cited) break-down rule: a line at order k smears beyond one bin when the
relative speed excursion within the record exceeds 1/(k·N_rev) — ≈ 0.15 % for
the 27th order in a 25-revolution record.

**Finding (confidence: high · verified: primary).** "Healthy ≈ 3" holds for
*raw* kurtosis of a Gaussian signal; early defects raise it to 4–8 or higher
and crest factor from ≈ 3 to 5–7 (Vibromera, vendor). Both fall back as damage
spreads: overlapping impulse responses push the distribution "towards the value
of a Gaussian distribution" (ISMA 2016, citing Pachaud et al. 1997), and RMS
keeps rising so crest factor drops — "a potential trap for unwary analysts".
Crest factor "is not a robust parameter in a statistical sense"; kurtosis "is
statistically much more robust" because single outliers have little effect
(Beckhoff TwinCAT documentation). The sensitive quantity is the kurtosis of the
*filtered/pre-whitened* signal (−0.38 → 11.58 across the chain, Randall 2010).
The four fault-frequency formulas in the landscape review are correct (B&K
appendix, pure rolling assumed; f_r = relative race speed), but the modulation
rule is more general than stated: a fault on the **rotating** race is
amplitude-modulated at that race's rotation frequency, a rolling-element fault
appears at 2×BSF modulated by FTF, and "clean BPFO without sidebands" holds only
for a stationary outer race under a fixed load direction — a locomotive
outer-race spall under rotating load showed load-modulation sidebands.

**Recommended default pipeline (inference from the sources).** Per record and
bearing: (1) if a `msg.rpm` series or tacho is present and the within-record
variation exceeds ≈ 0.2–0.5 %, integrate to shaft angle and resample the
*envelope* to constant Δθ; otherwise use the constant speed. (2) Cepstrum
pre-whitening, switchable (off at very low SNR), or cepstral editing of
shaft/gear families when gear masking is configured. (3) Fast-kurtogram scan
(1/3-binary tree, ≤ 6 levels) over [1 kHz, Nyquist], each band scored by SES
line strength at the expected fault orders (±2 %, ≥ 3 harmonics) with kurtosis
as tie-breaker; the fixed band kept as trend mode and fallback. (4) Hilbert
squared envelope, Hann window, SES at ≥ 5–10× the resolution needed to separate
BPFI from the nearest ½-harmonic of f_r. (5) Matching of BPFO / BPFI / 2×BSF /
FTF with ±2 % tolerance, harmonic count, BPFI ± f_r and 2×BSF ± FTF sidebands,
½/⅓ inter-harmonics → looseness. (6) RMS velocity for ISO zones, excess
kurtosis and CF of the band-passed signal for early flags, CF only trended.
(7) Analytic cepstrum for gear sideband spacing. (8) ML optional, fed with
order-domain envelope spectra and shipped with bearing-wise validation
metadata. All steps are O(N log N) FFT-class operations.

**Implementable gaps ranked by evidence strength:** (1) computed order tracking
— high; (2) cepstrum pre-whitening toggle before envelope analysis — high;
(3) fast-kurtogram band selection with SES-line validation and a fixed-band
trend mode — high/medium; (4) Hilbert squared-envelope spectrum instead of
rectify + moving average — medium-high; (5) slip/geometry tolerance, 2×BSF +
FTF sidebands and inter-harmonic rules in the matcher — medium-high;
(6) cepstral editing (ACEP) for gearboxes/low SNR — medium; (7) spectral
correlation/coherence for extended faults — medium; (8) raw and excess kurtosis
plus filtered-signal kurtosis — medium; (9) ML inference on envelope/order
spectra with bearing-wise validation — medium; (10) VMD/EEMD/wavelet front-ends
— low, do not prioritise.

> **Implication for this toolkit.** `signal-analyzer` already computes RMS,
> crest factor, kurtosis, an envelope spectrum with BPFO/BPFI/BSF/FTF matching
> (geometry-derived or typed), BPFI ±1X sidebands, looseness (≥ 4 1X harmonics),
> sub-synchronous 0.38–0.48X rules, gear-mesh cepstrum, per-message `msg.rpm`
> and an ISO 20816-3 rating by bin-wise spectral integration over 10–1 000 Hz.
> Three reference steps are absent: there is no order tracking or angular
> resampling (no code matches "orderTracking"); there is no automatic band
> selection — the envelope band-pass is a fixed band, defaults 500–5 000 Hz
> (`envelopeBandLow`/`envelopeBandHigh`, upper edge auto-lowered below Nyquist)
> with a peak floor of 8× the local median (`envelopePeakFloor`); and the
> envelope is rectification followed by a centred moving average
> (`nodes/utils/signal-processing.js`, "Step 2: Rectify (absolute value)"),
> not a Hilbert squared envelope. There is no cepstrum pre-whitening. The
> node reports **excess** kurtosis (`m4 / σ⁴ − 3`, `nodes/signal-analyzer.js`
> line 302) and flags an anomaly at `|kurtosis| > 4` (line 832), which is a raw
> kurtosis of 7 — a late threshold by the 4–8 early-defect range above; the
> node help should state the convention. The BPFI ±1X sideband logic is present
> and conditioned on a found BPFI harmonic; 2×BSF ± FTF sidebands are not
> matched explicitly. The simulated confusion matrix in `docs/VALIDATION.md`
> (healthy 30/30 clean; weak defects 13–47 % detected; medium/strong 70–100 %)
> is consistent with a full-band envelope without pre-whitening; the ranked
> gaps above are the evidence-backed route to the weak-defect rows.

---
## 2. Standards the toolkit should conform to

**Finding (confidence: high · verified: primary for front matter, secondary for
iso.org catalogue status).** The verified standards map, as of October 2026
(iso.org catalogue pages answered HTTP 403 and were read through search-engine
page summaries; iTeh sample PDFs of the forewords and scopes were read
directly):

| Standard | Current edition (Oct 2026) | Status | What conformance means for software |
| --- | --- | --- | --- |
| ISO 13374-1:2003 / -2:2007 / -3:2012 / -4:2015 | Ed. 1 each; -2 confirmed 2021, -3 confirmed, -4 under systematic review (5 pages) | Published | Structural: adopt the DA→DM→SD→HA→PA→AG block vocabulary and a reference information model (part 2 "requirements for a reference information model and a reference processing model to which an open CM&D architecture needs to conform"). No certification scheme exists. |
| MIMOSA OSA-CBM 3.3.1 | 29 Jun 2010; no later release | Frozen | UML data model + XSD + WSDL + binary encoding of the six blocks; "an implementation of the ISO-13374 functional specification". Reuse the data-event *semantics*; do not implement the 2010 wire formats. |
| MIMOSA OSA-EAI / CCOM | OSA-EAI V3.2.3 (date not on page); CCOM 4.0.0 (2016), 4.1.0-RC1 (2020, still RC) | Dormant | Asset-lifecycle exchange model; MIMOSA's only news item since 2022 is a 2025 survey notice. |
| ISO 13379-1 | **ISO 13379-1:2025** (Ed. 2, Oct 2025); 2012 edition **withdrawn** | Published | Diagnostics as descriptors → symptoms → fault with a confidence factor (7.5) and a diagnostic report (Annex A); data-driven methods moved to informative Annex E; new recommended procedure (Clause 4) and FMSA rating methods (5.3.4/5.3.5). |
| ISO 13379-2:2015 | Ed. 1; ISO/CD 13379-2 (Ed. 2) under development | Published | Procedures for data-driven monitoring in a monitoring centre; no algorithm-level conformance. |
| ISO 13381-1 | **ISO 13381-1:2025** (Ed. 3, Sep 2025, 23 pp.); 2015 withdrawn 2 Sep 2025 | Published | Title now "General guidelines **and requirements**". Prognosis outputs: RUL, estimated time to failure (ETTF), confidence level, predictive horizon, failure definition; a prognosis report (7.3 in the 2015 text). |
| ISO 17359:2018 | Ed. 3; reconfirmed 2023 | Published | Programme procedure; clause 8.10 "Baseline data". Process standard, not software. |
| ISO 13373 | Parts 1 (2002), 2 (2016), 3 (2015), 4 (2021), 5 (2020), 7 (2017), 9 (2017), **10 (2024)**; part 8 at AWI; no part 6 | Published | Vibration CM procedures, signal processing (part 2), diagnosis guidelines (part 3); clause text paywalled. |
| ISO 18436 | -3:2025 re-issued; -2 and -8 at FDIS; ISO/DIS 18436-10 new | Published | Personnel certification; not a software target. |
| ISO 20816 | -1:2016, -2:2017 (+Amd 1:2024), **-3:2022**, -4:2018, -5:2018, -8:2018, -9:2020, **-21:2025**; ISO/AWI 20816-7 (Jan 2026); ISO/FDIS 20816-3 Ed. 2 in approval (DIN draft 2026-08) | Published | Zones A–D for broad-band magnitude (criterion I) **and** change in magnitude (criterion II); ALARM/TRIP per 6.5; values are "guidelines based on worldwide machine experience". |
| ISO 10816-6:1995, 10816-7:2009 | Still in force (reciprocating machines; rotodynamic pumps) | Published | Referenced from the ISO 20816-3:2022 scope exclusions. |
| EN 13306:2017 | Stage 90.92 "to be revised" since 6 Aug 2025 | Published | Vocabulary only. |
| ISO 55000:2024 / 55001:2024 | Ed. 2, July 2024; 2014 editions withdrawn | Published | Management system; not software. |
| IEC 62443-4-2:2019 (+Cor 2022); -2-1:2024; -3-3:2013 | Current | Published | Component requirements (SL-C) along seven foundational requirements; assessed on the deployed component, not a library. |
| OPC 40001-1 (OPC UA for Machinery) | 1.04.2, 7 Oct 2026 | Published | §16 *Monitoring* (since 1.04.0, May 2025) with Status / Health / Process / Consumption folders; Health reuses `DeviceHealthEnumeration` of OPC 10000-100 (NAMUR NE 107). |
| OPC 40001-2 Process Values | 1.00, 1 May 2023 | Published | `ProcessValueType` with mandatory `EngineeringUnits`/`EURange`, setpoints, deviation limits. (OPC 40001-101 is *Result Transfer*, 1.01.0, 2025 — not Process Values.) |
| Sparkplug 3.0 | = **ISO/IEC 20237:2023** (Oct 2023, 123 pp.) | Published | Topic namespace `spBv1.0/group_id/message_type/edge_node_id/[device_id]`, NBIRTH/NDEATH/DBIRTH/DDEATH/NDATA/DDATA/NCMD/DCMD/STATE, protobuf payload, 19 metric datatypes; royalty-free specification licence. |
| IDTA AAS submodels | **02048 Predictive Maintenance v1.0 (11 Jun 2025)**; 02008-1-1 Time Series Data v1.1 (2023); 02013-1-0 Reliability v1.0 (2022); 02101 Maintenance Inspection Documentation in development | Published | RUL entity on the OPC Foundation Lifetime model (`DurationValue`, `EngineeringUnit`, `StartValue`, `StartDateTime`), `ConfidenceInterval`, boundary conditions with `DriftInfoAIModel`, `PredictionModelInformation`, pre-alerts. |

ISO 13374/13379/13381/17359/18436 come from ISO/TC 108/SC 5; the ISO 20816 series
(and its 10816/7919 predecessors) from ISO/TC 108/SC 2.

**Finding (confidence: high by convergence · verified: secondary for the
numbers, primary for the foreword).** ISO 20816-3:2022 "cancels and replaces
ISO 7919-3:2009, ISO 7919-3:2009/Amd 1:2017, ISO 10816-3:2009 and ISO
10816-3:2009/Amd 1:2017, which have been merged and editorially revised"
(foreword, sample PDF); the title range widened to 120–30 000 r/min; Amd 1:2017
to ISO 10816-3 was editorial and altered no zone values. The four zone rows in
the landscape review and in `vibration.js` — Group 1 rigid 2.3 / 4.5 / 7.1,
Group 1 flexible 3.5 / 7.1 / 11.0, Group 2 rigid 1.4 / 2.8 / 4.5, Group 2
flexible 2.3 / 4.5 / 7.1 mm/s r.m.s. — agree with three independent secondary
reproductions of Tables A.1/A.2 (Fabrico; ToolGrit, Feb 2026;
travail-industrie), with ACOEM's 2026 article citing the 2022 edition for the
Group 2 B/C pair (2.8 / 4.5), and with Sensemore's statement that "ISO 20816-3
carries forward the ISO 10816-3 boundaries". The free sample does not contain
Annex A, so the numbers are **not primary-verified**. Group definitions add a
shaft-height criterion: Group 1 also covers electrical machines with H ≥ 315 mm,
Group 2 160 mm ≤ H < 315 mm (ISO 496 is a normative reference since Amd 1).
Measurement: "flat response over a frequency range of at least 10 Hz to
1 000 Hz … for machines with speeds approaching or below 600 r/min, the lower
limit … shall not be greater than 2 Hz" (§4.3); ISO 20816-1 notes the 10–1 000 Hz
band was the acceptance-test metric and "might not meet the requirements of a
condition monitoring scheme". The standard explicitly "do[es] not address the
diagnostic evaluation of the condition of those gears or bearings". A second
edition (ISO/FDIS 20816-3, 24 pp.) is in approval and drops ">15 kW" from the
*title*; whether it changes zone values is unknown (paid). "Group" (20816-3)
≠ "Class" (ISO 10816-1 / ISO 2372); vendors still ship the old class scheme for
small machines (B&K Vibro VCM-3 template: Class II alert 4.1, danger 6.4 mm/s),
which ISO 20816-3 does not cover.

**Finding (confidence: high · verified: primary).** OSA-CBM is simultaneously
"the main input for ISO 13374" and its reference implementation; its core is a
UML model with `DataEventSet` → `DataEvent` → `EventData`, block-prefixed
subtypes such as `DMReal` and `PADataEvent`, engineering-unit and asset
identifiers, and XML/HTTP, SOAP or binary transports (Lebold 2007; Drever et
al., PHME 2016). The MIMOSA licence (v2.1.a, 2014) is royalty-free and permits
modification but restricts redistribution of the Materials to bundles "embedded
in or bundled with Licensee product or service" with equally protective
end-user terms — irrelevant if only the semantics are reused. No vendor page
retrieved (Emerson, Bently Nevada, Schaeffler, Tractian) claims "ISO 13374
compliant"; vendors cite the *limit* standard (System 1 "embedded ISO 10816-3,
10816-7 and 14694 wizards"; Tractian "ISO Limit (20816)") and the *analyst*
standard (ISO 18436-2). OSA-CBM adopters cluster in aerospace/defence
(GE/Boeing 2009, Airbus OMAHA 2016, US DoD ATS 2018).

**Finding (confidence: high · verified: primary).** OPC 10000-100 v1.05.0
(15 Nov 2025) defines `DeviceHealthEnumeration`: NORMAL (0), FAILURE (1),
CHECK_FUNCTION (2), OFF_SPEC (3), MAINTENANCE_REQUIRED (4) — "the output signal
is still valid, but the wear reserve is nearly exhausted" — per NAMUR NE 107,
with `DeviceHealthAlarms` of the four matching alarm types. OPC 40001-1 §16
Monitoring/Health reuses it and §15 LifetimeCounters carry the "remaining
estimated lifetime of a MachineryItem". No Machinery-level "condition
monitoring" companion specification exists (Robotics has a CM interface). IDTA
02048 (semanticId `…/PredictiveMaintenance/1/0`, based on DIN EN IEC 63270,
maintenance types adapted from DIN EN 13306) is the first published AAS
template that carries a prognosis — RUL entity, `ConfidenceInterval` (Range),
boundary conditions, model information, pre-alerts — and notes that the
confidence interval is only valid inside the boundary conditions the model was
trained for.

**What is realistic to claim.** Realistic and valuable: (1) "architecture
aligned with the ISO 13374-1 functional model; message fields follow OSA-CBM
data-event semantics" — never "ISO 13374 compliant/certified" (no certifying
body); (2) ISO 20816-3:2022 zone semantics with the edition string, group,
support class, measurement quantity and band, criterion II (change) and
user-set ALARM/TRIP overrides per 6.5; (3) ISO 13381-1 prognosis-report fields
(RUL with unit, ETTF, confidence level, predictive horizon, failure definition)
named so an exporter can fill IDTA 02048; (4) ISO 13379-1:2025 diagnosis output
(descriptors, symptoms, fault hypothesis, confidence factor); (5) mapping tables
to OPC UA `DeviceHealthEnumeration` (zone A/B → NORMAL, C → MAINTENANCE_REQUIRED,
D → FAILURE, out-of-range input → OFF_SPEC, baseline learning → CHECK_FUNCTION)
and Sparkplug metric types. Not realistic: OSA-CBM 3.3.1 XML/WSDL/binary wire
conformance, IEC 62443-4-2 SL-C for a library (document which foundational
requirements the admin guard and path allowlist support instead), and ISO
18436 / ISO 55001 / EN 13306, which are not software standards.

> **Implication for this toolkit.** The ISO 20816-3 machine-group/foundation
> rating in `nodes/utils/vibration.js` and `signal-analyzer` (legacy ISO 10816-1
> class I–IV table kept as a labelled option) carries exactly the four verified
> rows and the 10–1 000 Hz integration band; its median rating error of 0.2 % in
> the simulated validation concerns the integration, not the table. What the
> standards add: tag the table with the edition ("ISO 20816-3:2022") so the
> pending second edition is traceable, expose the 2 Hz lower band limit for
> ≤ 600 r/min machines, and add criterion II (change versus baseline) and
> ALARM/TRIP overrides. `trend-predictor` emits `rul`, `rulLower`, `rulUpper`,
> `confidence` (R²), `confidenceLevel` and `status`, which covers the interval
> but not ETTF as an absolute time, the predictive horizon or the failure
> definition as named fields. `severity` is emitted by `anomaly-detector`,
> `signal-analyzer` and `multi-value-processor` but not by
> `isolation-forest-anomaly` or `pca-anomaly` — a prerequisite for any uniform
> `DeviceHealthEnumeration` mapping. The `needsPermission` guard on every
> `httpAdmin` route and the model-path allowlist (`nodes/utils/path-validator.js`)
> map onto IEC 62443-4-2's IAC/UC and SI foundational requirements and should be
> described that way, not as 62443 conformance.

---
## 3. Anomaly detection on time-series and vibration data

**Finding (confidence: high · verified: primary).** The JMLR 2024 result is
correctly quoted in the methods review (33 algorithms × 52 **tabular** data
sets; EIF best on global, kNN best on local anomalies; kNN mean AUC 0.740 vs
DeepSVDD 0.557) but it does **not** transfer to time series. On TSB-AD (Liu &
Paparrizos, NeurIPS 2024 Datasets & Benchmarks; 1 070 curated series from 40
datasets, 40 algorithms, VUS-PR as the sole ranking measure) the univariate
leaders are **Sub-PCA 0.42**, KShapeAD 0.40, POLY 0.39, Series2Graph 0.39,
MOMENT 0.38–0.39, KMeansAD 0.37, Sub-KNN 0.35 and Matrix Profile 0.35, against
**IForest 0.30**, Sub-IForest 0.22, Sub-LOF 0.25, LOF 0.17 and
AnomalyTransformer 0.12; on the multivariate track CNN 0.31, OmniAnomaly 0.31,
**PCA 0.31**, LSTMAD 0.31, OCSVM 0.26, MCD 0.27, **EIF 0.21, IForest 0.20, KNN
0.18, LOF 0.14**. The authors' own reading: "Statistical-based methods generally
demonstrate robust performance, while neural network-based methods do not
exhibit the superiority often attributed to them"; "Sub-PCA and KShapeAD
demonstrate exceptional performance, despite having been overlooked as basic
baselines for many years". A tuned Matrix-Profile/kNN detector (MMPAD, arXiv
2604.02445, Apr 2026, preprint; k = 5/15, exclusion zone, moving-average
post-processing) tops both tracks at **0.44 / 0.35**. TimeEval (VLDB 2022; 71
algorithms, 976 series) found "no clear winner", deep learning "not (yet)
competitive", and DWT-MLEAD the best cost/benefit (AUC-ROC 83 %, 2.2 ms per
point); TSB-UAD (VLDB 2022) and TAB (2025 preprint) rank NORMA/Matrix Profile,
k-Means, kNN, OC-SVM and PCA/POLY/IForest as the robust set. On SWaT / WADI /
SMD a **PCA reconstruction error** gives the best point-wise F1 in every column
(0.833 / 0.501 / 0.655 / 0.572) and trained deep models distil into a one-layer
linear perceptron with no loss (Sarfraz et al., ICML 2024). ADBench (NeurIPS
2022; 30 × 57) adds that "none of the benchmarked unsupervised algorithms is
statistically better than others". What transfers from the tabular result is
"kNN on subsequences"; EIF/IF do not transfer; PCA, which the JMLR study does
not single out, becomes a top method.

**Finding (confidence: high · verified: primary).** Point-adjusted F1 is
discredited: uniformly random scores reach PA-F1 **0.969 (SWaT), 0.965 (WADI),
0.931 (MSL), 0.961 (SMAP)** — above every published method on four of five
datasets — while their plain F1 is 0.08–0.23 (Kim et al., AAAI 2022; Sarfraz
2024 reproduces 0.963 / 0.894). Benchmark triviality is documented: 316 of 367
Yahoo series (86.1 %) are solvable with a one-line expression, and run-to-failure
bias puts anomalies at the end of series (Wu & Keogh, TKDE 2023). VUS-PR is the
2024–2026 consensus threshold-free measure ("most robust (less sensitive to
lags)", TSB-AD; VLDB Journal 2025); under best-of-N reporting affiliation-F1 and
ROC-family metrics become gameable (affiliation-F1 crosses the gameable line by
N = 3, ROC by N = 9–11) while PR-family metrics and PA%K stay flat (Lyu, arXiv
2607.11969, preprint). Pretraining contamination inflates foundation-model
results: MOMENT scores VUS-PR 0.38 on TSB-AD-U but **0.12 on its own held-out
subset**; only ≈ 7 % of benchmark datasets were never used for pretraining of
any TSFM (Meyer et al. 2025, preprint). Threshold leakage is common — ICML 2024
admits its F1 uses the best test-set threshold.

**Finding (confidence: high · verified: primary).** On vibration features the
detector matters less than the feature. CWRU is saturated (Isolation Forest F1
0.998, OC-SVM 0.997, LOF 0.789 on kurtosis/skewness/peak-to-peak; Neupane et
al., PHME 2024 — "future researchers start with the traditional approaches
first"). On Paderborn real damage under a strict one-class protocol, IF on
classical features reaches ROC-AUC 0.625 / F1 0.184, OC-SVM 0.734 / 0.332, an
autoencoder 0.429, Deep SVDD 0.654, and a self-supervised CNN–Transformer with IF
on top 0.878 (Zaidi et al., Processes 2026). On field EMU traction-motor data IF
scores 0.636 accuracy against 0.952 for a VMD + residual-RMS + OC-SVM pipeline —
the gain is in the representation, not the scorer (Cui et al., Sensors 2025).
On IMS Bearing2_1 the first-detection index is 535 for RMS with SVDD, LOF or
IF alike but 650–703 for kurtosis with the same detectors (Dai et al., Sensors
2025): the health indicator moves onset by 115–168 files, the detector by none.
Per-feature mean ± 3σ limits gave 38 % false positives on a test bench against
15 % for a nearest-neighbour distance and 8 % for clustering (Górski et al.,
Sensors 2021). On DCASE machine sounds, switching the scoring backend among
cosine-kNN, Mahalanobis, density-normalised kNN and PCA residual moves AUC by
13.8 points on average and "no single backend won everywhere" (arXiv
2606.19269, preprint). **No head-to-head study of IF vs EIF vs kNN vs
Mahalanobis vs PCA/SPE on handcrafted vibration features under one protocol
exists**; ranking by what is available: PCA/SPE and OC-SVM at or above IF, LOF
consistently weakest, EIF ≈ IF.

**Finding (confidence: high · verified: primary).** EIF adds nothing on time
series: TSB-AD-M EIF AUC-PR 0.19 / VUS-PR 0.21 vs IForest 0.19 / 0.20; the EIF
paper itself reports "no appreciable difference" on synthetic blobs (the gain is
in score-bias maps), and Generalized Isolation Forest found EIF better on only
4 of 14 datasets. Deep Isolation Forest (TKDE 2023) beats both mainly in AUC-PR
(Mars 0.626 vs 0.458 / 0.390) but on learned embeddings with neural forward
passes. Naive subsequence flattening *hurts* tree methods (Sub-IForest 0.22 vs
IForest 0.30).

**Finding (confidence: high · verified: primary).** Zero-shot time-series
foundation models rank below Sub-PCA/Sub-kNN (TSB-AD-U VUS-PR: MOMENT 0.38,
TimesFM 0.30, Lag-Llama 0.27, Chronos 0.27; OFA/GPT-2 0.24), excel only at
point anomalies, and "struggle with sequence anomalies … The use of flawed
point-adjustment techniques … creating an illusion of progress" (TSB-AD). A
plain moving-variance detector beats Chronos, TimesFM, Time-MoE and MOMENT on
MSL, SMD and SMAP (TimeRCD, preprint 2026). MOMENT loses to a TCN-AE and to
Isolation Forest on C-MAPSS degradation ranking (AUROC 0.731 vs 0.957 / 0.952)
and to OC-SVM on MIMII pump sound (0.550 vs 0.694), at 13.4 ms per batch on an
RTX 4090 and 691 MB VRAM versus 0.29 ms and 2.6 MB for the TCN-AE (Wen & Chen,
arXiv 2608.22968, preprint). Chronos-2 (arXiv 2510.15821, 17 Oct 2025; 120 M
parameters) is a forecasting release with no anomaly evaluation and costs a
median 1.4 s per forecast on an 8-core desktop CPU (FETS, preprint). No TSFM has
been evaluated zero-shot on CWRU, PRONOSTIA, XJTU-SY or IMS raw vibration. The
e-Energy 2025 paper in the landscape sources compares TimeGPT and MOMENT only
(no Chronos) and finds a from-scratch VAE beats both.

**Finding (confidence: high · verified: primary).** Label-free threshold
calibration: peaks-over-threshold EVT (SPOT/DSPOT; Siffer et al., KDD 2017)
fits a generalized Pareto distribution to excesses, needs one risk parameter
q (typically 10⁻³–10⁻⁴) and a calibration batch of ≈ 1 000 points, converges to
the theoretical quantile "regardless of n", and makes no distributional
assumption; DSPOT runs on residuals of a local model for drifting baselines. A
per-operating-condition GEV scheme (MSSP 139:106417, 2020, snippet) is "adopted
by industrial partners: EDF Energy and Beran Instruments". 3σ works on a scalar
*detector score* (Neupane 2024: μ − 3σ on IF/OC-SVM scores best) and fails on
raw per-feature vibration statistics (Górski). A `contamination`-style
threshold is a training-score quantile whose false-alarm rate drifts silently
as the score distribution moves.

> **Implication for this toolkit.** Of its multivariate detectors, `pca-anomaly`
> — Hotelling T² with an F-based limit (χ² fallback) and SPE with Box's weighted
> χ² approximation, `threshold` default 3.0 as a one-sided normal quantile,
> `retrainMode` on by default — has the strongest benchmark backing; the
> Mahalanobis test in `multi-value-processor` (F-based limit against the history
> before the sample) is the second. `isolation-forest-anomaly` is the
> **standard** axis-parallel Isolation Forest (`numEstimators` 100, `maxSamples`
> 256, `contamination` 0.1, threshold at the contamination quantile of training
> scores; batch / incremental / adaptive modes), i.e. a mid-table generalist on
> time series; replacing it with EIF would change nothing measurable. There is
> no kNN or LOF detector; the evidence favours adding a windowed kNN /
> Matrix-Profile distance to a healthy window bank, not LOF. The univariate
> `anomaly-detector` (z-score default, IQR, threshold, percentile, EMA, CUSUM,
> moving average; scored against the window *before* the sample; 10 %
> hysteresis; `consecutiveCount` 1) applies σ-rules to raw features per regime;
> a POT/SPOT option exposing a risk q instead of a σ multiplier is the
> evidence-backed default for its `threshold` branch, and the `adaptive` IF
> mode's contamination-quantile tracking should be bounded. There is no
> foundation-model detector, and the evidence says it should stay an experiment.
> The toolkit's own validation (PRONOSTIA fixture, `examples/test-suite.json`)
> should report VUS-PR or AUC-PR plus an event-level "detected before onset"
> statistic, never point-adjusted F1.

---
## 4. Prognostics: evaluation, metrics and classical statistics

**Finding (confidence: high · verified: primary).** Three conventions silently
decide C-MAPSS numbers: the piecewise-linear RUL cap (125 cycles since Li et
al. 2018, 130 in other work; a cap of 125 changes 38.9 % of FD001 training rows
because the shortest engine runs 128 cycles — practitioner evidence, low
confidence), the asymmetric PHM08 score, and last-window-only scoring of
truncated test units. The score as printed in Saxena et al. 2008 is
s = Σ (e^{−d/a1} − 1) for d < 0 and Σ (e^{d/a2} − 1) for d ≥ 0 with
d = estimated − true RUL and "a1 = 10, a2 = 13" — which, attached to those
branches, penalises *early* predictions more, contradicting the paper's own
sentence that late predictions are penalised more heavily; every 2023–2026
paper checked uses 13 for early and 10 for late (arXiv 2610.04278; Robinson,
IJPHM 2026). The score is a *sum* over units (n = 100 for FD001/FD003, 259/248
for FD002/FD004), so it is comparable only with n stated. Measured leakage
routes: per-condition normalisation fitted with test statistics shifts RMSE by
−4.39 (FD002) and −7.40 (FD004) and refitting the normaliser on train +
validation engines by a further −1.1 to −0.2 (Gupta, engrXiv 2026, abstract);
window-level instead of unit-level splitting inflates fault-classification
accuracy from a genuine 20–60 % to 99.9 % on C-MAPSS, NASA IMS and the UCI
hydraulic set (Shamim et al., arXiv 2607.16493, preprint); test-score feedback
let "a leading test score rank only 22nd on the final test leaderboard" in
PHM08 (Bektas et al., Data in Brief 2018). The organisers withheld the
validation set for exactly this reason. N-CMAPSS (Arias Chao et al., Data
2021) lets every cycle be scored; a 2026 study on nine N-CMAPSS subsets with
twenty replicated unit-level splits finds split-conformal and CQR track nominal
coverage while CV+ "degrades toward its worst-case guarantee" because of
within-engine correlation, and coverage "collapses under concept shift that
covariate reweighting cannot fix" for 2 of 9 held-out failure modes (Yan,
Zenodo 2026). Minimum reporting: subset, cap value and whether the test target
is capped, window length, normalisation fit scope, score convention and n.

**Finding (confidence: medium · verified: secondary; PRONOSTIA primary
bot-blocked).** PRONOSTIA's official protocol is within-condition: the first
two bearings of each condition train, the remaining 11 (5 / 5 / 1) test at a
truncation point; 25.6 kHz, 2 560 samples every 10 s, end of life at 20 g; the
PHM12 score A = exp(−ln 0.5 · Er/5) for Er ≤ 0 and exp(+ln 0.5 · Er/20) for
Er > 0 with Er = (true − predicted)/true × 100 %, i.e. it halves at −5 % (late)
and at +20 % (early). Condition 3 is listed as 1 300 rpm / 4 500 N in Tefera et
al. (IJPHM 2025) but 1 500 rpm / 5 000 N in the landscape review; the primary
(Nectoux et al. 2012, HAL) could not be fetched. Bearing RUL labels are
*defined* from the first-prediction time (y = T before FPT, linear after), and
the FPT rule is a 3σ / μ + kσ threshold on an indicator, in modern work with
SPC run rules (k = 2, five consecutive exceedances; SARNet, preprint 2025).
Any threshold tuned on the same bearing that is later scored is in-sample; the
defensible protocol is leave-one-bearing-out within a condition with
parameters frozen on the others, and percentage error at the prediction time in
addition to absolute error.

**Finding (confidence: high · verified: primary).** The IJPHM 2010 metric
hierarchy (Saxena et al.) is defined per unit with a β-probability-mass
criterion: **Prognostic Horizon** PH = t_EoL − t_i, i the first index at which
the predicted RUL distribution puts ≥ β of its mass inside r* ± α·t_EoL;
**α-λ accuracy** = 1 if the mass inside [(1 − α)r*, (1 + α)r*] is ≥ β at
t_λ = t_P + λ(t_EoL − t_P), point form (1 − α)r* ≤ r̂ ≤ (1 + α)r* (library example
α = 0.1, β = 0.5); **Relative Accuracy** RA_λ = 1 − |r* − r̂|/r*; **Cumulative RA**
= weighted mean of RA over predictions before t_λ; **convergence** = Euclidean
distance from (t_P, 0) to the centroid of the area under a metric curve. The
α-bounds differ between PH (± α·t_EoL) and α-λ (± α·r*) — implementers mix them
up. Sharp (PHM 2013) criticises the hierarchy as "largely self-reliant" and
proposes lifetime-percentage metrics (weighted error bias, prediction spread,
confidence-interval coverage). For intervals: PICP = mean 1{y ∈ [L, U]},
MPIW = mean(U − L), PINAW = MPIW/(y_max − y_min), plus conditional coverage by
RUL bin (Robinson, IJPHM 2026: asymmetric CQR at nominal 0.90 gives PICP
0.88–0.92 and PINAW 0.35–0.49 on FD001–FD004 with RMSE 13.3–16.9). Conformal
coverage is marginal "and only holds on average across all data points"
(Javanmardi & Hüllermeier, IJPHM 2023).

**Finding (confidence: high · verified: primary).** Two HI-quality families
collide. Coble & Hines (PHM 2009): monotonicity = |#(dx > 0) − #(dx < 0)|/(n − 1)
per history, averaged; prognosability = exp(−std(p_fail)/mean|p_start − p_fail|)
across units; trendability = 1 − std over units of (#(dx > 0)/(n − 1) +
#(d²x > 0)/(n − 2)), "particularly sensitive to noise"; fitness = weighted sum
(GA-optimised PHM08 combination: M 0.933, P 0.909, T 0.805). MathWorks implements
monotonicity (sign or Spearman-rank form, Savitzky–Golay smoothed),
prognosability as above, and **trendability as the minimum pairwise
correlation between units** after resampling to percent lifetime. The bearing
literature (Zhang, Zhang & Xu 2016 → Lei 2018 → 2025 papers) uses monotonicity
on the smoothed trend, "trendability" = Pearson or Spearman correlation with
time, **robustness** = mean exp(−|(y − y_tr)/y|), and a hybrid score = mean of
the three; consistency between two HIs = 2·I(h1, h2)/(H(h1) + H(h2)). Single-run
metrics (one asset) can only be monotonicity, correlation-with-time and
robustness; prognosability and the Coble/MathWorks trendability need ≥ 2
run-to-failure histories. **No literature-backed acceptance threshold exists**;
values are used to rank candidates (≈ 0.8–0.93 in Coble's example; 0.18 / 0.79 /
0.85 for a residual HI in a 2024 N-CMAPSS paper).

**Finding (confidence: high · verified: primary definitions, derived mapping).**
The crossing time t* = (T − â)/b̂ is a ratio of correlated regression estimates
(inverse prediction/calibration). Fieller's theorem gives the exact interval,
bounded only if the slope is significant (b̂²/σ̂_b² > t_q²); otherwise the
confidence set is unbounded, and "any method which is not able to generate
unbounded confidence limits for a ratio can lead to arbitrary large deviations
from the intended confidence level" (Gleser–Hwang, via Franz 2007). The
delta/Taylor interval is acceptable when the slope's CV is small but must carry
the covariance term. With g = T − ŷ_n, S_xx = Σ(x_i − x̄)², σ̂² = SS_res/(n − 2):
var(ŷ_n) = σ̂²(1/n + (x_n − x̄)²/S_xx), var(b̂) = σ̂²/S_xx, cov(ŷ_n, b̂) =
σ̂²(x_n − x̄)/S_xx > 0, and

    var(t̂) ≈ var(ŷ_n)/b̂² + g²·var(b̂)/b̂⁴ + 2·g·σ̂²(x_n − x̄)/(S_xx·b̂³),

the third term positive, so dropping it under-states the variance; the
quantile should be t_{n−2} (2.101 vs 1.960 at n = 20). All of this is a
confidence interval for the *mean* crossing time; a prediction interval for the
noisy crossing needs a process model: Wiener X(t) = x₀ + μt + σB(t) gives an
inverse-Gaussian RUL with f(l) = (w − x_t)/√(2πσ²l³) · exp(−(w − x_t − μl)²/(2σ²l)),
mean (w − x_t)/μ, variance σ²(w − x_t)/μ³; a Gamma process gives
F_T(t) = Γ(v(t), uL)/Γ(v(t)) (teaching notes; Si et al. 2011 and van Noortwijk
2009 confirmed by listing only).

**Finding (confidence: high · verified: primary for NIST/vendor, derived for
the conditional forms).** Weibull conditional RUL given survival to age t:
R(x | t) = exp{−[((t + x)/η)^β − (t/η)^β]}; conditional quantile
x_q(t) = η[(t/η)^β − ln(1 − q)]^{1/β} − t (for R = 0.1 from now:
t + x = η[(t/η)^β + ln 10]^{1/β}); mean residual life
MRL(t) = (η/β)·e^{(t/η)^β}·Γ(1/β, (t/η)^β) with MRL(0) = ηΓ(1 + 1/β). Rank
regression on X is the vendor-recommended estimator for small complete
samples, MLE for censored data, "as sample sizes get larger, 30 or more, these
differences become less important" (ReliaSoft). Weibull-PHM
h(t | z) = (β/η)(t/η)^{β−1} exp(γᵀz(t)) is the classical way to let condition
data update a Weibull hazard (Jardine line; haul-truck wheel motors 20–30 %
overhaul-cost savings, 2001, secondary); no 2023–2026 Weibull-PHM paper was
reached. **Similarity-based RUL** (Wang et al. 2008, highest PHM08 score per a
secondary report; Eker et al., PHME 2014): match the last λ observations of
the test HI against a library of complete run-to-failure trajectories at every
alignment, convert distances to similarities, return the similarity-weighted
mean of the library units' remaining lives at the matched points, optionally
using only the most similar K % (best K = 38 % and 44 % on two datasets); it
needs ≥ 5–10 comparable run-to-failure traces of the same HI.

**Finding (confidence: high · verified: primary).** Cost-optimal replacement
with failure CDF F, hazard h, preventive cost C_p and failure cost C_f (age
replacement, Barlow & Proschan 1965 via Choo & Shin, IJPHM 2025):

    C(T) = [C_p + (C_f − C_p)·F(T)] / ∫₀ᵀ R(t) dt,
    optimum: h(T*)·∫₀^{T*} R(t) dt − F(T*) = C_p / (C_f − C_p),
    C(T*) = (C_f − C_p)·h(T*)   (unique and finite under IFR).

Block replacement with minimal repair at cost C_k: C(t_p) = [C_p + C_k ∫₀^{t_p} h]/t_p
with t_p·h(t_p) − ∫₀^{t_p} h = C_p/C_k; for Weibull β > 1 this closes to
t_p* = η·[C_p/(C_k(β − 1))]^{1/β}. Choo & Shin fit a Weibull by MLE to XGBoost
failure-time predictions of 100 FD001 engines (RMSE 17.86; mean 206.97 cycles)
and show t_0* falling from 177.7 to 111.0 cycles as C_f/C_p rises from 1.8 to
11, i.e. the answer is cost-ratio-sensitive. The 2026 prognostics-based policy
paper (Koutas & Straub, arXiv 2607.27899, preprint) uses as benchmark the
one-step rule **replace component i if P(RUL_i ≤ Δt) > (c_f + c_v,i)/c_c** —
the preventive/corrective cost ratio — and derives renewal-reward policies up
to 35–65 % cheaper on a virtual simulator. The landscape review's sentence that
the replacement time sits where failure risk and remaining part value balance
is supported; "replace at the q-quantile of RUL" is not cost-optimal in
general.

> **Implication for this toolkit.** `trend-predictor` (`nodes/trend-predictor.js`
> lines 538–820) fits linear, exponential (log-linear, falling back to linear
> when any value ≤ 0) or Weibull models after a median filter (5) and a centred
> moving average; the slope is 0.7 × Theil–Sen + 0.3 × OLS, the level the median
> of Theil–Sen intercepts at the last sample; "no trend" is a slope within 2
> standard errors of zero. The band is exactly the delta method above **without
> the covariance term**: Var(steps) = varLevel/slope² + gap²·varSlope/slope⁴ with
> OLS-only variances, a two-sided normal z from `confidenceLevel` (default 0.95,
> clamped 0.5–0.9999), symmetric, no process noise, and a Theil–Sen/OLS blend
> slope paired with an OLS variance. The toolkit's own Monte-Carlo
> (`tools/sim/sim-rul.js`, September 2026) measured the 90 % band covering the
> true failure time in ≈ 75–80 % of runs and the 99 % band in ≈ 90 %, point
> estimate ≈ 2 % optimistic — under-coverage consistent with the omitted term
> and z vs t. Minimal fix: add the covariance term and use t_{n−2}; better:
> report the Fieller interval and declare it **unbounded** whenever the existing
> "slope within 2 SE of zero" test fails (that test is Fieller's boundedness
> condition at ≈ 95 %); for a real prediction interval fit μ, σ² from HI
> increments and use inverse-Gaussian quantiles. The Weibull branch reads the
> degradation fraction D = level/threshold as F(t_eq) = D and reports time to
> R = 10 % from the *unconditional* age, with a band from level uncertainty
> only; no source supports the D → F(t) mapping, and the literature's
> conditional quantity at the same age is η[(t_eq/η)^β + ln 10]^{1/β} − t_eq or
> MRL(t_eq). `health-index` (weighted, dynamic, minimum, average, geometric
> aggregation) has no HI-quality scoring; the single-run metrics
> (monotonicity, correlation-with-time, robustness) are implementable per
> asset today, prognosability only once several run-to-failure traces exist.
> Cost-optimal replacement timing is absent (landscape §10 "still open"): with
> the band's CDF and a configured C_p/C_f, both the one-step rule and the
> age-replacement optimum above are closed-form additions. Similarity-based
> RUL is not feasible with one committed fixture (PRONOSTIA Bearing1_1).

---
## 5. LLM agents for maintenance decisions

**Finding (confidence: high · verified: primary).** All five sources cited in
the landscape review §9 exist, but each needs qualification. **PHMForge**
(arXiv 2604.01532; Columbia / Georgia Tech / IBM; preprint, no independent
reproduction): the quoted numbers match **v3 (24 Aug 2026)** — 99 SME-authored
scenarios over eight asset classes (turbofans 14, aero-engines 30, bearings 22,
batteries 24, motors 5, gearboxes 3, industrial engines 1; no pumps, hydraulics
or wind-turbine drivetrains), 39 MCP tools, 3 frameworks × 6 backbones — while
v1 (2 Apr 2026) of the same ID had a different title, 75 scenarios, 65 tools and
a 68 % peak. **80.8 % pass@1 is one configuration** (Claude Code + Claude Opus
4.6); the next is 64.6 % (Sonnet 4.5); open-weight backbones scored 36–80 % on
a 25-scenario subset. The "100 % → 20 %" figure is **pass-all-3** on five
lithium-ion RUL scenarios (5/5 → 1/5); the mean pass@1 drop on that class is
80.6 → 48.6 % (operator-style) and 91.7 → 73.6 % (protocol-style), and the
ablation covers only the battery class. "Remaining failures are planning
errors, not invocation errors" overstates the paper: orchestration errors
dominate (23 % trajectory-level incorrect sequencing) but schema-invalid calls
concentrate in smaller open-weight models, Mistral-Medium-2505 truncated
100-element arrays (0 % on RUL), and 64 % of distractor failures were
"semantic-brittleness". Without enforced self-computed MAE/RMSE there was a
**31 % false-positive rate** of agents claiming success. LLM-judge agreement
with humans is α = 0.61 (human α 0.74–0.82). The authors state the design
"biases PHMForge toward measuring orchestration over an existing tool surface".
**Predictive Maintenance MCP** (Di Maggio, Applied Sciences 16(6):2812, 15 Mar
2026, MDPI 403) is a single-author proof-of-concept, MIT-licensed, 38 tools + 3
prompts, ISO 20816-3 / ISO 13374 / OSA-CBM vocabulary, Ollama-capable; its only
accuracy evidence is a self-reported README benchmark: correct fault ranked
first in 34/44 (77.3 %) of the clearly-diagnosable CWRU 12 kHz records and **2 of
4 healthy baselines raised a false indication**. The PHME "prediction to
prescription" paper is from **2024** (Cranfield; GPT-4 + top-5 RAG) and scores
only fault *classification* on a linear-actuator rig (85.36 % vs 83.04 %
InceptionTime); the prescriptive output is example text. The log-cleaning
paper (PHMAP 2025 / arXiv 2511.05311) uses **synthetic** logs with injected
noise: out-of-fleet rejection ≥ 92 % for all six models, GPT-5 100 % on missing
values, but **0 % of wrong end dates corrected by every model**, identifier
misalignment ≤ 27.7 %, and GPT-5 cost $5.86 and 11 051 s per experiment.

**Finding (confidence: high · verified: primary).** No independent evaluation
of an LLM on real maintenance decisions exists. The closest: ChatGPT scored
**67 % on a GE Vernova PHM analyst exam against an 80 % pass mark** (Bard 56 %;
hallucination rates 5–10 %; Lukens & Ali, PHM 2023); GE Vernova's copilot caught
94–96 % of failure modes on 294 historical cases but SMEs agreed on *which
troubleshooting step reveals the failure mode* in only 25 % of cases (Lukens
et al., PHM 2024); AssetOpsBench (IBM, KDD 2026) tops out at 65 % task
completion with "no model exceeding a 70 % completion rate" and 46 % under
plan-execute, with 23.8 % "overstatement of task completion" and a +7-point gain
from a clarification step; the Trajel audit of its traces finds a **68.3 %
human-identified hallucination rate** (procedural 38.5 %, factual 26.3 %, scope
19.8 %) and an LLM judge missing 79 % of logical and 77 % of referential
hallucinations (arXiv 2605.24219, preprint); on real MaintNet aviation logs a
fine-tuned Gemma-3-4B beats GPT-4o but absolute fidelity is BLEU ≈ 0.05,
ROUGE-1 ≈ 0.35 (Kumar et al., PHMAP 2025). The widely indexed arXiv 2410.03223
(ChatGPT 65 % / Claude 72 % / proposed 91 %) contradicts itself between tables
and should not be cited. Surveys place LLMs at "near-term value for
information and decision-support agents" (Di Maggio, Applied Sciences 2025);
every quantified deployment figure (Siemens Industrial Copilot "25 % less
reactive maintenance time", Senseye 40 % / 55 % / 50 %) is a vendor pilot claim
without method or site.

**Finding (confidence: high · verified: primary).** Documented failure modes:
non-determinism at temperature 0 (47.6–75.8 % of code tasks with zero identical
outputs, Ouyang et al. 2024; 80 unique completions in 1 000 at T = 0 from
batch-size-dependent floating-point non-associativity, Thinking Machines 2025;
Claude Opus 4.7/4.8 "has deprecated temperature entirely", Tamba 2026);
numeric errors — frontier models score **45–63 %** on 500 real calculation
tasks with rounding 35 % and arithmetic 33 % of errors (ORCA, preprint); unit
mis-conversion; fabricated citations (≈ 18 % with GPT-4, Walters & Wilder,
Sci. Rep. 2023); format restriction degrading reasoning (Tam et al. 2024; a
two-step prose-then-JSON recovers it); small open-weight models producing
schema-invalid calls. Mitigations with numbers: deterministic tools (PHMForge
ablation), mandatory verification (31 % false positives without),
self-consistency (+4 to +18 points on reasoning sets), clarification prompts
(+7 points). Local models: on a 3 570-test tool-selection benchmark
qwen3:14B-Q4_K_M reaches F1 0.971 (gpt-4 0.974), qwen3:8B-Q4 0.919, llama3.1:8B-Q4
0.793 (Docker, vendor blog) — single-step selection is near-frontier, but the
same model classes score 36–48 % on PHMForge's multi-step tasks; CPU decoding is
≈ 1.5–2.5 tok/s for 7 B Q4 on a Raspberry Pi 5 and ≈ 3 tok/s on a 4-core Xeon
(community numbers, low confidence), so a 300-token advisory takes minutes.

**Finding (confidence: high · verified: primary, EUR-Lex).** Regulation (EU)
2026/1744 (Digital Omnibus on AI, OJ 24 Jul 2026, in force 27 Jul 2026)
defers Annex III high-risk obligations to **2 Dec 2027** and Annex I
(product-embedded) to **2 Aug 2028**, narrows "safety component" to functions
whose intended purpose is to prevent or mitigate risks, and moves the Machinery
Regulation into Annex I Section B. Article 50 transparency applies from
**2 Aug 2026** (machine-readable marking of generated text under 50(2); grace
to 2 Dec 2026 for pre-existing systems); GPAI *provider* obligations since
2 Aug 2025. Annex III point 2 (safety components in critical-infrastructure
operation) is the only Annex III route relevant to CM. The Machinery Regulation
(EU) 2023/1230 applies from **14 January 2027** (Art. 54; many secondary
sources say 20 January) and puts ML-based "self-evolving" safety components
under third-party assessment (Annex I Part A points 5–6); whether a
non-learning but non-deterministic LLM counts as "self-evolving" is undefined.

> **Implication for this toolkit.** `llm-analyzer` already follows the pattern
> the evidence supports: it receives structured findings from other nodes
> (batched, stable column schema per node lifetime) and does no tool use or
> MCP — the LLM never calls the analysis nodes. Its JSON mode appends a schema
> instruction to the system prompt and parses the reply from raw JSON or a
> ```json fence; it does **not** use provider-native structured outputs or
> function calling, so schema validity is not enforced. Providers are
> Anthropic, OpenAI, OpenAI-compatible, Google Gemini and Ollama
> (`nodes/utils/llm-providers.js`); `msg.apiUrl` overrides are allowed only
> when explicitly enabled and same-origin. Evidence-backed additions, all
> outside the model: a `reasoning`-first output schema validated after
> parsing; a deterministic grounding check that every number, zone label,
> fault type and standard reference in the output exists in the input; an
> "AI-generated" marker in the payload (Art. 50 hygiene from 2 Aug 2026); a
> logged prompt hash, model id and output hash per run instead of any
> reproducibility promise; documentation of the role as "advisory draft for
> qualified personnel; not a safety function; not self-evolving"; and a note
> that no independent study shows LLM advisories improve maintenance outcomes.
> Keep analysis sequencing in the flow, not in the model.

---

## 6. Edge deployment

**Finding (confidence: high · verified: primary for identifiers; medium ·
secondary for the Springer numbers).** The landscape review's sentence "TinyML
models on microcontrollers now classify bearing states at roughly 88 % accuracy
in under 50 ms and a few millijoules per inference" compresses two papers and
gets the hardware and the energy wrong. Gao et al., Sci. China Technol. Sci.
68(12):2220401 (2025; Crossref-verified) report **88.28 %, 45 ms, 17.7 mJ on an
ESP32-S3** (Xtensa LX7, not Cortex-M) on a proprietary four-fault dataset with
transfer learning (abstract via two concordant snippets; publisher page
redirects). Garay et al., Sensors 26(14):4536 (17 Jul 2026) report an **INT8
fully-connected autoencoder on ten time-domain features reaching F1 = 0.9807 on
a Cortex-M4F at 254 µs and 6 056 B flash** for static-unbalance anomaly
detection — not bearing classification — plus a per-installation
healthy-baseline recalibration that restores F1 = 0.975 without weight
retraining, and a latency budget in which the cloud uplink is 79–88 %. Better-
documented MCU bearing classifiers: a QAT-INT8 1-D CNN with CMSIS-NN on a Teensy
4.1 reaches macro-F1 98.6 ± 0.3 % across seven public datasets at 4.7 ms, 90 kB
flash, 42 kB RAM (JESA 59(4), 2026); an Edge Impulse deployment 99.36 %, 30 ms,
29.3 kB RAM, 69.7 kB flash (ACM GLSVLSI 2025); STM32H743 98.9 %, 19 ms (arXiv
2304.09100, preprint). MLPerf-Tiny-class autoencoders: 128.9 µs / 24.9 µJ
inference-only on an STM32N6 (1.59 ms / 216 µJ with pre/post-processing;
arXiv 2505.15622, preprint); 0.9 ms / 0.18 mJ on an STM32H735 (ST wiki,
vendor). 17.7 mJ is two orders of magnitude above these; "a few millijoules"
is wrong in both directions. The INT8 loss for a bearing 1-D CNN is ≈ 0.5 pp
(snippet-level); ternary/binary drop to 83.6 / 74.2 % from 99.3 %.

**Finding (confidence: high · verified: primary).** `onnxruntime-node` is
actively released (1.30.0 on 14 Sep 2026; core v1.31.0 on 9 Oct 2026) and
ships prebuilt **CPU** binaries for Linux x64/arm64, Windows and macOS; CUDA is
Linux x64 only (CUDA 12; CUDA 11 dropped at v1.22), DirectML Windows only,
CoreML macOS only, WebGPU experimental with no Linux-arm64 prebuilt in the
Node README. KleidiAI Arm kernels arrived in v1.22 (SME2/FP16 in 1.29–1.31).
Quantisation guidance: static S8S8 QDQ is the recommended first choice for
CNNs, dynamic for RNN/Transformer; `reduce_range` is needed with per-channel on
AVX2/AVX512 without VNNI; "Arm-based processors with dot-product instructions
generally perform better" and quantisation "may be slower on older hardware".
Measured: a 104 826-parameter 1-D CNN-Transformer runs **1.98 ms FP32 vs 2.33 ms
INT8 on a Raspberry Pi 4B** (INT8 slower; file −9.5 %), 1.04 ms on an i7-13620H,
0.34 ms on an M4 (Chen et al., Sensors 26(9):2574, 2026); on a Pi 5 static INT8
is 1.65–2.70× faster on seven of nine networks (community benchmark, low
confidence). **`@tensorflow/tfjs-node`** has had no stable release since
**4.22.0 on 21 Oct 2024** (one 4.23.0-rc.0, Jan 2025); the Node 22 prebuilt
issue (#8430) was closed on 23 Jul 2026 without a fix after a maintainer said the
team is "concentrated on other scheduled milestones"; Linux-arm64 prebuilts
were never officially supported; converter uint8/uint16/float16 quantisation is
weight-size compression only; the WASM backend (XNNPACK, SIMD, threads) is the
maintained fallback (2020-era numbers: 10.3 ms vs 893.5 ms plain JS for
MobileNet V2). **Coral**: Google archived `pycoral` on 3 Jul 2025 and
`libedgetpu` on 14 Oct 2025 (last pycoral release 2.0.0, Jul 2021, Python
≤ 3.9); community (feranick) builds cover Python 3.9–3.12 / TF 2.16; the
"Coral NPU" of 15 Oct 2025 is RISC-V NPU *IP* for wearables, not an Edge TPU
successor. Gateway numbers: Pi 5 idle ≈ 2.6 W, Pi 5 + USB TPU ≈ 3.1 W, Jetson
Orin Nano idle ≈ 4.3 W; SSD-MobileNet 93 ms → 10 ms with the TPU on a Pi 5
(arXiv 2409.16808, preprint) — gains are for vision detectors, unproven for
≤ 1 MB PdM models that already run in 1–3 ms on a Pi CPU.

**Finding (confidence: high · verified: primary).** On-device drift cost:
sequential detectors (Page–Hinkley, CUSUM-style, centroid distance) cost a few
operations per feature per sample; a centroid-distance detector on 511-bin fan
vibration spectra used 69 kB on a Pi 4 (vs 619 kB Quant Tree, 1 933 kB SPLL)
and 10.6 ms per sample on a Raspberry Pi Pico (Cortex-M0+, 133 MHz; Yamada &
Matsutani, preprint 2023); ADWIN keeps a logarithmic bucket structure (river
defaults δ = 0.002, clock 32, max_buckets 5) and is measurably heavier; batch
two-sample tests (KS per feature; MMD with permutations, O((N+M)²·d)) belong on
the gateway at window granularity. Model update patterns from 2025–2026
guidance: shadow → canary → A/B, promotion gated by device-health signals
(latency, memory, temperature, confidence collapse), previous model kept on
disk, artefacts signed (OpenSSF Model Signing 1.0 / OMS, sigstore-based), OS
updates on an A/B rootfs (Mender/RAUC) separate from model updates; Greengrass
rolls back at deployment level, Azure IoT Edge documents no module rollback.
Node-RED in peer-reviewed CM systems is the visualisation/rule layer over MQTT
while acquisition, FFT and models run in Python/C on the edge device (Sensors
25(1):180, 2024); the single-threaded event loop is the documented limit, with
worker threads or child processes as the offload path (Node-RED forum).

> **Implication for this toolkit.** `ml-inference` loads ONNX via
> `onnxruntime-node` and TF.js via `@tensorflow/tfjs-node` (both optional
> dependencies; `onnxruntime-node` is held at 1.24.3 in the lockfile, six minor
> versions behind 1.30.0), with a Python sidecar
> (`nodes/python/python_bridge.py`), Coral via
> `nodes/python/coral_inference.py`, a remote inference bridge, an
> MLflow helper, a bundled model catalog and the path allowlist; there is no
> quantisation tooling in the package and no worker threads for FFT or
> inference. Consequences: on Linux arm64 gateways the Node binding is CPU-only
> and Jetson GPUs are reachable only through the Python sidecar — document it;
> prefer ONNX over TF.js in the catalog and point TF.js users to the WASM
> backend where `tfjs-node` cannot build; mark `coral_inference.py` "legacy /
> existing hardware" with a pinned interpreter (3.9 official, or tested feranick
> wheels); recommend FP32 on Cortex-A72 and static S8S8 QDQ with
> `graphOptimizationLevel: "all"` on Cortex-A76/VNNI hosts, with
> `intraOpNumThreads` = cores − 1 so the event loop keeps a core. Implementable
> MLOps subset: content hash + signature check before model load (the allowlist
> is the hook), a shadow mode running incumbent and candidate on the same
> message, promotion gated on agreement/latency over a canary window, and
> automatic revert on load failure. The MCU tier sits upstream of Node-RED
> (features/classes over MQTT); its recalibration-without-retraining pattern
> maps onto the toolkit's baseline/learning-window concept. A measured
> windows-per-second profile of `signal-analyzer` + `ml-inference` on Pi 4/5 and
> an N100 would fill a documented gap — no peer-reviewed study uses Node-RED as
> the inference layer for vibration PdM.

---
## 7. Robustness: concept drift, domain shift, explainability

**Finding (confidence: high · verified: primary).** The single primary source
behind the methods review's drift section (Hinder, Vaquet & Hammer, Frontiers
AI 2024, Part A) argues against the implementation it was cited for. Its
two-sample class contains *loss-based* (autoencoder, OC-SVM, Isolation-Forest
scores), *virtual-classifier* (D3) and *statistical-test* (KS, MMD) sub-types,
and its guidelines read: "it is advisable to use meta or block-based methods";
"When working with high dimensional data, one should avoid using
dimension-wise methodologies, especially if false alarms are costly";
"loss-based strategies should be avoided when the target of the drift
detection is monitoring for anomalous behavior"; and "in unsupervised settings
only virtual drift has to be considered" — a label-free toolkit can only ever
detect p(x) shift. In its experiments DAWIDD is "in second place for all
datasets", global KCpD best but offline, ShapeDD close; "All drift detectors
struggle when confronted with multiple drifts." Part B (Frontiers AI 2024)
adds that detection should be followed by localisation and explanation, and
that "evaluations in the form of user studies will be required". CM-specific
objections: two-sample tests assume i.i.d. samples, which "highly correlated"
live CM data violate (Jourdan, NeurIPS-W 2023); "perceived drift is a product
of windowing", drift detection is "ill-posed", and on 11 real streams batch
retraining pipelines out-rank every detector pipeline (Gower-Winter et al.,
IDA 2026); a sequential RFF-MMD test with logarithmic time and space per
observation exists (Kalinke & Gavioli-Akilagun, NeurIPS 2025, abstract).
Library defaults are tabular-ML defaults, none validated for vibration
features: alibi-detect KS p = 0.05 with Bonferroni (FDR optional), online
detectors calibrated to an expected run time with ≥ 10× ERT bootstraps;
Evidently KS p < 0.05 up to 1 000 reference rows then Wasserstein ≥ 0.1, PSI 0.1,
dataset drift at ≥ 50 % drifting columns; river ADWIN δ = 0.002, Page–Hinkley
λ = 50 / δ = 0.005 / α = 0.9999, KSWIN α = 0.005 (window 100, "very sensitive");
DDM/EDDM need a labelled error stream. PSI is "highly sensitive to batch size"
below ≈ 200 samples (ICLR 2026 workshop poster); the 0.10 / 0.25 PSI constants
are a rule of thumb whose critical values depend on n and bin count.
Complexities per sample range from O(1) (DbDDA) and O(log w) (incremental KS)
to O(w²) (ECHO) (Werner et al., DATA 2024).

**Finding (confidence: high · verified: primary; the decision rule is an
inference).** The CM literature uses "drift" in the opposite sense to the ML
literature — slow signal drift that *is* the incipient fault (Zenisek et al.
2019; Estaji et al., IEEE TII 2025: EWMA better on average, CUSUM for very small
drifts, both "fixed mean drift detectors"; Ricaldi-Morales et al., Sensors 2026:
stator faults detected as *model drift* of a healthy MLP, 1 % incipient faults in
≈ 61 ms). **No 2023–2026 paper offers a statistical test that separates benign
shift from degradation on the feature stream alone**; every working design
adds structure. Kermenov et al. (Sensors 2023) run a concept-drift detector
first (VAE encoder, Mahalanobis score, threshold = baseline × 1.07, "chosen in
an empirical way") and an anomaly detector second — "When no CD is detected,
the change in the data pattern is identified as an anomaly" — on one robot
with one simulated fault; drift = new program, anomaly = 10 % torque step; both
detectors "return to the training stage" after a confirmed drift. Wind-turbine
practice: gearbox false positives were "mostly caused by bearing temperatures
that are gradually rising due to normal wear", motivating trend removal and
periodic retraining (Letzgus, WES 2020; kernel change-points in ≈ ⅓ of 600
signals, F1 0.86); fleet-median subtraction "neutralizes seasonal
fluctuations", normal-behaviour models need ≈ 6 months of 10-min SCADA data,
measured false-positive ratios 0.08–0.12 per signal (Chesterman et al., WES
2023). Every source that auto-updates baselines names the risk: a trigger
designed "to incorporate slow mechanical wear … into an updated baseline …
introduces the risk of masking progressive degradation" (Kim et al., JMSE
2026, snippet); a model trained on an already-degraded machine "may embed these
faulty dynamics" (Ricaldi-Morales, snippet). Retraining policy: with
incremental learning no policy beats no-retrain in 54 paired comparisons;
without it, "simple periodic retraining significantly outperforms both reactive
policies under abrupt and gradual drift", reactive wins only for recurring drift
(Dasari, arXiv 2608.19488, preprint); drift-triggered retraining "achieves
comparable forecasting accuracy to periodic retraining in most cases"
(Poenaru-Olaru et al. 2025, preprint). **Corrected recommendation:** a frozen
healthy baseline is the *degradation* reference and a sliding recent window the
*drift* reference; disambiguate structurally — (1) a logged context event
(regime, recipe, rpm set-point, sensor replacement, work order) coinciding with
the shift → drift candidate; (2) change confined to fault-frequency-anchored
indicators with unchanged broadband RMS → degradation, uniform gain/offset or
a shift in the sensor's resonance region → sensor/mounting (vendor evidence,
low confidence); (3) abrupt step without fault-frequency growth → drift,
monotone trend against the frozen baseline → degradation. Drift alarm →
localise (which features, which regime) → human confirmation → re-baseline or
bring the periodic re-fit forward. Never performance-triggered (no labels),
never automatic.

**Finding (confidence: high · verified: primary).** Domain adaptation often
hurts. On Paderborn artificial → real damage (F1 %, average of three tasks)
source-only scores 39.65 while DIRT-T 20.57, DANN 32.60, CDAN 34.33 and DSAN
34.14 fall *below* it (negative transfer); the proposed online source
selection reaches 60.94, and removing the selection drops it to 39.11 (Wang et
al., arXiv 2405.17493, preprint). On Paderborn motor-current cross-condition
tasks (13 classes) source-only averages 33.78 % (time) / 44.04 % (frequency),
DANN 46.53 / 57.89, calibrated adaptive teacher 54.50 / 64.76, and the
source-only expected calibration error on the target is **58 %** (11 % after
calibration; Forest & Fink, Sensors 2024). CNNs on spectrograms learn "distinct
average frequency profiles" of the rig, "signal features very specific to the
physical properties of the specific test setup" (SKF, PHM 2021, Grad-CAM).
Cross-machine is harder than cross-condition (secondary). Lab-to-field studies
are emulated-noise or single-site. Vibration foundation models give bounded
gains: VibFM (PHME 2026; ≈ 400 h from 16 open datasets, masked-spectrogram
pre-training, Paderborn held out, bearing-level splits) 48.9 % from scratch →
**75.1 % frozen encoder + head → 85.5 % fine-tuned**, healthy-only
reconstruction ROC-AUC 0.893, and the authors note it "does not prove
invariance to frequency response" of a new rig; UniFault (> 6.9 M samples,
preprint) trails ROCKET on Paderborn (79.3 vs 80.1 %) with unclear hold-out.
Frequency-domain inputs beat raw time inputs across all methods (+10 points).

**Finding (confidence: high · verified: primary).** SHAP dominates XAI-for-PdM
(18 of 102 papers; LIME 12; feature importance 10; counterfactuals 1), yet only
≈ 2 of 102 papers involved humans and "the evaluation of the explanations has
not received the same attention as the performance of the algorithm" (Cummins
et al., arXiv 2401.07871, PRISMA preprint). The only controlled technician
experiment (n = 45; Shin et al., Sensors 2024) tested no explanations: the
fault-tree group was 15 % faster than the AI-support group and interface
simplicity drove the difference. On vibration CNNs Grad-CAM, LRP-Z and global
LIME met the correctness criteria "partially … but never completely" (Mey &
Neufeld 2022, preprint); attribution methods rank RUL features differently
(Kundu & Hoque, PHM 2023); the HITL review finds "merely providing explanations
does not ensure user comprehension or trust", explanation design "can both
build and erode trust", and visual explanations aligned with technician
reasoning "such as FFT envelopes" enhance trust (Amaliah et al., Electronics
2025; body statements snippet-level). Evidence-ranked explanation forms for an
alarm: (1) the matched fault frequency, harmonics and sidebands on the envelope
spectrum — checkable against physics; (2) feature contributions with a
stability check over consecutive windows; (3) a similar past case
(practice-driven); (4) counterfactuals, research-stage and "not always
actionable". Regulation: Art. 13 AI Act (accuracy metrics, foreseeable
circumstances, output-explanation capability, oversight measures, logging)
binds only high-risk systems (dates in §5) but is the de-facto template;
ISO/IEC TS 6254:2025 (4 Sep 2025, 69 pp.) gives explainability objectives as
guidance, not certifiable requirements.

> **Implication for this toolkit.** There is no distribution-drift detection
> (no KS, MMD, PSI or ADWIN code); the only "drift" is the CUSUM allowance
> `cusumDrift` (default 0.5, in σ units under the default `cusumMode: "sigma"`),
> which is signal drift in the CM sense, and the README roadmap lists
> "Concept/data-drift monitoring + retraining feedback loop" as open. The
> mechanisms that *can* absorb damage today are the `isolation-forest-anomaly`
> `adaptive` mode (threshold follows the contamination quantile online),
> `pca-anomaly retrainMode` (retrains on normal data unless "off") and the
> operator-feedback adaptive thresholds in `anomaly-detector` (`adaptiveEnabled`,
> learning rate 0.1, minimum 10 feedbacks); none is bounded by a maximum
> change per day, an open-alarm lock or a context event. `regimeProperty` (one
> baseline per operating-point value; it cut false alarms from 21–22 to 0–3 per
> 640 samples on a simulated two-speed pump) implements the regime half of the
> structural rule; the missing half is an event input that gates re-baselining.
> The bundled ONNX/TF.js models are lab-rig models: the catalog should carry
> source-only accuracy and the calibration caveat, classifier outputs should be
> gated by a per-device out-of-distribution score, an ML fault label should
> require agreement from the `signal-analyzer` fault-frequency match before it
> becomes an alarm, and small-target fine-tuning on data from
> `training-data-collector` should be preferred over any cross-machine UDA at
> the gateway. For explanations, `signal-analyzer` already produces form (1);
> per-feature SPE/T² contributions in `pca-anomaly` and path-length (DIFFI-style)
> contributions in `isolation-forest-anomaly` would add form (2) without SHAP's
> cost; "an alarm without a 'why' gets ignored" should be documented as a
> heuristic, not a finding.

---

## 8. Implications for this toolkit

Consolidated and ranked by evidence strength (confirmed-correct = the existing
design is validated; new gap = a missing capability; correction = the existing
documents or code describe something wrongly):

| # | Research finding | Relevance to the toolkit | Status |
| --- | --- | --- | --- |
| 1 | Envelope spectrum is the reference bearing method; leakage-free CNNs do not beat physics (§1) | Envelope + fault-order matching as the primary diagnosis path is right; ML on envelope/order spectra only | confirmed-correct |
| 2 | Order tracking is step one of the reference chain; smearing hides BPFO under speed variation (§1) | No order tracking exists; `msg.rpm` corrects the nominal order, not the smearing | new gap |
| 3 | Cepstrum pre-whitening is the best single preprocessing on hard CWRU records; kurtogram band selection validated by SES line strength (§1) | Fixed 500–5 000 Hz band, no CPW, rectify-and-average envelope | new gap |
| 4 | Sub-PCA/PCA and windowed kNN lead time-series benchmarks; IF mid-table; EIF ≈ IF; LOF weakest (§3) | `pca-anomaly` validated; "EIF + kNN validates the IF design" is wrong; add windowed kNN, not LOF or EIF | correction |
| 5 | `trend-predictor` band omits the covariance term, uses z, is a CI for the mean crossing; 90 % band covers 75–80 % (§4) | Add covariance + t_{n−2}; Fieller interval with "unbounded" flag; optional inverse-Gaussian PI | correction |
| 6 | Weibull conditional RUL ≠ distance to unconditional B90 (§4) | Replace the D → F(t) mapping with age + survival conditioning (conditional quantile or MRL) | correction |
| 7 | Distribution drift must not auto-trigger refresh; meta/block-based detectors preferred; drift ≠ degradation needs a structural rule (§7) | Roadmap drift monitor: context event + two references + human confirmation; bound the three adaptive mechanisms | correction |
| 8 | Point-adjusted F1 is discredited; VUS-PR/AUC-PR plus event-level metrics (§3) | Validation reporting for the PRONOSTIA fixture and test suite | new gap |
| 9 | ISO 13379-1:2025 replaces 2012; ISO 20816 part list; zone values hold; IDTA 02048 exists (§2) | Edition tag on the zone table; prognosis-report fields; `severity` on all anomaly nodes; `DeviceHealthEnumeration` mapping | correction / new gap |
| 10 | EVT/POT thresholds on detector scores; per-feature 3σ gives the most false alarms (§3) | POT option with risk q in `anomaly-detector`; bounded `adaptive` IF mode | new gap |
| 11 | LLM advisory from structured findings is defensible; orchestration and outcome claims are not; Art. 50 from 2 Aug 2026 (§5) | `llm-analyzer` architecture confirmed; add schema validation, grounding check, AI-generated marker, run logging | confirmed-correct / new gap |
| 12 | `tfjs-node` stalled; Coral archived; ORT CPU-only on arm64; INT8 slower on Pi 4 (§6) | Prefer ONNX; WASM fallback; "legacy" Coral; per-host quantisation guidance; update the pinned ORT | correction |
| 13 | HI quality metrics have three "trendability" definitions; no thresholds (§4) | Implement single-run monotonicity, correlation-with-time, robustness; name the definition | new gap |
| 14 | Cost-optimal replacement: age-replacement optimum and the one-step P(RUL ≤ Δt) > C_p/C_f rule (§4) | Closed-form addition on top of the RUL band once the band is calibrated | new gap |
| 15 | UDA often scores below source-only; CNNs learn rig frequency profiles (§7) | Catalog models are lab-rig models: ship source-only accuracy, gate by OOD score, require physics agreement | correction |
| 16 | Excess vs raw kurtosis; CF/kurtosis rise then fall; not "most robust" (§1) | Document the convention; treat falling CF with rising RMS as spreading damage; filtered-signal kurtosis | correction |
| 17 | Explanations are necessary but not sufficient; physics-anchored forms best evidenced (§7) | Keep fault-frequency evidence in alarms; per-feature contributions in PCA/IF nodes | confirmed-correct / new gap |
| 18 | TinyML "88 % / 50 ms / mJ" sentence is wrong (§6) | Documentation correction only; MCU tier is upstream of Node-RED | correction |

**Prioritised next steps.** (1) Fix the `trend-predictor` band (covariance
term, t-quantile, unbounded flag) and re-run `tools/sim/sim-rul.js` until the
90 % band covers ≈ 90 %; replace the Weibull branch with conditional RUL.
(2) Add cepstrum pre-whitening and a kurtogram/SES band scan with the fixed band
as trend mode; switch the envelope to a Hilbert squared envelope; add 2×BSF ±
FTF and slip tolerance to the matcher. (3) Implement computed order tracking
on the envelope from a `msg.rpm` series or tacho times. (4) Add a windowed
kNN/Matrix-Profile detector and emit `severity` from `isolation-forest-anomaly`
and `pca-anomaly`. (5) Build the drift monitor as context event + frozen and
sliding references + localisation + confirmation, and bound the three adaptive
mechanisms. (6) Re-tag the ISO 20816-3 table with the edition, add criterion II
and ALARM/TRIP overrides, add the ISO 13381-1 / IDTA 02048 prognosis fields and
a `DeviceHealthEnumeration` mapping. (7) Harden `llm-analyzer` output
(schema validation, grounding check, AI-generated marker, run log). (8) Switch
validation metrics to VUS-PR/AUC-PR and leave-one-bearing-out. (9) Update the
pinned `onnxruntime-node`, document the arm64/Jetson/Coral/tfjs-node status and
publish a latency profile. (10) Correct the two documents per §9.

---
## 9. Corrections to the existing documents

L = [RESEARCH-cm-pdm-landscape.md](RESEARCH-cm-pdm-landscape.md),
M = [RESEARCH-pdm-cm.md](RESEARCH-pdm-cm.md). Sources are named briefly; URLs
are in the Sources section. "Confidence" is the confidence in the correction.

### 9a. Vibration diagnostics

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| L | §5.2 | "ML pays off when speed and load vary strongly or many fault types overlap." | Learning-based diagnosis is where performance "can drastically decrease under varying working conditions"; bearing-wise Macro-AUROC is 53–62 % for raw/FFT CNN inputs on Paderborn. ML's measured advantage appears with many labelled bearings under *fixed* conditions or when fed envelope spectra; varying speed is the domain of order-tracked envelope analysis. | Latil 2025; Vieira 2026; Zhao 2020; Zhao 2013; Sawalhi 2025 | high |
| L | §6 | "CWRU … Most cited but 'too easy': many methods exceed 99 %." | The > 99 % figures are a leakage artefact of segment-/condition-wise splits (bearing-wise: 62–75 %); expert envelope analysis leaves ≈ 27–38 % of drive-end records not clearly diagnosable and "much of the CWRU data is atypical". Keep "sanity checks only" — because it is unrepresentative, not easy. | Vieira 2026; Smith & Randall 2015 | high |
| L | §3 | "An outer-race defect shows clean BPFO harmonics without sidebands." | Modulation follows the *rotating* race or load: sidebands at the race rotation frequency appear for a fault on whichever race rotates; a rolling-element fault appears at 2×BSF modulated by FTF; outer-race spalls under rotating load show load-modulation sidebands. | B&K BO 0501; Zhao 2013 | high |
| L | §3 | "Kurtosis plus crest factor is one of the most robust early indicators … because both are independent of the absolute level." | Both are level-independent but neither is robust: CF "is not a robust parameter in a statistical sense"; kurtosis fails for extended faults, insufficient bandwidth, carrier-modulated faults and overlapping impulse responses, and both fall back as damage spreads. The robust early indicator is the kurtosis of the pre-whitened/SK band or the SES line strength. | Beckhoff; Randall/Antoni/Gryllias 2016; Randall 2010; Borghesani 2014 | high |
| L | §3 | "kurtosis (impulsiveness, healthy ≈ 3, impact damage well above)" | Correct for raw kurtosis; the toolkit emits **excess** kurtosis (healthy ≈ 0) and its `\|kurtosis\| > 4` rule is a raw-kurtosis-7 threshold. State the convention. | code, `nodes/signal-analyzer.js` lines 302/832 | high |
| L | §3 | "Envelope analysis (HFRT, SPM)" | SPM (shock pulse method) is a proprietary resonant-transducer technique, not envelope analysis of an accelerometer band — check wording. | no source retrieved | low |

### 9b. Standards (14-row errata)

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| L | §2 table, ISO 13379 | "ISO 13379-1/-2 … part 2 specifically for data-driven techniques." | Cite ISO 13379-1:2025 (Ed. 2; 2012 withdrawn) and ISO 13379-2:2015 (ISO/CD 13379-2 in progress). Data-driven method descriptions sit in informative Annex E of 13379-1:2025; Clause 4 adds a recommended procedure; 7.5 covers confidence-factor determination. | iso.org 88027, 88028; FDIS sample | high |
| L | §2 table, ISO 20816 | "ISO 20816-1…9 … (replaces ISO 10816 / ISO 7919)" | Published parts: 1 (2016), 2 (2017, Amd 1:2024), 3 (2022), 4, 5, 8 (2018), 9 (2020), 21 (2025); no part 6; part 7 at AWI (Jan 2026). ISO 10816-6:1995 and 10816-7:2009 remain in force and are referenced from ISO 20816-3's scope. ISO/FDIS 20816-3 Ed. 2 is in approval. | ISO 20816-3:2022 sample; iso.org 92744, 84280, 89922 | high |
| L | §2 table, ISO 20816 | "The only normatively justified absolute limit values." | Soften: the standard calls its numbers "guidelines based on worldwide machine experience" to be "applied with due regard to specific machine features"; ALARM/TRIP are set per 6.5. | ISO 20816-3:2022 §1, TOC | high |
| L | §2 table, ISO 13374 | "Basis of MIMOSA OSA-CBM." | Reverse: OSA-CBM was "the main input for ISO 13374" and is "an implementation of the ISO-13374 functional specification"; it predates ISO 13374-1:2003 and was last released as 3.3.1 in 2010. | MIMOSA OSA-CBM page; What is MIMOSA v1.1 | high |
| L | §2 table, ISO 13374 | "Practically every CM software architecture follows this scheme." | Add editions (-1:2003, -2:2007 confirmed 2021, -3:2012, -4:2015 under review). "Every architecture follows it" is opinion — no vendor conformance statement found; keep as "widely used as a vocabulary". | iso.org 36645, 37611, 54933; vendor search | high |
| L | §2 table, ISO 13381-1 | "ISO 13381-1:2025 … New edition 2025 (replaces 2015)." | **Confirmed.** Add: Ed. 3, 2025-09, 23 pp., title now "General guidelines **and requirements**"; 2015 withdrawn 2025-09-02; defined terms include ETTF and predictive horizon. | iso.org 88029; DIN; 2015 sample | high |
| L | §2 "ISO 20816: vibration zones" | "rates broadband vibration velocity (RMS, typically 10–1 000 Hz)" | Precise: "flat response over … at least 10 Hz to 1 000 Hz; for machines with speeds approaching or below 600 r/min, the lower limit … shall not be greater than 2 Hz" (§4.3); ISO 20816-1 notes the band "might not meet the requirements of a condition monitoring scheme". | ISO 20816-3:2022 and 20816-1:2016 samples | high |
| L | §2 zone table | "Group 1 (large machines, 300 kW – 50 MW)" / "Group 2 (medium machines, 15 – 300 kW)" | Add the shaft-height criterion (Group 1 also H ≥ 315 mm; Group 2 160 mm ≤ H < 315 mm). Values verified against three secondary reproductions; unchanged from ISO 10816-3:2009. | Fabrico; ToolGrit; travail-industrie; Amd 1:2017 sample | high (secondary) |
| L | §2 zone-table caption | "guide values per ISO 20816-3 as reported in secondary sources. The values of the current edition … are binding" | Name the edition (ISO 20816-3:2022, Annex A normative, Tables A.1 rigid / A.2 flexible per secondary sources), note the pending second edition; "binding" overstates — the standard itself says guideline values. | as above | high |
| L | §2 table, ISO 13373 | "ISO 13373-1…9 … part 3 (diagnosis), part 9 (electric motors)" | Published parts 1, 2, 3, 4, 5, 7, 9, **10 (2024, generators)**; part 8 (pumps) at AWI; no part 6. | iso.org 82072, 78145 | high |
| L | §2 table, ISO 18436 | "ISO 18436-1…8" | Part 3 re-issued 2025 (Ed. 3); parts 2 and 8 at FDIS; ISO/DIS 18436-10 in development. | iso.org 88263, 88030, 88265, 88264 | high |
| L | §2 table, EN 13306 / ISO 55000 | "EN 13306:2017"; "ISO 55000/55001" | EN 13306:2017 current but at stage 90.92 "to be revised" (Aug 2025); ISO 55000:2024 and ISO 55001:2024 (Ed. 2, July 2024). | genorma; iso.org 83054 | high |
| L | §4 "Where the blocks run" | "Transport is mostly MQTT (Sparkplug B …)"; "The Asset Administration Shell … is still rarely in production in a CM context" | Sparkplug B is Sparkplug 3.0 = ISO/IEC 20237:2023; IDTA has published a Predictive Maintenance submodel (02048, June 2025) and Time Series Data (02008 v1.1) — there is now something to conform to. | iso.org 86204; IDTA 02048 PDF | high |
| M | Caveat 4 / Open question 1 | "ISO 10816/20816 severity zones" | Replace with "ISO 20816-3:2022 (ISO 10816-3 withdrawn)". ISO 13374 is an SC 5 standard, ISO 20816 an SC 2 standard. L §4's "six functional blocks" is correct (OSA-CBM: "six (previously seven)", the seventh being Presentation, now ISO 13374-4). | Sheppard 2018; ISO 20816-3:2022 sample | high |

### 9c. Anomaly detection

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| M | TL;DR, §2 | "a two-algorithm toolbox suffices — Extended Isolation Forest for global anomalies, kNN for local — which directly validates an Isolation-Forest-plus-distance-based design like this toolkit's." | The JMLR result is correctly quoted but does not replicate on time series: TSB-AD IForest VUS-PR 0.30 (U) / 0.20 (M), EIF 0.21 (M) vs Sub-PCA 0.42, PCA 0.31, KMeansAD 0.37/0.29, Matrix-Profile kNN 0.44/0.35; TimeEval and TSB-UAD find no winner. What transfers is kNN on subsequences; what validates the toolkit is its PCA/SPE detector. Open question 2 is thereby answered: PCA/Mahalanobis-type and OC-SVM rank at or above IF; EIF does not. | TSB-AD 2024; MMPAD 2026; TimeEval 2022; Zaidi 2026 | high |
| M | implications table, row 1 | "Consider a kNN/local-density detector to cover local anomalies." | A local-density detector (LOF) is the weakest classical option on time series (0.17/0.14; F1 0.79 vs 0.998 on CWRU); add a windowed kNN / Matrix-Profile distance to a healthy bank instead. | TSB-AD 2024; Neupane 2024 | high |
| M | Caveat 2 | "Its 'largest comparison to date' is an author claim (contestable vs ADBench, NeurIPS 2022)." | ADBench is 30 algorithms × 57 datasets, Bouman et al. 33 × 52 — larger in algorithms, smaller in datasets; ADBench's headline is that no unsupervised algorithm is statistically better and DeepSVDD/DAGMM are worse than shallow methods. | ADBench 2022 | high |
| L | §9 "Time-series foundation models" | "known weaknesses are strongly seasonal patterns and unclear pretraining-data provenance" | Provenance is confirmed and quantifiable (MOMENT 0.38 → 0.12 VUS-PR on held-out data; ≈ 7 % of benchmark datasets uncontaminated). The "strongly seasonal patterns" clause is unsupported by any source found; a 2026 preprint states the opposite. "Chronos-2 (Amazon, October 2025)" is confirmed (17 Oct 2025 arXiv; 20 Oct 2025 README). | TSB-AD App. D.3; Meyer 2025; arXiv 2605.24381; Chronos README | high / medium |
| L | §5.1 table, TSFM row | "early studies show mixed anomaly results" | Sharpen: zero-shot Chronos/TimesFM/Lag-Llama score VUS-PR 0.27–0.30 on TSB-AD-U (below IForest 0.30, far below Sub-PCA 0.42); a moving-variance baseline beats them on MSL/SMD/SMAP; MOMENT loses to TCN-AE/IF on C-MAPSS and OC-SVM on MIMII — "generally inferior except on point anomalies". | TSB-AD; TimeRCD 2026; Wen & Chen 2026 | high |
| L | Sources | "Are Time Series Foundation Models good for Energy Anomaly Detection? (ACM e-Energy 2025)" | Correct identifier, but the paper compares only TimeGPT and MOMENT (no Chronos/TimesFM) and a from-scratch VAE beats both; snippet-verified only (ACM 403). | Hela et al. 2025 | medium |
| L | §5.1 table, z-score row | weaknesses: "Baseline drift; load changes create false alarms" | Add: per-feature Gaussian 3σ limits on vibration features gave the highest false-alarm rate (38 %) in the only direct comparison; apply σ-rules to detector scores or use POT/GEV thresholds. | Górski 2021; Siffer 2017; MSSP 139:106417 | high |

### 9d. Prognostics and RUL

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| M | §3c | "The `trend-predictor` already exposes RUL **confidence intervals** — this aligns with the literature's prescription." | The node emits a delta-method *confidence interval for the mean crossing time* (z-based, omitting the level–slope covariance, no process noise); the 2023–2026 prescription is intervals with verified coverage (PICP vs nominal) and, for extrapolated crossings, Fieller-type intervals that become unbounded when the slope is insignificant or process-model (inverse-Gaussian) RUL distributions. | Franz 2007; Javanmardi 2023; Robinson 2026; Yan 2026; code | high |
| L | §10 PA | "`trend-predictor` emits `rul`, `rulLower` and `rulUpper` for linear, exponential and Weibull models." | Qualified: the Weibull branch maps D = level/threshold to F(t_eq) = D and reports η(ln 10)^{1/β} − t_eq (distance to the *unconditional* B90 age); the literature's Weibull RUL is the conditional quantile η[(t/η)^β + ln 10]^{1/β} − t or MRL(t). No source supports the D → F(t) mapping. | ReliaWiki; NIST; derived; code | high |
| L | §5.3, Sources | "Integrating ML-Based RUL Predictions with Cost-Optimal Block Replacement (IJPHM)" | Complete: Choo & Shin (2025), IJPHM 16(1), DOI 10.36001/ijphm.2025.v16i1.4242 — XGBoost RUL on FD001/FD003 (RMSE 17.86 / 20.69), Weibull MLE on predicted failure times, age and minimal-repair block replacement with assumed costs, t_p* = 186.68 cycles. The §5.3 "balance" sentence is supported. | Choo & Shin 2025 | high |
| M | §3a | "On C-MAPSS: LSTM RMSE ≈ 14.2–14.93 vs 1D-CNN ≈ 15.68–16.97." | Comparable only with the same subset, cap (125 / 130 / none), window and normalisation fit scope (per-condition normalisation alone shifts FD004 RMSE by −7.4). Report with the convention or not at all. | Gupta 2026; arXiv 2610.04278 | high |
| M | §3b | "measured by monotonicity, trendability, and prognosability" | Extend: the bearing literature uses monotonicity, correlation-with-time ("trendability") and robustness with a hybrid mean; "trendability" has three incompatible definitions (Coble 2009, MathWorks, bearing literature) — state which is implemented. | Coble & Hines 2009; MathWorks; Sun 2025; Tefera 2025 | high |
| L | §6 PRONOSTIA | "3 operating points (1 800 / 1 650 / 1 500 rpm)" | Flagged, not corrected: Tefera et al. 2025 list condition 3 as 1 300 rpm / 4 500 N; the primary (Nectoux 2012) was bot-blocked. Keep 1 500 rpm until checked. | Tefera 2025 | low |

### 9e. LLM agents

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| L | §9 | "The PHMForge benchmark (2026) with 99 scenarios and 39 MCP tools shows frontier models reaching roughly 81 % pass@1" | Correct for arXiv 2604.01532 **v3 (24 Aug 2026)**; v1 (2 Apr 2026) reported 75 scenarios, 65 tools and a 68 % peak. 80.8 % is one configuration (Claude Code + Claude Opus 4.6); next best 64.6 %; open-weight 36–80 % on a 25-scenario subset. Preprint by the tool builders (Columbia / Georgia Tech / IBM), no independent replication. | PHMForge v1/v3 | high |
| L | §9 | "replacing the tools with pure text retrieval drops RUL accuracy on battery scenarios from 100 % to 20 %" | The metric is pass-all-3 on 5 lithium-ion RUL scenarios (5/5 → 1/5); mean pass@1 drops 80.6 → 48.6 % and 91.7 → 73.6 %; the ablation covers only the battery class. | PHMForge v3 | high |
| L | §9 | "The remaining failures are planning errors (when to call which tool), not invocation errors." | Overstated: orchestration errors *dominate* (23 % incorrect sequencing), but schema-invalid calls, array truncation (Mistral-Medium 0 % on RUL), 64 % semantic-brittleness distractor failures and 18–23 % data-discovery errors are reported too. | PHMForge v3 | high |
| L | §9 | "'Predictive Maintenance MCP' as an open server with spectral, envelope and anomaly tools" | Add: single-author proof-of-concept (Di Maggio, Politecnico di Torino; Applied Sciences 16(6):2812, 15 Mar 2026), MIT-licensed, self-reported README benchmark only (34/44 = 77.3 % top-1 on an easy CWRU subset; 2 of 4 healthy baselines flagged). | Semantic Scholar; README | high |
| L | §9, §5.4 | "LLM agents for cleaning maintenance logs"; "LLM agents are now used to clean such logs" | Demonstrated on **synthetic** logs with injected noise (PHMAP 2025): generic noise handled (≥ 92 % out-of-fleet rejection), domain errors not (0 % on wrong end dates for all six models; identifier misalignment ≤ 27.7 %); GPT-5 $5.86 and 11 051 s per experiment. | Dimidov 2025 | high |
| L | §9 | "agentic systems moving from prediction to prescription" (PHME source) | PHME **2024** (Cranfield; GPT-4 + top-5 RAG on a linear-actuator rig); scores only fault classification (85.36 % vs 83.04 %); prescriptive output is unscored example text. | Deng 2024 | high |
| L | §9 "Further lines" | "Regulation: EU AI Act (high-risk classification only for safety components)" | Outdated: Regulation (EU) 2026/1744 (in force 27 Jul 2026) deferred Annex III to 2 Dec 2027 and Annex I to 2 Aug 2028 and narrowed "safety component"; Art. 50 transparency applies from 2 Aug 2026 regardless; Annex III pt 2 (critical-infrastructure safety components) is the relevant route; Machinery Regulation 2023/1230 applies from 14 Jan 2027 with ML "self-evolving" safety components under third-party assessment. | EUR-Lex 2026/1744; 2023/1230; Art. 50 | high |
| L | §10 AG | "The research says clearly that value arises when the LLM receives structured findings … as tool outputs" | Supported for benchmark pass rates (PHMForge ablation) and an OEM case library (RAG +2 points), but no evidence that this improves actual maintenance decisions; the only human-bar comparison had ChatGPT at 67 % vs an 80 % pass mark. Write "benchmark evidence". | Lukens 2023, 2024 | high |
| M | Open question 4 | "Maturity/reliability of LLMs for actual maintenance decisions … (independent replication?)" | Answered: no independent replication of any LLM-for-maintenance result exists; the peer-reviewed evidence is self-evaluation by the proposing groups, mostly with LLM judges; maturity = "information/decision-support draft". | §5 synthesis | high |

### 9f. Edge deployment

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| L | §4 "Where the blocks run" | "TinyML models on microcontrollers now classify bearing states at roughly 88 % accuracy in under 50 ms and a few millijoules per inference." | Two papers conflated: Gao et al. (2025) — 88.28 %, 45 ms, **17.7 mJ on an ESP32-S3** (not Cortex-M), proprietary data, transfer learning; Garay et al. (Sensors 2026) — INT8 autoencoder *anomaly detection* on a Cortex-M4F, F1 0.98, 254 µs, 6 kB flash. Published Cortex-M bearing classifiers reach 98–99 % at 5–30 ms; MLPerf-Tiny autoencoders 0.1–1 ms, 20–200 µJ. | Crossref; S2; JESA 2026; GLSVLSI 2025; arXiv 2505.15622 | high (identifiers) / medium (Springer numbers) |
| M | Sources | "Springer s11431-025-3072-9; MDPI Applied Sciences 16(5):2493 — frontier/digital-twin" | The Springer paper is a TinyML bearing-diagnosis paper, not a digital-twin paper. | Crossref | high |
| L | §4 "Where the blocks run" | "Gateway / plant PC (SD, HA, PA): Node-RED, Python sidecars, ONNX runtime." | `onnxruntime-node` ships prebuilt CPU binaries for Linux arm64, so Raspberry-Pi-class boards are a supported host too — CPU-only; CUDA is Linux x64 only. | ORT js/node README | high |

### 9g. Drift, domain shift, explainability

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| M | §4c | "Unsupervised detectors fall into two-sample (KS test, MMD), meta-statistic (ADWIN, ShapeDD), and block-based (DAWIDD, KCpD) strategies" | Incomplete: the two-sample class also contains loss-based (AE, OC-SVM, IF scores) and virtual-classifier (D3) sub-types; the survey recommends meta-/block-based over two-sample tests and warns against loss-based detection when monitoring for anomalies. | Hinder 2024 Part A | high |
| M | §4c | "A genuine drift monitor should run two-sample tests (KS / MMD) on feature distributions (live window vs training baseline) to trigger ONNX/TFJS model refresh." | Three corrections: the survey prefers meta-/block-based detectors and says feature-wise tests in high dimension cause false alarms; KS/MMD assume i.i.d. samples, which CM streams violate; a drift alarm must not trigger refresh automatically — degradation also shifts the distribution, auto-updated baselines mask it, the only CM design with a rule runs a context-change detector first, and periodic retraining is a strong baseline reactive triggers rarely beat. | Hinder 2024; Jourdan 2023; Kim 2026; Ricaldi-Morales 2026; Kermenov 2023; Gower-Winter 2026; Dasari 2026 | high |
| M | §4c "Scope" | "real drift (conditional p(y\|x) change) vs virtual/data drift (marginal p(x) change)" | Correct; add the consequence "in unsupervised settings only virtual drift has to be considered" — a label-free toolkit can only detect virtual drift. | Hinder 2024 | high |
| M | Caveat 6 | "Concept-drift finding rests on a single (strong, peer-reviewed) primary source." | Now corroborated and extended by Hinder Part B 2024, Lukats (IJDSA 2024), Cerqueira (KDD 2026), Gower-Winter (IDA 2026), Jourdan (NeurIPS-W 2023), Estaji (TII 2025). | as named | high |
| M | §4c toolkit note | "The CUSUM `drift` parameter in `anomaly-detector` is process drift in the signal, not distribution drift." | Correct (`cusumDrift` default 0.5 σ). Add: the CM literature itself uses "drift" in the signal sense (Zenisek 2019, Estaji 2025, Ricaldi-Morales 2026), so the docs must define *signal drift* vs *distribution drift* vs *degradation*. | Zenisek 2019; Estaji 2025; code | high |
| L | §5.4 | "Explainability decides acceptance by the maintainer. An alarm without a 'why' gets ignored." | Overstated: "merely providing explanations does not ensure user comprehension or trust"; explanation design "can both build and erode trust"; only ≈ 2 of 102 XPM papers involved humans; the one controlled technician experiment tested no explanations and found interface design dominated. Reword: necessary but not sufficient; form decides. | Amaliah 2025; Cummins 2024; Shin 2024 | high |
| L | §5.2 | "often with transfer learning from test-rig data (CWRU, Paderborn) to the target machine." | Add: standard UDA (DANN, CDAN, DDC, DSAN) scored below source-only on Paderborn artificial → real; source-only cross-condition accuracy is 34–44 % with ECE ≈ 58 %; CNNs learn rig frequency-response profiles; lab-to-field studies are emulated or single-site. Test-rig transfer is a research route, not an evidenced deployment route. | Wang 2024; Forest & Fink 2024; SKF 2021; Iunusova 2025 | high |
| L | §5.4 | "Concept drift from recipe changes, seasons and repairs: baselines must be re-tracked without 'learning in' the damage itself." | Supported and now sourced; nuance: wind-turbine practice removes seasons by fleet-median subtraction and treats slow wear as drift to retrain away because its objective differs from this toolkit's. | Kim 2026; Letzgus 2020; Chesterman 2023; Kermenov 2023 | high |
| L | §5.1 table, CUSUM/EWMA row | "Parameters (k, h) must match the signal statistics" | Consistent with Estaji et al. 2025 (EWMA better on average, CUSUM for very small drifts, both "fixed mean drift detectors"). | Estaji 2025 | high |
| L | §10 | "Open: concept-drift monitoring" | Still open; the code has no KS/MMD/PSI/ADWIN and the `adaptive` IF mode, `pca-anomaly retrainMode` and operator-feedback thresholds are unbounded baseline-update paths. | code facts | high |

### 9h. Landscape fact-check (market, adoption, datasets, regulation, Sources)

| Document | Section | Sentence as written | Corrected statement | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| L | §7 Benefit, TL;DR 4 | "Maintenance cost reduction 10–40 % (Deloitte, PwC)" | Deloitte: "reduce overall maintenance costs by 5–10 percent"; its DE position paper repeats 5–10 % (intro says 25 %, unsourced); PwC/Mainnovation 2018: average 12 % among firms targeting cost. "10–40 %" appears verbatim and unsourced on Mordor's page and is widely attributed to McKinsey MGI 2015 (primary unreachable). | Deloitte Insights 2017; Deloitte DE paper; consultancy.nl; Mordor | high that Deloitte does not say it; low for McKinsey |
| L | §7 Benefit, TL;DR 4 | "Reduction of unplanned downtime 20–50 % (Deloitte …)" | Deloitte's 20–50 % is *maintenance planning time*: "reduce the time required to plan maintenance by 20–50 percent, increase equipment uptime and availability by 10–20 percent, and reduce overall maintenance costs by 5–10 percent". A "reduce downtime by 50 percent" figure is McKinsey MGI 2015 (snippet only). | Deloitte Insights 2017 | high |
| L | §7 Benefit | "up to 70–90 % at high maturity (Mordor)" | Mordor says "unplanned-downtime cuts of 70–90 %" with no maturity qualifier and no source; drop "at high maturity". | Mordor | high |
| L | §7 Benefit | "Extended asset life 10–20 % (Industry studies)" | No source; nearest: PwC/Mainnovation 2018 +20 % among firms targeting lifetime extension. Cite PwC "≈ 20 %" or remove. | consultancy.nl | low |
| L | §7 Market | "MarketsandMarkets ≈ 14–18 bn (2026), CAGR 34 %, target 2031" | M&M (Mar 2026): USD 13.89 bn (2026) → 23.79 bn (2031), CAGR 11.4 %. The 34 % CAGR is Mordor's. | M&M | high |
| L | §7 Market | "Grand View Research ≈ 15 bn (2026), 28 %, USD 98 bn by 2033" | GVR: USD 14.2 bn (2025), 17.5 bn (2026) → 98.1 bn (2033), CAGR 27.9 %. | GVR | high |
| L | §7 Market | "Mordor Intelligence 15.3 bn (2026), 29 %, USD 42 bn by 2030" | Mordor: USD 14.09 bn (2025), 18.9 bn (2026) → 82.17 bn (2031), CAGR 34.14 %. The 15.3 / 29 % / 42 bn-by-2030 triple is Research and Markets (TBRC). | Mordor | high |
| L | §7 Market | "Precedence Research ≈ 16 bn (2026), 22 %, USD 97 bn by 2035" | Precedence (page updated 1 Oct 2026): USD 9.21 bn (2025), 11.70 bn (2026) → 94.27 bn (2035), CAGR 26.19 %. | Precedence | high (today's page) |
| L | §7 Market | "Research and Markets ≈ 20 bn (2026), 11 %, USD 24 bn by 2031" | Report 5767408 (TBRC, Feb 2026): USD 11.82 bn (2025) → 15.29 bn (2026, CAGR 29.4 %) → 41.87 bn (2030). The 11 % / 24 bn / 2031 triple is MarketsandMarkets'. | R&M | high |
| L | §7 Maturity | Level names "Visual inspection / Instrumented inspection / Real-time CM / PdM 4.0" | Four levels and "Predictive Maintenance 4.0" confirmed; the exact PwC labels for levels 1–3 could not be read (pwc.be/pwc.de block automated access). | consultancy.nl | medium |
| L | §7 Adoption | "Preventive maintenance as primary strategy 71 %" | "71 % of organizations cite preventive maintenance as part of their strategy"; < 35 % allocate most of their time to it; 58 % spend more than half their time reacting. Not "primary". | MaintainX 2025 report, press release | high |
| L | §7 Adoption | "Plan to adopt AI within 12 months 65 %" | "65 % of organizations expect to implement AI-powered maintenance solutions by 2026". Use "by 2026". | MaintainX press release | high |
| L | §7 Adoption | "per a 2024 VDMA survey, over 60 % of mid-sized machine builders see intelligent maintenance as one of the most important digitalisation levers" | Not found. VDMA's 2025 AI survey (quoted in the April 2026 position paper): > 80 % attribute medium-to-high strategic importance to AI; 43 % already use AI, a further 48 % plan to by 2028; 45 % name missing personnel and 42 % poor data quality as hurdles. | VDMA position paper | low |
| L | §7 Adoption | VDMA position paper "names data integration, missing standards, interoperability and employee acceptance as the central barriers" | The paper (PDF created 15 Apr 2026) names data availability, data quality, interoperability between heterogeneous systems, integration into existing production/IT and organisational challenges; "missing standards" and "employee acceptance" are not stated as barriers (standards such as OPC UA appear as enablers). | VDMA position paper | high |
| L | §7 Adoption, Sources | "Fraunhofer ISI (2024): only 13 % of machine-building firms used AI in their own production" | Confirmed via the VDMA paper ("erst 13 Prozent … und planten weitere 10 Prozent bis 2025"); the Fraunhofer ISI primary was not reached, and the Sources list cites a Fraunhofer **IML** service page with no statistics — wrong institute/URL. | VDMA paper; IML page | medium |
| L | §8 Barriers | "Budget (25 % name it first)", "Skills (24 %)", "Cybersecurity (22 %)" | These are MaintainX 2025 figures for *barriers to AI adoption* (budget constraints 25 %, lack of expertise 24 %, cybersecurity concerns 22 %), not general PdM barriers; the report's "top maintenance challenges" are lack of resources 45 %, aging infrastructure 33 %, skilled-labour shortage 30 %. | MaintainX blog, report page | medium |
| L | §6 Datasets | "CWRU … seeded bearing faults (inner, outer, ball, 3 sizes)" | 12 kHz drive-end table: 0.007", 0.014", 0.021", 0.028" (4 sizes); apparatus page: 7, 14, 21, 28 and 40 mils (5 sizes). Rest of the row holds. | CWRU apparatus / 12k DE pages | high |
| L | §6 Datasets | "Microsoft Azure PdM … 100 machines, 1 year" | Microsoft's Predictive Maintenance Modelling Guide data: 1 000 machines, 8 761 000 hourly rows, 1 Jan 2015 – 1 Jan 2016; the 100-machine variant is the Kaggle re-upload (unverified). State "100 (Kaggle) or 1 000 (Microsoft), calendar year 2015". | Microsoft repo | high / low |
| L | §9 Regulation | "EU AI Act (high-risk classification only for safety components)" | High-risk = Annex I (safety components of products under harmonisation law) *and* Annex III use cases. Dates: in force 1 Aug 2024; prohibitions 2 Feb 2025; GPAI 2 Aug 2025; general application 2 Aug 2026; Annex III extended to 2 Dec 2027 and Annex I to 2 Aug 2028 by the AI Omnibus (proposal 19 Nov 2025, agreement 7 May 2026, in force 27 Jul 2026). | EC regulatory framework page; AI Act timeline | high |
| L | §9 Regulation | "Cyber Resilience Act for connected products" | Add dates: Reg. (EU) 2024/2847 in force 10 Dec 2024; reporting obligations from 11 Sep 2026; main obligations from 11 Dec 2027. | EC CRA page | high |
| L | §9 Regulation | "NIS2 for operators" | Add dates: Directive (EU) 2022/2555 in force Jan 2023; transposition deadline 17 Oct 2024; NIS1 repealed 18 Oct 2024. | EC NIS2 page | high |
| L | §9 Trends | "TimesFM (Google) and Moirai (Salesforce)" (no versions) | TimesFM 2.5 (15 Sep 2025, 200 M) and **TimesFM 3.0 (Aug 2026)**; Moirai latest Moirai-2.0-R-small (Aug 2025; Moirai-MoE Oct 2024). | TimesFM README; uni2ts README | high |
| L | Sources | "Deloitte Insights, Industry 4.0 and predictive technologies for asset maintenance" | Actual title: "Making maintenance smarter: Predictive maintenance and the digital supply network", Deuel et al., 9 May 2017. | Deloitte Insights | high |
| L | Sources | "MaintainX, 25 Maintenance Stats, Trends and Insights for 2026" | Blog "25 maintenance stats you need for 2026", published 17 Oct 2025, relaying the **2025** report (1 320 respondents); a separate 2026 edition (2 234 respondents; 64 % PM programme; 58 % already use AI) has different metrics. | MaintainX blog; 2026 report page | high |
| L | Sources | "Fraunhofer IML, Predictive Maintenance" (under market/adoption) | Service page with no statistics; the 13 % figure is Fraunhofer ISI via VDMA. | IML page | high |
| L | Sources | "Multimodal TinyML-Based PdM Architecture for IIoT (Sensors 2026)" | Title truncated: "A Multimodal TinyML-Based Predictive Maintenance Architecture for Industrial IoT in the 6G Era", Garay et al., Sensors 26(14):4536, 17 Jul 2026. | Crossref | high |
| L | Sources | PHME 4114 and IJPHM 2236 entries (no years) | PHME 4114 is 2024 (Vol 8 No 1); IJPHM 2236 is Ramasso & Saxena 2014. | PHM Society pages | high |
| — | (not in L; asked for) | Machinery Regulation application date "20 January 2027" | Regulation (EU) 2023/1230, Art. 54: "It shall apply from **14 January 2027**"; Directive 2006/42/EC repealed with effect from 14 January 2027. | EUR-Lex | high |

**Confirmed as written.** Siemens True Cost of Downtime 2024 (USD 253 m per
large plant and year; USD 2.3 m per hour in automotive; 25 incidents a month,
326 h a year — primary PDF; the figures travelled via the MaintainX blog but
match). PwC/Mainnovation 2018 headline (268 firms in NL/BE/DE; ≤ 11 % at
level 4; uptime the most-cited goal — via consultancy.nl, PwC primary blocked).
MaintainX 2025: PdM 27 % (30 % in 2024), reactive 38 %, AI implemented 32 %,
pilot/evaluating 26 %. Deloitte uptime gain 10–20 %. Chronos-2 date and
publisher. The DT-driven PdM systematic review (arXiv 2509.24443). ISO
13381-1:2025. The ISO 20816-3 zone values (secondary-verified). The four
bearing fault-frequency formulas. Dataset rows for IMS, C-MAPSS, N-CMAPSS,
Paderborn (32 experiments: 6 healthy, 12 artificial, 14 real; 64 kHz), MFPT
(the original mfpt.org page now redirects without the data), AI4I 2020. Every
arXiv/DOI identifier in the landscape Sources list resolves to the described
paper. The methods review's JMLR quotation, its concept-drift taxonomy and its
refuted-claims list stand.

**Unverifiable.** The "VDMA 2024 survey, > 60 %" claim (no such publication
found); "extended asset life 10–20 % (industry studies)"; the §8 heuristic
"5–10 % of assets causing 80 % of downtime cost"; ResearchGate 393022844 and
331822028 (403); the PwC Germany PDF (Akamai 403 — existence unknown); the
German NIS2 transposition date; the McKinsey MGI 2015 primary text; the
Fraunhofer ISI 2024 primary publication; ISO 20816-3:2022 Annex A numbers
(paid); the ISO 13381-1:2025 clause changes; PRONOSTIA condition 3; the
Springer TinyML abstract (IdP redirect); the methods review's source
"ScienceDirect S0952197623004967 — anomaly/drift" (paywalled, content unknown).

---
## Caveats

1. **Paywalled primaries.** ScienceDirect, MDPI, Springer, Wiley, IEEE, ACM,
   iso.org, HAL, ResearchGate, PwC and McKinsey pages returned HTTP 403, bot
   challenges or time-outs throughout; where a paper lives only there, numbers
   come from abstracts (Europe PMC, Semantic Scholar, Crossref), author
   repositories or snippets and are tagged *secondary*. iTeh sample PDFs
   (forewords, scopes, tables of contents) were read for the ISO standards.
2. **ISO 20816-3 Annex A is secondary-only.** The zone values rest on three
   concordant secondary reproductions, a vendor article citing the 2022
   edition for one pair, and the primary foreword's "merged and editorially
   revised"; no tier-1 vendor application note (SKF, HBK, Pruftechnik) was
   reached, and the FDIS second edition is unread.
3. **Preprint risk.** MMPAD, TimeRCD, TAB, Wen & Chen, Meyer, Lyu, PHMForge,
   Trajel, ORCA, Tamba, Shamim, Gupta (engrXiv), Yan (Zenodo), Koutas &
   Straub, Dasari, Poenaru-Olaru, Wang (OSAA), UniFault, Cummins, Mey &
   Neufeld, Bartoli, Liao and the Pi/Jetson benchmark are not peer-reviewed;
   several are self-evaluations by the proposing groups. Vieira et al. is
   "in press" at MSSP and was read from the arXiv HTML.
4. **Benchmark-domain caveats.** TSB-AD, TimeEval and TSB-UAD are general
   time-series archives, not vibration data; the vibration-specific
   comparisons (Neupane, Zaidi, Dai, Cui, Górski) use different features,
   protocols and metrics and cannot be pooled into one ranking. The Smith &
   Randall counts are my own tally from a transcript (±2 records). C-MAPSS,
   PRONOSTIA, XJTU-SY and IMS are test-rig or simulation data; nothing here
   is field-validated.
5. **Search quota.** Every researcher hit the web-search and fetch budget
   before finishing; the vibration lead-time question, the KS/GEV
   false-alarm comparison on bearing indicators, a 2023–2026 Weibull-PHM
   paper, the Pi 5 / Orin Nano / N100 same-model comparison and the official
   BFCL per-model scores were not reached. Absence of evidence is reported as
   such, not as evidence of absence.
6. **Derived formulas.** The delta-method covariance term, the Fieller mapping
   to the HI crossing time, the conditional Weibull quantile/MRL, the Wiener
   inverse-Gaussian parametrisation, the Weibull block-replacement closed
   form and the order-smearing threshold are derivations from verified
   definitions, not quotations.
7. **Regulatory text.** Regulation (EU) 2026/1744 was read in two windows;
   the "user assistance / performance optimisation" exclusion wording comes
   from law-firm summaries. Whether an LLM counts as "self-evolving" under the
   Machinery Regulation has no guidance document.

---

## Open questions

1. Envelope-vs-RMS/FFT detection lead time in hours or % of life on
   XJTU-SY/PRONOSTIA/IMS from a 2023–2026 peer-reviewed study — none found.
2. A head-to-head of fixed band vs kurtogram vs autogram vs SES-validated
   scan on non-CWRU data with detection rates; typical band widths in
   current practice.
3. Whether ISO/FDIS 20816-3 (Ed. 2) changes any group definition or zone
   value; the "shall" items added by ISO 13381-1:2025; ISO 17359 §8.10 and
   ISO 13379-1:2025 re-baselining guidance after overhaul.
4. IF vs EIF vs windowed kNN vs Mahalanobis vs PCA/SPE on handcrafted vibration
   features under one leakage-free protocol with VUS-PR; POT/GEV vs 3σ
   thresholds on bearing indicators with false-alarm rate and delay.
5. A 2023–2026 Weibull-PHM or Bayesian-Weibull paper; realised savings of
   cost-optimal replacement on real fleet data; PRONOSTIA condition 3.
6. Any independent replication of PHMForge, AssetOpsBench or Predictive
   Maintenance MCP; a controlled study of hallucinated fault frequencies or
   standard clauses; the results of Löwhagen et al. (IJPR 2025).
7. Same-model latency of a small vibration model on Pi 5, Jetson Orin Nano
   and an Intel N100 (and whether N100 exposes a VNNI path to MLAS);
   `tfjs-node` vs `tfjs-wasm` vs ORT on one model; MLPerf Tiny v1.3/v1.4
   per-device anomaly-detection numbers.
8. A benchmark of unsupervised drift detectors on vibration feature streams;
   measured separation of benign shift from fault on bearing/gearbox data
   beyond Kermenov's n = 1; the cost of a wrong re-baseline vs a false drift
   alarm.
9. Multi-site field validation of any domain-adaptation method or vibration
   foundation model; an independent comparison of VibFM, UniFault, BearingFM
   and BearLLM; gearbox-specific domain-adaptation evidence.
10. A controlled study of maintainers' trust or decision quality with vs
    without explanations for a PdM alarm.

---

## Sources

**Primary (peer-reviewed journals / conference / standards):**

- Randall, Antoni & Gryllias, "Alternatives to kurtosis as an indicator of rolling element bearing faults", ISMA 2016 — https://past.isma-isaac.be/downloads/isma2016/papers/isma2016_0550.pdf
- Randall & Antoni, "Rolling element bearing diagnostics — A tutorial", MSSP 25(2), 2011 — https://doi.org/10.1016/j.ymssp.2010.07.017
- Smith & Randall, "Rolling element bearing diagnostics using the Case Western Reserve University data", MSSP 64–65, 2015 — https://doi.org/10.1016/j.ymssp.2015.04.021 (transcript: https://www.slideshare.net/slideshow/smith-randall-15rollingelementbearingdiagnosticscwu/238800531)
- Kiakojouri & Wang, Sensors 25(8):2378, 2025 — https://pmc.ncbi.nlm.nih.gov/articles/PMC12030810/
- Vieira, Bauler, Rosa & Silva, "Towards a more realistic evaluation of machine learning models for bearing fault diagnosis", MSSP 258:114640, 2026 (in press) — https://arxiv.org/html/2509.22267v1
- Lessmeier, Kimotho, Zimmer & Sextro, Paderborn bearing dataset, PHME 2016 — https://papers.phmsociety.org/index.php/phme/article/download/1577/542
- Hendriks, Dumond & Knox, MSSP 169:108732, 2022 — https://doi.org/10.1016/j.ymssp.2021.108732
- Zhao et al., "Deep learning algorithms for rotating machinery intelligent diagnosis: an open source benchmark study", ISA Trans. 107, 2020 — https://arxiv.org/html/2003.03315v3
- Latil, Houé Ngouna, Medjaher & Lhuisset, IJPHM 16(2), 2025 — https://papers.phmsociety.org/index.php/ijphm/article/view/4208
- Antoni, "Fast computation of the kurtogram", MSSP 21(1), 2007 — https://doi.org/10.1016/j.ymssp.2005.12.002
- Smith, Borghesani, Ni, Wang & Peng, "Optimal demodulation-band selection … log-cycligram", MSSP 134:106303, 2019 — https://doi.org/10.1016/j.ymssp.2019.106303
- Borghesani, Pennacchi & Chatterton, MSSP 43:25–43, 2014 — https://re.public.polimi.it/handle/11311/767875
- Randall, "A history of cepstrum analysis and its application to mechanical problems", MSSP 97:3–19, 2017 — https://surveillance7.sciencesconf.org/conference/surveillance7/01_a_history_of_cepstrum_analysis_and_its_application_to_mechanical_problems.pdf
- Peeters, Guillaume & Helsen, "Signal pre-processing using cepstral editing for vibration-based bearing fault detection", ISMA 2016 — https://past.isma-isaac.be/downloads/isma2016/papers/isma2016_0264.pdf
- Zhao, Lin, Xu & Lei, tacholess envelope order analysis, Sensors 13(8), 2013 — https://pmc.ncbi.nlm.nih.gov/articles/PMC3812632/
- Sawalhi, VFD inverter signature as pseudo-tachometer, Sensors 25(3):815, 2025 — https://pmc.ncbi.nlm.nih.gov/articles/PMC11820092/
- Pachaud, Salvetat & Fray, "Crest factor and kurtosis contributions …", MSSP 11(6), 1997 — https://doi.org/10.1006/mssp.1997.0115
- EMD/EEMD and VMD parameter sensitivity: Sensors 2017 — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5713071/ · 2022 — https://pmc.ncbi.nlm.nih.gov/articles/PMC9142948/ · 2021 — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8146961/ · Sci. Rep. 2025 — https://www.nature.com/articles/s41598-025-89161-3
- ISO 20816-3:2022, ISO 20816-1:2016, ISO 10816-3:2009/Amd 1:2017, ISO/FDIS 13379-1, ISO 13381-1:2015 (iTeh sample PDFs) — https://cdn.standards.iteh.ai/samples/78311/30f79c7c3eca41c1ad7b4321a447bd39/ISO-20816-3-2022.pdf · https://cdn.standards.iteh.ai/samples/63180/ace1232a76714dc48087a6cfe49c2bda/ISO-20816-1-2016.pdf · https://cdn.standards.iteh.ai/samples/71200/3bccf6dc62744bfdaed314b9f6d78c04/ISO-10816-3-2009-Amd-1-2017.pdf · https://cdn.standards.iteh.ai/samples/iso/iso-fdis-13379-1/cb495a03fbfd4181b6c19d28ca1afb88/iso-fdis-13379-1.pdf · https://cdn.standards.iteh.ai/samples/51436/8246d96c8ff54347ae65f3aba73f2e88/ISO-13381-1-2015.pdf
- iso.org catalogue (page summaries; direct fetch 403): ISO 13379-1:2025 https://www.iso.org/standard/88027.html · ISO/CD 13379-2 https://www.iso.org/standard/88028.html · ISO 13381-1:2025 https://www.iso.org/standard/88029.html · ISO 20816-3:2022 https://www.iso.org/standard/78311.html · ISO/FDIS 20816-3 https://www.iso.org/standard/89922.html · ISO/AWI 20816-7 https://www.iso.org/standard/92744.html · ISO 20816-21:2025 https://www.iso.org/standard/84280.html · ISO 13373-10:2024 https://www.iso.org/standard/82072.html · ISO/AWI 13373-8 https://www.iso.org/standard/78145.html · ISO 18436-3:2025 https://www.iso.org/standard/88263.html · ISO/DIS 18436-2 https://www.iso.org/standard/88030.html · ISO/FDIS 18436-8 https://www.iso.org/standard/88265.html · ISO/DIS 18436-10 https://www.iso.org/standard/88264.html · ISO 13374-2 https://www.iso.org/standard/36645.html · ISO 13374-3 https://www.iso.org/standard/37611.html · ISO 13374-4 https://www.iso.org/standard/54933.html · ISO 17359:2018 https://www.iso.org/standard/71194.html · ISO 55001:2024 https://www.iso.org/standard/83054.html · ISO/IEC 20237:2023 https://www.iso.org/standard/86204.html · ISO/IEC TS 6254:2025 https://www.iso.org/standard/82148.html
- DIN: ISO 13381-1 — https://www.dinmedia.de/en/standard/iso-13381-1/243237734 · ISO/FDIS 20816-3 — https://www.dinmedia.de/en/draft-standard/iso-fdis-20816-3/405621630 · genorma EN 13306:2017 — https://genorma.com/en/standards/en-13306-2017 · AFNOR IEC 62443-4-2:2019 — https://www.boutique.afnor.org/en-gb/standard/iec-62443422019/security-for-industrial-automation-and-control-systems-part-42-technical-se/xs134182/253290
- OPC Foundation: OPC 40001-1 §16 Monitoring — https://reference.opcfoundation.org/Machinery/v104/docs/16 · OPC UA for Machinery page — https://opcfoundation.org/developer-tools/specifications-opc-ua-information-models/opc-ua-for-machinery/ · OPC 40001-2 — https://reference.opcfoundation.org/specs/OPC-40001-2/full · OPC 40001-101 — https://reference.opcfoundation.org/specs/OPC-40001-101 · OPC 10000-100 — https://reference.opcfoundation.org/specs/OPC-10000-100/full
- Eclipse Sparkplug 3.0.0 specification — https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf
- IDTA submodels: 02048 Predictive Maintenance — https://industrialdigitaltwin.org/wp-content/uploads/2025/06/IDTA-02048_Submodel_PredictiveMaintenance.pdf · 02008-1-1 Time Series Data — https://industrialdigitaltwin.org/wp-content/uploads/2023/03/IDTA-02008-1-1_Submodel_TimeSeriesData.pdf · 02013-1-0 Reliability — https://industrialdigitaltwin.org/en/wp-content/uploads/sites/2/2022/11/IDTA-02013-1-0_Submodel_Reliability.pdf
- MIMOSA: OSA-CBM — https://www.mimosa.org/mimosa-osa-cbm/ · OSA-CBM 3.3.1 — https://www.mimosa.org/specifications/osa-cbm-3-3-1/ · CCOM — https://www.mimosa.org/mimosa-ccom/ · What is MIMOSA v1.1 — https://www.mimosa.org/wp-content/uploads/white-papers/2020/05/what-is-mimosa/What-is-MIMOSA-Version-1.1.pdf · Licence v2.1.a — https://www.mimosa.org/wp-content/uploads/MIMOSA_License_Agreement.pdf
- Drever et al., "Implementing MIMOSA Standards", PHME 2016 — https://papers.phmsociety.org/index.php/phme/article/download/1647/609
- Bouman, Bukhsh & Heskes, JMLR 25(105), 2024 — https://jmlr.org/papers/v25/23-0570.html
- Liu & Paparrizos, "The Elephant in the Room: Towards a Reliable Time-Series Anomaly Detection Benchmark" (TSB-AD), NeurIPS 2024 — https://proceedings.neurips.cc/paper_files/paper/2024/file/c3f3c690b7a99fba16d0efd35cb83b2c-Paper-Datasets_and_Benchmarks_Track.pdf
- Schmidl, Wenig & Papenbrock, TimeEval, PVLDB 15(9), 2022 — https://www.vldb.org/pvldb/vol15/p1779-wenig.pdf
- Paparrizos et al., TSB-UAD, PVLDB 15(8), 2022 — https://www.vldb.org/pvldb/vol15/p1697-paparrizos.pdf
- Boniol et al., "VUS: effective and efficient accuracy measures …", VLDB Journal 34(3), 2025 — https://doi.org/10.1007/s00778-025-00907-x
- Sarfraz et al., "Position: Quo Vadis, Unsupervised Time Series Anomaly Detection?", ICML 2024 — https://arxiv.org/abs/2405.02678
- Han et al., ADBench, NeurIPS 2022 — https://arxiv.org/abs/2206.09426
- Kim et al., "Towards a Rigorous Evaluation of Time-series Anomaly Detection", AAAI 2022 — https://arxiv.org/abs/2109.05257
- Wu & Keogh, "Current Time Series Anomaly Detection Benchmarks are Flawed …", IEEE TKDE 2023 — https://arxiv.org/abs/2009.13807
- Neupane et al., semi-supervised anomaly detection comparison, PHME 2024 — https://papers.phmsociety.org/index.php/phme/article/download/4053/2378
- Zaidi, Shenfield, Zhang & Ikpehai, Processes 14(15):2452, 2026 — https://shura.shu.ac.uk/37786/
- Cui, Zhang & Wang, Sensors 25(18):5733, 2025 — https://pmc.ncbi.nlm.nih.gov/articles/PMC12473427
- Dai et al., multi-scale self-supervision bearing anomaly detection, Sensors 25(4):1185, 2025 — https://pmc.ncbi.nlm.nih.gov/articles/PMC11859829/
- Górski et al., novelty-detection comparison, Sensors 21(10):3536, 2021 — https://pmc.ncbi.nlm.nih.gov/articles/PMC8161417/
- Xu, Pang, Wang & Wang, Deep Isolation Forest, IEEE TKDE 2023 — https://arxiv.org/abs/2206.06602
- Hariri, Kind & Brunner, Extended Isolation Forest, IEEE TKDE 2021 — https://arxiv.org/pdf/1811.02141 · Lesouple et al., Generalized Isolation Forest, PRL 2021 — https://www.sciencedirect.com/science/article/abs/pii/S0167865521002063
- Siffer, Fouque, Termier & Largouët, "Anomaly Detection in Streams with Extreme Value Theory", KDD 2017 — https://www.eecs.yorku.ca/course_archive/2018-19/F/6412/reading/kdd17p1067.pdf
- Automatic alarm setup using extreme value theory, MSSP 139:106417, 2020 — https://www.sciencedirect.com/science/article/abs/pii/S0888327019306387
- Hela, Handigol & Arjunan, ACM e-Energy 2025 — https://dl.acm.org/doi/abs/10.1145/3679240.3734633
- Saxena, Goebel, Simon & Eklund, PHM08 damage-propagation modelling — https://ntrs.nasa.gov/api/citations/20090029214/downloads/20090029214.pdf
- Saxena, Celaya, Saha, Saha & Goebel, "Metrics for Offline Evaluation of Prognostic Performance", IJPHM 1(1), 2010 — https://doi.org/10.36001/ijphm.2010.v1i1.1336
- Sharp, prognostic-metric critique, PHM Society 2013 — https://papers.phmsociety.org/index.php/phmconf/article/download/2317/1308
- Choo & Shin, "Integrating ML-Based RUL Predictions with Cost-Optimal Block Replacement", IJPHM 16(1), 2025 — https://doi.org/10.36001/ijphm.2025.v16i1.4242
- Robinson, asymmetric conformal RUL intervals, IJPHM 17(1), 2026 — https://doi.org/10.36001/IJPHM.2026.v17i1.4724
- Javanmardi & Hüllermeier, conformal RUL, IJPHM 14(2), 2023 — https://doi.org/10.36001/IJPHM.2023.v14i2.3417
- Bektas et al., PHM08 secondary test sets, Data in Brief 21, 2018 — https://doi.org/10.1016/j.dib.2018.11.085
- Arias Chao, Kulkarni, Goebel & Fink, N-CMAPSS, Data 6(1):5, 2021 — https://doi.org/10.3390/data6010005
- Coble & Hines, prognostic-parameter metrics, PHM Society 2009 — https://papers.phmsociety.org/index.php/phmconf/article/view/1404
- Eker, Camci & Jennions, similarity-based prognostics, PHME 2014 — https://papers.phmsociety.org/index.php/phme/article/download/1479/445
- Wang, Yu, Siegel & Lee, similarity-based RUL, ICPHM 2008 — https://doi.org/10.1109/PHM.2008.4711421 · Li, Lei, Lin & Ding, improved exponential model, IEEE TIE 62(12), 2015 — https://doi.org/10.1109/TIE.2015.2455055 · Si, Wang, Hu & Zhou, Wiener-process review, EJOR 213(1), 2011 — https://doi.org/10.1016/j.ejor.2010.11.018
- Di Maggio, "Predictive Maintenance MCP", Applied Sciences 16(6):2812, 2026 — https://doi.org/10.3390/app16062812 · Di Maggio, "Toward Autonomous LLM-Based AI Agents for Predictive Maintenance", Applied Sciences 15(21):11515, 2025 — https://www.mdpi.com/2076-3417/15/21/11515
- Deng et al., "From Prediction to Prescription", PHME 2024 — https://papers.phmsociety.org/index.php/phme/article/view/4114
- Dimidov et al., "Cleaning Maintenance Logs with LLM Agents", PHMAP 2025 — https://papers.phmsociety.org/index.php/phmap/article/view/4486
- Lukens & Ali, ChatGPT on PHM exams, PHM Society 2023 — http://papers.phmsociety.org/index.php/phmconf/article/view/3487 · Lukens et al., "LLM Agents as PHM Copilots", PHM Society 2024 — https://papers.phmsociety.org/index.php/phmconf/article/view/3906
- Kumar, Farahat & Gupta, maintenance actions from logs with domain LLMs, PHMAP 2025 — https://papers.phmsociety.org/index.php/phmap/article/view/4652
- AssetOpsBench (IBM; accepted KDD 2026) — https://arxiv.org/html/2506.03828v2
- Ouyang et al., non-determinism of ChatGPT in code generation, ACM TOSEM 2024 — https://arxiv.org/abs/2308.02828 · Wang et al., self-consistency, ICLR 2023 — https://arxiv.org/abs/2203.11171 · Walters & Wilder, fabricated citations, Sci. Rep. 2023 — https://doi.org/10.1038/s41598-023-41032-5
- Regulation (EU) 2026/1744 (Digital Omnibus on AI) — https://eur-lex.europa.eu/eli/reg/2026/1744/oj · Regulation (EU) 2023/1230 (Machinery) — https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1230
- European Commission: AI regulatory framework — https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai · GPAI guidelines — https://digital-strategy.ec.europa.eu/en/policies/guidelines-gpai-providers · Cyber Resilience Act — https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act · NIS2 — https://digital-strategy.ec.europa.eu/en/policies/nis2-directive
- Gao et al., edge-deployable TinyML bearing diagnosis, Sci. China Technol. Sci. 68(12):2220401, 2025 — https://doi.org/10.1007/s11431-025-3072-9
- Garay et al., multimodal TinyML PdM architecture, Sensors 26(14):4536, 2026 — https://doi.org/10.3390/s26144536
- Chen et al., 1-D CNN-Transformer on Pi 4 / i7 / M4 under ORT, Sensors 26(9):2574, 2026 — https://pmc.ncbi.nlm.nih.gov/articles/PMC13165830/
- El Boughardini et al., lightweight 1-D CNN on Teensy 4.1, JESA 59(4), 2026 — https://www.iieta.org/journals/jesa/paper/10.18280/jesa.590423
- TinyML bearing classification with Edge Impulse, ACM GLSVLSI 2025 — https://doi.org/10.1145/3716368.3735272
- Machine condition monitoring on edge computing (Revolution Pi + Node-RED), Sensors 25(1):180, 2024 — https://pmc.ncbi.nlm.nih.gov/articles/PMC11723020/
- Passarotto et al., "Edge AI on Constrained Devices", ACM TECS 25(5), 2026 — https://dl.acm.org/doi/10.1145/3827611
- Hinder, Vaquet & Hammer, concept drift Part A, Frontiers AI 7, 2024 — https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2024.1330257/full (arXiv text: https://arxiv.org/abs/2310.15826) · Part B — https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2024.1330258/full
- Jourdan, nearest-neighbour drift detection for CM, NeurIPS 2023 Workshop on Distribution Shifts — https://neurips.cc/virtual/2023/80526
- Lukats et al., unsupervised drift detectors benchmark, IJDSA 18(3), 2024 — https://link.springer.com/article/10.1007/s41060-024-00620-y
- Gower-Winter, Groen & Krempl, "The Window Dilemma", IDA 2026 — https://arxiv.org/html/2602.06456
- Kalinke & Gavioli-Akilagun, online change detection via random Fourier features, NeurIPS 2025 — https://arxiv.org/abs/2505.17789
- Werner et al., computational performance of unsupervised drift detection, DATA 2024 — https://arxiv.org/abs/2304.08319
- Singh, "When Drift Detectors Cry Wolf", ICLR 2026 workshop — https://iclr.cc/virtual/2026/10016892
- Zenisek, Holzinger & Affenzeller, CIE 137:106031, 2019 — https://pure.fh-ooe.at/en/publications/machine-learning-based-concept-drift-detection-for-predictive-mai/
- Estaji et al., drift detection in the CM domain, IEEE TII 21(1), 2025 — https://repositum.tuwien.at/handle/20.500.12708/209592
- Ricaldi-Morales et al., model-drift fault detection in induction machines, Sensors 26(5):1595, 2026 — https://europepmc.org/article/PMC/PMC12987117
- Kermenov et al., anomaly detection and concept-drift adaptation on a cobot, Sensors 23(6):3260, 2023 — https://europepmc.org/article/PMC/PMC10052046
- Kim et al., MLOps for self-adaptive anomaly detection on ships, JMSE 14(13):1152, 2026 — https://doi.org/10.3390/jmse14131152
- Letzgus, change-point detection in wind-turbine SCADA, WES 5, 2020 — https://wes.copernicus.org/articles/5/1375/2020/ · Chesterman et al., WES 8, 2023 — https://wes.copernicus.org/articles/8/893/2023/
- Forest & Fink, "Calibrated Adaptive Teacher", Sensors 24(23), 2024 — https://arxiv.org/html/2312.02826v2
- Liefstingh et al. (SKF), interpretation of deep-learning bearing models, PHM Society 2021 — https://papers.phmsociety.org/index.php/phmconf/article/view/3047
- Iunusova & Archenti, lab-to-field generalization gap, Applied Sciences 15(12):6804, 2025 — https://doi.org/10.3390/app15126804
- Mannone, Fischer & Dazer, VibFM, PHME 2026 — https://papers.phmsociety.org/index.php/phme/article/view/4912
- Amaliah, Tjahjono & Palade, human-in-the-loop XAI for PdM, Electronics 14(17):3384, 2025 — https://doi.org/10.3390/electronics14173384
- Shin, Rothrock & Prabhu, technicians' diagnosis workload, Sensors 24(6):1943, 2024 — https://europepmc.org/article/PMC/PMC10974974
- Kundu & Hoque, "Explainable Predictive Maintenance is Not Enough", PHM Society 2023 — https://www.papers.phmsociety.org/index.php/phmconf/article/view/3472
- Sheppard et al., OSA-CBM / ISO 13374 on test stations (Montana State, 2018) — https://www.cs.montana.edu/sheppard/pubs/auto-2018.pdf
- CWRU Bearing Data Center — https://engineering.case.edu/bearingdatacenter/apparatus-and-procedures · https://engineering.case.edu/bearingdatacenter/12k-drive-end-bearing-fault-data
- Siemens, "The True Cost of Downtime 2024" — https://assets.new.siemens.com/siemens/assets/api/uuid:1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf

**Frontier preprints (NOT peer-reviewed — cite with care):**

- Yeh, MMPAD (Matrix Profile on TSB-AD), arXiv 2604.02445 — https://arxiv.org/abs/2604.02445
- TAB, unified TSAD benchmarking, arXiv 2506.18046 — https://arxiv.org/html/2506.18046v2
- Lyu, stress test of post-PA metrics, arXiv 2607.11969 — https://arxiv.org/abs/2607.11969
- Meyer et al., pretraining contamination of TSFMs, arXiv 2510.13654 — https://arxiv.org/html/2510.13654v1
- TimeRCD, arXiv 2509.21190 — https://arxiv.org/html/2509.21190v5
- Wen & Chen, "Do Time-Series Foundation Models Pay Off for Industrial Monitoring?", arXiv 2608.22968 — https://arxiv.org/html/2608.22968
- Ansari et al., Chronos-2, arXiv 2510.15821 — https://arxiv.org/abs/2510.15821 (README: https://github.com/amazon-science/chronos-forecasting)
- FETS benchmark (CPU cost of Chronos-2), arXiv 2604.22328 — https://arxiv.org/html/2604.22328 · Soni et al., arXiv 2605.24381 — https://arxiv.org/pdf/2605.24381
- Zhou & Wang, scoring backends on DCASE machine sounds, arXiv 2606.19269 — https://arxiv.org/abs/2606.19269
- Li, Qiu, Zhu, Jiang & Zhou, harmonic-structure detection on IMS, arXiv 1511.03174 — https://arxiv.org/abs/1511.03174
- MCSFormer, arXiv 2505.14897 — https://arxiv.org/pdf/2505.14897
- Shamim et al., leakage-audited splitting for PdM, arXiv 2607.16493 — https://arxiv.org/abs/2607.16493
- Gupta, C-MAPSS normalisation audit, engrXiv 10.31224/8145 — https://engrxiv.org/preprint/view/8145
- C-MAPSS conventions (cap 125, score 13/10), arXiv 2610.04278 — https://arxiv.org/html/2610.04278
- Yan, conformal RUL on N-CMAPSS, Zenodo 2026 — https://zenodo.org/records/21281080
- SARNet (FPT run rules, PHM12 score), arXiv 2510.22955 — https://arxiv.org/pdf/2510.22955
- Tefera et al., constraint-guided HI models on PRONOSTIA, arXiv 2503.09113 — https://arxiv.org/pdf/2503.09113 · Sun et al., arXiv 2506.05438 — https://arxiv.org/pdf/2506.05438 · unsupervised HI on N-CMAPSS, arXiv 2405.04990 — https://arxiv.org/pdf/2405.04990
- Franz, "Ratios: A short guide to confidence limits and proper use", arXiv 0710.2024 — https://arxiv.org/pdf/0710.2024
- Koutas & Straub, prognostics-based replacement policies, arXiv 2607.27899 — https://arxiv.org/html/2607.27899v1
- PHMForge, arXiv 2604.01532 (v1 2 Apr 2026, v3 24 Aug 2026) — https://arxiv.org/abs/2604.01532 · https://arxiv.org/html/2604.01532 · https://arxiv.org/html/2604.01532v1
- Trajel, hallucination audit of agent trajectories, arXiv 2605.24219 — https://arxiv.org/html/2605.24219v2
- Boonmee et al., arXiv 2410.03223 (internally inconsistent; do not cite for numbers) — https://arxiv.org/html/2410.03223
- Tamba, temperature control and reproducibility, arXiv 2606.26185 — https://arxiv.org/abs/2606.26185
- ORCA calculation benchmark, arXiv 2511.02589 — https://arxiv.org/abs/2511.02589
- Tam et al., "Let Me Speak Freely?", arXiv 2408.02442 — https://arxiv.org/abs/2408.02442
- Liao, CNN bearing diagnosis on STM32H743, arXiv 2304.09100 — https://arxiv.org/abs/2304.09100
- Bartoli et al., "Benchmarking Energy and Latency in TinyML", arXiv 2505.15622 — https://arxiv.org/html/2505.15622v1
- Raspberry Pi / Coral / Jetson Orin Nano detector benchmark, arXiv 2409.16808 — https://arxiv.org/html/2409.16808v1
- Yamada & Matsutani, sequential drift detection on low-end edge devices, arXiv 2212.09637 — https://arxiv.org/html/2212.09637
- Cerqueira et al., drift-detector evaluation framework, arXiv 2606.07789 (accepted KDD 2026) — https://arxiv.org/abs/2606.07789
- Dasari, "When to Retrain", arXiv 2608.19488 — https://arxiv.org/abs/2608.19488 · Poenaru-Olaru et al., arXiv 2510.10320 — https://arxiv.org/abs/2510.10320
- Wang et al., OSAA distant-domain adaptation, arXiv 2405.17493 — https://arxiv.org/html/2405.17493v1
- Eldele et al., UniFault, arXiv 2504.01373 — https://arxiv.org/html/2504.01373v2
- Cummins et al., explainable PdM survey, arXiv 2401.07871 — https://arxiv.org/html/2401.07871v1
- Mey & Neufeld, XAI for vibration fault detection, arXiv 2207.10732 — https://ar5iv.labs.arxiv.org/html/2207.10732

**Secondary / vendor / library documentation:**

- Brüel & Kjær, application note BO 0501, "Envelope Analysis for Diagnostics of Local Faults in Rolling Element Bearings" — https://www.bksv.com/media/doc/bo0501.pdf
- Randall, "Machine Diagnostics using Advanced Signal Processing", PHM Society tutorial 2010 — https://phmsociety.org/wp-content/uploads/2010/11/Tutorial-Diagnostics-Randall.pdf
- Beckhoff TwinCAT Condition Monitoring documentation (crest factor, kurtosis) — https://infosys.beckhoff.com/content/1033/tf3600_tc3_condition_monitoring/1162493835.html · Vibromera glossary — https://vibromera.eu/glossary/bearing-fault-frequencies/
- ISO 20816-3 zone reproductions: Fabrico — https://www.fabrico.io/blog/iso-20816-vibration-severity-zones/ · ToolGrit — https://www.toolgrit.com/guides/vibration-analysis-basics · travail-industrie — https://travail-industrie.com/blog/article-titre/analyse-vibratoire-norme-iso-10816-zones-seuils-machines · ACOEM (2026) — https://acoem.us/?p=34047 · Sensemore calculator — https://sensemore.io/tools/iso-20816-vibration-severity-calculator/ · B&K Vibro VCM-3 template — https://www.bkvibro.com/wp-content/uploads/2021/07/VCM-3_Master_Monitoring_Template_S01_Standard_C108041002_en_v01.pdf
- BSI listing ISO 13379-1:2025 — https://knowledge.bsigroup.com/products/condition-monitoring-and-diagnostics-of-machine-systems-data-interpretation-and-diagnostics-techniques-part-1-general-guidelines · Lebold (Penn State ARL) OSA-CBM slides — https://sites.esm.psu.edu/wiki/_media/research:cjl9:lebold_arl.pdf
- MathWorks Predictive Maintenance Toolbox: monotonicity / trendability / prognosability — https://www.mathworks.com/help/predmaint/ref/monotonicity.html · https://www.mathworks.com/help/predmaint/ref/trendability.html · https://www.mathworks.com/help/predmaint/ref/prognosability.html
- ReliaSoft HotWire, rank regression vs MLE — https://help.reliasoft.com/articles/content/hotwire/issue1/hottopics1.html · NIST/SEMATECH e-Handbook §8.1.6.2 (Weibull) — https://www.itl.nist.gov/div898/handbook/apr/section1/apr162.htm · ReliaWiki Weibull functions — https://reliawiki.com/index.php/Template:Weibull_mode · Vatn, NTNU PK8207 lecture notes (Wiener/Gamma first-passage) — https://jvatn.folk.ntnu.no/eLearning/PK8207/LectureNotes/PK8207NumIntStochasticProcess.pdf · NASA prognostics metrics library — https://github.com/nasa/prognosticsmetricslibrary
- scikit-learn IsolationForest — https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.IsolationForest.html · MATLAB isolationforest — https://www.mathworks.com/help/stats/isolationforest.html
- Predictive Maintenance MCP README (self-reported benchmark) — https://raw.githubusercontent.com/LGDiMaggio/predictive-maintenance-mcp/main/README.md · Semantic Scholar record — https://api.semanticscholar.org/graph/v1/paper/DOI:10.3390/app16062812
- Thinking Machines, "Defeating Nondeterminism in LLM Inference" — https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/ · Docker, "Local LLM Tool Calling: A Practical Evaluation" — https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/ · Ollama structured outputs — https://ollama.com/blog/structured-outputs
- AI Act explorer: Article 50 — https://artificialintelligenceact.eu/article/50/ · Article 13 — https://artificialintelligenceact.eu/article/13/ · Article 6 — https://artificialintelligenceact.eu/article/6/ · Annex III — https://artificialintelligenceact.eu/annex/3/ · implementation timeline — https://artificialintelligenceact.eu/implementation-timeline/
- Siemens Industrial Copilot maintenance claims — https://www.engineering.com/siemens-adds-ai-powered-maintenance-to-industrial-copilot/ · Senseye claims — https://smartindustry.com/artificial-intelligence/article/33015656/with-industrial-copilot-siemens-and-schaeffler-help-make-gen-ai-industrial-grade
- ONNX Runtime: Node binding README — https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md · releases — https://github.com/microsoft/onnxruntime/releases · quantization guide — https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html · SessionOptions — https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.SessionOptions.html · npm — https://registry.npmjs.org/onnxruntime-node
- TensorFlow.js: npm tfjs-node — https://registry.npmjs.org/@tensorflow/tfjs-node · issue #8430 — https://github.com/tensorflow/tfjs/issues/8430 · converter README — https://github.com/tensorflow/tfjs/blob/master/tfjs-converter/README.md · WASM backend README — https://github.com/tensorflow/tfjs/blob/master/tfjs-backend-wasm/README.md
- Coral: pycoral releases — https://github.com/google-coral/pycoral/releases · libedgetpu — https://github.com/google-coral/libedgetpu · Coral NPU announcement — https://developers.googleblog.com/en/introducing-coral-npu-a-full-stack-platform-for-edge-ai/ · feranick builds — https://github.com/feranick/pycoral
- Raspberry Pi 5 quantisation benchmark (community) — https://github.com/manunicholasjacob/rpi5-quantization-benchmark · ST STM32Cube.AI model performances — https://wiki.st.com/stm32mcu/wiki/AI:STM32Cube.AI_model_performances · MLCommons MLPerf Tiny — https://mlcommons.org/benchmarks/inference-tiny/
- Model signing and OTA: Sigstore model-transparency v1.0 — https://blog.sigstore.dev/model-transparency-v1.0 · OpenSSF OMS — https://openssf.org/?p=8454 · AWS Greengrass deployments — https://docs.aws.amazon.com/greengrass/v2/developerguide/revise-deployments.html · Azure IoT Edge — https://learn.microsoft.com/en-us/azure/iot-edge/how-to-deploy-modules-portal · Mender U-Boot integration — https://docs.mender.io/system-updates-yocto-project/board-integration/bootloader-support/u-boot/manual-u-boot-integration
- Node-RED forum on multi-core use — https://discourse.nodered.org/t/can-node-red-flow-utilize-multiple-cpu-cores/53356
- Drift libraries: river ADWIN — https://riverml.xyz/latest/api/drift/ADWIN/ · Page–Hinkley — https://riverml.xyz/latest/api/drift/PageHinkley/ · KSWIN — https://riverml.xyz/latest/api/drift/KSWIN/ · DDM — https://riverml.xyz/latest/api/drift/binary/DDM/ · alibi-detect KS — https://docs.seldon.ai/alibi-detect/cd/methods/offline/ksdrift.md · MMD — https://docs.seldon.ai/alibi-detect/cd/methods/offline/mmddrift · online MMD — https://docs.seldon.ai/alibi-detect/cd/methods/online/onlinemmddrift.md · Evidently data-drift defaults — https://docs.evidentlyai.com/metrics/customize_data_drift · NannyML univariate comparison — https://nannyml.readthedocs.io/en/main/how_it_works/univariate_drift_comparison.html
- PSI statistics: risk.net — https://www.risk.net/journal-of-risk-model-validation/7725371/statistical-properties-of-the-population-stability-index · du Pisanie et al., arXiv 2303.01227 — https://arxiv.org/abs/2303.01227
- Deloitte Insights, "Making maintenance smarter" (2017) — https://www.deloitte.com/us/en/insights/industry/manufacturing-industrial-products/industry-4-0/using-predictive-technologies-for-asset-maintenance.html · Deloitte DE position paper — https://www.deloitte.com/content/dam/assets-zone2/de/de/docs/about/2024/Deloitte_Predictive-Maintenance_PositionPaper.pdf · consultancy.nl on PwC/Mainnovation 2018 — https://www.consultancy.nl/nieuws/20216/predictive-maintenance-wint-terrein-en-levert-koplopers-efficiencywinst-op
- Market reports: MarketsandMarkets — https://www.marketsandmarkets.com/Market-Reports/operational-predictive-maintenance-market-8656856.html · Grand View Research — https://www.grandviewresearch.com/industry-analysis/predictive-maintenance-market · Mordor Intelligence — https://www.mordorintelligence.com/industry-reports/predictive-maintenance-market · Precedence Research — https://www.precedenceresearch.com/predictive-maintenance-market · Research and Markets 5767408 — https://www.researchandmarkets.com/reports/5767408/predictive-maintenance-market-report
- MaintainX: State of Industrial Maintenance 2025 — https://www.getmaintainx.com/state-of-industrial-maintenance-2025 · press release — https://www.getmaintainx.com/newsroom/state-of-industrial-maintenance-report-2025 · blog (17 Oct 2025) — https://www.getmaintainx.com/blog/maintenance-stats-trends-and-insights · 2026 edition — https://www.getmaintainx.com/state-of-industrial-maintenance
- VDMA, "Positionspapier des VDMA zu Industrial AI" (Apr 2026) — https://www.vdma.eu/documents/34570/76845115/2026_04%20VDMA-Positionspapier%20Industrial%20AI.pdf · Fraunhofer IML service page — https://www.iml.fraunhofer.de/de/abteilungen/b2/anlagenmanagement/predictive-maintenance.html
- Microsoft Predictive Maintenance Modelling Guide data — https://github.com/microsoft/SQL-Server-R-Services-Samples/blob/master/PredictiveMaintenanceModelingGuide/README.md
- TimesFM README — https://github.com/google-research/timesfm · Salesforce uni2ts (Moirai) README — https://github.com/SalesforceAIResearch/uni2ts
- Crossref records used for identifier verification — https://api.crossref.org/works/10.1007/s11431-025-3072-9 · https://api.crossref.org/works/10.3390/s26144536 · https://api.crossref.org/works/10.1145/3827611
