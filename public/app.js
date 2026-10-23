import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Spectator only. The server owns physics; this page replays the recorded
// trajectory of whichever episode is being watched.
//
// World frame (server): x east, y north, z up.  three.js: x, y up, -z north.
const W = (x, y, z = 0) => new THREE.Vector3(x, z, -y);

// ============================================================
// Scene
// ============================================================

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);
scene.fog = new THREE.Fog(0x0f172a, 40, 80);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(-18, 22, 24);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 2, 0);
controls.maxPolarAngle = Math.PI * 0.48;
controls.update();

scene.add(new THREE.HemisphereLight(0xfdf6e3, 0x1e293b, 0.65));
const sun = new THREE.DirectionalLight(0xfffaf2, 1.1);
sun.position.set(10, 25, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
scene.add(sun);

const floor = new THREE.Mesh(new THREE.BoxGeometry(24, 0.1, 24), new THREE.MeshStandardMaterial({ color: 0xe6e1d2, roughness: 0.95 }));
floor.position.y = -0.05;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(24, 12, 0xb6ad95, 0xcfc8b5);
grid.position.y = 0.01;
scene.add(grid);

const COLORS = { red: 0xdc2626, blue: 0x2563eb, yellow: 0xeab308, green: 0x16a34a, orange: 0xf97316, purple: 0x9333ea, home: 0xf8fafc };

let worldGroup = new THREE.Group();
scene.add(worldGroup);

function buildWorld(world) {
  scene.remove(worldGroup);
  worldGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  worldGroup = new THREE.Group();

  for (const b of world.buildings) {
    const k = Math.min(1, Math.max(0, (b.h - 3) / 8));
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(b.w, b.h, b.d),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.6, 0.12, 0.62 - 0.25 * k), roughness: 0.8 })
    );
    mesh.position.copy(W(b.x, b.y, b.h / 2));
    mesh.castShadow = mesh.receiveShadow = true;
    worldGroup.add(mesh);
  }
  for (const z of world.noFly) {
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(z.r, z.r, 20, 40, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false })
    );
    cyl.position.copy(W(z.x, z.y, 10));
    worldGroup.add(cyl);
    const ring = new THREE.Mesh(new THREE.RingGeometry(z.r - 0.08, z.r, 48), new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(W(z.x, z.y, 0.03));
    worldGroup.add(ring);
  }
  for (const p of world.pads) {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.04, 36), new THREE.MeshStandardMaterial({ color: COLORS[p.color], roughness: 0.5 }));
    pad.position.copy(W(p.x, p.y, 0.02));
    pad.receiveShadow = true;
    worldGroup.add(pad);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.04, 8, 40), new THREE.MeshStandardMaterial({ color: 0x1e293b }));
    rim.rotation.x = -Math.PI / 2;
    rim.position.copy(W(p.x, p.y, 0.05));
    worldGroup.add(rim);
  }
  for (const c of world.crates) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: COLORS[c.color], roughness: 0.6 }));
    crate.position.copy(W(c.x, c.y, c.z + 0.3));
    crate.castShadow = true;
    worldGroup.add(crate);
  }
  scene.add(worldGroup);
}

// ----- Drone -----
const drone = new THREE.Group();
const droneBody = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.42), new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4, metalness: 0.3 }));
droneBody.castShadow = true;
drone.add(droneBody);
const nose = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.1), new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0e7490, emissiveIntensity: 0.6 }));
nose.position.set(0.24, 0.02, 0);
drone.add(nose);
const rotors = [];
for (const [ax, az] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.05), new THREE.MeshStandardMaterial({ color: 0x334155 }));
  arm.position.set(ax * 0.18, 0, az * 0.18);
  arm.rotation.y = ax * az > 0 ? -Math.PI / 4 : Math.PI / 4;
  drone.add(arm);
  const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.015, 20), new THREE.MeshStandardMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.55 }));
  rotor.position.set(ax * 0.36, 0.07, az * 0.36);
  drone.add(rotor);
  rotors.push(rotor);
}
drone.scale.setScalar(1.6);
scene.add(drone);

