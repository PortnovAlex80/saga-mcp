// tests/app/operator-soft-stop-migration.test.mjs
//
// Schema v12 → v13 migration (operator SOFT-STOP) on a temp database:
//
//   1. A DB stamped user_version=12 whose worker_executions table predates the
//      soft-stop columns opens through getDb() and receives the additive
//      columns (stop_fence INTEGER NOT NULL DEFAULT 0, voided_at TEXT NULL).
//   2. The two new audit tables (factory_worker_stops, factory_operator_holds)
//      exist with their CHECK constraints.
//   3. The DB is stamped user_version=13 and reopens cleanly (idempotent).
//
// Runs in its own test file: getDb() caches one connection per process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { closeDb, getDb } from '../../dist/db.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-softstop-mig-'));
const dbPath = path.join(temp, 'v12.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

test('v12 DB gains the soft-stop columns, tables and version stamp via getDb()', () => {
  // Build a pre-v13 database: the OLD worker_executions shape (no stop_fence,
  // no voided_at) plus the v12 version stamp.
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'active', tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE worker_executions (
      execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id INTEGER NOT NULL,
      epic_id INTEGER NOT NULL, task_id INTEGER NOT NULL, worker_id TEXT NOT NULL,
      machine_id TEXT NOT NULL, launcher TEXT NOT NULL DEFAULT 'claude_cli',
      state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved','running','cancel_requested','exited','spawn_failed','lost','terminated')),
      phase TEXT NOT NULL DEFAULT 'executing'
        CHECK (phase IN ('executing','reviewing','finishing','integrating')),
      pid INTEGER, process_birth_token TEXT, log_path TEXT,
      reserved_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT,
      phase_updated_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
      exit_code INTEGER, last_error TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      lease_expires_at TEXT, heartbeat_at TEXT, progress_at TEXT,
      suspected_stuck_at TEXT, cancel_requested_at TEXT,
      stuck_state TEXT NOT NULL DEFAULT 'active'
    );
  `);
  raw.prepare("INSERT INTO projects (id,name) VALUES (1,'legacy')").run();
  raw.prepare(
    `INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state)
     VALUES ('exec-legacy','r',1,1,1,'w','m','running')`,
  ).run();
  raw.pragma('user_version = 12');
  raw.close();

  // getDb() must migrate additively: SCHEMA_SQL for the new tables, the
  // ensure-column helper for worker_executions, and the v13 stamp.
  process.env.DB_PATH = dbPath;
  const db = getDb();

  const columns = db.prepare('PRAGMA table_info(worker_executions)').all().map(column => column.name);
  assert.ok(columns.includes('stop_fence'), 'stop_fence column added');
  assert.ok(columns.includes('voided_at'), 'voided_at column added');

  const legacy = db.prepare('SELECT stop_fence, voided_at, state FROM worker_executions WHERE execution_id=?')
    .get('exec-legacy');
  assert.equal(legacy.stop_fence, 0, 'stop_fence defaults to 0 — no row reset');
  assert.equal(legacy.voided_at, null, 'voided_at defaults to NULL — no row reset');
  assert.equal(legacy.state, 'running', 'existing state CHECK untouched');

  assert.ok(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_worker_stops'",
  ).get());
  assert.ok(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_operator_holds'",
  ).get());

  // CHECK constraints live: an illegal phase cannot persist.
  assert.throws(() => db.prepare(
    `INSERT INTO factory_worker_stops
       (stop_ref, worker_execution_ref, workplace_ref, project_id, reason, phase)
     VALUES ('s1','exec-legacy',NULL,1,'r','nonsense-phase')`,
  ).run());

  // Version stamped to 13.
  assert.equal(db.pragma('user_version', { simple: true }), 13);

  // Idempotent: closing and reopening a now-v13 DB is a clean no-op.
  closeDb();
  const reopened = getDb();
  assert.equal(reopened.pragma('user_version', { simple: true }), 13);
  const columnsAfter = reopened.prepare('PRAGMA table_info(worker_executions)').all().map(column => column.name);
  assert.ok(columnsAfter.includes('stop_fence') && columnsAfter.includes('voided_at'));
});
