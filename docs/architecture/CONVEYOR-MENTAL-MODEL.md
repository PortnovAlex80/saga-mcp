# Conveyor Mental Model — Saga4 (Version 2)

The architectural metaphor that governs how the Saga conveyor moves work from
idea to release. This document captures the conceptual model so every change to
the conveyor can be checked against it. It is NOT a spec — the formal invariant
is **CGAD P18** (`cgad-v2-spec.md`); this file is the plain-language model
behind it.

**Version 2** supersedes the original. The refactoring waves (0–9) are
complete; the plan has been removed. A new core analogy — **one machine, one
material, one desk** — is introduced to clarify why the conveyor is
universal across all workshops.

## The one-machine factory

The Saga conveyor has **one machine**: a language model. It has **one
material**: text. It produces **one kind of product**: text artifacts.

This sounds trivial until you realise what it means for the architecture:

| Workshop | What the LM produces | Physical form |
|---|---|---|
| Discovery | Proposal, readiness assessment, certificate | Text (JSON/Markdown) |
| Formalization | PRD, UC, AC, SRS, FR, NFR | Text (JSON/Markdown) |
| Development | Code, tests, review comments | Text (source files) |
| Delivery | Release record, observations | Text (JSON) |

A proposal, a PRD and a TypeScript module are **the same physical entity**: a
text artifact with a schema and a content hash. The schema differs
(`saga3.discovery-proposal.v1` vs `saga3.formalization-product-bundle.v1` vs
`text/x-typescript`) — but that is **data polymorphism, not mechanism
polymorphism**.

**This is why there is one desk, not four.** The conveyor does not have a
"proposal desk", a "PRD desk" and a "code desk". It has **one desk**:
`WorkplaceProduct(processRunId, nodeId, schema, ref, hash)`. Every worker —
regardless of workshop — places text on the same desk. Every kernel engineer —
regardless of workshop — reads from the same desk.

### The LEGO principle

A workshop (цех) is a **pure declaration** — a package of skills, profiles,
policies and schemas. It contains **zero runtime code** for:

- How workers are hired, dispatched or supervised.
- Where products are stored or read from.
- How review works or recovery triggers.
- Which table receives a submit.

The workshop declares **WHAT** (Flow, execution profiles, schemas, policies).
The factory runtime decides **HOW** (dispatch, desk, review, recovery).

Adding a new workshop means writing a new package (skills + profiles + Flow
declaration). It does NOT mean:
- Adding a new `*_submit` tool.
- Adding a new table.
- Adding a new resolver that reads from that table.
- Adding a `task_kind === 'myModule.*'` switch anywhere.

If any of those steps is required, the LEGO contract is broken.

### One desk, one submit, one read

```
Worker (any workshop)
  │
  ▼
submitWork({ schema, ref, content })     ← ONE universal submit
  │
  ▼
workplace_products table                 ← ONE desk
  (processRunId, nodeId, schema,
   ref, hash, executionRef)
  │
  ▼
readWorkplaceOutput(processRunId, nodeId) ← ONE universal read
  │
  ▼
Kernel engineer / next node (any workshop)
```

