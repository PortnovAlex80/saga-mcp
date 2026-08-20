// tests/factory/trace-delete-managed-ledger-mirror.test.mjs
//
// Stage-20 elite post-mortem regression. The elite run died terminally with
// REPLAY_CAPTURE_TRACE_NOT_FOUND (expected 35, resolved 29) after a worker
// LAWFULLY deleted six traces during in-cell repair: handleTraceDelete
// removed the live artifact_traces row but left factory_managed_trace_
// productions (the ledger that feeds every FUTURE WorkplaceProductionSnapshot
// seal) untouched. The re-sealed snapshot then froze dead tuples and the
// fail-closed replay certification killed the lifecycle.
//
// The fix: trace_delete mirrors the delete into the managed trace ledger in
// the same transaction. These tests prove both authorities stay consistent
// through add → delete → re-add, driven through the REAL tool handlers with
// a live managed-execution provenance (the exact production write path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_DIR = mkdtempSync(path.join(tmpdir(), 'trace-delete-mirror-'));
const EXEC = 'worker-execution:cccccccc-0000-0000-0000-000000000003';
process.env.DB_PATH = path.join(DB_DIR, 'test.sqlite');
process.env.SAGA_MANAGED_EXECUTION = '1';
process.env.SAGA_EXECUTION_ID = EXEC;
process.env.SAGA_TASK_ID = '3';

const dbMod = await import(pathToFileURL(path.resolve(ROOT, 'dist/db.js')).href);
const schemaMod = await import(pathToFileURL(path.resolve(ROOT, 'dist/schema.js')).href);
const ledgerMod = await import(
  pathToFileURL(path.resolve(ROOT, 'dist/process-modules/persistence/sqlite-managed-production-ledger.js')).href
);
const artifactsMod = await import(pathToFileURL(path.resolve(ROOT, 'dist/tools/artifacts.js')).href);

const MODULE_REF = 'solution-formalization@1.0.0';
const PROCESS_RUN_ID = 2;

function seedPlain(db) {
  db.exec(schemaMod.SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (id, name, status) VALUES (1, 'test', 'active')`).run();
  db.prepare(`INSERT INTO epics (id, project_id, name, status, priority) VALUES (1, 1, 'REQ-001', 'planned', 'high')`).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, epic_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash,
        projected_stage, status)
     VALUES (2, 1, 1, 'solution-formalization', '1.0.0', ?,
             'key', 'generic-flow', 'factory.formalization-case.v1', '{}', 'hash',
             'formalization', 'running')`,
  ).run(MODULE_REF);
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, current_execution_id, metadata)
     VALUES (3, 1, 'author', 'in_progress', ?, ?)`,
  ).run(EXEC, JSON.stringify({
    process_run_id: PROCESS_RUN_ID,
    process_node_id: 'define-acceptance-contract',
    process_module_ref: MODULE_REF,
    process_input_hash: 'hash',
    work_intent_id: 1,
  }));
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
        launcher, state, phase, reserved_at, started_at)
     VALUES (?, 'run-1', 1, 1, 3, 'w', 'm', 'test', 'running', 'executing',
             datetime('now'), datetime('now'))`,
  ).run(EXEC);
  for (const [id, type, code] of [[14, 'FR', 'FR-1'], [5, 'RULE', 'RULE-1']]) {
    db.prepare(
      `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status)
       VALUES (?, 1, 1, ?, ?, ?, 'docs/x.md', 'accepted')`,
    ).run(id, type, code, code);
  }
  ledgerMod.ensureManagedProductionLedgerSchema(db);
}

const ledgerCount = db => (db.prepare(
  `SELECT COUNT(*) AS n FROM factory_managed_trace_productions
    WHERE source_id=14 AND target_type='artifact' AND target_id=5 AND link_type='derived_from'`,
).get().n);
const liveCount = db => (db.prepare(
  `SELECT COUNT(*) AS n FROM artifact_traces
    WHERE source_id=14 AND target_type='artifact' AND target_id=5 AND link_type='derived_from'`,
).get().n);

test('trace_delete mirrors into the managed trace ledger (stage-20 elite post-mortem)', () => {
  const db = dbMod.getDb();
  seedPlain(db);
  const add = artifactsMod.handlers.trace_add({
    source_id: 14, target_type: 'artifact', target_id: 5, link_type: 'derived_from',
  });
  assert.ok(add.id > 0, 'trace_add must create the live trace');
  assert.equal(liveCount(db), 1);
  assert.equal(ledgerCount(db), 1, 'trace_add must append the managed ledger row');

  const res = artifactsMod.handlers.trace_delete({
    source_id: 14, target_type: 'artifact', target_id: 5, link_type: 'derived_from',
  });
  assert.equal(res.deleted, true);
  assert.equal(liveCount(db), 0);
  assert.equal(
    ledgerCount(db), 0,
    'the managed ledger must mirror the live delete — otherwise the next seal freezes '
    + 'a dead tuple and replay certification fails the lifecycle terminally',
  );
});

test('deleting a trace that no longer exists touches no ledger rows', () => {
  const db = dbMod.getDb();
  const res = artifactsMod.handlers.trace_delete({
    source_id: 14, target_type: 'artifact', target_id: 5, link_type: 'derived_from',
  });
  assert.equal(res.deleted, false);
  assert.equal(ledgerCount(db), 0);
});

test('re-add after delete restores both authorities consistently', () => {
  const db = dbMod.getDb();
  const readd = artifactsMod.handlers.trace_add({
    source_id: 14, target_type: 'artifact', target_id: 5, link_type: 'derived_from',
  });
  assert.equal(liveCount(db), 1);
  assert.equal(ledgerCount(db), 1);
  const ledgerRow = db.prepare(
    `SELECT trace_id FROM factory_managed_trace_productions
      WHERE source_id=14 AND target_type='artifact' AND target_id=5 AND link_type='derived_from'`,
  ).get();
  assert.equal(ledgerRow.trace_id, readd.id, 'the ledger must point at the CURRENT live trace row');
});
