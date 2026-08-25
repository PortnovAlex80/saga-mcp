# EK-8 deletion set — legacy Development dispatch / coordinator / material-selection paths

WP-08 deliverable (plan EK-5): identify the EXACT legacy files and wiring the
EK-8 atomic cutover deletes once `src/workflow-kernel/development/**` becomes
the production Development authority. The new vertical is reachable only from
`tests/workflow-kernel/development/**` until then; nothing in this list may
be deleted before the cutover (they still own the legacy production path).

## 1. Legacy Development module (dispatch/coordinator surface)

- `src/modules/development/**` — the whole legacy module:
  - `application/development-installation.ts`, `application/development-production-cell-installation.ts` (cell bootstrapping that Workplace.materialize + workItem.planGraph now own)
  - `application/development-workspace-preparation.ts` (desk/workspace prep replaced by workplace.admitWorkIntent + the resolved role contract)
  - `application/candidate-check-contracts.ts`, `application/development-check-providers.ts` (check wiring replaced by CheckPlan external input evidence + workplace.runAuthorGate/runFinalGate)
  - `application/development-redevelopment-policy.ts`, `application/replan-case-builder.ts`, `application/replan-supersede.ts` (replan authority replaced by typed repair obligations: obligation:requeueRepair / routeUpstreamRepair; ADR-053 forbids silent supersede)
  - `application/development-srs-artifact-content.ts`
  - `domain/**`, `infrastructure/sqlite-development-verification-adoption.ts` and the rest of the module tree (sole owner of Development transitions becomes the Workplace reducer)
- `src/process-modules/modules/development/**` — the legacy Development process modules:
  - `development-process-module.ts`, `development-continuation-process-module.ts`, `development-verification-continuation-process-module.ts`, `package/**` (flow ownership moves to ProcessRun module flows from the installed manifest; R17)

## 2. Legacy material selection / accepted-material authority (ADR-053 core)

- `src/infrastructure/workplace/sqlite-author-candidate-carry-forward.ts` — carry-forward of author candidates; replaced by workplace.presentCandidateSet + CandidateSet evidence (no mutable carry-forward)
- `src/infrastructure/workplace/sqlite-production-cell-integration.ts`, `sqlite-production-cell-projection-persistence.ts` — the WorkerExecution-as-material-authority projection path; replaced by the Workplace production revision (the accepted material authority; WorkerExecution is provenance only)
- `src/infrastructure/workplace/sqlite-reconciliation-ledger.ts`, `sqlite-replan-mandate-ledger.ts` — replaced by the event-projected ledger + ForwardReverseReconciliationReceipt (R7, settlement-time)
- Legacy dispatch/coordinator wiring that selects Development work by scanning boards/queues:
  - `src/app/composition-root.ts` — ONLY the Development module registration + dispatcher binding blocks (the file itself survives for other modules until their WPs cut over)
  - `src/app/factory-redevelopment.ts`, `src/app/factory-continuation.ts`, `src/app/factory-documentation-continuation.ts` — Development continuation entrypoints replaced by lifecycleRun.createContinuation + stage routes
  - `tracker-view/claude-runner.mjs` Development spawn path + `tracker-view/engine-supervisor.mjs` Development dispatch loop sections that bypass the cognition transport contract (the opencode shim survives; it is re-bound behind CognitionTransportContract at EK-8)
  - `src/infrastructure/workers/claude-worker-executor-factory.ts` — worker executor factory replaced by the actor port (scripted/replay/real behind the same CognitionTransportContract)

## 3. What is NOT deleted (explicitly preserved)

- `src/workflow-kernel/**` (all packages; the new authority)
- `docs/architecture/decisions/053-*` and the conveyor documents (normative)
- The opencode shim `tools/agent-proxy/claude-shim.mjs` and the
  FACTORY_CLAUDE_BACKEND_FORBIDDEN enforcement in `tracker-view/claude-runner.mjs`
  (re-bound behind the real-actor channel at EK-8, never deleted)
- Legacy Discovery/Formalization stage modules (their WPs own their cutover)

## 4. Cutover proof obligations for EK-8 (derived from WP-08 tests)

- `tests/workflow-kernel/development/structure.test.mjs` pins: no production
  entrypoint outside the kernel imports `workflow-kernel/development`;
  actors import no persistence surface.
- After deletion, `npm run build` + all kernel suites + `test:architecture`
  must stay green with the legacy files gone (ratchet, no zombie imports).
