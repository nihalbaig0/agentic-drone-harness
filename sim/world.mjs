// Deterministic aerial world + flight physics.
//
// The world is a function of (init, suite) only, so every attempt in a group
// (same task, same init) flies in exactly the same scene. All randomness inside
// an episode (wind gusts, sensor noise) is seeded from (init, suite) as well, so
// the same action sequence always reproduces the same trajectory.
//
// Units: metres, seconds, radians. z is altitude above the arena floor.

import { makeRng } from "./rng.mjs";
import { CRATE_COLORS } from "./tasks.mjs";

export const ARENA = 12;          // half-extent of the flyable square
export const CEILING = 20;
export const DRONE_R = 0.3;       // collision radius
export const PAD_R = 0.8;
export const CRATE_SIZE = 0.6;
export const DT = 0.05;
export const MAX_H_SPEED = 3.0;
export const MAX_V_SPEED = 1.5;
export const KP = 1.2;            // frozen position controller gain
export const REACH_TOL = 0.4;
export const INSPECT = { maxHorizontal: 1.5, maxAbove: 4.0 };

// Distance from a point to an axis-aligned building footprint (0 if inside).
export function rectDist(px, py, b) {
  const ex = Math.max(Math.abs(px - b.x) - b.w / 2, 0);
  const ey = Math.max(Math.abs(py - b.y) - b.d / 2, 0);
  return Math.hypot(ex, ey);
}

export function surfaceAt(world, x, y) {
  let z = 0;
  for (const b of world.buildings) if (rectDist(x, y, b) === 0) z = Math.max(z, b.h);
  return z;
}

function placeBuildings(rng, home) {
  const out = [];
  const count = rng.int(7, 10);
  for (let guard = 0; out.length < count && guard < 500; guard++) {
    const b = {
      x: rng.uniform(-9.5, 9.5), y: rng.uniform(-9.5, 9.5),
      w: rng.uniform(1.8, 3.6), d: rng.uniform(1.8, 3.6), h: rng.uniform(3, 11)
    };
    if (rectDist(home.x, home.y, b) < 3.5) continue;
    const overlaps = out.some((o) =>
      Math.abs(b.x - o.x) < (b.w + o.w) / 2 + 1.2 && Math.abs(b.y - o.y) < (b.d + o.d) / 2 + 1.2);
    if (overlaps) continue;
    out.push(b);
  }
  return out.map((b, i) => ({ id: `B${i + 1}`, ...round(b) }));
}

function placeNoFly(rng, home) {
  const out = [];
  const count = rng.int(1, 2);
  for (let guard = 0; out.length < count && guard < 200; guard++) {
    const z = { x: rng.uniform(-7, 7), y: rng.uniform(-7, 7), r: rng.uniform(1.4, 2.2) };
    if (Math.hypot(z.x - home.x, z.y - home.y) < z.r + 4) continue;
    if (out.some((o) => Math.hypot(z.x - o.x, z.y - o.y) < z.r + o.r + 2)) continue;
    out.push(z);
  }
  return out.map((z, i) => ({ id: `NFZ${i + 1}`, ...round(z) }));
}

function round(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) r[k] = typeof v === "number" ? Number(v.toFixed(2)) : v;
  return r;
}

// Rejection-sample a ground spot that is clear of buildings, no-fly zones,
// home, and the points already taken.
function groundSpot(rng, world, taken, spacing) {
  let best = null;
  for (let guard = 0; guard < 400; guard++) {
    const x = rng.uniform(-10, 10), y = rng.uniform(-10, 10);
    if (world.buildings.some((b) => rectDist(x, y, b) < 1.2)) continue;
    if (world.noFly.some((z) => Math.hypot(x - z.x, y - z.y) < z.r + 1.5)) continue;
    if (Math.hypot(x - world.home.x, y - world.home.y) < 3) continue;
    if (taken.some((t) => Math.hypot(x - t.x, y - t.y) < spacing)) continue;
    best = { x, y };
    break;
  }
  return best ?? { x: rng.uniform(-10, 10), y: rng.uniform(-10, 10) };
}

