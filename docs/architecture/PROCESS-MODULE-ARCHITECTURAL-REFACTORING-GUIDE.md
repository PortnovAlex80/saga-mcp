# Process Module Architectural Refactoring Guide

- Status: architecture diagnosis + execution guide
- Date: 2026-08-21
- Scope: built-in Process Modules, workshop package ownership, authoring surface, composition and bindings
- Explicit non-goal: redesigning Workplace/Gate/Factory physics without conformance evidence
- Governing decisions: ADR-053, ADR-082, ADR-083, ADR-084, ADR-085
- Related plan: `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md`
- Companion authoring guide: `docs/architecture/NEW-WORKSHOP-DESIGN-AUTHORING-GUIDE.md`

## 1. Executive diagnosis

The current Saga Factory core and the current Process Module packaging layer should not be judged as one architectural object.

The evidence supports a more precise diagnosis:

### Factory physics: comparatively strong

The universal runtime has coherent first-class concepts:

```text
WorkIntent
Workplace
WorkerExecution/fence
WorkplaceProductionRevision
CandidateSet
GateRun / GateDecision
review as optional Cell role
RecoveryIssue / recovery budget
effect receipt
CellFinalAcceptance
lifecycle routing
```

The strongest current architectural property is that these concepts are used across very different workshops:

- simple LLM production;
- reviewed LLM production;
- fan-out/fan-in and DAG scheduling;
- deterministic kernel nodes;
- human decisions;
- external effects and observations;
- continuation/re-plan flows.

This is evidence that the universal Factory model is real rather than merely aspirational.

### Process Module authoring/packaging: transitional and structurally weak

The current module layer shows multiple signs of an unfinished architectural migration:

- one logical workshop is physically split across two source trees;
- executable declarations are also collected in a factory-global capability manifest;
- composition still has multiple manual surfaces;
- module definitions mix topology, profile configuration, resource paths, CheckPlans and package concerns in large files;
- Development variants use clone-and-rewrite inheritance over a whole ProcessModuleDefinition;
- legacy node concepts remain visible after the Production Cell model became canonical;
- the authoring kit documents an `external-node` template although `external` was deliberately removed from `FlowNodeKind`;
- the authoring kit proves package validation but not canonical runtime connectivity;
- conformance ownership is still mostly outside workshop ownership.

This is not a reason to discard the Process Module concept.

It is a reason to finish the refactor so the code representation matches the already stronger domain model.

## 2. Refactoring thesis

The target is:

> Preserve Factory physics. Refactor workshop representation until one workshop is one coherent blueprint boundary with one public descriptor and one exact executable binding closure.

The refactor is successful when an agent can understand a workshop by opening one directory, and when the runtime can install it without consulting scattered module-name-specific lists.

The desired relation is:

```text
Workshop owns blueprint
  identity
  contracts
  flow
  cells
  profiles
  checks
  effects
  ports
  resources
  conformance declarations
        |
        v
one workshop descriptor
        |
        v
closed built-in catalog / admitted installation
        |
        v
Universal Factory owns physics
```

## 3. What NOT to refactor as part of this structural program

Do not opportunistically rewrite these unless a conformance scenario demonstrates a real defect:

- Workplace reducer semantics;
- WorkerExecution fencing;
- CandidateSet authority;
- GateDecision semantics;
- accepted authority head;
- production revision sealing;
- final acceptance;
- recovery budget semantics;
- transition obligations;
- lifecycle routing semantics;
- atomic execution release/finalizer.

A large structural refactor is exactly the wrong place to “simplify” authority physics by intuition.

If the new conformance kernel discovers a Factory bug, fix it in a separate semantically named commit with its own proof.

## 4. Evidence-backed architectural smells

These are not style preferences. They are concrete indicators that ownership and representation are misaligned.

### Smell A — one workshop lives in multiple ownership roots

Current pattern:

