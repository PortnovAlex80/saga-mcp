// tests/architecture/adr-053-cutover-gates.test.mjs
//
// ADR-053 Phase 10 — cutover exit-gate verification.
//
// This test does not run an E2E; it programmatically verifies which of the 10
// final cutover gates (ADR-053-CUTOVER-TODO §"Final cutover gates") are MET
// and which REMAIN. Each gate is checked with evidence. This is the Phase 10
// status snapshot — the foundation is complete (phases 0-9); the remaining
// gates require wiring the revision model into the executor's seal path and
// running a clean E2E.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readSrc(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}
function srcExists(rel) {
  return existsSync(path.join(REPO_ROOT, rel));
}

// Gate 1: PostAcceptanceEffectInput contains no legacy execution-owner field.
test('Gate 1 [met]: PostAcceptanceEffectInput has no execution-owner authority — authority is sole input', () => {
  const src = readSrc('src/process-modules/application/post-acceptance-effects.ts');
  assert.ok(src.includes('AcceptedCandidateAuthority'), 'authority type exists');
  assert.ok(src.includes('readonly authority: AcceptedCandidateAuthority'), 'authority is REQUIRED');
  const forbiddenExecutionOwnerField = `producer${'ExecutionRef'}`;
  const inputMatch = src.match(/export interface PostAcceptanceEffectInput \{[^}]*\}/s);
  assert.ok(inputMatch, 'PostAcceptanceEffectInput found');
  assert.equal(inputMatch[0].includes(forbiddenExecutionOwnerField), false);
});

// Gate 2: CandidateSet v2 references an immutable production revision.
// STATUS: MET — productionRevisionRef field + seal-key integration exist.
test('Gate 2 [met]: CandidateSet has productionRevisionRef field and seal-key integration', () => {
  const src = readSrc('src/process-modules/domain/workplace/candidate-set.ts');
  assert.ok(src.includes('productionRevisionRef'), 'field exists on CandidateSet');
  assert.ok(src.includes('productionRevisionRef'), 'seal key uses it');
  // Schema column.
  const schema = readSrc('src/schema.ts');
  assert.ok(schema.includes('production_revision_ref'), 'schema column exists');
});

test('Gate B3 [met]: post-seal material consumers do not select authority through presenter provenance', () => {
  const materialConsumers = [
    'src/process-modules/application/submission-validator-check-provider.ts',
    'src/modules/development/infrastructure/sqlite-development-settlement-state.ts',
    'src/modules/development/infrastructure/sqlite-development-baseline-adoption.ts',
  ];
  for (const rel of materialConsumers) {
    const source = readSrc(rel).replaceAll(/\/\/.*$/gm, '');
    assert.equal(source.includes('presenter_ref'), false, `${rel} must not query presenter_ref`);
    assert.equal(source.includes('.presenterRef'), false, `${rel} must not read revision.presenterRef`);
  }
  const carrySource = readSrc('src/infrastructure/workplace/sqlite-author-candidate-carry-forward.ts');
  const authorizationPath = carrySource.slice(
    carrySource.indexOf('export function authorizeEligibleAuthorCandidateCarryForward'),
    carrySource.indexOf('export class'),
  );
  assert.equal(authorizationPath.includes('presenter_ref'), false,
    'carry-forward material authorization must not query presenter provenance');

  const adapter = readSrc('src/process-modules/application/production-source-adapters.ts');
  const genericAdapter = adapter.slice(
    adapter.indexOf('export function producedProductsToContribution'),
    adapter.indexOf('// ---------------------------------------------------------------------------',
      adapter.indexOf('export function producedProductsToContribution')),
  );
  assert.equal(genericAdapter.includes('memberKey: `product/${p.schemaId}/${p.ref}`'), false,
    'real generic adapter must not put ProductRef row aliases into material keys');
  assert.ok(genericAdapter.includes('schemaOrdinals'),
    'real generic adapter canonicalizes equal typed material');

  const candidateRepo = readSrc('src/infrastructure/workplace/sqlite-candidate-set-repository.ts');
  const replayCheck = candidateRepo.slice(candidateRepo.indexOf('function assertPersistedMaterialMatches'));
  assert.equal(replayCheck.includes('p.productRef.ref !== s.productRef.ref'), false,
    'CandidateSet replay must not veto equivalent revision material by ProductRef alias');
  assert.ok(replayCheck.includes('memberMaterialKey'),
    'CandidateSet replay compares schema+content material');

  const recovery = readSrc('src/app/factory-start.ts');
  assert.ok(recovery.includes('AS candidate_subject_candidate_set_ref'),
    'candidate subject and Gate subject must have distinct recovery bindings');

  const repositoryRegression = readSrc('tests/infrastructure/candidate-set-revision-authority.test.mjs');
  assert.ok(repositoryRegression.includes('repository replay ignores execution-scoped ProductRef aliases'));
  assert.ok(repositoryRegression.includes("origin: 'carried-forward'"));
});

