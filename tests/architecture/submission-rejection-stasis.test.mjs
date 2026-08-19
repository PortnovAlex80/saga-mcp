// tests/architecture/submission-rejection-stasis.test.mjs
//
// BLINDSIGHT F5 (persistence layer + worker/tool layer, PREVENTIVE-HUNT
// «Слепота по слоям»): the durable submission-rejection chain
// (factory_submission_validation_rejections — one append-only row per
// rejected worker_done preflight, each carrying the byte-identity of the
// observed artifact set) was written per attempt and NEVER read as a chain.
// The pattern "the worker resubmitted BYTE-IDENTICAL material after N
// rejections" (zero repair — minimal labor) was invisible: every round
// looked like the first, and the loop could only end by mechanically
// exhausting a budget that this path does not even have.
//
// This suite pins the honest repair: the worker_done path reads the
// rejection chain AT the decision point; N consecutive rejections with the
// same observed-set digest (N parameterized, default 5) end the loop with a
// TYPED refusal and a blocked task (fail-closed), while a CHANGED observed
// set (real repair work) resets the counter and is never taxed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getDb, closeDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/dispatcher.js');
const { initSubmissionRegistries } = await import('../../dist/process-modules/application/submission-registries.js');
const { ensureFactoryProcessRunSchema } = await import('../../dist/process-modules/persistence/sqlite-process-run-repository.js');
const { ensureManagedProductionLedgerSchema } = await import('../../dist/process-modules/persistence/sqlite-managed-production-ledger.js');
const { ensureFormalizationPersistenceSchema } = await import('../../dist/modules/formalization/infrastructure/formalization-persistence.js');
const {
  DEFAULT_SUBMISSION_STASIS_THRESHOLD,
  readSubmissionRejectionStasis,
} = await import('../../dist/lifecycle/submission-validation-rejections.js');

const hash = value => createHash('sha256').update(value).digest('hex');

const repo = path.join(os.tmpdir(), `saga-stasis-repo-${process.pid}-${Date.now()}`);
mkdirSync(repo, { recursive: true });

/** Fresh DB per test (getDb caches one connection per DB_PATH). */
function useFreshDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `saga-submission-stasis-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DB_PATH = dbPath;
  return getDb();
}

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

function seedBase() {
  const db = useFreshDb();
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);
  ensureFormalizationPersistenceSchema(db);
  initSubmissionRegistries(db);

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
  // The conveyor-bound workplace this task projects to (the dispatcher's
  // human park runs through the ConveyorRuntime PROC-13 use case, which
  // needs the materialized workplace row).
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES (?,2,'solution-formalization@1.0.0','define-architecture-contract',
        'task-11','in_progress','running','author',1)`,
  ).run(WORKPLACE_REF);
  return { db, srsHash };
}

const WORKPLACE_REF =
  'workplace/2/solution-formalization@1.0.0/define-architecture-contract/task-11';

const TASK_METADATA = {
  process_run_id: 2,
  process_module_ref: 'solution-formalization@1.0.0',
  process_node_id: 'define-architecture-contract',
  process_node_input_hash: hash('node-input'),
};

/** One repair round: a NEW worker execution owns the task and calls worker_done. */
function repairRound(db, srsHash, round) {
  const executionId = `exec-stasis-${round}`;
  const workerId = `worker-stasis-${round}`;
  // The previous round's execution must be terminal before a new one may own
  // the task (partial UNIQUE: one ACTIVE execution per task / per worker).
  db.prepare(
    `UPDATE worker_executions SET state='exited' WHERE task_id=11 AND state='running'`,
  ).run();
  db.prepare(
    `UPDATE tasks SET status='in_progress', assigned_to=?, current_execution_id=?
      WHERE id=11`,
  ).run(workerId, executionId);
  // The workplace is leased by this round's execution (the conveyor's human
  // park must be able to release exactly this reservation).
  db.prepare(
    `UPDATE factory_workplaces
        SET active_reservation_ref=?, kanban_phase='in_progress', loop_state='running'
      WHERE workplace_ref=?`,
  ).run(executionId, WORKPLACE_REF);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase)
     VALUES (?,'run',1,1,11,?,'machine','test','running','executing')`,
  ).run(executionId, workerId);
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        artifact_id,artifact_type,artifact_status,content_hash,operation)
     VALUES (2,'solution-formalization@1.0.0','define-architecture-contract',
             11,11,?,22,'SRS','draft',?,'create')`,
  ).run(executionId, srsHash);
  return handlers.worker_done({
    task_id: 11,
    worker_id: workerId,
    execution_id: executionId,
    result: `repair round ${round}`,
  });
}

