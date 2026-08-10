# Dispatcher and Worker Execution Lifecycle

How the Saga Factory claims tasks, spawns worker processes, and processes
results. The goal of this document is to make the dispatch→spawn→drain loop
fully legible so a scripted worker can be injected in place of the spawned LLM.

All file paths are relative to the repo root unless absolute. Line numbers are
accurate to the committed source at the time of writing.

---

## 1. The orchestrate-cli loop

Entry point: `src/orchestrate-cli.ts`. The CLI is the **factory operator**. It
runs the lifecycle (which pauses when a module waits for kanban tasks to drain),
distributes queued tasks to workers, then resumes. Repeat until the lifecycle
reaches a terminal state or no more tasks remain.

### 1.1 Startup

`main()` (line 94):

1. `parseArgs` extracts `--launch-ref=<opaque capability>` (line 49). The launch
   ref is an opaque capability token; it is NOT a free argument.
2. `claimFactoryLaunch(launchRef, claimToken)` (line 103) atomically claims the
   durable launch row. The ticket yields `{ projectId, epicId, concurrency,
   lifecycleInput, lifecycleInputSchema, initiatedBy, mode }`.
3. For `mode === 'resume'`, the idempotency key + `initiated_by` are read from
   the durable `factory_lifecycle_runs` row (lines 121-142) to avoid
   `LIFECYCLE_REPLAY_CONTEXT_MISMATCH`.
4. `loadCompositionOverrides(projectId, epicId)` (line 169) loads the
   `SAGA_PRODUCT_LIFECYCLE_COMPOSITION` ESM module, which supplies Delivery
   providers AND optionally `workerExecutorFactory` / `resolveWorkerContext`
   overrides. It also installs the production Process Module packages
   (`installProductionModules`) so every ProcessRun is pinned to an immutable
   `packageDigest`.
5. `createFactoryApplication(process.env, overrides)` (line 177) composes the
   single `SagaApplication`. This constructs (see `src/app/composition-root.ts`):
   - ONE `WorkAssignmentPort` (`SqliteWorkAssignmentAdapter`) carrying the route
     resolver — the single assignment authority.
   - ONE `WorkerExecutorFactory` (pinned Claude factory, OR the scripted override
     if `overrides.workerExecutorFactory` is set).
   - Both are published to module-level handles
     (`lastFactoryWorkAssignment`, `lastFactoryWorkerExecutorFactory`) so the
     dispatch loop reuses them — "one spawn point, one assignment authority".
6. `startWorkerSupervision({ executionRuntime, projectId, epicId })` (line 194)
   starts the watchman: one reconcile on startup (catches orphans from a prior
   crash), then every 30s.

### 1.2 The main loop (lines 216-462)

```ts
let emptyDispatchStreak = 0;
const MAX_EMPTY_DISPATCH_STREAK = 3;
while (true) {
  const result = await application.runEpisode({ ... });         // (A) run lifecycle
  process.stdout.write(`cycle: ${JSON.stringify({...})}\n`);
  if (result.reason !== 'paused') break;                        // (B) terminal → exit

  const dispatched = await distributeQueuedTasks({ ... });      // (C) dispatch + drain
  if (dispatched === 0) {                                       // (D) empty queue handling
    // supervision sweep, active-executions check, idle classification, streak
  }
  emptyDispatchStreak = 0;                                      // reset on success
}
```

**Phase A — runEpisode.** Each cycle calls
`application.runEpisode({ projectId, epicId, concurrency, lifecycleInput (first
cycle only), idempotencyKey, resumePaused: !isFirstCycle || mode==='resume',
initiatedBy })`. The lifecycle runtime advances the Process Module flow as far
as it can. When it hits a node that needs kanban work to drain, it returns
`{ reason: 'paused', ... }`. When it reaches a terminal state it returns
`{ reason: 'completed' | 'failed' | 'stopped', ... }`.

On the first cycle, if `result.lifecycleRun?.id` is present,
`markFactoryLaunchRunning` records the lifecycle run id on the launch row.

**Phase B — terminal check.** `if (result.reason !== 'paused') break;` — any
non-paused reason (completed/failed/stopped) breaks the loop and proceeds to
finalization (line 463+).

**Phase C — distributeQueuedTasks.** When paused, the CLI imports
`distributeQueuedTasks` from `./app/dispatch-loop.js` and the shared
`getLastFactoryWorkAssignment()` + `getLastFactoryWorkerExecutorFactory()`
handles. It builds a `factoryContext`:

```ts
factoryContext: {
  projectId, epicId, workspaceRoot,
  dbPath: process.env.DB_PATH!,
  sagaEntry,                           // dist/index.js — the MCP server
  sagaSkillRoot: process.cwd(),
  claudePath: process.env.SAGA_CLAUDE_PATH,   // legacy fallback only
  logRoot, heartbeatLog, lmStudioUrl,
}
```

`distributeQueuedTasks` returns the count of terminal worker executions (see
section 2).

**Phase D — empty-queue handling (lines 369-457).** When `dispatched === 0`:

1. **On-demand supervision sweep** (line 374): `supervisionHandle.reconcileOnce()`
   runs immediately — an empty queue is itself a high-value reconciliation
   boundary and must not race the streak timeout.
2. **Active-executions check** (lines 387-403): queries
   `worker_executions WHERE state IN ('reserved','running','cancel_requested')`.
   If `n > 0`, a resumed host may be adopting executions from a previous host
   that are not in this process's Promise set. Reset `emptyDispatchStreak = 0`,
   log, sleep 2s, `continue`.
3. **Idle-state classification** (lines 408-439): reads
   `readCurrentStageWorkplaceState(db, lifecycleRunId)` for the lifecycle run's
   CURRENT stage run. Three buckets (see section 1.4):
   - `humanPausedCount > 0` → **break** (stop the factory in paused state).
   - `kernelProgressCount > 0` → reset streak, sleep 250ms, `continue`.
   - otherwise → fall through to streak increment.
4. **Streak increment** (lines 445-456): `emptyDispatchStreak += 1`. If it hits
   `MAX_EMPTY_DISPATCH_STREAK` (3), break with
   `"empty-queue streak exhausted — stopping to avoid infinite loop"`. Otherwise
   sleep 2s and `continue`.

### 1.3 Empty-queue-streak

The streak counter exists because a paused lifecycle may need to be re-run after
each worker completes (the next node projection can fire). But if
`distributeQueuedTasks` returns 0 repeatedly without the lifecycle advancing,
the run is genuinely stuck (needs-human, unresolved dependency). The factory
stops at streak = 3 rather than spinning forever.

