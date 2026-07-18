# Passive worker lifecycle kernel — implementation blueprint

Status: implementation guide for proposed ADR-010/ADR-011.

Audience: an implementation agent changing `saga-mcp`.

## 1. Goal

Make the passive Claude CLI lifecycle deterministic from task reservation to
completion, including process loss, human questions, review retries, and Git
integration.

The controller owns lifecycle transitions. A Claude process receives one
addressed work assignment and reports one terminal outcome. It never selects
the next task, moves Kanban columns, owns a repository merge lock, or decides
which lifecycle phase comes next.

The first stabilization slice keeps `tasks` and `worker_executions` as
authoritative snapshots. The target model makes semantic `work_items` and
`work_attempts` canonical, while `tasks.status` becomes a compatibility board
projection and `worker_executions` remains OS-process truth. Durable command
receipts, audit events, and external-effect intents support the transition.
This is not full event sourcing.

## 2. Non-goals

- Do not add a state-machine or event-bus dependency.
- Do not rebuild the entire task schema in the first migration.
- Do not make the event log the source of truth.
- Do not put Git, filesystem, PID inspection, process spawn, or process kill
  inside a SQLite transaction.
- Do not implement a generic workflow DSL.
- Do not preserve the current same-process review-and-merge protocol.
- Do not infer liveness from log activity.

## 3. Selected pattern composition

Use these patterns together:

1. **Functional Core / Imperative Shell**
   - pure reducers validate commands and emit events/effect intents;
   - the shell reads SQLite, observes OS/Git state, and executes effects.
2. **Ports and Adapters**
   - domain code imports no SQLite, Node OS, Git, MCP, or tracker-view modules;
   - infrastructure implements narrow storage and observation ports.
3. **CQRS-lite typed command boundary**
   - all lifecycle writes are commands;
   - existing read queries and snapshots remain in place.
4. **Idempotent Inbox / Command Receipt**
   - each semantic command has a stable ID and stored response;
   - a retry returns the original response without repeating effects.
5. **Transactional Outbox**
   - an external effect is enqueued in the same transaction as the state
     transition that requested it.
6. **Process Manager**
   - small coordinators handle worker execution, human wait, and Git
     integration;
   - there is no universal event bus or one giant workflow class.
7. **Typestate with discriminated unions**
   - domain code decodes flat rows into valid composite states;
   - impossible combinations are rejected before a transition.
8. **Compatibility Projection**
   - current task columns remain the board/read projection during rollout;
   - only the lifecycle projector may write them.
9. **Work Item / Attempt model**
   - a task is a stable product goal and provenance container;
   - implementation, review, integration, and human wait are durable work
     items;
   - a retry is a new attempt and never rewinds an already completed item.

## 4. Target architecture

```text
MCP / Engine / UI / Reconciler
              |
              v
       typed Command Bus
              |
     BEGIN IMMEDIATE transaction
              |
       +------+-------+-------------------+
       |              |                   |
       v              v                   v
 command receipt   pure reducer       snapshot loader
       |              |                   |
       |              v                   |
       |       events + effect intents    |
       |              |                   |
       +--------------+-------------------+
                      |
          project work/items + snapshots + event
          + enqueue durable effects
                      |
                    COMMIT
                      |
                      v
                 Outbox Relay
          +-----------+-------------+
          |           |             |
          v           v             v
      CLI runner   Git executor   notifications
          |           |             |
          +-----------+-------------+
                      |
               follow-up command
```

The database transaction makes command acceptance, snapshot projection,
receipt, event, and outbox insertion atomic. External work is deliberately
outside that transaction and reports back through another idempotent command.

## 5. Module boundaries

Create this structure:

```text
src/lifecycle/
  domain/
    ids.ts
    model.ts
    work-items.ts
    commands.ts
    results.ts
    events.ts
    effects.ts
    errors.ts
    invariants.ts
    evolve.ts
    reducers/
      claim.ts
      execution.ts
      outcome.ts
      human.ts
      integration.ts
      dependency.ts
      admin.ts
      table.ts

  application/
    command-bus.ts
    decide.ts
    context.ts
    process-managers/
      worker-process.ts
      human-wait.ts
      integration.ts

  ports/
    unit-of-work.ts
    snapshots.ts
    receipts.ts
    events.ts
    outbox.ts
    process-observer.ts
    repository-observer.ts
    clock.ts

  infrastructure/
    sqlite/
      unit-of-work.ts
      snapshot-loader.ts
      snapshot-projector.ts
      receipt-store.ts
      event-store.ts
      outbox-store.ts
      integration-intent-store.ts
      work-item-store.ts
    process/
      local-process-observer.ts
      worker-effect-executor.ts
    git/
      git-observer.ts
      integration-executor.ts

  adapters/
    dispatcher.ts
    runner.ts
    reconciler.ts
    dependencies.ts
    admin.ts
```