test('F5: N consecutive byte-identical rejections end the loop with a typed refusal and a blocked task', () => {
  const { db, srsHash } = seedBase();
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,assigned_to,current_execution_id,task_kind,
        execution_mode,project_repository_id,metadata)
     VALUES (11,1,'architect','in_progress','worker-1',NULL,
             'formalization.architecture','tracker_only',1,?)`,
  ).run(JSON.stringify(TASK_METADATA));

  const N = DEFAULT_SUBMISSION_STASIS_THRESHOLD;
  assert.equal(typeof N, 'number', 'threshold is exported and parameterizable');
  assert.ok(N >= 2);

  // Rounds 1..N-1: each rejection is the ordinary typed refusal — the worker
  // keeps the fence and may repair.
  for (let round = 1; round < N; round += 1) {
    assert.throws(
      () => repairRound(db, srsHash, round),
      error => error?.name === 'SubmissionValidationError'
        && error.code === 'FORMALIZATION_SRS_INCOMPLETE',
      `round ${round} stays the ordinary typed rejection`,
    );
    const task = db.prepare('SELECT status FROM tasks WHERE id=11').get();
    assert.equal(task.status, 'in_progress', `round ${round} keeps the task repairable`);
  }

  // The retrospective reader sees the byte-identical chain.
  const stasis = readSubmissionRejectionStasis(db, 11);
  assert.equal(stasis.consecutiveIdenticalBytes, N - 1);
  assert.equal(stasis.rejectionCode, 'FORMALIZATION_SRS_INCOMPLETE');
  assert.ok(stasis.observedSetDigest);

  // Round N: the SAME bytes again — the loop ends honestly.
  let stasisError;
  assert.throws(
    () => repairRound(db, srsHash, N),
    error => {
      stasisError = error;
      return error?.name === 'SubmissionValidationError'
        && error.code === 'SUBMISSION_STASIS_IDENTICAL_BYTES';
    },
    'round N with byte-identical material returns the TYPED stasis refusal',
  );
  assert.match(stasisError.message, new RegExp(`${N} consecutive rejections`));
  assert.match(stasisError.message, /byte-identical/);

  // Fail-closed: the task is blocked — no more mechanical rounds.
  const task = db.prepare('SELECT status, metadata FROM tasks WHERE id=11').get();
  assert.equal(task.status, 'blocked');
  const metadata = JSON.parse(task.metadata);
  assert.equal(metadata.managed_submission_stasis.rejectionCode, 'FORMALIZATION_SRS_INCOMPLETE');
  assert.equal(metadata.managed_submission_stasis.consecutiveRejections, N);
  assert.ok(metadata.managed_submission_stasis.observedSetDigest);

  closeDb();
});

test('F5: real repair work (changed bytes) RESETS the counter — convergence is never taxed', () => {
  const { db } = seedBase();
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,assigned_to,current_execution_id,task_kind,
        execution_mode,project_repository_id,metadata)
     VALUES (11,1,'architect','in_progress','worker-1',NULL,
             'formalization.architecture','tracker_only',1,?)`,
  ).run(JSON.stringify(TASK_METADATA));

  const N = DEFAULT_SUBMISSION_STASIS_THRESHOLD;

  // N-1 byte-identical rounds...
  for (let round = 1; round < N; round += 1) {
    assert.throws(() => repairRound(db, hash(srs), round), /FORMALIZATION_SRS_INCOMPLETE/);
  }
  assert.equal(readSubmissionRejectionStasis(db, 11).consecutiveIdenticalBytes, N - 1);

  // ...then the worker ACTUALLY edits the SRS (different bytes on disk + a
  // changed managed production hash). The observed set changes -> the chain
  // resets.
  const repairedSrs = `${srs}\n<!-- repair round edit -->`;
  writeFileSync(path.join(repo, 'srs.md'), repairedSrs);
  assert.throws(
    () => repairRound(db, hash(repairedSrs), N),
    error => error?.name === 'SubmissionValidationError'
      && error.code === 'FORMALIZATION_SRS_INCOMPLETE',
    'changed bytes still yield the ordinary typed rejection (not stasis)',
  );
  assert.equal(
    readSubmissionRejectionStasis(db, 11).consecutiveIdenticalBytes,
    1,
    'the changed observed set resets the consecutive run to 1',
  );
  const task = db.prepare('SELECT status FROM tasks WHERE id=11').get();
  assert.equal(task.status, 'in_progress', 'the task stays repairable after real work');

  closeDb();
});
