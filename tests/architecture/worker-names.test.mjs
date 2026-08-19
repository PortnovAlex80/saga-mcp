// tests/architecture/worker-names.test.mjs
//
// WORKER-NAMES-DESIGN.md — factory-floor worker callsigns (repair agent #7).
//
// RED-first suite pinning the design contract:
//   1. The four workshop pools hold EXACTLY the 28 names from the design.
//   2. stageFromModuleName maps factory_process_runs.module_name → workshop
//      (product-discovery / solution-formalization / solution-development /
//      documentation-release); delivery and unknown modules fall back to the
//      all-28 pool.
//   3. pickWorkerName: per-project uniqueness among LIVE executions
//      (reserved/running/cancel_requested), workshop pool first → all 28 →
//      deterministic suffix; a name is freed when its worker reaches a
//      terminal state; scoping is per-project (the same name may be live in
//      two different projects).
//   4. hashName: deterministic short legacy fallback for pre-display_name
//      rows (COALESCE(display_name, hashName(worker_id)) — zero migration).
//   5. Claim stamping: SqliteWorkAssignmentAdapter.assignTask writes
//      worker_executions.display_name inside the claim transaction while
//      execution_id / worker_id / tasks.current_execution_id stay UUID-based
//      (UUID remains the authority identifier everywhere — ADR-053; the name
//      is a human-visibility layer only).
//   6. Migration: ensureWorkerExecutionsDisplayName adds the column to a
//      legacy-shape DB (worker_executions WITHOUT display_name) without
//      touching existing rows, and a legacy NULL row reads back through the
//      hashName fallback.
//
// Hermetic: temp DB per suite; no factory engine, no spawns, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { closeDb, getDb } from '../../dist/db.js';
import { SCHEMA_SQL, ensureWorkerExecutionsDisplayName } from '../../dist/schema.js';
import {
  closeRuntimeDbCache,
  readExecutionDisplayName,
} from '../../dist/worker-executions.js';
import {
  WORKER_NAME_POOLS,
  ALL_WORKER_NAMES,
  stageFromModuleName,
  pickWorkerName,
  hashName,
} from '../../dist/worker-names.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { SqliteWorkAssignmentAdapter } from '../../dist/infrastructure/work/sqlite-work-assignment-adapter.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-wn-'));
process.env.DB_PATH = path.join(temp, 'wn.db');

test.after(() => {
  closeDb();
  closeRuntimeDbCache();
  rmSync(temp, { recursive: true, force: true });
});

function setupProject() {
  const p = projects.project_create({ name: `wn-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  const e = epics.epic_create({ project_id: p.id, name: 'WN epic' });
  return { projectId: p.id, epicId: e.id };
}

/** Stamp process_run_id onto a task's metadata — the saga4 authority gate. */
function stampProcessRun(taskId, processRunId, moduleName) {
  const db = getDb();
  const row = db.prepare(
    `SELECT t.metadata,t.epic_id,e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?`,
  ).get(taskId);
  db.prepare(
    `INSERT OR IGNORE INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
       executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    processRunId, row.project_id, row.epic_id,
    moduleName, '1.0.0', `${moduleName}@1.0.0`,
    `test-process:${processRunId}`, 'generic-flow', 'test.input.v1', '{}',
    'a'.repeat(64), 'running',
  );
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
  meta.process_run_id = processRunId;
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), taskId);
}

function makeTodoTask(epicId, overrides = {}) {
  return tasks.task_create({ epic_id: epicId, title: overrides.title ?? 'wn t', ...overrides });
}

function claimCard(projectId, taskId, workerNo, moduleName) {
  stampProcessRun(taskId, taskId, moduleName);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  return adapter.assignTask({
    projectId,
    workerId: `worker-uuid-${workerNo}`,
    workerExecutionId: `exec-uuid-${workerNo}-${taskId}`,
    runId: `run-${workerNo}`,
    machineId: 'test-machine',
  });
}

