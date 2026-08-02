# Conveyor Mental Model — Saga4

The architectural metaphor that governs how the Saga conveyor moves work from
idea to release. This document captures the conceptual model so every change to
the conveyor can be checked against it. It is NOT a spec — the formal invariant
is **CGAD P18** (`cgad-v2-spec.md`); this file is the plain-language model
behind it.

## The conveyor

A product initiative moves through **stages** (Discovery → Formalization →
Development → Delivery). Each stage is run by a **module** (a swappable unit
with its own skills/specialty). Inside a module, work flows through a **Flow** of
**nodes**.

## Three entities, one primary

The conveyor has three kinds of entity. Getting their roles right is the whole
game.

| Entity | Code | Lifetime | Role |
|---|---|---|---|
| **Workplace** (место) | a **node** in a ProcessRun | durable — lives for the whole run | PRIMARY. Owns the card and the desk. |
| **Worker** (рабочий) | an LM execution (a `task` + execution fence) | one-shot — comes, works, leaves, never returns | GUEST on the workplace. |
| **Card** (карточка) | the projected `task` row | durable — belongs to the workplace | Carries the work done so far. |
| **Desk** (стол) | the execution workspace directory | durable — belongs to the workplace | Holds the worker's drafts/tools. |

### Who does what — the hard boundary

- **Worker (модель + skill):** knows ONLY how to do the work described in its
  skill. That is all. It does not hire, does not spawn, does not pick tasks,
  does not decide how many workers run, does not manage infrastructure. It
  arrives at the desk where the infrastructure has ALREADY placed the card,
  reads it, does the work, calls `worker_done`, leaves. The worker never calls
  `worker_next` — the infrastructure assigns the card before the worker arrives.
- **Infrastructure (конвейер):** hires workers, decides how many to run, picks
  tasks from the queue (review first, then todo), puts the exact card on the
  desk BEFORE the worker arrives, provides the desk, manages
  fencing/heartbeat/persistence. A module declares WHAT work its workplaces need
  (via its Flow + execution profiles); the infrastructure decides HOW to staff
  it and WHICH task each worker gets.

A module MUST NOT hire workers itself. `workerExecutorFactory`,
`runScopedTasks`, `executor.start` belong to infrastructure, never to a module.
The development module currently violates this (it reaches into
`SqliteDevelopmentRuntimeOptions.workerExecutorFactory` and spawns workers from
inside the module) — that is the leak to fix. Discovery, Formalization and
Delivery are clean: they declare LM nodes in their Flow and let the
infrastructure's `LmNodeExecutor` staff them.

### One queue, one concurrency knob, infrastructure assigns cards

There is exactly **one** queue and **one** concurrency control: `--concurrency=N`.
The **infrastructure** picks tasks from the `todo` AND `review` queue (review
first) and **assigns** each task to a hired worker. The worker never searches
for work — the infrastructure puts the exact card on the desk before the worker
arrives. No module runs its own dispatch loop, no module has a second
concurrency parameter. The queue ordering is:

1. **`review` tasks FIRST** — existing code in review gets priority so it
   reaches commit/merge faster. Never start new `todo` work while reviewed code
   is waiting.
2. **`todo` tasks** — new work, in priority then sort order.

The infrastructure (dispatch-loop) selects a task, hires a worker via
`WorkerExecutorFactory` with `claimScope.taskIds=[taskId]`, and provides the
desk. The worker reads the card, does the work, calls `worker_done`, leaves.
The worker does NOT call `worker_next` — that is the infrastructure's job.

This is already implemented in `findNextClaimable` (`dispatcher.ts:451`:
`CASE WHEN t.status = 'review' THEN 0 ELSE 1 END`). The principle: close what
is started before opening new work.

**The workplace is the primary entity.** The worker is a one-shot guest on it.
The card and the desk are property of the **workplace**, not the worker, and
survive a worker change.

## The repair mechanic (recovery)

Every workplace has a common mechanic — independent of its specialty — for
sending work back for rework:

> When a verifier (engineer / kernel node) finds a defect, a **new worker** is
> brought to the **SAME workplace**. The new worker takes the **SAME card** (with
> the work already done on it) and continues on the **SAME desk** (with the
> prior drafts). The worker fixes the defect and the verifier re-checks.

The worker never carries the card or the desk away. The next worker always finds
the workplace's card and desk waiting.

This is exactly the **physical-resume** path (`generic-flow-executor.ts`
restoreFrame), generalised to **semantic recovery**. There is one proven path,
not two.

## What this rules out (the bug this model replaced)

- ~~Recovery mints a **new card** per attempt~~ → the verifier looks at the new
  empty card, finds "no work", and the loop never converges.
