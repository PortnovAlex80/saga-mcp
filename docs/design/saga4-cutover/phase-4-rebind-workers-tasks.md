# Phase 4 — Rebind Workers & Tasks to Process Module Node Authority

**Branch:** `saga4`
**Scope:** READ-ONLY investigation output. This document is the only artifact. No source is modified.
**Goal:** Make `worker_next` / `worker_done` / `worker_merge_release` and the `tasks` row they mutate **pure work-items** bound exclusively to Process Module node authority. A task status change (todo→in_progress→review→done) must NEVER, by itself, advance a lifecycle stage or spawn downstream work. Only a module-owned kernel/settlement may produce an authoritative module outcome; a completed task is only **evidence** consumed by its owning node.

**Key principle:** _"A completed task is only evidence consumed by its owning Process Module node. Only a module-owned kernel/settlement may produce an authoritative module outcome."_

---

## 0. Executive Summary & Critical Findings

The dispatcher is already part-way through the cutover: the saga3 node/intent-based claim path (`saga3_work_intents`, `tasks.metadata.work_intent_id`, `process_run_id` guards) is wired and the LM node executor (`lm-node-executor.ts:567-589`) already treats `worker_done` as polled evidence rather than a state driver. But the codebase retains **four legacy escape hatches** where a generic task status still mutates lifecycle state. These are the Phase 4 removal targets:

### FINDING 1 — The claim SQL is a DUAL path (dispatcher.ts:391-411)
`findNextClaimable` admits a task if EITHER (a) its `workflow_stage` is compatible with `episode_workflows.stage` (legacy stage-pump model), OR (b) it carries a `process_run_id` in metadata (saga3 model). The legacy clauses must collapse so only the node/intent path remains. **See §1.**

### FINDING 2 — `worker_done` and `worker_merge_release` still call the task-kind ladder (dispatcher.ts:1119-1132, 1672-1679)
Both call sites invoke `generateNextForCompletedTask(taskId)` — the `task_kind`-keyed ladder (`brief_accepted`/`prd_accepted`/`uc_accepted`/`ac_accepted`/`baseline_accepted`/`srs_accepted`, `workflow.ts:378-383`). The calls are already guarded by `process_run_id == null`, so they only fire for non-managed tasks, but the guard is the wrong shape: it makes saga3 a special case rather than the only path. **See §2.**

### FINDING 3 — `worker_next` mutates lifecycle stage on every claim (dispatcher.ts:631)
`handleWorkerNext` calls `advanceReadyEpisodes(projectId)` which loops over `episode_workflows` for the project and runs `handleEpisodeTransition` (writes `episode_workflows.stage`). A **worker tool is advancing lifecycle stages**. This is the single most direct violation of the Phase 4 principle and is NOT saga3-aware (it only skips `stage='discovery'`). **See §3.**

### FINDING 4 — `workflow_stage` column is written as a projected UI label by modules, but read as authoritative by the dispatcher
Process Modules legitimately stamp `tasks.workflow_stage` when projecting a task (`lm-node-executor.ts:406` `ctx.module.identity.kind`, `sqlite-development-runtime.ts:716`). The formalization kernel gate reads it back (`sqlite-formalization-kernel.ts:252`). So the column is a **module-owned label**, but the dispatcher's claim filter treats it as an authority check against `episode_workflows.stage`. **Retain as optional module-owned UI label; strip the dispatcher's authority check. See §4.**

### FINDING 5 — Review verdict flow is ALREADY correct (no stage mutation)
The review verdict (`approved`/`changes_requested`) in `worker_done` only moves the task between `review`/`done`/`todo`/`blocked` (dispatcher.ts:847-996). It never writes `episode_workflows.stage` and never generates downstream work. The module-owned node (`lm-node-executor.ts:567-589`, `saga3-discovery-engine.ts:567-585`) polls task status and derives its own terminal verdict. **KEEP — already compliant. See §5.**

---

## 1. `findNextClaimable` — Collapse the Dual Claim Path

**File:** `src/tools/dispatcher.ts:346-471`

### 1.1 The two paths today

The candidate `SELECT` (lines 391-464) admits a task into the claimable set through a disjunction in lines 398-411:

```sql
AND (
  t.workflow_stage IS NULL                                                    -- (A) legacy: untyped task
  OR t.task_kind = 'summary.stage'                                            -- (B) bookkeeping: claimable anywhere
  -- Process Module owns the stage of its exact task projection. The
  -- legacy episode_workflows.stage column belongs to the Saga 2 pump and
  -- must not veto a task fenced to a Saga 3 ProcessRun + explicit claimScope.
  ${processModuleStageClause}                                                 -- (C) saga3: process_run_id in metadata
  OR NOT EXISTS (SELECT 1 FROM episode_workflows ew WHERE ew.epic_id=t.epic_id)  -- (D) legacy: no workflow row
  OR EXISTS (                                                                 -- (E) legacy: stage matches pump
    SELECT 1 FROM episode_workflows ew
    WHERE ew.epic_id=t.epic_id AND ew.stage=t.workflow_stage
  )
)
```

- **saga3 node-based path (KEEP):** branch (C), driven by `tasks.metadata.process_run_id` (populated by `bindProjectedTaskProcessContext`, `lm-node-executor.ts:428-442`). The `taskIdsClause` (lines 385-387) further narrows to an explicit allowlist when a node passes `claimScope: { taskIds: [taskId] }` (`lm-node-executor.ts:547`). This is the only path Phase 4 retains.
- **legacy stage-based path (REMOVE):** branches (A), (D), (E) — `workflow_stage IS NULL`, the `NOT EXISTS episode_workflows` fallback, and the `ew.stage = t.workflow_stage` match. These are the Saga 2 pump's stage-gating logic leaking into the dispatcher. Branch (B) (`summary.stage` bookkeeping) is legacy bookkeeping and goes away with the pump (Phase 3 deletes the only producers of `summary.stage`).

### 1.2 Concrete edit spec — `src/tools/dispatcher.ts`

**Remove** the `processModuleStageClause` helper (lines 388-390) — once (A)/(D)/(E) are gone, the saga3 path is no longer a special case but the default, so the conditional `OR json_extract(...) IS NOT NULL` is redundant.

**Replace** the entire disjunction (lines 398-411) with a single saga3 authority predicate:

```sql
-- Phase 4: a task is claimable ONLY if it is bound to an active Process Module
-- node. The discriminator is tasks.metadata.process_run_id (stamped by the
-- module's node executor at projection time). workflow_stage is now a
-- module-owned UI label only (§4) and must NOT gate claiming.
AND json_extract(t.metadata, '$.process_run_id') IS NOT NULL
```

The resulting `WHERE` keeps all other safety predicates unchanged:
- `t.status IN ('todo','review')` (line 393)
- `assigned_to IS NULL OR ''` (394)
- project/epic/role/taskIds filters (395-397, 412-413)
- `current_execution_id IS NULL` (414)
- `worker_executions` not reserved/running (415-418)
- no open `human_requests` (419-422)
- dependencies satisfied incl. merge gate (423-434)

**Also remove** the `workflow_stage` scoping inside the conflict-key anti-join (lines 446-455, the `AND other.workflow_stage = t.workflow_stage` clause at line 452). Two tasks collide on a `conflict_key` regardless of their stage label; the stage scoping exists only because the legacy pump could run two stages' dev tasks concurrently. With node-authority claiming, the owning node already serializes its own conflict set. Replace with: scope the anti-join by `process_run_id` equality instead, so two tasks from different ProcessRuns on the same file still serialize:

```sql
AND other.id IN (
  SELECT t2.id FROM tasks t2
  WHERE json_extract(t2.metadata,'$.process_run_id')
      = json_extract(t.metadata,'$.process_run_id')
)
```

**Net effect:** a task with no `process_run_id` becomes unclaimable through `worker_next`. This is the desired cutover invariant — only module-projected tasks enter the worker queue.

### 1.3 Migration note (non-blocking for Phase 4)
After this change, the `findNextClaimable` function name and its `taskIds` parameter remain valid; `taskIds` is exactly the node-scoped allowlist. No signature change needed. `readWorkIntentForTaskClaim` (lines 259-312) already enforces the WorkIntent↔task binding invariant at claim time and is retained unchanged — it is the authority snapshot the node froze.

---

## 2. Task-Kind-Based Downstream Generation — Remove the Ladder Call Sites