// Camera footprint on the surface below the drone (what scan() can see).
const footprintRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
footprintRing.rotation.x = -Math.PI / 2;
scene.add(footprintRing);
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 6), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.35 }));
scene.add(beam);

// Trail
const trailGeom = new THREE.BufferGeometry();
const trailLine = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({ color: 0x22d3ee }));
scene.add(trailLine);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ============================================================
// Watching an episode
// ============================================================

const watch = {
  id: null,
  world: null,
  trail: [],
  playT: 0,
  summary: null,
  result: null,
  callsShown: 0
};

function surfaceAt(world, x, y) {
  let z = 0;
  for (const b of world.buildings) {
    if (Math.abs(x - b.x) <= b.w / 2 && Math.abs(y - b.y) <= b.d / 2) z = Math.max(z, b.h);
  }
  return z;
}

function sampleAt(t) {
  const tr = watch.trail;
  if (!tr.length) return null;
  if (t <= tr[0].t) return tr[0];
  for (let i = 1; i < tr.length; i++) {
    if (tr[i].t >= t) {
      const a = tr[i - 1], b = tr[i];
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: b.yaw, idx: i };
    }
  }
  return { ...tr[tr.length - 1], idx: tr.length };
}

export async function watchEpisode(id) {
  if (watch.id === id) return;
  watch.id = id;
  watch.trail = [];
  watch.playT = 0;
  watch.world = null;
  watch.callsShown = 0;
  document.getElementById("callLog").innerHTML = "";
  await pollWatched();
  highlightGroupRow();
}

async function pollWatched() {
  if (!watch.id) return;
  try {
    const res = await fetch(`/spectator/episodes/${encodeURIComponent(watch.id)}?since=${watch.trail.length}`);
    if (!res.ok) return;
    const s = await res.json();
    if (!watch.world) {
      watch.world = s.world;
      buildWorld(s.world);
    }
    watch.trail.push(...s.trail);
    watch.summary = s.summary;
    watch.result = s.result;
    renderEpisodeCard();
    renderCalls(s.calls);
  } catch { /* server restarting */ }
}

function renderEpisodeCard() {
  const s = watch.summary;
  if (!s) return;
  document.getElementById("epId").textContent = s.episode_id;
  document.getElementById("epInstruction").textContent = s.instruction;
  document.getElementById("epStatus").textContent = s.status;
  const max = s.harness === "code" ? 8 : 40;
  document.getElementById("epTurn").textContent = `${s.turns} / ${max}`;
  document.getElementById("epBattery").textContent = `${Math.round(s.battery_pct)}%`;
  document.getElementById("epInspected").textContent = s.inspected.length ? s.inspected.join(", ") : "none";
  const hud = document.getElementById("hudEpisode");
  hud.textContent = `${s.task} · init ${s.init} · attempt ${s.attempt} · ${s.harness}`;
  hud.className = "pill" + (watch.result ? (watch.result.reward ? " ok" : " fail") : "");
  const box = document.getElementById("adapterBox");
  if (watch.result) {
    box.hidden = false;
    document.getElementById("adapterJson").textContent = JSON.stringify(watch.result, null, 1);
    const er = document.getElementById("endReason");
    er.textContent = `ended: ${s.end_reason}` + (watch.result.valid ? "" : " (infrastructure failure, excluded from optimisation)");
    er.className = "end-reason " + (watch.result.reward ? "ok" : "fail");
  } else {
    box.hidden = true;
  }
}

function fmtCall(c) {
  const r = c.response;
  if (r.code !== undefined) return `submit_code(${r.code.length} chars)`;
  const args = Object.entries(r.args || {}).map(([k, v]) => `${k}=${typeof v === "number" ? Number(v.toFixed(2)) : v}`).join(", ");
  return `${r.skill}(${args})`;
}