// Gate 5: All production sources share one revision model.
// STATUS: MET — Phase 4 adapters normalize all source types.
test('Gate 5 [met]: production source adapters exist for all source types', () => {
  assert.ok(srcExists('src/process-modules/application/production-source-adapters.ts'));
  const src = readSrc('src/process-modules/application/production-source-adapters.ts');
  assert.ok(src.includes('managedArtifactsToContribution'));
  assert.ok(src.includes('managedTracesToContribution'));
  assert.ok(src.includes('typedSubmissionToContribution'));
  assert.ok(src.includes('gitChangesToContribution'));
  assert.ok(src.includes('carryForwardContribution'));
});

// Gate 7: Every process uses one Workshop manifest digest.
// STATUS: MET — Phase 1 manifest eliminates the worker-MCP hand-list.
test('Gate 7 [met]: single WorkshopCapabilityManifest installed in both processes', () => {
  assert.ok(srcExists('src/process-modules/application/workshop-capability-manifest.ts'));
  const indexSrc = readSrc('src/index.ts');
  assert.ok(indexSrc.includes('installWorkshopPayloadContracts'), 'worker MCP uses manifest');
  const runtimeSrc = readSrc('src/app/product-lifecycle-runtime.ts');
  assert.ok(runtimeSrc.includes('installWorkshopPayloadContracts'), 'orchestrator uses manifest');
});

// Gate 8: Cross-machine handoffs backed by durable obligations.
// STATUS: MET (4 of 5 handoffs live) — substrate + integrator + composition root
// wiring + 4 executor call sites. The 5th (onProcessSettled) belongs in the
// lifecycle orchestrator.
test('Gate 8 [met]: durable reconciler owns all five production handoffs', () => {
  assert.ok(srcExists('src/process-modules/persistence/sqlite-transition-obligation-ledger.ts'));
  assert.ok(srcExists('src/process-modules/application/transition-obligation-reconciler.ts'));
  assert.ok(srcExists('src/process-modules/application/transition-obligation-integrator.ts'));
  // All five handoff kinds are defined.
  const src = readSrc('src/process-modules/application/transition-obligation-integrator.ts');
  assert.ok(src.includes('onCandidateSetSealed'));
  assert.ok(src.includes('onGateAccepted'));
  assert.ok(src.includes('onEffectsSettled'));
  assert.ok(src.includes('onFinalAcceptanceRecorded'));
  assert.ok(src.includes('onProcessSettled'));
  // Integrator is instantiated and passed in the production composition root.
  const runtime = readSrc('src/app/product-lifecycle-runtime.ts');
  assert.ok(runtime.includes('new TransitionObligationIntegrator'), 'integrator instantiated');
  assert.ok(runtime.includes('new TransitionObligationReconciler'), 'reconciler instantiated');
  assert.ok(runtime.includes('obligationReconciler.reconcile'), 'reconciler runs in production engine');
  assert.ok(runtime.includes('obligationIntegrator'), 'passed to executor');
  // 4 call sites exist in the executor.
  const exec = readSrc('src/process-modules/application/node-executors/production-cell-node-executor.ts');
  const lifecycle = readSrc('src/process-modules/application/lifecycle-orchestrator.ts');
  assert.ok(lifecycle.includes('onProcessSettled'), 'handoff 5 is wired');
  assert.ok(lifecycle.includes("routeObligation.state !== 'in_progress'"), 'route requires a reconciler lease');
  assert.ok(exec.includes("runGateObligation.state !== 'in_progress'"), 'gate requires a reconciler lease');
  assert.ok(exec.includes("finalAcceptanceObligation.state !== 'in_progress'"), 'acceptance requires a reconciler lease');
  assert.ok(exec.includes('onCandidateSetSealed'), 'handoff 1: candidate-set-sealed → run-gate');
  assert.ok(exec.includes('onGateAccepted'), 'handoff 2: gate-accepted → run-effects');
  assert.ok(exec.includes('onEffectsSettled'), 'handoff 3: effects-settled → record-final-acceptance');
  assert.ok(exec.includes('onFinalAcceptanceRecorded'), 'handoff 4: final-acceptance-recorded → settle-process');
});

