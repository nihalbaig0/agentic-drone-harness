// End to end over HTTP: mock model server -> recording proxy -> LLM planner ->
// drone harness. Checks that proxy records and harness records share episode
// ids (so they can be matched to outcomes), and that a model-server failure
// becomes valid = false rather than a task failure.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = mkdtempSync(path.join(tmpdir(), "drone-runs-"));
const children = [];
let mock, ports;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function start(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env, RUNS_DIR: runsDir } });
    children.push(child);
    child.stdout.once("data", () => resolve(child));
    child.once("exit", (code) => reject(new Error(`${file} exited ${code}`)));
  });
}

// A model that takes off, then calls done(). Model name "broken" returns 500.
function mockModel(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    if (j.model === "broken") { res.writeHead(500); return res.end("boom"); }
    const turn = j.messages.filter((m) => m.role === "assistant").length;
    const call = turn === 0 ? ["takeoff", { z: 6 }] : ["done", {}];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `step ${turn}`, tool_calls: [{ id: `c${turn}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } }]
    }));
  });
}

before(async () => {
  ports = { mock: await freePort(), sim: await freePort(), proxy: await freePort() };
  mock = http.createServer(mockModel).listen(ports.mock);
  await start("server.mjs", { PORT: String(ports.sim) });
  await start("proxy.mjs", { PORT: String(ports.proxy), UPSTREAM: `http://127.0.0.1:${ports.mock}`, RUN: "itest" });
});

after(() => {
  for (const c of children) c.kill();
  mock?.close();
  rmSync(runsDir, { recursive: true, force: true });
});

function planner(model) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["planners/llm_planner.mjs",
      "--task", "inspect_red", "--init", "3", "--attempts", "1", "--model", model, "--run", "itest",
      "--sim", `http://127.0.0.1:${ports.sim}`, "--base-url", `http://127.0.0.1:${ports.proxy}/v1`
    ], { cwd: root }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.trim()))));
  });
}

const readJsonl = (f) => readFileSync(path.join(runsDir, "itest", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("LLM planner through the recording proxy: calls are recorded and matched to the episode", async () => {
  const result = await planner("mock-9b");
  assert.equal(result.valid, true);
  assert.equal(result.reward, 0);                     // took off and quit: not inspected
  const proxied = readJsonl("proxy_calls.jsonl").filter((r) => r.episode_id === result.episode_id);
  assert.deepEqual(proxied.map((r) => r.turn), [1, 2]);
  assert.ok(proxied[0].request.messages.length >= 2 && proxied[0].request.tools.length === 7);
  const harness = readJsonl("calls.jsonl").filter((r) => r.episode_id === result.episode_id);
  assert.deepEqual(harness.map((r) => r.response.skill), ["takeoff", "done"]);
  const adapter = readJsonl("adapter.jsonl").find((r) => r.episode_id === result.episode_id);
  assert.deepEqual(adapter, result);
});

test("a model-server failure is an infrastructure failure (valid = false)", async () => {
  const result = await planner("broken");
  assert.equal(result.valid, false);
  const ep = readJsonl("episodes.jsonl").find((r) => r.episode_id === result.episode_id);
  assert.match(ep.end_reason, /^infra:model server returned 500/);
});
