# ADR-013: Lifecycle fix execution plan (post-audit)

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** —
- **Superseded by:** —
- **Implements:** ADR-010 (passive worker command kernel), ADR-011 (work items)
- **Decision-maker:** code audit review

## Context

ADR-010 and ADR-011 were Proposed 2026-07-18, but a fresh code audit (2026-07-19)
against `D:\Development\saga-mcp` HEAD `119fd43` confirms the lifecycle kernel
they describe is **not wired into the production path**. The new isolated modules
(`src/lifecycle/**`, `src/lifecycle/domain/**`) are imported only by tests and
`backfill-migration.ts`. All runtime transitions still happen through direct
`UPDATE tasks` in `src/tools/dispatcher.ts` (15 occurrences) and through two
separate terminalization paths in `src/worker-executions.ts`.

The audit's claim of "282/282 tests green" is also stale: the current head runs
**308 pass / 0 fail** but with intermittent flakes on `track-pipeline.test.mjs:233`
(observed once in three full runs) — a symptom of the same ASK-protocol race
the audit describes.

This document is the **execution plan** that turns ADR-010/011 from isolated
modules into the production state machine. It is prioritised by operator-visible
symptoms (stuck agents, dropped episodes, latency), not by aesthetic code
cleanliness. Phase 1 is cheap targeted fixes that remove ~80% of the reported
pain in 1–2 days. Phase 4 is the long ADR-010/011 migration.

### Verified defects (each confirmed against code at HEAD)

| Defect | Code evidence | Symptom |
|---|---|---|
| `handleWorkerAskNeed` not in a transaction | `dispatcher.ts:794` — order: comment → release → UPDATE tags → INSERT human_requests, **no `withImmediateTransaction` wrapper** (unlike `completeTask:730`) | "agents not created": needs-human tag without blocking request, or request without tag |
| `generateNextForCompletedTask` after COMMIT | `dispatcher.ts:730` tx commit, `dispatcher.ts:739` generate **outside tx** | "episode stuck after first task": crash window loses downstream forever |
| Global write-lock on every lifecycle op | `withImmediateTransaction` (`dispatcher.ts:46-62`) = `BEGIN IMMEDIATE` = whole-DB write lock | "slow with parallel workers": writers serialize on a single lock |
| Three terminalization paths with different effects | `markExecutionExited:109`, `markExecutionSpawnFailed:92` (own SQL + own tx) vs `reconcileWorkerExecutions:274,318` (delegates to `releaseExecutionAtomically`). Comment `atomic-release.ts:16` claims "all three callers delegate" — false | "execution not stopped": fenced task with dead execution row |
| Architecture test is a whitelist, not a boundary | `architecture.test.mjs:131` — `SANCTIONED` set of 13 files; `architecture.test.mjs:239` — `existsSync` presence check | "false sense of single-writer" |
| Lifecycle kernel not called from production | `grep "from.*lifecycle/domain" src/` → 0 hits in production code; `task_work_items` diverges from `tasks` after first runtime transition | root architectural debt |

## Decision

Four phases, executed in order. Phases 1, 2, 3 may run in parallel by different
workers (they touch disjoint files). Phase 4 is strictly sequential, single
worker, small steps.

```
1.1 (ASK tx)        ──► 1.3 (flaky stab)
1.2 (outbox)        ──►
2.1 (repo locks)    (independent)
3.1 (term unify)    (independent)
3.2 (boundary test) (independent, stage-gated by 4.1)
4.1 (command bus)   ──► 4.2 (integration executor) ──► 4.3 (delete old machine)
```

## Phase 1 — Targeted fixes (1–2 days)

### 1.1 — Wrap `handleWorkerAskNeed` in atomic transaction

**Problem.** `dispatcher.ts:794` runs four separate writes with no tx wrapper:
comment → `releaseExecutionAtomically` → `UPDATE tags` → `INSERT human_requests`.

**Fix.**
1. Wrap the entire handler body in `withImmediateTransaction(db, () => { ... })`
   (mirror `completeTask` at `dispatcher.ts:730`).
2. Reorder: `INSERT human_requests` (creates blocking request) **before**
   `releaseExecutionAtomically`. If release fails, request already exists and
   the task is correctly blocked — not the reverse.
