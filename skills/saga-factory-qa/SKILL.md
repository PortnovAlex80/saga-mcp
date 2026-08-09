---
name: saga-factory-qa
description: "Mandatory fail-closed pre-commit architecture QA for Saga4. Run before every commit that changes Factory runtime, workshops, Production Cells, Workplace/RepositoryDesk, WorkerExecution, products, CandidateSets, Gates, review/recovery, replay, lifecycle, effects, persistence, or Factory Contract harnesses. Blocks local fixes that create workshop-specific physics or bypass the Conveyor Mental Model."
---

# Saga Factory QA — pre-commit architecture regression gate

## Mission

You are the architectural regression firewall for Saga4.

Your job is NOT merely to decide whether the changed feature works locally.
Your job is to prove that the change still obeys the common Factory physics.

The recurring failure this skill exists to prevent is:

```text
agent changes one workshop/cell
  -> local tests become green
  -> agent introduces a private runtime/adapter/state transition/recovery path
  -> another workshop still uses the common or older path
  -> the new feature works locally
  -> the Factory concept is broken globally
```

The governing rule is:

> ONE PRODUCTION INTERFACE, ONE MATERIAL, ONE DESK, ONE FACTORY RUNTIME.

The canonical source is:

`docs/architecture/CONVEYOR-MENTAL-MODEL.md`

Read that document fresh and completely on EVERY invocation.
Do not rely on memory, summaries, task descriptions, commit messages, comments,
previous QA output, or the author’s explanation of the change.

If current code and the Conveyor Mental Model disagree, that disagreement is a
blocking finding unless the human explicitly approved changing the architecture
itself.

This skill is fail-closed:

```text
PASS_TO_COMMIT  = architecture proven
BLOCKED         = architecture violated
NOT_PROVEN      = evidence incomplete -> also block commit
```

Green tests alone are never sufficient evidence.

---

# Mandatory architecture contracts to read

Before reviewing a Factory-related commit, read these files in addition to the
Conveyor Mental Model:

```text
src/process-modules/domain/process-module.ts
src/process-modules/domain/workplace/production-cell-definition.ts
src/process-modules/application/node-executors/production-cell-node-executor.ts
src/app/product-lifecycle-runtime.ts
```

Then read any changed implementation and its sibling consumers.

The current foundational contracts are:

```text
ProcessModuleDefinition
  = base declarative contract of a Workshop / Process Module

ProductionCellDefinition
  = base declarative contract of the universal worker-quality cell

ProductionCellNodeExecutor
  = shared runtime implementation of Production Cell physics

Product lifecycle composition root
  = constructs shared Factory runtime once and plugs workshops into it
```

This is deliberately COMPOSITION over private inheritance hierarchies.
A workshop "inherits" Factory behavior by declaring itself through these base
contracts and using common runtime extension points. It must not copy the
runtime implementation.

If a new workshop needs a new common Factory capability, extend the shared
contract/runtime first, then let all workshops consume it declaratively.
Do NOT solve it by giving the new workshop a private mechanism.

---

# The allowed Workshop surface

A normal Workshop / Process Module may declare WHAT:

```text
identity + version
input/output contracts
outcomes
Flow
Production Cells
execution profiles / skills
product schemas/contracts
CheckPlans
policies
invariants
recovery policy
optional post-acceptance Effect hook
domain-specific settlement/output mapping
```

A Production Cell may declare WHAT through `ProductionCellDefinition`:

```text
input selectors
materialization/workKey selectors
author skill/profile
product contracts
author CheckPlan
optional reviewer skill/profile + final CheckPlan
bounded recovery policy
optional post-acceptance Effect id
transitions
```

Factory runtime owns HOW:

