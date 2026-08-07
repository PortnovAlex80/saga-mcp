# Conveyor Mental Model — Saga4 (Version 4.1)

This document is the plain-language architectural model for the Saga conveyor.
The formal invariant remains **CGAD P18** (`cgad-v2-spec.md`). Every runtime,
module, test and recovery change should be checked against this model.

The governing analogy is now:

> **one production interface, one material, one desk, one factory runtime**

A workshop is a declarative arrangement of Production Cells. It is not a
private engine, queue, state machine, product store or submit protocol.

---

## 1. One production interface, one material, one desk

Saga does not fundamentally care whether a worker is backed by GLM, Claude,
Qwen, LM Studio or a deterministic replay executor.

The factory sees one thing:

```text
WorkerExecution
  -> reads exact input ProductRefs
  -> produces text / canonical JSON / TextSet / patch products
  -> submits through the normal worker protocol
  -> leaves one immutable CandidateSet
```

The **physical worker implementation is replaceable**. The production contract
is not.

The material crossing the worker boundary is text or a content-addressed set of
text documents. A proposal, PRD, SRS, TypeScript file, review verdict and
verification report are therefore different schemas of the same physical
material.

External actions are different. Compilation, tests, Git integration, publish,
deploy and other effects are performed by deterministic kernel/provider ports.
The worker may produce a textual desired-state product, but it never gains
transition or effect authority merely by producing text.

### Product identity

The core treats a product as an opaque content-addressed envelope:

```text
ProductEnvelope {
  ref: ProductRef
  mediaType
  body: InlineText | CanonicalJson | TextSetManifestRef | ImmutableBlobRef
  lineageRefs[]
  producerAuthority {
    kind
    ref
  }
  workplaceRef?
}
```

`ProductRef` is the exact identity. Consumers use exact refs/hashes or accepted
output bindings. They never use a mutable “latest worker output” heuristic.

### One logical desk

There is no proposal desk, requirements desk and code desk in the conveyor
physics. There is one logical Workplace-scoped production surface:

```text
Worker
  -> product_read(exact ProductRef)
  -> product_submit(schemaRef, content)
  -> execution_complete(...)
  -> CandidateSet
```

Schema determines meaning. It does not select another runtime mechanism.

---

## 2. The LEGO principle

A workshop (цех) declares **WHAT** must happen:

- Flow and Production Cells;
- execution profiles and skills;
- input/output contracts;
- CheckPlans;
- decision and recovery policies;
- optional external effects.

The factory runtime owns **HOW**:

- dispatch;
- worker selection and launch;
- concurrency;
- Workplace identity;
- desk provisioning;
- fencing and supervision;
- product persistence;
- CandidateSet sealing;
- review;
- GateRun and GateDecision;
- recovery;
- lifecycle progression.

Adding a normal workshop must not require:

- a new dispatcher;
- a new worker runner;
- a new lifecycle engine;
- a new task status family;
- a module-specific submit/read protocol;
- a module-specific acceptance state machine.

If core runtime branches on module name or worker profession, the LEGO contract
is broken.

---

## 3. Production Cell is the universal LM/deterministic-worker unit

A Production Cell contains the whole bounded production loop:

```text
exact input ProductRefs
  -> fenced author WorkerExecution
  -> sealed author CandidateSet
  -> author GateRun
     | accepted(final) -> terminal(accepted)
     | accepted(author) -> reviewer role
     | repair_required -> repair_wait
     | human_required -> paused
     | failed -> terminal(failed)

optional reviewer
  -> reviewer WorkerExecution pinned to exact author CandidateSet
  -> reviewer CandidateSet
  -> final GateRun
     | accepted -> terminal(accepted)
     | repair_required -> author or reviewer repair
     | human_required -> paused
     | failed -> terminal(failed)
```

WorkerExecution, reviewer execution, CheckRun and GateRun are internal attempts
of the cell. They are not hidden Flow nodes.

