/**
 * Tiny mock for Anthropic's POST /v1/messages — used by docker-compose.demo.yml
 * so the llm-analyzer demo runs without an API key. Replies with a canned-but-
 * context-aware analysis based on the inbound stats line.
 *
 * Not for production. Do not deploy this anywhere reachable.
 */

"use strict";

const http = require("http");

const PORT = parseInt(process.env.PORT, 10) || 8088;

function pickResponse(userPrompt) {
    // Try to fish the stats line out of the prompt — keeps the canned
    // output a little less robotic by referencing the actual mean/stddev.
    const m = /Stats:\s*([^\n]+)/.exec(userPrompt || "");
    const stats = m ? m[1].trim() : "(no stats)";
    const mean = /mean=([\-0-9.eE]+)/.exec(stats);
    const stdDev = /stdDev=([\-0-9.eE]+)/.exec(stats);

    const meanV = mean ? parseFloat(mean[1]) : null;
    const stdV = stdDev ? parseFloat(stdDev[1]) : null;

    let verdict = "Batch within expected band, no obvious anomaly.";
    if (Number.isFinite(stdV) && Number.isFinite(meanV)) {
        if (stdV > Math.max(0.001, Math.abs(meanV) * 0.2)) {
            verdict = "Batch shows elevated variance versus the mean — worth a follow-up sample.";
        } else if (Math.abs(meanV) < 1e-6) {
            verdict = "Mean ≈ 0 with low spread — sensor reading nominal.";
        }
    }
    return verdict + " (stats observed: " + stats + ")";
}

/**
 * Demo-only helper: when the operator chose JSON output, return a JSON
 * object with a couple of common fields, derived loosely from stats so
 * downstream switch-nodes have something realistic to gate on.
 *
 * Note this isn't a generic mock; it just reflects what the demo's
 * `outputSchema` field contains.
 */
function pickJsonResponse(userPrompt) {
    const m = /Stats:\s*([^\n]+)/.exec(userPrompt || "");
    const stats = m ? m[1].trim() : "(no stats)";
    const stdMatch = /stdDev=([\-0-9.eE]+)/.exec(stats);
    const std = stdMatch ? parseFloat(stdMatch[1]) : 0;

    // Synthetic 0..1 score: more variance → higher score.
    const score = Math.min(1, Math.max(0, std / 5 + Math.random() * 0.2));
    const severity = score >= 0.7 ? "critical" : score >= 0.4 ? "warning" : "ok";
    const obj = {
        severity,
        score: Math.round(score * 100) / 100,
        summary:
            severity === "ok"
                ? "Batch within expected band."
                : "Variance " + (std.toFixed(2)) + " above baseline — inspect.",
        recommendation:
            severity === "critical"
                ? "Inspect within 4 hours."
                : severity === "warning"
                    ? "Schedule a check at next maintenance window."
                    : "No action required."
    };
    return JSON.stringify(obj);
}

const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
        res.statusCode = 405;
        return res.end();
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try {
            body = JSON.parse(raw);
        } catch (_) {
            body = null;
        }
        const userPrompt =
            body && Array.isArray(body.messages) && body.messages[0] ? String(body.messages[0].content || "") : "";
        // Anthropic uses `body.system`; OpenAI/Ollama include it as a
        // `system`-role message — check both so JSON-mode is detectable
        // regardless of provider in the demo.
        const systemPrompt =
            (body && typeof body.system === "string" && body.system) ||
            (body &&
                Array.isArray(body.messages) &&
                (body.messages.find((m) => m && m.role === "system") || {}).content) ||
            "";
        const wantsJson = /single JSON object|single valid JSON/.test(systemPrompt);
        const text = wantsJson ? pickJsonResponse(userPrompt) : pickResponse(userPrompt);
        const inTok = Math.max(1, Math.round(userPrompt.length / 4));
        const outTok = Math.max(1, Math.round(text.length / 4));

        // First non-empty line of the user prompt + a JSON tag if the
        // operator picked JSON mode — handy in `docker logs` to spot which
        // flow fired what.
        const firstLine = (userPrompt.split("\n")[0] || "").slice(0, 90);
        const tag = wantsJson ? "[JSON]" : "[TEXT]";
        // eslint-disable-next-line no-console
        console.log(
            new Date().toISOString(),
            req.method,
            req.url,
            "→",
            inTok + "in/" + outTok + "out",
            tag,
            firstLine
        );

        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
            JSON.stringify({
                id: "msg_mock_" + Date.now(),
                type: "message",
                role: "assistant",
                model: (body && body.model) || "claude-haiku-mock",
                content: [{ type: "text", text }],
                stop_reason: "end_turn",
                usage: { input_tokens: inTok, output_tokens: outTok }
            })
        );
    });
});

server.listen(PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log("anthropic-mock listening on http://0.0.0.0:" + PORT + "/v1/messages");
});