function fmtFeedback(fb) {
  if (fb.terminated) return { text: `terminated: ${fb.terminated}`, err: true };
  if (fb.error) return { text: fb.error, err: true };
  if (fb.detections) return { text: fb.detections.length ? fb.detections.map((d) => `${d.label}${d.close_range ? " (close)" : ""}`).join(", ") : "nothing detected", err: false };
  if (fb.landed_on) return { text: `landed on ${fb.landed_on}`, err: false };
  if (fb.reached !== undefined) return { text: fb.reached ? "reached" : `missed by ${fb.position_error_m} m`, err: !fb.reached };
  if (fb.trace) return { text: `${fb.primitive_calls} primitive calls` + (fb.logs?.length ? ` · ${fb.logs.length} log lines` : ""), err: false };
  return { text: "ok", err: false };
}

function renderCalls(calls) {
  const ol = document.getElementById("callLog");
  if (!calls.length) {
    // Assigning only creates the episode; a planner has to pick it up.
    const waiting = watch.summary?.planner === "claude-code" && watch.summary?.status === "running";
    ol.innerHTML = waiting
      ? `<li class="empty">Waiting for Claude Code to pick this episode up. In a terminal: <code>cd drone-sim &amp;&amp; claude</code>, then ask it to follow <code>CLAUDE_AGENT_BRIEF.md</code>. It polls <code>/api/assignment</code> and its calls appear here.</li>`
      : `<li class="empty">No planner calls yet.</li>`;
    return;
  }
  if (watch.callsShown === 0) ol.innerHTML = "";
  for (const c of calls.slice(watch.callsShown)) {
    const li = document.createElement("li");
    const fb = fmtFeedback(c.feedback);
    li.innerHTML = `<span class="turn">#${c.turn}</span><span class="call"></span><span class="fb${fb.err ? " err" : ""}"></span>`;
    li.querySelector(".call").textContent = fmtCall(c);
    li.querySelector(".fb").textContent = fb.text;
    if (c.response.code !== undefined) {
      const pre = document.createElement("pre");
      pre.textContent = c.response.code;
      li.appendChild(pre);
    }
    if (c.reasoning && !c.reasoning.startsWith("scripted")) {
      const why = document.createElement("span");
      why.className = "fb";
      why.textContent = `“${c.reasoning}”`;
      li.appendChild(why);
    }
    ol.appendChild(li);
  }
  watch.callsShown = calls.length;
  ol.scrollTop = ol.scrollHeight;
}

// Planner images (what the planner itself receives).
function refreshImages() {
  if (!watch.id) return;
  const ts = Date.now();
  document.getElementById("cameraImg").src = `/api/episodes/${encodeURIComponent(watch.id)}/camera.png?ts=${ts}`;
  document.getElementById("mapImg").src = `/api/episodes/${encodeURIComponent(watch.id)}/map.png?ts=${ts}`;
}

// ============================================================
// Panel: setup, group demo, assignment, episode list
// ============================================================

let lastGroup = null;
let meta = null;

async function loadMeta() {
  meta = await (await fetch("/api/meta")).json();
  const taskSel = document.getElementById("taskSel");
  for (const t of meta.tasks) taskSel.add(new Option(t, t, false, t === "deliver_yellow_orange"));
  const suiteSel = document.getElementById("suiteSel");
  for (const s of Object.keys(meta.suites)) suiteSel.add(new Option(s, s));
  const hint = () => { document.getElementById("suiteHint").textContent = meta.suites[suiteSel.value]; };
  suiteSel.addEventListener("change", hint);
  hint();
}

function setupBody() {
  return {
    task: document.getElementById("taskSel").value,
    suite: document.getElementById("suiteSel").value,
    init: Number(document.getElementById("initInput").value) || 0,
    harness: document.getElementById("harnessSel").value
  };
}

