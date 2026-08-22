# Workshop Conformance Coverage — Agent Implementation Guide

Status: implementation handoff
Date: 2026-08-21
Branch baseline: `w0-waves`
Primary reference implementation: Discovery unified-kernel pack
Governing architecture: ADR-084 / Saga Kernel Conformance Engine

## 1. Mission

Continue the unified Saga Factory conformance work without creating another test runtime.

The next agent must:

1. build scenario packs for Formalization, Development, and Delivery using the same conformance kernel already used by Discovery;
2. keep the production Factory as the only authority for state transitions, material identity, gates, review, recovery, effects, settlement, and lifecycle routing;
3. build one global Factory coverage universe from workshop-local obligations, inter-desk transitions, inter-workshop handoffs, generic Factory invariants, and fault/recovery dimensions;
4. compute demonstrated coverage only from PASS `ScenarioEvidenceBundle`s;
5. integrate mutation-kill evidence into the same report;
6. produce a final Factory Conformance Coverage report with explicit uncovered obligations and surviving mutants.

The target is not “many tests”. The target is an executable proof map:

```text
independent normative obligations
        +
installed workshop topology
        +
scenario packs
        +
scripted cognition / controlled human-external world
        |
        v
canonical production Factory
        |
        v
read-only durable observation
        |
        v
independent oracles
        |
        v
ScenarioEvidenceBundle
        |
        v
mathematical coverage + mutation report
```

A workshop is not closed because its test files exist. It is closed only when:

- its workshop coverage universe is 100% planned;
- its workshop coverage universe is 100% demonstrated by PASS evidence;
- every P0 obligation has at least one real detector witness and mutation witness;
- all deliberately excluded internal platform fault edges are named and assigned to the common K4 fault scheduler;
- no unexplained `ANONYMOUS-STALL`, stale authority, or stranded execution remains.

## 2. Core architectural conclusion

The current Factory already spans several materially different kinds of workshop mechanics:

1. cognitive Production Cell — LLM/scripted worker produces a typed product;
2. reviewed Production Cell — author CandidateSet, reviewer CandidateSet, final Gate;
3. fan-out/fan-in Production Cell — one declared collection creates multiple Workplaces and later rejoins;
4. deterministic kernel node — no worker is hired;
5. human node — a typed interaction adapter supplies an authorized human decision;
6. post-acceptance effect — Factory-owned external mutation after accepted material;
7. external provider / authoritative observation — environment outside the Factory is controlled but not fabricated;
8. continuation/replan module — a later process package adopts prior certified material and continues under fresh authority.

This is why the conformance engine must be organized around mechanisms and obligations rather than around workshop names.

Discovery proves the basic cognitive singleton Production Cell and deterministic settlement pattern.
Formalization adds repeated reviewed cells, acceptance effects, a baseline-freeze kernel, and rich traceability invariants.
Development adds fan-out/fan-in, Git effects, dependency scheduling, candidate freezing, readiness certification, verification, and continuation/replan variants.
Delivery is the strongest non-LLM proof: it has no execution profiles at all; it is kernel + human + external providers + observation + settlement.

If all four workshops can bind to one test kernel without workshop-name branches in the kernel, that is strong architectural evidence that Saga is a universal Factory runtime rather than a collection of product-specific pipelines.

## 3. Read these sources before implementation

Do not start by cloning Discovery files. Reconstruct each installed workshop first.

Architecture and common proof kernel:

1. `AGENTS.md`
2. `GUARDRAILS.md`
3. `docs/architecture/CONVEYOR-MENTAL-MODEL.md`
4. `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`
5. `docs/architecture/decisions/084-causal-conformance-proof-kernel.md`
6. `docs/testing/GRAPH-TEST-STRATEGY.md`
7. `docs/testing/CAUSAL-PROOF-IMPLEMENTATION-BRIEFS.md`
8. `docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md`
9. `tests/factory-proof/canonical-proof-composition.mjs`
10. `tests/factory-proof/scenario-runner.mjs`
11. `tests/factory-proof/scenario-evidence.mjs`
12. `tests/factory-proof/trace-observer.mjs`
13. `tests/factory-proof/coverage-kernel.mjs`
14. `tests/factory-proof/obligation-contracts.mjs`
15. `tests/factory-proof/mutation-algebra.mjs`
16. `tests/factory-proof/installed-protection-reader.mjs`

Discovery reference implementation:

- `tests/factory-proof/discovery-scenario-pack.mjs`
- `tests/factory-proof/discovery-resilience-pack.mjs`
- `tests/factory-proof/discovery-resilience-pack.test.mjs`
- `tests/factory-proof/discovery-scenario-drive.mjs`
- `tests/factory-proof/discovery-coverage-drive.mjs`
- `tests/factory-proof/discovery-restart-proof.mjs`
- `tests/factory-proof/discovery-retry-exhaustion-proof.mjs`
- `docs/handoff/2026-08-21-discovery-closure-resilience.md`

Formalization production sources:

- `src/process-modules/modules/formalization/formalization-process-module.ts`
- `src/modules/formalization/application/formalization-production-cell-installation.ts`
- `src/modules/formalization/application/formalization-check-providers.ts`
- `src/modules/formalization/application/formalization-contract-validator.ts`
- `src/modules/formalization/application/acceptance-contract-validator.ts`
- `src/modules/formalization/application/srs-contract-validator.ts`
- `src/modules/formalization/application/formalization-accept-products-effect.ts`
- `tests/factory-e2e/w9-happy-handlers.mjs`

Development production sources:

- `src/process-modules/modules/development/development-process-module.ts`
- `src/process-modules/modules/development/development-continuation-process-module.ts`
- `src/process-modules/modules/development/development-verification-continuation-process-module.ts`
- `src/modules/development/application/development-check-providers.ts`
- `src/modules/development/application/development-installation.ts`
- `src/modules/development/application/development-production-cell-installation.ts`
- `src/modules/development/domain/development-kernel-ports.ts`
- `tests/factory-e2e/w9-happy-handlers.mjs`

Delivery production sources:

