---
name: saga-factory-qa
description: "Mandatory fail-closed pre-commit architecture QA for Saga4. Run before every commit that changes Factory runtime, start/resume entrypoints, workshops, Production Cells, Workplace/RepositoryDesk, WorkerExecution, package/workspace resources, product contracts, CandidateSets, Gates, review/recovery, replay, lifecycle, effects, persistence, parsers/validators, or Factory Contract harnesses. Blocks local fixes that create workshop-specific physics, make workers guess contracts or representation grammar, break replay identity, reset reusable production, or bypass the Conveyor Mental Model."
---

# Saga Factory QA — pre-commit architecture regression gate

## Mission

You are the architectural regression firewall for Saga4.

Your task is NOT merely to decide whether the changed feature works locally.
You must prove that the candidate commit still obeys the common Factory physics,
that a worker receives the exact contract it is expected to satisfy, that
runtime parsers/validators do not secretly require a representation grammar the
worker was never given, and that start/resume/replay/recovery preserve the
intended durable production semantics.

The recurring failures this skill exists to prevent are:

```text
agent changes one workshop/cell
  -> local tests become green
  -> agent introduces private runtime/desk/recovery/replay behavior
  -> sibling workshop still uses another path
  -> Factory concept silently splits
```

and:

```text
Workshop declares output schema X
  -> worker receives only a schema id / prose hint
  -> model guesses the JSON shape
  -> partial product is persisted
  -> happy-path test does not notice missing fields
```

and:

```text
worker-visible contract permits representation A
  -> parser silently assumes narrower representation B
  -> semantically valid worker output parses as empty/invalid
  -> worker_done is rejected repeatedly
  -> system blames the model instead of the producer/consumer contract drift
```

and:

```text
Run A captures accepted production
  -> test/operator entrypoint deletes or reprovisions the persistence scope
  -> Run B starts from an empty capsule store or a different semantic identity
  -> model work repeats
  -> report incorrectly concludes that Replay does not work
```

and:

```text
factory host crashes while a worker owns a Workplace
  -> startup reaper releases only the task/execution row
  -> Workplace keeps a stale active reservation / running state
  -> replacement worker is claimed under split authority
  -> completion later fails a fence or the cell remains stuck
```

The governing rule is:

> ONE PRODUCTION INTERFACE, ONE MATERIAL, ONE DESK, ONE FACTORY RUNTIME.

A second governing rule follows from it:

> THE WORKER MUST NOT GUESS ITS PRODUCT CONTRACT.

A third governing rule is equally mandatory:

> THE WORKER MUST NOT GUESS A HIDDEN SERIALIZATION OR MARKUP GRAMMAR.

A fourth governing rule protects continuity:

> RESUME CONTINUES THE SAME DURABLE RUN; NEW START MAY REPLAY CERTIFIED PRODUCTION, BUT MUST NOT RESET THE PERSISTENCE THAT MAKES REPLAY POSSIBLE.

A parser may be stricter than generic Markdown/YAML/JSON only when that stricter
grammar is part of the canonical contract AND is delivered to the worker through
the pinned WorkplaceDesk. Otherwise the parser must accept every representation
that the delivered contract legitimately permits and canonicalize it before
domain validation.

The canonical architecture source is:

`docs/architecture/CONVEYOR-MENTAL-MODEL.md`

Read it fresh and completely on EVERY invocation.
Do not rely on memory, summaries, task descriptions, commit messages, comments,
previous QA output, or the author's explanation.

This skill is fail-closed:

```text
PASS_TO_COMMIT = architecture, contract delivery, representation parity and continuity proven
BLOCKED        = an invariant is violated
NOT_PROVEN     = required evidence is missing; this also blocks commit
```

Green tests alone are never sufficient evidence.

---

# Mandatory architecture contracts to read

For every Factory-related review read, in addition to the Conveyor Mental Model:

```text
src/process-modules/domain/process-module.ts
src/process-modules/domain/workplace/production-cell-definition.ts
src/process-modules/application/node-executors/production-cell-node-executor.ts
src/process-modules/application/workspace-projection.ts
src/process-modules/application/pinned-workspace-materializer.ts
src/app/product-lifecycle-runtime.ts
```

For changes touching start/resume/replay/crash recovery also read the applicable
end-to-end control path, including:

```text
src/app/factory-start.ts
src/app/product-lifecycle-run-starter.ts
src/process-modules/application/lifecycle-orchestrator.ts
src/process-modules/persistence/sqlite-lifecycle-run-repository.ts
src/infrastructure/replay/replay-claim-binder.ts
src/infrastructure/replay/sqlite-replay-capsule-repository.ts
src/infrastructure/replay/replay-capture-effect.ts
src/replay/replay-capsule.ts
src/infrastructure/work/sqlite-work-assignment-adapter.ts
src/infrastructure/work/worker-supervision-service.ts
src/infrastructure/workers/claude-board-worker-executor.ts
src/infrastructure/persistence/sqlite-factory-runtime-repositories.ts
src/application/conveyor-runtime.ts
src/lifecycle/atomic-release.ts
src/lifecycle/work-assignment-core.ts
scripts/factory.mjs
tests/factory-contract/recovery-replay-continuity.test.mjs
and every bootstrap/reset/smoke script used as evidence
```

For every affected structured worker product also read:

```text
- the concrete ProcessModuleDefinition / ExecutionProfileDefinition;
- the concrete ProductContract / output schema declaration;
- the semantic skill that tells the worker what to produce;
- every declared workspaceTemplate / callTemplate / checklist used to describe it;
- the module package resource index/manifest that pins those bytes;
- the deterministic validator / CheckProvider that decides whether the product
  satisfies the contract;
- every parser/canonicalizer used before that validator;
- representative examples/templates if the parser relies on textual or markup
  structure such as Markdown headings, fenced blocks, YAML list markers, field
  order, indentation, quoting or separators.
```

For every parser or textual-contract change, read the producer AND consumer
sides even if only one side is in the diff. A regex is part of an executable
consumer contract and therefore must be audited against the worker-visible
producer contract.

Then read changed implementations and sibling consumers.

The current foundational contracts are:

```text
ProcessModuleDefinition
  = base declarative contract of a Workshop / Process Module

ProductionCellDefinition
  = base declarative contract of the universal worker-quality cell

ExecutionProfileDefinition
  = declarative worker contract: skills, tools, templates, checklists, output schema

WorkspaceProjection + materializePinnedWorkspace
  = generic package -> exact WorkplaceDesk contract/resource delivery path

ProductionCellNodeExecutor
  = shared runtime implementation of Production Cell physics

Product lifecycle composition root
  = constructs shared Factory runtime once and plugs workshops into it
```

This is COMPOSITION, not a family of private runtimes.
A Workshop "inherits" Factory behavior by declaring itself through the shared
contracts and extension points. It must not copy the runtime implementation.

If a Workshop needs a new common Factory capability, extend the shared contract
and shared runtime first, then let all Workshops consume it declaratively.

---

# Ownership model

A normal Workshop may declare WHAT:

```text
identity/version
input/output contracts
outcomes
Flow
Production Cells
execution profiles / semantic skills
worker-visible templates/checklists/instructions
product schemas/contracts
representation grammar when a narrow grammar is genuinely required
CheckPlans and deterministic domain validators
policies and invariants
bounded recovery policy
optional post-acceptance Effect hook
domain-specific settlement/output mapping
```

A Production Cell may declare WHAT through `ProductionCellDefinition`:

```text
input selectors
materialization/workKey selectors
author profile
product contracts
author CheckPlan
optional reviewer profile + final CheckPlan
bounded recovery policy
optional post-acceptance Effect id
transitions
```

