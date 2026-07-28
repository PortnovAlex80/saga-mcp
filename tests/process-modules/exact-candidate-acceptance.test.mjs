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
const {
  ensureExactCandidateAcceptanceSchema,
  SqliteExactCandidateAcceptance,
} = await import(
  '../../dist/process-modules/persistence/sqlite-exact-candidate-acceptance.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

function fixture({ includeProducerReceipt = true } = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-exact-acceptance-'));
  process.env.DB_PATH = path.join(temp, 'acceptance.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  const input = { objective: 'accept exact output' };
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
      idempotencyKey: 'acceptance-run',
    },
  });
  const taskId = Number(db.prepare(
    `INSERT INTO tasks
       (epic_id,title,status,priority,task_kind,workflow_stage,
        execution_skill,execution_mode,generation_key,metadata)
     VALUES (10,'Produce','done','high','test.produce','formalization',
             'test','artifact_change','test-produce','{}')
     RETURNING id`,
  ).get().id);
  const executionId = 'exec-producer-1';
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES (?, 'run-1',1,10,?,'producer','machine','test','exited','finishing','{}')`,
  ).run(executionId, taskId);
  const reviewerExecutionId = 'exec-review-1';
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES (?, 'run-review-1',1,10,?,'reviewer','machine','test',
             'exited','finishing','{}')`,
  ).run(reviewerExecutionId, taskId);

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
    `INSERT INTO saga3_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        artifact_id,artifact_type,artifact_status,content_hash,operation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    processRun.id,
    'test-module@1.0.0',
    'produce-contract',
    501,
    taskId,
    executionId,
    artifactId,
    'SRS',
    'draft',
    contentHash,
    'create',
  );

  const producerReply = {
    completed: taskId,
    completed_new_status: 'review',
    stop: true,
    stop_reason: 'done',
  };
  const reviewReply = {
    completed: taskId,
    completed_new_status: 'done',
    stop: true,
    stop_reason: 'done',
  };
  if (includeProducerReceipt) {
    db.prepare(
      `INSERT INTO command_receipts
         (command_id,command_kind,actor_kind,actor_id,execution_id,task_id,
          payload_hash,accepted,rejection_code,result_json,reply_json)
       VALUES (?,?,?,?,?,?,?,1,NULL,?,?)`,
    ).run(
      `${executionId}:worker-done:approved`,
      'worker_done',
      'managed_execution',
      'producer',
      executionId,
      taskId,
      'c'.repeat(64),
      JSON.stringify(producerReply),
      JSON.stringify(producerReply),
    );
  }
  db.prepare(
    `INSERT INTO command_receipts
       (command_id,command_kind,actor_kind,actor_id,execution_id,task_id,
        payload_hash,accepted,rejection_code,result_json,reply_json)
     VALUES (?,?,?,?,?,?,?,1,NULL,?,?)`,
  ).run(
    'exec-review-1:worker-done:approved',
    'worker_done',
    'managed_execution',
    'reviewer',
    'exec-review-1',
    taskId,
    'b'.repeat(64),
    JSON.stringify(reviewReply),
    JSON.stringify(reviewReply),
  );

  const command = {
    idempotencyKey: 'gate:1:accept',
    lineage: {
      processRunId: processRun.id,
      moduleRef: 'test-module@1.0.0',
      nodeId: 'produce-contract',
      intentId: 501,
      taskId,
      executionId,
      projectId: 1,
      epicId: 10,
    },
    candidates: [{ artifactId, artifactType: 'SRS', contentHash }],
    requireApprovedReview: true,
    authority: 'test-gate@1',
    reasonCode: 'CONTRACT_VALID',
    context: { gateNodeId: 'resolve-contract' },
  };
  return { temp, db, artifactId, contentHash, command };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('exact candidate acceptance is atomic, review-backed and idempotent', () => {
  const f = fixture();
  try {
    const acceptance = new SqliteExactCandidateAcceptance(f.db);
    const first = acceptance.accept(f.command);
    assert.equal(first.replayed, false);
    assert.equal(
      first.schemaVersion,
      'saga3.exact-candidate-acceptance.v2',
    );
    assert.equal(first.items[0].disposition, 'accepted');
    assert.equal(
      first.producerCompletionReceiptCommandId,
      'exec-producer-1:worker-done:approved',
    );
    assert.equal(
      first.approvedReviewReceiptCommandId,
      'exec-review-1:worker-done:approved',
    );
    assert.deepEqual(
      f.db.prepare(
        `SELECT status,accepted_hash,drift_state
           FROM artifacts WHERE id=?`,
      ).get(f.artifactId),
      {
        status: 'accepted',
        accepted_hash: f.contentHash,
        drift_state: 'clean',
      },
    );

    const replay = acceptance.accept(f.command);
    assert.equal(replay.replayed, true);
    assert.equal(replay.decisionId, first.decisionId);
    assert.equal(replay.decisionHash, first.decisionHash);
    assert.equal(
      f.db.prepare(
        'SELECT COUNT(*) AS n FROM saga3_exact_candidate_acceptance_decisions',
      ).get().n,
      1,
    );
    assert.equal(
      acceptance.isAcceptedExact(
        f.command.lineage,
        f.command.candidates[0],
      ),
      true,
    );

    f.db.prepare(
      `UPDATE artifacts SET content_hash=?,drift_state='drifted' WHERE id=?`,
    ).run('c'.repeat(64), f.artifactId);
    assert.throws(
      () => acceptance.accept(f.command),
      error => error?.code === 'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT',
    );
  } finally {
    cleanup(f.temp);
  }
});

test('a mismatched member rejects the whole candidate set before any CAS', () => {
  const f = fixture();
  try {
    const secondHash = 'd'.repeat(64);
    const secondId = Number(f.db.prepare(
      `INSERT INTO artifacts
         (project_id,epic_id,type,code,title,path,status,content_hash,
          accepted_hash,drift_state)
       VALUES (1,10,'FR','FR-1','FR','docs/fr.md','draft',?,NULL,'unknown')
       RETURNING id`,
    ).get(secondHash).id);
    f.db.prepare(
      `INSERT INTO saga3_managed_artifact_productions
         (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
          artifact_id,artifact_type,artifact_status,content_hash,operation)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      f.command.lineage.processRunId,
      f.command.lineage.moduleRef,
      f.command.lineage.nodeId,
      f.command.lineage.intentId,
      f.command.lineage.taskId,
      f.command.lineage.executionId,
      secondId,
      'FR',
      'draft',
      secondHash,
      'create',
    );

    const invalidSet = {
      ...f.command,
      idempotencyKey: 'gate:1:invalid-set',
      candidates: [
        ...f.command.candidates,
        {
          artifactId: secondId,
          artifactType: 'FR',
          contentHash: 'e'.repeat(64),
        },
      ],
    };
    const acceptance = new SqliteExactCandidateAcceptance(f.db);
    assert.throws(
      () => acceptance.accept(invalidSet),
      error => error?.code === 'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT',
    );
    assert.equal(
      f.db.prepare('SELECT status FROM artifacts WHERE id=?').get(f.artifactId).status,
      'draft',
    );
    assert.equal(
      f.db.prepare('SELECT status FROM artifacts WHERE id=?').get(secondId).status,
      'draft',
    );
    assert.equal(
      f.db.prepare(
        'SELECT COUNT(*) AS n FROM saga3_exact_candidate_acceptance_decisions',
      ).get().n,
      0,
    );
  } finally {
    cleanup(f.temp);
  }
});

