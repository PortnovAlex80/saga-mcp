// tests/process-modules/finding-trajectory-chain.test.mjs
//
// FINDING-TRAJECTORY BUDGET, unit 2 of 3 — the append-only
// factory_gate_finding_set_chain and the atomic write at driveGateRun
// decision time (docs/architecture/FINDING-TRAJECTORY-BUDGET.md).
//
//   W1 — every repair_required decision appends exactly ONE finding-set row
//        (digest/count/keys/fatalKeys) derived from the decision's OWN check
//        receipts through the shared decodeFindingsForDecision; a replayed
//        decision appends nothing (UNIQUE gate_decision_key).
//   T7 — the chain RESETS on a check_plan_digest change: the reader scope is
//        (workplace, gate, role, check_plan_digest) derived from the latest
//        row — findings under a different plan are not comparable evidence.
//
// Findings use the REAL stage-11 shape (development task-graph contract):
// 'implementation items X and Y overlap without a dependency order'.

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
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import { findingSet } from '../../dist/process-modules/domain/workplace/finding-trajectory.js';
import { SqliteGateFindingSetChain } from '../../dist/infrastructure/workplace/sqlite-gate-finding-set-chain.js';
import {
  countGateRejectedCandidateSets,
} from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROVIDER = 'test.production-contract';
const PROVIDER_DIGEST = sha('provider');

// Stage-11 finding fixtures — pairwise overlap diagnostics.
const OVERLAP_CODE = 'implementation-scope-overlap';
function overlapDiagnostic(left, right) {
  return encodeCheckDiagnostic({
    code: OVERLAP_CODE,
    message: `implementation items '${left}' and '${right}' overlap without a dependency order`,
  });
}
const SIX_ITEMS = ['auth', 'billing', 'cart', 'deck', 'email', 'files'];
const FIRST_ATTEMPT_PAIRS = [];
for (let i = 0; i < SIX_ITEMS.length; i += 1) {
  for (let j = i + 1; j < SIX_ITEMS.length; j += 1) {
    FIRST_ATTEMPT_PAIRS.push([SIX_ITEMS[i], SIX_ITEMS[j]]);
  }
}
const SECOND_ATTEMPT_PAIRS = [
  ['auth', 'billing'], ['auth', 'email'], ['billing', 'email'], ['cart', 'deck'], ['email', 'files'],
];

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
    authorGate: {
      gateId: 'author-gate', gatePhase: 'final', checkPlan: checkPlan('author-plan'),
    },
    review: undefined,
    recovery: { maxAttempts: 30, onExhausted: 'requeue' },
    transitions: { accepted: 'next', humanRequired: 'blocked', failed: 'failed' },
  };
}

// The check outcome is controlled per attempt: a rejected attempt carries the
// exact stage-11 overlap diagnostics as evidence.
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
  const durableIntegrator = new TransitionObligationIntegrator({ ledger: obligationLedger });
  const eagerLease = method => input => {
    let obligation = durableIntegrator[method](input);
    if (obligation.state === 'pending') {
      const fence = obligationLedger.allocateLeaseFence(obligation.obligationKey);
      obligationLedger.lease(obligation.obligationKey, 'chain-unit-test', fence);
      obligation = obligationLedger.get(obligation.obligationKey);
    }
    return obligation;
  };
  const obligationIntegrator = {
    onCandidateSetSealed: eagerLease('onCandidateSetSealed'),
    onGateAccepted: eagerLease('onGateAccepted'),
    onEffectsSettled: eagerLease('onEffectsSettled'),
    onProcessSettled: eagerLease('onProcessSettled'),
  };
  let id = 100;
  let checkOutcome = { outcome: 'passed', evidenceRefs: [] };
  const persistence = {
    ensureExecutionPlan() { return { intentId: id++, taskId: id++, replayed: false }; },
    bindProjectedTaskProcessContext() {},
    readTaskProjectRepositoryId() { return 1; },
    readProcessInputHash() { return sha('factory-order'); },
    activateRoleTask() {},
    concludeExecutionIntent() {},
    readExecutionReceipt: executionRef => ({ intentId: 1, taskId: 1, executionRef }),
    projectWorkplace() {},
  };
  persistence.countGateRejectedCandidateSets = (ref, role) =>
    countGateRejectedCandidateSets(db, serializeWorkplaceRef(ref), role);
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
      run: (effectId, input) => ({
        outcome: 'succeeded',
        receiptRef: `provider:${effectId}:${input.candidateSetRef}`,
        receiptDigest: sha({ effectId, candidateSetRef: input.candidateSetRef }),
      }),
    },
    finalAcceptance: new SqliteCellFinalAcceptance(db),
    authorityHead: new SqliteAcceptedAuthorityHeadRepository(db),
    productReader: {
      readContributionProducts: ({ contributorRef }) => products.get(contributorRef) ?? [],
      readContributionProductPayload: () => null,
    },
    checkProviders: {
      resolve: providerId => (providerId === PROVIDER
        ? {
          providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST,
          run: () => checkOutcome,
        }
        : null),
    },
    resolveInstallationDigest: () => sha('installation'),
    now: () => new Date(),
  });
  const setCheckDiagnostics = (outcome, diagnostics) => {
    checkOutcome = { outcome, evidenceRefs: diagnostics };
  };
  return {
    db, workplaceRepo, coordinator, candidateSetRepo, executor, products, persistence,
    setCheckDiagnostics, chain: new SqliteGateFindingSetChain(db),
  };
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