- ~~Recovery gives the worker a **clean desk**~~ → the worker starts from
  scratch every round and cannot converge on a complex artifact
  (BUGS-2026-07-30 #10 "каждый запуск — чистый лист").
- ~~A gate reads the card by **worker identity**~~ → it is blinded to the
  workplace's prior work on every repair round.

## Resume must not be coupled to package digest

A run's **work** (the card's accepted artifacts/traces/submissions and the
projected tasks on the kanban) lives in the durable database, keyed by
process-run + node. It does **not** live inside the module package. The package
is the **toolset and instructions** (templates, skills, schemas, tracker rules)
the workers use — it is a separate concern from the work they produced.

A ProcessRun pins an `installation_id` + `package_digest` so a run is
reproducible against the exact bytes it started with. But this pin is an
**integrity boundary for toolset versioning**, not a gate on whether the run's
work can be resumed. When the toolset changes (e.g. a tracker rule or a skill is
updated), `PackageInstaller.installPackage` recomputes the digest and a naive
resume throws "already holds the active slot with a different package_digest" —
even though every artifact, trace, submission and task on the workplace's card
is unchanged and still valid.

The correct behaviour: **resume is about the work on the card, not the toolset
version.** If the package changed, the runtime reinstalls the new version (or
records the drift) and resumes against the existing work. The card, the desk,
the accepted artifacts, the submissions and the kanban tasks all survive a
toolset change. Coupling resume-correctness to `package_digest` equality is the
same class of mistake as coupling a gate's read to transient task identity: it
treats an ancillary identity (which tools; which worker) as if it owned the
work, when the workplace owns the work.

(In practice today this is mitigated by clearing stale installations before
resume so the new digest installs cleanly. The deeper fix is for the runtime to
tolerate a digest change on resume — reinstating the installation rather than
rejecting the resume — and record the drift for audit.)

## Why Discovery is permissive (the market is the real gate)

A user who enters a hypothesis into the conveyor wants to see it built — **even
if the conveyor's own assessment judges the idea weak**. Discovery is an
idea-strength gate, not a build gate: its job is to record how strong the idea
looks (go / clarify / reject / defer / inconclusive / failed) into the discovery
certificate, **not** to block the conveyor.

The reasoning is product-level: **the only real validation of an idea is the
market.** An expert assessment that "this idea is bad" is itself a hypothesis —
it can be wrong, and history is full of ideas experts dismissed that succeeded.
The conveyor must not impose that judgement as a hard block, because doing so
privileges one assessor's opinion over the market's verdict.

So every Discovery outcome forwards to Formalization. The strength of the idea
travels in the certificate (so downstream stages know the assessed risk), but it
never terminates the run. Formalization is the conveyor's real go/no-go gate:
it reasons about whether a *contract* can be built from the idea, and its
non-formalized outcomes terminate there — but even that is about buildability,
not about whether the idea is "good".

The strict-gate variant (non-go Discovery terminates) survives as a separate
declarative scenario package (`LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT`) for
regulated/contractual environments where an explicit go/no-go gate is legally
required. The production lifecycle is permissive by default.

## How this is enforced (CGAD P18)

- **Card reuse:** `LmNodeExecutor` computes the generationKey WITHOUT a
  per-recovery-attempt suffix, so `ensureNodeExecutionPlan` reclaims the
  workplace's existing card. (`lm-node-executor.ts`)
- **Desk stability:** the workspace directory is keyed by the **node**
  (`executions/node-<nodeId>/`), so drafts survive across workers.
  (`pinned-workspace-materializer.ts`)
- **Stable node-input hash:** the workplace's identity hash excludes the
  transient recovery loop input, so the reused card's reserved metadata compares
  equal across attempts. (`saga-board-adapter-data-builder.ts`)
- **Durable product reads:** kernel gates read managed productions by durable
  node-scope (processRunId + moduleRef + nodeId), never by transient task.
  (`formalization-installation.ts`)

Per-attempt **audit** is preserved orthogonally: each repair round records its
own `NodeRun` (keyed on process_run + node + attempt), independent of task
identity.

## Analogy key (the words we use)

- **конвейер** = the Saga runtime (orchestrator + executors + persistence)
- **цех** = a process module (discovery / formalization / development / delivery)
- **место** (workplace) = a node in a ProcessRun
- **рабочий** (worker) = an LM execution (one task, one execution fence)
- **инженер** (engineer) = a kernel node (the verifier)
- **карточка** (card) = the projected task row
- **стол** (desk) = the execution workspace directory
- **скилл** = the execution profile / semantic skill of a workplace

## Canonical factory vocabulary

The following vocabulary is normative for architecture discussions, code
reviews, tests and plans. The metaphor is useful only while every word has one
stable technical meaning.

