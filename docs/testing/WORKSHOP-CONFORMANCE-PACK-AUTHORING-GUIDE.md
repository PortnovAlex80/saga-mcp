# Workshop Conformance Pack Authoring Guide

- Status: execution guide / agent handoff
- Date: 2026-08-21
- Branch baseline when written: `w0-waves`
- Architectural authority: ADR-084 and accepted Factory ADRs
- Scope: Formalization, Development, Delivery, future Process Modules, and the final global Factory coverage report

## 1. Mission

This guide tells the next implementation agent how to extend the unified Saga conformance kernel from the completed Discovery vertical slice to every remaining built-in workshop and then build one global Factory coverage universe.

The target is not "more tests". The target is a mathematically auditable proof surface over the production Factory:

```text
workshop/lifecycle declarations
  + independent AcceptanceObligationContracts
  + deterministic actor/human/external-world fixtures
  + declarative scenarios
  + bounded fault schedule
                         |
                         v
                REAL Factory runtime
                         |
                         v
              read-only durable trace
                         |
                         v
                 independent oracles
                         |
                         v
              ScenarioEvidenceBundles
                         |
                         v
                 coverage matrices
                         |
                         v
          global Factory conformance report
```

A workshop is NOT conformant because its tests are green. It is conformant when every required item in its declared coverage universe has demonstrated PASS evidence and every applicable mutation family is killed by its assigned production protection.

The final deliverable must make statements of this form possible:

```text
Factory Conformance Coverage

Discovery             96%
Formalization         91%
Development           88%
Delivery              93%

Inter-workshop gates  100%
Transition coverage   97%
Negative transitions  89%
Recovery coverage     84%
Mutation kill rate    95%

Uncovered obligations:
  ...
```

Do not invent these percentages. They are computed only from declared universes and PASS evidence bundles.

## 2. The architectural insight: a Factory workshop is not synonymous with an LLM workshop

The current built-ins already exercise the major execution kinds of the Factory:

1. Discovery: simple cognitive Production Cells plus deterministic settlement.
2. Formalization: reviewed cognitive Production Cells, author Gate, reviewer Gate, repair, post-acceptance effects, deterministic baseline freeze and settlement.
3. Development: graph planning, fan-out/fan-in Workplaces, dependency scheduling, reviewed implementation Cells, Git effects, candidate freeze, runnability certification, verification fan-out, continuation and re-plan variants.
4. Delivery: no LLM Production Cell at all in the standard flow; it is kernel + human interaction + external-effect providers + authoritative observation + settlement.

Therefore the universal test rule is NOT "replace the LLM".

The universal rule is:

> Replace only the nondeterministic outside participant. Preserve every production authority transition.

Depending on node kind:

```text
Production Cell with LM worker
  -> replace cognition only with scripted actor

Human node
  -> replace human decision source only with deterministic human-adapter fixture

External effect / external observation
  -> replace the external world only with an explicit deterministic provider fixture

Kernel node
  -> replace nothing
```

Never replace the dispatcher, Workplace reducer, WorkerExecution fence, CandidateSet, Gate, GateDecision, Recovery planner, effect ledger, final acceptance, lifecycle router, process settlement, or persistence authority.

## 3. Required reading before implementation

Read in this order:

1. `AGENTS.md`
2. `GUARDRAILS.md`
3. `docs/architecture/CONVEYOR-MENTAL-MODEL.md`
4. `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`
5. `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
6. `docs/architecture/decisions/081-authority-commit-proof-contract.md`
7. `docs/architecture/decisions/084-causal-conformance-proof-kernel.md`
8. `docs/testing/GRAPH-TEST-STRATEGY.md`
9. `docs/testing/CAUSAL-PROOF-IMPLEMENTATION-BRIEFS.md`
10. `docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md`
11. `tests/factory-proof/MIGRATION-MAP.md`
12. `docs/handoff/2026-08-21-discovery-closure-resilience.md`

Then read the actual ProcessModule definition, its CheckProviders, kernel handlers, effects and lifecycle mappings. Documentation is a guide; installed code and accepted ADRs define the current implementation surface.

## 4. Existing proof-kernel assets: reuse, do not fork

The following files are the current common kernel and must remain single-source:

```text
tests/factory-proof/canonical-proof-composition.mjs
tests/factory-proof/scenario-dsl.mjs
tests/factory-proof/scenario-runner.mjs
tests/factory-proof/scenario-evidence.mjs
tests/factory-proof/trace-observer.mjs
tests/factory-proof/coverage-kernel.mjs
tests/factory-proof/obligation-contracts.mjs
tests/factory-proof/mutation-algebra.mjs
tests/factory-proof/installed-protection-reader.mjs
```

Discovery is the first authoring example:

```text
tests/factory-proof/discovery-scenario-pack.mjs
tests/factory-proof/discovery-resilience-pack.mjs
tests/factory-proof/discovery-scenario-drive.mjs
tests/factory-proof/discovery-coverage-drive.mjs
tests/factory-proof/discovery-restart-proof.mjs
tests/factory-proof/discovery-retry-exhaustion-proof.mjs
```

Use Discovery for patterns, not as a template to copy literally. Formalization, Development and Delivery have different execution topologies.

## 5. Non-negotiable rules for every new pack

### 5.1 No second Factory

A scenario pack may contain:

- declarative scenario definitions;
- valid fixtures;
- invalid/mutated actor outputs;
- deterministic actor programs;
- deterministic human decisions;
- deterministic external-provider behavior;
- independent oracles;
- coverage tokens;
- journals used only as test evidence.

A scenario pack may NOT contain:

- a reducer;
- a retry algorithm;
- a Gate emulator;
- a lifecycle route function that duplicates production routing;
- direct writes to authority tables;
- a "fix state" helper;
- a fake CandidateSet or GateDecision writer;
- recency-based reconstruction of accepted material.

If a test requires any of those to pass, either the test is wrong or production has an architectural defect.

### 5.2 Expected truth is independent from production validators

Do not generate expected obligations solely from the CheckPlan or validator implementation being tested.

The strict proof reconciles three different sources:

```text
1. AcceptanceObligationContracts        normative expectation
2. installed production protections    actual configured protection
3. durable/external evidence            observed behavior
```

A deleted Gate or missing provider must make set equality or the mutation kill matrix red.

### 5.3 Demonstrated coverage is PASS-only

A declared scenario contributes to planned coverage.

A ScenarioEvidenceBundle contributes to demonstrated coverage only when:

```text
bundle.verdict === "pass"
```

Failed, inconclusive, timed-out, malformed, or missing evidence contributes zero demonstrated coverage.

### 5.4 Semantic model quality is out of scope

Kernel conformance does not judge whether the LLM wrote a clever PRD, good architecture, elegant code or wise business recommendation.

Kernel conformance tests deterministic properties such as:

- exact refs/hashes;
- schema and cardinality;
- lineage;
- Gate behavior;
- repair ownership;
- feedback causality;
- fences;
- idempotency;
- retries;
- effects;
- routing;
- progress and bounded failure.

Semantic quality belongs to real-model evals/canaries.

## 6. Universal workshop authoring algorithm

Apply these steps to ANY ProcessModule, whether it contains LLM workers, human nodes, kernel nodes, external effects, or a mixture.

### Step 0 - Freeze the baseline

Before writing scenarios:

1. record branch/commit;
2. record moduleRef/version;
3. record lifecycle identity/version;
4. record installed CheckProviders/effects/human adapters;
5. record current independent AcceptanceObligationContracts;
6. identify known metadata drift in the obligation registry before trusting it.

Do not silently "correct" expected truth from production declarations. If the independent registry is stale, update it explicitly and explain why.

Known current debt: the two Discovery descriptions in `obligation-contracts.mjs` still describe old payload fields (`outcome`, `fileDeclarations`) rather than current `recommended_outcome` / Readiness v2. Clean this before declaring the global registry authoritative.

### Step 1 - Reconstruct topology from the ProcessModule

Build a machine-readable topology inventory with, for every node:

```text
nodeId
kind = production-cell | kernel | human
input schema
output schema
cellId if applicable
author profile
reviewer profile if applicable
author Gate / CheckPlan
final Gate / CheckPlan
recovery policy
post-acceptance effect
outgoing transitions by event
terminal outcomes
```

For every lifecycle stage also record:

```text
stageId
moduleRef
inputMapping
outputMapping
outcomeRoutes
entry/exit conditions
```

The topology inventory is discovery data for test planning, not an oracle of correctness.

### Step 2 - Partition the coverage universe by authority boundary

For one workshop W define:

```text
U_W = U_contract
    ∪ U_gate
    ∪ U_transition
    ∪ U_negative_transition
    ∪ U_review
    ∪ U_recovery
    ∪ U_fence_idempotency
    ∪ U_effect
    ∪ U_kernel
    ∪ U_handoff
    ∪ U_restart
```

Only include applicable families. Delivery, for example, has no LM review universe but has a large human/external-effect universe.

### Step 3 - Enumerate local deterministic obligations

Start from independent AcceptanceObligationContracts and workshop invariants.

For each obligation record:

```text
obligation ID
subject
valid witness
violated relation
expected authorized detector
expected causal owner
allowed terminal kinds
fault class
mutation family
```

Do not write one full Factory scenario for every field mutation. Mechanical field variants belong to mutation algebra. Full causal scenarios represent distinct causal equivalence classes.

### Step 4 - Define causal equivalence classes

Full Factory scenarios should be minimized by causal signature:

```text
{detector, reason class, repair owner, repair frontier, terminal class}
```

If ten malformed fields all fail at the same provider, generate ten mutants for the kill matrix but normally run one representative full repair scenario.

If two failures differ in owner or frontier, they are NOT equivalent and need separate causal scenarios.

### Step 5 - Build the positive spine first

One scenario must traverse the normal workshop spine and prove:

- exact input adoption;
- every mandatory local accepted transition;
- exact immutable accepted material;
- required effects;
- local settlement/certificate;
- exact lifecycle handoff or terminal route.

Do not continue until this produces one coherent ScenarioEvidenceBundle.

### Step 6 - Add Gate negative cases

For every independently important protection:

```text
valid upstream material
  -> inject one violating worker/provider/human output
  -> REAL production detector
  -> REAL CheckReceipt / GateDecision / typed failure
  -> forbidden downstream transition must not occur
