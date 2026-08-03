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
const { SqliteSaga3DiscoveryRuntime } = await import(
  '../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
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
  db.prepare(
    `UPDATE tasks
        SET assigned_to='worker-1',current_execution_id=?
      WHERE id=?`,
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
    // WAVE 6 CUTOVER: the execution-scoped listArtifactsForExecution /
    // listTracesForExecution methods were removed (execution-context-assembler
    // §9.11: no by-execution fallback). The canonical durable read is the
    // node-scope API (CGAD P18). This fixture writes under a single
    // (processRunId, moduleRef, nodeId), so the node-scope read returns the
    // same rows the execution-scoped read did — proving the exact worker
    // execution's writes are visible through the durable channel.
    const artifacts = ledger.listArtifactsForNodeInProcessRun(
      f.processRun.id, f.moduleRef, f.nodeId,
    );
    const traces = ledger.listTracesForNodeInProcessRun(
      f.processRun.id, f.moduleRef, f.nodeId,
    );
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

test('a reviewer or stale execution cannot mutate managed products', () => {
  const f = fixture();
  try {
    const reviewerExecution = 'exec-managed-review-1';
    f.db.prepare(
      `UPDATE worker_executions
          SET state='exited',phase='finishing',finished_at=datetime('now')
        WHERE execution_id=?`,
    ).run(f.executionId);
    f.db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
          launcher,state,phase,metadata)
       VALUES (?, 'run-2',1,10,?,'reviewer-1','machine-1','test',
               'running','reviewing','{}')`,
    ).run(reviewerExecution, f.taskId);
    f.db.prepare(
      `UPDATE tasks
          SET status='review_in_progress',assigned_to='reviewer-1',
              current_execution_id=?
        WHERE id=?`,
    ).run(reviewerExecution, f.taskId);
    process.env.SAGA_EXECUTION_ID = reviewerExecution;

    assert.throws(
      () => artifactHandlers.artifact_create({
        project_id: 1,
        epic_id: 10,
        type: 'SRS',
        title: 'Reviewer must not write',
        path: 'docs/reviewer-write.md',
        code: 'SRS-REVIEWER',
        status: 'draft',
        content_hash: 'f'.repeat(64),
      }),
      /MANAGED_PRODUCTION_FENCE_VIOLATION/,
    );
    assert.equal(
      f.db.prepare(
        `SELECT COUNT(*) AS n FROM artifacts WHERE code='SRS-REVIEWER'`,
      ).get().n,
      0,
    );
  } finally {
    cleanup(f.temp);
  }
});

test('a kernel-gated producer can draft candidates but cannot self-accept them', () => {
  const f = fixture();
  try {
    f.db.prepare(
      `UPDATE tasks
          SET metadata=json_set(
            metadata,
            '$.artifact_acceptance_authority',
            'kernel-gate'
          )
        WHERE id=?`,
    ).run(f.taskId);

    assert.throws(
      () => artifactHandlers.artifact_create({
        project_id: 1,
        epic_id: 10,
        type: 'SRS',
        title: 'Self accepted candidate',
        path: 'docs/self-accepted.md',
        code: 'SRS-SELF-ACCEPTED',
        status: 'accepted',
        content_hash: 'a'.repeat(64),
      }),
      /ARTIFACT_ACCEPTANCE_AUTHORITY_VIOLATION/,
    );
    assert.equal(
      f.db.prepare(
        `SELECT COUNT(*) AS n
           FROM artifacts
          WHERE code='SRS-SELF-ACCEPTED'`,
      ).get().n,
      0,
    );

    const draft = artifactHandlers.artifact_create({
      project_id: 1,
      epic_id: 10,
      type: 'SRS',
      title: 'Kernel-gated candidate',
      path: 'docs/kernel-gated.md',
      code: 'SRS-KERNEL-GATED',
      status: 'draft',
      content_hash: 'b'.repeat(64),
    });
    assert.equal(draft.status, 'draft');

    // Simulate the common gate committing the reviewed version, then prove a
    // worker cannot mutate that accepted row without explicitly reopening it.
    f.db.prepare(
      `UPDATE artifacts
          SET status='accepted',accepted_hash=content_hash,drift_state='clean'
        WHERE id=?`,
    ).run(draft.id);
    assert.throws(
      () => artifactHandlers.artifact_update({
        id: draft.id,
        title: 'Silent in-place rewrite',
      }),
      /ARTIFACT_ACCEPTANCE_AUTHORITY_VIOLATION/,
    );
    const reopened = artifactHandlers.artifact_update({
      id: draft.id,
      status: 'draft',
      title: 'Explicit candidate revision',
    });
    assert.equal(reopened.status, 'draft');
  } finally {
    cleanup(f.temp);
  }
});

test('producer replay selection follows completion receipts across ledger tables', () => {
  const f = fixture();
  try {
    const artifact = artifactHandlers.artifact_create({
      project_id: 1,
      epic_id: 10,
      type: 'SRS',
      title: 'First candidate',
      path: 'docs/replayed-producer.md',
      code: 'SRS-REPLAYED-PRODUCER',
      status: 'draft',
      content_hash: '1'.repeat(64),
    });
    const insertCompletion = (executionId, payloadHash) => {
      const reply = {
        completed: f.taskId,
        completed_new_status: 'review',
      };
      f.db.prepare(
        `INSERT INTO command_receipts
           (command_id,command_kind,actor_kind,actor_id,execution_id,task_id,
            payload_hash,accepted,rejection_code,result_json,reply_json)
         VALUES (?,?,?,?,?,?,?,1,NULL,?,?)`,
      ).run(
        `${executionId}:worker-done:approved`,
        'worker_done',
        'managed_execution',
        executionId,
        executionId,
        f.taskId,
        payloadHash,
        JSON.stringify(reply),
        JSON.stringify(reply),
      );
    };
    insertCompletion(f.executionId, '2'.repeat(64));

    f.db.prepare(
      `UPDATE worker_executions
          SET state='exited',phase='finishing',finished_at=datetime('now')
        WHERE execution_id=?`,
    ).run(f.executionId);
    const reworkExecutionId = 'exec-managed-product-2';
    f.db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
          launcher,state,phase,metadata)
       VALUES (?, 'run-rework',1,10,?,'worker-2','machine-1','test',
               'running','executing','{}')`,
    ).run(reworkExecutionId, f.taskId);
    f.db.prepare(
      `UPDATE tasks
          SET status='in_progress',assigned_to='worker-2',
              current_execution_id=?
        WHERE id=?`,
    ).run(reworkExecutionId, f.taskId);
    process.env.SAGA_EXECUTION_ID = reworkExecutionId;
    artifactHandlers.artifact_update({
      id: artifact.id,
      title: 'Second candidate',
      status: 'draft',
      content_hash: '3'.repeat(64),
    });
    insertCompletion(reworkExecutionId, '4'.repeat(64));

    assert.equal(
      new SqliteSaga3DiscoveryRuntime()
        .readLatestManagedProductionExecutionId(
          f.taskId,
          f.processRun.id,
          f.nodeId,
        ),
      reworkExecutionId,
    );
  } finally {
    cleanup(f.temp);
  }
});