3. `handleWorkerAskDone` (`dispatcher.ts:904`): wrap in tx; check
   `info.changes === 1` on the `UPDATE ... WHERE state='open'`. Two concurrent
   answers must not both return `state='answered'`.

**Acceptance criteria.**
- AC-1: at any crash point inside `handleWorkerAskNeed`, either all four side
  effects commit or none do.
- AC-2: no state "needs-human tag set, human_requests row missing".
- AC-3: no state "execution released, task still assigned".
- AC-4: two concurrent `worker_ask_done` — exactly one returns `answered`, the
  other returns `already_answered`.

**Tests.** Extend `tests/lifecycle/ask-protocol.test.mjs` with crash-injection
at each intra-handler point and a concurrent-`worker_ask_done` test.

### 1.2 — Move `generateNextForCompletedTask` into durable outbox

**Problem.** `dispatcher.ts:730` commits receipt; `dispatcher.ts:739` runs
`generateNextForCompletedTask` outside the tx. Crash between → downstream lost
forever, replay returns receipt without `workflow_generation`
(byte-equivalent replay invariant violated).

**Fix.**
1. New table `outbox_intents (intent_key TEXT PRIMARY KEY, command_kind, payload_json, state, created_at, processed_at, result_json)` in `src/schema.ts`.
2. Inside `completeTask` (same tx as receipt): `INSERT INTO outbox_intents
   (intent_key='gen-${taskId}', state='pending', ...)`.
3. In-process consumer after COMMIT: picks `state='pending'`, calls
   `generateNextForCompletedTask`, marks `state='done'` with result.
4. Replay path: `worker_done` with same `commandId` reads `workflow_generation`
   from `outbox_intents.result_json`, not from a local variable.

**Acceptance criteria.**
- AC-1: crash after COMMIT-receipt, before outbox processed → on restart,
  `outbox_intents.state='pending'` is picked up, downstream created.
- AC-2: replay `worker_done` with same `commandId` → byte-identical reply
  including `workflow_generation`.
- AC-3: idempotent — re-processing the same `intent_key` does not double-create.

**Tests.** New `tests/lifecycle/outbox-recovery.test.mjs`. Extend idempotency
test for byte-equal replay.

### 1.3 — Stabilise flaky `track-pipeline.test.mjs:233`

**Problem.** Observed flake: `decision='clarify' should set needs-human=true
(got null)`. Likely downstream of 1.1's ASK race.

**Fix.** After 1.1 lands, run the suite 10×. If still flaky — investigate the
test fixture (`tests/mock-claude.mjs`) and timing. **No `sleep`/`retry` fixes.**

**Acceptance criteria.**
- AC-1: 10 consecutive runs of `node --test tests/lifecycle/track-pipeline.test.mjs` → 10 green.

## Phase 2 — Lock contention (3–5 days)

### 2.1 — Repository-scoped advisory lock instead of global `BEGIN IMMEDIATE`

**Problem.** `withImmediateTransaction` (`dispatcher.ts:46-62`) is a whole-DB
write lock acquired on every `worker_next`/`worker_done`/`ask`/`merge`. It has
4 production call sites in `dispatcher.ts` (`:437`, `:730`, `:1026`, `:1129`).

**Fix.**
1. Saga is single-process (better-sqlite3 in-process) → in-process advisory lock
   via `Map<repoId, Promise<void>>` is sufficient.
2. New `src/lifecycle/repository-lock.ts` — `withRepositoryLock(repoId, fn)`.
3. Repo-scoped ops (claim, merge, generate-for-task) take advisory lock by
   `project_repository_id`. Global ops (episode_transition, reconciler) keep
   `BEGIN IMMEDIATE`.

**Acceptance criteria.**
- AC-1: 2 workers in **different** repos, parallel `worker_next` — both finish
  <50ms (currently serialized).
- AC-2: 2 workers in **same** repo — serialized (correctness preserved).
- AC-3: zero deadlocks across 100 concurrency-test runs.

**Tests.** Extend `tests/lifecycle/concurrency-transition.test.mjs` with
latency measurement across 3 workers × 2 repos.

## Phase 3 — Terminalization unification (1–2 days)

### 3.1 — Collapse three terminalization paths into one

