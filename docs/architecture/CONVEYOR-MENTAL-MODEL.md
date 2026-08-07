# Conveyor Mental Model — Saga4 (Version 4.2)

This document is the plain-language architectural model for the Saga conveyor.
The formal invariant remains **CGAD P18** (`cgad-v2-spec.md`). Every runtime,
module, test, replay, recovery and delivery change must be checked against this
model.

The governing rule is:

> **one production interface, one material, one desk, one factory runtime**

A workshop is a declarative arrangement of Production Cells. It is not a
private engine, queue, state machine, product store, submit protocol, testing
runtime or recovery runtime.

---

## 1. One production interface, one material, one desk

Saga does not fundamentally care whether a worker is backed by GLM, Claude,
Qwen, LM Studio or deterministic replay.

The factory sees one production contract:

```text
WorkerExecution
  -> receives exact immutable execution context
  -> reads exact authorized inputs
  -> produces text / canonical JSON / TextSet / patch products
  -> submits through the normal worker protocol
  -> leaves one immutable CandidateSet
```

The physical worker implementation is replaceable. The production contract is
not.

The material crossing the worker boundary is text or a content-addressed set of
text documents. A proposal, PRD, SRS, TypeScript file, review verdict and
verification report are different schemas of the same physical material.

External actions are different. Compilation, tests, Git integration, publish,
deploy and other effects are performed by deterministic kernel/provider ports.
A worker may produce a textual desired-state product, but it never gains
transition or effect authority merely by producing text.

### Product identity

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

`ProductRef` is exact identity. Consumers use exact refs/hashes or accepted
output bindings. They never use a mutable “latest worker output” heuristic.

### One logical desk

There is no proposal desk, requirements desk and code desk in conveyor physics.
There is one Workplace-scoped production surface:

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

A workshop declares **WHAT** must happen:

- Flow and Production Cells;
- execution profiles and skills;
- input/output contracts;
- CheckPlans;
- decision and recovery policies;
- optional external effects.

The factory owns **HOW**:

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
- replay lookup;
- recovery;
- lifecycle progression.

Adding a normal workshop must not require a new dispatcher, worker runner,
lifecycle engine, task status family, submit/read protocol or module-specific
acceptance state machine.

If core runtime branches on module name or worker profession, the LEGO contract
is broken.

---

## 3. Production Cell is the universal cognitive-production unit

A Production Cell contains the whole bounded worker/quality loop:

```text
exact inputs
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

One definition may materialize many Workplaces, for example Development
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

## 4. CandidateSet is the QC handoff

Worker completion seals one exact immutable CandidateSet:

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
assessment evidence; it never replaces authored production.

Worker completion means only:

> this execution stopped and left a candidate on the desk.

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

These are different facts:

```text
Gate computation returned accepted
!=
GateDecision was durably applied
!=
Production Cell reached terminal(accepted)
```

Only application of a **cell-final accepted GateDecision** may publish accepted
output bindings and move the cell forward.

A persisted decision that loses the expected Workplace revision remains audit
evidence but cannot advance the cell.

### CellFinalAcceptance

Code must not repeatedly reconstruct the final-acceptance predicate from
`decision.verdict === 'accepted'`.

The application layer should expose one typed proof/value such as:

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
final GateDecision verdict = accepted
AND
that decision was applied to the expected Workplace revision
AND
Workplace.loopState = terminal
AND
Workplace.terminalReason = accepted
```

Replay certification and other post-finalization capabilities should consume
this proof rather than a raw `accepted` verdict.

---

## 6. Replay-first is normal factory execution

There is no production mode, mock mode, hybrid mode or replay mode. There is one
normal Factory Start.

Every worker assignment follows the same algorithm:

```text
materialize Workplace
  -> atomic claim/fence WorkerExecution
  -> freeze exact ReplayKey
  -> resolve certified capsule eligibility
       | HIT  -> deterministic replay worker
       | MISS -> model selected by normal frontend/workshop routing
  -> normal MCP/product protocol
  -> CandidateSet
  -> CURRENT GateRun
  -> CURRENT GateDecision
  -> normal Workplace/lifecycle transition
```

