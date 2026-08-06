import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { ensureManagedProductionLedgerSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js'
);
const { SqliteExactCandidateAcceptance } = await import(
  '../../dist/process-modules/persistence/sqlite-exact-candidate-acceptance.js'
);
const { sha256Hex } = await import('../../dist/shared/canonical-json.js');

function insertExecution(db, executionId, taskId, workerId) {
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES (?, ?,1,10,?,?, 'machine','test','exited','finishing','{}')`,
  ).run(executionId, `run:${executionId}`, taskId, workerId);
}

function insertReceipt(db, {
  executionId,
  taskId,
  workerId,
  verdict = 'approved',
  status,
}) {
  const reply = {
    completed: taskId,
    completed_new_status: status,
    stop: true,
    stop_reason: verdict === 'approved' ? 'done' : 'changes_requested',
  };
  db.prepare(
    `INSERT INTO command_receipts
       (command_id,command_kind,actor_kind,actor_id,execution_id,task_id,
        payload_hash,accepted,rejection_code,result_json,reply_json)
     VALUES (?,?,?,?,?,?,?,1,NULL,?,?)`,
  ).run(
    `${executionId}:worker-done:${verdict}`,
    'worker_done',
    'managed_execution',
    workerId,
    executionId,
    taskId,
    sha256Hex({ executionId, verdict, status }),
    JSON.stringify(reply),
    JSON.stringify(reply),
  );
}

function setup({ includeRecoveryDone = true } = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-review-epoch-'));
  process.env.DB_PATH = path.join(temp, 'acceptance.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();

  const input = { objective: 'review exact recovery candidate' };
  const { record: processRun } = new SqliteProcessRunRepository(db).start({
    moduleRef: { name: 'test-module', version: '1.0.0' },
    executorKind: 'generic-flow',
    input: {
      schema: 'test.input.v1',
      payload: input,
      contentHash: sha256Hex(input),
    },
    projectedStage: 'formalization',
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'test',
      idempotencyKey: `review-epoch:${Date.now()}:${Math.random()}`,
    },
  });

  const taskId = Number(db.prepare(
    `INSERT INTO tasks
       (epic_id,title,status,priority,task_kind,workflow_stage,
        execution_skill,execution_mode,generation_key,metadata)
     VALUES (10,'Produce','done','high','test.produce','formalization',
             'test','artifact_change','review-epoch','{}')
     RETURNING id`,
  ).get().id);

  const producerExecutionId = 'exec-author-A';
  const reviewerExecutionId = 'exec-review-R';
  const recoveryExecutionId = 'exec-recovery-B';
  insertExecution(db, producerExecutionId, taskId, 'author-A');
  insertExecution(db, reviewerExecutionId, taskId, 'reviewer-R');
  insertExecution(db, recoveryExecutionId, taskId, 'recovery-B');

  ensureManagedProductionLedgerSchema(db);
  const contentHash = 'a'.repeat(64);
  const artifactId = Number(db.prepare(
    `INSERT INTO artifacts
       (project_id,epic_id,type,code,title,path,status,content_hash,
        accepted_hash,drift_state)
     VALUES (1,10,'SRS','SRS-1','SRS','docs/srs.md','draft',?,NULL,'unknown')
     RETURNING id`,
  ).get(contentHash).id);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        artifact_id,artifact_type,artifact_status,content_hash,operation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    processRun.id,
    'test-module@1.0.0',
    'produce-contract',
    501,
    taskId,
    producerExecutionId,
    artifactId,
    'SRS',
    'draft',
    contentHash,
    'create',
  );

  insertReceipt(db, {
    executionId: producerExecutionId,
    taskId,
    workerId: 'author-A',
    status: 'review',
  });
  insertReceipt(db, {
    executionId: reviewerExecutionId,
    taskId,
    workerId: 'reviewer-R',
    status: 'done',
  });
  if (includeRecoveryDone) {
    insertReceipt(db, {
      executionId: recoveryExecutionId,
      taskId,
      workerId: 'recovery-B',
      status: 'done',
    });
  }

  const command = {
    idempotencyKey: `gate:${taskId}:accept`,
    lineage: {
      processRunId: processRun.id,
      moduleRef: 'test-module@1.0.0',
      nodeId: 'produce-contract',
      intentId: 501,
      taskId,
      executionId: recoveryExecutionId,
      projectId: 1,
      epicId: 10,
    },
    candidates: [{ artifactId, artifactType: 'SRS', contentHash }],
    requireApprovedReview: true,
    authority: 'test-gate@1',
    reasonCode: 'CONTRACT_VALID',
    context: { gateNodeId: 'resolve-contract' },
  };

  return {
    temp,
    db,
    processRun,
    taskId,
    artifactId,
    contentHash,
    producerExecutionId,
    reviewerExecutionId,
    recoveryExecutionId,
    command,
  };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('late recovery completion does not replace the reviewed candidate epoch', () => {
  const f = setup();
  try {
    const acceptance = new SqliteExactCandidateAcceptance(f.db);
    const decision = acceptance.accept(f.command);

    assert.equal(decision.lineage.executionId, f.producerExecutionId);
    assert.equal(
      decision.producerCompletionReceiptCommandId,
      `${f.producerExecutionId}:worker-done:approved`,
    );
    assert.equal(
      decision.approvedReviewReceiptCommandId,
      `${f.reviewerExecutionId}:worker-done:approved`,
    );
    assert.equal(
      acceptance.isAcceptedExact(f.command.lineage, f.command.candidates[0]),
      true,
      'recovery execution may replay the task-level exact decision',
    );
  } finally {
    cleanup(f.temp);
  }
});

test('a recovery-produced new hash cannot inherit an older review', () => {
  const f = setup();
  try {
    const newHash = 'b'.repeat(64);
    f.db.prepare(
      `UPDATE artifacts SET content_hash=?, drift_state='unknown' WHERE id=?`,
    ).run(newHash, f.artifactId);
    f.db.prepare(
      `INSERT INTO factory_managed_artifact_productions
         (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
          artifact_id,artifact_type,artifact_status,content_hash,operation,recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','+1 minute'))`,
    ).run(
      f.processRun.id,
      f.command.lineage.moduleRef,
      f.command.lineage.nodeId,
      f.command.lineage.intentId,
      f.taskId,
      f.recoveryExecutionId,
      f.artifactId,
      'SRS',
      'draft',
      newHash,
      'update',
    );

    const changed = {
      ...f.command,
      idempotencyKey: `gate:${f.taskId}:changed`,
      candidates: [{
        artifactId: f.artifactId,
        artifactType: 'SRS',
        contentHash: newHash,
      }],
    };
    assert.throws(
      () => new SqliteExactCandidateAcceptance(f.db).accept(changed),
      error => error?.code === 'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
    );
    assert.equal(
      f.db.prepare('SELECT status FROM artifacts WHERE id=?')
        .get(f.artifactId).status,
      'draft',
    );
  } finally {
    cleanup(f.temp);
  }
});