```text
src/process-modules/modules/<workshop>/
  definition/package/resources

src/modules/<workshop>/
  domain/application/installation code

src/process-modules/application/workshop-capability-manifest.ts
  global executable capability declarations
```

The existing modularization plan measured at least 32 files importing across the two workshop trees in both directions.

Impact:

- high navigation cost for agents;
- hard to answer “what does this workshop own?”;
- package definition and executable implementation drift independently;
- moving or changing a workshop requires repository-global knowledge.

Target:

```text
src/modules/<workshop>/
  one ownership root
```

with host adapters intentionally linked from infrastructure.

### Smell B — global capability manifest knows every workshop

`workshop-capability-manifest.ts` imports Discovery, Formalization, Development and generic capabilities directly and hand-assembles one Factory-wide executable set.

This solved an important earlier problem: orchestrator/worker-MCP contract drift.

But it is now a central ownership bottleneck.

A new workshop capability requires editing a factory-global file that understands workshop internals.

Target:

```text
workshop descriptor
  -> local capability declarations

closed built-in catalog
  -> aggregates descriptors

binding closure
  -> proves declaration == executable binding
```

The global view remains as a generated/checked projection, not the primary place where workshop details are authored.

### Smell C — Process Module definitions are too syntactically dense

`development-process-module.ts` is a large file containing:

- CheckPlan declarations;
- profile resource paths;
- tool lists;
- payload contract refs;
- Cell definitions;
- fan-out materialization;
- full flow topology;
- artifacts;
- policies;
- invariants;
- execution profiles.

The issue is not file length by itself.

The issue is that multiple independent reasons to change are represented in one construction unit.

Target decomposition:

```text
definition.ts              final assembly only
contracts.ts               input/output schemas and refs
cells.ts                   cell builders/fragments
profiles.ts                execution profiles
flow.ts                    nodes/transitions/outcomes
capabilities.ts            check/effect/handler declarations
runtime-bindings.ts        executable bindings
resources.ts or manifest   package resource inventory
```

The final `definition.ts` should read like a blueprint, not like the implementation of the blueprint language.

### Smell D — whole-module clone-and-rewrite inheritance

Development continuation modules currently use patterns such as:

```ts
const base = structuredClone(developmentProcessModule)
filter nodes
map nodes
replace selected cell definitions
filter profiles
filter transitions/recovery
```

This is clever and compact, but fragile.

Why:

- variant semantics depend on the shape/order/details of a large base object;
- adding a base node can silently change a continuation;
- filtering can preserve fields that should have been reconsidered;
- the diff between variants is procedural rather than declarative;
- testing must prove not only the intended variant but accidental inheritance.

Target:

```text
Development family fragments
  plannerCell()
  implementationCell(mode)
  freezeNode(mode)
  readinessCell()
  verificationCell(mode)
  settlementNode(mode)
  terminalNodes()

assembleBaseDevelopment()
assembleManagedContinuation()
assembleReplanContinuation()
assembleVerificationContinuation()
```

Variants should share explicit immutable fragments, not clone a finished module and surgically mutate it.

### Smell E — legacy node vocabulary remains after the architecture changed

`FlowNodeKind` still exposes `lm`, although the Production Cell is now the canonical unit of LM production.

The code comments explicitly removed `external`, but the current module-authoring-kit README still documents an `external-node` scaffold.

This is a strong sign that the authoring model and production model are not fully synchronized.

Target:

- decide whether direct `lm` is still a supported first-class architecture;
- if not, deprecate and remove it after migration;
- remove/update stale `external-node` authoring artifacts immediately with the structural cutover;
- make authoring templates derive from the actual canonical node vocabulary.

### Smell F — two retry/recovery vocabularies can be confused

Current design includes:

- `ExecutionProfileDefinition.retryPolicy` / `recoveryPolicy`;
- `ProductionCellDefinition.recovery`.