- `src/process-modules/modules/delivery/delivery-process-module.ts`
- `src/modules/delivery/application/delivery-installation.ts`
- `src/modules/delivery/domain/delivery-kernel-ports.ts`
- `src/modules/delivery/domain/delivery-settlement-policy.ts`

Lifecycle boundary:

- `src/process-modules/lifecycles/product-delivery-lifecycle.ts`

If this guide conflicts with an accepted ADR or the current production declaration, the accepted ADR/current declaration wins. Update this guide in the same commit that resolves the discrepancy.

## 4. Non-negotiable rules

### 4.1 Test Factory mechanics, not LLM quality

The deterministic conformance suite does not judge whether an LLM wrote a good PRD, a wise architecture, elegant code, or a persuasive review.

It tests mechanical/relational properties such as:

- schema and payload contract;
- exact ProductRef/digest binding;
- CandidateSet authority;
- Gate outcome and repair owner;
- reviewer subject binding;
- transition legality;
- recovery/retry behavior;
- stale-fence refusal;
- tool lifecycle;
- idempotency;
- effects and receipts;
- restart/redrive;
- exact downstream handoff;
- bounded progress.

Semantic model quality belongs to evals/canaries, not this deterministic kernel.

### 4.2 Replace only the external source of nondeterminism

For cognitive cells, replace model cognition through the supported worker seam.

For Delivery, do not invent a worker: Delivery has no execution profiles. Control only the allowed human/external provider adapters.

The test must not replace or emulate:

- dispatcher;
- Workplace reducer;
- execution finalizer;
- CandidateSet sealing;
- Gate/CheckProvider execution;
- recovery planner;
- final acceptance;
- lifecycle router.

### 4.3 Never write authority state from a scenario

Do not insert/update/delete authority records to force a state.

Never manufacture:

- GateDecision;
- CandidateSet;
- accepted authority head;
- recovery ownership;
- final acceptance;
- lifecycle transition;
- execution fence;
- recovery epoch.

Faults may crash, delay, deny, corrupt actor-visible input, or control an external provider. They may not fabricate production truth.

### 4.4 Independent expectations

Do not call the production validator under test to compute the expected answer.

Strict proof reconciles three independent sources:

1. versioned `AcceptanceObligationContract`;
2. installed production protection/binding identity;
3. observed durable/external-world facts.

The obligation registry must remain independent of production CheckPlans/validator implementations.

### 4.5 Demonstrated coverage requires PASS evidence

A scenario declaration contributes only to planned coverage.

Only a PASS `ScenarioEvidenceBundle` contributes to demonstrated coverage.

Failed, timed-out, inconclusive, or evidence-less scenarios contribute zero demonstrated coverage.

### 4.6 Workshop closure is not platform-fault closure

A workshop pack owns faults that can be triggered through a legitimate worker, human, or external-world interface.

Do not inject internal kernel exceptions merely to force a `kernel -> complete-failed` edge.

Those edges belong to the common K4 named fault scheduler and must be listed as `platformFaultEdges` until that scheduler exists.

### 4.7 No workshop-name branches in the common kernel

Do not add `if (module === 'formalization')` or equivalent branches to:

- `scenario-runner.mjs`;
- `coverage-kernel.mjs`;
- canonical composition;
- evidence bundle core.

If a new concept is needed, first express it generically as selector, role, topology property, effect type, human adapter, external provider, or oracle input.

## 5. Common kernel to reuse

### `scenario-runner.mjs`

Ordinary scenarios use `runScenario(...)`:

```text
validate
  -> canonical composition
  -> production Factory drive
  -> read-only durable trace
  -> progress oracle
  -> independent workshop oracles
  -> ScenarioEvidenceBundle
```

Do not create one runner per workshop.

Dedicated multi-start or real-time drives are acceptable only when the generic runner cannot represent a genuine temporal/restart proof. They must still use canonical composition and emit the same evidence contract.

### `trace-observer.mjs`

Extend only when a required durable fact is genuinely generic or needed by multiple workshops.

Rules:

- read only;
- no reducer import;
- no expected transition logic;
- schema drift fails closed;
- exact refs/hashes are preserved where authority matters.

### `coverage-kernel.mjs`

Coverage tokens are intentionally open-ended strings.

Core namespaces already include:

```text
obligation:...
gate:...
transition:...
negative-transition:...
transition-pair:...
fault-class:...
injection-boundary:...
detector:...
counterfactual:...
scenario-kind:...
repair-owner:...
```

Workshop packs may use additional namespaced tokens without changing the mathematical engine:

```text
binding:...
lineage:...
fanout:...
fanin:...
effect:...
recovery:...
restart:...
idempotency:...
handoff:...
projection:...
human:...
external-observation:...
```

## 6. Universal recipe for any workshop

### Step 0 — repair the normative registry before trusting global closure

Audit `tests/factory-proof/obligation-contracts.mjs` against current independent requirements and installed protections.

Known debt at this handoff:

- Discovery Proposal/Readiness descriptions still reflect an older payload vocabulary.

Fix metadata drift before treating registry equality as a global acceptance ratchet.

Do not derive semantics from installed validators; compare identities/versions only after the independent contracts are written.

### Step 1 — inventory production topology

Before writing scenarios, create a table:

| Node | Kind | Roles | Product | CheckPlan | Effect | Success edge | Failure/human edges |
|---|---|---|---|---|---|---|---|

Also inventory:

- terminal outcomes;
- recovery policy;
- execution modes;
- fan-out selectors/dependencies;
- kernel nodes;
- human nodes;
- post-acceptance effects;
- lifecycle input/output mappings;
- continuation module variants.

Do not infer topology from old tests.

### Step 2 — define the workshop coverage universe first

Create a finite explicit list before implementing the entire scenario pack.

Minimum families:

```text
A. local normative obligations
B. author/final Gate outcomes
C. positive transitions
D. negative transitions
E. exact material/lineage bindings
F. review semantics where review exists
G. fan-out/fan-in where topology exists
H. effects/effect idempotency where effects exist
I. recovery/counterfactual/fence/tool lifecycle
J. restart/redrive/idempotency
K. workshop output/certificate
L. exact lifecycle handoff
```