One cell definition may materialize many Workplaces, for example Development
fan-out.

```text
WorkplaceRef {
  processRunId
  moduleRef
  productionCellId
  workKey
}
```

`workKey` is stable and derived from accepted input identity, never worker or
attempt identity.

---

## 4. CandidateSet is the quality-control handoff

A worker may create drafts and several products. Quality control must not inspect
a mutable desk view. Completion seals one exact CandidateSet:

```text
CandidateSet {
  candidateSetRef
  workplaceRef
  producerExecutionRef
  role                    // author | reviewer
  subjectCandidateSetRef? // reviewer only
  members[] {
    productRef
    origin
    sourceCandidateSetRef?
  }
  candidateSetDigest
  sealedAt
}
```

The seal key `(workplaceRef, producerExecutionRef, role)` is deterministic.
Repeating the same seal is idempotent; a different payload under the same key is
rejected.

A reviewer is pinned to one exact author CandidateSet. Reviewer output is
assessment evidence; it never replaces the authored product.

Worker completion means only:

> “this execution stopped and left an immutable candidate on the desk.”

It does **not** mean acceptance.

---

## 5. GateDecision is acceptance authority

A GateRun inspects exact CandidateSets through declared checks and emits one
append-only GateDecision:

```text
GateDecision {
  workplaceRef
  gateRunRef
  gatePhase
  subjectCandidateSetRef
  assessmentCandidateSetRefs[]
  verdict                  // accepted | repair_required | human_required | failed
  repairTargetRole?
  checkPlanRef
  checkPlanDigest
  checkReceiptRefs[]
  installationDigest
  decisionKey
  acceptedOutputBindings[]
  decisionDigest
}
```

Only application of a **cell-final accepted GateDecision** can move a Production
Cell forward and publish accepted output bindings.

A persisted decision that loses the expected Workplace revision remains audit
evidence but cannot advance the cell.

Therefore these are different facts:

```text
Gate computation returned accepted
!=
GateDecision successfully advanced the Workplace
```

This distinction is also the certification boundary for replay capsules.

---

## 6. Replay-first is normal factory execution

There is no separate production mode, mock mode, hybrid mode or replay mode.
There is one normal Factory Start.

Every worker assignment follows the same algorithm:

```text
materialize Workplace
  -> atomic claim/fence WorkerExecution
  -> freeze exact ReplayKey
  -> look for certified capsule
       | HIT  -> deterministic replay worker
       | MISS -> model selected by normal frontend/workshop routing
  -> normal MCP/product protocol
  -> CandidateSet
  -> current GateRun
  -> current GateDecision
  -> normal Workplace/lifecycle transition
```

Replay is therefore an optimization of **worker production only**.

It does not replay or restore:

- GateDecision;
- Workplace transition;
- task/Kanban status;
- lifecycle cursor;
- settlement;
- release certificate;
- external effect receipt.

Those mechanisms always execute using the current code.

### Why this matters

A replayed Discovery or Formalization worker still traverses the current
Production Cell, CandidateSet, GateRun, GateDecision and lifecycle code. Thus a
factory regression in an already-passed workshop can still be detected without
paying again for the same semantic LLM work.

This is deliberately different from restoring a machine checkpoint after the
workshop and skipping its current transitions.

---

## 7. ReplayKey is exact semantic invocation identity

A capsule is reusable only when the current invocation is semantically the same
as the accepted invocation that produced it.

The ReplayKey is derived from immutable server-authored data such as:

```text
ReplayKeyMaterial {
  projectId
  moduleRef
  nodeId
  productionCellId
  workKey
  role
  packageDigest
  nodeInputHash
  subjectCandidateDigest? // reviewer
}
```

For repository-changing work, the exact repository base commit/tree must be
covered either directly or transitively by the frozen node input hash.

Replay identity must not depend on:

- worker execution ID;
- task row ID merely as identity;
- process timestamps;
- selected provider/model;
- transient filesystem path.