Factory runtime owns HOW:

```text
Factory Start / resume
ProcessRun/LifecycleRun progression
module package installation and pinning
resource resolution from pinned package bytes
Workplace/WorkplaceDesk materialization
dispatch/concurrency
RepositoryDesk allocation
WorkerExecution assignment/fencing/launch
worker protocol and authority
product persistence
CandidateSet sealing
GateRun / GateDecision
review loop
repair/recovery execution
replay lookup/capture/execution/rebinding
CellFinalAcceptance
external Effect execution
lifecycle progression
```

A Workshop must not receive Factory authority merely because its domain is
special.

---

# Gate 0 — base-interface protection

Evaluate this BEFORE feature-specific checks.

## BI-01 — exactly one Workshop contract

Normal Workshops enter through `ProcessModuleDefinition` / `FlowDefinition`.
FAIL if the diff introduces another normal Workshop interface/registry/runtime.

## BI-02 — exactly one Production Cell contract

Normal worker-quality loops are declared through `ProductionCellDefinition` and
executed by the shared Production Cell runtime.
FAIL if a Workshop creates a private author/reviewer/recovery cell engine.

## BI-03 — extension points remain declarative

Skills, schemas, selectors, templates, CheckPlans, policies and effect ids are
allowed declarations. They must not grant a Workshop direct authority to mutate
Workplace, CandidateSet, Gate, lifecycle, replay eligibility or Effect state.

## BI-04 — no copied common mechanism

Actively search changed Workshop code for logic resembling shared:

```text
workspace/desk materialization
dispatch/fencing
CandidateSet sealing
Gate/reviewer loop
recovery
replay
RepositoryDesk
lifecycle progression
```

Ask: "Would a second Workshop need this exact mechanism?"
If yes and it lives under one Workshop, FAIL unless it is a domain adapter
behind a shared interface.

## BI-05 — new Workshop thought experiment

A hypothetical normal Workshop X must obtain worker production, desk resources,
review, repair, replay and effects by supplying declarations and registered
providers only.

If Workshop X must copy Discovery/Formalization/Development runtime code, FAIL.

## BI-06 — dependency direction

PASS only if:

```text
Workshop declaration -> shared domain/application contracts
Factory runtime       -> shared contracts, not concrete Workshop classes
```

FAIL on generic Factory code importing concrete Workshop infrastructure to
implement generic physics, or branching on Workshop identity where a declaration
or provider should decide behavior.

---

# Canonical worker-producing path

For every affected worker path reconstruct this concrete chain and name the
file/function/class at every hop:

```text
Factory Start / current ProcessRun
  -> pinned ProcessModule installation/package
  -> Workshop declaration (ProcessModuleDefinition)
  -> Production Cell declaration (ProductionCellDefinition)
  -> ExecutionProfileDefinition
       -> semantic/protocol skill
       -> allowed tools
       -> outputSchema
       -> trackerTemplate
       -> workspaceTemplates
       -> callTemplates
       -> checklists
  -> generic WorkspaceProjection
  -> generic pinned WorkplaceDesk materialization
       -> worker-visible contract files
       -> recovery/review feedback when applicable
       -> RepositoryDesk when git-changing
  -> fenced WorkerExecution
  -> common product_read / product_submit / worker_done protocol
  -> immutable CandidateSet
  -> representation parser/canonicalizer when applicable
  -> deterministic CheckPlan / validator over exact CandidateSet
  -> current GateRun
  -> append-only GateDecision
  -> current Workplace transition
       -> repair on SAME Workplace
       OR
       -> CellFinalAcceptance
  -> authorized Effect if declared
  -> current lifecycle progression
```

If one hop is unknown, verdict for that invariant is `NOT_PROVEN`.

---

# Contract-on-Desk invariant

A schema id is not a usable worker contract by itself.
For every structured worker product prove THREE channels when textual parsing is
involved, otherwise prove the first two:

```text
GUIDANCE CHANNEL
canonical contract declaration
  -> pinned package resource
  -> profile declaration
  -> generic WorkspaceProjection
  -> exact WorkplaceDesk
  -> worker is explicitly told where/how to read it

REPRESENTATION CHANNEL
canonical semantic contract
  -> allowed textual/serialization representations
  -> any intentionally narrow grammar is explicitly worker-visible
  -> parser/canonicalizer accepts exactly that declared language
  -> canonical structure is produced

AUTHORITY CHANNEL
submitted CandidateSet / produced artifact
  -> deterministic validator / CheckProvider over canonical meaning
  -> current GateDecision
```

The guidance channel helps the model produce the right meaning and shape.
The representation channel guarantees the consumer does not invent hidden
syntax. The authority channel prevents incomplete/wrong meaning from being
accepted. None substitutes for another.

A raw invalid `product_submit` row MAY exist as worker production/audit material.
That is not itself an architecture defect. The hard invariant is:

> malformed or incomplete production must be unable to obtain final acceptance.

A template is guidance, not authority. A validator/CheckProvider is authority,
not worker guidance. A parser is neither semantic guidance nor acceptance
authority: it is a representation boundary and must not silently redefine the
contract.

---

# Representation Contract invariant

For every human-readable worker artifact that is later parsed by code, define
which of these two modes applies:

```text
MODE 1 — NORMATIVE GRAMMAR
There is exactly one intentionally strict representation grammar.
The canonical contract declares it, pinned worker guidance shows it exactly,
and the parser rejects deviations consistently.

MODE 2 — SEMANTIC CONTRACT WITH MULTIPLE REPRESENTATIONS
The contract defines semantic fields/sections but does not mandate one exact
markup serialization. The parser must accept all representations legitimately
allowed by the delivered contract and canonicalize them before validation.
```

FAIL if the implementation is accidentally between the modes, for example:

```text
skill says "each D2 row must include ac, module, pattern..."
parser secretly requires fenced YAML
parser secretly requires "- ac:" instead of "ac:"
parser treats a nested Markdown subsection as end of the parent section
```

Do not fix such drift automatically by making the parser maximally permissive.
First determine the intended contract:

```text
if syntax is semantically important -> make it canonical + pinned + explicit
if syntax is only representation     -> canonicalize equivalent forms
```

---

# Continuity invariant — Resume vs New Start vs Replay

The Factory has three different continuity mechanisms. QA must never conflate
them:

```text
RESUME
  same LifecycleRun / ProcessRun / StageRun / Workplace authority
  completed durable work is read directly from the same run
  only unfinished/crashed execution is recovered

NEW FACTORY START, SAME PROJECT
  new LifecycleRun / ProcessRun / Workplace authority
  certified worker production may be reconstructed from ReplayCapsules
  current CandidateSets/Gates/lifecycle transitions run again

CHECKPOINT ADOPTION / RESTORE
  explicit import/restore mechanism with its own trust and compatibility checks
  not a substitute for ordinary same-DB resume or Replay
```

For a normal host crash, previously completed stages MUST NOT be replayed through
LLM or capsules merely to reconstruct progress. The durable LifecycleRun and its
completed StageRun/ProcessRun records are the source of truth. Replay is the
cross-run production reuse mechanism, not the same-run cursor mechanism.

For an intentional new Factory Start, reusable capsules MUST remain available in
the same persistence scope. Deleting the DB, deleting `factory_replay_capsules`,
creating a new Project, or copying capsules into another DB is not a valid Run B
proof.

Replay semantic identity must contain product semantics and intentional contract
compatibility inputs, not operator/runtime provenance. Fields such as these are
presumptively NON-semantic unless a concrete contract proves otherwise:

```text
initiatedBy / operator name
launch_ref / order_ref / idempotency key
LifecycleRun / ProcessRun / StageRun ids
Workplace / WorkerExecution / task / CandidateSet refs
timestamps / pid / machine / log path / workspace path
CLI option values unrelated to the product idea
```

`packageDigest` is intentionally compatibility-sensitive: changed pinned
contract/skill/template bytes MAY and normally SHOULD cause a replay miss.

The public/operator entrypoint must parse control options independently from
business input. A flag value such as model name, sandbox name, concurrency or
DB path must never become part of `initiative.subject`, `semanticInputDigest`,
or another replay-semantic field merely because of argv slicing.

Stabilizing an operator field at one entrypoint is NOT sufficient proof that it
is non-semantic. If `initiatedBy` or another provenance field reaches a stage
input, the semantic-digest canonicalization boundary itself must exclude it (or
an explicit product contract must prove that it is semantic). QA must inspect
the code that computes `semanticInputDigest`, not only the CLI/start facade.

A replay miss is not diagnosable from `capsule_ref=null` alone. QA requires a
component-wise comparison of ReplayKey material between expected source capsule
and current claim:

```text
projectId
moduleRef
nodeId
productionCellId
workKey
role
packageDigest
semanticInputDigest
subjectProductionDigest when reviewer
```

The report must say WHICH component differs and whether that difference is
semantic, compatibility-sensitive, or accidental provenance.

Crash recovery has an additional atomicity invariant:

```text
dead/stale WorkerExecution
  -> same recovery authority transition
       WorkerExecution terminalized
       Workplace running/leased -> repair_wait (or declared equivalent)
       stale activeReservationRef cleared
       task reverse projection/fence released coherently
  -> replacement execution receives a NEW reservation
```

FAIL if one crash path updates only `worker_executions/tasks` while another path
also updates Workplace authority. Close callbacks, startup supervision/reaper,
lease expiry and explicit recovery must converge through one semantic recovery
use case or prove byte-for-byte equivalent atomic effects.

The WorkerExecution terminalization, Workplace crash transition and task fence /
reverse projection should commit as one DB atomic unit. If an implementation
splits them across transactions, QA requires a crash-between-steps recovery test
that proves deterministic convergence before a replacement can be claimed;
otherwise the result is `NOT_PROVEN`.

A replacement claim MUST NOT be allowed to run under a Workplace whose
`activeReservationRef` still points to a terminal/lost execution. Treating an
already `running` Workplace as an idempotent no-op when the reservation differs
is not recovery.

---

# QA procedure

## Phase 0 — exact commit candidate

1. Inspect staged diff.
2. Inspect unstaged files that could be accidentally omitted.
3. Record every changed file.
4. Read enough surrounding code to reconstruct control/data flow.
5. Follow delegation into shared infrastructure.
6. Search outside the diff for sibling implementations of the same concept.
7. For changed product/schema/template code, trace all applicable Contract-on-Desk channels.
8. For parser/validator changes, inspect the producer skill/template and enumerate every syntactic assumption enforced by code.
9. For repeated worker_done/submission failures, inspect the exact validation error path before attributing failure to model behavior.
10. For replay/start/resume changes, trace the actual operator entrypoint through claim-time replay binding and prove persistence is preserved.
11. For crash/reaper changes, compare controlled close recovery with startup supervision recovery at WorkerExecution + Workplace + task authority boundaries.
12. Distinguish architecture/source ratchets from behavioral proofs. A regex/source assertion may prevent accidental deletion but cannot by itself prove runtime crash/replay semantics.

Classify changed files:

```text
Workshop declaration
Factory runtime
Factory start/resume entrypoint
Lifecycle
Production Cell
Execution profile / contract resource
Workspace projection/materialization
Workplace
RepositoryDesk
WorkerExecution
Product/material
Representation parser/canonicalizer
CandidateSet
Check/Gate
Review
Recovery
Replay
Replay identity / semantic digest
Checkpoint
Effect
Persistence
Test/bootstrap/reset harness
Test physical worker
Test authority/harness
Other
```

Do not review only changed lines.

## Phase 1 — Architecture Impact Matrix

Before running tests produce:

| invariant/concept | changed implementation | shared entry point | second consumer/workshop | falsifying evidence/test | verdict |
|---|---|---|---|---|---|

Every affected shared mechanism must have a second consumer inspected.
A blank second-consumer column for shared physics is `NOT_PROVEN`.

For structured worker output add a Contract-on-Desk row containing:

```text
output schema
worker-visible resource(s)
materializer path
representation mode + parser/canonicalizer when applicable
validator/CheckProvider
positive compatible-representation probe when applicable
negative malformed-product test
```

For replay/resume changes add a Continuity row containing:

```text
entrypoint
same-run resume identity
new-start identity
capsule persistence location
ReplayKey material diff proof
worker invocation count
crash-reaper Workplace transition proof when applicable
behavioral runtime proof vs source-only ratchet
```

## Phase 2 — explicit checklist

Every applicable item is exactly one of:

```text
PASS
FAIL
N/A — reason
NOT_PROVEN — missing evidence
```

`NOT_PROVEN` blocks commit.

## Phase 3 — mandatory cross-path probes

Use the Risk Trigger Matrix below.
Never certify a generic mechanism from only the Workshop being changed.

## Phase 4 — verdict

Only `PASS_TO_COMMIT` permits commit.

If blocked, identify the smallest correction at the proper common ownership
layer. Never propose a Workshop-local workaround for Factory physics.

---

# Explicit pre-commit checklist

## A. Workshop / Factory ownership

### QA-A01 — Workshop declares WHAT, Factory owns HOW
Changed Workshop code remains declarative/domain-specific.

### QA-A02 — canonical base interfaces are used
Changed Workshop/Cell enters through shared ProcessModule/ProductionCell
contracts.

### QA-A03 — no competing base interface/runtime
No second normal Workshop/ProductionCell runtime exists.

### QA-A04 — no Workshop-specific Factory runtime leak
Shared runtime does not depend on Discovery/Formalization/Development/Delivery
infrastructure to implement generic physics.

### QA-A05 — no Workshop-name branching in core physics
Module/schema/cell names do not select private runtime behavior where shared
contracts/providers should.

### QA-A06 — one owner per authority responsibility
Identify one authoritative owner for assignment, Workplace, CandidateSet,
GateDecision, repair, RepositoryDesk, effects and lifecycle progression.

### QA-A07 — new Workshop thought experiment passes
A new normal Workshop obtains standard behavior by declaration, not copied code.

---

## B. Contract-on-Desk / schema handoff

### QA-B01 — output schema chain is coherent

For every affected worker product compare and record the exact schema id at all
applicable declarations:

```text
Flow node outputSchema
ProductionCellDefinition.productContracts[].schemaRef
ExecutionProfileDefinition.outputSchema
WorkIntent/output_schema projection
product_submit schema
CheckPlan/validator expected schema
```

Any unexplained mismatch is FAIL.

### QA-B02 — worker-visible contract exists

For a nontrivial structured product, the worker must receive a concrete pinned
contract aid: call template, schema resource, checklist/instruction, or another
explicit machine-delivered representation containing the required shape.

FAIL if the worker is expected to infer required fields/enums/nesting merely
from a schema id such as `factory.foo.v1` or from undocumented memory.

### QA-B03 — resource is declared by the owning profile

The exact template/schema/checklist must be referenced through the module/profile
contract (`workspaceTemplates`, `callTemplates`, `checklists`, instructions, or
an explicitly canonical equivalent).

Do not count a random file existing somewhere in the repository.

### QA-B04 — resource is pinned and content-addressed

