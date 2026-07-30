# Phase 1 — Authority Map (Legacy Saga2 Entrypoints → Keep/Adapt vs Delete)

> Read-only design investigation. NO source changes. Output = this document.
> Branch: `saga4`. Date: 2026-07-30.
> Scope: every legacy Saga2 entrypoint that can **start / resume / advance**
> an epic, classified into SHARED INFRASTRUCTURE (keep + adapt) vs LEGACY
> ORCHESTRATION (delete), plus a deletion-vs-adapt matrix and the top-3 risks.

All `file:line` references are against the working tree on `saga4`. `grep -rn`
excluded `node_modules`, `dist`, `.git`, `.worktrees`.

---

## 0. Glossary / the three runtime planes

The codebase already separates three planes that this cutover must keep
distinct. Mixing them is the primary deletion risk.

| Plane | Table / surface | Driven by | Entrypoint |
|---|---|---|---|
| **Saga 2 legacy orchestration** | `episode_workflows.stage` | `orchestrate.ts` pump loop (`tryAdvanceStage` → `episode_transition`) | `orchestrate-cli.ts`, tracker-view `/api/engine/*` |
| **Saga 3 process modules** | `saga3_process_runs`, `saga3_work_intents`, certificates | `GenericFlowExecutor` / `Saga3DiscoveryEngine` / `Saga3FormalizationEngine` / `createProductLifecycleRuntime` | same `orchestrate-cli.ts` host (mode-switched), `process_run_start` MCP tool |
| **Shared infra (engine-neutral)** | `tasks`, `artifacts`, `worker_executions`, repos/worktrees, MCP transport | any engine via ports | `src/index.ts` MCP server, `claude-runner.mjs` worker launcher |

The `episode_workflows` table is read by BOTH the legacy plane (the `.stage`
column drives the pump) AND the shared plane (its `metadata` JSON carries
`engine_running`, `engine_pid`, `active_model`, `needs-human`, `lastHealError`
…). This dual use is the central deletion hazard — see Risk 1.

---

## 1. Executable entrypoints that can start / resume / advance an epic

### 1.1 CLI host — `src/orchestrate-cli.ts` (the ONLY process entrypoint)

`main()` (line 112) is the single Node entrypoint. It:

1. Parses `<project_id> <epic_id> [--concurrency=N] [--lifecycle-input=…]
   [--idempotency-key=…] [--resume]` (`parseArgs`, line 34-110).
2. Loads composition overrides keyed on `SAGA_ORCHESTRATION_MODE`
   (`loadCompositionOverrides`, line 191-257):
   - `saga3-discovery-generic` → installs the Discovery module package
     (`installModulePackages`, line 198-204).
   - `saga3-lifecycle` → requires `SAGA_PRODUCT_LIFECYCLE_COMPOSITION` ESM
     module, calls `installProductionModules` (line 247-251).
3. Builds the application: `createSaga2Application(process.env, overrides)`
   (line 143) — this is the engine-selection boundary.
4. Runs one episode: `application.runEpisode({...})` (line 144-155).

So `orchestrate-cli.ts` is engine-neutral: it never imports `orchestrate.ts`
directly. The legacy pump is reached only when `selectEngine` returns
`Saga2Engine` (§8). **This file stays; only its mode-menu shrinks.**

### 1.2 Legacy Saga 2 pump — `src/orchestrate.ts`

`export async function orchestrate(opts)` (line 793) — the autonomous
background loop. The whole file (1208 lines) is legacy orchestration EXCEPT
the host-runtime/port calls it shares with saga3 (heartbeat, lock, zombie
reconcile). Key internals (all DELETE candidates, see §3 / §5):

- Pump loop `while (true)` at line 899.
- Stage read: `currentStage()` (352) → `opts.persistence.episodes.currentStage`.
- Task counts: `countActiveTasks()` (360) →
  `opts.persistence.tasks.countStageTasks`.
- Generation: `generateNextIfReady()` (375) → calls
  `generateNextForCompletedTask` (workflow.ts).
- Stage advance: `tryAdvanceStage()` (462) → calls
  `lifecycleHandlers.episode_transition` (485).
- Recovery: `attemptHeal()` (541) + `RECOVERY_TREE` (106-311),
  `spawnGenericRecoveryTask()` (596), `spawnPostTransitionRecovery()` (651).
- Rate-limit / concurrency: `detectRateLimits()` (747),
  `computeEffectiveConcurrency()` (773).
- Singleton guard: `opts.host.acquireEngineLock` (828).

### 1.3 Saga 3 engines (also `OrchestrationEngine` impls, also poll-loops)

These are NOT legacy Saga2, but they ARE autonomous loop engines and they
share `episode_workflows.metadata`. Listed for completeness — cutover target
is `saga3-lifecycle` (`createProductLifecycleRuntime`), not deletion of these:

- `src/engines/saga3-discovery-engine.ts:205` `Saga3DiscoveryEngine`,
  `run()` line 220, internal `while (true)` at **567** (its own pump over a
  single WorkIntent / task). Reads `episode_workflows` only via
  `persistence.episodes.currentStage` (501, 510, 709).
- `src/engines/saga3-formalization-engine.ts:62` `Saga3FormalizationEngine`
  (one-shot settlement+certificate shim, no poll loop; comment line 9
  explicitly says formalization workers are still driven by saga2 or
  saga-dispatch).