Changing the configured model does not invalidate a capsule. A capsule proves
that a product contract was accepted for exact inputs, not that one particular
model must reproduce it.

Changing a meaningful input, installed package contract, author CandidateSet or
repository base creates a miss.

---

## 8. Capsule is certified accepted production

A Replay Capsule is not a cached chat response and not an old runtime state.
It is an immutable declarative recipe for reproducing one accepted worker
execution’s products.

Conceptually:

```text
ReplayCapsule {
  replayKey
  keyMaterial
  sourceCandidateSetRef
  sourceExecutionRef       // audit only
  payloadHash

  typedProducts[]
  artifacts[]
  traces[]
  gitRecipe?
}
```

Old DB row IDs are never replay authority.

Artifacts and traces use semantic selectors/local replay mappings. Git replay
uses an exact recorded base plus patch/content recipe and verifies the resulting
tree.

### Certification boundary

A capsule may be materialized only from a CandidateSet whose Workplace is
durably:

```text
loopState = terminal
terminalReason = accepted
```

For a cell without review this certifies the accepted author CandidateSet.

For a reviewed cell the final accepted Workplace certifies **both**:

- the exact author CandidateSet;
- the exact reviewer CandidateSet bound to that author set.

The author set is not certified for replay merely because its author gate passed
and review was queued. Final review may still reject it.

Rejected, repair, paused, human-required, failed, stale-decision and superseded
candidates never enter the certified replay corpus.

### Lazy durable certification is allowed

Capsule materialization is an optimization, not acceptance authority. The
system may materialize the capsule immediately after `terminal(accepted)` or
lazily before a later replay lookup, provided it derives it only from already
durable accepted state.

This permits crash-safe behavior without introducing a second pending-capture
state machine:

```text
accepted Workplace exists
  -> capsule missing because process crashed before archive
  -> next assignment performs certification sweep
  -> exact accepted CandidateSets become capsules
  -> replay lookup continues
```

The accepted Workplace/CandidateSet/Gate evidence is authoritative; the capsule
is a reconstructible archive derived from it.

---

## 9. Replay worker is indistinguishable at the production boundary

On a capsule hit the physical execution may use the deterministic
CLI-compatible executor. On a miss it uses the selected LLM route.

After product submission the factory must not need to know which one produced
the text.

Both paths must use the normal:

- immutable ExecutionContext;
- WorkIntent authority;
- Workplace desk;
- product/artifact/trace tools;
- Git desk for Development;
- `worker_done` / execution completion protocol;
- CandidateSet sealing;
- quality gates.

A replay worker cannot:

- set Workplace status;
- create GateDecision directly;
- advance lifecycle;
- expand its tool authority;
- mutate another execution’s products.

### Replay provenance

The journal must still tell the truth about execution source.

On replay hit:

```text
executor = deterministic replay-compatible executor
provider = null
model = null
capsuleRef = exact certified capsule
```

The project/workshop’s selected model remains unchanged. A later miss still uses
that model.

---

## 10. Model selection remains orthogonal

Model selection is an operational/cost-control policy, not domain behavior.

Normal inheritance remains:

```text
factory default
  -> workshop default
  -> cell/role override
  -> frontend/run selection where applicable
```

At claim time the selected route is frozen into WorkerExecution.

Replay does not rewrite model configuration. It only replaces one physical
worker execution when an exact certified capsule exists.

Thus a project may use a cheap model for Discovery, a stronger model for SRS,
another reviewer model, and still gain replay automatically without any new
factory mode.

---

## 11. Test project and production projects use the same runtime

A service/conformance project may ship with prebuilt certified fixture capsules.
A production project normally starts without capsules.

The factory does not branch on “test project”.

First production run:

```text
no capsule -> selected LLM -> accepted -> capsule becomes available
```

Later run:

```text
exact capsule -> replay
changed invocation -> miss -> selected LLM
```

A conformance project can therefore run almost entirely from known capsules
while still exercising current orchestration, desks, CandidateSets, gates and
lifecycle.

