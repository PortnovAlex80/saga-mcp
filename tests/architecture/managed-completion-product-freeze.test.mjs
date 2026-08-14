import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const dbPath = path.join(
  os.tmpdir(),
  `saga-managed-completion-freeze-${process.pid}-${Date.now()}.sqlite`,
);
process.env.DB_PATH = dbPath;

const { getDb, closeDb } = await import('../../dist/db.js');
const { buildExecutionContext } = await import(
  '../../dist/shared/authority/build-execution-context.js'
);
const { executionContextHash } = await import(
  '../../dist/shared/authority/execution-context.js'
);
const { authorizeSagaToolCall } = await import(
  '../../dist/shared/authority/authorize-tool-call.js'
);
const {
  freezeManagedCompletionProduct,
  readManagedCompletionProducts,
} = await import(
  '../../dist/infrastructure/workplace/sqlite-managed-completion-product.js'
);
const { ensureManagedProductionLedgerSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js'
);
const { SqliteProcessProductRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-product-repository.js'
);
const { SqliteWorkplaceProductAdapter } = await import(
  '../../dist/process-modules/persistence/sqlite-workplace-product-adapter.js'
);

function seedManagedExecution(db) {
  ensureManagedProductionLedgerSchema(db);
  new SqliteProcessProductRepository(db);
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (1,1,'synthetic','1.0.0','synthetic@1.0.0','run-1','generic-flow',
             'factory.synthetic-input.v1','{}','input-hash','running')`,
  ).run();
  const authorityScope = {
    enforcement: 'runtime',
    allowed_tools: ['artifact_create', 'trace_add', 'worker_done'],
    scope: 'workplace:synthetic',
    snapshot_ref: 'snapshot:synthetic',
  };
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status)
     VALUES (1,1,'synthetic.author','produce',?,
             'factory.synthetic-bundle.v1','executing')`,
  ).run(JSON.stringify(authorityScope));
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
    `UPDATE factory_work_intents SET projected_task_id=1 WHERE id=1`,
  ).run();
  const intent = db.prepare('SELECT * FROM factory_work_intents WHERE id=1').get();
  const executionContext = buildExecutionContext({
    modelRoute: { provider: 'test', model: 'test', effort: 'low' },
    workIntent: {
      ...intent,
      authority_scope: JSON.parse(intent.authority_scope),
    },
    capturedAt: new Date().toISOString(),
  });
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES ('exec-1','dispatch-1',1,1,1,'worker-1','machine','test',
             'running','executing',?)`,
  ).run(JSON.stringify({
    execution_context: executionContext,
    execution_context_hash: executionContextHash(executionContext),
  }));
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        artifact_id,artifact_type,artifact_status,content_hash,operation)
     VALUES (1,'synthetic@1.0.0','cell-node',1,1,'exec-1',
             10,'SPEC','draft','hash-before','create')`,
  ).run();
}

test('accepted completion freezes managed material and closes later tool authority', () => {
  const db = getDb();
  seedManagedExecution(db);

  const product = db.transaction(() => freezeManagedCompletionProduct(db, {
    executionId: 'exec-1',
    workerDoneCommandId: 'exec-1:worker-done:approved',
  }))();
  assert.ok(product);
  assert.deepEqual(readManagedCompletionProducts(db, 'exec-1'), [product]);

  db.prepare(
    `INSERT INTO command_receipts
       (command_id,command_kind,actor_kind,execution_id,task_id,payload_hash,
        accepted,result_json,reply_json)
     VALUES ('exec-1:worker-done:approved','worker_done','managed_execution',
             'exec-1',1,'payload',1,'{}','{}')`,
  ).run();
  const denied = authorizeSagaToolCall({
    toolName: 'artifact_create',
    db,
    executionId: 'exec-1',
    managedExecution: '1',
    taskId: '1',
    workerId: 'worker-1',
  });
  assert.equal(denied.allow, false);
  assert.equal(denied.code, 'AUTHORITY_DENIED');
  assert.deepEqual(denied.details.allowed_tools, ['worker_done']);

  // Fault injection below the gateway: even if a late ledger row appears,
  // the completion ProductRef and its sealed payload cannot float.
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        artifact_id,artifact_type,artifact_status,content_hash,operation)
     VALUES (1,'synthetic@1.0.0','cell-node',1,1,'exec-1',
             11,'SPEC','draft','hash-after','create')`,
  ).run();
  assert.deepEqual(readManagedCompletionProducts(db, 'exec-1'), [product]);
  const stored = new SqliteWorkplaceProductAdapter(db).readProduct(product);
  assert.equal(stored.content.artifacts.length, 1);
  assert.equal(stored.content.artifacts[0].artifactId, 10);

  assert.throws(
    () => freezeManagedCompletionProduct(db, {
      executionId: 'exec-1',
      workerDoneCommandId: 'different-command',
    }),
    /MANAGED_COMPLETION_PRODUCT_REPLAY_MISMATCH/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE factory_execution_completion_products SET product_digest='tampered'
        WHERE execution_id='exec-1'`,
    ).run(),
    /FACTORY_COMPLETION_PRODUCT_IMMUTABLE/,
  );
  closeDb();
});

test('worker_done freezes before transition and seal-time reads only the frozen product', () => {
  const dispatcher = readFileSync(
    new URL('../../src/tools/dispatcher.ts', import.meta.url),
    'utf8',
  );
  const freezeAt = dispatcher.indexOf('freezeManagedCompletionProduct(db, {');
  const transitionAt = dispatcher.indexOf("let newStatus: 'review' | 'done' | 'todo' | 'blocked';");
  assert.ok(freezeAt > 0 && transitionAt > freezeAt);

  const runtime = readFileSync(
    new URL('../../src/app/product-lifecycle-runtime.ts', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /readManagedCompletionProducts\(db, contributorRef\)/);
  assert.doesNotMatch(
    runtime.slice(runtime.indexOf("if (ingress.mode === 'managed-workplace')"), runtime.indexOf("if (ingress.mode === 'managed-workplace')") + 900),
    /WorkplaceProductionResolver|\.read\(workplaceRef\)/,
  );
});