They are not necessarily wrong: one can represent physical execution policy and the other logical Cell recovery.

But their names and `onExhausted` vocabularies differ:

```text
profile recovery:
  fail | pause | escalate

cell recovery:
  fail | pause | requeue
```

This invites an agent to misunderstand which layer owns a retry.

Target:

- document and enforce the layer distinction;
- rename types/fields if necessary so physical worker restart and logical Cell repair are impossible to confuse;
- add validation rejecting contradictory policies;
- avoid copying the same numerical attempt budget into two layers without a stated reason.

Do not collapse the layers merely for cosmetic simplicity if they represent different physics.

### Smell G — helper defaults can hide semantics

`singletonProductionCell()` is useful, but several semantically important values are defaulted.

Examples to audit:

- default product cardinality;
- default humanRequired transition falling back to failed transition;
- capability preset defaults.

A helper called `singletonProductionCell` defaulting product cardinality to a plural range deserves explicit review.

This may be intentional product cardinality semantics rather than a bug, but such ambiguity is exactly what refactoring should eliminate.

Target:

- make architecture-bearing fields explicit;
- defaults only for truly mechanical values;
- validation should reject ambiguous combinations.

### Smell H — resource paths are interwoven with topology

Formalization and Development definitions contain many literal resource path constants and build profiles alongside flow definitions.

This makes path/package changes look like process changes.

Target:

```text
package/resources inventory
        ↓
resource logical IDs
        ↓
profiles reference logical/package-relative resources
```

Moving a checklist should not require understanding Flow routing.

### Smell I — authoring kit validates a package, not canonical connectivity

The current authoring kit intentionally validates package structure and conformance against canonical validators.

That is useful.

But ADR-085 correctly identifies the missing theorem:

> A package that validates is not proof that orchestrator, worker MCP and scripted worker all resolve the same executable binding set in the canonical runtime.

Target authoring finish line:

```text
scaffold
  -> validate definition
  -> validate package/resource closure
  -> validate capability declarations
  -> bind installation
  -> compare role binding receipts
  -> run generic conformance scenario
```

### Smell J — tests know ownership better than source layout

The new conformance work is increasingly able to describe a workshop as a coherent scenario pack, while production source ownership is still fragmented.

That inversion should be corrected.

Target:

```text
src/modules/<workshop>/conformance/
  module-owned fixtures/scenario declarations

shared tests/factory-proof/
  universal runner/observer/coverage/mutation engine
```

The shared engine must not acquire workshop branches.

## 5. Architectural quality verdict

The current project is not best described as “bad architecture”.

A more accurate statement is:

> The domain/runtime architecture has advanced further than its source/package representation. The repository contains the residue of several successful migrations, and the Process Module layer has not yet been compressed into the final form implied by those decisions.

This distinction matters.

A rewrite would risk destroying the strong parts.

The correct operation is a structural consolidation around the already proven universal runtime.

## 6. Target architecture

Use the ADR-085 ownership model.

```text
src/
  modules/
    built-in-catalog.ts

    discovery/
      WORKSHOP.md
      index.ts
      manifest.ts
      definition.ts
      runtime-bindings.ts
      contracts.ts
      cells.ts
      profiles.ts
      domain/
      application/
      ports/
      package/
      conformance/

    formalization/
      ...

    development/
      definition.ts
      family.ts / variants.ts
      cells/
      profiles/
      domain/
      application/
      ports/
      package/
      conformance/

    delivery/
      ...

  process-modules/
    domain/
    application/
    installation/
    persistence/

  infrastructure/
    process-modules/
      discovery/
      formalization/
      development/
      delivery/
```

### Universal kernel owns

- Flow/Cell vocabulary;
- Workplace state;
- execution/fence;
- CandidateSet;
- Gate machinery;
- recovery mechanics;
- effect orchestration;
- transition obligations;
- lifecycle orchestration;
- installation/binding machinery.

### Workshop owns