async function rejectedAttempt(h, ctx, ref, label, diagnostics) {
  h.setCheckDiagnostics('failed', diagnostics);
  finishRole(h, ref, `execution:${label}`, {
    schemaId: 'factory.test-product.v1', ref: `product:${label}`, digest: sha(label),
  });
  await h.executor.execute(ctx);
  const state = h.coordinator.readState(ref);
  assert.equal(state.loopState, 'repair_wait', `attempt ${label} must be rejected into repair_wait`);
}

test('W1: a repair_required decision atomically appends ONE finding-set chain row (stage-11 shape)', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  await h.executor.execute(ctx); // hire the author

  await rejectedAttempt(h, ctx, ref, 'attempt-1',
    FIRST_ATTEMPT_PAIRS.map(([a, b]) => overlapDiagnostic(a, b)));
  const serialized = serializeWorkplaceRef(ref);
  let rows = h.db.prepare(
    'SELECT gate_decision_key, finding_set_digest, finding_count, fatal_finding_count, '
    + 'finding_keys, fatal_finding_keys FROM factory_gate_finding_set_chain WHERE workplace_ref=?',
  ).all(serialized);
  assert.equal(rows.length, 1, 'exactly one chain row per repair_required decision');
  const expected = findingSet(FIRST_ATTEMPT_PAIRS.map(([a, b]) => ({
    code: `${PROVIDER}:${OVERLAP_CODE}`,
    severity: 'error',
    message: `implementation items '${a}' and '${b}' overlap without a dependency order`,
  })));
  assert.equal(rows[0].finding_count, 15, 'the 15-finding stage-11 first attempt');
  assert.equal(rows[0].finding_set_digest, expected.digest,
    'the row digest equals the pure-module findingSet digest over the same findings');
  assert.deepEqual(JSON.parse(rows[0].finding_keys), [...expected.keys]);
  assert.deepEqual(JSON.parse(rows[0].fatal_finding_keys, ), []);

  await rejectedAttempt(h, ctx, ref, 'attempt-2',
    SECOND_ATTEMPT_PAIRS.map(([a, b]) => overlapDiagnostic(a, b)));
  rows = h.db.prepare(
    'SELECT finding_count FROM factory_gate_finding_set_chain WHERE workplace_ref=? ORDER BY id',
  ).all(serialized);
  assert.deepEqual(rows.map(row => row.finding_count), [15, 5],
    'the second rejection appends the strict 5-finding subset row');

  // Replaying the same decision key through the repository appends nothing.
  const decisionKey = h.db.prepare(
    'SELECT gate_decision_key FROM factory_gate_finding_set_chain WHERE workplace_ref=? ORDER BY id DESC LIMIT 1',
  ).get(serialized).gate_decision_key;
  h.chain.appendForDecision({
    workplaceRef: serialized,
    gateDecisionKey: decisionKey,
    gateRef: 'author-gate',
    repairTargetRole: 'author',
    checkPlanDigest: sha('ignored-on-replay'),
    checkReceiptRefs: [],
    fallbackSubjectRef: 'irrelevant',
  });
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_gate_finding_set_chain').get().n,
    2,
    'a replayed decision key appends nothing (idempotent by UNIQUE constraint)',
  );

  const tail = h.chain.readTrajectoryTail(serialized, 'author');
  assert.equal(tail.sets.length, 2);
  assert.equal(tail.sets[0].count, 15);
  assert.equal(tail.sets[1].count, 5);
  assert.deepEqual(tail.latestKeys, tail.sets[1].keys);
  assert.equal(tail.gateRef, 'gate:7:final', 'the derived gate ref of the final-phase author gate');
  h.db.close();
});

test('T7: a check_plan_digest change RESETS the chain — old-plan findings are not comparable evidence', async () => {
  const h = harness();
  const definition = cell();
  const ctx = context(definition);
  const ref = workplaceRef();
  await h.executor.execute(ctx); // hire the author

  await rejectedAttempt(h, ctx, ref, 'plan-a-1',
    FIRST_ATTEMPT_PAIRS.map(([a, b]) => overlapDiagnostic(a, b)));
  const serialized = serializeWorkplaceRef(ref);
  let tail = h.chain.readTrajectoryTail(serialized, 'author');
  assert.equal(tail.sets.length, 1);
  const planADigest = tail.checkPlanDigest;

  // The module ships a NEW plan version: different entries, different digest.
  definition.authorGate.checkPlan = checkPlan('author-plan-v2');
  await rejectedAttempt(h, ctx, ref, 'plan-b-1',
    SECOND_ATTEMPT_PAIRS.map(([a, b]) => overlapDiagnostic(a, b)));

  tail = h.chain.readTrajectoryTail(serialized, 'author');
  assert.equal(tail.sets.length, 1,
    'the plan-B scope sees ONLY the row minted under plan B — the chain reset');
  assert.notEqual(tail.checkPlanDigest, planADigest);
  assert.equal(tail.sets[0].count, 5);
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_gate_finding_set_chain WHERE workplace_ref=?').get(serialized).n,
    2,
    'both rows are retained as append-only audit; the reset is a READ scope, not a deletion',
  );
  h.db.close();
});
