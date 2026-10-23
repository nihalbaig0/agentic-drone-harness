#!/usr/bin/env node
// Keeps Claude Code flying every episode assigned from the viewer.
//
// Polls the harness (no model tokens while idle) and, for each running
// episode assigned to Claude Code, starts a fresh headless `claude -p` session
// pinned to that episode id. Episodes are flown one at a time, oldest first, so
// a new "Assign" click never swaps the episode out from under a running agent.
//
//   node tools/claude_supervisor.mjs            # current assignment + every new one
//   node tools/claude_supervisor.mjs --backlog  # also every older unflown episode
//
// If a session exits without finishing its episode, the episode is aborted as an
// infrastructure failure (valid = false), as the adapter contract requires.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIM = (process.env.SIM_URL || "http://127.0.0.1:8095").replace(/\/$/, "");
const POLL_MS = Number(process.env.POLL_MS || 2000);
const CLAUDE = process.env.CLAUDE_BIN || "claude";

const attempted = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(`[${new Date().toLocaleTimeString()}] ${msg}\n`);

async function getJson(p, init) {
  const r = await fetch(SIM + p, init);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}

// Running Claude Code episodes nobody has attempted yet, oldest first.
async function pending() {
  const { episodes } = await getJson("/api/episodes");
  return episodes
    .filter((e) => e.planner === "claude-code" && e.status === "running" && !attempted.has(e.episode_id))
    .reverse();
}

function fly(id) {
  const prompt = [
    "Follow CLAUDE_AGENT_BRIEF.md.",
    `Fly exactly this episode: ${id}. Get its briefing with GET ${SIM}/api/episodes/${id}`,
    "and act on it directly; do not switch to a different assignment even if one appears.",
    "Stop as soon as the episode has a result, and report the result in one line."
  ].join(" ");
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ["-p", prompt, "--allowedTools", "Bash(curl:*)", "Bash(sleep:*)", "Read"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: -1, out: `could not start ${CLAUDE}: ${e.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// Without --backlog, older unflown assignments (superseded clicks) are skipped;
// the server's idle watchdog closes them as infrastructure failures.
async function skipBacklog() {
  const current = (await getJson("/api/assignment")).episode_id;
  const old = (await pending()).filter((e) => e.episode_id !== current);
  for (const e of old) attempted.add(e.episode_id);
  if (old.length) log(`Skipping ${old.length} older unflown assignment(s); run with --backlog to fly them.`);
}

async function main() {
  log(`Supervisor watching ${SIM} for episodes assigned to Claude Code. Ctrl+C to stop.`);
  if (!process.argv.includes("--backlog")) await skipBacklog().catch((e) => log(`could not read backlog: ${e.message}`));
  for (;;) {
    let queue = [];
    try {
      queue = await pending();
    } catch (e) {
      log(`server unreachable (${e.message}); retrying`);
    }
    for (const ep of queue) {
      attempted.add(ep.episode_id);
      log(`Flying ${ep.episode_id}: ${ep.task} (init ${ep.init}) - "${ep.instruction}"`);
      const { code, out } = await fly(ep.episode_id);
      const last = out.trim().split("\n").filter(Boolean).pop() ?? "";
      const after = await getJson(`/api/episodes/${ep.episode_id}`).catch(() => null);
      if (after?.status === "running") {
        await getJson(`/api/episodes/${ep.episode_id}/abort`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: `claude_session_exited_${code}` })
        }).catch(() => {});
        log(`  session exited (${code}) without finishing; aborted as infrastructure failure. ${last}`);
      } else if (after?.result) {
        log(`  reward ${after.result.reward}, valid ${after.result.valid}, ${after.status}`);
      } else {
        log(`  done (${code}). ${last}`);
      }
    }
    await sleep(POLL_MS);
  }
}

main();