- identity;
- contracts;
- flow blueprint;
- Cell definitions;
- role/profile declarations;
- domain validators/check semantics;
- deterministic kernel policies;
- effect semantics/ports;
- resource package;
- local outcomes;
- conformance declarations.

### Infrastructure owns

- SQLite/filesystem/Git/provider substrates;
- external clients;
- process/OS adapters.

## 7. One workshop descriptor

The final canonical workshop representation should converge toward a single descriptor.

Conceptually:

```ts
export const formalizationWorkshop = {
  manifest,
  definition,
  createBindings,
  conformance,
} satisfies BuiltInWorkshop;
```

The descriptor is not itself runtime authority.

It is the single source of workshop declaration from which installation and binding closure are verified.

Do not create a second “new SPI” beside the existing package/installation system merely because the old layout is awkward.

Extend and finish the existing concepts.

## 8. Decompose definitions by architectural axis

### 8.1 Discovery

Expected final structure can stay small:

```text
contracts.ts
cells.ts
profiles.ts
definition.ts
runtime-bindings.ts
```

Avoid over-engineering the smallest workshop.

### 8.2 Formalization

Formalization currently has five structurally similar reviewed Cells.

This is a good place for a local family builder:

```ts
reviewedFormalizationCell({
  id,
  authorProfile,
  reviewerProfile,
  outputSchema,
  check,
  acceptedTransition,
})
```

But do not let the builder hide:

- output contract;
- Gate IDs;
- recovery policy;
- post-acceptance effect;
- reviewer identity.

Suggested decomposition:

```text
formalization/
  definition.ts
  contracts.ts
  outcomes.ts
  cells/
    product-contract.ts
    use-cases.ts
    acceptance-contract.ts
    reconciliation.ts
    architecture.ts
    reviewed-cell.ts
  kernels/
    freeze-baseline.ts
    settlement.ts
  profiles.ts
  capabilities.ts
  runtime-bindings.ts
```

The final flow assembly should visually expose:

```text
product -> use-cases -> acceptance -> reconcile
        -> freeze-baseline
        -> architecture
        -> settle
```

### 8.3 Development

Development deserves explicit family architecture rather than a giant definition.

Recommended fragments:

```text
development/
  definition.ts
  family.ts
  variants.ts

  contracts/
  cells/
    planner.ts
    implementation.ts
    readiness.ts
    verification.ts
  kernels/
    resolve-task-graph.ts
    freeze-candidate.ts
    bind-runnable.ts
    settlement.ts
    adoption.ts
  effects/
    git-integration.ts   # semantic declaration/port; substrate in infrastructure
  profiles/
  conformance/
```

Build variants compositionally:

```ts
const base = developmentFamily({
  planner: basePlanner,
  implementation: gitImplementation,
  verification: standardVerification,
  freeze: baseFreeze,
  settlement: baseSettlement,
});

const managed = developmentFamily({
  planner: none,
  implementation: managedTextImplementation,
  verification: managedVerification,
  freeze: continuationFreeze,
  settlement: continuationSettlement,
});
```

Do not use `structuredClone(finishedModule)` as the primary architecture for future variants.

### 8.4 Delivery

Delivery should remain visibly non-LLM.

Suggested decomposition:

```text
delivery/
  definition.ts
  contracts.ts
  ports/
    preflight.ts
    approval.ts
    publication.ts
    observation.ts
  kernels/
    preflight.ts
    publish-deploy.ts
    observe-release.ts
    settlement.ts
  runtime-bindings.ts
  conformance/
```

This protects an important architectural theorem: external-world orchestration does not require inventing a worker.

## 9. Separate pure blueprint from executable binding

A major goal is to make the module definition importable without causing process-global mutation.

Bad target:

```text
import workshop
  -> registers global providers/effects immediately
```

Good target:

```text
import workshop
  -> pure descriptor

createBindings(context)
  -> concrete executable objects

install/bind
  -> exact declaration/binding parity check
```

