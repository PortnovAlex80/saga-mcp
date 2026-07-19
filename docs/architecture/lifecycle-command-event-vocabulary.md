# Lifecycle Command/Event/Effect Vocabulary

**Status:** FROZEN as of Slice 0.
**Source of truth:** `src/lifecycle/domain/{commands,events,effects,state}.ts`.
**Authority:** This document is the canonical list. Slice 1+ implementations
MUST NOT rename these identifiers without an ADR update that supersedes this
file. Renames break: persisted receipts, audit events, test fixtures, scanner
output, and downstream tooling that consumes the event log.

The names here mirror blueprint §6.2 (line 250-303), §7 (line 310-348),
§8 (line 376-415), §11 transition table (line 506-528).

## Branded IDs

Carry identity at domain boundaries; erased at runtime.

| Type              | Purpose                                                    |
|-------------------|------------------------------------------------------------|
| `CommandId`       | Idempotency key for a lifecycle command.                   |
| `ExecutionId`     | Identifies one worker execution (one OS process attempt).  |
| `IntegrationId`   | Identifies one integration intent (Git merge unit).        |
| `HumanRequestId`  | Identifies one open human-input request (ASK).             |

Stable derivation (blueprint §7.1:355-370):
- `<execution-id>:implementation-completed`
- `<execution-id>:review-verdict`
- `<execution-id>:human-question`
- `<execution-id>:verification:<artifact-id>:<content-hash>`

Controller/admin commands use generated UUIDs. Reusing one ID with a different
canonical payload hash is `IDEMPOTENCY_KEY_REUSED`.

## ManagedTaskState variants

Source: blueprint §6.2:250-285.

| `kind`                  | Meaning                                                |
|-------------------------|--------------------------------------------------------|
| `queued`                | In a ready queue for implementation or review.         |
| `active`                | A worker is executing an implementation/review attempt.|
| `finishing`             | Terminal report accepted; process draining.            |
| `waiting_human`         | Parked for human input (ASK). No live process.         |
| `awaiting_integration`  | Review approved; integration intent ready.             |
| `integrating`           | Integration executor running.                          |
| `integration_conflict`  | Integration observed a conflict.                       |
| `blocked_dependencies`  | Dependency reconciliation blocked a queued task.       |
| `completed`             | All required work items terminal-successful.           |

## Invariant codes

Source: blueprint §6.2:292-303. Returned by `decodeManagedState` for invalid
composite rows; surfaced by the invariant scanner as `named_violation`.

| Code                                            | Trigger                                                                |
|-------------------------------------------------|------------------------------------------------------------------------|
| `ACTIVE_WITHOUT_OWNER`                          | `status` active but `assigned_to` is null.                             |
| `ACTIVE_WITHOUT_EXECUTION`                      | `status` active but `current_execution_id` is null (legacy signature). |
| `BUFFER_WITH_OWNER`                             | Buffer status (`todo`/`review`/`done`/`blocked`) with `assigned_to`.   |
| `TASK_FENCE_WITHOUT_ACTIVE_EXECUTION`           | `current_execution_id` set but no matching active execution row.       |
| `EXECUTION_DOES_NOT_OWN_TASK`                   | Execution row's id ≠ task's `current_execution_id`.                    |
| `TERMINAL_EXECUTION_OWNS_TASK`                  | Task fenced by an execution in `exited`/`lost`/`terminated`/`spawn_failed`. |
| `DONE_PENDING_WITHOUT_INTEGRATION_INTENT`       | `status=done AND integration_state=pending` with no integration intent. |
| `WAITING_HUMAN_WITH_ACTIVE_EXECUTION`           | `needs-human` tag + live execution fence (ASK dead-assignment).        |
| `COMPLETED_WITH_UNFINISHED_INTEGRATION`         | `git_change` task `done` with null `integration_state`.                |
| `MULTIPLE_ACTIVE_INTEGRATIONS_FOR_REPOSITORY`   | Two `active` integration intents for the same repository (Slice 5).    |

## Commands

Source: blueprint §7:334-348 and §11.

