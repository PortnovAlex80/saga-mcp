import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { LegacyEngineAdministration } from '../../dist/infrastructure/engine/engine-administration.js';

function databaseFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-engine-resume-'));
  const dbPath = path.join(root, 'saga.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (2,1,'e')").run();
  db.close();
  return { root, dbPath };
}

function insertRun(dbPath, { name = 'factory', idempotencyKey = 'same-order' } = {}) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO saga3_lifecycle_runs
      (lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
       definition_snapshot,definition_hash,project_id,epic_id,initiated_by,
       idempotency_key,input_schema,input_snapshot,input_hash,status,entry_stage_id,current_stage_id)
     VALUES (?, '1', ?, 'Factory', '', '{}', 'definition', 1, 2, 'user', ?,
       'input', '{}', 'input-hash', 'paused', 'a', 'a')`,
  ).run(name, `${name}@1`, idempotencyKey);
  db.close();
}

function child() {
  const process = new EventEmitter();
  process.pid = 4242;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.unref = () => {};
  queueMicrotask(() => { process.stdout.end(); process.stderr.end(); });
  return process;
}

test('engine start automatically resumes the unique active lifecycle run', t => {
  const f = databaseFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  insertRun(f.dbPath);
  let args;
  const admin = new LegacyEngineAdministration({
    config: { dbPath: f.dbPath, orchestrationMode: 'lifecycle' },
    platform: 'linux', spawnProcess: (_command, actual) => { args = actual; return child(); },
    spawnProcessSync: () => ({ status: 1, stdout: '', stderr: '' }),
  });
  admin.start({ epicId: 2, concurrency: 2 });
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('--idempotency-key=same-order'));
});

test('engine start fails closed when more than one lifecycle is active in the epic', t => {
  const f = databaseFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  insertRun(f.dbPath, { name: 'factory-a', idempotencyKey: 'a' });
  insertRun(f.dbPath, { name: 'factory-b', idempotencyKey: 'b' });
  const admin = new LegacyEngineAdministration({
    config: { dbPath: f.dbPath, orchestrationMode: 'lifecycle' },
    spawnProcess: () => child(), spawnProcessSync: () => ({ status: 1, stdout: '', stderr: '' }),
  });
  assert.throws(() => admin.start({ epicId: 2 }), /multiple resumable LifecycleRuns/);
});
