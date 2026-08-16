// tests/architecture/supervision-pid-guard.test.mjs
//
// FIX 1 (2026-08-16 incident, project 4) — supervision sweep PID liveness +
// PID-reuse guard. A worker died silently; Windows reused its PID for an
// unrelated process; process existence then reported "alive" forever while
// renewLeases kept the heartbeat fresh, so the sweep reported kept=1
// leases_renewed=1 for ~3 hours and one stuck task froze the whole engine.
//
// Coverage (real OS processes on throwaway temp DBs — the
// operator-soft-stop-process.test.mjs pattern; nothing here touches
// .factory-testbed):
//   (a) dead-PID execution is marked lost and NOT renewed;
//   (b) PID-reuse guard: a live PID with a FOREIGN recorded identity is
//       treated as dead-for-this-execution (released once the heartbeat is
//       stale; renewal WITHHELD while the heartbeat is fresh; never killed);
//   (c) live fresh-heartbeat execution with a MATCHING identity is kept and
//       renewed exactly as today;
//   (d) voided execution (schema v13) is never touched by the guard;
//   (w) service seam: the sweep passes renewal exclusions to renewLeases and
//       counts lost_dead_pid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { closeDb, getDb } from '../../dist/db.js';
import {
  REAL_PROCESS_PROBE,
  isProcessAlive,
  readProcessBirthToken,
  reconcileWorkerExecutions,
} from '../../dist/worker-executions.js';
import { SqliteExecutionRuntimeRepository } from '../../dist/infrastructure/persistence/sqlite-factory-runtime-repositories.js';
import { startWorkerSupervision } from '../../dist/infrastructure/work/worker-supervision-service.js';
import { PID_GUARD_HEARTBEAT_STALE_MS } from '../../dist/lifecycle/stuck-policy.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-pid-guard-'));
const dbPath = path.join(temp, 'pid-guard.db');
// renewLeases resolves the GLOBAL db handle (getDb()); point it at the temp
// DB before any repository call. getDb() is lazy, so module import order is
// safe.
process.env.DB_PATH = dbPath;

function freshDb() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  // One shared temp file (getDb() caches a connection per DB_PATH); reset the
  // tables each test so the fixed surrogate ids never collide.
  db.prepare('DELETE FROM worker_executions').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM supervision_locks').run();
  db.prepare("INSERT OR IGNORE INTO projects (id,name) VALUES (1,'pid-guard-test')").run();
  db.prepare("INSERT OR IGNORE INTO epics (id,project_id,name) VALUES (1,1,'e')").run();
  return db;
}

