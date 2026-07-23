# Saga 3 Runtime Coherence Audit

Status: active architecture recovery record

Date: 2026-07-23

Scope: Saga 3 controller, worker runtime, Oracle execution, tracker projection,
engine lifecycle, logs, and restart semantics.

## 1. Executive finding

The system did not fail because the pipeline graph is intrinsically complex.
It failed because one logical transition was represented by several independently
writable records, while the production pump, MCP completion service, tracker,
and operating-system process callbacks all believed they owned those records.

The most visible engine death was deterministic:

1. A worker produced artifacts and proposed a verification command.
2. `CommandOraclePort` invoked `bash` by name.
3. On Windows, PATH resolved that name to the WSL relay in
   `C:\Windows\System32`, although no `/bin/bash` existed.
4. The relay returned exit code 1.
5. Saga interpreted the observation-channel failure as negative product
   evidence.
6. The CLI retried the same condition three times.
7. The CLI issued `RESOURCE_EXHAUSTED` and stopped.

The resulting database was internally contradictory: a terminal episode could
still have an admitted work intent and a pending assignment, the execution exit
code could be overwritten after MCP completion, and a restart did not load the
terminal certificate before authorizing more work.

This is a control-authority failure, not an LLM intelligence problem.

## 2. Runtime topology found in production

The actual production path is:

tracker-view
  -> detached Saga 3 CLI process
  -> EpisodeController.stepEpisode
  -> work intent and assignment in SQLite
  -> Claude CLI worker
  -> strict Saga 3 MCP server
  -> AcceptWorkerSubmission
  -> artifact writer and OraclePort
  -> condition/evidence/assignment commit
  -> CLI process-exit callback
  -> worker execution and tracker task projection
  -> next controller step

This differs from the apparent application structure. `app/engine.ts` is not
the production engine. `app/cli.ts` is the real application pump and currently
contains controller, scheduler, process-supervision, retry, certificate,
lifecycle, and projection responsibilities. Therefore the repository still has
two architectural descriptions of the engine even though only one drives the
live system.

## 3. Required ownership model

Each fact must have exactly one authority:

| Fact | Authority | Other consumers |
| --- | --- | --- |
| Episode spec and generation | deterministic controller policy | CLI, workers, tracker |
| Condition status | accepted evidence transaction | controller and projections |
| Work intent state | control application | scheduler and tracker |
| Assignment state and lease | control application | worker transport and runtime |
| Artifact acceptance | submission application service | tracker projection |
| Evidence verdict | trusted Oracle adapter plus acceptance service | controller |
| OS process PID and exit code | runtime coordinator | tracker and diagnostics |
| Task card status | tracker compatibility projection | frontend only |
| Engine desired state | operator command from frontend | process supervisor |
| Engine observed state | process supervisor heartbeat/liveness | frontend |
| Terminal outcome | immutable outcome certificate | every component |
| Concurrency ceiling | frontend selector, frozen for each admission decision | scheduler |

The tracker task is not control truth. A worker process exit code is not an
Oracle verdict. A worker declaration is not evidence. Engine desired state is
not engine liveness. These pairs must never be collapsed into one field.

## 4. Non-negotiable invariants

1. Terminal is absorbing within one episode generation.
2. A change to constitution, platform policy, or governance policy creates a
   new generation; it never mutates or deletes the old certificate.
3. One active assignment has at most one execution ID.
4. One active tracker task fence refers to exactly one active execution row.
5. An execution exit code records the OS process result only.
6. A condition status records accepted evidence only.
7. The MCP completion transaction cannot close an OS process that has not yet
   exited.
8. A late process callback cannot mutate a task fenced by a newer execution.
9. Retry exhaustion cannot leave a pending assignment or admitted intent.
10. An unavailable Oracle runtime produces `Unknown/not executed`, never
    `False/executed`.
11. Restart must hydrate the certificate and current authoritative state before
    making a new decision.
12. The frontend-selected concurrency is the only operator capacity input.
    The safe fallback when no selection exists is one.

## 5. Stabilization changes implemented in this recovery slice

### 5.1 Oracle runtime

Windows Oracle execution now resolves Git Bash by explicit verified paths.
It does not resolve the Windows WSL relay through PATH. Unix uses an explicitly
existing `/bin/bash` or `/bin/sh`. `SAGA3_ORACLE_SHELL` may provide an explicit
override. If no interpreter exists, the result is `Unknown` with
`executed=false`.

This is a compatibility adapter for the current command-shaped Oracle contract.
It is not the final trust model.

### 5.2 Runtime coordination

`SqliteRuntimeCoordinator` is now the single write boundary for:

- starting and finishing `worker_executions`;
- acquiring and releasing the legacy task execution fence;
- advancing the associated assignment and work intent at process boundaries.

