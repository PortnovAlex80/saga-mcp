# ADR-096 Phase 7 — Gate item 5 canary ledger

Two real-model canaries, frozen build, observation only. Written AS WE GO.
Nothing here is committed to git.

- Frozen worktree: `D:/Development/saga-mcp-P7-FROZEN` (detached @ 37ce4c00)
- Receipt before canaries: `BUILD RECEIPT MATCH a5108835f2fd`
  (head 37ce4c00d46a0198ba272198f80f86d4876d0190 | dist 1530 files tree abd53015e240 | package-store 7 packages) @ 2026-08-25T01:37Z
- Settings tripwire baseline (`~/.claude/settings.json` sha256):
  `2d6176e8d1382fe1a05791892840aa3a4f023ab87157ecaa13d1bc3a5545c6d0` @ 2026-08-25T01:38Z (before both canaries)

Recipe deviations from the task brief (recorded honestly):

1. The brief said `SAGA_ENGINE_LOG=<path>` on the spawning command. In this
   build `scripts/factory-engine-spawn.mjs` computes the engine log itself via
   `resolveEngineLogPath()` and OVERRIDES `SAGA_ENGINE_LOG` in the child env;
   the operator-honored control is `SAGA_ORCHESTRATION_LOG=<dir>` (log root).
   We set `SAGA_ORCHESTRATION_LOG=D:/Development/qualification-adr096/canary-N`
   so the engine log + `.heartbeat` land in the evidence dir. The spawn prints
   the exact log path; recorded per canary below.
2. The brief suggested a possible `--sandbox` flag. NOT used: the smoke script
   already provisions project/epic/repo/controls rows with fixed ids (1,1,1);
   `--sandbox` would INSERT duplicate primary keys. `factory.mjs start <db>
   "<idea>"` in DB-path-only mode creates a NEW order + launch carrying the
   CANARY idea (initiative.subject = idea) and spawns the engine bound to that
   launch-ref. The smoke's own pre-seeded launch row (hardcoded
   accessible-counter input, state='requested', own order_ref) stays dormant —
   the engine claims only the launch-ref it was spawned with
   (acquireFactoryLaunchController is per-launch-ref; one-active-launch rule is
   per-order, not per-epic). Noted as an observation, not an intervention.

---

## Canary-1

- Idea: "A small CLI utility that reads a Markdown file and prints a plain-text outline summary with word counts per section."
- Model: glm-5.2 (zai, effort high) — authoritative from smoke-provisioned
  `lifecycle_execution_controls`; journal `execution.reserved` confirms
  model_route {provider zai, model glm-5.2, effort high, backend agent-proxy}.

### Timeline (UTC, 2026-08-25)

- 01:39 evidence dirs created (canary-1 pre-created dir was EMPTY, removed to
  let the smoke own provisioning — smoke refuses existing roots)
- 01:40:0x smoke provisioned root `D:/Development/qualification-adr096/canary-1`
  (db `factory.sqlite`, product repo `product/`, dormant smoke launch
  `launch-real-e9b99f48-9cb0-46de-93a5-400d2a3b853c` — stays 'requested',
  never claimed)
- 01:40:15 `factory.mjs start` → launch `launch-c141ffac-f3a3-4092-bc35-c86238a0a526`
  (order new, idempotency `factory-5365e693…`, initiated_by factory-start).
  Engine DETACHED **pid=28188**, log
  `canary-1/saga-engine-1-2026-08-25T01-40-15.174Z.log`. Env inline:
  SAGA_REAL_CLAUDE_PATH=agent-proxy shim, SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1,
  SAGA_ORCHESTRATION_LOG=canary-1 root. (start printed `model=glm-4.7` — that is
  DEFAULT_FACTORY_MODEL used ONLY for launch-concurrency math; controls row keeps
  glm-5.2; no intervention.)
- 01:40:15 SPAWN VERIFIED (stop-after-launch, Elite-9 precedent): launch row
  state='running', engine_pid=28188 stamped; controls engine_state='running',
  pid stamped; pid alive (node.exe); `.heartbeat`, `.phase` (boot→runEpisode→
  dispatch→wait-poll task=1), `.worker-backend`=agent-proxy all present.
- 01:40:15 worker "Beacon" (developer, task=1 initial-discovery) spawned
  pid=47808 via `node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs`
  (journal worker.spawn; cwd=canary-1/product; mcp tools; model glm-5.2 high).
- 01:44 watchdog started (interval 60s, stagnation 45m, settings-sha baseline,
  max 12h) → `canary-1/watchdog.jsonl` (background task exec_ba961391).