The streak is **reset to 0** by:
- Any successful dispatch (`dispatched > 0`).
- Active durable executions still running (host adoption case).
- Kernel-owned progress pending (repair_wait / verifying / effect_pending).

### 1.4 Idle-state classification

`src/app/orchestration-idle-state.ts` — `readCurrentStageWorkplaceState(db,
lifecycleRunId)`.

Crosses `factory_lifecycle_runs` → `factory_stage_runs` (via
`lr.current_stage_run_id`) → `factory_workplaces` (via
`sr.process_run_id`). It groups non-terminal workplaces by `loop_state` into
three buckets:

```ts
const KERNEL_PROGRESS_STATES = new Set(['repair_wait', 'verifying', 'effect_pending']);
```

- **kernelProgressCount** — `loop_state IN ('repair_wait','verifying',
  'effect_pending')`. These are driven synchronously by the
  ProductionCellNodeExecutor on the NEXT `runEpisode` call. The factory resumes
  the kernel promptly (250ms sleep) and does NOT consume the streak.
- **humanPausedCount** — `loop_state === 'paused'`. This is the explicit
  onExhausted / human-required boundary, invisible to normal dispatch and
  supervision. The factory STOPS in paused state.
- **otherNonTerminalCount** — everything else non-terminal. Falls through to the
  streak path.

Important: `LifecycleRun.current_stage_run_id` is a StageRun id, NOT a
ProcessRun id. The query always crosses the explicit `sr.process_run_id`
binding; integer id equality across those tables is accidental.

### 1.5 Finalization (lines 463-502)

After the loop breaks:

1. Writes the pipeline result to the engine log.
2. **Replay certification sweep** (lines 478-490): if not paused,
   `certifyAcceptedReplayCapsules(db, projectId)` backfills missing capsules
   (crash reconciliation fallback).
3. `finishFactoryLaunch(launchRef, claimToken, status, errorJson, completionMarker)`
   records the final state on the durable launch row.
4. `process.exit(result.reason === 'failed' ? 1 : 0)`.

The `finally` block (line 513) stops supervision and closes the application.

---

## 2. Task dispatch — `distributeQueuedTasks`

`src/app/dispatch-loop.ts`. This application service owns queue scheduling and
the global concurrency budget. It atomically assigns a card through
`WorkAssignmentPort` BEFORE constructing a worker process, then gives one
immutable `AssignedWork` to one executor.

### 2.1 The drain loop

```ts
while (true) {
  // Inner loop: launch workers up to concurrency budget or queue exhaustion.
  while (true) {
    if (input.shouldYieldToKernel?.()) { kernelWorkPending = true; break; }
    const admission = input.readConcurrencyAdmission();
    assertAdmission(admission);
    if (admission.activeExecutions >= admission.effectiveConcurrency) {
      capacityBlockedForNow = true; break;
    }
    const launched = startOne();        // assignTask + executor.start
    if (!launched) { queueExhaustedForNow = true; break; }
    active.add(launched.completion);
  }
  if (active.size === 0) {
    // Nothing running: break on kernel-yield, capacity-block, or queue-exhaust.
    break;
  }
  await Promise.race(active);           // a completion may unblock dependents
}
```

### 2.2 `startOne` — the atomic assignment + spawn sequence

```ts
const startOne = (): ActiveAssignedWorker | null => {
  const workerExecutionId = input.idGenerator.newTypedId('worker-execution');
  const workerId = input.idGenerator.newTypedId('worker');
  const assignment = input.workAssignment.assignTask({
    projectId, epicId, workerId,
    workerExecutionId: asExecutionId(workerExecutionId),
    runId: dispatchRunId, machineId: input.machineId,
  });
  if (!assignment) return null;          // queue exhausted

  const executor = input.workerExecutorFactory(input.factoryContext);
  executor.start({ projectId, epicId, concurrency: 1, assignment });
  // ↑ local ceiling of 1 — concurrency belongs to this service, not the runner.

  const completion = waitForAssignedWorker({ executor, projectId, assignment, pollMs });
  return { assignment, completion };
};
```

Key invariants:
- The `workerExecutionId` and `workerId` are generated by the dispatcher
  (uuidIdGenerator), NOT by the worker. The worker is a process host.
- `assignTask` runs FIRST, inside one BEGIN IMMEDIATE transaction. If it returns
  null, no worker is spawned. If it succeeds, the card is already fenced.
- If `executor.start` throws, `releaseAssignment` returns the card to the queue
  and the executor is disposed (lines 100-111).

### 2.3 `waitForAssignedWorker`

Polls `executor.status(projectId)` every `pollMs` (default 1000ms). Returns when
`snapshot === null` or `snapshot.status` is in
`{completed, stopped, failed}`. The executor is disposed in a `finally` block.

Returns `terminalWorkers` (count of terminal executions) from
`distributeQueuedTasks`. This is what `orchestrate-cli` uses to distinguish
"dispatched 0" (empty/stuck) from "dispatched N" (progress).

### 2.4 Concurrency admission

`readConcurrencyAdmission()` returns `{ operatorConcurrency, modelConcurrencyLimit,
effectiveConcurrency, activeExecutions }`. `assertAdmission` (line 211) enforces
all are integers 1..10 and `effectiveConcurrency === min(operatorConcurrency,
modelConcurrencyLimit)`. A slot is acquired only after `assignTask` succeeds.

---

## 3. Task claim — `worker_next` / `findNextClaimable`

Two claim paths share ONE atomic core (`findNextClaimable` in
`src/lifecycle/work-assignment-core.ts`):
- **MCP path** — `worker_next` in `src/tools/dispatcher.ts` (line 229), when a
  worker calls the tool directly.
- **Engine path** — `WorkAssignmentPort.assignTask` in
  `SqliteWorkAssignmentAdapter` (which calls the same `findNextClaimable`).

### 3.1 The claim SQL (lines 412-494 of work-assignment-core.ts)

