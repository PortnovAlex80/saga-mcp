// tests/process-modules/c8-recovery-effect-receipts.test.mjs
//
// B-004 cluster repair, DEFECT 3 (W-2) — C8 recovery must not write an
// unrecoverable FinalAcceptance.
//
// The defect (PREVENTIVE-HUNT W-2): the C8 recovery path and the direct
// terminal-capture path call recordFinalAcceptanceAndCapture(ref, accepted,
// []) — EMPTY effectReceiptRefs — while the record-final-acceptance
// obligation postcondition (transition-handoff-postconditions.ts, the
// 'record-final-acceptance' arm) demands that fa.effect_receipt_refs CONTAIN
// the exact 'cell-effect-receipt:<digest>' obligation source. The
// FinalAcceptance row is immutable and digest-fenced
// (CELL_FINAL_ACCEPTANCE_REPLAY_MISMATCH on any differing re-write), so the
// obligation can NEVER complete: a poisoned, unrecoverable row.
//
// Proves:
//   R1  after C8 crash recovery the FinalAcceptance row carries the ACTUAL
//       durable effect receipts resolved at recovery time (option a), and the
//       record-final-acceptance postcondition becomes SATISFIABLE — the
//       obligation can honestly complete;
//   R2  when the cell declares a post-acceptance effect but NO durable
//       receipt exists, recovery writes NOTHING and reports pendingOutcome
//       (option b) — the reason-identity valve (defect 1) then terminates the
//       wait honestly instead of leaving an unmatchable immutable row;
//   R3  for a cell with NO post-acceptance effect, [] remains the truthful
//       receipt set (no poison, no regression of the no-effect path).
//
// BEFORE the fix this is RED: R1 sees effect_receipt_refs='[]' and a
// permanently unsatisfiable postcondition; R2 sees a poisoned row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteWorkplaceProductionRevisionRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import { SqliteCellFinalAcceptance } from '../../dist/infrastructure/workplace/sqlite-cell-final-acceptance.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { ProductionCellNodeExecutor } from '../../dist/process-modules/application/node-executors/production-cell-node-executor.js';
import { CommitAcceptedCandidate } from '../../dist/process-modules/application/commit-accepted-candidate.js';
import { TransitionObligationIntegrator } from '../../dist/process-modules/application/transition-obligation-integrator.js';
import { SqliteTransitionObligationLedger } from '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { leaseFence } from '../../dist/process-modules/domain/transition-obligation.js';
import { readTransitionHandoffPostcondition } from '../../dist/process-modules/application/transition-handoff-postconditions.js';
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROVIDER = 'test.production-contract';
const PROVIDER_DIGEST = sha('provider');

function checkPlan(id, phase = 'final') {
  const entries = [{
    check: { providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST },
    parameters: {},
    environmentRef: null,
  }];
  const base = {
    checkPlanId: id,
    version: '1.0.0',
    entries,
    decisionPolicyRef: `test.${phase}.decision`,
    decisionPolicyDigest: sha(`${phase}.decision`),
    unknownErrorPolicy: 'fail-closed',
  };
  return { ...base, checkPlanDigest: sha(base) };
}

function cell({ effect = true } = {}) {
  return {
    id: 'singleton-cell',
    inputSelectors: ['source'],
    materialization: { completionPolicy: 'all' },
    author: { skillRef: 'author-profile', capabilityPreset: 'sandbox-code-author' },
    productContracts: [{
      binding: 'result', schemaRef: 'factory.test-product.v1', mediaType: 'application/json', cardinality: '1',
    }],
    authorGate: { gateId: 'author-gate', gatePhase: 'final', checkPlan: checkPlan('final-plan') },
    recovery: { maxAttempts: 2, onExhausted: 'fail' },
    transitions: { accepted: 'next', humanRequired: 'blocked', failed: 'failed' },
    ...(effect ? { postAcceptanceEffect: 'test-effect' } : {}),
  };
}