- `src/engines/saga2-engine.ts:26` `Saga2Engine` — a 35-line adapter whose
  `run()` (33) just forwards to `orchestrate()`. **Pure DELETE** (its only
  job is to wrap the legacy pump behind the `OrchestrationEngine` port).

### 1.4 HTTP frontend — `tracker-view/tracker-view.mjs`

Single 5700-line file. The control plane is built once at line 86:

```
const sagaApplication = createSagaControlApplication(process.env);
```

(`createSagaControlApplication`, composition-root.ts:113 — control-only, no
`runEpisode`). All engine lifecycle routes delegate to it:

| Route (tracker-view.mjs) | Handler | What it does |
|---|---|---|
| `POST /api/engine/start` (5626) | `handleEngineStart` (5051) | `sagaApplication.startEngine({epicId,concurrency,lifecycleInputPath,idempotencyKey,resumePaused})` (5058) |
| `POST /api/engine/stop` (5629) | `handleEngineStop` (5083) | `stopEngine` (5086) |
| `POST /api/engine/restart` (5623) | `handleEngineRestart` → `restartEngine` | re-spawn |
| `POST /api/engine/concurrency` (5635) | `handleEngineConcurrency` (5099) | metadata write only (no spawn) |
| `GET /api/engine/status` (5632) | `handleEngineStatus` (5117) | reads `episode_workflows.metadata` (5122-5127) |
| `POST /api/episode/resume` (5579) | `handleEpisodeResume` (4413) | clears needs-human flag |
| `POST /api/episode/transition` (5594) | `handleSagaOperation('episode_transition')` | direct MCP-call passthrough |
| `GET /api/episode/pipeline` (5601) | `handleEpisodePipeline` | legacy stage view |
| `GET /api/lifecycle/pipeline` (5607) | `lifecyclePipelineApi.handlePipeline` | NEW saga3 view (coexists) |
| `POST /api/board-run/start` (5582) | `handleBoardRunStart` | `boardRunner` (claude-runner.mjs) |
| `POST /api/board-run/stop` (5585) | `handleBoardRunStop` | stop worker run |

`startEngine` → `LegacyEngineAdministration.start()` (composition-root wires
`LegacyEngineAdministration` at composition-root.ts:120/171), which
**spawns `node orchestrate-cli.js <project> <epic> --concurrency=N`**
(legacy-engine-administration.ts:58-118, `spawnProcess` at 82). The kill tree
matches on `orchestrate-cli.js ${projectId} ${epicId}` (lines 255, 275, 291,
299). So **tracker-view is the primary legacy start/resume surface** — its
button (`.agent-engine-toggle`, tracker-view.mjs:1454) is the human-facing
on-switch for the pump.

The board-run path (`/api/board-run/*`) uses the SAME
`createClaudeBoardRunner` (tracker-view.mjs:22, 329) as the engine — i.e. the
worker launcher is shared infra, not legacy.

### 1.5 Worker launcher — `tracker-view/claude-runner.mjs`

`createClaudeBoardRunner` (1080) / `class ClaudeBoardRunner` (324). Spawns
`claude -p` per claimed task (spawn at 890, args built 845-872). This is the
shared worker substrate used by Saga2Engine, Saga3DiscoveryEngine and the
lifecycle runtime's `workerExecutorFactory`. **KEEP** (see Table A).

### 1.6 MCP server — `src/index.ts`

Stdio MCP server. `ALL_TOOLS` / `ALL_HANDLERS` assembled at 96-142 from every
`src/tools/*.ts` module. The legacy-orchestration-relevant tools exposed:
`episode_status`, `episode_transition`, `verification_record`
(`lifecycleDefs`/`lifecycleHandlers` from `src/tools/lifecycle.ts`), and
`workflow_generate_next` (`workflowDefs` from `src/tools/workflow.ts`).
Visibility is filtered by `visibleSagaToolNames(getDb())` (150-155), so saga3
authority scoping can already hide them. The MCP transport itself is shared
infra (KEEP); only the two tools above + their handlers are legacy.

### 1.7 Root `.mjs` scripts

| File | Role | Legacy? |
|---|---|---|
| `bootstrap-autism-buttons.mjs` | one-shot DB/workspace bootstrap (git init, project/epic insert) | infra helper (no engine) |
| `bootstrap-hex-lifecycle.mjs` | bootstrap fresh saga3 lifecycle DB + prints the `orchestrate-cli` cmd | infra helper |
| `bootstrap-molecule3d*.mjs` | same pattern | infra helper |
| `run-hex-lifecycle.mjs` | deterministic E2E runner — drives `createProductLifecycleRuntime` with STUB executors, no LM, no `orchestrate-cli` spawn | lifecycle test harness (KEEP) |
| `run-hex-lifecycle-diagnostic.mjs` | validates `hex-lifecycle-input.json` against the lifecycle input contract; no execution | lifecycle test harness (KEEP) |
| `hex-composition.mjs` | ESM composition module loaded by `orchestrate-cli` when `SAGA_ORCHESTRATION_MODE=saga3-lifecycle`; exports `createProductLifecycleComposition` (mock delivery) | lifecycle composition (KEEP) |
| `product-lifecycle-composition.mjs` | same, fuller version | lifecycle composition (KEEP) |
| `reset-saga-db.mjs` | wipes saga.db data (keeps schema) | infra helper (no engine) |

