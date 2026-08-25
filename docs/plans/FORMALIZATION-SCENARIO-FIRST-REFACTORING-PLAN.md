# Formalization Scenario-First Refactoring Plan

Status: planned and blocked by two prerequisite plans.

This plan is a successor to:

- `docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`
- `docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md`

No production implementation from this plan may start until both prerequisite
plans have reviewed completion receipts, the Event Kernel plan has completed
EK-13, `saga4` points at the reviewed closure SHA, and the target worktree is
clean. This plan may be reviewed and corrected before that gate, but it must
not compete with WP-11F, WP-12, WP-13, EK-11, EK-12, or EK-13.

This document is self-contained. An execution coordinator may assign one work
package or one phase to an agent without relying on prior conversation.

## Autonomous execution policy

No phase, exit gate, review, qualification run, merge decision, or completion
receipt in this plan requires interactive human participation.

- [ ] The integration coordinator, implementer, independent verifier,
      adversarial reviewer, and run operator are agent roles.
- [ ] Independent approval means a durable receipt from a different agent that
      did not author the subject; it does not mean operator or user approval.
- [ ] The user's standing directive authorizes every reversible in-scope phase
      transition when its executable gate is green. The coordinator does not
      pause between phases to request confirmation.
- [ ] A red gate causes autonomous diagnosis, the smallest lawful repair, a new
      immutable candidate or build where required, and rerun of the affected
      gate. It does not cause a question to the user.
- [ ] Runtime scenarios that model a human actor are executed by a deterministic
      scripted actor or an independently assigned agent actor through the same
      public command path.
- [ ] Qualification projects must not depend on credentials, legal authority,
      external publication approval, or facts available only to a human.
- [ ] An agent never fabricates credentials, external authority, or evidence.
      If an unforeseen irreducibly external dependency appears, it is recorded
      as a typed blocked result while every independent work item continues;
      such a result cannot be counted as qualification success.

## Objective

Within 30 calendar days after the second prerequisite completion receipt,
replace the post-EK Formalization semantic flow with a scenario-first flow that
preserves accepted source intent, interaction scenarios, derived system
requirements, acceptance evidence, SRS realization, and Development planning
bindings as one content-addressed chain.

The refactor is successful only when all of the following are true together:

- [ ] The installed Formalization graph has exactly six reviewed Production
      Cells, two kernel nodes, three terminal nodes, and eighteen declared
      transitions.
- [ ] Product intent is accepted before scenarios, scenarios are accepted
      before final FR/NFR/RULE artifacts, and acceptance criteria are accepted
      after the requirements they verify.
- [ ] Every accepted Discovery scope item has an exact PRD intent member or an
      explicit deferred or out-of-scope disposition.
- [ ] Every required interaction or operational scenario survives unchanged
      through the WHAT baseline, SRS, Solution Contract, DevelopmentCase, and
      Development WorkItems.
- [ ] The Elite missing-entrypoint and missing-composition mutations are
      rejected before Development execution begins.
- [ ] Interactive, external-system, scheduled/batch, and autonomous products
      use the same Formalization flow without a game-specific or human-only
      branch.
- [ ] All new semantic, transition, authority, restart, capsule, and handoff
      mutations are killed by blocking tests.
- [ ] The post-EK scripted project corpus passes from fresh databases and
      repositories on one immutable build.
- [ ] Three diverse real OpenCode full-conveyor runs pass consecutively from
      fresh inputs on the same immutable build.
- [ ] No old Formalization flow, acceptance-only baseline, compatibility
      adapter, database migration, dual read, dual write, or stale capsule path
      remains reachable.

## Decision

The refactor keeps the existing artifact vocabulary:

```text
brief
PRD
UC
FR
NFR
RULE
AC
SRS
```

The refactor does not add BR, SR, UR, BUC, SUC, CJM, mission-thread, or ConOps
as new runtime artifact types. Those terms may be used by authors as analysis
techniques, but they are not new kernel concepts, tables, schedulers, or
artifact authorities.

The minimum concept budget is:

- [ ] One additional reviewed Production Cell named
      `derive-system-requirements`.
- [ ] One requirements bundle contract, CheckPlan, execution profile, and
      package-local semantic skill for that Cell.
- [ ] Stable intent members inside the existing PRD container.
- [ ] Actor and flow fields inside the existing UC container.
- [ ] One whole-WHAT baseline replacing the acceptance-only baseline.
- [ ] One structured scenario-realization section inside the existing SRS.
- [ ] Scenario and realization bindings added to existing Solution Contract,
      DevelopmentCase, and WorkItem contracts.
- [ ] Zero new mutable owner, database table, kernel role, scheduler,
      transition kind, parallel artifact system, or compatibility path.

This is not a simple node reorder. It is a Formalization-led cross-workshop
semantic handoff refactor. The universal Event Kernel, Workplace, Production
Cell, CandidateSet, GateDecision, post-acceptance effect, obligation driver,
repair mechanics, and Kanban projection remain unchanged.

## Decision analysis

The fork was classified as complicated: the causal defect is knowable, but a
local reorder, a full requirements ontology, and a minimal contract refactor
have different correctness and blast-radius properties.

Options considered:

- Full BR/SR/UR/BUC/SUC ontology. Strong vocabulary, but adds many new semantic
  entities, creates an artifact-theatre risk, and fits autonomous products
  poorly unless further profiles are introduced.
- Reorder only the current UC and AC Cells. Smallest code change, but invalid:
  the current AC contract requires accepted UC and FR/NFR inputs, while final
  FR/NFR/RULE production currently belongs to the first Cell.
- Split the product Cell, keep existing artifact types, add one requirements
  Cell, replace the baseline, and preserve scenarios through Development.
  This is the selected option.