```text
Factory Start / resume
ProcessRun/LifecycleRun progression
materialization of Workplaces
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

A workshop must not receive those authorities merely because its domain is
special.

---

# Base-interface protection gate

This gate is evaluated BEFORE all other checklist items.

## BI-01 — exactly one Workshop contract

Find the canonical base contract used by the changed workshop.
Normally this is `ProcessModuleDefinition` plus `FlowDefinition`.

FAIL if the diff introduces another parallel Workshop interface/registry/runtime
that can run normal modules without going through the canonical contract.

## BI-02 — exactly one Production Cell contract

Normal worker-quality loops must be declared through `ProductionCellDefinition`
and executed by the shared Production Cell runtime.

FAIL if a workshop creates its own author/reviewer/recovery cell abstraction.

## BI-03 — extension points are declarative

A workshop may supply skills, schemas, selectors, CheckPlans, policies and effect
ids/providers through declared extension points.

FAIL if the extension point gives the workshop direct access to mutate
Workplace/Gate/lifecycle authority.

## BI-04 — no copied common mechanism

Search for code in the changed workshop that resembles shared Production Cell,
RepositoryDesk, recovery, replay, Gate or lifecycle mechanics.

Ask:

> Could a second workshop need this exact mechanism?

If yes, and the implementation lives under one workshop, FAIL unless it is
strictly a domain adapter behind a common interface.

## BI-05 — adding a new Workshop must be mostly declaration

Run the thought experiment:

> If I add Workshop X tomorrow, can I get normal worker production, review,
> repair, replay and desk behavior by supplying declarations and registered
> providers only?

If normal Workshop X requires copying runtime code from Discovery/Formalization/
Development, FAIL.

## BI-06 — shared interfaces protect both directions

Check compile-time/domain boundaries where practical:

- Workshop declarations depend on shared domain interfaces.
- Factory runtime consumes shared interfaces, not concrete workshop classes.
- Concrete workshop infrastructure does not leak into generic Factory runtime.
- Generic runtime does not branch on workshop identity.

A class/function named `Generic` is not proof. Trace imports and call paths.

---

# When this skill is mandatory

Run before every commit that touches any of these concepts directly or indirectly:

- Factory Start / resume / LifecycleRun / ProcessRun;
- workshop/module registration or composition;
- Flow or Production Cell declarations;
- dispatch, assignment, concurrency, launch, fencing, supervision or termination;
- Workplace identity/state;
- RepositoryDesk / worktree / branch/base selection;
- worker-facing read/submit/complete protocol;
- product persistence, ProductRef, product materialization;
- CandidateSet seal/read/provenance;
- CheckPlan, CheckRun, GateRun, GateDecision, CellFinalAcceptance;
- author/reviewer loops;
- repair/recovery feedback, retry routing, retry budget;
- replay lookup, semantic identity, capture, execution, rebinding, eligibility;
- Git integration, publish, deploy or other effects;
- persistence adapters used by any of the above;
- test harnesses that substitute physical workers;
- Factory Contract / architecture tests.

If any affected concept is not proven by this QA, do not commit.

---

# What this skill is NOT

This is not a generic style review.

Do not spend the review primarily on formatting, naming taste, prompt prose,
or raw test count.

The primary question is:

> DID THE DIFF PRESERVE ONE FACTORY PHYSICS FOR ALL WORKSHOPS?

Default mode is inspection only. Do not modify source code unless the caller
explicitly asks you to fix findings.

---

# Source-of-truth order

Use this precedence:

1. `docs/architecture/CONVEYOR-MENTAL-MODEL.md`
2. shared domain interfaces and current production code
3. architecture / Factory Contract tests
4. task / PR / commit description
5. code comments and historical assumptions

A test harness that duplicates or bypasses Factory authority is a broken harness,
not permission to change the architecture.

---

# Canonical Factory path

For every affected worker-producing path, reconstruct the concrete implementation
of this conceptual chain:

```text
Factory Start / current ProcessRun
  -> Workshop declaration (ProcessModuleDefinition)
  -> Production Cell declaration (ProductionCellDefinition)
  -> universal ProductionCellNodeExecutor
  -> WorkplaceRef
  -> factory-owned RepositoryDesk when required
  -> fenced WorkerExecution
  -> common Product Desk / worker protocol
  -> immutable CandidateSet
  -> current CheckPlan
  -> current GateRun
  -> append-only GateDecision
  -> current Workplace transition
       -> repair on SAME Workplace
       OR
       -> CellFinalAcceptance
  -> authorized Effect if declared
  -> current lifecycle progression