export function generateWorld(init, suite = "base", goal = { inspect: [], land: null }) {
  const rHome = makeRng("home", init);
  const rBuild = makeRng("buildings", init, suite === "layout" ? "alt-layout" : "layout");
  const rObj = makeRng("objects", init);
  const rWind = makeRng("wind", init);

  const home = round({ x: -9 + rHome.uniform(-1, 1), y: -9 + rHome.uniform(-1, 1) });
  const world = { init, suite, home, buildings: [], noFly: [], crates: [], pads: [] };
  world.buildings = placeBuildings(rBuild, home);
  world.noFly = placeNoFly(rBuild, home);

  const taken = [home];
  for (const color of CRATE_COLORS) {
    if (color === "green") continue;
    const p = groundSpot(rObj, world, taken, 3.5);
    taken.push(p);
    world.crates.push({ id: `${color}_crate`, color, ...round(p), z: 0 });
  }
  // The green crate always sits on a rooftop: the planner must reason in 3D
  // (inspect from at most 4 m above the ROOF, not the ground).
  const roofs = world.buildings.filter((b) => b.w >= 2 && b.d >= 2);
  const roof = roofs.length ? roofs[Math.floor(rObj.next() * roofs.length)] : world.buildings[0];
  world.crates.push({
    id: "green_crate", color: "green",
    ...round({ x: roof.x + rObj.uniform(-0.3, 0.3) * roof.w / 2, y: roof.y + rObj.uniform(-0.3, 0.3) * roof.d / 2 }),
    z: roof.h, onBuilding: roof.id
  });

  world.pads.push({ id: "home_pad", color: "home", x: home.x, y: home.y, z: 0 });
  for (const color of ["orange", "purple"]) {
    const p = groundSpot(rObj, world, taken, 3);
    taken.push(p);
    world.pads.push({ id: `${color}_pad`, color, ...round(p), z: 0 });
  }

  if (suite === "swap") applyPositionSwap(world, goal);

  const strong = suite === "wind";
  const mag = strong ? rWind.uniform(1.0, 1.6) : rWind.uniform(0, 0.25);
  const dir = rWind.uniform(-Math.PI, Math.PI);
  world.wind = {
    x: mag * Math.cos(dir), y: mag * Math.sin(dir),
    gust: 0.25 * mag, freq: rWind.uniform(0.25, 0.6), phase: rWind.uniform(0, 2 * Math.PI)
  };
  world.sensor = {
    scanNoise: suite === "noise" ? 3 : 1,
    falsePositive: suite === "noise" ? 0.2 : 0,
    poseNoise: suite === "noise" ? 0.25 : 0,
    light: suite === "light" ? 0.45 : 1
  };
  return world;
}

const SWAP_PARTNER = { red: "blue", blue: "yellow", yellow: "red", green: "red" };

function applyPositionSwap(world, goal) {
  const target = goal.inspect[0] ?? "red";
  const a = world.crates.find((c) => c.color === target);
  const b = world.crates.find((c) => c.color === SWAP_PARTNER[target]);
  for (const k of ["x", "y", "z", "onBuilding"]) [a[k], b[k]] = [b[k], a[k]];
  for (const c of [a, b]) if (c.onBuilding === undefined) delete c.onBuilding;
  const o = world.pads.find((p) => p.color === "orange");
  const p = world.pads.find((q) => q.color === "purple");
  for (const k of ["x", "y"]) [o[k], p[k]] = [p[k], o[k]];
}

// What a planner is allowed to know up front: the "city map". Buildings and
// no-fly zones are charted; crates and the orange / purple pads are not, so
// they must be found with the camera.
export function publicMap(world) {
  return {
    arena: { x: [-ARENA, ARENA], y: [-ARENA, ARENA], ceiling: CEILING },
    home_pad: { x: world.home.x, y: world.home.y },
    buildings: world.buildings.map(({ id, x, y, w, d, h }) => ({ id, x, y, w, d, h })),
    no_fly_zones: world.noFly.map(({ id, x, y, r }) => ({ id, x, y, r }))
  };
}

// ============================================================
// Flight: the frozen low-level executor. The planner never sets
// velocities directly; it calls skills and this controller flies them.
// ============================================================

export class Flight {
  constructor(world) {
    this.world = world;
    this.p = { x: world.home.x, y: world.home.y, z: 0 };
    this.v = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.t = 0;
    this.battery = 100;
    this.airborne = false;
    this.landedOn = "home_pad";
    this.failure = null;           // set when the episode must terminate
    this.trail = [this.sample()];
    this.steps = 0;
    // Sensor noise streams depend on the suite only when the suite is about
    // sensing, so e.g. `language` differs from `base` in the words alone.
    this.profile = world.suite === "noise" || world.suite === "light" ? world.suite : "nominal";
    this.sensorRng = makeRng("sensor", world.init, this.profile);
  }

