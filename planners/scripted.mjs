// A scripted stand-in for a sampled planner, used to exercise the pipeline
// end to end without a model server.
//
// `strategy` is written to be fully self-contained (no imports, no closures),
// so the SAME function can be:
//   * driven turn by turn through the skill harness (one skill call per turn), or
//   * serialised with .toString() and submitted as a program to the code harness.
//
// `seed` plays the role of sampling temperature: different attempts on the same
// (task, init) make different choices (cruise altitude, whether they check the
// no-fly zones, whether they correct for wind), which is what gives a group
// non-zero reward variance and therefore a learning signal under RLOO.

import { Episode } from "../sim/harness.mjs";

export function strategy(drone, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const map = drone.map;
  const text = drone.instruction.toLowerCase();

  // --- parse the instruction ---
  const colors = ["red", "blue", "yellow", "green"]
    .filter((c) => text.includes(c + " crate"))
    .sort((a, b) => text.indexOf(a + " crate") - text.indexOf(b + " crate"));
  const needLand = /\bland\b|touch down|set down/.test(text);
  let padLabel = null;
  if (needLand) {
    const m = text.match(/(orange|purple)\s+(landing\s+)?pad/);
    padLabel = m ? m[1] + " pad" : "home pad";
  }

  // --- sampled plan style for this attempt ---
  const tallest = Math.max(...map.buildings.map((b) => b.h));
  const cruise = rand() < 0.8 ? tallest + 1.5 : Math.max(3, tallest - 1 - 3 * rand());
  const surveyAlt = Math.min(18, Math.max(cruise, tallest + 3));
  const checkNoFly = rand() < 0.75;
  const fixWind = rand() < 0.7;

  const known = {};
  if (padLabel === "home pad") known["home pad"] = { x: map.home_pad.x, y: map.home_pad.y, surface_z: 0 };
  const remember = (res) => {
    for (const d of res.detections) {
      if (!known[d.label] || d.close_range || (!known[d.label].close_range && d.horizontal_dist < known[d.label].horizontal_dist)) known[d.label] = d;
    }
  };

  let here = drone.state().pose;

  // Segment / circle intersection with a safety margin.
  const crosses = (ax, ay, bx, by, z, margin) => {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    let t = ((z.x - ax) * dx + (z.y - ay) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + t * dx - z.x, ay + t * dy - z.y) < z.r + margin;
  };

  const leg = (x, y, z) => {
    let r = drone.fly_to(x, y, z);
    if (!r.reached && fixWind) {
      // Aim past the waypoint by the observed steady-state offset.
      r = drone.fly_to(x + (x - r.pose.x), y + (y - r.pose.y), z);
    }
    here = r.pose;
    return r;
  };

  const blockedBy = (ax, ay, bx, by) => map.no_fly_zones.find((z) => crosses(ax, ay, bx, by, z, 0.8));

  // Keep a waypoint out of every no-fly zone (pushed radially outward).
  const clearOfZones = (x, y) => {
    for (const z of map.no_fly_zones) {
      const dx = x - z.x, dy = y - z.y, d = Math.hypot(dx, dy);
      if (d < z.r + 1.2) {
        const n = d || 1;
        x = z.x + ((d ? dx : 1) / n) * (z.r + 1.5);
        y = z.y + ((d ? dy : 0) / n) * (z.r + 1.5);
      }
    }
    return [x, y];
  };

  const go = (x, y, z, depth = 0) => {
    if (checkNoFly) {
      [x, y] = clearOfZones(x, y);
      const nfz = depth < 4 ? blockedBy(here.x, here.y, x, y) : null;
      if (nfz) {
        // Detour through a point beside the zone, on the side the path already leans to.
        let mx = (here.x + x) / 2 - nfz.x, my = (here.y + y) / 2 - nfz.y;
        if (Math.hypot(mx, my) < 0.3) { mx = -(y - here.y); my = x - here.x; }
        const n = Math.hypot(mx, my) || 1;
        go(nfz.x + (mx / n) * (nfz.r + 1.8), nfz.y + (my / n) * (nfz.r + 1.8), z, depth + 1);
        return go(x, y, z, depth + 1);
      }
    }
    return leg(x, y, z);
  };

  const find = (label) => {
    if (known[label]) return known[label];
    const points = [[0, 0], [-6, 6], [6, 6], [6, -6], [-6, -6]];
    for (const [px, py] of points) {
      go(px, py, surveyAlt);
      remember(drone.scan());
      if (known[label]) return known[label];
    }
    return null;
  };

  const approach = (label, hoverAbove) => {
    for (let k = 0; k < 3; k++) {
      const o = known[label];
      go(o.x, o.y, Math.max(cruise, o.surface_z + 1.5));
      leg(o.x, o.y, o.surface_z + hoverAbove);
      const res = drone.scan();
      remember(res);
      if (res.detections.some((d) => d.label === label && d.close_range)) return true;
    }
    return false;
  };

  drone.takeoff(cruise);
  here = drone.state().pose;

  for (const c of colors) {
    const label = c + " crate";
    if (!find(label)) continue;
    approach(label, 2.5);
    leg(here.x, here.y, cruise);
  }

  if (padLabel) {
    if (find(padLabel)) {
      approach(padLabel, 2.0);
      const p = known[padLabel];
      leg(p.x, p.y, 1.5);
      drone.land();
    }
  }
  drone.done();
}

// Thrown to unwind the strategy once the episode has ended.
class Stop {}

// Drive `strategy` through an Episode using the SKILL harness: every primitive
// call is one recorded planner turn.
export function runSkillEpisode(ep, seed) {
  const drone = {
    instruction: ep.instruction,
    map: ep.briefing().map,
    state: () => ep.observe()
  };
  for (const name of ["takeoff", "fly_to", "move", "hover", "scan", "land", "done"]) {
    drone[name] = (...positional) => {
      if (ep.status !== "running") throw new Stop();
      const keys = { takeoff: ["z"], fly_to: ["x", "y", "z"], move: ["dx", "dy", "dz"], hover: ["seconds"] }[name] || [];
      const args = Object.fromEntries(keys.map((k, i) => [k, positional[i]]));
      const fb = ep.act({ skill: name, args, reasoning: `scripted(seed=${seed})` });
      if (ep.status !== "running" && name !== "done") throw new Stop();
      return { ...fb, pose: fb.observation?.pose, detections: fb.detections ?? [] };
    };
  }
  try {
    strategy(drone, seed);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  if (ep.status === "running") ep.finish("planner_stopped");
  return ep.result;
}

// Drive the same strategy through the CODE harness: the whole plan is one
// generated program, submitted as a single turn.
export function programFor(seed) {
  return `(${strategy.toString()})(drone, ${seed >>> 0});`;
}

export function runCodeEpisode(ep, seed) {
  ep.submitCode({ code: programFor(seed), reasoning: `scripted program (seed=${seed})` });
  if (ep.status === "running") ep.finish("planner_stopped");
  return ep.result;
}

export function runScripted(opts, seed) {
  const ep = opts instanceof Episode ? opts : new Episode(opts);
  return { episode: ep, result: ep.harness === "code" ? runCodeEpisode(ep, seed) : runSkillEpisode(ep, seed) };
}