// ---------------------------------------------------------------------------
// 1. The pools are exactly the design's 28 callsigns.
// ---------------------------------------------------------------------------

test('pools: exactly the design table callsigns, grouped by workshop', () => {
  assert.deepEqual(WORKER_NAME_POOLS.discovery,
    ['Beacon', 'Compass', 'Gyro', 'Meridian', 'Probe', 'Transit', 'Zenith']);
  assert.deepEqual(WORKER_NAME_POOLS.formalization,
    ['Draft', 'Jig', 'Kernel', 'Origin', 'Ruler', 'Square', 'Vector']);
  assert.deepEqual(WORKER_NAME_POOLS.development,
    ['Anvil', 'Endmill', 'Forge', 'Hammer', 'Lathe', 'Union', 'Wrench']);
  assert.deepEqual(WORKER_NAME_POOLS.documentation,
    ['Index', 'Nib', 'Quill', 'Vellum', 'Binder', 'Ledger', 'Ream', 'Tome']);
  // The design table lists 7+7+7+8 = 29 callsigns (its prose says "28" while
  // also claiming 3-7 chars — Meridian/Endmill are 8; the TABLE is canon).
  assert.equal(ALL_WORKER_NAMES.length, 29);
  assert.equal(new Set(ALL_WORKER_NAMES).size, 29, 'all names must be unique');
  // Design property: 24 unique first letters across the pools.
  assert.equal(new Set(ALL_WORKER_NAMES.map(n => n[0])).size, 24);
});

// ---------------------------------------------------------------------------
// 2. Module name → workshop mapping.
// ---------------------------------------------------------------------------

test('stageFromModuleName maps factory process module names to workshops', () => {
  assert.equal(stageFromModuleName('product-discovery'), 'discovery');
  assert.equal(stageFromModuleName('solution-formalization'), 'formalization');
  assert.equal(stageFromModuleName('solution-development'), 'development');
  assert.equal(stageFromModuleName('documentation-release'), 'documentation');
  // No pool of its own → all-28 fallback, not a crash.
  assert.equal(stageFromModuleName('delivery-release'), null);
  assert.equal(stageFromModuleName('test-module'), null);
  assert.equal(stageFromModuleName(null), null);
  assert.equal(stageFromModuleName(undefined), null);
});

// ---------------------------------------------------------------------------
// 3. pickWorkerName — collision-free issuance, workshop-first, suffixes.
// ---------------------------------------------------------------------------

test('pickWorkerName: workshop pool first, unique among live workers, per project', () => {
  const db = getDb();
  const { projectId: p1 } = setupProject();
  const taken = new Set();
  for (let i = 0; i < 7; i += 1) {
    const name = pickWorkerName(db, p1, 'development');
    assert.ok(WORKER_NAME_POOLS.development.includes(name),
      `development claim #${i} must draw from the development pool, got '${name}'`);
    assert.ok(!taken.has(name), `duplicate live name '${name}' in project ${p1}`);
    taken.add(name);
    // Simulate a live execution holding the name.
    db.prepare(
      `INSERT INTO worker_executions
        (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,display_name)
       VALUES (?,?,?,?,?,?,?, 'running','executing',?)`,
    ).run(`exec-pick-${p1}-${i}`, `run-${i}`, p1, 1, 9000 + i, `w-${i}`, 'm', name);
  }
  // Pool exhausted → draws from the other workshops (all-28 fallback).
  const overflow = pickWorkerName(db, p1, 'development');
  assert.ok(!WORKER_NAME_POOLS.development.includes(overflow),
    'overflow claim must fall back to the other workshops');
  assert.ok(ALL_WORKER_NAMES.includes(overflow));

  // The same name IS available in a different project (per-project scoping).
  const { projectId: p2 } = setupProject();
  const other = pickWorkerName(db, p2, 'development');
  assert.ok(WORKER_NAME_POOLS.development.includes(other));
});