  sample() {
    return { t: Number(this.t.toFixed(2)), x: Number(this.p.x.toFixed(3)), y: Number(this.p.y.toFixed(3)), z: Number(this.p.z.toFixed(3)), yaw: Number(this.yaw.toFixed(3)) };
  }

  windAt(t) {
    const w = this.world.wind;
    const g = w.gust * Math.sin(w.freq * t + w.phase);
    const n = Math.hypot(w.x, w.y) || 1;
    return { x: w.x + g * w.x / n, y: w.y + g * w.y / n };
  }

  // One physics tick toward a commanded velocity.
  step(cmd) {
    const a = Math.min(1, DT * 4);  // first-order motor lag
    this.v.x += (cmd.x - this.v.x) * a;
    this.v.y += (cmd.y - this.v.y) * a;
    this.v.z += (cmd.z - this.v.z) * a;
    const w = this.airborne ? this.windAt(this.t) : { x: 0, y: 0 };
    this.p.x += (this.v.x + w.x) * DT;
    this.p.y += (this.v.y + w.y) * DT;
    this.p.z += this.v.z * DT;
    const hs = Math.hypot(this.v.x, this.v.y);
    if (hs > 0.2) this.yaw = Math.atan2(this.v.y, this.v.x);
    this.battery -= DT * (0.15 + 0.03 * hs + 0.2 * Math.max(this.v.z, 0));
    this.t += DT;
    if (++this.steps % 2 === 0) this.trail.push(this.sample());
    this.checkSafety();
  }

  checkSafety() {
    if (this.failure) return;
    const { x, y, z } = this.p;
    if (this.battery <= 0) { this.battery = 0; this.failure = "battery_depleted"; return; }
    if (Math.abs(x) > ARENA || Math.abs(y) > ARENA || z > CEILING) { this.failure = "geofence_breach"; return; }
    for (const nfz of this.world.noFly) {
      if (Math.hypot(x - nfz.x, y - nfz.y) < nfz.r) { this.failure = `no_fly_zone:${nfz.id}`; return; }
    }
    for (const b of this.world.buildings) {
      if (z < b.h - 0.05 && rectDist(x, y, b) < DRONE_R) { this.failure = `collision:${b.id}`; return; }
    }
    if (this.airborne && z < -0.05) this.failure = "ground_impact";
  }

  positionCmd(tx, ty, tz) {
    let cx = KP * (tx - this.p.x), cy = KP * (ty - this.p.y);
    const h = Math.hypot(cx, cy);
    if (h > MAX_H_SPEED) { cx *= MAX_H_SPEED / h; cy *= MAX_H_SPEED / h; }
    const cz = Math.max(-MAX_V_SPEED, Math.min(MAX_V_SPEED, KP * (tz - this.p.z)));
    return { x: cx, y: cy, z: cz };
  }

  // Fly a straight line to (x, y, z). The controller does NOT avoid
  // obstacles: choosing safe waypoints and altitudes is the planner's job.
  flyTo(x, y, z) {
    const t0 = this.t;
    const dist = Math.hypot(x - this.p.x, y - this.p.y, z - this.p.z);
    const budget = dist / 2 + 8;
    let reached = false;
    while (!this.failure && this.t - t0 < budget) {
      this.step(this.positionCmd(x, y, z));
      const err = Math.hypot(x - this.p.x, y - this.p.y, z - this.p.z);
      if (err < REACH_TOL && Math.hypot(this.v.x, this.v.y, this.v.z) < 0.6) { reached = true; break; }
    }
    return { reached, duration: this.t - t0, error: Math.hypot(x - this.p.x, y - this.p.y, z - this.p.z) };
  }

  hover(seconds) {
    const hold = { ...this.p };
    const t0 = this.t;
    while (!this.failure && this.t - t0 < seconds) this.step(this.positionCmd(hold.x, hold.y, hold.z));
  }

  takeoff(altitude) {
    this.airborne = true;
    this.landedOn = null;
    return this.flyTo(this.p.x, this.p.y, altitude);
  }

