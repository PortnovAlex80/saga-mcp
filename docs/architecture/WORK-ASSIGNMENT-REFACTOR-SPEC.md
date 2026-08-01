# Work Assignment Refactor Specification

> Transforms the architectural audit (`CONVEYOR-MENTAL-MODEL.md` gap analysis)
> into an executable refactoring plan: target contracts, file inventory,
> migration waves, acceptance criteria, test matrix, and cutover order.
>
> **Status of the codebase (branch `saga4`, HEAD `ac3ed7f`):** the refactor is
> ~40 % done. TS-side `allowedTools` already omit `worker_next`; `dispatch-loop`
> already passes `claimScope.taskIds=[taskId]`; worker spawn already forbids
> `worker_next`. The remaining gap is the **physics**: the atomic claim + fence
> still happens *inside* the runner's `pump()` → `worker_next`, not *before*
> `executor.start()`. This spec closes that gap and the surrounding defects.

---

## 1. Root cause (one paragraph)

The infrastructure *suggests* a candidate card (`claimScope.taskIds=[id]`) but
does not *assign* it. The real atomic claim + fence creation lives in
`findNextClaimable` (`src/tools/dispatcher.ts:342`), invoked from inside
`runner.pump()` (`tracker-view/claude-runner.mjs:602`) **after** `start()`
returns. Meanwhile `readClaimableTasks` (`src/app/dispatch-loop.ts:50`) — the
preselector that decides which candidates to spawn workers for — diverges from
`findNextClaimable`: it omits the dependency check, the `current_execution_id`
fence check, the `process_run_id` authority gate, the conflict-key serialization,
and even orders priority in the **opposite** direction. Under two concurrent
dispatcher processes this opens a race window; under one process it produces
wasted worker spawns for cards that turn out to be unclaimable. The fix is to
make assignment a first-class infrastructure operation that happens before
spawn, in a single transaction, returning a typed `AssignedWork` the worker
receives read-only.

---

## 2. Target contracts

### 2.1 `AssignedWork` (the card the worker receives)

```ts
/** Immutable snapshot of a card assigned to one worker execution. Built by
 *  the infrastructure BEFORE the worker process is spawned. The worker reads
 *  this; it never searches the queue. */
interface AssignedWork {
  taskId: number;
  epicId: number;
  projectId: number;
  status: 'in_progress' | 'review_in_progress';   // post-assignment status
  skill: string;                                     // execution/review skill
  workerExecutionId: string;                         // = fence token
  fenceToken: string;                                // stamped on tasks.current_execution_id
  runId: string;
  workerId: string;
  machineId: string;
  repository: { id; repository_id; name; local_path; role; integration_branch; default_branch } | null;
  executionContext: unknown;                         // frozen model route + authority
}
```

### 2.2 `WorkAssignmentPort` (the infrastructure port)

```ts
interface WorkAssignmentPort {
  /** Atomically: (1) select one claimable card matching the scope, (2) verify
   *  dependencies + authority + conflict-keys + fence-free, (3) flip status
   *  (todo→in_progress | review→review_in_progress), (4) set assigned_to +
   *  current_execution_id, (5) INSERT worker_executions row with frozen
   *  execution_context. All in ONE IMMEDIATE transaction. Returns null if no
   *  card is claimable. Throws on fence/authority violation. */
  assignTask(input: AssignTaskInput): AssignedWork | null;

  /** Release a card back to the queue if the worker never started (spawn
   *  failure). Idempotent. */
  releaseAssignment(input: { taskId; workerExecutionId; reason }): void;
}

interface AssignTaskInput {
  projectId: number;
  epicId?: number;
  workerId: string;
  workerExecutionId: string;   // caller-generated fence token
  runId: string;
  machineId: string;
  taskIds?: number[];          // scope restrict (one specific card)
  role?: string;               // tag filter (requirements project)
}
```

**Transaction invariant:** `assignTask` runs the EXISTING `findNextClaimable`
SELECT + conditional UPDATE + `worker_executions` INSERT inside a single
`BEGIN IMMEDIATE … COMMIT`. This is the same SQL that is proven correct by
`tests/dispatcher-race/run.mjs` — we extract it, not rewrite it.

### 2.3 `WorkerExecutorStart` (extended)

```ts
interface WorkerExecutorStart {
  projectId: number;
  epicId?: number | null;
  concurrency: number;
  /** Pre-assigned card. When present, the runner SKIPS claimTask and launches
   *  the worker directly on this card. When absent (legacy/MCP-direct path),
   *  the runner falls back to claimScope + internal claim. */
  assignment?: AssignedWork;
  /** Legacy claim scope (MCP-direct workers that still self-claim). */
  claimScope?: { taskIds?: number[] };
}
```

---

## 3. File inventory

### Changed (core — single-writer hot files)

