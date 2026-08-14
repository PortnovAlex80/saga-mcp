/**
 * Test: GateRun driver lifecycle (Stage 2).
 *
 * Verifies the full sequence: createGateRun(claimed) → checking →
 * recordCheckReceipt → decided → recordDecision → terminal.
 * Also verifies the fail-closed decision policy: any failed/unknown →
 * repair_required; all passed → accepted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
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

/**
 * A stub CheckProvider that always returns the given outcome.
 */
function stubProvider(outcome) {
  return {
    providerId: 'formalization.srs-structural.v1',
    version: '1.0.0',
    // C10: must equal the digest pinned by buildArchitectureCheckPlan
    // (SRS_STRUCTURAL_CHECK_PROVIDER_DIGEST = 'srs-structural-v1-digest').
    providerDigest: 'srs-structural-v1-digest',
    run() { return outcome; },
  };
}

test('driveGateRun: all passed → verdict accepted, decision recorded', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const checkPlan = buildArchitectureCheckPlan();
  const providers = {
    resolve: (id) => id === 'formalization.srs-structural.v1' ? stubProvider('passed') : null,
  };

  const result = driveGateRun(gateRepo, providers, {
    workplaceRef: ref,
    subjectCandidateSetRef: 'candidate-set/test-ref',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-1',
    installationDigest: hash('install'),
    checkParameters: { srsArtifactRef: 'artifact:42' },
    environmentRef: null,
    presentationRef: 'worker-execution:gate-test',
  });

  assert.equal(result.decision.verdict, 'accepted');
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].outcome, 'passed');

  // Verify the GateRun row reached terminal state.
  const runRow = db.prepare(
    'SELECT state FROM factory_gate_runs WHERE gate_run_ref=?',
  ).get(result.decision.gateRunRef);
  assert.equal(runRow.state, 'terminal');

  // Verify the GateDecision row exists.
  const decisionRow = db.prepare(
    'SELECT verdict FROM factory_gate_decisions WHERE decision_key=?',
  ).get(result.decision.decisionKey);
  assert.equal(decisionRow.verdict, 'accepted');

  // Verify the CheckReceipt row exists.
  const receiptRow = db.prepare(
    'SELECT outcome FROM factory_check_receipts WHERE check_run_ref=?',
  ).get(result.decision.gateRunRef);
  assert.equal(receiptRow.outcome, 'passed');

  db.close();
});

test('driveGateRun: check failed → verdict repair_required', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const checkPlan = buildArchitectureCheckPlan();
  const providers = {
    resolve: () => stubProvider('failed'),
  };

  const result = driveGateRun(gateRepo, providers, {
    workplaceRef: ref,
    subjectCandidateSetRef: 'candidate-set/test-failed',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-2',
    installationDigest: hash('install'),
    checkParameters: { srsArtifactRef: 'artifact:42' },
    environmentRef: null,
    presentationRef: 'worker-execution:gate-test',
  });

  assert.equal(result.decision.verdict, 'repair_required');
  assert.equal(result.decision.repairTargetRole, 'author');
  assert.ok(result.decision.recoveryIssueRef);

  db.close();
});

test('driveGateRun: unknown outcome + fail-closed → repair_required', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const checkPlan = buildArchitectureCheckPlan();
  const providers = {
    resolve: () => stubProvider('unknown'),
  };

  const result = driveGateRun(gateRepo, providers, {
    workplaceRef: ref,
    subjectCandidateSetRef: 'candidate-set/test-unknown',
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease-3',
    installationDigest: hash('install'),
    checkParameters: { srsArtifactRef: 'artifact:42' },
    environmentRef: null,
    presentationRef: 'worker-execution:gate-test',
  });

  assert.equal(result.decision.verdict, 'repair_required',
    'fail-closed: unknown must block acceptance');
  db.close();
});

test('driveGateRun: provider not registered → CHECK_PROVIDER_MISSING', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const checkPlan = buildArchitectureCheckPlan();
  const providers = { resolve: () => null };

  assert.throws(
    () => driveGateRun(gateRepo, providers, {
      workplaceRef: ref,
      subjectCandidateSetRef: 'candidate-set/test-missing',
      checkPlan,
      gatePhase: 'author',
      expectedWorkplaceRevision: 1,
      gateLeaseRef: 'lease-4',
      installationDigest: hash('install'),
      checkParameters: {},
      environmentRef: null,
      presentationRef: 'worker-execution:gate-test',
    }),
    /CHECK_PROVIDER_MISSING/,
  );

  db.close();
});

test('ADR-053 C9: GateRun identity binds installationDigest + expectedWorkplaceRevision', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const checkPlan = buildArchitectureCheckPlan();
  const providers = { resolve: () => stubProvider('passed') };
  const base = {
    workplaceRef: ref, subjectCandidateSetRef: 'cs-c9', checkPlan, gatePhase: 'author',
    gateLeaseRef: 'lease-c9', checkParameters: {}, environmentRef: null,
    presentationRef: 'worker-execution:gate-c9',
  };
  const a = driveGateRun(gateRepo, providers, { ...base, expectedWorkplaceRevision: 1, installationDigest: hash('install-A') });
  // A different installed package (different installationDigest) must NOT reuse
  // the same GateRun/Decision — package-pinned identity (C9).
  const b = driveGateRun(gateRepo, providers, { ...base, expectedWorkplaceRevision: 1, installationDigest: hash('install-B') });
  assert.notEqual(a.decision.gateRunRef, b.decision.gateRunRef,
    'different installationDigest must yield a different GateRun');
  // A different Workplace revision must also yield a different GateRun.
  const c = driveGateRun(gateRepo, providers, { ...base, expectedWorkplaceRevision: 2, installationDigest: hash('install-A') });
  assert.notEqual(a.decision.gateRunRef, c.decision.gateRunRef,
    'different expectedWorkplaceRevision must yield a different GateRun');
  db.close();
});

