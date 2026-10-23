// Episode lifecycle for both execution mechanisms, plus the AgenticRoboRL
// adapter.
//
//   skill harness  -> the planner issues one skill call per turn (VLA-skill
//                     invocation, the RPent analogue)
//   code  harness  -> the planner submits a program per turn that calls the
//                     same primitives (control-code generation, CaP-X analogue)
//
// In both, only the planner's responses vary. The flight controller, the
// detector and the success check are frozen execution components.

import vm from "node:vm";
import { generateWorld, publicMap, Flight, ARENA, CEILING, INSPECT } from "./world.mjs";
import { resolveTask } from "./tasks.mjs";

export const LIMITS = {
  skill: { maxTurns: 40 },
  code: { maxTurns: 8, maxPrimitiveCalls: 200, timeoutMs: 2000 }
};

export const SKILLS = {
  takeoff: { args: ["z"], doc: "takeoff(z): climb vertically from the current landing spot to altitude z (m above floor)." },
  fly_to: { args: ["x", "y", "z"], doc: "fly_to(x, y, z): fly a STRAIGHT line to the waypoint. The controller does not avoid buildings or no-fly zones." },
  move: { args: ["dx", "dy", "dz"], doc: "move(dx, dy, dz): fly_to relative to the current pose." },
  hover: { args: ["seconds"], doc: "hover(seconds): hold position (wind still pushes you a little)." },
  scan: { args: [], doc: "scan(): downward camera + detector. Footprint radius = 0.75*altitude_above_surface + 0.5 m. Long-range detections are noisy and can miss; a crate seen within 1.5 m horizontally and at most 4 m above its surface counts as inspected." },
  land: { args: [], doc: "land(): descend at the current x, y until touching the surface below." },
  done: { args: [], doc: "done(): end the episode. The simulator, not the planner, decides success." }
};

// Thrown into planner code when a primitive is misused. Planner code may catch it.
export class PlannerError extends Error {}
PlannerError.prototype.name = "PlannerError";
// Thrown into planner code when the episode is over. Not an Error, so a broad
// catch(e) that checks `instanceof Error` will not swallow it by accident.
const EPISODE_OVER = Symbol("episode-over");