**Files:** `src/tools/dispatcher.ts`, `src/tools/workflow.ts`, `src/orchestrate.ts`

### 2.1 The ladder and its two call sites in worker tools

`generateNextForCompletedTask(taskId)` (`workflow.ts:365-392`) keys a transition off `task.task_kind`:

```typescript
// workflow.ts:378-383
const transition = task.task_kind === 'discovery.kickstart' ? 'brief_accepted'
  : task.task_kind === 'formalization.prd' ? 'prd_accepted'
  : task.task_kind === 'formalization.uc' ? 'uc_accepted'
  : task.task_kind === 'formalization.ac' ? 'ac_accepted'
  : task.task_kind === 'formalization.reconciliation' ? 'baseline_accepted'
  : task.task_kind === 'formalization.srs' ? 'srs_accepted'
  : null;
```

Each transition (`specsForTransition`, `workflow.ts:75-336`) INSERTs a downstream task with a hard-coded `workflow_stage`/`task_kind`/`execution_skill` (`insertGeneratedTask`, `workflow.ts:42-65`). This is a task-kind ladder — exactly what Phase 4 forbids: a generic task status (`done`) producing new work without a module-owned decision.

It is called from two worker-tool sites, both already guarded:

**Site 1 — `worker_done` (dispatcher.ts:1119-1132):**
```typescript
if (
  completed.completed_new_status === 'done'
  && completedTask?.process_run_id == null          // ← guard: legacy only
  && (!completedTask?.task_kind || completedTask.execution_mode !== 'git_change')
) {
  try {
    const generated = generateNextForCompletedTask(taskId);
    ...
```

**Site 2 — `worker_merge_release` (dispatcher.ts:1672-1679):**
```typescript
if (outcome === 'merged' && processManaged?.process_run_id == null) {  // ← guard
  try {
    generateNextForCompletedTask(taskId);
  ...
```

The `process_run_id == null` guards already prove the design intent: managed (saga3) tasks NEVER go through the ladder; their owning node generates the next task (`workflow_generate_next` MCP tool / `lm-node-executor` Flow). The guards are the seam.

### 2.2 Concrete edit spec

**REMOVE** both guarded blocks entirely:
- `dispatcher.ts:1109-1132` (the `completedTask` re-read, the `if (... process_run_id == null ...)` block, and the `generateNextForCompletedTask` call). The surrounding `completed` return and `storeReceipt` (lines 1076-1103) are unaffected.
- `dispatcher.ts:1668-1679` (the `processManaged` re-read and the `if (outcome === 'merged' && processManaged?.process_run_id == null)` block).

**REMOVE** the import `dispatcher.ts:8` (`import { generateNextForCompletedTask } from './workflow.js';`).

**ADAPT** `workflow.ts`: keep `handleWorkflowGenerateNext` and the `workflow_generate_next` MCP tool (lines 338-411) — this is the **module-owned** generation entry point called explicitly by saga3 nodes and the reconciler skill, not by a worker tool reacting to status. It already requires `source.status === 'done'` and a typed `task_kind` (lines 346-349), which is correct: the *module* decides the source is ready; the tool does not infer it. The `specsForTransition` ladder bodies (lines 75-336) stay for now — they are the formalization module's transition knowledge and will be re-homed into the formalization Process Module in a later phase. They are **REMOVE-from-worker-tools, KEEP-as-module-tool** for Phase 4.

**REMOVE** the engine-side caller `generateNextIfReady` in `src/orchestrate.ts:375-391`. Phase 3 deletes `orchestrate.ts` entirely (Phase 3 §1.1), so this site is removed by Phase 3; Phase 4 only needs to confirm no NEW caller of `generateNextForCompletedTask` survives in a worker tool after §2.2.

### 2.3 Why the guards were wrong even though they "worked"
The `process_run_id == null` check makes saga3 an opt-out special case. After Phase 4, there is no legacy path to opt back into: every task in the queue is module-projected (`process_run_id` is mandatory per §1.2), so the guard is always true and the branch is dead code that misleads readers into thinking generic status can still generate work. Removing it makes the invariant structural, not behavioural.

---

## 3. `worker_next` Must Not Advance Lifecycle Stage