test('projected tasks persist reviewer binding and reject reviewer rebinding', () => {
  const f = fixture();
  try {
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const input = {
      epicId: 10,
      projectId: 1,
      intentId: f.intentId,
      objective: 'formalize exact product',
      taskKind: 'formalization.prd',
      executionSkill: 'saga-product',
      reviewSkill: 'saga-requirements-reviewer',
      generationKey: 'managed-product-task',
      workflowStage: 'formalization',
      executionMode: 'artifact_change',
    };

    assert.equal(runtime.ensureProjectedTask(input), f.taskId);
    assert.equal(
      f.db.prepare('SELECT review_skill FROM tasks WHERE id=?')
        .get(f.taskId).review_skill,
      'saga-requirements-reviewer',
    );
    assert.throws(
      () => runtime.ensureProjectedTask({
        ...input,
        reviewSkill: 'saga-architecture-reviewer',
      }),
      /review_skill cannot be rebound/,
    );

    const insertedId = runtime.ensureProjectedTask({
      ...input,
      generationKey: 'managed-product-task-with-reviewer',
    });
    assert.equal(
      f.db.prepare('SELECT review_skill FROM tasks WHERE id=?')
        .get(insertedId).review_skill,
      'saga-requirements-reviewer',
    );
  } finally {
    cleanup(f.temp);
  }
});