The `schema` field distinguishes the **type of text** (proposal, PRD, code).
The runtime does not switch on schema to decide where to store or read — it
stores and reads uniformly. The kernel engineer validates the schema
declaratively (via the module's declared `outputSchema`), not by branching on
module name.

### Historical record: four parallel desks (the design mistake)

The original implementation was built workshop-by-workshop. Each workshop
received its **own submit tool, its own table and its own resolver** — because
the designers thought the workshops produced *different kinds of entities*:

| Workshop | What designers thought it produced | Actual physical product | Dedicated desk |
|---|---|---|---|
| Discovery | "A proposal" | Text (JSON) | `saga3_proposals` |
| Formalization | "Artifacts (PRD, UC, AC, SRS)" | Text (JSON/Markdown) | `saga3_managed_artifact_productions` |
| Development | "A submission" | Text (JSON task graph) | `saga3_managed_node_submissions` |
| Delivery | "Release records" | Text (JSON) | `saga3_delivery_*` |

The mistake was **domain-driven table design**: each workshop's domain
vocabulary ("proposal", "artifact", "submission") became a separate table,
when the physical reality is that **every product is text with a schema**.
The designers conflated *what the text means* (domain semantics) with *what
the text is* (a workplace product that the conveyor moves between nodes).

**The proof that this was a mistake** — and the proof that the Saga pipeline
is fundamentally one mechanism, not four — is that the refactoring described
in this document (Waves 0–9) made every workshop work through the same:

- Same dispatch-loop and atomic card assignment (Wave 2).
- Same `AssignedWork` launch input (Wave 3, Slice 1).
- Same review-pause-resume lifecycle (the `review_skill` declarative gate).
- Same recovery mechanic (RecoveryIssue → same card, same desk).
- Same pure stuck-policy (Wave 2 FU-D).
- Same cross-process lease (Wave 5).

The only thing that remains **non-universal** is the four separate desks
(four tables, four submit tools, four resolvers). These are the last
vestige of the per-workshop design. The conveyor already moves cards, hires
workers, manages review and handles recovery identically for every workshop.
The desk unification is the final step to make the LEGO model complete:
**one machine, one material, one desk**.

This historical record is preserved so future architects understand **why**
there are four tables and **why** they should become one — not because the
domains differ, but because the domains were mistaken for different materials
when they are all text.

> **Current status:** Discovery (`proposal_submit` → `saga3_proposals`),
> Formalization (`artifact_create` bridge → `saga3_managed_artifact_productions`),
> Development (`process_node_submit` → `saga3_managed_node_submissions`) and
> Delivery (kernel-only) each use their own desk. All four are proven to work
> end-to-end with real GLM 4.7 (the Sprint Velocity Calculator run demonstrated
> Discovery → Formalization → review → recovery → resume). The four desks are
> the largest remaining architectural debt.

## The conveyor

A product initiative moves through **stages** (Discovery → Formalization →
Development → Delivery). Each stage is run by a **module** (a swappable unit
with its own skills/specialty). Inside a module, work flows through a **Flow**
of **nodes**.

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

### One queue, one concurrency knob, infrastructure assigns cards

There is exactly **one** queue and **one** concurrency control:
`--concurrency=N`. The **infrastructure** picks tasks from the `todo` AND
`review` queue (review first) and **assigns** each task to a hired worker. The
worker never searches for work — the infrastructure puts the exact card on the
desk before the worker arrives. No module runs its own dispatch loop, no module
has a second concurrency parameter. The queue ordering is:

1. **`review` tasks FIRST** — existing code in review gets priority so it
   reaches commit/merge faster. Never start new `todo` work while reviewed code
   is waiting.
2. **`todo` tasks** — new work, in priority then sort order.

The infrastructure (dispatch-loop) selects a task, hires a worker via
`WorkerExecutorFactory`, and provides the desk. The worker reads the card, does
the work, calls `worker_done`, leaves.

**The workplace is the primary entity.** The worker is a one-shot guest on it.
The card and the desk are property of the **workplace**, not the worker, and
survive a worker change.

### Review is universal, not module-specific

When a worker finishes, the task routes to `review` or `done` based on a
**declarative field** (`review_skill` on the execution profile), not on a
hardcoded module-name check:

- `review_skill IS NULL` → `done` immediately (tracker-only tasks, e.g. Discovery).
- `review_skill IS SET` → `review` buffer. The LM-executor detects `review`,
  pauses the run, and the dispatch-loop hires a reviewer. After the reviewer
  approves, the run resumes and the kernel resolver re-reads with both
  receipts.

This is the same mechanism for **every** workshop. There is no
`if (task_kind.startsWith('discovery.'))` switch. The runtime core does not
switch on module names, module kinds or worker skills.

## The repair mechanic (recovery)

Every workplace has a common mechanic — independent of its specialty — for
sending work back for rework:

> When a verifier (engineer / kernel node) finds a defect, a **new worker** is
> brought to the **SAME workplace**. The new worker takes the **SAME card**
> (with the work already done on it) and continues on the **SAME desk** (with
> the prior drafts). The worker fixes the defect and the verifier re-checks.

The worker never carries the card or the desk away. The next worker always
finds the workplace's card and desk waiting.

The defect sheet (`RecoveryIssue`) is delivered **on the desk** — in
`task.metadata.recovery_feedback` — not through prompt regeneration. The new
worker reads the defect sheet alongside the prior drafts and understands what to
fix.

## What this rules out (the bug this model replaced)

- ~~Recovery mints a **new card** per attempt~~ → the verifier looks at the new
  empty card, finds "no work", and the loop never converges.
- ~~Recovery gives the worker a **clean desk**~~ → the worker starts from
  scratch every round and cannot converge on a complex artifact.
- ~~A gate reads the card by **worker identity**~~ → it is blinded to the
  workplace's prior work on every repair round.
- ~~Runtime core **switches on module names**~~ → adding a workshop requires
  editing dispatcher/lifecycle code instead of just writing a package.

## Resume must not be coupled to package digest

A run's **work** (the card's accepted artifacts/traces/submissions and the
projected tasks on the kanban) lives in the durable database, keyed by
process-run + node. It does **not** live inside the module package. The package
is the **toolset and instructions** (templates, skills, schemas, tracker rules)
the workers use — it is a separate concern from the work they produced.

