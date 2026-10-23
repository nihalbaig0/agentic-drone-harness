// OpenAI-compatible recording proxy: the "model-call proxy" of Fig. 2(b).
//
// Put it between the planner and the model server (e.g. vLLM serving the 9B
// student). Every chat completion is forwarded unchanged and recorded with the
// episode id and turn the planner sends in headers, so recorded calls can be
// matched to adapter records and turned into RL samples.
//
//   UPSTREAM=http://127.0.0.1:8000 PORT=8090 RUN=live POLICY_VERSION=0 node proxy.mjs
//
// The planner sets:  x-episode-id: <episode_id>   x-turn: <n>
//
// With RECORD_LOGPROBS=1 the proxy asks the upstream for token logprobs, so the
// rollout-time probabilities b_sj needed for truncated importance sampling
// (Appendix A) are stored next to the response. Streaming is not supported.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Recorder } from "./sim/recorder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = (process.env.UPSTREAM || "http://127.0.0.1:8000").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 8090);
const RUN = process.env.RUN || "live";
const POLICY_VERSION = Number(process.env.POLICY_VERSION || 0);
const RECORD_LOGPROBS = process.env.RECORD_LOGPROBS === "1";
const recorder = new Recorder(process.env.RUNS_DIR || path.join(__dirname, "runs"));

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function forwardHeaders(req) {
  const h = { "content-type": "application/json" };
  if (req.headers.authorization) h.authorization = req.headers.authorization;
  return h;
}

const server = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  const isCompletion = req.method === "POST" && /\/v1\/(chat\/)?completions$/.test(req.url);
  let body = null;
  if (isCompletion) {
    try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "body must be JSON" }));
    }
    if (body.stream) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "the recording proxy does not support stream=true" }));
    }
    if (RECORD_LOGPROBS) body.logprobs = true;
  }

  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: forwardHeaders(req),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : (body ? JSON.stringify(body) : raw)
    });
  } catch (e) {
    if (isCompletion) recordCall(req, body, null, 0, Date.now() - t0, `upstream unreachable: ${e.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `upstream unreachable: ${e.message}` }));
  }
  const text = await upstream.text();
  if (isCompletion) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* recorded as null */ }
    recordCall(req, body, parsed, upstream.status, Date.now() - t0, upstream.ok ? null : text.slice(0, 500));
  }
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
  res.end(text);
});

function recordCall(req, request, response, status, latencyMs, error) {
  recorder.append(RUN, "proxy_calls.jsonl", {
    ts: Date.now(),
    episode_id: req.headers["x-episode-id"] || null,
    turn: req.headers["x-turn"] ? Number(req.headers["x-turn"]) : null,
    policy_version: POLICY_VERSION,
    upstream_status: status,
    latency_ms: latencyMs,
    error,
    request,        // the exact context the model saw: messages, tools, sampling params
    response        // choices (incl. logprobs / token ids when the server returns them), usage
  });
}

server.listen(PORT, () => {
  process.stdout.write(`Recording proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM}  (run=${RUN}, policy v${POLICY_VERSION})\n`);
});