| Factory word | Technical meaning | Owner |
|---|---|---|
| **Factory / conveyor** (завод / конвейер) | Saga Runtime: orchestration, executors, dispatch and persistence | infrastructure |
| **Production order** (заказ) | `ProcessRun` | Conveyor Runtime domain |
| **Workshop** (цех) | a Process Module package | module package |
| **Workplace** (место) | a node in one `ProcessRun` | `ProcessRun` |
| **Card** (карточка) | projected task referenced by a workplace | Work Dispatch context; semantically assigned to the workplace |
| **Desk** (стол) | node-scoped workspace directory | workplace |
| **Worker** (рабочий) | one LM execution | infrastructure |
| **Shift / attempt** (смена / попытка) | one `NodeRun` / execution attempt | runtime audit |
| **Specialty** (специальность) | execution profile and semantic skill | module declaration |
| **Engineer** (инженер) | kernel/verifier node | runtime executing module policy |
| **Dispatcher** (диспетчер) | application service assigning cards | infrastructure |
| **Queue** (очередь) | claimable `review` and `todo` cards | Work Dispatch context |
| **Pass / badge** (пропуск) | execution fence and lease token | worker execution |
| **Timesheet** (табель) | execution status, heartbeat and timestamps | infrastructure |
| **Foreman / supervisor** (мастер) | parent runner supervising one worker process | infrastructure |
| **Watchman / reaper** (вахтёр) | periodic reconciliation of active executions | infrastructure |
| **Alive signal** (отметка «жив») | structured lease heartbeat | worker execution |
| **Progress signal** (отметка «работаю») | structured output/tool/progress observation | execution journal |
| **Tools** (инструменты) | allowed capabilities exposed to a worker | execution authority |
| **Tooling** (оснастка) | installed package, resources, templates and schemas | Module Catalog context |
| **Product** (изделие) | production, artifact or submission | Production context; attributed to the workplace |
| **Defect sheet** (брак-лист) | `RecoveryIssue` | verifier output |
| **Repair case** (ремонтный случай) | `RecoveryCase` | Conveyor Runtime domain |
| **Control point** (контрольная точка) | pre/post hooks and policy enforcement | infrastructure |
| **Production journal** (журнал) | events, traces, receipts and provenance | runtime persistence |

There are two different meanings of ownership here:

- **Semantic ownership:** the workplace owns the continuity of its card, desk
  and products. Replacing the worker must not replace any of them.
- **Persistence ownership:** the Work Dispatch context owns mutation of the
  projected task row, the Workspace adapter owns filesystem materialization,
  and the Production context owns durable products. The `ProcessRun` aggregate
  holds stable references; it does not reach into another aggregate's tables.

This distinction keeps the metaphor true without creating one distributed
aggregate spanning SQLite rows, directories and external workers.

## Acceptance criteria for the factory model

These criteria define the target architecture. A criterion is not considered
implemented merely because a comment, skill or type uses the right words. It
must be enforced by a contract and covered by an executable test.

### Factory / conveyor

- Only infrastructure starts, stops and replaces workers.
- Only infrastructure owns dispatch, concurrency, leases, fencing and
  heartbeat.
- A module never imports `WorkerExecutorFactory`, calls `executor.start`, or
  runs a private dispatch loop.
- Runtime core does not switch on module names, module kinds or worker skills.
- One global `concurrency=N` limit applies to every worker-launch path.
- Restarting the runtime preserves orders, workplaces, cards, desks and
  accepted products.

### Production order (`ProcessRun`)

- A run has one durable identity and immutable original input.
- Every workplace and attempt is attributable to exactly one run.
- Resume continues the same run rather than creating a replacement run.
- Run state can be reconstructed from durable persistence after a crash.
- A terminal run cannot silently return to `running`.
- Package drift cannot erase work; any incompatibility is explicit and
  auditable.

### Workshop (Process Module)

- A module declares WHAT work is required: Flow, nodes, execution profiles,
  contracts, policies and outcomes.
- A module does not decide HOW many workers exist or HOW they are launched.
- A module does not import another module's implementation.
- Module domain and application code do not import SQLite, MCP, a model driver,
  filesystem adapters, global `getDb`, or shared concrete repositories.
- Every external operation required by a module is expressed through a port.
- A module can be tested with in-memory/fake ports and no running infrastructure.

### Workplace (node)

- Workplace identity is stable for `(processRunId, moduleRef, nodeId)`.
- Recovery attempt, worker ID and package digest are not part of workplace
  identity.
- At most one live execution lease may mutate a workplace at a time.
- Card reference, desk reference and accepted product references survive a
  worker change.
- Verifiers read products by durable node scope or exact product reference,
  never by transient worker identity.
- A repeated execution creates a new attempt record, not a new workplace.

### Card (projected task)

- Infrastructure atomically assigns the exact card before launching a worker.
- Assignment validates status, dependencies, project/run scope and authority.
- The returned `AssignedWork` contains the exact task, workplace and fence.
- A worker does not call `worker_next` and cannot browse the shared queue.
- `review` cards are assigned before any new `todo` card.
- A card with unmet dependencies cannot be assigned.
- Two dispatchers cannot assign one card to two live executions.
- Projection and restart are idempotent and do not mint duplicate cards.
- Recovery reuses the same card and its accumulated work.

### Desk (workspace)

