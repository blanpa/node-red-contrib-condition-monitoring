# Experiments

Throwaway scripts that prove a piece of architecture before it gets
spec'd or merged into the main palette. They are **not** packaged with
the npm release, **not** part of the test suite, and **not** loaded by
Node-RED.

Treat anything in here as: works on my machine, today, against the
versions in `package-lock`. Re-run before trusting.

Currently empty — the previous `mcp-spike.js` was retired together with
the `mcp-bridge` node in favour of `llm-analyzer` (active LLM analysis
inside the flow rather than passive MCP-server data exposure).