Existing files become adapters:

- `src/tools/dispatcher.ts` validates MCP input and submits commands.
- `src/worker-executions.ts` retains OS observation helpers, but submits
  `ObserveProcess*` commands instead of writing task state.
- `src/orchestrate.ts` queries and submits commands; it owns no lifecycle SQL.
- `tracker-view/tracker-view.mjs` calls the same compiled application adapter;
  it owns no duplicate recovery SQL.
- `tracker-view/claude-runner.mjs` reserves/spawns/reports process facts; it does
  not recover task rows itself.

## 6. Domain model

### 6.1 Entity responsibilities

```text
Task
  stable goal, requirements provenance, priority, dependencies
    |
    +-- WorkItem: implementation cycle 1
    |     +-- WorkAttempt 1 -> WorkerExecution
    |
    +-- WorkItem: review cycle 1
    |     +-- WorkAttempt 1 -> WorkerExecution
    |
    +-- WorkItem: implementation cycle 2  (after changes requested)
    |
    +-- WorkItem: review cycle 2
    |
    +-- WorkItem: integration
          +-- WorkAttempt 1 -> lost Git executor
          +-- WorkAttempt 2 -> successful Git executor
```

- A task is never owned by an OS process.
- A work item is one semantic phase with an immutable terminal outcome.
- An attempt is one try at a work item.
- A worker execution is process truth for one attempt.
- Losing an integration attempt requeues the integration item. It never erases
  an approved review item.
- `done` is derived only when all required work items are terminal-successful.

Use fixed workflow templates, not a generic DSL:

```text
tracker_only/read_only_evidence: implementation -> review -> complete
git_change:                     implementation -> review -> integration -> complete
verification.ac:                verification -> adjudication -> optional integration
```

### 6.2 Compatibility typestate

Use branded IDs at domain boundaries:

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type CommandId = Brand<string, 'CommandId'>;
export type ExecutionId = Brand<string, 'ExecutionId'>;
export type IntegrationId = Brand<string, 'IntegrationId'>;
export type HumanRequestId = Brand<string, 'HumanRequestId'>;
```

Keep the persisted enums, but decode them into a discriminated union before
deciding a command:

```ts
export type ManagedTaskState =
  | {
      readonly kind: 'queued';
      readonly phase: 'implementation' | 'review';
    }
  | {
      readonly kind: 'active';
      readonly phase: 'implementation' | 'review';
      readonly workerId: string;
      readonly executionId: ExecutionId;
    }
  | {
      readonly kind: 'finishing';
      readonly completedPhase: 'implementation' | 'review';
      readonly executionId: ExecutionId;
    }
  | {
      readonly kind: 'waiting_human';
      readonly resumePhase: 'implementation' | 'review' | 'integration';
      readonly requestId: HumanRequestId;
    }
  | {
      readonly kind: 'awaiting_integration';
      readonly integrationId: IntegrationId;
    }
  | {
      readonly kind: 'integrating';
      readonly integrationId: IntegrationId;
      readonly executorExecutionId: ExecutionId;
    }
  | {
      readonly kind: 'integration_conflict';
      readonly integrationId: IntegrationId;
    }
  | { readonly kind: 'blocked_dependencies' }
  | { readonly kind: 'completed' };