- The workspace path is derived from durable node identity, not worker or
  attempt identity.
- Infrastructure materializes the desk before the worker starts.
- A replacement worker sees prior drafts, tools and recovery feedback.
- A worker cannot read or write the desk of another run or workplace.
- Worker completion does not delete the desk.
- Cleanup happens only through an explicit retention policy.
- Materialization is idempotent and validates path containment.

### Worker

- One launch receives exactly one `AssignedWork` value and one card.
- The worker knows its task, workplace, desk, execution ID and fence at start.
- It performs only the declared semantic specialty.
- It cannot create workers, choose concurrency, dispatch cards or manage
  infrastructure.
- It receives the minimum required tools and no queue-selection capability.
- It completes through `worker_done` and stops immediately afterwards.
- It cannot complete or mutate another worker's assigned card.
- A recovery worker is a new execution identity at the same workplace.

### Shift, pass, lease and heartbeat

- Every attempt has a unique execution ID and fence token.
- Assignment, lease creation and card status transition commit atomically.
- Every mutating worker call validates card, execution and fence.
- An expired or superseded worker cannot write or complete work.
- Launch failure releases the lease or lets it expire by a deterministic rule.
- Heartbeat belongs to an execution, not to the durable workplace.
- Missing heartbeat expires the execution but does not delete its card or desk.
- Duplicate completion is idempotent.
- The journal records `created`, `assigned`, `started`, `heartbeat`, `done`,
  `failed`, `expired` and `superseded` transitions.

### Foreman, watchman and escaped/tired workers

The factory distinguishes failures that look similar from the queue but require
different evidence and actions:

| Factory condition | Technical evidence | Required action |
|---|---|---|
| Worker left normally | supervised child `close` callback | terminalize execution; accept completion or recover unfinished card |
| Worker died / escaped | local PID is absent or PID birth token changed | mark `lost`; atomically revoke fence and return card |
| Foreman died | execution lease is expired and no trusted supervisor owns it | reaper performs fenced recovery; a new foreman may launch replacement |
| Worker is alive but silent | PID/lease alive, no progress events | observe and alert; do not immediately reassign |
| Worker is stuck / exhausted | progress silence exceeds policy and cancellation grace or wall-clock deadline | request cancellation, then verified termination and fenced recovery |
| Worker is remote | local PID cannot be verified | decide from durable lease heartbeat; never kill or release from PID guess |

The supervisor and reaper have separate responsibilities:

- The **foreman** owns the child-process callback. It records start, periodically
  renews the execution lease, observes output/tool activity, and handles normal
  `close`/`error` events.
- The **watchman** runs independently at startup and periodically while the
  conveyor is alive. It scans durable active executions and reconciles crashed
  foremen, dead workers, expired reservations and cancellation timeouts.
- Reconciliation is idempotent and uses the same atomic release primitive as
  the child `close` callback. A close/reaper race must have one effective
  winner.

There are two different signals:

- **Liveness heartbeat:** "the supervisor still owns this execution". This is
  a structured lease renewal persisted in the database. It must not depend on
  the language model remembering to call a tool.
- **Progress heartbeat:** "the worker produced observable activity". It may be
  updated from stdout, model stream events, tool hooks and accepted tool calls.
  It is useful for stuck detection but is not, by itself, authority to mutate.

A text `worker-heartbeat.log` is observability only. It may drive a dashboard,
but cannot be the source of truth for lease ownership or automatic release:
log writes can be buffered, paths can differ, and the whole host can disappear.

Safe automatic recovery requires all of the following:

- `worker_executions` stores `lease_expires_at`, `heartbeat_at`,
  `progress_at`, PID, machine ID and process birth token.
- A local dead-process decision compares PID **and** process birth token so PID
  reuse cannot kill an unrelated process.
- An alive-but-silent process is not released solely because `progress_at` is
  old. The policy first records `suspected_stuck`, requests cancellation, waits
  a grace period, then terminates only a verified process identity.
- The hard wall-clock deadline is explicit per execution profile. Legitimate
  long model inference is not confused with death.
- Terminalizing the execution, clearing the task fence and restoring
  `todo`/`review` happen in one transaction with compare-and-set on
  `current_execution_id`.
- A stale execution can never clear a newer execution's fence.
- Automatic recovery emits a system command/event such as
  `ObserveProcessExited`, `ObserveLeaseExpired` or `WorkerExecutionReaped`, plus
  `TaskReleased`. `AdminOverrideLifecycle` is reserved for an authenticated
  human override with a reason; automation must not impersonate an admin.
- Repeated scans are no-ops after the first successful terminal transition.

### Specialty, tools and authority

- A module declares a semantic skill and requested capabilities.
- Infrastructure resolves requested capabilities to installed tools.
- Allowed tools are bound to the assigned execution and fence.
- Pre-tool authorization rejects operations outside task, workplace or product
  scope.
- Skills explain domain work, not dispatch or infrastructure mechanics.
- Tool availability is versioned and visible in the execution receipt.

