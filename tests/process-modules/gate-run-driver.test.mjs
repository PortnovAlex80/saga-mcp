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
    }),
    /CHECK_PROVIDER_MISSING/,
  );

  db.close();
});
