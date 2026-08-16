import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';

const { ensureGatePresentationReplayBindingColumns, relaxFactoryLaunchStateForPaused } = await import('../../dist/schema.js');

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
    assert.match(child.stderr, /FACTORY_SCHEMA_MIGRATION_UNSUPPORTED: 99->12/);

    const reopened = new Database(dbPath, { readonly: true });
    assert.equal(reopened.pragma('user_version', { simple: true }), 99);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v8 migrates through current schema and preserves immutable workshop binding receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'saga-v9-binding-'));
  const dbPath = join(root, 'v8.sqlite');
  try {
    const fixture = new Database(dbPath);
    fixture.pragma('user_version=8');
    fixture.close();
    const script = `
      import { getDb, closeDb } from './dist/db.js';
      const db = getDb();
      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='factory_workshop_binding_receipts'").get();
      process.stdout.write(JSON.stringify({ version: db.pragma('user_version', { simple: true }), sql: table?.sql ?? '' }));
      closeDb();
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.version, 12);
    assert.match(result.sql, /binding_digest/);
    const reopened = new Database(dbPath);
    assert.throws(
      () => {
        reopened.prepare(`INSERT INTO factory_workshop_binding_receipts
          (receipt_ref,workshop_id,epoch,process_role,process_identity,manifest_digest,
           declared_snapshot,resolved_snapshot,binding_digest)
          VALUES ('r','w','e','worker-mcp','p','m','[]','[]','d')`).run();
        reopened.prepare("UPDATE factory_workshop_binding_receipts SET binding_digest='x'").run();
      },
      /immutable/,
    );
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('v9 to v10 freezes legacy Gate replay evidence before stamping the schema', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE worker_executions (execution_id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
      CREATE TABLE factory_gate_presentation_attempts (
        gate_run_ref TEXT NOT NULL,presentation_ref TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(gate_run_ref,presentation_ref));
    `);
    db.prepare(`INSERT INTO worker_executions (execution_id,metadata)
      VALUES ('exec:v9',?)`).run(JSON.stringify({
      execution_context: { replay: {
        key: 'key:v9', key_material: { projectId: 1 }, capsule_ref: 'capsule:v9',
        capsule_payload_hash: 'a'.repeat(64),
      } },
    }));
    db.prepare(`INSERT INTO factory_gate_presentation_attempts
      (gate_run_ref,presentation_ref) VALUES ('gate:v9','exec:v9')`).run();
    ensureGatePresentationReplayBindingColumns(db);
    const row = db.prepare(`SELECT replay_key,replay_key_material,replay_capsule_ref,
      replay_capsule_payload_hash FROM factory_gate_presentation_attempts`).get();
    assert.equal(row.replay_key, 'key:v9');
    assert.equal(JSON.parse(row.replay_key_material).projectId, 1);
    assert.equal(row.replay_capsule_ref, 'capsule:v9');
    assert.equal(row.replay_capsule_payload_hash, 'a'.repeat(64));
    assert.throws(
      () => db.prepare(`UPDATE factory_gate_presentation_attempts SET replay_key='changed'`).run(),
      /immutable/,
    );
  } finally {
    db.close();
  }
});

test('v9 to v10 fills replay key material on partially frozen Gate presentations', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE worker_executions (execution_id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
      CREATE TABLE factory_gate_presentation_attempts (
        gate_run_ref TEXT NOT NULL,presentation_ref TEXT NOT NULL,
        replay_key TEXT,replay_capsule_ref TEXT,replay_capsule_payload_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(gate_run_ref,presentation_ref));
    `);
    db.prepare(`INSERT INTO worker_executions (execution_id,metadata)
      VALUES ('exec:v9-partial',?)`).run(JSON.stringify({
      execution_context: { replay: {
        key: 'key:v9-partial', key_material: { projectId: 9, input: 'frozen' },
        capsule_ref: 'capsule:v9-partial', capsule_payload_hash: 'b'.repeat(64),
      } },
    }));
    db.prepare(`INSERT INTO factory_gate_presentation_attempts
      (gate_run_ref,presentation_ref,replay_key,replay_capsule_ref,replay_capsule_payload_hash)
      VALUES ('gate:v9-partial','exec:v9-partial','key:v9-partial','capsule:v9-partial',?)`)
      .run('b'.repeat(64));

    ensureGatePresentationReplayBindingColumns(db);

    const row = db.prepare(`SELECT replay_key,replay_key_material,replay_capsule_ref,
      replay_capsule_payload_hash FROM factory_gate_presentation_attempts`).get();
    assert.equal(row.replay_key, 'key:v9-partial');
    assert.deepEqual(JSON.parse(row.replay_key_material), { projectId: 9, input: 'frozen' });
    assert.equal(row.replay_capsule_ref, 'capsule:v9-partial');
    assert.equal(row.replay_capsule_payload_hash, 'b'.repeat(64));
  } finally {
    db.close();
  }
});

test('opening an existing v10 database never reinterprets an empty Gate replay binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'saga-v10-reopen-'));
  const dbPath = join(root, 'v10.sqlite');
  const open = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { getDb, closeDb } from './dist/db.js';
    getDb(); closeDb();
  `], {
    cwd: process.cwd(), env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8',
  });
  try {
    const initial = open();
    assert.equal(initial.status, 0, initial.stderr);
    const fixture = new Database(dbPath);
    fixture.pragma('foreign_keys=OFF');
    fixture.prepare(`INSERT INTO worker_executions
      (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata)
      VALUES ('exec:v10','run',1,1,1,'worker','machine','exited','finishing',?)`)
      .run(JSON.stringify({ execution_context: { replay: {
        key: 'key:after', key_material: { changed: true }, capsule_ref: 'capsule:after',
        capsule_payload_hash: 'c'.repeat(64),
      } } }));
    fixture.prepare(`INSERT INTO factory_gate_presentation_attempts
      (gate_run_ref,presentation_ref) VALUES ('gate:v10','exec:v10')`).run();
    fixture.close();

    const reopened = open();
    assert.equal(reopened.status, 0, reopened.stderr);
    const observed = new Database(dbPath, { readonly: true });
    const row = observed.prepare(`SELECT replay_key,replay_key_material,replay_capsule_ref,
      replay_capsule_payload_hash FROM factory_gate_presentation_attempts`).get();
    assert.deepEqual(row, {
      replay_key: null, replay_key_material: null,
      replay_capsule_ref: null, replay_capsule_payload_hash: null,
    });
    observed.close();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