```

### Step 7 - Add repair causality and counterfactuals

For each distinct repair causal class run:

```text
exact feedback     -> repair may converge
absent feedback    -> must not magically converge the same way
stale feedback     -> must not magically converge the same way
corrupted feedback -> must not magically converge the same way
```

Actors may branch only on production-visible inputs. They may not read scenario ID, raw attempt count, hidden DB state or expected outcome.

### Step 8 - Bind the generic Factory-physics corpus

Every Production Cell family should consume applicable generic proofs instead of reimplementing them:

- worker crash;
- retry exhaustion / recovery epoch;
- duplicate submit/redrive;
- post-completion call refusal;
- stale execution fence;
- restart/replay;
- CandidateSet exactness;
- foreign/stale subject refusal;
- no stranded execution;
- no anonymous stall;
- reviewer stale-author-set rejection if review exists;
- effect idempotency if an effect exists.

Do not multiply every generic axis by every Cell if the mechanics are structurally identical and ADR-084 equivalence permits representative coverage. But every actual Gate/transition/obligation still needs demonstrated coverage. Use covering arrays/pairwise assignment to distribute generic resilience axes across structurally equivalent Cells.

### Step 9 - Cover kernel nodes separately

Kernel nodes are not tested by scripted cognition.

For each kernel node enumerate:

```text
valid exact input -> expected event
invalid/missing/stale input -> typed failed/inconsistent/blocked event
replay -> identical content-addressed result
cross-run foreign material -> rejected where applicable
```

If reaching an internal kernel exception requires arbitrary authority corruption, classify it as a K4 platform fault edge instead of writing DB hacks inside the workshop pack.

### Step 10 - Prove exact inter-workshop handoff

For every routable stage boundary compare the upstream StageRun mapped output with the downstream StageRun input snapshot.

At minimum verify:

- outcome;
- certificate schema/ref/hash;
- output product schema/ref/hash;
- payload fields explicitly mapped by lifecycle;
- immutable semantic bindings such as baseline/candidate/policy hash.

The lifecycle owns routing. A workshop scenario must never route manually.

### Step 11 - Produce planned and demonstrated coverage

For a scenario corpus S and obligation universe U construct:

```text
M[i,j] = 1 if scenario S_j covers obligation U_i
```

Planned matrix comes from declarations.

Demonstrated matrix comes only from PASS EvidenceBundles.

Use the existing `coverage-kernel.mjs` set-cover implementation to report a minimal proving corpus. For small corpora it computes exact branch-and-bound set cover; larger corpora use deterministic greedy selection.

### Step 12 - Mutation kill matrix

Use `mutation-algebra.mjs` for structural and relational mutants.

The metric is:

```text
mutationKillRate = killedApplicableMutants / totalApplicableMutants
```

A mutant counts as killed only when the assigned production boundary rejects it with a typed rejection or throws at the authorized intake/protection boundary.

An accepted mutant is a blocking conformance failure.

### Step 13 - Closure rule

A workshop may be marked closed only when:

```text
planned required workshop universe = 100%
demonstrated required workshop universe = 100%
all mandatory scenarios emitted PASS evidence
independent registry == installed expected protection set
all applicable mandatory mutants are killed
platform-owned K4 gaps are listed separately, not hidden
```

Do not redefine the universe after seeing a red result merely to obtain 100%.

## 7. How to keep the scenario count finite

The raw Cartesian product is forbidden:

```text
Cells × Gates × faults × feedback variants × restarts × tools × outcomes
```

Use hierarchical coverage.

### Layer A - every unique local semantic/mechanical protection

Every obligation and every actual transition gets coverage.

### Layer B - one representative per Factory-physics equivalence class

Example: if five Formalization reviewed Cells use the same universal reviewer mechanics, do not run every crash/fence/counterfactual combination five times. Assign those axes across Cells using pairwise/covering-array selection while still exercising each Cell's own Gate and transitions.

### Layer C - mutation algebra

Field-level and relation-level variations are cheap mutants, not full lifecycle scenarios.

### Layer D - K4 named durable boundaries

Crash-before/crash-after at universal durable boundaries belongs to the common FaultSchedule layer. Do not reproduce that scheduler per workshop.

This yields strong coverage without combinatorial explosion.

## 8. Formalization blueprint

### 8.1 Current topology

Formalization is substantially more complex than Discovery.

Current standard flow:

```text
define-product-contract          reviewed Production Cell
  -> model-use-cases             reviewed Production Cell
  -> define-acceptance-contract  reviewed Production Cell
  -> reconcile-what              reviewed Production Cell
  -> freeze-acceptance-baseline  kernel
  -> define-architecture-contract reviewed Production Cell
  -> settle-formalization        kernel
  -> complete-formalized | complete-inconsistent | complete-failed
```

There are FIVE reviewed cognitive Cells. Each reviewed Cell currently has:

```text
author
 -> author CandidateSet
 -> author Gate / workshop CheckProvider
 -> reviewer
 -> reviewer CandidateSet
 -> final review-verdict Gate
 -> post-acceptance effect: formalization.accept-exact-products.v1
 -> recovery maxAttempts = 5, onExhausted = requeue
```

The two kernel nodes are important authority boundaries:

1. `freeze-acceptance-baseline` freezes exact accepted AC ids/hashes and lifecycle scope before HOW/SRS work.
2. `settle-formalization` reads the accepted graph + frozen baseline, emits `formalized|inconsistent|failed`, persists Solution Contract on `formalized`, and issues the process certificate.

### 8.2 Independent obligations already present

At minimum include the existing Formalization obligation families from `obligation-contracts.mjs`:

```text
frm.submission.product-contract
frm.submission.use-cases
frm.submission.acceptance-contract
frm.submission.reconciliation
frm.submission.srs-contract
effect.formalization-accept-products
```

Before implementation reconcile these contracts against current provider versions and actual payload schemas. Do not assume the registry is current merely because provider IDs match.

### 8.3 Required Formalization scenario families

#### Positive spine

Prove:

```text
Discovery exact handoff
 -> Product bundle accepted + reviewed
 -> UC bundle accepted + reviewed
 -> AC bundle accepted + reviewed
 -> reconciliation accepted + reviewed
 -> baseline frozen
 -> architecture/SRS accepted + reviewed
 -> settlement formalized
 -> exact Solution Contract/certificate
 -> exact Formalization -> Development handoff