test('pickWorkerName: all 29 live → deterministic suffixed series', () => {
  const db = getDb();
  const { projectId } = setupProject();
  ALL_WORKER_NAMES.forEach((name, i) => {
    db.prepare(
      `INSERT INTO worker_executions
        (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,display_name)
       VALUES (?,?,?,?,?,?,?, 'running','executing',?)`,
    ).run(`exec-full-${projectId}-${name}`, 'r', projectId, 1, 9100 + i, `w-${name}`, 'm', name);
  });
  const suffixed = pickWorkerName(db, projectId, 'formalization');
  assert.match(suffixed, /^Beacon-2$/, 'first suffix must be deterministic (Beacon-2)');
});

test('pickWorkerName: terminal executions free their name (natural rotation)', () => {
  const db = getDb();
  const { projectId } = setupProject();
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,display_name)
     VALUES ('exec-dead-1','r',?,1,9200,'w-dead','m','exited','executing','Anvil')`,
  ).run(projectId);
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,display_name)
     VALUES ('exec-alive-1','r',?,1,9201,'w-alive','m','running','executing','Endmill')`,
  ).run(projectId);
  const name = pickWorkerName(db, projectId, 'development');
  assert.equal(name, 'Anvil', 'a dead worker\'s name is reusable; a live one is not');
});

// ---------------------------------------------------------------------------
// 4. hashName — deterministic legacy fallback.
// ---------------------------------------------------------------------------

test('hashName: deterministic, short, distinct per worker_id', () => {
  const a1 = hashName('0d9a6c8e-1111-4aaa-8bbb-000000000001');
  const a2 = hashName('0d9a6c8e-1111-4aaa-8bbb-000000000001');
  const b = hashName('0d9a6c8e-2222-4aaa-8bbb-000000000002');
  assert.equal(a1, a2, 'same UUID → same fallback name');
  assert.notEqual(a1, b, 'different UUIDs → different fallback names');
  assert.match(a1, /^W-[a-z0-9]{1,8}$/, 'fallback name is short and readable');
});

test('readExecutionDisplayName: claim row → callsign; legacy NULL row → hashName; missing → null', () => {
  const dbPath = path.join(temp, 'read-name.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,display_name)
     VALUES ('exec-named','r',1,1,1,'w1','m','running','executing','Forge')`,
  ).run();
  db.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES ('exec-legacy','r',1,1,2,'w2','m','running','executing')`,
  ).run();
  db.close();

  assert.equal(readExecutionDisplayName(dbPath, 'exec-named'), 'Forge');
  assert.equal(readExecutionDisplayName(dbPath, 'exec-legacy'), hashName('w2'));
  assert.equal(readExecutionDisplayName(dbPath, 'exec-missing'), null);
  rmSync(dbPath, { force: true });
});

// ---------------------------------------------------------------------------
// 5. Claim stamping — the name lands inside the claim transaction; the UUID
//    identifiers keep their authority role untouched.
// ---------------------------------------------------------------------------

test('claim: assignTask stamps worker_executions.display_name; UUIDs stay the authority', () => {
  const { projectId, epicId } = setupProject();
  const t1 = makeTodoTask(epicId, { title: 'claim-a' });
  const t2 = makeTodoTask(epicId, { title: 'claim-b' });

  const work1 = claimCard(projectId, t1.id, 1, 'solution-development');
  assert.ok(work1, 'first claim must succeed');
  const work2 = claimCard(projectId, t2.id, 2, 'solution-development');
  assert.ok(work2, 'second claim must succeed');

  const db = getDb();
  const rows = db.prepare(
    `SELECT execution_id, worker_id, display_name, state
       FROM worker_executions WHERE task_id IN (?,?) ORDER BY task_id`,
  ).all(t1.id, t2.id);

  assert.equal(rows.length, 2);
  const names = rows.map(r => r.display_name);
  assert.ok(names.every(n => typeof n === 'string' && n.length > 0),
    `both claims must stamp a display_name, got ${JSON.stringify(names)}`);
  assert.notEqual(names[0], names[1], 'two live workers must never share a name');
  assert.ok(WORKER_NAME_POOLS.development.includes(names[0])
    || WORKER_NAME_POOLS.development.includes(names[1]),
    'solution-development claims draw from the forge pool');

  // UUID authority untouched: identifiers, fences and task projection stay as-is.
  for (const r of rows) {
    assert.match(r.execution_id, /^exec-uuid-/, 'execution_id stays the claim-issued id');
    assert.match(r.worker_id, /^worker-uuid-/, 'worker_id stays the claim-issued id');
    assert.equal(r.state, 'reserved');
  }
  const task1 = db.prepare('SELECT assigned_to, current_execution_id FROM tasks WHERE id=?').get(t1.id);
  assert.equal(task1.assigned_to, 'worker-uuid-1');
  assert.equal(task1.current_execution_id, 'exec-uuid-1-' + t1.id);
});

