# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`node-red-contrib-condition-monitoring` — a Node-RED module of **15 nodes** for
anomaly detection, predictive maintenance, signal/vibration analysis, ML
inference (ONNX/TF.js), a synthetic data/vision pipeline, and an LLM analyzer.
Published to npm; current line is **v0.3.x** (Beta). Pure CommonJS, runtime
`node >= 18`.

## Commands

```bash
npm test                 # jest, BOTH projects (unit + integration) — what CI runs
npx jest --selectProjects unit          # unit only (fast, parallel)
npx jest --selectProjects integration   # integration only (real Node-RED, serial)
npx jest path/to/_spec.js               # a single suite
npm run test:coverage    # with coverage gate (jest.config.js thresholds)
npm run lint             # eslint (flat config) — 0 errors required, warnings OK
npm run format:check     # prettier --check (CI gate); npm run format to fix
npm run test:smoke-onnx  # ONNX runtime smoke test (needs optional deps)
```

Before committing/pushing, the changes must pass the same gates CI enforces:
**lint, prettier, full `npm test`, and the audit gate** (below).

## Architecture

- **`nodes/<name>.js` + `nodes/<name>.html`** — one runtime + one editor file per
  node. Registered in `package.json` under `node-red.nodes`. Each runtime file is
  `module.exports = function (RED) { … RED.nodes.registerType("name", Node); }`.
- **`nodes/utils/`** — shared helpers, required by nodes as `./utils/<x>`:
  `statistics.js`, `path-validator.js` (security: model-path allowlisting),
  `admin-auth.js` (security: `httpAdmin` permission guard),
  `config-validator.js` (`clampInt`/`clampFloat`), `error-handler.js`,
  `message.js` (`copyPassthrough`), `persistence-helper.js`, `llm-providers.js`.
- **Non-node runtime modules** in `nodes/` (not registered, used by nodes):
  `websocket-manager.js`, `state-persistence.js`, `python-bridge-manager.js`,
  `max-bridge-manager.js`, `ml-inference-admin.js` (all of ml-inference's
  `httpAdmin` routes; takes runtime state by injection).
- **`nodes/python/`** — Python sidecars (`python_bridge.py`, `max_bridge.py`,
  `coral_inference.py`) driven by the bridge-manager nodes.
- **`nodes/models/`, `nodes/labels/`, `nodes/model-catalog.json`** — bundled ML
  model assets + catalog.

