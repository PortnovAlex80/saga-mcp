# FRF-WP01 — Intentional-Difference Ledger (installed post-EK package vs the plan's target)

The plan (§"Target process graph") declares normative targets: six
Production Cells + two kernel nodes + three terminal nodes + eighteen
transitions, and instructs FRF-0 to "verify them against the installed
post-EK package before implementation" and record "a necessary post-EK name
adjustment … before RED graph tests are frozen".

This ledger maps every installed node and every semantic surface to its
target disposition, and records each intentional difference between the
installed package (base `5c158608`, manifestDigest
`c6752ac045a5152b1eaca9508ea52338b5e3df6983b680d932bba5b6be69ba8a`) and
the plan's target semantics. Machine-readable capture:
`baseline/installed-formalization-graph.json`.

## D-0 (HEADLINE): the installed graph ALREADY equals the plan's target shape

The plan's §"Current defect to remove" describes the PRE-EK semantic order
(`define-product-contract` … `freeze-acceptance-baseline` … `settle-formalization`
seven-desk line). That order no longer exists: the EK-8 workshop conversion
(WP-11F) pre-installed the successor plan's target graph NAME-FOR-NAME as
installed-manifest data (manifest.ts header: "the successor plan's
normative target shape"), and the EK-8 purge deleted the legacy flow
(legacy-zero verified: `define-product-contract` / `freeze-acceptance-
baseline` appear in NO src/dist code — only in the historical
`EK8-DELETION-SET.md` and orphaned pre-EK evidence JSONs).

Node/edge mapping table (current → target): every row is IDENTICAL —

| # | Installed node | Kind | Target node | Disposition |
|---|---|---|---|---|
| 1 | `define-product-intent` | production-cell | `define-product-intent` | KEEP name; semantics verified below |
| 2 | `model-use-cases` | production-cell | `model-use-cases` | KEEP |
| 3 | `derive-system-requirements` | production-cell | `derive-system-requirements` | KEEP |
| 4 | `define-acceptance-contract` | production-cell | `define-acceptance-contract` | KEEP |
| 5 | `reconcile-what` | production-cell | `reconcile-what` | KEEP |
| 6 | `define-architecture-contract` | production-cell | `define-architecture-contract` | KEEP |
| 7 | `freeze-what-baseline` | kernel | `freeze-what-baseline` | KEEP |
| 8 | `settle-formalization` | kernel | `settle-formalization` | KEEP |
| 9 | `complete-formalized` | terminal | `complete-formalized` | KEEP |
| 10 | `complete-inconsistent` | terminal | `complete-inconsistent` | KEEP |
| 11 | `complete-failed` | terminal | `complete-failed` | KEEP |

All 18 installed edges equal the plan's expected transition universe
one-for-one (verified by diffing `installed-formalization-graph.json`
against the plan's §"Expected transition universe"; zero differences).
No node renames, no name adjustments, no deletions at the GRAPH level.

**Consequence for the plan's phases:** FRF-2's RED graph tests are NOT
old-flow-fails/new-flow-passes — the shape is installed; they pin the
installed shape from a TEST-OWNED fixture (the plan's own requirement:
"test-owned normative transition fixture independent from the production
module declaration"). FRF-3/4/5's cell-split work is likewise already
shaped; the plan's real, remaining defect is the SEMANTIC LAYER — the
differences D-1…D-12 below. The plan's §"Current defect to remove" prose
(semantic inversion / authority loss) remains TRUE of the semantic
contracts' enforcement, not of the graph names.

## Required FRF-09 fix targets (external audit round — reproduced)

### D-1 (REQUIRED, UC-FOREIGN): `validateSolutionContract` accepts FOREIGN handoff bindings

- **Where:** `src/workflow-kernel/workshops/formalization/products.ts:768`
  (`validateSolutionContract`); complicit: `settleSolutionContract`
  (products.ts:736) which only requires binding arrays NON-EMPTY.
- **Defect:** the validator pins `whatBaselineRef`, `srsRef`, and
  `baselineDigest` to the accepted authorities and verifies
  `canonicalDigest` — but NEVER checks that
  `developmentHandoff.{prdIntentBindings, scenarioBindings,
  requirementBindings, acceptanceBindings, scenarioRealizationBindings,
  terminalClaimBindings}` RESOLVE against the accepted material's id sets
  (`accepted.prd.memberIds`, `accepted.useCases.scenarioIds`,
  `accepted.requirements.requirementIds`, `accepted.acceptance.criterionIds`,
  `accepted.srs.realizedScenarioIds`, `accepted.handoff.terminalClaimIds`).
- **Reproduction (honest, executed at base):**
  `baseline/uc-foreign-reproduction.mjs` →
  `baseline/uc-foreign-reproduction.output.json`. A lawful eight-link
  accepted chain (handoff→PRD→UC→FR→AC→reconciliation→baseline→SRS) plus a
  settled contract whose EVERY binding array is foreign
  (`uc:FOREIGN-admin-shell`, `fr:FOREIGN-never-derived`,
  `ac:FOREIGN-never-accepted`, …) validates **`{ ok: true }`** and seals
  artifact digest `71d5e0c0…`. The honest control chain also validates
  (`{ok:true}`) — the validator cannot distinguish them.
- **Target (FRF-09, blocking):** FOREIGN_LINEAGE refusal for any handoff
  binding outside the exact accepted id sets; the reproduction file is the
  RED fixture seed. Also fence `settleSolutionContract` itself (settlement
  must not emit a contract it could not validate).

### D-2 (REQUIRED): Development consumes NO scenario/realization bindings

- **Where:** `src/workflow-kernel/workshops/development/**` (10 files) —
  grep-zero for `solutionContract|developmentHandoff|scenarioBinding|
  scenarioRealizationBinding` at base. The Development workshop products
  are `IntegratedCandidate` / `ReadinessManifest` / `VerifiedBundle`,
  bound to acceptance digests only.
- **Defect vs plan:** §"Development handoff requirements" — the
  DevelopmentCase must carry typed REQUIRED values (whole-WHAT baseline
  ref+hash, PRD intent bindings, scenario bindings, requirement bindings,
  AC bindings, scenario-realization bindings, terminal-claim bindings,
  integration obligations); Development planning must CONSUME them. Today
  the Solution Contract's `DevelopmentHandoff` is produced by
  Formalization and consumed by NOTHING.
- **Target (FRF-09):** lifecycle mapping + Development input validation +
  workspace preparation consume the handoff; byte-for-byte handoff tests.

### D-3 (REQUIRED): planning does not preserve UC/scenario identities

- **Where:** same package — no planning/task-graph surface holds a UC or
  scenario identity field (grep-zero).
- **Defect vs plan:** "Update task-graph planning so WorkItems preserve
  scenario and requirement identities in addition to AC identities";
  WorkItems must bind acceptance/scenario-realization/requirement/
  integration/composition/infrastructure obligations.
- **Target (FRF-09):** typed WorkItem bindings; replan/adoption/settlement/
  verification preserve the exact identities and hashes.

### D-4 (REQUIRED): no AC-complete-but-scenario-incomplete check

- **Where:** no validator anywhere in the tree rejects a Development plan
  that covers every AC while omitting a scenario entrypoint, runtime edge,
  composition owner, terminal result, or verifier. `validateSrs` enforces
  per-scenario runtime connectivity INSIDE the SRS, but nothing enforces
  scenario completeness of the PLAN/handoff.
- **Target (FRF-09, blocking):** the plan-kill test family ("An
  AC-complete but scenario-incomplete Development plan is rejected";
  "Retain all AC IDs while stripping UC/scenario bindings from the
  handoff; reject").

## Semantic-surface differences (verified against the desk contracts)

| # | Surface | Installed today | Plan target | Delta owner |
|---|---|---|---|---|
| D-5 | PRD intent members | `PRD_MEMBER_KINDS` (7 kinds) + `PRD_DISPOSITIONS` (4, with owner/reason fences) — INSTALLED and enforced (`validatePrdIntent`) | §define-product-intent | CONFORMANT (verify coverage of "required dispositions" stays blocking at FRF-3) |
| D-6 | UC contract | actor kinds (5, closed), trigger/flows/postcondition, PRD-intent lineage, scenario_required coverage — INSTALLED (`validateUseCaseScenarios`; SCOPE_VIOLATION on `requirementRefs`) | §model-use-cases | CONFORMANT |
| D-7 | Requirements Cell | exact revision pinning (STALE_LINEAGE), PRD-member + UC-scenario lineage (FOREIGN_LINEAGE), per-UC behavior-obligation coverage — INSTALLED (`validateSystemRequirements`) | §derive-system-requirements | CONFORMANT; FRF-5 adds the sixth Cell's resilience/repair/crash/restart coverage set (node exists, coverage set not yet enumerated per-Cell) |
| D-8 | AC contract | FR/NFR binding + UC-terminal binding + evidenceMethod vocabulary + terminal coverage — INSTALLED (`validateAcceptanceContract`, WHAT-side fences) | §define-acceptance-contract | CONFORMANT |
| D-9 | Reconciliation | report validated over the accepted chain; "gaps" verdict legal; pure validators CANNOT patch (purity is structural) | §reconcile-what (validation/report-only) | CONFORMANT in kind; FRF-6 adds one-edge-at-a-time + well-formed-unrelated-graph mutations and rejects any non-empty difference (today a `consistent` verdict only checks claim coverage rows — tighten per plan) |
| D-10 | Whole-WHAT baseline | exact-set freeze (`freezeWhatBaseline`): 6 authority digests + memberDigests + acceptedTraceDigest + canonical `wholeWhatDigest`; drift fences | §freeze-what-baseline | PARTIAL: the plan's baseline contents additionally enumerate deferral/constraint/assumption/unknown dispositions, evidence-method bindings, and per-member IDs/hashes as distinct named sections; installed folds them into `memberDigests`/`acceptedTraceDigest`. FRF-7 must decide: extend the frozen sections or record the fold as the reviewed equivalent. No acceptance-only baseline exists to delete (removed at EK-8). |
| D-11 | SRS scenario realization | `SrsScenarioRealization` with entrypoint/modules/runtimeEdges/externalInterfaces/compositionOwner/implementationSurfaces/terminalResult/evidenceBinding + reachability closure + every-required-UC-exactly-once — INSTALLED (`validateSrs`) | §define-architecture-contract | CONFORMANT in schema; FRF-8 adds the Elite/simple-server kill demonstrations (missing bootstrap, input→controller edge, state→renderer edge, composition owner) as BLOCKING at the handoff boundary |
| D-12 | Solution Contract / settlement | both-authority pinning + canonicalDigest — but binding-blind (D-1); settler requires non-empty only | §settle-formalization | FRF-07/09 REPLACE (see D-1) |

## Package-level intentional differences

| # | Item | Record |
|---|---|---|
| D-13 | `acceptedTransition` declarations | The plan's process-graph test layer expects per-Cell `acceptedTransition` declarations to match installed flow edges. The installed manifest declares edges CENTRALLY (`FORMALIZATION_FLOW_EDGES`) + per-desk `checkProviderId`/`effectId`; there is no per-cell transition field. FRF-2's test-owned fixture derives expected edges from the plan text, so this is a test-model difference to freeze, not a production gap. |
| D-14 | Stale reachability note | RETIRED at FRF-WP11 (2026-08-27): the index.ts header now states the installed-reachability law, the structure suite re-pinned to the FRF-WP11 package shape, and the cells are the installed desk authority. (Pre-cutover finding, for the record: the header claimed the package was reachable ONLY from focused tests while production.ts already imported roles.js; structure.test.mjs asserted the pre-cutover law.) |
| D-15 | Concept budget | Verified CONFORMANT: zero new mutable owners, tables, schedulers, kernel transition kinds, or artifact families in the installed package (all products are content-addressed kinds; sole writer = Workplace/EffectReceipt laws; `workshops.nameBranchLiterals = 0`). FRF-5's sixth Cell introduces NO new mechanism (already installed as a desk). |
| D-16 | Capsules | The Formalization side has NO capsule family of its own at base (capsule ingress exists on the Development side: `tests/workflow-kernel/development/capsule-ingress.test.mjs`). The plan's Formalization capsule tests (cold/warm/invalidation/corruption) are NEW at FRF-10; the "pre-refactor capsules never replay" law applies to the post-EK capsule digest regime. |
| D-17 | Development handoff surfaces enumerated | `DevelopmentHandoff` interface fields match the plan's §"Development handoff requirements" list one-for-one (certificateRef, baselineRef/Digest, srsRef/Digest, prdIntentBindings, scenarioBindings, requirementBindings, acceptanceBindings, scenarioRealizationBindings, terminalClaimBindings, integrationObligations, repositoryPolicyBindings) — the CONTRACT exists and is produced; the CONSUMER does not (D-2). The gap is exactly one-sided. |

## Stop-rule check

No stop rule fires: the post-EK path inventory does NOT contradict the
plan's ownership boundaries (the plan's stop rule anticipated this ledger);
no new mutable owner/table/scheduler is required; reconciliation is already
structurally report-only. The one plan-text correction FRF-1 should carry:
the §"Current defect to remove" section describes the deleted pre-EK flow —
FRF authors must read it as the semantic-enforcement defect (D-1..D-4), not
as a live graph to reorder.
