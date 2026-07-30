# Phase 9 — Proof & Acceptance for the Hard Legacy-Engine Cutover

**Phase:** 9 of the saga-mcp hard legacy-engine cutover (branch `saga4`).
**Scope:** STRICTLY READ-ONLY. This phase produces NO source changes. Its only
output is this document: the architectural test suite and the acceptance
searches that PROVE, after the cutover, that

1. exactly one lifecycle authority remains (the Lifecycle Orchestrator), and
2. task completion alone can no longer advance a module or a lifecycle stage.

Anything that can advance a module/lifecycle must go through
`src/process-modules/application/lifecycle-orchestrator.ts`
(`LifecycleOrchestrator.run`). The legacy `episode_workflows` pump
(`src/orchestrate.ts`, `src/tools/lifecycle.ts`, `src/tools/workflow.ts`) must
be reduced to read-only migration / archived-doc occurrences only.

The two authorities in play, for reference:

- **NEW authority** — `LifecycleOrchestrator` (`src/process-modules/application/lifecycle-orchestrator.ts`),
  durable `LifecycleRun` rows (`src/process-modules/persistence/lifecycle-run.ts`),
  driven by `process_run_start` / `lifecycle_run_*` tools
  (`src/tools/lifecycle-runs.js`). One run = one pinned `LifecycleRun` with a
  `version`/`leaseFence` fence; resume re-enters `run()` with
  `resumePaused: true` and replays the frozen `StageRun` input.
- **LEGACY authority** — `episode_workflows` table + the Saga 2 pump
  (`src/orchestrate.ts`: `tryAdvanceStage`, `generateNextForCompletedTask`,
  `RECOVERY_TREE`, `spawnGenericRecoveryTask`, `spawnPostTransitionRecovery`,
  `NEXT_STAGE`) exposed through `episode_transition`
  (`src/tools/lifecycle.ts`) and `workflow_generate_next`
  (`src/tools/workflow.ts`). Task completion in the legacy pump feeds
  `generateNextForCompletedTask` → `episode_transition`, which is exactly the
  "task completion advances the stage" path Phase 9 must prove is gone from the
  live engine.

---

## DELIVERABLE A — Architectural Tests to Add

Each test below specifies: **name**, **file path**, **what it asserts**, **how**,
and the **existing test file to mirror**. Mirror means: copy the harness shape
(fake repos / source-regex assertion / `node:test` skeleton), not the legacy
behaviour under test. All new tests are `node:test` (`test(...)`) and read
source via `readFileSync` or drive a fake-repo harness exactly as the cited
patterns do.

Shared conventions (copy from `tests/architecture/cutover-architecture-checks.test.mjs`):
- repo root via `path.resolve(__dirname, '..', '..')`,
- `REPO_ROOT` + `readFileSync` for source-regex tests,
- `scanDependencyGraph({ rootDir: REPO_ROOT })` (from
  `tools/dep-graph-scanner.mjs`) for import-graph tests,
- assert via `node:assert/strict`.

### A1. Exactly one lifecycle authority (only Lifecycle Orchestrator can start/resume)

- **Name:** `phase-9: only LifecycleOrchestrator.run may start or resume a LifecycleRun`
- **File:** `tests/architecture/phase-9-single-lifecycle-authority.test.mjs`
- **Asserts:** the only symbol in the codebase that calls
  `LifecycleRunRepository.start` / `acquireExecutionLease` /
  `renewExecutionLease` / `ensureStageRun` / `bindProcessRun` /
  `markStageRunning` / `resume` is `LifecycleOrchestrator` (in
  `src/process-modules/application/lifecycle-orchestrator.ts`). No second
  engine (Saga 2 pump, `orchestrate.ts`, a CLI tool, a frontend handler) may
  touch those repository write methods. This is the structural proof of "one
  authority".
- **How:**
  1. Source-scan `src/**/*.ts` for the six lifecycle-write method names
     (`\.start\(` on the lifecycle repo, `acquireExecutionLease`,
     `renewExecutionLease`, `ensureStageRun`, `bindProcessRun`,
     `markStageRunning`, `resume(`).
  2. Resolve each hit to its enclosing module and assert every hit lives in
     `lifecycle-orchestrator.ts` OR in a `*.test.*` / `tests/**` path OR in a
     `*_repository.ts` implementation (the repo defines the method, it does
     not *call* it as an authority). Concretely: enumerate importers of
     `persistence/lifecycle-run-repository.ts` and assert the only
     *consumer* (non-repo-impl, non-test) importer is `lifecycle-orchestrator.ts`.
  3. Belt-and-suspenders with the dep graph: assert no file under
     `src/orchestrate.ts`, `src/engines/saga2-engine.ts`,
     `src/tools/lifecycle.ts`, `src/tools/workflow.ts`,
     `tracker-view/**` imports `lifecycle-orchestrator.ts` or
     `lifecycle-run-repository.ts` — the legacy lane must not reach into the
     new authority at all (mirrors the `NEW_CORE`/`FORBIDDEN` shape).
- **Mirror:** `tests/architecture/cutover-architecture-checks.test.mjs`
  (`hiddenFallbackViolations` + `scanDependencyGraph`) and
  `tests/lifecycle/engine-control.test.mjs` (source-regex governance of the
  pump).