None of these import `orchestrate.ts` or `Saga2Engine`; none start the legacy
pump. The two `run-hex-*` scripts bypass `orchestrate-cli` entirely and call
`createProductLifecycleRuntime` directly — they are the reference harness for
the cutover target.

---

## 2. Every WRITE to `episode_workflows`

`grep -rn "episode_workflows" src/` (15 files). Writes only:

| File:line | Column / shape | Caller / plane |
|---|---|---|
| `src/schema.ts:77` | `CREATE TABLE` (+ index at 401) | DDL |
| `src/db.ts:801,807,811` | migration: add `track` column, backfill `fast-track` | one-shot migration |
| `src/tools/lifecycle.ts:52` | `INSERT OR IGNORE (epic_id)` — `getOrCreate` | legacy (ensureWorkflow) — also used by saga3 read-path |
| `src/tools/lifecycle.ts:332-335` | **`UPDATE … SET stage=?`** — the ONLY stage-column write, inside `handleEpisodeTransition` | **LEGACY (delete with episode_transition)** |
| `src/tools/lifecycle.ts:362-365` | `UPDATE metadata` remove `last_gate_error` — `advanceReadyEpisodes` | **LEGACY** |
| `src/tools/lifecycle.ts:371-378` | `UPDATE metadata json_set last_gate_*` — `advanceReadyEpisodes` error branch | **LEGACY** |
| `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts:22` | `INSERT OR IGNORE (epic_id)` — `ensureWorkflow` | shared (used by both pumps to guarantee a row exists) |
| `sqlite-saga2-runtime-repositories.ts:42-48` | `UPDATE metadata json_set needs-human/pause_reason` — `pause()` | legacy-pump pause (orchestrate.ts:403) — but the **column is shared** |
| `sqlite-saga2-runtime-repositories.ts:64-68` | `UPDATE metadata json_remove needs-human` — `clearNeedsHuman` | shared (resume path) |
| `sqlite-saga2-runtime-repositories.ts:145-153` | `UPDATE metadata json_set …` — `patchMetadata` | **shared** (engine_concurrency, engine_pid, active_model, lastHealError, …) |
| `src/planner/fast-track.ts:206-212` | `INSERT/UPDATE SET stage='development', track='fast-track'` — `routeFastTrack` | **LEGACY** (fast-track bypass of episode_transition; called from workflow.ts:162) |
| `src/tools/workflow.ts:164` | `UPDATE track='fast-track'` — `brief_accepted` fast-track branch | **LEGACY** |
| `src/infrastructure/engine/legacy-engine-administration.ts:236-239` | `UPDATE metadata` engine_running/engine_pid/… — `setMeta` | **shared control-plane** (the engine-start button persists here; ANY engine needs this) |
| `src/tools/export-import.ts:408,500` | `INSERT`/`UPDATE baseline_artifact_id` | export/import round-trip (shared) |
| `src/process-modules/persistence/sqlite-process-run-repository.ts:68` | DDL: `projected_stage TEXT` column on `saga3_process_runs` (the lifecycle's replacement for the stage column) | lifecycle |

**Reads** (no write): `sqlite-board-projection-reader.ts:73` (board join on
`ew.stage`), `dispatcher.ts:221,406,408`, `tasks.ts:450`,
`projects.ts:267,319`, `export-import.ts:122`,
`legacy-claude-worker-executor-factory.ts:128`, `projects.ts` cascade.

**Key insight**: only `lifecycle.ts:332` writes the `.stage` column itself.
All other writes touch `metadata` JSON. The stage column is the legacy
orchestration index; `metadata` is shared control state. A safe cutover can
drop the `.stage` writer (and the `track` column writes in fast-track.ts /
workflow.ts) while keeping `metadata` writes intact — see Risk 1.

---

## 3. Orchestration function definitions + call sites

`grep` for the five named functions. Definitions and every call site:

### 3.1 `episode_transition`
- **Definition**: `src/tools/lifecycle.ts:495` (tool def) → handler
  `handleEpisodeTransition` (body around lifecycle.ts:300-339; the stage
  `UPDATE` is at 332).
- **Export**: `src/tools/lifecycle.ts:535` (`handlers.episode_transition`).
- **Call sites**:
  - `src/orchestrate.ts:485` — `tryAdvanceStage` (legacy pump).
  - `src/orchestrate.ts:1079` — reject branch (`to_stage:'cancelled'`).
  - `src/tools/lifecycle.ts:357` — `advanceReadyEpisodes` (legacy bulk-advance
    helper, exported at 341).
  - `tracker-view/tracker-view.mjs:5595` — `/api/episode/transition` route →
    `handleSagaOperation('episode_transition')` (human-driven manual advance).
  - MCP-exposed as `episode_transition` via `src/index.ts` (lifecycleDefs).

### 3.2 `generateNextForCompletedTask`
- **Definition**: `src/tools/workflow.ts:365` (exported). Internally calls
  `handleWorkflowGenerateNext` (workflow.ts:386) which calls
  `specsForTransition` + `insertGeneratedTask`.
- **Call sites**:
  - `src/orchestrate.ts:28` (import) → `src/orchestrate.ts:384`
    (`generateNextIfReady`, legacy pump).
  - `src/tools/dispatcher.ts:8` (import) →
    - `src/tools/dispatcher.ts:1125` — inside `worker_done` AFTER a non-managed
      task reaches `done` (auto-advance the formalization ladder).
    - `src/tools/dispatcher.ts:1674` — inside `worker_merge_release` AFTER a
      managed-merge succeeds (same auto-advance for git_change tasks).

  These two dispatcher call sites are the **non-engine** advance path: a worker
  finishing a PRD/UC/AC/SRS task auto-spawns the next formalization task
  without waiting for the pump. They are part of the typed-formalization
  pipeline the lifecycle runtime also needs; classify as **ADAPT, not delete**
  (see Table A / Risk 2).

### 3.3 `tryAdvanceStage`
- **Definition**: `src/orchestrate.ts:462`.
- **Call sites**: `src/orchestrate.ts:1094` (only — inside the pump's "nothing
  left to generate" branch). **LEGACY-only, single internal caller.**

### 3.4 `spawnGenericRecoveryTask`
- **Definition**: `src/orchestrate.ts:596`.
- **Call sites**: `src/orchestrate.ts:1150` (only — pump's catch-all healer).
  Uses `opts.persistence.tasks.createRecoveryTask`
  (sqlite-saga2-runtime-repositories.ts:239). **LEGACY-only.**

### 3.5 `spawnPostTransitionRecovery`
- **Definition**: `src/orchestrate.ts:651`.
- **Call sites**: `src/orchestrate.ts:501` (only — inside `tryAdvanceStage`
  when stranded tasks exist after a transition). **LEGACY-only.**

### 3.6 (Bonus) `advanceReadyEpisodes`
- **Definition**: `src/tools/lifecycle.ts:341` (exported). Bulk-advances every
  non-terminal episode in a project by re-calling `episode_transition` in a
  loop (357). No current internal caller in the pump; left as a manual/CLI
  helper. **LEGACY** (depends on episode_transition).

---

## 4. Stage-based task-claim query — the dual-path branch

`src/tools/dispatcher.ts`, `findNextClaimable` (346). This is the single
atomic claim primitive used by `worker_next` (`handleWorkerNext`, 574).

### 4.1 The stage filter (dispatcher.ts:398-411)

```sql
AND (
  t.workflow_stage IS NULL
  OR t.task_kind = 'summary.stage'              -- bookkeeping: any stage
  ${processModuleStageClause}                   -- saga3-managed tasks bypass
  OR NOT EXISTS (SELECT 1 FROM episode_workflows ew WHERE ew.epic_id=t.epic_id)
  OR EXISTS (
    SELECT 1 FROM episode_workflows ew
    WHERE ew.epic_id=t.epic_id AND ew.stage=t.workflow_stage
  )
)
```

- **`processModuleStageClause`** (dispatcher.ts:388-390): when a `taskIds`
  allowlist (Saga3 claimScope reservation) is supplied, tasks carrying
  `metadata.process_run_id` are claimable regardless of stage. This is the
  **saga3 bypass** — a Process Module owns its task's stage.
- The last two branches are the **legacy Saga2 stage gate**: a task is only
  claimable if `episode_workflows.stage == task.workflow_stage` (or the epic
  has no workflow row yet).

### 4.2 The two claim-side readers (snapshot inside the IMMEDIATE txn)

- `readModelRouteAtClaim` (dispatcher.ts:213-224): reads
  `episode_workflows.metadata` `active_model` / `active_provider` /
  `active_model_effort`. **Shared** (model routing is engine-agnostic; the
  worker launcher consumes it). Called at dispatcher.ts ~698 (frozen route
  snapshot attached to the claim reply).
- `readWorkIntentForTaskClaim` (dispatcher.ts:259-312): the **saga3 path**.
  Discriminator is `task.metadata.work_intent_id` (281-287), NOT a task_kind
  literal. If absent → returns `null` (legacy/manual task, no frozen
  authority). If present → loads the `saga3_work_intents` row (292) and
  validates the binding (`strictAuthorityScope`, 232-257). This is the
  universal module-aware authority snapshot.

### 4.3 Reservation / fencing (dispatcher.ts:659-665, 512-547)

`handleWorkerNext` builds a `reservation { executionId, runId, machineId }`
from `execution_id`/`run_id`/`machine_id` args (659-665), passes it into
`findNextClaimable` (671), and on a Saga3 reservation stamps a
`worker_executions` row + `current_execution_id` (512-547). The legacy path
(no `execution_id`) just sets `assigned_to` (490/501). Both paths share the
same `worker_executions` fencing substrate (§7).

**Cutover action**: the legacy stage-gate branches (406-410) become dead once
`episode_workflows.stage` is no longer written; the saga3
`processModuleStageClause` + `work_intent_id` path is the survivor. The two
`readModelRouteAtClaim` / `readWorkIntentForTaskClaim` readers stay.

---

## 5. Legacy recovery task creators

All in `src/orchestrate.ts`. The recovery substrate
(`createRecoveryTask`, `recordPostTransitionSweep`,
`terminalBookkeepingCounts`, `hasActiveRecovery`, `listStrandedTasks`) lives
in `sqlite-saga2-runtime-repositories.ts:219-299` and is **shared** (the
`recovery.heal` task_kind + activity-log plumbing is engine-neutral). Only the
orchestrate-side *spawners* are legacy:

| Spawner | Definition | Recovery source |
|---|---|---|
| `RECOVERY_TREE` | orchestrate.ts:106-311 | stage-keyed rule table (formalization/planning/development/verification/integration). Each rule has `match` RegExp, `diagnosis`, `action_prompt`, `max_retries`. |
| `attemptHeal` | orchestrate.ts:541 | consults `RECOVERY_TREE`, calls `createRecoveryTask` (572). |
| `spawnGenericRecoveryTask` | orchestrate.ts:596 | catch-all autonomous-recovery task for unmatched gate errors. |
| `spawnPostTransitionRecovery` | orchestrate.ts:651 | resolves stranded tasks after a stage transition. |

The `autonomous-recovery` skill (referenced in every `action_prompt`) is a
worker skill, not engine code — it survives the cutover. The lifecycle
runtime has its own recovery surface (`SqliteRecoveryCaseRepository`,
product-lifecycle-runtime.ts:302) and does not use `RECOVERY_TREE`.

---

## 6. Frontend endpoints / files invoking legacy execution

(covered in §1.4). Summary of legacy-only surface in `tracker-view.mjs`:

- Engine start/stop/restart/concurrency/status: 5051-5152 (all delegate to
  `LegacyEngineAdministration`, which spawns `orchestrate-cli.js`).
- `/api/episode/transition` (5594) and `/api/episode/pipeline` (5601) —
  legacy stage model.
- `engineControlStateForEpic` (655) reads `episode_workflows.metadata`
  `engine_running` / `engine_concurrency` (shared column, legacy semantics).
- The `.episode-resume` button (797, 958, 1637) → `/api/episode/resume`
  (shared clear-flag, but currently only meaningful to the paused pump).
- `structured-context-hook.mjs` and `artifact-presentation.mjs` are
  worker-side helpers, not engine controls (KEEP).

The NEW lifecycle UI (`tracker-view/lifecycle-pipeline/`, served at
`/api/lifecycle/pipeline` 5607 + static `/lifecycle-pipeline/*` 5611) already
coexists and is the post-cutover surface.

---

## 7. Mode selection — `src/runtime/orchestration-mode.ts`

`OrchestrationMode` union (50-57) and `ORCHESTRATION_MODES` array (59-62):

| Mode | Engine wired (composition-root.ts `selectEngine`) | Background pump? |
|---|---|---|
| `v2` | `Saga2Engine` (352) | no — saga-orchestrator skill in main context |
| `v3` | `Saga2Engine` (352) | yes |
| `saga2` | `Saga2Engine` (352) (alias of v3) | yes |
| `saga3-discovery` | `Saga3DiscoveryEngine` via `ProcessModuleRuntimeEngine` (250-312) | yes (own loop, saga3-discovery-engine.ts:567) |
| `saga3-discovery-generic` | `GenericFlowExecutor` via `buildDiscoveryGenericEngine` (234-248 → 370-486) | yes |
| `saga3-formalization` | `Saga3FormalizationEngine` (320-348) | one-shot (no loop) |
| `saga3-lifecycle` | `createProductLifecycleRuntime` (209-223) | yes (lifecycle orchestrator) |

- **Default**: `DEFAULT_ORCHESTRATION_MODE = 'v2'` (line 65). `parseOrchestrationMode`
  (74) throws on unknown values (no silent fallback).
- `requiresBackgroundEngine(mode)` (94): true for every mode except `v2` —
  i.e. the tracker-view start gate uses this to decide whether to spawn.
- `isSaga3DiscoveryMode` (107), `isSaga3DiscoveryGenericMode` (116),
  `isSaga3FormalizationMode` (126), `isSaga3LifecycleMode` (131) are the
  composition-root predicates.

Loaded once at config time: `saga-runtime-config.ts:49`
(`orchestrationMode: parseOrchestrationMode(env.SAGA_ORCHESTRATION_MODE)`).

**Cutover action**: delete `v2`/`v3`/`saga2`/`saga3-discovery` from the union
(keep `saga3-discovery-generic`, `saga3-formalization`, `saga3-lifecycle`);
make `saga3-lifecycle` the new default. `requiresBackgroundEngine` stays.

---

## 8. composition-root.ts — Saga2Engine vs lifecycle wiring

`createSaga2Application` (134) is the only engine-selection boundary.

- Persistence stack assembled at 139-160 (`SqliteEpisodeRuntimeRepository`,
  `SqliteTaskRuntimeRepository`, `SqliteExecutionRuntimeRepository`,
  `SqliteWorkspaceResolver`, `NodeSaga2HostRuntime`,
  `SqliteBoardProjectionReader`, `LegacyEngineAdministration`). **Shared.**
- Worker factory: `createLegacyClaudeWorkerExecutorFactory` (150) OR, when a
  module package installation is present, `createPinnedWorkerFactory` (149,
  defined 563) — the latter pins workers to immutable package bytes. **Shared.**
- `selectEngine(...)` (201-358) is the switch:

| Line | Branch | Returns |
|---|---|---|
| 209-223 | `isSaga3LifecycleMode` AND `productLifecycle` overrides present | `createProductLifecycleRuntime({...}).engine` (217) — **gating condition: `overrides.productLifecycle` must be supplied** (throws `SAGA3_LIFECYCLE_DEPENDENCIES_REQUIRED` at 211 if missing) |
| 234-248 | `isSaga3DiscoveryGenericMode` AND `modulePackages` | `buildDiscoveryGenericEngine(...)` (241) — throws `DISCOVERY_MODULE_PACKAGE_REQUIRED` (237) if absent |
| 250-312 | `isSaga3DiscoveryMode` | `Saga3DiscoveryEngine` wrapped in `ProcessModuleRuntimeEngine` (291) |
| 320-348 | `isSaga3FormalizationMode` | `Saga3FormalizationEngine` (328) |
| 352-357 | **else (v2/v3/saga2)** | `new Saga2Engine({config, workerExecutorFactory, persistence, host})` — **the legacy fallback** |

So the gating condition for the lifecycle plane is: mode = `saga3-lifecycle`
**and** `overrides.productLifecycle` non-null (supplied by
`orchestrate-cli.loadCompositionOverrides` at 247-256 from the
`SAGA_PRODUCT_LIFECYCLE_COMPOSITION` ESM module). The final `return new
Saga2Engine(...)` at 352 is the legacy branch to delete.

`createSagaControlApplication` (113-126) is the tracker-view control plane:
builds only `board` + `engineAdministration` (`LegacyEngineAdministration`).
It is engine-neutral and stays — but `LegacyEngineAdministration`'s
`orchestrateCliPath` (legacy-engine-administration.ts:54-55) currently
hardcodes `orchestrate-cli.js`, so the spawned child's *mode* is what selects
the engine, not the admin layer.

---

## TABLE A — SHARED INFRASTRUCTURE (KEEP & ADAPT)

Engine-neutral surfaces used by every engine. Must NOT be deleted; some need
light adaptation (column noted).

| Surface | Files | Adaptation needed |
|---|---|---|
| **CLI host (process entrypoint)** | `src/orchestrate-cli.ts` | Drop `v2`/`v3`/`saga2`/`saga3-discovery` from mode menu (191-206); keep `--resume`, `--lifecycle-input`, `--idempotency-key`. |
| **Application ports** | `src/application/saga-application.ts`, `src/application/ports/*` (`orchestration-engine`, `engine-administration`, `board-projection`, `saga2-host-runtime`, `saga2-runtime-persistence`, `worker-executor`) | None — already engine-neutral. |
| **Composition root (selection)** | `src/app/composition-root.ts` | Keep `createSaga2Application`/`createSagaControlApplication`; delete the `Saga2Engine` branch (352-357) and the saga3-discovery branch (250-312) once `saga3-lifecycle` is primary. Keep `createPinnedWorkerFactory` (563), `buildDiscoveryWorkerContext` (493). |
| **MCP transport + tool registry** | `src/index.ts` | Keep transport + `visibleSagaToolNames` authority filter; drop `episode_transition`/`episode_status` tool defs (lifecycle.ts:494-509) and `workflow_generate_next` def (workflow.ts:393) from registration once unused. |
| **Worker launcher** | `tracker-view/claude-runner.mjs` (`ClaudeBoardRunner` 324, spawn 890), `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts`, `src/infrastructure/workers/claude-board-worker-executor.ts` | None. Used by all engines via `workerExecutorFactory`. |
| **Task/artifact/comment/note/subtask/activity persistence** | `src/tools/tasks.ts`, `artifacts.ts`, `comments.ts`, `notes.ts`, `subtasks.ts`, `activity.ts`, `helpers/activity-logger.ts`, `helpers/artifact-file.ts` | None. |
| **Repository / worktree / checkout infra** | `src/tools/repositories.ts`, `src/infrastructure/workspaces/sqlite-workspace-resolver.ts`, merge-lock logic in `dispatcher.ts` (`worker_merge_acquire`/`worker_merge_release`) | None. |
| **Execution fencing / leases** | `src/worker-executions.ts` (`assertExecutionFence` 41, `markExecutionRunning` 60, `reconcileWorkerExecutions` 237), `src/lifecycle/atomic-release.ts` | None. Shared by legacy + saga3 + lifecycle. |
| **Module installation / package store / snapshots** | `src/process-modules/installation/production-install.ts`, `src/process-modules/persistence/sqlite-process-run-repository.ts`, `sqlite-process-outcome-certificate-repository.ts`, `sqlite-node-run-repository.ts`, snapshot tooling | None. |
| **Generic flow runtime** | `src/process-modules/application/generic-flow-executor.ts` (`GenericFlowExecutor` 206), `generic-flow-engine-adapter.ts`, `kernel-handler-registry.ts`, `kernel-node-executor.ts`, `lm-node-executor.ts`, `process-module-runtime-engine.ts` | None — this IS the saga3 replacement. |
| **Lifecycle runtime (cutover target)** | `src/app/product-lifecycle-runtime.ts` (`createProductLifecycleRuntime` 294, returns `{engine,…}` 590), `src/app/product-lifecycle-repository-bindings.ts`, `src/process-modules/lifecycles/*` | None. |
| **Saga3 authority / work-intents** | `src/saga3/authority/authorize-saga-tool-call.ts`, `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts` (`SqliteSaga3DiscoveryRuntime` 81, `saga3_work_intents`), `dispatcher.ts:readWorkIntentForTaskClaim` (259) | None. |
| **Shared episode metadata (control state)** | `episode_workflows.metadata` JSON writes: `patchMetadata` (sqlite-saga2-runtime-repositories.ts:144), `setMeta` (legacy-engine-administration.ts:228), `clearNeedsHuman` (62) | Keep; this is where engine_running/engine_pid/active_model/needs-human live for ALL engines. |
| **Frontend (control plane + new lifecycle UI)** | `tracker-view/tracker-view.mjs` (control routes §1.4), `tracker-view/lifecycle-pipeline/*`, `tracker-view/structured-context-hook.mjs`, `tracker-view/artifact-presentation.mjs` | Adapt: repoint `/api/engine/start` semantics from "spawn saga2 pump" to "spawn lifecycle engine"; `/api/episode/pipeline` → retire in favour of `/api/lifecycle/pipeline`. |
| **Typed formalization ladder (auto-advance on worker_done/merge)** | `src/tools/workflow.ts:generateNextForCompletedTask` (365) + its 2 dispatcher call sites (1125, 1674) | ADAPT, do not delete: the lifecycle runtime still needs PRD→UC→AC→SRS auto-spawn when a worker finishes a producer task. Either keep the function or move the ladder into the lifecycle module. |
| **Host runtime (locks, heartbeat, zombie reconcile, rate-limit scan)** | `src/infrastructure/runtime/node-saga2-host-runtime.ts` | Adapt: rename off the `saga2` literal; the lock/heartbeat/scan primitives are reused by the lifecycle engine. |
| **Recovery task persistence (task_kind-agnostic)** | `sqlite-saga2-runtime-repositories.ts:createRecoveryTask` (239), `recordPostTransitionSweep` (226), `hasActiveRecovery` (211), `terminalBookkeepingCounts` (268) | Keep; delete only the orchestrate.ts *spawners* that feed them. |
| **Bootstrap / test harness scripts** | `bootstrap-*.mjs`, `run-hex-lifecycle*.mjs`, `reset-saga-db.mjs`, `hex-composition.mjs`, `product-lifecycle-composition.mjs` | None (lifecycle-only already). |

---

## TABLE B — LEGACY ORCHESTRATION (DELETE)

Exact files, and where shared files must be surgically edited (line ranges /
functions). Order = safest-first.

| # | Target | Evidence | Action |
|---|---|---|---|
| B1 | `src/orchestrate.ts` (whole file, 1-1208) | The legacy pump: `orchestrate()` 793, `tryAdvanceStage` 462, `generateNextIfReady` 375, `RECOVERY_TREE` 106, `attemptHeal` 541, `spawnGenericRecoveryTask` 596, `spawnPostTransitionRecovery` 651, `detectRateLimits` 747, `computeEffectiveConcurrency` 773. | DELETE file. No external import except `saga2-engine.ts:9`. |
| B2 | `src/engines/saga2-engine.ts` (whole file) | `Saga2Engine.run()` (33) only forwards to `orchestrate()`; import at composition-root.ts:18. | DELETE file + remove import + remove `selectEngine` fallback (352-357). |
| B3 | `selectEngine` legacy branch | composition-root.ts:349-357 (`return new Saga2Engine({...})`). | DELETE branch; let unknown modes throw (parseOrchestrationMode already rejects them). |
| B4 | `episode_transition` tool + stage writer | lifecycle.ts:495-509 (def), handler body ~280-339, **stage UPDATE at 332-335**; export at 535. | DELETE handler + tool def + export. KEEP `verification_record` (511-530) — used by lifecycle verification. |
| B5 | `advanceReadyEpisodes` | lifecycle.ts:341-385 (exported, calls episode_transition at 357). | DELETE function. |
| B6 | `episode_status` tool | lifecycle.ts:486-493 (reads stage); handler `handleEpisodeStatus`. | DELETE (lifecycle has `lifecycle_run_get`/`episode_status` MCP via saga3). |
| B7 | `workflow_generate_next` MCP tool (def only) | workflow.ts:393-408 (def) + handlers 410-412. | DELETE tool registration; **KEEP `generateNextForCompletedTask` (365) + `handleWorkflowGenerateNext`** — the dispatcher still calls them (Table A). |
| B8 | Fast-track stage/track writes | `src/planner/fast-track.ts:206-212` (`UPDATE stage='development', track='fast-track'`); `src/tools/workflow.ts:150-172` (`brief_accepted` fast-track branch, `UPDATE track` at 164). | DELETE the SQL writes; if fast-track survives, re-implement as a lifecycle input branch, not an `episode_workflows` mutation. |
| B9 | `RECOVERY_TREE` + spawners | orchestrate.ts:106-311, 541-581, 596-630, 651-694. | DELETE (in B1). The `autonomous-recovery` skill + `createRecoveryTask` persistence stay. |
| B10 | `Saga3DiscoveryEngine` (legacy adapter) | saga3-discovery-engine.ts:205-709 (own `while(true)` at 567); composition-root.ts:250-312. | DELETE once `saga3-discovery-generic` is green (the file header at orchestration-mode.ts:32-36 already calls this the "legacy" path to replace). |
| B11 | `saga3-discovery` mode + branch | orchestration-mode.ts:54 (union), 60 (array), `isSaga3DiscoveryMode` (107-109) keeping both; composition-root.ts:250-312. | DELETE mode + branch; keep `saga3-discovery-generic`. |
| B12 | `v2`/`v3`/`saga2` modes | orchestration-mode.ts:51-53, 60, default at 65, `requiresBackgroundEngine` (94). | DELETE from union/array; change default to `saga3-lifecycle`; simplify `requiresBackgroundEngine`. |
| B13 | Legacy tracker-view stage surface | `/api/episode/transition` (5594), `/api/episode/pipeline` (5601), `engineControlStateForEpic` (655, reads `engine_running`/`engine_concurrency` — keep the metadata read, drop the saga2-stage assumptions), `.episode-resume` button (797/958/1637) once pump pause is gone. | Retire routes/buttons; keep `/api/engine/start|stop|status|concurrency` but repoint to lifecycle spawn. |
| B14 | `episode_workflows.stage` + `.track` columns | schema.ts:77 (stage), 401 (index); db.ts:801/807/811 (track migration). | DROP columns LAST (after B4/B8 remove all writers and dispatcher.ts:406-410 stage-gate is dead). Keep the row + `metadata`. |

---

## RISK: top 3 deletions that could break shared infra (and mitigation)

### Risk 1 — Deleting `episode_workflows` writes blinds the control plane and the worker launcher

**Why it breaks**: `episode_workflows.metadata` is NOT legacy-only. The engine
start button (`LegacyEngineAdministration.setMeta`,
legacy-engine-administration.ts:228-241), the kanban engine-state widget
(`engineControlStateForEpic`, tracker-view.mjs:655-660), the worker model
route (`readModelRouteAtClaim`, dispatcher.ts:213-224 / `readWorkerModelRoute`,
sqlite-saga2-runtime-repositories.ts:125-142), the needs-human flag
(`clearNeedsHuman` 62, `/api/episode/resume`), and the concurrency/model-limit
ceiling (`readTargetConcurrency` 108) ALL read/write `metadata`. Only the
`.stage` and `.track` columns are legacy. A naive "delete episode_workflows"
would silence engine controls for every engine, including the lifecycle one.

**Mitigation**: Delete ONLY `lifecycle.ts:332` (stage writer), the fast-track
`stage`/`track` writes (B8), and eventually DROP the two columns (B14, last).
Keep `ensureWorkflow` (lifecycle.ts:52 / sqlite-saga2-runtime-repositories.ts:22),
`patchMetadata` (144), `setMeta`, `clearNeedsHuman`, and every `metadata`
read. Add a grep gate in CI: `grep -rn "episode_workflows.*SET stage" src/`
must return zero before the column DROP.

### Risk 2 — Deleting `generateNextForCompletedTask` kills the formalization ladder even under the lifecycle engine

**Why it breaks**: The PRD→UC→AC→reconciliation→SRS→planning auto-advance is
NOT driven by the legacy pump alone. `worker_done` calls
`generateNextForCompletedTask` directly at dispatcher.ts:1125 (non-managed
done) and `worker_merge_release` calls it at 1674 (after merge). These two
call sites fire for ANY engine that completes a typed formalization task,
including the lifecycle runtime's tracker_only producer tasks. Deleting the
function alongside `workflow_generate_next` (B7) would stall the ladder mid
formalization with no error — workers just stop appearing.

**Mitigation**: B7 deletes only the MCP *tool definition* (workflow.ts:393-408)
and its handler export (410-412). **Keep** `generateNextForCompletedTask`
(workflow.ts:365) and `handleWorkflowGenerateNext`, and keep the two
dispatcher call sites (1125, 1674) intact. If the ladder is to be owned by
the lifecycle module instead, migrate it FIRST and flip the dispatcher calls
in the same change — never delete-then-hope.

### Risk 3 — Deleting the `Saga2Engine`/`selectEngine` fallback before all entrypoints are mode-switched silently re-introduces the pump

**Why it breaks**: `LegacyEngineAdministration.start()`
(legacy-engine-administration.ts:58-118) spawns `orchestrate-cli.js` with
`SAGA_ORCHESTRATION_MODE: this.config.orchestrationMode` (line 91) read from
`loadSagaRuntimeConfig` (saga-runtime-config.ts:49). If the default mode
(B12) is changed to `saga3-lifecycle` but the `selectEngine` fallback (B3) is
deleted in a different commit, or a stale env var / old bootstrap script
still sets `SAGA_ORCHESTRATION_MODE=v3`, `parseOrchestrationMode` will throw
— OR, worse, if the fallback is deleted before the union is pruned, the
tracker-view start button spawns a child that immediately exits, leaving
`engine_running=1` stuck on (LegacyEngineAdministration sets it at 97-102
before the child fails). The kill-tree matcher (255/275/291/299) then can't
find the dead PID, so `status()` reports `alive:false` but `running:true`
forever.

**Mitigation**: Order the deletions strictly: (1) B12 prune modes + change
default in ONE commit with B3 fallback removal; (2) verify
`bootstrap-*.mjs` and any operator env files set no stale mode; (3) make
`LegacyEngineAdministration.start()` validate the mode is lifecycle-capable
before spawning (or have the child exit code 2 clear `engine_running` —
currently `orchestrate-cli.ts:157` exits 1 on failure but does not clear the
flag). Add a reconciliation: `status()` already flips `running` to false on
`!alive` (legacy-engine-administration.ts:171-174) — keep that path robust.
