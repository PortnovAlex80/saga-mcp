---
name: saga-factory-qa
description: "Mandatory fail-closed pre-commit architecture QA for Saga4. Run before every commit that changes Factory runtime, workshops, Production Cells, Workplace/RepositoryDesk, WorkerExecution, package/workspace resources, product contracts, CandidateSets, Gates, review/recovery, replay, lifecycle, effects, persistence, or Factory Contract harnesses. Blocks local fixes that create workshop-specific physics, make workers guess contracts, or bypass the Conveyor Mental Model."
---

# Saga Factory QA — pre-commit architecture regression gate

## Mission

You are the architectural regression firewall for Saga4.

Your task is NOT merely to decide whether the changed feature works locally.
You must prove that the candidate commit still obeys the common Factory physics
and that a worker receives the exact contract it is expected to satisfy.

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

The governing rule is:

> ONE PRODUCTION INTERFACE, ONE MATERIAL, ONE DESK, ONE FACTORY RUNTIME.

A second governing rule follows from it:

> THE WORKER MUST NOT GUESS ITS PRODUCT CONTRACT.

The canonical architecture source is:

`docs/architecture/CONVEYOR-MENTAL-MODEL.md`

Read it fresh and completely on EVERY invocation.
Do not rely on memory, summaries, task descriptions, commit messages, comments,
previous QA output, or the author's explanation.

This skill is fail-closed:

```text
PASS_TO_COMMIT = architecture and contract delivery proven
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

For every affected structured worker product also read:

```text
- the concrete ProcessModuleDefinition / ExecutionProfileDefinition;
- the concrete ProductContract / output schema declaration;
- every declared workspaceTemplate / callTemplate / checklist used to describe it;
- the module package resource index/manifest that pins those bytes;
- the deterministic validator / CheckProvider that decides whether the product
  satisfies the contract.
```

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
  -> common product_read / product_submit / execution_complete protocol
  -> immutable CandidateSet
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
For every structured worker product prove BOTH channels:

```text
GUIDANCE CHANNEL
canonical contract declaration
  -> pinned package resource
  -> profile declaration
  -> generic WorkspaceProjection
  -> exact WorkplaceDesk
  -> worker is explicitly told where/how to read it

AUTHORITY CHANNEL
submitted CandidateSet
  -> deterministic validator / CheckProvider
  -> current GateDecision
```

The guidance channel helps the model produce the right shape.
The authority channel prevents an incomplete/wrong shape from being accepted.
Neither substitutes for the other.

A raw invalid `product_submit` row MAY exist as worker production/audit material.
That is not itself an architecture defect. The hard invariant is:

> malformed or incomplete production must be unable to obtain final acceptance.

A template is guidance, not authority. A validator/CheckProvider is authority,
not worker guidance.

---

# QA procedure

## Phase 0 — exact commit candidate

1. Inspect staged diff.
2. Inspect unstaged files that could be accidentally omitted.
3. Record every changed file.
4. Read enough surrounding code to reconstruct control/data flow.
5. Follow delegation into shared infrastructure.
6. Search outside the diff for sibling implementations of the same concept.
7. For changed product/schema/template code, trace both Contract-on-Desk channels.

Classify changed files:

```text
Workshop declaration
Factory runtime
Lifecycle
Production Cell
Execution profile / contract resource
Workspace projection/materialization
Workplace
RepositoryDesk
WorkerExecution
Product/material
CandidateSet
Check/Gate
Review
Recovery
Replay
Effect
Persistence
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
validator/CheckProvider
negative malformed-product test
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

### QA-B07 — template and authority contract do not drift

Compare worker-visible template/schema content with the deterministic validator.
At minimum check:

```text
schema id/version
required top-level fields
required nested fields
allowed enums
identity/binding fields
evidence/source-reference requirements where applicable
```

A template that omits validator-required fields is FAIL even if happy-path tests
currently pass.

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
  -> template matches validator contract
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

### QA-F05 — reviewer replay has split identity
QC uses current CandidateSetRef; replay equivalence uses semantic author production.

### QA-F06 — rejected/corrupt replay fails closed
No same-capsule infinite repair loop and no silent inference fallback inside the
same failed replay execution.

### QA-F07 — canonical two-pass proof

```text
Run A: same Project, zero capsules -> normal workers -> current gates -> capture
Run B: NEW Factory Start -> replay hits -> NEW Workplaces/CandidateSets/Gates
       -> zero scripted inference calls
```

No DB/capsule copying, authority-table reset, Project-id trick or private simulator.

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

### QA-I05 — harness failure is not "just a test bug" until boundary difference is proven
Show the exact divergence from the production worker boundary before dismissing it.