test('an accepted artifact without a prior exact decision cannot be attested retroactively', () => {
  const f = fixture();
  try {
    f.db.prepare(
      `UPDATE artifacts
          SET status='accepted',accepted_hash=?,drift_state='clean'
        WHERE id=?`,
    ).run(f.contentHash, f.artifactId);
    const acceptance = new SqliteExactCandidateAcceptance(f.db);
    assert.throws(
      () => acceptance.accept(f.command),
      error =>
        error?.code
        === 'EXACT_ACCEPTANCE_PREEXISTING_ACCEPTANCE_UNATTESTED',
    );
    assert.equal(
      f.db.prepare(
        'SELECT COUNT(*) AS n FROM saga3_exact_candidate_acceptance_decisions',
      ).get().n,
      0,
    );
  } finally {
    cleanup(f.temp);
  }
});

test('review-required acceptance rejects a done task without exact producer completion', () => {
  const f = fixture({ includeProducerReceipt: false });
  try {
    const acceptance = new SqliteExactCandidateAcceptance(f.db);
    assert.throws(
      () => acceptance.accept(f.command),
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

test('a newer changes_requested receipt supersedes an older approval', () => {
  const f = fixture();
  try {
    const reply = {
      completed: f.command.lineage.taskId,
      completed_new_status: 'todo',
      stop: true,
      stop_reason: 'changes_requested',
    };
    f.db.prepare(
      `INSERT INTO command_receipts
         (command_id,command_kind,actor_kind,actor_id,execution_id,task_id,
          payload_hash,accepted,rejection_code,result_json,reply_json)
       VALUES (?,?,?,?,?,?,?,1,NULL,?,?)`,
    ).run(
      'exec-review-2:worker-done:changes_requested',
      'worker_done',
      'managed_execution',
      'reviewer-2',
      'exec-review-2',
      f.command.lineage.taskId,
      'd'.repeat(64),
      JSON.stringify(reply),
      JSON.stringify(reply),
    );
    const acceptance = new SqliteExactCandidateAcceptance(f.db);
    assert.throws(
      () => acceptance.accept(f.command),
      error => error?.code === 'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
    );
  } finally {
    cleanup(f.temp);
  }
});

test('a legacy v1 decision remains exactly replayable after the v2 upgrade', () => {
  const f = fixture();
  try {
    ensureExactCandidateAcceptanceSchema(f.db);
    const ledgerId = Number(f.db.prepare(
      `SELECT id
         FROM saga3_managed_artifact_productions
        WHERE artifact_id=?`,
    ).get(f.artifactId).id);
    const legacyRequest = {
      schemaVersion: 'saga3.exact-candidate-acceptance.v1',
      idempotencyKey: f.command.idempotencyKey,
      lineage: f.command.lineage,
      candidates: f.command.candidates,
      requireApprovedReview: true,
      authority: f.command.authority,
      reasonCode: f.command.reasonCode,
      context: f.command.context,
    };
    const requestSnapshot = canonicalJson(legacyRequest);
    const requestHash = sha256Hex(legacyRequest);
    const candidateSetHash = sha256Hex(f.command.candidates);
    const item = {
      artifactId: f.artifactId,
      artifactType: 'SRS',
      contentHash: f.contentHash,
      ledgerId,
      disposition: 'accepted',
      priorStatus: 'draft',
      priorAcceptedHash: null,
      priorDriftState: 'unknown',
      finalStatus: 'accepted',
      finalAcceptedHash: f.contentHash,
      finalDriftState: 'clean',
    };
    const decisionHash = sha256Hex({
      schemaVersion: 'saga3.exact-candidate-acceptance.v1',
      idempotencyKey: f.command.idempotencyKey,
      requestHash,
      candidateSetHash,
      reviewReceiptCommandId: 'exec-review-1:worker-done:approved',
      items: [item],
    });
    f.db.prepare(
      `UPDATE artifacts
          SET status='accepted',accepted_hash=content_hash,drift_state='clean'
        WHERE id=?`,
    ).run(f.artifactId);
    const decisionId = Number(f.db.prepare(
      `INSERT INTO saga3_exact_candidate_acceptance_decisions
         (schema_version,idempotency_key,request_hash,request_snapshot,
          candidate_set_hash,process_run_id,module_ref,node_id,intent_id,
          task_id,execution_id,project_id,epic_id,review_required,
          review_receipt_command_id,authority,reason_code,decision_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       RETURNING id`,
    ).get(
      legacyRequest.schemaVersion,
      f.command.idempotencyKey,
      requestHash,
      requestSnapshot,
      candidateSetHash,
      f.command.lineage.processRunId,
      f.command.lineage.moduleRef,
      f.command.lineage.nodeId,
      f.command.lineage.intentId,
      f.command.lineage.taskId,
      f.command.lineage.executionId,
      f.command.lineage.projectId,
      f.command.lineage.epicId,
      1,
      'exec-review-1:worker-done:approved',
      f.command.authority,
      f.command.reasonCode,
      decisionHash,
    ).id);
    f.db.prepare(
      `INSERT INTO saga3_exact_candidate_acceptance_items
         (decision_id,ordinal,artifact_id,artifact_type,
          expected_content_hash,ledger_id,disposition,prior_status,
          prior_accepted_hash,prior_drift_state,final_status,
          final_accepted_hash,final_drift_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      decisionId,
      0,
      item.artifactId,
      item.artifactType,
      item.contentHash,
      item.ledgerId,
      item.disposition,
      item.priorStatus,
      item.priorAcceptedHash,
      item.priorDriftState,
      item.finalStatus,
      item.finalAcceptedHash,
      item.finalDriftState,
    );

    const replay = new SqliteExactCandidateAcceptance(f.db).accept(f.command);
    assert.equal(replay.schemaVersion, legacyRequest.schemaVersion);
    assert.equal(replay.replayed, true);
    assert.equal(replay.decisionHash, decisionHash);
  } finally {
    cleanup(f.temp);
  }
});