Benefits:

- deterministic tests;
- simpler multi-installation reasoning;
- no hidden registration order;
- easier orchestrator/worker/scripted parity;
- easier future admission controls.

## 10. Capability closure

Today the global manifest is useful but too centralized.

Refactor it into two conceptual levels.

### Local declaration

Each workshop owns entries such as:

```text
payload contract
  schemaId
  contractId
  version
  digest

check provider
  logicalId
  version
  implementationDigest

post-acceptance effect
  logicalId
  version
  implementationDigest

kernel/human/tool binding
  logicalId
  version
  digest/contract
```

### Closed global projection

Before C12:

```text
BUILT_IN_WORKSHOPS = [
  discoveryWorkshop,
  formalizationWorkshop,
  developmentWorkshop,
  deliveryWorkshop,
]
```

The Factory-wide capability manifest becomes a derived/validated aggregation of this literal closed tuple.

It must not scan the filesystem or installed packages to admit code.

## 11. Lifecycle remains outside workshop ownership

Do not co-locate lifecycle routing into a workshop merely for navigation convenience.

Lifecycle owns cross-workshop policy.

Workshop exports stable input/output/outcome contracts.

Lifecycle consumes them.

This dependency direction must remain visible:

```text
workshop local outcome
        ↓
lifecycle route declaration
        ↓
next workshop input mapping
```

A workshop must never import the next workshop implementation.

## 12. Refactor the type vocabulary only after behavioral coverage exists

Candidate cleanup targets include:

- legacy direct `lm` node;
- stale authoring-kit `external-node` support;
- profile-vs-Cell recovery naming;
- ambiguous helper defaults;
- obsolete artifact authority vocabulary if no longer used;
- string resource paths that should become package-relative logical refs.

But type cleanup can create broad compile churn.

Do it after conformance coverage can prove behavior, not before.

## 13. Update the module authoring kit as part of the cutover

The kit must describe the architecture that actually runs.

Required changes after the target layout lands:

- remove stale `external-node` template/documentation;
- prefer Production Cell templates over direct LM-node templates for cognitive production;
- scaffold `WORKSHOP.md`;
- scaffold target workshop descriptor/layout;
- validate declaration-to-binding closure;
- validate capability roles/digests;
- validate no forbidden direct imports/global registration;
- run a minimal generic conformance pack, not only manifest validation;
- prove canonical runtime connectivity.

The kit should become a workshop creation tool, not just a JSON manifest generator.

## 14. Conformance-driven refactoring discipline

The new test kernel is the prerequisite for safe structural change.

Before moving architecture:

```text
Discovery conformance
Formalization conformance
Development/Delivery representative baselines
normalized authority traces
package/binding fingerprints
```

During refactor, every semantic difference must be classified.

Allowed ignore fields in differential traces should be limited to incidental identity:

- generated UUIDs;
- timestamps;
- absolute paths;
- disposable DB row IDs.

Do NOT ignore:

- product digests;
- CandidateSet authority;
- Gate outcomes;
- recovery reason sequence;
- effect receipts;
- final acceptance;
- local outcomes;
- lifecycle handoffs.

## 15. Structural Refactor Qualification Gate

Do not begin the source cutover merely because these documents exist.

The refactor starts only when the agreed deterministic proof baseline is green enough to detect regressions.

Minimum:

- canonical composition is stable;
- ScenarioRunner/EvidenceBundle/CoverageKernel are working;
- Discovery closure is green;
- Formalization has enough coverage to characterize reviewed Cell/effect/baseline behavior;
- obligation registry is not known-stale for the surfaces being protected;
- normalized trace comparison is non-vacuous.

Development full coverage may continue during/after design preparation, but the actual all-built-in ownership cutover should not outrun its ability to detect semantic drift.

## 16. Refactoring sequence