Weighted decision criteria were correctness, minimum new concepts, alignment
with the post-EK architecture, independent testability, blast radius, and
support for non-human systems. The selected option scored highest because it
changes the causal order and downstream authority without introducing a second
requirements platform.

Red-team conditions incorporated into this plan:

- [ ] A UC may be human-neutral but never actorless.
- [ ] Source-to-intent coverage is checked against the exact Discovery handoff,
      not against self-generated PRD content only.
- [ ] Reconciliation is validation and reporting only. It may not patch an
      already accepted artifact or trace in place.
- [ ] The whole-WHAT baseline consumes exact final-acceptance and production-
      revision references; it never reselects accepted artifacts.
- [ ] Scenario bindings are mandatory Development planning inputs, not payload
      decoration.
- [ ] The post-EK scenario engine is extended; no second graph or test engine
      is created.
- [ ] The previous EK qualification is considered invalidated by the semantic
      contract change and is rerun on a new immutable build.

## Current defect to remove

The pre-refactor semantic order is:

```text
define-product-contract
  produces brief + PRD + FR/NFR/RULE

model-use-cases
  produces UC required to cover already accepted FR

define-acceptance-contract
  produces AC derived from UC and FR/NFR

reconcile-what
freeze-acceptance-baseline
define-architecture-contract
settle-formalization
```

This order can prove coverage inside the declared requirement set, but cannot
prove that the declared set contains every source outcome or every complete
actor-to-result path. It also freezes AC identities without making the accepted
UC set an active downstream planning obligation.

The refactor must remove both failures:

- semantic inversion: UC confirms pre-existing FR instead of exposing system
  behavior from actor outcomes;
- authority loss: UC remains provenance but does not remain required planning
  material through SRS and Development.

## Target process graph

The expected primary path is:

```text
define-product-intent
-> model-use-cases
-> derive-system-requirements
-> define-acceptance-contract
-> reconcile-what
-> freeze-what-baseline
-> define-architecture-contract
-> settle-formalization
-> complete-formalized
```

Production Cells:

```text
define-product-intent
model-use-cases
derive-system-requirements
define-acceptance-contract
reconcile-what
define-architecture-contract
```

Kernel nodes:

```text
freeze-what-baseline
settle-formalization
```

Terminal nodes:

```text
complete-formalized
complete-inconsistent
complete-failed
```

Expected transition universe:

```text
define-product-intent --domain.accepted--> model-use-cases
define-product-intent --domain.failed--> complete-failed

model-use-cases --domain.accepted--> derive-system-requirements
model-use-cases --domain.failed--> complete-failed

derive-system-requirements --domain.accepted--> define-acceptance-contract
derive-system-requirements --domain.failed--> complete-failed

define-acceptance-contract --domain.accepted--> reconcile-what
define-acceptance-contract --domain.failed--> complete-failed

reconcile-what --domain.accepted--> freeze-what-baseline
reconcile-what --domain.failed--> complete-failed

freeze-what-baseline --domain.frozen--> define-architecture-contract
freeze-what-baseline --domain.drift-detected--> complete-inconsistent
freeze-what-baseline --domain.failed--> complete-failed

define-architecture-contract --domain.accepted--> settle-formalization
define-architecture-contract --domain.failed--> complete-failed

settle-formalization --domain.formalized--> complete-formalized
settle-formalization --domain.inconsistent--> complete-inconsistent
settle-formalization --domain.failed--> complete-failed
```

The counts and names above are normative targets, but FRF-0 must verify them
against the installed post-EK package before implementation. A necessary
post-EK name adjustment must be recorded before RED graph tests are frozen; it
may not weaken the six-Cell/two-kernel/three-terminal/eighteen-edge shape.

Production Cell repair and reviewer loops are internal Production Cell
behavior. They are tested separately and are not additional process-flow
edges.

## Target semantic trace grammar

Use the existing artifact containers and existing trace vocabulary wherever
the post-EK package supports exact atomic-member references.

```text
PRD --derived_from--> brief and exact Discovery source claims
UC --derived_from--> PRD and exact PRD intent members
FR --derived_from--> PRD and one or more UC branches when scenario-derived
NFR --derived_from--> PRD and optionally UC when scenario-local
RULE --derived_from--> PRD and optionally UC when scenario-local
AC --derived_from--> FR or NFR
scenario-facing AC --derived_from--> UC and terminal scenario branch
SRS --derived_from--> frozen whole-WHAT baseline
```

Cross-cutting NFR and RULE artifacts may derive directly from PRD intent or
source constraints. They must not be forced into a fictional user scenario.

Every required PRD intent member must have exactly one of these dispositions:

```text
scenario_required
direct_requirement
deferred
out_of_scope
```

`deferred` and `out_of_scope` require an owner and reason. A direct requirement
route requires a reason why no meaningful interaction or operational scenario
exists.

## Desk contracts

### define-product-intent

The Cell produces the existing brief and PRD containers only.

The PRD must contain stable atomic intent members for:

- system boundary;
- actors and affected stakeholders;
- stakeholder, user, operator, or mission outcomes;
- scope and exclusions;
- lifecycle terminal claims;
- constraints;
- assumptions and unknowns;
- required dispositions.

The Cell must not produce final FR, NFR, RULE, UC, AC, or SRS artifacts.

### model-use-cases

The Cell keeps the existing UC artifact type. A UC is an interaction or
operational scenario and must always declare an actor.

Allowed actor kinds are a small closed vocabulary:

```text
human
operator
external_system
scheduler_or_clock
sensor_or_environment
```

Every UC must contain:

- stable scenario identity;
- exact PRD intent references;
- actor kind and actor identity;
- goal or protected outcome;
- trigger;
- preconditions;
- main flow;
- material alternate and error flows;
- observable postcondition or terminal result.