The start transition is one SQLite transaction. The finish transition is one
SQLite transaction and is fenced by `tasks.current_execution_id`.

`SqliteWorkerSubmissionRepository` no longer writes process exit state or
tracker task state. It commits only accepted Saga 3 artifacts, evidence,
condition, assignment, work intent, and submission state.

### 5.3 Restart and terminal behavior

The CLI now loads an existing outcome certificate before constructing the live
controller context. A terminal generation exits without materializing another
intent or assignment.

When retry budget is exhausted after `stepEpisode` has materialized a candidate,
that candidate is explicitly closed before the terminal certificate is written.
This removes the phantom-pending-assignment state.

### 5.4 Policy-aware generations

Episode generation now changes when any frozen input changes:

- constitution hash;
- platform policy hash;
- governance hash.

The runtime-coherence repair introduces a new platform policy hash. Existing
false terminal certificates remain immutable history, while the next launch
creates a new generation governed by the repaired policy.

### 5.5 Worker isolation and provider compatibility

The worker uses the explicit strict Saga 3 MCP configuration and safe mode to
prevent user hooks, plugin startup, and background customizations from hijacking
the controlled role. The LM Studio environment used by the previous worker
infrastructure is injected explicitly when the frontend-selected provider is
LM Studio.

### 5.6 Frontend process behavior

Detached tracker, docs-graph, and engine children use hidden Windows process
windows. The status endpoint no longer launches a PowerShell/WMI scan of every
Node process on every frontend poll. Liveness is read from the recorded engine
PID. The heavy descendant scan remains only for an explicit stop/restart and is
hidden.

The concurrency fallback changed from four to one. The persisted frontend
selector remains the runtime capacity input.

## 6. Remaining architectural defects

The stabilization slice makes the current vertical path coherent, but the clean
architecture refactor is not complete.

### P0: Oracle recipes are still worker-proposed

The controller authorizes an Oracle ID and version, but the worker still supplies
the command text. This allows a worker to choose a weak or self-fulfilling check.
The final design must store trusted, versioned Oracle recipes in frozen policy.
Worker submissions may provide artifact references and diagnostics, never the
pass/fail program itself.

Target contract:

OracleRequest {
  oracleId,
  oracleVersion,
  generation,
  inputs: typed artifact and repository references
}

The adapter must translate the trusted recipe to structured executable plus
argument vector. Arbitrary shell strings should then be removed.

### P0: The production application pump is still `app/cli.ts`

Retry policy, worker launch, terminal recovery, DB hydration, and lifecycle are
still coordinated directly by the CLI. `app/engine.ts` is not the production
path. These must be replaced by one application-level `EpisodePump`; CLI and
frontend become inbound adapters that invoke it.

### P0: Recovery is a counter, not an incident state machine

The current three-attempt rule does not distinguish:

- product evidence rejected;
- Oracle unavailable;
- model provider unavailable;
- worker timeout;
- process spawn failure;
- stale lease;
- persistence conflict;
- invalid worker submission.

The recovery controller must create a stable incident fingerprint, classify the
failure, select a bounded recovery rung, and record every attempt. Repeating the
same action without a changed precondition must not consume the budget as if it
were progress.

Minimum recovery rungs:

1. Re-observe without mutation.
2. Retry the same worker only for transient provider/process failures.
3. Recreate the worker context and lease.
4. Select an allowed alternate model/provider if frozen policy permits it.
5. Replan the affected work intent while preserving the condition contract.
6. Degrade only obligations declared optional before execution.
7. Emit the correct terminal certificate with a causal chain.

### P1: SQL remains inside controller and domain-facing modules

`EpisodeController` and `pipeline-contracts.ts` still know SQLite and legacy
task rows. They require semantic repositories:

- EpisodeStateRepository;
- WorkIntentRepository;
- AssignmentRepository;
- OutcomeCertificateRepository;
- TrackerProjectionPort.

The controller must become deterministic over a hydrated state snapshot plus
ports. No SQL, task IDs, log paths, or frontend fields belong in it.

### P1: Desired state and observed liveness share metadata

`engine_running` is used partly as user intent and partly as process truth.
Introduce separate fields/read models:

- engine_desired_state: running or stopped;
- engine_observed_state: starting, running, stopping, stopped, crashed;
- engine_instance_id, pid, process birth token, heartbeat, and last transition;
- terminal outcome and causal error separately.

The supervisor, not the request handler, owns observed state.

### P1: Parallel capacity is persisted but the Saga 3 pump is sequential

The selector is correctly treated as the capacity source, but the current pump
awaits one worker before admitting the next. True parallelism requires:

- select independent deficits;
- conflict claims and repository write claims;
- `effectiveCapacity = min(frontendSelection, modelLimit, policyLimit)`;
- reserve all assignments transactionally;
- launch up to effective capacity;
- consume completions independently;
- serialize integration effects even when development is parallel.

