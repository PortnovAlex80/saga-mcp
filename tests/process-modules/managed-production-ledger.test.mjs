import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { handlers: artifactHandlers } = await import('../../dist/tools/artifacts.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteManagedProductionLedger } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-managed-products-'));
  process.env.DB_PATH = path.join(temp, 'products.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  const input = { objective: 'formalize exact product' };
  const { record: processRun } = new SqliteProcessRunRepository(db).start({
    moduleRef: { name: 'solution-formalization', version: '1.0.0' },
    executorKind: 'generic-flow',
    input: {
      schema: 'saga3.formalization-case.v1',
      payload: input,
      contentHash: sha256Hex(input),
    },
    projectedStage: 'formalization',
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'test',
      idempotencyKey: 'managed-product-run',
    },
  });
  const moduleRef = 'solution-formalization@1.0.0';
  const nodeId = 'define-product-contract';
  const intentId = 501;
  const task = db.prepare(
    `INSERT INTO tasks
       (epic_id,title,status,priority,task_kind,workflow_stage,
        execution_skill,execution_mode,generation_key,metadata)
     VALUES (10,'Formalize','in_progress','high','formalization.prd',
             'formalization','saga-product','artifact_change','managed-product-task',?)
     RETURNING id`,
  ).get(JSON.stringify({
    work_intent_id: intentId,
    process_run_id: processRun.id,
    process_node_id: nodeId,
    process_module_ref: moduleRef,
    process_input_hash: processRun.inputHash,
  }));
  const taskId = task.id;
  const executionId = 'exec-managed-product-1';
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES (?, 'run-1',1,10,?,'worker-1','machine-1','test','running','executing','{}')`,
  ).run(executionId, taskId);
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = executionId;
  process.env.SAGA_TASK_ID = String(taskId);
  return {
    temp,
    db,
    processRun,
    moduleRef,
    nodeId,
    intentId,
    taskId,
    executionId,
  };
}

function cleanup(temp) {
  delete process.env.SAGA_MANAGED_EXECUTION;
  delete process.env.SAGA_EXECUTION_ID;
  delete process.env.SAGA_TASK_ID;
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('artifact and trace tools machine-stamp the exact worker execution', () => {
  const f = fixture();
  try {
    const prd = artifactHandlers.artifact_create({
      project_id: 1,
      epic_id: 10,
      type: 'PRD',
      title: 'Product',
      path: 'docs/prd.md',
      code: 'PRD-1',
      status: 'accepted',
      content_hash: 'a'.repeat(64),
    });
    const fr = artifactHandlers.artifact_create({
      project_id: 1,
      epic_id: 10,
      type: 'FR',
      title: 'Draw circle',
      path: 'docs/fr.md',
      code: 'FR-1',
      status: 'accepted',
      content_hash: 'b'.repeat(64),
    });
    const trace = artifactHandlers.trace_add({
      source_id: fr.id,
      target_type: 'artifact',
      target_id: prd.id,
      link_type: 'derived_from',
    });
    const ledger = new SqliteManagedProductionLedger(f.db);
    const query = {
      processRunId: f.processRun.id,
      moduleRef: f.moduleRef,
      nodeId: f.nodeId,
      intentId: f.intentId,
      taskId: f.taskId,
      executionId: f.executionId,
    };
    const artifacts = ledger.listArtifactsForExecution(query);
    const traces = ledger.listTracesForExecution(query);
    assert.deepEqual(artifacts.map(row => row.artifactId), [prd.id, fr.id]);
    assert.deepEqual(artifacts.map(row => row.operation), ['create', 'create']);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].traceId, trace.id);
    assert.equal(traces[0].sourceId, fr.id);
    assert.equal(traces[0].targetId, prd.id);
  } finally {
    cleanup(f.temp);
  }
});

test('inconsistent ProcessRun metadata fails before an artifact mutation commits', () => {
  const f = fixture();
  try {
    f.db.prepare(
      `UPDATE tasks
          SET metadata=json_set(metadata, '$.process_input_hash', ?)
        WHERE id=?`,
    ).run('0'.repeat(64), f.taskId);
    assert.throws(
      () => artifactHandlers.artifact_create({
        project_id: 1,
        epic_id: 10,
        type: 'PRD',
        title: 'Must roll back',
        path: 'docs/nope.md',
        code: 'PRD-BAD',
        status: 'draft',
        content_hash: 'c'.repeat(64),
      }),
      /task provenance does not match ProcessRun/,
    );
    assert.equal(
      f.db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE code='PRD-BAD'`).get().n,
      0,
    );
  } finally {
    cleanup(f.temp);
  }
});
