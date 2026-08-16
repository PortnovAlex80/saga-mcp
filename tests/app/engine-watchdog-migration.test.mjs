// tests/app/engine-watchdog-migration.test.mjs
//
// Schema v13 → v14 migration (antifreeze layer C) on a temp database:
//
//   1. A DB stamped user_version=13 whose lifecycle_execution_controls carries
//      the OLD engine_state CHECK (no 'failed_watchdog', no last_error) and
//      whose factory_launch_requests predates the engine marker columns opens
//      through getDb() and receives the additive columns + the widened CHECK
//      with every existing row preserved.
//   2. The factory_engine_watchdog_events audit table exists with its CHECK.
//   3. The DB is stamped user_version=14 and reopens cleanly (idempotent).
//
// Runs in its own test file: getDb() caches one connection per process
// (same isolation pattern as operator-soft-stop-migration.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { closeDb, getDb } from '../../dist/db.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-watchdog-mig-'));
const dbPath = path.join(temp, 'v13.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

test('v13 DB gains engine marker columns, watchdog table, widened CHECK and version 14', () => {
  // Build a pre-v14 database: the OLD lifecycle_execution_controls shape
  // (engine_state CHECK without 'failed_watchdog', no last_error) and a
  // factory_launch_requests without the engine host binding columns.
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
    CREATE TABLE epics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, description TEXT, branch TEXT, status TEXT NOT NULL DEFAULT 'planned',
      priority TEXT NOT NULL DEFAULT 'medium', sort_order INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_orders (
      order_ref TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      epic_id INTEGER NOT NULL REFERENCES epics(id),
      source_kind TEXT NOT NULL DEFAULT 'idea_url', state TEXT NOT NULL DEFAULT 'provisioned',
      source_url TEXT, source_final_url TEXT, source_media_type TEXT,
      source_digest TEXT, source_body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT, lifecycle_run_id INTEGER
    );
    CREATE TABLE factory_launch_requests (
      launch_ref TEXT PRIMARY KEY,
      order_ref TEXT NOT NULL REFERENCES factory_orders(order_ref),
      mode TEXT NOT NULL CHECK (mode IN ('new','resume')),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      epic_id INTEGER NOT NULL REFERENCES epics(id),
      initiated_by TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 10),
      state TEXT NOT NULL CHECK (state IN ('requested','claimed','running','paused','completed','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE lifecycle_execution_controls (
      epic_id INTEGER PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
      engine_state TEXT NOT NULL DEFAULT 'stopped'
        CHECK (engine_state IN ('running','stopped','unknown')),
      engine_pid INTEGER,
      concurrency INTEGER,
      started_at TEXT,
      stopped_at TEXT,
      concurrency_changed_at TEXT,
      model_provider TEXT,
      model_name TEXT,
      model_effort TEXT,
      model_concurrency_limit INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  raw.prepare("INSERT INTO projects (id,name) VALUES (1,'legacy')").run();
  raw.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'legacy-epic')").run();
  raw.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES ('ord-legacy',1,1,'idea_url','paused')`,
  ).run();
  raw.prepare(
    `INSERT INTO factory_launch_requests
       (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state)
     VALUES ('launch-legacy','ord-legacy','resume',1,1,'legacy','idem-legacy',2,'running')`,
  ).run();
  raw.prepare(
    `INSERT INTO lifecycle_execution_controls (epic_id,engine_state,engine_pid,concurrency)
     VALUES (1,'running',4242,4)`,
  ).run();
  raw.pragma('user_version = 13');
  raw.close();

  process.env.DB_PATH = dbPath;
  const db = getDb();

  // Additive: launch marker columns present, legacy row intact (no reset).
  const launchColumns = db.prepare('PRAGMA table_info(factory_launch_requests)').all()
    .map(column => column.name);
  assert.ok(launchColumns.includes('engine_log_path'), 'engine_log_path added');
  assert.ok(launchColumns.includes('engine_pid'), 'engine_pid added');
  assert.ok(launchColumns.includes('engine_spawned_at'), 'engine_spawned_at added');
  const legacyLaunch = db.prepare(
    'SELECT state, engine_log_path, engine_pid FROM factory_launch_requests WHERE launch_ref=?',
  ).get('launch-legacy');
  assert.equal(legacyLaunch.state, 'running', 'existing launch row untouched');
  assert.equal(legacyLaunch.engine_log_path, null, 'pre-v14 launch stays LEGACY (NULL markers)');
  assert.equal(legacyLaunch.engine_pid, null);

  // Additive: last_error column present, legacy control row preserved.
  const controlColumns = db.prepare('PRAGMA table_info(lifecycle_execution_controls)').all()
    .map(column => column.name);
  assert.ok(controlColumns.includes('last_error'), 'last_error added');
  const legacyControl = db.prepare(
    'SELECT engine_state, engine_pid, concurrency, last_error FROM lifecycle_execution_controls WHERE epic_id=1',
  ).get();
  assert.equal(legacyControl.engine_state, 'running', 'control row preserved through rebuild');
  assert.equal(legacyControl.engine_pid, 4242);
  assert.equal(legacyControl.concurrency, 4);
  assert.equal(legacyControl.last_error, null);

  // Widened CHECK is live: 'failed_watchdog' persists, the old value space too.
  db.prepare(
    "UPDATE lifecycle_execution_controls SET engine_state='failed_watchdog', last_error=? WHERE epic_id=1",
  ).run('engine watchdog: restart budget exhausted (5 attempts / 2h)');
  assert.equal(
    db.prepare('SELECT engine_state FROM lifecycle_execution_controls WHERE epic_id=1').get().engine_state,
    'failed_watchdog',
  );

  // Audit table exists with its CHECK constraint live.
  assert.ok(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_engine_watchdog_events'",
  ).get());
  assert.throws(() => db.prepare(
    `INSERT INTO factory_engine_watchdog_events
       (event_ref, project_id, epic_id, launch_ref, kind, reason)
     VALUES ('w1', 1, 1, 'launch-legacy', 'nonsense-kind', 'r')`,
  ).run());

  // Version stamped to 14.
  assert.equal(db.pragma('user_version', { simple: true }), 14);

  // Idempotent: closing and reopening a now-v14 DB is a clean no-op.
  closeDb();
  const reopened = getDb();
  assert.equal(reopened.pragma('user_version', { simple: true }), 14);
  const reopenedControl = reopened.prepare(
    'SELECT engine_state, last_error FROM lifecycle_execution_controls WHERE epic_id=1',
  ).get();
  assert.equal(reopenedControl.engine_state, 'failed_watchdog', 'v14 state survives reopen');
});