Replay replaces only expensive/non-deterministic **worker production**.

Replay never restores:

- GateDecision;
- Workplace transition;
- task/Kanban status;
- lifecycle cursor;
- settlement;
- release certificate;
- external-effect completion.

Those mechanisms always execute through current code.

This is why replay is useful for regression testing: previously accepted worker
production can be reconstructed cheaply while the current factory physics are
executed again.

---

## 7. Factory Start, Resume and Project scope are different identities

Replay-first requires a precise distinction between product identity and run
identity.

### Project

A Project is the stable product scope. Replay capsules are project-scoped unless
a narrower declared scope is required.

### Factory Start

A **new Factory Start** means a new production run identity for the same project.
It begins lifecycle progression from the beginning using current runtime code.
It may reuse exact certified capsules from previous runs of that project.

```text
same Project
  -> Factory Run A
  -> Factory Run B
  -> Factory Run C
```

Run identity must not be conflated with Project identity.

### Resume

`resume` continues the **same** interrupted run and its existing Workplaces. It
does not intentionally re-run already completed Production Cells from the
beginning.

Therefore:

```text
new start      = new ProcessRun/LifecycleRun identity for the same project
resume         = continue the same run identity
replay capsule = reusable worker production across compatible runs
```

A persistence rule that permits only one lifetime production run per project is
not an architectural invariant of Saga4 replay-first. It is a legacy/schema
constraint and must not force test harnesses to copy capsules between fake
projects, reset production tables or invent a second runtime.

Idempotency may deduplicate the **same start request**. It must not forbid a
later intentional new Factory Start for the same project.

---

## 8. ReplayKey is exact semantic invocation identity

A capsule is reusable only when the current worker invocation is semantically
the same as the accepted invocation that produced it.

Conceptually:

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
covered either directly or transitively by frozen input identity.

Replay identity must not depend on:

- WorkerExecution ID;
- task row ID merely as identity;
- ProcessRun ID merely as identity;
- timestamps;
- selected provider/model;
- transient filesystem path.

Changing configured model does not invalidate a capsule. A capsule proves that
production was accepted for exact semantic inputs, not that one model brand
must reproduce it.

Meaningful input/package/contract/author-candidate/repository-base change causes
a miss.

### Closed-world replay input rule

Replay is safe only if all information that may materially influence worker
output is pinned into the execution input identity.

A replayable WorkerExecution may consume:

1. exact ProductRefs in its frozen read set;
2. exact Workplace/CandidateSet/RecoveryIssue refs authorized for that attempt;
3. external observations that have first been converted to immutable,
   content-addressed products and included in the frozen read set.

An unpinned live read from search, web, API, mutable database state or filesystem
state makes the invocation **non-replayable** unless that observation is captured
as an exact input product.

The safety property comes from the closed input surface, not from SHA-256 alone.

---

## 9. Capsule is certified worker production

ReplayCapsule is not a cached chat response, checkpoint or old runtime state. It
is an immutable declarative recipe for reproducing one accepted worker
execution's products.

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

Old database row IDs are never replay authority.

Artifacts/traces use semantic selectors or replay-local mappings. Git replay
uses exact base identity plus patch/content recipe and verifies the resulting
tree.

### Certification boundary

A capsule can become reusable only from **CellFinalAcceptance**.

For a cell without review, final acceptance certifies its exact author
CandidateSet.

For a reviewed cell, final acceptance certifies exactly:

- the final decision's `subjectCandidateSetRef` (author);
- its `assessmentCandidateSetRefs[]` (reviewer evidence).

Do not scan all historical CandidateSets of a terminal Workplace: old rejected
repair/reviewer attempts remain durable history and must not become capsules.

Rejected, repair, paused, human-required, failed, stale-decision and superseded
candidates never enter the certified replay corpus.

### Direct capture and lazy reconstruction

Normal path:

```text
CellFinalAcceptance
  -> capture exact accepted worker execution(s)
  -> ReplayCapsule(s)
```