| File | Change |
|---|---|
| `src/application/ports/worker-executor.ts` | Add `AssignedWork`, `WorkAssignmentPort`, `AssignTaskInput` types; extend `WorkerExecutorStart.assignment`. |
| `src/app/dispatch-loop.ts` | Replace `readClaimableTasks` + `claimScope` with `assignTask()` per card before `executor.start({assignment})`. Add concurrency semaphore. |
| `src/process-modules/application/node-executors/lm-node-executor.ts` | Call `assignTask()` before `workerExecutor.start({assignment})` (line ~549). |
| `tracker-view/claude-runner.mjs` | `pump()`: if `run.assignment` present, skip `claimTask`, go straight to `launch`. `start()`: accept + store `assignment`. |
| `src/infrastructure/workers/legacy-claude-worker-executor-factory.ts` | Thread `assignment` through; when pre-assigned, `prepareWorkspace` uses `assignment` directly. |

### New

| File | Purpose |
|---|---|
| `src/infrastructure/work/sqlite-work-assignment-adapter.ts` | SQLite impl of `WorkAssignmentPort`. Extracts `findNextClaimable` atomic logic from `dispatcher.ts` into a reusable, injectable adapter. |
| `tests/architecture/work-assignment-contract.test.mjs` | Contract test: assignTask atomicity, dependency exclusion, review-first, fence creation, double-assign rejection. |
| `tests/architecture/dispatcher-concurrent-assign.test.mjs` | Two-process race: both call assignTask, exactly one wins. |

### Updated (mechanical — parallelizable)

| File | Change |
|---|---|
| 6 worker SKILL.md files (saga-worker, saga-product, saga-analyst, saga-architect, saga-verifier, + specialists) | Remove "call worker_next to claim" instructions; replace with "your card is pre-assigned, read it via task_get". |
| `tests/architecture/dependency-direction.test.mjs` | Fix 3 stale entries (rename `sqlite-development-runtime`→`sqlite-development-settlement-state`); resolve 3 new entries. |
| `tests/architecture/saga2-boundaries.test.mjs` | Fix 3 env-drift failures (Windows temp dir; stale hand-built schema missing `lifecycle_execution_controls`). |
| `package.json` | `test:architecture` → include `dependency-direction.test.mjs` + `cutover-architecture-checks.test.mjs`. Add `test:dispatcher-race`. |
| `.github/workflows/ci.yml` | Add `saga4` to branch triggers. |

---

## 4. Waves

### Wave A — `WorkAssignmentPort` + SQLite adapter (SERIAL, core)

**Precondition:** none.
**Files:** `worker-executor.ts` (types), `sqlite-work-assignment-adapter.ts` (new).
**What:** Define `AssignedWork` / `WorkAssignmentPort` / `AssignTaskInput`. Extract
the atomic claim logic (SELECT + conditional UPDATE + INSERT worker_executions)
from `findNextClaimable` into `SqliteWorkAssignmentAdapter.assignTask()`, running
under `withImmediateTransaction`. The existing `worker_next` handler delegates to
the same adapter (single code path, no duplication).
**Acceptance:**
- `assignTask` is one transaction (BEGIN IMMEDIATE … COMMIT).
- Returns `AssignedWork | null`; null when no card claimable.
- SELECT includes ALL gates from `findNextClaimable`: status, unassigned, project/epic, `process_run_id IS NOT NULL`, `current_execution_id IS NULL`, no active worker_executions, no open human_requests, dependencies done+merged, conflict-key serialization.
- ORDER BY review-first → priority ASC → created_at.
- INSERT worker_executions with frozen execution_context + hash.
- `worker_next` still works unchanged (delegates to adapter).

### Wave B — Wire assignment before spawn (SERIAL, depends on A)

**Precondition:** Wave A.
**Files:** `dispatch-loop.ts`, `lm-node-executor.ts`, `claude-runner.mjs`, `legacy-claude-worker-executor-factory.ts`, `claude-board-worker-executor.ts`.
**What:** dispatch-loop generates `workerExecutionId` (fence token) + `workerId`,
calls `assignTask()`, and on success passes `assignment` to `executor.start()`.
Runner `pump()` skips `claimTask` when `assignment` is present. LM node executor
does the same. On spawn failure, `releaseAssignment()` returns the card.
**Acceptance (the dispatch contract):**
1. Card is assigned (status flipped + fence set) BEFORE `executor.start()` returns.
2. Worker process launches with `SAGA_TASK_ID` + `SAGA_EXECUTION_ID` from the assignment — no in-process claim.
3. Two dispatcher processes calling `assignTask` for overlapping scopes never get the same card.
4. `review` always chosen before `todo`.
5. Card with unmet dependencies is never assigned.
6. Spawn failure calls `releaseAssignment` → card returns to `todo`/`review`.
7. `worker_next` MCP tool still works for requirements-project role-based agents (legacy path, `claimScope` fallback).

