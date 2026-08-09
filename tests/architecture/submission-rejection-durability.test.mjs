import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `saga-submission-rejection-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = dbPath;

const { getDb, closeDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/dispatcher.js');
const { initSubmissionRegistries } = await import('../../dist/process-modules/application/submission-registries.js');
const { ensureFactoryProcessRunSchema } = await import('../../dist/process-modules/persistence/sqlite-process-run-repository.js');
const { ensureManagedProductionLedgerSchema } = await import('../../dist/process-modules/persistence/sqlite-managed-production-ledger.js');
const { ensureFormalizationPersistenceSchema } = await import('../../dist/modules/formalization/infrastructure/formalization-persistence.js');

const hash = value => createHash('sha256').update(value).digest('hex');

test('rejected worker_done commits exact feedback while preserving owner and fence', () => {
  const db = getDb();
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);
  ensureFormalizationPersistenceSchema(db);
  initSubmissionRegistries(db);

  const repo = path.join(os.tmpdir(), `saga-submission-repo-${process.pid}-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(`INSERT INTO repositories (id,name) VALUES (1,'r')`).run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(repo);
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (2,1,'solution-formalization','1.0.0','solution-formalization@1.0.0',
             'k','generic-flow','s','{}','input-hash','running')`,
  ).run();

  const prdHash = hash('prd');
  const acHash = hash('ac');
  const srs = [
    '# SRS',
    '## §12 Decision Log',
    '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
    '|---|---|---|---|---|---|',
    '| 1 | KISS | inherited | none | simple | 2026-08-09 |',
    '### D.2 AC-2: wrong heading',
    '| ac | module | files | pattern | ac_kind | criticality |',
    '|---|---|---|---|---|---|',
    '| AC-1.1 | core | app.js | A | implementation | blocker |',
  ].join('\n');
  const srsHash = hash(srs);
  writeFileSync(path.join(repo, 'srs.md'), srs);
  db.prepare(
    `INSERT INTO artifacts
       (id,project_id,epic_id,type,code,title,path,status,content_hash,
        accepted_hash,drift_state,project_repository_id,storage_kind,tags,metadata)
     VALUES (2,1,1,'PRD',NULL,'PRD','prd.md','accepted',?,?,'clean',1,'file_backed','[]','{}'),
            (3,1,1,'AC','AC-1','AC-1','ac.md','accepted',?,?,'clean',1,'db_native','[]','{}'),
            (22,1,1,'SRS',NULL,'SRS','srs.md','draft',?,?,'clean',1,'file_backed','[]','{}')`,
  ).run(prdHash, prdHash, acHash, acHash, srsHash, srsHash);
  db.prepare(
    `INSERT INTO artifact_traces (source_id,target_type,target_id,link_type)
     VALUES (22,'artifact',2,'derived_from')`,
  ).run();
  const baseline = {
    schemaVersion: 'factory.acceptance-baseline-snapshot.v1',
    processRunId: 2,
    formalizationEpicId: 1,
    sourceReconciliationRef: 'test:reconciliation',
    sourceReconciliationHash: hash('reconciliation'),
    acArtifactIds: [3],
    acArtifactHashes: { 3: acHash },
    baselineHash: hash('baseline'),
  };
  db.prepare(
    `INSERT INTO factory_formalization_acceptance_baselines
       (process_run_id,formalization_epic_id,schema_version,payload,baseline_hash,snapshot_hash)
     VALUES (2,1,?,?,?,?)`,
  ).run(
    baseline.schemaVersion,
    JSON.stringify(baseline),
    baseline.baselineHash,
    hash(JSON.stringify(baseline)),
  );

  const executionId = 'exec-rejected';
  const metadata = {
    process_run_id: 2,
    process_module_ref: 'solution-formalization@1.0.0',
    process_node_id: 'define-architecture-contract',
    process_node_input_hash: hash('node-input'),
  };
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,assigned_to,current_execution_id,task_kind,
        execution_mode,project_repository_id,metadata)
     VALUES (11,1,'architect','in_progress','worker-1',?,
             'formalization.architecture','tracker_only',1,?)`,
  ).run(executionId, JSON.stringify(metadata));
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase)
     VALUES (?,'run',1,1,11,'worker-1','machine','test','running','executing')`,
  ).run(executionId);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        artifact_id,artifact_type,artifact_status,content_hash,operation)
     VALUES (2,'solution-formalization@1.0.0','define-architecture-contract',
             11,11,?,22,'SRS','draft',?,'create')`,
  ).run(executionId, srsHash);

  let rejectionError;
  assert.throws(
    () => handlers.worker_done({
      task_id: 11,
      worker_id: 'worker-1',
      execution_id: executionId,
      result: 'attempted completion',
    }),
    error => {
      rejectionError = error;
      return error?.name === 'SubmissionValidationError'
        && error.code === 'FORMALIZATION_SRS_INCOMPLETE';
    },
  );
  assert.match(rejectionError.message, /Required representation:.*fenced YAML block/);
  assert.match(rejectionError.message, /Required fields: ac, title, module, files/);
  assert.match(rejectionError.message, /Exact accepted codes: AC-1/);
  assert.match(rejectionError.message, /Canonical example:\n## §D2 AC Map\n```yaml/);

  const task = db.prepare(
    'SELECT status,assigned_to,current_execution_id,metadata FROM tasks WHERE id=11',
  ).get();
  assert.equal(task.status, 'in_progress');
  assert.equal(task.assigned_to, 'worker-1');
  assert.equal(task.current_execution_id, executionId);
  const saved = JSON.parse(task.metadata);
  assert.equal(
    saved.recovery_feedback.schemaVersion,
    'factory.submission-validation-recovery-feedback.v1',
  );
  assert.ok(saved.recovery_feedback.issue.findings.length >= 2);

  const rejection = db.prepare(
    `SELECT rejection_ref,rejection_code,observed_set_digest
       FROM factory_submission_validation_rejections WHERE task_id=11`,
  ).all();
  assert.equal(rejection.length, 1);
  assert.equal(rejection[0].rejection_code, 'FORMALIZATION_SRS_INCOMPLETE');
  assert.ok(rejection[0].observed_set_digest);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM command_receipts WHERE task_id=11`).get().n,
    0,
    'rejected preflight is not a terminal worker_done receipt',
  );

  assert.throws(() => handlers.worker_done({
    task_id: 11,
    worker_id: 'worker-1',
    execution_id: executionId,
    result: 'attempted completion',
  }), /FORMALIZATION_SRS_INCOMPLETE/);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM factory_submission_validation_rejections WHERE task_id=11`).get().n,
    1,
    'exact invalid retry reuses the immutable rejection snapshot',
  );

  closeDb();
});