**Files:** `src/tools/dispatcher.ts:631`, `src/tools/lifecycle.ts:341-385`

### 3.1 The violation

`handleWorkerNext` (dispatcher.ts:604-) ends its setup with:

```typescript
// dispatcher.ts:631
advanceReadyEpisodes(projectId);
```

`advanceReadyEpisodes` (lifecycle.ts:341-385) loops every `episode_workflows` row in the project and, for each, calls `handleEpisodeTransition` up to 5 times in a `for` loop (lines 351-383), writing `episode_workflows.stage` (via `handleEpisodeTransition`) and `episode_workflows.metadata` (lines 361-366, 370-379). It only skips `stage IN ('discovery','completed','cancelled')` (line 348) — meaning every `worker_next` call for a project with an episode in `formalization`/`planning`/`development`/`verification`/`integration` triggers a stage-transition attempt.

This is the most direct Phase 4 violation: **a worker acquiring a task mutates the lifecycle stage of (potentially unrelated) episodes in the same project.** Stage advancement must be a module-owned settlement decision, not a side-effect of claiming work.

### 3.2 Concrete edit spec

**REMOVE** the call `advanceReadyEpisodes(projectId);` at `dispatcher.ts:631`. `worker_next` becomes a pure claim: SELECT candidate, conditional-UPDATE assignment, return task + skill. No lifecycle side-effect.

**ADAPT** the stage-advancement owner. After Phase 3 deletes the legacy pump, the only legitimate driver of `episode_transition` is the Process Module lifecycle orchestrator (`src/process-modules/application/lifecycle-orchestrator.ts`, `lifecycle-router.ts`) acting on a module-owned settlement outcome, OR the explicit `episode_transition` MCP tool invoked by an operator/skill. `advanceReadyEpisodes` should be **re-homed**:
- Move `advanceReadyEpisodes` out of `lifecycle.ts` (a tools-layer file) into the lifecycle application layer, or delete it if the module orchestrator already advances on settlement (verify in the module lifecycle binding — `process-modules/lifecycles/`). Phase 4's job is only to **cut the worker_next → advanceReadyEpisodes edge**; the re-home target is a Phase 5/6 concern.
- Keep `handleEpisodeTransition` (lifecycle.ts:273-) and the `episode_transition` MCP tool — they are the **module/orchestrator-owned** transition primitive. They are correct to retain; the violation was calling them implicitly from a worker tool.

### 3.3 Why the discovery skip is insufficient
The `stage NOT IN ('discovery',...)` filter (lifecycle.ts:348) was added because saga3 discovery already self-manages its stage. But formalization/planning/development/verification/integration episodes served by Process Modules have the same self-management requirement. The skip-list approach scales badly; removing the call from `worker_next` entirely is the clean cut.

---

## 4. `workflow_stage` Column — Retain as Optional Module-Owned UI Label

**Files:** `src/tools/dispatcher.ts`, `src/tools/tasks.ts`, `src/tools/lifecycle.ts`, `src/process-modules/**`, `src/tools/export-import.ts`

### 4.1 Who WRITES `tasks.workflow_stage`

| Site | File:line | Classification |
|---|---|---|
| Module projection (LM node) | `src/process-modules/application/node-executors/lm-node-executor.ts:406` (`workflowStage: ctx.module.identity.kind`) | **KEEP-AS-LABEL** — module stamps its own kind |
| Module projection (development) | `src/process-modules/modules/development/sqlite-development-runtime.ts:716` (`workflowStage`, derived at :644 from `input.item.kind`) | **KEEP-AS-LABEL** |
| `task_create` MCP tool | `src/tools/tasks.ts:407,528` (accepts `workflow_stage` arg, INSERTs it) | **ADAPT** — keep the arg for module/skill use, but document as informational only |
| `task_update` MCP tool | `src/tools/tasks.ts:844` (in the updatable-fields allowlist) | **KEEP-AS-LABEL** |
| Legacy ladder generator | `src/tools/workflow.ts:44,56` (`insertGeneratedTask`) | **REMOVE** with the ladder call sites (§2.2) — the module-owned `workflow_generate_next` keeps writing it as a label |
| Export/import | `src/tools/export-import.ts:85,320,337` | **KEEP** — round-trip the label |