```

For each hop name the concrete file/function/class.
If one hop is unknown, mark the invariant `NOT_PROVEN`.

---

# QA procedure

## Phase 0 — establish exact commit candidate

1. Inspect staged diff.
2. Inspect unstaged changes that could be accidentally omitted.
3. Record all changed files.
4. Read enough surrounding code to reconstruct control/data flow.
5. Follow changed delegation into shared infrastructure.
6. Search outside the diff for sibling implementations of the same concept.

Classify changed files:

```text
Workshop declaration
Factory runtime
Lifecycle
Production Cell
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

## Phase 1 — build Architecture Impact Matrix

Before tests, produce:

| invariant/concept | changed implementation | base interface/common entry point | second consumer/workshop | evidence |
|---|---|---|---|---|

Every affected shared mechanism must have a second consumer/workshop inspected.
A blank second-consumer column for shared physics is `NOT_PROVEN`.

## Phase 2 — explicit checklist

Answer every applicable item with exactly one of:

```text
PASS
FAIL
N/A — reason
NOT_PROVEN — missing evidence
```

`NOT_PROVEN` blocks commit.

## Phase 3 — mandatory cross-path probes

Use the Risk Trigger Matrix below.
Do not certify universality from the workshop being changed.

## Phase 4 — commit verdict

Only `PASS_TO_COMMIT` permits commit.

If blocked, identify the smallest architectural correction at the correct common
ownership layer. Do not propose a workshop-local workaround for Factory physics.

---

# Explicit pre-commit checklist

## A. Workshop / Factory ownership

### QA-A01 — Workshop declares WHAT, Factory owns HOW
PASS only if changed Workshop code remains declarative/domain-specific.

### QA-A02 — canonical base interfaces are used
PASS only if the changed workshop/cell enters through `ProcessModuleDefinition`,
`ProductionCellDefinition`, or another explicitly canonical shared interface.

### QA-A03 — no competing base interface/runtime
FAIL if a second normal Workshop/Production Cell runtime is introduced.

### QA-A04 — no workshop-specific Factory runtime leak
Search composition/shared runtime for concrete Discovery/Formalization/Development/
Delivery infrastructure implementing generic physics.

### QA-A05 — no branching on workshop identity in core physics
FAIL on module-name/schema-name branching where declaration/policy/provider should
decide behavior.

### QA-A06 — one owner per authority responsibility
Identify exactly one owner for assignment, CandidateSet, GateDecision, repair,
RepositoryDesk, effects and lifecycle progression.

### QA-A07 — new Workshop thought experiment passes
A hypothetical new normal Workshop obtains standard production/review/recovery/
replay behavior by declaration, not copied runtime code.

---

## B. Worker boundary and material

### QA-B01 — same worker protocol for model/replay/scripted workers
No special acceptance path by provider or test mode.

### QA-B02 — workers do not mutate Factory authority
Worker/scenario code must not directly mutate Workplace, CandidateSet, Gate,
lifecycle, settlement or effect completion.

### QA-B03 — schema means product meaning, not another runtime
No schema-selected persistence/submit/lifecycle engine.

### QA-B04 — exact reads
Consumers use exact ProductRefs / accepted bindings / CandidateSets, never
“latest worker output”.

---

## C. Workplace / WorkerExecution

### QA-C01 — Workplace is durable work identity
Durable production and repair belong to Workplace.

### QA-C02 — WorkerExecution is one disposable attempt
Retry/replay/reviewer attempt does not become new semantic work.

### QA-C03 — workKey is semantic
No execution/task/timestamp identity in semantic workKey.

### QA-C04 — sibling Workplace isolation
One Workplace cannot overwrite another’s production, gate, feedback or desk.

