# STAGE-20 RUN TRACKER — ELITE: full lifecycle on the post-merge factory

Protocol declared BEFORE launch (the stage-15/19 discipline).

## Purpose

First full product-build run (discovery → formalization → development →
runnable-local) on the tree that merged the parallel session's formalization
hardening (heading-resolution gate v1.2.0 3cf4819a, workshop rebind f8ffd759,
derived-evidence factory-owned e62a9e8a) plus the W0-1 canonical proof
composition and the actor-grammar repairs.

**Product (operator directive, 2026-08-20 night):** an Elite-style space
trading & combat game WITH a browser frontend — "с фронтом на хром браузере
с красивой графикой, то же задание, только про фронт не забыть". The frontend
is a first-class acceptance subject, not an afterthought.

**Model:** glm-4.6 (operator directive), **ratelimit 4** (operator directive;
the catalog profile limit is 2 — the controls row is raised to 4 immediately
after start, before the first claim; re-applied after any resume because the
resume path re-stamps the catalog limit).

## Pre-declared protocol

- Entry: `node scripts/factory.mjs start .factory-sandboxes/elite-db/factory.sqlite
  "<idea>" --model glm-4.6 --sandbox .factory-sandboxes/elite` — fresh sandbox,
  fresh DB, standard product-build lifecycle (delivery deferred).
- Idea text demands the Chrome frontend explicitly (canvas/WebGL visuals, HUD,
  market/dock screens, playable loop) and browser-smoke coverage.
- Executor: agent-proxy shim ONLY (`SAGA_REAL_CLAUDE_PATH`/`SAGA_CLAUDE_PATH` =
  `node <repo>/tools/agent-proxy/claude-shim.mjs`, map `zai-coding-plan/glm-4.6`);
  `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`.
- `~/.claude/settings.json`: sha256 anchored at launch; NEVER touched.
- No mid-run repairs (escalate, never decide). NO builds while the run lives.
- Observation: `tools/run-watchdog.mjs` 60 s samples; **stop conditions**
  (pre-declared): 45 min fingerprint stagnation, engine-vanished, settings
  drift, or a natural terminal state. Snapshot before launch and before any
  stop.
- Abort: operator directive only.

## Success criteria (declared up front)

1. Natural terminal (`runnable-local`) with a truthful label — and this time
   the label must be EXTERNALLY true: the integrated product actually starts,
   serves the game in a browser, and its own test suite passes (the stage-19
   amendment lesson: internal truth ≠ external truth).
2. The frontend exists as accepted material: ACs covering the browser UI
   (starfield/HUD/market/dock/combat visuals) are in the frozen acceptance
   baseline, implemented, and verified — not silently narrowed away.
3. Stage-18 fixes exercised on a fresh run: R1 WRITE AUTHORITY delivery,
   R2 claim-surface monotonicity, R3 integration diagnostics.

## Pre-flight (filled at launch)

- [ ] HEAD SHA + full-suite counts (the post-repair baseline)
- [ ] build exit 0 (current dist)
- [ ] fresh `.factory-sandboxes/elite-db/`, `elite/`, `elite-logs/`
- [ ] controls: model glm-4.6, concurrency 4, model_concurrency_limit 4
- [ ] settings.json sha256 anchored
- [ ] pre-launch DB snapshot

## Log (append-only, newest last)

- **20:51:50Z (23:51 local) — LAUNCHED.** Pre-flight: HEAD `c5f7f7aa`, build
  exit 0 (dist 23:51), full suite green (0 fail after the post-merge repair
  commit `c5f7f7aa`), fresh `elite-db/`+`elite/`+`elite-logs/`; settings sha
  anchored `2d6176e8…` (unchanged since stage-19). Engine detached pid 54812,
  launch `launch-f079ed95-6a85-4a48-bb3c-f2cfe3090217`, log
  `saga-engine-1-2026-08-20T20-51-50.040Z.log`, worker-backend marker
  `agent-proxy`. Model glm-4.6; controls raised to concurrency 4 /
  model_concurrency_limit 4 immediately after start (catalog limit 2 — the
  operator's ratelimit-4 directive; re-apply after any resume, which
  re-stamps the catalog value). Pre-launch snapshot
  `snapshot-pre-launch-*.sqlite` taken. Watchdog live (60 s samples,
  45-min stagnation, 12-h max, settings tripwire).