**Problem.** `markExecutionExited` (`worker-executions.ts:109`, own UPDATE at
`:119`) and `markExecutionSpawnFailed:92` (own UPDATE at `:100`) carry their
own SQL and own tx, while `reconcileWorkerExecutions:274,318` delegates to
`releaseExecutionAtomically`. Comment `atomic-release.ts:16` claims all three
delegate — false. Verified: `grep "UPDATE worker_executions.*SET state=" src/`
returns hits in both `atomic-release.ts` AND `worker-executions.ts`.

**Fix.**
1. Audit: `grep -rn "markExecutionExited\|markExecutionSpawnFailed" src/`.
2. Either delete (if unused) or reduce to 3-line wrappers calling
   `releaseExecutionAtomically` with the right `terminalState`.
3. Update the `atomic-release.ts:14-34` header comment to match reality.

**Acceptance criteria.**
- AC-1: `grep -rn "UPDATE worker_executions.*SET state=" src/` → only
  `src/lifecycle/atomic-release.ts`.
- AC-2: regression test for each terminal state (`exited`, `terminated`,
  `spawn_failed`, `lost`) passes.

### 3.2 — Architecture-boundary test instead of whitelist

**Problem.** `architecture.test.mjs:131` — `SANCTIONED` set of 13 files is a
whitelist (logic at `:155-164`: `if (SANCTIONED.has(rel)) continue;`), not a
boundary. `architecture.test.mjs:239` and `:256` use `existsSync`.

**Fix.**
1. Invert: lifecycle `UPDATE` is allowed **only** in `src/lifecycle/**`. Any
   such SQL in `src/tools/**`, `src/orchestrate.ts` → test fails with file:line.
2. **Stage-gate:** accept this only after 4.1. Before that, temporarily allow
   `src/tools/dispatcher.ts` with `// TODO(4.1): remove after command bus wired`.
3. Replace `existsSync` presence checks with structural import-usage checks
   where feasible, or mark as "structural guard only".

**Acceptance criteria.**
- AC-1: `architecture.test.mjs` inverts to blacklist with documented exceptions.
- AC-2: every exception carries a `TODO(phase)` tag.

## Phase 4 — P0: lifecycle kernel into production path (1–2 weeks)

**Do not start until 1.x and 2.1 land.** Otherwise you will rewrite against
a moving base.

### 4.1 — Application service / command bus

**Problem.** `grep "from.*lifecycle/domain" src/` → 0 hits anywhere (production
or test). 15 direct `UPDATE tasks` live in `dispatcher.ts`.

**Fix.**
1. Create `src/lifecycle/application-service.ts`: `handleCommand(db, cmd) →
   {events, effects, reply}`.
2. Single `withImmediateTransaction`: `decode` → `decide` (pure) →
   `appendEvents` → `project` (via `compatibility-projector` +
   `WorkItemRepository`) → `storeReceipt` → `writeOutbox`.
3. MCP handlers (`worker_next`, `worker_done`, `ask`, `merge`) become thin
   adapters: parse args → `handleCommand` → return reply.
4. After wiring: `task_work_items` becomes primary, `tasks` is a projection.
   `backfill-migration` runs once.

**Acceptance criteria.**
- AC-1: `grep "UPDATE tasks SET (status|assigned_to|integration_state)" src/tools/` → 0.
- AC-2: `grep "from.*lifecycle/(domain|application-service)" src/tools/` → all
  MCP handlers.
- AC-3: `track-pipeline.test.mjs` runs **through** the application service.
- AC-4: replay of any command with same `commandId` → byte-identical reply.

**Tests.** Property-based: for any command sequence, projection is consistent
with events. Migration test for `backfill-migration`.

### 4.2 — Integration executor into the working cycle

**Problem.** `observeRepository`/`performMerge`
(`integration-executor.ts:189,254`) live only in tests. Production merge is
`worker_merge_acquire/release` in `dispatcher.ts:638`.

**Fix.**
1. `worker_merge_acquire/release` → call application service, which inserts
   `integration_intents` + outbox entry.
2. Consumer loop picks `integration_intents WHERE state='pending'` by lease,
   calls `performMerge` (Git CAS), sends lifecycle command `MergeCompleted` /
   `MergeFailed`.
3. Worker becomes passive: reports merge result, does not perform it.

**Acceptance criteria.**
- AC-1: `grep "performMerge" src/` → called from consumer, not MCP handler.
- AC-2: crash mid-merge → lease expires, another consumer picks up the intent.
- AC-3: merge conflict → `integration_intents.state='conflict'`, task
  needs-human (already implemented upstream of this fix).

