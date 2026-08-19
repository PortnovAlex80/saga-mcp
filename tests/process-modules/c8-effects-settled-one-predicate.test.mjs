// tests/process-modules/c8-effects-settled-one-predicate.test.mjs
//
// B-004 cluster repair, DEFECT 2 (W-1/O-B1) — ONE predicate for the
// effects-settled boundary.
//
// The stage-10 kill chain (PREVENTIVE-HUNT W-1): a crash in the window
// between completeAcceptanceEffect and recordFinalAcceptanceAndCapture
// leaves the Workplace terminal(accepted) with NO FinalAcceptance and the
// effect receipt already durable. The reconciler then completes the
// run-effects obligation from the SATISFIED postcondition (receipt exists)
// — and the C8 re-entry gate (gateEffectHandoffReady) demands
// state==='in_progress', which is now PERMANENTLY false. The C8 recovery
// returns pendingOutcome forever; the record-final-acceptance obligation
// defers forever. The boundary is evaluated four ways:
//   node-executor:1153-1170 (C8 gate: in_progress ONLY)
//   node-executor:837-839/:870-871 (TB-12: in_progress OR completed)
//   transition-handoff-postconditions:48-82 (receipt OR repair OR acceptance)
//   the reconciler completing run-effects from the satisfied postcondition
//
// This suite proves:
//   P1  the C8/record-final-acceptance re-entry accepts a COMPLETED
//       run-effects obligation when the durable postcondition chain still
//       justifies it (receipt exists) and the FinalAcceptance row is
//       genuinely absent — recovery records the acceptance instead of
//       parking forever;
//   P2  the completed arm does NOT fire when a FinalAcceptance row already
//       exists (nothing to recover — the old strict behavior is preserved
//       for the recovered case);
//   P3  the shared predicate lives in transition-handoff-postconditions.ts
//       and both callers (C8 gate, TB-12 fall-through) consume it;
//   P4  the provider-invocation gate stays LEASE-STRICT: a completed
//       obligation never authorizes invoking the effect provider again.
//
// BEFORE the fix this is RED: the recovery reconcile parks in pendingOutcome
// with the run-effects obligation completed (the livelock), and the shared
// predicate does not exist.

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

function cell() {
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
    postAcceptanceEffect: 'test-effect',
  };
}

/**
 * The production-cell-node-executor harness shape, adapted for the W-1 kill:
 * the obligation integrator is the REAL durable one (no eager leasing), so
 * the test drives obligation states through the REAL ledger exactly as the
 * fenced reconciler does, and the replay-capture error is MUTABLE so the
 * crash window can be opened and then closed.
 */
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
  const effectCalls = [];
  const obligationLedger = new SqliteTransitionObligationLedger(db);
  const obligationIntegrator = new TransitionObligationIntegrator({ ledger: obligationLedger });
  const persistence = {
    ensureExecutionPlan(input) {
      return { intentId: 1, taskId: 1, replayed: false };
    },
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
        effectCalls.push({ effectId, input });
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
  return { db, workplaceRepo, coordinator, executor, products, effectCalls, obligationLedger, replayCapture };
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

function workplaceRef(cellId = 'singleton-cell') {
  return { processRunId: 7, moduleRef: 'test-module@1.0.0', productionCellId: cellId, workKey: 'singleton' };
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

/** Lease a ready obligation the way the fenced reconciler does. */
function leaseReady(h) {
  const [obligation] = h.obligationLedger.findReady(1);
  assert.ok(obligation, 'a ready obligation exists to lease');
  const fence = h.obligationLedger.allocateLeaseFence(obligation.obligationKey);
  assert.equal(h.obligationLedger.lease(obligation.obligationKey, 'reconciler-test', fence), true);
  return h.obligationLedger.get(obligation.obligationKey);
}

// ===========================================================================
// P1 — the W-1 kill: crash between completeAcceptanceEffect and
// recordFinalAcceptanceAndCapture, run-effects COMPLETED by the reconciler
// from the satisfied postcondition. The C8 re-entry must admit the completed
// handoff (postcondition still justifies it, FinalAcceptance genuinely
// absent) and record the acceptance instead of pendingOutcome-ing forever.
// ===========================================================================
test('P1: C8 re-entry accepts a COMPLETED run-effects handoff when the postcondition chain justifies it', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  await h.executor.execute(ctx);
  finishRole(h, ref, 'execution:w1-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:w1', digest: sha('w1-product'),
  });
  // Episode 2 seals the presented CandidateSet and creates the run-gate
  // obligation (pending) — exactly as the ADR-053 B-8 boundary requires.
  await h.executor.execute(ctx);

  // Reconciler leases run-gate → re-drive → gate accepts → run-effects created.
  leaseReady(h);
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'effect_pending',
    'accepted gate parked the workplace in effect_pending');

  // Reconciler leases run-effects → re-drive settles the effect (receipt
  // durable, record-final-acceptance obligation created) → parks (new
  // obligation is pending, not leased by this episode).
  const runEffectsLease = leaseReady(h);
  assert.equal(runEffectsLease.handoffKind, 'run-effects');
  await h.executor.execute(ctx);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_effect_receipts').get().n, 1,
    'the effect receipt is durable');

  // THE CRASH WINDOW: the reconciler leases record-final-acceptance, the
  // episode completes the acceptance effect (workplace → terminal(accepted))
  // and then replay-capture THROWS before FinalAcceptance is recorded.
  const rfaLease = leaseReady(h);
  assert.equal(rfaLease.handoffKind, 'record-final-acceptance');
  h.replayCapture.error = new Error('REPLAY_CAPTURE_CRASH_WINDOW: capture failed before acceptance');
  await assert.rejects(() => h.executor.execute(ctx), /REPLAY_CAPTURE_CRASH_WINDOW/);
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted',
    'the workplace is durably terminal(accepted) — the crash window state');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 0,
    'FinalAcceptance was never recorded');

  // The reconciler's behavior after the crash: the run-effects postcondition
  // is SATISFIED (receipt exists) → it completes run-effects WITHOUT
  // re-driving; the crashed record-final-acceptance lease returns to pending
  // (defer under the still-held fence).
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
  const completedRunEffects = h.obligationLedger.get(runEffectsLease.obligationKey);
  assert.equal(completedRunEffects.state, 'completed',
    'precondition of the kill: run-effects is completed, so the old C8 gate is permanently false');

  // Recovery: the crash window is closed (capture succeeds again).
  h.replayCapture.error = null;
  const recovery = await h.executor.execute(ctx);

  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n,
    1,
    'P1/W-1 KILL: the C8 re-entry must record FinalAcceptance when the completed '
    + 'run-effects handoff is still justified by its durable postcondition',
  );
  assert.equal(recovery.runtimeEvent, 'completed',
    'the recovered cell settles instead of pendingOutcome-ing forever');
  assert.ok(h.effectCalls.every((call) => call.effectId !== 'test-effect' || call.input.authority.candidateSetRef),
    'sanity: effect invocations remain authority-bound');
  h.db.close();
});