Crash fallback:

```text
terminal(accepted) durable evidence exists
  -> capsule archive missing
  -> later certification sweep reconstructs exact capsule(s)
```

Direct capture is the normal path. Lazy reconstruction is crash/reconciliation
fallback. No second pending-capture state machine is required.

The accepted Workplace/CandidateSet/Gate evidence is authoritative. Capsule is
derived reusable evidence.

---

## 10. Replay worker is indistinguishable at the production boundary

On capsule hit the physical execution uses deterministic replay. On miss it uses
the selected inference route.

After product submission the factory must not need to know which physical worker
produced the bytes.

Both paths use the same:

- immutable ExecutionContext;
- WorkIntent authority;
- Workplace desk;
- product/artifact/trace tools;
- RepositoryDesk where applicable;
- execution completion protocol;
- CandidateSet sealing;
- quality gates.

Replay worker cannot set Workplace status, create GateDecision, advance lifecycle,
expand tool authority or mutate another execution's products.

### Provenance remains truthful

Replay hit records deterministic replay provenance and exact capsule ref. It must
not pretend an inference provider/model generated the output.

Project/workshop model configuration remains unchanged. A later miss still uses
that configured model.

---

## 11. A rejected replay capsule is not immediately replayed again

Current gates may reject production that was accepted in an earlier run. This is
expected and valuable.

The dangerous loop is forbidden:

```text
capsule C -> replay -> current Gate rejects
repair worker claim -> capsule C again
capsule C -> replay -> current Gate rejects
...
```

After a replay-produced CandidateSet is rejected for a Workplace, that exact
capsule is **ineligible for subsequent recovery attempts of that Workplace**.
The next attempt resolves as an ordinary replay miss and uses the selected model
(or another eligible capsule only if its identity is genuinely different).

No separate blacklist aggregate is required. Ineligibility should be derived
from existing durable evidence:

```text
WorkerExecution.replay.capsuleRef
  -> CandidateSet.producerExecutionRef
  -> rejecting GateDecision / RecoveryIssue
  -> WorkplaceRef
```

A replay hit that corrupts/fails during execution is also fail-closed. It does
not silently fall through to a paid LLM inside the same execution. Recovery
creates a new WorkerExecution, which then resolves eligibility normally.

---

## 12. Model selection remains orthogonal

Model selection is operational/cost-control policy, not domain behavior.

Normal inheritance remains conceptually:

```text
factory default
  -> workshop default
  -> cell/role override
  -> frontend/run selection where applicable
```

At claim, the selected route is frozen into WorkerExecution.

Replay never rewrites the project's model settings. It only substitutes one
physical worker on exact capsule hit.

Model identity deliberately does not belong in ReplayKey. A future user command
that explicitly asks for another answer is a replay-bypass command, not a model
key mutation.

---

## 13. Future regeneration semantics

Normal execution is `prefer replay`:

```text
eligible capsule -> replay
otherwise        -> selected model
```

A future “Regenerate” action may request a one-invocation replay bypass:

```text
bypass replay once
  -> selected model
  -> new CandidateSet
  -> current Gate
```

This is a local execution directive, not another factory mode.

Old accepted capsules may remain audit/version history; regeneration does not
require deleting them.

---

## 14. Test project and production projects use the same runtime

A service/conformance project may be seeded with certified fixture capsules. A
production project normally starts empty and builds capsules from accepted work.

Factory runtime must not branch on `isTest`, project name, mock mode or hybrid
mode.

A conformance harness may:

- create project/input/repository fixtures;
- seed certified capsule fixtures;
- invoke normal Factory Start;
- assert durable results.

It must not:

- override all stages to a simulator through special routing;
- copy production state to fake a second lifecycle;
- reset runtime tables to force replay;
- implement its own lifecycle progression.

### Canonical two-pass proof

For a normal project whose model provider is available:

```text
Run A: same project, no capsules
  -> model workers
  -> current gates
  -> final accepted cells
  -> capsules captured

Run B: intentional new Factory Start for same project
  -> new run identities / new Workplaces
  -> same semantic invocation keys
  -> capsule hits
  -> new CandidateSets
  -> current gates and lifecycle execute again
```

