# Security Policy

## Supported Versions

This project is currently at **0.3.x (beta)**. Security fixes land on the `main`
branch and are released as soon as a fix is available. Older patch
releases are not back-ported.

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| 0.2.x   | :x:                |
| < 0.2   | :x:                |

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
  allowlist for any user-supplied model path. The defaults are the
  `ml-models` cache directory, the Node-RED `userDir`, and `process.cwd()`.
  Operators can extend the allowlist via `settings.js`:

  ```js
  conditionMonitoring: {
    allowedModelPaths: ['/srv/models']
  }
  ```

- **Model download integrity** — every download flow (URL, Hugging Face,
  MLflow, custom registry) accepts an optional SHA-256 digest via the
  `modelSha256` node property. When set, mismatches are rejected with
  `ESHAMISMATCH` and the partial file is unlinked.

- **WebSocket auth & origin allowlist** — the dashboard WebSocket can be
  protected with a shared `authToken` and a list of `allowedOrigins`. Tokens
  are compared in constant time. Requests without a matching token are closed
  with WebSocket code `4401`. Configure these in any node that publishes to
  the WebSocket (e.g. `anomaly-detector`).

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