**Conclusion:** the only forbidden WRITER after §2.2 is the ladder inside worker tools. Module projection and the explicit MCP tools legitimately write it as a label.

### 4.2 Who READS `tasks.workflow_stage` as AUTHORITATIVE (must change)

| Site | File:line | Classification |
|---|---|---|
| Dispatcher claim filter | `src/tools/dispatcher.ts:399,409,452` | **REMOVE** — §1.2 strips this |
| `assertTasksReady` (lifecycle gate) | `src/tools/lifecycle.ts:89,262-264` (`WHERE workflow_stage=?`, groups by stage) | **ADAPT** — this is a module-owned gate reading its own projected label; keep BUT only call it from `episode_transition`/module orchestrator, never from a worker tool |
| Formalization kernel `areTasksReady` | `src/process-modules/modules/formalization/sqlite-formalization-kernel.ts:252` (`WHERE workflow_stage='formalization'`) | **KEEP-AS-LABEL** — module reading its own projection |
| Development runtime projection check | `src/process-modules/modules/development/sqlite-development-runtime.ts:621,633,687` | **KEEP-AS-LABEL** — module checking its own projection is consistent |
| `task_list` filter / `sort_by` | `src/tools/tasks.ts:513,588,621` | **KEEP** — UI filtering on the label |

**Conclusion:** `workflow_stage` is demoted to an optional, module-owned UI/label column. The only reader that treated it as a cross-cutting authority gate was the dispatcher, and §1.2 removes that. Module-internal reads of their own projected label are correct and retained.

### 4.3 `episode_workflows.stage` is Phase 3's concern
Writes to `episode_workflows.stage` (lifecycle.ts:331-335, 361-366, 370-379; `sqlite-saga2-runtime-repositories.ts:42,64`; `legacy-engine-administration.ts:236`; `fast-track.ts:206`) are the **lifecycle stage** column, not the task `workflow_stage` label. Phase 3 owns `episode_workflows`. Phase 4 only owns the edge from `worker_next` → `advanceReadyEpisodes` (§3.2), which is the one place a worker tool reached into `episode_workflows.stage`.

---

## 5. Review Verdict Flow — Already Compliant (KEEP)

**File:** `src/tools/dispatcher.ts:847-996`

The review verdict handling in `worker_done` is already correct for Phase 4:

- `in_progress` + `worker_done` → `review` (or `done` for discovery-only tasks, dispatcher.ts:852-859). This is a **task-internal** status transition, not a lifecycle stage change.
- `review_in_progress` + `verdict='approved'` → `done` (line ~876+). Task-internal.
- `review_in_progress` + `verdict='changes_requested'` → `todo` (re-work loop), with the verification escape hatch for `verification.ac` tasks with ≥2 failed evidence records (dispatcher.ts:862-880). Task-internal.
- The verdict writes only `tasks.status`, `tasks.assigned_to`, `tasks.integration_state`, a comment, and worktree metadata (dispatcher.ts:988-1046). It **never** writes `episode_workflows.stage` and (after §2.2) never generates downstream work.

The review result returns to the owning node exactly as the Phase 4 principle requires: the LM node executor polls `readTaskState(taskId)` (`lm-node-executor.ts:572`, `saga3-discovery-engine.ts:572`) and combines `taskDone`/`taskBlocked` with worker-substrate state to derive its own terminal verdict (`'clean'`/`'task_blocked'`/`'executor_failed'`/…, lm-node-executor.ts:559-589). The node, not the task status, drives settlement. The `exact-candidate-acceptance.ts` `requireApprovedReview` field (`src/process-modules/application/exact-candidate-acceptance.ts:61-64`) codifies this: "task=done alone is insufficient: an accepted worker_done receipt whose terminal result is `done` must exist" — the module requires the *evidence*, not the status.

**No edit required.** This is the reference implementation Phase 4 wants everywhere.

---

## 6. WorkIntent Creation Path — Tasks Are Created ONLY by Active Module Nodes

**Files:** `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts`, `src/process-modules/application/node-executors/lm-node-executor.ts`

### 6.1 The authoritative task-creation path (KEEP)

A task enters the worker queue only through this chain:

