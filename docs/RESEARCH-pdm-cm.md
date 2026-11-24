# Predictive Maintenance & Condition Monitoring — Scientific State of the Art (2023–2026)

> A literature-grounded review of PdM/CM methods, focused on peer-reviewed work and
> authoritative sources from 2023–2026. Each finding carries a **confidence** level and
> an adversarial **verification vote** (claims were checked by 3 independent skeptic
> agents; ≥2 refutes kills a claim). Source URLs are listed per finding and consolidated
> at the end. Read the **Caveats** section before quoting any number — several frontier
> results are unreplicated preprints.

**Method:** fan-out web search across 6 angles → 27 sources fetched → 129 candidate
claims extracted → top 25 adversarially verified → 23 confirmed / 2 refuted → synthesized.
Generated 2026-06-16. **Revised 2026-10-09:** the four open questions below are answered
in the follow-up review, and the statements that the follow-up pass found to be
overstated (sections 2, 3c, 4c and the implications table) were corrected in place; the
original wording is quoted in section 9 of the follow-up.

**Companion documents:** [RESEARCH-cm-pdm-landscape.md](RESEARCH-cm-pdm-landscape.md)
covers the wider landscape — standards (ISO 17359/13374/20816/13381), measurement
techniques, market and adoption data, barriers, and a mapping of this toolkit's nodes onto
the ISO 13374 blocks. [RESEARCH-pdm-cm-followup.md](RESEARCH-pdm-cm-followup.md)
(October 2026) answers this review's open questions and covers its declared gaps.

---

## TL;DR

The 2023–2026 literature has settled on a **stable methodological taxonomy** for PdM/CM.
Prognostic/RUL methods split into **model-based (physics), data-driven (ML),
knowledge-based, and hybrid** families — the three-way model/data/hybrid framing being
most common, encoding a clear **interpretability-vs-adaptability tradeoff**. **Deep
learning now dominates RUL forecasting** (CNN, LSTM, GRU, autoencoders; Transformers and
GNNs emerging) and consistently beats classical statistical baselines, but the field's
acknowledged weaknesses are **inadequate uncertainty quantification, label scarcity, and
poor cross-machine generalization**.

For **anomaly detection**, the largest peer-reviewed benchmark on *tabular* data (JMLR
2024) finds a **two-algorithm toolbox suffices** — Extended Isolation Forest for global
anomalies, kNN for local. On time-series benchmarks this does not replicate (follow-up
review, section 3): sub-sequence PCA and windowed kNN lead, Isolation Forest sits
mid-field, so what the benchmarks validate is this toolkit's PCA/SPE detector rather than
its Isolation Forest. The frontier is the **Industry 4.0 → 5.0 shift** (human-centricity,
sustainability, resilience over four enablers: ML, Digital Twins, IoT, Big Data),
**LLM-based prognostics**, **physics-informed / Transformer** models, and **formalized
concept-drift detection** for retraining.

---

## 1. Method families & taxonomy

**Finding (confidence: high · vote 3-0).** RUL/prognostic methods are organized into a
stable taxonomy: **model-based (physics), data-driven (ML), knowledge-based/experimental,
and hybrid**. The three-way model/data/hybrid split is most common and reflects an
interpretability-vs-adaptability tradeoff:

- **Model-based** — interpretable, but mathematical degradation models are hard to build in practice; limited adaptability.
- **Data-driven** — adaptable, learns from data; less explainable.
- **Hybrid** — balances both.

A second axis separates **regression** methods (estimate RUL as a value) from
**classification** methods (forecast failure probability over time intervals).

*Sources:* MDPI Sensors 24(11):3454 (2024); arXiv 2506.20090v1 (2025); ScienceDirect S2666827025000878 (2025).

---

## 2. Anomaly detection — a small toolbox suffices

**Finding (confidence: high · vote 3-0 / 2-1 mixed).** The largest unsupervised
anomaly-detection comparison to date (**JMLR vol. 25, paper 23-0570, 2024** — 33
algorithms × 52 real-world multivariate datasets) concludes:

- **Extended Isolation Forest (EIF)** is best overall and best on **global** anomalies (significantly outperforms 13–14 of competitors via Friedman/Nemenyi tests).
- **kNN** is best on **local** anomalies.
- **These two together suffice** for a representative collection of multivariate data.

