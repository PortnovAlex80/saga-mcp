// tests/app/engine-supervisor.test.mjs
//
// Antifreeze layer C — the panel engine supervisor, on a real temp database
// (fake process deps only, mirrors tests/app/product-lifecycle-start-receipt
// .test.mjs):
//
//   1. frozen engine (live pid + heartbeat older than the stale threshold)
//      → guarded kill + direct resume-restart + durable audit rows
//      (freeze_detected / restart_attempted / restart_succeeded);
//   2. healthy engine (fresh heartbeat) is not touched — and the LEGACY
//      fallback (no heartbeat file, fresh engine log mtime) reads healthy;
//   3. dead pid → one durable 'engine_dead' mark, no exception, no restart
//      (deduplicated across sweeps);
//   4. backoff ladder holds: an immediate second freeze defers, advancing the
//      clock past the interval re-treats;
//   5. restart budget (5 / 2h) exhausted → engine_state='failed_watchdog' +
//      last_error, no restart, no kill;
//   6. sweepBeforeSpawn: fresh+live blocks the duplicate (ok:'already-running'),
//      stale+live kills the corpse, dead pid lets the spawn proceed, and a
//      reused foreign pid is never killed.
//
// Tests run serially on ONE shared temp DB; every scenario starts from
// resetScenario() (fresh launch row + clean audit table).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { closeDb, getDb } from '../../dist/db.js';
import { initShared, withDb, withDbWrite } from '../../tracker-view/shared.mjs';
import { createEngineSupervisor } from '../../tracker-view/engine-supervisor.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-engine-supervisor-'));
const dbPath = path.join(temp, 'supervisor.db');
const engineLog = path.join(temp, 'saga-engine-test.log');
const heartbeatPath = `${engineLog}.heartbeat`;

const EPIC_ID = 7;
const PROJECT_ID = 7;
const ENGINE_PID = 4242;
const NEW_ENGINE_PID = 9001;

// --- fixture ---------------------------------------------------------------
process.env.DB_PATH = dbPath;
const db = getDb();
db.prepare("INSERT INTO projects (id,name) VALUES (7,'sup-p7')").run();
db.prepare("INSERT INTO epics (id,project_id,name) VALUES (7,7,'sup-e7')").run();
db.prepare(
  `INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state)
   VALUES ('ord-sup', 7, 7, 'idea_url', 'provisioned')`,
).run();
initShared({ dbPath, Database, workerLogRoots: [] });

let scenarioSeq = 0;

/** Fresh launch row + clean audit table + marker files with given ages. */
function resetScenario({ heartbeatAgeMs }) {
  scenarioSeq += 1;
  const launchRef = `launch-sup-${scenarioSeq}`;
  withDbWrite(handle => {
    handle.prepare('DELETE FROM factory_engine_watchdog_events').run();
    handle.prepare('DELETE FROM factory_launch_requests').run();
    handle.prepare(
      `INSERT INTO factory_launch_requests
         (launch_ref, order_ref, mode, project_id, epic_id, initiated_by,
          idempotency_key, concurrency, state, engine_log_path, engine_pid, engine_spawned_at)
       VALUES (?, 'ord-sup', 'resume', 7, 7, 'test',
               ?, 1, 'running', ?, ?, datetime('now'))`,
    ).run(launchRef, `idem-${launchRef}`, engineLog, ENGINE_PID);
  });
  const now = Date.now();
  writeFileSync(engineLog, 'engine log line\n');
  writeFileSync(heartbeatPath, '');
  utimesSync(engineLog, new Date(now - heartbeatAgeMs), new Date(now - heartbeatAgeMs));
  utimesSync(heartbeatPath, new Date(now - heartbeatAgeMs), new Date(now - heartbeatAgeMs));
  return launchRef;
}

function makeDeps() {
  const alive = new Set();
  const killed = [];
  const restarts = [];
  const brakeDeps = {
    isAlive: pid => alive.has(pid),
    readCommandLine: pid => (alive.has(pid)
      ? `node D:\\repo\\dist\\orchestrate-cli.js --launch-ref=x (pid ${pid})`
      : null),
    killTree: pid => {
      killed.push(pid);
      alive.delete(pid);
      return true;
    },
  };
  const sagaApplication = {
    startEngine(command) {
      restarts.push(command);
      alive.add(NEW_ENGINE_PID);
      return { running: true, pid: NEW_ENGINE_PID, epicId: command.epicId };
    },
  };
  return { alive, killed, restarts, brakeDeps, sagaApplication };
}