### 4.3 — Delete the old state machine

**Problem.** After 4.1+4.2, `dispatcher.ts` retains dead direct-mutation code.

**Fix.**
1. Remove every direct `UPDATE tasks` from `dispatcher.ts`.
2. Target: `dispatcher.ts` shrinks from 1524 lines to ~200-300 (thin adapter).
3. Mark `backfill-migration.ts` as one-shot (`// TODO: drop after vN+1`).
4. 3.2 architecture test is now fully green with no `TODO` exceptions.

**Acceptance criteria.**
- AC-1: `wc -l src/tools/dispatcher.ts` → <400.
- AC-2: `architecture.test.mjs` green with no `TODO(4.1)` exceptions.
- AC-3: all E2E tests run through the application service.

## Universal checklist (every phase, every task)

### Pre-flight
- [ ] Read `GUARDRAILS.md` and `INVARIANTS.md` in saga-mcp.
- [ ] Read existing ADRs 009, 010, 011, 012.
- [ ] Read this plan — know which phase/subtask this is.
- [ ] Read `src/lifecycle/atomic-release.ts` — understand fence-CAS invariants.
- [ ] Check for parallel work via `conflict_check` if available.
- [ ] Worktree clean before start (`git status` empty).

### Implementation
- [ ] Every lifecycle mutation wrapped in `withImmediateTransaction` (or
      `withRepositoryLock` for repo-scoped after 2.1).
- [ ] No direct `UPDATE tasks / lifecycle tables` outside `src/lifecycle/**`
      (strictly enforced after 4.1).
- [ ] `lifecycle_events` row appended for audit trail.
- [ ] Idempotency: `commandId` unique, replay → same reply.
- [ ] Crash-safety: considered crash at **every** intra-handler point. No
      partial-state window.
- [ ] No `expect()` / `unwrap()` equivalents in library code (AGENTS.md).
- [ ] No new dependency without a saga tracker task (AGENTS.md).

### Testing
- [ ] New unit test for the new behaviour.
- [ ] Regression test for the invariant.
- [ ] `npm test` locally green (308+).
- [ ] 10 runs of flaky-suspect tests (track-pipeline, concurrency) — stable green.
- [ ] Boundary/architecture test added if the layer boundary changes.

### Completion (`worker_done`)
- [ ] Worktree clean — **no** `probe-*.mjs`, `.tmp` files, or other debris.
- [ ] `git status` shows only meaningful changes.
- [ ] `CHANGELOG.md` updated.
- [ ] If public API changes — `README.md` / ADR updated.
- [ ] If contract changes — saga artifact updated (status → accepted).
- [ ] `worker_done` verdict is honest: not "looks done", but "npm test green,
      AC met, checklist complete".
- [ ] Task comment lists concrete files/lines changed and test names added.

## Definition of Done — whole epic

- [ ] `npm test` stable green across **10** consecutive runs (was flaky).
- [ ] Simulation: 5 parallel workers across 3 repos → 0 zombies, 0 stuck
      tasks, claim latency <100ms.
- [ ] Crash injection: `kill -9` at a random point → system recovers, outbox
      drains.
- [ ] `grep "UPDATE tasks SET (status|assigned_to)" src/tools/` → **0**.
- [ ] `grep "UPDATE worker_executions.*SET state=" src/` → only
      `atomic-release.ts`.
- [ ] `architecture.test.mjs` inverted and green with no `TODO` exceptions.
- [ ] `wc -l src/tools/dispatcher.ts` → <400 (currently 1524).
- [ ] Replay of any `worker_done`/`ask`/`merge` with same `commandId` →
      byte-identical reply.
- [ ] `task_work_items` consistent with `tasks` after any command (property test).

## Consequences

- **Positive.** Phases 1-3 remove operator-visible pain (stuck agents, dropped
  episodes, latency) within days, without the risk of a big-bang rewrite.
  Phase 4 retires the parallel state machine ADR-010/011 describe.
- **Negative.** Phase 4 is a 1-2 week single-worker effort with high regression
  risk; must be done in small steps with green tests after each handler migration.
- **Neutral.** The architecture-boundary test (3.2) will be red until 4.1 lands.
  This is intentional — it tracks the remaining migration surface.
