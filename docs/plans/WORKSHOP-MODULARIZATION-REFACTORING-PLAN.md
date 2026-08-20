# Workshop modularization and co-location refactoring plan

- Status: Blocked by the Saga Kernel Conformance Engine prerequisite
- Date: 2026-08-21
- Decision: ADR-085
- Scope: Discovery, Formalization, Development and Delivery built-ins
- Explicit non-goal: opening generic package admission before C12

## 0. Starting condition

Implementation is not authorized until the Structural Refactor Qualification
Gate in `docs/plans/PROJECT-STRUCTURAL-CLEANUP-PLAN.md` is green. The required
test engine is defined by
`docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md`. Until then, this document
is planning input only: do not move workshop files, introduce the target
catalog, change runtime wiring or split workshop implementations.

This is a greenfield repository refactor. There is no deployed production
environment, persistent production database, customer data or non-terminal run
population. Consequently:

- all four workshops may be moved immediately in one repository change;
- package/resource/handler digests and generated fixtures may be rebuilt;
- there is no data migration, drain, backward-compatibility period or stored
  state rollback protocol;
- no legacy re-export or historical executable registry is required;
- SQLite or repository instances mentioned below are disposable test fixtures.

In this document, “canonical runtime” means the code path intended to become the
real runtime. It does not imply that a production deployment exists today.

## 1. Outcome

After this refactoring, an agent starts at
`src/modules/<workshop>/WORKSHOP.md`, finds every workshop-owned contract,
definition, resource, port and executable binding declaration under that
directory, and imports the workshop only through its `index.ts`.

The canonical runtime starts from one closed, source-controlled tuple of the four built-in
workshops. Orchestrator, worker MCP and scripted worker resolve the same declared
capability identities and record exact binding receipts. The old
`src/process-modules/modules/*` implementations, workshop-specific runtime
registration calls and competing manual module arrays no longer exist.

This is a structural and composition refactor. It must not change Workplace
authority, production revision semantics, check/gate behavior, recovery,
settlement, routing, effects, prompt content or produced artifacts.

## 2. Evidence-backed diagnosis

The repository currently makes one logical workshop span several authorities:

| Area | Current location | Problem |
|---|---|---|
| Definition/package/resources | `src/process-modules/modules/<name>` | Separated from implementation and registration |
| Domain/application/ports | `src/modules/<name>` | Imports back into the package tree |
| Registration | workshop `index.ts` plus `product-lifecycle-runtime.ts` | Runtime-specific manual calls |
| Executable capability list | `workshop-capability-manifest.ts` | Factory-wide list imports every workshop |
| Installation lists | CLI, fresh harness and runtime roots | More than one composition surface |
| Authoring proof | `tools/module-authoring-kit` | Validates a package, not canonical runtime connectivity |

Measured on 2026-08-21:

- `src/process-modules/modules`: 116 files, about 14,173 lines;
- `src/modules`: 90 files, about 29,272 lines;
- the universal application/domain/installation layers alone contain 133
  files, before persistence, lifecycle and shared layers are counted;
- `tests/process-modules`: 122 files, about 35,295 lines;
- at least 32 files import across the two workshop trees in both directions.

The current dependency ratchet treats both roots as one module tree. That
protects dependency direction but hides the navigation cost. The current
conformance runner scans the legacy module path, while the canonical runtime does not use
the existing plugin/binding SPI as its composition authority. A manifest that
passes authoring-kit validation is therefore not proof that a workshop is
connected to the canonical runtime.

ADR-082 adds a deliberate constraint: admission is closed until C12. The
refactor may centralize the four built-ins, but must not discover packages,
accept package-supplied executable atoms, or reduce admission to copying a
manifest into a directory.

## 3. Architecture after the cutover

### 3.1 Ownership layout

```text
src/
  modules/
    built-in-catalog.ts              # closed literal tuple; no discovery
    discovery/
      WORKSHOP.md                    # agent entrypoint and generated inventory
      index.ts                       # only public TypeScript surface
      manifest.ts                    # pure canonical package manifest
      definition.ts                  # Flow and ProductionCell definitions
      runtime-bindings.ts            # binding factories, no global mutation
      domain/
      application/
      ports/
      package/
        protocols/
        capabilities/
        resources/
          skills/
          templates/
          checklists/
          schemas/
      conformance/
        fixtures.ts
        scenarios.ts
    formalization/ ...
    development/ ...                 # continuation variants stay in this family
    delivery/ ...

  process-modules/
    domain/                           # universal vocabulary and state
    application/                      # universal execution/gates/routing
    installation/                     # CAS, pins, binding and compatibility
    persistence/                      # universal repository contracts

  infrastructure/process-modules/
    <workshop>/                       # concrete host adapters, including SQLite
```