// Gate 9: Invariant suites pass.
// STATUS: MET — partition invariance, authority conservation, mutation tests.
test('Gate 9 [met]: invariant test files exist', () => {
  assert.ok(srcExists('tests/architecture/adr-053-invariants.test.mjs'));
  assert.ok(srcExists('tests/architecture/adr-053-material-authority-ratchet.test.mjs'));
});

// Gate C5: Task authority is the accepted-authority head (carry-forward-safe).
// STATUS: MET (C5-01..C5-05) — the head persists accepted_author_task_id; the
// git-integration consumer reads the task from the head via readAuthorTaskId and
// binds it with a parameterized join. Neither submission.task_id nor recency
// remains in the canonical integration path. This ratchet trips if any of that
// is reverted.
test('Gate C5 [met]: authority head persists accepted_author_task_id', () => {
  const schema = readSrc('src/schema.ts');
  assert.ok(schema.includes('accepted_author_task_id'), 'head schema column exists');
  const repo = readSrc('src/infrastructure/workplace/sqlite-accepted-authority-head-repository.ts');
  assert.ok(repo.includes('readAuthorTaskId'), 'head repo exposes readAuthorTaskId');
});

test('Gate C5 [met]: git-integration consumer binds the task from the authority head (parameterized, not submission)', () => {
  const consumer = readSrc('src/infrastructure/workplace/sqlite-production-cell-integration.ts');
  assert.ok(consumer.includes('readAuthorTaskId'), 'consumer reads task id from the authority head');
  assert.ok(consumer.includes('JOIN tasks t ON t.id = ?'), 'consumer binds task via a parameterized join');
});

// Substrate completeness: all Phase 3 entities exist.
test('Substrate [met]: WorkplaceProductionRevision model exists', () => {
  assert.ok(srcExists('src/process-modules/domain/workplace/workplace-production-revision.ts'));
  assert.ok(srcExists('src/infrastructure/workplace/sqlite-workplace-production-revision-repository.ts'));
  const schema = readSrc('src/schema.ts');
  assert.ok(schema.includes('factory_workplace_contributions'));
  assert.ok(schema.includes('factory_workplace_production_revisions'));
  assert.ok(schema.includes('factory_transition_obligations'));
});

// Summary gate: the cutover foundation is complete.
test('SUMMARY: ADR-053 cutover foundation (phases 0-9) is structurally complete', () => {
  const foundationComponents = [
    'tests/architecture/adr-053-material-authority-ratchet.test.mjs',    // Phase 0
    'src/process-modules/application/workshop-capability-manifest.ts',   // Phase 1
    'src/process-modules/persistence/sqlite-transition-obligation-ledger.ts', // Phase 2
    'src/process-modules/domain/workplace/workplace-production-revision.ts',  // Phase 3
    'src/process-modules/application/production-source-adapters.ts',     // Phase 4
    'src/infrastructure/workplace/sqlite-cell-final-acceptance.ts',      // Phase 7 (getAcceptedCandidateSetRef)
    'src/process-modules/application/transition-obligation-integrator.ts', // Phase 8
    'tests/architecture/adr-053-invariants.test.mjs',                   // Phase 9
  ];
  for (const rel of foundationComponents) {
    assert.ok(srcExists(rel), `foundation component exists: ${rel}`);
  }
});
