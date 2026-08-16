// tests/modules/formalization/formalization-snapshot-materializer.test.mjs
//
// GB-5 (option B): formalization bundle submissions must seal the
// factory-computed workplace production snapshot (managed ledger), not the
// worker's raw payload. "Factory computes the canonical digest" (ADR-053).

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const importAbs = p => import(pathToFileURL(path.resolve(REPO_ROOT, p)).href);

test('materializeFormalizationSnapshot: wrap, idempotence, pass-through, empty fail-closed', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gb5-mat-'));
  process.env.DB_PATH = path.join(dir, 'mat.db');
  const { getDb, closeDb } = await importAbs('dist/db.js');
  const db = getDb();
  const { ensureManagedProductionLedgerSchema } = await importAbs(
    'dist/process-modules/persistence/sqlite-managed-production-ledger.js',
  );
  ensureManagedProductionLedgerSchema(db);
  const { materializeFormalizationSnapshot } = await importAbs(
    'dist/modules/formalization/application/formalization-snapshot-materializer.js',
  );
  const { sha256Hex } = await importAbs('dist/shared/canonical-json.js');

  db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'mat','active')").run();
  db.prepare("INSERT INTO epics (id,project_id,name,status) VALUES (1,1,'E','planned')").run();
  const mkTask = (id, exec, wp) => db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,current_execution_id,workplace_ref,metadata)
     VALUES (? ,1,'T','in_progress',?,?,?)`,
  ).run(id, exec, wp, JSON.stringify({ process_run_id: 9, process_node_id: 'define-product-contract', process_module_ref: 'solution-formalization@1.0.0', process_input_hash: 'h', work_intent_id: 1, workplace_ref: wp }));
  const mkExec = (exec, taskId) => db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,task_id,project_id,epic_id,worker_id,machine_id,phase,state,reserved_at)
     VALUES (?,'dispatch-run:test',?,1,1,?,?,'executing','running',datetime('now'))`,
  ).run(exec, taskId, 'worker:' + exec, 'test-host');

  mkTask(1, 'worker-execution:t1', 'workplace/9/solution-formalization@1.0.0/formalization-product-contract/singleton');
  mkExec('worker-execution:t1', 1);
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,executor_kind,
        input_schema,input_snapshot,input_hash,status)
     VALUES (9,1,1,'solution-formalization','1.0.0','solution-formalization@1.0.0','k1','generic-flow',
             'factory.formalization-case.v1','{}','h','paused')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,artifact_id,
        artifact_type,artifact_status,content_hash,operation,recorded_at)
     VALUES (9,'solution-formalization@1.0.0','define-product-contract',1,1,
             'worker-execution:t1',2,'PRD','accepted','hash-a','upsert',datetime('now'))`,
  ).run();

  const env = { SAGA_MANAGED_EXECUTION: '1', SAGA_EXECUTION_ID: 'worker-execution:t1' };
  const raw = { artifacts: [{ artifact_id: 2, content_hash: 'hash-a' }] };

  const wrapped = materializeFormalizationSnapshot(db, 'factory.formalization-product-bundle.v1', raw, env);
  assert.equal(wrapped.schemaVersion, 'factory.workplace-production-snapshot.v3');
  assert.equal(wrapped.expectedSchemaRef, 'factory.formalization-product-bundle.v1');
  assert.equal(wrapped.workplaceRef, 'workplace/9/solution-formalization@1.0.0/formalization-product-contract/singleton');
  assert.equal(wrapped.artifacts.length, 1);
  assert.equal(wrapped.artifacts[0].artifactId, 2);
  assert.equal(wrapped.artifacts[0].contentHash, 'hash-a');
  assert.ok(sha256Hex(wrapped).length === 64);

  assert.equal(materializeFormalizationSnapshot(db, 'factory.formalization-product-bundle.v1', wrapped, env), wrapped);
  // GB-10: a worker-rolled snapshot-shaped payload WITHOUT canonical trace identity
  // must NOT pass through — it is rebuilt from the ledger.
  const handRolled = { ...wrapped, traces: wrapped.traces.map(({ traceId, traceHash, ...rest }) => rest) };
  const rebuilt = materializeFormalizationSnapshot(db, 'factory.formalization-product-bundle.v1', handRolled, env);
  assert.ok(Array.isArray(rebuilt.traces));
  assert.ok(rebuilt.traces.every(tr => Number.isSafeInteger(tr.traceId))); // fixture ledger has no traces → []
  assert.ok(rebuilt.schemaVersion === 'factory.workplace-production-snapshot.v3');

  assert.equal(materializeFormalizationSnapshot(db, 'factory.discovery-proposal.v1', raw, env), raw);
  assert.equal(materializeFormalizationSnapshot(db, 'factory.formalization-product-bundle.v1', raw, {}), raw);

  mkTask(2, 'worker-execution:t2', 'workplace/9/solution-formalization@1.0.0/formalization-use-cases/singleton');
  mkExec('worker-execution:t2', 2);
  assert.throws(
    () => materializeFormalizationSnapshot(db, 'factory.formalization-use-case-bundle.v1', {}, {
      SAGA_MANAGED_EXECUTION: '1', SAGA_EXECUTION_ID: 'worker-execution:t2',
    }),
    /FORMALIZATION_SNAPSHOT_EMPTY/,
  );

  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