The persistence model must support this directly. Tests must not work around a
one-run-per-project schema by using two databases or rewriting project IDs.

---

## 15. Checkpoints and replay are related but not the same

Replay answers:

> Can current factory code reconstruct previously accepted expensive worker
> production and run current transitions again?

Checkpoint answers:

> Can operational state of an interrupted live run be restored?

```text
ReplayCapsule = reconstruct certified worker production
Checkpoint    = restore runtime/machine state
```

Future checkpoints may reuse content-addressed accepted material and capsule
storage, but checkpoint restore does not replace replay-first execution.

---

## 16. Workplace is primary; worker is temporary

| Entity | Lifetime | Meaning |
|---|---|---|
| Workplace | durable for one materialized cell in one run | primary production place |
| WorkerExecution | one attempt | temporary worker visit |
| WorkItem/Card | rebuildable projection | human Kanban view |
| Desk | Workplace-scoped | workspace/product view |
| CandidateSet | immutable | exact batch sent to QC |
| GateDecision | immutable | QC authority |
| ReplayCapsule | immutable/derived | certified reconstruction recipe |

Worker replacement never changes Workplace identity inside one run.

A new Factory Start creates new run/Workplace identities while remaining in the
same Project capsule scope.

---

## 17. Repository desk is factory-owned

For code-changing work, factory prepares RepositoryDesk before worker launch.
Model/replay worker does not invent its own worktree or branch.

Launch context pins repository identity and expected base commit/tree.

A Git replay recipe may apply only when exact base binding matches. Replayer
applies recorded patch/content and verifies resulting tree before submitting
current-run implementation product.

Copying an old commit SHA without proving repository identity is not replay.

---

## 18. Two-channel state and repair-role mapping

Human Kanban and machine loop are separate.

```text
Kanban:
todo -> in_progress -> review -> review_in_progress -> done
 * -> blocked
 * -> failed
 * -> cancelled

Workplace loop:
idle -> queued -> leased -> running -> verifying
                              |
                              -> repair_wait -> queued ...
terminal / paused
```

Repair projection is explicit:

```text
repairTargetRole = author
  -> Kanban = in_progress

repairTargetRole = reviewer
  -> Kanban = review_in_progress
```

The projection layer does not guess from prose, prior card status or module
name.

Worker crash/replay miss does not return started work to `todo` as domain truth.

---

## 19. Review is universal

If review is declared:

```text
author CandidateSet passes author gate
  -> same Workplace queues reviewer
  -> reviewer pinned to exact author CandidateSet
  -> reviewer CandidateSet
  -> final GateDecision
```

Invalid reviewer output retries reviewer role.

A valid reviewer verdict proving author defect returns same Workplace to author
repair.

Only final accepted review creates CellFinalAcceptance and makes exact author +
reviewer production certifiable for replay.

---

## 20. Recovery remains Workplace repair, not replay

Recovery creates a **new WorkerExecution** on the same Workplace/desk with exact
RecoveryIssue and rejected CandidateSet inputs.

Replay may satisfy the new worker only if a still-eligible exact capsule exists.
A capsule just rejected by current QC on that Workplace is not eligible again.

Recovery budget remains durable/sticky. Replay does not reset it.

---

## 21. Quality-control layers

Every gate has three conceptual layers:

1. **Core integrity** — exact refs, hashes, schema/cardinality, lineage and
   producer authority.
2. **Declared CheckPlan** — versioned schema/policy/lint/build/test/provider
   checks.
3. **Decision policy** — deterministic reduction to accepted / repair_required /
   human_required / failed.

Replay bypasses none of them.

If current checks become stricter, replayed old production may fail. That is
correct. Recovery then uses a real model rather than replaying the same rejected
capsule forever.

---

## 22. Checks, effects and compensation

Checks inspect immutable candidates and do not mutate authoritative/external
state.

Effects perform authorized external changes after the required acceptance
boundary, using exact desired-state identity, idempotency key, durable
EffectAttempt and EffectReceipt.

