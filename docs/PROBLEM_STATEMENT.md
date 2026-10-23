# Does planner post-training transfer to a new embodiment?

**An aerial harness for AgenticRoboRL**

*Proposal and working prototype. It builds on Liu et al., "AgenticRoboRL:
Bringing Coding-Agent Post-Training to Agentic Robotics" (arXiv:2610.28589).*

---

## 1. Motivation

AgenticRoboRL shows that the post-training recipe of coding agents (SFT on
teacher trajectories, then multi-turn RL with a terminal success reward and a
leave-one-out baseline) improves a 9B robot **planner** while every execution
component stays frozen. On LIBERO-PRO it raises success from 18.1% to 71.0%,
and with the CaP-X harness from 2.7% to 28.5%.

The paper says the framework is general across harnesses, and Figure 2 leaves
a dashed box for *"additional harnesses / new adapter"*. Two questions are
still open:

1. **One embodiment.** Both harnesses drive a tabletop manipulator in LIBERO.
   We do not yet know whether the recipe transfers when the frozen executor is
   different in kind, such as a flight controller instead of a VLA or motion
   planner.
2. **Confounded harness comparison.** The two harnesses are evaluated on
   different task subsets and observation settings: CaP-X uses 60
   Object/Goal/Spatial tasks with privileged state. So the effect of the
   *execution mechanism* (skill calls versus generated code) on post-training
   gains is not isolated.

This project builds a harness that tests both questions at once.

## 2. Problem statement

> **Train only the high-level planner of a quadrotor, a language model, to
> carry out language-specified search, inspection and delivery missions in a
> cluttered 3D city block. The flight controller, the perception module and the
> success check stay frozen. Measure whether AgenticRoboRL's SFT + multi-turn
> RL recipe, plugged in through a new adapter and otherwise unchanged, improves
> success and robustness, and whether the gain depends on the execution
> mechanism when tasks and initial states are held fixed.**

Formally, in the paper's notation: a task `ξ = (x, s⁰)` is an instruction
`x` (for example *"Inspect the yellow crate, then land on the orange pad"*)
and a seeded initial state `s⁰` (city layout, object and pad positions, hidden
wind). At turn `t` the harness builds the context `c_t = Φ(x, o_≤t, y_<t)`.
The planner emits `y_t ~ π_θ(· | c_t)`, which is either one skill call or one
program. The objective is Eq. 2 unchanged:
`max_θ E[R(τ)]` with `R(τ) = 1[task success]`, judged by the simulator.

What makes the aerial version hard, and different from tabletop manipulation:

| Property | In this harness | Why it stresses the planner |
|---|---|---|
| Partial observability | Crates and two of three pads are **not on the map**. The camera footprint grows with altitude, but detections get noisier and less reliable | The planner must explore: trade wide noisy scans against precise low ones over many turns |
| 3D geometric reasoning | Buildings have heights, and one target sits **on a rooftop** | "Inspect" means at most 4 m above the *roof*, and cruise altitude must clear the tallest building on the path |
| Hard safety constraints | No-fly zones are columns at every altitude. Collisions, geofence and battery are terminal | One bad waypoint ends the episode, so verifiable and unforgiving |
| Hidden dynamics | Seeded wind gives steady-state waypoint misses | The planner must use execution feedback to compensate, a closed-loop multi-turn skill |
| Frozen low-level control | `fly_to` flies a straight line and does **not** avoid obstacles | All the intelligence that can be trained lives in the planner, as in the paper |

## 3. Research questions

- **RQ1. Embodiment transfer.** Does SFT + RLOO, applied through a new
  adapter with the trainer unchanged, improve a 9B planner on an aerial harness
  as it does on LIBERO-PRO? How much comes from SFT and how much from RL?
- **RQ2. Execution mechanism, controlled.** With the *same* world, tasks,
  initial states and frozen components, does post-training help the
  skill-call harness (RPent-like) and the control-code harness (CaP-X-like)
  equally? This harness offers both on one simulator, and the reference planner
  produces identical rewards through either one (Section 6), so any difference
  comes from the mechanism.
- **RQ3. Post-training versus memory under hidden dynamics.** The paper's
  strongest baselines use external memory. On the `wind` suite, does a
  post-trained planner *without* memory learn to use execution feedback, such
  as a missed waypoint plus its offset, as well as a frontier agent that keeps
  notes across episodes? The TurboPi project in the parent directory is
  exactly such a memory condition: the agent writes per-camera calibration
  "skill files" it reuses later.
- **RQ4. Does terminal-only reward teach safety?** The paper uses no
  shaping. In a domain where most failures are constraint violations, does RL
  on `1[success]` alone reduce the violation rate, or does it make the planner
  more aggressive? Violations are logged per episode as a diagnostic, never as
  reward.

## 4. Benchmark design

**Tasks (8).** Inspect one crate (×2), inspect the rooftop crate, land on a
pad, inspect-then-deliver (×2), inspect-and-return-home, and a two-crate
survey with return.

**Perturbation suites (8).** These mirror LIBERO-PRO (axes S and T) and
LIBERO-Plus:

| Suite | Analogue | What changes |
|---|---|---|
| `base` | none | nominal |
| `swap` | LIBERO-PRO position swap | the target crate trades places with another (rooftop ↔ ground), and the orange and purple pads swap |
| `task` | LIBERO-PRO task perturbation | same scene, different target crate or pad in the instruction |
| `language` | LIBERO-Plus language | paraphrased instruction, same goal |
| `wind` | LIBERO-Plus robot / dynamics | hidden 1.0–1.6 m/s wind |
| `noise` | LIBERO-Plus sensor noise | 3× detection noise, false positives, noisy pose |
| `light` | LIBERO-Plus lighting | dim scene: unreliable long-range detections, dark camera |
| `layout` | LIBERO-Plus layout | a different building and no-fly-zone arrangement for the same seed (crates and pads re-placed around it) |