### A2. Task completion alone cannot advance a module or lifecycle stage

- **Name:** `phase-9: worker_done / task status flip never advances a stage or LifecycleRun`
- **File:** `tests/architecture/phase-9-task-completion-cannot-advance.test.mjs`
- **Asserts:** the task-completion path (`worker_done` in
  `src/tools/dispatcher.ts`, `task_update`'s ignored `status` field in
  `src/tools/tasks.ts`) does NOT, in the live engine, call
  `generateNextForCompletedTask`, `episode_transition`, `tryAdvanceStage`,
  `workflow_generate_next`, `LifecycleRunRepository.completeStage`, or any
  `UPDATE … SET stage` / `UPDATE episode_workflows`. Task completion may only
  record a `worker_execution` outcome and clear `assigned_to`; the only thing
  that advances the lifecycle is the orchestrator observing a *terminal
  ProcessRun* (a module-local outcome), never a task status.
- **How:**
  1. Source-scan `src/tools/dispatcher.ts` (the `worker_done` handler) for
     any of the advance symbols and assert zero matches in the live branch.
     (Phase 8 leaves them only in the legacy `orchestrate.ts` pump, which A6
     below proves is unreachable for new runs.)
  2. Parse `src/tools/tasks.ts` `task_update` handler and assert `status` is
     documented as IGNORED (the existing comment) and there is no
     `UPDATE tasks SET workflow_stage=` and no `UPDATE episode_workflows`.
  3. Runtime guard: with a fake `ProcessRunRepository` + fake
     `LifecycleRunRepository` (harness from
     `lifecycle-orchestrator.test.mjs`), drive a ProcessRun to a terminal
     `done` outcome through `LifecycleOrchestrator.run`, then assert
     `completeStage` was called exactly once *by the orchestrator* and that
     calling `worker_done`-equivalent on the dispatcher (fake) never calls
     any repo write method.
- **Mirror:** `tests/process-modules/lifecycle-orchestrator.test.mjs`
  (fake `lifecycleRunRepo` + `processRunRepo` harness) for the runtime half;
  `tests/architecture/cutover-architecture-checks.test.mjs` for the source half.

### A3. A failed Development outcome cannot enter Verification

- **Name:** `phase-9: a failed Development outcome routes away from Verification, never into it`
- **File:** `tests/process-modules/phase-9-development-failure-routing.test.mjs`
- **Asserts:** when the Development stage's `ProcessRun` settles to a
  non-`verified`/failed outcome, the lifecycle `outcomeRoutes` for that stage
  cannot route to the Verification stage. The Product Delivery lifecycle
  definition must map a failed development outcome to a terminal `failed`
  (or a repair route), never to `verification`.
- **How:**
  1. Load the Product Delivery lifecycle definition
     (`src/process-modules/lifecycles/product-delivery-lifecycle.ts`) and
     locate the Development stage binding's `outcomeRoutes`.
  2. Assert that for every outcome code the Development module may emit that
     is NOT the success code, the route `type` is `terminal` with a
     `failed`/`blocked` status (or an explicit repair target), and the
     `toStage` (or transition target) is never the Verification stage id.
  3. Drive a harness (mirror `delivery-lifecycle-resume.test.mjs`): start the
     lifecycle, force the Development module's ProcessRun to `failed`, and
     assert the resulting `LifecycleRun.status` is `failed` and
     `currentStageId` never becomes the verification stage.
- **Mirror:** `tests/process-modules/delivery-lifecycle-resume.test.mjs`
  (`createProductLifecycleRuntime` + `orchestrator.run` + terminal-status
  assertions) and the outcome-route shape in
  `tests/process-modules/lifecycle-orchestrator.test.mjs`
  (`outcomeRoutes: { done: { type: 'terminal', status: 'done' } }`).

### A4. Verification cannot start without a verified integrated candidate

- **Name:** `phase-9: Verification stage entry requires a verified integration bundle + integrated candidate`
- **File:** `tests/process-modules/phase-9-verification-entry-gate.test.mjs`
- **Asserts:** the Verification stage's `entryConditions` (or the input
  mapping's required schemas) demand both a
  `VERIFIED_INTEGRATION_BUNDLE_SCHEMA` ref/hash AND an
  `INTEGRATED_CANDIDATE_SCHEMA` ref/hash. Starting the lifecycle with a
  development certificate but a null/missing verified bundle must refuse to
  enter (or pause before) Verification.
- **How:**
  1. Static: read the lifecycle definition's Verification stage
     `inputMapping` and assert it maps
     `verifiedIntegrationBundle` and `integratedCandidate` from the upstream
     Development output (the existing wiring at
     `product-delivery-lifecycle.ts` lines ~348–355 is the target shape).
  2. Runtime: harness like `delivery-lifecycle-resume.test.mjs`, but supply a
     development certificate whose `verifiedIntegrationBundle` is `null`
     (simulating an un-verified candidate). Assert
     `orchestrator.run` does NOT reach the Verification stage — either it
     pauses at Development, routes to `failed`, or throws an entry-condition
     error — and that `currentStageId` is never the verification stage id.
  3. Positive control: with a valid bundle+candidate, assert the run DOES
     enter Verification (so the test is not vacuously true).