### Engineer, verification and repair

- A verifier evaluates durable products; it does not redo the producer's work.
- Verification is reproducible from stored inputs and exact product references.
- A defect produces a structured `RecoveryIssue` with findings, subject refs,
  acceptance criteria, allowed changes and required tools.
- A defect opens or advances one `RecoveryCase` for the same workplace.
- Repair brings a new worker to the same card and desk.
- Successful verification resolves the active repair case.
- Exhausted recovery produces an explicit `failed` or `paused` outcome.

### Products and production journal

- Every product has a schema, durable reference and content hash.
- Every artifact, submission, trace and receipt has workplace and attempt
  provenance.
- Accepted products cannot be silently overwritten.
- Consumers read by exact reference/hash or durable node scope, never by
  "latest worker" heuristics.
- Hash and schema are checked at trust boundaries.
- `NodeRun` preserves per-attempt audit independently of card identity.
- The journal is append-only or provides equivalent tamper-evident history.

### Tooling and package digest

- A package contains instructions and tools, not the work produced with them.
- Installation bytes and resource indexes have verifiable digests.
- A run records which installation it used for every attempt.
- Package drift is recorded as an audit event.
- Drift does not replace cards, desks or accepted products.
- Resume reinstalls a compatible toolset or reports explicit incompatibility;
  raw digest inequality alone is not loss of work.

### Hooks / control points

- A pre-launch hook runs after committed assignment and before process launch.
- Hooks receive an immutable execution context and cannot secretly select a
  different card.
- Workspace hooks validate existence, ownership and containment of the desk.
- Authority hooks bind allowed tools to task, execution and fence.
- Pre-tool hooks fail closed for unauthorized mutations.
- Post-tool hooks persist receipt and provenance without changing domain truth.
- Completion hooks validate Definition of Done before accepting `worker_done`.
- Hook retry is idempotent and its fail-open/fail-closed policy is explicit.
- Modules may declare hook policy; infrastructure executes lifecycle hooks.

### Mandatory end-to-end scenarios

1. Two dispatcher processes racing for one card yield exactly one assignment.
2. With `concurrency=3`, no more than three workers run and at least two run
   concurrently when two cards are available.
3. A worker starts with a committed task ID and has no `worker_next` tool.
4. Worker crash preserves the card, desk and already persisted products.
5. Recovery gives a new execution the same card and workspace.
6. A superseded worker cannot mutate the workplace after recovery begins.
7. A verifier sees products made by every prior accepted attempt.
8. Package digest drift does not block a compatible resume.
9. Runtime restart does not duplicate cards or active leases.
10. Review work drains before new todo work begins.
11. A module test runs without SQLite, MCP, filesystem or a real LM.
12. Architecture tests reject new outward domain dependencies and
    implementation-to-implementation module imports.
13. Killing a worker process without a `close` callback causes the periodic
    reaper to mark it lost and return its card to the correct queue.
14. Killing the parent runner causes lease expiry and recovery by a new runtime
    instance.
15. A live worker with no tool activity is not reassigned before cancellation
    grace or its wall-clock deadline.
16. A reused PID with a different birth token is never treated as the original
    worker and is never killed.
17. Child-close and reaper racing on the same execution produce one terminal
    transition and one effective `TaskReleased` event.

## DDD interpretation

The factory metaphor supplies a ubiquitous language and several invariants. It
does not, by itself, define transaction boundaries or justify one large
"Factory" aggregate. Strategic and tactical DDD boundaries are defined below.

### Bounded contexts

#### 1. Conveyor Runtime

Owns `ProcessRun`, workplace progression, Flow transitions, attempts,
recovery policy and recovery cases. It decides which workplace is ready, but
delegates card assignment and physical worker launch through ports.

#### 2. Work Dispatch

Owns projected task state, queue ordering, dependency readiness, atomic
assignment, leases, liveness reconciliation and completion state transitions.
Its public language is `Card`, `Assignment`, `Lease`, `Fence`, `AssignedWork`
and `WorkerExecution`.

#### 3. Module Contracts

Owns process-module definitions, Flow/node declarations, execution profiles,
input/output contracts and module outcomes. Module packages are plugins of this
context, not infrastructure services.

#### 4. Production and Evidence

Owns immutable product references, artifacts, submissions, traces, acceptance
receipts and provenance. It exposes exact-ref and durable-node-scope reads.

#### 5. Module Catalog and Installation

Owns manifests, resources, package digests, dependency locks, installation
activation and drift audit. It does not own ProcessRun work.

#### 6. Lifecycle Composition

Owns stage bindings and routing between module outcomes. It references module
contracts and installed identities, never concrete module implementations.

### Aggregates and invariants

