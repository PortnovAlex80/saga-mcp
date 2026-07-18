# ADR-009: Durable worker executions and canonical verification targets

## Status

Accepted (2026-07-18)

## Context

Claude CLI verification workers routinely spend 3–7 minutes reading frozen
contracts and running cargo/vitest without producing log output. The
orchestrator treated roughly 180 seconds of log silence as death, released the
task holder, and let another process claim the same task. The old process then
failed its holder check and became an orphan.

The verification model had two related defects:

- a `verification.ac` task did not store the AC it owned;
- `verification_record(passed)` accepted any AC and derived a `verified_by`
  edge from that call;
- evidence uniqueness was effectively task/AC/revision-wide, so a later holder
  could not append a new attempt after the original holder died.

Task lifecycle state and OS process lifecycle are different state machines.
`tasks.status` cannot be the source of truth for whether a process exists.

This is a Complicated decision under the Cynefin triage: the failure is
reproducible, but the repair crosses dispatcher, process, schema, migration,
verification, and UI boundaries.

## Decision drivers

- Correctness under concurrent claim, close, recovery, and PID reuse.
- Recovery and observability independent of task status.
- Compatibility with the existing two-phase development/review workflow.
- Testability with deterministic SQLite transitions.
- Reversibility through one schema/code commit.

## Considered options

### A. Add fields only to `tasks`

Store the current PID and verification target directly on a task.

This is the smallest delta, but it still conflates process history with the
current task snapshot and cannot fence a late response from an older process.

### B. Durable execution registry plus fencing token

Create `worker_executions`, reserve one execution atomically with the task
claim, register PID plus process-birth identity after spawn, and require the
execution ID on worker mutations. Keep a canonical
`verification_target_artifact_id` on verification tasks.

### C. Renewable time leases

Give every worker a short lease and require periodic heartbeats.

This can support remote machines, but heartbeat failure is still ambiguous
during local tool execution and introduces timing sensitivity into every
worker action.

## MCDA

Scores are 1–5; weighted totals are out of 500.

| Criterion | Weight | A: task fields | B: registry + fence | C: leases |
|---|---:|---:|---:|---:|
| Correctness | 30 | 3 | 5 | 4 |
| Recovery/observability | 20 | 3 | 5 | 4 |
| Workflow alignment | 15 | 4 | 5 | 3 |
| Implementation risk | 15 | 4 | 4 | 2 |
| Testability | 10 | 4 | 4 | 3 |
| Reversibility | 10 | 4 | 4 | 3 |
| **Weighted total** | **100** | **350** | **455** | **365** |

## Red Team

The strongest objection to option B is that a registry without fencing merely
adds another stale table. A late worker could still call `worker_done`, PID
reuse could target an unrelated process, and task/registry state could drift.

The objection is accepted. Option B is valid only with all of these controls:

- task claim and execution reservation occur in the same immediate
  transaction;
- `tasks.current_execution_id` fences all managed worker mutations;
- active execution uniqueness is enforced for task and worker;
- process termination requires matching host, PID, and process-birth token;
- recovery clears a task only with an exact execution-ID compare-and-swap;
- the UI reads process rows and presents task status as separate data.

## Decision

Adopt option B.

1. `worker_next` may reserve a caller-provided execution ID atomically with the
   task claim. The board runner always uses this managed path and scopes engine
   claims to its epic.
2. A spawned process moves its registry row from `reserved` to `running` and
   records host, PID, birth token, log path, and phase.
3. `worker_done`, `verification_record`, ask, and merge mutations require the
   current execution fence for managed tasks. Legacy manual callers remain
   compatible when a task has no fence.
4. Reconciliation treats log output as telemetry only. A local process is live
   by OS PID; termination additionally requires the recorded birth identity.
   Dead executions restore `in_progress -> todo` and
   `review_in_progress -> review` with an exact fenced update.
5. A `verification.ac` task owns exactly one accepted AC through
   `verification_target_artifact_id`. Planning provenance (`depends_on`) is the
   migration source; `verified_by` remains derived output.
6. `verification_record` rejects cross-AC evidence. Evidence is immutable per
   execution attempt, allowing a later holder to append a retry.
7. Approval checks passing evidence only for the canonical AC revision, not
   every historical `verified_by` edge.
8. Startup migration backfills canonical targets from unambiguous provenance.
   For pre-provenance boards only, it may use one unambiguous, token-bounded
   AC-code match in the task title. It never guesses between multiple matches.
   The migration then deletes mismatched legacy `verified_by` edges while
   retaining evidence rows for audit.

## Pre-mortem

Assume this failed after six months:

1. **Task and registry drift.** A crash occurred after only one side changed.
   Mitigation: atomic claim/reservation and exact fenced recovery.
2. **PID reuse killed unrelated work.** Mitigation: host and process-birth
   identity are mandatory before a managed process is registered or killed.
3. **A reserved row blocked work forever after spawn failure.** Mitigation:
   spawn failures become terminal immediately; unstarted reservations expire.
4. **A legitimate merger was killed after task status became done.**
   Mitigation: explicit `integrating` phase permits `done + pending`.
5. **Old verification data kept the board blocked.** Mitigation: target
   backfill, derived-trace repair, and a gate based on canonical evidence.
6. **Remote machine died permanently.** Current reconciliation cannot prove a
   remote PID dead. A future machine-heartbeat lease is required before
   multi-host orchestration is enabled.

## Consequences

Positive:

- long silent cargo/vitest work is no longer released;
- stale processes cannot mutate a reassigned task;
- process visibility no longer depends on a small set of task statuses;
- cross-verification traces are structurally impossible through public tools;
- retry evidence preserves history instead of overwriting it.

Negative:

- managed worker calls carry an additional execution token;
- the database gains a durable execution history;
- local PID identity inspection is platform-specific;
- remote execution recovery remains intentionally conservative.

## Rollback

Revert this change. New columns and tables are additive and can remain unused.
Do not drop `worker_executions` during rollback; it is audit history.

## Verification

- full TypeScript build and Node test suite;
- regression tests for cross-AC rejection, startup trace repair, per-execution
  retry evidence, stale-fence rejection, silent-live retention, and dead-PID
  release;
- board-runner tests cover spawn, close, recovery, and log-stream closure.
