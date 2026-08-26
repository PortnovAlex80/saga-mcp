# EK-8 deletion set — legacy Formalization dispatch / coordinator / baseline paths

WP-11F deliverable (plan phase EK-8 workshop conversion): identify the
EXACT legacy files and wiring the WP-12 atomic cutover deletes once
`src/workflow-kernel/workshops/formalization/**` becomes the production
Formalization authority. The new package is reachable only from
`tests/workflow-kernel/workshops/formalization/**` until then; nothing in
this list may be deleted before the cutover (they still own the legacy
production path).

## 1. Legacy Formalization module (dispatch/coordinator surface)

- `src/modules/formalization/**` — the whole legacy module:
  - `application/formalization-production-cell-installation.ts` (cell
    bootstrapping that Workplace materialization + the installed manifest
    flow now own)
  - `application/formalization-check-providers.ts`,
    `application/formalization-check-refs.ts`,
    `application/acceptance-contract-validator.ts`,
    `application/formalization-contract-validator.ts`,
    `application/srs-contract-validator.ts`,
    `application/srs-structural-check-provider.ts` (check wiring replaced
    by CheckPlan external input evidence + the declared semantic providers
    of `workshops/formalization/gates.ts`)
  - `application/formalization-accept-products-effect.ts` (effect
    authority replaced by idempotent effects settled through
    workplace.settleEffect — the sole EffectReceipt writer, R13)
  - `application/reconciliation-payload-contract.ts`,
    `application/constraint-coverage.ts`,
    `application/formalization-contract-analysis.ts`,
    `application/srs-d2-parser.ts`, `application/artifact-content-reader.ts`,
    `application/architecture-check-plan.ts` (rescan/parse surfaces
    replaced by the content-addressed product schemas + the accepted
    material chain of `workshops/formalization/products.ts`)
  - `domain/**` (SRS contract, schemas, artifact-ref bridge, kernel ports)
    and `infrastructure/sqlite-formalization-kernel.ts`,
    `infrastructure/sqlite-formalization-package-adapters.ts`,
    `infrastructure/formalization-persistence.ts` (sole owner of
    Formalization transitions becomes the event-projected kernel)
- `src/process-modules/modules/formalization/**` — the legacy Formalization
  process module:
  - `formalization-process-module.ts` and `package/**` (flow ownership
    moves to the installed workshop manifest data — R17; the successor
    scenario-first flow — six Production Cells + freeze + settle — is
    manifest content, not code)

## 2. Legacy accepted-material / baseline authority (ADR-053 core)

- The acceptance-only baseline freeze path
  (`freeze-acceptance-baseline` handler +
  `ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA` consumers) — replaced by the
  content-addressed whole-WHAT baseline
  (`workshops/formalization/products.ts: freezeWhatBaseline`) sealed as a
  Workplace production revision
- The Solution Contract issuance path that rescans accepted artifacts by
  epic/lifecycle/task/status/type/chronology — replaced by
  `settleSolutionContract` (exact references to both authorities; never a
  rescan)
- Legacy dispatch/coordinator wiring that selects Formalization work by
  scanning boards/queues or carry-forward state:
  - `src/app/composition-root.ts` — ONLY the Formalization module
    registration + dispatcher binding blocks (the file itself survives for
    other modules until their WPs cut over)
  - tracker-view dispatch loop sections that spawn Formalization desks
    outside the cognition transport contract (the opencode shim survives;
    it is re-bound behind CognitionTransportContract at the cutover)

## 3. What is NOT deleted (explicitly preserved)

- `src/workflow-kernel/**` (all packages; the new authority)
- `src/modules/discovery/**`, `src/process-modules/modules/discovery/**`
  (the Discovery WP-11D owns their cutover)
- `docs/architecture/decisions/053-*` and the conveyor documents
  (normative); `docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md`
  (the semantic reference for the target desk contracts)
- The opencode shim `tools/agent-proxy/claude-shim.mjs` and the
  FACTORY_CLAUDE_BACKEND_FORBIDDEN enforcement in
  `tracker-view/claude-runner.mjs` (re-bound behind the real-actor channel
  at the cutover, never deleted)

## 4. Cutover proof obligations for WP-12 (derived from the WP-11F tests)

- `tests/workflow-kernel/workshops/formalization/structure.test.mjs` pins:
  no production entrypoint outside the kernel imports
  `workflow-kernel/workshops/formalization`; the pure modules import no
  persistence surface; only frozen command ids are composed; no quoted
  workshop-name literal appears in kernel scope (complexity dimension
  `workshops.nameBranchLiterals` stays 0).
- After deletion, `npm run build` + all kernel suites + `test:architecture`
  must stay green with the legacy files gone (ratchet, no zombie imports).