An E2E test script is only an **external harness** that prepares a project,
starts the normal Factory and asserts durable results. It must not implement a
second mock/hybrid lifecycle or special stage execution path.

Terms such as “mock factory”, “hybrid runtime” and “mock E2E mode” are not
architectural concepts.

---

## 12. Future regeneration semantics

The normal policy is effectively:

```text
prefer replay
```

If an exact capsule exists, use it; otherwise invoke the selected model.

A future “Regenerate” user action may introduce a local replay directive such as
`bypass` for one invocation. That feature is deliberately outside the current
implementation.

It must not become another factory runtime.

---

## 13. Checkpoints and replay are related but not the same

Replay answers:

> “Can the current factory reconstruct previously accepted expensive worker
> production and run all current transitions again?”

Checkpoint answers:

> “Can the operational state of the currently running factory be restored after
> interruption?”

Replay capsules are therefore a useful immutable substrate for future
checkpoint design, but checkpoint restore must not be confused with replay-first
execution.

A future checkpoint may reference already content-addressed accepted products
and capsules rather than re-materializing every artifact independently.

This can reduce checkpoint complexity while preserving separate semantics:

```text
Replay capsule = reconstruct accepted worker production
Checkpoint      = restore machine/runtime state
```

If a checkpoint becomes unusable during factory development, replay-first start
from the beginning remains a safe way to rebuild progression while avoiding
most repeated LLM cost.

---

## 14. Workplace is primary; worker is temporary

The core entities have distinct lifetimes:

| Entity | Lifetime | Meaning |
|---|---|---|
| Workplace | durable for one materialized cell | primary production place |
| WorkerExecution | one attempt | temporary worker visit |
| WorkItem/Card | rebuildable projection | human Kanban view |
| Desk | Workplace-scoped | files/tools/drafts for the workplace |
| CandidateSet | immutable | exact batch sent to QC |
| GateDecision | immutable | QC authority |
| ReplayCapsule | immutable/reconstructible | certified replay recipe derived from accepted production |

Worker replacement never changes Workplace identity.

A replay worker is simply another WorkerExecution implementation visiting the
same kind of Workplace under the same authority.

---

## 15. Repository desk is factory-owned

For code-changing work the factory prepares the repository desk before launch.
The model or replay worker does not invent its own worktree or branch.

The launch context pins facts such as:

```text
projectRepositoryId
worktreePath
source branch / integration branch
expected base commit/tree
```

The process starts in the prepared worktree.

A Git replay recipe may be applied only when its exact base binding matches.
The replay executor applies the recorded patch/content recipe and verifies the
resulting tree before submitting the current run’s implementation product.

Copying an old commit SHA into a new run without proving repository identity is
not replay.

---

## 16. Two-channel state remains unchanged

Human Kanban and machine loop state are separate:

```text
Kanban:
todo -> in_progress -> review -> review_in_progress -> done
 * -> blocked
 * -> failed
 * -> cancelled

Workplace loop:
idle -> queued -> leased -> running -> verifying
                              |          |
                              |          -> repair_wait -> queued ...
                              -> ...
terminal / paused
```

Allowed pairings remain closed:

| Kanban | Workplace loop |
|---|---|
| todo | idle |
| in_progress | queued / leased / running / verifying / repair_wait |
| review | queued(reviewer) |
| review_in_progress | queued / leased / running / verifying / repair_wait |
| blocked | paused |
| done | terminal(accepted) |
| failed | terminal(failed) |
| cancelled | terminal(cancelled) |

A worker crash or replay miss does not return started work to `todo` as domain
truth.

---

## 17. Review is universal

If a Production Cell declares review:

```text
author CandidateSet accepted by author gate
  -> same Workplace queues reviewer
  -> reviewer pinned to exact author CandidateSet
  -> reviewer CandidateSet
  -> final GateDecision
```

Invalid reviewer output retries reviewer role.