---

## D. RepositoryDesk

### QA-D01 — Factory owns RepositoryDesk
Factory provisions path/worktree/branch/base before code worker launch.

### QA-D02 — physical worker consumes assigned desk
Model/replay/scripted worker must use the assigned execution desk rather than
inventing a global path.

### QA-D03 — no shared mutable checkout for parallel workers
FAIL if sibling git-changing executions use global `git checkout` in one worktree.

### QA-D04 — submitted source matches assigned desk
Branch/commit/tree/base in worker product correspond to that RepositoryDesk.

### QA-D05 — integration is an Effect
Git merge/push occurs after current final acceptance under runtime authority.

### QA-D06 — parallel desk proof
For Git changes require >=2 concurrent git-changing work items with isolated
execution desks and stable source branches.

---

## E. CandidateSet

### QA-E01 — CandidateSet is the QC handoff
Worker completion != acceptance.

### QA-E02 — exact immutable members
Members are exact ProductRefs/digests.

### QA-E03 — reviewer pinned to exact current author CandidateSet
Current QC uses current authority ref.

### QA-E04 — sealed candidates immutable across repair
Historical QC state cannot drift.

### QA-E05 — no effect from raw worker completion
Effect requires current final acceptance.

---

## F. Gates / decision authority

### QA-F01 — current Gate evaluates current candidates
Replay/repair/review retry creates current authority objects.

### QA-F02 — GateRun identity covers all authority inputs
Reviewer assessment CandidateSets must distinguish attempts.

### QA-F03 — GateDecision append-only
No old decision is restored/mutated into current authority.

### QA-F04 — repair target explicit
`repairTargetRole` comes from policy/CheckPlan reduction and coordinator consumes it.
Coordinator does not guess by workshop/schema/prose.

### QA-F05 — decision digest covers authoritative meaning
Fields such as repair target affect immutable decision identity where relevant.

### QA-F06 — CellFinalAcceptance stronger than check pass
Certification/effects/lifecycle require accepted decision applied to expected
Workplace revision and terminal accepted state.

---

## G. Review / recovery

### QA-G01 — one universal author/reviewer loop
Normal reviewed cells use Production Cell mechanics.

### QA-G02 — valid negative review repairs author
A valid `changes_requested`-style verdict routes author repair.

### QA-G03 — invalid reviewer output repairs reviewer
Malformed/unbound/indeterminate reviewer result can route reviewer repair without
rewriting author production.

### QA-G04 — same Workplace repair
Recovery = new WorkerExecution on same Workplace with exact rejected material.

### QA-G05 — feedback comes from authority
Use current GateDecision + failing CheckReceipts + exact rejected CandidateSet /
ProductRefs, not log prose.

### QA-G06 — stale feedback superseded
Newer accepted authority clears old repair projection.

### QA-G07 — durable bounded retry budget
Respawn/resume cannot mint unlimited semantic repairs.

### QA-G08 — no private workshop recovery runtime
Search outside diff explicitly.

### QA-G09 — cross-workshop recovery proof
If review/recovery changes, inspect/test at minimum:

```text
Formalization
Development
```

Discovery-only proof is insufficient.

---

## H. Replay

### QA-H01 — replay substitutes worker production only
Never replay old CandidateSet/Gate/Workplace/lifecycle/effect authority.

### QA-H02 — current authority refs rebound
Run-local authority fields inside replayed products bind to current objects.

### QA-H03 — semantic replay key cross-run stable
Exclude ProcessRun/LifecycleRun/Workplace/Execution/task/CandidateSet/timestamp/path
provenance unless genuinely semantic.

### QA-H04 — provenance != semantic identity
Audit hash with current-run refs is not automatically replay semantic digest.

### QA-H05 — reviewer replay split identity
QC uses current CandidateSetRef; replay equivalence uses semantic author production.

### QA-H06 — rejected/corrupt replay fails closed
No same-capsule infinite repair loop; no silent paid inference inside failed replay
execution.