```

`decodeManagedState(task, execution, integration, humanRequest)` returns either
a valid state or a stable `InvariantViolation`. It must not silently normalize
invalid managed rows.

Required invariant codes:

- `ACTIVE_WITHOUT_OWNER`
- `ACTIVE_WITHOUT_EXECUTION`
- `BUFFER_WITH_OWNER`
- `TASK_FENCE_WITHOUT_ACTIVE_EXECUTION`
- `EXECUTION_DOES_NOT_OWN_TASK`
- `TERMINAL_EXECUTION_OWNS_TASK`
- `DONE_PENDING_WITHOUT_INTEGRATION_INTENT`
- `WAITING_HUMAN_WITH_ACTIVE_EXECUTION`
- `COMPLETED_WITH_UNFINISHED_INTEGRATION`
- `MULTIPLE_ACTIVE_INTEGRATIONS_FOR_REPOSITORY`

During the shadow migration, `decodeManagedState` reads both canonical work
items and compatibility task/execution rows, then reports projection mismatch.
Legacy/manual tasks are decoded through an explicit compatibility branch. Do
not make the managed decoder fail open when `current_execution_id` is null.

## 7. Commands

Use one typed envelope:

```ts
export interface CommandEnvelope<C extends LifecycleCommand> {
  readonly commandId: CommandId;
  readonly actor:
    | { readonly kind: 'controller'; readonly id: string }
    | {
        readonly kind: 'managed_execution';
        readonly workerId: string;
        readonly executionId: ExecutionId;
      }
    | { readonly kind: 'integration_executor'; readonly id: string }
    | { readonly kind: 'human'; readonly id: string }
    | { readonly kind: 'admin'; readonly id: string; readonly reason: string };
  readonly command: C;
}
```

Initial command union:

```ts
export type LifecycleCommand =
  | ReserveWorkItem
  | RegisterWorkerProcess
  | ReportImplementationCompleted
  | SubmitReviewVerdict
  | ParkForHuman
  | RecordHumanAnswer
  | RequestExecutionStop
  | ObserveProcessExited
  | ObserveProcessLost
  | ReserveIntegrationAttempt
  | ObserveIntegrationMerged
  | ObserveIntegrationConflict
  | ReconcileDependencies
  | AdminOverrideLifecycle;
```

Every worker outcome identifies `workItemId` and `attemptId`. Do not expose
`targetStatus` on worker commands. Only the reducer selects the next work item
and the board projector derives task status.

### 7.1 Stable command IDs

Do not rely on an LLM inventing UUIDs correctly.

Derive IDs for semantic single-use worker commands:

```text
<execution-id>:implementation-completed
<execution-id>:review-verdict
<execution-id>:human-question
<execution-id>:verification:<artifact-id>:<content-hash>
```

Controller/admin commands use generated UUIDs. A retry must reuse the original
ID. Reusing one ID with a different canonical payload hash is
`IDEMPOTENCY_KEY_REUSED`.

## 8. Events and effects

Events are audit facts and projection inputs, not the source of truth:

```ts
export type DomainEvent =
  | WorkItemCreated
  | WorkAttemptReserved
  | WorkAttemptStarted
  | WorkAttemptSucceeded
  | WorkAttemptLost
  | ExecutionReserved
  | ExecutionStarted
  | ImplementationCompleted
  | ReviewItemCreated
  | ReviewApproved
  | ReviewChangesRequested
  | ImplementationItemCreated
  | HumanInputRequested
  | HumanInputProvided
  | IntegrationRequested
  | IntegrationStarted
  | IntegrationObservedMerged
  | IntegrationObservedConflict
  | ExecutionStopRequested
  | ExecutionExited
  | ExecutionLost
  | TaskReleased
  | DependencyBlocked
  | DependencyUnblocked
  | AdminOverrideApplied;
```

Effects are a closed discriminated union:

```ts
export type EffectIntent =
  | { readonly kind: 'worker.spawn'; readonly executionId: ExecutionId }
  | { readonly kind: 'worker.terminate'; readonly executionId: ExecutionId }
  | { readonly kind: 'integration.execute'; readonly integrationId: IntegrationId }
  | { readonly kind: 'human.notify'; readonly requestId: HumanRequestId }
  | { readonly kind: 'workflow.generate'; readonly sourceTaskId: number }
  | { readonly kind: 'dependencies.reconcile'; readonly taskId: number };
```

Never store a callback or arbitrary code as an effect. External and retryable
effects go to the outbox. Activity-log and comment projections may be written
in the command transaction.

## 9. Reducer contract

```ts
export interface Decision<R> {
  readonly events: readonly DomainEvent[];
  readonly effects: readonly EffectIntent[];
  readonly result: R;
}

export function decide<C extends LifecycleCommand>(
  state: ManagedTaskState,
  envelope: CommandEnvelope<C>,
  facts: LifecycleFacts,
): Decision<ResultFor<C>> | DomainRejection;