document.getElementById("groupBtn").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    const res = await fetch("/spectator/group", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...setupBody(), group: 6 }) });
    lastGroup = await res.json();
    renderGroup();
    const firstWin = lastGroup.members.find((m) => m.reward === 1) ?? lastGroup.members[0];
    watch.id = null;
    await watchEpisode(firstWin.episode_id);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById("assignBtn").addEventListener("click", async () => {
  const res = await fetch("/spectator/assign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(setupBody()) });
  const body = await res.json();
  if (body.episode_id) await watchEpisode(body.episode_id);
});

function renderGroup() {
  if (!lastGroup) return;
  document.getElementById("groupCard").hidden = false;
  document.getElementById("groupKey").textContent = `${lastGroup.task} · init ${lastGroup.init}`;
  const tbody = document.getElementById("groupRows");
  tbody.innerHTML = "";
  for (const m of lastGroup.members) {
    const tr = document.createElement("tr");
    tr.dataset.id = m.episode_id;
    const a = m.advantage;
    tr.innerHTML = `<td>${m.attempt}</td><td class="${m.reward ? "pos" : "neg"}">${m.reward}</td><td class="${a > 0 ? "pos" : a < 0 ? "neg" : ""}">${a > 0 ? "+" : ""}${a.toFixed(2)}</td><td></td><td>${m.turns}</td>`;
    tr.children[3].textContent = m.end_reason;
    tr.addEventListener("click", () => watchEpisode(m.episode_id));
    tbody.appendChild(tr);
  }
  const wins = lastGroup.members.filter((m) => m.reward).length;
  document.getElementById("groupNote").textContent = wins === 0 || wins === lastGroup.members.length
    ? "Every attempt got the same reward, so every advantage is 0: this group contributes no policy gradient."
    : `${wins}/${lastGroup.members.length} succeeded. Successful turns are pushed up, failed ones down.`;
  highlightGroupRow();
}

function highlightGroupRow() {
  document.querySelectorAll("#groupRows tr").forEach((tr) => tr.classList.toggle("watching", tr.dataset.id === watch.id));
}

let lastAssignment = null;
async function pollOverview() {
  try {
    const o = await (await fetch("/spectator/overview")).json();
    // Auto-follow a newly assigned Claude Code episode.
    if (o.assignment && o.assignment !== lastAssignment) {
      lastAssignment = o.assignment;
      watchEpisode(o.assignment);
    }
    if (!watch.id && o.episodes.length) watchEpisode(o.episodes[0].episode_id);
    const ul = document.getElementById("episodeList");
    ul.innerHTML = "";
    for (const e of o.episodes.slice(0, 15)) {
      const li = document.createElement("li");
      const tag = e.status === "running" ? `<span class="run">running</span>` : e.valid === false ? `<span class="r0">invalid</span>` : `<span class="r${e.reward}">R=${e.reward}</span>`;
      li.innerHTML = `<span></span>${tag}`;
      li.firstChild.textContent = `${e.planner} · ${e.task} · i${e.init} a${e.attempt}`;
      li.addEventListener("click", () => watchEpisode(e.episode_id));
      ul.appendChild(li);
    }
  } catch { /* server restarting */ }
}

// ============================================================
// Render loop
// ============================================================

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.1, clock.getDelta());
  const tr = watch.trail;
  if (tr.length) {
    const end = tr[tr.length - 1].t;
    const backlog = end - watch.playT;
    const speed = Math.max(4, backlog / 6);           // catch up on long rollouts
    watch.playT = Math.min(end, watch.playT + dt * speed);
    const s = sampleAt(watch.playT);
    drone.position.copy(W(s.x, s.y, s.z + 0.1));
    drone.rotation.y = s.yaw;
    const flying = s.z > 0.15;
    for (const r of rotors) r.rotation.y += flying ? dt * 60 : 0;

    const ground = watch.world ? surfaceAt(watch.world, s.x, s.y) : 0;
    const above = Math.max(0, s.z - ground);
    const fp = 0.75 * above + 0.5;
    footprintRing.visible = beam.visible = flying;
    footprintRing.scale.setScalar(fp);
    footprintRing.position.copy(W(s.x, s.y, ground + 0.04));
    beam.scale.y = Math.max(0.01, above);
    beam.position.copy(W(s.x, s.y, ground + above / 2));

    const n = Math.min(s.idx ?? tr.length, tr.length);
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = W(tr[i].x, tr[i].y, tr[i].z); pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z; }
    trailGeom.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    trailGeom.setDrawRange(0, n);
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

await loadMeta();
resize();
setInterval(pollWatched, 400);
setInterval(pollOverview, 1500);
setInterval(refreshImages, 1200);
pollOverview();
requestAnimationFrame(tick);