Also export `PLATFORM_FAULT_EDGES` for internal kernel exception routes that the workshop cannot legitimately trigger.

### Step 3 — build the valid positive spine

Reuse existing deterministic happy handlers where possible.

Prefer wrapping/mutating a known-good handler over copying it.

The positive spine must prove:

- every Production Cell accepts valid material;
- every reviewer class accepts the exact author CandidateSet;
- every kernel node consumes exact accepted upstream material;
- every declared post-acceptance effect settles;
- every positive transition occurs;
- terminal output/certificate is exact;
- downstream lifecycle handoff is exact.

### Step 4 — one negative representative per independent protection

For each independent obligation, create at least one real causal mutant that must be killed by the assigned detector.

Use the shared mutation vocabulary:

```text
ref           -> missing / foreign / stale / cross-run
digestOf      -> correct-looking ref + wrong digest
subset        -> out-of-scope member / missing member
unique        -> duplicate key/code
cardinality   -> zero / below / above
grammar       -> malformed / truncated / near-miss
projection    -> missing / ambiguous projection
lineage       -> broken ancestor/edge
ordering      -> valid values, illegal order
version       -> downgraded/incompatible version
crossField    -> individually valid, relationally inconsistent fields
```

A negative scenario must identify:

- fault origin;
- detector;
- evidence;
- Gate/rejection result;
- repair/escalation owner;
- prohibited transition.

“Run failed” is not enough.

### Step 5 — causal repair + feedback counterfactuals

For repairable defects prove:

```text
exact feedback     -> intended repair
absent feedback    -> no magical repair
stale feedback     -> no magical repair
corrupted feedback -> no magical repair
```

Actors may react only to production-visible state. They must not branch on hidden attempt count or scenario id.

Do not run this quartet for every mechanically identical cell. Apply equivalence classes as described below.

### Step 6 — generic resilience corpus

Applicable dimensions:

- worker crash;
- retry/recovery exhaustion;
- duplicate `product_submit`;
- late/post-completion tool call;
- stale execution fence;
- restart/redrive;
- semantic replay/idempotency;
- stale/foreign reviewer subject;
- effect idempotency;
- effect crash windows;
- no stranded execution;
- no `ANONYMOUS-STALL`.

Bind these to stable mechanism classes rather than blindly duplicating every scenario for every cell.

### Step 7 — deterministic kernel nodes

For each kernel node:

- cover every normally constructible event;
- prove exact upstream identity;
- prove exact output/certificate identity;
- cover replay/idempotency if authoritative material is persisted;
- list truly internal exceptions under common platform faults.

### Step 8 — exact inter-workshop handoff

Use durable stage facts:

- upstream `mapped_output_snapshot`;
- `factory_process_transitions`;
- downstream `input_snapshot`.

Prove field-by-field semantic authority equality:

```text
certificate ref/hash
output ref/hash
outcome
payload/baseline/candidate binding
        ==
downstream StageRun input
```

The existence of the next stage is not sufficient proof.

### Step 9 — pack structural tests

Every workshop pack test must prove:

- scenario IDs unique;
- all scenarios validate;
- all scenarios map to a runtime case or named special drive;
- planned workshop closure = 100%;
- platform-owned internal fault edges are excluded honestly;
- set cover is feasible.

### Step 10 — coverage drive

The coverage drive must:

1. run scenarios in isolated processes when singleton DB/composition state can leak;
2. collect valid EvidenceBundles;
3. produce planned and demonstrated matrices;
4. count only PASS bundles;
5. list excluded bundles;
6. exit non-zero unless demonstrated workshop closure is 100%.

### Step 11 — classify every red before fixing it

Possible classes:

**Scenario/fixture bug**
- intended stimulus was not produced;
- fixture violates unrelated prerequisite;
- oracle expects something production never promised.

**Evidence-layer bug**
- durable fact exists but observer cannot read it;
- test-side schema drift hides evidence;
- bundle/coverage plumbing drops valid facts.

**Normative-registry bug**
- independent contract is stale/contradictory to an accepted design decision.

**Factory production bug**
- stimulus is correct;
- obligation is correct;
- observed production state violates it.

If it is a production defect, fix production separately. Do not weaken the scenario to make it green.

### Step 12 — promote only after deterministic local green

Do not delete legacy tests or register a new blocking pack until:

- repeated local runs are deterministic;
- every workshop-owned token is demonstrated;
- P0 protections have mutation witnesses;
- no unexplained flake remains;
- legacy obligations have mapped replacements.

## 7. Avoid Cartesian scenario explosion

Never execute the full product:

```text
cells x roles x faults x feedback variants x restart boundaries x outcomes
```

Use hierarchical coverage.

### 7.1 Mandatory per-protection coverage

Every distinct independent protection/check provider needs:

- positive witness;
- negative witness;
- detector/evidence assertion;
- causal repair witness when repairable.

This cannot be optimized away.

### 7.2 Mandatory per-topology coverage

Every distinct mechanism needs a representative:

- singleton author-only cell;
- reviewed cell;
- fan-out/fan-in cell;
- post-acceptance effect;
- deterministic kernel node;
- human node;
- lifecycle handoff;
- continuation/replan where installed.

### 7.3 Generic physics uses equivalence classes

Fence, duplicate-submit, late-call, crash, and basic review mechanics need not be repeated for every cell if they traverse the same production path.

Use at least one representative for each materially different class:

- execution mode (`tracker_only`, `git_change`, `artifact_change`, read-only evidence);
- author vs reviewer;
- singleton vs fan-out;
- product persistence mode;
- reviewer implementation class;
- post-acceptance effect implementation;
- continuation module variant.

### 7.4 Pairwise/covering-array selection

After mandatory protection scenarios are fixed, select generic-physics cases pairwise over dimensions such as:

```text
cell class
role
execution mode
fault class
recovery state
restart state
review present/absent
effect present/absent
fan-out present/absent
```