The Cell must not require a pre-existing FR and must not create FR/NFR/RULE or
AC artifacts.

### derive-system-requirements

This is the only new Production Cell.

It produces existing FR, NFR, and RULE artifacts from exact accepted PRD and
UC material.

- Scenario-derived FRs must bind to exact PRD intent and UC branch identities.
- Every material system response in a UC must have at least one FR, RULE, or
  scenario-local NFR obligation.
- Every accepted UC must produce at least one observable behavior obligation.
- Cross-cutting NFR and RULE artifacts may bind directly to PRD intent or
  source constraints.
- No requirement may derive from a foreign, stale, superseded, or unaccepted
  material revision.

### define-acceptance-contract

The Cell keeps the existing AC concept and atomic AC identity.

- Every AC must bind to exact FR or NFR material.
- A scenario-facing AC must retain its exact UC and terminal-branch binding.
- Every required UC terminal result must have at least one end-to-end AC or an
  accepted evidence binding of type test, monitoring, audit, or independent
  agent review.
- AC remains WHAT-side verification and must not contain architecture or file
  allocation decisions.

### reconcile-what

The Cell validates and reports the closed chain:

```text
Discovery source claim
-> PRD intent member or explicit disposition
-> UC or justified direct requirement
-> FR/NFR/RULE
-> AC/evidence obligation
```

The reconciler may not add, delete, or patch an accepted artifact, member, or
trace. A repair must create a new immutable revision in the owning upstream
Cell, invalidate dependent outputs, and rerun the affected cone. If the
runtime cannot route that repair lawfully, the run becomes inconsistent; it
must not mutate accepted history.

### freeze-what-baseline

The acceptance-only baseline is deleted and replaced, not retained beside the
new contract.

The whole-WHAT baseline contains exact content-addressed references for:

- FormalizationCase and Discovery certificate/proposal identity;
- source claim and constraint manifests;
- each accepted CellFinalAcceptance, CandidateSet, and
  WorkplaceProductionRevision used as material authority;
- PRD container and intent-member IDs/hashes;
- UC container, scenario, and branch IDs/hashes;
- FR/NFR/RULE container and member IDs/hashes;
- AC container and atomic criterion IDs/hashes;
- accepted trace/member-binding set and canonical digest;
- deferral, constraint, assumption, and unknown dispositions;
- evidence-method bindings;
- one canonical whole-WHAT digest.

The freezer consumes exact accepted inputs carried by transitions. It may not
scan by epic, lifecycle, task, execution, status, type, chronology, maximum ID,
or latest artifact. It may not reparse mutable documents after their atomic
member manifest has been accepted.

### define-architecture-contract

The existing SRS remains the architecture artifact. Add one mandatory
scenario-realization section. For every required UC it records:

```text
scenario identity
entrypoint or trigger
participating modules
required producer-consumer/runtime edges
external interfaces
composition owner
required implementation and integration surfaces
terminal observable result
evidence binding
```

The existing AC-level decomposition may remain, but it cannot substitute for
scenario realization. A flat list of files is not proof of runtime
connectivity.

### settle-formalization

Settlement consumes the exact whole-WHAT baseline and exact accepted SRS
revision. It must not rediscover accepted artifacts or reparse mutable source
files. It emits one content-addressed Solution Contract containing exact
references to both authorities and their atomic manifests.

## Development handoff requirements

The DevelopmentCase must carry typed, required values for:

```text
formalization certificate
solution contract
whole-WHAT baseline reference and hash
SRS reference and hash
PRD intent bindings
interaction/operational scenario bindings
FR/NFR/RULE bindings
acceptance criteria bindings
scenario realization bindings
terminal claim bindings
integration and construction obligations
repository and policy bindings
```

Development planning must consume these values. A WorkItem must bind to one or
more of:

- acceptance obligation;
- scenario-realization obligation;
- requirement obligation;
- integration or composition obligation;
- typed infrastructure obligation.

A plan is invalid if it covers every AC but omits a scenario entrypoint,
runtime edge, composition owner, terminal result, or verifier.

## Graph and test model

Do not create a second graph engine. Extend the independently authored
transition, claim, scenario, model-comparison, fault, and minimization
infrastructure delivered by the Event Kernel plan.

Keep four graph concerns explicit:

- installed Formalization process transition graph;
- semantic source/intent/scenario/requirement/acceptance trace graph;
- SRS scenario-realization graph;
- workflow obligation and demonstrated-test universe.

The process transition graph is checked by exact node/edge equality. The
semantic and SRS graphs are checked by typed closure and reachability. The
workflow test universe proves that every declared transition and fault edge is
demonstrated. These graphs may share canonical identity helpers, but one graph
must not be substituted for another.

Forward and reverse expected graphs must be authored independently:

- forward input: exact Discovery handoff, target desk contracts, and public
  commands;
- reverse input: Solution Contract, DevelopmentCase, SRS realization,
  terminal evidence, and product-verifier obligations.

The derivations are frozen before comparison. Neither author may read the
other result before both hashes are recorded. Expected graphs must not be
generated from production validators or production flow output.

## Test migration policy

The semantic order is intentionally breaking. Existing Formalization tests and
capsules are classified before modification:

- retain unchanged: generic Workplace, Production Cell, CandidateSet,
  GateDecision, revision, fencing, obligation, repair, and recovery laws;
- rewrite: tests that encode Formalization node order, artifact ownership,
  trace direction, freeze shape, SRS decomposition, handoff, or planning;
- regenerate through public production ingress: evidence fixtures, normalized
  traces, scenario packs, golden corpus, and replay capsules;
- delete: tests and resources that exist only to preserve the old flow or
  acceptance-only baseline.

