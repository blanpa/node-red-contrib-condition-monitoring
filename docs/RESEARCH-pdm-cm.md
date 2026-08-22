# Predictive Maintenance & Condition Monitoring — Scientific State of the Art (2023–2026)

> A literature-grounded review of PdM/CM methods, focused on peer-reviewed work and
> authoritative sources from 2023–2026. Each finding carries a **confidence** level and
> an adversarial **verification vote** (claims were checked by 3 independent skeptic
> agents; ≥2 refutes kills a claim). Source URLs are listed per finding and consolidated
> at the end. Read the **Caveats** section before quoting any number — several frontier
> results are unreplicated preprints.

**Method:** fan-out web search across 6 angles → 27 sources fetched → 129 candidate
claims extracted → top 25 adversarially verified → 23 confirmed / 2 refuted → synthesized.
Generated 2026-06-16.

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

For **anomaly detection**, the largest peer-reviewed benchmark (JMLR 2024) finds a
**two-algorithm toolbox suffices** — Extended Isolation Forest for global anomalies, kNN
for local — which directly validates an Isolation-Forest-plus-distance-based design like
this toolkit's. The frontier is the **Industry 4.0 → 5.0 shift** (human-centricity,
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
> `pca-anomaly`/Mahalanobis (distance-based) combination is well-aligned with the
> empirical consensus. **Caveat:** the JMLR benchmark is on **tabular** data, *not*
> vibration/time-series (CWRU, FEMTO, MFPT) — rankings may not transfer directly to
> spectral vibration features. See [open question 2](#open-questions).

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

*Source:* PMC11174398 (Sensors 24(11):3454, 2024).

### 3c. Uncertainty quantification is the shared weakness

**Finding (confidence: high · vote 3-0).** Inadequate **uncertainty quantification (UQ)**
is a common limitation of current DL-RUL methods. Most rely on a single probability
distribution assuming one underlying degradation pattern, which lacks robustness for
time-varying degradation. Proposed remedies: **multi-distribution fusion, ensemble, and
Bayesian** approaches (e.g. Zhan et al., RESS 2024, integrate multiple candidate RUL
predictions with learned weights). Much C-MAPSS literature remains deterministic point estimates.

> **Implication for this toolkit.** The `trend-predictor` already exposes RUL **confidence
> intervals** — this aligns with the literature's prescription. Exposing/visualizing those
> bounds prominently is the right design, not a point estimate alone.

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

Unsupervised detectors fall into **two-sample** (KS test, MMD), **meta-statistic** (ADWIN,
ShapeDD), and **block-based** (DAWIDD, KCpD) strategies, following a four-stage scheme
(acquisition → descriptor → dissimilarity → normalization).

> **Implication for this toolkit (directly actionable).** This is the science behind the
> [open backlog item](../README.md#roadmap) on drift monitoring. The CUSUM `drift`
> parameter in `anomaly-detector` is *process drift in the signal*, **not** distribution
> drift. A genuine drift monitor should run **two-sample tests (KS / MMD) on feature
> distributions** (live window vs training baseline) to trigger ONNX/TFJS model refresh.

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
| EIF (global) + kNN (local) two-algo toolbox suffices | Validates `isolation-forest-anomaly` + `pca-anomaly`/Mahalanobis. Consider a kNN/local-density detector to cover *local* anomalies. |
| HI quality (monotonicity/trendability/prognosability) drives RUL | Add HI-quality scoring to `signal-analyzer` feature output as a selection aid for `trend-predictor`. |
| UQ is the field's weakness; expose confidence, not point estimates | `trend-predictor` already emits RUL confidence bounds — keep/surface them. |
| Concept drift needs KS/MMD two-sample tests on feature distributions | Backlog drift-monitor item: implement distribution drift (not CUSUM signal drift) to gate retraining. |
| Deep learning dominates but needs labels; classical competitive in low-data | Keeping classical detectors (Z-score, IQR, IF, PCA) as defaults is sound for label-scarce edge deployments. |
| LLMs for prognosis are proposal-stage, unreplicated | `llm-analyzer` for *alert triage/explanation* is defensible today; LLM-for-RUL is future/experimental. |

---

## Caveats

1. **Preprint risk.** LLM-for-RUL (arXiv 2410.03134, 2501.07191) and the Transformer+wavelet MCSFormer (arXiv 2505.14897) are **arXiv preprints, not peer-reviewed**, reporting self-selected baselines on intra-condition splits — prone to leakage/cherry-picking. Two LLM super-claims were explicitly refuted (below).
2. **Tabular ≠ vibration.** The strongest anomaly-detection evidence (JMLR 23-0570) is on **multivariate tabular** data, not vibration/time-series (CWRU, FEMTO, MFPT). Rankings may not transfer to spectral features. Its "largest comparison to date" is an author claim (contestable vs ADBench, NeurIPS 2022).
3. **Synthetic rankings are dataset-specific** (Scientific African study).
4. **Coverage gaps in the *verified* set.** The confirmed claims do **not** directly evidence: vibration signal-processing specifics (envelope/demodulation, cepstrum, EMD, bearing/gear fault frequencies), control charts (CUSUM, EWMA), Weibull/similarity-based RUL, several standards (ISO 13374/13379/10816/20816, MIMOSA OSA-CBM/OSA-EAI), TinyML/edge specifics, XAI, or self-supervised/domain-adaptation as standalone claims. These appear only contextually — treat as lower confidence than the explicit findings above. See open questions.
5. **Fetch limitations.** Some MDPI/ScienceDirect URLs returned HTTP 403 and were verified via PMC mirrors or search snippets — text corroborated but not always from the canonical URL.
6. **Concept-drift finding** rests on a single (strong, peer-reviewed) primary source.

---

## Refuted claims

These were extracted from sources but **failed** adversarial verification — do **not** cite as fact:

- ❌ *"The LLM framework surpasses SOTA on C-MAPSS FD002/FD004 and is near-SOTA on the rest."* (vote 1-2) — arXiv 2410.03134.
- ❌ *"With transfer learning, fine-tuning on minimal target-domain data outperforms SOTA trained on full target-domain data."* (vote 0-3) — arXiv 2410.03134.

---

## Open questions

These parts of the original question were **not** covered by verified claims and warrant a follow-up, targeted review:

1. 2023–2026 peer-reviewed consensus on the relative diagnostic value of **FFT vs envelope/demodulation vs cepstrum vs wavelet/EMD** for bearing/gear faults, and which **standards** (ISO 10816/20816 severity zones, ISO 13374/13379, MIMOSA OSA-CBM) the toolkit should conform to.
2. Do the "EIF + kNN suffice" findings **replicate on vibration/time-series** benchmarks (CWRU, PRONOSTIA/FEMTO, MFPT, PHM challenges), and how do PCA/Mahalanobis and One-Class SVM rank there?
3. Documented **evaluation/leakage pitfalls** and recommended metrics (RMSE vs PHM scoring asymmetry, run-to-failure splitting) for C-MAPSS and bearing RUL — how should an edge toolkit validate trend/RUL models to avoid optimistic intra-condition results?
4. Maturity/reliability of **LLMs for actual maintenance decisions** beyond proposal-stage preprints (independent replication?), and recommended **edge/TinyML deployment patterns** (ONNX/TFJS quantization, on-device inference) for the DL and drift-detection methods.

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
- Springer s11431-025-3072-9; MDPI Applied Sciences 16(5):2493 — frontier/digital-twin

**Frontier preprints (NOT peer-reviewed — cite with care):**

- arXiv 2410.03134 — LLM regression for RUL — https://arxiv.org/pdf/2410.03134
- arXiv 2501.07191 — LM4RUL — https://arxiv.org/pdf/2501.07191
- arXiv 2505.14897 — MCSFormer (Transformer + wavelet) — https://arxiv.org/pdf/2505.14897

**Secondary / non-academic:** Wikipedia (CBM by vibration analysis); SSG Insight (ISO standards overview, blog).