An independent study (Scientific African, 2024) found **One-Class SVM, Isolation Forest,
and Robust Covariance** most effective on synthetic data, with Isolation Forest slightly
leading on precision/recall balance.

> **Direct implication for this toolkit.** The `isolation-forest-anomaly` +
> `pca-anomaly`/Mahalanobis (distance-based) combination covers both global and local
> anomalies. **Caveat, confirmed in October 2026:** the JMLR benchmark is on **tabular**
> data, and its ranking does *not* transfer to time series: on TSB-AD (NeurIPS 2024)
> Isolation Forest scores VUS-PR 0.30 (univariate) / 0.20 (multivariate) and Extended
> Isolation Forest 0.21 against sub-sequence PCA 0.42, PCA 0.31 and windowed kNN
> 0.44 / 0.35; on Paderborn real-damage features OC-SVM (ROC-AUC 0.73) beats Isolation
> Forest (0.63). The part that holds up is the PCA/SPE detector — see
> [open question 2](#open-questions) and the follow-up review, section 3.

*Sources:* JMLR v25/23-0570 (2024); ScienceDirect S2468227624003284 (2024).

---

## 3. RUL / prognostics

### 3a. Deep learning dominates

**Finding (confidence: high · vote 3-0).** DL architectures (CNN, LSTM, GRU,
autoencoders incl. stacked-denoising/sparse, echo-state networks, deep belief networks)
now dominate RUL forecasting and consistently outperform classical statistical baselines.
LSTM excels at temporal degradation patterns; deep CNNs have beaten RNN/LSTM/DNN **in
specific studies** (not universally — classical/hybrid stays competitive in low-data
regimes). Meta-analysis reports up to ~14% gains over traditional methods. On C-MAPSS:
LSTM RMSE ≈ 14.2–14.93 vs 1D-CNN ≈ 15.68–16.97.

> Note: the 2024 Sensors survey covers AE/DBN/RNN/CNN families but **not** Transformers or
> GNNs — those appear in separate 2024–2025 dedicated surveys (e.g. arXiv 2409.19629 on GNN-for-RUL).

*Sources:* arXiv 2506.20090v1; MDPI Sensors 24(11):3454; PMC11174398.

### 3b. Health-indicator quality governs accuracy

**Finding (confidence: high · vote 3-0).** The quality of the **health indicator (HI)** —
measured by **monotonicity, trendability, and prognosability** — is a primary determinant
of DL-RUL accuracy. A high-quality HI yielded RMSE as low as 2.67 flights in a worked example.

> **Implication for this toolkit.** Feature/HI engineering on the FFT/vibration features
> (`signal-analyzer`) — scored by these three metrics — governs downstream
> `trend-predictor` RUL accuracy. Worth adding HI-quality metrics as a feature-selection aid.
> Note (October 2026): "trendability" has three incompatible definitions in the literature
> (Coble 2009 derivative-sign spread, the MathWorks minimum pairwise correlation, and the
> bearing literature's correlation with time), and the bearing-prognostics papers use
> monotonicity, correlation-with-time and *robustness*; any implementation must state which
> one it computes — formulas in the follow-up review, section 4.

*Source:* PMC11174398 (Sensors 24(11):3454, 2024).

### 3c. Uncertainty quantification is the shared weakness

**Finding (confidence: high · vote 3-0).** Inadequate **uncertainty quantification (UQ)**
is a common limitation of current DL-RUL methods. Most rely on a single probability
distribution assuming one underlying degradation pattern, which lacks robustness for
time-varying degradation. Proposed remedies: **multi-distribution fusion, ensemble, and
Bayesian** approaches (e.g. Zhan et al., RESS 2024, integrate multiple candidate RUL
predictions with learned weights). Much C-MAPSS literature remains deterministic point estimates.

> **Implication for this toolkit.** The `trend-predictor` exposes an RUL **band** — the
> right design, not a point estimate alone. Qualified in October 2026: the band is a
> delta-method confidence interval for the mean crossing time (z-based, omitting the
> level–slope covariance, no process noise), not a calibrated prediction interval; the
> Monte-Carlo check in `tools/sim` shows it under-covers (≈ 75–80 % at a nominal 90 %).
> The literature's prescription is intervals with *verified coverage* (PICP against the
> nominal level) and, for extrapolated crossings, Fieller-type intervals that become
> unbounded when the slope is not significant — follow-up review, section 4.

*Sources:* PMC11174398; ScienceDirect S0951832024004551 (RESS, 2024).

---

## 4. Modern frontier: LLMs, Transformers, drift

### 4a. LLMs for RUL (emerging, proposal-stage)

**Finding (confidence: high that the work exists · vote 3-0).** LLMs are an active
2024–2025 frontier for RUL. Frameworks tokenize degradation signals into patches, use
hybrid embedding (selective freeze/fine-tune), and two-stage fine-tuning to model
nonlinear degradation without complex transfer-learning architectures:

- **arXiv 2410.03134** — an LLM regression framework for RUL capturing temporal dependencies in multidimensional sensor signals.
- **arXiv 2501.07191 (LM4RUL)** — bearing RUL via LLM, tokenizing vibration data, evaluated on XJTU-SY and FEMTO.

> ⚠️ **These describe what the papers *propose*.** Two specific performance super-claims
> from 2410.03134 were **REFUTED** in verification (see [Refuted claims](#refuted-claims)).
> Relevant to the toolkit's `llm-analyzer` as a *future* direction for LLM-assisted
> RUL/diagnosis — not as proven SOTA.

*Sources:* arXiv 2410.03134; arXiv 2501.07191.

### 4b. Transformer + wavelet for bearing RUL (medium confidence)

**Finding (confidence: medium · vote 2-1).** A multi-channel Swin Transformer
(**MCSFormer**, arXiv 2505.14897, 2025) combines wavelet denoising + Wavelet Packet
Decomposition with attention-based feature fusion, reporting 41% / 64% / 69% lower MAE vs
three baselines on PRONOSTIA/FEMTO. The wavelet/WPD preprocessing connects to the toolkit's
FFT/vibration stage.

> ⚠️ **Single unreplicated arXiv preprint**, intra-condition splits against self-selected
> baselines — prone to leakage/cherry-picking. Cite as "the paper reports," not fact.

*Source:* arXiv 2505.14897.

### 4c. Concept/data drift — formal basis for retraining

**Finding (confidence: high · vote 3-0, single strong primary).** Concept drift is
formally defined as a **violation of the constant-data-generating-distribution
assumption**, taxonomized by:

- **Temporal type:** abrupt / gradual / incremental / recurring (Gama et al. 2014).
- **Scope:** **real drift** (conditional p(y|x) change) vs **virtual/data drift** (marginal p(x) change).

Unsupervised detectors fall into **two-sample** (KS test, MMD; the survey also counts
loss-based and virtual-classifier detectors here), **meta-statistic** (ADWIN, ShapeDD),
and **block-based** (DAWIDD, KCpD) strategies, following a four-stage scheme
(acquisition → descriptor → dissimilarity → normalization). Without labels only
*virtual* drift can ever be detected.

> **Implication for this toolkit (directly actionable, corrected October 2026).** This is
> the science behind the [open backlog item](../README.md#roadmap) on drift monitoring.
> The CUSUM `drift` parameter in `anomaly-detector` is *process drift in the signal*,
> **not** distribution drift — and the CM literature itself uses "drift" for the incipient
> fault, so a toolkit drift monitor must define the term. The earlier recommendation here
> ("run KS/MMD two-sample tests on feature distributions to trigger model refresh") is
> withdrawn: the cited survey itself prefers meta-statistic and block-based detectors,
> warns that feature-wise tests in high dimension produce false alarms and that loss-based
> detection should be avoided when monitoring for anomalies; KS/MMD assume i.i.d. samples,
> which CM streams violate; and a degradation also shifts the feature distribution, so an
> automatic refresh on a drift alarm would learn the damage in. The evidenced design runs
> a context-change detector (speed, load, recipe, sensor swap) *before* the fault detector,
> treats a drift alarm as a request for human confirmation, and prefers periodic
> retraining over reactive triggers — follow-up review, section 7.

*Source:* Frontiers in AI 2024, doi 10.3389/frai.2024.1330257.

### 4d. Macro-trend: Industry 4.0 → 5.0

**Finding (confidence: high · vote 3-0).** PdM/CM is reframing around the **Industry 5.0**
paradigm — **human-centricity, sustainability, resilience** — built on four enabling
technologies: **Machine Learning, Digital Twins, IoT, Big Data**. I5.0 complements rather
than replaces I4.0.

> An edge-deployed, transparent, LLM-augmented toolkit (local Node-RED, no cloud round-trip)
> fits the human-centric/resilient direction well.

*Source:* ScienceDirect S2590123024011903 (2024 systematic review).

---

## Practical implications for this toolkit

| Research finding | Relevance to `node-red-contrib-condition-monitoring` |
| --- | --- |
| EIF (global) + kNN (local) suffice on tabular data; on time series sub-sequence PCA and windowed kNN lead, IF is mid-field | Validates `pca-anomaly` (SPE) more than `isolation-forest-anomaly`. The detector worth adding is a **windowed kNN / Matrix-Profile distance** to a healthy bank, not a local-density (LOF) detector, which is the weakest classical option on time series. |
| HI quality (monotonicity/trendability/prognosability, plus robustness) drives RUL | Add HI-quality scoring to `signal-analyzer` feature output as a selection aid for `trend-predictor`; state which trendability definition is used. |
| UQ is the field's weakness; expose intervals with verified coverage, not point estimates | `trend-predictor` emits an RUL band — keep/surface it, and fix its calibration (covariance term, Fieller-type bound, coverage check) — follow-up review, section 4. |
| Concept drift: meta-statistic/block-based detectors, context gating, no automatic refresh | Backlog drift-monitor item: detect distribution drift (not CUSUM signal drift) behind a context-change gate; a drift alarm asks for confirmation rather than triggering retraining. |
| Deep learning dominates but needs labels; classical competitive in low-data | Keeping classical detectors (Z-score, IQR, IF, PCA) as defaults is sound for label-scarce edge deployments. |
| LLMs for prognosis are proposal-stage, unreplicated | `llm-analyzer` for *alert triage/explanation* is defensible today; LLM-for-RUL is future/experimental. |

---

## Caveats

1. **Preprint risk.** LLM-for-RUL (arXiv 2410.03134, 2501.07191) and the Transformer+wavelet MCSFormer (arXiv 2505.14897) are **arXiv preprints, not peer-reviewed**, reporting self-selected baselines on intra-condition splits — prone to leakage/cherry-picking. Two LLM super-claims were explicitly refuted (below).
2. **Tabular ≠ vibration.** The strongest anomaly-detection evidence (JMLR 23-0570) is on **multivariate tabular** data, not vibration/time-series (CWRU, FEMTO, MFPT). Rankings may not transfer to spectral features. Its "largest comparison to date" is an author claim (contestable vs ADBench, NeurIPS 2022).
3. **Synthetic rankings are dataset-specific** (Scientific African study).
4. **Coverage gaps in the *verified* set — closed in October 2026.** The confirmed claims of this review do **not** directly evidence: vibration signal-processing specifics (envelope/demodulation, cepstrum, EMD, bearing/gear fault frequencies), control charts (CUSUM, EWMA), Weibull/similarity-based RUL, several standards (ISO 13374/13379-1:2025/20816-3:2022 — ISO 10816-3 is withdrawn — MIMOSA OSA-CBM/OSA-EAI), TinyML/edge specifics, XAI, or self-supervised/domain-adaptation as standalone claims. Each of these is now covered, with its own confidence tags, in the follow-up review (sections 1, 2, 4, 6 and 7).
5. **Fetch limitations.** Some MDPI/ScienceDirect URLs returned HTTP 403 and were verified via PMC mirrors or search snippets — text corroborated but not always from the canonical URL.
6. **Concept-drift finding** rested on a single (strong, peer-reviewed) primary source in June 2026; it is corroborated and extended by six further sources in the follow-up review, section 7 — which also withdraws the KS/MMD recommendation drawn from it (section 4c).

---

## Refuted claims

These were extracted from sources but **failed** adversarial verification — do **not** cite as fact:

- ❌ *"The LLM framework surpasses SOTA on C-MAPSS FD002/FD004 and is near-SOTA on the rest."* (vote 1-2) — arXiv 2410.03134.
- ❌ *"With transfer learning, fine-tuning on minimal target-domain data outperforms SOTA trained on full target-domain data."* (vote 0-3) — arXiv 2410.03134.

---

## Open questions

These parts of the original question were **not** covered by verified claims in June 2026. All four are answered in [RESEARCH-pdm-cm-followup.md](RESEARCH-pdm-cm-followup.md) (October 2026); the section numbers refer to that document, and its own "Open questions" section lists what remains open.

1. 2023–2026 peer-reviewed consensus on the relative diagnostic value of **FFT vs envelope/demodulation vs cepstrum vs wavelet/EMD** for bearing/gear faults — **answered, section 1** (envelope analysis with resonance-band selection and cepstral pre-whitening first; no independent evidence favours wavelet/EMD/VMD over it on non-CWRU data; order tracking for variable speed) — and which **standards** (ISO 20816-3:2022 severity zones, ISO 13374/13379, MIMOSA OSA-CBM) the toolkit should conform to — **answered, section 2**.
2. Do the "EIF + kNN suffice" findings **replicate on vibration/time-series** benchmarks, and how do PCA/Mahalanobis and One-Class SVM rank there? — **answered, section 3**: they do not replicate; PCA/SPE-type and OC-SVM rank at or above Isolation Forest, EIF does not.
3. Documented **evaluation/leakage pitfalls** and recommended metrics for C-MAPSS and bearing RUL, and how an edge toolkit should validate trend/RUL models — **answered, section 4** (unit-wise splits, RUL-cap and scoring conventions, Saxena metrics, PICP coverage checks, Fieller-type crossing-time intervals).
4. Maturity/reliability of **LLMs for actual maintenance decisions** — **answered, section 5**: no independent replication of any LLM-for-maintenance result exists as of October 2026; the defensible use is a decision-support draft grounded in tool outputs — and recommended **edge/TinyML deployment patterns** — **answered, section 6**.

---

## Sources

**Primary (peer-reviewed journals / conference / standards):**

- MDPI Sensors 24(11):3454 (2024) — RUL survey — https://www.mdpi.com/1424-8220/24/11/3454 (PMC mirror: https://pmc.ncbi.nlm.nih.gov/articles/PMC11174398/)
- arXiv 2506.20090v1 (2025) — PdM taxonomy survey — https://arxiv.org/html/2506.20090v1
- ScienceDirect S2666827025000878 (2025) — prognostics paradigms — https://www.sciencedirect.com/science/article/pii/S2666827025000878
- Reliability Engineering & System Safety S0951832024004551 (2024) — multi-distribution UQ — https://www.sciencedirect.com/science/article/abs/pii/S0951832024004551
- JMLR v25/23-0570 (2024) — unsupervised anomaly-detection benchmark — https://jmlr.org/papers/v25/23-0570.html
- Scientific African S2468227624003284 (2024) — anomaly detection comparison — https://www.sciencedirect.com/science/article/pii/S2468227624003284
- Frontiers in AI (2024) — concept-drift survey — https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2024.1330257/full
- ScienceDirect S2590123024011903 (2024) — Industry 4.0→5.0 PdM/CM systematic review — https://www.sciencedirect.com/science/article/pii/S2590123024011903
- ScienceDirect S0952197623004967 — anomaly/drift — https://www.sciencedirect.com/science/article/abs/pii/S0952197623004967
- ScienceDirect S0951832023007640 — frontier trends (RESS) — https://www.sciencedirect.com/science/article/abs/pii/S0951832023007640
- Sheppard et al., OSA-CBM/PHM standards — https://www.cs.montana.edu/sheppard/pubs/auto-2018.pdf
- PHM Society PHME articles — https://www.papers.phmsociety.org/index.php/phme/article/view/1487 · https://www.papers.phmsociety.org/index.php/phme/article/download/1647/609
- VTT — MIMOSA for condition-based maintenance — https://cris.vtt.fi/en/publications/mimosa-for-condition-based-maintenance/
- C-MAPSS ML-RUL challenges review — https://www.researchgate.net/publication/353119926
- arXiv 2509.22267, 2407.14625, 2401.07871 — benchmark/foundation-model work
- Springer s11431-025-3072-9 (Gao et al. 2025, TinyML bearing diagnosis on an ESP32-S3 — not a digital-twin paper); MDPI Applied Sciences 16(5):2493 — frontier/digital-twin

**Frontier preprints (NOT peer-reviewed — cite with care):**

- arXiv 2410.03134 — LLM regression for RUL — https://arxiv.org/pdf/2410.03134
- arXiv 2501.07191 — LM4RUL — https://arxiv.org/pdf/2501.07191
- arXiv 2505.14897 — MCSFormer (Transformer + wavelet) — https://arxiv.org/pdf/2505.14897

**Secondary / non-academic:** Wikipedia (CBM by vibration analysis); SSG Insight (ISO standards overview, blog).
