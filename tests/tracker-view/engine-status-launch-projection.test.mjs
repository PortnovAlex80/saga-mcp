// tests/tracker-view/engine-status-launch-projection.test.mjs
//
// CC-GAP-2 — the tracker engine-status projection (`last_launch` in
// GET /api/factory/status) must expose OPERATIONAL launch/order state
// separately from the lifecycle business verdict. Before the fix the endpoint
// returned launch_state/order_state only: a launch that settled 'completed'
// after a `development-blocked` business terminal was indistinguishable from
// a released product at this surface — 'completed' implied product success.
//
// The durable authority is unchanged (factory_lifecycle_runs.status vs
// terminal_status are already separate columns); this tests the READ
// projection readLastLaunchStatus that powers the endpoint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const { SCHEMA_SQL } = await import('../../dist/schema.js');
const { readLastLaunchStatus } = await import('../../tracker-view/lifecycle-endpoints.mjs');

const root = mkdtempSync(path.join(tmpdir(), 'saga-engine-status-launch-'));

function makeDb() {
  const dbPath = path.join(root, `db-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'gap2-p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (7,1,'gap2-e')").run();
  return db;
}

function seedTerminalLaunch(db, { launchState, orderState, lifecycleStatus, terminalStatus }) {
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES ('ord-1',1,7,'existing_project',?)`,
  ).run(orderState);
  const lifecycleInfo = db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
        definition_snapshot,definition_hash,project_id,epic_id,initiated_by,
        idempotency_key,input_schema,input_snapshot,input_hash,
        status,entry_stage_id,terminal_status)
     VALUES ('product-delivery','1.0.0','product-delivery@1.0.0','Product Delivery','test',
        '{}','hash',1,7,'test','idem-gap2','schema','{}','ih',
        ?, 'discovery', ?)`,
  ).run(lifecycleStatus, terminalStatus);
  db.prepare(
    `INSERT INTO factory_launch_requests
       (launch_ref,order_ref,mode,project_id,epic_id,lifecycle_run_id,
        initiated_by,idempotency_key,concurrency,state,completed_at)
     VALUES ('lau-1','ord-1','new',1,7,?, 'operator','idem-1',2,?,datetime('now'))`,
  ).run(Number(lifecycleInfo.lastInsertRowid), launchState);
  return Number(lifecycleInfo.lastInsertRowid);
}

test('the gap counterexample: launch/order completed sit NEXT TO terminal_status=development-blocked — neither implies the other', () => {
  const db = makeDb();
  try {
    const lifecycleRunId = seedTerminalLaunch(db, {
      launchState: 'completed',
      orderState: 'completed',
      lifecycleStatus: 'completed',
      terminalStatus: 'development-blocked',
    });
    const row = readLastLaunchStatus(db, 7);

    assert.ok(row, 'row found for the epic');
    // Operational channels (unchanged).
    assert.equal(row.launch_state, 'completed');
    assert.equal(row.order_state, 'completed');
    assert.ok(row.launch_finished_at);
    // Separated verdict channels.
    assert.equal(row.lifecycle_run_id, lifecycleRunId);
    assert.equal(row.lifecycle_status, 'completed');
    assert.equal(row.lifecycle_terminal_status, 'development-blocked');
  } finally {
    db.close();
  }
});

test('success verdict is carried verbatim, not synthesized from launch state', () => {
  const db = makeDb();
  try {
    seedTerminalLaunch(db, {
      launchState: 'completed',
      orderState: 'completed',
      lifecycleStatus: 'completed',
      terminalStatus: 'released',
    });
    const row = readLastLaunchStatus(db, 7);
    assert.equal(row.launch_state, 'completed');
    assert.equal(row.lifecycle_terminal_status, 'released');
    assert.equal(row.lifecycle_status, 'completed');
  } finally {
    db.close();
  }
});

test('runtime failure: launch failed + order start_failed; the repository-stamped terminal_status=failed travels next to them', () => {
  const db = makeDb();
  try {
    seedTerminalLaunch(db, {
      launchState: 'failed',
      orderState: 'start_failed',
      lifecycleStatus: 'failed',
      terminalStatus: 'failed',
    });
    const row = readLastLaunchStatus(db, 7);
    assert.equal(row.launch_state, 'failed');
    assert.equal(row.order_state, 'start_failed');
    assert.equal(row.lifecycle_status, 'failed');
    // fail() stamps terminal_status='failed' (sqlite-lifecycle-run-repository);
    // the read projection must carry that verdict, not flatten it away.
    assert.equal(row.lifecycle_terminal_status, 'failed');
  } finally {
    db.close();
  }
});

test('paused launch (graceful drain, exit-2 class) projects both channels; verdict honestly null', () => {
  const db = makeDb();
  try {
    seedTerminalLaunch(db, {
      launchState: 'paused',
      orderState: 'paused',
      lifecycleStatus: 'paused',
      terminalStatus: null,
    });
    const row = readLastLaunchStatus(db, 7);
    assert.equal(row.launch_state, 'paused');
    assert.equal(row.order_state, 'paused');
    assert.equal(row.lifecycle_status, 'paused');
    assert.equal(row.lifecycle_terminal_status, null);
  } finally {
    db.close();
  }
});

test('legacy launch rows without a lifecycle pointer: lifecycle columns are null, launch/order still exposed (LEFT JOIN)', () => {
  const db = makeDb();
  try {
    db.prepare(
      `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
       VALUES ('ord-legacy',1,7,'existing_project','completed')`,
    ).run();
    db.prepare(
      `INSERT INTO factory_launch_requests
         (launch_ref,order_ref,mode,project_id,epic_id,
          initiated_by,idempotency_key,concurrency,state,completed_at)
       VALUES ('lau-legacy','ord-legacy','new',1,7,'operator','idem-legacy',2,'completed',datetime('now'))`,
    ).run();
    const row = readLastLaunchStatus(db, 7);
    assert.equal(row.launch_state, 'completed');
    assert.equal(row.lifecycle_run_id, null);
    assert.equal(row.lifecycle_status, null);
    assert.equal(row.lifecycle_terminal_status, null);
  } finally {
    db.close();
  }
});

test('no launches at all: null, not a fabricated status', () => {
  const db = makeDb();
  try {
    assert.equal(readLastLaunchStatus(db, 7), null);
  } finally {
    db.close();
  }
});

test('epic isolation: launches of other projects are not visible', () => {
  const db = makeDb();
  try {
    db.prepare("INSERT INTO projects (id,name) VALUES (2,'other-p')").run();
    db.prepare("INSERT INTO epics (id,project_id,name) VALUES (8,2,'other')").run();
    db.prepare(
      `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
       VALUES ('ord-other',2,8,'existing_project','completed')`,
    ).run();
    db.prepare(
      `INSERT INTO factory_launch_requests
         (launch_ref,order_ref,mode,project_id,epic_id,
          initiated_by,idempotency_key,concurrency,state)
       VALUES ('lau-other','ord-other','new',2,8,'operator','idem-other',2,'running')`,
    ).run();
    assert.equal(readLastLaunchStatus(db, 7), null);
    assert.equal(readLastLaunchStatus(db, 8).launch_state, 'running');
  } finally {
    db.close();
  }
});

process.on('exit', () => rmSync(root, { recursive: true, force: true }));
