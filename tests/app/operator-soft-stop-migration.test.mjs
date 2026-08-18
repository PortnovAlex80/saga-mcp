// tests/app/operator-soft-stop-migration.test.mjs
//
// POST-PURGE migration contract (the ladder was removed in the
// pre-production purge; K15-era schema history): a database is either
// FRESH (user_version 0 -> schema applied -> stamped current) or EXACTLY
// CURRENT. A DB stamped v12 fails closed at getDb() with the typed
// FACTORY_SCHEMA_MIGRATION_UNSUPPORTED error — never a partial in-place
// upgrade. The v12 legacy worker_executions SHAPE below is preserved as a
// fixture of record; the assertions pin the refusal, the released
// connection cache, and that the file is left untouched (stamped 12).
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
  try { closeDb(); } catch { /* never opened successfully */ }
  rmSync(temp, { recursive: true, force: true });
});

test('a v12 DB fails closed at open — no ladder, no partial upgrade, no mutation', () => {
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

  // The post-purge contract: refuse, typed, naming both versions.
  process.env.DB_PATH = dbPath;
  assert.throws(
    () => getDb(),
    /FACTORY_SCHEMA_MIGRATION_UNSUPPORTED: 12->\d+\./u,
    'a pre-purge database fails closed at open — no ladder runs',
  );

  // The refused open must not poison the cached connection: a FRESH
  // database afterwards opens cleanly and stamps the current version.
  const freshPath = path.join(temp, 'fresh.db');
  process.env.DB_PATH = freshPath;
  const fresh = getDb();
  const stamped = fresh.pragma('user_version', { simple: true });
  assert.ok(stamped > 12, `a fresh DB stamps the current schema version (got ${stamped})`);
  closeDb();

  // The refused v12 file is untouched: still stamped 12, legacy shape intact.
  const verify = new Database(dbPath);
  assert.equal(verify.pragma('user_version', { simple: true }), 12,
    'the refused database was not mutated, re-stamped, or half-upgraded');
  const columns = verify.prepare('PRAGMA table_info(worker_executions)').all().map(column => column.name);
  assert.ok(!columns.includes('stop_fence') && !columns.includes('voided_at'),
    'no partial upgrade leaked into the refused legacy DB');
  assert.equal(
    verify.prepare('SELECT state FROM worker_executions WHERE execution_id=?').get('exec-legacy').state,
    'running',
    'legacy row preserved verbatim',
  );
  verify.close();
});