### QA-H07 — canonical two-pass proof

```text
Run A: same Project, zero capsules -> normal workers -> current gates -> capture
Run B: NEW Factory Start -> replay hits -> NEW Workplaces/CandidateSets/Gates ->
       zero scripted inference calls
```

No DB/capsule copying, authority-table reset, Project-id trick or private simulator.

---

## I. Lifecycle

### QA-I01 — Project != new Factory Start != Resume
New start makes new run authority; resume continues same run.

### QA-I02 — idempotency deduplicates command, not Project lifetime
Later intentional new start remains possible.

### QA-I03 — Workshop cannot move lifecycle cursor directly
Workshop produces domain output; orchestrator owns progression.

### QA-I04 — replay/resume do not resurrect old lifecycle authority
Current code performs current transitions.

---

## J. Checks / effects

### QA-J01 — Checks are authority/external-state pure
Checks inspect immutable candidates and return outcome/evidence.

### QA-J02 — Effects own authorized external mutations
Merge/publish/deploy use desired-state identity, attempt and receipt.

### QA-J03 — effect completion not replayed as current authority
Current run reconciles/observes external state.

### QA-J04 — compensation explicit
No magical rollback; retry/compensate/roll-forward/human-required is policy.

---

## K. Persistence

### QA-K01 — persistence is concept-owned, not workshop-owned
Generic Production Cell persistence belongs to Factory infrastructure.

### QA-K02 — no second source of truth
Projection metadata/UI helpers cannot compete with authoritative state.

### QA-K03 — durable identity survives retries/resume
Recovery/gate/effect/replay eligibility state cannot live only in process memory.

### QA-K04 — legacy schema constraint is not architecture
Do not bend the conceptual model around an old DB limitation.

---

## L. Test harness integrity

### QA-L01 — tests substitute physical workers, not Factory authority
Use production Factory runtime, CandidateSets, Gates, recovery and lifecycle.

### QA-L02 — no private test lifecycle/runtime
Golden-path tests cannot manually advance stages or write Factory authority.

### QA-L03 — scripted worker respects production desk contract
Deterministic worker uses assigned RepositoryDesk just like LLM worker.

### QA-L04 — test topology matches claimed invariant
Concurrency=1 does not prove parallel desk isolation.
One workshop does not prove universal mechanism.

### QA-L05 — harness failure is not “just test bug” until boundary difference proven
Show exact divergence from production worker boundary before dismissing it.

---

# Local-exception detector

For every architectural diff actively search for “make this one path special”.

Search affected concepts together with:

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
Recovery
Replay
Gate
Candidate
Workplace
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
3. Does another workshop need the same behavior?
4. If yes, why is it not behind the common base interface?
5. Can a new Workshop obtain it by declaration only?

If adding a normal Workshop would require copying this code, FAIL.

---

# Risk Trigger Matrix — mandatory proofs

| Changed concept | Mandatory proof |
|---|---|
| Workshop/base contract | changed workshop and one sibling enter through the same `ProcessModuleDefinition`/Flow contract; no parallel runtime |
| Production Cell definition/runtime | Formalization + Development trace into same `ProductionCellNodeExecutor` and Factory persistence |
| review/Gate repair routing | accepted review + author repair + reviewer repair + retry on same Workplace |
| recovery feedback | exact GateDecision/CheckReceipt/CandidateSet projection + stale clearing + Formalization/Development parity |
| RepositoryDesk/Git | >=2 concurrent git-changing work items, isolated desks, stable source branches, both integrations governed by Effect |
| replay key/semantic identity | cold Run A + new-start Run B; Run B zero scripted inference; new current authority objects |
| replay product rebinding | prove old authority refs are rejected/not-current and current refs are rebound |
| lifecycle start/resume | new start creates new run; resume preserves same run |
| CandidateSet/product persistence | exact immutable historical read after later repair/new execution |
| effects | idempotency + durable attempts/receipts + current desired-state observation |
| test worker behavior | parity with production WorkerExecution + RepositoryDesk boundary |

