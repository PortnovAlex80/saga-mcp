# FRF-WP06 — the define-acceptance-contract cell

Owner: FRF-WP06 (Acceptance and reconciliation). Plan:
`docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md`
("#Desk contracts/define-acceptance-contract", "#Desk
contracts/reconcile-what", "#Phase FRF-6"). Status: test-only reachable
until the FRF-WP11 cutover installs the cells package; the installed
workshop (`../manifest.ts`, `../products.ts`, `../gates.ts`) is
untouched by this package.

## Modules

| Module | Role |
|---|---|
| `protocol.mjs` | the cell protocol: flow position (after `derive-system-requirements`, accepted exit to `reconcile-what`), INPUT contract (accepted requirements bundle + accepted UC scenarios/branches + verifiable statements + evidence bindings), OUTPUT contract (`formalization.acceptance-bindings.v1` bundle), `acceptanceUniverseFrom` (builds the WP03 id-set universe, fail-closed) |
| `wp03-seam.mjs` | **the WP03 validator seam** (see below) |
| `closure.mjs` | the closure validators — pure checks the cell's gate runs: requirements coverage closure, AC-to-source closure, terminal-result coverage (cr-05), and the bundle validator `validateAcceptanceBundle` |
| `reconciliation.mjs` | report-only reconciliation (`reconcileWhat`) — names gaps, never mutates; carries the ACTUAL computed verdict (the F-2 fix) |
| `skill.mjs` | the desk semantic skill (installed id pattern `formalization-desk-define-acceptance-contract`) + the author checklist |
| `template.mjs` | the output templates (AC binding, deferral, evidence binding, bundle wrapper) |
| `check-plan.mjs` | the declared check provider `frf.acceptance-closure.v1` (succeeds installed `formalization.acceptance-structure.v1` at WP11), its CheckPlan evidence fact, and the ordered check list |
| `reviewer.mjs` | the reviewer contract: same-provider recheck, adversarial re-derivations, upstream escalation |
| `desk-roles.mjs` | the desk's two launch-kind bindings (author/reviewer; kernel protocol-role universe) |
| `gate.mjs` | `evaluateAcceptanceGate` — fail-closed provider verification + bundle validation + the frozen reason→verdict routing (pinned to `../gates.ts`) |
| `index.mjs` | the public surface |

## The WP03 validator seam

WP03 froze the AC binding payload contract
(`docs/refactoring/formalization-frf/contracts/schemas/ac-binding.schema.json`)
with the fail-closed typed validator
(`.../contracts/validators/ac-binding.mjs`, `validateAcBinding`), and
declared it "payload contract only … the FRF-04..09 cells will adopt
the schemas/validators as their product payload contracts and call the
validators with the exact accepted id sets carried by transitions".
This cell is that adoption:

- `wp03-seam.mjs` IMPORTS the actual WP03 validator module — never a
  copy — so contract and enforcement cannot drift.
- The cell gate (`closure.mjs` → `validateAcceptanceBundle`) runs
  `validateAcBinding` once per criterion with the universe built by
  `acceptanceUniverseFrom`; per-criterion refusals
  (`MALFORMED_PRODUCT`, `MISSING_LINEAGE`, `FOREIGN_LINEAGE`,
  `SCOPE_VIOLATION`) propagate VERBATIM — the cell never re-implements
  or weakens a WP03 law.
- The seam pins the adopted files' sha256 (`WP03_SEAM.validatorSha256`,
  `WP03_SEAM.commonSha256`); the focused test re-hashes the docs files
  and refuses on drift. The frozen contract may only change through a
  new WP03 version, never silently.
- The BOTH-citation-shapes law (reverse edges 0051+0052, ambiguity a-5
  resolution): a scenario-facing AC must retain its UC scenario binding
  AND its terminal-branch binding TOGETHER. Stripping either is a
  killed mutation.

## The closure laws (what the gate adds AROUND the seam)