“One place” means one place for workshop ownership, not mixing factory physics
or concrete persistence into the workshop. The module defines injected ports.
Host-owned adapters remain outside and are linked in the generated inventory.

### 3.2 Public surface

Only `src/modules/<workshop>/index.ts` may be imported from outside that
workshop. It exports one descriptor with pure data plus binding construction:

```ts
export interface BuiltInWorkshop {
  readonly manifest: ProcessModuleManifest;
  readonly definition: ProcessModuleDefinition;
  createBindings(context: WorkshopBindingContext): WorkshopRuntimeBindings;
}
```

This interface does not itself authorize execution. The closed catalog names
the admitted built-ins. Exact coverage validation rejects:

- a declared handler/check/effect/decoder/tool without a binding;
- an undeclared extra binding;
- a logical ID, version or implementation digest mismatch;
- different resolved receipts between orchestrator, worker MCP and scripted
  worker roles.

Extend the existing `ProcessModulePlugin` and `bindInstallation` concepts where
possible; do not introduce a parallel SPI that is green only in tests.

### 3.3 Closed catalog before C12

The catalog is deliberately boring:

```ts
export const BUILT_IN_WORKSHOPS = [
  discoveryWorkshop,
  formalizationWorkshop,
  developmentWorkshop,
  deliveryWorkshop,
] as const;
```

It may not read installed packages, scan directories, load configuration,
accept an external composite capability manifest, or let a package register a
kernel handler. Canonical runtime composition must consume this tuple directly.

ADR-082's four admission surfaces remain explicit and mechanically compared:

1. payload contracts;
2. executable capabilities;
3. the exact built-in composition set;
4. lifecycle start gateways.

They become checked projections of the closed built-in declarations, not open
extension points. If this changes admission distance beyond what ADR-082
permits, approve a narrow amendment before implementation. C12/generic plugin
admission is a separate project.

## 4. Required `WORKSHOP.md` contract

The authoring kit creates this file. CI regenerates factual blocks between
stable markers and fails on drift. Human prose outside generated blocks remains
reviewable.

Required sections:

1. Purpose and non-goals.
2. Owner and support boundary.
3. Exact upstream input refs, cardinality and authority source.
4. Exact output refs, cardinality and downstream consumers.
5. Flow diagram: cells, author/reviewer profiles, waits and recovery edges.
6. Stable `workKey` rule and same-Workplace repair rule.
7. Check plans with S classification: decidable procedure, lawful exit, or
   honestly open requirement.
8. Effects and their exact accepted-material authority.
9. Outcomes: accepted, human-required and failed.
10. Resource inventory with digest and ownership.
11. Executable binding inventory with logical ID/version/digest/role.
12. Host adapter inventory with links to injected implementations.
13. Lifecycle routes.
14. Local validation and conformance commands.
15. Known variants and compatibility range.

An agent should never have to search a factory-global manifest to learn what a
workshop owns. Generated inventory is navigation, while the manifest remains
the machine authority.

## 5. Exact checklist: authoring a workshop

### Identity and boundary

- [ ] Choose a stable `moduleRef`, semantic version and compatibility range.
- [ ] State purpose, owner, non-goals and whether this is Tier 1, 2 or 3 under
      ADR-082.
- [ ] Define exact input/output product refs, schemas, cardinality and lifecycle
      outcome bindings.
- [ ] Confirm no workshop implementation imports another workshop; communicate
      only through products/contracts and lifecycle routing.
- [ ] Export only through the workshop `index.ts`.

### Flow and authority

- [ ] Define Flow and ProductionCells declaratively; do not add a dispatcher,
      queue, lifecycle engine, private product store or module-name switch.
- [ ] Give every cell a stable cell ID and deterministic `workKey` rule.
- [ ] Bind author/reviewer profiles, CheckPlan, recovery and effects explicitly.
- [ ] Preserve repair on the same Workplace and exact production-revision
      lineage.
- [ ] Define accepted, human-required and failed exits; reject a zero-edge or
      vacuously terminal flow.

### Contracts and resources