```sql
SELECT t.*
  FROM tasks t
 WHERE (t.assigned_to IS NULL OR t.assigned_to='')
   AND t.current_execution_id IS NULL
   AND t.epic_id IN (SELECT id FROM epics WHERE project_id=?)
   /* + optional epicClause, taskIdsClause, excludeClause, roleClause */
   AND json_extract(t.metadata, '$.process_run_id') IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM factory_process_runs pr
      WHERE pr.id=json_extract(t.metadata, '$.process_run_id')
        AND pr.status IN ('running','paused')
   )
   AND (
     (t.workplace_ref IS NOT NULL
       AND t.status IN ('todo','review')
       AND EXISTS (
         SELECT 1 FROM factory_workplaces w
          WHERE w.workplace_ref=t.workplace_ref
            AND (w.loop_state='queued'
                 OR (w.loop_state IN ('leased','running','verifying')
                     AND NOT EXISTS (
                       SELECT 1 FROM worker_executions we
                        WHERE we.execution_id=w.active_reservation_ref
                          AND we.state IN ('reserved','running','cancel_requested')
                     )))))
     OR (t.workplace_ref IS NULL AND t.status IN ('todo','review'))
   )
   AND NOT EXISTS (active worker_executions for this task)
   AND NOT EXISTS (open human_requests for this task)
   AND NOT EXISTS (unmet dependencies — including un-merged git_change deps)
   AND NOT EXISTS (conflict-key collision with another pending git_change task
                   in the same process_run_id)
 ORDER BY
   CASE WHEN t.status='review' THEN 0 ELSE 1 END,   -- review first
   <PRIORITY_ORDER>,                                 -- critical/high/medium/low
   t.created_at
 LIMIT 1
```

### 3.2 Atomicity

The claim runs inside `withImmediateTransaction(db, () => { ... })` — a manual
`BEGIN IMMEDIATE` (write-locks the whole DB). If the SELECT finds a task, an
UPDATE flips its status:

```sql
UPDATE tasks
   SET status=?, assigned_to=?, current_execution_id=?, updated_at=datetime('now')
 WHERE id=? AND status IN ('todo','review')
   AND (assigned_to IS NULL OR assigned_to='')
   AND current_execution_id IS NULL
```

The `info.changes !== 1` guard handles the race where another worker claimed the
same row between SELECT and UPDATE — it recurses (up to `MAX_CLAIM_ATTEMPTS = 10`)
to find a different task.

### 3.3 Status transitions on claim

- `todo` → `in_progress` (development cycle)
- `review` → `review_in_progress` (review cycle, status changed)

`claimedStatusFor` (line 343) prefers the Workplace `kanban_phase` when a
`workplace_ref` is set: if the workplace is in review/review_in_progress, the
task claims as `review_in_progress`.

### 3.4 Metadata stamped on the task

The claim transaction stamps:
- `tasks.status` — `in_progress` or `review_in_progress`.
- `tasks.assigned_to` — the worker id (the disposable attempt identity).
- `tasks.current_execution_id` — the execution id (the fence token; equals the
  worker execution id).

When a `reservation` is supplied (engine path), a `worker_executions` row is
INSERT-ed with:
- `execution_id`, `run_id`, `project_id`, `epic_id`, `task_id`, `worker_id`,
  `machine_id`.
- `phase` — `'executing'` (author) or `'reviewing'` (reviewer).
- `metadata` — `{ execution_context, execution_context_hash }` (frozen route +
  authority snapshot, see section 4.3).
- `lease_expires_at` — `now + WORKER_LEASE_TTL_MS` (5 min).
- `heartbeat_at`, `progress_at` — `now`.
- `stuck_state` — `'active'`.

The task metadata (NOT stamped by the claim itself) carries:
- `process_run_id` — required for the task to be claimable.
- `process_node_id`, `process_execution_profile_id` / `process_workspace.profile_id`.
- `work_intent_id` — links to the authority WorkIntent.
- `workplace_ref` — links to the durable Workplace.
- `product_source` — `'typed-submission'` or `'managed-production'`.
- `role` — `'author'` or `'reviewer'`.

### 3.5 Skill / profile determination

`skillForTask(task, sourceStatus)` (line 48 of work-assignment-core.ts):
1. If review-status and `task.review_skill` set → use it.
2. Else if `task.execution_skill` set → use it.
3. Else look for a tag `review-skill:<x>` or `skill:<x>`.
4. Else look for `role:<x>` tag → `saga-<role>`.
5. Fallback: `saga-reviewer` or `saga-developer`.

The execution profile (Process Module profile with protocol/semantic/reviewer
skills + allowedTools) is resolved separately in the runner via
`resolveExecutionProfile(taskKind)` and `resolveLaunchSpec({ assignment,
resolvedProfile })` — see section 5. The route (executor kind, model, provider)
is resolved at claim time via `readRouteKeyForTask` + the injected
`routeResolver`, and frozen into `execution_context`.

### 3.6 The `worker_next` server-side fence (one launch = one card)

`handleWorkerNext` (line 229 of dispatcher.ts) rejects a second claim from an
execution that ALREADY holds an active card — BEFORE the queue is read:

```ts
if (typeof fenceExecutionId === 'string' && fenceExecutionId !== '') {
  const holdsActiveExecution = db.prepare(
    `SELECT 1 FROM worker_executions
      WHERE execution_id=? AND state IN (reserved,running,cancel_requested) LIMIT 1`,
  ).get(fenceExecutionId, ...ACTIVE_EXECUTION_STATES);
  const holdsFencedTask = holdsActiveExecution
    ? undefined
    : db.prepare('SELECT 1 FROM tasks WHERE current_execution_id=? LIMIT 1')
      .get(fenceExecutionId);
  if (holdsActiveExecution || holdsFencedTask) {
    throw new Error(`AUTHORITY_DENIED: execution '...' already holds an active card; ...`);
  }
}
```

This is the single server-side chokepoint covering MCP-direct, every launcher,
and tests — independent of any client `--disallowedTools` flag.

---

## 4. Worker spawn

### 4.1 Production executor factory

`src/infrastructure/workers/claude-worker-executor-factory.ts` —
`createPinnedClaudeWorkerExecutorFactory(options)` returns a
`WorkerExecutorFactory`. Each call returns a `ClaudeBoardWorkerExecutor`
wrapping a `ClaudeBoardRunner` (from `tracker-view/claude-runner.mjs`).

The factory wires:
- `resolveWorkspace: () => context.workspaceRoot`
- `dbPath`, `sagaEntry` (MCP server path), `sagaSkillRoot`, `claudePath`,
  `realClaudePath`, `logRoot`, `heartbeatLog`, `lmstudioBaseUrl`,
  `getActiveModel` (model route reader).
- `resolveProfile: taskKind => resolveExecutionProfile(taskKind)`.
- `resolveLaunchSpec` — resolves the pinned package + execution profile +
  allowedTools for the assignment.
- `prepareWorkspace` — materializes the pinned workspace AND provisions the
  RepositoryDesk (git worktree) for git_change tasks (see section 4.4).
- `recoverAssignment` — called when a worker exits without a terminal
  `worker_done` (see section 6.4).
- An in-process replay runner for capsule replay (see section 5.3).

### 4.2 The spawn (`ClaudeBoardRunner.launch`)

`tracker-view/claude-runner.mjs` line 767. The runner is one-card: `pump()`
takes `run.preassignedWork`, converts it via `assignmentFromAssignedWork`, and
calls `launch(run, assignment, workerId)`. There is NO in-process claim.

