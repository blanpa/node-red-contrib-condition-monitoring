# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### 📚 Documentation

- **`docs/RESEARCH-pdm-cm-followup.md`** (October 2026): answers the four
  open questions of the June methods review and its declared coverage gaps —
  which vibration technique for which fault (envelope analysis with
  resonance-band selection and cepstral pre-whitening first; order tracking
  for variable speed), the standards a CM toolkit can realistically conform to
  (ISO 13374 / OSA-CBM vocabulary, ISO 20816-3:2022 zones, ISO 13381-1:2025
  prognosis fields, IDTA 02048), how simple detectors rank on time-series and
  vibration benchmarks, RUL evaluation pitfalls and interval calibration, the
  state of LLM agents for maintenance decisions, edge deployment patterns, and
  drift / domain-shift / explainability — each claim with a confidence and a
  verification tag, plus a consolidated errata table for the two existing
  documents.
- **`docs/RESEARCH-cm-pdm-landscape.md` and `docs/RESEARCH-pdm-cm.md` corrected
  in place** after a claim-by-claim verification: the benefit table had
  credited Deloitte with ranges it never published (Deloitte: 5–10 % cost,
  10–20 % uptime, 20–50 % planning time), three market-report rows were under
  the wrong vendor, ISO 13379-1 and ISO 20816 part lists were out of date, the
  OSA-CBM / ISO 13374 relationship was reversed, the TinyML figures merged two
  papers, the EU AI Act dates predated the 2026 Digital Omnibus, CWRU has 4–5
  fault sizes, the Azure PdM data has 1 000 machines, and the methods review's
  KS/MMD drift recommendation contradicted its own source. The `trend-predictor`
  band is now described as what it is (a delta-method interval that
  under-covers) and the Isolation-Forest "validation" is qualified to the
  PCA/SPE detector. README links the new document.

## [0.4.0] - 2026-10-05 - Code-review pass over all nodes

A minor release rather than a patch: several nodes now produce different (the
corrected) results — see "Changed behaviour".

### ✨ Added (this release)

- **Group By for `anomaly-detector` and `trend-predictor`** (`groupBy`,
  `maxGroups`): one independent state per device on an interleaved stream, as
  `signal-analyzer` already had. In `anomaly-detector` it combines with regimes
  (one baseline per device and operating point). `health-index`, `pca-anomaly`,
  `isolation-forest-anomaly` and `multi-value-processor` gained the same
  setting. All seven nodes share `nodes/utils/group-state.js`.
- **`anomaly-detector`: CUSUM in standard deviations** (`cusumMode: "sigma"`,
  the default for new nodes). Drift and thresholds are multiples of the
  window's σ, so one setting fits any signal scale. Existing flows keep the
  signal-unit behaviour (`"raw"`).
- **`trend-predictor`: trend fitted over time**, not over the sample index, so
  gaps and irregular sampling no longer bend the RUL (`timeBased` in the
  result; falls back to the index when timestamps do not increase).
- **`multi-value-processor`: state persistence** (`persistState`).
- `msg.config` overrides apply to multi-sensor object payloads in
  `anomaly-detector` and `trend-predictor`.
- `nodes/utils/signal-processing.js`: the signal-analyzer's FFT, filters,
  cepstrum and diagnosis rules as pure, directly tested functions.
- The dev `docker-compose.yml` maps `host.docker.internal` on Linux, so the
  end-to-end suite's llm-analyzer tab reaches the demo mock.
- `tools/build-test-suite.js` fills every node with its editor defaults (the
  imported suite no longer shows blank select fields) and has a σ-CUSUM test:
  49 tests.

### 🧹 Changed (this release)

- **Quartiles use the interpolated percentile** (`utils/statistics`):
  `calculateQuartiles` now agrees with `calculatePercentile` and
  `calculateMedian` (for `[1, 2, 3, 4]`: q1 1.75, median 2.5, q3 3.25 instead of
  2 / 3 / 4). The IQR bounds of `anomaly-detector` shift slightly.
- **`signal-analyzer`: a cepstral line is reported as the gear-mesh frequency
  or as one sideband**, whichever is closest — not as all candidates within
  tolerance at once.
- **`multi-value-processor`:** a constant sensor in correlate mode reports
  `correlation: null` with a `reason` and is not anomalous; the analyze
  z-score uses a running accumulator (≈60× faster at large windows).
- **`condition-monitoring-source`:** fault descriptions and the RUL label are
  English (`"stabil"` → `"stable"`).
- **`llm-analyzer`, `training-data-collector`:** ISO-date-shaped strings are no
  longer read as the number of their year.
- **WebSocket `getStats`** no longer returns client addresses; the
  anomaly-detector warns when WebSocket output is enabled without a token.
- Removed options that never did anything: `removeOutliers` /
  `outlierThreshold` (training-data-collector), `batchSize` (ml-inference),
  `vibOutputMode` (signal-analyzer). Flows that still carry them load unchanged.
- `ml-inference.js` split: MLflow helper/tracker and download/registry helpers
  live in `ml-inference-mlflow.js` / `ml-inference-download.js`; the two HTTP
  bridges share `utils/json-http-client.js`; `mulberry32` lives once in
  `utils/seeded-random.js`.
- Tests: older specs assert computed values instead of property presence;
  random test data is seeded.

### ⚠️ Changed behaviour (code-review pass over all nodes)

Fixes below change results or output for existing flows. Each is the corrected
behaviour; config keys and output field names are unchanged unless noted.

- **`anomaly-detector`:** a sample is scored against the window *before* it,
  once that window holds 10 values (or is full). Scored within its own window
  the z-score was capped at `sqrt(n − 1)`, so a window of 10 could never reach
  a threshold of 3. Outliers now score far higher; a step off a perfectly flat
  baseline is an anomaly. EMA compares against the average before the sample.
- **`signal-analyzer`:** the Overlap setting now takes effect — a
  sample-by-sample stream is analysed when the buffer fills and then every
  `fftSize × (1 − overlap)` samples instead of on every sample (array payloads:
  once per message, as before). FFT mode removes the window mean (reported as
  `dcOffset`). Peaks mode uses **Min Peak Height** (empty = mean ± 2σ) rather
  than the FFT's relative peak threshold. Cepstrum no longer assumes 1800 rpm
  when no shaft speed is known (no gear diagnosis instead). Bearing-fault
  `severity` is relative to the noise floor, not an absolute magnitude.
- **`trend-predictor`:** "no trend" is decided statistically (slope within two
  standard errors of zero) instead of by an absolute slope of 0.0001 per
  sample. The exponential model is a real exponential fit; Weibull uses the
  configured β and η. Non-numeric payloads such as `"12abc"` are rejected.
- **`pca-anomaly`:** SPE and contributions are computed correctly, limits are
  F / chi-squared based (the `threshold` setting now moves them), features are
  matched by name, and the model retrains on normal data (`retrainMode: "off"`
  freezes it).
- **`isolation-forest-anomaly`:** `numEstimators` / `maxSamples` take effect,
  the threshold is calibrated at training time, batch mode retrains per window.