A valid reviewer verdict proving an author defect returns the same Workplace to
author repair.

Only final accepted review transitions the Workplace to `terminal(accepted)`.
Only at that point are both author and reviewer executions eligible for replay
certification.

---

## 18. Recovery remains Workplace repair, not replay

Semantic/technical recovery means bringing a **new WorkerExecution** to the same
Workplace and desk with exact RecoveryIssue and rejected CandidateSet inputs.

Replay is different. It may satisfy that new worker invocation only when an
exact certified capsule exists for its current ReplayKey.

The recovery state machine remains bounded and sticky on exhaustion. Replay does
not reset recovery budgets or reopen cases.

---

## 19. Quality-control layers

Every gate has three conceptual layers:

1. **Core integrity** — exact refs, hashes, schema/cardinality, lineage and
   producer authority.
2. **Declared CheckPlan** — versioned schema/policy/lint/build/test/provider
   checks.
3. **Decision policy** — deterministic reduction to accepted / repair_required /
   human_required / failed.

Replay cannot bypass any layer.

If current checks become stricter, a replayed old product may now fail. That is
correct and is one reason replay is valuable for regression testing the factory.

---

## 20. Checks versus effects

Checks inspect immutable candidates and do not mutate authoritative/external
state.

Effects perform authorized external changes only after the required acceptance
boundary and with idempotent desired-state identity and durable receipts.

Examples:

```text
lint/build/test              = check
Git integration/merge/push   = effect
publish/deploy               = effect
```

Replay reconstructs worker production. It does not replay successful external
effects as if they were text generation.

---

## 21. Workshop instances of the same core

| Workshop | Production meaning |
|---|---|
| Discovery | proposal/readiness products, deterministic settlement |
| Formalization | PRD/FR/NFR/RULE/UC/AC/SRS products and traceability |
| Development | task graph, patches/TextSets, review verdicts, verification evidence; Git integration as effect |
| Delivery | desired state where worker cognition is required; approval/effects/observation as control nodes |

Development may have more fan-out/fan-in topology, but it is not a different
worker/runtime mechanism.

---

## 22. One queue and one dispatch authority

There is one infrastructure queue/concurrency mechanism.

Infrastructure selects eligible queued Workplaces, records a reservation/fence,
builds immutable execution context, resolves replay, then launches the chosen
physical worker.

The worker never chooses work.

The module never starts workers.

Replay lookup is part of this normal assignment boundary, not a second queue.

---

## 23. Execution authority and supervision

Every WorkerExecution has a unique execution identity, fence and immutable
execution context.

The execution context pins:

- Workplace/WorkIntent authority;
- allowed Saga tools;
- model/executor route;
- replay key and exact capsule ref when a hit occurs;
- captured-at/provenance hashes.

All managed MCP calls validate this context fail-closed.

Replay workers receive no broader tool authority than the corresponding real
worker role.

Liveness, progress, OS process identity and lease supervision remain execution
concerns independent of Workplace continuity.

---

## 24. Production journal

The journal explains production; it does not authorize transitions by itself.

It records exact provenance for:

- WorkerExecutions;
- product submissions;
- CandidateSets;
- CheckReceipts;
- GateDecisions;
- external effect attempts;
- replay source/capsule selection.

The journal must distinguish LLM production from deterministic replay without
changing the downstream production semantics.

Accepted products and GateDecisions remain immutable evidence. A ReplayCapsule
is reconstructible derived evidence and may be re-materialized from accepted
production if archive creation was interrupted.

---

## 25. Replay certification invariant

This invariant is mandatory:

> **No reusable capsule exists solely because a check returned `accepted`. A
> capsule is certified only from an exact CandidateSet belonging to a durable
> `terminal(accepted)` Workplace.**

For reviewed cells:

> **Final Workplace acceptance certifies both the exact author CandidateSet and
> its exact reviewer CandidateSet.**

A stale accepted GateDecision that never advances the Workplace must not create
a certified capsule.