Prove the declared contract resource appears in the module package resource
index and is resolved from the ProcessRun-pinned package installation/digest.

FAIL if a running worker can silently see machine-global/current-tree bytes that
are not pinned to its module package.

### QA-B05 — generic materializer puts it on the exact WorkplaceDesk

Trace through shared `WorkspaceProjection` and `materializePinnedWorkspace` (or
an explicitly canonical successor).

FAIL if Discovery/Formalization/Development need separate resource-copy logic.

### QA-B06 — worker is explicitly pointed to the contract

A file existing on disk is insufficient. Prove the launch/desk projection makes
the relevant `callFiles`, `workspaceFiles`, checklist path, assistance projection
or equivalent visible to the worker so the worker knows what to read/use.

If this cannot be reconstructed, `NOT_PROVEN`.

### QA-B07 — template, skill, canonical contract and authority do not drift

Compare ALL producer/consumer contract surfaces, not only template vs validator:

```text
semantic skill
canonical schema/contract constant
worker-visible template/example/checklist
parser/canonicalizer
submission validator
CheckProvider / Gate authority
reviewer contract when applicable
```

At minimum compare:

```text
schema id/version/digest
required top-level fields
required nested fields
allowed enums
identity/binding fields
evidence/source-reference requirements
cardinality/multiplicity
representation constraints when textual parsing is involved
```

Any unexplained disagreement is FAIL. A permissive validator is also drift when
the canonical producer contract forbids values. Example: if the skill permits
only `implementation|verification` but the canonical enum still permits
`spike|merge_with`, QA must report contract drift rather than treating the
superset as harmless.

### QA-B08 — validator is deterministic and Gate-owned

There must be a deterministic CheckProvider/validator or equivalent Factory gate
that validates the exact CandidateSet product against the contract.

The model must not self-certify its own JSON shape.

### QA-B09 — malformed product cannot become accepted

Require a negative proof: remove/corrupt at least one required field or binding
and demonstrate that current Gate authority does NOT produce final acceptance.
Expected outcomes may be `repair_required`, `human_required`, or terminal failure
according to policy, but never accepted.

Do not require `product_submit` itself to reject malformed production unless that
is its declared responsibility. Persistence of a rejected candidate is allowed.

### QA-B10 — source-bound contracts verify exact identity

When a product refers to an upstream ProductRef/CandidateSet/repository snapshot,
prove the validator checks the exact current id/digest/binding, not only the
shape.

### QA-B11 — retry sees contract + feedback together

A repair WorkerExecution on the same Workplace receives the same pinned contract
resources plus current authoritative recovery/review feedback. A retry must not
lose the template or switch to unpinned current-tree instructions.

### QA-B12 — replay remains contract-compatible

Replay eligibility/certification must include the package/contract semantic
identity required by the architecture. A capsule produced under stale contract
bytes must not masquerade as production under a changed pinned package.

### QA-B13 — cross-Workshop contract-delivery proof

If shared workspace/package/materialization code changes, inspect/test at least
two distinct Workshops/profiles. Default:

```text
Discovery readiness structured typed product
AND
one Formalization or Development structured typed product
```

Both must use the SAME projection/materializer path.

### QA-B14 — template existence is not enough

The following is forbidden reasoning:

```text
"template exists on the desk" -> PASS
```

Required reasoning is:

```text
profile declares exact resource
  -> pinned package contains exact bytes
  -> generic materializer exposes it to this worker
  -> worker is told to use/read it
  -> skill/template/canonical contract agree
  -> parser accepts the declared representation language
  -> validator checks the canonical meaning
  -> malformed candidate is rejected by current Gate
```

---

## C. Worker boundary and material

### QA-C01 — same worker protocol for model/replay/scripted workers
No special acceptance path by provider or test mode.

### QA-C02 — workers do not mutate Factory authority
Worker/scenario code cannot directly mutate Workplace, CandidateSet, Gate,
lifecycle, settlement or Effect completion.

### QA-C03 — schema means product meaning, not another runtime
Schema id must not select a second persistence/submit/lifecycle engine.

### QA-C04 — exact reads
Consumers use exact ProductRefs / accepted bindings / CandidateSets, never
"latest worker output" heuristics.

---

## D. Workplace / WorkerExecution / RepositoryDesk

### QA-D01 — Workplace is durable work identity
Durable production, desk state and repair belong to Workplace.

### QA-D02 — WorkerExecution is one disposable attempt
Retry/replay/reviewer execution does not become new semantic work.

### QA-D03 — workKey is semantic
No execution/task/timestamp identity in semantic workKey.

### QA-D04 — sibling Workplace isolation
One Workplace cannot overwrite another's production, gate, feedback or desk.

### QA-D05 — Factory owns RepositoryDesk
Factory provisions path/worktree/branch/base before code worker launch.

### QA-D06 — physical worker consumes assigned RepositoryDesk
Model/replay/scripted worker uses the assigned execution desk, not a global path.

### QA-D07 — no shared mutable checkout for parallel workers
FAIL if sibling git-changing executions use global `git checkout` in one worktree.

### QA-D08 — submitted source matches assigned desk
Branch/commit/tree/base in worker product correspond to that RepositoryDesk.

### QA-D09 — Git integration is an Effect
Merge/push occurs only after current final acceptance under runtime authority.

### QA-D10 — parallel desk proof
For Git changes require >=2 concurrent git-changing work items with isolated
desks and stable source branches.

---

## E. CandidateSet / Gate / review / recovery

### QA-E01 — CandidateSet is the QC handoff
Worker completion != acceptance.

### QA-E02 — CandidateSet members are exact immutable ProductRefs
Later repair cannot mutate historical QC material.

### QA-E03 — reviewer is pinned to exact current author CandidateSet
Current QC uses current authority refs.

### QA-E04 — current Gate evaluates current candidates
Replay/repair/reviewer retry creates current authority objects.

### QA-E05 — GateRun identity covers all authority inputs
Assessment CandidateSets distinguish reviewer attempts.

### QA-E06 — GateDecision is append-only current authority
No old decision is restored/mutated into current authority.

### QA-E07 — repair target is explicit
`repairTargetRole` comes from CheckPlan/policy reduction. Coordinator executes it
and does not guess by Workshop/schema/prose.

### QA-E08 — decision identity covers authoritative meaning
Fields such as repair target participate in immutable decision identity where
required.

### QA-E09 — CellFinalAcceptance is stronger than check pass
Certification/effects/lifecycle require accepted GateDecision applied to expected
Workplace revision and terminal accepted state.

### QA-E10 — one universal author/reviewer loop
Normal reviewed cells use Production Cell mechanics.

### QA-E11 — valid negative review repairs author
A valid `changes_requested`-style verdict routes author repair.

### QA-E12 — invalid reviewer output can repair reviewer
Malformed/unbound/indeterminate reviewer result does not rewrite author production.

### QA-E13 — recovery is same Workplace, new WorkerExecution
Feedback cites exact rejected material.

### QA-E14 — feedback comes from authority
Use current GateDecision + failing CheckReceipts + exact rejected CandidateSet /
ProductRefs, not log prose.

### QA-E15 — stale feedback is superseded
New accepted authority clears old repair projection.

### QA-E16 — retry budget is durable and bounded
Respawn/resume cannot mint unlimited semantic repairs.

### QA-E17 — no private Workshop recovery runtime
Search outside the diff explicitly.

### QA-E18 — cross-Workshop recovery proof
If review/recovery changes, inspect/test at minimum Formalization + Development.
Discovery-only proof is insufficient.

