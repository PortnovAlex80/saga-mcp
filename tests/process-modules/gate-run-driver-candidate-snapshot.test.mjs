// tests/process-modules/gate-run-driver-candidate-snapshot.test.mjs
//
// BLINDSIGHT C1 (Authority/Gate layer, PREVENTIVE-HUNT «Слепота по слоям»):
// check providers received candidateSnapshot = {} — the durable rejection
// history (finding-trajectory chain + the provider's own prior receipts) was
// WRITTEN but never DELIVERED to the decision point. A provider that cannot
// see the previous findings cannot recognize cosmetic resubmission.
//
//   CS1 a provider running for a workplace with a prior repair_required
//       decision receives the finding-trajectory chain tail (sets with keys)
//       AND its own prior receipt (outcome/checkReceiptRef) in
//       input.candidateSnapshot;
//   CS2 a provider on a fresh workplace (no history) receives the typed EMPTY
//       shape ({ findingTrajectoryTails: {author: null, reviewer: null},
//       providerHistory: [] }) — not the untyped {} blind spot;
//   CS3 the snapshot is a READ-ONLY delivery view: it must not enter the
//       GateRun identity (same subject + history grown by other workplaces'
//       decisions must not change THIS run's gateRunRef) and must not be
//       required from legacy repos (absent optional method → {}).
//
// BEFORE the fix CS1/CS2 are RED: candidateSnapshot is always {}.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteGateFindingSetChain } from '../../dist/infrastructure/workplace/sqlite-gate-finding-set-chain.js';
import { driveGateRun } from '../../dist/process-modules/application/gate-run-driver.js';
import { buildArchitectureCheckPlan } from '../../dist/modules/formalization/application/architecture-check-plan.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);
  const REF = { processRunId: 1, moduleRef: 'sf@1', productionCellId: 'define-architecture-contract', workKey: 'default' };
  new SqliteWorkplaceRepository(db).materialize(REF);
  return { db, ref: REF };
}

const PROVIDER_ID = 'formalization.srs-structural.v1';

function captureProvider(captured, outcome) {
  return {
    providerId: PROVIDER_ID,
    version: '1.0.0',
    providerDigest: 'srs-structural-v1-digest',
    run(input) {
      captured.push(input.candidateSnapshot);
      return outcome;
    },
  };
}

test('CS1: provider sees the finding-trajectory chain tail and its own prior receipt', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const chain = new SqliteGateFindingSetChain(db);
  const checkPlan = buildArchitectureCheckPlan();

  // Round 1 — the same provider rejects the first subject.
  const first = driveGateRun(gateRepo, { resolve: () => captureProvider([], 'failed') }, {
    workplaceRef: ref,
    subjectCandidateSetRef: 'candidate-set/cs1-first',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-cs1',
    installationDigest: hash('install'),
    checkParameters: {},
    environmentRef: null,
    presentationRef: 'worker-execution:cs1-first',
  });
  assert.equal(first.decision.verdict, 'repair_required');
  chain.appendForDecision({
    workplaceRef: `workplace/${ref.processRunId}/${ref.moduleRef}/${ref.productionCellId}/${ref.workKey}`,
    gateDecisionKey: first.decision.decisionKey,
    gateRef: first.decision.gateRef,
    repairTargetRole: first.decision.repairTargetRole ?? 'author',
    checkPlanDigest: first.decision.checkPlanDigest,
    checkReceiptRefs: first.decision.checkReceiptRefs,
    fallbackSubjectRef: first.decision.subjectCandidateSetRef,
  });

  // Round 2 — a NEW subject on the SAME workplace: the provider must now see
  // the round-1 trajectory tail and its own failed receipt.
  const captured = [];
  const second = driveGateRun(gateRepo, { resolve: () => captureProvider(captured, 'passed') }, {
    workplaceRef: ref,
    subjectCandidateSetRef: 'candidate-set/cs1-second',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 2,
    gateLeaseRef: 'lease-cs1',
    installationDigest: hash('install'),
    checkParameters: {},
    environmentRef: null,
    presentationRef: 'worker-execution:cs1-second',
  });
  assert.equal(second.decision.verdict, 'accepted');
  assert.equal(captured.length, 1, 'provider ran once for the new subject');

  const snapshot = captured[0];
  assert.ok(snapshot && typeof snapshot === 'object', 'candidateSnapshot must be delivered');

  const tail = snapshot.findingTrajectoryTails?.author;
  assert.ok(tail, 'author-role trajectory tail must be delivered');
  assert.equal(tail.gateRef, first.decision.gateRef);
  assert.equal(tail.checkPlanDigest, first.decision.checkPlanDigest);
  assert.equal(tail.sets.length, 1, 'one same-scope chain row so far');
  const keys = tail.sets[0].keys;
  assert.ok(Array.isArray(keys) && keys.length === 1,
    'chain keys must ride with the tail');
  assert.match(keys[0], new RegExp(`^${PROVIDER_ID.replace('.', '\\.')}:failed::`),
    'the fallback finding key of the round-1 rejection must be visible');

  const history = snapshot.providerHistory;
  assert.ok(Array.isArray(history) && history.length === 1,
    'the provider must see its own prior receipt');
  assert.equal(history[0].checkReceiptRef, first.decision.checkReceiptRefs[0]);
  assert.equal(history[0].outcome, 'failed');
  assert.equal(history[0].subjectCandidateSetRef, 'candidate-set/cs1-first');

  db.close();
});