Do not hand-edit snapshots or sealed hashes to make them green. Each regenerated
fixture requires provenance and at least one deliberate RED mutation. Every
new or retained test file must be blocking-hosted and removal-guarded.

Old Formalization capsules must miss safely under the new package and semantic
contract digest. There is no capsule migration, adapter, or mixed replay mode.

## Required test layers

### Contract and pure validator tests

- [ ] Product intent accepts brief plus PRD and rejects final FR/NFR/RULE
      production in that Cell.
- [ ] UC accepts no pre-existing FR input and rejects an actorless scenario.
- [ ] Requirements Cell rejects missing, foreign, stale, or unsupported PRD/UC
      lineage.
- [ ] Acceptance rejects missing requirement or scenario-terminal lineage.
- [ ] Reconciliation detects forward and reverse gaps without mutating accepted
      material.
- [ ] Whole-WHAT freeze rejects missing, extra, duplicated, substituted, stale,
      foreign, or drifted material.
- [ ] SRS realization rejects disconnected runtime graphs.
- [ ] DevelopmentCase rejects missing scenario and realization bindings.

### Process graph tests

- [ ] The expected graph has exactly eleven nodes and eighteen transitions.
- [ ] Every nonterminal node is reachable from the entry.
- [ ] Every formalized path visits all six Production Cells and both kernel
      nodes.
- [ ] Every reviewed Cell has accepted and failed exits.
- [ ] Freeze has frozen, drift-detected, and failed exits.
- [ ] Settlement has formalized, inconsistent, and failed exits.
- [ ] Cell `acceptedTransition` declarations match installed flow edges.
- [ ] Node output and successor input schemas match.
- [ ] Every handler, CheckPlan, role contract, resource, and schema is pinned by
      the installed package.
- [ ] No old node, edge, resource, or handler remains reachable.

### Production Cell and temporal tests

- [ ] Author gate, reviewer gate, post-acceptance effect, repair,
      retry-exhaustion, feedback, crash, and restart coverage includes all six
      Production Cells.
- [ ] Crash-before and crash-after schedules cover each new Cell acceptance,
      WHAT freeze, SRS acceptance, settlement, and lifecycle handoff.
- [ ] Restart never recreates accepted upstream PRD or UC material.
- [ ] Partitioning identical material across one execution, multiple repair
      executions, or multiple atomic members produces the same semantic
      baseline.
- [ ] Decoy executions and newer unrelated artifacts never become authority.
- [ ] No terminal route leaves an execution, obligation, wait, or aggregate
      stranded.

### Formalization-to-Development tests

- [ ] Formalization output maps byte-for-byte to Development input for every
      authoritative field.
- [ ] Removing PRD intent, UC, realization, terminal-claim, or construction
      bindings fails before planning.
- [ ] An AC-complete but scenario-incomplete Development plan is rejected.
- [ ] A multi-module scenario cannot be represented by one disconnected local
      task.
- [ ] Infrastructure/composition WorkItems use typed SRS construction
      obligations when they do not map one-to-one to AC.
- [ ] Replan, adoption, settlement, and verification preserve the exact same
      scenario identities and hashes.

### Capsule tests

- [ ] Cold scripted production creates accepted outputs for all six Cells.
- [ ] Warm replay reuses cognition products but creates fresh CandidateSets,
      GateRuns, GateDecisions, effects, baseline, settlement, and lifecycle
      transitions through public ingress.
- [ ] A semantic source change invalidates the exact downstream cone.
- [ ] Provenance-only identity changes do not invalidate semantic replay.
- [ ] Corrupt or incomplete capsules fail closed and are not immediately
      reselected for the same repair attempt.
- [ ] Pre-refactor capsules never replay under the new package digest.

### Product-profile tests

- [ ] Interactive UI product with a human actor, public entrypoint, input,
      domain behavior, state propagation, rendered result, and browser smoke.
- [ ] API or service integration with an external-system actor, validation,
      success, rejection, timeout, duplicate request, and receipt.
- [ ] Scheduled or batch product with a clock actor, idempotent processing,
      restart behavior, observable result, and audit evidence.
- [ ] Autonomous event/control-loop product with sensor/environment trigger,
      decision, action, feedback, degraded result, safe failure, and monitoring
      evidence.
- [ ] Elite-derived interactive regression with the complete composition path.

### Elite and simple-server kill tests

- [ ] Keep valid PRD, UC, FR, AC, renderer, HUD, input, domain, server, and test
      declarations but remove the browser bootstrap; reject before Development
      execution.
- [ ] Remove the input-to-controller runtime edge; reject.
- [ ] Remove the state-to-renderer runtime edge; reject.
- [ ] Remove the composition owner; reject.
- [ ] Retain all AC IDs while stripping UC/scenario bindings from the handoff;
      reject.
- [ ] Give the Development planner an AC-complete disconnected graph; reject.

### Required semantic mutations

- [ ] Remove one source scope item from PRD intent while keeping all generated
      downstream artifacts well formed.
- [ ] Replace one PRD/UC graph with a well-formed but semantically unrelated
      graph.
- [ ] Remove an actor, trigger, alternate flow, error flow, or observable
      postcondition.
- [ ] Remove the scenario covering one required intent member.
- [ ] Restore the forbidden `UC --covers--> pre-existing FR` direction.
- [ ] Make product intent emit final FR/NFR/RULE artifacts.
- [ ] Add a shortcut from product intent or UC directly to acceptance.
- [ ] Bypass `derive-system-requirements`.
- [ ] Add an FR with no exact PRD/UC source.
- [ ] Remove the FR/RULE response for one material scenario step.
- [ ] Keep AC coverage but remove its terminal scenario binding.
- [ ] Freeze only AC members and omit accepted UC or requirements.
- [ ] Substitute material from a newer execution, another run, or another PRD.
- [ ] Mutate accepted material after reconciliation.
- [ ] Strip scenario realization from SRS or DevelopmentCase.
- [ ] Delete or de-host any new test, driver, corpus entry, or mutation token.

