# FRF-WP01 — Formalization Test Classification (first cut)

Per the plan's test-migration policy ("The semantic order is intentionally
breaking. Existing Formalization tests and capsules are classified before
modification"), every CURRENT Formalization test surface is classified
below. Labels: **KEEP** (retain unchanged), **SPLIT** (rewrite / split —
the test encodes a surface FRF changes), **REGENERATE** (fixtures produced
through public ingress), **DELETE** (exists only to preserve the old flow).

Base: `5c158608` (branch `frf/wp01-baseline`). Counts from
`post-ek-inventory.json` (per-file sha256 recorded there).

**CUTOVER RECORD (FRF-WP11, 2026-08-27):** every SPLIT landed. The
scenario full-run drives the INSTALLED cells over public commands; the
products-suite fence battery re-pointed at the dispatch through the corpus
mutation materializers; the structure suite re-pinned to the FRF-WP11
package shape (products.ts/contribution.ts died; cells/ + contracts/ are
installed); the settlement/UC-FOREIGN and AC-complete-scenario-incomplete
kills are blocking (the settle desk fences the twelve binding kinds). The
26 orphaned old-flow fixtures (DELETE) are gone; the cells' suites and
tests/frf-corpus are blocking-hosted (workflow-kernel + frf-corpus matrix
groups).

## Focused suite — `tests/workflow-kernel/workshops/formalization/` (68/68 green at base)

| File | Tests | Classification | Rationale |
|---|---|---|---|
| `manifest.test.mjs` | 8 | **KEEP** (extend at FRF-2) | Already pins the eleven-node/eighteen-transition shape, reachability, cell exits, provider pinning, manifest digest. FRF-2 adds the test-owned normative fixture independent of the production module declaration; these stay green unchanged. |
| `products.test.mjs` | 10 | **SPLIT** | All eight product validators stay, but `settle-formalization: exact references to BOTH authorities` and the settlement half encode the CURRENT binding-blind settlement. FRF-07/09 split them: authority-ref assertions KEEP; a new binding-membership family (UC-FOREIGN RED) lands beside them. |
| `gates.test.mjs` | 7 | **KEEP** | Verdict routing (FOREIGN→upstream-repair, DRIFT→human-wait), provider fail-closed, CheckPlan evidence — generic gate laws, unchanged by FRF. |
| `ingress.test.mjs` | 9 | **KEEP** | Capsule ingress laws (digest recomputation, foreign lineage, parent-state, idempotence) are scenario-first-neutral. |
| `effects.test.mjs` | 4 | **KEEP** | Idempotent effect settlement + D5/D12 typed-wait vocabulary — kernel mechanics, untouched by FRF. |
| `roles.test.mjs` | 6 | **KEEP** | One resolution path / one pin / reclassification refusal — role-contract laws preserved. FRF-05 adds one new Cell's bindings elsewhere. |
| `scenario.test.mjs` | 15 | **SPLIT** | The full-run and mutation battery KEEP, but the run asserts the CURRENT eight-desk fold whose settlement accepts authored handoff arrays without membership checks; FRF-10 extends the actor scripts + adds the AC-complete-but-scenario-incomplete and foreign-handoff mutations. The full-run test itself splits: public-command path KEEP, settlement assertions rewritten when the settler fences bindings. |
| `structure.test.mjs` | 9 | **SPLIT** | Purity/no-SQL/no-clock/no-board/no-name-literal laws KEEP. `the package is reachable ONLY from focused tests: no production entrypoint imports it` is STALE at base (the EK-8 cutover landed; `src/workflow-kernel/composition/production.ts` imports `workshops/formalization/roles.js`) — it passes only because the check predates the cutover pin; FRF-11 rewrites it to the cutover-pinned reachability law. `the EK-8 legacy deletion set is documented in the owned paths` becomes obsolete when the EK-8 set note retires. |
| `support.mjs` | — (helper) | **SPLIT** | Authored chain builder feeds the settlement assertions; gains binding-membership-fixture helpers at FRF-09. |
| `red-demos.py` | — (helper) | **KEEP** | Demo driver only. |

## Development side — the FRF-09 consumer gap (no scenario consumption exists today)

| File | Tests | Classification | Rationale |
|---|---|---|---|
| `tests/workflow-kernel/workshops/development/*.test.mjs` (5 files) | — | **SPLIT** | All currently green and none reference `solutionContract` / `scenarioBindings` / `scenarioRealizationBindings` / `developmentHandoff` (grep-zero at base). FRF-09 splits each: existing acceptance/material-chain laws KEEP; a new scenario-binding-consumption family lands beside them (handoff omission, stale-reference, AC-complete-but-scenario-incomplete RED). |
| `tests/workflow-kernel/development/*.test.mjs` (9 files + fixtures) | — | **KEEP** | Kernel development vertical (capsule ingress, admission, material chain, mutations) — generic Workplace/kernel laws. |

## Scenario engine and corpus

| Surface | Classification | Rationale |
|---|---|---|
| `tests/workflow-kernel/engine/scenario.test.mjs`, `faults/scenario-faults.test.mjs` | **KEEP** (extend at FRF-10) | The post-EK scenario engine the plan explicitly extends ("no second harness"). |
| `tests/project-corpus/**` (33/33 green) | **KEEP + REGENERATE entries** | Corpus format/drivers KEEP. Any corpus entry whose actor programs author the CURRENT permissive settlement regenerates through public ingress at FRF-10; formalization-stage expectations re-derived, never hand-edited. |
| `tests/workflow-kernel/synthetic/**`, `workshops/synthetic/**` | **KEEP** | Synthetic generalization engine — FRF-10 extends, does not replace. |
| `tests/workflow-kernel/composition/composition.test.mjs`, `cutover-pins.test.mjs` | **KEEP** (cutover pins gain FRF rows at FRF-11) | Production-composition laws. |
| `tests/workflow-kernel/model/complexity.test.mjs` | **KEEP** | The complexity budget FRF-05 must re-verify with the sixth Cell already installed (it IS installed — see ledger D-0). |

## Old-flow remnants — DELETE candidates (first cut; disposition owned by FRF-10/FRF-11)

| Surface | Classification | Rationale |
|---|---|---|
| `tests/factory-evidence/formalization/**` (26 JSON fixtures) | **DELETE** | Pre-EK harvested evidence of the OLD flow — file names and payloads reference `define-product-contract`-era desks (`use-cases-missing-fr-coverage-repair` is the OLD inverted direction). Consumed by NOTHING at base (grep-zero across tests/tools/src; the harvest suites died at the EK-8 purge). Exist only to preserve the old flow. |
| `tests/factory-evidence/{development,delivery,discovery,documentation}/**`, `harvest-manifest.json`, `conformance-report.json` | **DELETE** (out of FRF scope-proper; flag to coordinator) | Same orphaned pre-EK harvest family; not Formalization-specific. FRF-11's deletion patch should carry or explicitly defer them. |

## Matrix hosting status

All KEEP/SPLIT files above live in the `workflow-kernel` (88 files) or
`project-corpus` (4 files) matrix groups — blocking-hosted, removal-guarded
by `matrix-coverage` (19/19) and the workflow-kernel group glob. The 26
orphaned `factory-evidence/formalization` fixtures are hosted by NO group
(matrix registry records no consumer) — consistent with their DELETE
disposition. No Formalization test is quarantined (the matrix QUARANTINE
table is empty at base).
