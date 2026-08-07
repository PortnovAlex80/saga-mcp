# Conveyor Mental Model — Saga4 (Version 4.3)

This document is the architectural compass for the Saga conveyor. It is the
plain-language interpretation of the formal CGAD invariants and must be used to
review runtime, persistence, module, testing, replay, recovery and delivery
changes.

The governing rule is:

> **one production interface, one material, one desk, one factory runtime**

A workshop is a declarative arrangement of Production Cells. It is not a
private engine, queue, state machine, product store, submit protocol, testing
runtime or recovery runtime.

---

## 1. One production interface

Saga does not fundamentally care whether a worker is backed by GLM, Claude,
Qwen, LM Studio or deterministic replay.

The factory sees one contract:

```text
WorkerExecution
  -> receives one immutable execution context
  -> reads exact authorized inputs
  -> produces text / canonical JSON / TextSet / patch products
  -> submits through the normal worker protocol
  -> seals one immutable CandidateSet
```

The physical worker implementation is replaceable. Production physics are not.

The material crossing the worker boundary is text or content-addressed textual
material. Proposal, PRD, SRS, source code, reviewer verdict and verification
report differ by schema, not by runtime mechanism.

External state changes are different. Compilation, tests, Git integration,
publish and deploy are performed by deterministic kernel/provider capabilities.
A worker may describe desired state, but text does not grant effect or
transition authority.

---

## 2. One logical desk

All workers use one Workplace-scoped production surface:

```text
product_read(exact ProductRef)
product_submit(schemaRef, content)
execution_complete(...)
```

`ProductRef` is exact product identity. Consumers use exact refs/digests or
accepted output bindings, never “latest worker output”.

Schema determines product meaning. It must not select another persistence,
submit or lifecycle mechanism.

---

## 3. LEGO principle

Workshop packages declare WHAT:

- Flow / Production Cells;
- skills and execution profiles;
- product contracts;
- CheckPlans;
- decision/recovery policy;
- optional effects.

Factory runtime owns HOW:

- dispatch and concurrency;
- worker selection and launch;
- Workplace and desk identity;
- fencing/supervision;
- product persistence;
- CandidateSet sealing;
- GateRun/GateDecision;
- review;
- replay lookup;
- recovery;
- lifecycle progression.

Adding a normal workshop must not add another dispatcher, worker runner,
lifecycle engine, submit/read protocol or acceptance state machine.

Core runtime must not branch on workshop name or worker profession.

---

## 4. Production Cell is the universal worker-quality loop

```text
exact semantic inputs
  -> fenced author WorkerExecution
  -> author CandidateSet
  -> author GateRun
       | accepted(final) -> final acceptance
       | accepted(author) -> reviewer
       | repair_required -> repair_wait
       | human_required -> paused
       | failed -> terminal(failed)

optional reviewer
  -> reviewer WorkerExecution pinned to exact author CandidateSet
  -> reviewer CandidateSet
  -> final GateRun
       | accepted -> final acceptance
       | repair_required -> author/reviewer repair
       | human_required -> paused
       | failed -> terminal(failed)
```

WorkerExecution, reviewer execution and GateRun are attempts inside the cell,
not hidden Flow nodes.

A cell definition may materialize many Workplaces. Stable instance identity is:

```text
WorkplaceRef {
  processRunId
  moduleRef
  productionCellId
  workKey
}
```

`workKey` is semantic/stable inside the run and never contains worker-attempt
identity.

---

## 5. CandidateSet is the QC handoff

Worker completion seals exact products:

```text
CandidateSet {
  candidateSetRef
  workplaceRef
  producerExecutionRef
  role                    // author | reviewer
  subjectCandidateSetRef? // reviewer only
  members[] { productRef, origin, sourceCandidateSetRef? }
  candidateSetDigest
  sealedAt
}
```

Worker completion means only:

> this execution stopped and left a candidate batch on the desk.

It does not mean acceptance.

CandidateSet authority identity may include current run/execution provenance.
That is correct for QC and audit, but it is **not automatically a cross-run
replay identity**.

---

## 6. GateDecision and CellFinalAcceptance

GateRun emits one append-only GateDecision over exact CandidateSets.

These are distinct facts:

```text
check/gate computation says accepted
!=
GateDecision is persisted
!=
GateDecision is applied to expected Workplace revision
!=
Workplace reaches terminal(accepted)
```

Only the last condition is cell-final acceptance.

Code should expose one typed proof/value, conceptually:

```text
CellFinalAcceptance {
  workplaceRef
  finalGateDecisionRef
  subjectCandidateSetRef
  assessmentCandidateSetRefs[]
}
```

It is constructible only after proving:

```text
final GateDecision.verdict = accepted
AND decision applied to expected Workplace revision
AND Workplace.loopState = terminal
AND Workplace.terminalReason = accepted
```

Replay certification consumes `CellFinalAcceptance`, not a raw `accepted`
verdict.

---

## 7. Project, Factory Start and Resume are different identities

### Project

Project is stable product scope and the normal replay namespace.

### New Factory Start

An intentional new Factory Start creates a **new run identity** for the same
Project and starts lifecycle progression from the beginning using current code.

```text
Project P
  -> Factory Run A
  -> Factory Run B
  -> Factory Run C
```

The new run gets new ProcessRun/LifecycleRun/Workplace/WorkerExecution identities
but may reuse semantically compatible capsules belonging to Project P.

### Resume

Resume continues the same interrupted run and its existing Workplaces. It does
not intentionally re-run completed cells from the beginning.

```text
new start = new run identity, same project
resume    = same run identity
```

Persistence must not collapse Project identity into “one lifetime Factory Run”.
A legacy schema that permits only one order/lifecycle per Project is a migration
constraint, not Saga4 architecture.

Idempotency deduplicates the **same start command**. It must not prohibit a later
intentional new start of the same Project with the same source bytes.

---

## 8. Replay-first is normal execution

There is no production mode, mock mode, hybrid mode or replay mode.

Every worker assignment follows one algorithm:

```text
materialize Workplace
  -> claim + fence WorkerExecution
  -> freeze replay semantic identity
  -> resolve capsule eligibility
       | HIT  -> deterministic replay worker
       | MISS -> normally selected model
  -> same MCP/product surface
  -> NEW CandidateSet
  -> CURRENT GateRun
  -> CURRENT GateDecision
  -> CURRENT Workplace/lifecycle transition
```

Replay substitutes only worker production.

Replay never restores:

- CandidateSet from another run as current QC state;
- GateDecision;
- Workplace state;
- task/Kanban status;
- lifecycle cursor;
- settlement/certificate;
- external-effect completion.

Current factory code always performs those steps again.

---

## 9. Replay identity must be semantic and cross-run stable

This is a critical invariant.

A replay key identifies **the semantic worker invocation**, not its current
runtime envelope.

Conceptually:

```text
ReplayKeyMaterial {
  projectId
  moduleRef
  nodeId
  productionCellId
  workKey
  role
  packageContractDigest
  semanticInputDigest
  subjectProductionDigest? // reviewer
  repositoryBaseDigest?    // when not already inside semanticInputDigest
}
```

### `semanticInputDigest`

`semanticInputDigest` is computed from the information that may materially
change worker output, for example:

- exact input product schema + content digest;
- stable business/initiative values;
- stable fan-out item identity/content;
- exact RecoveryIssue semantic content when relevant;
- immutable external observation products;
- repository base commit/tree for code-changing work.

It MUST exclude runtime/provenance identities that naturally differ between
Factory Runs:

- ProcessRun/LifecycleRun ids;
- WorkplaceRef;
- WorkerExecution id;
- task/intent row ids;
- CandidateSetRef;
- producerExecutionRef;
- timestamps;
- transient filesystem paths.

A raw `nodeInputHash` may remain useful for current-run authority/audit, but it
must not be used as ReplayKey input unless its canonicalization is explicitly
proven to exclude all run-specific envelope fields.

### Production manifests must separate semantics from provenance

A Production Cell output manifest may contain both:

```text
semantic products/digests
AND
current-run provenance refs
```

Its audit `contentHash` is not automatically a replay semantic digest.
Downstream replay identity must derive from accepted product content, not from a
manifest hash that includes Workplace/CandidateSet/execution/task identities.

---

## 10. Reviewer replay uses semantic author production identity

Reviewer execution is authoritatively pinned to the **exact current-run author
CandidateSetRef**. That remains required for QC.