- **`health-index`:** `dynamic` mode no longer down-weights a persistently
  anomalous sensor; weight 0 excludes a sensor; a payload with no usable
  reading emits nothing instead of 100 / healthy.
- **`multi-value-processor`:** Mahalanobis scores against the history before
  the sample with an F-based limit; cross-correlation reports the largest
  `|r|` and the lead/lag text the right way round.
- **`llm-analyzer`:** `msg.apiUrl` is ignored unless **Allow msg.apiUrl
  override** is enabled (then same-origin only). The Gemini key travels in the
  `x-goog-api-key` header, the `openai` provider sends
  `max_completion_tokens`. A batch that failed transiently is retried.
- **`training-data-collector`:** export file names carry milliseconds and a
  sequence suffix; time-series CSV has `t<i>_<feature>` columns; the editor's
  split percentages now reach the runtime; S3 keys live in node credentials.
- **`ml-inference`:** registry cache files keep their real extension, multipart
  posts to `/ml-inference/upload` return 415, a failed auto-update keeps the
  loaded model, the Python sidecar survives deploys.

### 🐛 Fixed (code-review pass over all nodes)

- **The "debug" option broke five nodes and silently disabled their state
  persistence.** `anomaly-detector`, `trend-predictor`, `pca-anomaly`,
  `isolation-forest-anomaly` and `multi-value-processor` stored the flag in
  `node.debug`, overwriting Node-RED's logger method. With debug on every
  message failed with "node.debug is not a function"; with it off, restoring
  persisted state threw inside the persistence layer and the state was
  discarded. The flag now lives in `node.debugEnabled`.
- **Crashes of the whole runtime:** the ml-inference status routes answered
  twice when no Python was installed; a non-JSON stdout line or an `EPIPE` from
  the Python sidecar, and a busy WebSocket port or two WebSocket-enabled nodes,
  raised unhandled `error` events. A vision-annotator box with a non-finite
  coordinate looped forever.
- **`signal-analyzer`:** cepstrum quefrencies were half their true value (a
  50 Hz harmonic family read as 100 Hz); FFT and vibration windows above
  ~10^5 samples overflowed the stack; an envelope band above Nyquist was
  replaced silently (now clamped or reported once, with the band and filter
  used in the output); the cepstrum panel's shaft-speed field was a duplicate
  element that was never saved. FFT peaks carry a physical `amplitude`. The
  cepstrum transform and the envelope low-pass are O(n log n) / O(n).
- **`anomaly-detector`:** multi-sensor hysteresis counted non-consecutive
  anomalies; the threshold warning band was unreachable for negative limits;
  `iqrWarningMultiplier` was ignored; only the active regime was persisted;
  `msg.reset` left per-sensor EMA/CUSUM state; malformed `msg.config` values
  disabled checks; WebSocket listeners leaked on every redeploy; batch mode
  failed on large or malformed arrays.
- **`trend-predictor`:** RUL supports falling indicators (**Failure
  Direction**); the `cycles` unit returned milliseconds; a lower bound of 0 was
  reported as `null`; the median filter pulled both ends of a trend inward
  (RUL read late); rate-of-change acceleration used the wrong time base; the
  RUL panel's window-size field was a duplicate element that was never saved.
- **`llm-analyzer`:** the request timeout did not cover the response body;
  `persistState` never wrote anything; an in-flight request outlived a redeploy.
- **`training-data-collector`:** auto-saves within one second overwrote each
  other; samples arriving during an export were lost; a failing export was
  retried on every message; a small window with high overlap never slid;
  streaming files grew without bound (`maxStreamFileMB`, `maxFiles`).
- **`ml-inference`:** editor uploads stored the multipart body as the model;
  TF.js uploads above 5 MB were rejected; downloads could hang forever;
  registry sources only worked for ONNX; a crashed sidecar was never restarted;
  concurrent loads raced; MAX / SavedModel / ONNX sessions were not released;
  the `python-status` package probe never ran.
- **`health-index`, `multi-value-processor`, `pca-anomaly`,
  `isolation-forest-anomaly`:** optional per-device state (`groupBy`,
  `maxGroups`), non-finite inputs no longer poison a window, unchecked
  `msg.config` overrides and weights are validated, `send` / `done` are used
  throughout.
- **Shared:** `path-validator` rejects a new file behind a symlinked parent;
  state arriving before the persisted state has loaded is no longer
  overwritten; close handlers always call `done()`.

### ✨ Added

- **`signal-analyzer`: ISO 20816-3 machine groups.** The vibration-severity
  table now rates by machine *group* (1: 300 kW – 50 MW, 2: 15 – 300 kW) and
  *foundation* (rigid / flexible), as ISO 10816-3 / 20816-3 prescribe. New nodes
  default to `group2_rigid`; the four legacy ISO 10816-1 classes remain
  selectable so existing flows evaluate exactly as before. The result is emitted
  as `payload.iso20816` with a `standard` field; `payload.iso10816` stays as an
  alias of the same object.
- **`signal-analyzer`: bearing fault frequencies from geometry.** Enter rolling
  elements, element and pitch diameter and contact angle and the node derives
  BPFO / BPFI / BSF / FTF from the current shaft speed. Typed-in frequencies win
  over derived ones; `bearingFreqs.source` reports `manual`, `geometry`,
  `mixed` or `none`.
- **`signal-analyzer`: shaft speed per message.** `msg.rpm` (also
  `msg.shaftSpeed`, `msg.config.shaftSpeed`) overrides the configured RPM in
  vibration, envelope and cepstrum mode, so variable-speed drives get correct
  fault frequencies. Bearing values can be overridden through `msg.config` too.
- **`signal-analyzer`: three diagnostic rules in envelope mode.** BPFI harmonics
  with ±1X / ±2X sidebands (`BPFI-Sideband`, an inner-race defect running through
  the load zone), four or more harmonics of 1X (`Looseness`), and 0.38–0.48X
  components (`SubSynchronous`: oil whirl or rub, suppressed when the peak matches
  the configured cage frequency).
- **`anomaly-detector`: operating-point regimes.** `regimeProperty` names a
  message property (e.g. `regime`, `payload.speedClass`); the detector keeps one
  independent baseline per value — window, EMA, CUSUM, hysteresis counters and
  per-sensor buffers — so a load change switches baselines instead of alarming.
  `maxRegimes` (default 20) bounds memory with LRU eviction; `msg.reset = "all"`
  clears every regime. Outputs are tagged with `msg.regime`.
- **Real run-to-failure test fixture.** `tools/build-pronostia-fixture.js`
  reduces the PRONOSTIA / FEMTO-ST Bearing1_1 run (IEEE PHM 2012) to 58
  per-snapshot indicators (`test/fixtures/pronostia-bearing1_1-trend.json`,
  17 kB). `test/degradation-fixture_spec.js` drives `anomaly-detector` and
  `trend-predictor` with that real degradation curve instead of synthetic ramps.