The spawn sequence:

1. **Resolve the executor binary** from the FROZEN `execution_context.executor_kind`
   (line 465 `resolveExecutorPath`). As of the routing cutover, only
   `claude-cli` is supported; the simulator is gone. Falls back to
   `this.realClaudePath ?? this.claudePath`.
2. **Resolve model route** from the FROZEN `execution_context.model_route`
   (`{provider, model, effort}`). Throws `FROZEN_MODEL_ROUTE_REQUIRED` if absent.
3. **Write the per-execution MCP config** (line 525
   `writeExecutionMcpConfig(executionId, taskId, workerId)`). This is a temp
   JSON file carrying the saga MCP server config with env:
   ```json
   {
     "mcpServers": {
       "saga": {
         "type": "stdio",
         "command": "node",
         "args": ["<sagaEntry>"],
         "env": {
           "DB_PATH": "<resolved>",
           "TRACKER_AUTOSTART": "0",
           "SAGA_MANAGED_EXECUTION": "1",
           "SAGA_EXECUTION_ID": "<executionId>",
           "SAGA_TASK_ID": "<taskId>",
           "SAGA_WORKER_ID": "<workerId>"
         }
       }
     }
   }
   ```
   This is how execution identity reaches the stdio-spawned MCP child under
   `--strict-mcp-config` (the child gets ONLY these env keys).
4. **Resolve the execution profile + launch spec** (`resolveProfile`,
   `resolveLaunchSpec`). Required — throws if missing.
5. **Prepare the workspace** (`prepareWorkspace`) — materializes pinned files +
   provisions the RepositoryDesk.
6. **Build the prompt** (line 98 `buildPrompt`) — inlines the protocol skill +
   semantic/reviewer skill, the machine-provisioned workspace paths, and the
   task payload. See section 4.5.
7. **Assemble args** (line 867):
   ```
   -p --bare --disable-slash-commands
   [--model <modelArg>] [--effort <effortArg>]
   --mcp-config <executionMcpConfigPath> --strict-mcp-config
   --settings <structured-hook-settings>
   --allowedTools <saga-allowed + builtins>
   --disallowedTools mcp__saga__worker_next[, <denied builtins>]
   --permission-mode dontAsk
   --output-format stream-json --verbose --forward-subagent-text --no-session-persistence
   ```
   `--bare` disables user/project hooks/plugins/skills/memory/CLAUDE.md
   (ambient authority). `worker_next` is always disallowed (one launch = one
   card).
8. **Spawn** (line 1022):
   ```ts
   const child = this.spawnClaude(executorSelection.claudePath, args, {
     cwd: executionCwd,                    // the RepositoryDesk worktree path
     env: {
       ...process.env,
       ...lmstudioEnv,                     // LM Studio endpoint overrides if applicable
       SAGA_RUN_ID: run.id,
       SAGA_WORKER_ID: workerId,
       SAGA_EXECUTION_ID: assignment.execution_id,
       SAGA_TASK_ID: String(task.id),
       SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64: <base64 of hook script>,
       SAGA_AGENT_ASSISTANCE_PATH: processWorkspace?.agentAssistanceAbsolutePath,
       SAGA_PROJECT_ID, SAGA_PROJECT_NAME, SAGA_TASK_TITLE,
     },
     windowsHide: true,
     stdio: ['pipe', 'pipe', 'pipe'],
   });
   ```
9. **Pipe the prompt via stdin** (line 1058) — avoids the Windows CreateProcess
   32767-char limit for large skills.
10. **Progress signal** (line 1075): stdout/stderr activity updates
    `progress_at` (throttled to ≤1/30s) so the stuck-policy distinguishes
    long-running-but-healthy from dead.
11. **Register the execution** (line 1219): `executionStore.markRunning(dbPath,
    executionId, pid, readBirthToken(pid), logPath, startedAt)`.

### 4.3 Environment variables passed to the worker

To the **worker claude process**:
- `SAGA_RUN_ID`, `SAGA_WORKER_ID`, `SAGA_EXECUTION_ID`, `SAGA_TASK_ID`,
  `SAGA_PROJECT_ID`, `SAGA_PROJECT_NAME`, `SAGA_TASK_TITLE`.
- `SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64` (base64 of the structured
  PostToolUse hook script).
- `SAGA_AGENT_ASSISTANCE_PATH` (structured agent-assistance projection path).
- LM Studio overrides when `provider === 'lmstudio'`: `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_ATTRIBUTION_HEADER`,
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.

To the **saga MCP child** (via `--mcp-config` env under `--strict-mcp-config`):
- `DB_PATH`, `TRACKER_AUTOSTART=0`, `SAGA_MANAGED_EXECUTION=1`,
  `SAGA_EXECUTION_ID`, `SAGA_TASK_ID`, `SAGA_WORKER_ID`.

The gateway (`src/index.ts`) reads `process.env.SAGA_EXECUTION_ID` to authorize
each Saga tool call against the frozen `execution_context` snapshot.

### 4.4 `provisionRepositoryDesk`

`src/infrastructure/workers/repository-desk-provisioner.ts` — the SINGLE place
that runs `git worktree`. The factory (not the LM) decides:
- which repository (`task.project_repository_id`),
- which branch (`task/<id>` for author, detached HEAD for reviewer/verifier),
- which base commit (integration branch HEAD, or the frozen
  `expectedBaseCommit` from the DevelopmentCase, or the accepted source commit
  for reviewers).

`provisionRepositoryDesk` in `claude-worker-executor-factory.ts` (line 762):
- Resolves the repo binding + base commit.
- For reviewers: `provisionReviewerDesk({ repositoryRoot, taskId, sourceCommit,
  ... })` — a read-only detached checkout at the frozen CandidateSet source.
- For authors: `provisionAuthorDesk({ repositoryRoot, taskId, integrationBranch,
  baseCommit, ... })` — a worktree on `task/<id>` with an immutable
  effective-base receipt.
- The desk binding is persisted into both `tasks.metadata.process_workspace.repository_desk`
  and `worker_executions.metadata.repository_desk`.

The worker process is spawned with `cwd = desk.executionPath`. All methods are
idempotent (reuse an existing worktree at the expected path/branch/commit).

### 4.5 `readProcessBirthToken` — the PowerShell path fix