Until this scheduler exists, the UI must describe Saga 3 as effective
concurrency one instead of implying that a higher selected value is active.

### P1: Logging has no retention contract

The legacy file `~/.zcode/cli/engine-heartbeat.log` was observed at approximately
12.2 GB. It is written by the old orchestrator, not the Saga 3 pump, and was not
deleted during this audit. Logging needs a shared sink with:

- bounded file size and rotation;
- episode/generation/intent/assignment/execution correlation IDs;
- structured event type and severity;
- one lifecycle event per transition, not per tight polling cycle;
- retention and cleanup policy;
- tracker reads through a log query port, not path conventions.

### P1: Project deletion does not own Saga 3 aggregate lifecycle

Deleting the legacy project/epic/task aggregate can leave Saga 3 episode specs,
conditions, evidence, assignments, and certificates behind. This is valid only
if the product explicitly defines them as an immutable archive and provides an
archive root that no longer references the deleted legacy IDs. Otherwise they
are orphans.

The project lifecycle application service must choose and atomically enforce one
frozen policy:

- archive the project and all Saga generations under a durable project identity;
  or
- delete the complete aggregate, projections, executions, and logs through one
  explicit destructive command.

SQLite foreign keys or an application-level deletion manifest must cover both
the legacy and Saga 3 schemas. The frontend must not perform partial cleanup.

## 7. Target application components

The intended clean runtime is:

EpisodePump
  - hydrates one generation
  - calls deterministic controller
  - submits commands to ports
  - persists one transition and outbox event

DeterministicController
  - evaluates conditions
  - selects deficits
  - authorizes intents
  - evaluates terminal predicates
  - contains no SQLite, process, frontend, or logging code

RecoveryController
  - classifies incidents
  - selects a frozen recovery rung
  - enforces attempt/time/token budgets
  - proves whether a retry changed a relevant precondition

WorkerRuntimePort
  - reserves, starts, observes, stops, and fences OS processes
  - never decides condition truth

SubmissionApplicationService
  - treats all LM output as proposals
  - validates authority and lease
  - writes accepted artifacts
  - requests trusted Oracle observation
  - commits evidence and condition transition

TrackerProjection
  - consumes committed domain/runtime events
  - owns legacy task and frontend read models
  - cannot mutate control truth

LogSink
  - consumes the same committed events plus diagnostics
  - is replaceable without changing control behavior

## 8. Required implementation sequence

Slice 1, completed by this recovery:

- repair Oracle shell resolution;
- separate submission commit from process/task finalization;
- atomically coordinate runtime and tracker projection;
- hydrate terminal certificate on restart;
- version frozen policies into generation identity;
- remove frontend polling process scans and visible child windows.

Slice 2:

- define semantic state repositories;
- move all raw Saga SQL out of EpisodeController and CLI;
- make `EpisodePump` the only production application loop;
- retire the placeholder/duplicate engine path.

Slice 3:

- replace worker command strings with trusted typed Oracle recipes;
- introduce failure classification and incident fingerprints;
- connect the existing incident authority to the production pump;
- store recovery decisions and causal chains.

Slice 4:

- separate desired engine state from observed process state;
- introduce supervisor instance fencing and heartbeat expiry;
- reconcile stale executions on boot without global process scans.

Slice 5:

- implement the frontend-bounded parallel scheduler;
- add conflict claims and serialized integration;
- project actual/effective concurrency to the frontend.

Slice 6:

- introduce structured bounded logging;
- stop writing new events to legacy heartbeat files;
- provide an explicit operator migration/cleanup action for oversized historical
  logs.

## 9. Verification gates for each slice

No slice is accepted merely because it compiles.

For every state transition, verify:

- authority: exactly one component may write it;
- atomicity: no observer can see half of the transition;
- fencing: stale callbacks cannot mutate current state;
- restart: killing the process between every two writes yields a valid state;
- idempotency: repeating a command yields the same durable result;
- causality: every terminal result points to evidence and recovery decisions;
- observability: frontend state can be derived without guessing from logs;
- isolation: replacing frontend/logging does not change controller behavior.

The runtime scenario matrix must include:

- Oracle executable missing;
- Oracle timeout;
- Oracle pass, fail, and inconclusive;
- worker exits before submission;
- submission accepted before worker exit;
- worker exits non-zero after accepted evidence;
- engine killed after assignment reservation;
- duplicate and stale MCP completion;
- frontend stop during active worker;
- restart with active, failed, and terminal generations;
- model endpoint unavailable or selected model cannot load;
- concurrency changed while workers are active;
- two independent deficits and two conflicting repository writers.

This audit intentionally used static inspection, database/process observation,
and TypeScript compilation. It did not run the test suite or a live LLM episode.
