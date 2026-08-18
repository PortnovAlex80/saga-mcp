// tests/app/engine-watchdog-migration.test.mjs
//
// POST-PURGE migration contract (the ladder was removed in the
// pre-production purge; K15-era schema history): a database is either
// FRESH (user_version 0 -> schema applied -> stamped current) or EXACTLY
// CURRENT. A DB stamped with an OLDER schema version fails closed at
// getDb() with the typed FACTORY_SCHEMA_MIGRATION_UNSUPPORTED error —
// never a partial in-place upgrade, never a silent reopen.
//
// This file preserves the v13 legacy SHAPE below as a fixture of record
// (the pre-v14 lifecycle_execution_controls / factory_launch_requests)
// and pins the fail-closed behavior against it: the open is refused, the
// connection is released (getDb's cache is not poisoned), and the file is
// left exactly as it was — stamped 13, un-mutated.
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
  try { closeDb(); } catch { /* never opened successfully */ }
  rmSync(temp, { recursive: true, force: true });
});

test('a v13 DB fails closed at open — no ladder, no partial upgrade, no mutation', () => {
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
  // The post-purge contract: refuse, typed, naming both versions and the
  // operator's two remedies.
  assert.throws(
    () => getDb(),
    /FACTORY_SCHEMA_MIGRATION_UNSUPPORTED: 13->\d+\./u,
    'a pre-purge database fails closed at open — no ladder runs',
  );

  // The refused open must not poison the cached connection: pointing
  // DB_PATH at a FRESH database afterwards opens cleanly and stamps current.
  const freshPath = path.join(temp, 'fresh.db');
  process.env.DB_PATH = freshPath;
  const fresh = getDb();
  const stamped = fresh.pragma('user_version', { simple: true });
  assert.ok(stamped > 13, `a fresh DB stamps the current schema version (got ${stamped})`);
  closeDb();

  // The refused v13 file is untouched: still stamped 13, still its legacy shape.
  const verify = new Database(dbPath);
  assert.equal(verify.pragma('user_version', { simple: true }), 13,
    'the refused database was not mutated, re-stamped, or half-upgraded');
  const controlColumns = verify.prepare('PRAGMA table_info(lifecycle_execution_controls)').all()
    .map(column => column.name);
  assert.ok(!controlColumns.includes('last_error'),
    'no partial upgrade leaked into the refused legacy DB');
  assert.equal(
    verify.prepare('SELECT engine_state FROM lifecycle_execution_controls WHERE epic_id=1').get().engine_state,
    'running',
    'legacy row preserved verbatim',
  );
  verify.close();
});
