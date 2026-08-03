import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const {
  handlers,
  _resetManagedNodeSubmissionRepositoryForTests,
} = await import('../../dist/tools/process-node-submissions.js');
const { SqliteManagedNodeSubmissionRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-node-submit-'));
  process.env.DB_PATH = path.join(temp, 'submissions.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  const input = { objective: 'plan exact development graph' };
  const processRepo = new SqliteProcessRunRepository(db);
  const { record: processRun } = processRepo.start({
    moduleRef: { name: 'solution-development', version: '1.0.0' },
    executorKind: 'generic-flow',
    input: {
      schema: 'saga3.development-case.v1',
      payload: input,
      contentHash: sha256Hex(input),
    },
    projectedStage: 'development',
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'test',
      idempotencyKey: 'managed-node-submission',
    },
  });
  processRepo.update(processRun.id, { status: 'preparing' });
  processRepo.update(processRun.id, { status: 'running' });

  const moduleRef = 'solution-development@1.0.0';
  const nodeId = 'plan-task-graph';
  const intentId = 501;
  const taskId = db.prepare(
    `INSERT INTO tasks
       (epic_id,title,status,priority,task_kind,workflow_stage,
        execution_skill,execution_mode,generation_key,metadata)
     VALUES (10,'Plan','in_progress','high','planning.decomposition',
             'development','saga-planner','tracker_only','node-submit-task',?)
     RETURNING id`,
  ).get(JSON.stringify({
    work_intent_id: intentId,
    process_run_id: processRun.id,
    process_node_id: nodeId,
    process_module_ref: moduleRef,
    process_input_hash: processRun.inputHash,
  })).id;
  const executionId = 'exec-node-submit-1';
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES (?,'run-1',1,10,?,'worker-1','machine-1','test',
             'running','executing','{}')`,
  ).run(executionId, taskId);
  db.prepare(
    'UPDATE tasks SET current_execution_id=? WHERE id=?',
  ).run(executionId, taskId);

  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = executionId;
  process.env.SAGA_TASK_ID = String(taskId);
  return {
    temp,
    db,
    processRepo,
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
  _resetManagedNodeSubmissionRepositoryForTests();
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('managed node submission is machine-bound, immutable and exactly replayable', () => {
  const f = fixture();
  try {
    const payload = {
      schemaVersion: 'saga3.development-task-graph-proposal.v1',
      implementationItems: [],
      verificationItems: [],
      integrationTargets: [],
    };
    const first = handlers.process_node_submit({
      schema: payload.schemaVersion,
      payload,
    });
    const replay = handlers.process_node_submit({
      schema: payload.schemaVersion,
      payload,
    });
    assert.equal(first.accepted, true);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.submission_ref, first.submission_ref);
    assert.equal(first.content_hash, sha256Hex(payload));

    const repository = new SqliteManagedNodeSubmissionRepository(f.db);
    const record = repository.readExact({
      processRunId: f.processRun.id,
      moduleRef: f.moduleRef,
      nodeId: f.nodeId,
      intentId: f.intentId,
      taskId: f.taskId,
      executionId: f.executionId,
    });
    assert.deepEqual(record.payload, payload);
    assert.equal(record.artifactRef, first.submission_ref);
    assert.throws(
      () => handlers.process_node_submit({
        schema: payload.schemaVersion,
        payload: { ...payload, implementationItems: [{ key: 'different' }] },
      }),
      /MANAGED_NODE_SUBMISSION_ALREADY_FINAL/,
    );
    assert.throws(
      () => f.db.prepare(
        `UPDATE saga3_managed_node_submissions
            SET content_hash='tampered' WHERE id=?`,
      ).run(record.submissionId),
      /MANAGED_NODE_SUBMISSION_IMMUTABLE/,
    );
  } finally {
    cleanup(f.temp);
  }
});
test('managed node submission refuses a lost execution or ProcessRun fence', () => {
  const f = fixture();
  try {
    const command = {
      schema: 'test.node-product.v1',
      payload: { schemaVersion: 'test.node-product.v1' },
    };
    f.db.prepare(
      'UPDATE tasks SET current_execution_id=NULL WHERE id=?',
    ).run(f.taskId);
    assert.throws(
      () => handlers.process_node_submit(command),
      /MANAGED_NODE_SUBMISSION_FENCE_LOST/,
    );

    f.db.prepare(
      'UPDATE tasks SET current_execution_id=? WHERE id=?',
    ).run(f.executionId, f.taskId);
    f.processRepo.update(f.processRun.id, { status: 'paused' });
    assert.throws(
      () => handlers.process_node_submit(command),
      /MANAGED_NODE_SUBMISSION_PROCESS_NOT_RUNNING/,
    );
    assert.equal(
      f.db.prepare(
        'SELECT COUNT(*) AS n FROM saga3_managed_node_submissions',
      ).get().n,
      0,
    );
  } finally {
    cleanup(f.temp);
  }
});

test('a fresh execution may submit a correction while exact and reviewed-task reads stay distinct', () => {
  const f = fixture();
  try {
    const repository = new SqliteManagedNodeSubmissionRepository(f.db);
    const first = repository.submitForCurrentExecution({
      schema: 'test.node-product.v1',
      payload: { revision: 1 },
    }).record;

    f.db.prepare(
      `UPDATE worker_executions SET state='exited'
        WHERE execution_id=?`,
    ).run(f.executionId);
    const secondExecutionId = 'exec-node-submit-2';
    f.db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
          launcher,state,phase,metadata)
       VALUES (?,'run-2',1,10,?,'worker-2','machine-1','test',
               'running','executing','{}')`,
    ).run(secondExecutionId, f.taskId);
    f.db.prepare(
      'UPDATE tasks SET current_execution_id=?, assigned_to=? WHERE id=?',
    ).run(secondExecutionId, 'worker-2', f.taskId);
    process.env.SAGA_EXECUTION_ID = secondExecutionId;

    const secondQuery = {
      processRunId: f.processRun.id,
      moduleRef: f.moduleRef,
      nodeId: f.nodeId,
      intentId: f.intentId,
      taskId: f.taskId,
      executionId: secondExecutionId,
    };
    assert.equal(repository.readExact(secondQuery), null);
    assert.equal(
      repository.readLatestForTask(secondQuery).submissionId,
      first.submissionId,
    );

    const second = repository.submitForCurrentExecution({
      schema: 'test.node-product.v1',
      payload: { revision: 2 },
    }).record;
    assert.notEqual(second.submissionId, first.submissionId);
    assert.equal(repository.readExact(secondQuery).submissionId, second.submissionId);
    assert.equal(
      repository.readLatestForTask(secondQuery).submissionId,
      second.submissionId,
    );
  } finally {
    cleanup(f.temp);
  }
});