The WP03 validator is per-criterion and id-set-based; it cannot see the
whole bundle or the requirements' own derivation. The closure
validators add the set-level laws:

1. **Requirements coverage closure** — every FR/NFR of the accepted
   bundle is covered by ≥1 criterion OR explicitly deferred
   (owner+reason). Uncovered → `COVERAGE_GAP` naming the requirement;
   RULE deferral → `FOREIGN_LINEAGE` (RULE is not AC-bindable);
   covered+deferred → `MALFORMED_PRODUCT` (contradictory disposition).
2. **AC-to-source closure** — a criterion binding scenario-derived
   FR/NFR material must carry BOTH citation shapes (the one-sided
   "FR without UC" defect → `MISSING_LINEAGE`); a cited scenario no
   bound requirement derives from → `FOREIGN_LINEAGE` (well-formed but
   semantically unrelated substitution); duplicate criterion ids →
   `MALFORMED_PRODUCT`.
3. **Terminal-result coverage (cr-05)** — every required UC terminal
   branch is covered by ≥1 end-to-end criterion or a well-formed
   accepted standalone evidence binding (closed four-kind vocabulary +
   observable terminal result). Uncovered → `COVERAGE_GAP` naming the
   branch and its owning scenario.

## Report-only reconciliation (the F-2 fix)

Forward-graph finding F-2 (frozen in
`docs/refactoring/formalization-frf/graphs/forward/forward-graph.json`):
the INSTALLED accepted-material fold hardcodes reconciliation verdict
`'consistent'` regardless of the product's actual verdict
(`contribution.ts:99-100`; ledger D-9 tightening). `reconciliation.mjs`
is the replacement surface:

- the verdict is COMPUTED — `findings.length === 0 ? 'consistent' :
  'gaps'` — never a parameter, never trusted from input;
- the report NAMES its gaps (typed findings over the closed chain:
  claim → intent → scenario → requirement → criterion → evidence);
- it NEVER mutates: pure function over the snapshot, returns a
  deep-frozen report; a lawful repair belongs to the owning upstream
  cell as a new immutable revision;
- row shape keeps the installed `formalization.what-reconciliation.v1`
  row contract (sourceClaimRef/memberRef/scenarioRef/requirementRefs/
  criterionRefs) so the WP11 cutover adopts it without a new artifact
  family.

## Reachability and purity laws

- Pure `.mjs` ES modules: no I/O, no clock, no session, no SQL, no
  persistence import. The canonical digest rule comes from the WP03
  shared helpers (byte-identical to `src/workflow-kernel/domain/digest.ts`
  — continuity asserted by the focused test against `dist/`).
- Test-only reachable: nothing under `src` (no compiled `.ts` module)
  imports this package, and `dist/` contains no cell output; the
  installed workshop's eleven-module enumeration is unchanged. Law
  tested in `tests/.../cells/acceptance/structure.test.mjs`.
- No bare quoted workshop-name literal (complexity dimension
  `workshops.nameBranchLiterals` stays 0).

## Focused tests

`tests/workflow-kernel/workshops/formalization/cells/acceptance/`:

- `acceptance-cell.test.mjs` — green path, seam identity + digest pin,
  protocol/skill/check-plan/reviewer/desk-role/template laws,
  gate routing pinned to the installed `gates.ts` source;
- `closure-validators.test.mjs` — the negative semantic fixtures
  (foreign AC refs; one-sided citations: FR-without-UC and
  branch-without-scenario; duplicate criterion ids; uncovered
  requirements without deferral) and the killed mutations per validator
  family;
- `reconciliation.test.mjs` — report-only laws: computed verdict (the
  F-2 kill), gap naming forward and reverse, input immutability,
  frozen report, deterministic digest;
- `structure.test.mjs` — the cell's structural fences (test-only
  reachability, purity, no SQL/clock literals, closed vocabularies);
- `fixtures/` — the green chain and the typed RED seeds (naming
  convention follows WP03: `NN-description.REASON.json`).