```text
lint/build/test              = check
Git integration/merge/push   = effect
publish/deploy               = effect
```

Replay reconstructs worker production. It never treats an old effect receipt as
new worker output and never repeats an external effect merely because a capsule
was replayed.

### No implicit rollback

Saga must never infer an automatic rollback for an external effect.

An effect capability/policy explicitly declares its recovery regime:

```text
EffectRecoveryPolicy =
    retry-idempotently
  | compensate-explicitly
  | roll-forward
  | human-required
```

Default for effects without a proven compensator is roll-forward or
human-required.

A compensating action, when supported, is itself an authorized Effect with its
own desired-state ref, idempotency key, attempt and receipt. It is not hidden
undo logic.

---

## 23. Observation is a control/provider loop, not another worker engine

Delivery observation does not justify a second Production Cell/runtime.

Canonical shape:

```text
Deploy Effect
  -> EffectReceipt
  -> ObservationProvider reads exact deployment target
  -> Observation Product/Receipt
  -> deterministic policy
       | healthy
       | degraded
       | failed
       | not-ready
```

If observation is not ready, the same control operation may schedule a durable
retry according to policy:

```text
not-ready
  -> durable next-observation time
  -> observe again
```

This is a retryable control/provider operation. It does not hire an LM worker,
create another worker queue or mutate Production Cell state outside declared
control transitions.

---

## 24. Workshop instances of the same core

| Workshop | Production meaning |
|---|---|
| Discovery | proposal/readiness products, deterministic settlement |
| Formalization | PRD/FR/NFR/RULE/UC/AC/SRS and traceability |
| Development | task graph, patches/TextSets, reviews, verification; Git integration as effect |
| Delivery | desired state where cognition is required; authorization/effects/observation as control operations |

Development may have more fan-out/fan-in topology. It is not another worker
runtime.

---

## 25. One queue and one dispatch authority

There is one infrastructure dispatch/concurrency mechanism.

Infrastructure selects eligible queued Workplaces, records reservation/fence,
builds immutable execution context, resolves replay eligibility, then launches
the chosen physical worker.

Worker never chooses work. Module never starts workers. Replay lookup is part of
normal assignment, not another queue.

---

## 26. Execution authority and supervision

Every WorkerExecution has unique execution identity, fence and immutable
execution context.

Execution context pins:

- Workplace/WorkIntent authority;
- allowed Saga tools;
- exact read set / input identity;
- model/executor route;
- replay key and exact capsule ref on hit;
- provenance hashes.

All managed MCP calls validate this fail-closed.

Replay worker receives no broader authority than corresponding LLM worker.

Liveness, progress, process identity and lease supervision remain execution
concerns independent of Workplace continuity.

---

## 27. Production journal

Journal explains production; it does not authorize transitions by itself.

It records exact provenance for WorkerExecutions, product submissions,
CandidateSets, CheckReceipts, GateDecisions, EffectAttempts and replay source.

Journal distinguishes inference production from deterministic replay without
changing downstream semantics.

Accepted products/GateDecisions remain immutable authority evidence. Capsule is
derived reusable evidence.

---

## 28. Mandatory replay/certification scenarios

The shared conformance suite must prove at least:

1. Capsule miss preserves selected provider/model/effort and launches normal
   model path.
2. Exact capsule hit uses deterministic replay but leaves project model settings
   unchanged.
3. Input/package/contract change creates a miss.
4. Reviewer capsule key is pinned to exact author CandidateSet digest.
5. Repository base mismatch prevents Git replay.
6. Replay produces a new current CandidateSet and current GateRun.
7. Old GateDecision/lifecycle/Workplace state is never replayed.
8. Capsule is certified only from CellFinalAcceptance.
9. Reviewed cell certifies exactly final author + reviewer sets, not historical
   rejected attempts.
10. Rejected/repair/human-required/failed candidates never become capsules.
11. Stale accepted GateDecision that loses transition authority cannot certify.
12. Crash after final acceptance but before archive capture is repaired by lazy
   reconstruction.
