// tests/app/operator-soft-stop-engine-brake-launch-pids.test.mjs
//
// E-A6 (PREVENTIVE-HUNT Layer 3): the soft-stop engine brake used to read ONLY
// lifecycle_execution_controls.engine_pid — a column written exclusively by the
// panel engine-administration start path. Engines spawned through
// product-lifecycle-run-starter (tracker start) or scripts/factory.mjs stamp
// factory_launch_requests.engine_pid instead, so for those launches the brake
// was a silent NO-OP: the operator's stop left the engine alive and re-hiring.
//
// The brake must union BOTH durable pid sources for the project scope, dedup,
// keep the orchestrate-cli.js command-line guard, and stay fail-closed on a
// verified survivor.
//
// Harness shape copied from tests/app/operator-soft-stop.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { brakeEnginesForProject } from '../../dist/app/operator-soft-stop.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-brake-launch-'));
process.env.DB_PATH = path.join(temp, 'brake-launch.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function setupProject() {
  const p = projects.project_create({ name: `brake-launch-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const e = epics.epic_create({ project_id: p.id, name: 'brake launch epic' });
  return { projectId: p.id, epicId: e.id };
}

/**
 * A launch row whose engine was spawned by factory.mjs / the run-starter:
 * engine_pid + engine_log_path live on factory_launch_requests ONLY — no
 * lifecycle_execution_controls row exists (that is exactly the E-A6 shape).
 */
function insertLaunch(projectId, epicId, { pid, state = 'running', launchRef = `launch-${pid}-${Math.random().toString(36).slice(2, 8)}` }) {
  const db = getDb();
  const orderRef = `order-${launchRef}`;
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
     VALUES (?,?,?,NULL,'existing_project','starting')`,
  ).run(orderRef, projectId, epicId);
  db.prepare(
    `INSERT INTO factory_launch_requests
       (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,
        concurrency,state,engine_log_path,engine_pid,engine_spawned_at)
     VALUES (?,?,'resume',?,?, 'factory-start',?, 4, ?, ?, ?, datetime('now'))`,
  ).run(launchRef, orderRef, projectId, epicId, `idem-${launchRef}`, state,
    `${os.tmpdir()}/saga-engine-test-${pid}.log`, pid);
  return launchRef;
}

/** Fake OS deps over a mutable alive-set; records every killTree call. */
function fakeDeps({ survivors = new Set() } = {}) {
  const alive = new Set();
  const kills = [];
  return {
    alive,
    kills,
    deps: {
      isAlive: pid => alive.has(pid),
      readCommandLine: pid => (alive.has(pid) && !survivors.has(pid)
        ? `node dist/orchestrate-cli.js --launch-ref=x (pid ${pid})`
        : `node dist/orchestrate-cli.js --launch-ref=x (pid ${pid})`),
      killTree: pid => {
        kills.push(pid);
        if (!survivors.has(pid)) alive.delete(pid);
        return !survivors.has(pid);
      },
    },
  };
}

test('E-A6: engine pid persisted ONLY on a launch row gets braked (not a no-op)', () => {
  const { projectId, epicId } = setupProject();
  insertLaunch(projectId, epicId, { pid: 424300 });
  const fake = fakeDeps();
  fake.alive.add(424300);

  const results = brakeEnginesForProject(getDb(), { projectId }, fake.deps);

  assert.equal(results.length, 1, 'the launch-row engine must be in the brake scope');
  assert.equal(results[0].enginePid, 424300);
  assert.equal(results[0].outcome, 'braked');
  assert.deepEqual(fake.kills, [424300], 'the guarded tree-kill was issued');
  // The controls row is stamped stopped (created idempotently when absent).
  assert.equal(
    getDb().prepare('SELECT engine_state FROM lifecycle_execution_controls WHERE epic_id=?').get(epicId)?.engine_state,
    'stopped',
  );
});

test('E-A6: dead launch-row pid → already_dead; terminal launch states are out of scope', () => {
  const { projectId, epicId } = setupProject();
  insertLaunch(projectId, epicId, { pid: 424301 }); // dead
  insertLaunch(projectId, epicId, { pid: 424302, state: 'completed' });
  insertLaunch(projectId, epicId, { pid: 424303, state: 'failed' });
  const fake = fakeDeps();
  fake.alive.add(424302);
  fake.alive.add(424303);

  const results = brakeEnginesForProject(getDb(), { projectId }, fake.deps);

  const byPid = new Map(results.map(item => [item.enginePid, item.outcome]));
  assert.equal(byPid.get(424301), 'already_dead', 'dead launch-row engine reported');
  assert.equal(byPid.has(424302), false, 'completed launch out of brake scope');
  assert.equal(byPid.has(424303), false, 'failed launch out of brake scope');
  assert.deepEqual(fake.kills, [], 'no kill for terminal-launch pids');
  assert.equal(
    getDb().prepare('SELECT engine_state FROM lifecycle_execution_controls WHERE epic_id=?').get(epicId)?.engine_state,
    'stopped',
  );
});

test('E-A6: same pid in controls AND launch row is deduped to one brake', () => {
  const { projectId, epicId } = setupProject();
  const db = getDb();
  db.prepare(
    'INSERT INTO lifecycle_execution_controls (epic_id, engine_state, engine_pid) VALUES (?, ?, ?)',
  ).run(epicId, 'running', 424310);
  insertLaunch(projectId, epicId, { pid: 424310 });
  const fake = fakeDeps();
  fake.alive.add(424310);

  const results = brakeEnginesForProject(getDb(), { projectId }, fake.deps);

  assert.equal(results.length, 1, 'pid present in both sources brakes exactly once');
  assert.equal(results[0].enginePid, 424310);
  assert.equal(results[0].outcome, 'braked');
  assert.equal(fake.kills.length, 1, 'exactly one tree-kill for the shared pid');
});

test('E-A6: launch-row engine that survives the verified kill fails closed', () => {
  const { projectId, epicId } = setupProject();
  insertLaunch(projectId, epicId, { pid: 424320 });
  const fake = fakeDeps({ survivors: new Set([424320]) });
  fake.alive.add(424320);

  assert.throws(
    () => brakeEnginesForProject(getDb(), { projectId }, fake.deps),
    /ENGINE_BRAKE_FAILED.*424320/s,
  );
});

test('E-A6: reused foreign pid on a launch row is guarded-skipped, never killed', () => {
  const { projectId, epicId } = setupProject();
  insertLaunch(projectId, epicId, { pid: 424330 });
  const db = getDb();
  const foreign = {
    isAlive: () => true,
    readCommandLine: () => 'C:/somewhere/unrelated.exe --serve',
    killTree: () => { throw new Error('must not be reached'); },
  };

  const results = brakeEnginesForProject(db, { projectId }, foreign);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'pid_reused_foreign');
  assert.equal(
    db.prepare('SELECT engine_state FROM lifecycle_execution_controls WHERE epic_id=?').get(epicId)?.engine_state,
    'stopped',
    'no live engine of ours remains for the epic',
  );
});

test('E-A6: brake scope stays project-filtered across both sources', () => {
  const mine = setupProject();
  const other = setupProject();
  insertLaunch(other.projectId, other.epicId, { pid: 424340 });
  const fake = fakeDeps();
  fake.alive.add(424340);

  const results = brakeEnginesForProject(getDb(), { projectId: mine.projectId }, fake.deps);
  assert.equal(results.length, 0, 'foreign-project launch engine is out of scope');
  assert.deepEqual(fake.kills, []);
});
