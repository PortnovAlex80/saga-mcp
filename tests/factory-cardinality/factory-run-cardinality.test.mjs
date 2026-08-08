/**
 * Tranche 1 focused tests (CONVEYOR v4.3 §1-4, §7, §11):
 *   A. Factory cardinality — Project may own many historical Factory Runs.
 *   B. Start idempotency — same command key dedupes; same source bytes do not.
 *
 * These prove the persistence contract directly: schema + launch repo + decoder.
 * They do NOT start a real lifecycle (that is the Tranche 4 E2E).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  requestFactoryLaunch,
} from '../../dist/infrastructure/factory/sqlite-factory-launch-repository.js';
import { decodeFactoryStartCommand } from '../../dist/app/factory-start.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedProjectEpic(db, projectId = 1, epicId = 1) {
  db.prepare('INSERT INTO projects (id,name,status) VALUES (?,?,\'active\')').run(projectId, `p${projectId}`);
  db.prepare('INSERT INTO epics (id,project_id,name,status) VALUES (?,?,\'e\',\'planned\')').run(epicId, projectId);
}

function insertOrder(db, orderRef, projectId, epicId, state = 'completed', sourceDigest = null) {
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,source_digest,state)
     VALUES (?,?,?, 'existing_project', ?, ?)`,
  ).run(orderRef, projectId, epicId, sourceDigest, state);
}

// ---------------------------------------------------------------------------
// A. Factory cardinality: Project -> many historical FactoryOrders
// ---------------------------------------------------------------------------

test('A: a project may own multiple historical factory orders (no UNIQUE on project_id)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  insertOrder(db, 'order-A', 1, 1, 'completed', 'sha256:idea');
  // Run B: a NEW order for the SAME project+epic — must succeed (§7).
  assert.doesNotThrow(() => insertOrder(db, 'order-B', 1, 1, 'provisioned', 'sha256:idea'));
  const orders = db.prepare('SELECT order_ref FROM factory_orders WHERE project_id=1 ORDER BY order_ref').all();
  assert.equal(orders.length, 2);
  db.close();
});

test('A: same source_digest across two orders is legal (provenance, not identity)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  // Two orders sharing the SAME source bytes — legal under v4.3 §3.
  insertOrder(db, 'order-A', 1, 1, 'completed', 'sha256:same-bytes');
  assert.doesNotThrow(() => insertOrder(db, 'order-B', 1, 1, 'provisioned', 'sha256:same-bytes'));
  const dup = db.prepare('SELECT order_ref FROM factory_orders WHERE source_digest=?').all('sha256:same-bytes');
  assert.equal(dup.length, 2);
  db.close();
});

test('A: lifecycle_run_id remains UNIQUE (one order owns at most one run)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
      (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
       definition_snapshot,definition_hash,project_id,epic_id,initiated_by,
       idempotency_key,input_schema,input_snapshot,input_hash,status,entry_stage_id)
     VALUES (1,'factory','1','factory@1','f','','{}','d',1,1,'a','k','s','{}','h','completed','e')`,
  ).run();
  insertOrder(db, 'order-A', 1, 1, 'completed');
  db.prepare('UPDATE factory_orders SET lifecycle_run_id=1 WHERE order_ref=\'order-A\'').run();
  // A second order CANNOT steal the same lifecycle_run_id.
  insertOrder(db, 'order-B', 1, 1, 'provisioned');
  assert.throws(
    () => db.prepare('UPDATE factory_orders SET lifecycle_run_id=1 WHERE order_ref=\'order-B\'').run(),
    /UNIQUE constraint failed: factory_orders.lifecycle_run_id/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// B. Start-command idempotency
// ---------------------------------------------------------------------------

test('B: retry of the same in-flight idempotency key dedupes to the same launch', () => {
  const db = freshDb();
  seedProjectEpic(db);
  insertOrder(db, 'order-A', 1, 1, 'provisioned');
  const ref1 = requestFactoryLaunch({
    orderRef: 'order-A', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'actor', idempotencyKey: 'K1', concurrency: 2,
  }, db);
  // Retry the SAME command while still in-flight → same launch_ref.
  const ref2 = requestFactoryLaunch({
    orderRef: 'order-A', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'actor', idempotencyKey: 'K1', concurrency: 2,
  }, db);
  assert.equal(ref1, ref2);
  db.close();
});

test('B: a different idempotency key for the same source creates a new order/run', () => {
  // This mirrors the gateway contract: K1→Run A, later K2 (same source)→Run B.
  // At the DB level: two orders for the same project, each with its own launch.
  const db = freshDb();
  seedProjectEpic(db);
  insertOrder(db, 'order-A', 1, 1, 'completed', 'sha256:S');
  insertOrder(db, 'order-B', 1, 1, 'provisioned', 'sha256:S');
  const refA = requestFactoryLaunch({
    orderRef: 'order-A', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'actor', idempotencyKey: 'K1', concurrency: 2,
  }, db);
  const refB = requestFactoryLaunch({
    orderRef: 'order-B', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'actor', idempotencyKey: 'K2', concurrency: 2,
  }, db);
  assert.notEqual(refA, refB);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM factory_orders WHERE project_id=1').get().c, 2);
  db.close();
});

test('B: same key on a different order is rejected (durable key = same command identity)', () => {
  // CONVEYOR v4.3 PART 8: the idempotency key identifies a Start command
  // DURABLY. Reusing a key against a different order contradicts the command
  // the key already recorded → must be rejected (not silently deduped to the
  // first order, and not freed when the first launch completes).
  const db = freshDb();
  seedProjectEpic(db);
  insertOrder(db, 'order-A', 1, 1, 'provisioned');
  insertOrder(db, 'order-B', 1, 1, 'provisioned');
  requestFactoryLaunch({
    orderRef: 'order-A', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'actor', idempotencyKey: 'shared-key', concurrency: 2,
  }, db);
  // Same key on a DIFFERENT order contradicts the recorded command identity.
  assert.throws(
    () => requestFactoryLaunch({
      orderRef: 'order-B', mode: 'new', projectId: 1, epicId: 1,
      initiatedBy: 'actor', idempotencyKey: 'shared-key', concurrency: 2,
    }, db),
    /FACTORY_LAUNCH_IDEMPOTENT_REQUEST_MISMATCH/,
  );
  db.close();
});

test('B: a completed launch does NOT free its idempotency key (PART 8 durable binding)', () => {
  // CONVEYOR v4.3 PART 8: "Do not 'free' K1 after completion."
  // Same idempotency key identifies the same Start command even after the
  // launch reaches terminal state. A new intentional Start MUST mint a
  // different key; reusing K1 against a different order is rejected.
  const db = freshDb();
  seedProjectEpic(db);
  insertOrder(db, 'order-A', 1, 1, 'provisioned');
  const ref = requestFactoryLaunch({
    orderRef: 'order-A', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'actor', idempotencyKey: 'K1', concurrency: 2,
  }, db);
  // Simulate the launch completing.
  db.prepare('UPDATE factory_launch_requests SET state=\'completed\' WHERE launch_ref=?').run(ref);
  // Reusing K1 on a NEW order is rejected — the key still identifies order-A.
  insertOrder(db, 'order-B', 1, 1, 'provisioned');
  assert.throws(
    () => requestFactoryLaunch({
      orderRef: 'order-B', mode: 'new', projectId: 1, epicId: 1,
      initiatedBy: 'actor', idempotencyKey: 'K1', concurrency: 2,
    }, db),
    /FACTORY_LAUNCH_IDEMPOTENT_REQUEST_MISMATCH/,
  );
  // But reissuing K1 against the SAME order/order_ref retried after completion
  // resolves to the original launch (durable idempotent return).
  const retried = requestFactoryLaunch({
    orderRef: 'order-A', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'actor', idempotencyKey: 'K1', concurrency: 2,
  }, db);
  assert.equal(retried, ref);
  db.close();
});

// ---------------------------------------------------------------------------
// Decoder contract (new_start + idempotency_key)
// ---------------------------------------------------------------------------

test('decoder: new_start mode for existing project', () => {
  assert.deepEqual(
    decodeFactoryStartCommand({ project_id: 5, mode: 'new_start' }),
    { kind: 'new_start', projectId: 5, idempotencyKey: undefined },
  );
  // default mode for project_id is resume
  assert.deepEqual(
    decodeFactoryStartCommand({ project_id: 5 }),
    { kind: 'resume', projectId: 5 },
  );
});

test('decoder: idempotency_key plumbed for new and new_start', () => {
  assert.equal(
    decodeFactoryStartCommand({ idea_url: 'https://x.example/i', idempotency_key: 'CMD-1' }).idempotencyKey,
    'CMD-1',
  );
  assert.equal(
    decodeFactoryStartCommand({ project_id: 5, mode: 'new_start', idempotency_key: 'CMD-2' }).idempotencyKey,
    'CMD-2',
  );
});

test('decoder: invalid mode rejected', () => {
  assert.throws(
    () => decodeFactoryStartCommand({ project_id: 5, mode: 'bogus' }),
    /mode must be 'resume' or 'new_start'/,
  );
});