13. Replay MCP calls pass through same authority gateway as LLM calls.
14. Corrupt replay hit fails closed and does not silently call a model in the
   same execution.
15. A replayed capsule rejected by current Gate is not replayed again in the
   next recovery attempt of that Workplace.
16. Unpinned live external input marks execution non-replayable or is first
   materialized as immutable input product.
17. Same project supports Run A (model production) then intentional new Run B
   from beginning (capsule replay) without table resets, cross-project copying
   or another runtime.
18. Conformance fixture project can complete through normal Factory Start from
   prebuilt capsules without mock/hybrid routing.

---

## 29. Mandatory effect/observation scenarios

External-effect conformance is at least as important as replay conformance.

Prove:

1. Crash after an effect happened externally but before receipt consumption
   converges without a duplicate external change.
2. Duplicate EffectAttempt with same idempotency identity has one effective
   external result.
3. Retry observes external state before repeating the action.
4. Unsupported compensation never occurs implicitly.
5. Explicit compensation is a separate authorized Effect with its own receipt.
6. Observation retry does not create another worker/runtime/queue.
7. Deployment observation eventually reaches healthy/degraded/failed or an
   explicit bounded/human-required terminal policy.

---

## 30. Fitness functions, not only prose

This document is architectural source of truth, but important invariants must be
mechanically enforced.

CI/architecture tests should reject at least:

- module-name/task-kind switches in universal dispatch/cell physics;
- module-specific submit/read protocols;
- mock/hybrid factory execution modes;
- replay code mutating GateDecision/Workplace/lifecycle directly;
- capsule payload containing old GateDecision as replay authority;
- capsule certification from raw `verdict === accepted` without
  CellFinalAcceptance;
- repeat use of a capsule already rejected by current Gate in the same
  Workplace recovery chain;
- replayable worker with unpinned live-read capability;
- direct domain imports of SQLite/replay/simulator adapters;
- test harness that resets production tables or copies capsules across projects
  merely to simulate a second normal Factory Start.

Architecture review checklists complement executable fitness functions; they do
not replace them.

---

## 31. DDD interpretation

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

Replay persistence is infrastructure/production-evidence support. It is not a
workshop, lifecycle or acceptance aggregate.

### Important aggregates

| Aggregate | Core invariant |
|---|---|
| Project | stable product/replay scope; may have multiple intentional Factory Runs |
| ProcessRun/LifecycleRun | one execution of lifecycle; resume continues this identity |
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

## 32. Hexagonal dependency rule

```text
CLI / MCP / UI / scheduler
        -> application use cases
        -> domain contracts/policies
        <- ports
        <- SQLite / filesystem / model / replay / Git adapters
```

Replay implementation belongs behind execution/production ports. Domain code
must not import SQLite replay repositories or simulator scripts.

A replay executor is an outbound adapter implementing the same physical worker
contract as an inference driver.

---

## 33. Canonical factory glossary

| Human term | Machine meaning |
|---|---|
| Factory / conveyor | Saga runtime |
| Project / product | stable product scope and replay namespace |
| Factory Run | one intentional ProcessRun/LifecycleRun execution |
| Resume | continuation of the same Factory Run |
| Workshop | Process Module package |
| Production Cell | declarative worker/check/review/gate loop |
| Workplace | materialized Production Cell instance in one run |
| Worker | one WorkerExecution, regardless of physical implementation |
| LLM worker | WorkerExecution backed by inference |
| Replay worker | WorkerExecution backed by certified capsule recipe |
| Card | WorkItem projection |
| Desk | Workplace-scoped workspace/product view |
| Candidate batch | CandidateSet |
| Quality engineer | GateRun |
| QC act | GateDecision |
| Final QC acceptance | CellFinalAcceptance proof/value |
| Defect sheet | RecoveryIssue |
| Replay capsule | certified reconstruction recipe for worker production |
| Effect | authorized external state change |
| Observation | retryable provider/control read of external state |

The quality department is not another workshop. Replay is not another factory.
Observation is not another worker engine.

---

## 34. Architecture review questions