```

#### Product-contract negative classes

At least:

- broken brief/PRD/FR lineage;
- foreign/stale root ref;
- valid author product + reviewer reject + author repair;
- reviewer invalid verdict.

#### Use-case negative classes

At least:

- UC derives from foreign/non-accepted PRD/FR;
- missing required coverage;
- reviewer repair representative if causal signature differs.

#### Acceptance-contract negative classes

At least:

- missing AC;
- duplicate criterion code;
- malformed AC heading grammar;
- missing/foreign trace to FR/NFR/UC;
- constraint register uncovered without waiver;
- hash/container drift where the current architecture makes that distinction load-bearing.

Mechanical permutations belong to mutation algebra.

#### Reconciliation negative classes

At least:

- report silently omits an uncovered constraint;
- report claims repaired material not represented by durable graph;
- no-op reconciliation accepted when truly no changes are required;
- exact feedback repair versus absent/stale/corrupt feedback.

#### Baseline kernel

Must prove:

```text
no accepted AC -> failed
clean accepted AC set -> frozen
accepted hash drift -> inconsistent/drift-detected
baseline binds current LifecycleRun only
cross-run accepted material cannot enter baseline
replay freezes identical semantic baseline
architecture starts only after baseline freeze
```

The lifecycle-scope property is critical because the current implementation explicitly looks up the owning lifecycle run before baseline construction.

#### Architecture/SRS negative classes

At least:

- D2 stanza references AC outside frozen baseline;
- duplicate stanza AC code;
- invalid `ac_kind`;
- missing decomposition for required implementation AC;
- foreign/stale baseline binding;
- reviewer reject/repair;
- exact accepted SRS cannot mutate the frozen AC artifacts.

#### Settlement

Prove both public decisions:

```text
formalized
inconsistent
```

And classify internal `failed` paths that require kernel-only injection as K4 platform fault edges if they cannot be reached through lawful workshop inputs.

### 8.4 Formalization coverage optimization

Do not run all resilience axes on all five reviewed Cells.

A recommended covering assignment is:

```text
Product Contract: crash + stale fence
Use Cases: duplicate submit + late call
Acceptance Contract: exact/absent/stale/corrupt feedback
Reconciliation: restart/replay + reviewer repair
Architecture: retry exhaustion + reviewer invalid output
```

This is only a starting allocation. The final assignment should be generated from the required universe so every generic axis and every unique Cell transition is covered with minimum scenario count.

### 8.5 Formalization exit gate

Do not begin Development pack implementation until the Formalization report can state:

```text
local obligations              100% demonstrated
all 5 author Gates             accepted + negative covered
all applicable final Gates     accepted + negative covered
baseline freeze transitions    covered
formalized/inconsistent paths  covered
Discovery -> Formalization     exact
Formalization -> Development   exact
review repair causality        covered by causal equivalence classes
mutation mandatory families    killed
```

## 9. Development blueprint

Development is the hardest workshop. Do not start by writing scenarios. First reconstruct its state/authority topology.

### 9.1 Base flow

The current standard module includes at least these major boundaries:

```text
plan-task-graph                 Production Cell
 -> resolve-task-graph          kernel
 -> implement-work-items        fan-out reviewed Production Cell
 -> freeze-integrated-candidate kernel
 -> certify-product-readiness   Production Cell
 -> bind-runnable-candidate     kernel
 -> verify-acceptance           fan-out Production Cell
 -> settle-development          kernel
 -> verified | blocked | failed