- [ ] Add a versioned schema and runtime decoder for every untrusted payload.
- [ ] Normalize representation once at ingress; never let LM representation
      become semantic authority.
- [ ] Store workshop-owned skills, templates, checklists and schemas beneath
      `package/resources` and reference them package-relatively.
- [ ] Include every resource byte in the manifest index/digest.
- [ ] Mark platform-owned resources as explicit platform dependencies rather
      than copying them into the workshop.

### Capabilities and bindings

- [ ] Declare every handler, validator, check, effect, provider and tool with
      logical ID, version, implementation digest, allowed roles and trust basis.
- [ ] Implement `createBindings(context)` using injected ports and without
      process-global registration side effects.
- [ ] Prove exact declaration-to-binding coverage for every process role.
- [ ] Make effects consume exact accepted Product/ProductionRevision authority,
      never `latest`, task or WorkerExecution lookup.
- [ ] Put concrete SQLite/filesystem/provider substrates in
      `src/infrastructure/process-modules/<workshop>`.

### S and conformance

- [ ] Classify every check as decidable, lawfully escapable, or honestly open.
- [ ] Prove the conjunction of scope, required artifact classes, environment and
      check requirements is satisfiable, or expose a lawful exit.
- [ ] Add module-owned scenarios for happy path, reject-to-repair, human and
      failed outcomes, fan-out, resume, crash boundaries and package drift.
- [ ] Run manifest closure, resource/digest, binding coverage, dependency and
      generic conformance gates.
- [ ] Confirm scenario/edge/count floors did not decrease.

## 6. Exact checklist: connecting a built-in workshop before C12

- [ ] Complete the authoring checklist and obtain ADR-082 Tier 3 admission
      approval; co-location is not admission.
- [ ] Add one explicit entry to the closed built-in tuple.
- [ ] Update all four admission projections deliberately: payload contracts,
      executable capabilities, composition set and lifecycle start gateway.
- [ ] Add lifecycle routing as exact output-ref to input-ref data; do not branch
      on a workshop name in the universal runtime.
- [ ] Install the content-addressed package and resolve exact executable
      bindings before orchestration starts.
- [ ] Write and compare expected/resolved binding receipts for orchestrator,
      worker MCP and scripted worker; fail closed on any difference.
- [ ] Confirm disposable test runs pin installation, package, definition,
      CheckPlan and handler digests consistently after the move.
- [ ] Pass the generic conformance suite and every negative drift mutant.
- [ ] Pass a fresh scripted L5 run and a same-project Run A to Run B replay.
- [ ] Run the local full-lifecycle E2E only after deterministic gates are green.
- [ ] Verify that deleting the catalog entry makes the workshop unreachable and
      that no private registration path remains.

After C12, replace this checklist only through a new ADR. Do not silently turn
the closed tuple into filesystem or package discovery.

## 7. Refactoring sequence

The refactoring unit is all four built-ins. There is no deployed state, so the
target topology can replace the current topology directly. Commits may be
organized for review, but the branch is complete only when no legacy path,
compatibility layer or second binder remains.

### P0 — Capture the behavioral baseline

Add test-only tooling that exports for every workshop:

- canonical definition and package JSON;
- resource bytes/digests and handler refs/digests;
- cells, profiles, checks, effects, outcomes and routes;
- declared and resolved role capabilities;
- installation/binding receipts;
- normalized durable traces for all canonical scenarios.

The trace normalizer may ignore only UUIDs, timestamps, absolute paths and
database row IDs. It must compare semantic inputs/products, Workplace and
ProductionRevision lineage, CandidateSets, receipts, decisions, effects,
settlement, routes and reason sequence.

Run the baseline on the pre-refactor revision and persist fingerprinted
fixtures. Prove the oracle is non-vacuous by mutating one item in each class and
observing a red test. All database/repository state used here is created by the
test and discarded afterwards.

Exit gate: clean current baseline plus a reviewed semantic ignore list.

### P1 — Move all four workshop trees

For all four workshops:

- create the target layout and `WORKSHOP.md`;
- consolidate resources, definitions, protocols, domain, application and ports;
- convert outside imports to the public `index.ts`;
- declare runtime bindings without creating a second runtime route;
- move concrete adapters to the existing infrastructure boundary;
- update authoring-kit templates and inventory generator.

Recommended review order is Discovery, Formalization, Development, Delivery.
This is review decomposition only. Do not leave pure re-exports, fallbacks or
duplicate implementations in the completed branch.