## Work packages

The coordinator owns integration, shared manifests, matrix hosting, plan truth,
and final evidence. Implementers do not approve their own packages.

FRF-WP01: Post-EK inventory and baseline

- Depends on both prerequisite completion receipts.
- Owns inventory, baseline commands, current graph capture, test classification,
  deletion manifest, and intentional-difference ledger.
- Makes no production behavior change.

FRF-WP02: Independent target graphs

- Depends on FRF-WP01.
- One agent derives the forward graph from source and desk contracts.
- A different agent derives the reverse graph from handoff and terminal
  evidence.
- The coordinator freezes both hashes and performs reconciliation.
- Neither graph author implements the production validator.

FRF-WP03: Minimal semantic contracts

- Depends on FRF-WP01 and FRF-WP02.
- Owns PRD intent-member, UC scenario-member, requirements bundle, AC binding,
  and whole-WHAT baseline schemas.
- Adds no artifact type or mutable storage owner.

FRF-WP04: Product-intent and UC Cells

- Depends on FRF-WP03.
- Owns product/UC protocols, skills, templates, CheckPlans, reviewers, and
  focused tests.
- Does not edit shared package manifests or CI hosts.

FRF-WP05: System-requirements Cell

- Depends on FRF-WP03.
- Owns the one new Cell, role contract, skill, output bundle, validator, and
  focused tests.
- Does not modify acceptance, SRS, or Development code.

FRF-WP06: Acceptance and reconciliation

- Depends on FRF-WP04 and FRF-WP05.
- Owns acceptance bindings, closure validators, report-only reconciliation,
  and negative semantic fixtures.

FRF-WP07: WHAT freeze and settlement

- Depends on FRF-WP03 and FRF-WP06.
- Owns replacement baseline, exact accepted-authority ingestion, persistence,
  settlement, solution contract, and authority mutations.

FRF-WP08: SRS scenario realization

- Depends on FRF-WP03 and FRF-WP06.
- Owns the existing SRS contract extension, parser, validator, architecture
  skills, and Elite composition mutations.

FRF-WP09: Development handoff and planning

- Depends on FRF-WP07 and FRF-WP08.
- Owns lifecycle mapping, DevelopmentCase, WorkItem bindings, planning gates,
  replan/adoption/settlement/verification preservation, and handoff tests.

FRF-WP10: Scenario, resilience, capsule, and project corpus

- Depends on FRF-WP04 through FRF-WP09.
- Extends the post-EK scenario engine and fault scheduler.
- Owns regenerated fixtures and capsules produced through public ingress.
- Does not create a second harness or write authority storage directly.

FRF-WP11: Package integration, deletion, CI, and docs

- Depends on FRF-WP04 through FRF-WP10.
- Coordinator-owned shared paths: installed package manifest, transition
  universe, proof claims, acceptance matrix, scripts, removal guards, current
  docs, and deletion patch.

FRF-WP12: Independent qualification and closure

- Depends on FRF-WP11.
- Uses a clean immutable build and fresh databases/repositories.
- Makes no production or test source edit while a qualification series is
  active.

## Phase FRF-0 - Prerequisite gate and post-EK baseline

- [ ] Verify the reviewed completion receipt and closure SHA for
      `CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`.
- [ ] Verify EK-13 completion, FINAL-RECEIPT, qualification source SHA, closure
      SHA, and executable-tree equality for
      `EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md`.
- [ ] Require `saga4` at the reviewed closure SHA and a clean worktree.
- [ ] Confirm no live Factory run, worker, watchdog, or qualification kit uses
      the target checkout, database, repository, package store, or `dist`.
- [ ] Create the successor integration branch and record its base SHA.
- [ ] Read the final post-EK canonical architecture and installed Formalization,
      Development, scenario-engine, role-contract, and context-envelope
      packages.
- [ ] Re-inventory all production and test paths. Current pre-EK file paths are
      evidence only and may not be assumed to survive WP-12.
- [ ] Capture installed package/module versions, digests, role contracts,
      schemas, graph, handlers, CheckPlans, resources, lifecycle mappings,
      Development handoff, capsules, and CI hosts.
- [ ] Run and record the post-EK clean baseline commands, including build,
      architecture, process modules, workflow model, workflow faults,
      development capsule, project corpus, acceptance matrix, and full suite.
- [ ] Classify every current Formalization test and fixture as retain, rewrite,
      regenerate, or delete.
- [ ] Produce a deletion manifest and intentional-difference ledger.

Exit:

- [ ] Both prerequisite plans are complete and the successor base is frozen.
- [ ] No implementation is based on deleted pre-EK paths.
- [ ] The current behavior and expected breaking changes are reproducible.

## Phase FRF-1 - Freeze independent graph and semantic specifications

- [ ] Author the forward transition and semantic graph from the exact Discovery
      handoff, desk contracts, and public commands only.
- [ ] Author the reverse graph from Solution Contract, DevelopmentCase, SRS
      realization, terminal evidence, and product verifier obligations only.
- [ ] Prevent either author from reading the other's result until both graph
      hashes are recorded.
- [ ] Reconcile the graphs and classify every non-empty difference.
- [ ] Freeze the eleven-node, eighteen-transition target universe.
- [ ] Freeze the semantic trace grammar and allowed direct-requirement
      dispositions.
- [ ] Freeze the concept budget and reject any unapproved new table, artifact
      family, authority owner, transition kind, or compatibility mode.
- [ ] Write independent invalid fixtures for every graph and semantic law.
- [ ] Record the specification digest and independent approval receipt.