- **Mirror:** `tests/process-modules/delivery-lifecycle-resume.test.mjs`
  (full `developmentCertificate` / `verifiedIntegrationBundle` /
  `integratedCandidate` fixture) and
  `tests/process-modules/exact-candidate-acceptance.test.mjs`.

### A5. Repository references survive export/import and restored test cache

- **Name:** `phase-9: tracker_export → tracker_import round-trips repository bindings, checkouts, and task repository refs`
- **File:** `tests/migrations/phase-9-export-import-repository-roundtrip.test.mjs`
- **Asserts:** exporting a project that owns repositories, repository
  checkouts, and tasks pinned to `project_repository_id`, then importing it
  into a fresh DB, restores: (a) the `repositories` rows, (b) the
  `project_repositories` bindings, (c) the `repository_checkouts` rows
  (the "restored test cache" — machine-local checkout records), and (d) every
  task's `project_repository_id` remapped to the new binding id (never
  dropped to `null` when the original was non-null).
- **How:**
  1. Build a temp DB (mirror the `mkdtempSync` + raw `better-sqlite3` setup
     in `tests/architecture/saga2-boundaries.test.mjs` `SQLite board reader`
     test): insert one project, one epic, two `repositories`, two
     `project_repositories` bindings, one `repository_checkouts` row per
     binding, and two tasks each pinned to a different `project_repository_id`.
  2. Call `tracker_export` (`src/tools/export-import.ts` `handleExport`) and
     capture the JSON; assert the payload contains a non-empty `repositories`
     array whose entries each carry `checkouts`, and that each task carries
     `_original_project_repository_id`.
  3. Spin a second temp DB, call `tracker_import` (`handleImport`) with that
     JSON, then query the new DB and assert: repository count matches,
     binding count matches, checkout count matches, and every imported task's
     `project_repository_id` is non-null and points at a binding that exists
     in `repositoryBindingIdMap` equivalent (i.e. resolves to a real
     `project_repositories.id`).
- **Mirror:** `tests/architecture/saga2-boundaries.test.mjs` (`SQLite board
  reader preserves the tracker project and board projection` — raw schema +
  temp DB) and `tests/product-workflow.test.mjs` (existing export/import
  coverage). Source under test:
  `src/tools/export-import.ts` lines ~89, ~169–271, ~341–348.

### A6. Stale numeric repository IDs are rejected before worker spawn

- **Name:** `phase-9: a task whose project_repository_id no longer exists is rejected before a worker is spawned`
- **File:** `tests/process-modules/phase-9-stale-repository-id-rejection.test.mjs`
- **Asserts:** when a task carries a `project_repository_id` that has been
  deleted (or never existed), the dispatcher / workspace-preparation path
  rejects it (throws a clear error or skips claim) BEFORE constructing a
  worker executor and BEFORE calling `spawnProcess`. A stale numeric id must
  not silently fall back to `null`/legacy workspace resolution and must not
  spawn a worker that will crash mid-execution.
- **How:**
  1. Source-scan `src/process-modules/application/process-workspace-preparation.ts`
     and `pinned-workspace-materializer.ts` for the repository resolution
     path; assert there is a guard that throws on a missing binding (no
     silent `?? null` swallow at the spawn boundary).
  2. Runtime: harness a `ProcessRun` whose input references a
     `project_repository_id` not present in `project_repositories`; assert
     `orchestrator.run` (or the workspace-preparation step) throws before
     the `workerExecutorFactory` is invoked (count factory calls == 0,
     mirror the duplicate-lock short-circuit pattern in
     `tests/architecture/saga2-boundaries.test.mjs`).
- **Mirror:** `tests/architecture/saga2-boundaries.test.mjs`
  (`workerExecutorFactory: () => { calls++; throw new Error('must not build worker…') }`
  + assert call count 0) and
  `tests/process-modules/process-execution-workspace.test.mjs`.

### A7. Module recovery returns structured feedback to the producer

- **Name:** `phase-9: a recovery issue returns RECOVERY_FEEDBACK_SCHEMA feedback to the producing LM node`
- **File:** `tests/process-modules/phase-9-module-recovery-structured-feedback.test.mjs`
- **Asserts:** when a module verifier emits a repair issue, the executor
  routes back to the same LM node with a feedback production whose schema is
  exactly `RECOVERY_FEEDBACK_SCHEMA` and whose body carries: `processRunId`,
  `moduleRef`, `verifyNodeId`, `repairNodeId`, `attempt`, `maxAttempts`,
  `caseId`, `issue`, `issueHash`, `sourceProduction`. No free-form string
  feedback; no env-var side channels.
- **How:**
  1. Direct mirror of the existing passing test
     `tests/process-modules/generic-flow-feedback-recovery.test.mjs` `a
     recovery issue routes back to the same LM node with exact durable
     feedback`, but parametrized: run it for multiple reason codes and for
     both `disposition: 'repair'` and `disposition: 'human'` to prove the
     feedback structure is uniform (reason codes stay opaque).
  2. Assert the feedback `artifactRef` matches
     `/^recovery-case:\d+:attempt:\d+$/` and that the persisted
     `recovery_case` row carries the issue + feedback attempt.