### QA-E19 — every crash path updates Workplace authority
A dead/lost/terminated execution that owned a Workplace must cause the declared
`running|leased -> repair_wait` (or equivalent) domain transition and clear the
stale reservation before replacement claim. Releasing only the task fence is FAIL.

### QA-E20 — recovery paths converge atomically
Controlled process-close recovery, startup supervision/reaper, lease expiry and
explicit crash recovery must call the same semantic recovery use case or prove
identical atomic effects across WorkerExecution + Workplace + task projection.
The normal proof is one outer transaction (nested savepoints are acceptable).
If the implementation uses separate transactions, a deterministic crash-between-
steps test is mandatory; source comments or eventual-retry intuition are not proof.

### QA-E21 — replacement reservation is fresh and authoritative
A replacement execution must be able to install its own reservation in the
Workplace. `activeReservationRef` may never point to a terminal execution once a
new worker starts.

---

## F. Replay

### QA-F01 — replay substitutes worker production only
Never replay old CandidateSet/Gate/Workplace/lifecycle/Effect authority.

### QA-F02 — current authority refs are rebound
Run-local authority fields inside replayed products bind to current objects.

### QA-F03 — semantic replay key is cross-run stable
Exclude ProcessRun/LifecycleRun/Workplace/Execution/task/CandidateSet/timestamp/path
provenance unless genuinely semantic.

### QA-F04 — provenance != semantic identity
Audit hash with current-run refs is not automatically replay semantic digest.
Operator provenance such as `initiatedBy`, launch/order refs and idempotency keys
must not alter replay identity unless a product contract proves semantic meaning.
QA must inspect the semantic canonicalizer/digest computation itself. Merely
making `initiatedBy` a stable constant in one CLI entrypoint is insufficient.

### QA-F05 — reviewer replay has split identity
QC uses current CandidateSetRef; replay equivalence uses semantic author production.

### QA-F06 — rejected/corrupt replay fails closed
No same-capsule infinite repair loop and no silent inference fallback inside the
same failed replay execution.

### QA-F07 — canonical two-pass proof

```text
Run A: SAME Project, SAME persistence, zero capsules
       -> normal workers -> current gates -> capture
Run B: intentional NEW Factory Start for SAME Project and SAME persistence
       -> replay hits -> NEW Workplaces/CandidateSets/Gates
       -> zero inference calls for every compatible accepted production
```

No DB/capsule copying, DB deletion, capsule-table reset, authority-table reset,
Project-id trick or private simulator. A test that starts Run B from a clean DB
is NOT a replay test.

### QA-F08 — entrypoint preserves capsule persistence
Start/new-start/bootstrap/smoke scripts used to prove replay must not delete the
DB, `factory_replay_capsules`, Project identity or other replay source rows
between Run A and Run B.

### QA-F09 — control argv cannot contaminate semantic input
CLI flags and their values must be parsed structurally. Model name, sandbox name,
concurrency, DB path and other control coordinates must not leak into product
idea/initiative content or semantic replay digests.

### QA-F10 — ReplayKey miss is component-diagnosable
For every expected hit, record source-vs-current values for all ReplayKey
components and identify the exact mismatch. `capsule_ref=null` alone is
`NOT_PROVEN` as a diagnosis.

### QA-F11 — package compatibility remains intentional
Changing pinned package/skill/template/contract bytes may cause a miss through
`packageDigest`. Do not "fix" this by removing contract compatibility from the
key unless the architecture explicitly changes.

---

## G. Lifecycle / checks / effects

### QA-G01 — Project != new Factory Start != Resume
New start creates new run authority; resume continues the same run.

### QA-G02 — idempotency deduplicates command, not Project lifetime
A later intentional new start remains possible.

### QA-G03 — Workshop cannot move lifecycle cursor directly
Workshop produces domain output; orchestrator owns progression.

### QA-G04 — replay/resume do not resurrect old lifecycle authority
Current code performs current transitions.

### QA-G05 — Checks are authority/external-state pure
Checks inspect immutable candidates and return outcome/evidence.

### QA-G06 — Effects own authorized external mutations
Merge/publish/deploy use desired-state identity, attempt and receipt.

### QA-G07 — Effect completion is not replayed as current authority
Current run reconciles/observes external state.

### QA-G08 — compensation is explicit
No magical rollback; retry/compensate/roll-forward/human-required is policy.

### QA-G09 — same-run resume reuses durable completed stage/process results directly
After host restart, a completed ProcessRun/StageRun in the SAME LifecycleRun must
not invoke LLM and must not require a ReplayCapsule to remember that it finished.
The durable run cursor/result is authoritative.

### QA-G10 — crash resume starts at the unfinished authority boundary
A resume of the same run must preserve completed earlier stages and recover only
the current unfinished Workplace/WorkerExecution (plus any authorized repair).
If a test shows Discovery/Formalization rerunning after a pure host crash in the
same run, FAIL unless those stages were not durably completed.

### QA-G11 — lifecycle lease takeover is bounded and fenced
A replacement host may take over only an expired/unowned lifecycle execution
lease and must advance the fence. A still-live lease remains busy, not silently
stolen.

---

## H. Persistence

### QA-H01 — persistence is concept-owned, not Workshop-owned
Generic Production Cell/workspace/replay persistence belongs to Factory
infrastructure.

### QA-H02 — no second source of truth
Projection metadata/UI helpers cannot compete with authoritative state.

### QA-H03 — durable identity survives retry/resume
Recovery/gate/effect/replay eligibility cannot live only in process memory.

### QA-H04 — legacy schema constraint is not architecture
Do not bend the conceptual model around an old DB limitation.

### QA-H05 — replay archive survives intentional new starts
ReplayCapsules are derived reusable production for the Project scope. Normal
`new_start` must not delete them. Explicit destructive reset is a separate test
operation and cannot be used as evidence that replay works.

---

## I. Test harness integrity

### QA-I01 — tests substitute physical workers, not Factory authority
Use production Factory runtime, CandidateSets, Gates, recovery and lifecycle.

### QA-I02 — no private test lifecycle/runtime
Golden-path tests cannot manually advance stages or write Factory authority.

### QA-I03 — scripted worker respects production desk contract
Deterministic worker uses assigned WorkplaceDesk/RepositoryDesk just like LLM.

### QA-I04 — test topology matches the claim
Concurrency=1 does not prove parallel desk isolation.
One Workshop does not prove a universal mechanism.
A happy-path valid JSON does not prove contract enforcement.
A clean-DB second run does not prove replay.

### QA-I05 — harness failure is not "just a test bug" until boundary difference is proven
Show the exact divergence from the production worker boundary before dismissing it.

### QA-I06 — contract tests include a malformed-product negative case
For changed output contracts/materialization/validators, intentionally omit or
corrupt required data and prove current Gate authority refuses final acceptance.

### QA-I07 — crash-resume probe is destructive-process, non-destructive-state
To prove recovery, kill/terminate the host or worker process while preserving the
DB and repository state, then invoke canonical resume. Do not reset persistence.
Assert completed stages are unchanged and only unfinished authority is recovered.
Also assert the lost execution becomes terminal, Workplace enters repair_wait or
the declared exhausted state, stale reservation is cleared, and the replacement
execution can complete without a fence mismatch. Source-text/regex ratchets are
useful guards but DO NOT satisfy this behavioral proof by themselves.

### QA-I08 — replay probe counts physical inference invocations
For canonical Run A/Run B, record actual model/CLI spawn or provider invocation
counts. A claimed replay hit is insufficient if a physical inference worker was
also started.

---

## J. Representation grammar / parser compatibility

This section is mandatory whenever worker-produced text, Markdown, YAML, JSON,
XML, code blocks, section headings or another human-readable representation is
parsed by deterministic code.