function makeSupervisor(deps, now) {
  return createEngineSupervisor({
    withDb,
    withDbWrite,
    sagaApplication: deps.sagaApplication,
    brakeDeps: deps.brakeDeps,
    ...(now ? { now } : {}),
  });
}

function events() {
  return withDb(handle => handle.prepare(
    `SELECT kind, reason, engine_pid, heartbeat_age_ms, detail
       FROM factory_engine_watchdog_events ORDER BY rowid`,
  ).all());
}

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// --- 1. freeze treatment ---------------------------------------------------

test('frozen engine (live pid, stale heartbeat) → guarded kill + restart + durable audit', () => {
  resetScenario({ heartbeatAgeMs: 10 * 60_000 }); // 10 min stale, threshold 120s
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  const supervisor = makeSupervisor(deps);

  const result = supervisor.sweepOnce();

  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0].verdict, 'freeze_treated');
  // The frozen engine host was killed by pid, a fresh engine started through
  // the panel resume code path (direct call, no HTTP).
  assert.deepEqual(deps.killed, [ENGINE_PID]);
  assert.deepEqual(deps.restarts, [{ epicId: EPIC_ID }]);
  // Durable receipts: freeze + attempt + outcome, with the stale-heartbeat
  // reason the operator can grep.
  assert.deepEqual(events().map(event => event.kind),
    ['freeze_detected', 'restart_attempted', 'restart_succeeded']);
  const freeze = events()[0];
  assert.equal(freeze.reason, 'engine_watchdog_heartbeat_stale');
  assert.equal(freeze.engine_pid, ENGINE_PID);
  assert.ok(freeze.heartbeat_age_ms >= 10 * 60_000);
});

// --- 2. healthy engines are untouched --------------------------------------

test('healthy engine (fresh heartbeat) is not touched', () => {
  resetScenario({ heartbeatAgeMs: 2_000 });
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  const supervisor = makeSupervisor(deps);

  const result = supervisor.sweepOnce();

  assert.equal(result.verdicts[0].verdict, 'healthy');
  assert.deepEqual(deps.killed, []);
  assert.deepEqual(deps.restarts, []);
  assert.deepEqual(events(), []);
});

test('LEGACY fallback: no heartbeat file, fresh engine log mtime reads healthy', () => {
  resetScenario({ heartbeatAgeMs: 3_000 });
  rmSync(heartbeatPath, { force: true });
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  const supervisor = makeSupervisor(deps);

  const result = supervisor.sweepOnce();
  assert.equal(result.verdicts[0].verdict, 'healthy');
  assert.deepEqual(deps.restarts, []);
});

// --- 3. dead pid → mark only ------------------------------------------------

test('dead pid → one engine_dead mark, no exception, no restart, deduplicated', () => {
  resetScenario({ heartbeatAgeMs: 3_000 });
  const deps = makeDeps(); // ENGINE_PID not added to alive → dead
  const supervisor = makeSupervisor(deps);

  const first = supervisor.sweepOnce();
  const second = supervisor.sweepOnce();

  assert.equal(first.verdicts[0].verdict, 'engine_dead');
  assert.equal(second.verdicts[0].verdict, 'engine_dead');
  const marks = events().filter(event => event.kind === 'engine_dead');
  assert.equal(marks.length, 1, 'repeated sweeps do not spam the audit table');
  assert.equal(marks[0].reason, 'engine_watchdog_pid_dead');
  assert.deepEqual(deps.killed, []);
  assert.deepEqual(deps.restarts, []);
});

// --- 4. backoff ladder --------------------------------------------------------

test('backoff interval holds: immediate re-freeze defers, clock advance re-treats', () => {
  resetScenario({ heartbeatAgeMs: 15 * 60_000 });
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  const clock = { offsetMs: 0 };
  const supervisor = makeSupervisor(deps, () => Date.now() + clock.offsetMs);

  // First freeze: attempt #1 happens immediately.
  supervisor.sweepOnce();
  assert.equal(deps.restarts.length, 1);

  // The restarted engine "freezes again" right away (same markers, live pid).
  deps.alive.add(ENGINE_PID);
  const deferred = supervisor.sweepOnce();
  assert.equal(deferred.verdicts[0].verdict, 'freeze_treated');
  assert.deepEqual(deferred.verdicts[0].events, ['deferred'], 'backoff defers the 2nd restart');
  assert.equal(deps.restarts.length, 1, 'no restart happened during backoff');
  assert.equal(events().filter(event => event.kind === 'restart_attempted').length, 1);

  // Advance the clock past the 1-minute first rung → attempt #2 proceeds.
  clock.offsetMs = 2 * 60_000;
  deps.alive.add(ENGINE_PID);
  const treated = supervisor.sweepOnce();
  assert.deepEqual(treated.verdicts[0].events,
    ['freeze_detected', 'restart_attempted', 'restart_succeeded']);
  assert.equal(deps.restarts.length, 2);
});