| `kind`                            | Actor                 | Notes                                              |
|-----------------------------------|-----------------------|----------------------------------------------------|
| `ReserveWorkItem`                 | controller            | Claims implementation/review; spawns worker.       |
| `RegisterWorkerProcess`           | managed_execution     | Worker registered its PID + birth token.           |
| `ReportImplementationCompleted`   | managed_execution     | Freezes `sourceSha`; creates review item.          |
| `SubmitReviewVerdict`             | managed_execution     | `approved` (git/non-git) or `changes_requested`.   |
| `ParkForHuman`                    | managed_execution     | **Terminal** — releases process, persists question.|
| `RecordHumanAnswer`               | human                 | Answers an open request; queues fresh worker.      |
| `RequestExecutionStop`            | controller            | Cancel an active execution.                         |
| `ObserveProcessExited`            | controller            | Process closed with exit code.                      |
| `ObserveProcessLost`              | controller            | Verified-dead active execution (PID reuse guard).   |
| `ReserveIntegrationAttempt`       | integration_executor  | Take the repository lock; start merge.              |
| `ObserveIntegrationMerged`        | integration_executor  | Ancestry/trailer observation succeeded.             |
| `ObserveIntegrationConflict`      | integration_executor  | Deterministic conflict manifest.                    |
| `ReconcileDependencies`           | controller            | `blocked: true`/`false` (queued tasks only).        |
| `AdminOverrideLifecycle`          | admin                 | Manual recovery with reason; audited.               |

## Events

Source: blueprint §8:376-403. Audit facts and projection inputs. Not the
source of truth (see blueprint §1 non-goals).

| `kind`                       |
|------------------------------|
| `WorkItemCreated`            |
| `WorkAttemptReserved`        |
| `WorkAttemptStarted`         |
| `WorkAttemptSucceeded`       |
| `WorkAttemptLost`            |
| `ExecutionReserved`          |
| `ExecutionStarted`           |
| `ImplementationCompleted`    |
| `ReviewItemCreated`          |
| `ReviewApproved`             |
| `ReviewChangesRequested`     |
| `ImplementationItemCreated`  |
| `HumanInputRequested`        |
| `HumanInputProvided`         |
| `IntegrationRequested`       |
| `IntegrationStarted`         |
| `IntegrationObservedMerged`  |
| `IntegrationObservedConflict`|
| `ExecutionStopRequested`     |
| `ExecutionExited`            |
| `ExecutionLost`              |
| `TaskReleased`               |
| `DependencyBlocked`          |
| `DependencyUnblocked`        |
| `AdminOverrideApplied`       |

## Effect intents

Source: blueprint §8:405-415. Closed discriminated union. The reducer emits;
the shell outbox-relay executes. Never callbacks, never arbitrary code.

| `kind`                   | Target                       |
|--------------------------|------------------------------|
| `worker.spawn`           | CLI runner                   |
| `worker.terminate`       | Process killer               |
| `integration.execute`    | Git executor                 |
| `human.notify`           | Human-notification channel   |
| `workflow.generate`      | Episode workflow engine      |
| `dependencies.reconcile` | Dependency reconciler        |

## Domain rejection codes

Stable codes returned by `decide` for rejected commands. Deterministic
rejections are persisted as receipts too (blueprint §10:477-478).

| Code                          | Meaning                                                  |
|-------------------------------|----------------------------------------------------------|
| `NO_TRANSITION`               | Zero rules matched the (state, command) pair.            |
| `PRECONDITION_FAILED`         | Rule matched but facts/conditions failed.                |
| `IDEMPOTENCY_KEY_REUSED`      | `commandId` reused with different payload hash.          |
| `NOT_AUTHORIZED`              | Actor not permitted for this command.                    |
| `AMBIGUOUS_TRANSITION_TABLE`  | Internal: >1 rule matched (reducer bug).                 |

## Change protocol

Adding an item to any of the lists above requires:

1. Update the corresponding `.ts` file in `src/lifecycle/domain/`.
2. Add a characterization test in `tests/lifecycle/oracle.test.mjs`.
3. Add a fixture in `tests/lifecycle/fixtures/` if relevant.
4. Update this document in the same commit.
5. If the change is observable to downstream tooling (e.g. a new event that
   the audit log exposes), update ADR-011 or file a follow-up ADR.

Renaming an item additionally requires migrating receipts/events on disk —
prefer ADD + DEPRECATE over in-place rename.
