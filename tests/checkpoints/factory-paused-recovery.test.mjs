import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { persistSubmissionValidationRejection } from '../../dist/lifecycle/submission-validation-rejections.js';
import { resumePausedSubmissionWorkplace, resumeWorkerLossWorkplace } from '../../dist/app/factory-start.js';
import { reconcileAutomaticPreSpawnRecovery } from '../../dist/app/automatic-pre-spawn-recovery.js';

const hash = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  ensureFactoryLifecycleRunSchema(db);
  const repoPath = path.join(os.tmpdir(), `factory-paused-recovery-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(repoPath, { recursive: true });
  const srs = '# invalid SRS awaiting repair\n';
  writeFileSync(path.join(repoPath, 'srs.md'), srs);
  const srsHash = hash(srs);

  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(`INSERT INTO repositories (id,name) VALUES (1,'r')`).run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(repoPath);
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (2,1,'solution-formalization','1.0.0','solution-formalization@1.0.0',
             'process','generic-flow','input','{}','input-hash','paused')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,
        description,definition_snapshot,definition_hash,project_id,epic_id,
        initiated_by,idempotency_key,input_schema,input_snapshot,input_hash,
        status,entry_stage_id,current_stage_id,current_stage_run_id)
     VALUES (1,'product-delivery','1.0.0','product-delivery@1.0.0','Product Delivery',
             'test','{}','definition-hash',1,1,'test','lifecycle','input','{}',
             'input-hash','paused','initial-discovery','solution-formalization',2)`,
  ).run();
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,
        module_ref_key,binding_snapshot,binding_hash,input_schema,input_snapshot,
        input_hash,status,process_run_id)
     VALUES (2,1,2,'solution-formalization',1,'solution-formalization','1.0.0',
             'solution-formalization@1.0.0','{}','binding-hash','input','{}',
             'input-hash','paused',2)`,
  ).run();
  const workplaceRef = 'workplace/2/solution-formalization@1.0.0/formalization-architecture-contract/singleton';
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES (?,2,'solution-formalization@1.0.0','formalization-architecture-contract',
             'singleton','blocked','paused','author',7)`,
  ).run(workplaceRef);
  db.prepare(
    `INSERT INTO artifacts
       (id,project_id,epic_id,type,title,path,status,content_hash,accepted_hash,
        drift_state,project_repository_id,storage_kind,tags,metadata)
     VALUES (22,1,1,'SRS','SRS','srs.md','draft',?,?,'clean',1,'file_backed','[]','{}')`,
  ).run(srsHash, srsHash);
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,task_kind,execution_mode,
        project_repository_id,metadata)
     VALUES (11,1,'architect','in_progress',?,'formalization.architecture',
             'tracker_only',1,?)`,
  ).run(workplaceRef, JSON.stringify({
    process_run_id: 2,
    process_module_ref: 'solution-formalization@1.0.0',
    process_node_id: 'define-architecture-contract',
  }));
  const persisted = persistSubmissionValidationRejection(db, {
    validatorId: 'formalization.srs-contract.v1',
    validatorVersion: '1.1.0',
    processRunId: 2,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'define-architecture-contract',
    executionId: 'lost-exec',
    taskId: 11,
    actorKind: 'admin',
    rejectionCode: 'FORMALIZATION_SRS_INCOMPLETE',
    gaps: [{
      artifactId: 22,
      artifactCode: null,
      artifactType: 'SRS',
      existingTargets: [],
      missing: { relation: 'd2-representation', requiredTargetTypes: ['§D2 YAML'], minimum: 1 },
    }],
    details: { expectedAcCodes: ['AC-1'] },
    inputSnapshotHash: 'node-input-hash',
  });
  return { db, repoPath, workplaceRef, persisted };
}

test('guarded recovery consumes one authorization and requeues by Workplace CAS', () => {
  const { db, workplaceRef, persisted } = fixture();
  const input = {
    lifecycleRunId: 1,
    actorId: 'operator',
    reason: 'incident recovery',
  };
  const result = resumePausedSubmissionWorkplace(db, input);
  assert.equal(result.rejectionRef, persisted.rejectionRef);
  assert.equal(result.resultingRevision, 8);
  assert.equal(result.replayed, false);
  const workplace = db.prepare(
    'SELECT kanban_phase,loop_state,revision FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceRef);
  assert.deepEqual(workplace, { kanban_phase: 'in_progress', loop_state: 'queued', revision: 8 });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=11').get().status, 'in_progress');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_operator_recovery_authorizations').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_operator_recovery_consumptions').get().n, 1);

  const replay = resumePausedSubmissionWorkplace(db, input);
  assert.equal(replay.authorizationRef, result.authorizationRef);
  assert.equal(replay.replayed, true);
  assert.equal(db.prepare('SELECT revision FROM factory_workplaces WHERE workplace_ref=?').get(workplaceRef).revision, 8);
  db.close();
});

test('guarded recovery refuses artifact bytes changed after rejection', () => {
  const { db, repoPath } = fixture();
  writeFileSync(path.join(repoPath, 'srs.md'), '# changed outside artifact service\n');
  assert.throws(
    () => resumePausedSubmissionWorkplace(db, {
      lifecycleRunId: 1,
      actorId: 'operator',
      reason: 'incident recovery',
    }),
    /file hash changed after rejection/,
  );
  assert.equal(db.prepare('SELECT revision FROM factory_workplaces').get().revision, 7);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_operator_recovery_authorizations').get().n, 0);
  db.close();
});

test('worker-loss recovery resolves the exact lost author across multiple role tasks', () => {
  const { db, workplaceRef } = fixture();
  db.prepare(
    `UPDATE tasks SET metadata=json_set(metadata,'$.role','author') WHERE id=11`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,task_kind,execution_mode,
        project_repository_id,metadata)
     VALUES (12,1,'reviewer','done',?,'formalization.architecture',
             'tracker_only',1,'{"role":"reviewer"}')`,
  ).run(workplaceRef);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,reserved_at,finished_at,last_error)
     VALUES ('lost-author','run-a',1,1,11,'author','machine','factory',
             'lost','executing','2026-01-02 00:00:00','2026-01-02 00:01:00','process lost'),
            ('done-reviewer','run-r',1,1,12,'reviewer','machine','factory',
             'exited','reviewing','2026-01-03 00:00:00','2026-01-03 00:01:00',NULL)`,
  ).run();

  const input = { lifecycleRunId: 1, actorId: 'operator', reason: 'worker loss' };
  const result = resumeWorkerLossWorkplace(db, input);
  assert.equal(result.lostExecutionRef, 'lost-author');
  assert.equal(result.taskId, 11);
  assert.equal(result.resultingRevision, 8);
  assert.equal(result.replayed, false);
  assert.deepEqual(
    db.prepare(
      'SELECT kanban_phase,loop_state,revision FROM factory_workplaces WHERE workplace_ref=?',
    ).get(workplaceRef),
    { kanban_phase: 'in_progress', loop_state: 'queued', revision: 8 },
  );
  assert.equal(db.prepare(
    'SELECT COUNT(*) n FROM factory_worker_loss_resume_authorizations',
  ).get().n, 1);

  const replay = resumeWorkerLossWorkplace(db, input);
  assert.equal(replay.authorizationRef, result.authorizationRef);
  assert.equal(replay.replayed, true);
  db.close();
});

test('ordinary bootstrap recovery requeues a superseded pre-spawn desk failure once', () => {
  const { db, workplaceRef } = fixture();
  db.prepare("UPDATE tasks SET status='blocked' WHERE id=11").run();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,reserved_at,last_error)
     VALUES ('worker-execution:desk-failure','run-1',1,1,11,'worker','machine',
             'factory','spawn_failed','executing',datetime('now'),?)`,
  ).run(
    'Claude spawn failed (pre-assigned): REPOSITORY_DESK_BASE_MISMATCH: '
    + 'old attempt does not descend from the new effective base',
  );

  let result;
  try {
    result = reconcileAutomaticPreSpawnRecovery(db, 1);
  } catch (error) {
    assert.fail(error?.stack ?? String(error));
  }
  assert.equal(result.executionId, 'worker-execution:desk-failure');
  assert.equal(result.resultingRevision, 8);
  assert.deepEqual(
    db.prepare(
      'SELECT kanban_phase,loop_state,revision FROM factory_workplaces WHERE workplace_ref=?',
    ).get(workplaceRef),
    { kanban_phase: 'in_progress', loop_state: 'queued', revision: 8 },
  );
  assert.equal(db.prepare(
    'SELECT state FROM worker_executions WHERE execution_id=?',
  ).get('worker-execution:desk-failure').state, 'spawn_failed');
  assert.equal(db.prepare(
    'SELECT COUNT(*) n FROM factory_automatic_spawn_recovery_receipts',
  ).get().n, 1);
  assert.equal(reconcileAutomaticPreSpawnRecovery(db, 1), null);
  assert.equal(db.prepare(
    'SELECT COUNT(*) n FROM factory_automatic_spawn_recovery_receipts',
  ).get().n, 1);
  db.close();
});

test('bootstrap recovery leaves an actual process spawn failure human-paused', () => {
  const { db } = fixture();
  db.prepare("UPDATE tasks SET status='blocked' WHERE id=11").run();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,reserved_at,last_error)
     VALUES ('worker-execution:enoent','run-1',1,1,11,'worker','machine',
             'factory','spawn_failed','executing',datetime('now'),
             'Claude spawn failed: ENOENT claude')`,
  ).run();
  assert.equal(reconcileAutomaticPreSpawnRecovery(db, 1), null);
  assert.equal(db.prepare('SELECT loop_state FROM factory_workplaces').get().loop_state, 'paused');
  assert.equal(db.prepare(
    'SELECT COUNT(*) n FROM factory_automatic_spawn_recovery_receipts',
  ).get().n, 0);
  db.close();
});
