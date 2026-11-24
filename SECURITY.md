# Security Policy

## Supported Versions

This project is currently at **0.4.x (beta)**. Security fixes land on the `main`
branch and are released as soon as a fix is available. Older patch
releases are not back-ported.

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| 0.3.x   | :x:                |
| < 0.3   | :x:                |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for vulnerabilities. Instead:

1. Email the maintainer (see the `author` field in `package.json` and the
   `bugs` URL in the project metadata) with a description of the issue.
2. Include reproduction steps, affected version(s), and your assessment of
   the impact.
3. Allow up to **7 days** for an initial response and up to **30 days** for a
   coordinated fix.

If you would prefer GitHub's private reporting flow, you can also file a
private advisory under the repository's *Security* tab.

## Known Hardening Notes

The package ships several defenses against common deployment risks. Operators
should be aware of these:

- **Path traversal protection** — `nodes/utils/path-validator.js` enforces an
  allowlist for any user-supplied model path (`modelPath`, `msg.loadModel`).
  The defaults are the model store (`<userDir>/ml-models`, where uploads and
  downloads land) and the models bundled with the package — nothing else.
  The Node-RED `userDir` and `process.cwd()` were on the list up to 0.4.0 and
  are deliberately not any more: the user dir holds `flows_cred.json` and
  `settings.js`, and a cwd of `/` (systemd's default, some containers) made
  the check a no-op. Models elsewhere need an explicit entry in `settings.js`:

  ```js
  conditionMonitoring: {
    allowedModelPaths: ['/srv/models']
  }
  ```

  Model metadata is written into the store (`ml-models/.meta/`), never next
  to the model, so an allowlisted directory may be read-only.

- **Model download integrity** — every download flow (URL, Hugging Face,
  MLflow, custom registry) accepts an optional SHA-256 digest via the
  `modelSha256` node property. When set, mismatches are rejected with
  `ESHAMISMATCH` and the partial file is unlinked.

- **WebSocket auth & origin allowlist** — the dashboard WebSocket can be
  protected with a shared auth token and a list of allowed origins. Both are
  set in the **WebSocket panel of the `anomaly-detector` node**: the token is a
  Node-RED credential (`websocketAuthToken`, type `password` — encrypted at
  rest, never part of a flow export); the origins are a comma-separated
  `websocketAllowedOrigins` property. A token kept in the plain node config
  (flows written before the credential existed) still works but is warned
  about, since it travels with the flow file. Tokens are compared in constant
  time over SHA-256 digests, so neither content nor length leaks through
  timing. Requests without a matching token are closed with WebSocket code
  `4401`; when an origin allowlist is set, requests without an `Origin` header
  are refused too. All nodes publishing on one port share one server, which
  takes the first deployed node's settings and is stopped and restarted on
  redeploy, so a rotated token takes effect without a Node-RED restart. A
  client that stops reading its messages is skipped and, after ten skipped
  broadcasts in a row, disconnected, so a stalled dashboard cannot grow the
  runtime's memory.

- **Model-registry tokens** — the `ml-inference` node keeps its URL bearer
  token, Hugging Face token, MLflow token and custom-registry API key as
  Node-RED credentials (type `password`), encrypted at rest and excluded from
  flow exports. Flows saved before 0.4.1 carry them as plain node properties;
  those still work but log a warning on start — re-enter the value in the
  editor to move it into the credentials file.

- **LLM credentials & data egress** — the `llm-analyzer` node stores its API
  key as a Node-RED credential (`apiKey`, type `password`), encrypted at rest
  in the credentials file; the inline `apiKey` config property is a dev/test
  backstop only and should not be used in production. Be aware that this node
  **sends buffered sensor data to an external LLM API** of the operator's
  choosing (Anthropic, OpenAI, Google, an OpenAI-compatible endpoint, or a
  local Ollama instance — the latter keeps data on-site).

- **Prototype-pollution sanitisation** — `nodes/utils/error-handler.js`
  exposes `sanitizeObject` which is used wherever JSON-decoded user input
  feeds into a config object (e.g. `health-index` sensor weights).

- **No `--no-verify` git workflow** — please don't disable hooks when
  committing security fixes; use the documented `lint`/`format`/`test`
  scripts instead.

## Out of Scope

- Vulnerabilities in upstream packages (`@tensorflow/tfjs-node`,
  `onnxruntime-node`, etc.) — please report those upstream.
- Issues that require an attacker to already have write access to your
  Node-RED flows file or filesystem.
- Denial of service via deliberate misuse of legitimate features (e.g. very
  large window sizes).