export function evolve(
  state: ManagedTaskState,
  event: DomainEvent,
): ManagedTaskState;
```

Reducers:

- receive immutable state, command, and already-observed facts;
- perform no I/O;
- read no clock;
- mutate no input;
- return stable domain error codes;
- match exactly one transition rule.

Use a typed rule table per concern. `decide` must return `NO_TRANSITION` if no
rule matches and throw an internal `AMBIGUOUS_TRANSITION_TABLE` if more than
one rule matches.

## 10. Command bus transaction

Pseudocode:

```ts
execute(envelope) {
  const acceptedAt = clock.now();
  const payloadHash = hashCanonical(envelope.command);

  return unitOfWork.immediate(() => {
    const oldReceipt = receipts.find(envelope.commandId);
    if (oldReceipt) {
      if (oldReceipt.payloadHash !== payloadHash) {
        return idempotencyConflict(oldReceipt);
      }
      return oldReceipt.reply;
    }

    const snapshot = snapshots.loadFor(envelope.command);
    const decoded = decodeManagedState(snapshot);
    const decision = decide(decoded.state, envelope, decoded.facts);

    if (!decision.ok) {
      receipts.storeRejected(envelope, payloadHash, decision.error, acceptedAt);
      return decision;
    }

    const postState = decision.events.reduce(evolve, decoded.state);
    assertCompositeInvariants(postState);

    receipts.storeAccepted(envelope, payloadHash, decision.result, acceptedAt);
    events.append(envelope, decision.events, acceptedAt);
    snapshots.project(snapshot, decision.events);
    outbox.enqueue(envelope, decision.effects, acceptedAt);

    return { ok: true, replayed: false, value: decision.result };
  });
}
```

Transaction requirements:

- use `BEGIN IMMEDIATE`;
- store deterministic rejections as receipts too;
- snapshot writes include expected pre-state/fence CAS;
- event append, snapshot projection, outbox, and receipt succeed or roll back
  together;
- insert the receipt before events that reference it; transaction rollback keeps
  the receipt invisible if a later projection/outbox write fails;
- no Git/OS/filesystem/Claude operations occur inside the transaction.

## 11. Transition table

| Command | Required pre-state | Events | Post-state | Durable effects |
|---|---|---|---|---|
| `ReserveWorkItem(implementation)` | ready implementation item, deps ready, no human block | `WorkAttemptReserved`, `ExecutionReserved` | active implementation attempt | optionally `worker.spawn` |
| `ReserveWorkItem(review)` | ready review item, no human block | `WorkAttemptReserved`, `ExecutionReserved` | active review attempt | optionally `worker.spawn` |
| `RegisterWorkerProcess` | matching reserved execution | `ExecutionStarted` | same active task | none |
| `ReportImplementationCompleted` | matching active implementation attempt | `ImplementationCompleted`, `ReviewItemCreated` | implementation item completed; review item ready | review notification if needed |
| `SubmitReviewVerdict(approved)` non-git | matching active review attempt; verification gates pass | `ReviewApproved` | review item completed; task projection completed | `workflow.generate` |
| `SubmitReviewVerdict(approved)` git | matching active review attempt; reviewed source SHA frozen | `ReviewApproved`, `IntegrationItemCreated` | review item completed; integration item ready | `integration.execute` |
| `SubmitReviewVerdict(changes_requested)` | matching active review attempt | `ReviewChangesRequested`, `ImplementationItemCreated` | review item terminal; next implementation cycle ready | none |
| `ParkForHuman` | matching active implementation/review | `HumanInputRequested` | waiting human; execution finishing | `human.notify` |
| `RecordHumanAnswer` | matching open human request | `HumanInputProvided` | queued resume phase | none |
| `ObserveProcessExited` after accepted terminal report | execution finishing | `ExecutionExited` | preserve committed semantic post-state | none |
| `ObserveProcessExited` without terminal report | active execution | `ExecutionExited`, `TaskReleased` | original phase queue | none |
| `ObserveProcessLost` | verified-dead active execution | `ExecutionLost`, `WorkAttemptLost` | same work item ready for a new attempt | none |
| `ObserveProcessLost` for reviewer after approval | review item already terminal; integration item ready | `ExecutionLost` | integration remains ready | none |
| `ReserveIntegrationAttempt` | ready integration item, repository free | `IntegrationAttemptReserved` | integration item active | none |
| `ObserveIntegrationMerged` | matching integration intent and repository observation | `IntegrationObservedMerged` | completed | `workflow.generate`, cleanup |
| `ObserveIntegrationConflict` | matching integration intent | `IntegrationObservedConflict` | integration conflict or waiting human | `human.notify` |
| `ReconcileDependencies(blocked)` | queued task only | `DependencyBlocked` | blocked dependencies | none |
| `ReconcileDependencies` on active task | active | rejection or `worker.terminate` policy | never direct blocked+live combination | optional termination |
| `AdminOverrideLifecycle` | explicit expected version/fence and reason | `AdminOverrideApplied` | policy-selected | policy-selected |

The post-state after a semantic worker report must not depend on the process
exit code. Once a terminal command was committed, process close is bookkeeping.

## 12. Passive worker protocols

### 12.1 Implementation

```text
controller claims implementation
  -> runner spawns one Claude process
  -> worker changes its task branch and commits
  -> worker reports ReportImplementationCompleted(source_sha, summary)
  -> response says stop:true
  -> process exits
  -> controller later claims review with a fresh process