Exit:

- [ ] Production implementation has not started.
- [ ] Target graphs, contracts, mutations, and concept budget are frozen.

## Phase FRF-2 - Land RED graph and contract tests

- [ ] Add a test-owned normative transition fixture independent from the
      production module declaration.
- [ ] Add exact node/edge equality, reachability, terminal predecessor, schema
      compatibility, package pinning, and old-node-removal assertions.
- [ ] Add RED source-to-intent, scenario, requirement, acceptance, freeze, SRS,
      and Development handoff fixtures.
- [ ] Add the old-order mutations: product Cell emits final requirements, UC
      covers pre-existing FR, requirements Cell bypass, and UC-to-acceptance
      shortcut.
- [ ] Add the Elite/simple-server composition mutations.
- [ ] Add authority mutations for latest, foreign run, decoy execution,
      contribution partition, and post-acceptance trace patching.
- [ ] Prove all new tests fail for the intended reason on the old semantic
      flow.
- [ ] Register test files in the blocking matrix before production code turns
      them green.

Exit:

- [ ] Expected failures are attributable to the old flow, not broken fixtures.
- [ ] No expected graph is generated from production code.

## Phase FRF-3 - Split product intent from final requirements

- [ ] Change the product Cell responsibility to brief plus PRD intent only.
- [ ] Add stable atomic intent members without adding a new artifact type.
- [ ] Bind every source scope item to intent, deferral, or out-of-scope
      disposition.
- [ ] Preserve constraint and unknown ownership from the exact Discovery
      handoff.
- [ ] Reject FR/NFR/RULE/UC/AC/SRS production in the product Cell CandidateSet.
- [ ] Update output contract, protocol, skill, checklist, reviewer, validator,
      CheckPlan, role contract, package resources, and focused tests.
- [ ] Bump semantic contract identity rather than silently changing old bytes.

Exit:

- [ ] Product intent is accepted without final FR/NFR/RULE artifacts.
- [ ] A dropped Discovery scope item is rejected or explicitly disposed.

## Phase FRF-4 - Make UC scenario-first

- [ ] Make the UC Cell consume exact accepted PRD intent material.
- [ ] Remove the precondition that FR artifacts already exist.
- [ ] Delete the `UC covers pre-existing FR` production rule and resource.
- [ ] Require actor, trigger, preconditions, main flow, alternate/error flows,
      and observable postcondition.
- [ ] Support human, operator, external-system, clock, and
      sensor/environment actors through one UC contract.
- [ ] Require every scenario-required intent member to have UC coverage.
- [ ] Permit direct requirements only through the frozen explicit disposition.
- [ ] Reject final requirements and AC artifacts produced by the UC Cell.
- [ ] Update protocols, skills, templates, reviewers, validators, package
      resources, and focused tests.

Exit:

- [ ] A meaningful UC set can be accepted before any final FR exists.
- [ ] Actorless and source-orphan scenarios are rejected.

## Phase FRF-5 - Add derive-system-requirements

- [ ] Add the new reviewed Cell after `model-use-cases`.
- [ ] Add its requirements bundle, role contract, skill, checklist, author
      CheckPlan, reviewer route, final gate, post-acceptance effect, package
      resources, and installed handler bindings.
- [ ] Produce only FR/NFR/RULE artifacts.
- [ ] Require scenario-derived FR to bind to exact PRD intent and UC branches.
- [ ] Permit cross-cutting NFR/RULE to bind directly to PRD intent or source
      constraints.
- [ ] Require every material UC system response to have a behavior obligation.
- [ ] Require every accepted UC to have at least one resulting FR or lawful
      supporting obligation.
- [ ] Reject orphan, duplicate, foreign, stale, cross-run, and unsupported
      requirements.
- [ ] Add author, reviewer, repair, feedback, exhaustion, crash, restart, and
      post-acceptance-effect tests for the sixth Cell.

Exit:

- [ ] Final system requirements are downstream of scenarios.
- [ ] The six-Cell flow is installed and exact graph tests are green.

## Phase FRF-6 - Refactor acceptance and immutable reconciliation

- [ ] Keep AC production after final requirements.
- [ ] Bind AC to exact FR/NFR and to exact UC terminal branches when
      scenario-facing.
- [ ] Require evidence type and observable terminal result.
- [ ] Rebuild forward and reverse closure over source, intent, scenario,
      requirements, acceptance, and evidence.
- [ ] Make reconciliation validation/report-only.
- [ ] Delete any ability of reconciliation to patch accepted traces or
      artifacts in place.
- [ ] Route lawful semantic repair to a new owning-cell revision and invalidate
      the downstream cone; otherwise emit inconsistent.
- [ ] Preserve constraint coverage and unknown dispositions.
- [ ] Reject every non-empty blocking graph difference rather than accepting a
      warning.
- [ ] Add one-edge-at-a-time and well-formed-unrelated-graph mutations.

Exit:

- [ ] The complete WHAT graph is closed in both directions.
- [ ] No accepted semantic authority is mutated by reconciliation.

## Phase FRF-7 - Replace the baseline and settlement authority

- [ ] Delete the acceptance-only baseline schema, handler, persistence, tests,
      fixtures, and current documentation.
- [ ] Implement the whole-WHAT baseline from exact accepted transition inputs.
- [ ] Bind source, production revision, CandidateSet, gate, container, atomic
      member, trace, disposition, and evidence identities and hashes.
- [ ] Compute one canonical whole-WHAT digest.
- [ ] Reject missing, extra, duplicate, stale, foreign, substituted, repartitioned,
      or drifted authority.
- [ ] Make architecture consume only the exact frozen baseline.
- [ ] Make settlement consume only the exact baseline and exact accepted SRS.
- [ ] Remove lifecycle/type/status/latest reselection and mutable-document
      reparsing after acceptance.