- Observed non-issues: `[prompt-budget] … priorDeaths=23` is a char-budget
  section (zero real deaths in fresh DB — readTaskDeathHistory returns []);
  lifecycle status 'paused' during initial-discovery is the dispatch-loop
  "paused with 1 durable execution active — waiting" steady state, not an
  operator park.

### Poll log

- 01:47 initial-discovery DONE (tasks 1-2: discovery-proposal, discovery-readiness
  workplaces terminal/done) → solution-formalization started (task 3,
  formalization-product-contract). Engine alive hb=1-2s, no trips.
- 01:55-02:00 product-contract in review loop; 4 gates total; 4 tasks done.
- 02:05 6 gates, tasks done=4.
- 02:16 6 tasks done; formalization-acceptance-contract workplace rev=2
  running (formalization advanced product-contract → acceptance-contract).
  Engine alive, watchdog clean (no trips, no stagnation).
- (observing)

## Continuation (post-stall) — 2026-08-25, successor agent

Predecessor stalled in a long sleep ~02:16Z and was stopped by the
orchestrator. The RUN was never affected (engine detached, pid 28188).
Orchestrator restarted the watchdog (same flags, same baseline sha) —
confirmed appending + fresh before I took over. Watchdog and engine are
untouched by me except for reads.

### Reconstructed timeline 02:16Z → 03:45Z (engine log + journal)

- 02:30/02:33 formalization-acceptance-contract: author-phase accepted →
  **final accepted** (gate verdicts all "accepted", zero repairs anywhere).
- 02:37/02:42 formalization-reconciliation accepted (final 02:42:26).
- ~02:43-03:07 formalization-architecture-contract: LONG loop, workplace
  reached revision 14. Two worker deaths inside it (see below), finally
  author accepted 03:03:06, **final accepted 03:07:56**.
- **03:08:03Z stage advance: solution-formalization → solution-development**
  (first CYCLE line with the new stage).
- 03:17:38 development-plan-task-graph: final accepted (workplace terminal
  03:17:38).
- Impl cells (workplace/3 @ solution-development@1.4.4):
  - `ecb7787b1e82…`: author accepted 03:25:11, final accepted 03:31:08,
    git-integration.v1 effect started→claimed→**succeeded** 03:31:10,
    cell-final-acceptance recorded 03:31:13.
  - `99281152e905…`: author accepted 03:38:47, final accepted 03:44:30,
    git-integration.v1 **succeeded** 03:44:33, cell-final-acceptance 03:44:35.
  - `7f91c6e92b04…` (task 15): third cell, worker spawned 03:45:03Z
    (worktree author-77381f3ae2dfd9935843-15).
- Worker exits: 17× exit_code=0, **2× exit_code=1** — both during the
  architecture-contract loop, both handled by the DECLARED death/respawn
  transition: task 11 "Draft" died 02:45:14 (134s, no worker_done) →
  `supervision.reaped` 02:50:15 → re-claimed todo→in_progress → respawn →
  approved 03:03. Task 12 "Draft" (review phase) died 03:05:39 (134s) →
  reaped 03:06:19 → re-claimed review→review_in_progress → respawn →
  approved 03:07:53. No operator action; no new invariant class observed.
- Verdict distribution journal-wide at 03:45Z: gate.decision accepted 17,
  worker done approved 39, repair_target_role set: 0 occurrences.
- No fatal/unhandled/ECONNREFUSED/AUTHORITY_BINDING_INVALID/… in engine log.

### Poll log (continuation)

- 03:44Z takeover check: engine pid 28188 alive (hb 5s), tripwire sha
  `2d6176e8…` unchanged, launch_state=running, stage=solution-development,
  tasks done=16 review_in_progress=1 todo=1, gates=16. Formalization
  workplaces all terminal (product-contract rev8 02:00, use-cases rev8
  02:10, reconciliation rev8 02:42, architecture-contract rev14 03:08).
- 03:46Z cell `99281152e905…` completed the full arc (review task 18
  approved 03:44:26, gate final accepted 03:44:30, git-integration
  succeeded 03:44:33). Cell 3 (`7f91c6e9…`, task 15) executing since
  03:45:03Z. Engine healthy, watchdog clean (stagnant_seconds=240 baseline).

## Canary-1 TERMINAL — orchestrator record (agent stalled; direct observation)