let episodeCounter = 0;
export function newEpisodeId(prefix = "ep") {
  episodeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${episodeCounter.toString(36)}`;
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Number(v.toFixed(2));

export class Episode {
  constructor({ id, task, suite = "base", init, attempt = 0, harness = "skill", planner = "unknown", policyVersion = 0, run = "live", recorder = null }) {
    if (!(harness in LIMITS)) throw new Error(`harness must be 'skill' or 'code'`);
    if (!Number.isInteger(init) || init < 0) throw new Error("init must be a non-negative integer");
    const { taskKey, goal, instruction } = resolveTask(task, suite);
    Object.assign(this, { id: id ?? newEpisodeId(), task, suite, init, attempt, harness, planner, policyVersion, run, recorder });
    this.taskKey = taskKey;
    this.goal = goal;
    this.instruction = instruction;
    this.world = generateWorld(init, suite, goal);
    this.flight = new Flight(this.world);
    this.inspected = new Set();
    this.turn = 0;
    this.calls = [];
    this.status = "running";
    this.endReason = null;
    this.result = null;
    this.createdAt = Date.now();
    this.lastTurnAt = Date.now();
    this.lastScan = null;
  }

  get maxTurns() { return LIMITS[this.harness].maxTurns; }

  // Everything the planner receives at the start: instruction, charted map,
  // the tool surface, limits, and the first observation.
  briefing() {
    return {
      episode_id: this.id,
      harness: this.harness,
      instruction: this.instruction,
      map: publicMap(this.world),
      skills: Object.fromEntries(Object.entries(SKILLS).map(([k, v]) => [k, v.doc])),
      inspection_rule: `A crate is inspected when scan() sees it from <= ${INSPECT.maxHorizontal} m horizontally and <= ${INSPECT.maxAbove} m above the crate's surface.`,
      limits: { max_turns: this.maxTurns, arena_half_extent: ARENA, ceiling: CEILING, ...(this.harness === "code" ? { max_primitive_calls_per_program: LIMITS.code.maxPrimitiveCalls, program_timeout_ms: LIMITS.code.timeoutMs } : {}) },
      observation: this.observe()
    };
  }

  observe() {
    const f = this.flight;
    return {
      pose: f.observedPose(),
      battery_pct: r2(Math.max(0, f.battery)),
      airborne: f.airborne,
      landed_on: f.landedOn,
      sim_time_s: r2(f.t),
      inspected: [...this.inspected],
      turn: this.turn,
      turns_left: this.maxTurns - this.turn,
      status: this.status
    };
  }

  // ----- primitives (shared by both harnesses) -----

  runPrimitive(name, args = {}) {
    const f = this.flight;
    const spec = SKILLS[name];
    if (!spec) throw new PlannerError(`unknown skill '${name}'. Available: ${Object.keys(SKILLS).join(", ")}`);
    const a = {};
    for (const k of spec.args) {
      const v = args[k] ?? (name === "takeoff" && k === "z" ? 3 : name === "hover" ? 1 : undefined);
      if (!finite(v)) throw new PlannerError(`${name} needs numeric '${k}'`);
      a[k] = v;
    }
    switch (name) {
      case "takeoff": {
        if (f.airborne) throw new PlannerError("already airborne");
        if (a.z < f.p.z + 0.5) throw new PlannerError(`takeoff altitude must be at least 0.5 m above the current surface (z=${r2(f.p.z)})`);
        const r = f.takeoff(Math.min(a.z, CEILING - 0.5));
        return { reached: r.reached, position_error_m: r2(r.error), duration_s: r2(r.duration) };
      }
      case "fly_to":
      case "move": {
        if (!f.airborne) throw new PlannerError("not airborne: call takeoff first");
        const [x, y, z] = name === "move" ? [f.p.x + a.dx, f.p.y + a.dy, f.p.z + a.dz] : [a.x, a.y, a.z];
        if (z < 0.5) throw new PlannerError("waypoint altitude must be >= 0.5 m; use land() to touch down");
        const r = f.flyTo(x, y, z);
        return { reached: r.reached, position_error_m: r2(r.error), duration_s: r2(r.duration) };
      }
      case "hover": {
        if (!f.airborne) throw new PlannerError("not airborne");
        f.hover(Math.max(0, Math.min(a.seconds, 30)));
        return {};
      }
      case "scan": {
        if (!f.airborne) throw new PlannerError("scan needs the drone airborne (the camera faces down)");
        const s = f.scan();
        for (const c of s.inspected) this.inspected.add(c);
        this.lastScan = { t: f.t, x: f.p.x, y: f.p.y, z: f.p.z, footprint: s.footprint_radius };
        return { detections: s.detections, footprint_radius_m: s.footprint_radius };
      }
      case "land": {
        if (!f.airborne) throw new PlannerError("already landed");
        const r = f.land();
        return r.landed ? { landed_on: r.on } : {};
      }
      case "done":
        return { acknowledged: true };
    }
  }

  // Wrap a primitive so the feedback always carries the new observation, and
  // so episode-terminating events are detected right where they happen.
  execute(name, args) {
    let feedback;
    try {
      feedback = { ok: true, ...this.runPrimitive(name, args) };
    } catch (e) {
      if (e instanceof PlannerError) feedback = { ok: false, error: e.message };
      else throw e;                  // simulator bug -> infrastructure failure
    }
    if (this.flight.failure) {
      feedback.ok = false;
      feedback.terminated = this.flight.failure;
    }
    feedback.observation = this.observe();
    return feedback;
  }

  // ----- skill harness: one skill call per turn -----

  act({ skill, args = {}, reasoning = "" }) {
    this.assertTurn("skill");
    const context = this.contextForTurn();
    this.turn += 1;
    let feedback;
    try {
      feedback = this.execute(skill, args);
    } catch (e) {
      this.record(context, { skill, args }, reasoning, { ok: false, error: "simulator error" });
      this.abort(`infra:simulator_error:${e.message}`);
      return { ok: false, error: "simulator error; episode invalidated", status: this.status, result: this.result };
    }
    this.record(context, { skill, args }, reasoning, feedback);
    if (this.flight.failure) this.finish(this.flight.failure);
    else if (skill === "done" && feedback.ok) this.finish("planner_done");
    else if (this.turn >= this.maxTurns) this.finish("turn_limit");
    feedback.observation = this.observe();
    if (this.status !== "running") feedback.result = this.result;
    return feedback;
  }

  // ----- code harness: one program per turn -----

  submitCode({ code, reasoning = "" }) {
    this.assertTurn("code");
    if (typeof code !== "string" || !code.trim()) throw new PlannerError("code must be a non-empty string");
    const context = this.contextForTurn();
    this.turn += 1;
    const logs = [];
    const trace = [];
    let calls = 0;
    let doneCalled = false;
    let infraError = null;
    const ep = this;

    const primitive = (name) => (...positional) => {
      if (ep.flight.failure || doneCalled || infraError) throw EPISODE_OVER;
      if (++calls > LIMITS.code.maxPrimitiveCalls) throw new PlannerError(`more than ${LIMITS.code.maxPrimitiveCalls} primitive calls in one program`);
      const spec = SKILLS[name];
      const args = typeof positional[0] === "object" && positional[0] !== null
        ? positional[0]
        : Object.fromEntries(spec.args.map((k, i) => [k, positional[i]]));
      let fb;
      try {
        fb = ep.execute(name, args);
      } catch (e) {
        infraError = e;
        throw EPISODE_OVER;
      }
      trace.push({ call: name, args, ok: fb.ok, ...(fb.error ? { error: fb.error } : {}), ...(fb.terminated ? { terminated: fb.terminated } : {}) });
      if (name === "done") doneCalled = true;
      if (fb.terminated) throw EPISODE_OVER;
      if (!fb.ok) throw new PlannerError(fb.error);
      const { ok, observation, ...rest } = fb;
      return JSON.parse(JSON.stringify({ ...rest, pose: observation.pose, battery_pct: observation.battery_pct }));
    };

    const drone = {
      instruction: this.instruction,
      map: JSON.parse(JSON.stringify(publicMap(this.world))),
      state: () => JSON.parse(JSON.stringify(ep.observe()))
    };
    for (const name of Object.keys(SKILLS)) drone[name] = primitive(name);

    const sandbox = {
      drone,
      print: (...xs) => { if (logs.length < 200) logs.push(xs.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); },
      PlannerError
    };
    sandbox.console = { log: sandbox.print };
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

    let error = null;
    try {
      vm.runInContext(code, ctx, { timeout: LIMITS.code.timeoutMs, filename: `turn-${this.turn}.js` });
    } catch (e) {
      if (e !== EPISODE_OVER) error = e && e.message ? `${e.name || "Error"}: ${e.message}` : String(e);
    }

    const feedback = { ok: !error && !this.flight.failure, error, logs, trace, primitive_calls: calls };
    if (this.flight.failure) feedback.terminated = this.flight.failure;
    if (infraError) {
      this.record(context, { code }, reasoning, { ok: false, error: "simulator error" });
      this.abort(`infra:simulator_error:${infraError.message}`);
      return { ok: false, error: "simulator error; episode invalidated", status: this.status, result: this.result };
    }
    feedback.observation = this.observe();
    this.record(context, { code }, reasoning, feedback);
    if (this.flight.failure) this.finish(this.flight.failure);
    else if (doneCalled) this.finish("planner_done");
    else if (this.turn >= this.maxTurns) this.finish("turn_limit");
    feedback.observation = this.observe();
    if (this.status !== "running") feedback.result = this.result;
    return feedback;
  }

  assertTurn(kind) {
    if (this.status !== "running") throw new PlannerError(`episode is ${this.status}`);
    if (this.harness !== kind) throw new PlannerError(`this episode uses the ${this.harness} harness`);
    this.lastTurnAt = Date.now();
  }

  // c_{i,t} from Eq. (1): what this turn's response is conditioned on. The full
  // history is reconstructable from earlier records; we store the immediate
  // observation and how many prior turns precede it.
  contextForTurn() {
    return { turn: this.turn + 1, prior_turns: this.turn, observation: this.observe() };
  }

  record(context, response, reasoning, feedback) {
    const rec = {
      episode_id: this.id,
      turn: this.turn,
      policy_version: this.policyVersion,
      harness: this.harness,
      planner: this.planner,
      context,
      response,
      reasoning: String(reasoning || "").slice(0, 4000),
      feedback
    };
    this.calls.push(rec);
    this.recorder?.call(this.run, rec);
  }

  // ----- outcome -----

  // Simulator success check (Table 5: "not the planner's own finish call").
  success() {
    if (this.flight.failure) return false;
    for (const c of this.goal.inspect) if (!this.inspected.has(c)) return false;
    if (this.goal.land) {
      if (this.flight.airborne) return false;
      if (this.flight.landedOn !== `${this.goal.land}_pad`) return false;
    }
    return true;
  }

  finish(reason) {
    if (this.status !== "running") return this.result;
    this.status = "finished";
    this.endReason = reason;
    const reward = this.success() ? 1 : 0;
    this.result = this.adapterRecord(reward, true);
    this.recorder?.episode(this.run, this.result, this.summary());
    return this.result;
  }

  // Infrastructure failure: excluded from optimisation (valid = false).
  abort(reason = "infra:unspecified") {
    if (this.status !== "running") return this.result;
    this.status = "aborted";
    this.endReason = reason;
    this.result = this.adapterRecord(0, false);
    this.recorder?.episode(this.run, this.result, this.summary());
    return this.result;
  }

  // The five fields of Table 5, plus the id that matches recorded calls.
  adapterRecord(reward, valid) {
    return { episode_id: this.id, task: this.taskKey, init: this.init, attempt: this.attempt, reward, valid };
  }

  summary() {
    const f = this.flight;
    return {
      episode_id: this.id, run: this.run, task: this.taskKey, init: this.init, attempt: this.attempt,
      harness: this.harness, planner: this.planner, policy_version: this.policyVersion,
      instruction: this.instruction, goal: this.goal, status: this.status, end_reason: this.endReason,
      reward: this.result?.reward ?? null, valid: this.result?.valid ?? null,
      turns: this.turn, sim_time_s: r2(f.t), battery_pct: r2(Math.max(0, f.battery)),
      inspected: [...this.inspected], landed_on: f.landedOn, airborne: f.airborne
    };
  }

  // Full ground truth + trajectory, for the spectator viewer only.
  spectate(sinceIndex = 0) {
    return {
      summary: this.summary(),
      result: this.result,
      world: this.world,
      trail: this.flight.trail.slice(sinceIndex),
      trailLength: this.flight.trail.length,
      lastScan: this.lastScan,
      calls: this.calls.map((c) => ({ turn: c.turn, response: c.response, reasoning: c.reasoning, feedback: { ...c.feedback, observation: undefined } }))
    };
  }
}
