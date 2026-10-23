// Append-only run storage. One directory per run:
//
//   runs/<run>/calls.jsonl     every planner request/response at the harness boundary
//   runs/<run>/adapter.jsonl   one AgenticRoboRL adapter record per episode (Table 5)
//   runs/<run>/episodes.jsonl  richer per-episode metadata (end reason, turns, battery, ...)

import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

export class Recorder {
  constructor(root) {
    this.root = root;
  }

  dir(run) {
    if (!/^[\w.-]{1,80}$/.test(run)) throw new Error(`bad run name '${run}'`);
    const d = path.join(this.root, run);
    mkdirSync(d, { recursive: true });
    return d;
  }

  append(run, file, obj) {
    appendFileSync(path.join(this.dir(run), file), JSON.stringify(obj) + "\n");
  }

  call(run, rec) { this.append(run, "calls.jsonl", rec); }

  episode(run, adapterRecord, summary) {
    this.append(run, "adapter.jsonl", adapterRecord);
    this.append(run, "episodes.jsonl", summary);
  }

  read(run, file) {
    const p = path.join(this.dir(run), file);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}
