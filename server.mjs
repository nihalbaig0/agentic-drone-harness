// HTTP harness for planners (Claude Code, an LLM behind the recording proxy,
// or anything that speaks HTTP), plus a spectator viewer.
//
// The physics, detector and success check run here, headless and seeded. The
// browser is only a spectator: closing it changes nothing about an episode.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Episode, PlannerError, LIMITS, SKILLS } from "./sim/harness.mjs";
import { Recorder } from "./sim/recorder.mjs";
import { TASKS, SUITES, SPLITS } from "./sim/tasks.mjs";
import { renderMap, renderCamera } from "./sim/render.mjs";
import { computeAdvantages } from "./sim/rloo.mjs";
import { runScripted } from "./planners/scripted.mjs";
import { hashString } from "./sim/rng.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 8095);
const IDLE_ABORT_MS = Number(process.env.IDLE_ABORT_MS || 10 * 60 * 1000);
const MAX_EPISODES_IN_MEMORY = 300;

const recorder = new Recorder(process.env.RUNS_DIR || path.join(__dirname, "runs"));
const episodes = new Map();           // id -> Episode (most recent last)
let assignmentId = null;              // episode the teacher handed to Claude Code
let lastGroup = null;                 // last scripted group demo, for the viewer

function remember(ep) {
  episodes.set(ep.id, ep);
  while (episodes.size > MAX_EPISODES_IN_MEMORY) episodes.delete(episodes.keys().next().value);
}

// A planner that never comes back (model server down, terminal closed) is an
// infrastructure failure, not a task failure: valid = false.
setInterval(() => {
  const now = Date.now();
  for (const ep of episodes.values()) {
    if (ep.status === "running" && now - ep.lastTurnAt > IDLE_ABORT_MS) ep.abort("infra:planner_unreachable");
  }
}, 15000).unref();

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const THREE_VERSION = "0.164.1";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 512 * 1024) throw new PlannerError("request body too large");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new PlannerError("body must be JSON"); }
}

function createEpisode(body) {
  let ep;
  try {
    ep = newEpisodeFrom(body);
  } catch (e) {
    throw new PlannerError(e.message);   // bad task / suite / init -> 400
  }
  remember(ep);
  return ep;
}

function newEpisodeFrom(body) {
  return new Episode({
    task: body.task ?? "deliver_yellow_orange",
    suite: body.suite ?? "base",
    init: Number.isInteger(body.init) ? body.init : 1,
    attempt: Number.isInteger(body.attempt) ? body.attempt : 0,
    harness: body.harness ?? "skill",
    planner: String(body.planner ?? "http").slice(0, 60),
    policyVersion: Number.isInteger(body.policy_version) ? body.policy_version : 0,
    run: body.run ?? "live",
    recorder
  });
}

function getEpisode(id) {
  const ep = episodes.get(id);
  if (!ep) throw Object.assign(new Error(`no episode '${id}'`), { status: 404 });
  return ep;
}