### QA-I06 — contract tests include a malformed-product negative case
For changed output contracts/materialization/validators, intentionally omit or
corrupt required data and prove current Gate authority refuses final acceptance.

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
WorkspaceProjection
PinnedWorkspace
Template
Checklist
Schema
OutputSchema
ProductContract
Recovery
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
7. Is the worker-visible template actually consistent with the Gate validator?

If adding a normal Workshop requires copying this code, FAIL.

---

# Risk Trigger Matrix — mandatory proofs

| Changed concept | Mandatory proof |
|---|---|
| Workshop/base contract | changed Workshop + one sibling enter through same `ProcessModuleDefinition`/Flow contract; no parallel runtime |
| Production Cell definition/runtime | Formalization + Development trace into same `ProductionCellNodeExecutor` and Factory persistence |
| output schema / call template / checklist | declaration -> pinned package -> profile -> generic desk materializer -> worker-visible path -> deterministic validator; malformed product must not be accepted |
| workspace/package materialization | Discovery readiness + one Formalization/Development structured worker use same projection/materializer path and see only declared pinned contract resources |
| review/Gate repair routing | accepted review + author repair + reviewer repair + retry on same Workplace |
| recovery feedback | exact GateDecision/CheckReceipt/CandidateSet projection + stale clearing + Formalization/Development parity |
| RepositoryDesk/Git | >=2 concurrent git-changing work items, isolated desks, stable source branches, both integrations governed by Effect |
| replay key/semantic identity | cold Run A + new-start Run B; Run B zero scripted inference; new current authority objects |
| replay product rebinding | old authority refs are not current; current refs are rebound |
| lifecycle start/resume | new start creates new run; resume preserves same run |
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

Worker guidance:
resource: <template/schema/checklist path>
resource index entry + digest: <...>
pinned installation/package digest: <...>
WorkspaceProjection: <function/path>
WorkplaceDesk materialized path: <...>
worker-visible pointer: <callFiles/workspaceFiles/checklists/assistance/etc>

Authority:
validator/CheckProvider: <file/function/provider id>
required fields/enums/bindings checked: <...>
negative malformed candidate probe: PASS/FAIL/NOT_PROVEN

Verdict: PASS/FAIL/NOT_PROVEN
```

For example, a readiness assessment is NOT proven merely because
`readiness-call-template.json` exists. QA must also prove that the profile
references it, the pinned package contains it, the generic materializer exposes
it on the current desk, and the readiness validator rejects missing
`proposal_id`, proposal hash, required dimensions, next action, confidence,
rationale, or malformed evidence references according to its contract.

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
  -> falsifying test selected
  -> test green
```

Prefer permanent architecture ratchets that fail if someone later:

- imports Workshop-specific persistence into universal Factory runtime;
- adds module-name branching to core coordinator/materializer;
- creates a second Workshop/ProductionCell interface;
- forgets to declare/pin/materialize an output contract resource;
- leaves a worker with only a schema id and no usable contract shape;
- lets a call template drift from its deterministic validator;
- accepts a malformed structured candidate because only the happy path was tested;
- always routes reviewer repair to author;
- bypasses reviewer verdict in Development Gate;
- shares one mutable checkout across parallel worker desks;
- restores old CandidateSet/Gate authority during replay;
- folds run ids into semantic replay identity;
- lets scripted scenarios mutate Factory authority directly.

---

# Findings severity

## BLOCKER — architecture violation

Examples:

```text
second Factory/Workshop/ProductionCell runtime
Workshop-specific recovery or workspace materialization physics
worker must guess required product fields
contract template exists but is not delivered through pinned WorkplaceDesk
worker-visible template and Gate validator disagree
malformed product can receive final acceptance
direct authority mutation from worker/test code
shared mutable RepositoryDesk for parallel workers
replay restores old authority
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
Git desk changed but only concurrency=1 tested
replay changed without Run A/Run B proof
common base-interface path cannot be reconstructed
worker-visible contract path cannot be reconstructed
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

Checklist:
BI-01 PASS — ...
QA-A01 PASS — ...
QA-B01 PASS — ...
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
[ ] The worker-visible template/schema matches the deterministic validator.
[ ] A malformed/incomplete candidate is proven unable to obtain final acceptance.
[ ] Workplace remains durable; WorkerExecution remains an attempt.
[ ] RepositoryDesk remains Factory-owned and isolated.
[ ] CandidateSet remains the exact immutable QC handoff.
[ ] GateDecision remains current append-only authority.
[ ] Recovery targets the same Workplace using exact rejected material.
[ ] Reviewer repair can target reviewer; author defects can target author.
[ ] Replay substitutes production only and reruns current authority.
[ ] Checks remain checks; Effects remain authorized mutations.
[ ] Scripted/test workers use the same physical boundary as production workers.
[ ] Every triggered Risk Matrix proof was actually provided.
[ ] No NOT_PROVEN item remains.
```

If any box is unchecked, do not authorize commit.