But cross-run replay identity cannot use a CandidateSet digest that includes
WorkplaceRef or producerExecutionRef.

Reviewer ReplayKey therefore uses a semantic digest such as:

```text
subjectProductionDigest = hash(
  ordered/multiset of accepted author product { schemaId, contentDigest }
  + contract-relevant semantic metadata
)
```

Do not use current-run CandidateSetRef or run-scoped CandidateSet digest as the
cross-run reviewer replay key.

This preserves both requirements:

```text
QC authority       -> exact current CandidateSetRef
Replay equivalence -> stable semantic author-production digest
```

---

## 11. Closed-world replay input rule

Replay safety depends on a closed input surface, not on hashing alone.

A replayable WorkerExecution may consume only:

1. exact ProductRefs in its frozen read set;
2. exact Workplace/CandidateSet/RecoveryIssue material authorized for the
   attempt;
3. external observations first materialized as immutable content-addressed
   input products.

An unpinned live read from web/search/API/mutable DB/filesystem makes the
invocation non-replayable unless that observation is first captured into the
semantic input set.

---

## 12. ReplayCapsule is certified worker production

```text
ReplayCapsule {
  replayKey
  keyMaterial
  sourceCandidateSetRef   // audit provenance
  sourceExecutionRef      // audit provenance
  payloadHash
  typedProducts[]
  artifacts[]
  traces[]
  gitRecipe?
}
```

Old DB ids are never replay authority.

Artifacts/traces use semantic selectors or replay-local mappings. Git recipe
pins exact repository base and verifies resulting tree.

### Certification

Only `CellFinalAcceptance` can certify reusable capsules.

No-review cell:

```text
final accepted decision -> exact author CandidateSet -> author capsule
```

Reviewed cell:

```text
final accepted decision
  -> exact subject author CandidateSet
  -> exact assessment reviewer CandidateSet(s)
  -> author + reviewer capsules
```

Never scan every historical CandidateSet of a terminal Workplace. Rejected
repair/reviewer attempts remain durable audit history but are not certified.

### Direct capture and lazy reconstruction

Normal path:

```text
CellFinalAcceptance -> capture capsule(s)
```

Crash fallback:

```text
durable final acceptance exists
capsule archive missing
  -> later certification sweep reconstructs it
```

Direct capture is normal. Lazy reconstruction is recovery for missed archive
materialization. No second capture state machine is needed.

---

## 13. Replay worker is ordinary at the production boundary

Hit and miss use the same WorkerExecution protocol, authority, Product Desk,
RepositoryDesk, completion command, CandidateSet and current gates.

Replay worker cannot mutate Workplace, create GateDecision, advance lifecycle or
expand tool authority.

Provenance must remain truthful:

```text
inference execution -> real provider/model provenance
replay execution    -> deterministic executor + exact capsule ref
```

Replay does not rewrite project/workshop model settings.

---

## 14. Model selection remains orthogonal

Normal model inheritance remains operational/cost policy:

```text
factory default
  -> workshop default
  -> cell/role override
  -> frontend/run selection
```

Replay key deliberately excludes model identity. Capsule proves accepted
production for semantic inputs, not allegiance to a model vendor/version.

A future explicit “Regenerate” command may bypass replay for one invocation. It
is not another runtime mode.

---

## 15. Rejected replay cannot loop forever

If current QC rejects replayed production, the same capsule must not be selected
again for the next recovery attempt of that Workplace.

Forbidden:

```text
capsule C -> replay -> reject
repair -> capsule C -> replay -> reject
...
```

Eligibility is derived from durable existing evidence:

```text
WorkerExecution.replay.capsuleRef
  -> produced CandidateSet
  -> rejecting GateDecision / RecoveryIssue
  -> WorkplaceRef
```

The next recovery WorkerExecution treats that capsule as ineligible and normally
falls through to the selected model.

A corrupt capsule hit also fails closed. It does not silently call a paid model
inside the same execution. Recovery creates a new execution and resolves again.

---

## 16. Test projects and production projects use the same runtime

Factory must not branch on project name, `isTest`, mock mode or hybrid mode.

### Fixture/conformance project

A service test project may be seeded with certified fixture capsules and then
invoke normal Factory Start. The test asserts current CandidateSets, gates,
transitions and terminal outcome.

