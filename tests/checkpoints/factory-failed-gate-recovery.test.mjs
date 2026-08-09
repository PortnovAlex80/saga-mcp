import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { recoverFailedGateRun } from '../../dist/app/factory-start.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { ensureFactoryNodeRunSchema } from '../../dist/process-modules/persistence/sqlite-node-run-repository.js';
import { ensureFactoryProcessProductV2Schema } from '../../dist/process-modules/persistence/sqlite-process-product-repository-v2.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';

const FAILURE = 'CHECK_PROVIDER_VERSION_MISMATCH: expected 1.0.0, got 1.1.0';
const hash = value => createHash('sha256').update(value).digest('hex');

function canonicalArchitecturePlan() {
  return formalizationProcessModule.flow.nodes.find(
    node => node.id === 'define-architecture-contract',
  ).cellDefinition.authorGate.checkPlan;
}

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  ensureFactoryLifecycleRunSchema(db);
  ensureFactoryNodeRunSchema(db);
  ensureFactoryProcessProductV2Schema(db);
  const repoPath = path.join(os.tmpdir(), `factory-gate-recovery-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(repoPath, { recursive: true });
  const srs = '# canonical SRS\n';
  writeFileSync(path.join(repoPath, 'srs.md'), srs);
  const srsHash = hash(srs);

  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')").run();
  db.prepare("INSERT INTO repositories (id,name) VALUES (1,'r')").run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(repoPath);
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status,error,completed_at)
     VALUES (2,1,1,'solution-formalization','1.0.0','solution-formalization@1.0.0',
             'process','generic-flow','input','{}','input-hash','failed',?,datetime('now'))`,
  ).run(FAILURE);
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,
        description,definition_snapshot,definition_hash,project_id,epic_id,
        initiated_by,idempotency_key,input_schema,input_snapshot,input_hash,
        status,entry_stage_id,current_stage_id,current_stage_run_id,
        terminal_status,version,error,completed_at)
     VALUES (1,'product-delivery','1.0.0','product-delivery@1.0.0','Product Delivery',
             'test','{}','definition-hash',1,1,'test','lifecycle','input','{}',
             'input-hash','failed','initial-discovery','solution-formalization',2,
             'failed',9,?,datetime('now'))`,
  ).run(FAILURE);
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,ordinal,stage_id,attempt,module_name,module_version,
        module_ref_key,binding_snapshot,binding_hash,input_schema,input_snapshot,
        input_hash,status,process_run_id,error,completed_at)
     VALUES (2,1,2,'solution-formalization',1,'solution-formalization','1.0.0',
             'solution-formalization@1.0.0','{}','binding-hash','input','{}',
             'input-hash','failed',2,?,datetime('now'))`,
  ).run(FAILURE);
  const workplaceRef = 'workplace/2/solution-formalization@1.0.0/formalization-architecture-contract/singleton';
  const workplace = {
    processRunId: 2,
    moduleRef: 'solution-formalization@1.0.0',
    productionCellId: 'formalization-architecture-contract',
    workKey: 'singleton',
  };
  const executionRef = 'worker-execution:accepted-author';
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,active_reservation_ref)
     VALUES (?,2,'solution-formalization@1.0.0','formalization-architecture-contract',
             'singleton','in_progress','verifying','author',18,?)`,
  ).run(workplaceRef, executionRef);
  db.prepare(
    `INSERT INTO artifacts
       (id,project_id,epic_id,type,title,path,status,content_hash,
        drift_state,project_repository_id,storage_kind,tags,metadata)
     VALUES (22,1,1,'SRS','SRS','srs.md','draft',?,
             'unknown',1,'file_backed','[]','{}')`,
  ).run(srsHash);
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,task_kind,execution_mode,
        project_repository_id,metadata)
     VALUES (11,1,'architect','in_progress',?,'formalization.architecture',
             'tracker_only',1,'{}')`,
  ).run(workplaceRef);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,exit_code,finished_at)
     VALUES (?,'run',1,1,11,'worker','machine','claude_cli','exited','finishing',0,datetime('now'))`,
  ).run(executionRef);
  db.prepare(
    `INSERT INTO command_receipts
       (command_id,command_kind,actor_kind,execution_id,task_id,payload_hash,
        accepted,result_json,reply_json)
     VALUES ('done','worker_done','managed_execution',?,11,'payload',1,'{}','{}')`,
  ).run(executionRef);

  const product = {
    schemaId: 'factory.formalization-architecture-bundle.v1',
    ref: 'workplace:solution-formalization@1.0.0:define-architecture-contract:product',
    digest: 'a'.repeat(64),
  };
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id,product_kind,product_key,schema_id,artifact_ref,
        product_hash,payload_snapshot,payload_hash,node_id)
     VALUES (2,'bundle','architecture',?,?,?,'{}','payload','define-architecture-contract')`,
  ).run(product.schemaId, product.ref, product.digest);
  const candidateDigest = sha256Hex({
    workplaceRef: workplace,
    executionRef,
    role: 'author',
    products: [product],
  });
  const candidate = new SqliteCandidateSetRepository(db).seal({
    workplaceRef: workplace,
    producerExecutionRef: executionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members: [{ productRef: product, origin: 'produced', sourceCandidateSetRef: null }],
    sealReceiptRef: 'seal:author',
    candidateSetDigest: candidateDigest,
    sealedAt: new Date().toISOString(),
  }).set;

  const plan = canonicalArchitecturePlan();
  const oldGateRef = 'gate-run:legacy-plan';
  const gateRepo = new SqliteGateRepository(db);
  gateRepo.createGateRun({
    gateRunRef: oldGateRef,
    workplaceRef: workplace,
    gatePhase: 'author',
    subjectCandidateSetRef: candidate.candidateSetRef,
    assessmentCandidateSetRefs: [],
    checkPlanRef: plan.checkPlanId,
    checkPlanDigest: 'legacy-plan-digest',
    expectedWorkplaceRevision: 18,
    gateLeaseRef: 'gate-lease:legacy',
  });
  gateRepo.setGateRunState(oldGateRef, 'checking');
  const first = plan.entries[0].check;
  gateRepo.recordCheckReceipt({
    checkReceiptRef: `receipt:${oldGateRef}:${first.providerId}`,
    checkRunRef: oldGateRef,
    subjectCandidateSetRef: candidate.candidateSetRef,
    assessmentCandidateSetRefs: [],
    check: first,
    environmentRef: null,
    outcome: 'passed',
    evidenceRefs: [],
    receiptDigest: 'receipt-digest',
  });
  db.prepare(
    `INSERT INTO factory_submission_validation_receipts
       (validator_id,validator_version,process_run_id,module_ref,node_id,
        execution_id,task_id,input_snapshot_hash,artifact_ids,trace_ids,
        artifact_hashes,trace_digest,contract_ref,validated_set_digest)
     VALUES ('formalization.srs-contract.v1','1.1.0',2,
             'solution-formalization@1.0.0','define-architecture-contract',?,11,
             'validated','[22]','[]',?,'','{}','validated')`,
  ).run(executionRef, JSON.stringify({ 22: srsHash }));
  db.prepare(
    `INSERT INTO factory_node_runs
       (id,process_run_id,node_id,node_kind,attempt,status,error_message,completed_at)
     VALUES (34,2,'define-architecture-contract','production-cell',15,'failed',?,datetime('now'))`,
  ).run(FAILURE);
  return { db, plan, workplaceRef, candidate, oldGateRef };
}