```

The implementation Cell is not singleton. It materializes work items from the resolved task graph, respects dependency keys, uses completionPolicy=`all`, carries AC provenance, runs author + reviewer Gates, and invokes Factory-owned `git-integration` after final acceptance.

The verification Cell also fans out over verificationItems and the exact bound candidate.

### 9.2 Development is a family of modules, not one flow only

The closure plan must include the versioned continuation surfaces:

```text
solution-development-managed@1.1.0
solution-development-managed@1.2.0 re-plan continuation
verification continuation module where applicable
```

The managed continuation changes the implementation material model to textual `SourceChangeCandidate` and removes worker Git mutation authority. The re-plan variant inserts an LM planner before the resolver and must supersede remaining cycle-1 work deterministically.

Do not pretend the base module alone represents Development conformance.

### 9.3 Development coverage layers

Build Development in explicit layers.

#### D0 - Formalization -> Development exact handoff

Verify exact:

- Formalization certificate schema/ref/hash and `formalized` decision;
- Solution Contract schema/ref/hash;
- acceptanceBaselineHash;
- SRS projection;
- acceptanceCriteria;
- repository bindings;
- development policy hash.

#### D1 - Task graph planning and freeze

Prove:

- at least one work item;
- unique keys;
- all dependency refs exist;
- DAG semantics/no illegal cycles if required by provider;
- AC coverage and exact lineage;
- invalid graph rejected before materialization;
- exact accepted proposal canonicalizes to one deterministic task graph;
- resolver replay is idempotent.

Use `dev.task-graph` and related obligation contracts/mutants.

#### D2 - Fan-out and scheduler physics

This is a new dimension not present in Discovery/Formalization singleton Cells.

Prove with a small graph fixture containing at least:

```text
A and B independent
C depends on A
D depends on A+B
```

Then verify:

- independent items may be runnable concurrently within configured cap;
- dependent work cannot become claimable before prerequisites;
- completionPolicy=`all` prevents fan-in transition while one item is unresolved;
- each workKey has a distinct Workplace;
- per-Workplace material/desk/fence isolation;
- no item receives another item's accepted material by recency;
- crash/retry of A does not reset B;
- accepted B remains conserved while A repairs.

#### D3 - Implementation author Gate

Unique protections include at least:

```text
dev.impl-scope
dev.impl-claim-monotonicity
payload contract / exact implementation product
```

Required negatives:

- file outside effective scope;
- silent narrowing of previously claimed files;
- dropped file without explicit disposition;
- stale/foreign source or base identity;
- different second submission under same execution;
- worker tries to perform an authority operation reserved for Factory effect.

#### D4 - Implementation review and Git effect

Prove:

- reviewer pins exact accepted author CandidateSet;
- reviewer cannot approve foreign/stale author material;
- changes_requested returns to same logical Workplace author frontier;
- exact review feedback causes repair;
- absent/stale/corrupted review feedback does not cause equivalent repair;
- Git integration occurs only after final acceptance;
- worker has no merge authority;
- effect receipt binds exact candidate/workplace/decision;
- effect redrive is idempotent;
- external success before receipt persistence is handled by K4 observe/redrive semantics, not blind duplicate integration.

#### D5 - Freeze integrated candidate

Prove:

- all required accepted implementation results integrated before freeze;
- frozen source identity is content-addressed;
- unrelated later commit/worker cannot change frozen candidate;
- missing/failed integration routes through settlement/failure path;
- replay returns same candidate identity.

#### D6 - Readiness certification

This Cell has a multi-provider CheckPlan and upstream-failure semantics.

Unique protections include:

```text
dev.readiness-monotonicity
factory.local-runnability
```

Prove:

- valid readiness manifest binds exact frozen source;
- narrowed/changed readiness declaration escalates rather than silently passing;
- runnability subject is frozen integrated candidate, not the certifier's own product;
- deterministic runnability failure is owned by upstream producer where configured;
- certifier cannot repair the source merely by rewriting the manifest;
- human_required/blocked path is covered where policy declares it.

#### D7 - Bind runnable candidate

Kernel proof:

- exact readiness evidence + exact frozen source -> bound candidate;
- stale readiness hash or foreign candidate -> failed;
- binding is replay-idempotent.

#### D8 - Acceptance verification fan-out

Prove:

- verification materializes against exact candidate + verification work item;
- each evidence product binds exact candidate hash;
- foreign/stale candidate evidence rejected;
- all required verification items must settle before fan-in;
- upstream-owned failed verification reaches Development settlement rather than infinite verifier repair;
- crash of one verifier does not corrupt already accepted sibling verification.

#### D9 - Settlement

Prove public terminal classes:

```text
verified
blocked
failed
```

and exact Development certificate/verified bundle identity.

#### D10 - Continuation and re-plan

This is mandatory Development conformance, not optional regression decoration.

Prove:

- accepted prefix is conserved;
- continuation starts from exact certified failure evidence;
- old/superseded tasks become dispatch-ineligible;
- new continuation Workplaces have fresh authority identity;
- managed source author has no Bash/Git mutation capability if the profile forbids it;
- Factory materializes/integrates textual SourceChangeCandidate;
- cycle-2 re-plan sees the whole accepted integrated cycle-1 reality;
- re-plan graph is valid and non-empty;
- remaining cycle-1 work is drained/superseded before new graph dispatch;
- restart/replay cannot resurrect superseded work.

### 9.4 Development fixture philosophy

Use one intentionally tiny runnable repository, e.g. a Hello World/static fixture, with deterministic tests/start command. The goal is Factory mechanics, not application quality.

The fixture should be large enough to express:

- 2-4 work items;
- independent/dependent scopes;
- one allowed file mutation;
- one out-of-scope mutation;
- one dropped-file disposition;
- deterministic Git integration;
- deterministic test/runnability evidence.

Keep application code trivial.

## 10. Delivery blueprint

Delivery is the proof that the Factory abstraction is broader than LLM orchestration.

### 10.1 Current topology

```text
preflight-release   kernel
 -> approve-release human
 -> publish-deploy  kernel + explicit external provider
 -> observe-release kernel + authoritative observation provider
 -> settle-delivery kernel
 -> released | approval-required | blocked | failed
