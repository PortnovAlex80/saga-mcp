import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const dbPath = path.join(
  os.tmpdir(),
  `saga-production-cell-product-boundary-${process.pid}-${Date.now()}.sqlite`,
);
process.env.DB_PATH = dbPath;

test('worker MCP composition installs payload contracts from the single workshop manifest (ADR-053 Phase 1)', async () => {
  const source = readFileSync(
    path.resolve('src/index.ts'),
    'utf8',
  );
  // ADR-053 Phase 1: the worker MCP installs payload contracts via the single
  // manifest entry point, not a hand-list of individual register calls.
  assert.match(
    source,
    /installWorkshopPayloadContracts\(\)/,
    'src/index.ts must call installWorkshopPayloadContracts() — the single manifest install path',
  );
  // The manifest itself must declare every pinned built-in review decoder.
  const { buildWorkshopCapabilityManifest } = await import(
    '../../dist/process-modules/application/workshop-capability-manifest.js'
  );
  const manifest = buildWorkshopCapabilityManifest();
  const schemaIds = new Set(manifest.payloadContracts.map(e => e.schemaId));
  for (const expected of [
    'factory.review-verdict.v1',
    'factory.development-review-verdict.v1',
    'factory.candidate-verification-evidence-product.v2',
    'factory.development-task-graph-proposal.v1',
  ]) {
    assert.ok(
      schemaIds.has(expected),
      `workshop manifest must declare payload contract ${expected}; got: ${[...schemaIds].join(', ')}`,
    );
  }
});

const { getDb, closeDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/dispatcher.js');
const { SqliteManagedNodeSubmissionRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js'
);

test('worker_done cannot advance a Production Cell without an exact typed product', () => {
  const db = getDb();
  new SqliteManagedNodeSubmissionRepository(db);
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status)
     VALUES (1,1,'synthetic.review','review','{}',
             'factory.development-review-verdict.v1','executing')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (1,1,'synthetic','1.0.0','synthetic@1.0.0','run-1','generic-flow',
             'factory.synthetic-input.v1','{}','input-hash','running')`,
  ).run();
  const workplaceRef = 'workplace/1/synthetic@1.0.0/cell/item';
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,active_reservation_ref)
     VALUES (?,1,'synthetic@1.0.0','cell','item','in_progress','running','author',2,'exec-1')`,
  ).run(workplaceRef);
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,assigned_to,current_execution_id,workplace_ref,
        task_kind,execution_mode,metadata)
     VALUES (1,1,'produce','in_progress','worker-1','exec-1',?,
             'synthetic.work','tracker_only',?)`,
  ).run(workplaceRef, JSON.stringify({
    process_run_id: 1,
    process_module_ref: 'synthetic@1.0.0',
    process_node_id: 'cell-node',
    production_cell_id: 'cell',
    work_intent_id: 1,
  }));
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase)
     VALUES ('exec-1','dispatch-1',1,1,1,'worker-1','machine','test','running','executing')`,
  ).run();
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_managed_node_submissions').get().n,
    0,
  );
  assert.equal(
    JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=1').get().metadata).production_cell_id,
    'cell',
  );
  assert.equal(
    db.prepare('SELECT workplace_ref FROM tasks WHERE id=1').get().workplace_ref,
    workplaceRef,
  );
  assert.equal(
    db.prepare('SELECT production_cell_id FROM factory_workplaces WHERE workplace_ref=?').get(workplaceRef).production_cell_id,
    'cell',
  );

  assert.throws(
    () => handlers.worker_done({
      task_id: 1,
      worker_id: 'worker-1',
      execution_id: 'exec-1',
      result: 'prose-only completion claim',
    }),
    /PRODUCTION_CELL_PRODUCT_REQUIRED/,
  );
  assert.deepEqual(
    db.prepare('SELECT status,assigned_to,current_execution_id FROM tasks WHERE id=1').get(),
    { status: 'in_progress', assigned_to: 'worker-1', current_execution_id: 'exec-1' },
  );
  assert.deepEqual(
    db.prepare('SELECT kanban_phase,loop_state,active_reservation_ref FROM factory_workplaces WHERE workplace_ref=?').get(workplaceRef),
    { kanban_phase: 'in_progress', loop_state: 'running', active_reservation_ref: 'exec-1' },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE command_kind='worker_done'").get().n,
    0,
  );

  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (1,'synthetic@1.0.0','cell-node',1,1,'exec-1',
             'factory.review-verdict.v1','{}','wrong-schema-product')`,
  ).run();
  assert.throws(
    () => handlers.worker_done({
      task_id: 1,
      worker_id: 'worker-1',
      execution_id: 'exec-1',
      result: 'wrong-schema completion claim',
    }),
    /PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH.*factory\.development-review-verdict\.v1.*factory\.review-verdict\.v1/,
  );
  assert.deepEqual(
    db.prepare('SELECT status,assigned_to,current_execution_id FROM tasks WHERE id=1').get(),
    { status: 'in_progress', assigned_to: 'worker-1', current_execution_id: 'exec-1' },
  );
  closeDb();
});

test('Development verification gate executes the v2 payload/lineage contract, not only the pass-through check', async () => {
  const { developmentProcessModule } = await import(
    '../../dist/process-modules/modules/development/development-process-module.js'
  );
  const node = developmentProcessModule.flow.nodes.find(
    candidate => candidate.id === 'verify-acceptance',
  );
  assert.equal(node?.kind, 'production-cell');
  const providerIds = node.cellDefinition.authorGate.checkPlan.entries
    .map(entry => entry.check.providerId);
  assert.ok(providerIds.includes('development.verification-product-contract.v2'));
  assert.ok(providerIds.includes('factory.product-contract.v1'));
  const productContract = node.cellDefinition.productContracts[0];
  assert.equal(
    productContract.payloadContract?.contractId,
    'development.verification-evidence-payload.v2',
  );
  const verificationEntry = node.cellDefinition.authorGate.checkPlan.entries
    .find(entry => entry.check.providerId === 'development.verification-product-contract.v2');
  assert.equal(verificationEntry?.repairTargetRoleOnIndeterminate, 'author');
  const readinessEntry = node.cellDefinition.authorGate.checkPlan.entries
    .find(entry => entry.check.providerId === 'factory.local-runnability.v1');
  assert.ok(readinessEntry, 'local runnability provider is mandatory');
  assert.equal(readinessEntry.failureOwnership, 'upstream');
  assert.equal(readinessEntry.repairTargetRoleOnFailure, undefined);
});