### QA-J01 — representation mode is explicit

Classify the product as `NORMATIVE_GRAMMAR` or `MULTI_REPRESENTATION_SEMANTIC`.
If neither can be proven from canonical contract + worker guidance, `NOT_PROVEN`.

### QA-J02 — every parser constraint has contract provenance

Enumerate syntactic assumptions actually enforced by parser code, including as
applicable:

```text
heading text and heading level
section boundary rules
fenced block required/optional
fence language tag
list marker such as "- ac:"
indentation
field ordering
field spelling/case
quoting
separator characters
blank-line behavior
nested subsection behavior
multiple code-block behavior
comments
cardinality/multiplicity
```

For EACH assumption provide one provenance:

```text
canonical contract explicitly requires it
AND pinned worker-visible guidance delivers it
```

or prove the parser does not require it.

A regex implementation detail is NOT contract provenance.
An example file that is not pinned to the worker is NOT contract provenance.
A comment saying "LLMs usually write X" is NOT contract provenance.

Any hidden syntactic requirement is FAIL.

### QA-J03 — producer and consumer languages are equal

Let `L_worker` be the set of representations permitted by the actual pinned
skill/template/checklist the worker receives, and `L_parser` the set accepted by
the parser.

PASS requires:

```text
NORMATIVE_GRAMMAR:
  L_worker == L_parser == canonical grammar

MULTI_REPRESENTATION_SEMANTIC:
  L_worker subset-or-equal L_parser
```

FAIL when there exists a representation the worker is allowed to produce but
the parser rejects before semantic validation.

### QA-J04 — equivalent representations canonicalize equivalently

For multi-representation contracts require a positive compatibility proof with
at least two semantically equivalent representations when two are legitimately
allowed. They must produce the same canonical meaning and the same validation
outcome.

Examples when applicable:

```text
fenced YAML list item: "- ac: AC-1"
subsection form:       "### AC-1" + "ac: AC-1"
```

Do NOT invent a second allowed form only to satisfy this test. If the grammar is
normative and singular, prove the worker receives that exact grammar instead.

### QA-J05 — hierarchical section boundaries are structurally correct

When parsing Markdown-like documents, a section must not terminate merely
because a deeper nested subsection appears. Boundary detection must respect the
current heading level unless the canonical grammar explicitly says otherwise.

Require regression probes for:

```text
same-level next section
shallower next section
deeper nested subsection
end-of-document
```

### QA-J06 — mixed-content sections do not shadow valid content

If raw section text and fenced blocks can coexist, prove a non-authoritative
incidental fenced block cannot cause the parser to ignore the actual canonical
stanzas/fields elsewhere in the same section.

A parser of the form:

```text
if any code block exists -> parse only the first code block
else -> parse raw section
```

is `NOT_PROVEN` or FAIL unless the contract guarantees that behavior is correct.

### QA-J07 — canonicalize representation before domain validation

Prefer and prove the separation:

```text
raw representation
  -> parser/canonicalizer
  -> canonical semantic structure
  -> domain validator
```

The domain validator should not accidentally encode arbitrary Markdown/YAML
presentation choices as business/domain requirements.

If parsing and domain validation are intentionally combined, QA must still map
every representation constraint to canonical contract provenance.

### QA-J08 — field/enum drift is checked across all surfaces

Compare semantic skill, canonical contract, parser, validator and reviewer.
A producer restriction that the validator silently broadens is drift; a parser
restriction that the producer never received is drift; a template field missing
from the canonical contract is drift.

### QA-J09 — submission rejection is actionable and retry-safe

When representation parsing fails at `worker_done`/submission validation, the
worker must receive a concrete error identifying the rejected contract element
and remain able to repair the same execution/workplace according to policy.

Repeated identical rejection caused by hidden parser grammar is a Factory defect,
not evidence that the model is incapable of following instructions.

### QA-J10 — no model-blame conclusion without boundary proof

Before concluding "the model failed to call worker_done", "the model ignored the
contract", "the model chose a wrong format", or equivalent, inspect and record:

```text
actual pinned prompt/skill/template delivered
actual allowed tools
actual worker_done/tool attempts if observable
exact submission-validation errors
parser/canonicalizer behavior on produced bytes
Gate/receipt/recovery path
```

If the worker attempted the required protocol and the runtime rejected a
representation allowed by its delivered contract, classify the root cause as
producer/consumer contract drift or parser defect, not model behavior.

### QA-J11 — parser changes require permanent regression tests

A parser/representation fix is NOT proven by testing only the observed failing
sample. Add or identify durable tests that falsify the relevant hidden assumption.

For sectioned Markdown/YAML-like products, include applicable cases such as:

```text
canonical fenced form
canonical raw/subsection form when allowed
nested headings
a same-level following section
a shallower following section
mixed raw text + incidental fenced block
both "- key:" and "key:" only when both are contract-allowed
malformed/missing required semantic fields -> rejected
```

A parser fix without tests for the failure class is `NOT_PROVEN`.

---

# Local-exception detector

For every architectural diff search affected concepts together with:

```text
Discovery
Formalization
Development
Delivery
Runtime
Executor
Coordinator
Adapter
Persistence
FactoryStart
new_start
resume
Bootstrap
Reset
ReplayKey
semanticInputDigest
initiatedBy
WorkspaceProjection
PinnedWorkspace
Template
Checklist
Schema
OutputSchema
ProductContract
Parser
Canonicalizer
Regex
Markdown
YAML
JSON
Recovery
Reaper
Supervision
activeReservationRef
Replay
Gate
Candidate
Workplace
RepositoryDesk
worktree
checkout
schema id
module name
production cell id
isTest
mock
simulator
```

Then ask:

1. Why is this code located here?
2. Is the responsibility domain-specific or Factory physics?
3. Does another Workshop need the same behavior?
4. If yes, why is it not behind the common interface?
5. Can a new Workshop obtain it by declaration only?
6. Does the worker receive the exact product contract, or is it expected to guess?
7. Is the worker-visible template/skill consistent with the canonical contract and Gate validator?
8. Does the parser enforce any syntax that is absent from worker-visible pinned guidance?
9. Can two semantically equivalent allowed representations produce different parser/validator outcomes?
10. If a model is blamed, has the runtime boundary actually been disproven as the cause?
11. Does the test preserve the same DB + Project between replay Run A and Run B?
12. Can control argv or operator provenance change semanticInputDigest accidentally?
13. On host/worker death, who clears the Workplace active reservation and moves loop state to repair?
14. Do close-callback and startup-reaper recovery have identical authority effects?
15. Does same-run resume reuse completed StageRun/ProcessRun records rather than rebuilding them?
16. Is the semantic replay canonicalizer itself free of operator/runtime provenance, independent of entrypoint constants?
17. Is crash/recovery behavior proven by executing the state transition, not only by matching source text?

If adding a normal Workshop requires copying this code, FAIL.

---

# Risk Trigger Matrix — mandatory proofs