- [ ] Update persistence, package contracts, solution-contract construction,
      replay identity, and authority tests.
- [ ] Do not add v1 fallback, migration, backfill, dual read, or adapter.

Exit:

- [ ] Accepted UC and requirement material cannot disappear after freeze.
- [ ] ADR-053 authority and partition invariance remain blocking-green.

## Phase FRF-8 - Add SRS scenario realization

- [ ] Add one mandatory scenario-realization section to the existing SRS.
- [ ] Add a strict parser and validator for scenario identity, entry/trigger,
      modules, runtime edges, interfaces, composition owner, terminal result,
      and evidence binding.
- [ ] Require every frozen required UC exactly once.
- [ ] Reject extra, duplicate, stale, foreign, and disconnected scenarios.
- [ ] Preserve existing AC decomposition without treating it as scenario
      realization.
- [ ] Add interactive, API, batch, autonomous, and Elite fixtures.
- [ ] Kill missing bootstrap, controller edge, state-render edge, composition
      owner, terminal result, and verifier mutations.

Exit:

- [ ] A flat complete file list cannot pass as a connected product realization.
- [ ] Elite missing-composition defects are rejected before Development.

## Phase FRF-9 - Make Development consume scenarios

- [ ] Add required whole-WHAT, intent, UC, requirement, realization, terminal,
      and construction bindings to Solution Contract and DevelopmentCase.
- [ ] Update lifecycle mapping with exact byte-for-byte handoff tests.
- [ ] Update Development input validation and workspace preparation.
- [ ] Update task-graph planning so WorkItems preserve scenario and requirement
      identities in addition to AC identities.
- [ ] Permit typed integration, composition, and infrastructure obligations
      that are not one-to-one with AC.
- [ ] Reject AC-complete but scenario-incomplete task graphs.
- [ ] Update replan, adoption, settlement, verification, capsule, and recovery
      paths to preserve exact identities and hashes.
- [ ] Add omission, stale-reference, cross-run, disconnected-plan, and
      repartition tests.

Exit:

- [ ] Development deterministically consumes the scenario obligations.
- [ ] Scenario bindings are not optional metadata.

## Phase FRF-10 - Hard cutover, test rebuild, and legacy deletion

- [ ] Cut production Formalization to the new package and graph in one
      controlled landing.
- [ ] Delete old product semantics, UC-to-pre-existing-FR protocol, acceptance-
      only freeze, stale schemas, handlers, resources, prompts, templates,
      fixtures, comments, and current docs.
- [ ] Remove old node and contract identities from installed package manifests,
      proof claims, transition universes, lifecycle maps, and test drivers.
- [ ] Regenerate evidence and golden fixtures only through public production
      ingress.
- [ ] Build fresh capsules under the new package digest.
- [ ] Confirm old capsules miss safely and never select mixed authority.
- [ ] Extend the post-EK scenario engine, fault scheduler, model comparison, and
      minimizer; do not create a second harness.
- [ ] Update all six Cell author/reviewer/gate/effect/recovery coverage sets.
- [ ] Prove all eighteen process transitions by declared equals demonstrated.
- [ ] Host every test and driver in blocking CI with removal guards.
- [ ] Delete obsolete tests after their replacement invariant is blocking.
- [ ] Run static legacy-zero searches for old nodes, schemas, trace rules, and
      compatibility paths.

Exit:

- [ ] One Formalization protocol and one baseline authority remain.
- [ ] No test exists only to keep the old flow alive.
- [ ] The blocking matrix has no Formalization orphan or quarantine.

## Phase FRF-11 - Scripted qualification

- [ ] Freeze one clean source SHA, build digest, fresh schema fingerprint,
      package digests, role contracts, context contract, graph universe,
      scenario corpus, actor programs, and capsule manifest.
- [ ] Refuse qualification on dirty source, mismatched build, reused database,
      reused repository, stale capsule, or unhosted test.
- [ ] Run the interactive, API, batch, autonomous, and Elite-derived cases from
      fresh databases and repositories.
- [ ] Run cold cognition and warm capsule replay for every positive case.
- [ ] Run crash-before/crash-after schedules at every new acceptance, freeze,
      SRS, settlement, and handoff boundary.
- [ ] Run the complete post-EK scripted project corpus through the new
      Formalization package.
- [ ] Verify real product outputs appropriate to each project, not Factory
      status alone.
- [ ] Run the full blocking build, architecture, workflow model, workflow
      fault, process-module, Formalization, Development, capsule, project
      corpus, acceptance-matrix, legacy-zero, docs-current, and full-suite
      commands.
- [ ] Record exact counts, durations, normalized traces, mutation kill results,
      package/capsule identities, and evidence digests.

Exit:

- [ ] All scripted projects pass on one immutable build.
- [ ] All required mutations are killed by the expected first detector.
- [ ] Projection, restart, partition, and capsule behavior preserve the same
      semantic result.

## Phase FRF-12 - Real-agent qualification and closure

- [ ] Use the exact immutable kit that passed FRF-11.
- [ ] Route every worker through the repository OpenCode shim and pinned role
      and context contracts.
- [ ] Start every run from a fresh database and repository.
- [ ] Run three projects consecutively:
  - [ ] interactive Node/browser product with API and browser smoke;
  - [ ] external-system or batch product with retries and audit evidence;
  - [ ] autonomous/event-driven product with degraded and safe-failure paths.
- [ ] Require complete idea through local Delivery for every run.
- [ ] Require no operator repair, manual SQL, hot-swapped build, source edit,
      inherited database, stale process, or oracle weakening.
- [ ] Independently verify install, build, tests, start, public interaction,
      terminal evidence, and local delivery result.
