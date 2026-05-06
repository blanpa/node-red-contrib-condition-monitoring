---
name: Bug report
about: Report a defect in a node, helper, or runtime integration.
title: "[bug] "
labels: bug
assignees: ""
---

## Summary

<!-- One-sentence description of the wrong behaviour. -->

## Reproduction

1. …
2. …
3. …

**Smallest possible flow** (paste JSON or attach a `.flow.json`):

```json
[
  …
]
```

## Expected vs actual

- Expected: …
- Actual: …

## Environment

- Package version: <!-- npm ls node-red-contrib-condition-monitoring -->
- Node-RED version: <!-- node-red --version -->
- Node.js version: <!-- node -v -->
- OS / container: <!-- e.g. Debian 12 in docker, macOS 14 native -->
- Optional runtimes installed (delete those that don't apply):
  - [ ] @tensorflow/tfjs-node
  - [ ] onnxruntime-node
  - [ ] ws (WebSocket dashboard)
  - [ ] @aws-sdk/client-s3
  - [ ] python_bridge.py runtime (TFLite / sklearn / Keras)

## Logs

<!-- Node-RED stderr, including any "Failed to start ..." or stack traces. -->

```
…
```

## Anything else?

<!-- Workarounds you tried, related upstream issues, etc. -->