  land() {
    const hold = { x: this.p.x, y: this.p.y };
    const t0 = this.t;
    while (!this.failure && this.t - t0 < 40) {
      const surface = surfaceAt(this.world, this.p.x, this.p.y);
      if (this.p.z <= surface + 0.02) {
        this.p.z = surface;
        this.v = { x: 0, y: 0, z: 0 };
        this.airborne = false;
        break;
      }
      const c = this.positionCmd(hold.x, hold.y, surface);
      c.z = Math.max(-0.9, Math.min(c.z, -0.3));
      this.step(c);
    }
    if (this.failure) return { landed: false };
    this.trail.push(this.sample());
    const surface = surfaceAt(this.world, this.p.x, this.p.y);
    let on = "ground";
    if (surface > 0) {
      on = "roof:" + this.world.buildings.find((b) => rectDist(this.p.x, this.p.y, b) === 0).id;
    } else {
      const pad = this.world.pads.find((q) => Math.hypot(q.x - this.p.x, q.y - this.p.y) < PAD_R);
      if (pad) on = pad.id;
    }
    this.landedOn = on;
    return { landed: true, on };
  }

  // Downward camera + frozen detector. Returns noisy detections of crates and
  // pads inside the camera footprint. A crate is "inspected" when it is seen at
  // close range (within 1.5 m horizontally and at most 4 m above its surface).
  scan() {
    this.hover(1.0);
    this.battery -= 0.2;
    const s = this.world.sensor;
    const rng = this.sensorRng;
    const detections = [];
    const inspected = [];
    const things = [
      ...this.world.crates.map((c) => ({ ...c, label: `${c.color} crate`, kind: "crate" })),
      ...this.world.pads.map((q) => ({ ...q, label: `${q.color} pad`, kind: "pad" }))
    ];
    for (const o of things) {
      const above = this.p.z - o.z;
      if (above <= 0.2) continue;
      const dh = Math.hypot(o.x - this.p.x, o.y - this.p.y);
      if (dh > footprint(above)) continue;
      if (this.occluded(o)) continue;
      const close = dh <= INSPECT.maxHorizontal && above <= INSPECT.maxAbove;
      const pDetect = close ? 1 : Math.max(0.3, Math.min(1, 1.15 - 0.06 * above)) * s.light;
      if (rng.next() > pDetect) continue;
      const sigma = (close ? 0.05 : 0.05 * above) * s.scanNoise;
      detections.push({
        label: o.label,
        x: Number((o.x + sigma * rng.normal()).toFixed(2)),
        y: Number((o.y + sigma * rng.normal()).toFixed(2)),
        surface_z: Number(o.z.toFixed(2)),
        horizontal_dist: Number(dh.toFixed(2)),
        close_range: close
      });
      if (close && o.kind === "crate") inspected.push(o.color);
    }
    if (rng.next() < s.falsePositive) {
      const ang = rng.uniform(-Math.PI, Math.PI), rad = rng.uniform(0, footprint(this.p.z));
      detections.push({
        label: `${rng.pick(["red", "blue", "yellow", "green"])} crate`,
        x: Number((this.p.x + rad * Math.cos(ang)).toFixed(2)),
        y: Number((this.p.y + rad * Math.sin(ang)).toFixed(2)),
        surface_z: 0, horizontal_dist: Number(rad.toFixed(2)), close_range: false
      });
    }
    return { detections, inspected, footprint_radius: Number(footprint(this.p.z).toFixed(2)) };
  }

  // A ground object is hidden if the camera ray to it passes through a building.
  occluded(o) {
    for (let i = 1; i < 12; i++) {
      const f = i / 12;
      const x = this.p.x + (o.x - this.p.x) * f;
      const y = this.p.y + (o.y - this.p.y) * f;
      const z = this.p.z + (o.z + 0.3 - this.p.z) * f;
      for (const b of this.world.buildings) {
        if (b.id === o.onBuilding) continue;
        if (z < b.h && rectDist(x, y, b) === 0) return true;
      }
    }
    return false;
  }

  // Pose as the planner reads it (noisy in the `noise` suite).
  observedPose() {
    // One noisy reading per physics tick: reading the pose twice at the same
    // moment gives the same value, so how often a harness observes cannot
    // change what the planner sees.
    const n = this.world.sensor.poseNoise;
    const r = n ? makeRng("pose", this.world.init, this.profile, this.steps) : null;
    const jitter = (k) => (n ? k * n * r.normal() : 0);
    return {
      x: Number((this.p.x + jitter(1)).toFixed(2)),
      y: Number((this.p.y + jitter(1)).toFixed(2)),
      z: Number((this.p.z + jitter(0.3)).toFixed(2)),
      yaw: Number(this.yaw.toFixed(2))
    };
  }
}

// Ground radius the downward camera sees from `above` metres.
export function footprint(above) {
  return 0.75 * above + 0.5;
}