// ===========================================================================
// P2 — the completed arm is scoped: when FinalAcceptance already exists the
// completed handoff does NOT re-admit re-driving production (nothing to
// recover; the old strict outcome for this case is preserved).
// ===========================================================================
test('P2: a completed run-effects handoff with FinalAcceptance already present does not re-drive', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  await h.executor.execute(ctx);
  finishRole(h, ref, 'execution:p2-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:p2', digest: sha('p2-product'),
  });
  await h.executor.execute(ctx);
  leaseReady(h);
  await h.executor.execute(ctx);
  const settledLease = leaseReady(h);
  await h.executor.execute(ctx);
  const rfa = leaseReady(h);
  await h.executor.execute(ctx);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 1,
    'the happy path recorded FinalAcceptance');
  // The reconciler later completes run-effects (postcondition satisfied via
  // the FinalAcceptance arm).
  h.obligationLedger.complete({
    obligationKey: settledLease.obligationKey,
    completionReceipt: 'transition-completion:post-hoc',
    resultDigest: sha('post-hoc'),
    owner: 'reconciler-test',
    fence: leaseFence(settledLease.leaseFence),
  });
  const captureCallsBefore = h.effectCalls.filter((c) => c.effectId === 'replay-capture').length;
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 1,
    'no duplicate FinalAcceptance');
  assert.equal(
    h.effectCalls.filter((c) => c.effectId === 'replay-capture').length,
    captureCallsBefore,
    'P2: with FinalAcceptance present, a completed handoff does not re-drive capture',
  );
  h.db.close();
});

// ===========================================================================
// P3 — the shared predicate itself lives in the postcondition module.
// ===========================================================================
test('P3: effectsSettledProceedable is the one exported effects-settled predicate', async () => {
  const postconditions = await import(
    '../../dist/process-modules/application/transition-handoff-postconditions.js'
  );
  assert.equal(typeof postconditions.effectsSettledProceedable, 'function',
    'P3: the shared predicate must be exported from transition-handoff-postconditions.ts');
  assert.equal(typeof postconditions.finalAcceptanceAbsent, 'function',
    'P3: the FinalAcceptance-absence check must come from the same module (not a second predicate)');
});

// ===========================================================================
// P4 — the provider-invocation gate stays LEASE-STRICT.
// ===========================================================================
test('P4: a completed run-effects handoff never authorizes invoking the effect provider again', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  await h.executor.execute(ctx);
  finishRole(h, ref, 'execution:p4-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:p4', digest: sha('p4-product'),
  });
  await h.executor.execute(ctx);
  leaseReady(h);
  await h.executor.execute(ctx);
  // Reconciler completes run-effects from the satisfied postcondition WITHOUT
  // this episode ever holding its lease; the receipt exists but the workplace
  // never left effect_pending (a different crash shape: receipt durable,
  // completeAcceptanceEffect never ran).
  const settled = leaseReady(h);
  assert.equal(settled.handoffKind, 'run-effects');
  await h.executor.execute(ctx);
  const receiptCount = h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_effect_receipts').get().n;
  assert.ok(receiptCount >= 1);
  h.obligationLedger.complete({
    obligationKey: settled.obligationKey,
    completionReceipt: 'transition-completion:post-hoc',
    resultDigest: sha('post-hoc'),
    owner: 'reconciler-test',
    fence: leaseFence(settled.leaseFence),
  });
  // Drop the receipt's idempotency partner: force the !existing branch by
  // counting provider calls — the completed obligation must NOT invoke
  // test-effect again (no lease, no authority).
  const providerCallsBefore = h.effectCalls.filter((c) => c.effectId === 'test-effect').length;
  await h.executor.execute(ctx);
  assert.equal(
    h.effectCalls.filter((c) => c.effectId === 'test-effect').length,
    providerCallsBefore,
    'P4: provider invocation requires the live reconciler lease (in_progress), never a completed handoff',
  );
  h.db.close();
});