```

There are no standard LM execution profiles in the Delivery module.

### 10.2 Critical prerequisite before Delivery scenarios

Current `canonical-proof-composition.mjs` fingerprints the installed lifecycle using `productBuildLifecycle`, which deliberately excludes Delivery. Delivery lives in `product-delivery`.

Before claiming Delivery canonical proof, generalize canonical lifecycle identity so the proof fingerprint is derived from the lifecycle actually selected/driven by the bootstrap/launch, not hard-coded `productBuildLifecycle`.

Requirements for this refactor:

```text
- Product Build proofs keep their current honest identity.
- Product Delivery proofs fingerprint the Delivery stage too.
- Scenario evidence states exact lifecycle name/version/stage list.
- No test chooses a different lifecycle only to make a scenario pass.
```

Do this once in the generic kernel. Do not add a Delivery-specific fingerprint bypass.

### 10.3 Delivery substitutes external participants, not kernel logic

The deterministic test seam is:

```text
human approval adapter
preflight external evidence providers
publication/deployment providers
observation providers
```

The production Delivery handlers, external-effect ledger, deterministic action keys, process products, settlement policy, certificates and lifecycle routing remain real.

### 10.4 Required Delivery scenarios

#### Deferred profile

Prove the ordinary start-from-idea/deferred release behavior:

- no externally visible action;
- typed approval-required/blocked outcome according to current policy;
- no publication provider invocation.

#### Authorized, approval not required

If policy supports `not-required`, prove the direct lawful path into publication.

#### Authorized, approval required/pending

Prove:

- exact preflight built first;
- human node pauses/returns approval-required when no decision exists;
- no release effect begins while pending.

#### Approved

Prove approval binds exactly:

```text
candidate hash
preflight hash
release-policy hash
```

A stale approval from another candidate/policy must not float forward.

#### Denied / expired

Prove deterministic typed route to blocked/approval-required without publication.

#### Preflight blocked / failed

Prove provider evidence and policy route to settlement without human/effect paths that should not run.

#### Publication success

For each required action prove:

- deterministic actionKey;
- explicit provider binding;
- no fallback provider;
- one durable external-effect action record;
- success response alone does NOT establish release.

#### Publication failed/unknown

Prove transition still reaches authoritative observation where declared. Do not blindly repeat the external action.

#### Observation

Prove:

- authoritative observation binds publication hash and candidate hash;
- currentCandidateHash must still equal certified candidate;
- unknown/error/missing required destination prevents released settlement;
- matched desired state can settle released.

#### Observe-before-retry

This is a primary Delivery theorem:

```text
external call may have happened
receipt persistence uncertain
restart/redrive
 -> observe current target state
 -> only re-act when production policy authorizes it
```

A duplicate non-idempotent release effect is a blocking failure.

#### Candidate immutability

Any candidate identity drift after Development certification must block Delivery and require fresh Development verification.

#### Restart boundaries

Delivery is the best initial consumer of K4 fault boundaries around external effects:

```text
after effect provider / before durable receipt
after receipt / before source transition
after observation / before settlement
after settlement / before lifecycle routing
```

Implement these through the common FaultSchedule layer, never Delivery-only DB mutation.

## 11. Global Factory coverage universe

After all workshop packs exist, build a single canonical universe.

Define:

```text
U_FACTORY =
    U_local_obligations
  ∪ U_inter_desk_transitions
  ∪ U_inter_workshop_transitions
  ∪ U_generic_factory_invariants
  ∪ U_fault_recovery_dimensions
  ∪ U_mutation_obligations
```

### 11.1 Local obligations

Namespace by workshop and stable logical protection, e.g.:

```text
obligation:frm.submission.acceptance-contract
obligation:dev.impl-scope
obligation:factory.local-runnability
```

One logical obligation appears once globally even if several scenarios prove it.

### 11.2 Inter-desk transitions

Every declared ProcessModule edge is an obligation:

```text
transition:<module>:<from>-><to>:<event>
```

Also include negative-transition obligations where a rejected/failed state must NOT advance to the normal successor.

For Production Cells distinguish:

```text
author accepted -> reviewer or next node
author repair_required -/-> next node
review accepted -> next node
review repair_required -> author/reviewer repair frontier
human_required -> declared blocked/human route
failed -> declared failed/settlement route
```

### 11.3 Inter-workshop transitions

At minimum current standard Product Delivery boundaries:

```text
Discovery -> Formalization
Formalization(formalized) -> Development
Formalization(inconsistent) -> terminal
Formalization(failed) -> terminal
Development(verified) -> Delivery in product-delivery
Development(blocked) -> terminal
Development(failed) -> terminal
Delivery outcomes -> lifecycle terminals
```

Product Build is a distinct lifecycle scenario: Development `verified` terminates as `runnable-local` and Delivery must not be assumed.

### 11.4 Generic Factory invariants

Maintain a finite global list independent of workshop names. At minimum:

```text
authority-conservation
exact-candidate-set-binding
accepted-head-exactness
recency-non-interference
one-live-execution-fence
stale-fence-refusal
post-completion-tool-refusal
duplicate-submit-idempotency
worker-done-finalization-convergence
same-workplace-repair
reviewer-subject-pinning
exact-feedback-caused-repair
absent-feedback-no-magical-repair
stale-feedback-no-magical-repair
corrupt-feedback-no-magical-repair
bounded-recovery
no-anonymous-stall
no-stranded-execution
effect-idempotency
exact-effect-receipt-binding
restart-identity-isolation
semantic-replay-idempotency
incompatible-input-no-replay
lifecycle-handoff-exactness
projection-rebuild-authority-conservation
```

Add an invariant only when it is stated independently and has an observable proof method.

### 11.5 Fault/recovery dimensions

Use named common boundaries from the conformance plan:

```text
before Product persistence
after Product / before ProductionRevision
after ProductionRevision / before CandidateSet
after CandidateSet / before CheckReceipt
after CheckReceipt / before GateDecision
after GateDecision / before feedback/effect obligation
after external effect / before durable effect receipt
after effect receipt / before source transition
after final acceptance / before lifecycle routing
after route obligation / before downstream adoption
```

For each applicable boundary the K4 scheduler eventually proves crash-before/crash-after + restart + fair drain.

Do NOT require every workshop pack to implement all these mechanics independently. Packs declare applicability; K4 owns execution.

### 11.6 Mutation universe

Mutation reporting is separate from scenario coverage.

For every applicable AcceptanceObligationContract report:

```text
total mutants
killed typed
killed throw
survived accepted
unverdictable
not applicable
```

Global mutation kill rate:

```text
killRate = killed / applicable
```

Never count `not applicable` in the denominator.

## 12. Global report design

Create a machine-readable report, suggested schema:

```text
factory.proof.conformance-report.v1
```

Suggested body:

```json
{
  "factoryFingerprint": "...",
  "lifecycles": ["product-build@...", "product-delivery@..."],
  "workshops": {
    "discovery": { "covered": 0, "total": 0, "percent": 0, "uncovered": [] },
    "formalization": { "covered": 0, "total": 0, "percent": 0, "uncovered": [] },
    "development": { "covered": 0, "total": 0, "percent": 0, "uncovered": [] },
    "delivery": { "covered": 0, "total": 0, "percent": 0, "uncovered": [] }
  },
  "dimensions": {
    "interWorkshop": {},
    "transitions": {},
    "negativeTransitions": {},
    "recovery": {},
    "genericInvariants": {},
    "faultSchedule": {},
    "mutation": {}
  },
  "minimalProvingCorpus": [],
  "excludedEvidence": [],
  "uncoveredObligations": []
}
```

### 12.1 Percentage rules

For each dimension:

```text
percent = demonstrated_required_items / total_required_items * 100
```

No scenario-count percentages.

No line-coverage percentages.

No credit for planned-only coverage.

No credit for failed/inconclusive bundles.

### 12.2 Do not hide families behind one average

The primary UI/report should show multiple dimensions. A single global weighted score may be added later only if weights are versioned and fixed before results are known.

Preferred first report:

```text
Factory Conformance Coverage