This sequence respects ADR-085: commits may be reviewable, but the completed architecture must not leave a shadow runtime or dual ownership model.

### R0 — freeze current behavior and dependency map

Produce machine-readable inventories for every workshop:

```text
module identity/digest
flow nodes/transitions
cell definitions
profiles
check plans
capabilities
resources
kernel handlers
effects
lifecycle routes
binding receipts
conformance universe
normalized traces
```

Also capture source dependency graph:

```text
src/process-modules/modules/*
src/modules/*
workshop-capability-manifest
composition roots
worker MCP installation
fresh harness installation
```

Exit:

- current graph understood;
- baseline reproducible;
- non-vacuity mutants make it red.

### R1 — define target descriptors without changing behavior

For each built-in, define the intended public descriptor and ownership inventory on paper/code branch.

Do not switch runtime yet.

The descriptor schema must be shared.

Exit:

- Discovery/Formalization/Development/Delivery all fit the same descriptor shape;
- Delivery requires no fake execution profile;
- Development continuations fit as variants/family members, not exceptions to the Factory kernel.

### R2 — decompose workshop internals

Inside the refactor branch, split giant definition construction into stable fragments.

This is a source decomposition, not behavior change.

Formalization first because repeated reviewed Cells expose the right reusable local abstractions.

Development second because it stress-tests those abstractions with fan-out/effects/variants.

Exit:

- final definition files read as declarative topology;
- no structuredClone whole-module inheritance remains as the primary variant mechanism;
- helper functions have explicit semantic parameters.

### R3 — co-locate all built-in workshop ownership

Move all four workshop-owned trees to the ADR-085 target.

Do not classify host adapters as workshop-owned just to make the folder self-contained.

Update imports so external consumers use only workshop `index.ts`.

Exit:

- every workshop-owned file has exactly one canonical home;
- no cross-imports between legacy/new workshop roots;
- no compatibility re-export layer remains in the final merge state.

### R4 — introduce local runtime binding declarations

Move capability ownership from the global hand-list into each workshop descriptor.

Implement pure `createBindings(context)`-style construction using the existing installation/binding concepts.

The closed built-in catalog aggregates them.

Exit:

```text
declared capabilities == resolved capabilities
```

for each workshop and process role.

### R5 — switch canonical composition atomically

Make all production composition consumers use the same closed built-in tuple:

- orchestrator;
- lifecycle runtime;
- worker MCP payload-contract installation;
- scripted worker/fresh harness;
- conformance bootstrap.

Remove competing manual lists and workshop-specific registration roots.

No shadow binder remains.

Exit:

- exactly one built-in composition source;
- role binding receipts match;
- deleting catalog entry makes workshop unreachable everywhere.

### R6 — clean the universal Process Module vocabulary

Now remove or explicitly deprecate legacy surfaces.

Candidates:

- direct `lm` node if no justified consumers remain;
- stale external-node authoring support;
- duplicate/ambiguous recovery terminology;
- unused registry-ref alternatives if they no longer serve the target architecture;
- ambiguous helper defaults.

Each deletion must have coverage proving there is no remaining legitimate use.

### R7 — update authoring kit and generated `WORKSHOP.md`

Make the kit scaffold the target architecture.

Generate factual inventory blocks from descriptors:

- flow;
- contracts;
- cells;
- profiles;
- capabilities;
- resources;
- adapters;
- conformance commands.

CI fails if generated inventory drifts.

### R8 — co-locate workshop conformance declarations

Move workshop-owned fixtures/scenario declarations under the workshop ownership boundary while keeping universal execution infrastructure under `tests/factory-proof` or its eventual shared canonical home.

Exit:

- adding a new workshop pack does not modify ScenarioRunner/CoverageKernel;
- global coverage discovers/aggregates declared built-in workshop packs through the closed catalog/proof registry.

### R9 — differential proof

Run pre-refactor and post-refactor revisions on equivalent disposable fixtures.