`src/worker-executions.ts` line 258. This reads a process birth token (creation
timestamp / start time) used to verify PID identity for the reaper (prevents
killing an unrelated process that recycled a dead worker's PID).

- **win32**: resolves PowerShell via `process.env.POWERSHELL_PATH` falling back
  to `C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` (Git Bash /
  restricted environments may not have `powershell` on PATH visible to Node
  `spawnSync`). Runs:
  ```powershell
  $p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";
  if ($null -ne $p) { $p.CreationDate.ToUniversalTime().ToString('o') }
  ```
  Returns the CreationDate as an ISO 8601 string, or null on failure.
- **linux**: reads `/proc/${pid}/stat` and returns `linux:<field-19>` (the
  process start time in jiffies since boot).
- Other platforms: returns null.

`verifyProcessBirthToken(pid, expectedToken)` reads the current token and
compares. A mismatch means the PID was recycled (scenario 16) — the reaper
refuses to kill.

---

## 5. Worker execution lifecycle

### 5.1 WorkerExecution = disposable attempt

A `worker_executions` row represents ONE attempt at ONE card by ONE process.
Identity: `execution_id` (a UUID generated by the dispatcher). State machine:

```
reserved → running → (finishing|integrating) → exited
                  ↘ cancel_requested → terminated
                  ↘ spawn_failed
                  ↘ lost
```

Columns (from `WorkerExecutionRow`):
- `execution_id`, `run_id`, `project_id`, `epic_id`, `task_id`, `worker_id`,
  `machine_id`.
- `state` — `reserved | running | cancel_requested | exited | terminated |
  spawn_failed | lost`.
- `phase` — `executing | reviewing | finishing | integrating`.
- `pid`, `process_birth_token`, `log_path`.
- `lease_expires_at`, `heartbeat_at`, `progress_at`.
- `suspected_stuck_at`, `cancel_requested_at`, `stuck_state`.
- `metadata` — JSON with `execution_context`, `execution_context_hash`,
  `repository_desk`.

`ACTIVE_EXECUTION_STATES = ['reserved','running','cancel_requested']`.

### 5.2 Workplace = durable identity

A `factory_workplaces` row is the durable card — it survives across many
disposable WorkerExecution attempts. Its `loop_state` is the authoritative
execution state; `tasks.status` is a reverse projection. States include
`queued`, `leased`, `running`, `verifying`, `effect_pending`, `repair_wait`,
`paused`, `terminal`.

The task is bound to its workplace via `tasks.workplace_ref`. The claim SQL
checks the workplace `loop_state` (queued, or leased/running/verifying with no
active reservation) to determine eligibility.

### 5.3 `worker_done` — state advancement

`handleWorkerDone` in `src/tools/dispatcher.ts` (line 484). Runs inside
`withImmediateTransaction`. Sequence:

1. **Idempotency check** (line 521): `workerDoneCommandId(executionId, verdict,
   taskId, workerId, result)` + `hashPayload(...)`. If a prior accepted receipt
   exists with the same command_id + payload hash, return the stored reply
   verbatim. If the command_id exists with a DIFFERENT payload, throw
   `IDEMPOTENCY_KEY_REUSED`.
2. **Owner check** (line 548): `SELECT * FROM tasks WHERE id=? AND
   assigned_to=?`. The worker must own the task.
3. **Execution fence** (line 554): `assertExecutionFence(db, task, executionId)`
   — if `task.current_execution_id` is set, the supplied `executionId` must
   match AND an active `worker_executions` row must exist for it.
4. **Production Cell submission requirement** (line 565): a Production Cell
   completion requires at least one typed managed product to have been persisted
   by this execution. Otherwise `running → verifying` creates a state that
   cannot seal a CandidateSet.
5. **Submission validation gate** (line 579): for author completion only, runs
   the module-owned validator. Rejection leaves the worker as execution owner
   and throws `SubmissionValidationError`.
6. **Compute new status** (lines 600-703):
   - `in_progress` + has review_skill → `review` (buffer for reviewer).
   - `in_progress` + no review_skill → `done` (close immediately; tracker-only
     tasks).
   - `review_in_progress` + `approved` → `done`.
   - `review_in_progress` + `changes_requested`:
     - `verification.ac` with ≥2 failed evidence → `done` (loop escape).
     - Else with exhausted `managed_review_budget` → `blocked`.
     - Else → `todo` (retry).
7. **Atomic UPDATE** (line 746): `UPDATE tasks SET status=?, assigned_to=NULL,
   ... WHERE id=? AND assigned_to=? AND (current_execution_id IS NULL OR
   current_execution_id=?)`. The `info.changes !== 1` guard catches assignment
   races.
8. **ConveyorRuntime release** (line 764): `releaseTaskExecution` advances the
   Workplace loop.
9. **Phase update** (line 785): for `done` git_change tasks with pending
   integration → `integrating`; else `finishing`.
10. **Comment** (line 801): insert the worker's result as a comment.
11. **Integration state** (lines 806-838): for done git_change tasks, set
    `integration_state='pending'` and stamp `metadata.worktree.merged_into='pending'`.
12. **Idempotency receipt** (line 884): `storeReceipt` so a retry returns the
    same reply.

The reply always carries `stop: true` — `worker_done` does NOT auto-claim the
next task (that created zombies in the "one task = one launch" model).

### 5.4 The execution fence (`execution_id`)

The fence token === the worker execution id (same string, branded differently
for type safety: `ExecutionId` vs `FenceToken`). It is stamped on:
- `tasks.current_execution_id`
- `worker_executions.execution_id`

Every mutating call (`worker_done`, `worker_merge_acquire`,
`worker_merge_release`, `worker_ask_need`, `verification_record`) must supply
`execution_id` matching the task's `current_execution_id`. `assertExecutionFence`
(line 95 of worker-executions.ts) enforces this: if the task is fenced and the
supplied id doesn't match (or no active execution row exists), it throws.

The fence is cleared by `releaseExecutionAtomically` (in
`src/lifecycle/atomic-release.ts`) — the single primitive used by the reaper,
the close callback, and `worker_ask_need` to terminalize an execution AND
release its task in one transaction.

---

## 6. Supervision — the watchman

`src/infrastructure/work/worker-supervision-service.ts`. Started by
`orchestrate-cli` at line 194. Runs one reconcile on startup, then every
`DEFAULT_INTERVAL_MS` (30s).

### 6.1 Two layers of single-flight protection

1. **In-process** (LAYER 1): a module-scoped `Set<${projectId}:${epicId}>` so
   two handles or a periodic sweep racing an on-demand `reconcileOnce()` cannot
   overlap within one Node process.
2. **Cross-process** (LAYER 2): a `supervision_locks` table row acquired by CAS
   (`INSERT OR IGNORE` + `UPDATE ... WHERE expires_at < ? OR holder_id = ?`).
   TTL `DEFAULT_SWEEP_LEASE_MS` (30s). The holder re-acquires on every sweep.

The ultimate convergence guarantee is the fenced-CAS idempotency of
`releaseExecutionAtomically` — even if two processes slipped past the lease,
they converge to one effective winner per fenced card.

### 6.2 The sweep order

```
reconcile FIRST, renewLeases SECOND.
```

A newly started host must NOT renew a same-host execution left by a previous
host before the reaper has evaluated its durable lease + PID birth identity.
Renewing first would "adopt" an orphan by extending `lease_expires_at`.

### 6.3 `reconcileWorkerExecutions` — the reaper

`src/worker-executions.ts` line 349. Now a thin MECHANISM; all POLICY lives in
the pure `decideStuckAction` (`src/lifecycle/stuck-policy.ts`).

For each active execution row, precompute IO-dependent booleans:
- `isLocal` — `row.machine_id === hostname`.
- `isAlive` — `probe.isAlive(row.pid)` (false for `reserved` rows).
- `birthTokenMatches` — `probe.readBirthToken(pid) === expectedToken`.
- `ownsActiveTask`, `legitimateIntegration`, `legitimateFinishing`.

Call `decideStuckAction(input)` → dispatch on the `Action`:

| Action | Mechanism |
|---|---|
| `KEEP` | push kept/remote_unknown result |
| `MARK_SUSPECTED` | stamp `suspected_stuck` + `suspected_stuck_at` (idempotent) |
| `REQUEST_CANCEL` | stamp `cancel_requested` + `cancel_requested_at` |
| `TERMINATE` | `probe.killVerified(pid, token)`; on success `releaseExecutionAtomically(terminal='terminated')` |
| `TERMINATE_BUT_PID_REUSE` | KEEP for a human (never kill a reused PID) |
| `RELEASE` | `releaseExecutionAtomically(terminal='lost'|'spawn_failed'|'terminated')` |

### 6.4 Thresholds (`src/lifecycle/stuck-policy.ts`)

- `RESERVED_BOOT_TIMEOUT_MS` = 60s — reserved execution must acquire a PID.
- `FINISH_GRACE_MS` = 30s — keep while finishing phase activity is fresh.
- `STUCK_SILENCE_MS` = 10 min — no `progress_at` advance → suspected_stuck.
- `STUCK_CANCEL_GRACE_MS` = 5 min — suspected_stuck → cancel_requested.
- `CANCEL_GRACE_MS` = 60s — cancel_requested → terminate (if PID birth verified).
- `PID_REUSE_GRACE_MS` = 10 min — cancel_requested with PID reuse → RELEASE.

`lease_expires_at` (TTL 5 min, `WORKER_LEASE_TTL_MS`): renewed by
`renewLeases` each sweep for local executions that survived reconciliation.

### 6.5 Worker close → `recoverAssignment`

When the spawned claude process closes (`ClaudeBoardRunner.launch` close handler,
line 1218), the runner calls `getTaskState(taskId)` to read the durable
post-close state. If `readAcceptedWorkerDone(executionId)` finds a receipt,
the worker completed. Otherwise:
- Spawn failure → `recoverAssignment({ spawnFailure: true })` →
  `releaseExecutionAtomically(terminal='spawn_failed')` + `pauseForHuman`.
- Process ran but no worker_done → `releaseExecutionAtomically(terminal='lost',
  preserveTaskStatus: true)` → Workplace is in `repair_wait`, retried by
  `ProductionCellNodeExecutor.reconcile()` subject to `cell.recovery.maxAttempts`.

Then `executionStore.markExited(dbPath, executionId, code, state)`.

---

## 7. Scripted executor injection

The factory exposes TWO DI seams on `ProductLifecycleCompositionOverrides`
(`src/app/composition-root.ts` line 55):
- `workerExecutorFactory?: WorkerExecutorFactory`
- `resolveWorkerContext?: (ctx) => WorkerExecutorFactoryContext`

When the composition module exports either, `createFactoryApplication` uses
them instead of the production pinned Claude factory (line 173). Production code
does not know it has been substituted.

### 7.1 `scenario-composition.mjs` — the test composition

`tests/factory-contract/scenario-composition.mjs`. Exports
`createProductLifecycleComposition(context)` which returns:

```js
return {
  workerExecutorFactory: createScriptedWorkerExecutorFactory({
    dispatcherPath: fileURLToPath(new URL('./scenario-dispatcher.mjs', import.meta.url)),
    scenariosPath: env.SAGA_SCENARIOS,
    invocationLogPath: env.SAGA_INVOCATION_LOG,
  }),
  resolveWorkerContext: ctx => ({
    projectId: ctx.projectId,
    epicId: ctx.epicId ?? 0,
    workspaceRoot: cwd,
    dbPath: env.DB_PATH,
    sagaEntry: `${cwd}/dist/index.js`,
    sagaSkillRoot: cwd,
    claudePath: undefined,
    lmStudioUrl: env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1',
  }),
  development: { taskGraphPolicy, settlementPolicy },
  delivery: { preflightPolicy, settlementPolicy, providers: { preflight, actionProviders, observeCurrentCandidateHash } },
};
```

This is wired via `SAGA_PRODUCT_LIFECYCLE_COMPOSITION=<path to this .mjs>` env,
loaded by `orchestrate-cli.ts` `loadCompositionOverrides` (line 540). Only
explicit ports are substituted; factory authority, gates, CandidateSets,
effects, and lifecycle routing remain production.

### 7.2 `scenario-scripted-executor.mjs` — the scripted factory

`tests/factory-contract/scenario-scripted-executor.mjs`. Exports
`createScriptedWorkerExecutorFactory(opts)` returning a `WorkerExecutorFactory`.
Each call returns a `WorkerExecutor` with `start`, `stop`, `status`,
`setConcurrency`, `dispose`.

`start(command)` (line 216):

1. **Capsule replay fast path** (line 229): if `assignment.executionContext.replay.capsule_ref`
   is present, call `runCapsuleReplay(dbPath, assignment, workspaceRoot)` —
   replays the capsule IN-PROCESS through the same MCP handlers
   (`product_submit`, `artifact_create`, `trace_add`, `worker_done`). No child
   process is spawned. This proves zero scripted inference calls on compatible
   replay hits.
2. **Write the MCP config** (line 254): temp JSON with the saga MCP server,
   passing `DB_PATH`, `TRACKER_AUTOSTART=0`, `SAGA_MANAGED_EXECUTION=1`,
   `SAGA_EXECUTION_ID`, `SAGA_TASK_ID`, `SAGA_WORKER_ID` in the child env.
3. **Build the prompt** (line 274): `project_id`, `task_id`, `worker_id`,
   `execution_id`, `role=author`, plus "You are a single-use Saga CLI worker."
4. **Provision the scripted desk** (line 289 `provisionScriptedDesk`): mirrors
   production — creates a per-task git worktree via `RepositoryDeskProvisioner`
   so concurrent workers don't share a checkout. Returns
   `{ executionPath, branch, baseCommit, headCommit, integrationBranch,
   repositoryRoot, detached }` or null for non-git tasks.
5. **Spawn the dispatcher child** (line 306):
   ```js
   spawn('node', [dispatcherPath, '-p', '--bare', '--mcp-config', mcpConfigPath,
     '--strict-mcp-config'], {
     cwd: deskCwd,                              // desk.executionPath or workspaceRoot
     env: {
       ...process.env,
       SAGA_EXECUTION_ID, SAGA_TASK_ID, SAGA_WORKER_ID, SAGA_RUN_ID, SAGA_PROJECT_ID,
       ...(opts.scenariosPath ? { SAGA_SCENARIOS } : {}),
       ...(opts.invocationLogPath ? { SAGA_INVOCATION_LOG } : {}),
       ...deskEnv,                              // SAGA_DESK_* (see below)
     },
     windowsHide: true,
     stdio: ['pipe', 'pipe', 'pipe'],
   });
   ```
6. **Write the prompt to stdin** (line 328).
7. **`markExecutionRunning`** (line 334) with `pid=null`, `processBirthToken=null`
   — the scripted executor does not fence on PID identity the way production
   does (it passes `null` for both).

The `deskEnv` passed to the child (line 295):
```
SAGA_DESK_EXECUTION_PATH  = desk.executionPath
SAGA_DESK_BRANCH          = desk.branch
SAGA_DESK_BASE_COMMIT     = desk.baseCommit
SAGA_DESK_HEAD_COMMIT     = desk.headCommit || ''
SAGA_DESK_INTEGRATION_BRANCH = desk.integrationBranch
SAGA_DESK_REPOSITORY_ROOT = desk.repositoryRoot
SAGA_DESK_DETACHED        = desk.detached ? '1' : '0'
```

On child close (line 371), `finalizeManagedWorkerProcess(openDb(), { taskId,
executionId, exitCode, reason, spawnFailure })` is called — the SAME production
finalizer. It reads the durable `worker_done` receipt to decide semantic
completion (OS exit alone never fabricates semantic completion).

### 7.3 `scenario-dispatcher.mjs` — the scripted worker child

`tests/factory-contract/scenario-dispatcher.mjs`. Receives the worker prompt
via stdin (same as real claude), loads the scenario set from `SAGA_SCENARIOS`,
and dispatches via `runScenarioWorker` (`scenario-engine.mjs`).

`SAGA_DESK_EXECUTION_PATH` / `SAGA_BUTTON_REPO_PATH` resolution (line 79):
```js
const repoPath = process.env.SAGA_DESK_EXECUTION_PATH
  || process.env.SAGA_BUTTON_REPO_PATH
  || '.';
const desk = process.env.SAGA_DESK_EXECUTION_PATH ? {
  executionPath: process.env.SAGA_DESK_EXECUTION_PATH,
  branch: process.env.SAGA_DESK_BRANCH,
  baseCommit: process.env.SAGA_DESK_BASE_COMMIT,
  headCommit: process.env.SAGA_DESK_HEAD_COMMIT || null,
  integrationBranch: process.env.SAGA_DESK_INTEGRATION_BRANCH,
  repositoryRoot: process.env.SAGA_DESK_REPOSITORY_ROOT,
  detached: process.env.SAGA_DESK_DETACHED === '1',
} : null;
```

So `SAGA_DESK_EXECUTION_PATH` is the per-task git worktree path (preferred when
provisioned); `SAGA_BUTTON_REPO_PATH` is the shared repository root fallback.

The scenario engine (`scenario-engine.mjs`) speaks the real MCP stdio protocol:
spawns the saga MCP server from the mcp-config, sends `initialize`,
`notifications/initialized`, then `tools/call` for `task_get`, `product_submit`,
`artifact_create`, `trace_add`, `worker_done`, etc. Scenario handlers are keyed
by `${module}/${node}/${role}/${workKey}` with wildcard fallback.

### 7.4 Capsule replay path (in-process)

Both the production factory and the scripted executor share the same in-process
replay path. When `assignment.executionContext.replay.capsule_ref` is present:

```js
function runCapselectReplay(dbPath, assignment, workspaceRoot) {
  process.env.DB_PATH = dbPath;
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = assignment.workerExecutionId;
  process.env.SAGA_TASK_ID = String(assignment.taskId);
  process.env.SAGA_WORKER_ID = assignment.workerId;
  // mark execution running (no PID — in-process)
  // executeCapsuleReplay(db, handlers, { taskId, workerId, executionId, cwd })
  // handlers.worker_done({ ... })
  // mark execution exited
}
```

This is the ONE replay path — there is no simulator route. The capsule submits
products/artifacts/traces and the recorded git commit, then completes via
`worker_done` so the normal lifecycle advancement and GateRun run exactly as
after a real inference execution.

---

## 8. How to build a better scripted executor

The current scripted executor (`scenario-scripted-executor.mjs`) is a faithful
test double but diverges from production in ways that matter for
production-faithful replay. To build a scripted executor that is
indistinguishable from the real Claude worker from the factory's perspective:

### 8.1 What the current scripted executor already gets right

- Uses the SAME `WorkerExecutorFactory` port — production dispatch code is
  unchanged.
- Uses the SAME `WorkAssignmentPort` (claim + fence happen atomically before
  `start`).
- Uses the SAME `markExecutionRunning` / `finalizeManagedWorkerProcess` lifecycle
  primitives.
- Provisions a per-task git worktree via the SAME `RepositoryDeskProvisioner`.
- Speaks the real MCP stdio protocol through the SAME saga MCP server
  (`dist/index.js`) with the SAME env (`SAGA_MANAGED_EXECUTION`,
  `SAGA_EXECUTION_ID`, `SAGA_TASK_ID`, `SAGA_WORKER_ID`).
- OS exit alone never fabricates semantic completion — the finalizer reads the
  durable `worker_done` receipt.
- Capsule replay runs in-process through the SAME MCP handlers.

### 8.2 What it skips (production gaps)

1. **No `process_birth_token`.** `markExecutionRunning` is called with
   `pid=null, processBirthToken=null`. The reaper's PID-identity verification
   (`verifyProcessBirthToken`) cannot work on scripted workers. For
   production-faithful supervision testing, the scripted executor should capture
   the child PID and call `readProcessBirthToken(pid)` — exactly as
   `ClaudeBoardRunner.launch` does at line 1219.

2. **No structured PostToolUse hook.** Production passes
   `--settings <structured-hook-settings>` and
   `SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64`. The scripted dispatcher omits
   these. A production-faithful scripted worker should replicate the hook
   settings so agent-assistance projections are identical.

3. **No `--allowedTools` / `--disallowedTools` enforcement.** Production
   restricts the tool surface from the frozen `execution_context.authority.
   allowed_saga_tools` + the profile's `allowedToolIds`. The scripted dispatcher
   passes only `-p --bare --mcp-config ... --strict-mcp-config` — no tool
   allowlist. The saga MCP child still enforces `SAGA_EXECUTION_ID`-based
   authority, but the Claude-level tool surface is unrestricted.

4. **No `--bare` ambient-authority stripping beyond what `-p --bare` gives.**
   Production adds `--disable-slash-commands`, `--permission-mode dontAsk`,
   `--output-format stream-json`, `--verbose`, `--forward-subagent-text`,
   `--no-session-persistence`. The scripted dispatcher skips these because it
   is not Claude. This is correct for a non-Claude scripted worker but means
   the spawn args are not byte-identical.

5. **No progress signal.** Production throttles stdout activity to update
   `progress_at` (≤1/30s). The scripted executor pipes stderr to the parent
   but does not update `progress_at` from the child's stdout. A long-running
   scripted worker could be falsely classified as stuck. Fix: subscribe to the
   child's stdout and call `markExecutionProgress(dbPath, executionId)`.

6. **No per-execution MCP config cleanup on crash.** Production's
   `ClaudeBoardRunner` deletes the temp MCP config in the close handler. The
   scripted executor deletes it in `finalize` (line 345) — but only if
   `finalize` is reached. A hard crash leaves the temp file. Minor, but worth
   a `try/finally` around the spawn.

7. **No `recoverAssignment` injection.** Production's factory injects a
   `recoverAssignment` callback that handles spawn-failure vs lost-process
   differently and respects the Workplace `repair_wait` retry budget. The
   scripted executor relies entirely on `finalizeManagedWorkerProcess`. For
   crash-recovery fidelity, the scripted executor should expose the same
   recovery seam (or at minimum, test that
   `finalizeManagedWorkerProcess`'s `workplaceRepairRequested` path is
   exercised).

8. **No lease renewal.** The supervision service renews
   `lease_expires_at` for local executions. The scripted executor's workers
   are typically short-lived, but a long-running scripted scenario could hit
   the 5-min lease TTL. The saga MCP child does not renew its own lease (that
   is the watchman's job), so this is fine for the current harness but worth
   noting.

### 8.3 What a production-faithful scripted executor should add

To be indistinguishable from the factory's perspective:

- **Capture `child.pid` and read the birth token.** Pass them to
  `markExecutionRunning` so the reaper's full PID-identity path is exercised.
- **Subscribe to stdout for `markExecutionProgress`.** So the stuck-policy sees
  healthy activity.
- **Pass the frozen `execution_context` authority through to the scripted
  worker.** The scripted dispatcher should read
  `assignment.executionContext.authority.allowed_saga_tools` and restrict the
  scenario handler's `client.call` surface accordingly (or assert that the
  scenario only calls allowed tools).
- **Honor the RepositoryDesk the same way.** The scripted executor already
  provisions the desk and passes `SAGA_DESK_*` env; the scenario handler
  should commit to `desk.branch` (author) or stay detached (reviewer), exactly
  as the production prompt instructs the Claude worker.
- **Emit the heartbeat events.** Production writes STARTED/CLOSED/FAILED to the
  heartbeat log. The scripted executor could do the same for observability
  parity.

### 8.4 The minimal "scripted MCP worker" for replay

For the narrow goal of replacing the LLM with a script that emits the same MCP
calls, the essential contract is:

1. Read `assignment.executionContext` to know the frozen route, authority, and
   desk.
2. Spawn (or run in-process) a process that:
   - Speaks MCP stdio to the saga server (`dist/index.js`) with
     `SAGA_MANAGED_EXECUTION=1`, `SAGA_EXECUTION_ID`, `SAGA_TASK_ID`,
     `SAGA_WORKER_ID`.
   - Calls `task_get({ id })` to read the assigned task.
   - Performs the work (scenario-driven, replay-driven, or real tool calls).
   - Calls `product_submit` / `artifact_create` / `trace_add` as needed.
   - Calls `worker_done({ task_id, worker_id, result, execution_id })`.
3. Exit 0.
4. The production finalizer (`finalizeManagedWorkerProcess`) sees the durable
   `worker_done` receipt and records semantic completion. No special-casing.

The scripted executor in `scenario-scripted-executor.mjs` is already this, plus
scenario dispatching. The gaps in section 8.2 are about supervision and
authority fidelity, not about the core MCP-call contract.

---

## 9. Quick reference — the full cycle

```
orchestrate-cli main()
  ├── claimFactoryLaunch → ticket
  ├── loadCompositionOverrides → { workerExecutorFactory?, ... }
  ├── createFactoryApplication
  │     ├── SqliteWorkAssignmentAdapter (ONE, with route resolver)
  │     ├── createPinnedClaudeWorkerExecutorFactory (or scripted override)
  │     └── publish lastFactoryWorkAssignment + lastFactoryWorkerExecutorFactory
  ├── startWorkerSupervision (startup sweep + 30s interval)
  └── while (true):
        A. application.runEpisode → { reason: 'paused' | 'completed' | ... }
        B. if not paused: break
        C. distributeQueuedTasks:
             while capacity available and queue not exhausted:
               assignTask (atomic: SELECT + UPDATE + INSERT worker_executions)
               executor.start(assignment):
                 ClaudeBoardRunner.launch:
                   writeExecutionMcpConfig (SAGA_EXECUTION_ID in child env)
                   resolveProfile + resolveLaunchSpec + prepareWorkspace
                   provisionRepositoryDesk (git worktree)
                   buildPrompt (inline skills + workspace)
                   spawn claude -p --bare ... --mcp-config ... --strict-mcp-config
                   markExecutionRunning(pid, birthToken)
               waitForAssignedWorker (poll status until terminal)
        D. if dispatched === 0:
             on-demand supervision sweep
             if active executions > 0: sleep, continue
             classify idle state:
               humanPaused → break
               kernelProgress → continue (no streak)
               other → streak++; if streak >= 3: break
        reset streak
  ├── finishFactoryLaunch
  └── process.exit
```

The worker (Claude or scripted) speaks MCP to the saga server, calls `worker_done`
exactly once, and exits. The finalizer reads the durable receipt. The next
`runEpisode` advances the lifecycle. Repeat until terminal.