test('claim: workshop routing — discovery module draws navigation names', () => {
  const { projectId, epicId } = setupProject();
  const t = makeTodoTask(epicId, { title: 'claim-disc' });
  const work = claimCard(projectId, t.id, 3, 'product-discovery');
  assert.ok(work);
  const row = getDb().prepare(
    'SELECT display_name FROM worker_executions WHERE task_id=?',
  ).get(t.id);
  assert.ok(WORKER_NAME_POOLS.discovery.includes(row.display_name),
    `discovery claim must use a navigation name, got '${row.display_name}'`);
});

// ---------------------------------------------------------------------------
// 6. Migration — legacy DBs (no display_name column) upgrade in place.
// ---------------------------------------------------------------------------

test('migration: ensureWorkerExecutionsDisplayName adds the column to a legacy DB without data loss', () => {
  const legacyPath = path.join(temp, 'legacy.db');
  const legacy = new Database(legacyPath);
  legacy.pragma('foreign_keys = ON');
  // Pre-column worker_executions shape (v15): the columns the ensure helper
  // and pickWorkerName touch, minus display_name. Built by hand so the ALTER
  // path is exercised for real (SCHEMA_SQL of the CURRENT code would already
  // carry the column on a fresh DB — that is the other half of the contract).
  legacy.exec(`
    CREATE TABLE worker_executions (
      execution_id    TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      project_id      INTEGER NOT NULL,
      epic_id         INTEGER NOT NULL,
      task_id         INTEGER NOT NULL,
      worker_id       TEXT NOT NULL,
      machine_id      TEXT NOT NULL,
      launcher        TEXT NOT NULL DEFAULT 'claude_cli',
      state           TEXT NOT NULL DEFAULT 'reserved',
      phase           TEXT NOT NULL,
      reserved_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacy.prepare(
    `INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES ('legacy-exec-1','r',1,1,1,'legacy-worker-uuid','m','running','executing')`,
  ).run();

  ensureWorkerExecutionsDisplayName(legacy);
  ensureWorkerExecutionsDisplayName(legacy); // idempotent

  const after = legacy.prepare('PRAGMA table_info(worker_executions)').all().map(c => c.name);
  assert.ok(after.includes('display_name'), 'column must exist after ensure');
  const row = legacy.prepare(
    'SELECT execution_id, worker_id, display_name FROM worker_executions WHERE execution_id=?',
  ).get('legacy-exec-1');
  assert.equal(row.execution_id, 'legacy-exec-1', 'existing row survives');
  assert.equal(row.worker_id, 'legacy-worker-uuid');
  assert.equal(row.display_name, null, 'legacy row keeps NULL — read via COALESCE fallback');

  // The legacy row reads back through the hashName fallback.
  assert.equal(
    row.display_name ?? hashName(row.worker_id),
    hashName('legacy-worker-uuid'),
  );

  // Claim on the migrated DB stamps a name (fresh pool; project 1 has no live names).
  const name = pickWorkerName(legacy, 1, 'formalization');
  assert.ok(WORKER_NAME_POOLS.formalization.includes(name));
  legacy.close();
  rmSync(legacyPath, { force: true });
});