Use exact set cover for small corpora and deterministic greedy set cover for large corpora via `coverage-kernel.mjs`.

Set cover minimizes redundant scenarios; it does not remove mandatory obligations.

## 8. Formalization — concrete implementation plan

Formalization is much more complex than Discovery.

Current production topology:

```text
define-product-contract        reviewed Production Cell
  -> model-use-cases           reviewed Production Cell
  -> define-acceptance-contract reviewed Production Cell
  -> reconcile-what            reviewed Production Cell
  -> freeze-acceptance-baseline kernel
  -> define-architecture-contract reviewed Production Cell
  -> settle-formalization      kernel
  -> formalized | inconsistent | failed
```

There are five reviewed Production Cells. Every reviewed cell has:

- author Gate;
- reviewer CandidateSet;
- final Gate;
- `formalization.accept-exact-products.v1` post-acceptance effect;
- `maxAttempts=5`, `onExhausted='requeue'` at the cell level.

Do not confuse execution-profile recovery metadata with the Production Cell recovery authority. The Cell definition is authoritative for the cell loop.

### 8.1 Formalization scenario-pack files

Recommended structure:

```text
tests/factory-proof/formalization-scenario-pack.mjs
tests/factory-proof/formalization-resilience-pack.mjs
tests/factory-proof/formalization-scenario-pack.test.mjs
tests/factory-proof/formalization-scenario-drive.mjs
tests/factory-proof/formalization-coverage-drive.mjs
```

Create dedicated special drives only if restart/backoff proofs genuinely require them.

### 8.2 Positive Formalization spine

Reuse current W9 deterministic handlers for:

- product contract;
- use cases;
- acceptance contract;
- reconciliation;
- architecture/SRS;
- approved requirements reviewer;
- approved architecture reviewer.

Positive flow coverage must include:

```text
define-product-contract -> model-use-cases
model-use-cases -> define-acceptance-contract
define-acceptance-contract -> reconcile-what
reconcile-what -> freeze-acceptance-baseline
freeze-acceptance-baseline -> define-architecture-contract
define-architecture-contract -> settle-formalization
settle-formalization -> complete-formalized
```

Also prove:

- every accepted author CandidateSet is the subject of the correct reviewer;
- every final acceptance binds the accepted author material;
- accept-products effect projects exact sealed hashes;
- baseline is frozen before Architecture starts;
- SRS consumes the frozen baseline, not mutable current AC rows;
- settlement issues one exact Solution Contract + certificate;
- Formalization -> Development handoff preserves certificate, Solution Contract, baseline hash, SRS and AC bindings.

### 8.3 Formalization independent protection cases

The existing normative registry already identifies five major submission-validator obligations:

1. `frm.submission.product-contract`
2. `frm.submission.use-cases`
3. `frm.submission.acceptance-contract`
4. `frm.submission.reconciliation`
5. `frm.submission.srs-contract`

Build at least one causal representative for every independent constraint.

High-value mutants:

**Product contract**
- PRD has no brief root;
- FR derives from foreign/stale PRD;
- constraint register item is undisposed.

**Use cases**
- UC does not derive from accepted PRD/FR;
- cross-run artifact substituted.

**Acceptance contract**
- AC has no exact FR/NFR lineage;
- FR-derived AC has no UC lineage;
- duplicate criterion code;
- heading near-miss `AC-1` vs `AC-01`;
- wrong heading level / missing colon;
- missing constraint coverage.

**Reconciliation**
- silent subset in coverage report;
- report claims reconciled while a required coverage diff remains.

**SRS**
- SRS missing;
- SRS -> PRD trace missing;
- file/hash mismatch;
- §12 Decision Log missing/invalid;
- missing §D2 stanza;
- duplicate AC stanza;
- foreign AC code;
- invalid `ac_kind`;
- missing constraint coverage in §D2;
- contract version mismatch.

Do not turn the SRS suite into prose-quality evaluation. These are structural/relational properties only.

### 8.4 Formalization review coverage

Five cells share the generic review mechanism, but there are two reviewer classes:

- requirements reviewer;
- architecture reviewer.

Required review coverage:

- exact subject CandidateSet approved;
- stale/foreign subject rejected;
- reviewer `changes_requested` -> same Workplace author repair;
- invalid reviewer output -> reviewer repair;
- exact reviewer feedback causes author repair;
- absent/stale/corrupt reviewer feedback does not cause the same repair.

Run the full feedback quartet at least once for the requirements-reviewer class and once for the architecture-reviewer class. Other cells can rely on the shared review mechanism plus their own author-protection causal tests.

### 8.5 Accept-products effect coverage

The effect is a distinct Factory mechanism and must have its own representative scenarios.

Prove:

- accepted sealed artifact hashes become accepted projection exactly;
- replay/idempotency does not create divergent acceptance;
- mutable artifact row hash drift after sealing yields `repair_required`, not silent acceptance;
- no partial mutation occurs when one item is drifted;
- effect receipt and final acceptance are exact.

The drift repair path is especially important: it tests post-Gate failure ownership, not ordinary author Gate repair.

### 8.6 Baseline-freeze kernel coverage

Constructible events:

```text
frozen          -> define-architecture-contract
drift-detected  -> complete-inconsistent
```

Internal exception `failed` belongs to platform fault scheduling unless a legitimate upstream fixture can cause it without authority corruption.

Prove:

- only accepted ACs from the current lifecycle are frozen;
- accepted IDs/hashes and criterion codes are exact;
- duplicate criterion codes fail closed;
- another lifecycle on the same epic cannot leak ACs into this baseline;
- baseline semantic digest is cross-run stable where the production contract promises it.

Reuse/extend the existing W1-4 two-lifecycle proof rather than inventing a parallel isolation test engine.

### 8.7 Formalization settlement coverage

Required outcomes:

- `formalized` happy path;
- `inconsistent` from a legitimate inconsistent contract/baseline state if constructible;
- internal settlement exception remains platform-owned if it requires kernel injection.

Prove exact Solution Contract bundle:

```text
PRD
FR[]
NFR[]
RULE[]
UC[]
AC[]
acceptanceBaselineHash
SRS
```

Also prove exact `warrantRef`/constraint citations when the FormalizationCase carries a constraint register.

### 8.8 Formalization resilience equivalence classes

Do not repeat Discovery’s generic resilience suite five times.

Recommended minimum representatives:

- tracker-only requirements author: crash/fence/duplicate/late-call/restart;
- requirements reviewer: crash/fence/review repair;
- architecture author: crash/fence/restart because it adds SRS file + contractRef behavior;
- architecture reviewer: review feedback quartet;
- accept-products effect: effect restart/idempotency;
- baseline-freeze kernel: replay/lifecycle isolation.

Then use coverage tokens to show which common physics class each scenario proves.

## 9. Development — concrete implementation plan

Development is the most complex workshop and must not be approached until Formalization exposes weaknesses in the common pack pattern.

Base production topology:

```text
plan-task-graph                 Production Cell
  -> resolve-task-graph         kernel
  -> implement-work-items       fan-out reviewed Production Cell
  -> freeze-integrated-candidate kernel
  -> certify-product-readiness  Production Cell
  -> bind-runnable-candidate    kernel
  -> verify-acceptance          fan-out Production Cell
  -> settle-development         kernel
  -> verified | blocked | failed
```

Important additional installed variants:

- managed continuation (`solution-development-managed@1.1.0`);
- re-plan continuation (`solution-development-managed@1.2.0`);
- verification continuation (`solution-development-verification-continuation@1.0.0`).

These are part of Development conformance, not optional historical details.

### 9.1 Development pack decomposition

Do not put everything in one huge file.

Recommended structure:

```text
development-scenario-pack.mjs                 base happy + local protections
development-fanout-pack.mjs                   scheduling/fan-out/fan-in
development-resilience-pack.mjs               generic execution physics
development-continuation-pack.mjs             managed/replan/verification continuation
development-effect-pack.mjs                   git integration/effect crash windows
development-scenario-drive.mjs
development-coverage-drive.mjs
```

All packs still use the same common runner/evidence/coverage kernel.

### 9.2 Planner cell coverage

Independent protections include task-graph contract and replan graph where applicable.

High-value cases:

- duplicate item key;
- empty graph;
- foreign `dependsOn` key;
- missing AC coverage;
- dropped SRS module coverage;
- repository/base binding mismatch;
- replan graph retains avoidable serialization when parallelism is required;
- replan graph fails to extract shared-surface work.

Positive proof must show the kernel `resolve-task-graph` canonicalizes the already Gate-accepted proposal; the kernel must not rescue an invalid proposal.

### 9.3 Fan-out implementation cell

This is the first major topology not present in Discovery/Formalization.

Prove:

- one graph item -> one stable Workplace/workKey;
- all required items materialize;
- dependency ordering is respected;
- independent items may run concurrently within configured ceiling;
- fan-in waits for all required accepted items;
- one failed/repairing item does not make accepted siblings lose authority;
- accepted siblings remain exact across another item’s repair/restart;
- no cross-item desk/material leakage.

Implementation author protections:

- exact `workItemKey` equals kernel-projected item key;
- changed files stay inside effective change scopes;
- base commit matches effective desk base;
- claimed file surface cannot silently narrow without `droppedFiles` disposition;
- submitted commit/tree identity is valid;
- stale/foreign CandidateSet cannot be reviewed/integrated.

### 9.4 Implementation review coverage

Prove:

- reviewer reads exact author CandidateSet;
- exact source commit/tree is reviewed;
- `changes_requested` returns to same Workplace author;
- stale/foreign author set rejected;
- invalid review verdict repaired at reviewer;
- final Gate accepts only valid verdict bound to current author authority.

### 9.5 Git integration effect

This is a distinct effect implementation and deserves its own fault matrix.

Prove:

- model does not own merge authority;
- effect consumes exact accepted source material;
- `treeSha` is observed tree identity, not commit SHA substitution;
- integration base and source branch are exact;
- typed conflict does not silently mutate integration branch;
- duplicate/redrive is idempotent;
- crash after external Git mutation but before receipt converges through observation/receipt logic;
- final acceptance cannot precede effect settlement.

Do not mock the effect by writing “merged=true” into Factory tables.

### 9.6 Freeze-integrated-candidate kernel

Prove:

- freeze occurs only after every required accepted implementation result/effect;
- one immutable source candidate is produced;
- candidate content hash pins observed repository state;
- post-freeze repository drift cannot silently reuse old verification evidence;
- replay returns same semantic candidate where production promises idempotency.

### 9.7 Readiness certification cell

This cell combines two protections with different ownership semantics:

1. readiness monotonicity;
2. local runnability.

High-value cases:

- narrowed readiness declaration -> human escalation;
- changed declaration for same source candidate -> escalation;
- exact sourceCandidate ref/hash mismatch -> rejection;
- runnability failure owned upstream, not repaired by rewriting the manifest;
- unknown/error runnability cannot authorize verification;
- duplicate manifest/redrive is idempotent.

This is a critical test of correct defect ownership.

### 9.8 Bind-runnable-candidate kernel

Prove exact binding of:

```text
accepted readiness manifest
+ deterministic runnability receipt
+ frozen source candidate
-> integrated candidate
```

Foreign/stale receipt or candidate must not bind.

### 9.9 Verification fan-out

Prove:

- every required AC creates one verification Workplace;
- evidence pins exact accepted AC hash;
- evidence pins exact frozen candidate hash;
- passed/failed/unknown/error vocabulary is handled according to policy;
- `unknown`/`error` never authorizes a verified bundle;
- one failed verification routes through settlement as upstream product defect, not endless verifier self-repair;
- fan-in waits for required evidence set;
- evidence from old candidate becomes invalid after candidate drift.

### 9.10 Development settlement

Required outcome coverage:

- `verified`;
- `blocked` from legitimate verification/readiness deficiency;
- `failed` from legitimate infrastructure/lineage failure where constructible.

Prove exact Development certificate and VerifiedIntegrationBundle.