```

The report freezes `source_sha`. Review must inspect that exact commit. If the
branch advances afterward, approval cannot integrate it without a new review.

### 12.2 Review

```text
controller claims review
  -> reviewer inspects frozen source_sha
  -> SubmitReviewVerdict(approved | changes_requested)
  -> reviewer exits
```

- `changes_requested` creates a fresh implementation queue entry.
- `approved` completes a non-git task or creates an integration intent.
- A reviewer never fixes implementation in the same execution.
- A reviewer never performs Git integration.

### 12.3 Human question

`ParkForHuman` is terminal:

1. Persist question, context checkpoint, resume phase, source/worktree SHA, and
   requesting execution.
2. Mark the human request open.
3. Clear task ownership/fence through the normal terminal projection.
4. Mark execution finishing.
5. Exclude open human requests from claimability.
6. Return `stop:true`; the process exits.
7. UI records `RecordHumanAnswer`.
8. A fresh process receives the stored question, answer, and checkpoint.

Never promise same-process continuation for `claude -p`.

## 13. Git integration process manager

Git integration belongs to a deterministic executor, not to the reviewer.

### 13.1 Integration intent

Persist:

```text
integration_id
originating_command_id UNIQUE
task_id
project_repository_id
source_branch
reviewed_source_sha
target_branch
expected_target_sha
state: pending|running|merged|conflict|base_advanced|retryable|dead
executor_execution_id
attempt_count
available_at
result_commit
conflict_files
last_error
created_at / updated_at
```

The idempotency key is:

```text
repository:task:review-cycle:reviewed-source-sha:target-branch
```

### 13.2 Repository claim

The repository claim is bound to `integration_id` and executor execution
identity. It is not stealable solely by elapsed wall time.

For a local executor, reclaim only after verifying PID plus process-birth
identity. For a future remote executor, require a separate machine lease before
automatic reclaim.

### 13.3 Idempotent Git algorithm

1. Verify `source_branch` still points to `reviewed_source_sha`.
   - If not, emit `SOURCE_ADVANCED_AFTER_REVIEW`; require a new review.
2. Observe the target branch head.
3. If `reviewed_source_sha` is already an ancestor of the target, report
   `IntegrationObservedMerged` without another merge.
4. If the target differs from `expected_target_sha`, mark `base_advanced` and
   create a new reconciled intent. Do not blind-merge against an unobserved
   base.
5. Create a temporary detached integration worktree at
   `expected_target_sha`.
6. Run `git merge --no-ff --no-commit <reviewed_source_sha>`.
7. On conflict:
   - collect conflict paths;
   - abort merge;
   - remove the temporary worktree;
   - report `ObserveIntegrationConflict`.
8. On success, create a commit containing trailers:

   ```text
   Saga-Integration-Id: <integration-id>
   Saga-Task-Id: <task-id>
   Saga-Reviewed-Source: <source-sha>
   ```

9. Advance the target with compare-and-swap:

   ```bash
   git update-ref refs/heads/<target> <merge-sha> <expected-target-sha>
   ```

10. If CAS fails, do not report success. Re-observe and reconcile.
11. If the target branch is checked out in a registered local checkout, do not
    update its ref behind that worktree. The executor may merge in that
    checkout only when it is clean, is on the expected target branch, and HEAD
    equals `expected_target_sha`. Otherwise report `checkout_not_safe` and
    require a dedicated integration checkout. Never reset or clean a dirty user
    checkout.
12. Report the observed result through the command bus.
13. Cleanup is a separate idempotent effect.

An implementation may replace the temporary-worktree merge with Git plumbing
(`merge-tree`/`commit-tree`) after verifying the supported Git version. The
same reviewed-source, expected-target, ancestry, trailer, and `update-ref` CAS
invariants still apply.

Crash recovery:

- before `update-ref`: the temporary commit/worktree may be discarded;
- after `update-ref` but before DB acknowledgement: ancestry/trailer observation
  recovers success;
- after DB acknowledgement but before outbox completion: the same command ID
  replays its stored response;
- cleanup failure never reverses a successful integration.

Git conflict is a business outcome, not a technical retry failure.

## 14. Persistence additions

Additive tables:

```sql
CREATE TABLE task_work_items (
  work_item_id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('implementation','review','verification',
                    'integration','human_decision','cleanup')),
  cycle_no INTEGER NOT NULL,
  item_no INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL
    CHECK (state IN ('pending','ready','active','waiting',
                     'completed','cancelled')),
  outcome TEXT,
  predecessor_item_id TEXT REFERENCES task_work_items(work_item_id),
  required INTEGER NOT NULL DEFAULT 1,
  input_snapshot_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  history_complete INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (task_id, kind, cycle_no, item_no)
);