Exit gate: every workshop-owned file has exactly one canonical location, all
imports use public module surfaces, and the diff contains no business-rule
change.

### P2 — Switch composition immediately

In the same completed repository change:

1. rebuild package/resource/handler digests from the new paths;
2. install the closed built-in catalog as the canonical runtime input;
3. make CLI, lifecycle runtime, worker MCP and scripted harness consume that
   same closed composition;
4. write exact cross-role binding receipts and fail before issuing work on
   mismatch;
5. remove `src/process-modules/modules/*`, `register*` runtime calls, competing
   manifest arrays and all compatibility re-exports;
6. update ADR-082 exact ratchets without opening package admission.

There is no database migration, data copier, dual-read, dual-write, feature
flag, legacy fallback or old-version compatibility code.

Exit gate: zero legacy files/imports/manual composition lists and exactly one
canonical composition consumer graph.

### P3 — Prove before/after semantic equivalence

Run the old revision and candidate revision separately against byte-identical
disposable test fixtures, identical provider/effect fakes and the same scripted
inference seam. This is a comparison of two git revisions, not runtime
coexistence and not a data migration.

Compare the full normalized authority graph for:

- happy path;
- reject then repair on the same Workplace;
- human-required and failed exits;
- fan-out and cross-workshop handoffs;
- restart and resume;
- every durable crash boundary;
- same-project second run.

Exit gate: semantic diff is zero. Any intended semantic difference leaves this
refactor and requires its own ADR/change.

### P4 — Run the full local proof

Run L0-L5/S against fresh disposable fixtures. Include one scripted scenario
per workshop, the full lifecycle, same-project Run A to Run B, restart/fault
schedules and externally runnable product proof. No real deployment or
persistent environment is required.

Exit gate: all deterministic suites pass, scenario/count floors are unchanged
or higher, and every required mutant makes CI red.

### P5 — Ratchet and close

- make legacy paths/imports and direct `register*` calls hard CI failures;
- make `built-in-catalog.ts` the only permitted built-in list;
- fail if the binder/plugin lacks a canonical runtime consumer;
- fail if any process role resolves a different capability receipt;
- update architecture maps and delete stale references to removed
  `docs/refactor-management` material;
- record baseline, equivalence and full-suite evidence in the ADR.

Exit gate: the branch contains only the target topology and can be merged
without any operational migration step.

## 8. No-regression test strategy

### L0 — Static layout and package closure

- manifest/definition validation and canonical digest sensitivity;
- every resource exists, is package-relative and is indexed once;
- exact declarations-to-bindings coverage and no duplicate logical IDs;
- only `index.ts` is imported externally;
- no cross-workshop implementation imports;
- no SQLite/global DB access in domain/application;
- no direct global capability registration;
- no workshop-name switches in universal kernel code;
- one closed built-in list and four exact ADR-082 projections;
- file/scenario/edge floors prevent vacuous green.

Update the conformance scanner and dependency ratchets to treat
`src/modules/*` as the only module root after cutover.

### L1 — Workshop semantics

- every reducer edge plus every illegal edge;
- decoder normalization and property/fuzz cases;
- deterministic cell/workKey/recovery behavior;
- CheckPlan and effect authority;
- all terminal outcomes;
- same-Workplace reject-to-repair;
- workshop-owned scenarios through one shared conformance runner.

### L2 — Installation semantics on disposable stores

Use a fresh disposable SQLite fixture or repository implementation to cover:

- first install and idempotent reinstall;
- changed bytes under stable identity fail closed;
- missing/corrupt resource or handler;
- missing/extra/mutated binding and namespace collision;
- package/install identity remains consistent across a simulated restart;
- terminal history immutability;
- concurrent install/dispatch;
- a mutated identity never resolves through ambient handlers.

### L3 — Canonical composition

Use the canonical runtime composition with only inference substituted:

- exact cross-role capability and binding receipts;
- all outcome edges and reject-to-repair;
- exact cross-workshop product handoff;
- canonical composition fingerprint;
- no test-private registrar or fake gate;
- closed catalog removal makes a workshop unavailable everywhere.

### L4 — Temporal and fault schedule

Inject a crash before and after each durable boundary:

1. Product;
2. ProductionRevision;
3. CandidateSet;
4. CheckReceipt;
5. GateDecision;
6. required effect;
7. settlement;
8. lifecycle routing.