- **+75 s — route + first card verified.** opencode.exe pid 33636 spawned at
  +2 s: `opencode run --model zai-coding-plan/glm-4.6 --dir …elite\product`
  (agent-proxy shim → opencode → zai coding plan). Task 1 `discovery.work`
  claimed at `workplace/1/product-discovery@3.0.2/discovery-proposal`,
  in_progress; engine cycling paused@initial-discovery with 1 durable active
  execution, supervision sweeps clean (reaped=0).
- **22:17:34Z — TERMINAL FAILED (real defect caught by the fail-closed
  boundary).** Lifecycle 1 died at solution-formalization with
  `REPLAY_CAPTURE_TRACE_NOT_FOUND: expected 35, resolved 29` — the six
  `AC-2..AC-7 → RULE-1` traces (sources 14–19 → artifact 5).
  Root-cause chain (from activity_log + sealed snapshots + gate decisions):
  21:45–46 acceptance author traced 12 ACs (incl. →RULE-1); 21:48 gate
  accepted round 1; 21:50 `repair_required` (review round 2); **21:54 the
  worker lawfully DELETED the six AC→RULE traces** (trace_delete);
  21:58 gate ACCEPTED the repaired live material — but the re-sealed
  WorkplaceProductionSnapshot (21:58:43, digest 573e78…) STILL froze all 35
  traces, because the snapshot reads `factory_managed_trace_productions`
  and **trace_delete never mirrors into that ledger**; 22:17 the replay
  certification compared the ledger-frozen tuples against live
  artifact_traces → 6 missing → lifecycle terminal failed. Two desynced
  authorities: live artifact_traces (trace_delete mutates) vs the managed
  trace ledger (trace_add appends, delete does nothing). Fix (post-mortem,
  this terminal): handleTraceDelete mirrors the delete into
  factory_managed_trace_productions in the same transaction, so every
  FUTURE seal is live-consistent; already-sealed snapshots stay frozen and
  the fail-closed certification boundary is untouched. Regression test +
  relaunch follow. Engine exited code 1; watchdog will show natural death.
- **22:46:43Z — RELAUNCHED on the fixed build (run 2).** HEAD `563ce45c`
  (merge `95c2a3a1` of the W0/K proof branch + the trace_delete ledger-mirror
  fix + ADR-085/086 registry entries; full suite 731/734 → the 2 ADR
  registry failures were pre-existing red from the 00:34-00:38 planning
  commits, fixed in the same commit; regression pack
  trace-delete-managed-ledger-mirror 3/3). Pushed saga4+w0-waves. Fresh
  `elite-db/`+`elite/`+`elite-logs/` (failed run 1 archived as
  `*-failed1/`, nothing deleted). Engine pid 58004, launch
  `launch-5337b4e7-950a-4600-87da-415fb4b1bcef`, controls raised to 4/4
  immediately. Watchdog restarted (60 s / 45 min / 12 h, settings sha
  `2d6176e8…` unchanged). Tracker restarted on the new DB, port 4321.
  Same idea, same protocol; expected difference: a lawful in-repair
  trace deletion can no longer desync the managed ledger.