function harness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const coordinator = new ProductionCellCoordinator({
    db, workplaceRepo, authorityHeadRepo: new SqliteAcceptedAuthorityHeadRepository(db), now: () => new Date(),
  });
  const products = new Map();
  const obligationLedger = new SqliteTransitionObligationLedger(db);
  const obligationIntegrator = new TransitionObligationIntegrator({ ledger: obligationLedger });
  const persistence = {
    ensureExecutionPlan() { return { intentId: 1, taskId: 1, replayed: false }; },
    readTaskProjectRepositoryId() { return 1; },
    readProcessInputHash() { return sha('factory-order'); },
    activateRoleTask() {},
    concludeExecutionIntent() {},
    readExecutionReceipt(executionRef) { return { intentId: 1, taskId: 1, executionRef }; },
    projectWorkplace() {},
  };
  const replayCapture = { error: null };
  const executor = new ProductionCellNodeExecutor({
    db,
    coordinator,
    authorityCommit: new CommitAcceptedCandidate({ gateRepo, coordinator }),
    candidateSetRepo,
    gateRepo,
    revisionRepo: new SqliteWorkplaceProductionRevisionRepository(db),
    sealedProductMaterials: { seal() {}, readExact() { throw new Error('not used'); } },
    obligationIntegrator,
    persistence,
    postAcceptanceEffects: {
      identity(effectId) {
        return { effectId, version: '1.0.0', effectDigest: sha(`effect:${effectId}`) };
      },
      run(effectId, input) {
        if (effectId === 'replay-capture' && replayCapture.error) throw replayCapture.error;
        if (effectId === 'test-effect') {
          return {
            outcome: 'succeeded',
            receiptRef: `provider:${effectId}:${input.authority.candidateSetRef}`,
            receiptDigest: sha({ effectId, candidateSetRef: input.authority.candidateSetRef }),
          };
        }
        return { outcome: 'succeeded', receiptRef: 'unused', receiptDigest: sha('unused') };
      },
    },
    finalAcceptance: new SqliteCellFinalAcceptance(db),
    authorityHead: new SqliteAcceptedAuthorityHeadRepository(db),
    productReader: {
      readContributionProducts: ({ contributorRef }) => products.get(contributorRef) ?? [],
      readContributionProductPayload: () => null,
    },
    checkProviders: {
      resolve(providerId) {
        return providerId === PROVIDER
          ? { providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST, run: () => 'passed' }
          : null;
      },
    },
    resolveInstallationDigest: () => sha('installation'),
    now: () => new Date(),
  });
  return { db, workplaceRepo, coordinator, executor, products, obligationLedger, replayCapture };
}

function context(definition) {
  return {
    projectId: 1,
    epicId: 1,
    processRunId: 7,
    module: {
      identity: { name: 'test-module', version: '1.0.0', kind: 'development' },
      executionProfiles: [
        { id: 'author-profile', taskKind: 'test.author', executionSkill: 'author-skill', executionMode: 'tracker_only', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
      ],
    },
    node: { id: 'cell-node', kind: 'production-cell', label: 'Cell', description: 'Test cell', cellDefinition: definition },
    input: { order: 'frozen' },
    frame: { productions: {}, receipts: {}, runInput: {} },
    heartbeat() {},
    initiatedBy: 'test',
  };
}

function workplaceRef() {
  return { processRunId: 7, moduleRef: 'test-module@1.0.0', productionCellId: 'singleton-cell', workKey: 'singleton' };
}

function finishRole(h, ref, executionRef, product) {
  const queued = h.workplaceRepo.read(ref);
  const leased = h.workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase,
    loopState: 'leased',
    nextRole: queued.nextRole,
    terminalReason: null,
    activeReservationRef: executionRef,
  });
  assert.equal(leased.applied, true);
  const started = h.workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: leased.revision,
    kanbanPhase: leased.state.kanbanPhase,
    loopState: 'running',
    nextRole: leased.state.nextRole,
    terminalReason: null,
    activeReservationRef: executionRef,
  });
  assert.equal(started.applied, true);
  h.products.set(executionRef, [product]);
  h.coordinator.sealCandidateSet(ref);
}

function leaseReady(h) {
  const [obligation] = h.obligationLedger.findReady(1);
  assert.ok(obligation, 'a ready obligation exists to lease');
  const fence = h.obligationLedger.allocateLeaseFence(obligation.obligationKey);
  assert.equal(h.obligationLedger.lease(obligation.obligationKey, 'reconciler-test', fence), true);
  return h.obligationLedger.get(obligation.obligationKey);
}

/** Drive the full W-2 kill state: crash between completeAcceptanceEffect and
 * recordFinalAcceptanceAndCapture, then complete run-effects post-hoc. */
async function driveToCrashWindow(h, ctx, ref, marker) {
  await h.executor.execute(ctx);
  finishRole(h, ref, `execution:${marker}`, {
    schemaId: 'factory.test-product.v1', ref: `product:${marker}`, digest: sha(`${marker}-product`),
  });
  await h.executor.execute(ctx);
  leaseReady(h); // run-gate
  await h.executor.execute(ctx);
  const runEffectsLease = leaseReady(h); // run-effects
  await h.executor.execute(ctx); // settles the effect (receipt durable)
  const rfaLease = leaseReady(h); // record-final-acceptance
  h.replayCapture.error = new Error('REPLAY_CAPTURE_CRASH_WINDOW: capture failed before acceptance');
  await assert.rejects(() => h.executor.execute(ctx), /REPLAY_CAPTURE_CRASH_WINDOW/);
  h.obligationLedger.complete({
    obligationKey: runEffectsLease.obligationKey,
    completionReceipt: 'transition-completion:recovered-from-durable-postcondition',
    resultDigest: sha('recovered'),
    owner: 'reconciler-test',
    fence: leaseFence(runEffectsLease.leaseFence),
  });
  h.obligationLedger.defer({
    obligationKey: rfaLease.obligationKey,
    reason: 'FinalAcceptance for the exact EffectReceipt is not durable yet',
    owner: 'reconciler-test',
    fence: leaseFence(rfaLease.leaseFence),
  });
  h.replayCapture.error = null;
  return rfaLease;
}