1. **A Process Module node runs.** `LmNodeExecutor.execute` (`lm-node-executor.ts`) is invoked by the module's Flow for a node that declares an LM execution profile.
2. **The node ensures a WorkIntent + projected task pair.** `ensureExecutionPlan` (`lm-node-executor.ts:375-411`) is idempotent on a `generationKey` derived from `process-run`/`node`/recovery-identity (`lm-node-executor.ts:371-372`). It creates the WorkIntent row and the task together.
3. **The WorkIntent row is inserted** via `createIntent` (`sqlite-saga3-discovery-runtime.ts:122-139`):
   ```sql
   INSERT INTO saga3_work_intents
     (epic_id, kind, objective, authority_scope, output_schema,
      token_budget, retry_budget, status)
   VALUES (?,?,?,?,?,?,?, 'open')
   ```
   `authority_scope` carries `{ snapshot_ref, scope, allowed_tools, enforcement }` (lm-node-executor.ts:380-385), frozen from the node's execution profile.
4. **The task is projected** with `metadata.work_intent_id` + `metadata.process_run_id` stamped (`bindProjectedTaskProcessContext`, lm-node-executor.ts:428-442; `process-execution-workspace.ts:251`).
5. **At claim time**, `readWorkIntentForTaskClaim` (dispatcher.ts:259-312) re-validates the binding (epic match, projected_task_id match, status claimable, authority_scope well-formed) and freezes the authority snapshot into `worker_executions.metadata.execution_context` (dispatcher.ts:512-551).

This is the only path Phase 4 retains. A task without `work_intent_id`/`process_run_id` is not module-authoritative and (after §1.2) is not claimable.

### 6.2 The non-authoritative task-creation paths (REMOVE or ADAPT)

| Path | File | Classification |
|---|---|---|
| `task_create` MCP tool | `src/tools/tasks.ts` (handleTaskCreate) | **ADAPT** — keep as an operator/manual tool (recovery, ad-hoc), but such tasks are NOT claimable through `worker_next` unless a module binds them via a WorkIntent. After §1.2 a bare `task_create` task has no `process_run_id` and is unclaimable; that is correct. |
| `insertGeneratedTask` (ladder) | `src/tools/workflow.ts:42-65` | **REMOVE-from-worker-tools** (§2.2); the `workflow_generate_next` module tool keeps it |
| Post-transition recovery spawn | `src/orchestrate.ts:633-692` (`spawnPostTransitionRecovery`, `spawnGenericRecovery`) | **REMOVE** — Phase 3 deletes `orchestrate.ts` |
| `task_update` status='done' recovery override | `src/tools/tasks.ts` (`_recovery_override`) | **ADAPT** — keep for bookkeeping sweep, but it does not generate downstream work |

### 6.3 Invariant to enforce
After Phase 4, grep must confirm: **no `INSERT INTO tasks` outside of** (a) module projection (`lm-node-executor`, `sqlite-development-runtime`), (b) the module-owned `workflow_generate_next` tool, and (c) the manual `task_create` operator tool (whose products are explicitly unclaimable until module-bound). A test should assert that `worker_next` returns `null` for a task lacking `process_run_id`.

---

## 7. Tests That Will Need Updating

### 7.1 Tests asserting the generateNext ladder from worker tools
- `tests/lifecycle/formalization-mechanics.test.mjs` — calls `workflow_generate_next` directly (lines 106, 120, 136, 143, 170, 175, 180). These are **module-tool** calls and stay valid. But any test that asserts `worker_done` *auto*-generates the next task (rather than the module calling `workflow_generate_next`) must be rewritten to call the module tool explicitly.
- `tests/product-workflow.test.mjs` (47 ladder references) — characterization of the full pipeline. After §2.2, any step that relied on `worker_done` → auto-generate must insert an explicit `workflow_generate_next` (or module-node) step.
- `tests/track-pipeline.test.mjs`, `tests/mock-claude.mjs` — review for auto-generation assumptions.