Compare normalized authority graphs for:

- happy paths;
- reject/repair;
- reviewer repair;
- fan-out/fan-in;
- effects;
- restart/replay;
- human outcomes;
- external provider uncertainty;
- inter-workshop handoffs.

Any semantic diff is either:

- a defect in the refactor -> fix;
- an intended semantic change -> remove from this refactor and handle separately.

### R10 — ratchet the final architecture

Add hard checks:

- no `src/process-modules/modules/<workshop>` legacy ownership;
- no external import of workshop internals except `index.ts`;
- no factory-global workshop capability hand-editing outside closed aggregation;
- no direct global registration from workshop code;
- no stale external-node scaffold;
- no whole-module `structuredClone` variant construction;
- one closed built-in catalog;
- exact declaration/binding parity;
- conformance coverage floor cannot decrease silently.

## 17. No behavior-changing cleanup inside structural commits

A refactor agent will inevitably discover bugs.

Use this rule:

### If the bug is necessary to make the structural refactor possible

Stop and isolate it.

Create:

1. failing causal test/evidence;
2. semantic bugfix commit;
3. green proof;
4. then resume structural work.

### If the bug is unrelated

Record it and leave it out of the refactor.

This prevents a 200-file move from becoming impossible to reason about.

## 18. How to evaluate abstractions during refactor

Do not extract a generic helper after observing it once.

Use evidence from at least two workshop implementations.

Good extraction criterion:

```text
same authority semantics
+ same state transition role
+ same parameters vary declaratively
= generic helper candidate
```

Bad extraction criterion:

```text
these functions look similar
```

Example:

Formalization repeated reviewed singleton Cells can justify a local reviewed-Cell builder.

But Delivery’s human approval is not “basically a reviewer” merely because both produce a decision.

Keep semantic categories distinct even when shapes look similar.

## 19. Avoid the opposite failure: abstraction explosion

The current problem is not solved by creating 50 tiny SPI interfaces.

Prefer four layers:

```text
1. universal Factory vocabulary
2. workshop blueprint descriptor
3. workshop application/domain capabilities
4. host infrastructure adapters
```

Add a new abstraction only when it removes a real duplicated authority/ownership decision.

Do not introduce:

- WorkshopManager;
- CellFactoryFactory;
- generic “ExternalNode”; 
- universal semantic validator DSL for logic that is genuinely workshop-specific;
- plugin discovery before C12.

## 20. Development-specific refactor cautions

Development is the strongest stress test and the easiest place to damage semantics.

Preserve explicitly:

- fan-out workKey identity;
- dependency ordering;
- task provenance;
- implementation scope and widening authority;
- claim monotonicity;
- reviewer exact CandidateSet binding;
- Factory-owned Git integration;
- candidate freeze before readiness/verification;
- local runnability subject binding;
- upstream failure ownership;
- verification candidate/AC hash binding;
- continuation accepted-prefix authority;
- re-plan supersede semantics;
- restart isolation across cycles.

Do not simplify Development by collapsing these into one giant “build” node.

Complexity here is partly real domain/control complexity. The goal is to make it legible, not pretend it does not exist.

## 21. Formalization-specific refactor cautions

Preserve:

- five reviewed Cells as actual Production Cells;
- exact artifact/trace lineage;
- post-acceptance projection effect;
- acceptance heading/criterion semantics;
- constraint coverage/dispositions;
- reconciliation explicit product;
- baseline freeze before HOW;
- AC immutability after freeze;
- SRS exact D2 binding;
- lifecycle-scoped settlement.

The tempting bad refactor is to move all validation into one final settlement because it looks simpler.

Do not do this.

Shift-left Cell gates are part of the recovery architecture: they detect repairable errors while the worker still owns the repair frontier.

## 22. Delivery-specific refactor cautions

Preserve Delivery as proof that the Factory does not require an LLM.