| Aggregate root | Internal state / references | Transactional invariants |
|---|---|---|
| `ProcessRun` | workplace progress, active node, outcome, active recovery ref | valid Flow transition; one active recovery route; terminal is final |
| `Card` | status, dependencies, priority, assignment ref | review-first selection; dependencies met; one live assignment |
| `WorkerExecution` | assignment, fence, lease, heartbeat, terminal status | unique fence; only live execution mutates; terminal transition once |
| `RecoveryCase` | issue, attempts, resolution/exhaustion | same workplace; bounded attempts; one active case per policy |
| `Product` | schema, ref, hash, provenance, acceptance | immutable identity; verified hash; exact provenance |
| `ModuleInstallation` | manifest, resources, digest, active/retired state | digest integrity; one active compatible slot; drift audited |

`Workplace` is a durable entity inside the `ProcessRun` model. It stores
references to `Card`, `Desk` and `Product`; those resources are changed through
their owning contexts. Cross-context consistency uses application-level
orchestration, idempotency keys and an outbox/event journal, not a database
transaction spanning filesystem and model processes.

### Domain services and policies

- `FlowTransitionPolicy` validates workplace transitions.
- `DispatchPriorityPolicy` orders review before todo.
- `RecoveryPolicy` decides repair, pause or fail from a structured issue.
- `LeaseExpiryPolicy` determines when an execution loses authority.
- `ResumeCompatibilityPolicy` evaluates package/contract compatibility.
- `ProductAcceptancePolicy` validates schema, hash and provenance.

These policies must be pure. Reading SQLite, inspecting directories, launching
a model and publishing MCP tools belong to adapters.

## Hexagonal architecture

Dependency direction is always inward:

```text
CLI / MCP / scheduler / tests                 inbound adapters
                 |
                 v
DispatchWork / ExecuteNode / CompleteWork     application use cases
RecoverWorkplace / ResumeProcessRun
                 |
                 v
ProcessRun / Card / WorkerExecution           domain model and policies
RecoveryCase / Product / Installation
                 ^
                 |
repositories / launcher / workspace ports     outbound ports
                 ^
                 |
SQLite / LM driver / filesystem / package     outbound adapters
```

### Required inbound use cases

- `StartProcessRun`
- `AdvanceProcessRun`
- `DispatchAvailableWork`
- `ExecuteAssignedWork`
- `RecordHeartbeat`
- `CompleteAssignedWork`
- `RecordVerification`
- `RecoverWorkplace`
- `ResumeProcessRun`
- `ExpireWorkerExecution`
- `RenewWorkerLease`
- `ObserveWorkerProgress`
- `ReconcileWorkerExecutions`

MCP handlers, CLI commands and schedulers call these use cases. They do not
contain SQL or domain transition logic.

### Required outbound ports

> **Updated by ADR-022 (2026-08-02): module-local ports over global catalog.**
> The responsibilities below are MANDATORY, but they no longer live in a single
> global `ports/` file. Each responsibility is owned by the module that
> implements it; the module-local interface is the canonical declaration. Only
> `IdGeneratorPort` remains a global port, because identity creation spans every
> conveyor module. See `docs/architecture/decisions/022-module-local-ports-over-global-catalog.md`
> for the per-port live location and the evidence that drove the inversion.

Names may follow repository conventions, and **declarations may live at the
module boundary rather than in a shared catalog** (ADR-022). Responsibilities
must remain separate. The responsibility→live-location map:

| Responsibility | Canonical declaration |
| --- | --- |
| Assign / renew / complete / expire work | `WorkAssignmentPort` — `application/ports/worker-executor.ts` |
| Launch / stop a worker process | `ClaudeBoardRunner` run-lifecycle surface — `tracker-view/claude-runner.mjs` |
| Supervise (lease renewal, progress, exit, reconcile) | `startWorkerSupervision` + runtime repo + `reconcileWorkerExecutions` — `infrastructure/work/worker-supervision-service.ts`, `worker-executions.ts` |
| Materialize the desk / write recovery feedback | `materializePinnedWorkspace` — `process-modules/application/pinned-workspace-materializer.ts` |
| Read / append immutable products | `ProcessProductRepository(V2)` SPI — `process-modules/persistence/` |
| Resolve module selectors to installed entries | `PackageRegistry` SPI — `process-modules/installation/domain/package-registry.ts` |
| Append-only journal (receipts / events) | `command_receipts` via `lifecycle/idempotency.ts` |
| Inspect OS process liveness (read-only) | `ProcessProbe` — `worker-executions.ts` (the domain never calls `process.kill`) |
| Generate ids (cross-module) | `IdGeneratorPort` — `application/ports/conveyor-ports.ts` (the ONE global port) |

The illustrative interface shapes that previously appeared here (worked
examples of `WorkAssignmentPort`, `WorkerLauncherPort`,
`WorkerSupervisionPort`, `WorkspacePort`, `ProductRepositoryPort`) are
preserved in the git history and in ADR-022's context; they are NOT a
requirement that all five be re-declared in one shared file. The
responsibility matters, not the file it lives in.