- **Mirror:** `tests/process-modules/generic-flow-feedback-recovery.test.mjs`
  (the `syntheticModule` + `buildHarness` fixture is the canonical pattern;
  Phase 9's test is its regression-seal twin).

### A8. Retry exhaustion pauses or terminates according to module policy

- **Name:** `phase-9: exhausting the repair budget pauses (onExhausted:'pause') or fails (onExhausted:'fail') per module policy`
- **File:** `tests/process-modules/phase-9-retry-exhaustion-policy.test.mjs`
- **Asserts:**
  - with `onExhausted: 'pause'`: exhausting attempts throws
    `ProcessRunPausedError`, leaves the ProcessRun `paused` at a durable
    checkpoint, and the recovery case is `exhausted` (not `failed`).
  - with `onExhausted: 'fail'` / a fatal disposition: the run terminates
    with `RecoveryFatalError`, ProcessRun goes `failed`, and no repair loop
    is entered.
  - In neither case does exhaustion silently advance the stage.
- **How:** parametrize the existing
  `generic-flow-feedback-recovery.test.mjs` harness over `onExhausted ∈
  {pause, fail}` and `disposition ∈ {repair, fatal}`; assert the two
  distinct terminal shapes. This is the policy table Phase 9 freezes.
- **Mirror:** `tests/process-modules/generic-flow-feedback-recovery.test.mjs`
  (`exhausting the semantic repair budget pauses at a durable checkpoint` +
  `a fatal issue fails the run without entering the repair route`).

### A9. Restart resumes the pinned LifecycleRun

- **Name:** `phase-9: restart re-enters the same pinned LifecycleRun and replays the frozen StageRun input`
- **File:** `tests/process-modules/phase-9-restart-resumes-pinned-run.test.mjs`
- **Asserts:** after a pause (or a recoverable lease-loss
  `ProcessRunBusyError` / `NodeExecutionLeaseLostError`), calling
  `orchestrator.run` again with `resumePaused: true` (a) returns the SAME
  `LifecycleRun.id`, (b) does NOT start a new run (no new row, idempotency
  key matches), and (c) feeds the executor the *frozen* StageRun input —
  not a re-mapped or re-derived one.
- **How:**
  1. First half: direct mirror of the existing
     `lifecycle-orchestrator.test.mjs` test `restart uses the frozen StageRun
     input and preserves processRunId in the handoff frame` — assert
     `ensureStageCommand.inputPayload === frozenInput` and
     `processStartCommand.input.payload === frozenInput`.
  2. Second half: mirror `delivery-lifecycle-resume.test.mjs` — pause once,
     resume, assert `resumed.lifecycleRun.id === paused.lifecycleRun.id`,
     `status === 'completed'`, and that the external effect (e.g. delivery
     deployment) happened exactly once across pause+resume (idempotency).
  3. Recoverable-error half: mirror the
     `${recoverableErrorName} leaves the LifecycleRun recoverable` loop —
     assert `failCalls === 0` and `lifecycle.status === 'running'` after a
     `ProcessRunBusyError`, so a later restart has something to resume.
- **Mirror:** `tests/process-modules/lifecycle-orchestrator.test.mjs` and
  `tests/process-modules/delivery-lifecycle-resume.test.mjs`.

### A10. Frontend Start launches only the new lifecycle

- **Name:** `phase-9: tracker-view Start launches the Lifecycle Orchestrator, not the Saga 2 pump`
- **File:** `tests/architecture/phase-9-frontend-start-new-lifecycle-only.test.mjs`
- **Asserts:** the tracker-view Start path (`tracker-view/tracker-view.mjs`)
  wires Start to the lifecycle pipeline API
  (`createLifecyclePipelineApi` / `lifecycle-pipeline/mount.js`,
  `SqliteLifecycleRunRepository`) and does NOT spawn or invoke the legacy
  `episode_transition` / `orchestrate.ts` / `Saga2Engine` path. The frontend
  must be the single poller (`window.__lifecyclePipeline`) and must yield to
  the lifecycle projection, never to the legacy `episode_workflows` refresh.
- **How:**
  1. Read `tracker-view/tracker-view.mjs` source (mirror the
     `tracker uses extracted ports` source-regex test in
     `tests/architecture/saga2-boundaries.test.mjs`).
  2. Assert presence of `createLifecyclePipelineApi`,
     `SqliteLifecycleRunRepository`, and the lifecycle-pipeline mount.
  3. Assert absence (in the Start handler region) of `episode_transition`,
     `tryAdvanceStage`, `generateNextForCompletedTask`, `Saga2Engine`,
     `new LegacyEngineAdministration`, and `SAGA_ORCHESTRATION_MODE`-based
     engine switching. (The legacy projection adapter may remain for
     read-only display; the *Start* path must not.)
- **Mirror:** `tests/architecture/saga2-boundaries.test.mjs`
  (`tracker uses extracted ports and preserves the LM Studio hard rule fix`
  — source-regex over `tracker-view.mjs`).

---

## DELIVERABLE B — Acceptance Search Commands

For each marker: the exact `grep -rn` command, and the ONLY acceptable
remaining occurrence types after the cutover. "Acceptable" always means one of:
**(migration)** a read-only / write-once DB migration in `src/db.ts` /
`src/schema.ts`; **(read-only projection)** a `SELECT`-only read for backward
display; **(archived doc)** under `docs/**`; **(test)** under `tests/**`;
**(comment/docstring)** prose explaining what was removed. Anything else fails
acceptance.

Repository root for all commands: `D:\Разработка\saga-mcp` (run from there).

### B1. `episode_workflows`

```bash
grep -rn "episode_workflows" src/ tools/ tracker-view/ --include="*.ts" --include="*.mjs"
```

**Only acceptable remaining occurrences:**
- **(migration)** `src/schema.ts` — `CREATE TABLE IF NOT EXISTS episode_workflows`
  + its index (the table is retained for read-only migration; no live writes).
- **(migration)** `src/db.ts` — the `track` column backfill migration +
  comment (write-once migration of historical rows).
- **(read-only projection)** `src/infrastructure/projections/sqlite-board-projection-reader.ts`
  and `src/process-modules/persistence/process-run.ts` — a `SELECT`/projection
  comment only; the `projectedStage` comment ("Where to project legacy
  episode_workflows.stage (null = no projection)") must show the projection is
  optional and null for new runs.
- **(archived doc / comment)** comments in `src/tools/*.ts` documenting that
  the legacy filter is gated behind `NOT EXISTS (SELECT 1 FROM episode_workflows …)`.

**Unacceptable (fails acceptance):** any `INSERT INTO episode_workflows`,
any `UPDATE episode_workflows SET stage=`, in a *live* (non-migration,
non-test) path. Specifically the `INSERT OR IGNORE` and `UPDATE … SET stage=`
in `src/tools/lifecycle.ts` (`getOrCreate`, `handleEpisodeTransition`) and
`src/orchestrate.ts` must be unreachable for new runs (gated to zero callers
in the live engine — see B2/B3).

### B2. `episode_transition`

```bash
grep -rn "episode_transition" src/ tools/ tracker-view/ --include="*.ts" --include="*.mjs"
```

**Only acceptable remaining occurrences:**
- **(archived doc / comment)** the tool *definition* in `src/tools/lifecycle.ts`
  retained purely as a disabled no-op that throws
  `Error('episode_transition is retired; use the Lifecycle Orchestrator')`, OR
  removed entirely.
- **(test)** under `tests/**`.
- **(archived doc)** under `docs/**`.

**Unacceptable:** any live caller — i.e. the handler must not be registered
in the active MCP tool catalog, and the Saga 2 pump must not call it. The
frontend Start path must not reference it.

### B3. `tryAdvanceStage`

```bash
grep -rn "tryAdvanceStage" src/ tools/ --include="*.ts"
```

(Current: 4 occurrences, all in `src/orchestrate.ts`.)

**Only acceptable remaining occurrences:** **(archived doc / comment)** in
`src/orchestrate.ts` if that file is retained as a retired/archived module
with a banner comment `// RETIRED: legacy Saga 2 pump — not reachable by new
runs; see LifecycleOrchestrator`. If `orchestrate.ts` is deleted entirely,
this grep must return zero. **(test)** references under `tests/**` that assert
the symbol is *gone* are acceptable.

**Unacceptable:** any live import or call from a non-retired module.

### B4. `generateNextForCompletedTask`

```bash
grep -rn "generateNextForCompletedTask" src/ tools/ --include="*.ts"
```

(Current: `src/orchestrate.ts` ×4, `src/tools/dispatcher.ts` ×3,
`src/tools/workflow.ts` ×1.)

**Only acceptable remaining occurrences:**
- **(archived doc / comment)** inside a retired `src/orchestrate.ts` (banner
  comment as in B3), OR
- the definition in `src/tools/workflow.ts` retained only behind the
  retired `workflow_generate_next` tool (which must itself be a disabled
  no-op or removed), AND
- **(comment)** in `src/tools/dispatcher.ts` a comment stating
  `worker_done no longer calls generateNextForCompletedTask; the Lifecycle
  Orchestrator advances stages` — the *call* must be gone, only an
  explanatory comment may remain.

**Unacceptable:** `src/tools/dispatcher.ts` actually *calling* it from
`worker_done`. Acceptance = the dispatcher hits must be comments only.

### B5. `RECOVERY_TREE`

```bash
grep -rn "RECOVERY_TREE" src/ tools/ --include="*.ts"
```

(Current: 9 occurrences, all in `src/orchestrate.ts`.)

**Only acceptable remaining occurrences:** **(archived doc / comment)** inside
the retired `src/orchestrate.ts` banner (the legacy Saga 2 recovery tree), OR
zero if the file is deleted. The NEW recovery path is the module-level
recovery loop (`generic-flow-executor.ts` + `recovery-engine.ts` +
`SqliteRecoveryCaseRepository`), which must NOT use the name `RECOVERY_TREE`.

**Unacceptable:** any new-engine file referencing `RECOVERY_TREE`.

### B6. `spawnGenericRecoveryTask`

```bash
grep -rn "spawnGenericRecoveryTask" src/ tools/ --include="*.ts"
```

**Only acceptable remaining occurrences:** **(archived doc / comment)** in
retired `src/orchestrate.ts`, or zero. The new recovery model does not
"spawn a recovery task" — it routes back to the same LM node with
`RECOVERY_FEEDBACK_SCHEMA` (see A7). Any live caller fails acceptance.

### B7. `spawnPostTransitionRecovery`

```bash
grep -rn "spawnPostTransitionRecovery" src/ tools/ --include="*.ts"
```

**Only acceptable remaining occurrences:** **(archived doc / comment)** in
retired `src/orchestrate.ts`, or zero. This was the legacy "after
episode_transition, spawn a recovery task" hook; the new engine has no
post-transition recovery spawn (recovery is intra-module). Any live caller
fails acceptance.

### B8. `NEXT_STAGE`

```bash
grep -rn "NEXT_STAGE" src/ tools/ --include="*.ts"
```

(Current: `src/orchestrate.ts`, plus `scenario-runner.ts` and
`sqlite-lifecycle-run-repository.ts` use the *column/name* `nextStageId` /
similar — those are NOT the legacy `NEXT_STAGE` constant and must be
disambiguated.)

**Only acceptable remaining occurrences:**
- **(archived doc / comment)** the legacy `NEXT_STAGE` map (theSaga 2
  hard-coded stage sequence) inside retired `src/orchestrate.ts`, or zero.
- The new-engine `nextStageId` / `currentStageId` *column* names in
  `sqlite-lifecycle-run-repository.ts` and `scenario-runner.ts` are
  acceptable — they are the declarative lifecycle's stage cursor, not the
  legacy constant. Disambiguate with word-boundary grep:

```bash
grep -rn "\bNEXT_STAGE\b" src/ tools/ --include="*.ts"
```

Use the word-boundary form for acceptance: it must match only the legacy
constant (retired/commented) and not the new `nextStageId` column.

**Unacceptable:** any live branch using the hard-coded `NEXT_STAGE` map to
decide the next stage instead of the declarative lifecycle `outcomeRoutes`.

### B9. `saga2`

```bash
grep -rn "saga2" src/ tools/ tracker-view/ --include="*.ts" --include="*.mjs"
```

**Only acceptable remaining occurrences:**
- **(archived doc / comment / type name)** the `saga2` *orchestration mode*
  literal in `src/runtime/orchestration-mode.ts` (the parser still recognises
  it so historical configs fail loudly instead of silently), plus comments.
- **(archived module)** files explicitly named `saga2-*`
  (`src/engines/saga2-engine.ts`, `src/infrastructure/.../saga2-*`,
  `src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts`)
  retained ONLY as the retired legacy lane behind the disabled `saga2` mode,
  with NO live selection path reaching them. The composition root
  (`src/app/composition-root.ts`) must NOT select `Saga2Engine` for any
  default/new run.
- **(test)** under `tests/**`.

**Unacceptable:** the *default* orchestration mode being `saga2`, or any new
run being routed through `Saga2Engine`. (Note the current default is `v2` per
`tests/architecture/saga2-boundaries.test.mjs` — Phase 9 requires the default
to be the lifecycle, i.e. `SAGA_ORCHESTRATION_MODE` is gone or always
lifecycle; see B12.)

### B10. `"legacy orchestrate"`

```bash
grep -rn "legacy orchestrate" src/ tools/ tracker-view/ docs/ --include="*.ts" --include="*.mjs" --include="*.md"
```

(Current: zero source hits — phrase appears only in docs if at all.)

**Only acceptable remaining occurrences:** **(archived doc)** under `docs/**`,
or **(comment)** explaining the retirement. Zero live-code occurrences is the
target. Any code identifier named `legacy orchestrate` fails acceptance.

### B11. `"--engine=v2"`

```bash
grep -rn -- "--engine=v2" src/ tools/ tracker-view/ --include="*.ts" --include="*.mjs"
grep -rn '"--engine=v2"' src/ tools/ tracker-view/ --include="*.ts" --include="*.mjs"
```

(Current: zero hits.)

**Only acceptable remaining occurrences:** none in live code. If the CLI flag
is retained at all, it must be in a retired/commented CLI parser that throws
"engine selection is retired; the Lifecycle Orchestrator is the only engine".
Any live CLI wiring of `--engine=v2` fails acceptance. (The grep is doubled
because the `--` flag stops `grep` option parsing of the leading `--engine`.)

### B12. `workflow_stage` mutation

```bash
# any UPDATE that sets workflow_stage (stage advance via SQL)
grep -rnE "UPDATE tasks SET.*workflow_stage|workflow_stage\s*=\s*\?" src/ tools/ --include="*.ts"
# the episode_workflows stage-flip that USED to be the advance
grep -rnE "UPDATE episode_workflows" src/ tools/ --include="*.ts"
```

**Only acceptable remaining occurrences:** none in live code.
`workflow_stage` may be *read* (`SELECT … WHERE workflow_stage=?`,
`src/tools/lifecycle.ts:89`, `src/tools/dispatcher.ts` filter) and may be
*set once at task creation* (`INSERT INTO tasks … workflow_stage`, not an
`UPDATE`). The phase-9 invariant is: **no `UPDATE` that changes
`workflow_stage` or `episode_workflows.stage` exists in a live path.** Stage
advance happens only inside `LifecycleOrchestrator` via `completeStage` on the
`lifecycle_run` / `lifecycle_stage_run` tables — never by mutating
`tasks.workflow_stage` or `episode_workflows.stage`.

**Unacceptable:** any `UPDATE tasks SET … workflow_stage=` or
`UPDATE episode_workflows SET stage=` reachable from the live engine.

### B13. `SAGA_ORCHESTRATION_MODE`

```bash
grep -rn "SAGA_ORCHESTRATION_MODE" src/ tools/ tracker-view/ --include="*.ts" --include="*.mjs"
```

**Only acceptable remaining occurrences:**
- **(retired literal / comment)** in `src/runtime/orchestration-mode.ts` and
  `src/runtime/saga-runtime-config.ts`, the env var is recognised ONLY to
  reject retired values loudly (`Unknown SAGA_ORCHESTRATION_MODE` / "this
  variable is retired, the Lifecycle Orchestrator is always used"), OR
- **the default is gone or always-lifecycle**: `loadSagaRuntimeConfig` no
  longer reads a mode switch to decide the engine; the engine is always the
  Lifecycle Orchestrator. The current default `v2` (per
  `tests/architecture/saga2-boundaries.test.mjs` `runtime config defaults
  orchestration mode to the stable v2 mode`) must be flipped to "always
  lifecycle" — so this test's assertion is updated in Phase 9 to
  `config.orchestrationMode` being absent or always-lifecycle.
- **(test)** under `tests/**`.

**Unacceptable:** the env var selecting between `Saga2Engine` and
`Saga3DiscoveryEngine` in `src/app/composition-root.ts` for a live run, or the
spawned engine env (`legacy-engine-administration.ts`, `orchestrate-cli.ts`)
honoring a non-lifecycle mode.

---

## SMOKE-RUN ACCEPTANCE — one clean end-to-end lifecycle

This is the human-runnable proof that, on a fresh DB, exactly one engine
executes the full pipeline with zero legacy-pump writes.

### Command (run one clean lifecycle)

From the repo root, on a fresh temp DB (so no historical rows interfere):

```bash
# 1. Fresh DB in a temp dir
export SAGA_SMOKE_DB="$(mktemp -d)/smoke.db"
rm -f "$SAGA_SMOKE_DB"

# 2. Run one clean product lifecycle Discovery -> Formalization ->
#    Development -> Verification -> Delivery through the Lifecycle Orchestrator.
#    (Phase 9 target: there is no --engine flag; the orchestrator is the only
#    engine. If a CLI entrypoint still exists it must NOT accept --engine=v2.)
node dist/orchestrate-cli.js \
  --db-path="$SAGA_SMOKE_DB" \
  --lifecycle-input=./docs/design/saga4-cutover/smoke-product-delivery-case.json \
  --idempotency-key=phase-9-smoke-1
```

(If the Phase 9 CLI no longer takes `orchestrate-cli.js`, substitute the
equivalent `lifecycle_run_start` MCP call / `node dist/tools/lifecycle-runs.js`
invocation; the point is one run of the Product Delivery lifecycle from
Discovery to a released Delivery stage. The smoke input JSON is a fixture
that satisfies A3/A4 entry conditions: a discovery certificate, formalized
PRD/SRS/UC/AC, an integrated + verified candidate, and a release policy.)

### What DB inspection proves single-engine execution

Run these against `$SAGA_SMOKE_DB` immediately after the run completes. All
must hold for acceptance.

```sql
-- (1) Exactly ONE LifecycleRun was created and it reached a terminal state.
SELECT id, status, terminal_status, current_stage_id
FROM lifecycle_runs
WHERE idempotency_key = 'phase-9-smoke-1';
-- Accept: exactly one row, status in ('completed','released'),
--         terminal_status non-null.

-- (2) StageRuns walked the full pipeline in order (one per stage).
SELECT ordinal, stage_id, status, local_outcome
FROM lifecycle_stage_runs
WHERE lifecycle_run_id = (SELECT id FROM lifecycle_runs WHERE idempotency_key='phase-9-smoke-1')
ORDER BY ordinal;
-- Accept: ordinal 1..N for Discovery, Formalization, Development,
--         Verification, Delivery; each status='completed'.

-- (3) ZERO writes to episode_workflows during this fresh run.
--     The table exists (read-only migration) but no row was inserted/updated
--     by the live engine for this epic.
SELECT COUNT(*) AS ew_rows_for_smoke_epic
FROM episode_workflows
WHERE epic_id = (SELECT epic_id FROM lifecycle_runs WHERE idempotency_key='phase-9-smoke-1');
-- Accept: 0  (the legacy pump never touched this epic).

-- Even stronger: confirm no episode_workflows row was modified at all since
-- the schema was initialized. Capture the max(updated_at) BEFORE the run,
-- then AFTER assert it is unchanged:
SELECT MAX(updated_at) AS ew_max_updated FROM episode_workflows;
-- Accept: NULL (table empty on fresh DB) OR unchanged before/after.

-- (4) Exactly ONE ProcessRun per stage, all pinned to the lifecycle.
SELECT stage_id, COUNT(*) AS process_runs
FROM (
  SELECT sr.stage_id, pr.id
  FROM lifecycle_stage_runs sr
  JOIN process_runs pr ON pr.id = sr.process_run_id
  WHERE sr.lifecycle_run_id = (SELECT id FROM lifecycle_runs WHERE idempotency_key='phase-9-smoke-1')
)
GROUP BY stage_id;
-- Accept: one process_run per stage, no orphans.
```

**Acceptance criterion:** statements (1), (2), (3), (4) all hold. (3) is the
load-bearing one — zero `episode_workflows` writes during a fresh run is the
direct proof that the legacy pump did not execute.

### What process inspection proves a single orchestrator

On the host running the smoke:

```bash
# Exactly one orchestrator process for this epic; no Saga2Engine pump running.
# (Names adjusted to the actual process title Phase 9 ships; the invariant is
#  "one lifecycle orchestrator, zero saga2 pumps".)
pgrep -fa "lifecycle-orchestrator|orchestrate-cli" | grep -v grep
# Accept: exactly one line for the smoke run.

pgrep -fa "saga2-engine|Saga2Engine" | grep -v grep
# Accept: zero lines (no legacy pump).
```

If `pidof`/`pgrep` is unavailable on the platform, the engine-lock file is
the equivalent proof — the Lifecycle Orchestrator writes a single lock:

```bash
# One lifecycle lock for the smoke epic, owned by the one orchestrator pid.
ls -1 "$HOME/.zcode/cli"/lifecycle-*.pid 2>/dev/null
# Accept: exactly one lock file for the smoke epic, containing the pid from
#         the single pgrep line above.

# And NO legacy saga2 engine lock for the same epic.
ls -1 "$HOME/.zcode/cli"/engine-*.pid 2>/dev/null
# Accept: zero engine-*.pid lock files (the legacy pump did not take a lock).
```

**Acceptance criterion:** one lifecycle orchestrator process + zero Saga2Engine
pumps + one lifecycle lock + zero legacy engine locks. Combined with the
zero-`episode_workflows`-writes SQL above, this is the end-to-end proof that
only one lifecycle authority executed the run.

---

## Summary matrix

| # | Test (Deliverable A) | Proves | Mirror file |
|---|---|---|---|
| A1 | single-lifecycle-authority | only `LifecycleOrchestrator` writes the run | `cutover-architecture-checks.test.mjs` |
| A2 | task-completion-cannot-advance | `worker_done` ≠ stage advance | `lifecycle-orchestrator.test.mjs` |
| A3 | development-failure-routing | failed Dev ≠ Verification | `delivery-lifecycle-resume.test.mjs` |
| A4 | verification-entry-gate | no verified candidate ⇒ no Verification | `delivery-lifecycle-resume.test.mjs` |
| A5 | export-import-repository-roundtrip | repos/checkouts/refs survive | `saga2-boundaries.test.mjs` |
| A6 | stale-repository-id-rejection | stale id rejected pre-spawn | `saga2-boundaries.test.mjs` |
| A7 | module-recovery-structured-feedback | `RECOVERY_FEEDBACK_SCHEMA` to producer | `generic-flow-feedback-recovery.test.mjs` |
| A8 | retry-exhaustion-policy | pause-vs-fail per module policy | `generic-flow-feedback-recovery.test.mjs` |
| A9 | restart-resumes-pinned-run | resume = same run, frozen input | `lifecycle-orchestrator.test.mjs` |
| A10 | frontend-start-new-lifecycle-only | Start ⇒ orchestrator, not pump | `saga2-boundaries.test.mjs` |

| Marker (Deliverable B) | Only acceptable remaining type |
|---|---|
| `episode_workflows` | migration / read-only projection / comment |
| `episode_transition` | retired no-op or removed / test / doc |
| `tryAdvanceStage` | retired `orchestrate.ts` banner or zero |
| `generateNextForCompletedTask` | comment-only in dispatcher + retired def |
| `RECOVERY_TREE` | retired `orchestrate.ts` or zero |
| `spawnGenericRecoveryTask` | retired `orchestrate.ts` or zero |
| `spawnPostTransitionRecovery` | retired `orchestrate.ts` or zero |
| `NEXT_STAGE` (`\bNEXT_STAGE\b`) | retired `orchestrate.ts` or zero (not `nextStageId`) |
| `saga2` | retired mode literal + archived `saga2-*` modules / test |
| `"legacy orchestrate"` | archived doc only; zero in live code |
| `"--engine=v2"` | zero in live code |
| `workflow_stage` / `episode_workflows` UPDATE | zero live `UPDATE` (read + insert-at-create only) |
| `SAGA_ORCHESTRATION_MODE` | gone or always-lifecycle; reject-literal only |

The smoke run (one clean lifecycle) plus the SQL/process inspections above is
the final end-to-end seal: one orchestrator, zero legacy pump writes, zero
legacy engine processes.