// --- 5. budget exhaustion -----------------------------------------------------

test('restart budget exhausted → failed_watchdog + last_error, no restart, no kill', () => {
  resetScenario({ heartbeatAgeMs: 30 * 60_000 });
  const launchRef = withDb(handle => handle.prepare(
    'SELECT launch_ref FROM factory_launch_requests',
  ).get()).launch_ref;
  // Seed a full budget of prior watchdog restarts inside the 2h window.
  withDbWrite(handle => {
    const insert = handle.prepare(
      `INSERT INTO factory_engine_watchdog_events
         (event_ref, project_id, epic_id, launch_ref, kind, reason)
       VALUES (?, 7, 7, ?, 'restart_attempted', 'engine_watchdog_heartbeat_stale')`,
    );
    for (let i = 0; i < 5; i += 1) insert.run(`wd-seed-${i}-${launchRef}`, launchRef);
  });
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  const supervisor = makeSupervisor(deps);

  const result = supervisor.sweepOnce();

  assert.deepEqual(result.verdicts[0].events, ['freeze_detected', 'attempts_exhausted']);
  assert.deepEqual(deps.restarts, [], 'no 6th restart attempt');
  assert.deepEqual(deps.killed, [], 'exhaustion marks, it does not kill');
  assert.ok(events().map(event => event.kind).includes('attempts_exhausted'));
  const control = withDb(handle => handle.prepare(
    'SELECT engine_state, last_error FROM lifecycle_execution_controls WHERE epic_id=?',
  ).get(EPIC_ID));
  assert.equal(control.engine_state, 'failed_watchdog');
  assert.match(control.last_error, /restart budget exhausted/);
});

// --- 6. single-engine sweep before spawn --------------------------------------

test('sweepBeforeSpawn: live + fresh heartbeat blocks the duplicate spawn', () => {
  resetScenario({ heartbeatAgeMs: 5_000 });
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  const supervisor = makeSupervisor(deps);

  const verdict = supervisor.sweepBeforeSpawn({ projectId: PROJECT_ID, epicId: EPIC_ID });
  assert.equal(verdict.ok, 'already-running');
  assert.equal(verdict.action, 'already_running');
  assert.equal(verdict.engine_pid, ENGINE_PID);
  assert.deepEqual(deps.killed, []);
});

test('sweepBeforeSpawn: live + stale heartbeat kills the frozen corpse first', () => {
  resetScenario({ heartbeatAgeMs: 10 * 60_000 });
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  const supervisor = makeSupervisor(deps);

  const verdict = supervisor.sweepBeforeSpawn({ projectId: PROJECT_ID, epicId: EPIC_ID });
  assert.equal(verdict.ok, 'spawn');
  assert.equal(verdict.action, 'killed_frozen');
  assert.deepEqual(deps.killed, [ENGINE_PID]);
  assert.ok(events().map(event => event.kind).includes('sweep_killed_frozen'),
    'durable sweep receipt');
});

test('sweepBeforeSpawn: dead pid lets the spawn proceed without cleanup', () => {
  resetScenario({ heartbeatAgeMs: 10 * 60_000 });
  const deps = makeDeps(); // dead pid — nothing to clean
  const supervisor = makeSupervisor(deps);

  const verdict = supervisor.sweepBeforeSpawn({ projectId: PROJECT_ID, epicId: EPIC_ID });
  assert.equal(verdict.ok, 'spawn');
  assert.equal(verdict.action, 'none');
  assert.deepEqual(deps.killed, []);
});

test('sweepBeforeSpawn never kills a live pid that is not orchestrate-cli.js (pid reuse)', () => {
  resetScenario({ heartbeatAgeMs: 10 * 60_000 });
  const deps = makeDeps();
  deps.alive.add(ENGINE_PID);
  deps.brakeDeps.readCommandLine = () => 'C:\\Program Files\\unrelated.exe --service';
  const supervisor = makeSupervisor(deps);

  const verdict = supervisor.sweepBeforeSpawn({ projectId: PROJECT_ID, epicId: EPIC_ID });
  assert.equal(verdict.action, 'kill_failed', 'a foreign live pid is never killed');
  assert.deepEqual(deps.killed, []);
  assert.equal(events().at(-1).kind, 'sweep_blocked_live');
});