### Canonical two-pass integration proof

```text
Run A — same Project, no capsules
  -> selected model workers
  -> current gates
  -> final accepted cells
  -> capsules captured

Run B — intentional NEW Factory Start for same Project
  -> new run/workplace/execution identities
  -> same semantic replay keys
  -> capsule hits
  -> NEW CandidateSets
  -> CURRENT gates/lifecycle execute again
```

The persistence model must support this directly.

A canonical E2E must NOT:

- copy capsules between two databases;
- change Project id to manufacture a hit;
- reset lifecycle/process/workplace tables;
- route every stage to a simulator;
- implement a private lifecycle harness.

Those techniques can test serialization/adapters, but they do not prove the
accepted replay-first factory architecture.

---

## 17. Recovery and checkpoint remain separate semantics

Recovery brings a new WorkerExecution to the same Workplace/desk with exact
RecoveryIssue/rejected products. Replay may satisfy it only if an eligible
capsule exists.

Checkpoint restores operational state of the same interrupted run.

Replay reconstructs certified worker production while running current factory
transitions again.

```text
Recovery   = repair same Workplace
Checkpoint = restore same run machine state
Replay     = reuse semantic worker production across compatible invocations
```

---

## 18. RepositoryDesk is factory-owned

Factory provisions worktree/branch/base before code worker launch.

Model/replay worker does not invent or switch arbitrary worktrees.

Git replay requires exact base compatibility, applies recorded patch/content to
factory-provisioned desk and verifies resulting tree before submitting current
implementation product.

Old commit SHA alone is not replay proof.

---

## 19. Two-channel state and repair projection

Kanban and Workplace loop state remain separate.

Explicit repair mapping:

```text
repairTargetRole = author
  -> Kanban in_progress

repairTargetRole = reviewer
  -> Kanban review_in_progress
```

Projection never guesses from prose/module name.

Worker crash/replay miss/replacement does not reset domain work to `todo`.

---

## 20. Checks, effects and compensation

Checks inspect immutable candidates and cannot change authoritative/external
state.

Effects perform authorized external changes with exact desired-state identity,
idempotency key, durable EffectAttempt and EffectReceipt.

```text
lint/build/test            = check
Git merge/push             = effect
publish/deploy             = effect
```

Replay never substitutes old external-effect completion.

### No implicit rollback

Effect recovery policy is explicit:

```text
retry-idempotently
compensate-explicitly
roll-forward
human-required
```

Default without a proven compensator is roll-forward or human-required.

A compensating action is itself an authorized Effect with its own identity,
attempt and receipt.

---

## 21. Observation is a control/provider operation

Delivery observation does not create another worker engine.

```text
Deploy Effect
  -> EffectReceipt
  -> ObservationProvider
  -> Observation Product/Receipt
  -> deterministic policy
       | healthy
       | degraded
       | failed
       | not-ready -> durable retry
```

Observation retry is a bounded/durable control operation, not a private worker
queue or second Production Cell runtime.

---

## 22. One dispatch authority and one execution authority

Infrastructure selects eligible queued Workplaces, records reservation/fence,
builds immutable execution context, resolves replay eligibility and launches the
physical worker.

Worker never chooses work. Workshop never launches workers.

All managed tools validate execution authority fail-closed. Replay workers get
no broader capability set than corresponding inference workers.

---

## 23. DDD and dependency direction

Key conceptual ownership:

- **Project** — stable product/replay scope; multiple intentional Factory Runs.
- **ProcessRun/LifecycleRun** — one lifecycle execution; Resume preserves it.
- **Workplace** — one materialized cell in one run.
- **WorkerExecution** — one fenced attempt.
- **CandidateSet** — exact QC handoff in the current run.
- **GateDecision** — append-only QC authority.
- **ReplayCapsule** — derived reusable worker-production archive.
- **EffectAttempt** — idempotent external-effect attempt.

Dependency direction:

```text
CLI / MCP / UI / scheduler
        -> application use cases
        -> domain contracts/policies
        <- ports
        <- SQLite / filesystem / model / replay / Git adapters
```

Domain/application code must not depend directly on simulator scripts or SQLite
replay adapters.

---

## 24. Mandatory replay fitness tests