// ===========================================================================
// R1 — the honest row: recovery resolves the ACTUAL durable receipts.
// ===========================================================================
test('R1: C8 recovery records FinalAcceptance with the ACTUAL durable effect receipts', async () => {
  const h = harness();
  const ctx = context(cell({ effect: true }));
  const ref = workplaceRef();
  const rfaLease = await driveToCrashWindow(h, ctx, ref, 'w2-r1');

  const receiptRef = h.db.prepare(
    'SELECT effect_receipt_ref FROM factory_cell_effect_receipts',
  ).get().effect_receipt_ref;
  assert.ok(receiptRef.startsWith('cell-effect-receipt:'),
    'precondition: a durable effect receipt exists to resolve');

  const recovery = await h.executor.execute(ctx);
  assert.equal(recovery.runtimeEvent, 'completed');

  const acceptance = h.db.prepare(
    'SELECT effect_receipt_refs, candidate_set_ref FROM factory_cell_final_acceptances',
  ).get();
  assert.ok(acceptance, 'FinalAcceptance recorded');
  const refs = JSON.parse(acceptance.effect_receipt_refs);
  assert.ok(
    Array.isArray(refs) && refs.includes(receiptRef),
    `R2/W-2 POISON: FinalAcceptance.effect_receipt_refs=${acceptance.effect_receipt_refs} `
    + `does not contain the durable receipt ${receiptRef} — an immutable, digest-fenced `
    + 'row the record-final-acceptance obligation can NEVER match',
  );

  // The obligation postcondition must now be satisfiable — the loop can
  // honestly complete instead of deferring forever.
  const obligation = h.obligationLedger.get(rfaLease.obligationKey);
  const postcondition = readTransitionHandoffPostcondition(h.db, obligation);
  assert.equal(postcondition.satisfied, true,
    `the record-final-acceptance postcondition must be satisfiable after honest `
    + `recovery (reason was: ${postcondition.reason})`);
  h.db.close();
});

// ===========================================================================
// R2 — no receipts + a declared effect: write NOTHING, return pendingOutcome.
// ===========================================================================
test('R2: a declared effect with NO durable receipt writes NO FinalAcceptance (honest pending)', async () => {
  const h = harness();
  const ctx = context(cell({ effect: true }));
  const ref = workplaceRef();
  await driveToCrashWindow(h, ctx, ref, 'w2-r2');

  // A recovery variant where the receipt is NOT durable (a second crash
  // window: receipt transaction lost). The tables are append-only; model the
  // "never recorded" state by dropping the guard triggers (established C8
  // test practice for post-crash never-written states).
  h.db.prepare('DROP TRIGGER trg_factory_cell_effect_receipts_no_delete').run();
  h.db.prepare('DELETE FROM factory_cell_effect_receipts').run();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_effect_receipts').get().n, 0);

  const recovery = await h.executor.execute(ctx);
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n,
    0,
    'R2/W-2: with a declared effect and no durable receipt, recovery must NOT '
    + 'write a FinalAcceptance that lies about its receipts — pendingOutcome + '
    + 'the reason-identity valve end the wait honestly',
  );
  assert.equal(recovery.runtimeEvent, 'paused',
    'recovery reports pendingOutcome (pause.kind=worker_active) so the valve '
    + '(defect 1) can terminate the wait');
  assert.equal(recovery.pause?.kind, 'worker_active');
  h.db.close();
});

// ===========================================================================
// R3 — no-effect cell: [] is the truthful receipt set (no regression).
// ===========================================================================
test('R3: a cell with no declared effect still records FinalAcceptance with the truthful empty set', async () => {
  const h = harness();
  const ctx = context(cell({ effect: false }));
  const ref = workplaceRef();
  await h.executor.execute(ctx);
  finishRole(h, ref, 'execution:w2-r3', {
    schemaId: 'factory.test-product.v1', ref: 'product:w2-r3', digest: sha('w2-r3-product'),
  });
  await h.executor.execute(ctx);
  leaseReady(h); // run-gate
  await h.executor.execute(ctx); // gate accepted; run-effects obligation minted
  leaseReady(h); // run-effects (a no-effect cell still mints the handoff; the
  // FinalAcceptance arm of its postcondition is what settles it)
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed');
  const acceptance = h.db.prepare(
    'SELECT effect_receipt_refs FROM factory_cell_final_acceptances',
  ).get();
  assert.ok(acceptance, 'the no-effect path still records FinalAcceptance');
  assert.deepEqual(JSON.parse(acceptance.effect_receipt_refs), [],
    'for a cell that declares no effect, [] is the complete truthful receipt set');
  h.db.close();
});