- 04:49:47Z development stage COMPLETED (`CYCLE: reason=completed, stage=solution-development`).
- Terminal settlement (engine log, verbatim):
  `launch settlement: {"launch_state":"completed","order_state":"completed","exit_code":0,"lifecycle_status":"completed","terminal_status":"runnable-local","stage_outcome":"verified","product_outcome":"runnable-local"}`
- ADR-087 terminal drain: 1 receipt-backed execution settled, activeRemaining 0,
  `EXIT: code=0`.
- **VERDICT: canary-1 COMPLETED WITHOUT INTERVENTION — terminal
  runnable-local, stage verified.** Full real-model lifecycle: discovery
  (01:47) → formalization (02:42, 4 cells incl. review loops) → development
  plan (03:17) + implementation cells (first full arc 03:44:26–33 incl. git
  integration) → completed 04:49. ~3h10m wall. Zero operator actions; model
  deviations: none outside declared transitions observed in engine log.
- Evidence: `capture-run-snapshot` OK (db copy 5,341,184 bytes, integrity=ok,
  journal 858 lines, 7 logs, missed 0) into canary-1/; engine log + watchdog
  jsonl + board files in place.
- Watchdog (orchestrator-restarted after the first agent's watchdog died at
  02:41Z) stopped cleanly at terminal. Tripwire `2d6176e8…` unchanged
  before/after.

## Canary-2 LAUNCH — orchestrator record

- 05:14:54Z smoke provisioned fresh root canary-2 (RESET after empty-dir
  refuse), db + product repo; controls model glm-5.2 (smoke default; the
  start-line `model=glm-4.7` echo is launch-concurrency math only, same
  classification as canary-1).
- 05:14:58Z `factory.mjs start` (frozen worktree, INLINE env: opencode shim
  path + SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1) → launch
  `launch-738ef634-faaf-4886-91ca-1edd478776e0`, engine detached pid=11520,
  log at Temp saga-engine-1-2026-08-25T05-14-54.984Z.log (copy to canary-2/
  at capture).
- Idea: "A tiny Node HTTP echo server library with configurable middleware
  order and a health endpoint."
- 05:15:25Z spawn verified: heartbeat fresh, `[dispatch] assigned task=1`
  (initial-discovery). Watchdog started (60s/45m/12h, tripwire-baselined).
- NO-INTERVENTION observation by the orchestrator (automation ticks poll the
  engine log/watchdog).

## Canary-2 TERMINAL — orchestrator record

- 09:07:55Z development settled: `CYCLE: reason=completed, stage=solution-development`;
  launch settlement verbatim:
  `{"launch_state":"completed","order_state":"completed","exit_code":0,"lifecycle_status":"completed","terminal_status":"development-blocked","stage_outcome":"blocked","product_outcome":"development-blocked"}`
- Pipeline: initial-discovery `go` → solution-formalization `formalized` →
  solution-development `blocked`. Gates 15 accepted / 13 repair_required
  (review loops active). Tasks 16 done / 6 cancelled — the cancelled set is
  the REG-28 `drainAnonymousWorkOnProcessSettlement` fix working as designed
  at the terminal boundary.
- Root cause (factory_process_outcome_certificates id=3,
  factory.development-certificate.v1): decision `blocked`, reason
  `implementation-incomplete` — seven implementation work items
  (impl-api-public, impl-health-check, impl-middleware-order-ops,
  impl-middleware-registration, impl-middleware-request-visibility,
  impl-request-echo, impl-server-core) incomplete; settlement refused to
  fake completion.
- **VERDICT: canary-2 COMPLETED WITHOUT INTERVENTION — terminal
  development-blocked, an honest typed declared-outcome class (the w9-04
  dev-blocked tape proves the exact shape). NOT the manufacture-success
  shape (canary-1's runnable-local); per ADR-096 an honest typed failure is
  a valid factory outcome that does not count as successful autonomous
  manufacture. NO new invariant class observed → no kill-gate material.**
- Wall: 05:14:58Z → 09:07:55Z ≈ 3h53m. ADR-087 terminal drain clean
  (1 receipt-backed execution settled, activeRemaining 0). Evidence:
  capture-run-snapshot OK (5,341,184 B, integrity=ok, journal 727 lines,
  7 logs, 0 missed); engine log copied to canary-2/saga-engine-copied.log.
- Watchdog (canary-2) stopped cleanly at terminal. Tripwire `2d6176e8…`
  unchanged before/after. Frozen-tree receipt check AFTER the full canary
  window: **MATCH a5108835f2fd** — no source/dist/store mutation at any
  point across both canaries and all scripted legs.
