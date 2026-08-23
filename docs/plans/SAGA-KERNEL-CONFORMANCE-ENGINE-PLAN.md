# Saga Kernel Conformance Engine Execution Plan

- Status: Proposed
- Date: 2026-08-21
- Scope: Workplace lifecycle, material authority, tools, hooks, review, gates,
  effects, routing, recovery, and cross-workshop conformance
- Primary decision: ADR-084
- Coordinating decision: ADR-085
- Coordinating proposal: ADR-086
- Detailed implementation briefs: `docs/testing/CAUSAL-PROOF-IMPLEMENTATION-BRIEFS.md`

## 1. Purpose

Build one reusable test engine for the Saga production kernel. The engine must
accept scenario packs from any admitted workshop, drive the real Factory
runtime, inject bounded faults, observe durable evidence, and evaluate
independent expected properties.

The engine is not a new runtime. It must not implement a second dispatcher,
Workplace reducer, Gate, recovery planner, effect runner, lifecycle router, or
material authority model.

The engine replaces only:

1. model cognition, through a constrained scripted actor at the production
   worker spawn boundary; and
2. explicitly declared external-world providers where deterministic control is
   required.

All authoritative transitions remain production transitions.

## 2. Required outcome

The completed system must support this workflow:

```text
installed workshop package and lifecycle
  + scenario pack
  + scripted actor programs
  + bounded fault schedule
  + independent obligation contracts
                         |
                         v
              canonical Factory runtime
                         |
                         v
             read-only durable observation
                         |
                         v
       invariant, causality, progress, and S oracles
                         |
                         v
               ScenarioEvidenceBundle
```

A new built-in workshop is conformant when it can run the generic corpus by
adding only:

- its production package and lifecycle declarations;
- valid and invalid product fixtures;
- role-specific actor programs;
- external-provider fixtures; and
- genuinely workshop-specific semantic predicates.

The test engine itself must not change for the new workshop.

## 3. Source-of-truth hierarchy

Agents must read these documents before implementation:

1. `AGENTS.md`
2. `GUARDRAILS.md`
3. `docs/architecture/CONVEYOR-MENTAL-MODEL.md`
4. `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`
5. `docs/architecture/CONVEYOR-TRANSITION-CHECKLIST.md`
6. `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
7. `docs/architecture/decisions/084-causal-conformance-proof-kernel.md`
8. `docs/architecture/decisions/085-co-locate-workshops-before-opening-admission.md`
9. `docs/architecture/decisions/086-atomic-greenfield-authority-cutover.md`,
   when that proposal is present in the active branch
10. `docs/testing/GRAPH-TEST-STRATEGY.md`
11. `docs/testing/CAUSAL-PROOF-IMPLEMENTATION-BRIEFS.md`
12. `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md`
13. `tests/factory-proof/MIGRATION-MAP.md`
14. `docs/architecture/decisions/090-idea-authority-conservation.md`, when
    any Idea Authority Conservation packet (CC-IC-1..4 in
    `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` §7A) is active

If this plan conflicts with an accepted ADR, the ADR wins. Update this plan in
the same change that resolves the conflict.

## 4. Non-negotiable architecture rules

- [ ] There is one production interface, one material, one desk, and one
      Factory runtime.
- [ ] Workplace owns logical work and mutable material across attempts.
- [ ] WorkerExecution owns only a fenced attempt and its provenance.
- [ ] CandidateSet binds one exact immutable WorkplaceProductionRevision.
- [ ] Gate, effect, final acceptance, and downstream product preserve exact
      accepted-material authority.
- [ ] Review is an optional Production Cell role, not a separate engine.
- [ ] Tool authorization is enforced by the production tool gateway.
- [ ] Hooks provide context and telemetry but never transition authority.
- [ ] Scripted actors replace cognition only.
- [ ] Test observers are read-only and never create authoritative records.
- [ ] Test expectations are not generated from the production validator that
      they are intended to verify.
- [ ] Every proof reports the exact L0-L5/S claims it exercised.
- [ ] No fast or partial-composition test may claim strict L3, L4, or L5.
- [ ] No core test-engine branch may depend on workshop name, moduleRef, or a
      hard-coded role profession.
- [ ] Generic package admission remains closed until a separate C12 decision.

## 5. Universal kernel under test

The conformance engine treats the following chain as the universal Saga
kernel:

```text
WorkIntent
  -> Workplace
  -> WorkerExecution and fence
  -> RepositoryDesk and authorized tools
  -> WorkplaceProductionRevision
  -> CandidateSet
  -> author Gate
  -> optional reviewer execution and reviewer CandidateSet
  -> final Gate
  -> RecoveryIssue or required effect
  -> effect receipt
  -> CellFinalAcceptance
  -> lifecycle routing