At minimum prove:

1. Miss preserves selected provider/model/effort.
2. Exact semantic hit uses replay and leaves model settings unchanged.
3. New ProcessRun/Workplace/execution refs do not change ReplayKey by
   themselves.
4. Meaningful product input/package/contract change causes miss.
5. Reviewer key is stable across runs when author product content is identical.
6. Reviewer key changes when author product content changes.
7. Repository base mismatch prevents Git replay.
8. Replay creates NEW current CandidateSet and CURRENT GateRun.
9. GateDecision/Workplace/lifecycle from old run are never replayed.
10. Capsule certification requires CellFinalAcceptance.
11. Reviewed cell certifies only exact final author+reviewer sets.
12. Rejected historical repair attempts never become capsules.
13. Crash after final acceptance but before archive capture can lazily rebuild
    capsule.
14. Replay tool calls use the same authority gateway.
15. Corrupt hit fails closed without hidden LLM fallback.
16. Capsule rejected by current gate is ineligible on next recovery attempt.
17. Unpinned live external read is non-replayable.
18. Same Project supports Run A model production followed by Run B replay from
    beginning in the same persistence system, with no table reset/capsule copy.
19. Fixture project completes through normal Factory Start without mock/hybrid
    routing.

---

## 25. Mandatory effect fitness tests

Prove:

1. Crash after external change but before receipt consumption does not duplicate
   the effect.
2. Duplicate idempotency identity creates one effective external change.
3. Retry observes external state before repeating.
4. Unsupported compensation never happens implicitly.
5. Explicit compensation is its own authorized Effect.
6. Observation retry does not create a second runtime/queue.

---

## 26. Architecture fitness functions

CI should mechanically reject at least:

- module-name/task-kind branches in universal runtime physics;
- module-specific submit/read protocols;
- mock/hybrid factory modes;
- replay code mutating GateDecision/Workplace/lifecycle;
- certification from raw `verdict === accepted`;
- ReplayKey derived from run-specific envelope refs;
- reviewer ReplayKey derived from run-scoped CandidateSet identity;
- repeated same-capsule replay after current rejection;
- replayable workers with unpinned live-read authority;
- canonical E2E using DB reset/cross-DB capsule copy to fake a new Factory Run;
- one-run-per-project persistence constraints treated as target architecture.

Markdown is an architectural source of truth; executable fitness functions are
its enforcement.

---

## 27. Canonical glossary

| Human term | Machine meaning |
|---|---|
| Project / product | stable product scope and replay namespace |
| Factory Start | intentional creation of a new Factory Run |
| Factory Run | one ProcessRun/LifecycleRun execution |
| Resume | continuation of the same Factory Run |
| Workshop | Process Module package |
| Production Cell | worker/check/review/gate loop |
| Workplace | materialized cell instance in one run |
| Worker | one WorkerExecution |
| Replay worker | deterministic WorkerExecution using capsule recipe |
| Desk | Workplace-scoped workspace/product surface |
| Candidate batch | current-run CandidateSet |
| QC act | GateDecision |
| Final QC acceptance | CellFinalAcceptance proof/value |
| Defect sheet | RecoveryIssue |
| Replay capsule | certified reconstruction recipe for worker production |
| Effect | authorized external state change |
| Observation | retryable provider/control read of external state |

Replay is not another factory. Observation is not another worker engine.

---

## 28. Architectural rule of thumb

Two questions catch most design drift.

> **After worker products are submitted, can the rest of the factory execute
> identically without knowing whether the bytes came from GLM, Claude, Qwen or
> replay?**

And:

> **Can the same Project intentionally start a new Factory Run, reuse only
> semantically compatible capsules, and still execute all current QC/lifecycle
> code without resetting production state?**

If either answer is no, worker/run implementation details have leaked into
factory physics.

---

## Operational appendices

- [Universal transition diagnostics and logging](CONVEYOR-TRANSITION-DIAGNOSTICS.md)
- [Transition acceptance and incident checklist](CONVEYOR-TRANSITION-CHECKLIST.md)
- [Factory Domain Acceptance Registry](FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md)

Workshops are configuration instances of this protocol, not separate lifecycle
engines. Replay is a standard optimization of worker production inside the same
protocol, never another mode of the factory.
