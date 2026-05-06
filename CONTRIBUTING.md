# Contributing

Thanks for your interest in `node-red-contrib-condition-monitoring`. This page
describes the workflow we use so reviews stay quick and the test suite stays
green.

## Quick start

```bash
git clone https://github.com/blanpa/node-red-contrib-condition-monitoring.git
cd node-red-contrib-condition-monitoring
npm install
npm test
```

Optional ML runtimes (TensorFlow.js, ONNX, AWS S3, ws) are listed in
`optionalDependencies`. CI runs without them; install them locally if you are
touching `nodes/ml-inference.js`, `nodes/python-bridge-manager.js`, or the
WebSocket dashboard wiring.

## Branch / commit style

- Branch from `main`, name the branch after the change (`fix/sha-mismatch`,
  `feat/welford-stats`).
- One topic per PR. Refactors and behaviour changes belong in separate PRs.
- Conventional-ish commit messages preferred (`fix:`, `feat:`, `docs:`,
  `test:`, `refactor:`). The CHANGELOG is updated by maintainers on release.

## Required checks before opening a PR

```bash
npm run lint          # eslint, must be 0 errors
npm run format:check  # prettier, must be clean
npm test              # jest, all suites green
```

If you touched any files under `nodes/`, also re-run the targeted spec for
that node (e.g. `npx jest --testPathPatterns='anomaly-detector'`) so failures
surface fast.

## Coding conventions

- **`const` first, `let` only when reassigned, `var` is forbidden** (enforced
  by ESLint).
- **No `console.*` in `nodes/`**. Use `node.warn` / `node.error` /
  `node.debug`. Tests are exempt.
- **Avoid `obj.hasOwnProperty(key)`** — use
  `Object.prototype.hasOwnProperty.call(obj, key)`. The lint rule blocks the
  unsafe form.
- **Prefer the helpers in `nodes/utils/`** (`statistics`, `error-handler`,
  `persistence-helper`, `path-validator`) over re-implementing the same
  logic inline.
- **Streaming statistics**: use `RunningStats` from
  `nodes/utils/statistics.js` for high-rate sensor input — recomputing mean
  and std-dev on a sliding buffer is O(W) per sample, the Welford-based
  online stats are O(1).

## Tests

- Every new helper or non-trivial branch in a node deserves a Jest spec
  under `test/`.
- Use `jest`'s `toBeCloseTo(expected, decimals)` for floating-point
  comparisons.
- For path / I/O tests, write into `os.tmpdir()` and clean up in `afterAll`.

## Security-relevant changes

If your PR changes anything in:

- `nodes/utils/path-validator.js`
- `nodes/utils/error-handler.js` (sanitisation)
- `nodes/websocket-manager.js` (auth, origins)
- `nodes/ml-inference.js` (downloads, SHA verification, model paths)

…please:

1. Add a test that covers the security property you preserved or added.
2. Mention the change explicitly in the PR description.
3. Read [SECURITY.md](SECURITY.md) for the existing hardening contract — do
   not weaken it without discussion.

## Dependency hygiene

- Heavy ML runtimes stay under `optionalDependencies`. Don't promote them to
  `dependencies` unless you also document why CI needs them.
- Pin Docker `RUN npm install` versions to the same major as
  `package.json` so the smoke environment doesn't diverge from the published
  package.

## Releasing

Maintainer-only. Steps live in `CHANGELOG.md` plus the npm publish workflow
under `.github/workflows/`.