- **21:28:22Z (2026-08-22 00:28 local) — ELITE-3 LAUNCHED (night shift).**
  Tree: w0-waves HEAD `66122a02`, fresh build (last build while the run
  lives, per protocol). This run carries the day's production hardening:
  reconciliation report payload contract at intake (`a5e1d409`),
  artifact-ref desk reprojection on lawful repair (`177a4666`), §15 spin
  taxation for identical repair re-seals (`2520ba8e`, supersedes the
  round-2 park `f6a79aa1`), Discovery exhaustion seam (`9d37a9e1`).
  Conformance baselines at launch: Formalization 25/26 (restart-idempotency
  red — F-R1 review-capsule content model, diagnosed), Discovery 24/27
  (readiness-wrong-proposal-hash, readiness-feedback-exact, restart red).
  Fresh `elite-db/`+`elite/`+`elite-logs/`; settings sha anchored
  `2d6176e8…` (unchanged). Engine detached pid 15592, launch
  `launch-84bc03f8-9e36-4780-82b0-f5df54f94b6b`, model glm-4.6, agent-proxy
  shim. Controls raised 4/4 immediately (catalog 2 → 4). Pre-launch
  snapshot `snapshot-pre-launch-elite3.sqlite`. Watchdog live (60 s /
  45 min stagnation / 12 h, pid 511). Task 1 claimed at first poll;
  supervision sweeps clean. Night watchdog automation (every 20 min) also
  live. Same idea, same success criteria as run 2 — externally-true
  `runnable-local` or an honest typed terminal.
- **Night log (2026-08-22, small hours) — around Elite-3.** The run keeps
  progressing through formalization (no-build protocol honored: every src
  change committed unverified, verification batched for the terminal).
  Landed around the run: remote docs-graph frontend merged (e51263c4);
  F-R1 replay-capsule contamination fix — own-execution typed products only
  (bdcae547, triage verdict DB-proven); §10.2 selectable base lifecycle for
  honest Delivery proofs (c0a3c62f); Development conformance tranche D-A —
  spine PASS 8/8 oracles (01972137); Delivery tranche L-A; refactor Phases
  R0+R1 (inventory baseline 51941d8d… + BuiltInWorkshop descriptor);
  reconciliation payload-contract obligation declared after the T3 ratchet
  caught protection-without-obligation; K0 floor 33→34. Structural suite:
  91/91 after the fixes.
- **22:27Z watchdog — HEALTHY, formalization cleared.** Stage
  solution-formalization COMPLETED with local_outcome='formalized' (the
  first Elite run to clear formalization since the trace_delete mirror fix
  era; this time on the night build with the reconciliation payload
  contract + reprojection + §15 spin taxation). Development stage running:
  12/13 tasks done, lifecycle paused on a live card (latest execution
  started 22:20:37Z, phase finishing — no opencode process between spawns
  is expected; stagnation threshold 45 min). 13 executions, 0 lost. Worker
  backend agent-proxy/opencode; settings tripwire unchanged
  2d6176e8…. Tree: 15+ night commits on w0-waves, structural suite 91/91,
  the other agent's uncommitted discovery diff preserved untouched. Merge
  queue: after this run terminalizes.
- **22:46Z watchdog — healthy, on-same-card progress.** Latest execution
  started 22:41:28Z (phase executing, opencode alive), Development stage
  still in flight at 12/13 tasks; 0 lost executions; tripwire unchanged;
  tree quiet (only the preserved foreign discovery diff uncommitted).
  No action required.
- **23:06Z watchdog — healthy, long implementation card in flight.** New
  execution started 23:05:18Z (phase executing); the 13th Development card
  has been worked since ~22:41 across attempts (implementation cards are
  the long ones), 12/13 tasks done, 0 lost executions, tripwire unchanged.
  No action required.
- **23:26Z watchdog — alive; the 13th card is grinding through attempts.**
  20 executions total for 13 tasks (12 done) — the long implementation card
  has consumed several attempts (recovery budget governs; on exhaustion the
  cell parks typed, an honest terminal). Latest execution 23:22:22Z (phase
  executing), 0 lost, tripwire unchanged. No action; watching the attempt
  trend next cycle.