When adding a node: create the `.js`/`.html` pair, register it in `package.json`,
reuse `nodes/utils/` helpers (don't re-implement stats/validation), and add a
`test/<name>_spec.js`.

**Every `RED.httpAdmin` route must be wrapped in
`needsPermission(RED, "<node>.read"|"<node>.write")` from `utils/admin-auth`.**
Node-RED does *not* apply `adminAuth` to node-registered routes — an unguarded
one is reachable by anyone who can talk to the editor port.
`test/utils-admin-auth_spec.js` fails the build if a registration slips through.
Any request-supplied file name (route param, header, JSON body) must go through
a `path-validator` check before it reaches `fs` — see `safeChildPath()` in
`ml-inference-admin.js`.

## Tests

`jest.config.js` defines **two projects**:
- **`unit`** — everything in `test/` except `test/integration/`, run in parallel.
- **`integration`** — `test/integration/**`, run **serially** (each boots a real
  Node-RED instance on its own socket; `test/integration/red-runtime.js` is the
  harness). Port contention / timeouts appear if run in parallel.

Gotchas:
- Keep integration test data **deterministic** — no `Math.random()` in assertions.
  Random baselines can cross z-score thresholds while the running stddev is tiny
  and route a message to the wrong output → collect timeout on the slow CI runner.
- `test/fixtures/*_model_metadata.json` get a `lastLoaded` timestamp rewritten on
  every ml-inference run. **Revert that churn before committing** — don't stage it.
  Running the suite against a *container* also drops an untracked
  `nodes/models/<model>_metadata.json` sidecar next to each bundled model —
  same deal, delete it rather than commit it.
- Optional ML runtimes (`@tensorflow/tfjs-node`, `onnxruntime-node`) and `ws` are
  `optionalDependencies`; CI's unit/lint/audit jobs install with
  `--omit=optional`, so guard code/tests for their absence.
- Coverage thresholds (`jest.config.js`) sit under the baseline measured *the
  way CI measures it* — with `--omit=optional` (60/51/64/61 against a measured
  ≈64.8/55.8/70.4/66.0). Installing the optional runtimes locally reads a few
  points higher; don't set the gate from that number. The margin is wider than
  it looks like it needs to be because one run came in ~4.5 points low and never
  reproduced. Ratchet **up** as coverage grows, never down.
- Node-RED mounts body parsers on the admin router, so an `httpAdmin` handler
  may find the request stream already drained. Don't read `req.on("data")`
  blindly — it hangs. Prefer `req.body`, stream only as a fallback.

## CI gates (`.github/workflows/ci.yml`)

`test` (Node 18/20/22), `coverage`, `lint`, `audit`, `optional-runtimes`
(allowed to fail). All jobs install with **`npm ci`** so the tracked lockfile is
enforced; both workflows default to `permissions: contents: read`.

The **audit gate is intentionally scoped to required runtime deps only**: `npm audit --omit=dev --omit=optional --audit-level=high`. Highs in
dev/optional deps (tfjs-node's tar/node-pre-gyp tooling) are out of scope and
must not be "fixed" by force-bumping — they never reach a user who skips the
optional runtimes.

## ESLint

Flat config in **`eslint.config.js`** (ESLint 10; migrated from the old
`.eslintrc.json`). Needs `@eslint/js` + `globals`. Note `@eslint/js` has its own
version line (10.0.x), not eslint-core's (10.5.x). `no-unused-vars` uses
`caughtErrors:"none"` (keeps idiomatic `catch (e) {}` passing); the new
recommended rules `no-useless-assignment` / `preserve-caught-error` are off
pending a dedicated cleanup follow-up.

## Dependencies / gotchas

- **Do NOT bump `node-red` to v5.** It breaks the integration test harness
  (`node-red-node-test-helper` 0.3.6) — ~30 integration tests fail with "node not
  found"/ECONNREFUSED. Runtime itself is fine on v5. Kept at `^4.1.8`; Dependabot
  will keep re-proposing v5 — leave it until the test helper supports it.
- Packaging uses a **`files` allowlist** in `package.json` (`nodes/`, `examples/`
  minus the generated test-suite, `CHANGELOG.md`, `SECURITY.md`). The old
  `.npmignore` blocklist leaked training data/datasets into the tarball; it has
  been deleted (the allowlist takes precedence, so it was dead config — verified
  with `npm pack --dry-run`). Don't reintroduce it.
- `package-lock.json` is tracked (required for `npm ci` / setup-node cache).
- **Regenerating `examples/test-suite.json`** (`node tools/build-test-suite.js`)
  requires `./test-models/` to be populated first — `bash tools/fetch-models.sh`.
  Tabs are emitted conditionally on those fixtures, so running the generator
  without them silently produces a *smaller* suite (27 tabs / 37 tests instead
  of 38 / 48) and overwrites the committed one. The generator now refuses to
  write a partial suite unless `--allow-partial` is passed. The Test Runner's
  settle delay defaults to 45 s and is a ceiling, not a measurement — too short
  and `/test` reports false negatives; override with
  `TEST_SUITE_SETTLE_SECONDS` when regenerating for a slower machine.
- `training/` carries ~109 MB in git. **This is a deliberate decision — the data
  stays in the repo.** Don't propose a repo split, LFS migration or history
  rewrite for it. The weight never reaches npm users: the `files` allowlist in
  `package.json` keeps `training/` out of the tarball. Local-only venvs
  (`.venv/`, `notebooks_venv/`) are gitignored.

## Release / publish

Publishing runs on **tag push** via `.github/workflows/npm-publish.yml` using
**npm OIDC trusted publishing** (no `NPM_TOKEN` — do not reintroduce one). The
workflow verifies the tag matches `package.json` version, then `npm publish`.
Tags use the `vX.Y.Z` form. The workflow reads itself from the tagged commit, so
to re-trigger a publish you must move/re-push the tag (a plain rerun uses the
stale workflow).

## Local dev (Docker)

`docker-compose.yml` runs Node-RED with the package mounted live. The running dev
project uses compose project name **`cm-latest`** and host port **1890** (host
1880 is taken by another container):

```bash
NODE_RED_PORT=1890 docker compose -p cm-latest up -d
```

`node_modules` is mounted as a single volume; `./nodes` + `./package.json` are
nested mounts so the package resolves at
`/data/node_modules/node-red-contrib-condition-monitoring`.

## Conventions

- CommonJS, 2-space indent, Prettier-formatted. Comments in English, matching the
  surrounding density.
- Validate/clamp all node config inputs via `nodes/utils/config-validator.js`.
- Validate any filesystem/model path via `nodes/utils/path-validator.js`
  (allowlist) — this is a security boundary, don't bypass it.
- End git commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Commit/push only when asked; branch first if on `main` for PR work.