### 9.11 Development continuation modules

Treat each continuation as a topology variant.

**Managed continuation 1.1.0**

Prove:

- planner is absent;
- deterministic continuation graph is adopted;
- managed textual SourceChangeCandidate replaces worker Git mutation;
- author lacks Bash/Git mutation authority;
- Factory owns materialization/integration;
- exact accepted prefix is reused, not reconstructed by recency.

**Re-plan continuation 1.2.0**

Prove:

- replan planner exists before resolver;
- cycle-1 diagnosis is visible as authorized input;
- old remaining work becomes superseded before new graph materializes;
- superseded tasks are no longer claimable;
- new Workplaces carry fresh module/version authority;
- replan-graph provider kills parallelism/shared-surface defects.

**Verification continuation 1.0.0**

Prove:

- no planner/implementation/Git-production node exists;
- exact authorized baseline is adopted;
- only verification + settlement run;
- inherited verification CheckPlan remains intact;
- upstream-defect failure routes through settlement.

### 9.12 Development resilience equivalence classes

At minimum cover generic execution physics for:

- `tracker_only` planner;
- `git_change` implementation author;
- implementation reviewer;
- readiness certifier;
- verification worker;
- `artifact_change` managed-source author;
- fan-out restart/fence;
- post-acceptance Git effect.

Do not multiply every generic fault by every work item. Use representative work items plus fan-out invariants.

## 10. Delivery — concrete implementation plan

Delivery is structurally different and is a required universality proof.

Current topology:

```text
preflight-release    kernel
  -> approve-release human
  -> publish-deploy  kernel + external providers
  -> observe-release kernel + authoritative observation
  -> settle-delivery kernel
  -> released | approval-required | blocked | failed
```

`executionProfiles: []` is intentional. There is no LLM worker to script.

### 10.1 Delivery scenario model

Delivery scenarios control:

- lifecycle input authorization/deferred mode;
- preflight provider outcomes;
- human approval adapter outcomes;
- external action provider outcomes;
- authoritative observation provider outcomes;
- restart/fault schedule.

They must not add a fake worker.

### 10.2 Delivery positive/terminal outcomes

Cover at least:

- authorized + approved + actions succeed + observations match -> `released`;
- deferred mode -> `approval-required` without external effect;
- approval pending/expired -> `approval-required`;
- approval denied -> `blocked`;
- preflight blocked -> `blocked`;
- infrastructure/provider integrity failure -> `failed`;
- optional “approval not required” path if allowed by current policy fixture.

### 10.3 Exact authorization binding

Prove approval binds all three:

```text
candidate hash
preflight hash
release-policy hash
```

Mutants:

- stale candidate approval;
- foreign preflight approval;
- wrong release-policy hash;
- approval from prior lifecycle;
- expired decision replay.

No externally visible action may begin after any of those.

### 10.4 Publication/action idempotency

Prove:

- action keys are deterministic/cross-run stable where promised;
- duplicate delivery does not duplicate non-idempotent external effect;
- uncertain provider response does not imply success;
- retry observes authoritative state before repeating action;
- failed/uncertain publication still proceeds to observation where production intentionally requires it;
- external success without durable receipt is reconciled safely after restart.

### 10.5 Observation is authority

Prove “push/deploy response != release”.

Required cases:

- provider says succeeded, observation matches -> can settle released;
- provider says succeeded, observation mismatches -> not released;
- observation unknown/error -> not released;
- current candidate hash differs -> not released;
- observation binds wrong publication hash -> fail closed.

### 10.6 Settlement

Prove:

- ReleaseRecord exists only for `released`;
- non-released outcomes expose no ReleaseRecord;
- Delivery certificate is always exact for terminal outcomes;
- release record/certificate are idempotent on replay;
- exact Development certificate and VerifiedIntegrationBundle lineage are preserved.

### 10.7 Development -> Delivery handoff

Prove exact mapping of:

```text
Development certificate schema/ref/hash
VerifiedIntegrationBundle schema/ref/hash
integratedCandidate
Delivery mode
release policy
operator authorization/deferred profile
```

### 10.8 Delivery adapter safety

Static/adapter-level proofs remain necessary for invariants not expressible only through runtime outcome:

- no default provider capable of release;
- no force push / policy bypass;
- no branch-protection bypass;
- no registry immutability bypass;
- no external action without explicit authorized configuration.

These should feed the global obligation report as Contract/static evidence, not be mislabeled CanonicalFast runtime evidence.

## 11. Global Factory Coverage Universe

After all workshop packs exist, build one catalog instead of merging ad-hoc percentages.

Recommended new file:

```text
tests/factory-proof/factory-coverage-catalog.mjs
```

Each coverage item should carry metadata:

```js
{
  id: 'transition:define-product-contract->model-use-cases',
  family: 'transition',
  scope: 'formalization',
  priority: 'P0',
  mechanism: 'reviewed-cell',
  owner: 'workshop',
  proofModesRequired: ['Durable', 'CanonicalFast'],
}
```

Do not infer reporting categories from string parsing alone. Keep token ID open-ended, but give every required global item explicit reporting metadata.

### 11.1 Global universe composition

Define:

```text
U_factory =
    U_local_obligations
  ∪ U_local_transitions
  ∪ U_negative_transitions
  ∪ U_inter_workshop_handoffs
  ∪ U_generic_factory_invariants
  ∪ U_fault_recovery_dimensions
  ∪ U_mutation_obligations
```

#### Local obligations

From independent AcceptanceObligationContracts and workshop-specific invariants.

#### Local transitions

Every declared production flow edge that is constructible without internal kernel corruption.

#### Negative transitions

Examples:

- Gate repair must not advance to accepted successor;
- human-required must not perform external effect;
- failed author/reviewer product must not settle;
- stale execution must not publish;
- unresolved fan-out must not fan-in.

#### Inter-workshop handoffs

At minimum:

```text
Discovery -> Formalization
Formalization -> Development
Development -> Delivery
```

Also include terminal lifecycle routes:

- Formalization inconsistent stops;
- Development blocked stops;
- Delivery terminal outcomes stop with correct lifecycle status.

#### Generic Factory invariants

At minimum:

```text
authority conservation
exact CandidateSet binding
accepted-head exactness
stale-fence refusal
one execution / one active ownership
post-completion tool refusal
duplicate/redrive idempotency
no recency substitution
same Workplace across repair
review subject exactness
final acceptance after required effects only
progress classification / no anonymous stall
restart identity isolation
cross-lifecycle isolation
projection consistency
```

#### Fault/recovery dimensions

Use named classes rather than multiplying every boundary by every workshop:

```text
worker crash
host restart
lease/fence loss
duplicate command
late command
feedback absent/stale/corrupt
recovery exhaustion
effect uncertain-after-external-success
transition redrive
projection rebuild
```

#### Mutation obligations

Every P0 AcceptanceObligationContract must have at least one killed mutant family.

## 12. Global coverage report semantics

Recommended new aggregator:

```text
tests/factory-proof/factory-coverage-report.mjs
```

Input:

- workshop scenario definitions;
- PASS EvidenceBundles;
- global coverage catalog;
- mutation kill matrices;
- installed-protection equality result.

Output example:

```text
Factory Conformance Coverage

Discovery             100%
Formalization          96%
Development            91%
Delivery               94%

Inter-workshop gates  100%
Transition coverage    97%
Negative transitions   89%
Recovery coverage      84%
Mutation kill rate     95%

P0 uncovered: 0
P1 uncovered: 7
Surviving mutants: 3
Platform fault edges awaiting K4: 5
```

### 12.1 Never use a naive average

Do not compute Factory health as:

```text
(sum of workshop percentages) / 4
```

A 99% average can hide one catastrophic stale-fence hole.

Report separate families and priorities.

### 12.2 Workshop percentage

For workshop `W`:

```text
coverage(W) = demonstrated required workshop items / total required workshop items
```

Workshop percentage excludes explicitly platform-owned K4 internal fault edges, but the report must show them separately.

### 12.3 Family percentage

Compute separately for:

- obligations;
- transitions;
- negative transitions;
- handoffs;
- recovery;
- fault boundaries;
- static/contract protections.

### 12.4 Mutation kill rate

Use:

```text
killed mutants / executed required mutants
```

Also report:

- not-generated mutants;
- not-executed mutants;
- surviving mutants;
- obligations with zero mutation family.

A surviving P0 mutant is a blocking failure regardless of aggregate percentage.

### 12.5 Priority rules

Recommended:

**P0**
- authority/fence;
- exact material binding;
- effects that can mutate external state;
- lifecycle handoff identity;
- no anonymous stall;
- stale/foreign replay;
- release authorization.

**P1**
- bounded recovery variants;
- non-catastrophic negative transitions;
- secondary representation constraints.

**P2**
- diagnostic/reporting richness;
- redundant equivalent scenarios.

Global acceptance requires:

```text
P0 uncovered == 0
P0 surviving mutants == 0
```

Do not let a high aggregate percent waive this.

## 13. Global mathematical selection

The coverage matrix remains:

```text
M[i,j] = 1 if scenario Si proves required item Uj
```

Use set cover to find a minimum blocking corpus:

```text
minimize Σ xi
subject to
for every required P0 item uj:
    Σ M[i,j] * xi >= requiredMultiplicity(uj)
```

Recommended multiplicities:

- ordinary deterministic property: 1 witness;
- critical authority/fence property: 2 materially distinct topology witnesses;
- inter-workshop handoff: 1 exact boundary witness per route;
- effect/external-state property: 1 normal + 1 redrive/restart witness.

Keep the full regression corpus available. Set cover chooses the minimum blocking set; it does not delete diagnostic scenarios.

## 14. Cross-workshop universality proof

When all packs are implemented, perform an explicit universality audit.

The common kernel must remain unchanged when moving from:

```text
Discovery
  -> Formalization
  -> Development
  -> Delivery
```

Allowed workshop additions:

- scenario definitions;
- actor programs/fixtures;
- external provider fixtures;
- human adapter fixtures;
- genuinely workshop-specific independent oracles;
- coverage catalog entries.

If the common engine requires a workshop-name branch, classify that as an architectural smell and review the production abstraction before accepting it.

A particularly strong final proof is a small synthetic admitted workshop exercising one generic Production Cell without changing the engine. This belongs to K8 after the built-ins are stable.

## 15. Recommended implementation sequence

Do not start Development first.

### Wave F0 — registry cleanup and shared reporting contract

1. repair stale Discovery obligation descriptions;
2. add coverage catalog schema/validator;
3. add global report data model, but do not claim global percentages yet;
4. keep all current Discovery evidence intact.

Exit: independent registry is trustworthy enough to extend.

### Wave F1 — Formalization topology + positive spine

1. topology inventory;
2. positive handlers reused from W9;
3. five reviewed cells + two kernel nodes represented;
4. positive transition and exact handoff universe;
5. structural pack test.

Exit: Formalization happy path produces EvidenceBundle and exact Development handoff.

### Wave F2 — Formalization obligations and review/effect repair

1. five submission-validator negative families;
2. requirements-review representative repair;
3. architecture-review representative repair;
4. accept-products drift repair;
5. baseline isolation/inconsistent outcome;
6. resilience equivalence classes;
7. restart/idempotency;
8. coverage drive.

Exit: Formalization workshop closure 100% demonstrated; only named K4 internal fault edges excluded.

### Wave D0 — inspect what Formalization taught the common kernel

Before Development, review every common-kernel change made for Formalization.

If any change was workshop-specific, refactor it now.

Exit: common engine remains mechanism-based.

### Wave D1 — Development base spine

1. planner;
2. resolve graph;
3. fan-out implementation/review;
4. Git integration effect;
5. freeze candidate;
6. readiness;
7. bind runnable candidate;
8. fan-out verification;
9. settlement;
10. Formalization -> Development and Development -> Delivery handoffs.

Exit: base happy path proven.

### Wave D2 — Development protection families