Workshop obligations
  Discovery             xx%
  Formalization         xx%
  Development           xx%
  Delivery              xx%

Graph
  Transition coverage   xx%
  Negative transitions  xx%
  Inter-workshop        xx%

Resilience
  Recovery coverage     xx%
  Fault-boundary        xx%
  Restart/idempotency   xx%

Protection quality
  Mutation kill rate    xx%
  Generic invariants    xx%

Uncovered obligations
  ...
```

## 13. Recommended implementation sequence for the next agent

### Phase A - Clean prerequisites

1. Run/consume the local Discovery checkpoint first.
2. Fix only proven Discovery test/kernel defects.
3. Reconcile stale Discovery entries in `obligation-contracts.mjs`.
4. Generalize canonical lifecycle fingerprint/selection so both Product Build and Product Delivery can be proven honestly.
5. Add no workshop-specific branch to ScenarioRunner.

Exit: Discovery remains green and canonical evidence names the actual driven lifecycle.

### Phase B - Formalization pack

1. Write topology inventory.
2. Reconcile Formalization independent obligations against actual provider versions.
3. Build valid positive fixtures from existing `W9_HAPPY_HANDLERS`; refactor reusable actor primitives instead of duplicating them.
4. Build positive formalized spine.
5. Add five author-Gate negative classes.
6. Add representative review repair/counterfactual scenarios.
7. Add baseline kernel scenarios.
8. Add SRS/architecture scenarios.
9. Add inconsistent outcome.
10. Add exact Formalization -> Development handoff oracle.
11. Add resilience axes using covering assignment across reviewed Cells.
12. Build Formalization coverage drive + mutation report.

Exit: Formalization workshop universe 100% demonstrated, K4-only gaps explicit.

### Phase C - Refactor the proof kernel only from evidence

After two workshops, inspect duplication between Discovery and Formalization.

Only now extract generic helpers that appear in BOTH, e.g.:

```text
reviewed-cell causal corpus builder
generic duplicate/late-call/stale-fence actor wrappers
generic exact handoff oracle builder
generic recovery-exhaustion multi-pass driver
workshop coverage report adapter
```

Do not predict abstractions before Formalization proves them.

The goal is that Development consumes a hardened common kernel rather than three generations of copied helpers.

### Phase D - Development pack

Implement D0-D10 from section 9 in order.

Do not attempt full Development closure in one commit. Suggested tranches:

```text
D-A task graph + resolver
D-B fan-out scheduling + implementation happy/review
D-C implementation negative + Git effect
D-D freeze + readiness + runnability
D-E verification fan-out + settlement
D-F continuation + re-plan
D-G restart/fault/resilience + coverage/mutation closure
```

After every tranche update the demonstrated coverage report; do not merely count tests.

### Phase E - Delivery pack

1. Switch/use Product Delivery lifecycle honestly.
2. Create deterministic human approval fixture.
3. Create deterministic preflight/publication/observation provider fixtures.
4. Prove deferred path.
5. Prove approved release path.
6. Prove pending/denied/expired paths.
7. Prove publication unknown/failure + observation-before-retry.
8. Prove candidate immutability.
9. Add Delivery restart/idempotency scenarios.
10. Bind K4 external-effect fault boundaries.
11. Produce Delivery coverage/mutation report.

### Phase F - Global coverage universe

1. Add a registry that composes workshop required universes WITHOUT copying their scenario implementations.
2. Add lifecycle transition universe from independent lifecycle expectations.
3. Add generic invariant universe.
4. Add K4 boundary universe.
5. Collect PASS ScenarioEvidenceBundles.
6. Build global evidence matrix.
7. Run set-cover to identify minimum proving corpus.
8. Join mutation kill matrix.
9. Emit JSON + human-readable report.
10. Fail the blocking test when any required global item loses all PASS evidence.

### Phase G - Blocking ratchet

Only after stable local green:

- register workshop coverage drives in the blocking `factory-proof` group;
- pin minimum coverage floors;
- pin mutation floors;
- pin installed-protection set equality;
- make coverage regression fail even when raw test count increased.

## 14. How to respond when a new scenario is red

Classify before changing code.

### Type A - Scenario/fixture error

Evidence:

- actor used hidden scenario knowledge;
- expected an event production does not declare;
- fixture violates an earlier prerequisite accidentally;
- oracle asserts implementation detail instead of contract.

Fix the test.

### Type B - Independent obligation registry drift

Evidence:

- production contract intentionally/versionedly changed;
- independent obligation still describes old property.

Review architecture decision, then explicitly migrate/version the obligation. Never auto-copy production declaration.

### Type C - Actual Factory defect

Examples:

- stale execution can still submit;
- Gate rejects but downstream runs;
- reviewer sees wrong author set;
- crash strands running ownership;
- repair_wait never requeues;
- duplicate effect occurs;
- replay accepts incompatible semantic input;
- cross-lifecycle material leaks;
- exact handoff hash changes.

Fix the SINGLE production authority that owns the behavior. Do not add a test-only workaround.

### Type D - Missing common proof-kernel capability

Example:

- need crash at `after effect / before receipt` but no legal failpoint exists.

Implement it in common K4 FaultSchedule infrastructure with named causal boundary and observer-only termination semantics. Do not add a Delivery-specific state hack.

### Type E - Semantic/open world

If correctness requires judging whether prose/code/business reasoning is truly good, mark it semantic-open / canary/eval. Do not fabricate a deterministic oracle.

## 15. Architecture quality ratchet

The conformance kernel is also an architecture test.

A new workshop is suspicious if it requires:

```text
specialWorkshopDispatcher
specialWorkshopRetry
specialWorkshopGate
manual DB state patch
latest-row fallback
custom lifecycle router
```

The desired extension model is:

```text
new workshop
  = declarations
  + fixtures
  + actors/human/external participants
  + independent obligations
  + genuinely workshop-specific predicates

