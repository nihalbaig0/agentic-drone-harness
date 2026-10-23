// Task suite, perturbation suites, and the initial-state split.
//
// A task is a verifiable goal over the simulator's ground truth: which crates
// must be inspected (a close-range scan) and which pad, if any, the drone must
// end up landed on. The instruction is generated from the goal, so a task
// perturbation (LIBERO-PRO "T") changes the goal and the words together.

export const CRATE_COLORS = ["red", "blue", "yellow", "green"];
export const PAD_COLORS = ["home", "orange", "purple"];

export const TASKS = [
  { id: "inspect_red",           goal: { inspect: ["red"],           land: null } },
  { id: "inspect_blue",          goal: { inspect: ["blue"],          land: null } },
  { id: "inspect_green_roof",    goal: { inspect: ["green"],         land: null } },
  { id: "land_purple",           goal: { inspect: [],                land: "purple" } },
  { id: "deliver_yellow_orange", goal: { inspect: ["yellow"],        land: "orange" } },
  { id: "deliver_red_purple",    goal: { inspect: ["red"],           land: "purple" } },
  { id: "return_blue_home",      goal: { inspect: ["blue"],          land: "home" } },
  { id: "survey_red_yellow_home", goal: { inspect: ["red", "yellow"], land: "home" } }
];

// Perturbation suites. `swap` and `task` mirror LIBERO-PRO's position-swap and
// task-perturbation axes; the rest mirror LIBERO-Plus perturbation categories,
// translated to an aerial robot.
export const SUITES = {
  base:     "Nominal scene, nominal instruction.",
  swap:     "Position swap: the target crate trades places with another crate, and the orange and purple pads trade places.",
  task:     "Task perturbation: same scene, but the instruction names a different target crate / pad.",
  language: "Language perturbation: the same goal, paraphrased.",
  wind:     "Dynamics perturbation: strong hidden wind (1.0-1.6 m/s). Waypoints are missed unless the planner compensates.",
  noise:    "Sensor noise: 3x detection position noise, false-positive detections, noisy pose readout.",
  light:    "Lighting: dim scene. Long-range detections become unreliable and the camera image is dark.",
  layout:   "Layout: a different building and no-fly-zone arrangement for the same seed (crates and pads re-placed around it)."
};

// Initial-state split, following the paper's LIBERO protocol (Sec. 4.1):
// 0 is for exploration / memory, 1-10 for evaluation, 11-44 for teacher
// demonstrations and RL rollouts, 45-49 for checkpoint selection.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const SPLITS = {
  explore: [0],
  eval: range(1, 10),
  train: range(11, 44),
  val: range(45, 49)
};

const TASK_SWAP_CRATE = { red: "yellow", yellow: "blue", blue: "red", green: "blue" };
const TASK_SWAP_PAD = { orange: "purple", purple: "orange", home: "home" };

export function perturbGoal(goal) {
  const inspect = goal.inspect.map((c) => TASK_SWAP_CRATE[c]);
  // Keep multi-target tasks well-formed if the swap collides.
  const unique = [...new Set(inspect)];
  const land = goal.land ? TASK_SWAP_PAD[goal.land] : null;
  // A pure landing task changes its pad instead.
  return { inspect: unique, land };
}

function crateName(c, alt) {
  if (c === "green") return alt ? "green crate sitting on top of a building" : "green crate on the rooftop";
  return `${c} crate`;
}

function padName(p, alt) {
  if (p === "home") return alt ? "pad you launched from" : "home pad";
  return alt ? `${p} landing pad` : `${p} pad`;
}

function joinAnd(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", the ") + " and the " + items[items.length - 1];
}

export function instructionFor(goal, paraphrase = false) {
  const crates = goal.inspect.map((c) => crateName(c, paraphrase));
  const pad = goal.land ? padName(goal.land, paraphrase) : null;
  if (!paraphrase) {
    if (crates.length && pad) return `Inspect the ${joinAnd(crates)}, then land on the ${pad}.`;
    if (crates.length) return `Inspect the ${joinAnd(crates)}.`;
    return `Land on the ${pad}.`;
  }
  if (crates.length && pad) return `Get a close-up look at the ${joinAnd(crates)}, and afterwards touch down on the ${pad}.`;
  if (crates.length) return `Take a close look at the ${joinAnd(crates)}.`;
  return `Touch down on the ${pad}.`;
}

export function getTask(taskId) {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task '${taskId}'`);
  return task;
}

// Resolve (task, suite) into what the planner sees and what the simulator
// checks. `taskKey` is the adapter's `task` field: suite and task index.
export function resolveTask(taskId, suite = "base") {
  if (!(suite in SUITES)) throw new Error(`unknown suite '${suite}'`);
  const task = getTask(taskId);
  const goal = suite === "task" ? perturbGoal(task.goal) : task.goal;
  const instruction = instructionFor(goal, suite === "language");
  return { taskKey: `${suite}/${task.id}`, goal, instruction };
}
