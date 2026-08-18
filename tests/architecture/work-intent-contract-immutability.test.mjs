import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const { closeDb, getDb } = await import('../../dist/db.js');
const { productionIngressModeFromAuthorityScope } = await import(
  '../../dist/process-modules/application/production-ingress-contract.js'
);
const { readFrozenProductionIngress } = await import(
  '../../dist/process-modules/application/production-ingress-contract.js'
);
const { buildExecutionContext } = await import(
  '../../dist/shared/authority/build-execution-context.js'
);
const { executionContextHash } = await import(
  '../../dist/shared/authority/execution-context.js'
);
const { SqliteFactoryDiscoveryRuntime } = await import(
  '../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js'
);

test('WorkIntent contract is physically immutable and cannot switch production ingress', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-intent-seal-'));
  process.env.DB_PATH = path.join(temp, 'factory.sqlite');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects(id,name,status) VALUES(1,'P','active')`).run();
    db.prepare(`INSERT INTO epics(id,project_id,name) VALUES(1,1,'E')`).run();
    const managedScope = JSON.stringify({
      allowed_tools: ['artifact_create', 'worker_done'],
    });
    const intentId = Number(db.prepare(
      `INSERT INTO factory_work_intents
         (epic_id,kind,objective,authority_scope,output_schema,status)
       VALUES (1,'formalization','produce exact material',?,'schema.v1','open')
       RETURNING id`,
    ).get(managedScope).id);

    assert.equal(productionIngressModeFromAuthorityScope(managedScope), 'managed-workplace');
    assert.throws(
      () => db.prepare(
        `UPDATE factory_work_intents SET authority_scope=? WHERE id=?`,
      ).run(JSON.stringify({ allowed_tools: ['product_submit', 'worker_done'] }), intentId),
      /FACTORY_WORK_INTENT_CONTRACT_IMMUTABLE/,
    );
    const frozen = db.prepare(
      `SELECT authority_scope FROM factory_work_intents WHERE id=?`,
    ).get(intentId).authority_scope;
    assert.equal(productionIngressModeFromAuthorityScope(frozen), 'managed-workplace');

    assert.doesNotThrow(() => db.prepare(
      `UPDATE factory_work_intents
          SET projected_task_id=NULL,status='executing',updated_at=datetime('now')
        WHERE id=?`,
    ).run(intentId));
  } finally {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
});

test('execution ingress survives lawful task projection to the next WorkIntent', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-ingress-churn-'));
  process.env.DB_PATH = path.join(temp, 'factory.sqlite');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects(id,name,status) VALUES(1,'P','active')`).run();
    db.prepare(`INSERT INTO epics(id,project_id,name) VALUES(1,1,'E')`).run();
    const typedScope = {
      enforcement: 'runtime',
      allowed_tools: ['product_submit', 'worker_done'],
      scope: 'workplace:test',
      snapshot_ref: 'snapshot:typed',
    };
    const typedIntent = db.prepare(
      `INSERT INTO factory_work_intents
         (epic_id,kind,objective,authority_scope,output_schema,status)
       VALUES (1,'development','typed',?,'schema.v1','executing') RETURNING *`,
    ).get(JSON.stringify(typedScope));
    const managedIntentId = Number(db.prepare(
      `INSERT INTO factory_work_intents
         (epic_id,kind,objective,authority_scope,output_schema,status)
       VALUES (1,'development','managed',?,'schema.v1','open') RETURNING id`,
    ).get(JSON.stringify({ ...typedScope, allowed_tools: ['artifact_create', 'worker_done'] })).id);
    const taskId = Number(db.prepare(
      `INSERT INTO tasks
         (epic_id,title,status,priority,task_kind,workflow_stage,
          execution_skill,execution_mode,generation_key,metadata)
       VALUES (1,'T','in_progress','high','development.implementation','development',
               'saga-worker','tracker_only','intent-churn',?) RETURNING id`,
    ).get(JSON.stringify({ work_intent_id: typedIntent.id })).id);
    const workIntent = {
      id: Number(typedIntent.id),
      epic_id: 1,
      kind: 'development',
      objective: 'typed',
      authority_scope: typedScope,
      output_schema: 'schema.v1',
      token_budget: 0,
      retry_budget: 0,
      projected_task_id: taskId,
      status: 'executing',
      created_at: String(typedIntent.created_at),
      updated_at: String(typedIntent.updated_at),
    };
    const snapshot = buildExecutionContext({
      modelRoute: { provider: 'test', model: 'test', effort: 'low' },
      workIntent,
      capturedAt: new Date().toISOString(),
    });
    db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
          launcher,state,phase,metadata)
       VALUES ('exec:typed','run:1',1,1,?,'worker','machine','test','running','executing',?)`,
    ).run(taskId, JSON.stringify({
      execution_context: snapshot,
      execution_context_hash: executionContextHash(snapshot),
    }));

    assert.equal(readFrozenProductionIngress(db, 'exec:typed').mode, 'typed-submission');
    db.prepare(`UPDATE tasks SET metadata=? WHERE id=?`).run(
      JSON.stringify({ work_intent_id: managedIntentId }),
      taskId,
    );
    assert.equal(readFrozenProductionIngress(db, 'exec:typed').mode, 'typed-submission');
  } finally {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
});

