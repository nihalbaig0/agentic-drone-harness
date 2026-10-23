#!/usr/bin/env node
// Headless group rollouts -> adapter records -> RLOO advantages -> RL samples.
//
// This is one "policy-versioned round" of the paper's pipeline (Sec. 3.2) on
// the drone harness: collect G attempts for every (task, init) under fixed
// planner weights, report success per suite, and write the training samples
// an RL trainer would consume.
//
//   node tools/rollout.mjs --split train --group 6 --suites base,wind
//   node tools/rollout.mjs --split eval --group 1 --suites all --harness code
//
// Planner: the scripted reference planner (planners/scripted.mjs). To roll out
// a real model instead, use planners/llm_planner.mjs against the HTTP server.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { Episode } from "../sim/harness.mjs";
import { Recorder } from "../sim/recorder.mjs";
import { TASKS, SUITES, SPLITS } from "../sim/tasks.mjs";
import { computeAdvantages, buildSamples } from "../sim/rloo.mjs";
import { runScripted } from "../planners/scripted.mjs";
import { hashString } from "../sim/rng.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const a = { split: "train", group: 6, suites: "base", tasks: "all", harness: "skill", run: null, policyVersion: 0, inits: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (k === "quiet") { a.quiet = true; continue; }
    const v = argv[++i];
    if (k === "split") a.split = v;
    else if (k === "group") a.group = Number(v);
    else if (k === "suites") a.suites = v;
    else if (k === "tasks") a.tasks = v;
    else if (k === "harness") a.harness = v;
    else if (k === "run") a.run = v;
    else if (k === "policy-version") a.policyVersion = Number(v);
    else if (k === "inits") a.inits = v;
    else throw new Error(`unknown flag --${k}`);
  }
  return a;
}

function parseInits(spec, split) {
  if (!spec) {
    if (!SPLITS[split]) throw new Error(`unknown split '${split}' (use ${Object.keys(SPLITS).join(", ")})`);
    return SPLITS[split];
  }
  const out = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-").map(Number);
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return out;
}

export function rollout(opts) {
  const suites = opts.suites === "all" ? Object.keys(SUITES) : opts.suites.split(",");
  const tasks = opts.tasks === "all" ? TASKS.map((t) => t.id) : opts.tasks.split(",");
  const inits = parseInits(opts.inits, opts.split);
  const run = opts.run ?? `rollout-${opts.split}-${opts.harness}-${Date.now().toString(36)}`;
  const recorder = new Recorder(path.join(root, "runs"));
  const briefings = new Map();
  const perSuite = {};
  const endReasons = {};
  let n = 0;

  for (const suite of suites) {
    perSuite[suite] = { episodes: 0, successes: 0 };
    for (const task of tasks) {
      for (const init of inits) {
        for (let attempt = 0; attempt < opts.group; attempt++) {
          const ep = new Episode({
            id: `${run}-${suite}-${task}-${init}-${attempt}`,
            task, suite, init, attempt, harness: opts.harness,
            planner: "scripted", policyVersion: opts.policyVersion, run, recorder
          });
          briefings.set(ep.id, ep.briefing());
          // The sampling seed varies with the attempt (and policy version), not the scene.
          const seed = hashString(`${task}|${init}|${attempt}|v${opts.policyVersion}`);
          const { result } = runScripted(ep, seed);
          perSuite[suite].episodes += 1;
          perSuite[suite].successes += result.reward;
          endReasons[ep.endReason.split(":")[0]] = (endReasons[ep.endReason.split(":")[0]] || 0) + 1;
          n += 1;
        }
      }
    }
  }

  const adapter = recorder.read(run, "adapter.jsonl");
  const calls = recorder.read(run, "calls.jsonl");
  const { advantage, groupStats } = computeAdvantages(adapter);
  const samples = buildSamples(calls, advantage);
  const dir = recorder.dir(run);
  writeFileSync(path.join(dir, "briefings.jsonl"), [...briefings.values()].map((b) => JSON.stringify(b)).join("\n") + "\n");
  writeFileSync(path.join(dir, "rl_samples.jsonl"), samples.map((s) => JSON.stringify(s)).join("\n") + (samples.length ? "\n" : ""));

  const informative = groupStats.filter((g) => g.informative).length;
  const summary = {
    run, split: opts.split, harness: opts.harness, policy_version: opts.policyVersion,
    group_size: opts.group, episodes: n, valid_episodes: adapter.filter((r) => r.valid).length,
    success_rate: Object.fromEntries(Object.entries(perSuite).map(([s, v]) => [s, Number((100 * v.successes / v.episodes).toFixed(1))])),
    overall_success: Number((100 * adapter.reduce((s, r) => s + r.reward, 0) / Math.max(1, adapter.length)).toFixed(1)),
    groups: groupStats.length, informative_groups: informative,
    rl_samples: samples.length, end_reasons: endReasons,
    files: ["briefings.jsonl", "calls.jsonl", "adapter.jsonl", "episodes.jsonl", "rl_samples.jsonl", "summary.json"].map((f) => path.relative(root, path.join(dir, f)))
  };
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const s = rollout(opts);
  if (!opts.quiet) {
    console.log(`\nRun ${s.run}  (${s.harness} harness, split=${s.split}, G=${s.group_size}, policy v${s.policy_version})`);
    console.log(`${s.episodes} episodes in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${s.valid_episodes} valid\n`);
    console.log("suite        success");
    for (const [suite, rate] of Object.entries(s.success_rate)) console.log(`${suite.padEnd(12)} ${rate.toFixed(1).padStart(6)}%`);
    console.log(`${"overall".padEnd(12)} ${s.overall_success.toFixed(1).padStart(6)}%\n`);
    console.log(`groups: ${s.groups}, with non-zero advantage: ${s.informative_groups} (the rest give no gradient, Eq. 4)`);
    console.log(`RL samples written: ${s.rl_samples}`);
    console.log(`end reasons: ${JSON.stringify(s.end_reasons)}`);
    console.log(`files:\n  ${s.files.join("\n  ")}`);
  }
}