Additional repositories are formalized at their module boundary:
`ProcessRunRepository`, `NodeRunRepository`, `RecoveryCaseRepository`, and
`ModuleInstallationRepository`. `ClockPort` is intentionally NOT a global port
(ADR-022): temporal logic that needs determinism uses a narrow local clock
(FU-D's `SupervisionClock`), not a conveyor-wide abstraction.

### Adapter rules

- SQLite adapters implement repositories and atomic assignment transactions.
- The LM/Claude runner implements `WorkerLauncherPort` only.
- Filesystem code implements `WorkspacePort` only.
- MCP is an inbound adapter plus tool adapters; it is not the domain API.
- Composition root is the only place allowed to construct concrete adapters.
- Domain and application tests use fakes implementing the same ports.

## Refactoring plan

This plan changes the system incrementally. Every wave must leave the repository
buildable and must add enforcement before removing the old path.

### Current baseline (2026-08-01)

This is a dated migration baseline, not a permanent description of the system.
Delete each item when the corresponding executable acceptance test proves it is
gone.

- `LmNodeExecutor` and the application dispatch loop pass
  `claimScope.taskIds=[taskId]`, but production Development and Formalization
  skills still instruct workers to call `worker_next`. Assignment is therefore
  not yet consistently infrastructure-owned.
- `app/dispatch-loop.ts` reads claimable rows separately from assignment and
  launches its selected batch through a blocking loop. It does not yet provide
  an atomic select-and-assign boundary or real bounded parallelism.
- Module implementations still contain direct `getDb`, `Sqlite*`, shared
  concrete repository and cross-module imports.
- The dependency-direction ratchet contains an allowlist of known violations;
  a green ratchet means "no unapproved regression", not "clean architecture".
- CGAD P18 tests already protect stable node-input identity, separate recovery
  feedback and card generation-key reuse. These protections must remain green
  throughout every wave.
- Resume-tolerant package replacement exists as an option, but compatibility
  and drift handling are not yet one mandatory application policy.
- `worker-executions.ts` already contains PID/birth-token checks,
  `reconcileWorkerExecutions()` and atomic fenced task release; the runner also
  handles child `close`. However, the `ExecutionRuntimeRepository.reconcile()`
  port has no production scheduling call, so crash recovery is not a running
  watchman yet.
- Existing worker heartbeat text is observability, while
  `phase_updated_at` changes only on lifecycle phases. There is no durable
  periodic lease heartbeat or separate progress timestamp for a remote/dead
  foreman and an alive-but-stuck worker.
- `AdminOverrideLifecycle` exists in domain vocabulary but is not the correct
  automated reaper path and is not a production recovery tool.

### Wave 0 — Baseline and architecture gate

**Work**

- Make one `test:architecture` command run dependency-direction, conveyor,
  dispatcher-race and P18 suites.
- Fix current unallowlisted and stale dependency-ratchet entries; do not hide
  new violations by expanding the allowlist without a dated removal owner.
- Add characterization tests for current assignment, completion, recovery and
  resume behaviour.

**Exit criteria**

- Architecture command is green and required by CI.
- The allowlist count is printed and can only shrink.
- Current behaviour has reproducible race and recovery fixtures.

### Wave 1 — Domain contracts and ubiquitous language

**Work**

- Introduce driver-neutral IDs/value objects: `WorkplaceRef`, `CardRef`,
  `ExecutionId`, `FenceToken`, `Lease`, `DeskRef`, `ProductRef`.
- Define `AssignedWork` as the only worker launch input.
- Extract the pure policies listed above.
- Resolve the overloaded word `task`: card means projected work; execution
  means a one-shot worker attempt.

**Exit criteria**

- Domain packages import no adapters.
- Invalid transitions and mismatched references are rejected by unit tests.
- No new public contract calls a worker execution a task.

### Wave 2 — Atomic work assignment

**Work**

- Add `WorkAssignmentPort`.
- Implement one SQLite transaction that selects review-first, verifies
  dependencies, assigns the card, creates lease/fence and returns
  `AssignedWork`.
- Replace separate `readClaimableTasks` plus later worker claim with the port.
- Add database constraints or compare-and-set guards for one live assignment.

**Exit criteria**

- The card is committed as assigned before `WorkerLauncherPort.start`.
- Two processes racing for one card produce one winner.
- Unmet dependencies and cross-project cards are never assigned.
- Review-first ordering is verified under concurrency.

### Wave 3 — Worker receives work; worker does not dispatch

**Work**

- Change all launchers to accept `AssignedWork`.
- Remove `worker_next` from worker allowed tools and capability packages.
- Remove `worker_next` instructions from Development and Formalization skills.
- Keep a temporary compatibility adapter only at the infrastructure boundary,
  instrument every use, and set a removal date.

**Exit criteria**

- Production workers start with exact card, desk and fence.
- Calling `worker_next` from an assigned execution is impossible.
- One launch processes one card and stops after `worker_done`.
- Compatibility-path usage is zero in end-to-end tests.

### Wave 4 — One dispatcher and real global concurrency

**Work**

- Route Flow LM nodes and Development implementation cards through one
  application dispatch service.
- Replace blocking sequential loops with a bounded async worker pool.
- Apply one global concurrency budget across all launch paths.
- Define deterministic launch-failure, cancellation and shutdown behaviour.

**Exit criteria**

- At most `N` workers run globally.
- When two cards exist and `N >= 2`, executions overlap in time.
- No module owns a dispatch loop or secondary concurrency option.
- Shutdown leaves no permanently assigned orphan card.

### Wave 5 — Stable desks, hooks, supervision and zombie reaping

**Work**

- Put all workspace creation behind `WorkspacePort` and key it by workplace.
- Define typed pre-launch, pre-tool, post-tool and completion hook contracts.
- Centralize heartbeat, fence validation and execution journal transitions.
- Ensure recovery feedback is materialized separately from identity input.
- Add durable lease and progress columns and a supervisor-owned periodic lease
  renewal independent of model behaviour.
- Schedule reconciliation on runtime startup and at a bounded interval with a
  single-flight/advisory lock.
- Route child close, dead PID, expired lease and cancellation timeout through
  the same atomic fenced release application service.
- Add stuck policy: observe, request cancel, wait grace, then terminate only
  after PID birth verification or lease-authority proof.

**Exit criteria**

- Replacement workers receive the same directory and prior drafts.
- Path-containment and cross-run isolation tests pass.
- Stale fences fail every mutating tool call.
- Hook retries do not duplicate products or completion.
- A dead process and a dead supervisor return unfinished work without operator
  intervention.
- A merely silent but live model is not falsely reaped.
- Reaper activity has system audit events; human override remains separate.
- Reaper keeps running independently of the tracker UI and worker process.

### Wave 6 — Recovery and resume convergence

**Work**

- Use the same workplace/card/desk path for physical resume and semantic
  repair.
- Persist structured `RecoveryIssue` and bounded `RecoveryCase` attempts.
- Make verifiers read exact refs or durable workplace productions.
- Remove execution-scoped product lookup fallbacks.

**Exit criteria**

- Recovery never creates a replacement card or clean desk.
- A new execution fixes work from a prior attempt and the verifier sees it.
- Exhaustion deterministically pauses or fails according to policy.
- P18 and full recovery end-to-end tests pass.

### Wave 7 — Isolate modules behind ports

**Work**

- Remove `getDb`, `Sqlite*`, shared concrete repositories and cross-module
  implementation imports from Development, Delivery and Formalization.
- Define module-local application ports where the shared runtime vocabulary is
  insufficient.
- Move concrete construction to the composition root.
- Replace lifecycle imports of module implementations with contract/package
  references.

**Exit criteria**

- Module domain/application code has zero infrastructure imports.
- Each module runs contract tests with fake ports.
- Dependency ratchet has no Rule 1–3 allowlist entries.
- Adding a synthetic module requires no runtime-core modification.

### Wave 8 — Package drift and product integrity

**Work**

- Make resume compatibility an explicit policy rather than raw digest equality.
- Record old/new installation identity for each resumed attempt.
- Verify product schema/hash independently of installed package bytes.
- Define explicit incompatible-upgrade pause and operator action.

**Exit criteria**

- Compatible drift resumes the same run, card and desk.
- Incompatible drift pauses without mutating existing work.
- Audit shows exactly which toolset produced every attempt.

### Wave 9 — Cutover and legacy removal

**Work**

- Delete worker-driven claim, duplicate dispatchers, execution-scoped product
  reads and obsolete compatibility adapters.
- Remove stale skills, comments, capability declarations and tests describing
  the old model.
- Make the mandatory end-to-end scenarios above release gates.

**Exit criteria**

- Repository search finds no production worker instruction to call
  `worker_next`.
- There is one assignment port, one launcher path and one concurrency budget.
- Architecture allowlists for the migrated boundaries are empty.
- All factory-model acceptance criteria are executable or linked to an issue
  with an explicit owner; no criterion is claimed by prose alone.

## Architecture review questions

For every class, function, table and tool, ask:

1. Is this describing workshop work, workplace state, or factory physics?
2. Who owns its state and transaction boundary?
3. Does it depend only inward, through a declared port?
4. Is identity durable workplace identity or transient execution identity?
5. Is the card assigned before the worker starts?
6. Can a replacement worker see the same card, desk and products?
7. Can a stale worker still mutate anything?
8. Are hooks enforcing policy or secretly making domain decisions?
9. Is tracking an audit record, or is code incorrectly treating it as domain
   truth?
10. Who detects a dead worker when its parent runner also died?
11. Is the evidence liveness, progress, or merely an observability log?
12. Which executable test proves the claimed invariant?

If one component selects a card, starts a worker, writes SQL, manipulates the
workspace and makes a domain decision, the boundaries are broken even if the
component is named "service" or "executor".