Capsule archive failure never revokes already accepted production. Missing
archive is reconstructed lazily from accepted durable evidence before a later
lookup.

---

## 26. Mandatory replay/conformance scenarios

The shared conformance suite should prove at least:

1. Capsule miss preserves the selected provider/model/effort and launches the
   normal model path.
2. Exact capsule hit uses deterministic replay but leaves project model settings
   unchanged.
3. Changing node input/package digest produces a miss.
4. Reviewer capsule is pinned to exact author CandidateSet digest.
5. Repository base mismatch prevents Git replay.
6. Replay still produces a new current CandidateSet and current GateRun.
7. Old GateDecision/lifecycle state is never replayed.
8. Author-only capsule is certified only after `terminal(accepted)`.
9. In reviewed cells neither author nor reviewer capsule is certified before
   final acceptance; afterwards both are certifiable.
10. Rejected/repair/human-required/failed candidates never become capsules.
11. A stale accepted GateDecision that loses transition authority does not
    certify a capsule.
12. Crash after final acceptance but before archive creation is recovered by
    lazy certification on a later assignment.
13. Replay MCP calls are checked by the same authority gateway as LLM calls.
14. A corrupt capsule hit fails through normal worker failure/recovery and does
    not silently spend money by falling back to an LLM.
15. A conformance project can start through the normal Factory and complete from
    fixture capsules without a mock/hybrid runtime.
16. A production project with no capsules naturally invokes the selected models
    and builds its corpus as work becomes accepted.

The conformance harness may be scripted, but it is external to factory
architecture. It prepares data, starts the normal Factory, and asserts durable
facts.

---

## 27. DDD interpretation

The metaphor supplies ubiquitous language, not one giant aggregate.

### Bounded contexts

**Conveyor Runtime** owns ProcessRun, Workplace state, Flow progression and
recovery policy.

**Execution Control** owns WorkerExecution, reservations, launch, fences,
leases, supervision and physical executor choice.

**Production and Evidence** owns ProductRefs, CandidateSets, CheckReceipts and
GateDecisions.

**Work Projection** owns rebuildable human WorkItems.

**Module Contracts** owns Process Module/Production Cell declarations, skills,
schemas and policies.

**Module Catalog/Installation** owns installed package identity/digest.

**Lifecycle Composition** owns stage routing.

Replay capsule persistence is infrastructure/production-evidence support. It is
not a new workshop, lifecycle or aggregate that owns acceptance.

### Important aggregates

| Aggregate | Core invariant |
|---|---|
| ProcessRun | valid Flow transition; terminal is final |
| Workplace | one active mutation actor; final accepted gate is forward authority |
| WorkerExecution | unique fence; terminal once |
| CandidateSet | immutable exact producer handoff |
| GateDecision | append-only exact decision |
| RecoveryCase | bounded sticky repair history |
| Product | immutable schema/ref/digest/provenance |
| EffectAttempt | idempotent observe-before-retry external effect |

ReplayCapsule is derived immutable archive data. Its existence never substitutes
for a GateDecision.

---

## 28. Hexagonal dependency rule

Dependency direction remains inward:

```text
CLI / MCP / UI / scheduler
        -> application use cases
        -> domain contracts/policies
        <- ports
        <- SQLite / filesystem / model / replay / Git adapters
```

The replay implementation belongs behind execution/production ports. Domain code
must not import SQLite replay repositories or simulator scripts.

A replay executor is an outbound adapter implementing the same physical worker
contract as an LLM driver.

---

## 29. Canonical human-factory glossary

| Human term | Machine meaning |
|---|---|
| Factory / conveyor | Saga runtime |
| Production order | ProcessRun |
| Workshop | Process Module package |
| Production Cell | declarative worker/check/review/gate loop |
| Workplace | materialized Production Cell instance |
| Worker | one WorkerExecution, regardless of physical implementation |
| LLM worker | WorkerExecution backed by an inference model |
| Replay worker | WorkerExecution backed by a certified capsule recipe |
| Card | WorkItem projection |
| Desk | Workplace-scoped workspace/product view |
| Candidate batch | CandidateSet |
| Quality engineer | GateRun |
| QC act | GateDecision |
| Defect sheet | RecoveryIssue |
| Production journal | immutable/auditable runtime evidence |
| Replay capsule | certified reconstruction recipe for accepted worker production |