```

Universal mechanisms:

- Workplace state, role, loop, revision, and recovery budgets;
- execution reservation, lease, fencing, completion, and replay;
- material revision sealing and contribution provenance;
- CandidateSet, GateRun, GateDecision, and exact subject binding;
- author/reviewer protocol and feedback delivery;
- tool catalog projection, authorization, invocation, and receipts;
- hook context projection, deduplication, isolation, and failure behavior;
- effects, observations, idempotency, and settlement;
- transition obligations, lifecycle routing, and progress classification;
- projection rebuild and durable recovery.

Workshop-owned declarations and adapters:

- input and output payload schemas;
- Production Cell topology;
- author and reviewer profiles;
- CheckPlans and check providers;
- effect implementations;
- workshop tools and hook projections;
- lifecycle routes and semantic product predicates;
- conformance fixtures and actor programs.

## 6. Proof modes

Every scenario result must declare one or more exact proof modes.

| Mode | Purpose | Allowed substitutions | Prohibited claim |
|---|---|---|---|
| Contract | L0 schema, vocabulary, digest, and binding closure | none beyond fixtures | runtime behavior |
| Model | L1 bounded transition and relational exploration | scheduler and generated commands | production composition |
| Durable | L2 SQLite, CAS, fence, idempotency, and atomicity | deterministic clock and IDs | host scheduling |
| Canonical fast | fast composition diagnostics through the current in-process actor | inference/executor test seam | strict physical L3 |
| Canonical spawn | strict L3 through the production workerSpawn boundary | cognition only | third-party CLI hook integration unless exercised |
| Fault schedule | L4 named crash/interleaving scenarios followed by fair drain | cognition and declared external ports | unbounded liveness |
| Product | L5 fresh project and installed lifecycle | scripted cognition; declared sandbox providers | real-model behavior |
| Canary | monitored real opencode worker | controlled test input only | deterministic exhaustive proof |
| S | finite satisfiability of declared conjunctions | explicit semantic unknowns | general semantic completeness |

The existing in-process WorkerExecutorFactory seam remains useful for fast
diagnostics, but it cannot prove the physical runner, workspace, MCP transport,
tool listing, permissions, hooks, or process lifecycle.

## 7. Scenario contract

### 7.1 Top-level shape

The final schema should be equivalent to:

```yaml
schemaVersion: saga.kernel-scenario.v1
id: development-review-repair

subject:
  lifecycleRef: standard
  installationDigest: sha256:...
  selector:
    moduleRef: development
    cellId: implementation

claims: [L3, L4, S]

bootstrap:
  projectFixture: fixture://project/minimal
  lifecycleInput: fixture://input/change-request
  externalWorld: fixture://world/delivery-sandbox

actors:
  - selector: { role: author }
    program: actor://implementation/invalid-then-feedback-repair
  - selector: { role: reviewer }
    program: actor://review/reject-missing-test-once

schedule:
  seed: 91723
  hostCycleBudget: 40
  fairDrain: every-runnable-obligation

faults:
  - boundary: candidate-set.sealed
    occurrence: 1
    action: restart-host

expect:
  allowedTerminalOutcomes: [accepted]
  invariants:
    - authority-conservation
    - same-workplace-across-repair
    - exact-feedback-caused-repair
    - no-stranded-work