test('ADR-053 C13: decisionDigest covers the full canonical body (drift → different digest; replay stable)', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const checkPlan = buildArchitectureCheckPlan();
  const providers = { resolve: () => stubProvider('passed') };
  const base = {
    workplaceRef: ref, checkPlan, gatePhase: 'author', gateLeaseRef: 'lease-c13',
    checkParameters: {}, environmentRef: null, presentationRef: 'worker-execution:gate-c13',
    expectedWorkplaceRevision: 1, installationDigest: hash('i-A'),
  };
  const a = driveGateRun(gateRepo, providers, { ...base, subjectCandidateSetRef: 'cs-x' });
  const b = driveGateRun(gateRepo, providers, { ...base, subjectCandidateSetRef: 'cs-y' });
  assert.notEqual(a.decision.decisionDigest, b.decision.decisionDigest,
    'decisions differing in subject must have different decisionDigests (full body, C13)');
  // Deterministic: same identity → replay returns the persisted decision (same digest).
  const a2 = driveGateRun(gateRepo, providers, { ...base, subjectCandidateSetRef: 'cs-x' });
  assert.equal(a.decision.decisionDigest, a2.decision.decisionDigest,
    'same inputs must yield the same digest on replay');
  db.close();
});

test('ADR-053 C12: replaying a terminal GateRun does NOT re-run providers (one-shot)', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const checkPlan = buildArchitectureCheckPlan();
  let runCount = 0;
  const providers = {
    resolve: () => ({
      providerId: 'formalization.srs-structural.v1',
      version: '1.0.0',
      providerDigest: 'srs-structural-v1-digest',
      run() { runCount += 1; return 'passed'; },
    }),
  };
  const drive = () => driveGateRun(gateRepo, providers, {
    workplaceRef: ref, subjectCandidateSetRef: 'cs-c12', checkPlan, gatePhase: 'author',
    expectedWorkplaceRevision: 1, gateLeaseRef: 'lease-c12', installationDigest: hash('i-c12'),
    checkParameters: {}, environmentRef: null, presentationRef: 'worker-execution:gate-c12',
  });
  const first = drive();
  assert.equal(runCount, 1, 'provider runs once on the initial GateRun');
  assert.equal(first.decision.verdict, 'accepted');
  // Replay the SAME GateRun identity. It must return the persisted terminal
  // decision WITHOUT re-running the provider or regressing the GateRun state.
  const second = drive();
  assert.equal(runCount, 1, 'C12: provider must NOT re-run on a terminal GateRun replay');
  assert.equal(second.decision.decisionKey, first.decision.decisionKey, 'same decision returned');
  assert.equal(second.decision.decisionDigest, first.decision.decisionDigest);
  const runRow = db.prepare('SELECT state FROM factory_gate_runs WHERE gate_run_ref=?').get(first.decision.gateRunRef);
  assert.equal(runRow.state, 'terminal', 'C12: GateRun stays terminal (no regression to checking)');
  db.close();
});

test('ADR-053 C11: two entries of the same provider get distinct CheckReceipt refs', () => {
  const { db, ref } = freshDb();
  const gateRepo = new SqliteGateRepository(db);
  const entry = (params) => ({
    check: { providerId: 'dup.provider', version: '1.0.0', providerDigest: hash('dup') },
    parameters: params,
    environmentRef: null,
  });
  const planBase = {
    checkPlanId: 'dup-plan', version: '1.0.0',
    entries: [entry({ a: 1 }), entry({ a: 2 })],
    decisionPolicyRef: 'dup.policy', decisionPolicyDigest: hash('dup.policy'),
    unknownErrorPolicy: 'fail-closed',
  };
  const checkPlan = { ...planBase, checkPlanDigest: hash(JSON.stringify(planBase)) };
  const providers = { resolve: () => ({ providerId: 'dup.provider', version: '1.0.0', providerDigest: hash('dup'), run: () => 'passed' }) };
  const result = driveGateRun(gateRepo, providers, {
    workplaceRef: ref, subjectCandidateSetRef: 'cs-c11', checkPlan, gatePhase: 'author',
    expectedWorkplaceRevision: 1, gateLeaseRef: 'lease-c11', installationDigest: hash('i'),
    checkParameters: {}, environmentRef: null, presentationRef: 'worker-execution:gate-c11',
  });
  assert.equal(result.receipts.length, 2);
  assert.notEqual(result.receipts[0].checkReceiptRef, result.receipts[1].checkReceiptRef,
    'two entries of one provider must get distinct receipt refs (C11 ordinal)');
  db.close();
});
