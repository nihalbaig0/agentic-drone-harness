#!/usr/bin/env node
// An LLM planner for the drone harness, for any OpenAI-compatible model server
// (vLLM / SGLang / Ollama / a hosted API). Point --base-url at proxy.mjs so
// every model call is recorded and tagged with its episode.
//
//   node planners/llm_planner.mjs --task deliver_yellow_orange --suite base \
//     --init 11 --attempts 6 --harness skill --model Qwen/Qwen3.5-9B \
//     --base-url http://127.0.0.1:8090/v1 --sim http://127.0.0.1:8095
//
// Skill harness: the model answers each turn with exactly one tool call.
// Code harness: the model answers each turn with one ```javascript block.
// A model-server error aborts the episode as an infrastructure failure
// (valid = false), never as a task failure.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const SIM = (args.sim || "http://127.0.0.1:8095").replace(/\/$/, "");
const BASE_URL = (args["base-url"] || "http://127.0.0.1:8090/v1").replace(/\/$/, "");
const MODEL = args.model || "Qwen/Qwen3.5-9B";
const HARNESS = args.harness || "skill";
const ATTEMPTS = Number(args.attempts || 1);
const RUN = args.run || "live";
const POLICY_VERSION = Number(args["policy-version"] || 0);
const TEMPERATURE = Number(args.temperature ?? 1.0);
const API_KEY = process.env.OPENAI_API_KEY || "none";

const SKILL_TOOLS = [
  ["takeoff", "Climb vertically to altitude z (metres above the floor).", { z: "number" }],
  ["fly_to", "Fly a straight line to (x, y, z). Does NOT avoid buildings or no-fly zones.", { x: "number", y: "number", z: "number" }],
  ["move", "Fly relative to the current pose.", { dx: "number", dy: "number", dz: "number" }],
  ["hover", "Hold position for some seconds.", { seconds: "number" }],
  ["scan", "Downward camera + detector. Returns detections of crates and pads in the footprint.", {}],
  ["land", "Descend at the current x, y until touching the surface.", {}],
  ["done", "End the episode. The simulator decides success.", {}]
].map(([name, description, props]) => ({
  type: "function",
  function: {
    name, description,
    parameters: { type: "object", properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required: Object.keys(props) }
  }
}));

const SYSTEM = {
  skill: "You are the high-level planner of a quadrotor. Each turn, call exactly one tool. The flight controller flies straight lines and does not avoid obstacles: choose waypoints and altitudes that clear buildings (fly above their height) and never enter a no-fly zone (any altitude). Crates and the orange/purple pads are not on the map; find them with scan(). Wind may make you miss waypoints; correct using the reported pose. Finish with done().",
  code: "You are the high-level planner of a quadrotor. Each turn, reply with ONE ```javascript code block that controls the drone through the `drone` object: drone.takeoff(z), drone.fly_to(x,y,z), drone.move(dx,dy,dz), drone.hover(s), drone.scan(), drone.land(), drone.done(), drone.state(), drone.map, drone.instruction; print(...) to log. Primitives return results synchronously and throw on misuse. The controller flies straight lines and does not avoid obstacles. Call drone.done() when finished."
}[HARNESS];

async function sim(method, path, body) {
  const r = await fetch(SIM + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}

class InfraError extends Error {}

async function chat(messages, episodeId, turn) {
  let r;
  try {
    r = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, "x-episode-id": episodeId, "x-turn": String(turn) },
      body: JSON.stringify({
        model: MODEL, messages, temperature: TEMPERATURE, top_p: 0.95,
        ...(HARNESS === "skill" ? { tools: SKILL_TOOLS, tool_choice: "auto" } : {})
      })
    });
  } catch (e) {
    throw new InfraError(`model server unreachable: ${e.message}`);
  }
  if (!r.ok) throw new InfraError(`model server returned ${r.status}`);
  const j = await r.json();
  const msg = j.choices?.[0]?.message;
  if (!msg) throw new InfraError("model server returned no choices");
  return msg;
}

const compact = (fb) => JSON.stringify(fb).slice(0, 6000);

async function runEpisode(attempt) {
  const brief = await sim("POST", "/api/episodes", {
    task: args.task, suite: args.suite || "base", init: Number(args.init ?? 1), attempt,
    harness: HARNESS, planner: `llm:${MODEL}`, run: RUN, policy_version: POLICY_VERSION
  });
  const id = brief.episode_id;
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Task: ${brief.instruction}\n\nBriefing (JSON):\n${JSON.stringify({ map: brief.map, skills: brief.skills, inspection_rule: brief.inspection_rule, limits: brief.limits, observation: brief.observation })}` }
  ];
  let result = null;
  let idle = 0;
  try {
    for (let turn = 1; !result; turn++) {
      const msg = await chat(messages, id, turn);
      messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });

      let fb;
      if (HARNESS === "skill") {
        const call = msg.tool_calls?.[0];
        if (!call) {
          // No action: nudge, and give up (planner failure, still valid) if it keeps happening.
          if (++idle >= 3) fb = await sim("POST", `/api/episodes/${id}/act`, { skill: "done", reasoning: "planner produced no tool call" });
          else { messages.push({ role: "user", content: "Respond with exactly one tool call." }); continue; }
        } else {
          idle = 0;
          let a = {};
          try { a = JSON.parse(call.function.arguments || "{}"); } catch { a = {}; }
          fb = await sim("POST", `/api/episodes/${id}/act`, { skill: call.function.name, args: a, reasoning: msg.content || "" });
          messages.push({ role: "tool", tool_call_id: call.id, content: compact(fb) });
        }
      } else {
        const m = /```(?:javascript|js)?\s*\n([\s\S]*?)```/.exec(msg.content || "");
        const code = m ? m[1] : (msg.content || "").trim();
        fb = await sim("POST", `/api/episodes/${id}/code`, { code: code || "/* empty */", reasoning: (msg.content || "").replace(m?.[0] ?? "", "").trim() });
        messages.push({ role: "user", content: `Execution feedback:\n${compact(fb)}` });
      }
      if (fb.result) result = fb.result;
    }
  } catch (e) {
    if (e instanceof InfraError) {
      const r = await sim("POST", `/api/episodes/${id}/abort`, { reason: e.message });
      result = r.result;
    } else {
      throw e;
    }
  }
  return result;
}

for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
  const r = await runEpisode(attempt);
  process.stdout.write(JSON.stringify(r) + "\n");
}