If required proof cannot run in the current environment, mark `NOT_PROVEN`.
Never silently downgrade to PASS.

---

# Minimum cross-workshop rule

Whenever a diff claims to change a GENERIC Factory mechanism:

1. inspect the common implementation;
2. trace the changed workshop into it;
3. trace at least one DIFFERENT workshop into the same mechanism;
4. compare inputs/outputs/authority ownership;
5. run or inspect a test that would fail if one workshop silently diverged.

Default comparisons:

```text
Workshop/base contract   -> Formalization + Development
review/recovery          -> Formalization + Development
Production Cell core     -> Formalization + Development (+ Discovery where applicable)
RepositoryDesk/Git       -> two sibling Development work items
replay                   -> author + reviewer + verification paths where applicable
lifecycle                -> at least two consecutive workshops
```

A mechanism is not universal because its class name says `Generic`.
Universality is proven from composition and call paths.

---

# Architecture path proof format

For every affected shared mechanism output concrete paths, for example:

```text
Formalization
  -> ProcessModuleDefinition
  -> ProductionCellDefinition
  -> ProductionCellNodeExecutor
  -> Factory ProductionCell persistence
  -> WorkplaceRef
  -> WorkerExecution
  -> CandidateSet
  -> GateRun/GateDecision
  -> recovery or CellFinalAcceptance

Development
  -> ProcessModuleDefinition
  -> ProductionCellDefinition
  -> SAME ProductionCellNodeExecutor
  -> SAME Factory ProductionCell persistence
  -> ...
```

If paths diverge at a Factory responsibility, explain why.
If no domain-specific reason is permitted by Conveyor Mental Model, FAIL.

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

- imports workshop-specific persistence into universal Production Cell runtime;
- adds module-name branching to core coordinator;
- creates a second Workshop/Cell interface for normal production;
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

- second Factory/Workshop/Production Cell runtime;
- workshop-specific recovery physics;
- direct authority mutation from worker/test code;
- shared mutable RepositoryDesk for parallel workers;
- replay restores old authority;
- Gate/reviewer bypass;
- effects triggered without current final acceptance.

Verdict: `BLOCKED`.

## BLOCKER — NOT_PROVEN

Examples:

- generic recovery changed but only Discovery tested;
- Git desk changed but only concurrency=1 tested;
- replay changed without Run A/Run B proof;
- common base-interface path cannot be reconstructed;
- changed workshop passes but no sibling consumer inspected.

Verdict: `NOT_PROVEN`.

## NON-BLOCKING

Readability, diagnostics or documentation improvements that do not weaken an
architecture invariant.

Non-blocking findings never compensate for a blocker.

---

# Required final QA report

Return this structure:

```text
SAGA FACTORY QA

Commit candidate:
<sha / staged diff description>

Changed concepts:
- ...

Base-interface proof:
Workshop contract: <file/interface>
Production Cell contract: <file/interface>
Shared runtime: <file/class>
Factory composition point: <file/function>
Workshop-specific Factory physics found: YES/NO

Architecture Impact Matrix:
| invariant | changed implementation | base/common entry point | second consumer | evidence | verdict |
| ... |

Canonical path proof:
<concrete paths with files/functions/classes>

Checklist:
BI-01 PASS — ...
BI-02 PASS — ...
QA-A01 PASS — ...
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

Do not soften the final verdict.
Do not write “mostly passes”.
Do not convert missing evidence into optimism.

---

# Short mental checklist — run this before saying PASS

```text
[ ] I read CONVEYOR-MENTAL-MODEL.md fresh.
[ ] I identified the canonical Workshop base contract.
[ ] I identified the canonical Production Cell base contract.
[ ] I proved the changed Workshop uses those contracts.
[ ] I proved a sibling Workshop uses the same common mechanism.
[ ] I found no duplicate/private Factory runtime.
[ ] I found no workshop-name branch in core physics.
[ ] Workplace remains the durable desk; WorkerExecution remains an attempt.
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