test('CS2: fresh workplace receives the typed EMPTY history shape, not {}', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const captured = [];
  const result = driveGateRun(gateRepo, { resolve: () => captureProvider(captured, 'passed') }, {
    workplaceRef: ref,
    subjectCandidateSetRef: 'candidate-set/cs2-first',
    checkPlan: buildArchitectureCheckPlan(),
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-cs2',
    installationDigest: hash('install'),
    checkParameters: {},
    environmentRef: null,
    presentationRef: 'worker-execution:cs2',
  });
  assert.equal(result.decision.verdict, 'accepted');
  assert.deepEqual(captured[0], {
    subjectCandidateSetRef: 'candidate-set/cs2-first',
    workplaceRef: `workplace/${ref.processRunId}/${ref.moduleRef}/${ref.productionCellId}/${ref.workKey}`,
    findingTrajectoryTails: { author: null, reviewer: null },
    providerHistory: [],
  }, 'no history yet — the typed empty shape, never the blind {}');
  db.close();
});

test('CS3: the history snapshot does not enter GateRun identity (read-only delivery view)', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const chain = new SqliteGateFindingSetChain(db);
  const checkPlan = buildArchitectureCheckPlan();

  // Workplace A: reject + chain row.
  const a = driveGateRun(gateRepo, { resolve: () => captureProvider([], 'failed') }, {
    workplaceRef: ref,
    subjectCandidateSetRef: 'candidate-set/cs3-a',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-cs3',
    installationDigest: hash('install'),
    checkParameters: {},
    environmentRef: null,
    presentationRef: 'worker-execution:cs3-a',
  });
  chain.appendForDecision({
    workplaceRef: `workplace/${ref.processRunId}/${ref.moduleRef}/${ref.productionCellId}/${ref.workKey}`,
    gateDecisionKey: a.decision.decisionKey,
    gateRef: a.decision.gateRef,
    repairTargetRole: 'author',
    checkPlanDigest: a.decision.checkPlanDigest,
    checkReceiptRefs: a.decision.checkReceiptRefs,
    fallbackSubjectRef: a.decision.subjectCandidateSetRef,
  });

  // Workplace B: same plan, same subject shape — but NO history. Its GateRun
  // identity must NOT depend on workplace A's grown history: identity pins the
  // run's own inputs (subject/plan/install/revision), the snapshot is a view.
  const REF_B = { processRunId: 2, moduleRef: 'sf@1', productionCellId: 'define-architecture-contract', workKey: 'default' };
  new SqliteWorkplaceRepository(db).materialize(REF_B);
  const capturedB = [];
  const b = driveGateRun(gateRepo, { resolve: () => captureProvider(capturedB, 'passed') }, {
    workplaceRef: REF_B,
    subjectCandidateSetRef: 'candidate-set/cs3-b',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-cs3',
    installationDigest: hash('install'),
    checkParameters: {},
    environmentRef: null,
    presentationRef: 'worker-execution:cs3-b',
  });
  assert.equal(capturedB[0].findingTrajectoryTails.author, null,
    'workplace B sees no history');
  assert.notEqual(a.decision.gateRunRef, b.decision.gateRunRef,
    'different subjects keep distinct identities');
  db.close();
});