CREATE TABLE work_attempts (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL
    REFERENCES task_work_items(work_item_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('reserved','running','succeeded','failed',
                     'lost','cancelled')),
  worker_id TEXT,
  execution_id TEXT REFERENCES worker_executions(execution_id),
  command_id TEXT,
  outcome TEXT,
  result_json TEXT,
  reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT,
  UNIQUE (work_item_id, ordinal)
);

CREATE TABLE lifecycle_command_receipts (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected')),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  command_id TEXT NOT NULL REFERENCES lifecycle_command_receipts(command_id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);

CREATE TABLE lifecycle_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES lifecycle_command_receipts(command_id),
  effect_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','leased','succeeded','retry_wait','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_owner TEXT,
  lease_until TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Also add specialized `integration_intents` and `human_requests` tables. Do not
hide their query-critical state entirely inside generic outbox JSON.

Add partial unique indexes for one active attempt per work item and one active
execution per attempt. `worker_executions` gains nullable `attempt_id` during
the compatibility migration. It remains the process registry; do not duplicate
PID/birth-token liveness fields into `work_attempts`.

```sql
CREATE UNIQUE INDEX work_attempts_one_active_item
  ON work_attempts(work_item_id)
  WHERE state IN ('reserved','running');

CREATE UNIQUE INDEX work_attempts_one_execution
  ON work_attempts(execution_id)
  WHERE execution_id IS NOT NULL;
```

Add `tasks.lifecycle_version INTEGER NOT NULL DEFAULT 0`. Projection updates
increment it and include expected version/fence predicates.

## 15. MCP and compatibility

One compatibility release:

- `worker_next` adapts to `ReserveWorkItem`.
- `worker_done` reads the active execution phase and adapts to
  `ReportImplementationCompleted` or `SubmitReviewVerdict`.
- `worker_ask_need` adapts to terminal `ParkForHuman`.
- `worker_ask_done` is deprecated; human UI submits `RecordHumanAnswer`.
- `worker_merge_acquire/release` are removed from managed worker prompts and
  become internal integration-executor operations.
- `task_batch_update` may change descriptive fields only. Remove `status` and
  `assigned_to`.
- Add `task_admin_transition` with required `reason`, expected lifecycle
  version, and expected execution fence.

The engine and dispatcher must share one `listClaimableWork` repository query.
Do not maintain separate approximations for pump counts and actual claims.

## 16. Migration slices

Implement in this order. Each slice must be independently releasable.

### Slice 0 — Characterization and invariant oracle

- Add a read-only invariant scanner.
- Add failure fixtures around the real managed-child seam.
- Freeze command/event/error names.
- Add the pure state decoder and transition tests.
- Change no production writes.

Acceptance:

- current databases can be classified as valid managed, valid legacy, or a
  named invariant violation;
- every current lifecycle transition has a characterization test.

### Slice 1 — Terminal execution kernel

Move only:

- spawn failed;
- stop requested;
- process exited;
- process lost/terminated;
- task release.

Replace both runner recovery implementations with commands.

Acceptance:

- execution terminalization and task release occur in one transaction;
- close/reconciler races are idempotent;
- no terminal execution remains as a task fence.

### Slice 2 — Work-item shadow model

- Add `task_work_items`, `work_attempts`, and the compatibility board
  projection.
- Backfill one synthetic current pipeline per task without inventing history:
  - `todo` -> ready implementation item;
  - `in_progress` -> active implementation item + legacy attempt;
  - `review` -> completed implementation + ready review;
  - `review_in_progress` -> active review attempt;
  - `done + pending` -> approved review + ready/running integration;
  - `done + merged/not_required` -> terminal-successful pipeline;
  - `done + conflict` -> terminal review + conflicted integration;
  - `needs-human` -> waiting item + open human request.
- Mark ambiguous imports `history_complete=false`.
- Shadow-project work items to legacy task columns and compare after every
  transition. Old task columns remain authoritative in this slice.

Acceptance:

- every managed task has exactly one current semantic item;
- recomputed board projection matches legacy rows or reports a named mismatch;
- review approval survives loss of an integration attempt;
- backfill never fabricates prior cycle history.

### Slice 3 — Passive human wait and admin boundary

- Make ASK terminal.
- Add `human_requests`.
- Exclude open requests from claimability.
- Remove lifecycle fields from `task_batch_update`.
- Add audited admin transition.

Acceptance:

- a waiting task has no live process or assignment;
- answering creates no resurrection of an old execution;
- a fresh worker receives persisted question/answer context.

### Slice 4 — Worker outcomes

Move:

- implementation complete;
- review changes requested;
- non-git approval;
- verification-gated approval.

Acceptance:

- duplicate semantic report returns the same stored response;
- result comments/activity are not duplicated;
- `changes_requested` always creates a fresh developer execution.

### Slice 5 — Integration intent and executor

- Approval writes a frozen reviewed SHA and integration intent.
- Build the deterministic Git executor.
- Remove same-process merge from worker prompt.
- Add ancestry/trailer/CAS reconciliation.

Acceptance:

- reviewer exits immediately after approval without stranding the task;
- crash after `update-ref` is observed as success on retry;
- release-without-acquire is impossible;
- a live repository executor cannot lose its claim on wall time alone.

### Slice 6 — Claim and dependency writers

- Move claim/reservation into the bus.
- Share exact claimability query with engine counts.
- Move dependency block/unblock through commands.

Acceptance:

- no active task is directly changed to blocked;
- concurrent claims produce one reservation;
- count and claim predicates are identical.

### Slice 7 — Work-item cutover and single-writer enforcement

- Make work items/attempts authoritative for managed lifecycle.
- Route UI, admin, import/recovery, and remaining adapters through commands.
- Add an architecture test forbidding direct runtime lifecycle SQL.
- Delete obsolete recovery and merge-healer paths.
- Update skills and MCP descriptions.

Acceptance:

- production lifecycle columns have one writer;
- task board state is a deterministic projection of canonical work items;
- no LLM healer is required to infer process/Git truth;
- all compatibility adapters are marked with a removal release.

## 17. Work packages for implementation agents

Do not give one agent the whole migration.

### WP-1: Domain oracle

Files:

- `src/lifecycle/domain/**`
- domain-only tests

Deliver:

- state decoder;
- commands/events/effects unions;
- transition rules;
- `evolve`;
- invariant property/table tests.

Forbidden:

- production SQL changes;
- imports from Node, SQLite, tools, or tracker-view.

### WP-2: Receipt/event/outbox persistence

Files:

- schema and migration;
- `src/lifecycle/ports/**`;
- `src/lifecycle/infrastructure/sqlite/**`.

Deliver:

- `BEGIN IMMEDIATE` unit of work;
- accepted/rejected receipt replay;
- atomic event/snapshot/outbox transaction;
- fault-injection tests.

### WP-3: Terminal recovery vertical slice

Files:

- execution reducers/projector;
- runner/reconciler adapters;
- runner failure tests.

Deliver:

- one atomic path for exit/loss/release;
- removal of duplicated recovery SQL.

### WP-4: Work-item shadow projection

Files:

- work-item/attempt schema and migration;
- work-item repository;
- compatibility board projector;
- migration/projection tests.

Deliver:

- honest synthetic backfill;
- projection equivalence reporting;
- integration retry without review rollback in the shadow model.

### WP-5: Human wait

Files:

- human reducer/process manager;
- UI endpoint/projection;
- worker skill/prompt;
- ASK tests.

Deliver:

- terminal park;
- fresh-process resume;
- no task-tag-only ownership protocol.

### WP-6: Worker outcome adapters

Files:

- dispatcher adapters;
- outcome reducer;
- verification gates;
- compatibility MCP tests.

Deliver:

- idempotent implementation/review outcomes;
- no direct state transition in `worker_done`.

### WP-7: Git integration executor

Files:

- integration intent persistence;
- Git observer/executor;
- integration process manager;
- real temporary-repository tests.

Deliver:

- frozen reviewed SHA;
- ancestry/trailer observation;
- target `update-ref` CAS;
- conflict and crash reconciliation.

### WP-8: Work-item cutover and single-writer enforcement

Files:

- dependency/admin/UI adapters;
- architecture tests;
- obsolete-path cleanup;
- docs/skills.

Deliver:

- no runtime lifecycle SQL outside projector;
- exact shared claim query;
- managed board state derived from canonical items/attempts;
- removal of managed worker merge tools.

## 18. Test matrix

### Pure domain

- every allowed transition has one test;
- every neighboring invalid composite state is rejected;
- no two rules match one input;
- `decide` is deterministic;
- inputs are immutable;
- `events.reduce(evolve)` always satisfies invariants.

### Command idempotency

- same ID and same payload returns byte-equivalent response;
- same ID and different payload is rejected;
- a duplicate outcome creates no duplicate comment, event, successor, or
  outbox effect;
- deterministic rejection is replayed too.

### Process races

- completion races with process loss;
- runner close races with reconciler;
- stop races with successful completion;
- spawn success races with reservation timeout;
- stale execution reports after reassignment;
- PID reuse has a different birth token.

### Human wait

- park, process exit, answer, fresh claim;
- duplicate answer;
- answer after cancel/completion;
- old execution cannot resume;
- task is not claimable while request is open.

### Git

- already-ancestor is idempotent success;
- source branch advanced after review;
- target advanced before CAS;
- crash before/after merge commit;
- crash after `update-ref` before DB report;
- deterministic conflict manifest;
- two integrations in one repository serialize;
- integrations in different repositories proceed concurrently;
- cleanup retries do not reverse completion.

### Architecture

- domain imports no infrastructure;
- no direct lifecycle `UPDATE tasks` outside projector/migrations;
- no direct `UPDATE worker_executions` outside projector/migrations;
- all unions use exhaustive `assertNever`;
- engine count uses the same claimability query as claim;
- managed worker prompt contains no queue or merge ownership commands.

## 19. Observability

Expose separately:

- task semantic state;
- active execution and OS liveness;
- open human request;
- integration intent and repository observation;
- outbox state/age/attempts;
- last accepted/rejected command;
- invariant violations.

Do not label a task status as worker liveness. Do not label a process exit as
semantic task failure after an accepted terminal command.

## 20. Guardrails for the implementing agent

- Keep reducers below roughly 200 lines per concern.
- `command-bus.ts` contains no business `switch`.
- SQL exists only in infrastructure stores/projectors and migrations.
- Git/OS exists only in shell executors/observers.
- Commands contain intent, never raw column patches.
- Events contain domain facts, never complete database rows.
- Effects contain serializable data, never functions.
- A new transition requires:
  - command/result type;
  - event/effect type;
  - reducer rule;
  - evolve case;
  - allowed and rejected tests;
  - projection test.
- Do not keep both old and new writers after a slice is declared complete.
- Do not repair an unknown Git state by asking an LLM to guess.
- Do not make elapsed time alone proof that a local process or repository claim
  is dead.
- Do not call the audit event stream “event sourcing”.

## 21. Definition of done

The migration is complete when:

1. Every lifecycle mutation enters through the typed command bus.
2. Tasks are stable goals; work items are semantic phases; attempts own
   retries; executions represent OS processes.
3. Board status is a deterministic projection of canonical work items.
4. A managed worker can only report an addressed attempt outcome.
5. ASK releases the one-shot process and resumes through a fresh attempt.
6. Review approval produces a durable integration item and intent, not a worker-owned
   merge obligation.
7. Git integration is idempotently observable after every crash point.
8. Command retries return stored results.
9. Dispatcher, engine, UI, dependency logic, recovery, and admin tools have no
   direct lifecycle SQL.
10. No task is `done` for readiness purposes before required integration is
   observed merged.
11. Full tests include real managed-child success and failure paths.
12. The architecture test prevents new lifecycle writers.

## 22. Copy-paste brief for the first implementation agent

```text
Implement only Slice 0 and Slice 1 from
docs/architecture/passive-worker-kernel-blueprint.md.

Read ADR-009, ADR-010, ADR-011, GUARDRAILS signs 010/011, dispatcher.ts,
worker-executions.ts, claude-runner.mjs, and both runner recovery adapters.

Goal:
- add a pure typed lifecycle domain oracle;
- add command receipts/audit events behind additive SQLite migration;
- move process exit/loss/spawn-failure/task-release into one BEGIN IMMEDIATE
  command transaction;
- make engine and tracker-view runner adapters call the same command;
- remove their duplicate recovery SQL.

Do not:
- implement ASK, worker outcomes, or Git integration yet;
- add dependencies;
- make events the source of truth;
- change public worker behavior outside terminal recovery;
- touch unrelated dirty worktree files.

Required tests:
- pure allowed/rejected transition table;
- same command ID replay;
- ID reused with different payload;
- transaction fault rollback;
- close vs reconciler race;
- process loss after reassignment;
- terminal execution cannot remain a task fence;
- existing full suite remains green.

Finish with:
- exact list of lifecycle SQL writers remaining after Slice 1;
- proof that the two duplicate runner recovery implementations are gone;
- migration rollback notes.
```