/** Spawn a throwaway long-running node child and wait for its pid to be alive. */
function spawnThrowaway(marker = 'setInterval(() => {}, 1000)') {
  const child = spawn(process.execPath, ['-e', marker], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadline = Date.now() + 5000;
  while (!isProcessAlive(child.pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!isProcessAlive(child.pid)) throw new Error('throwaway child failed to start');
  return child;
}

/**
 * Insert one fenced RUNNING execution exactly like the production runner
 * does (markExecutionRunning shape: state='running', pid + birth token),
 * with an explicit heartbeat age and identity.
 */
function insertRunningExecution(db, {
  executionId,
  pid,
  birthToken,
  heartbeatAgeMs,
  voidedAt = null,
}) {
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,assigned_to,current_execution_id)
     VALUES (1,1,'pid-guard-task','in_progress','pid-guard-worker',?)`,
  ).run(executionId);
  const heartbeat = heartbeatAgeMs === null
    ? null
    : new Date(Date.now() - heartbeatAgeMs).toISOString();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        state,phase,pid,process_birth_token,heartbeat_at,lease_expires_at,
        stuck_state,voided_at,reserved_at,phase_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
  ).run(
    executionId, 'run-1', 1, 1, 1, 'pid-guard-worker', os.hostname(),
    'running', 'executing', pid, birthToken, heartbeat,
    new Date(Date.now() + 60_000).toISOString(),
    'active', voidedAt, new Date(Date.now() - 60_000).toISOString(),
  );
}

const REAL = { processProbe: REAL_PROCESS_PROBE, hostname: os.hostname() };

test.after(() => {
  closeDb();
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// (a) dead-PID execution is marked lost and NOT renewed.
// ---------------------------------------------------------------------------
test('(a) sweep marks a dead-PID execution lost and does not renew it', () => {
  const db = freshDb();
  const child = spawnThrowaway();
  const token = readProcessBirthToken(child.pid);
  assert.ok(token, 'birth token readable for the live child');
  insertRunningExecution(db, {
    executionId: 'exec-dead-pid',
    pid: child.pid,
    birthToken: token,
    // Heartbeat FRESH on purpose: the dead-PID release path must not depend
    // on the new stale-heartbeat gate (it is the pre-existing notAlive path).
    heartbeatAgeMs: 5_000,
  });
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch { /* already dead */ }
  const deadline = Date.now() + 5000;
  while (isProcessAlive(child.pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.equal(isProcessAlive(child.pid), false, 'child is dead before the sweep');

  const results = reconcileWorkerExecutions(db, 1, 1, Date.now(), REAL);
  const result = results.find(r => r.executionId === 'exec-dead-pid');
  assert.ok(result, 'a result row exists for the dead-PID execution');
  assert.equal(result.action, 'lost', 'dead-PID execution classified lost');
  assert.equal(result.released, true, 'card returned to the queue');
  assert.equal(result.lostViaDeadPid, true, 'counted toward lost_dead_pid');

  const row = db.prepare(
    'SELECT state FROM worker_executions WHERE execution_id=?',
  ).get('exec-dead-pid');
  assert.equal(row.state, 'lost', 'execution row is terminal lost');

  // Not renewed: the row left the active states, so renewLeases must skip it.
  const repo = new SqliteExecutionRuntimeRepository();
  const renewed = repo.renewLeases(1, 1, 5 * 60_000);
  assert.equal(renewed, 0, 'a lost execution is not renewed');
  db.close();
});

// ---------------------------------------------------------------------------
// (b) PID-reuse guard — a live PID whose recorded identity differs is
//     dead-for-this-execution. Two phases: fresh heartbeat → renewal
//     withheld; stale heartbeat → released as lost. Never killed.
// ---------------------------------------------------------------------------
test('(b) live PID with a FOREIGN recorded identity: withheld, then lost once the heartbeat ages; never killed', () => {
  const db = freshDb();
  const child = spawnThrowaway();
  const liveToken = readProcessBirthToken(child.pid);
  assert.ok(liveToken, 'birth token readable for the live child');
  insertRunningExecution(db, {
    executionId: 'exec-reused-pid',
    pid: child.pid,
    // The recorded identity deliberately DIFFERS from the live process: the
    // OS recycled this PID after the original worker died.
    birthToken: `recorded-identity-${liveToken}-FOREIGN`,
    heartbeatAgeMs: 5_000, // fresh — the guard must withhold, not release
  });

  try {
    // Phase 1: fresh heartbeat → kept with WITHHELD renewal.
    let results = reconcileWorkerExecutions(db, 1, 1, Date.now(), REAL);
    let result = results.find(r => r.executionId === 'exec-reused-pid');
    assert.ok(result, 'a result row exists for the reused-PID execution');
    assert.equal(result.action, 'kept', 'fresh heartbeat: kept for now');
    assert.equal(result.withholdRenewal, true, 'renewal is withheld');
    assert.equal(result.released, false, 'card still fenced in phase 1');
    assert.equal(isProcessAlive(child.pid), true, 'the unrelated live process was NOT killed');

    // The exclusion is what makes the heartbeat age.
    const repo = new SqliteExecutionRuntimeRepository();
    assert.equal(
      repo.renewLeases(1, 1, 5 * 60_000, ['exec-reused-pid']),
      0,
      'renewLeases skips the withheld execution',
    );
    assert.equal(
      repo.renewLeases(1, 1, 5 * 60_000),
      1,
      'without the exclusion the row would still be renewed (old behavior)',
    );

    // Phase 2: heartbeat now stale past the guard threshold → lost.
    db.prepare(
      'UPDATE worker_executions SET heartbeat_at=? WHERE execution_id=?',
    ).run(new Date(Date.now() - PID_GUARD_HEARTBEAT_STALE_MS - 1_000).toISOString(), 'exec-reused-pid');
    results = reconcileWorkerExecutions(db, 1, 1, Date.now(), REAL);
    result = results.find(r => r.executionId === 'exec-reused-pid');
    assert.equal(result.action, 'lost', 'stale heartbeat: released as lost');
    assert.equal(result.released, true, 'card returned to the queue');
    assert.equal(result.lostViaDeadPid, true, 'counted toward lost_dead_pid');
    assert.match(result.reason, /foreign/, 'reason names the foreign-PID classification');
    assert.equal(isProcessAlive(child.pid), true, 'the unrelated live process was STILL not killed');

    const task = db.prepare(
      'SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=1',
    ).get();
    assert.equal(task.status, 'todo', 'task restored to the queue');
    assert.equal(task.assigned_to, null, 'assignment cleared');
    assert.equal(task.current_execution_id, null, 'fence cleared');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    db.close();
  }
});

// ---------------------------------------------------------------------------
// (c) live fresh-heartbeat execution with a MATCHING identity: kept and
//     renewed exactly as before the fix.
// ---------------------------------------------------------------------------
test('(c) live fresh-heartbeat execution is kept and renewed as today', () => {
  const db = freshDb();
  const child = spawnThrowaway();
  const token = readProcessBirthToken(child.pid);
  assert.ok(token, 'birth token readable for the live child');
  insertRunningExecution(db, {
    executionId: 'exec-live-pid',
    pid: child.pid,
    birthToken: token, // MATCHING identity
    heartbeatAgeMs: 5_000,
  });
  try {
    const results = reconcileWorkerExecutions(db, 1, 1, Date.now(), REAL);
    const result = results.find(r => r.executionId === 'exec-live-pid');
    assert.ok(result, 'a result row exists for the live execution');
    assert.equal(result.action, 'kept', 'live execution kept');
    assert.equal(result.released, false, 'card untouched');
    assert.equal(result.withholdRenewal, undefined, 'renewal NOT withheld');
    assert.equal(result.lostViaDeadPid, undefined, 'not classified dead');
    assert.equal(isProcessAlive(child.pid), true, 'live worker untouched');

    const repo = new SqliteExecutionRuntimeRepository();
    assert.equal(repo.renewLeases(1, 1, 5 * 60_000), 1, 'lease renewed as today');
    const row = db.prepare(
      'SELECT state, heartbeat_at FROM worker_executions WHERE execution_id=?',
    ).get('exec-live-pid');
    assert.equal(row.state, 'running', 'still running');
    assert.ok(row.heartbeat_at !== null, 'heartbeat stamped by the renewal');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    db.close();
  }
});

// ---------------------------------------------------------------------------
// (d) voided execution (operator soft-stop, schema v13) is never touched by
//     the guard — even with a foreign identity and a stale heartbeat.
// ---------------------------------------------------------------------------
test('(d) voided execution is never touched by the PID guard', () => {
  const db = freshDb();
  const child = spawnThrowaway();
  const liveToken = readProcessBirthToken(child.pid);
  assert.ok(liveToken, 'birth token readable for the live child');
  insertRunningExecution(db, {
    executionId: 'exec-voided',
    pid: child.pid,
    birthToken: `recorded-identity-${liveToken}-FOREIGN`,
    heartbeatAgeMs: PID_GUARD_HEARTBEAT_STALE_MS + 60_000, // stale
    voidedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  try {
    const results = reconcileWorkerExecutions(db, 1, 1, Date.now(), REAL);
    const result = results.find(r => r.executionId === 'exec-voided');
    assert.ok(result, 'a result row exists for the voided execution');
    assert.notEqual(result.action, 'lost', 'voided execution NOT classified lost by the guard');
    assert.equal(result.released, false, 'card untouched');
    assert.equal(result.lostViaDeadPid, undefined, 'not counted toward lost_dead_pid');
    assert.equal(result.withholdRenewal, undefined, 'guard skipped the voided row entirely');

    const row = db.prepare(
      'SELECT state, voided_at FROM worker_executions WHERE execution_id=?',
    ).get('exec-voided');
    assert.equal(row.state, 'running', 'execution row untouched');
    const task = db.prepare(
      'SELECT current_execution_id FROM tasks WHERE id=1',
    ).get();
    assert.equal(task.current_execution_id, 'exec-voided', 'fence intact');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    db.close();
  }
});

// ---------------------------------------------------------------------------
// (w) service seam: the sweep forwards renewal exclusions and reports
//     lost_dead_pid on the result.
// ---------------------------------------------------------------------------
test('(w) supervision sweep wires exclusions into renewLeases and counts lost_dead_pid', () => {
  const db = freshDb();
  const renewCalls = [];
  const runtime = {
    reconcile: () => [
      {
        executionId: 'exec-withheld', taskId: 1, action: 'kept', released: false,
        reason: 'PID alive but foreign (reuse suspected); renewal withheld until heartbeat stale',
        withholdRenewal: true,
      },
      {
        executionId: 'exec-lost', taskId: 2, action: 'lost', released: true,
        reason: 'worker PID dead or reused by a foreign process',
        lostViaDeadPid: true,
      },
    ],
    renewLeases: (projectId, epicId, ttlMs, excludeExecutionIds) => {
      renewCalls.push({ projectId, epicId, ttlMs, excludeExecutionIds });
      return 0;
    },
    reportProgress: () => false,
  };
  const lines = [];
  const handle = startWorkerSupervision({
    executionRuntime: runtime,
    projectId: 1,
    epicId: 1,
    db,
    log: m => lines.push(m),
  });
  try {
    const result = handle.reconcileOnce();
    assert.equal(result.lostDeadPidCount, 1, 'lost_dead_pid counted from the projection');
    // startWorkerSupervision already ran its startup sweep; reconcileOnce ran
    // a second one. Every sweep must forward the exclusions.
    assert.equal(renewCalls.length, 2, 'renewLeases called once per sweep (startup + on-demand)');
    assert.deepEqual(
      renewCalls[1].excludeExecutionIds,
      ['exec-withheld'],
      'withheld execution passed as a renewal exclusion',
    );
    assert.ok(
      lines.some(l => l.includes('lost_dead_pid=1')),
      `sweep line carries lost_dead_pid: ${lines.join(' | ')}`,
    );
    assert.ok(
      lines.some(l => l.includes('renewal withheld execution=exec-withheld')),
      'withheld row gets its own audit line',
    );
  } finally {
    handle.stop();
    db.close();
  }
});