- **`signal-analyzer`: envelope peaks are judged against the local noise
  floor.** A line must exceed `envelopePeakFloor` (default 8) × the 30th
  percentile of the magnitudes in its ±0.4 % neighbourhood; the envelope mean is removed before
  the FFT. Matching tolerance is 5 % but at most 0.15 × shaft frequency and at
  least 1.5 bins, harmonics of a bearing line count only with the fundamental,
  BPFI sidebands only around a found BPFI harmonic, and a line on a shaft
  harmonic is flagged `coincidesWith1X`. Calibrated on simulated impact trains
  (`tools/sim/`): healthy signals produce no lines up to σ = 0.1 g, an
  outer-race defect BPFO only, an inner-race defect BPFI with ±1X sidebands
  only, looseness 1X harmonics only.
- `tools/sim/`: physically motivated simulations (bearing impact trains with
  resonance, slip and load modulation; accelerometer waveforms for the ISO
  rating; a two-speed pump for regimes; a Monte-Carlo coverage check of the RUL
  band) that drive the real nodes and print reports. See `tools/sim/README.md`
  for what they showed.
- `nodes/utils/vibration.js`: ISO severity tables, bearing formulas, spectral
  integration and an inverse-normal quantile, unit-tested in
  `test/utils-vibration_spec.js`.
- README: an ISO 13374 block map of the nodes, and a note for NIS2 / IEC 62443
  operators in the Security section. `docs/RESEARCH-cm-pdm-landscape.md`
  (standards, measurement techniques, market, barriers, trends) joins the
  existing methods review.

### 🐛 Fixed

- **`signal-analyzer`: the severity table was labelled ISO 10816-3 but held the
  ISO 10816-1 / ISO 2372 class I–IV limits** (0.71 / 1.8 / 4.5 mm/s for class I
  and so on). ISO 10816-3 has no classes; it rates by machine group and
  foundation with different values. The old classes are now correctly labelled
  as legacy ISO 10816-1 and the 20816-3 groups added (see *Added*).
- **`signal-analyzer`: acceleration-to-velocity conversion for the ISO rating
  assumed a single frequency.** RMS acceleration was divided by 2πf at the shaft
  frequency, which is only right when the signal is dominated by 1X — bearing
  and gear content at higher frequencies made the rating far too pessimistic
  (or, with the old 50 Hz fallback, arbitrary). The node now integrates the
  spectrum bin-wise (v = a / 2πf) over the 10–1000 Hz band the standard
  prescribes, using the configured sampling rate — for frame (array) payloads,
  which are the only input that is actually a waveform. Scalar streams and
  sampling rates that cannot support the band keep the single-frequency
  relation, and the result says which path was taken (`conversion`).
- **`trend-predictor`: the configured confidence level had no effect.** The RUL
  interval was hard-wired to 1.96 σ (95 %), so selecting 99 % still produced the
  95 % band. The level is now turned into a two-sided z-score (0.90 → 1.645,
  0.99 → 2.576) for both the linear and the Weibull path, and reported as
  `rul.confidenceLevel`.
- **`trend-predictor`: the RUL point estimate was biased late.** The "current
  value" fed into the extrapolation was the moving-average-smoothed last sample;
  the centred window is truncated at the end of the buffer, so that value lags
  the trend by about half a window and the RUL came out optimistic. The level
  is now the Theil-Sen intercept at the last index (median of
  `y[i] + slope·(n−1−i)`, no lag, robust), the slope is estimated on the
  median-filtered rather than the moving-average series for the same reason,
  and the interval is a delta-method interval for the *crossing time* (level
  and slope uncertainty, growing with the distance to the threshold) instead
  of a prediction interval for the next observation. Monte-Carlo on a noisy
  linear wear model: bias dropped from ≈ +3 % to ≈ +2 %, 90 % band coverage
  rose from 63–80 % to roughly 75–80 %, 99 % band from 87–90 % to ≈ 90 %.
  `currentLevel` is added to the RUL result.

### 🔒 Security

- **All `RED.httpAdmin` routes are now permission-guarded.** Node-RED does not
  apply `adminAuth` to routes a node registers itself — 17 of the 18 routes in
  this package had no `RED.auth.needsPermission()` guard and stayed reachable on
  the editor port even with adminAuth configured. They now require
  `<node>.read` / `<node>.write`. The new `nodes/utils/admin-auth.js` wrapper
  **fails closed** (401) when `RED.auth` is unavailable, and a test asserts
  structurally that no unguarded registration can be added back.
- **`POST /ml-inference/upload-tfjs`: arbitrary file write (path traversal).**
  TF.js weight-shard names came straight from the request body into
  `path.join(modelDir, w.name)`, so a weight named `../../…` wrote anywhere the
  Node-RED process could reach. All request-supplied names — weight shards, the
  model name, `x-filename`, and the delete/versions route parameters — now go
  through `safeChildPath()`, which strips directory components and re-validates
  the result against the allowlist in `utils/path-validator`.
- **Model uploads are size-capped.** Both upload endpoints buffered the entire
  request body in memory with no ceiling. The limit is 128 MB, configurable via
  `mlInferenceMaxUploadBytes` in `settings.js`; over-sized requests get a 413
  instead of an OOM.
- **`GET /ml-inference/registries/mlflow/models` validates its target.** The
  operator-supplied `registryUri` was fetched unchecked, making the editor port a
  request proxy. Non-`http(s)` schemes, malformed URLs and URL-embedded
  credentials are now rejected, and `mlInferenceAllowedRegistryHosts` in
  `settings.js` pins the registry host when set. The MLflow token moved from the
  query string (which lands in proxy logs and browser history) to an
  `x-mlflow-token` header. Responses are capped at 8 MB with a 15 s timeout.
- **`llm-analyzer` warns when the API key is in the node config**, where it is
  stored in plain text in `flows.json` and every flow export. Credentials remain
  the supported path. Mirrors the existing S3 warning in `training-data-collector`.

### 🐛 Fixed

- **Model uploads hung behind Node-RED's admin body parser.** Both upload routes
  read the raw request stream, but Node-RED mounts body parsers on the admin
  router — with the stream already drained, `data`/`end` never fired and the
  JSON `upload-tfjs` request hung until it timed out. The handlers now use the
  parsed body when one exists and only stream as a fallback.
- **`GET /ml-inference/registries/mlflow/models` forced `https`**, so an
  `http://` MLflow registry could never be reached. It now shares the node's own
  MLflow client, which honours the URL's scheme.
- **The persistence throttle never throttled.** Four nodes gated their periodic
  state save on `buffer.length % 10 === 0`, but the buffer is capped — once it
  saturates that expression is a constant, so the save fired on *every* message
  (any window size that is a multiple of 10, including the default 100) or on
  *none*. Replaced with a monotonic sample counter in `anomaly-detector`,
  `health-index` and `trend-predictor`.
- **Integration harness: the EADDRINUSE retry left every consumer on the old
  port.** `startRed()` re-listened on a fresh port but still reported and
  substituted (`$RED_PORT`) the first one it tried.

### ⚡ Performance

