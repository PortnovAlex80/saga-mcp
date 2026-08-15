import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { prepareDevelopmentContinuation } from '../../dist/app/factory-continuation.js';
import { SCHEMA_SQL, migrateFactorySchemaV3ToV4 } from '../../dist/schema.js';

const sourcePath = '.factory-sandboxes/meaning-run-20260809/factory.sqlite';

test('live-shaped verification continuation adopts warehouse product without worker production', async () => {
  const root = mkdtempSync(join(tmpdir(), 'saga-verification-continuation-'));
  const target = join(root, 'factory.sqlite');
  const source = new Database(sourcePath, { readonly: true });
  await source.backup(target);
  source.close();
  const db = new Database(target);
  try {
    db.pragma('foreign_keys=ON');
    db.exec(SCHEMA_SQL);
    migrateFactorySchemaV3ToV4(db);
    const before = snapshotCounts(db);
    const order = db.prepare(
      `SELECT order_ref FROM factory_order_runs WHERE lifecycle_run_id=6`,
    ).get();
    const prepared = prepareDevelopmentContinuation(db, {
      orderRef: order.order_ref,
      parentLifecycleRunId: 6,
      verificationOnly: true,
      actorId: 'scripted-regression',
      reason: 'prove verification-only recovery boundary',
    });
    assert.equal(prepared.childLifecycleRunId, 7);
    assert.equal(prepared.authorCarryForwardAuthorizationRef, null);
    const adoption = db.prepare(
      `SELECT evidence_snapshot,verification_method_plan_hash
         FROM factory_development_verification_adoptions WHERE adoption_ref=?`,
    ).get(prepared.adoptionRef);
    const evidence = JSON.parse(adoption.evidence_snapshot);
    assert.equal(evidence.sourceProcessRunId, 8);
    assert.equal(evidence.integratedCandidate.candidateHash,
      '8e0884d6868ee52abad225d5f73a2356317d6a7821741ce4168e85eba763e9ab');
    assert.equal(evidence.verificationMethodPlan.obligations.length, 31);
    assert.equal(evidence.verificationMethodPlan.planHash,
      adoption.verification_method_plan_hash);
    const child = db.prepare(
      `SELECT definition_snapshot FROM factory_lifecycle_runs WHERE id=?`,
    ).get(prepared.childLifecycleRunId);
    const definition = JSON.parse(child.definition_snapshot);
    const development = definition.stages.find(stage => stage.id === 'solution-development');
    assert.deepEqual(development.moduleRef, {
      name: 'solution-development-verification-continuation',
      version: '1.0.0',
    });
    assert.deepEqual(snapshotCounts(db), {
      ...before,
      lifecycleRuns: before.lifecycleRuns + 1,
      workers: before.workers,
      tasks: before.tasks,
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshotCounts(db) {
  return {
    lifecycleRuns: db.prepare('SELECT COUNT(*) count FROM factory_lifecycle_runs').get().count,
    workers: db.prepare('SELECT COUNT(*) count FROM worker_executions').get().count,
    tasks: db.prepare('SELECT COUNT(*) count FROM tasks').get().count,
  };
}