Each suite differs from `base` **only** in its stated factor. All other random
streams are shared, and a test enforces this.

**Initial-state split (as in the paper, Sec. 4.1).** 0 explore, 1–10 eval,
11–44 teacher data and RL rollouts, 45–49 checkpoint selection. Evaluation is
8 tasks × 10 inits = 80 episodes per suite, 640 in total.

**Adapter (Table 5).** Every episode emits exactly
`{episode_id, task, init, attempt, reward, valid}`:

- `task` is `suite/task_id`
- `reward` is the simulator's success check, never the planner's `done()`
- `valid = false` only for infrastructure failures: the model server is down
  or returns 5xx, the planner never comes back, or the simulator raises an
  internal error

Crashes, no-fly-zone breaches, exhausted turns and exceptions in generated
code are **valid** failures with reward 0, as in CaP-X.

## 5. Proposed experiment, mirroring the paper

| Stage | Setting |
|---|---|
| Student | Qwen3.5-9B behind `proxy.mjs` (records context, tokens and logprobs per call) |
| Teacher | a larger open model, or Claude Code, on inits 11–44, keeping successful episodes |
| SFT | one epoch on accepted teacher turns, context masked (Eq. 3) |
| RL | rounds of 64 groups × 6 attempts at temperature 1.0, RLOO advantage (Eq. 4), at most 16 responses per episode with weight `1/K` (Eq. 5), dual-clip PPO loss. Groups with equal rewards are dropped |
| Selection | inits 45–49 |
| Report | success per suite on inits 1–10 for base / SFT / SFT+RL / teacher / Claude Code, plus violation rate, turns and battery as diagnostics |

**Compute.** The simulator is headless and deterministic. 3,840 episodes
of the reference planner run in about 5 s on a laptop, so collection cost is
almost entirely model inference. Compare LIBERO's 7,200 s episode limit.
Episodes need about 10–40 turns.

## 6. What exists today (measured)

Everything below is runnable in `drone-sim/`, and the numbers come from
`node tools/rollout.mjs`.

**Reference (scripted, stochastic) planner** on the eval split, G = 6
attempts per (task, init), 480 episodes per suite:

| Harness | base | swap | task | language | wind | noise | light | layout | overall |
|---|---|---|---|---|---|---|---|---|---|
| skill calls | 42.3 | 48.8 | 52.5 | 42.3 | 16.7 | 16.7 | 17.3 | 34.4 | 33.9 |
| control code | 42.3 | 48.8 | 52.5 | 42.3 | 16.7 | 16.7 | 17.3 | 34.4 | 33.9 |

How to read this:

- The reference planner gives **identical rewards through both harnesses
  in all 3,840 episodes**, because it is the same function run turn by turn
  or submitted as one program. The only difference is the end-reason label of
  the 68 episodes that hit the skill harness's 40-turn limit, and those fail
  under both. A test enforces this, including under sensor noise. It is the
  control that makes RQ2 a clean comparison.
- It is a hand-written parser, so it is *not* hurt by `language`, `swap` or
  `task`. Those axes probe memorization and only bite on learned planners,
  which is the paper's point about LIBERO-PRO. The dynamics and sensing suites
  (`wind`, `noise`, `light`) cut it to about 17%, which leaves real headroom.
- On the train split, 66 of 272 groups (G = 6) have mixed outcomes and
  therefore a non-zero RLOO advantage. The pipeline writes 4,946 RL samples
  from one round, with no model involved.

**Claude Code as the planner** (one live episode, eval init 4,
*"Inspect the yellow crate, then land on the orange pad"*): reward 1 in 13
turns. On the same scene, the detector-only reference planner failed all 6
attempts, using 38 turns each and never finding the targets. At 14 m the
frozen detector **missed** both the crate and the pad, but they were plainly
visible in the camera image, and the agent localized them from pixels. This is
one episode, an anecdote rather than a result. That makes the
camera image a real channel for vision-language planners, and a second
ablation axis (detector only versus image plus detector).

**Pipeline pieces built and tested** (19 tests):

- deterministic replay
- simulator-judged success
- valid versus invalid attribution
- the exact five-field adapter schema
- RLOO math and the 16-response cap
- proxy ↔ harness episode matching through a mock model server
- a model-server failure turning into `valid = false`

## 7. Limitations (stated up front)

- Kinematic flight model: velocity-level control with first-order lag and
  wind. There are no attitude dynamics. This is a deliberate choice, because
  the planner, not the controller, is under study.
- The detector is a noisy symbolic oracle, not a learned perception model.
  The camera image is rendered from ground truth, orthographic and top-down.
- The code harness uses `node:vm`, which isolates mistakes but is **not a
  security boundary**. Run it only locally with planners you control.
- Claude Code's own model calls cannot be intercepted. Its turns are recorded
  at the harness boundary (action plus reasoning), so it serves as teacher or
  reference. Token-level RL data comes from open models through `proxy.mjs`.
- No model has been post-trained yet. Section 5 is the plan; Section 6 is the
  verified infrastructure and baselines.

## 8. Expected contribution

1. A third harness for AgenticRoboRL on a new embodiment, with the adapter
   interface exactly as in Appendix B.
2. The first *controlled* comparison of post-training gains across execution
   mechanisms, with the same world, tasks and seeds.
3. Evidence on post-training versus memory under hidden dynamics, and on
   whether terminal-only reward teaches constraint satisfaction.