function runGroup({ task = "deliver_yellow_orange", suite = "base", init = 26, harness = "skill", group = 6 }) {
  const run = "demo-groups";
  const members = [];
  const G = Math.max(2, Math.min(12, Number(group) || 6));
  for (let attempt = 0; attempt < G; attempt++) {
    const ep = new Episode({ task, suite, init, attempt, harness, planner: "scripted", run, recorder });
    remember(ep);
    runScripted(ep, hashString(`${task}|${init}|${attempt}|demo`));
    members.push(ep);
  }
  const { advantage } = computeAdvantages(members.map((m) => m.result));
  lastGroup = {
    task: members[0].taskKey, init, harness, instruction: members[0].instruction,
    members: members.map((m) => ({
      episode_id: m.id, attempt: m.attempt, reward: m.result.reward, valid: m.result.valid,
      advantage: Number((advantage.get(m.id) ?? 0).toFixed(3)), end_reason: m.endReason, turns: m.turn
    }))
  };
  return lastGroup;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ===== Planner API =====

    if (req.method === "GET" && p === "/api/meta") {
      return json(res, 200, {
        tasks: TASKS.map((t) => t.id), suites: SUITES, splits: SPLITS, limits: LIMITS,
        skills: Object.fromEntries(Object.entries(SKILLS).map(([k, v]) => [k, v.doc]))
      });
    }

    if (req.method === "POST" && p === "/api/episodes") {
      const ep = createEpisode(await readBody(req));
      return json(res, 200, ep.briefing());
    }

    if (req.method === "GET" && p === "/api/episodes") {
      return json(res, 200, { episodes: [...episodes.values()].reverse().slice(0, 60).map((e) => e.summary()) });
    }

    // The episode the teacher assigned to Claude Code (see CLAUDE_AGENT_BRIEF.md).
    if (req.method === "GET" && p === "/api/assignment") {
      const ep = assignmentId && episodes.get(assignmentId);
      if (!ep) return json(res, 200, { episode_id: null });
      return json(res, 200, ep.status === "running" ? ep.briefing() : { episode_id: ep.id, status: ep.status, result: ep.result });
    }

    let m = p.match(/^\/api\/episodes\/([\w.-]+)(?:\/([\w.]+))?$/);
    if (m) {
      const ep = getEpisode(m[1]);
      const sub = m[2] ?? "";
      if (req.method === "GET" && sub === "") return json(res, 200, { ...ep.briefing(), status: ep.status, result: ep.result });
      if (req.method === "POST" && sub === "act") return json(res, 200, ep.act(await readBody(req)));
      if (req.method === "POST" && sub === "code") return json(res, 200, ep.submitCode(await readBody(req)));
      if (req.method === "POST" && sub === "abort") {
        const body = await readBody(req);
        return json(res, 200, { result: ep.abort(`infra:${String(body.reason ?? "client_abort").slice(0, 120)}`) });
      }
      if (req.method === "GET" && (sub === "camera.png" || sub === "map.png")) {
        const png = sub === "camera.png" ? renderCamera(ep) : renderMap(ep);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return res.end(png);
      }
    }

    // ===== Spectator + teacher controls (NOT part of the planner surface) =====

    m = p.match(/^\/spectator\/episodes\/([\w.-]+)$/);
    if (req.method === "GET" && m) {
      return json(res, 200, getEpisode(m[1]).spectate(Number(url.searchParams.get("since") || 0)));
    }

    if (req.method === "GET" && p === "/spectator/overview") {
      return json(res, 200, {
        assignment: assignmentId,
        episodes: [...episodes.values()].reverse().slice(0, 40).map((e) => e.summary()),
        lastGroup
      });
    }

    if (req.method === "POST" && p === "/spectator/assign") {
      const body = await readBody(req);
      const ep = createEpisode({ ...body, planner: "claude-code" });
      assignmentId = ep.id;
      return json(res, 200, { episode_id: ep.id, instruction: ep.instruction });
    }

    if (req.method === "POST" && p === "/spectator/group") {
      return json(res, 200, runGroup(await readBody(req)));
    }

    // ===== static viewer =====
    if (req.method === "GET") {
      if (p.startsWith("/vendor/three/")) {
        const rel = p.slice("/vendor/three/".length);
        for (const base of [path.join(__dirname, "node_modules", "three"), path.join(__dirname, "..", "node_modules", "three")]) {
          const f = path.normalize(path.join(base, rel));
          if (f.startsWith(base) && existsSync(f)) {
            res.writeHead(200, { "content-type": mime[path.extname(f)] || "application/octet-stream" });
            return res.end(await readFile(f));
          }
        }
        res.writeHead(302, { location: `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/${rel}` });
        return res.end();
      }
      const rel = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
      const f = path.normalize(path.join(publicDir, rel));
      if (f.startsWith(publicDir) && existsSync(f)) {
        res.writeHead(200, { "content-type": mime[path.extname(f)] || "application/octet-stream" });
        return res.end(await readFile(f));
      }
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof PlannerError) return json(res, 400, { error: e.message });
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(port, () => {
  process.stdout.write(`Drone harness on http://127.0.0.1:${port}\n`);
});