1. task graph;
2. implementation scope;
3. claim monotonicity;
4. review verdict;
5. readiness monotonicity;
6. local runnability;
7. verification product;
8. exact lineage.

Exit: every Development protection has a detector witness and mutation family.

### Wave D3 — Development topology/fault closure

1. fan-out/fan-in properties;
2. dependency ordering/concurrency;
3. crash/fence per execution-mode class;
4. Git effect crash/idempotency;
5. candidate drift;
6. verification failure ownership;
7. restart/redrive.

Exit: base Development workshop closure 100% demonstrated.

### Wave D4 — continuation/replan variants

1. managed continuation;
2. re-plan continuation;
3. verification continuation;
4. supersede/adoption properties;
5. fresh authority/version isolation.

Exit: installed Development family closure complete.

### Wave L1 — Delivery deterministic/human/external pack

1. deferred/approval-required;
2. authorized release;
3. denial/blocked;
4. provider failure;
5. publication uncertainty;
6. authoritative observation mismatch;
7. exact ReleaseRecord/certificate;
8. duplicate/restart/idempotency;
9. Development -> Delivery exact handoff.

Exit: Delivery workshop closure 100% demonstrated.

### Wave G1 — global Factory universe

1. union workshop catalogs;
2. add generic Factory invariants;
3. add inter-workshop transitions;
4. add generic fault dimensions;
5. deduplicate equivalent physics;
6. assign P0/P1/P2;
7. assert every required item has planned coverage or explicit platform owner.

### Wave G2 — mutation integration

1. run obligation mutation families;
2. associate each kill matrix with global obligation id;
3. compute kill rate;
4. fail on surviving P0 mutant;
5. include surviving mutant diagnostics in final report.

### Wave G3 — final report and minimum blocking corpus

1. build demonstrated matrix from PASS EvidenceBundles;
2. compute workshop/family percentages;
3. solve set cover for minimum blocking corpus;
4. print uncovered items grouped by owner/family/priority;
5. print platform K4 debt separately;
6. only after repeated green, register the stable subset in `factory-proof` blocking matrix.

## 16. Expected final report

The exact numbers are not targets; truth is the target.

Example:

```text
Factory Conformance Coverage
============================

Workshop coverage
-----------------
Discovery             100.00%   54/54
Formalization          96.43%   81/84
Development            91.20%  114/125
Delivery               94.12%   48/51

Cross-workshop
--------------
Exact handoffs         100.00%    3/3
Lifecycle routes        96.00%   24/25

Factory physics
---------------
Transition coverage     97.10%
Negative transitions    89.30%
Authority/fence         100.00%
Recovery                 84.00%
Restart/redrive          92.00%
Effect idempotency       90.00%
Progress/no-stall       100.00%

Mutation
--------
Killed                  95.00%
Surviving P0             0
Surviving P1             3
Not generated            0

Blocking rule
-------------
P0 uncovered             0
P0 surviving mutants     0
Anonymous stalls         0
Unclassified protections 0

Platform K4 debt
----------------
- formalization settlement internal exception
- delivery crash after external effect before receipt
...

Uncovered obligations
---------------------
[P1][Development][recovery] ...
[P1][Formalization][transition] ...
...
```

Do not round away small but important gaps. Always print numerator/denominator and uncovered IDs.

## 17. Commit discipline

Keep changes reviewable and reversible.

Recommended commit shape:

```text
1. docs/test: topology + obligation inventory
2. feat(proof): workshop positive scenario pack
3. test(proof): pin planned workshop coverage
4. feat(proof): workshop causal negative/repair scenarios
5. feat(proof): workshop resilience equivalence classes
6. feat(proof): workshop coverage drive
7. feat(proof): exact lifecycle handoff
8. docs(handoff): local checkpoint
```

Production fixes discovered by scenarios should be separate commits from test-pack expansion.

Do not combine unrelated production bug fixes with global report refactoring.

## 18. Local validation cadence

For each workshop:

1. build;
2. structural pack tests;
3. one happy scenario;
4. one negative detector scenario;
5. one exact-feedback repair scenario;
6. one crash/fence scenario;
7. workshop coverage drive;
8. repeat to detect flakes;
9. only then promote to blocking.

Development should be validated in smaller groups because fan-out/Git/restart tests are materially heavier.

Delivery should explicitly validate external-world journals and authoritative observation, not only Factory DB state.

## 19. Stop conditions

Stop and classify before continuing if any of these appears:

- test needs direct authority-table write;
- scenario needs production reducer knowledge to decide next step;
- a workshop-name branch is proposed in common kernel;
- observer must infer expected state instead of reading fact;
- repair only works because actor knows attempt number;
- same semantic input changes authority without a declared reason;
- stale execution can still publish;
- effect can repeat externally without observation/idempotency protection;
- fan-out sibling material leaks between Workplaces;
- next lifecycle stage receives a “latest” product rather than exact upstream output;
- high aggregate coverage hides a P0 uncovered item.

These are architecture findings, not inconveniences to code around.

## 20. Definition of done for this program

This workstream is complete when:

1. Discovery, Formalization, Development (including installed continuation variants), and Delivery all use the same proof kernel;
2. no common-kernel branch depends on workshop name;
3. every installed protection has exactly one independent normative owner;
4. every P0 obligation has a real causal scenario and killed mutant witness;
5. all workshop-owned required coverage is demonstrated by PASS evidence;
6. all three inter-workshop handoffs are exact and demonstrated;
7. generic Factory authority/fence/recovery/idempotency properties are covered across materially distinct mechanism classes;
8. platform-only internal fault edges are assigned to the common K4 scheduler rather than hidden;
9. final report shows workshop, transition, negative-transition, recovery, handoff, and mutation coverage separately;
10. `P0 uncovered == 0`, `P0 surviving mutants == 0`, `anonymous stalls == 0`;
11. a minimum blocking corpus can be selected mathematically from the full regression corpus;
12. the built-in workshops demonstrate universality without changing the engine.

At that point the Factory has moved from “a large suite of tests” to a measurable conformance system for one universal production kernel.
