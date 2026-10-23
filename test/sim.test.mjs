import { test } from "node:test";
import assert from "node:assert/strict";
import { Episode } from "../sim/harness.mjs";
import { generateWorld, rectDist } from "../sim/world.mjs";
import { resolveTask, TASKS, SUITES } from "../sim/tasks.mjs";
import { computeAdvantages, buildSamples } from "../sim/rloo.mjs";
import { renderCamera, renderMap } from "../sim/render.mjs";
import { runScripted, strategy } from "../planners/scripted.mjs";
import { hashString } from "../sim/rng.mjs";

const ACTIONS = [
  { skill: "takeoff", args: { z: 12 } },
  { skill: "fly_to", args: { x: 0, y: -8, z: 12 } },
  { skill: "scan" },
  { skill: "fly_to", args: { x: 3, y: -6, z: 12 } },
  { skill: "scan" }
];

function play(opts, actions) {
  const ep = new Episode(opts);
  const fbs = actions.map((a) => ep.act(a));
  return { ep, fbs };
}

test("same (task, init, action sequence) reproduces the same trajectory and feedback", () => {
  for (const suite of ["base", "wind", "noise"]) {
    const a = play({ task: "inspect_red", init: 7, suite }, ACTIONS);
    const b = play({ task: "inspect_red", init: 7, suite, attempt: 3 }, ACTIONS);
    assert.deepEqual(a.ep.flight.trail, b.ep.flight.trail, suite);
    assert.deepEqual(a.fbs, b.fbs, suite);
  }
});

test("the world depends on init only: every attempt of a group shares the scene", () => {
  const w1 = new Episode({ task: "inspect_red", init: 12, attempt: 0 }).world;
  const w2 = new Episode({ task: "land_purple", init: 12, attempt: 5 }).world;
  assert.deepEqual(w1, w2);
  assert.notDeepEqual(w1, new Episode({ task: "inspect_red", init: 13 }).world);
});

test("calling done() without doing the task gives reward 0 (simulator decides, not the planner)", () => {
  const ep = new Episode({ task: "land_purple", init: 2 });
  ep.act({ skill: "takeoff", args: { z: 5 } });
  const fb = ep.act({ skill: "done" });
  assert.equal(ep.status, "finished");
  assert.deepEqual(fb.result, { episode_id: ep.id, task: "base/land_purple", init: 2, attempt: 0, reward: 0, valid: true });
});