For every change ask:

1. Does it introduce another factory/runtime path?
2. Does core branch on workshop/module names?
3. Is physical worker implementation leaking into Production Cell semantics?
4. Does worker completion merely seal CandidateSet?
5. Is final acceptance proven rather than inferred from raw `accepted`?
6. Could stale/superseded decision advance or certify anything?
7. Is ReplayCapsule treated as derived production rather than authority?
8. Does replay traverse current CandidateSet, Gate, settlement and lifecycle?
9. Does replay preserve normal authority and RepositoryDesk?
10. Does model selection remain independent from replay availability?
11. Are all semantically relevant worker inputs exact/pinned?
12. If replayed production fails current Gate, can the same capsule loop again?
13. Can crash after final acceptance reconstruct missing capsule safely?
14. Can same Project intentionally start a new Factory Run from beginning without
    resetting tables or copying capsules to another project?
15. Is external effect retry idempotent and observe-before-retry?
16. Is compensation explicit rather than implicit rollback?
17. Is an observation loop a control/provider operation rather than a hidden
    second runtime?
18. Does the test harness start the same normal Factory rather than simulate it?

If an answer requires a second engine, second acceptance mechanism or
module-specific replay path, the design is wrong.

---

## 35. Condensed conformance checklist

### Factory

- one normal Factory Start mechanism;
- Project may have multiple intentional Factory Runs;
- resume continues same run;
- one dispatch/concurrency mechanism;
- one Production Cell runtime;
- no mock/hybrid lifecycle mode;
- modules never launch workers.

### Worker production

- immutable execution context before spawn;
- closed exact read surface for replayable executions;
- one normal MCP/product surface;
- inference/replay workers have identical product authority;
- stale execution cannot submit;
- completion seals CandidateSet only.

### Quality

- exact CandidateSet subjects;
- reviewer pinned to exact author set;
- current CheckPlan always runs;
- GateDecision append-only;
- CellFinalAcceptance proves final durable acceptance;
- only final accepted transition publishes output/advances.

### Replay

- lookup replay-first by default;
- miss = selected model;
- hit = deterministic worker;
- key excludes model/transient/run attempt IDs;
- capsule certified only from CellFinalAcceptance;
- reviewed cell certifies exact final author + reviewer;
- rejected capsule is ineligible for immediate same-Workplace recovery replay;
- corrupt hit fails closed;
- GateDecision/Workplace/lifecycle never replayed;
- archive may be reconstructed lazily from durable accepted evidence.

### Desk/Git

- factory prepares repository desk;
- worker does not create/switch arbitrary worktree;
- Git replay validates exact base and resulting tree.

### Effects

- exact desired-state identity;
- idempotent EffectAttempt/EffectReceipt;
- observe-before-retry;
- no implicit rollback;
- compensation explicit when supported;
- observation control retries do not create another worker engine.

### Recovery/checkpoint

- repair stays on same Workplace;
- recovery budget durable/sticky;
- replay does not reset recovery;
- checkpoint restores machine state;
- replay reconstructs certified worker production.

---

## 36. Operational rule of thumb

The fastest test for any new mechanism is:

> **After a worker has submitted exact products, can the rest of the factory run
> identically without knowing whether those products came from GLM, Claude,
> Qwen or a replay capsule?**

If yes, the design respects the conveyor.

If no, physical worker implementation leaked into factory physics.

A second equally important test is:

> **Can the same Project be intentionally started again as a new Factory Run,
> reuse eligible capsules, and still execute all current quality/lifecycle code
> without resetting production state?**

If no, run identity has been incorrectly collapsed into project identity.

---

## Operational appendices

- [Universal transition diagnostics and logging](CONVEYOR-TRANSITION-DIAGNOSTICS.md)
- [Transition acceptance and incident checklist](CONVEYOR-TRANSITION-CHECKLIST.md)
- [Factory Domain Acceptance Registry](FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md)

Workshops are configuration instances of this protocol, not separate lifecycle
engines. Replay is a standard worker-production optimization inside the same
protocol, not another mode of the factory.