NOT
  + new test runtime
```

If a workshop cannot fit this model, investigate whether production has escaped the universal Factory grammar before weakening the test kernel.

## 16. Definition of done for the entire program

The program is complete when all of the following are true:

1. Discovery, Formalization, Development and Delivery each have declarative conformance packs.
2. Every pack runs through the same canonical ScenarioRunner/evidence/coverage kernel, except common special drivers for capabilities not yet expressible in the runner (these must be candidates for generic extraction, not workshop engines).
3. Product Build and Product Delivery are fingerprinted and proven as distinct lifecycle scenarios.
4. Every local deterministic obligation is represented in the independent registry or explicitly classified as semantic-open.
5. Every declared ProcessModule transition is either demonstrated or explicitly classified as common K4/internal fault-only.
6. Every forbidden normal transition has at least one negative proof where meaningful.
7. Every applicable generic Factory invariant has PASS evidence.
8. Every cross-workshop handoff is exact by ref/hash/payload bindings.
9. Recovery/fault coverage is quantified separately.
10. Mandatory mutation families have an explicit kill rate and surviving mutants are listed.
11. Failed/inconclusive scenarios contribute zero coverage.
12. The final report is generated from evidence, not maintained by hand.
13. A change that removes the last PASS proof for a required obligation fails the blocking suite.
14. A change that accepts a mandatory violating mutant fails the blocking suite.
15. No test-only reducer, router, Gate, recovery planner or authority writer exists.

At that point the Factory is no longer validated as a collection of workshop-specific test suites. It is validated as one universal typed production kernel instantiated by different workshop topologies and different outside participants.

## 17. Expected end-state directory shape

A reasonable end state is:

```text
tests/factory-proof/
  canonical-proof-composition.mjs
  scenario-runner.mjs
  scenario-dsl.mjs
  scenario-evidence.mjs
  trace-observer.mjs
  coverage-kernel.mjs
  obligation-contracts.mjs
  mutation-algebra.mjs
  fault-scheduler.mjs                 # K4 when landed
  generic-cell-corpus.mjs             # extracted only after 2+ workshops prove reuse
  generic-reviewed-cell-corpus.mjs
  generic-handoff-oracles.mjs

  discovery-scenario-pack.mjs
  formalization-scenario-pack.mjs
  development-scenario-pack.mjs
  delivery-scenario-pack.mjs

  discovery-coverage-drive.mjs
  formalization-coverage-drive.mjs
  development-coverage-drive.mjs
  delivery-coverage-drive.mjs

  factory-coverage-universe.mjs
  factory-conformance-report-drive.mjs
```

Names may change. The ownership boundaries must not.

## 18. Final instruction to the implementing agent

Work from evidence, not from test count.

For every workshop ask five questions:

```text
1. What exact authority is supposed to be conserved?
2. What can the outside participant do wrong?
3. Which production component is authorized to detect it?
4. Where must repair/retry/effect/routing go next?
5. What durable evidence independently proves that this happened?
```

Then encode the answers as obligations, scenarios, oracles and coverage items.

Do not optimize for green. Optimize for a red test whenever the Factory violates its own architecture.
