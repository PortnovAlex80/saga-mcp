# FRF-WP01 — Deletion Manifest (first cut; EXECUTED by FRF-WP11 2026-08-27)

The Formalization surfaces the plan will REPLACE, enumerated with
dispositions, per plan §"Current defect to remove" + §FRF-10 ("Delete old
product semantics … Remove old node and contract identities …"). This is
the FIRST-CUT inventory from base `5c158608`; FRF-11 owns the final
deletion patch. Nothing here is deleted by FRF-WP01 (inventory/baseline
only).

**EXECUTION RECORD (FRF-WP11, 2026-08-27):** the deletion patch landed.
A1-A5 (the replaced semantic surfaces) died with products.ts/
contribution.ts at the cutover (the installed desks route through the FRF
cells; the settlement is binding-aware - cr-02; the reconciliation verdict
is COMPUTED; the baseline is the sectioned whole-WHAT contract). B1+B2
(the orphaned pre-EK harvest, 84 files) deleted. C1 (the stale
reachability header) rewritten. C3 (the structure test) re-pinned to the
FRF-WP11 package shape. C2 (EK8-DELETION-SET.md) KEPT as history per the
E-manifest guard. The blocking validation lives in
tests/infrastructure/frf-removal-guard.test.mjs (matrix group
frf-removal-guard).

Legend: REPLACE = code surface whose current semantics are deleted and
rewritten in-place by the named phase; DELETE = file/surface removed;
OBSOLETE-DOC = stale prose retired by the docs pass; ALREADY-GONE = the
plan orders deletion of a surface that no longer exists (recorded so FRF
phases do not hunt for it).

## A. Semantic defects to remove (REPLACE — the plan's "current defect")

| # | Surface (path @ base) | Current behavior to delete | Disposition | Phase |
|---|---|---|---|---|
| A1 | `src/workflow-kernel/workshops/formalization/products.ts:768` — `validateSolutionContract` | Binding-blindness: accepts FOREIGN scenarioBindings/requirementBindings/acceptanceBindings/scenarioRealizationBindings/prdIntentBindings/terminalClaimBindings (UC-FOREIGN, reproduced — see `baseline/uc-foreign-reproduction.output.json`) | REPLACE: membership-fenced validator (FOREIGN_LINEAGE) | FRF-09 (ledger D-1) |
| A2 | `src/workflow-kernel/workshops/formalization/products.ts:736` — `settleSolutionContract` | Emits contracts whose binding arrays are only checked NON-EMPTY | REPLACE: settler must refuse what the validator would refuse | FRF-07 (ledger D-12) |
| A3 | `src/workflow-kernel/workshops/development/**` — products/mappings intake | Zero consumption of Solution Contract / scenario / realization bindings; DevelopmentCase-equivalent carries AC acceptance digests only | REPLACE: typed required handoff consumption + byte-for-byte mapping | FRF-09 (ledger D-2, D-3) |
| A4 | Development planning/task-graph identity set | No UC/scenario identity preservation; no AC-complete-but-scenario-incomplete rejection | REPLACE: typed WorkItem obligation bindings + plan-completeness gate | FRF-09 (ledger D-3, D-4) |
| A5 | `validateWhatReconciliation` consistent-verdict check | Accepts a `consistent` verdict whose only closure proof is source-claim row coverage | REPLACE (tighten): full forward+reverse closure over source/intent/scenario/requirement/criterion/evidence; every non-empty difference rejected | FRF-06 (ledger D-9) |

## B. Old-flow remnants (DELETE)

| # | Surface | Evidence of old-flow-only purpose | Disposition | Phase |
|---|---|---|---|---|
| B1 | `tests/factory-evidence/formalization/**` — 26 JSON fixtures | Pre-EK harvest (`harvest-manifest.json` 2026-08-25); payloads reference `define-product-contract`-era desks and the OLD inverted `use-cases-missing-fr-coverage` direction; consumed by NOTHING at base (grep-zero across tests/tools/src; not hosted by any matrix group) | DELETE | FRF-10/FRF-11 |
| B2 | `tests/factory-evidence/{development,delivery,discovery,documentation}/**`, `harvest-manifest.json`, `conformance-report.json` | Same orphaned pre-EK harvest family (not Formalization-specific) | DELETE — flagged to coordinator for the cross-workshop disposition | FRF-11 |

## C. Stale documentation of the pre-cutover era (OBSOLETE-DOC)

| # | Surface | Staleness | Disposition | Phase |
|---|---|---|---|---|
| C1 | `src/workflow-kernel/workshops/formalization/index.ts` header | "reachable ONLY from focused tests … until WP-12" — the cutover landed; `composition/production.ts` imports the package | REWRITE header comment (docs-level) | FRF-11 (ledger D-14) |
| C2 | `src/workflow-kernel/workshops/formalization/EK8-DELETION-SET.md` | Historical WP-11F artifact; its deletion set was executed at EK-8; survives as evidence only | KEEP as history (no action) or retire per coordinator docs pass | FRF-11 |
| C3 | `tests/workflow-kernel/workshops/formalization/structure.test.mjs` — pre-cutover reachability + EK-8-deletion-set assertions | Asserts the package has no production importer (stale) and that the EK-8 deletion doc exists | REWRITE to cutover-pinned reachability law; drop the deletion-set assertion when C2 retires | FRF-11 (classification SPLIT) |

## D. Plan-ordered deletions that are ALREADY-GONE (recorded)

| # | Plan order | Status at base |
|---|---|---|
| D-a | "Delete the acceptance-only baseline schema, handler, persistence, tests, fixtures, and current documentation" (FRF-7) | ALREADY-GONE at EK-8: legacy-zero verified — `freeze-acceptance-baseline` / `acceptanceBaseline` appear in NO src/dist code; `src/modules/**` and `src/process-modules/**` are absent (purged). FRF-7 implements the whole-WHAT baseline's missing sections instead (ledger D-10). |
| D-b | "Delete the `UC covers pre-existing FR` production rule and resource" (FRF-4) | ALREADY-GONE: `validateUseCaseScenarios` REFUSES `requirementRefs`/`requirements` presence (SCOPE_VIOLATION); the old rule exists only as the orphaned fixture name in B1. FRF-4 contributes the RED mutation "Restore the forbidden `UC --covers--> pre-existing FR` direction". |
| D-c | "Remove old node and contract identities from installed package manifests, proof claims, transition universes, lifecycle maps, and test drivers" (FRF-10) | No old node identity exists in any installed surface at base (legacy-zero). FRF-10 runs the static legacy-zero searches to PROVE it stays that way. |

## E. Explicitly NOT deleted (guard against over-deletion)

- Everything in `TEST-CLASSIFICATION.md` labeled KEEP — the generic
  Workplace/Production Cell/CandidateSet/GateDecision/revision/fencing/
  obligation/repair/recovery laws (ingress, gates, effects, roles,
  manifest, engine, corpus, kernel development vertical).
- `EK8-DELETION-SET.md` is evidence of a completed deletion; deleting it is
  a coordinator docs decision, not a semantic one.
- The orphaned harvest fixtures in B2 belong to other workshops' histories;
  FRF deletes only what the plan authorizes (Formalization surfaces) and
  flags the rest.
