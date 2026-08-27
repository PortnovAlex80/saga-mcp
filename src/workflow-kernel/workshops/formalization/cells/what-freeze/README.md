# FRF-WP07 — the WHAT-freeze cell (freeze-what-baseline + settle-formalization)

Work package FRF-WP07 of the Formalization Scenario-First Refactoring Plan
(plan §FRF-WP07: "replacement baseline, exact accepted-authority ingestion,
persistence, settlement, solution contract, and authority mutations"; plan
phase FRF-7). Owned paths: this directory and
`tests/workflow-kernel/workshops/formalization/cells/what-freeze/**`.

## What this cell is

The replacement authority pair for the two Formalization KERNEL desks:

- `freeze-what-baseline` — freezes the **whole-WHAT baseline**
  (`frf-contracts.what-baseline.v1`) from the exact accepted-authority
  surfaces (ledger D-10 resolved by EXTENDING the frozen sections: the six
  member containers, the five disposition sections, the evidence-method
  bindings and the trace set are distinct named sections — the legacy
  folded shape `formalization.what-baseline.v1`
  (`memberDigests`/`acceptedTraceDigest`) is refused on sight, forward
  finding F-8).
- `settle-formalization` — the settlement ladder (authority pins →
  binding resolution → seal) emitting
  `frf-contracts.solution-contract.v1`, whose twelve typed Development
  handoff kinds resolve against the **FROZEN baseline's exact id sets**
  per the baseline's own `developmentSurface.*.resolvesAgainst`
  declaration (reverse cr-02 / ledger D-1: FOREIGN_LINEAGE refusal — the
  UC-FOREIGN kill at the contract level).

## Modules

| Module | Responsibility |
|---|---|
| `protocol.mjs` | Desk identities, product kinds, transitions, the frozen refusal→outcome routing tables (drift ⇒ `drift-detected`; missing surfaces ⇒ `indeterminate`/D5; foreign ⇒ `upstream-repair`) |
| `ingestion.mjs` | Exact accepted-authority ingestion: fail-closed surface carry, baseline assembly (no folding), exact-authority assertion (id-for-id AND digest-for-digest), `verifyPresentedBaseline` (the substitution fence for presented material) |
| `freeze.mjs` | The desk driver: ingest → WP03-validate → seal → outcome route (opens the D12 drift wait / D5 indeterminate wait) |
| `settlement.mjs` | The settlement ladder + the sealed solution contract + the binding-aware `validateSolutionContract` (the settler fence A2: never emits what it cannot validate) |
| `persistence.mjs` | The immutable kernel-evidence ledger (exactly-once per content digest; a second different baseline per case is DRIFT) and the typed waits (D5/D12 vocabulary ONLY) |
| `checkplan.mjs` | The deterministic CheckPlan rows + gate declarations + first-match fail-closed evaluator (drift disposition is operator-only) |
| `reviewer.mjs` | Typed review verdicts binding the EXACT artifact (ref + whole-WHAT/canonical digest; monotonicity fences) |
| `desk-bindings.mjs` | Desk role bindings (reviewer launch kind; no authoring actor — the products are built deterministically; named desk-bindings because the EK-2 complexity dimension `roles.bindingAuthorities` binds at ≤1 kernel role-binding stem file) |
| `skill.mjs` | Installed skill artifacts (operator/reviewer runbooks; ids follow the installed manifest convention) |
| `template.mjs` | The sectioned authoring template — every WP03 section a distinct block, so a folded draft cannot even render |
| `shared.mjs` | The typed-refusal surface and **the WP03 seam** |

## THE FRF-WP03 VALIDATOR SEAM (required documentation)

The cell does NOT re-implement the whole-WHAT baseline contract. It
imports the FRF-WP03 typed validator and canonical helpers by exact
relative path from the frozen WP03 contracts:

```
docs/refactoring/formalization-frf/contracts/validators/what-baseline.mjs
  → validateWhatBaseline, CONTRACT_KIND,
    HANDOFF_BINDING_KINDS, WORK_ITEM_OBLIGATION_KINDS
docs/refactoring/formalization-frf/contracts/validators/common.mjs
  → sha256OfCanonical, digestExcluding, canonicalJson, findDuplicates, setIdentical
```

Laws of the seam (pinned by `seam.test.mjs`):

- **S1** one contract identity: the cell's `CONTRACT_KIND` IS the WP03
  validator's `frf-contracts.what-baseline.v1` (no fork);
- **S2** canonical digest parity: the WP03 helpers are byte-identical to
  the kernel rule `dist/workflow-kernel/domain/digest.js` (recursively
  key-sorted compact JSON, sha256/UTF-8);
- **S3** the cell reproduces the committed WP03 green fixture digests
  byte-for-byte (independent evidence, never generated from this cell);
- **S4** only the closed seven-code refusal vocabulary;
- **S5** the WP03 red baseline seeds (32–49) stay killed through the
  cell's presented-baseline verification path;
- **S6** the settlement resolves against exactly the WP03 frozen
  handoff/obligation vocabularies (12 + 5).

**WP11 integration contract (landed 2026-08-27):** this cell is INSTALLED (the
production entrypoint imports it; nothing compiled into `dist/`; asserted
by `cell-contracts.test.mjs`). At the FRF-WP11 package integration the
seam flips: the WP03 validators are compiled into the installed package,
the `docs/` relative import dies, the installed
`formalization.baseline-freeze.v1` / `formalization.settlement-structure.v1`
check providers re-point at these validators, and the folded
`formalization.what-baseline.v1` product is deleted (plan FRF-7 "delete
the acceptance-only baseline schema" was already executed at EK-8; the
FOLD replacement happens at that cutover). The module files are `.mjs`
so the pre-integration package inventory guards (the eleven-module
structure test) stay green; the identity data (node ids, provider ids,
effect ids, skill ids, launch kinds) is cross-checked against the
INSTALLED manifest in `dist` by the blocking tests, so the cutover flips
data, not identities.

## RED seeds (authority mutations — all killed deterministically)

| Seed | First detector |
|---|---|
| Substituted member (same id, foreign digest, all digests recomputed) | `ingestion.assertExactAuthority` → DRIFT_DETECTED |
| Substituted member via surfaces (fresh well-formed foreign scenario, "another run") | WP03 validator frozen-member universe → FOREIGN_LINEAGE |
| Folded section (disposition records lost / evidence bindings dropped) | `ingestion.checkNoFolding` → DRIFT_DETECTED; legacy shape → MALFORMED_PRODUCT on sight |
| Foreign handoff binding (the UC-FOREIGN reproduction: every binding array foreign) | `settlement.resolveHandoffKind` → FOREIGN_LINEAGE, outcome `inconsistent` |
| Duplicate member digest | WP03 validator allDigests fence → DRIFT_DETECTED (D12 wait) |
| Stripped scenario bindings (AC ids retained) | `settlement.settlementBindingResolution` → MISSING_LINEAGE |
| Substituted case identity | `ingestion.universeOfSurfaces` external pin → DRIFT_DETECTED |
| Stale container revision | WP03 validator revision pins → STALE_LINEAGE |

## Residuals / coordinator notes

- The EK deletion-manifest V2 guard (matrix group `ek-manifest-guard`)
  is RED at base with 89 findings (all FRF files are unclassified in the
  EK-owned manifest — the same class WP03 landed under). This package's
  files join that pending classification; the coordinator classifies at
  WP11 (tracker row FRF-WP01 already records the debt).
- The Development-side consumption of the solution contract (plan §FRF-9)
  is FRF-WP09's assignment; this cell produces the contract and its
  resolution surfaces only.