test('a changed recovery candidate is accepted only after a fresh review epoch', () => {
  const f = setup({ includeRecoveryDone: false });
  try {
    const newHash = 'c'.repeat(64);
    f.db.prepare(
      `UPDATE artifacts SET content_hash=?, drift_state='unknown' WHERE id=?`,
    ).run(newHash, f.artifactId);
    f.db.prepare(
      `INSERT INTO factory_managed_artifact_productions
         (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
          artifact_id,artifact_type,artifact_status,content_hash,operation)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      f.processRun.id,
      f.command.lineage.moduleRef,
      f.command.lineage.nodeId,
      f.command.lineage.intentId,
      f.taskId,
      f.recoveryExecutionId,
      f.artifactId,
      'SRS',
      'draft',
      newHash,
      'update',
    );

    insertReceipt(f.db, {
      executionId: f.recoveryExecutionId,
      taskId: f.taskId,
      workerId: 'recovery-B',
      status: 'review',
    });
    const reviewer2 = 'exec-review-R2';
    insertExecution(f.db, reviewer2, f.taskId, 'reviewer-R2');
    insertReceipt(f.db, {
      executionId: reviewer2,
      taskId: f.taskId,
      workerId: 'reviewer-R2',
      status: 'done',
    });

    const changed = {
      ...f.command,
      idempotencyKey: `gate:${f.taskId}:re-reviewed`,
      candidates: [{
        artifactId: f.artifactId,
        artifactType: 'SRS',
        contentHash: newHash,
      }],
    };
    const decision = new SqliteExactCandidateAcceptance(f.db).accept(changed);
    assert.equal(decision.lineage.executionId, f.recoveryExecutionId);
    assert.equal(
      decision.approvedReviewReceiptCommandId,
      `${reviewer2}:worker-done:approved`,
    );
  } finally {
    cleanup(f.temp);
  }
});