Also test duplicate delivery, racing workers and engine restart. Recovery must
converge without duplicate production/effects and expose a bounded durable
progress explanation.

### L5 — Product proof

- fresh scripted full lifecycle through the canonical runner seam;
- same-project Run A to Run B replay with current gates;
- exact accepted products and terminal outcomes;
- externally runnable product proof, not only an internal success label;
- optional local real-model smoke only after deterministic levels pass; it is
  not a deployment or migration gate.

### S — Satisfiability

Run the general gate-conjunction satisfiability proof and workshop-specific
scope/artifact/environment conjunctions. Every contradiction must have a proof,
lawful exit or honestly open status. No timeout-based green result is accepted.

## 9. Required mutation tests

Each mutant must make CI red:

- remove a decoder from worker MCP but keep it in orchestrator;
- change a handler/provider logical ID, version or digest;
- add a direct `register*` bypass outside the catalog consumer;
- make the plugin/binder exist with no canonical runtime consumer;
- omit or mutate an indexed resource;
- reintroduce a legacy-root or cross-workshop import;
- branch on workshop name in universal kernel code;
- look up material by execution/task/`latest` after authority is sealed;
- replace canonical composition with a private test composition;
- create a zero-edge DAG or remove an outcome scenario;
- add a second built-in list;
- omit one catalog workshop from an admission projection;
- run old/new external effects against the same target.

## 10. CI lanes and performance guards

Add deterministic commands (names are proposed and must be implemented in P0):

```text
npm run workshop:inventory -- --check
npm run workshop:conform -- --all
npm run workshop:diff -- --baseline <baseline-ref> --candidate <candidate-ref>
```

The refactor gate also runs the existing build, process-module, architecture,
temporal, contract, golden-path and acceptance-matrix suites. Capture startup,
installation and dispatch query counts plus bounded cycle counts at P0. Use
explicit reviewed thresholds; avoid noisy wall-clock-only assertions.

Every test creates and removes its own state. No migration fixture, production
snapshot or long-lived database is part of the acceptance criteria.

## 11. Work packages

| WP | Deliverable | Depends on | Done when |
|---|---|---|---|
| WP-1 | Inventory, trace normalizer and mutant oracle | none | P0 exit gate |
| WP-2 | Target trees and public surfaces for all four | WP-1 | P1 exit gate |
| WP-3 | Binding coverage and closed catalog | WP-2 | Catalog is consumed by the canonical runtime |
| WP-4 | Authoring kit and generated `WORKSHOP.md` | WP-2 | New scaffold passes L0-L3 |
| WP-5 | Remove legacy tree and competing wiring | WP-3 | P2 exit gate |
| WP-6 | Isolated base/candidate equivalence campaign | WP-3, WP-5 | P3 exit gate |
| WP-7 | Full local proof and permanent ratchets | WP-4, WP-6 | P4-P5 complete |

WP-2 may be reviewed workshop-by-workshop, but WP-2, WP-3 and WP-5 form one
complete repository cutover. There is no deployment migration unit.

## 12. Definition of done

The refactor is complete only when all statements are true:

- [ ] Each workshop-owned source/resource is under exactly one
      `src/modules/<workshop>` tree.
- [ ] Every `WORKSHOP.md` inventory matches the machine manifest.
- [ ] Canonical runtime, CLI, worker MCP and scripted harness consume one closed
      built-in composition.
- [ ] The four ADR-082 admission projections are exact and package admission is
      still closed.
- [ ] There are no legacy implementations/re-exports, direct `register*` calls,
      competing built-in lists or core workshop-name branches.
- [ ] Package/resource/handler digests are rebuilt and internally consistent in
      disposable tests; no compatibility mapping exists.
- [ ] Old/new normalized semantic traces are equal for every required scenario.
- [ ] L0-L5/S and all mutation tests are green and non-vacuous.
- [ ] The complete local scripted lifecycle and per-workshop scenarios are green.
- [ ] The authoring and connection checklists are exercised by a synthetic
      workshop fixture without changing universal runtime code.

## 13. Explicitly deferred decisions

- Generic/package-supplied workshop admission before C12.
- A new workspace/package topology or SPI v2.
- Dynamic external handler loading.
- Changing factory vocabulary, Workplace authority or lifecycle semantics.
- Any data or database migration layer.
- Keeping a legacy runtime fallback.

These require separate decisions. They are not hidden acceptance criteria for
this co-location refactor.