- **`anomaly-detector` no longer rebuilds its window on every message.** The hot
  path called `dataBuffer.map()` per sample and then re-reduced the result. A
  `windowValues` array is now maintained in lockstep with the buffer, and the
  moment-based methods (z-score, EMA, CUSUM, moving-average) read mean/σ from a
  Welford accumulator in O(1) — the `RunningStats` class that already existed in
  `utils/statistics` but had no production consumer. The accumulator is rebuilt
  once per full window turnover, which bounds the reverse-update drift; tests
  assert the streaming figures and the resulting anomaly decisions match the
  canonical batch computation sample for sample.
- **`windowSize` is capped at 100 000 instead of 1 000 000.** Every sample walks
  (and for the order-statistic methods sorts) the live window, so the old ceiling
  made a single message cost a million-element pass.

### 🧹 Changed

- **`ml-inference.js` split** — the ~575 lines of HTTP surface moved to
  `nodes/ml-inference-admin.js`, which takes the runtime state it needs by
  injection. The node module drops from 2618 to ~1900 lines and the security
  posture of the admin API is reviewable in one file.
- **`utils/message.js`** — the "copy the incoming message's properties onto the
  outgoing one" loop was duplicated verbatim 12 times across six nodes. Now one
  `copyPassthrough()` with the two variants (`includePayload`, `preserveTopic`)
  the call sites actually needed.
- **CI installs with `npm ci`**, not `npm install` — the lockfile is tracked
  precisely so it can be enforced. Both workflows also declare a least-privilege
  `permissions: contents: read` default.
- **Coverage gate raised** from 55/45/55/55 to 60/51/64/61, measured the way CI
  measures it — with `--omit=optional` (64.8/55.8/70.4/66.0). The margin is wide
  on purpose: one run came in ~4.5 points low and did not reproduce, so the gate
  sits below that outlier rather than just below the typical reading.
- **Test Runner settle delay raised 12 s → 45 s** and made configurable via
  `TEST_SUITE_SETTLE_SECONDS`. The delay is a ceiling, not a measurement:
  `/test` always waits that long and reports whatever answered in the meantime,
  so a short one turns a slow test into a *false negative*. On a cold run — 23
  ONNX sessions opening at once with ~52 MB of pretrained weights still outside
  the page cache — 12 s under-reported (22 of 48 tests, `ok: false`, with every
  chain actually working). `tools/build-test-suite.js` also refuses to overwrite
  the committed suite with a partial one when the `test-models/` fixtures are
  missing (it used to silently drop 11 tabs), and the stale "3s settle"
  description on the runner comment is corrected.
- **Removed `.npmignore`.** The `files` allowlist in `package.json` takes
  precedence, so the file had no effect — verified with `npm pack --dry-run`,
  which lists an identical 69 files with and without it.

---

## [0.3.2] - 2026-08-23 - Per-device signal buffers

### ✨ Added