### 7.2 Tests asserting the cross-stage claim filter
- `tests/lifecycle/concurrency-transition.test.mjs:60` — INSERTs `episode_workflows (epic_id, stage, metadata) VALUES (?, 'development', '{}')` and relies on the stage-based claim model. After §1.2 the task must carry `process_run_id` to be claimable; rewrite fixtures to project tasks via a module binding, or assert the task is correctly UNclaimable without one.
- `tests/dispatcher-race/worktree-isolation.mjs` — claims tasks via `worker_next` (lines 56, 62, 76, 94, 144, 151). Fixtures must add `process_run_id` to task metadata (or the tasks become unclaimable and the test's `next.task?.title` assertions fail).
- `tests/lifecycle/claim-dependency.test.mjs`, `tests/lifecycle/worker-outcomes.test.mjs` — review claim assumptions.
- `tests/lifecycle/engine-control.test.mjs`, `tests/lifecycle/formalization-mechanics.test.mjs`, `tests/lifecycle/model-selector.test.mjs`, `tests/lifecycle/project-delete.test.mjs` — all reference `episode_workflows`/`workflow_stage`; review for stage-based claiming.

### 7.3 Tests asserting `advanceReadyEpisodes` from `worker_next`
- Any test that calls `worker_next` and then asserts `episode_workflows.stage` advanced will break after §3.2. The stage advancement must instead be driven by `episode_transition` or the module orchestrator. Grep target: `worker_next` followed by an `episode_workflows.stage` assertion in the same test.

### 7.4 Architecture/boundary test that ALREADY pins the direction (KEEP, extend)
- `tests/architecture/saga2-boundaries.test.mjs:586` — `assert.doesNotMatch(engineSrc, /generateNextForCompletedTask|workflow_generate_next/)` for the saga3-discovery engine. This already encodes the Phase 4 boundary for the engine layer. **Extend** it: add an assertion that `src/tools/dispatcher.ts` source does NOT contain a call to `generateNextForCompletedTask` and does NOT match `/episode_workflows.*stage.*=.*t\.workflow_stage/` (the legacy claim clause). This turns §1.2 and §2.2 into a durable architectural guard.

### 7.5 Saga3 tests (largely unaffected — they already use the node path)
The `tests/saga3/d*` suite and `tests/process-modules/*` operate through WorkIntents and ProcessRuns. They should continue to pass; a representative smoke is `tests/process-modules/discovery-generic-flow-scenarios.test.mjs`.

---

## 8. Edit Checklist (Phase 4 implementation, in order)

1. **dispatcher.ts:631** — remove `advanceReadyEpisodes(projectId);` import + call (§3.2).
2. **dispatcher.ts:1109-1132** — remove the `worker_done` → `generateNextForCompletedTask` block (§2.2).
3. **dispatcher.ts:1668-1679** — remove the `worker_merge_release` → `generateNextForCompletedTask` block (§2.2).
4. **dispatcher.ts:8** — remove the `generateNextForCompletedTask` import (§2.2).
5. **dispatcher.ts:388-411** — collapse the claim disjunction to the single `process_run_id IS NOT NULL` predicate; remove `processModuleStageClause` helper (§1.2).
6. **dispatcher.ts:446-455** — replace `other.workflow_stage = t.workflow_stage` with `process_run_id` equality in the conflict-key anti-join (§1.2).
7. **lifecycle.ts** — re-home or delete `advanceReadyEpisodes` (§3.2); keep `handleEpisodeTransition` + `episode_transition` tool.
8. **Add architecture test** — extend `tests/architecture/saga2-boundaries.test.mjs` to forbid the removed patterns in `dispatcher.ts` (§7.4).
9. **Update affected tests** per §7.1–§7.3.

After steps 1–6, a task status change can no longer advance a lifecycle stage or generate downstream work; only a module-owned node/settlement may do so. Workers and tasks are pure work-items bound to Process Module node authority.

---

## 9. Out of Scope (owned by other phases)

- **`episode_workflows` table and `episode_transition` writes** — Phase 3 (deprecate/delete legacy engine + episode_workflows semantics).
- **`specsForTransition` ladder bodies in `workflow.ts`** — re-homing into the formalization Process Module is a later phase; Phase 4 only removes the *worker-tool* callers.
- **`LegacyEngineAdministration` rename, `Saga2HostRuntime`/`Saga2RuntimePersistence` rename** — Phase 3 §3 / Phase 6.
- **DB migration dropping/nullable-ing `tasks.workflow_stage`** — Phase 8 (the column stays as a label; no migration needed for Phase 4 correctness, only an architectural test).