- **23:46Z watchdog — the grinding cell identified: the PLANNER.** The
  attempt cycling is development-plan-task-graph (epoch 2 of 3,
  maxAttempts per epoch) — the 13th open task is a planner re-run after the
  12 completed implementation/verification cards. Latest execution
  23:45:59Z (phase executing), 23 total, 0 lost, tripwire unchanged.
  Per protocol no mid-run action: the §15/ADR-075 budget owns the outcome —
  convergence, or a typed terminal failed at the total cap.
- **00:06–00:09Z watchdog — planner epochs ALL exhausted (9/30 total cap);
  first 2 lost executions; run ALIVE and rolling into new epochs.** All
  three recovery epochs show 3/3 exhausted attempts — but the counter is
  cumulative: 9 of total_attempts_cap 30 spent, and the run auto-rolls new
  epochs (diagnosis text: "the budget rolls over into a new recovery epoch
  (no human required)"). Lifecycle paused at node 'plan-task-graph' with
  worker_active — a fresh execution started 00:06:16Z, heartbeat 00:09:05Z
  (14 s fresh at check time). Rejection diagnosis is SPECIFIC and evolving:
  epoch 1 = task-graph not closed/acyclic + SRS §2.2 test-file declarations;
  epoch 3 = pairwise "implementation items X and Y overlap without a
  dependency order" (validator demands explicit ordering between
  file-overlapping items — actionable feedback glm-4.6 has not yet
  satisfied). 2 lost executions, both Task 13: "Claude process exited with
  code 1 before terminal worker_done" (opencode shim exit; supervision
  respawned within ~2 s both times). 27 executions total. Tripwire
  unchanged. No mid-run action: budget owns the outcome — convergence or a
  typed terminal failed at 30/30. MORNING POST-MORTEM ITEMS: (1) planner
  gate feedback loop vs glm-4.6 — 9 rejections on overlap-ordering suggests
  the prompt may not surface the pairwise-overlap rule the validator
  enforces; (2) shim exit code 1 on Task 13 spawns (long-prompt crash?)
  — capture the worker log before recycling the sandbox.
- **00:12Z — TERMINAL: Elite-3 completed with terminal_status=failed at
  00:09:09Z. Typed, honest, budget-owned — the engine exited on its own
  (no engine process remains; run-watchdog still sampling, harmless).**
  Final: Discovery go → Formalization FORMALIZED (first night-build run to
  clear formalization) → Development 12/13 cards done → the 13th (the
  PLANNER re-run, development-plan-task-graph author) exhausted the
  recovery budget and the lifecycle typed-failed. ROOT CAUSE CHAIN (evidence
  in task13-evidence/, 3 worker logs preserved): (1) epochs 1–3 burned 9
  gate rejections — graph closure/acyclicity first, then pairwise
  "implementation items X and Y overlap without a dependency order";
  (2) retry prompts accumulate rejection feedback UNBOUNDEDLY → prompt hit
  436,283 bytes → opencode/Z.AI API rejects pre-tool: 8 shim retries, all
  class=pre-tool-death (exit=1), ~3 min per spawn, 3 lost executions
  00:00:31/00:03:23/00:06:16; (3) supervision respawned each time until the
  budget terminalized the run. TWO PRODUCTION FINDINGS for the kernel
  backlog: F-A "planner retry prompt must bound accumulated gate feedback
  (summarize/trim) or the cell dies by API payload limit — unrecoverable
  snowball"; F-B "overlap-ordering rule is enforced by the validator but
  apparently not taught in the planner prompt — glm-4.6 cannot guess it in
  9 attempts". An EARLIER planner submission was accepted in this same run
  (Submission #20, digest 4c6d1a52…, 16 impl + 16 verification items) —
  the failure mode is retry-loop-specific, not a hard capability wall.
  Post-Elite batch UNBLOCKED: build → verify batch → coverage drives →
  merge. Tripwire clean at terminal (2d6176e8…).
