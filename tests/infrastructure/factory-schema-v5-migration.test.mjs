import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';

const { relaxFactoryLaunchStateForPaused } = await import('../../dist/schema.js');

function createV4LaunchFixture(db) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE factory_orders (order_ref TEXT PRIMARY KEY);
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
    CREATE TABLE epics (id INTEGER PRIMARY KEY);
    CREATE TABLE factory_lifecycle_runs (id INTEGER PRIMARY KEY);
    CREATE TABLE factory_launch_requests (
      launch_ref TEXT PRIMARY KEY,
      order_ref TEXT NOT NULL REFERENCES factory_orders(order_ref) ON DELETE RESTRICT,
      mode TEXT NOT NULL CHECK (mode IN ('new','resume')),
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE RESTRICT,
      lifecycle_run_id INTEGER REFERENCES factory_lifecycle_runs(id) ON DELETE RESTRICT,
      lifecycle_input_json TEXT,
      lifecycle_input_schema TEXT,
      initiated_by TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 10),
      state TEXT NOT NULL CHECK (state IN ('requested','claimed','running','completed','failed')),
      claim_token TEXT,
      claimed_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE UNIQUE INDEX idx_factory_one_pending_launch
      ON factory_launch_requests(order_ref) WHERE state='requested';
    CREATE UNIQUE INDEX idx_factory_one_active_launch
      ON factory_launch_requests(order_ref)
      WHERE state IN ('requested','claimed','running');
    CREATE UNIQUE INDEX idx_factory_launch_idempotency
      ON factory_launch_requests(idempotency_key);
    INSERT INTO projects VALUES (1);
    INSERT INTO epics VALUES (1);
    INSERT INTO factory_orders VALUES ('order:1');
    INSERT INTO factory_launch_requests
      (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,
       idempotency_key,concurrency,state)
    VALUES ('launch:1','order:1','new',1,1,'test','key:1',2,'completed');
    PRAGMA user_version=4;
  `);
}

test('v4 to v5 launch-table migration preserves rows, indexes, fences, and paused state', () => {
  const db = new Database(':memory:');
  createV4LaunchFixture(db);
  const before = db.prepare('SELECT * FROM factory_launch_requests').get();

  relaxFactoryLaunchStateForPaused(db);

  assert.deepEqual(db.prepare('SELECT * FROM factory_launch_requests').get(), before);
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE name='factory_launch_requests'").get().sql,
    /'paused'/,
  );
  const indexes = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='factory_launch_requests'",
  ).all().map(row => row.name));
  assert.ok(indexes.has('idx_factory_one_pending_launch'));
  assert.ok(indexes.has('idx_factory_one_active_launch'));
  assert.ok(indexes.has('idx_factory_launch_idempotency'));
  assert.throws(
    () => db.prepare(`INSERT INTO factory_launch_requests
      (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,
       idempotency_key,concurrency,state)
      VALUES ('launch:duplicate','order:1','resume',1,1,'test','key:1',2,'paused')`).run(),
    /UNIQUE constraint failed/,
  );
  db.prepare(
    "UPDATE factory_launch_requests SET state='paused', completed_at=datetime('now') WHERE launch_ref='launch:1'",
  ).run();
  assert.equal(db.prepare("SELECT state FROM factory_launch_requests WHERE launch_ref='launch:1'").get().state, 'paused');
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  // Idempotent replay must preserve the migrated shape and data.
  relaxFactoryLaunchStateForPaused(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_launch_requests').get().n, 1);
  db.close();
});

test('getDb refuses to stamp an unknown future schema version as current', () => {
  const root = mkdtempSync(join(tmpdir(), 'saga-v5-future-'));
  const dbPath = join(root, 'future.sqlite');
  try {
    const fixture = new Database(dbPath);
    fixture.pragma('user_version=99');
    fixture.close();

    const script = `
      import { getDb } from './dist/db.js';
      try { getDb(); process.exit(0); }
      catch (error) {
        process.stderr.write(String(error instanceof Error ? error.message : error));
        process.exit(23);
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(child.status, 23, child.stderr);
    assert.match(child.stderr, /FACTORY_SCHEMA_MIGRATION_UNSUPPORTED: 99->7/);

    const reopened = new Database(dbPath, { readonly: true });
    assert.equal(reopened.pragma('user_version', { simple: true }), 99);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