The quality department is not another workshop. Replay is not another factory.

---

## 30. Architecture review questions

For every change ask:

1. Does it introduce another factory/runtime path?
2. Does it branch core logic on workshop/module names?
3. Is the worker physical implementation leaking into Production Cell domain
   semantics?
4. Does worker completion merely seal CandidateSet, or does some path incorrectly
   treat it as acceptance?
5. Does final acceptance come from an exact durable GateDecision + Workplace
   transition?
6. Could a stale/superseded decision advance or certify anything?
7. Is a replay capsule being treated as authority rather than derived accepted
   production?
8. Does replay still traverse the current CandidateSet, gate, settlement and
   lifecycle code?
9. Does replay preserve normal worker authority and exact repository desk?
10. Does model selection remain independent of replay availability?
11. Can an exact input change invalidate the capsule deterministically?
12. Can a crash after acceptance but before capsule materialization recover from
    durable accepted evidence without regenerating semantic work?
13. Does a test harness start the same normal Factory or implement another
    mock/hybrid machine?

If the answer introduces a second engine, second acceptance mechanism or
module-specific replay path, the design is wrong.

---

## 31. Condensed technical conformance checklist

### Factory

- one normal Factory Start;
- one dispatch/concurrency mechanism;
- one Production Cell runtime;
- one authoritative Workplace state machine;
- no mock/hybrid lifecycle mode;
- modules never launch workers themselves.

### Worker production

- exact immutable execution context before spawn;
- one normal MCP/product surface;
- model-backed and replay-backed workers have identical product authority;
- stale execution cannot submit;
- worker completion seals CandidateSet only.

### Quality

- exact CandidateSet subjects;
- reviewer pinned to exact author set;
- current CheckPlan always runs;
- GateDecision is append-only;
- only cell-final accepted transition publishes output/advances.

### Replay

- lookup is replay-first by default;
- miss means selected model, not failure;
- hit means deterministic worker, not another lifecycle;
- capsule key excludes model identity and transient IDs;
- capsule is certified only from durable terminal accepted Workplace;
- reviewed cell certifies author + reviewer only after final acceptance;
- corrupt hit fails closed;
- GateDecision/Workplace/lifecycle are never replayed;
- archive may be reconstructed lazily from accepted durable evidence.

### Desk/Git

- factory prepares repository desk;
- worker does not create/switch arbitrary worktree;
- Git replay validates exact base and resulting tree;
- moving branch state is never acceptance identity.

### Recovery/checkpoint

- repair stays on same Workplace;
- recovery budget is durable/sticky;
- replay does not reset recovery;
- checkpoints restore machine state, replay reconstructs accepted worker
  production;
- future checkpoints may reuse capsule/content-addressed snapshot storage but do
  not replace replay-first semantics.

---

## 32. Operational rule of thumb

The fastest way to judge any new mechanism is this question:

> **After the worker has submitted its exact products, could the rest of the
> factory run identically without knowing whether those products came from GLM,
> Claude, Qwen or a replay capsule?**

If yes, the design respects the conveyor.

If no, worker implementation has leaked into factory physics.

---

## Operational appendices

- [Universal transition diagnostics and logging](CONVEYOR-TRANSITION-DIAGNOSTICS.md)
- [Transition acceptance and incident checklist](CONVEYOR-TRANSITION-CHECKLIST.md)
- [Factory Domain Acceptance Registry](FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md)

Workshops are configuration instances of this protocol, not separate lifecycle
engines. Replay is a standard execution optimization of the same protocol, not
another mode of the factory.