- [ ] If any run fails, preserve evidence, add the smallest blocking regression,
      create a new immutable kit, and restart the series from run one.
- [ ] Re-run graph reconciliation, legacy-zero, test-hosting, mutation, and
      clean-worktree checks on the qualified SHA.
- [ ] Produce `FORMALIZATION-SCENARIO-FIRST-FINAL-RECEIPT.md` with prerequisite
      SHAs, qualification SHA/build, graph digests, test counts, mutation
      results, capsule identities, project results, and residuals.
- [ ] Merge only after independent review confirms every exit criterion.

Exit:

- [ ] Three consecutive real-agent projects pass on one immutable build.
- [ ] The qualified source and closure documentation differ only by explicitly
      allowlisted non-runtime files.
- [ ] `saga4` points at the reviewed closure SHA and the worktree is clean.

## Current reference seams to re-inventory after EK-13

These pre-EK paths identify responsibilities, not guaranteed post-EK file
locations:

```text
src/process-modules/modules/formalization/**
src/modules/formalization/domain/**
src/modules/formalization/application/**
src/modules/formalization/infrastructure/**
src/process-modules/lifecycles/product-delivery-lifecycle.ts
src/process-modules/lifecycles/product-documentation-lifecycle.ts
src/modules/development/domain/development-schemas.ts
src/modules/development/domain/development-task-graph.ts
src/modules/development/domain/development-settlement-policy.ts
src/modules/development/application/**
src/modules/development/infrastructure/**
tests/process-modules/formalization-*
tests/factory-proof/formalization-*
tests/factory-contract/**
tests/factory-evidence/formalization/**
tests/fixtures/golden-corpus/**
tools/run-acceptance-matrix.mjs
```

FRF-0 must replace this list with the installed post-EK path inventory before
any implementation assignment is issued.

## Standard agent work order

Every implementation assignment must include:

- exact base SHA and owned paths;
- prerequisite package and specification digests;
- explicit non-goals and forbidden paths;
- RED tests or mutations that define the change;
- focused verification commands;
- required evidence and completion receipt;
- prohibition on weakening validators, deleting tests before replacement,
  using old databases, adding compatibility behavior, or changing shared
  manifests outside coordinator ownership.

An implementer may not approve its own package. The independent verifier must
inspect production code, tests, mutations, authority selection, package
hosting, and deletion residue before the coordinator lands the package.

## Stop rules

- Stop if either prerequisite completion receipt is missing or inconsistent.
- Stop if Event Kernel qualification is still active or the target build is in
  use by a live Factory run.
- Stop if the post-EK path inventory contradicts this plan's assumed ownership
  boundaries; update and review the plan before code changes.
- Stop if the target requires a new mutable owner, table, scheduler, kernel
  transition kind, artifact family, or second test engine.
- Stop if reconciliation would need to mutate accepted material in place.
- Stop if the whole-WHAT baseline cannot be constructed from exact accepted
  transition bindings without reselection.
- Stop if a new test is unhosted, quarantined, self-derived from production
  output, or green before its intended production behavior exists.
- Stop if a compatibility adapter, migration, dual-read, dual-write, old-run
  adoption, or mixed capsule mode is proposed.
- Stop qualification on any source, test, build, schema, package, capsule, or
  oracle change; create a new immutable kit and restart the affected series.

## Definition of complete

- [ ] Both prerequisite plans have reviewed completion receipts.
- [ ] The successor uses the final post-EK architecture and paths.
- [ ] The target graph has exactly eleven nodes and eighteen transitions.
- [ ] Independent forward and reverse derivations are equal.
- [ ] Source, intent, scenario, requirements, acceptance, SRS realization, and
      Development handoff are content-addressed and closed in both directions.
- [ ] Reconciliation is report-only over accepted material.
- [ ] The whole-WHAT baseline is the only WHAT freeze authority.
- [ ] Formalization settlement performs no latest/status/type/chronology
      reselection of accepted material.
- [ ] Development planning consumes exact scenario and realization bindings.
- [ ] Elite missing-entrypoint and composition mutations are blocking-red.
- [ ] Interactive, API, batch, autonomous, and Elite-derived scripted cases
      pass from fresh databases and repositories.
- [ ] All six Cell resilience and temporal boundaries are demonstrated.
- [ ] Cold capsule production, warm replay, invalidation, and corruption paths
      pass through public ingress.
- [ ] Every new or retained Formalization test is blocking-hosted and removal-
      guarded.
- [ ] The complete post-EK scripted project corpus passes on one immutable
      build.
- [ ] Three diverse real-agent projects pass consecutively on that build.
- [ ] No old flow, old baseline, legacy resource, compatibility path, stale
      capsule, or obsolete current document remains reachable.
- [ ] The final receipt records exact SHAs, digests, commands, counts, mutation
      results, qualification results, and any truthful residual.
- [ ] `saga4` points at the reviewed closure SHA and the worktree is clean.

## Decision journal

Date: 2026-08-25.

Decision: use a scenario-first Formalization flow with one additional system-
requirements Cell, existing artifact types, a replacement whole-WHAT baseline,
SRS scenario realization, and mandatory Development scenario bindings.

Expected evidence after implementation:

- The Elite missing-bootstrap mutation is rejected before Development
  execution.
- No accepted UC disappears from the WHAT baseline or DevelopmentCase.
- Interactive and autonomous products use the same installed flow.
- Formalization adds one Production Cell and no kernel mechanism or table.
- The new flow remains inside the post-EK complexity budget.

Review trigger: FRF-11 scripted qualification and FRF-12 real-agent closure.

Kill criterion: if an AC-complete product with a missing entrypoint,
composition edge, or scenario handoff can reach Development execution, this
design has not fixed the architectural defect and must not be closed.