Do not introduce a generic worker merely to fit a uniform implementation pattern.

Preserve:

- deterministic preflight;
- typed human approval;
- exact approval subject binding;
- deterministic action keys;
- publication receipts;
- authoritative observation;
- observe-before-retry;
- settlement only after observed state;
- no force/bypass semantics;
- candidate immutability.

## 23. Refactoring metrics

Do not use line count reduction as the main success metric.

Track:

### Ownership metrics

```text
cross-workshop-tree imports
external imports bypassing index.ts
number of canonical composition lists
number of global registration entrypoints
```

Targets:

```text
legacy dual-root workshop imports = 0
canonical built-in catalog = 1
private workshop registration routes = 0
```

### Definition readability metrics

For each workshop record:

- nodes/cells visible in final definition;
- number of files needed to discover one Cell contract;
- number of duplicated profile/cell builders;
- number of whole-module clone/mutation operations.

### Binding metrics

```text
declared capabilities
resolved capabilities
missing bindings
extra bindings
role receipt mismatches
```

Target missing/extra/mismatch = 0.

### Behavioral metrics

- workshop demonstrated coverage;
- transition coverage;
- negative transition coverage;
- recovery coverage;
- mutation kill rate;
- normalized pre/post semantic diff.

The structural refactor is green only when behavioral metrics do not regress.

## 24. Refactor review questions

Every review should answer:

1. Did this move ownership closer to the workshop or merely rename folders?
2. Is there now one declaration of this capability or two?
3. Can an agent find the Cell’s product/check/recovery/effect from its local workshop inventory?
4. Did any universal runtime file gain a workshop-name branch?
5. Did any workshop gain runtime authority it did not have before?
6. Did a variant become more declarative or more procedural?
7. Did lifecycle routing remain outside the module?
8. Did exact refs/hashes remain exact?
9. Can pre/post conformance evidence prove semantic parity?
10. Was an intended bugfix accidentally mixed into structural code?

## 25. Red flags during implementation

Stop the refactor if you see:

- temporary dual-read/dual-write architecture without a deployed-state requirement;
- old and new workshop binders both active;
- “compatibility” re-exports with no concrete consumer deadline;
- generated package admission replacing the closed catalog before C12;
- a universal runtime switch on workshop name;
- direct DB access added to workshop domain/application merely to simplify a move;
- a variant implemented by another full module clone;
- a conformance test weakened because paths changed;
- scenario/obligation counts falling without a documented semantic deletion;
- resource/handler digest checks disabled to make moves easier;
- normalizing away Gate/recovery/effect differences in differential traces.

## 26. What the final repository should feel like to an agent

The usability test is simple.

An agent asked “change Formalization acceptance behavior” should begin at:

```text
src/modules/formalization/WORKSHOP.md
```

From there it can discover:

```text
acceptance Cell
  -> profile
  -> output contract
  -> CheckPlan
  -> validator
  -> reviewer
  -> recovery
  -> effect
  -> downstream baseline freeze
  -> conformance scenarios
```

without global grep across two workshop roots and a factory-wide capability file.

An agent asked “how does Factory handle a stale WorkerExecution?” should go to the universal kernel, not a workshop directory.

That separation is the desired architecture.

## 27. Finish condition

The Process Module refactor is complete when:

```text
one workshop = one ownership root
one workshop = one public descriptor
one workshop = one declaration/binding closure
one closed built-in catalog = canonical composition source
no duplicate manual workshop lists
no process-global private registration path
variants assembled from explicit family fragments
legacy authoring vocabulary removed or deliberately supported
module authoring kit matches production architecture
workshop conformance is first-class
pre/post normalized Factory behavior is equivalent
```

And the most important invariant remains true:

> The Factory runtime does not become aware of what “Discovery”, “Formalization”, “Development” or “Delivery” mean. It executes Process Module and Production Cell contracts.

That is the architecture worth preserving while the module layer is cleaned up.