| Changed concept | Mandatory proof |
|---|---|
| Workshop/base contract | changed Workshop + one sibling enter through same `ProcessModuleDefinition`/Flow contract; no parallel runtime |
| Production Cell definition/runtime | Formalization + Development trace into same `ProductionCellNodeExecutor` and Factory persistence |
| output schema / call template / checklist | declaration -> pinned package -> profile -> generic desk materializer -> worker-visible path -> canonical contract -> deterministic validator; malformed product must not be accepted |
| parser / canonicalizer / textual contract | worker-visible grammar -> parser constraint provenance -> positive compatible-representation probe(s) -> canonical structure -> validator; no hidden syntax |
| workspace/package materialization | Discovery readiness + one Formalization/Development structured worker use same projection/materializer path and see only declared pinned contract resources |
| review/Gate repair routing | accepted review + author repair + reviewer repair + retry on same Workplace |
| recovery feedback | exact GateDecision/CheckReceipt/CandidateSet projection + stale clearing + Formalization/Development parity |
| crash/reaper/supervision | controlled close + killed worker + killed host; each clears stale Workplace reservation, reaches repair/requeue under same policy, and replacement completion passes fence; source ratchet alone is insufficient |
| RepositoryDesk/Git | >=2 concurrent git-changing work items, isolated desks, stable source branches, both integrations governed by Effect |
| replay key/semantic identity | same-DB same-Project Run A + intentional new-start Run B; component-wise ReplayKey equality for expected hits; zero inference calls on hits; provenance excluded at semantic digest boundary |
| factory start/bootstrap/reset | prove Run B does not delete/recreate DB, Project or capsule archive; prove CLI control flags do not enter business semantic input |
| replay product rebinding | old authority refs are not current; current refs are rebound |
| lifecycle start/resume | new start creates new run; resume preserves same run; completed StageRun/ProcessRun results are reused directly |
| CandidateSet/product persistence | exact immutable historical read after later repair/new execution |
| effects | idempotency + durable attempts/receipts + current desired-state observation |
| test worker behavior | parity with production WorkerExecution + WorkplaceDesk/RepositoryDesk boundary |

If a mandatory proof cannot run in the current environment, mark `NOT_PROVEN`.
Never silently downgrade it to PASS.

---

# Minimum cross-Workshop rule

Whenever a diff changes GENERIC Factory mechanics:

1. inspect the common implementation;
2. trace the changed Workshop into it;
3. trace at least one DIFFERENT Workshop into the same mechanism;
4. compare inputs/outputs/authority ownership;
5. run or inspect a falsifying test that would fail if one Workshop diverged.

Default comparisons:

```text
Workshop/base contract     -> Formalization + Development
contract/desk material     -> Discovery readiness + Formalization or Development
review/recovery            -> Formalization + Development
Production Cell core       -> Formalization + Development (+ Discovery where applicable)
RepositoryDesk/Git         -> two sibling Development work items
replay                     -> author + reviewer + verification where applicable
lifecycle                  -> at least two consecutive Workshops
crash recovery             -> author execution + reviewer execution where applicable
```

A class named `Generic` is not proof of universality.
Universality is proven from composition and call paths.

---

# Contract-on-Desk proof format

For each affected structured worker product report:

```text
Product: <schema id>
Workshop/Profile: <module + execution profile>

Declaration chain:
Flow outputSchema: <...>
ProductionCell product contract: <...>
ExecutionProfile outputSchema: <...>
WorkIntent output schema: <...>
Canonical contract/version/digest: <...>

Worker guidance:
semantic skill: <path + relevant rule>
resource: <template/schema/checklist path>
resource index entry + digest: <...>
pinned installation/package digest: <...>
WorkspaceProjection: <function/path>
WorkplaceDesk materialized path: <...>
worker-visible pointer: <callFiles/workspaceFiles/checklists/assistance/etc>

Representation:
mode: NORMATIVE_GRAMMAR / MULTI_REPRESENTATION_SEMANTIC / N/A
parser/canonicalizer: <file/function>
parser constraints: <heading/fence/list-marker/indent/etc or N/A>
constraint provenance: <canonical rule + pinned worker-visible rule>
positive representation compatibility probe: PASS/FAIL/NOT_PROVEN/N/A
canonical structure produced: <...>

Authority:
validator/CheckProvider: <file/function/provider id>
required fields/enums/bindings checked: <...>
negative malformed candidate probe: PASS/FAIL/NOT_PROVEN

Cross-surface drift:
skill vs canonical contract: PASS/FAIL/NOT_PROVEN
contract vs parser: PASS/FAIL/NOT_PROVEN/N/A
contract vs validator: PASS/FAIL/NOT_PROVEN
reviewer vs contract: PASS/FAIL/NOT_PROVEN/N/A

Verdict: PASS/FAIL/NOT_PROVEN
```

For example, a readiness assessment is NOT proven merely because
`readiness-call-template.json` exists. QA must also prove that the profile
references it, the pinned package contains it, the generic materializer exposes
it on the current desk, and the readiness validator rejects missing
`proposal_id`, proposal hash, required dimensions, next action, confidence,
rationale, or malformed evidence references according to its contract.

Likewise, a Markdown SRS is NOT proven merely because the semantic fields are
listed in the architect skill. If a deterministic parser later requires fenced
YAML, a specific heading level, a `- ac:` prefix or another syntax choice, QA
must prove that exact grammar is canonical and pinned to the worker, or prove
that all contract-allowed equivalent representations canonicalize correctly.

---

# Continuity proof format

For every affected start/resume/replay/recovery path report:

```text
Scenario: SAME_RUN_RESUME / NEW_START_REPLAY / CHECKPOINT / CRASH_RECOVERY
Entrypoint: <file/function/command>
DB/persistence identity before/after: <same/different + evidence>
Project identity before/after: <same/different + evidence>
LifecycleRun identity before/after: <same/new as required>
Completed StageRun/ProcessRun reuse: <refs + no-inference evidence>
Capsule store preserved: PASS/FAIL/N/A
ReplayKey source/current components: <component table or N/A>
Semantic canonicalizer provenance exclusions: <evidence or N/A>
Physical inference calls: <count>
Workplace before crash: <loop/kanban/reservation>
WorkerExecution after reaper: <terminal state>
Workplace after reaper: <loop/kanban/reservation>
Replacement reservation: <new execution ref>
Replacement worker_done/gate: PASS/FAIL/NOT_PROVEN
Behavioral proof: <test/run evidence; source-only ratchet is not sufficient>
Verdict: PASS/FAIL/NOT_PROVEN
```

---

# Test reasoning discipline

Never reason:

```text
tests green -> architecture correct
```

Reason:

```text
architecture invariant
  -> production path inspected
  -> sibling path compared
  -> producer/consumer language compared
  -> continuity identity checked where relevant
  -> falsifying behavioral test selected
  -> architecture ratchet confirms the path cannot silently disappear
  -> tests green
```

Prefer permanent architecture ratchets that fail if someone later:

- imports Workshop-specific persistence into universal Factory runtime;
- adds module-name branching to core coordinator/materializer;
- creates a second Workshop/ProductionCell interface;
- forgets to declare/pin/materialize an output contract resource;
- leaves a worker with only a schema id and no usable contract shape;
- lets a semantic skill drift from the canonical contract enums/fields;
- lets a call template drift from its deterministic validator;
- lets a parser require syntax that is not in the pinned worker contract;
- lets nested Markdown headings truncate a parent semantic section;
- lets an incidental fenced block shadow valid raw structured content;
- accepts one representation and rejects an equivalent contract-allowed representation;
- accepts a malformed structured candidate because only the happy path was tested;
- always routes reviewer repair to author;
- bypasses reviewer verdict in Development Gate;
- shares one mutable checkout across parallel worker desks;
- restores old CandidateSet/Gate authority during replay;
- folds run ids or operator provenance into semantic replay identity;
- lets CLI control flag values leak into business semantic input;
- destroys replay capsules between canonical Run A and Run B;
- calls a clean-DB second execution a replay test;
- releases a dead execution/task but leaves Workplace running under a stale reservation;
- lets a replacement worker run without replacing the authoritative Workplace reservation;
- reruns completed same-run stages after a pure host crash;
- lets scripted scenarios mutate Factory authority directly.