```

### 7.2 DSL restrictions

- [ ] Scenario steps command the host, actor, clock, or external environment.
- [ ] Scenario steps do not inject synthetic reducer events.
- [ ] Scenario steps do not write authority tables.
- [ ] Scenario expectations state relations and outcomes, not generated IDs,
      timestamps, row order, or implementation-specific call counts.
- [ ] Scenario selection uses installed identities, stable cell IDs, roles, and
      product contracts, not workshop-specific engine branches.
- [ ] Faults target named causal boundaries or external processes, not arbitrary
      database corruption.
- [ ] Liveness assertions include a bounded unfair/fault prefix followed by an
      explicit fair-drain suffix.

### 7.3 Scripted actor contract

Allowed actor inputs:

- WorkIntent;
- prompt and declared role context;
- desk manifest and files visible in the assigned workspace;
- effective tool catalog;
- tool results and receipts;
- hook-delivered context;
- exact RecoveryIssue and review feedback.

Forbidden actor inputs:

- scenario ID;
- raw attempt number;
- hidden database state;
- expected terminal outcome;
- global invocation count used as business logic;
- direct access to transition handlers;
- direct access to finalizers or repositories.

Required actor evidence:

- [ ] Record `visibleInputDigest -> actorOutputDigest` for every invocation.
- [ ] Record every tool call and returned receipt visible to the actor.
- [ ] Record the exact feedback nonce or digest visible before repair.
- [ ] Make actor programs content-addressed and deterministic for a fixed input.
- [ ] Reject actor programs that import production repositories or test DB
      helpers.

### 7.4 Scenario evidence bundle

Every execution returns an immutable evidence bundle containing:

- scenario, schema, fixture, actor, and provider digests;
- canonical composition and installation fingerprints;
- exact proof-mode claims;
- normalized durable trace with raw evidence references;
- actor visible-input and output digests;
- external-world journal;
- fault injection and restart receipts;
- final durable snapshot summary;
- invariant results;
- progress explanations for all nonterminal scopes;
- mutation coverage and killed/surviving mutant IDs;
- minimized counterexample when a property fails.

## 8. Independent oracle model

Every strict proof reconciles three independent sources:

1. versioned AcceptanceObligationContracts;
2. installed production protections and bindings; and
3. observed durable and external-world facts.

The obligation registry must not be generated from installed CheckPlans or the
validator implementation. Installed protections are compared against the
registry using exact set equality.

Required generic properties:

- [ ] Authority conservation.
- [ ] Contribution partition invariance.
- [ ] Representation normalization.
- [ ] Cardinality conservation.
- [ ] Exact-reference substitution rejection.
- [ ] Recency non-interference.
- [ ] Atomic revision and CandidateSet sealing.
- [ ] Stale-fence refusal.
- [ ] Duplicate/redrive idempotency.
- [ ] Composition parity across host, worker MCP, and scripted worker.
- [ ] Denied tools never invoke handlers.
- [ ] Hook context never crosses execution identity.
- [ ] Exact feedback can cause repair.
- [ ] Missing, stale, or corrupt feedback cannot cause the same repair.
- [ ] Replan adoption removes superseded work from dispatch eligibility.
- [ ] Projection rebuild preserves authority and progress.
- [ ] Every nonterminal scope has a live owner, runnable command, typed wait,
      or transition due.
- [ ] Idea authority conservation: every non-empty register line is covered,
      dispositioned, or typed-waived; open-question entries reach resolved,
      deferred (reason, owner, and unblock criterion) — on v2 registers the
      waiver state is TYPED UNAVAILABLE (2026-08-23 waiver-authority
      decision, LANDED at `906edf84`: every v2 `waived` record, any shape
      including a perfectly shaped operator-attribution fake, is the
      `WAIVER_UNAVAILABLE` typed red, never enters `waivedIds`, and never
      subtracts, so the v2 required set is the FULL register —
      register ⊆ covered; the v1 frozen reasoned-waiver semantics remain);
      and every qualitative/experience entry
      carries a measurable interpretation or typed deferral;
      runnable-local synthesis and ordered-smoke obligations are injected
      deterministically at Discovery settlement — never inferred from prose;
      null-binding grandfathering applies only to frozen legacy v1 data,
      every new v2 Factory Start carries non-null typed authority (a built
      register or an explicit typed no-obligations attestation), and
      continuations inherit the original register ref (ADR-090).
- [ ] Requirements-to-result translation conservation (Space E maintenance,
      2026-08-23, LANDED at `905f5940` with the constraint-loss matrix
      13/13): three domain-free seams of translating requirements into
      plans/tasks/results for ANY product are honestly recorded as OPEN
      findings in `tests/matrix/e-constraint-loss.test.mjs` (they are not
      the Elite browser-game special case and are not solved by CC-U1,
      which owns planning-graph completeness — these seams live at other
      translation boundaries): (E-F2) the reverse orphan detector for
      plain FR/NFR requirements exists but production never requests
      reconciliation (`findContractGap({reconciliation:true})` is passed
      by no wired call site; RULE artifacts are excluded from the orphan
      check); (E-F3) the implementation result does not mechanically
      bind/echo the card's acceptance-criterion and covered constraint
      set, so a criterion-blind first attempt can pass the implementation
      gate; (E-F4, split residual) file-claim narrowing is caught by the
      landed claim-monotonicity ratchet, but criterion-level silent
      surrender after a scope-fence rejection, a free-text `droppedFiles`
      reason without criterion authority, and the criterion-blind first
      attempt remain open. Fixes extend the existing gates and result
      contracts — never a parallel vocabulary.

## 9. Generic scenario corpus

Each admitted workshop must bind fixtures and actors for every applicable
generic scenario.

### Core lifecycle

- [ ] Happy author acceptance.
- [ ] Author Gate rejection followed by same-Workplace repair.
- [ ] Reviewer rejection followed by same-Workplace repair.
- [ ] Invalid reviewer output.
- [ ] Human-required terminal outcome.
- [ ] Failed terminal outcome.
- [ ] Fan-out and fan-in where declared.
- [ ] Exact downstream handoff.

### Authority and isolation

- [ ] Stale WorkerExecution attempts publication.
- [ ] Foreign CandidateSet is substituted.
- [ ] New unrelated execution appears after accepted material is sealed.
- [ ] Contributions are split, merged, or reordered without semantic change.
- [ ] Reviewer references a stale or foreign author CandidateSet.
- [ ] Replan creates a new Workplace and supersedes the old dispatch target.

### Tools and hooks

- [ ] Allowed tool succeeds through the production gateway.
- [ ] Denied tool never reaches its handler.
- [ ] Post-completion tool call is refused except for the declared completion
      command.
- [ ] Tool receipt survives restart and redrive.
- [ ] Hook context is bounded and deduplicated.
- [ ] Hook state is isolated by execution.
- [ ] Hook failure degrades without changing authority.

### Durability and recovery

- [ ] Duplicate delivery.
- [ ] Lease loss and stale fence.
- [ ] Concurrent claim.
- [ ] Host restart after every named durable boundary.
- [ ] Worker exit before completion.
- [ ] Effect succeeds externally but receipt persistence is uncertain.
- [ ] Projection rebuild from authoritative records.
- [ ] Same-project Factory Start A to new Factory Start B.

### Satisfiability

- [ ] Required artifact lies outside allowed scope.
- [ ] Required tool is absent from the effective profile.
- [ ] Output schema cannot satisfy downstream input.
- [ ] Required check or effect provider is unbound or untrusted.
- [ ] Outcome routing is incomplete.
- [ ] Review and acceptance obligations are contradictory.
- [ ] Semantic-open requirements return `open` or `unknown`, never optimistic
      success.

## 10. Named fault boundaries

The initial strict fault vocabulary is:

1. before Product persistence;
2. after Product persistence and before ProductionRevision sealing;
3. after ProductionRevision sealing and before CandidateSet sealing;
4. after CandidateSet sealing and before CheckReceipt;
5. after CheckReceipt and before GateDecision;
6. after GateDecision and before feedback or effect obligation;
7. after external effect and before durable effect receipt;
8. after effect receipt and before source transition;
9. after final acceptance and before lifecycle routing;
10. after route obligation creation and before downstream adoption.

For each supported boundary:

- [ ] Run crash-before.
- [ ] Run crash-after.
- [ ] Restart from the same durable store.
- [ ] Redrive enabled work under fair scheduling.
- [ ] Assert no repeated accepted material or non-idempotent effect.
- [ ] Assert a terminal outcome, typed wait, or bounded incident.

Named failpoints may observe and terminate. They may not fabricate authority,
decisions, receipts, or repair ownership.

## 11. Execution strategy

### Stage K0 - Baseline, claim discipline, and refactor bridge

Goal: establish a non-vacuous baseline before either the proof-kernel work or
the ADR-085 co-location work changes composition.

Checklist:

- [ ] Inventory every current Factory test composition and its override surface.
- [ ] Classify every existing suite by exact L0-L5/S claims.
- [ ] Record quarantined, flaky, non-blocking, and blocking status.
- [ ] Freeze current scenario, transition-edge, gate-family, and mutation floors.
- [ ] Define the normalized authority-trace schema.
- [ ] Export canonical definition, installation, binding, and composition
      fingerprints for all built-ins.
- [ ] Capture pre-co-location normalized traces on disposable fixtures.
- [ ] Prove observer non-vacuity by mutating one item in each evidence class.
- [ ] Add a machine-readable coverage map from legacy suites to obligations.

Exit gate:

- [ ] Every existing proof claim has an owner and a replacement destination.
- [ ] The semantic ignore list contains only generated IDs, timestamps,
      absolute paths, and database row IDs.
- [ ] The ADR-085 baseline can be reproduced from a clean checkout.

Parallel decomposition:

- K0-A: suite and composition inventory;
- K0-B: normalized trace schema and read-only extractor;
- K0-C: scenario and edge floors;
- K0-D: baseline fingerprint capture and mutant self-tests.

Integration constraint: K0-B owns the trace vocabulary. Other agents may
propose fields but must not create competing trace formats.

### Stage K1 - Canonical composition hardening

Goal: finish W0-1 as a truthful single composition surface.

Checklist:

- [ ] Keep `tests/factory-proof/canonical-proof-composition.mjs` as the only new
      causal-proof entrypoint.
- [ ] Preserve a closed override allowlist and record the actual override
      fingerprint on every run.
- [ ] Migrate one happy scenario from the existing W9/fresh harness.
- [ ] Migrate one reject-to-repair scenario.
- [ ] Label the current in-process WorkerExecutorFactory path as partial
      composition rather than strict L3.
- [ ] Prevent new proof tests from importing legacy composition surfaces.
- [ ] Keep legacy suites until every obligation has a blocking replacement.
- [ ] Fingerprint the current canonical built-in workshop composition
      without depending on the future ADR-085 catalog layout.

Exit gate:

- [ ] One entrypoint drives all new causal proofs.
- [ ] Composition fingerprints detect a removed or replaced production module.
- [ ] Happy and repair scenarios generate authority rows through production
      handlers rather than direct test writes.
- [ ] No proof is silently upgraded from partial composition to strict L3.

Parallel decomposition:

- K1-A: override fingerprint and import ratchet;
- K1-B: happy scenario migration;
- K1-C: reject-to-repair migration;
- K1-D: proof-claim metadata and reporting.

Integration constraint: only one agent may edit the canonical composition
adapter at a time.

### Stage K2 - Narrow spawned actor seam

Goal: preserve the production runner and replace only model cognition.

Checklist:

- [ ] Route strict L3 scenarios through
      `FactoryCompositionOverrides.workerSpawn`.
- [ ] Implement a deterministic scripted child process.
- [ ] Preserve the production spawn envelope, prompt, pinned workspace, MCP
      config, tool permissions, hook settings, heartbeat, exit classification,
      finalization, and recovery behavior.
- [ ] Make the child call actual MCP tools and the normal completion command.
- [ ] Deny direct repository, finalizer, transition-handler, and SQLite access.
- [ ] Validate actor input against the production-visible-input schema.
- [ ] Record visible-input and output digests.
- [ ] Add absent, stale, corrupt, and exact-feedback actor counterfactuals.
- [ ] Retain the in-process actor only as an explicitly lower-fidelity fast lane.

Exit gate:

- [ ] A strict L3 happy scenario passes through workerSpawn.
- [ ] A strict L3 repair scenario succeeds only with exact feedback.
- [ ] Removing tool permission or MCP configuration makes the strict scenario
      fail before the handler is invoked.
- [ ] The actor cannot determine repair behavior from attempt number or hidden
      state.

Parallel decomposition:

- K2-A: scripted child process and spawn protocol;
- K2-B: production-visible actor input schema;
- K2-C: actor security/import ratchets;
- K2-D: feedback counterfactual fixtures.

Integration constraint: K2-A owns runner/spawn changes; K2-B through K2-D
should remain test-side until the interface is agreed.

### Stage K3 - Independent obligation compiler

Goal: implement W0-2 without circular expectations.

Checklist:

- [ ] Define versioned AcceptanceObligationContract schemas.
- [ ] Store obligation contracts independently of production CheckPlans and
      validator implementations.
- [ ] Define exact detector, reason, evidence, owner, frontier, invalidation,
      budget, and repair fields.
- [ ] Compile relational mutant families from obligation contracts.
- [ ] Compare normative obligations with installed protections using exact set
      equality.
- [ ] Fail on missing protection, extra undeclared protection, missing mutant
      operator, or missing causal representative.
- [ ] Add authority, representation, cardinality, temporal, feedback, tool,
      hook, and S mutant families.
- [ ] Generate stable mutant IDs and coverage reports.
- [ ] Add self-mutations that remove one obligation, detector, operator, and
      installed protection.

Exit gate:

- [ ] Deleting a production protection does not delete the expected obligation.
- [ ] Deleting an obligation or mutant operator makes registry closure fail.
- [ ] Every P0 obligation has a generated mutant family and a named causal
      representative class.
- [ ] Compiler output is deterministic for a fixed registry version.

Parallel decomposition:

- K3-A: contract schema and registry loader;
- K3-B: mutation algebra;
- K3-C: installed-protection projection;
- K3-D: set-equality and non-vacuity ratchets.

Integration constraint: K3-A owns the schema. Mutation families may be added in
parallel only after the schema is frozen for the stage.

### Stage K4 - Scenario DSL, observer, and counterexample engine

Goal: implement W0-3 over the canonical composition and independent registry.

Checklist:

- [ ] Implement the descriptive scenario schema.
- [ ] Implement installed-workshop scenario binding without workshop-name
      switches.
- [ ] Implement a read-only durable trace observer.
- [ ] Record evidence source and confidence for reconstructed landmarks.
- [ ] Implement bounded host-cycle scheduling and explicit fair drain.
- [ ] Implement named fault scheduling.
- [ ] Implement temporal and relational assertions.
- [ ] Implement feedback counterfactual execution.
- [ ] Implement progress classification and stranded-work diagnostics.
- [ ] Implement hierarchical counterexample minimization.
- [ ] Persist normalized regression fixtures without UUIDs, timestamps, or
      machine-local paths.
- [ ] Emit ScenarioEvidenceBundle.

Exit gate:

- [ ] The observer imports no reducer and writes no production table.
- [ ] The DSL cannot prescribe GateDecision, repair owner, or runtime transition.
- [ ] A failing generated scenario produces a deterministic minimized replay.
- [ ] Exact-feedback and missing/stale/corrupt counterfactuals differ for the
      expected causal reason.
- [ ] Every nonterminal final snapshot has an explicit progress explanation.

Parallel decomposition:

- K4-A: schema and binding compiler;
- K4-B: trace observer and evidence provenance;
- K4-C: scheduler and fault vocabulary;
- K4-D: assertion library and progress oracle;
- K4-E: minimizer and fixture serializer.

Integration constraint: K4-B owns normalized observations; K4-C may schedule
only commands exposed by production/test host ports and may not add authority
writes.

### Stage K5 - Blocking proof group and mutation ratchets

Goal: implement W0-4 and make the kernel an acceptance gate.

Checklist:

- [ ] Add a non-empty `factory-proof` acceptance-matrix group.
- [ ] Add an exact file-set coverage test for the group.
- [ ] Make canonical strict happy and feedback-driven repair blocking.
- [ ] Make obligation closure and mutation self-tests blocking.
- [ ] Make progress-oracle and counterfactual self-tests blocking.
- [ ] Add deterministic time, cycle, and scenario-count budgets.
- [ ] Separate quarantined legacy suites from blocking evidence.
- [ ] Publish exact claim and coverage summaries in test output.
- [ ] Keep concurrency at one where shared SQLite/process behavior requires it.

Exit gate:

- [ ] `--group factory-proof` executes a non-zero exact file set.
- [ ] Every kernel self-mutation makes the group red.
- [ ] A vacuous empty scenario pack makes the group red.
- [ ] The group is deterministic across repeated clean runs.

Parallel decomposition:

- K5-A: acceptance-matrix registration and coverage ratchet;
- K5-B: strict happy blocking pack;
- K5-C: strict repair blocking pack;
- K5-D: deterministic budgets and reporting.

Integration constraint: one agent owns `tools/run-acceptance-matrix.mjs` and its
coverage test.

### Stage K6 - P0 causal vertical proofs

Goal: complete W1-1 through W1-4 over the blocking proof kernel.

Required sequence:

1. W1-1: fabricated derived evidence;
2. W1-2: real Factory Start A to new Factory Start B;
3. W1-3: authorized Delivery through `released`;
4. W1-4: two Formalization lifecycles on one epic.

Checklist for every vertical proof:

- [ ] Declare the independent normative obligation.
- [ ] Generate and kill the structural mutant family.
- [ ] Run one full causal representative through canonical spawn composition.
- [ ] Record fault origin, detector, exact evidence, repair owner, feedback,
      minimal frontier, invalidation cone, regenerated suffix, and outcome.
- [ ] Run exact/absent/stale/corrupt feedback counterfactuals where repair is
      expected.
- [ ] Observe the final product or external state independently.
- [ ] Assert bounded progress and no stranded work.
- [ ] Add the proof to the blocking group only after repeated deterministic
      runs.

Exit gate:

- [ ] W1-1 through W1-4 pass through canonical production composition.
- [ ] No proof depends on a test-only authority write or trusting provider.
- [ ] Every proof has a mutation witness and causal trace.
- [ ] Delivery claims include independent external observation.

Parallel decomposition:

- W1-2, W1-3, and W1-4 may run in parallel after W1-1 validates the complete
  vertical pattern.
- Each vertical owns its scenario pack and obligation entries.
- Shared DSL, trace, scheduler, and assertion changes require integration-owner
  approval and separate commits.

### Stage K7 - Bounded explorer and systematic generated coverage

Goal: use cheap exploration to discover short local counterexamples without
creating a second runtime.

Checklist:

- [ ] Model Workplace/material, execution/engine, and lifecycle/pipeline as
      three orthogonal bounded machines.
- [ ] Use production reducers and repositories as the system under test.
- [ ] Keep an independent small relational expectation ledger.
- [ ] Generate legal and adversarial command classes.
- [ ] Normalize refs as exact, stale, foreign, missing, and newer.
- [ ] Bound Workplaces, executions, revisions, repair attempts, and topology.
- [ ] Use breadth-first search for shortest safety failures.
- [ ] Add seeded random walks for deeper interleavings.
- [ ] Apply partial-order reduction only where independence is proven.
- [ ] Minimize failing traces.
- [ ] Replay promoted traces through L2 and selected L3/L4 adapters.
- [ ] Label explorer-only results as L1/L2.

Exit gate:

- [ ] Every closed event vocabulary entry is either generated or explicitly
      excluded with a reason.
- [ ] Known authority, fence, and replan-adoption mutants are discovered.
- [ ] Minimized traces replay deterministically.
- [ ] No explorer decision is written back as production routing or recovery
      authority.

Parallel decomposition:

- K7-A: command and observation vocabulary;
- K7-B: deterministic explorer;
- K7-C: generators and shrinkers;
- K7-D: L2/L3 replay adapters;
- K7-E: coverage and event-vocabulary ratchets.

### Stage K8 - Cross-workshop universality and steady-state operation

Goal: prove that the kernel supports any admitted workshop without engine
changes.

Checklist:

- [ ] Generalize fresh bootstrap to caller-supplied admitted installation and
      lifecycle definitions through production APIs.
- [ ] Run the generic corpus for Discovery, Formalization, Development, and
      Delivery.
- [ ] Run the same corpus against a synthetic workshop fixture without changing
      engine code.
- [ ] Verify closed-catalog removal makes a workshop unavailable everywhere.
- [ ] Verify orchestrator, worker MCP, and scripted actor resolve identical
      binding receipts.
- [ ] Verify module-owned conformance scenarios are discoverable from the
      canonical workshop descriptor.
- [ ] Run fresh scripted happy and repair L5 scenarios.
- [ ] Run one monitored happy-path and one monitored repair-path real-model
      canary through the opencode worker route.
- [ ] Establish coverage, runtime, and flake budgets for steady-state CI.
- [ ] Retire legacy suites only after obligation mapping and blocking replacement
      are complete.

Exit gate:

- [ ] A synthetic workshop requires only package, lifecycle, fixtures, actors,
      and semantic predicates.
- [ ] No universal runtime or test-engine file changes for the synthetic
      workshop.
- [ ] All W0 and P0 W1 proofs remain blocking and green.
- [ ] Real-model canaries are monitored evidence, not deterministic gate
      substitutes.

## 12. Structural refactor prerequisite and later coordination

The proof kernel runs first. ADR-085 workshop co-location and ADR-086 structural
cleanup remain blocked until the Structural Refactor Qualification Gate below
is green. They do not run as parallel implementation tracks.

### Structural Refactor Qualification Gate

- [ ] K0 through K5 exit gates are complete.
- [ ] The blocking `factory-proof` group includes a strict full-lifecycle happy
      scenario through `workerSpawn`.
- [ ] The blocking group includes a strict feedback-driven same-Workplace
      repair scenario.
- [ ] Named fault boundaries affected by the planned refactor are blocking.
- [ ] Base and candidate revisions can be executed separately and compared
      through the normalized authority trace.
- [ ] Composition removal, lifecycle bypass, missing fence/receipt/effect and
      route omission mutants make the group red.
- [ ] The observer and scenario engine make no authoritative writes.
- [ ] A clean-checkout command for the complete gate is documented and passes.

Before this gate is green, agents may inventory and document ADR-085/086 work,
but may not move workshop/runtime files or introduce target compatibility
facades.

### Before ADR-085 P1/P2 cutover

- [ ] The Structural Refactor Qualification Gate is green.
- [ ] Freeze scenario/count/edge floors.
- [ ] Capture pre-cutover evidence on the base revision.

### During ADR-085 P1/P2

- [ ] Keep proof-kernel semantics unchanged while workshop files move.
- [ ] Make canonical composition consume the new closed built-in catalog.
- [ ] Do not add a shadow binder, compatibility runtime, or second scenario
      engine.
- [ ] Update only package-relative fixture/resource locations where required.

### For ADR-085 P3 equivalence

- [ ] Use the K0/K4 normalized authority trace vocabulary.
- [ ] Compare base and candidate revisions in isolated disposable environments.
- [ ] Require zero semantic diff across happy, repair, outcomes, handoffs,
      restart, crash boundaries, and second-run scenarios.

### For ADR-085 P4/P5 closure

- [ ] Require W0-1 through W0-4 or an explicitly documented temporary gate
      equivalent.
- [ ] Require non-vacuity mutations and coverage floors.
- [ ] Require the synthetic-workshop conformance fixture.
- [ ] Keep package admission closed; conformance is not admission authority.

### Coordination with the proposed ADR-086 authority cutover

If ADR-086 is adopted, the proof kernel is the evidence rail for the atomic
schema, lifecycle, tool, and composition cutover. It is not a later cleanup.

- [ ] Require the Structural Refactor Qualification Gate before the authority
      cutover changes canonical construction.
- [ ] Express the strict actor seam as an immutable composition contract rather
      than depending on the current composition-root file location.
- [ ] Remove test dependence on mutable `lastFactory*` accessors when the
      canonical composition becomes an injected immutable object.
- [ ] Give CLI, MCP, worker, and scripted scenarios the same composition object
      and compare their fingerprints.
- [ ] Keep lifecycle commands and tool calls as adapters over production
      application ports; do not preserve dispatcher-owned SQL for tests.
- [ ] Compare the base and candidate authority graphs in isolated disposable
      environments before the atomic merge.
- [ ] Do not declare any intermediate authority packet a supported topology.
- [ ] Do not create a compatibility harness for the pre-cutover authority graph.
- [ ] Update test paths and imports only after the new single composition is
      available; preserve scenario and obligation identities.
- [ ] Require zero legacy authority entrypoints at the shared merge gate.

## 13. Agent and subagent execution model

### 13.1 Integration owner

One primary agent owns:

- stage sequencing and gate decisions;
- shared schema approval;
- canonical composition changes;
- acceptance-matrix changes;
- conflict resolution;
- final verification and evidence report.

Subagents must not independently merge competing versions of shared contracts.

### 13.2 Subagent task contract

Every delegated task must include:

- one bounded work-package ID;
- exact objective and explicit non-goals;
- authoritative files to read;
- files the subagent owns;
- files it may inspect but not edit;
- expected tests or read-only evidence;
- required output format;
- dependency and merge assumptions.

Every subagent returns:

1. result summary;
2. files changed;
3. tests executed and exact outcomes;
4. unresolved risks;
5. assumptions made;
6. follow-up work that is outside its scope.

### 13.3 Safe parallelization rules

- [ ] Parallelize independent scenario packs, mutant families, fixtures, and
      read-only inventories.
- [ ] Do not parallel-edit the canonical composition adapter.
- [ ] Do not parallel-edit the scenario schema before it is frozen.
- [ ] Do not parallel-edit the trace vocabulary or acceptance-matrix registry.
- [ ] Assign one owner to production runner/spawn changes.
- [ ] Keep actor programs separate from oracle implementations.
- [ ] Keep observer work separate from production repository writes.
- [ ] Rebase or reconcile before running shared integration gates.

### 13.4 Recommended work waves

Wave 0:

- K0-A, K0-B, K0-C, and K0-D in parallel.

Wave 1:

- K1-A through K1-D, with one canonical-composition owner.
- K3-A schema design may proceed read-only, but implementation waits for the
  K1 composition claim boundary.

Wave 2:

- K2 actor seam and K3 obligation compiler in parallel.
- Their shared merge gate is production-visible actor input plus independent
  obligation identity.

Wave 3:

- K4-A through K4-E after schema ownership is assigned.

Wave 4:

- K5-A through K5-D.

Wave 5:

- W1-1 first as the reference vertical.
- W1-2, W1-3, and W1-4 in parallel after W1-1.

Wave 6:

- K7 explorer families and K8 workshop scenario packs in parallel.

## 14. Work-package dependency table

| Package | Deliverable | Depends on | May run with | Merge gate |
|---|---|---|---|---|
| K0 | baseline and trace contract | none | ADR-085 discovery | reproducible non-vacuous baseline |
| K1 | canonical composition | K0 vocabulary | ADR-085 file planning | truthful composition fingerprint |
| K2 | workerSpawn actor | K1 seam | K3 | strict spawned happy and repair |
| K3 | obligation compiler | K0 claims, K1 boundary | K2 | independent set equality and mutations |
| K4 | DSL, observer, scheduler | K2, K3 | module fixtures | causal counterfactual evidence bundle |
| K5 | blocking group | K4 | none on shared registry | deterministic non-vacuous CI gate |
| W1-1 | reference causal vertical | K5 | none | complete causal theorem |
| W1-2 | cross-run proof | W1-1 pattern | W1-3, W1-4 | blocking canonical proof |
| W1-3 | Delivery release proof | W1-1 pattern | W1-2, W1-4 | independent external observation |
| W1-4 | parallel Formalization proof | W1-1 pattern | W1-2, W1-3 | authority isolation proof |
| K7 | bounded explorer | K3, K4 vocabulary | K8 | minimized replayable failures |
| K8 | universal workshop corpus | K5, ADR-085 catalog | K7 | synthetic workshop with zero engine edits |

## 15. Verification checklist for every implementation change

- [ ] Re-read the applicable ADR and stage exit gate.
- [ ] Confirm the worktree and preserve unrelated user changes.
- [ ] State the exact proof level claimed by the changed test.
- [ ] Run the narrowest relevant test first.
- [ ] Run build/type checks when TypeScript contracts changed.
- [ ] Run factory-proof import and coverage ratchets.
- [ ] Run the relevant acceptance-matrix group.
- [ ] Run mutation/self-test coverage for oracle changes.
- [ ] Repeat process/fault scenarios enough times to detect nondeterminism.
- [ ] Record exact commands, exit codes, and evidence artifacts.
- [ ] Confirm no direct authority writes were added to test code.
- [ ] Confirm no workshop-name branch was added to universal code.
- [ ] Confirm no new legacy composition import was added.
- [ ] Confirm no proof claim exceeds the exercised seam.

Until W0-4 adds the dedicated group, use explicit factory-proof test files plus
the existing build and acceptance commands. Do not document a proposed command
as if it already exists.

## 16. Pre-mortem and hard controls

### Failure: the DSL becomes a fourth runtime

Signals:

- scenario code computes expected next states;
- scenario code assigns repair owners;
- tests write GateDecision, CandidateSet, or transition rows.

Controls:

- read-only observer import ratchet;
- no reducer imports from DSL/scheduler packages;
- host commands only;
- production handlers create every authoritative record.

### Failure: the oracle is circular

Signals:

- deleting a production Gate also deletes the expectation;
- expected obligations are derived only from installed CheckPlans;
- mutation coverage remains green after registry/operator deletion.

Controls:

- independent versioned AcceptanceObligationContracts;
- exact set equality;
- registry, protection, and operator self-mutations.

### Failure: scripted actors are omniscient

Signals:

- actor branches on attempt number or scenario ID;
- actor reads SQLite;
- repair succeeds without exact feedback.

Controls:

- production-visible input schema;
- import and capability ratchets;
- input/output digests;
- exact/absent/stale/corrupt feedback counterfactuals.

### Failure: partial composition is presented as E2E

Signals:

- WorkerExecutorFactory replacement claims runner or hook proof;
- tests pass while MCP/tool permissions are disconnected;
- proof output lacks a composition fingerprint.

Controls:

- explicit proof-mode metadata;
- strict L3 requires workerSpawn;
- composition fingerprint and allowlist;
- real opencode canaries for third-party CLI integration claims.

### Failure: state-space explosion makes the suite unusable

Signals:

- full Cartesian L3/L4 scenario generation;
- unstable wall-clock waits;
- redundant representatives dominate CI time.

Controls:

- exhaustive cheap structural mutants;
- one mechanically justified causal representative per equivalence class;
- bounded cycles and fair drain;
- deterministic sharding and minimized replay fixtures;
- explicit runtime budgets.

### Failure: workshop modularization creates a second proof path

Signals:

- co-location tests use a shadow binder;
- base and candidate runtimes coexist;
- test-only workshop discovery bypasses the closed catalog.

Controls:

- isolated before/after revision comparison;
- one canonical composition consumer graph;
- closed built-in tuple before C12;
- no compatibility runtime.

## 17. Stop conditions and definition of done

The architecture refactor is complete when all statements below are true:

- [ ] W0-1 through W0-4 are implemented and blocking.
- [ ] W1-1 through W1-4 pass through canonical production composition.
- [ ] Strict L3 actor scenarios use workerSpawn and production-visible inputs.
- [ ] Independent obligation contracts, mutation algebra, set equality, and
      self-mutations are blocking.
- [ ] The observer is read-only and independently reconstructs authority.
- [ ] Exact feedback is causally proven through counterfactuals.
- [ ] Every nonterminal final state has a bounded progress explanation.
- [ ] L0-L5/S claims are explicit and honestly scoped.
- [ ] Fresh scripted happy and repair product runs are green.
- [ ] One happy and one repair real-model canary have passed through the
      opencode worker route.
- [ ] Discovery, Formalization, Development, Delivery, and one synthetic
      workshop run the generic corpus without test-engine changes.
- [ ] Legacy suites are retired only after obligation coverage maps to blocking
      replacements.
- [ ] A newly found defect adds an obligation, mutant, or scenario to the
      existing kernel rather than creating another harness.

W1-5 systematic gate-family expansion continues as normal coverage growth. It
does not keep the architectural refactor permanently open after the stop
conditions above are satisfied.

## 18. First executable backlog

The first integration owner should issue work in this order:

- [ ] K0-A: refresh the current harness and override inventory.
- [ ] K0-B: define the normalized authority-trace schema shared with ADR-085.
- [ ] K0-C: record non-vacuity floors and current quarantine status.
- [ ] K1-A: audit and harden the canonical composition fingerprint.
- [ ] K1-B: make the current happy proof claim explicit and truthful.
- [ ] K1-C: migrate one feedback-driven repair scenario.
- [ ] K2-A: prototype the workerSpawn scripted child without changing runtime
      authority.
- [ ] K3-A: implement the AcceptanceObligationContract schema and loader.
- [ ] K3-B: implement the first authority-conservation mutant family.
- [ ] K4-B: implement the read-only trace observer over the canonical happy and
      repair scenarios.
- [ ] K5-A: add the blocking group only after K2 through K4 satisfy their exit
      gates.

The integration owner must stop and repair the architecture if any task
requires a second dispatcher, direct authority-table writes, an omniscient
actor, a workshop-name branch, or a test-private production composition.