## Why Discovery is permissive (the market is the real gate)

A user who enters a hypothesis into the conveyor wants to see it built — **even
if the conveyor's own assessment judges the idea weak**. Discovery is an
idea-strength gate, not a build gate: its job is to record how strong the idea
looks (go / clarify / reject / defer / inconclusive / failed) into the discovery
certificate, **not** to block the conveyor.

So every Discovery outcome forwards to Formalization. The strict-gate variant
(non-go Discovery terminates) survives as a separate declarative scenario
package for regulated/contractual environments.

## How this is enforced (CGAD P18)

- **Card reuse:** `LmNodeExecutor` computes the generationKey WITHOUT a
  per-recovery-attempt suffix, so the workplace's existing card is reclaimed.
- **Desk stability:** the workspace directory is keyed by the **node**
  (`executions/node-<nodeId>/`), so drafts survive across workers.
- **Stable node-input hash:** the workplace's identity hash excludes the
  transient recovery loop input.
- **Durable product reads:** kernel gates read products by durable node scope
  (processRunId + moduleRef + nodeId), never by transient task identity.

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
| **Product** (изделие) | text artifact placed on the desk by a worker | Production context; attributed to the workplace |
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

### One machine, one material, one desk

- Every LM worker — in every workshop — places text artifacts on **one desk**:
  a `workplace_products` table keyed by `(processRunId, nodeId)`.
- There is **one universal submit tool** (`submitWork`) that every worker uses,
  regardless of workshop. Schema distinguishes the payload type; the mechanism
  is identical.
- There is **one universal read** (`readWorkplaceOutput`) that every kernel
  engineer uses, regardless of workshop.
- The runtime does not branch on `task_kind`, `schema` or `module name` to
  decide where to store or read a product.
- A workshop declares its `outputSchema` declaratively; the runtime validates
  against it without executing workshop-specific code.

> **Status:** This is the target. The current implementation has four separate
> desks (see "Known gap" above). Unifying them is the primary architectural
> debt.

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
18. A worker in any workshop places its product on the same universal desk;
    the next workshop's engineer reads it from the same desk without a
    module-specific adapter.

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

> **ADR-022 (2026-08-02): module-local ports over global catalog.**
> Responsibilities are MANDATORY but declared at the module boundary. Only
> `IdGeneratorPort` remains global.

| Responsibility | Canonical declaration |
| --- | --- |
| Assign / renew / complete / expire work | `WorkAssignmentPort` — `application/ports/worker-executor.ts` |
| Launch / stop a worker process | `ClaudeBoardRunner` — `tracker-view/claude-runner.mjs` |
| Supervise (lease renewal, progress, exit, reconcile) | `startWorkerSupervision` + `reconcileWorkerExecutions` |
| Materialize the desk / write recovery feedback | `materializePinnedWorkspace` |
| Read / append immutable products | `ProcessProductRepository(V2)` SPI |
| Resolve module selectors to installed entries | `PackageRegistry` SPI |
| Append-only journal (receipts / events) | `command_receipts` via `lifecycle/idempotency.ts` |
| Inspect OS process liveness (read-only) | `ProcessProbe` — `worker-executions.ts` |
| Generate ids (cross-module) | `IdGeneratorPort` |

`ClockPort` is intentionally NOT a global port (ADR-022): temporal logic that
needs determinism uses a narrow local clock (`SupervisionClock`).

### Adapter rules

- SQLite adapters implement repositories and atomic assignment transactions.
- The LM/Claude runner implements the worker-launch surface only.
- Filesystem code implements workspace materialization only.
- MCP is an inbound adapter plus tool adapters; it is not the domain API.
- Composition root is the only place allowed to construct concrete adapters.
- Domain and application tests use fakes implementing the same ports.

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
13. **Is this a module-specific desk/submit/read, or the universal one?** If
    module-specific — why does this workshop need its own desk when every
    product is text?
14. **Does runtime code switch on `task_kind` or module name?** If yes — the
    LEGO contract is broken; the decision should come from a declared profile.

If one component selects a card, starts a worker, writes SQL, manipulates the
workspace and makes a domain decision, the boundaries are broken even if the
component is named "service" or "executor".