### Wave C — Concurrency coordination (depends on B)

**Precondition:** Wave B.
**Files:** `dispatch-loop.ts`.
**What:** Replace the sequential `for` loop with a bounded-concurrency scheduler:
at most `N` workers in-flight simultaneously; when one finishes, the next
assigned card launches. Uses `Promise`-based tracking of in-flight runs.
**Acceptance:**
- At most N worker executions active simultaneously.
- No wasted spawn attempts for unclaimable cards (assignment fails fast → skip).

### Wave D — Skills alignment (PARALLEL, independent)

**Precondition:** none (mechanical).
**Files:** 6 SKILL.md files listed in §3.
**What:** Replace "call `worker_next({worker_id, project_id})` to claim" with
"your card is pre-assigned by the dispatcher; read it via `task_get({id: <SAGA_TASK_ID>})`;
do NOT call `worker_next`." Aligns instructions with the already-disabled tool.
**Acceptance:** No worker SKILL.md instructs calling `worker_next`. grep clean.

### Wave E — Architecture tests + CI gates (PARALLEL, independent)

**Precondition:** none.
**Files:** `dependency-direction.test.mjs`, `saga2-boundaries.test.mjs`, `package.json`, `ci.yml`.
**What:** Fix ratchet (3 stale → renamed, 3 new → resolved or allowlisted with
debt reason). Fix saga2-boundaries env drift. Make `test:architecture` run ALL
architecture tests. Add `saga4` to CI. Wire `tests/dispatcher-race/*` into a
`test:dispatcher-race` script.
**Acceptance:**
- `npm run test:architecture` exits 0.
- dependency-direction ratchet: 0 new, 0 stale.
- `saga2-boundaries`: 18/18 pass.
- CI triggers on `saga4`.

### Wave F — Module hex boundary extraction (PARALLEL, large, follow-on)

**Precondition:** Wave E (ratchet green to establish baseline).
**What:** Move `getDb` / `Sqlite*` / `child_process` / `os` imports out of
`modules/{development,delivery,formalization}` behind injected ports. Shrink the
allowlist toward zero. This is the largest wave; scoped per-module.
**Acceptance:** No `getDb`/`Sqlite*`/`WorkerExecutorFactory` import inside `modules/*`
(except installation wiring which is the composition root).

### Wave G — Legacy path removal (depends on B + D)

**Precondition:** Waves B + D.
**What:** After all worker paths use pre-assigned cards, remove the `claimScope`
fallback in the runner and the `taskIds` threading. Keep `worker_next` as an MCP
tool only for the requirements-project role-based path until that migrates too.

---

## 5. Test matrix

| Invariant | Test | Wave |
|---|---|---|
| assignTask is atomic (one tx) | `work-assignment-contract.test.mjs` | A |
| Two dispatchers never get same card | `dispatcher-concurrent-assign.test.mjs` + `tests/dispatcher-race/run.mjs` | A/B |
| review chosen before todo | `work-assignment-contract.test.mjs` | A |
| unmet deps exclude assignment | `work-assignment-contract.test.mjs` | A |
| double-assign rejected (fence) | `work-assignment-contract.test.mjs` | A |
| card assigned before spawn | integration assert in dispatch-loop | B |
| spawn failure releases card | `work-assignment-contract.test.mjs` | B |
| recovery worker gets same card + workspace | `node-durable-identity.test.mjs` (existing, must stay green) | B |
| worker has no worker_next in allowedTools | existing profile tests | D |
| no SKILL.md instructs worker_next | grep assertion | D |
| ratchet 0-new 0-stale | `dependency-direction.test.mjs` | E |
| architecture suite green | `npm run test:architecture` | E |
| at most N concurrent | `dispatch-concurrency.test.mjs` | C |

---

## 6. Compatibility & cutover

- **Backward compatible:** `worker_next` MCP tool remains for requirements-project
  role-based agents and any external caller. It delegates to the same adapter.
- **Feature flag:** the runner supports BOTH `assignment` (new) and `claimScope`
  (legacy) on `WorkerExecutorStart`. Wave G removes the legacy path once all
  callers migrate.
- **No schema migration:** all changes use existing tables (`tasks`,
  `worker_executions`). No new columns.
- **Cutover order:** A → B → C (serial core); D, E (parallel mechanical);
  F (follow-on per-module); G (final removal after D+B verified in production).

---

## 7. Execution plan for this session

1. **Now:** launch Wave D (skills) + Wave E (arch tests/CI) as parallel subagents
   — they are independent and mechanical.
2. **Then:** I implement Wave A → B → C myself (single-writer hot files, the
   architectural keystone).
3. **Defer:** Wave F (large hex extraction) and G (legacy removal) to follow-on
   sessions, with this spec as the contract.