test("landing on the right pad gives reward 1", () => {
  // Pick an init whose straight home -> purple-pad line misses every no-fly
  // zone, then fly it above the rooftops. This test is about the reward, so it
  // uses ground truth for the pad position.
  const clear = (w, p) => w.noFly.every((z) => {
    const ax = w.home.x, ay = w.home.y, dx = p.x - ax, dy = p.y - ay;
    const t = Math.max(0, Math.min(1, ((z.x - ax) * dx + (z.y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(ax + t * dx - z.x, ay + t * dy - z.y) > z.r + 0.5;
  });
  let ep = null;
  for (let init = 1; init < 50 && !ep; init++) {
    const cand = new Episode({ task: "land_purple", init });
    if (clear(cand.world, cand.world.pads.find((p) => p.color === "purple"))) ep = cand;
  }
  assert.ok(ep, "no init with a clear path");
  const pad = ep.world.pads.find((p) => p.color === "purple");
  const cruise = Math.max(...ep.world.buildings.map((b) => b.h)) + 2;
  ep.act({ skill: "takeoff", args: { z: cruise } });
  ep.act({ skill: "fly_to", args: { x: pad.x, y: pad.y, z: cruise } });
  ep.act({ skill: "fly_to", args: { x: pad.x, y: pad.y, z: 1.5 } });
  const landed = ep.act({ skill: "land" });
  assert.equal(landed.landed_on, "purple_pad", JSON.stringify(landed));
  const fb = ep.act({ skill: "done" });
  assert.equal(fb.result.reward, 1, ep.endReason);
});

test("flying through a building terminates the episode with reward 0 (valid failure)", () => {
  const ep = new Episode({ task: "inspect_red", init: 3 });
  const b = ep.world.buildings[0];
  ep.act({ skill: "takeoff", args: { z: 1 } });
  const fb = ep.act({ skill: "fly_to", args: { x: b.x, y: b.y, z: 1 } });
  assert.ok(fb.terminated?.startsWith("collision:") || fb.terminated?.startsWith("no_fly_zone:"), JSON.stringify(fb.terminated));
  assert.equal(ep.result.reward, 0);
  assert.equal(ep.result.valid, true);
});

test("misused skills return an error to the planner and do not end the episode", () => {
  const ep = new Episode({ task: "inspect_red", init: 3 });
  assert.equal(ep.act({ skill: "fly_to", args: { x: 0, y: 0, z: 5 } }).ok, false);   // not airborne
  assert.equal(ep.act({ skill: "teleport" }).ok, false);
  assert.equal(ep.status, "running");
  assert.equal(ep.turn, 2);
});

test("code harness: an exception in generated code is a valid failure with reward 0", () => {
  const ep = new Episode({ task: "inspect_red", init: 4, harness: "code" });
  const fb = ep.submitCode({ code: "drone.takeoff(6); undefinedFunction();" });
  assert.match(fb.error, /ReferenceError/);
  assert.equal(ep.status, "running");
  ep.submitCode({ code: "drone.done();" });
  assert.equal(ep.result.valid, true);
  assert.equal(ep.result.reward, 0);
});

test("code harness: infinite loops are stopped by the timeout", () => {
  const ep = new Episode({ task: "inspect_red", init: 4, harness: "code" });
  const fb = ep.submitCode({ code: "while (true) {}" });
  assert.match(fb.error, /timed out/i);
  assert.equal(ep.status, "running");
});

test("infrastructure failure gives valid=false, and the adapter record has exactly the five fields + id", () => {
  const ep = new Episode({ task: "inspect_red", init: 4 });
  ep.act({ skill: "takeoff", args: { z: 6 } });
  const r = ep.abort("infra:model_server_down");
  assert.deepEqual(Object.keys(r).sort(), ["attempt", "episode_id", "init", "reward", "task", "valid"]);
  assert.equal(r.valid, false);
  assert.equal(r.reward, 0);
});

test("a simulator bug during a skill is attributed to infrastructure", () => {
  const ep = new Episode({ task: "inspect_red", init: 4 });
  ep.flight.scan = () => { throw new Error("detector crashed"); };
  ep.act({ skill: "takeoff", args: { z: 6 } });
  ep.act({ skill: "scan" });
  assert.equal(ep.status, "aborted");
  assert.equal(ep.result.valid, false);
});

test("RLOO advantages follow Eq. 4 and skip invalid episodes and equal-reward groups", () => {
  const rec = (id, task, init, reward, valid = true) => ({ episode_id: id, task, init, attempt: 0, reward, valid });
  const records = [
    rec("a", "base/t", 1, 1), rec("b", "base/t", 1, 0), rec("c", "base/t", 1, 0), rec("d", "base/t", 1, 1), rec("x", "base/t", 1, 1, false),
    rec("e", "base/t", 2, 1), rec("f", "base/t", 2, 1)
  ];
  const { advantage, groupStats } = computeAdvantages(records);
  assert.equal(advantage.get("a"), 1 - 1 / 3);
  assert.equal(advantage.get("b"), 0 - 2 / 3);
  assert.equal(advantage.has("x"), false);
  assert.equal(advantage.get("e"), 0);
  assert.deepEqual(groupStats.map((g) => g.informative), [true, false]);

  const calls = Array.from({ length: 20 }, (_, i) => ({ episode_id: "a", turn: i + 1, policy_version: 0, context: { observation: {} }, response: { skill: "scan" }, reasoning: "" }))
    .concat([{ episode_id: "e", turn: 1, policy_version: 0, context: { observation: {} }, response: { skill: "done" }, reasoning: "" }]);
  const samples = buildSamples(calls, advantage);
  assert.equal(samples.length, 16);                     // capped at 16 per episode, none from the zero-advantage group
  assert.ok(samples.every((s) => s.episode_id === "a" && Math.abs(s.weight - 1 / 16) < 1e-9));
  assert.equal(samples[1].context.history.length, samples[1].turn - 1);
});

test("scripted planner: both harnesses run the same plan, and groups have reward variance", () => {
  let informative = 0;
  for (const suite of ["base", "noise"]) {
    for (let init = 11; init <= 20; init++) {
      const rewards = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const seed = hashString(`deliver_yellow_orange|${init}|${attempt}`);
        const s = runScripted({ task: "deliver_yellow_orange", suite, init, attempt, harness: "skill" }, seed).result.reward;
        const c = runScripted({ task: "deliver_yellow_orange", suite, init, attempt, harness: "code" }, seed).result.reward;
        assert.equal(s, c, `${suite} init ${init} attempt ${attempt}: skill ${s} vs code ${c}`);
        rewards.push(s);
      }
      const sum = rewards.reduce((x, y) => x + y, 0);
      if (suite === "base" && sum > 0 && sum < 6) informative++;
    }
  }
  assert.ok(informative >= 3, `only ${informative}/10 groups had reward variance`);
});

test("strategy is self-contained, so it can be submitted as generated code", () => {
  assert.doesNotThrow(() => new Function(`return (${strategy.toString()})`)());
});

test("perturbation suites do what they say", () => {
  const base = generateWorld(5, "base", resolveTask("inspect_red", "base").goal);
  const swap = generateWorld(5, "swap", resolveTask("inspect_red", "swap").goal);
  const red = (w) => w.crates.find((c) => c.color === "red");
  const blue = (w) => w.crates.find((c) => c.color === "blue");
  assert.deepEqual([red(swap).x, red(swap).y], [blue(base).x, blue(base).y]);
  assert.notEqual(resolveTask("inspect_red", "task").instruction, resolveTask("inspect_red", "base").instruction);
  assert.notEqual(resolveTask("inspect_red", "language").instruction, resolveTask("inspect_red", "base").instruction);
  assert.deepEqual(resolveTask("inspect_red", "language").goal, resolveTask("inspect_red", "base").goal);
  const wind = generateWorld(5, "wind");
  assert.ok(Math.hypot(wind.wind.x, wind.wind.y) >= 1.0);
  assert.notDeepEqual(generateWorld(5, "layout").buildings, base.buildings);
  assert.equal(Object.keys(SUITES).length, 8);
});

test("generated worlds are well-formed for every eval/train init", () => {
  for (let init = 0; init < 50; init++) {
    const w = generateWorld(init);
    const green = w.crates.find((c) => c.color === "green");
    const roof = w.buildings.find((b) => b.id === green.onBuilding);
    assert.ok(roof && rectDist(green.x, green.y, roof) === 0 && green.z === roof.h, `init ${init}: green crate not on a roof`);
    for (const c of w.crates.filter((c) => c.color !== "green")) {
      assert.ok(w.buildings.every((b) => rectDist(c.x, c.y, b) > 0.5), `init ${init}: ${c.id} inside a building`);
    }
  }
  for (const t of TASKS) assert.ok(resolveTask(t.id, "task").goal.inspect.length + (resolveTask(t.id, "task").goal.land ? 1 : 0) > 0);
});

test("images are valid PNGs", () => {
  const ep = new Episode({ task: "inspect_red", init: 1, suite: "light" });
  ep.act({ skill: "takeoff", args: { z: 6 } });
  for (const png of [renderCamera(ep), renderMap(ep)]) {
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
});

test("language perturbation changes only the words: same actions give the same outcome as base", () => {
  const a = play({ task: "inspect_red", init: 9, suite: "base" }, ACTIONS);
  const b = play({ task: "inspect_red", init: 9, suite: "language" }, ACTIONS);
  assert.deepEqual(a.fbs, b.fbs);
});
