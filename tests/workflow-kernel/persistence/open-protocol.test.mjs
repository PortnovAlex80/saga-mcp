/**
 * open-protocol.test.mjs - exact-version open and fail-closed unsupported
 * databases (WP-06, plan phase EK-3): an empty path creates the protocol,
 * an exact database reopens, every other non-empty database is refused with
 * FACTORY_DATABASE_PROTOCOL_UNSUPPORTED and is byte-for-byte unchanged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const { openKernelDatabase, FactoryDatabaseProtocolUnsupportedError } = await import('../../../dist/workflow-kernel/persistence/database.js');
const schema = await import('../../../dist/workflow-kernel/persistence/schema.js');
const { SCHEMA_SQL, SCHEMA_FINGERPRINT, PROTOCOL_ID } = schema;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ek-wp06-open-'));
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function expectRefusal(path, expectedReason) {
  const before = sha256(path);
  assert.throws(
    () => openKernelDatabase(path),
    (error) => {
      assert.ok(error instanceof FactoryDatabaseProtocolUnsupportedError, `typed refusal, got ${error?.constructor?.name}: ${error?.message}`);
      assert.equal(error.code, 'FACTORY_DATABASE_PROTOCOL_UNSUPPORTED');
      assert.equal(error.verification.reason, expectedReason);
      assert.match(error.message, /Choose a fresh database path/, 'operator-facing instruction present');
      return true;
    },
    `open must refuse with ${expectedReason}`,
  );
  assert.equal(sha256(path), before, 'the refused database is byte-for-byte unchanged');
}

test('a missing path (and an in-memory path) bootstraps the fresh protocol', () => {
  const dir = tempDir();
  const path = join(dir, 'fresh.sqlite');
  const db = openKernelDatabase(path);
  try {
    const identity = schema.readProtocolIdentity(db);
    assert.equal(identity.protocol_id, PROTOCOL_ID);
    assert.equal(identity.schema_fingerprint, SCHEMA_FINGERPRINT);
  } finally {
    db.close();
  }
  assert.ok(existsSync(path), 'the database file was created');
});

test('a zero-byte file and a schema-less SQLite file are treated as an empty path', () => {
  const dir = tempDir();
  const zeroByte = join(dir, 'zero.sqlite');
  writeFileSync(zeroByte, Buffer.alloc(0));
  openKernelDatabase(zeroByte).close();
  assert.equal(schema.readProtocolIdentity(new Database(zeroByte)).schema_fingerprint, SCHEMA_FINGERPRINT);

  const schemaLess = join(dir, 'schema-less.sqlite');
  new Database(schemaLess).close(); // valid SQLite file, no user objects
  openKernelDatabase(schemaLess).close();
  assert.equal(schema.readProtocolIdentity(new Database(schemaLess)).schema_fingerprint, SCHEMA_FINGERPRINT);
});

test('an exact fresh database reopens (exact-version open)', () => {
  const dir = tempDir();
  const path = join(dir, 'exact.sqlite');
  openKernelDatabase(path).close();
  const again = openKernelDatabase(path);
  again.close();
});

test('a legacy (old-protocol) database is refused without any file mutation', () => {
  const dir = tempDir();
  const legacy = join(dir, 'legacy.sqlite');
  {
    const db = new Database(legacy);
    db.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE worker_executions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL);
      INSERT INTO projects (name) VALUES ('old world');
    `);
    db.close();
  }
  expectRefusal(legacy, 'FOREIGN_SCHEMA');
});

test('a file that is not a SQLite database at all is refused without any file mutation', () => {
  const dir = tempDir();
  const junk = join(dir, 'junk.sqlite');
  writeFileSync(junk, Buffer.from('not a sqlite database - just bytes for the refusal test ..........'));
  expectRefusal(junk, 'FOREIGN_SCHEMA');
});

test('a wrong schema fingerprint is refused (created tables, foreign identity row)', () => {
  const dir = tempDir();
  const wrong = join(dir, 'wrong-fingerprint.sqlite');
  {
    const db = new Database(wrong);
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO protocol_metadata (singleton, protocol_id, schema_version, schema_fingerprint, universe_version) VALUES (1, ?, 1, ?, ?)')
      .run(PROTOCOL_ID, 'deadbeefdeadbeef', 'ek.transition-universe.ek1-reconciliation.v1');
    db.pragma('user_version = 1');
    db.close();
  }
  expectRefusal(wrong, 'FINGERPRINT_MISMATCH');
});

test('a wrong protocol id or schema version is refused', () => {
  const dir = tempDir();
  const wrongId = join(dir, 'wrong-id.sqlite');
  {
    const db = new Database(wrongId);
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO protocol_metadata (singleton, protocol_id, schema_version, schema_fingerprint, universe_version) VALUES (1, ?, 1, ?, ?)')
      .run('some.other.protocol', SCHEMA_FINGERPRINT, 'ek.transition-universe.ek1-reconciliation.v1');
    db.pragma('user_version = 1');
    db.close();
  }
  expectRefusal(wrongId, 'PROTOCOL_MISMATCH');

  const wrongVersion = join(dir, 'wrong-version.sqlite');
  {
    const db = new Database(wrongVersion);
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO protocol_metadata (singleton, protocol_id, schema_version, schema_fingerprint, universe_version) VALUES (1, ?, 2, ?, ?)')
      .run(PROTOCOL_ID, SCHEMA_FINGERPRINT, 'ek.transition-universe.ek1-reconciliation.v1');
    db.pragma('user_version = 2');
    db.close();
  }
  expectRefusal(wrongVersion, 'PROTOCOL_MISMATCH');
});

test('a partially created kernel schema (tables without the identity row) is refused', () => {
  const dir = tempDir();
  const partial = join(dir, 'partial.sqlite');
  {
    const db = new Database(partial);
    db.exec(`
      CREATE TABLE factory_run (instance_id TEXT PRIMARY KEY);
      CREATE TABLE workflow_event (sequence INTEGER PRIMARY KEY);
    `);
    db.close();
  }
  expectRefusal(partial, 'PARTIAL_SCHEMA');
});

test('an identity row without the exact schema objects is refused', () => {
  const dir = tempDir();
  const partialObjects = join(dir, 'partial-objects.sqlite');
  {
    const db = new Database(partialObjects);
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO protocol_metadata (singleton, protocol_id, schema_version, schema_fingerprint, universe_version) VALUES (1, ?, 1, ?, ?)')
      .run(PROTOCOL_ID, SCHEMA_FINGERPRINT, 'ek.transition-universe.ek1-reconciliation.v1');
    db.pragma('user_version = 1');
    db.exec('DROP TRIGGER trg_workflow_event_no_update');
    db.close();
  }
  expectRefusal(partialObjects, 'FINGERPRINT_MISMATCH');
});

test('two fresh bootstraps carry the identical fingerprint and the identity row is immutable after creation', () => {
  const dir = tempDir();
  const a = join(dir, 'a.sqlite');
  const b = join(dir, 'b.sqlite');
  const dbA = openKernelDatabase(a);
  const dbB = openKernelDatabase(b);
  try {
    assert.equal(schema.readProtocolIdentity(dbA).schema_fingerprint, schema.readProtocolIdentity(dbB).schema_fingerprint);
    assert.equal(schema.readProtocolIdentity(dbA).schema_fingerprint, SCHEMA_FINGERPRINT);
    assert.throws(() => dbA.exec("UPDATE protocol_metadata SET schema_fingerprint = 'x'"), /EK_PROTOCOL_METADATA_IMMUTABLE/);
  } finally {
    dbA.close();
    dbB.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