- **`signal-analyzer`: one buffer per device (`groupBy`)** — a single node can now
  serve an interleaved stream from many machines. Set **Group By** to a message
  property (typically `topic`, nested paths like `payload.deviceId` work too) and
  the node keeps an independent sample buffer per value, emitting one result per
  device tagged with `msg.group`. Works in all five modes (fft, vibration, peaks,
  envelope, cepstrum). **Max Groups** (default 50) caps memory by dropping the
  least recently used buffer. Leaving `groupBy` empty preserves the previous
  single-buffer behaviour. Closes [#25](https://github.com/blanpa/node-red-contrib-condition-monitoring/issues/25).
- **`signal-analyzer`: `msg.reset` is now group-scoped** — `msg.reset = true`
  clears the buffer of the group the message belongs to (the single buffer when
  grouping is off, i.e. unchanged); the new `msg.reset = "all"` clears every group.

### 🐛 Fixed

- **`signal-analyzer`: restoring a persisted buffer silently failed.** The node
  assigned its `debug` config flag onto `this.debug`, overwriting Node-RED's own
  `node.debug()` logger. State persistence logs through that method, so every
  restore threw inside the deserialize `try` and the saved buffer was discarded
  (enabling Debug Mode broke the node's own logging the same way). The flag now
  lives on `node.debugEnabled`.
- Persisted signal buffers are stored per group (format `version: 2`). State
  written by earlier versions is migrated into the ungrouped buffer on load, and
  the stale flat keys are dropped.

### 🔒 Dependencies

- Lockfile refreshed with a plain `npm audit fix` (no `--force`, `package.json`
  untouched): 37 → 29 advisories. Notable in-range moves: node-red 4.1.11 →
  4.1.13, axios 1.16 → 1.19, tar 7.5.11 → 7.5.22, form-data, ip-address,
  fast-uri, brace-expansion, js-yaml and the babel toolchain.
- `onnxruntime-node` is held at 1.24.3 in the lockfile: 1.27.0 aborts the jest
  worker (SIGABRT) in the ML path-validation integration flow on the CI runner.
  The declared range stays `^1.24.3`.
- The remaining advisories all sit in dev or optional dependencies and need
  breaking changes to clear (jsonata via node-red 4.x, tar via npm's bundled
  tree, adm-zip via the optional ML runtimes).
  `npm audit --omit=dev --omit=optional --audit-level=high` stays at **0**.

### 📚 Documentation

- `docs/API.md`: the Signal Analyzer message interfaces were rewritten against
  the actual implementation. The documented FFT output was wrong (it showed
  `payload.frequencies` / `payload.spectral` / `sampleRate` / `windowSize`,
  none of which the node emits) and the Vibration ISO 10816 block did not match
  the emitted fields. Peaks mode and the per-device grouping are now documented.

---

## [0.3.1] - 2026-06-15 - Data sources, vision pipeline & hardening

### ✨ Data sources for testing every node (incl. vision)

- **`condition-monitoring-source`** gained a **waveform** output mode: besides the
  trended scalar KPIs it can emit a raw vibration time-signal (configurable
  `sampleRate`/`frameSize`) with the fault components at their characteristic
  orders (imbalance 1×, misalignment 2×, looseness, bearing impacts at BPFO) so
  `signal-analyzer` (FFT/envelope/kurtosis) can be exercised — its FFT recovers
  the fault frequency. `signal-analyzer` FFT/envelope/cepstrum now also accept a
  whole frame (array) in one message.
- **New node `image-source`** — synthetic inspection-image generator (the visual
  counterpart of condition-monitoring-source): textured surface with configurable
  defects (spot/scratch/multi), severity, noise, optional degrade-over-time, a
  ground-truth mask and a deterministic seed. Drives the whole vision pipeline
  (`image-source → image-preprocess → ml-inference → vision-annotator`).
- **New node `json-source`** — generic structured-data (JSON record) simulator:
  user-defined fields (mean/noise/trend/min/max, constants), optional anomaly
  injection, deterministic seed. Drives the object/record nodes
  (multi-value-processor, health-index, pca-anomaly, training-data-collector,
  llm-analyzer record mode). Together the three sources cover every node.

### ✨ New Nodes: `image-preprocess` + `vision-annotator` (computer-vision pipeline)

Two pure-JS nodes (deps: `pngjs`, `jpeg-js` — no native build) that let
`ml-inference` work on real images end-to-end:

- **`image-preprocess`** — decode PNG/JPEG → resize (bilinear/nearest) →
  normalize (`0-1`/`0-255`/`-1..1`/`imagenet`/`custom`) → NCHW/NHWC tensor;
  keeps the resized image on `msg.image` for overlays.
- **`vision-annotator`** — renders model output as an annotated PNG +
  structured `msg.annotations`. 9 modes: `boxes`, `obb`, `segmentation`,
  `instances`, `polygons`, `keypoints`, `heatmap`, `anomaly`, `classification`
  (with measurements: areas, perimeter, anomaly fraction, …). Live in-editor
  thumbnail under the node (double-click to enlarge).
- `ml-inference` now also reports the output tensor shape on
  `msg.mlInference.outputShape`.

A self-validating example flow `examples/test-suite.json` exercises every node
and annotation mode with synthetic **and real pretrained models** (SqueezeNet,
YOLOv10, YOLOv8-pose, Depth-Anything). Fetch models via `tools/fetch-models.sh`;
`GET /test` runs all checks, `GET /gallery` shows the annotated images. Jest
specs added for both new nodes.

### ✨ New Node: `condition-monitoring-source`

A synthetic **data source** for condition monitoring and predictive
maintenance demos, testing and prototyping. It streams the sensor data of
a degrading machine instead of consuming it.

**What it does:**
- Models machine **health (0–100%)** decaying over time via
  `degRate × loadFactor × (1 + Σ fault severity)`.
- Derives **vibration RMS, temperature, current and pressure** from health,
  load and active faults, with adjustable measurement noise.
- Injects four fault signatures at their characteristic orders relative to
  shaft frequency: **imbalance (1×), misalignment (2×), bearing (~3.5×),
  looseness (0.5×)**.
- Emits **status** (normal/warning/alarm) against ISO 10816-style
  thresholds and an estimated **remaining useful life (RUL)**.

**Control & configuration:**
- Stream control via `autoStart`, an interval timer, or manual inject;
  commands `start` / `stop` / `reset` (string payload or `msg.start/stop/reset`).
- Live reconfiguration via `msg.config` (load, faults, noise, thresholds,
  interval); `msg.emit = true` also emits a sample immediately.
- Configurable failure policy (reset / stop / continue) and an optional
  integer `seed` for reproducible streams.
- Output as a full condition object or just the vibration value.

Registered in `package.json`, documented in the README, ships with example
flow `examples/11-condition-monitoring-source.json` and a Jest spec
(`test/condition-monitoring-source_spec.js`).

### 🔒 Security

- **`training-data-collector`** — closed two path-traversal vectors: the
  configured `datasetName` is now sanitized (basename + character allowlist)
  before being used in stream/export filenames, and the admin download endpoint
  (`/training-data-collector/download/:filename`) strips directory components and
  verifies the resolved path stays inside the data directory.
- **`json-source`** — the `fields` spec (both static config and the `msg.config`
  runtime override) is validated and stripped of prototype-pollution keys
  (`__proto__`, `constructor`, `prototype`); non-object/array specs are rejected.

### 🐛 Fixed

- **`condition-monitoring-source`** — debug logging overwrote Node-RED's
  `node.debug()` method with a boolean, throwing `TypeError` whenever debug was
  enabled (uncaught in `stop`/`reset`/failure-policy paths). Renamed the flag to
  `debugEnabled` and route through `node.log()`.
- **`ml-inference`** — the previously loaded model is now disposed/unloaded
  before an auto-update or `msg.loadModel` reload (tensor / native-session /
  bridge-model leak); warmup disposes multi-output tensor arrays; the model
  download stream now has an `error` listener so disk errors reject instead of
  crashing the process.
- **`ml-inference` — MLflow / registry model sources now load on startup.**
  Previously the model was only auto-loaded when a `modelPath` was set, so the
  `mlflow`, `huggingface` and `custom` registry sources never initialised (the
  node sat at "no model configured" and inference failed). Plus two MLflow
  registry fixes: the registry client now picks http/https from the registry URI
  scheme (a plain-http registry such as `http://mlflow-server:5000` no longer
  fails against a hardcoded https client), and "latest"/stage resolution now
  calls the correct `POST /api/2.0/mlflow/registered-models/get-latest-versions`
  endpoint instead of a non-existent `latest-versions/get`. Non-HTTP artifact
  sources (`s3:`, `dbfs:`, `mlflow-artifacts:`, …) now produce a clear error
  instead of an opaque failure. Added integration tests against a mock MLflow
  server covering registry resolution (latest/stage + specific version) and the
  tracking lifecycle (experiment/run creation, param + metric logging, end-run).
- **`signal-analyzer`** — ISO 10816 acceleration→velocity conversion now derives
  the frequency from the configured `shaftSpeed` instead of a hardcoded 50 Hz
  (falls back to 50 Hz only when no shaft speed is set); `sampleEntropy` is
  capped to the most recent 2000 samples (O(n²) guard); cepstrum rahmonics
  guarded against an empty/zero spectrum (no more NaN normalization).
- **`trend-predictor`** — the RUL confidence interval now uses the smoothed
  current value (consistent with the point estimate, so the interval brackets
  the RUL).
- **`pca-anomaly`** — replaced the ad-hoc percentile formula that degenerated to
  the 0th percentile (flagging nearly everything) at low thresholds with a proper
  normal-CDF mapping of the sigma-like threshold.
- **`health-index`** — `geometric` aggregation guarded against an empty score set
  (returned `NaN`).
- **`multi-value-processor`** — correlation result is validated before formatting
  (an unknown `correlationMethod` previously crashed on `null.toFixed()`).
- **`state-persistence`** — `load()` uses the async callback form of
  `context.get`, so persistence works with asynchronous context stores (e.g. the
  file store), not just synchronous ones.
- **`python-bridge-manager`** — on a startup timeout the spawned Python process
  is now killed directly instead of attempting a graceful shutdown that could
  leave it running.
- **`image-preprocess`** — bilinear resampling clamps all corner indices and
  weights, fixing fragile edge behaviour at sub-pixel sample positions.
- **`vision-annotator`** — scalar-field renderers now error on a declared shape
  larger than the data instead of silently producing `NaN` metrics.
- **Node-RED lifecycle** — `anomaly-detector`, `trend-predictor`,
  `isolation-forest-anomaly` and `pca-anomaly` input handlers now use the
  `(msg, send, done)` signature and call `done()`/`done(err)` on every path;
  `image-source`/`json-source` close handlers invoke their `done` callback.

### 📝 Documentation

- README: corrected the Signal Analyzer `msg.config` keys (removed `fftSize`/
  `sampleRate`, which are not honored at runtime) and the Health Index
  `aggregationMethod` example (`min` → `minimum`); fixed the version tagline and
  test count; translated the GPU-acceleration section to English; removed the
  obsolete v0.1.x→v0.2.0 migration guide; redesigned the architecture diagrams
  (grouped sources, category colour-coding, fixed disconnected nodes).

---

## [0.3.0] - 2026-06-12 - LLM Analyzer Node (Phase 1–5)

### ✨ New Node: `llm-analyzer`

A flow-time LLM analysis node that buffers samples and asks an LLM to
analyse them. The result flows back into the Node-RED pipeline as a
`msg.payload` — text in plain mode, structured object (or extracted
field) in JSON mode. Replaces the briefly-explored `mcp-bridge` (passive
MCP server, withdrawn the same release window in favour of this active
in-flow analyser).

**Five providers, one contract:**
- Anthropic (Claude — `x-api-key` header)
- OpenAI (GPT — Chat Completions)
- Google (Gemini — generateContent)
- Ollama (local — no key needed)
- OpenAI-compatible (Groq, Together, OpenRouter, DeepSeek, Mistral, vLLM, LMStudio …)

**Three trigger modes:**
- `batch` — fire when N samples accumulated
- `manual` — fire on `msg.flush === true`
- `interval` — fire every X ms on whatever's buffered

**Two input modes:**
- `scalar` — one numeric value (or array) per msg
- `record` — multi-sensor objects, auto-detects numeric columns
  (skipping common timestamp/id field names) or honours an explicit
  allowlist

**Two output modes:**
- `text` — `msg.payload` = LLM string
- `json` — operator pastes example JSON into the schema field; node
  appends an instruction to the system prompt and parses the response
  with a tolerant extractor (markdown fences, prose-wrapped objects,
  braces inside strings all handled). Optional `outputPath` (dot-notation)
  extracts a single nested field.

**Production hardening:**
- `maxBufferSize` — hard ring-buffer cap (default 10 000)
- `maxSamplesInPrompt` — token-cost knob (default 100)
- `persistState` — buffer + counters survive redeploys
- Lifetime cost tracking on `msg.totalUsage` + status line
- Concurrency-safe — triggers during in-flight calls are queued, never dropped

**Configuration is fully self-contained** — API keys via Node-RED
credentials (encrypted on disk), per-provider URL/model defaults adjust
automatically when the operator picks a provider. Editor UI matches the
rest of the `condition-monitoring` family (collapsible `cm-section`
cards, gradient headers, `#9482f1` family colour). A "Preview rendered
prompt" button shows the operator what will actually go to the LLM.

**Test coverage:** 82 unit tests + 3 integration tests against a real
Node-RED runtime via the existing harness.

**Demo stack:** `docker-compose.demo.yml` starts a Node-RED container
plus a small mock-Anthropic sidecar so the five demo flows
(temp / vib-with-anomaly / manual / multi-sensor / json-scorer) run
without needing a real API key.

See `docs/SPEC-llm-analyzer.md` for the full design contract.

### 🐛 Fixed (pre-release hardening pass)

- **ml-inference**: outgoing msg is now deep-cloned — a nested
  `outputProperty` previously mutated the original message
- **signal-analyzer**: input handler uses the `(msg, send, done)`
  signature so message tracking and catch-node correlation work
- **llm-analyzer**: error containment covers prompt building (a throw
  there left the node stuck in-flight); interval timer is unref'd
- **python-bridge**: ready-signal race on fast startup, ignored
  `pythonPath` option, dead SIGKILL fallback, candidate double-callback
- **max-bridge**: 4xx responses with JSON error bodies were retried
- **Memory bounds for long-running flows**: FFT instance cache eviction,
  training-data-collector hard buffer cap (2x bufferSize, with warning),
  persistence load failures surface as warnings instead of silent resets

### 🔒 Security / Robustness

- **websocket-manager**: `maxClients` connection cap (close 4009),
  `maxMessageSize` payload limit (64 KiB default), per-client
  subscription cap (256 topics)
- **Config validation**: shared `clampInt`/`clampFloat`
  (`nodes/utils/config-validator.js`) replaces the `parseInt(x) || default`
  pattern across all nodes — `0` is no longer silently turned into the
  default where it is a valid value

### 🧪 Testing & CI

- 68 new unit tests for websocket-manager, python-bridge-manager and
  max-bridge-manager (previously zero coverage)
- Jest coverage thresholds gate CI and publishing
- `--forceExit` removed from the test scripts (suite exits cleanly)
- npm publish workflow: `npm ci`, coverage+lint gates, tag↔package.json
  version check, `--provenance` attestation

### 📚 Docs & Examples

- `examples/` with one importable flow per node (10 total)
- LLM Analyzer reference in `docs/API.md`, architecture section updated,
  SECURITY.md supported versions bumped to 0.3.x, README ToC

---

## [0.2.2] - 2026-01-18 - Predictive Maintenance Enhancement

### ✨ New Features

#### Anomaly Detector
- **Hysteresis (Anti-Flicker)** - Prevents rapid alarm on/off switching
  - Configurable consecutive samples before triggering alarm
  - Exit hysteresis percentage (deadband) for returning to normal state
  - New output properties: `rawAnomaly`, `hysteresis.applied`, `hysteresis.consecutiveAnomalies`
- **Multi-Sensor JSON Input** - Process multiple sensors in one message
  - Accepts JSON objects: `{ "temp": 65.2, "pressure": 4.5 }`
  - Maintains separate buffers and hysteresis states per sensor
  - Outputs combined result with `anomalySensors` array

#### Signal Analyzer
- **ISO 10816-3 Integration** - Vibration severity assessment
  - Machine classes I-IV (small to large machines)
  - Zones A-D (good, acceptable, warning, critical)
  - Automatic severity, recommendation, and alarm/warning flags
  - Zone progress percentage for trending
- **Butterworth Filter** - Improved envelope analysis
  - 2nd order IIR filter with bilinear transform
  - Zero-phase filtering (filtfilt) - no phase distortion
  - Automatic fallback to simple filter for edge cases

#### Health Index
- **Dynamic Weighted Aggregation** - Auto-adjusts sensor weights based on reliability
  - Tracks per-sensor anomaly rates and signal variance
  - Automatically downweights unreliable or noisy sensors
  - New output: `dynamicWeights` with `effectiveWeight`, `reliabilityFactor`, `anomalyRate`

#### Trend Predictor
- **Robust RUL Calculation** - More stable predictions with noisy data
  - Theil-Sen estimator for robust slope (resistant to outliers)
  - Median filter to remove spikes before trend analysis
  - Moving average smoothing for noise reduction
  - Weighted combination of robust and linear slope (70/30)
- **Multi-Sensor JSON Input** - Process multiple sensors in one message
  - Accepts JSON objects: `{ "motor_temp": 75.2, "bearing_vib": 2.5 }`
  - Calculates trends/RUL independently per sensor
  - Outputs `exceededSensors` array when thresholds are reached

### 🎨 UI Improvements

- Added placeholder text (hellgrau) to all input fields showing example values
- ISO 10816 machine class selector in Signal Analyzer vibration mode
- Hysteresis settings section in Anomaly Detector
- Dynamic weighting option in Health Index aggregation dropdown
- Updated help documentation for all new features

### 🧪 Testing

- **148 Tests** - Up from 83 (65 new tests added)
- Added tests for hysteresis behavior and state tracking
- Added tests for ISO 10816 zone evaluation
- Added tests for dynamic weight calculation
- Added tests for robust RUL slope calculation
- Added tests for multi-sensor JSON input (Anomaly Detector, Trend Predictor)

---

## [0.2.0] - 2026-01-07 - Major Consolidation Release

### 🚀 Breaking Changes

**18 nodes consolidated into 8 powerful nodes:**

| Old Nodes | New Node | Selection |
|-----------|----------|-----------|
| zscore-anomaly, iqr-anomaly, threshold-anomaly, percentile-anomaly, ema-anomaly, cusum-anomaly, moving-average-anomaly | **anomaly-detector** | `method` dropdown |
| multi-value-splitter, multi-value-anomaly, correlation-anomaly | **multi-value-processor** | `mode` dropdown |
| fft-analysis, vibration-features, peak-detection | **signal-analyzer** | `mode` dropdown |
| trend-prediction, rate-of-change | **trend-predictor** | `mode` dropdown |
| isolation-forest-anomaly | **isolation-forest-anomaly** | (unchanged) |
| health-index | **health-index** | (unchanged) |
| ml-inference | **ml-inference** | (unchanged) |
| (new) | **pca-anomaly** | Principal Component Analysis |

### 🚀 New Nodes

#### PCA Anomaly Detection
- **Principal Component Analysis** for multi-sensor anomaly detection
- Automatic component selection based on variance threshold
- Contribution analysis identifies which sensors cause anomalies
- SPE (Squared Prediction Error) and T² (Hotelling's) statistics
- Ideal for correlated multi-sensor data (5+ sensors)

### ✨ New Features

#### ML Inference Node
- **6 Model Formats Supported:**
  - ONNX (.onnx) - PyTorch, TensorFlow exports
  - Keras (.keras, .h5) - Native Keras models
  - scikit-learn (.pkl, .joblib) - Classical ML
  - TFLite (.tflite) - Edge/IoT devices
  - TensorFlow SavedModel - Full TF format
  - Google Coral Edge TPU - Hardware acceleration
- **Model Registry Integration:**
  - Hugging Face Hub
  - MLflow Registry
  - Custom Registry API
  - URL-based loading with Bearer/Basic auth
- **Python Bridge** for Keras, sklearn, TFLite inference

#### Signal Analyzer
- **Envelope Analysis Mode** - Bearing fault detection using envelope spectrum
  - Bandpass filtering with configurable frequency range
  - Automatic detection of BPFO, BPFI, BSF, FTF fault frequencies
  - Harmonic analysis (up to 3x fundamental)
  - Configurable shaft speed and bearing parameters
- **Cepstrum Mode** - Gearbox fault detection using cepstrum (quefrency domain)
  - Detects gear mesh frequencies and sidebands
  - Rahmonic (cepstrum peak) detection
- **Vibration Mode Enhancements:**
  - **Autocorrelation (ACF)** - Detects periodicity in signals
  - **Sample Entropy** - Measures signal complexity/regularity
  - **Periodicity Detection** - Identifies periodic patterns with strength metric
- **`windowFunction`** - Hann, Hamming, Blackman, Rectangular
- **`overlapPercent`** - 0-90% overlap for continuous analysis

#### Trend Predictor
- **Dedicated RUL Mode** - Remaining Useful Life calculation with confidence intervals
  - Configurable failure and warning thresholds
  - Multiple time units (hours, minutes, days, cycles)
  - Confidence intervals based on R-squared
  - Status output: healthy/warning/critical/failed
  - Degradation rate and percentage tracking
- **Weibull reliability analysis** for RUL prediction
  - New degradation model option: Linear, Exponential, Weibull
  - Automatic Weibull parameter estimation (β, η)
  - **B-Life calculation** (B1, B5, B10, B50) - time when X% have failed
  - Failure mode classification with interpretation (infant_mortality, useful_life, wear_out, rapid_wear_out)
  - MTTF calculation

#### Multi-Value Processor
- **Aggregate Mode** - Reduce multiple values to single statistic
  - Methods: Mean, Median, Min, Max, Sum, Range, StdDev
  - Optional output of all statistics
  - Preserves original values when needed
- **Mahalanobis Distance** - Multivariate anomaly detection accounting for sensor correlations
  - New method in Analyze mode
  - **Severity levels** (normal, warning, critical) with dual thresholds
  - Covariance-aware anomaly threshold
- **Cross-Correlation** - Time lag detection between two sensors
  - Finds optimal lag and correlation strength
  - Detects propagation delays (e.g., temperature waves through pipes)
  - Interpretation of lag direction (which sensor leads/lags)

#### Isolation Forest
- **Online Learning Modes** - Adaptive anomaly detection
  - Batch mode (original behavior)
  - Incremental mode with configurable retrain interval
  - Adaptive mode with threshold auto-adjustment
  - Extended output with sample count and retrain info
- **`numEstimators`** - Number of isolation trees (default: 100)
- **`maxSamples`** - Samples per tree (default: 256)

#### Health Index
- **Visual Threshold Configuration** - Slider-based sensor weight editor
  - Interactive add/remove sensor controls
  - Visual threshold bar showing status zones
  - Configurable healthy/warning/degraded/critical thresholds
  - All thresholds now output in msg.thresholds

#### All Nodes
- **`outputTopic`** - Set custom msg.topic on output
- **`debug` mode** - Detailed logging to Node-RED debug

### 📦 Pre-trained Models

All models trained on realistic synthetic industrial data:

| Model | Format | Accuracy | Description |
|-------|--------|----------|-------------|
| sensor-onnx | ONNX | 99.2% | 5-sensor anomaly detection |
| onnx-anomaly | ONNX | 99.9% | 10-sensor correlation |
| pytorch-vibration | ONNX | 100% | Bearing fault detection |
| keras-anomaly | Keras | 98.8% | 5-sensor (.keras) |
| sklearn-rf | sklearn | 99.4% | Random Forest |
| sklearn-gb | sklearn | 99.5% | Gradient Boosting |
| sensor-tflite | TFLite | 98.5% | Edge-optimized |

### 🎨 UI Improvements

- **Modern Design** - Collapsible sections, consistent styling
- **Unified Category** - All nodes in "condition-monitoring"
- **Single Icon** - Consistent icon.png across all nodes
- **Z-Score Clarification** - Thresholds now clearly labeled as σ (standard deviations)

### 🧪 Testing

- **8 Test Suites** - One per node
- **83 Tests** - All passing
- **Jest Framework** with node-red-node-test-helper

### 📝 Documentation

- Updated README for 8-node architecture
- Comprehensive models/README.md
- Example flows in flows.json with 12 tabs

### 🔧 Technical

- Python bridge (python_bridge.py) for TFLite/Keras/sklearn
- Custom Dockerfile with Python ML dependencies
- Fixed duplicate ml-inference registration bug
- Improved ONNX input shape parsing

---

## [0.1.2] - 2024-12-17 - Quality & Testing Release

### ✨ New Features

#### Node Improvements
- **Severity Levels**: All anomaly nodes now output `severity` field with values:
  - `"normal"` - No anomaly detected
  - `"warning"` - Approaching threshold (configurable)
  - `"critical"` - Threshold exceeded
- **Node Status Display**: Live status showing:
  - Blue ring: Waiting for data
  - Yellow: Warmup phase (collecting data)
  - Green: Normal operation with current statistics
  - Yellow dot: Warning detected
  - Red dot: Critical anomaly detected
- **Reset Function**: Send `msg.reset = true` to clear buffer and restart learning
- **Buffer Info**: Output now includes `bufferSize` and `windowSize` for transparency

#### Improved Nodes
- `zscore-anomaly` - Added `warningThreshold` config option
- `threshold-anomaly` - Added `warningMargin` (%) for approach warnings
- `iqr-anomaly` - Added `warningMultiplier`, now outputs `median`
- `ema-anomaly` - Added `warningThreshold`, configurable `windowSize`
- `moving-average-anomaly` - Added `warningThreshold`, outputs `stdDev`
- `cusum-anomaly` - Added `warningThreshold`, outputs `cusumMax`

### 🧪 Testing

- **47 Unit Tests** - Comprehensive test suite with realistic industrial scenarios
- **Jest Framework** - Professional testing with node-red-node-test-helper
- **CI/CD Integration** - Tests run automatically on npm publish workflow
- **Realistic Test Data** - Tests use actual industrial values:
  - Motor temperature monitoring (45-47°C normal, 52.5°C anomaly)
  - Pump vibration analysis (2.3-2.7 mm/s normal, 4.2 mm/s bearing defect)
  - Hydraulic pressure monitoring (150-250 bar operating range)
  - Compressor current analysis (12-13A normal, 18.5A mechanical jam)
  - CNC spindle load monitoring (45-52% normal, 72% tool wear)

### 📦 Package Improvements

- **Icons Optimized**: Reduced from 2.8 MB to 55 KB (99.9% smaller)
- **Package Size**: 58 KB compressed, 287 KB unpacked
- **Dev Dependencies**: Added jest, node-red, node-red-node-test-helper

### 📝 Documentation

- **Updated Help Text**: Z-Score node now has comprehensive built-in documentation
- **Severity Levels**: Documented in node help panels
- **Reset Function**: Documented with examples

### 🔧 Technical Changes

- Improved message property preservation (no longer overwrites existing fields)
- Consistent output format across all anomaly detection nodes
- Better error handling with status display

---

## [0.1.1] - 2025-12-03 - Bug Fix Release

### 🐛 Fixed

- **Dependency Update**: Updated `ml-isolation-forest` from `^0.0.4` to `^0.1.0` to fix installation errors
  - Version 0.0.4 is no longer available on npm registry
  - Resolves `npm error code ETARGET` during installation
- **API Compatibility**: Updated Isolation Forest Anomaly node to work with new API
  - Changed from binary prediction (-1/1) to score-based detection
  - Implemented dynamic threshold calculation based on contamination parameter
  - Improved anomaly detection accuracy with adaptive scoring

### 📦 Dependencies

- `ml-isolation-forest`: `^0.0.4` → `^0.1.0`
- `simple-statistics`: `^7.8.2` (unchanged)

### ✅ Testing

- Verified npm installation works correctly
- Confirmed API compatibility with ml-isolation-forest 0.1.0
- Tested Isolation Forest node functionality

---

## [0.1.0] - 2024-11-16 - INITIAL BETA RELEASE

### 🎉 First Public Release

This is the initial beta release with all core features implemented and functional.

### 🚧 Status: Beta Testing

All features are working and ready for real-world testing. API may change before v1.0.0.

### ✨ Added

#### Anomaly Detection Nodes (10)
- **Z-Score Anomaly** - Statistical outlier detection using standard deviations
- **IQR Anomaly** - Interquartile range-based robust outlier detection
- **Moving Average Anomaly** - Trend-based anomaly detection with sliding window
- **Isolation Forest Anomaly** - ML-based anomaly detection for complex patterns
- **Threshold Anomaly** - Simple min/max boundary checking
- **Percentile Anomaly** - Rank-based extreme value detection
- **EMA Anomaly** - Exponential moving average for recent change detection
- **CUSUM Anomaly** - Cumulative sum for drift detection
- **Multi-Value Anomaly** - Combined sensor analysis
- **Multi-Value Splitter** - Array data splitting utility

#### Predictive Maintenance Nodes (7)
- **Trend Prediction** - Remaining Useful Life (RUL) calculation using linear regression
- **FFT Analysis** - Frequency domain analysis for vibration monitoring
- **Vibration Features** - Comprehensive feature extraction (RMS, Crest Factor, Kurtosis, Skewness)
- **Health Index** - Multi-sensor aggregation into 0-100% health score
- **Rate of Change** - Derivative analysis for rapid change detection
- **Peak Detection** - Impact and shock event counting
- **Correlation Anomaly** - Sensor relationship validation

#### Features
- Two category structure: "anomaly detection" and "predictive maintenance"
- Consistent yellow color scheme for all nodes
- Custom logo for brand recognition
- Comprehensive documentation for each node
- 5 complete example flows demonstrating all nodes
- Docker development environment

#### Documentation
- Complete README with decision guide ("Which Node Should I Use?")
- 5 example flows with detailed explanations
- Node-specific help documentation
- PAYLOAD_FORMAT.md for data structure specs
- MULTI_VALUE.md for multi-sensor usage
- DOCKER.md for containerized development
- NODE_COVERAGE.md showing example coverage
- IMPORT_GUIDE.md for getting started

### 📋 Dependencies
- `ml-isolation-forest` ^0.0.4 - Machine learning anomaly detection
- `simple-statistics` ^7.8.2 - Statistical calculations

### ⚠️ Known Limitations
- API may change before v1.0 release
- Some features require validation in production environments

### 🔮 Planned for v1.0
- [x] ~~Comprehensive unit test suite~~ (Added in v0.1.2 - 47 tests)
- [ ] Performance benchmarks
- [ ] Additional validation with real industrial data
- [ ] API stabilization
- [x] ~~npm package publication~~ (Published)

---

## Version Numbering

- **0.1.0** - Initial beta release ✅
- **0.1.1** - Bug fix release ✅
- **0.1.2** - Quality & Testing release ✅
- **0.2.0** - Major Consolidation release ✅
- **0.2.2** - Predictive Maintenance Enhancement (current) ✅
- **0.3.0 - 0.8.0** - Beta updates with bug fixes and improvements
- **0.9.0** - Release candidate (feature freeze)
- **1.0.0** - First stable release (target: Q2 2026)
- **1.x.x** - Stable releases with backward compatibility
- **2.0.0+** - Major releases (may include breaking changes)

---

## Contributing

During the testing phase, feedback is highly appreciated:
- Report bugs and issues
- Suggest improvements
- Share your use cases
- Contribute example flows

---

**Note:** This project is under active development. Use in production with caution and proper testing.
