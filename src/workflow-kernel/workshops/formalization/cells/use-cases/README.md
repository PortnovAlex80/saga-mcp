# FRF-WP04 Production Cell: `model-use-cases`

New parallel construction (plan FRF-WP04, desk contract
"model-use-cases"). INSTALLED since the FRF-WP11 cutover: the installed
workshop routes the model-use-cases desk through this cell (provider
`frf-cell.uc-scenarios.v1`); the old products.ts validator died at the
cutover.

## Package contents

| File | Role |
| --- | --- |
| `seam.ts` | The WP03 contract seam (see below) |
| `cell.ts` | Identity, desk protocol (accepted intents -> scenario drafts), skill declarations, product template, WP-17 role bindings, the cross-desk `AcceptedScenarioSet` fold (incl. branch ids per scenario for FRF-WP05) |
| `gate.ts` | CheckPlan, the declared deterministic check provider, the semantic gate (cross-desk lineage, UC coverage fence, verdict routing, D5 human-wait, obligation routing) |
| `reviewer.ts` | The independent reviewer (closed accept/repair verdicts over the gate outcome) |

## The WP03 contract seam (honest description)

Same seam contract as the product-intent cell (see
`../product-intent/README.md`). The semantic authority for a UC
scenario member is the FRF-WP03 contract
`frf-contracts.uc-scenario-member.v1`:

- schema: `docs/refactoring/formalization-frf/contracts/schemas/uc-scenario-member.schema.json`
- validator: `docs/refactoring/formalization-frf/contracts/validators/uc-scenario-member.mjs`

This cell never re-implements the contract and never imports the docs
tree; every scenario is validated through `seam.ts`
(`UcScenarioContractPort`, install-once, digest-pinned, fail-closed
`CONTRACT_SEAM_UNWIRED` resolution). Today the focused test suite
installs the real WP03 validator with
`validatorDigest = sha256(validator file bytes)`. Since the FRF-WP11
cutover the seam SELF-INSTALLS the in-package validator (installed
wiring, pinned by contracts/identity.ts); a same-digest install stays an
idempotent no-op and the test-only reset hook is deleted.

## Cross-desk lineage (the UC-FOREIGN fix at Cell level)

The gate's only accepted PRD universe is the upstream
`define-product-intent` cell's accepted output fold
(`AcceptedIntentSet`, type-imported from `../product-intent/cell.ts`).
The gate builds `{ idSets: { prdMemberIds } }` from that exact set and
the WP03 validator resolves every scenario's `prdIntentRefs` against
it. A foreign PRD reference (another run, another project, a fabricated
member id) is refused `FOREIGN_LINEAGE` and routed `upstream-repair` -
never a silent scope widen. No upstream set supplied at all is a typed
`UPSTREAM_NOT_SUPPLIED` refusal (fail-closed; the gate never guesses
the accepted universe).

## Gate behavior summary

- Verdict routing (frozen table): identical to the product-intent cell;
  indeterminate reasons route to `human-wait` via the D5
  `TypedWait:human-input` descriptor, never a pass.
- Provider declaration digests cover the fence list (fence removal =
  digest mismatch = `PROVIDER_NOT_DECLARED`).
- Cell-level laws beyond the per-scenario WP03 contract: duplicate
  scenario ids (`MALFORMED_PRODUCT`) and the UC coverage fence - every
  `scenario_required` upstream intent member must be covered by at
  least one scenario's `prdIntentRefs` (`COVERAGE_GAP`).
- On accept the gate folds `AcceptedScenarioSet` (scenario ids,
  terminal-branch ids per owning scenario, covered PRD member ids,
  revision digest) - the exact accepted universe the
  `derive-system-requirements` cell (FRF-WP05) binds against; branch
  identities are recorded at their OWN level per owning scenario.
