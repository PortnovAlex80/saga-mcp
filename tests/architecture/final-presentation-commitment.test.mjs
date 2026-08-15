import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `saga-final-presentation-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = dbPath;
process.env.SAGA_MANAGED_EXECUTION = '1';

const { getDb, closeDb } = await import('../../dist/db.js');
const { handlers: productHandlers, _resetProductToolRepositoriesForTests } = await import('../../dist/tools/products.js');
const { registerProductPayloadContract, productPayloadContractDigest } = await import(
  '../../dist/process-modules/application/product-payload-contract.js'
);
const { buildExecutionContext } = await import('../../dist/shared/authority/build-execution-context.js');
const { executionContextHash } = await import('../../dist/shared/authority/execution-context.js');
const { SqliteManagedNodeSubmissionRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js'
);
const { recordFinalPresentationCommitment } = await import(
  '../../dist/infrastructure/workplace/sqlite-final-presentation-commitment.js'
);
const { finalizeManagedWorkerProcess } = await import(
  '../../dist/infrastructure/workers/worker-process-termination.js'
);

const schemaId = 'factory.test-final-presentation.v1';
const contractId = 'test.final-presentation.v1';
const version = '1.0.0';
const definition = { type: 'object', required: ['value'] };
const contractDigest = productPayloadContractDigest({ schemaId, contractId, version, definition });
registerProductPayloadContract({
  schemaId,
  contractId,
  version,
  definition,
  contractDigest,
  validate(payload) {
    return payload && typeof payload === 'object' && typeof payload.value === 'string'
      ? [] : ['value must be a string'];
  },
});

function seed(id) {
  const db = getDb();
  const executionId = `exec-${id}`;
  const workerId = `worker-${id}`;
  const workplaceRef = `workplace/${id}/solution-development@1.4.3/plan-task-graph/task-${id}`;
  db.prepare(`INSERT INTO projects (id,name) VALUES (?,?)`).run(id, `p-${id}`);
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (?,?,?)`).run(id, id, `e-${id}`);
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,?,?,'solution-development','1.4.3','solution-development@1.4.3',?,
             'generic-flow','factory.input.v1','{}',?,'paused')`,
  ).run(id, id, id, `run-${id}`, `input-${id}`);
  const authority = {
    enforcement: 'runtime',
    allowed_tools: ['product_submit', 'worker_done'],
    scope: workplaceRef,
    snapshot_ref: workplaceRef,
    payload_contract: { contractId, version, contractDigest },
  };
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status)
     VALUES (?,?,?,?,?,?,'executing')`,
  ).run(id, id, 'development.plan-task-graph', 'plan', JSON.stringify(authority), schemaId);
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,active_reservation_ref)
     VALUES (?,?,'solution-development@1.4.3','development-plan-task-graph','item',
             'in_progress','running','author',2,?)`,
  ).run(workplaceRef, id, executionId);
  const metadata = {
    process_run_id: id,
    process_module_ref: 'solution-development@1.4.3',
    process_node_id: 'plan-task-graph',
    process_input_hash: `input-${id}`,
    production_cell_id: 'development-plan-task-graph',
    work_intent_id: id,
  };
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,assigned_to,current_execution_id,workplace_ref,
        task_kind,execution_mode,metadata)
     VALUES (?,?,?,'in_progress',?,?,?,'development.plan-task-graph','tracker_only',?)`,
  ).run(id, id, 'plan', workerId, executionId, workplaceRef, JSON.stringify(metadata));
  const intent = db.prepare('SELECT * FROM factory_work_intents WHERE id=?').get(id);
  const executionContext = buildExecutionContext({
    modelRoute: { provider: 'test', model: 'test', effort: 'low' },
    workIntent: { ...intent, authority_scope: JSON.parse(intent.authority_scope) },
    capturedAt: new Date().toISOString(),
  });
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES (?,?,?,?,?,?,?,'test','running','executing',?)`,
  ).run(executionId, `dispatch-${id}`, id, id, id, workerId, 'machine', JSON.stringify({
    execution_context: executionContext,
    execution_context_hash: executionContextHash(executionContext),
  }));
  process.env.SAGA_EXECUTION_ID = executionId;
  process.env.SAGA_TASK_ID = String(id);
  return { db, executionId, workerId, workplaceRef };
}

test('typed product_submit atomically commits and closes the final presentation', () => {
  const { db, executionId, workplaceRef } = seed(1);
  _resetProductToolRepositoriesForTests();
  const reply = productHandlers.product_submit({ schema: schemaId, content: { value: 'ready' } });
  assert.equal(reply.accepted, true);
  assert.equal(reply.stop, true);
  assert.match(reply.presentation_commitment_ref, /^final-presentation:/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_final_presentation_commitments').get().n, 1);
  assert.equal(db.prepare(
    `SELECT COUNT(*) AS n FROM factory_transition_obligations
      WHERE source_kind='final-presentation-committed' AND handoff_kind='close-presentation'`,
  ).get().n, 1);
  assert.equal(db.prepare(
    `SELECT COUNT(*) AS n FROM command_receipts
      WHERE execution_id=? AND command_kind='presentation_close' AND accepted=1`,
  ).get(executionId).n, 1);
  assert.equal(db.prepare(
    `SELECT COUNT(*) AS n FROM command_receipts WHERE command_kind='worker_done'`,
  ).get().n, 0);
  assert.deepEqual(
    db.prepare('SELECT status,assigned_to FROM tasks WHERE id=1').get(),
    { status: 'in_progress', assigned_to: null },
  );
  assert.deepEqual(
    db.prepare('SELECT loop_state,active_reservation_ref FROM factory_workplaces WHERE workplace_ref=?').get(workplaceRef),
    { loop_state: 'verifying', active_reservation_ref: executionId },
  );
});

test('terminal observation redrives a committed product without another LM execution', () => {
  const { db, executionId } = seed(2);
  const repo = new SqliteManagedNodeSubmissionRepository(db);
  const tx = db.transaction(() => {
    const submitted = repo.submitForCurrentExecution({ schema: schemaId, payload: { value: 'crash-window' } });
    return recordFinalPresentationCommitment(db, {
      taskId: 2,
      executionId,
      productSchema: schemaId,
      productRef: submitted.record.artifactRef,
      productDigest: submitted.record.contentHash,
    });
  });
  const commitment = tx.immediate();
  assert.ok(commitment);
  // This execution is deliberately still open across the simulated crash window.
  assert.equal(db.prepare(
    `SELECT COUNT(*) AS n FROM command_receipts
      WHERE execution_id=? AND command_kind='presentation_close'`,
  ).get(executionId).n, 0);
  const result = finalizeManagedWorkerProcess(db, {
    taskId: 2,
    executionId,
    exitCode: 1,
    reason: 'provider timeout after accepted product',
  });
  assert.equal(result.semanticCompletion, true);
  assert.equal(result.workplaceRepairRequested, false);
  assert.equal(db.prepare(
    `SELECT COUNT(*) AS n FROM command_receipts
      WHERE execution_id=? AND command_kind='presentation_close' AND accepted=1`,
  ).get(executionId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM worker_executions WHERE task_id=2').get().n, 1);
});

test('payload rejection creates neither commitment nor close obligation', () => {
  const { db, executionId } = seed(3);
  _resetProductToolRepositoriesForTests();
  assert.throws(
    () => productHandlers.product_submit({ schema: schemaId, content: { value: 7 } }),
    /PRODUCT_PAYLOAD_CONTRACT_REJECTED/,
  );
  assert.equal(db.prepare(
    `SELECT COUNT(*) AS n FROM factory_final_presentation_commitments
      WHERE execution_id=?`,
  ).get(executionId).n, 0);
  assert.equal(db.prepare(
    `SELECT COUNT(*) AS n FROM factory_transition_obligations o
      WHERE o.source_kind='final-presentation-committed'
        AND NOT EXISTS (
          SELECT 1 FROM factory_final_presentation_commitments c
           WHERE c.commitment_ref=o.source_ref
        )`,
  ).get().n, 0);
  assert.deepEqual(
    db.prepare('SELECT status,assigned_to,current_execution_id FROM tasks WHERE id=3').get(),
    { status: 'in_progress', assigned_to: 'worker-3', current_execution_id: executionId },
  );
});

test.after(() => closeDb());