A source-level ratchet is not a substitute for runtime evidence when the claim is
about crash ordering, transaction atomicity, process death, replay hits, model
spawn suppression, fences or persisted state transitions.

---

# Findings severity

## BLOCKER — architecture or contract violation

Examples:

```text
second Factory/Workshop/ProductionCell runtime
Workshop-specific recovery or workspace materialization physics
worker must guess required product fields
worker must guess hidden parser/serialization grammar
contract template exists but is not delivered through pinned WorkplaceDesk
worker-visible skill/template and canonical contract disagree
canonical contract and validator enums/required fields disagree
parser accepts a narrower language than the worker-visible contract permits
malformed product can receive final acceptance
direct authority mutation from worker/test code
shared mutable RepositoryDesk for parallel workers
replay restores old authority
new-start destroys capsule persistence
operator/runtime provenance changes semantic ReplayKey
CLI control values contaminate initiative semantic input
startup reaper releases task but leaves stale Workplace reservation
replacement execution cannot become Workplace reservation owner
same-run resume reruns durably completed stages without semantic invalidation
Gate/reviewer bypass
Effect triggered without current final acceptance
```

Verdict: `BLOCKED`.

## BLOCKER — NOT_PROVEN

Examples:

```text
generic recovery changed but only Discovery tested
workspace materializer changed but only one Workshop inspected
output contract changed without malformed-product negative test
parser changed without producer-contract inspection
parser changed without positive compatible-representation test where multiple forms are allowed
text section parser changed without nested/same-level boundary tests
Git desk changed but only concurrency=1 tested
replay changed without SAME-DB SAME-PROJECT Run A/Run B proof
replay miss reported without ReplayKey component comparison
semantic replay fix proves only a stable CLI initiatedBy but not exclusion at digest boundary
crash recovery claimed from source regex assertions without executing killed-worker/host recovery
crash recovery claimed without inspecting Workplace reservation after reaper
resume claimed without proving completed StageRun/ProcessRun reuse and zero inference for them
common base-interface path cannot be reconstructed
worker-visible contract path cannot be reconstructed
model blamed without inspecting actual worker_done/submission/parser path
```

Verdict: `NOT_PROVEN`.

Readability/diagnostic/documentation improvements may be non-blocking only when
no invariant is weakened. Non-blocking findings never compensate for a blocker.

---

# Required final QA report

Return exactly this structure:

```text
SAGA FACTORY QA

Commit candidate:
<sha / staged diff description>

Changed concepts:
- ...

Base-interface proof:
Workshop contract: <file/interface>
Production Cell contract: <file/interface>
Workspace contract/materializer: <file/interface>
Shared runtime: <file/class>
Factory composition point: <file/function>
Workshop-specific Factory physics found: YES/NO

Architecture Impact Matrix:
| invariant | changed implementation | shared entry point | second consumer | falsifying evidence | verdict |
| ... |

Canonical path proof:
<concrete paths with files/functions/classes>

Contract-on-Desk proof:
<one block per affected structured product>

Representation-contract proof:
<representation mode, parser constraints + provenance, equivalence probes,
canonicalization path, producer/consumer language verdict>

Continuity proof:
<resume/new-start/replay/crash identity, capsule persistence, ReplayKey diff,
semantic canonicalizer evidence, Workplace reservation transition, behavioral
runtime proof and physical inference-count evidence>

Checklist:
BI-01 PASS — ...
QA-A01 PASS — ...
QA-B01 PASS — ...
QA-E19 PASS — ...
QA-F07 PASS — ...
QA-G09 PASS — ...
QA-J01 PASS — ...
...
Only genuinely inapplicable items may be N/A, with reason.

Mandatory probes:
- <probe>: PASS / FAIL / NOT_PROVEN — <command/test/evidence>

Blocking findings:
1. <finding or none>

Non-blocking findings:
1. <finding or none>

Final verdict:
PASS_TO_COMMIT
or
BLOCKED
or
NOT_PROVEN

Commit permission:
YES only when Final verdict = PASS_TO_COMMIT.
```

Do not soften the verdict.
Do not write "mostly passes".
Do not convert missing evidence into optimism.
Do not attribute a protocol/format failure to the model before producer/consumer
contract parity has been proven.
Do not call a clean-DB second run replay.
Do not call task release crash recovery until Workplace authority and reservation
state have also been proven coherent.
Do not call a source-text ratchet a behavioral recovery/replay proof.

---

# Short mental checklist — before saying PASS

```text
[ ] I read CONVEYOR-MENTAL-MODEL.md fresh.
[ ] I identified the canonical Workshop base contract.
[ ] I identified the canonical Production Cell base contract.
[ ] I proved the changed Workshop uses those contracts.
[ ] I proved a sibling Workshop uses the same common mechanism.
[ ] I found no duplicate/private Factory runtime.
[ ] I found no Workshop-name branch in core physics.
[ ] For every affected structured product I traced output schema end-to-end.
[ ] The worker receives a concrete pinned contract resource; it does not guess.
[ ] The exact resource is declared by the execution profile.
[ ] The pinned package/resource digest is proven.
[ ] The generic materializer puts the resource on the current WorkplaceDesk.
[ ] The worker is explicitly pointed to that file/resource.
[ ] Semantic skill, canonical contract, template and validator agree on fields/enums.
[ ] For every textual parser I classified the representation mode.
[ ] Every parser syntactic constraint has canonical + pinned worker-visible provenance.
[ ] The parser accepts every representation the delivered worker contract permits.
[ ] Equivalent allowed representations canonicalize to equivalent meaning.
[ ] Section-boundary parsing is proven against nested/same/shallow headings where applicable.
[ ] Mixed raw/fenced content cannot silently shadow valid contract content where applicable.
[ ] Parser changes have permanent regression tests for the failure class.
[ ] A malformed/incomplete candidate is proven unable to obtain final acceptance.
[ ] Workplace remains durable; WorkerExecution remains an attempt.
[ ] RepositoryDesk remains Factory-owned and isolated.
[ ] CandidateSet remains the exact immutable QC handoff.
[ ] GateDecision remains current append-only authority.
[ ] Recovery targets the same Workplace using exact rejected material.
[ ] Every crash/reaper path clears stale Workplace reservation and reaches repair/requeue coherently.
[ ] A replacement execution owns a fresh authoritative Workplace reservation.
[ ] Controlled-close and startup-reaper recovery converge on the same semantic effects.
[ ] Crash recovery state changes are atomic, or crash-between-steps convergence is behaviorally proven.
[ ] Reviewer repair can target reviewer; author defects can target author.
[ ] Same-run resume reuses durably completed StageRun/ProcessRun results directly.
[ ] Same-run host crash resumes at the unfinished authority boundary, not from Discovery.
[ ] Replay substitutes production only and reruns current authority.
[ ] Canonical replay proof uses SAME DB + SAME Project across Run A and Run B.
[ ] Run B does not delete/reset/copy capsules or authority tables.
[ ] ReplayKey expected hits were compared component-by-component.
[ ] Operator provenance is excluded at the semantic-digest boundary, not merely stabilized in one entrypoint.
[ ] CLI control values do not contaminate semantic replay identity.
[ ] Physical inference count is zero for compatible replay hits.
[ ] Crash/replay claims have behavioral runtime proof; source ratchets are supplemental only.
[ ] Checks remain checks; Effects remain authorized mutations.
[ ] Scripted/test workers use the same physical boundary as production workers.
[ ] If the model was blamed, I inspected the actual prompt/tools/submission/parser path first.
[ ] Every triggered Risk Matrix proof was actually provided.
[ ] No NOT_PROVEN item remains.
```

If any box is unchecked, do not authorize commit.