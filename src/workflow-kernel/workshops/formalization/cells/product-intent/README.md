# FRF-WP04 Production Cell: `define-product-intent`

New parallel construction (plan
`docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md`, work
package FRF-WP04, desk contract "define-product-intent"). INSTALLED
since the FRF-WP11 cutover: the installed workshop routes the
define-product-intent desk through this cell (the manifest pins its
declared provider `frf-cell.product-intent.members.v1`), and the old
products.ts validator died at the cutover.

## Package contents

| File | Role |
| --- | --- |
| `seam.ts` | The WP03 contract seam (see below) |
| `cell.ts` | Identity, desk protocol (brief + capsule intents -> member drafts), skill declarations, product template, WP-17 role bindings, the cross-desk `AcceptedIntentSet` fold |
| `gate.ts` | CheckPlan, the declared deterministic check provider, the semantic gate (verdict routing, D5 human-wait, obligation routing, desk coverage law) |
| `reviewer.ts` | The independent reviewer (closed accept/repair verdicts over the gate outcome) |

## The WP03 contract seam (honest description)

The semantic authority for a PRD intent member is the FRF-WP03 contract
`frf-contracts.prd-intent-member.v1`:

- schema: `docs/refactoring/formalization-frf/contracts/schemas/prd-intent-member.schema.json`
- validator: `docs/refactoring/formalization-frf/contracts/validators/prd-intent-member.mjs`
  (pure, deterministic, fail-closed, typed refusal codes)

Those live in the **docs tree as `.mjs` modules**. This TypeScript
package cannot import them: `tsc` compiles `src/**` only, and FRF-WP03
deliberately added no production storage owner or compiled artifact for
the contracts. This cell therefore:

1. **never re-implements** the member contract (no second validator to
   drift), and
2. **never imports** the docs tree,
3. validates every member through `seam.ts`: a typed port
   (`ProductIntentContractPort`) installed exactly once
   (`installProductIntentContract`), pinned by a `validatorDigest`, and
   resolved fail-closed (`resolveProductIntentContract`). An unwired
   seam is a typed `CONTRACT_SEAM_UNWIRED` gate refusal - a bypassed
   validator can never become a silent pass.

**Who installs the port (since FRF-WP11):** the seam ITSELF - the
installed wiring self-installs the in-package validator
(`src/workflow-kernel/workshops/formalization/contracts/validators/
prd-intent-member.mjs`) on first resolution, pinned by the package
identity table (`contracts/identity.ts`). A test-side install of the
same pinned digest stays an idempotent no-op; a different digest is
refused (`CONTRACT_SEAM_REPINNED`). The docs-tree contract is a frozen
byte-equal snapshot (removal-guarded).

**Who installs it (since FRF-WP11):** the seam itself - the installed
wiring resolves the in-package validator through the pinned identity
table on first use. The pre-cutover test-only reset hook died with the
test-time injection (an unwired seam is unreachable in the installed
package; the swap fence is the identity-table pin).

## Gate behavior summary

- Verdict routing (frozen table): `MALFORMED_PRODUCT`/`MISSING_LINEAGE`/
  `STALE_LINEAGE`/`COVERAGE_GAP` -> `repair` (`obligation:requeueRepair`);
  `FOREIGN_LINEAGE` -> `upstream-repair`
  (`obligation:routeUpstreamRepair`, never a silent scope widen);
  `DRIFT_DETECTED` -> `human-wait` (D5 `TypedWait:human-input`,
  `obligation:requeueAfterHumanResolution`); `SCOPE_VIOLATION` ->
  `terminal-reject`; any other (indeterminate) reason -> `human-wait`
  via D5, never a pass.
- Provider declaration digests cover the fence list: a mutated
  declaration (fence removal, impostor id) fails digest verification
  (`PROVIDER_NOT_DECLARED`).
- Cell-level laws beyond the per-member WP03 contract: non-empty brief
  and members, duplicate member ids (`MALFORMED_PRODUCT`), and the desk
  coverage law - every accepted Discovery source claim must be realized
  by some member's `sourceClaimRefs`/`scopeClaimRefs` (`COVERAGE_GAP`).
- On accept the gate folds `AcceptedIntentSet` (member ids,
  `scenario_required` ids, member digests, revision digest) - the exact
  accepted universe the `model-use-cases` cell validates against.