test('failed provider gate recovery preserves CandidateSet and reopens only runtime envelopes', () => {
  const { db, plan, workplaceRef, candidate, oldGateRef } = fixture();
  const input = {
    projectId: 1,
    replacementCheckPlan: plan,
    actorId: 'operator',
    reason: 'remove legacy provider version',
  };
  const recovered = recoverFailedGateRun(db, input);
  assert.equal(recovered.candidateSetRef, candidate.candidateSetRef);
  assert.equal(recovered.abandonedGateRunRef, oldGateRef);
  assert.equal(recovered.replacementCheckPlanDigest, plan.checkPlanDigest);
  assert.equal(recovered.resultingLifecycleVersion, 10);
  assert.equal(recovered.replayed, false);
  assert.deepEqual(
    db.prepare('SELECT status,terminal_status,error,completed_at,version FROM factory_lifecycle_runs WHERE id=1').get(),
    { status: 'paused', terminal_status: null, error: null, completed_at: null, version: 10 },
  );
  assert.deepEqual(
    db.prepare('SELECT status,error,completed_at FROM factory_stage_runs WHERE id=2').get(),
    { status: 'paused', error: null, completed_at: null },
  );
  assert.deepEqual(
    db.prepare('SELECT status,error,completed_at FROM factory_process_runs WHERE id=2').get(),
    { status: 'paused', error: null, completed_at: null },
  );
  assert.deepEqual(
    db.prepare('SELECT loop_state,revision,active_reservation_ref FROM factory_workplaces WHERE workplace_ref=?').get(workplaceRef),
    { loop_state: 'verifying', revision: 18, active_reservation_ref: 'worker-execution:accepted-author' },
  );
  assert.equal(db.prepare('SELECT state FROM factory_gate_runs WHERE gate_run_ref=?').get(oldGateRef).state, 'checking');
  assert.equal(db.prepare('SELECT status FROM factory_node_runs WHERE id=34').get().status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM factory_failed_gate_recovery_authorizations').get().n, 1);

  const replay = recoverFailedGateRun(db, input);
  assert.equal(replay.authorizationRef, recovered.authorizationRef);
  assert.equal(replay.replayed, true);
  db.close();
});

test('failed gate recovery refuses replacement plans that retain the legacy digest', () => {
  const { db, plan } = fixture();
  assert.throws(
    () => recoverFailedGateRun(db, {
      projectId: 1,
      replacementCheckPlan: { ...plan, checkPlanDigest: 'legacy-plan-digest' },
      actorId: 'operator',
      reason: 'bad recovery',
    }),
    /not the canonical successor/,
  );
  assert.equal(db.prepare('SELECT status FROM factory_lifecycle_runs WHERE id=1').get().status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM factory_failed_gate_recovery_authorizations').get().n, 0);
  db.close();
});
