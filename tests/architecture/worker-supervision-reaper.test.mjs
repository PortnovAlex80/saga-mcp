/**
 * WorkerSupervisionService tests — the watchman acceptance gate.
 *
 * CONVEYOR-MENTAL-MODEL §"Foreman, watchman and escaped/tired workers" +
 * baseline gap: reconcileWorkerExecutions() existed but had no production
 * scheduling call, so crashed runners left fenced zombie cards. The supervision
 * service closes that gap.
 *
 * These tests prove the watchman:
 *   - runs a startup sweep that reaps orphaned executions and releases cards
 *   - is idempotent (a reaped execution is not reaped twice)
 *   - returns a structured result describing what happened
 *   - stops cleanly
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { handlers as dispatcher } from '../../dist/tools/dispatcher.js';
import { SqliteExecutionRuntimeRepository } from '../../dist/infrastructure/persistence/sqlite-factory-runtime-repositories.js';
import { startWorkerSupervision } from '../../dist/infrastructure/work/worker-supervision-service.js';
import { reconcileWorkerExecutions } from '../../dist/worker-executions.js';
import { releaseExecutionAtomically } from '../../dist/lifecycle/atomic-release.js';
import { decide } from '../../dist/lifecycle/domain/evolve.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-sv-'));
process.env.DB_PATH = path.join(temp, 'sv.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

/** Stamp process_run_id onto a task — the saga4 authority gate. */
function stampProcessRun(taskId, processRunId = 1) {
  const db = getDb();
  const row = db.prepare(
    `SELECT t.metadata,t.epic_id,e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?`,
  ).get(taskId);
  db.prepare(
    `INSERT OR IGNORE INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
       executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,?,?,'test-module','1.0.0','test-module@1.0.0',?,
             'generic-flow','test.input.v1','{}',?,'running')`,
  ).run(processRunId, row.project_id, row.epic_id, `test-process:${processRunId}`, 'a'.repeat(64));
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
  meta.process_run_id = processRunId;
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), taskId);
}

test('supervision preserves verifying when accepted worker_done races physical close', () => {
  const { projectId, epicId } = setupProject();
  const zombie = createZombie(projectId, epicId);
  const db = getDb();
  const workplace = db.prepare(
    'SELECT workplace_ref FROM tasks WHERE id=?',
  ).get(zombie.taskId);
  assert.ok(workplace?.workplace_ref);

  db.prepare(
    `UPDATE factory_workplaces SET loop_state='verifying',revision=revision+1
      WHERE workplace_ref=?`,
  ).run(workplace.workplace_ref);
  db.prepare(
    `INSERT INTO command_receipts
       (command_id,command_kind,actor_kind,actor_id,task_id,execution_id,
        payload_hash,accepted,result_json,reply_json)
     VALUES (?, 'worker_done', 'managed_execution', NULL, ?, ?,
             'semantic-done', 1, '{}', '{}')`,
  ).run(`cmd-semantic-done-${zombie.taskId}`, zombie.taskId, zombie.executionId);

  const handle = startWorkerSupervision({
    executionRuntime: new SqliteExecutionRuntimeRepository(),
    projectId,
    epicId,
    intervalMs: 60_000,
  });

  assert.equal(
    db.prepare('SELECT state FROM worker_executions WHERE execution_id=?')
      .get(zombie.executionId).state,
    'lost',
  );
  assert.equal(
    db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?')
      .get(workplace.workplace_ref).loop_state,
    'verifying',
  );
  assert.equal(
    db.prepare('SELECT current_execution_id FROM tasks WHERE id=?')
      .get(zombie.taskId).current_execution_id,
    null,
  );
  handle.stop();
});

function setupProject() {
  const p = projects.project_create({ name: `sv-test-${Date.now()}` });
  const e = epics.epic_create({ project_id: p.id, name: 'SV epic' });
  return { projectId: p.id, epicId: e.id };
}

/**
 * Create a fenced zombie: a card assigned + a worker_executions row whose OS
 * process is provably dead (no such PID). This is the exact state a crashed
 * runner leaves behind.
 */
function createZombie(projectId, epicId) {
  const task = tasks.task_create({ epic_id: epicId, title: 'orphaned' });
  stampProcessRun(task.id);
  // Claim the card through worker_next with an execution_id — this flips status,
  // sets the fence, and inserts a worker_executions row.
  const claimed = dispatcher.worker_next({
    worker_id: 'zombie-worker',
    project_id: projectId,
    machine_id: os.hostname(),
    execution_id: `exec-zombie-${task.id}`,
    run_id: 'sv-run',
    task_ids: [task.id],
  });
  assert.ok(claimed.task, 'worker_next must claim the card to set up the zombie');
  // Simulate the worker process dying without a close callback: mark the
  // execution 'running' with a PID that does not exist (so isProcessAlive
  // returns false). reconcileWorkerExecutions will then reap it.
  getDb().prepare(
    `UPDATE worker_executions SET state='running', pid=?, started_at=datetime('now','-10 minutes'), phase_updated_at=datetime('now','-10 minutes') WHERE execution_id=?`,
  ).run(999999, `exec-zombie-${task.id}`);
  return { taskId: task.id, executionId: `exec-zombie-${task.id}` };
}

test('startup sweep reaps an orphaned execution into durable repair_wait', () => {
  const { projectId, epicId } = setupProject();
  const zombie = createZombie(projectId, epicId);

  // Before supervision: card is fenced (in_progress, assigned, fenced).
  const before = getDb().prepare(
    'SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?',
  ).get(zombie.taskId);
  assert.equal(before.status, 'in_progress');
  assert.equal(before.assigned_to, 'zombie-worker');
  assert.equal(before.current_execution_id, zombie.executionId);

  // Start the watchman — runs a startup sweep immediately.
  const executionRuntime = new SqliteExecutionRuntimeRepository();
  const messages = [];
  const handle = startWorkerSupervision({
    executionRuntime,
    projectId,
    epicId,
    intervalMs: 60_000, // long; the startup sweep is what we test
    log: (m) => messages.push(m),
  });

  // After startup sweep the physical fence is cleared and the universal
  // Workplace records repair_wait. Kanban intentionally remains in_progress;
  // the next lifecycle reconciliation authorizes a fresh repair reservation.
  const after = getDb().prepare(
    'SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?',
  ).get(zombie.taskId);
  assert.equal(after.status, 'in_progress', 'Kanban phase is not rolled back');
  assert.equal(after.assigned_to, null, 'assignment cleared');
  assert.equal(after.current_execution_id, null, 'fence cleared');
  assert.equal(
    getDb().prepare(
      `SELECT w.loop_state FROM factory_workplaces w
        JOIN tasks t ON t.workplace_ref=w.workplace_ref WHERE t.id=?`,
    ).get(zombie.taskId).loop_state,
    'repair_wait',
  );

  const execRow = getDb().prepare(
    'SELECT state FROM worker_executions WHERE execution_id=?',
  ).get(zombie.executionId);
  assert.equal(execRow.state, 'lost', 'execution marked lost by the reaper');

  assert.ok(
    messages.some((m) => m.includes('REAPED') && m.includes(zombie.executionId)),
    'an audit event was emitted for the reaped execution',
  );

  handle.stop();
});

test('reaper is idempotent — a second sweep is a no-op for already-reaped executions', () => {
  const { projectId, epicId } = setupProject();
  const executionRuntime = new SqliteExecutionRuntimeRepository();
  // Start supervision FIRST (clean state), then create a zombie and reap it
  // explicitly via reconcileOnce. The startup sweep must not consume the zombie
  // before this test's logic runs.
  const handle = startWorkerSupervision({
    executionRuntime,
    projectId,
    epicId,
    intervalMs: 60_000,
  });
  const zombie = createZombie(projectId, epicId);
  // First explicit sweep reaps.
  const first = handle.reconcileOnce();
  assert.ok(first.reapedCount >= 1, 'first sweep reaps the zombie');
  // Second sweep finds nothing active — the execution is already terminal.
  const second = handle.reconcileOnce();
  assert.equal(second.reapedCount, 0, 'second sweep is a no-op (already terminal)');
  handle.stop();
});

test('supervision stop() halts the periodic timer', () => {
  const { projectId, epicId } = setupProject();
  const executionRuntime = new SqliteExecutionRuntimeRepository();
  const handle = startWorkerSupervision({
    executionRuntime,
    projectId,
    epicId,
    intervalMs: 10,
  });
  // stop() must be idempotent and not throw.
  assert.doesNotThrow(() => handle.stop());
  assert.doesNotThrow(() => handle.stop());
});

/**
 * CONVEYOR scenario 13: killing a worker process without a close callback
 * causes the periodic reaper to mark it lost and return its card. Covered by
 * the 'startup sweep reaps an orphaned execution' test above (PID 999999 dead).
 */

/**
 * CONVEYOR scenario 14: killing the parent runner causes lease expiry and
 * recovery by a new runtime instance. When the supervisor stops renewing the
 * lease (it died with the runner), lease_expires_at passes; a subsequent sweep
 * by a new runtime reaps the now-dead execution.
 */
test('expired lease + dead process is reaped (parent runner death recovery)', () => {
  const { projectId, epicId } = setupProject();
  const executionRuntime = new SqliteExecutionRuntimeRepository();
  // Start supervision first (clean state), THEN create the zombie so the
  // startup sweep does not consume it before this test's explicit reconcile.
  const handle = startWorkerSupervision({ executionRuntime, projectId, epicId, intervalMs: 60_000 });
  const zombie = createZombie(projectId, epicId);
  // Simulate the parent runner dying: lease already expired (no renewal), PID dead.
  getDb().prepare(
    `UPDATE worker_executions SET lease_expires_at=datetime('now','-1 hour') WHERE execution_id=?`,
  ).run(zombie.executionId);

  const result = handle.reconcileOnce();
  assert.ok(result.reapedCount >= 1, 'expired-lease dead execution is reaped');

  const after = getDb().prepare(
    'SELECT status, current_execution_id FROM tasks WHERE id=?',
  ).get(zombie.taskId);
  assert.equal(after.status, 'in_progress', 'Kanban phase is preserved for repair');
  assert.equal(after.current_execution_id, null, 'fence cleared');
  assert.equal(
    getDb().prepare(
      `SELECT w.loop_state FROM factory_workplaces w
        JOIN tasks t ON t.workplace_ref=w.workplace_ref WHERE t.id=?`,
    ).get(zombie.taskId).loop_state,
    'repair_wait',
  );
  handle.stop();
});

/**
 * CONVEYOR scenario 15: a live worker with no tool activity is NOT reassigned
 * before cancellation grace or its wall-clock deadline. The stuck policy must
 * advance through suspected_stuck → cancel_requested, NOT release an alive
 * process on the first sweep just because progress_at is old.
 *
 * We simulate "alive" with the current process's own PID (provably alive) and
 * a very old progress_at. The reaper must NOT release it on a single sweep —
 * it advances stuck_state instead.
 */
test('alive-but-silent worker is not falsely reaped (stuck policy advances, not releases)', () => {
  const { projectId, epicId } = setupProject();
  const task = tasks.task_create({ epic_id: epicId, title: 'slow worker' });
  stampProcessRun(task.id);
  const claimed = dispatcher.worker_next({
    worker_id: 'slow-worker',
    project_id: projectId,
    machine_id: os.hostname(),
    execution_id: `exec-slow-${task.id}`,
    run_id: 'sv-run',
    task_ids: [task.id],
  });
  assert.ok(claimed.task);
  // Simulate a LIVE worker (this process's PID is alive) that has been silent:
  // old progress_at, old heartbeat_at. A real alive process, so isProcessAlive
  // returns true. The reaper must NOT release it.
  const livePid = process.pid;
  getDb().prepare(
    `UPDATE worker_executions
       SET state='running', pid=?, process_birth_token=NULL,
           started_at=datetime('now','-20 minutes'),
           progress_at=datetime('now','-20 minutes'),
           heartbeat_at=datetime('now','-20 minutes'),
           lease_expires_at=datetime('now','+1 hour')
     WHERE execution_id=?`,
  ).run(livePid, `exec-slow-${task.id}`);

  const executionRuntime = new SqliteExecutionRuntimeRepository();
  const handle = startWorkerSupervision({ executionRuntime, projectId, epicId, intervalMs: 60_000 });
  const result = handle.reconcileOnce();
  assert.equal(result.reapedCount, 0, 'alive worker NOT reaped despite silent progress');

  // The card must still be fenced (not released).
  const after = getDb().prepare(
    'SELECT status, current_execution_id FROM tasks WHERE id=?',
  ).get(task.id);
  assert.equal(after.status, 'in_progress', 'card still held by the alive silent worker');
  assert.equal(after.current_execution_id, `exec-slow-${task.id}`, 'fence intact');

  // stuck_state advanced toward cancel (observed the silence). It may be
  // 'suspected_stuck' or 'cancel_requested' depending on elapsed time, but must
  // NOT be released.
  const exec = getDb().prepare(
    'SELECT stuck_state FROM worker_executions WHERE execution_id=?',
  ).get(`exec-slow-${task.id}`);
  assert.notEqual(exec.stuck_state, 'active', 'stuck policy advanced past active');
  handle.stop();
});

// ---------------------------------------------------------------------------
// CONVEYOR Wave 5 bug-fix tests. These cover the FULL stuck-policy transition
// chain (BUG 4), remote-dead-by-lease release (BUG 1), liveness-vs-progress
// separation (BUG 2) and reused-PID birth-token protection (scenario 16, BUG 3).
//
// We never spawn or kill real OS processes. A fake ProcessProbe controls every
// isAlive / readBirthToken / killVerified decision deterministically. Each fake
// records what killed it so the tests assert the verified kill actually fired.
// ---------------------------------------------------------------------------

/**
 * Build a fake ProcessProbe. `alivePids` is the set of PIDs isAlive() reports as
 * alive; `birthTokens` maps pid→token that readBirthToken returns; killVerified
 * only succeeds when the pid is alive AND its current token equals expected and
 * records the kill in `kills`.
 */
function fakeProbe({ alivePids = new Set(), birthTokens = new Map(), kills = [] } = {}) {
  return {
    isAlive: (pid) => pid != null && alivePids.has(pid),
    readBirthToken: (pid) => birthTokens.get(pid) ?? null,
    killVerified: (pid, expected) => {
      if (!alivePids.has(pid)) return false;
      if ((birthTokens.get(pid) ?? null) !== expected) return false;
      // "Kill" the fake process: drop it from the alive set.
      alivePids.delete(pid);
      kills.push({ pid, expected });
      return true;
    },
    _alivePids: alivePids,
    _kills: kills,
  };
}

/**
 * ISO timestamp `minutes` from now (negative = past). Pre-computed in JS so the
 * helper below can use bound parameters rather than embedding SQL expressions.
 */
function iso(minutesFromNow) {
  return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString();
}

/**
 * Parse a DB-stored timestamp into epoch ms. Accepts both full ISO
 * (`...Z`) and SQLite (`YYYY-MM-DD HH:MM:SS`) formats — mirrors parseDbTime in
 * worker-executions.ts. Robust against the double-Z that naive `+ 'Z'` produces.
 */
function parseDbMs(value) {
  if (!value) return 0;
  const s = String(value);
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/** Claim a card and stamp a worker_executions row with the given fields. */
function claimExecution(projectId, epicId, execId, overrides = {}) {
  const task = tasks.task_create({ epic_id: epicId, title: execId });
  stampProcessRun(task.id);
  const claimed = dispatcher.worker_next({
    worker_id: execId,
    project_id: projectId,
    machine_id: overrides.machine_id ?? os.hostname(),
    execution_id: execId,
    run_id: 'sv-run',
    task_ids: [task.id],
  });
  assert.ok(claimed.task, `worker_next must claim the card for ${execId}`);
  // Always parameterized — never embed values into the SQL string.
  const assignments = { state: 'running' };
  for (const [key, value] of Object.entries(overrides)) {
    assignments[key] = value;
  }
  const columns = Object.keys(assignments);
  const placeholders = columns.map((c) => `${c}=@${c}`).join(', ');
  getDb().prepare(
    `UPDATE worker_executions SET ${placeholders} WHERE execution_id=@execution_id`,
  ).run({ ...assignments, execution_id: execId });
  return { taskId: task.id, executionId: execId };
}

/**
 * BUG 1 — Remote-dead execution never released.
 *
 * CONVEYOR §"Worker is remote" + §"Foreman died": a remote/unverifiable PID must
 * still be released once its LEASE has expired. The decision to recover a
 * dead/disappeared foreman comes from the durable lease (lease_expires_at), not
 * from PID presence. A remote execution with a live lease is left alone.
 */
test('BUG 1: remote execution is released after lease expiry even though PID is unverifiable', () => {
  const { projectId, epicId } = setupProject();
  // Remote machine + expired lease. PID is unverifiable (different host).
  const expired = claimExecution(projectId, epicId, 'exec-remote-dead', {
    machine_id: 'other-host-001',
    pid: 4242,
    lease_expires_at: iso(-120),
    progress_at: iso(-120),
  });
  // Remote machine + LIVE lease. Must be left alone.
  const alive = claimExecution(projectId, epicId, 'exec-remote-alive', {
    machine_id: 'other-host-002',
    pid: 5353,
    lease_expires_at: iso(60),
    progress_at: iso(0),
  });

  const probe = fakeProbe();
  const results = reconcileWorkerExecutions(getDb(), projectId, epicId, Date.now(), {
    processProbe: probe,
    hostname: os.hostname(),
  });

  const expiredResult = results.find((r) => r.executionId === expired.executionId);
  assert.equal(expiredResult.action, 'lost', 'remote+expired-lease execution reaped');
  assert.equal(expiredResult.released, true, 'remote card returned to queue');

  const aliveResult = results.find((r) => r.executionId === alive.executionId);
  assert.equal(aliveResult.action, 'remote_unknown', 'remote+live-lease execution NOT touched');

  // The expired card is back in the queue; the alive one is still fenced.
  const expiredTask = getDb().prepare('SELECT status, current_execution_id FROM tasks WHERE id=?').get(expired.taskId);
  assert.equal(expiredTask.status, 'todo', 'expired remote card returned to todo');
  assert.equal(expiredTask.current_execution_id, null, 'expired remote fence cleared');

  const aliveTask = getDb().prepare('SELECT status, current_execution_id FROM tasks WHERE id=?').get(alive.taskId);
  assert.equal(aliveTask.status, 'in_progress', 'live-lease remote card still held');
  assert.equal(aliveTask.current_execution_id, alive.executionId, 'live-lease remote fence intact');

  // Idempotency: a second sweep is a no-op for the released execution.
  const second = reconcileWorkerExecutions(getDb(), projectId, epicId, Date.now(), {
    processProbe: probe, hostname: os.hostname(),
  });
  assert.equal(second.find((r) => r.executionId === expired.executionId), undefined,
    'already-released execution is not reprocessed');
});

/**
 * BUG 2 — Liveness renewal does not reset the progress-silence clock.
 *
 * renewLeases advances heartbeat_at (liveness) but MUST NOT advance progress_at
 * or the stuck clocks. A silent-but-alive worker whose heartbeat was just
 * renewed must STILL be detected as stuck once progress_at ages past grace.
 */
test('BUG 2: liveness lease renewal does not reset the progress-silence clock', () => {
  const { projectId, epicId } = setupProject();
  const exec = claimExecution(projectId, epicId, 'exec-silent-after-renew', {
    pid: 7700,
    process_birth_token: 'token-7700',
    progress_at: iso(-20), // progress silent 20 min ago
  });

  const repo = new SqliteExecutionRuntimeRepository({
    processProbe: fakeProbe({ alivePids: new Set([7700]), birthTokens: new Map([[7700, 'token-7700']]) }),
    hostname: os.hostname(),
  });
  // renewLeases advances lease_expires_at + heartbeat_at NOW, leaving progress_at
  // at its old value (20 min ago).
  const renewed = repo.renewLeases(projectId, epicId, 5 * 60 * 1000);
  assert.equal(renewed, 1, 'one local lease renewed');

  const row = getDb().prepare(
    'SELECT progress_at, heartbeat_at, lease_expires_at FROM worker_executions WHERE execution_id=?',
  ).get(exec.executionId);
  // heartbeat/lease moved forward, progress_at stayed stale — the crux of BUG 2.
  const age = Date.now() - parseDbMs(row.progress_at);
  assert.ok(age > 15 * 60 * 1000, 'progress_at was NOT reset by lease renewal');
  assert.ok(parseDbMs(row.heartbeat_at) > Date.now() - 60_000,
    'heartbeat_at (liveness) was renewed');

  // Because progress_at is still stale, reconcile must advance stuck_state.
  const results = repo.reconcile(projectId, epicId);
  const execResult = results.find((r) => r.executionId === exec.executionId);
  assert.equal(execResult.released, false, 'not released on first detection');
  const after = getDb().prepare('SELECT stuck_state FROM worker_executions WHERE execution_id=?').get(exec.executionId);
  assert.notEqual(after.stuck_state, 'active', 'stuck policy advanced despite liveness renewal');
});

/**
 * BUG 4 — Full stuck-policy transition chain end-to-end:
 *   active → suspected_stuck → cancel_requested → process killed → terminated
 *   → card released to the correct queue.
 *
 * Drives multiple reconcile sweeps with advancing fake time, asserting each
 * transition. The verified kill (BUG 3) must actually fire against the verified
 * PID before the card is released.
 */
test('BUG 4: stuck worker advances the full chain suspected→cancel→kill→terminated→released', () => {
  const { projectId, epicId } = setupProject();
  const kills = [];
  const alivePids = new Set([8800]);
  const birthTokens = new Map([[8800, 'token-8800']]);
  const probe = fakeProbe({ alivePids, birthTokens, kills });

  // progress_at is set to T0 (now). We advance fake time across sweeps.
  const exec = claimExecution(projectId, epicId, 'exec-stuck-chain', {
    pid: 8800, process_birth_token: 'token-8800',
    progress_at: iso(0), heartbeat_at: iso(0),
    lease_expires_at: iso(60),
  });

  const db = getDb();
  const opts = { processProbe: probe, hostname: os.hostname() };

  // Step 0 — rewind progress_at to 20 min ago and run the first sweep at T+20min.
  db.prepare('UPDATE worker_executions SET progress_at=? WHERE execution_id=?')
    .run(iso(-20), exec.executionId);
  let t = Date.now() + 20 * 60 * 1000;
  let r = reconcileWorkerExecutions(db, projectId, epicId, t, opts);
  let row = db.prepare('SELECT stuck_state, suspected_stuck_at FROM worker_executions WHERE execution_id=?').get(exec.executionId);
  assert.equal(row.stuck_state, 'suspected_stuck', 'progress silence advanced to suspected_stuck');
  assert.ok(row.suspected_stuck_at, 'suspected_stuck_at stamped');
  assert.equal(r.find((x) => x.executionId === exec.executionId)?.released, false, 'not released at suspected_stuck');

  // Step 1 — before cancel grace: stays suspected_stuck.
  t += 2 * 60 * 1000; // 2 min past suspicion — under the 5 min cancel grace
  r = reconcileWorkerExecutions(db, projectId, epicId, t, opts);
  row = db.prepare('SELECT stuck_state FROM worker_executions WHERE execution_id=?').get(exec.executionId);
  assert.equal(row.stuck_state, 'suspected_stuck', 'still suspected before cancel grace');

  // Step 2 — past cancel grace (5 min): advance to cancel_requested.
  t += 4 * 60 * 1000; // total 6 min past suspicion — over the 5 min grace
  r = reconcileWorkerExecutions(db, projectId, epicId, t, opts);
  row = db.prepare('SELECT stuck_state, cancel_requested_at FROM worker_executions WHERE execution_id=?').get(exec.executionId);
  assert.equal(row.stuck_state, 'cancel_requested', 'cancel requested after silence grace');
  assert.ok(row.cancel_requested_at, 'cancel_requested_at stamped');
  assert.equal(r.find((x) => x.executionId === exec.executionId)?.released, false, 'not released at cancel_requested');
  assert.equal(kills.length, 0, 'process NOT killed before the cancel grace elapses');

  // Step 3 — before kill grace (1 min): cancellation in flight, not yet killed.
  // (execution `state` stays `running`; only `stuck_state` is `cancel_requested`.)
  t += 30 * 1000; // 30s into cancel grace
  r = reconcileWorkerExecutions(db, projectId, epicId, t, opts);
  row = db.prepare('SELECT state, stuck_state FROM worker_executions WHERE execution_id=?').get(exec.executionId);
  assert.equal(row.stuck_state, 'cancel_requested', 'still in cancel grace (stuck_state)');
  assert.equal(row.state, 'running', 'execution state still running during cancel grace');
  assert.equal(kills.length, 0, 'not killed during cancel grace');

  // Step 4 — past kill grace (1 min): verified kill fires, then released.
  t += 31 * 1000; // 61s into cancel grace — over the 1 min kill grace
  r = reconcileWorkerExecutions(db, projectId, epicId, t, opts);
  const result = r.find((x) => x.executionId === exec.executionId);
  assert.equal(result.action, 'terminated', 'terminated after verified kill');
  assert.equal(result.released, true, 'card released');

  // BUG 3: the verified kill actually fired (not just the card release).
  assert.equal(kills.length, 1, 'the OS process was actually killed (BUG 3)');
  assert.equal(kills[0].pid, 8800);
  assert.equal(kills[0].expected, 'token-8800');

  row = db.prepare('SELECT state FROM worker_executions WHERE execution_id=?').get(exec.executionId);
  assert.equal(row.state, 'terminated', 'execution in terminal state');

  // Card returned to the correct queue (todo, since it was in_progress).
  const task = db.prepare('SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?').get(exec.taskId);
  assert.equal(task.status, 'todo', 'card returned to todo queue');
  assert.equal(task.assigned_to, null, 'assignment cleared');
  assert.equal(task.current_execution_id, null, 'fence cleared');

  // Idempotent: a subsequent sweep is a no-op.
  r = reconcileWorkerExecutions(db, projectId, epicId, t + 10_000, opts);
  assert.equal(r.find((x) => x.executionId === exec.executionId), undefined,
    'terminal execution is not reprocessed');
});

/**
 * BUG 3 + CONVEYOR scenario 16 — A reused PID with a different birth token is
 * NEVER killed and NEVER released. The original worker died; an unrelated
 * process now holds the same PID. Killing it would corrupt an innocent process,
 * so the execution is left for a human even though all graces have elapsed.
 */
test('scenario 16: reused PID with a different birth token is not killed and not released', () => {
  const { projectId, epicId } = setupProject();
  const kills = [];
  const alivePids = new Set([9900]);
  // The stored token no longer matches the live process (PID was reused).
  const probe = fakeProbe({
    alivePids,
    birthTokens: new Map([[9900, 'token-NEW-unrelated']]), // live process has a DIFFERENT token
    kills,
  });

  const exec = claimExecution(projectId, epicId, 'exec-pid-reuse', {
    pid: 9900,
    process_birth_token: 'token-ORIGINAL', // stored token differs from live
    progress_at: iso(-30),
    stuck_state: 'cancel_requested',
    cancel_requested_at: iso(-5), // kill grace long elapsed
    lease_expires_at: iso(60),
  });

  const r = reconcileWorkerExecutions(getDb(), projectId, epicId, Date.now(), {
    processProbe: probe, hostname: os.hostname(),
  });
  const result = r.find((x) => x.executionId === exec.executionId);
  assert.equal(result.action, 'kept', 'execution NOT terminated/released');
  assert.equal(result.released, false, 'card NOT released');
  assert.match(result.reason, /birth token changed/, 'reason explains PID-reuse protection');

  // The reused-PID process was NEVER killed.
  assert.equal(kills.length, 0, 'unrelated reused-PID process was NOT killed (scenario 16)');

  // Card still fenced.
  const task = getDb().prepare('SELECT status, current_execution_id FROM tasks WHERE id=?').get(exec.taskId);
  assert.equal(task.status, 'in_progress', 'card still fenced (left for human)');
  assert.equal(task.current_execution_id, exec.executionId, 'fence intact');
});

/**
 * Wave 2 Замечание 1 (critical) — Reserved execution must survive the FIRST
 * reaper sweep and only be released once RESERVED_BOOT_TIMEOUT_MS (60s) has
 * elapsed.
 *
 * Before the fix, `const alive = row.state === 'reserved' ? false : ...` made
 * `!alive` always true for reserved rows, so `if (!alive || reservedExpired ||
 * leaseExpired)` released the card on the very first sweep (~30s) — before the
 * 60s boot timeout. A card could be returned to the queue while the supervisor
 * was still mid-spawn.
 *
 * Fix: reserved rows are released ONLY by reservedExpired (or leaseExpired),
 * never by !alive — a null PID cannot be probed.
 *
 * The execution is created by worker_next (schema defaults: state='reserved',
 * pid=NULL, reserved_at=now). We drive reconcile with a fake clock and a probe
 * whose isAlive() we keep honest (reserved rows have no PID anyway).
 */
test('Wave 2 #1: reserved execution survives early sweeps, released only after 60s boot timeout', () => {
  const { projectId, epicId } = setupProject();
  // Claim a card — this inserts a worker_executions row in the DEFAULT state
  // 'reserved' with pid=NULL, which is the exact post-assignTask/pre-spawn
  // state the supervisor sweeps through.
  const task = tasks.task_create({ epic_id: epicId, title: 'reserved-boot' });
  stampProcessRun(task.id);
  const claimed = dispatcher.worker_next({
    worker_id: 'reserved-worker',
    project_id: projectId,
    machine_id: os.hostname(),
    execution_id: `exec-reserved-${task.id}`,
    run_id: 'sv-run',
    task_ids: [task.id],
  });
  assert.ok(claimed.task, 'worker_next must claim the card');
  const executionId = `exec-reserved-${task.id}`;

  // Pin reserved_at to a known instant so the boot-timeout arithmetic is
  // deterministic regardless of test-run clock jitter.
  const t0 = Date.now();
  const db = getDb();
  db.prepare('UPDATE worker_executions SET reserved_at=?, phase_updated_at=? WHERE execution_id=?')
    .run(new Date(t0).toISOString(), new Date(t0).toISOString(), executionId);

  // Sanity: the row really is the reserved/spawn-pending state under test.
  const initial = db.prepare(
    'SELECT state, pid FROM worker_executions WHERE execution_id=?',
  ).get(executionId);
  assert.equal(initial.state, 'reserved', 'execution starts in reserved state');
  assert.equal(initial.pid, null, 'reserved execution has no PID yet');

  // Honest probe: no PID means isAlive returns false; that is exactly the case
  // the OLD code mishandled (it then used !alive to release the card).
  const probe = fakeProbe({ alivePids: new Set() });
  const opts = { processProbe: probe, hostname: os.hostname() };

  // --- T+1s: before the 60s boot timeout. Must NOT release. -----------------
  let r = reconcileWorkerExecutions(db, projectId, epicId, t0 + 1_000, opts);
  let execResult = r.find((x) => x.executionId === executionId);
  // The execution must remain reserved: either not touched at all, or reported
  // as kept (definitely not 'lost'/'spawn_failed').
  if (execResult) {
    assert.notEqual(execResult.action, 'lost', 'reserved exec NOT released at T+1s');
    assert.equal(execResult.released, false, 'card NOT returned at T+1s');
  }

  let taskRow = db.prepare(
    'SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?',
  ).get(task.id);
  assert.equal(taskRow.status, 'in_progress', 'card still in_progress at T+1s');
  assert.equal(taskRow.assigned_to, 'reserved-worker', 'assignment intact at T+1s');
  assert.equal(taskRow.current_execution_id, executionId, 'fence intact at T+1s');

  let execRow = db.prepare('SELECT state FROM worker_executions WHERE execution_id=?').get(executionId);
  assert.equal(execRow.state, 'reserved', 'execution STILL reserved at T+1s (not spawn_failed)');

  // --- T+61s: past RESERVED_BOOT_TIMEOUT_MS (60_000ms). Must release. -------
  r = reconcileWorkerExecutions(db, projectId, epicId, t0 + 61_000, opts);
  execResult = r.find((x) => x.executionId === executionId);
  assert.ok(execResult, 'a result row exists for the expired reserved execution');
  assert.equal(execResult.action, 'lost', 'reserved exec released at T+61s');
  assert.equal(execResult.released, true, 'card returned to queue at T+61s');
  assert.match(execResult.reason, /spawn reservation timed out/, 'reason cites reservation timeout');

  execRow = db.prepare('SELECT state, last_error FROM worker_executions WHERE execution_id=?').get(executionId);
  assert.equal(execRow.state, 'spawn_failed', 'execution terminal state is spawn_failed at T+61s');

  taskRow = db.prepare(
    'SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?',
  ).get(task.id);
  assert.equal(taskRow.status, 'todo', 'card returned to todo at T+61s');
  assert.equal(taskRow.assigned_to, null, 'assignment cleared at T+61s');
  assert.equal(taskRow.current_execution_id, null, 'fence cleared at T+61s');

  // Idempotent: a later sweep does not reprocess the terminal execution.
  r = reconcileWorkerExecutions(db, projectId, epicId, t0 + 120_000, opts);
  assert.equal(
    r.find((x) => x.executionId === executionId), undefined,
    'terminal reserved execution is not reprocessed',
  );
});

/**
 * Wave 5 #6 — reportProgress must check the fence. The UPDATE accepts a
 * fenceToken parameter but historically filtered only on execution_id + active
 * state, so a SUPERSEDED worker (its worker_executions row still in an active
 * state while tasks.current_execution_id was reassigned away from it) could
 * refresh progress_at and keep itself alive past the stuck-policy grace.
 *
 * This mirrors markExecutionProgress's EXISTS(tasks.current_execution_id=...)
 * fence: only the CURRENT execution (the one the task's fence points to) may
 * update progress.
 *
 * Schema invariant: at most ONE active execution per task
 * (idx_worker_executions_one_active_task). So the realistic supersession
 * window is: execution A's row is still active, but the task's fence has been
 * moved to a NEW execution_id (B) that does not yet have its own active row
 * for this task — e.g. the recover/re-claim path reassigns the fence before
 * A's stale row is swept. In that window A is notionally alive and must NOT be
 * able to reset its own progress clock.
 */
test('fenced progress: superseded execution cannot reset progress_at', () => {
  const { projectId, epicId } = setupProject();
  const db = getDb();
  const executionRuntime = new SqliteExecutionRuntimeRepository();

  const task = tasks.task_create({ epic_id: epicId, title: 'fenced-progress' });
  stampProcessRun(task.id);

  // 1. Claim the card with execution A → fence = A, A's row active.
  const execA = `exec-A-${task.id}`;
  const claimedA = dispatcher.worker_next({
    worker_id: 'worker-A',
    project_id: projectId,
    machine_id: os.hostname(),
    execution_id: execA,
    run_id: 'run-A',
    task_ids: [task.id],
  });
  assert.ok(claimedA.task, 'worker_next must claim the card for execution A');

  // Sanity: fence points at A and A's execution row is active.
  const afterA = db.prepare(
    'SELECT current_execution_id, status, assigned_to FROM tasks WHERE id=?',
  ).get(task.id);
  assert.equal(afterA.current_execution_id, execA, 'fence points at A after claim');
  const rowA = db.prepare(
    "SELECT state, progress_at FROM worker_executions WHERE execution_id=?",
  ).get(execA);
  assert.ok(['reserved', 'running', 'cancel_requested'].includes(rowA.state),
    'A starts in an active state');

  // Make A's row provably 'running' (the stale/superseded-but-alive state) and
  // pin its progress_at to a known old instant so a reset is detectable.
  const oldProgress = '2020-01-01T00:00:00.000Z';
  db.prepare(
    `UPDATE worker_executions SET state='running', progress_at=? WHERE execution_id=?`,
  ).run(oldProgress, execA);

  // 2. SUPERSEDE: the task's fence is reassigned to a NEW execution_id (execB),
  //    while A's row is intentionally LEFT active. This is the stale-row window
  //    the fence must defend against: A is no longer the current execution, so
  //    it must not be able to refresh progress_at. (We do NOT insert execB as an
  //    active row — the schema forbids two active executions per task, and the
  //    fence guard must hold regardless of whether B has a row yet.)
  const execB = `exec-B-${task.id}`;
  db.prepare(
    `UPDATE tasks SET current_execution_id=? WHERE id=?`,
  ).run(execB, task.id);

  // Confirm the superseded state: the fence moved to B, A's row is still active.
  const superseded = db.prepare(
    'SELECT current_execution_id FROM tasks WHERE id=?',
  ).get(task.id);
  assert.equal(superseded.current_execution_id, execB, 'fence now points at B');
  const aState = db.prepare('SELECT state, progress_at FROM worker_executions WHERE execution_id=?').get(execA);
  assert.equal(aState.state, 'running', "A's stale row is still active (superseded)");

  // 3. THE BUG: A (superseded) attempts to report progress. It MUST fail and
  //    MUST NOT reset progress_at, because A is no longer the current execution.
  const movedA = executionRuntime.reportProgress({
    executionId: execA,
    fenceToken: execA,
    now: new Date('2026-08-02T12:00:00.000Z'),
  });
  assert.equal(movedA, false, 'superseded execution A cannot report progress');

  const aProgressAfter = db.prepare(
    'SELECT progress_at FROM worker_executions WHERE execution_id=?',
  ).get(execA).progress_at;
  assert.equal(aProgressAfter, oldProgress,
    'A progress_at was NOT reset by the superseded reportProgress call');

  // 4. Restore the fence to A and confirm the CURRENT execution CAN report
  //    progress (positive control — the fence guard does not block the
  //    legitimate current execution).
  db.prepare(
    `UPDATE tasks SET current_execution_id=? WHERE id=?`,
  ).run(execA, task.id);

  const movedA2 = executionRuntime.reportProgress({
    executionId: execA,
    fenceToken: execA,
    now: new Date('2026-08-02T12:00:01.000Z'),
  });
  assert.equal(movedA2, true, 'current execution A can report progress once fence is restored');
  const aProgressFinal = db.prepare(
    'SELECT progress_at FROM worker_executions WHERE execution_id=?',
  ).get(execA).progress_at;
  assert.equal(aProgressFinal, '2026-08-02T12:00:01.000Z',
    'A progress_at advanced once it is the current execution again');
});

// ---------------------------------------------------------------------------
// Wave 5 re-check 2026-08-02 — system-reaper vs admin_override audit-event
// distinction (WAVE-5-REMARKS.txt §"ПОВТОРНАЯ ПРОВЕРКА").
//
// The re-check requires an explicit test proving the system reaper event and
// the admin_override_lifecycle event produce DIFFERENT lifecycle_events rows
// (and different command_receipts actor provenance). Wave 5 §5: "admin_override
// нельзя использовать как обычное действие автоматики, потому что это смешивает
// системное восстановление с ручным вмешательством" — system recovery and human
// override MUST be distinguishable in the audit trail.
//
// The two paths:
//   * SYSTEM REAPER  — releaseExecutionAtomically writes lifecycle_events
//     event_kind='TaskReleased' + command_receipts actor_kind='controller',
//     actor_id='reconciler', command_kind='ObserveProcessExited'
//     (atomic-release.ts:315-338). Automated, no human in the loop.
//   * ADMIN OVERRIDE — the domain decide() for AdminOverrideLifecycle (with an
//     actor of kind 'admin') produces a DomainEvent kind='AdminOverrideApplied'
//     (evolve.ts:709-725). An executor persists it to lifecycle_events with
//     event_kind='AdminOverrideApplied' + command_receipts actor_kind='admin'
//     (the actor that authorized the manual intervention).
//
// This test drives BOTH paths against the same DB and asserts the two
// lifecycle_events rows differ in event_kind AND the two command_receipts rows
// differ in actor_kind / actor_id / command_kind — so a later audit can tell
// "the watchman reaped this automatically" apart from "an operator forced this".
// ---------------------------------------------------------------------------
test('audit distinction: system reaper event vs admin_override event produce different lifecycle_events rows', () => {
  const db = getDb();
  const { projectId, epicId } = setupProject();

  // --- SYSTEM REAPER PATH --------------------------------------------------
  // Create a fenced zombie and release it via the atomic-release primitive the
  // reaper uses. This writes the TaskReleased audit event.
  const zombie = createZombie(projectId, epicId);
  const reaperOutcome = releaseExecutionAtomically(db, {
    executionId: zombie.executionId,
    terminalState: 'lost',
    reason: 'OS process is not alive',
  });
  assert.equal(reaperOutcome.taskReleased, true, 'reaper released the zombie card');

  const reaperEvent = db.prepare(
    `SELECT event_kind, payload_json FROM lifecycle_events
      WHERE command_id IN (
        SELECT command_id FROM command_receipts
         WHERE actor_kind='controller' AND actor_id='reconciler')
      AND event_kind='TaskReleased' AND task_id=?`,
  ).get(zombie.taskId);
  assert.ok(reaperEvent, 'a TaskReleased lifecycle_event was written by the reaper');
  assert.equal(reaperEvent.event_kind, 'TaskReleased');
  const reaperPayload = JSON.parse(reaperEvent.payload_json);
  assert.equal(reaperPayload.kind, 'TaskReleased');

  const reaperReceipt = db.prepare(
    `SELECT command_kind, actor_kind, actor_id FROM command_receipts
      WHERE actor_id='reconciler' AND task_id=?`,
  ).get(zombie.taskId);
  assert.ok(reaperReceipt, 'a command_receipt was written by the reaper');
  assert.equal(reaperReceipt.actor_kind, 'controller');
  assert.equal(reaperReceipt.actor_id, 'reconciler');
  assert.equal(reaperReceipt.command_kind, 'ObserveProcessExited');

  // --- ADMIN OVERRIDE PATH -------------------------------------------------
  // A SEPARATE task: an operator forces it to 'completed' via
  // AdminOverrideLifecycle. The domain decide() emits AdminOverrideApplied;
  // we persist it the way an executor does (the command_receipts +
  // lifecycle_events rows with actor_kind='admin').
  const adminTask = tasks.task_create({ epic_id: epicId, title: 'admin-forced' });
  stampProcessRun(adminTask.id);
  const adminCommandId = `cmd-admin-${adminTask.id}-${Date.now()}`;
  const adminDecision = decide(
    { tasks: {}, workItems: {}, workAttempts: {}, executions: {} },
    {
      commandId: adminCommandId,
      actor: { kind: 'admin', id: 'operator-alice', reason: 'manual recovery: stuck review' },
      command: {
        kind: 'AdminOverrideLifecycle',
        taskId: adminTask.id,
        expectedStateFence: 'review_in_progress',
        target: 'completed',
      },
    },
  );
  assert.equal(adminDecision.ok, true, 'admin override is authorized by an admin actor');
  assert.equal(adminDecision.events.length, 1);
  assert.equal(adminDecision.events[0].kind, 'AdminOverrideApplied');

  // Persist the admin decision the way the command-bus executor does: a
  // command_receipt with actor_kind='admin' + a lifecycle_events row carrying
  // the AdminOverrideApplied event.
  db.prepare(
    `INSERT INTO command_receipts
       (command_id, command_kind, actor_kind, actor_id, task_id,
        payload_hash, accepted, result_json, reply_json)
     VALUES (?, 'AdminOverrideLifecycle', 'admin', 'operator-alice', ?,
             ?, 1, ?, ?)`,
  ).run(
    adminCommandId,
    adminTask.id,
    'sha256:admin-override',
    JSON.stringify(adminDecision.result),
    JSON.stringify(adminDecision.result),
  );
  db.prepare(
    `INSERT INTO lifecycle_events (command_id, seq, event_kind, task_id, payload_json)
     VALUES (?, 0, 'AdminOverrideApplied', ?, ?)`,
  ).run(adminCommandId, adminTask.id, JSON.stringify(adminDecision.events[0]));

  const adminEvent = db.prepare(
    `SELECT event_kind, payload_json FROM lifecycle_events
      WHERE event_kind='AdminOverrideApplied' AND task_id=?`,
  ).get(adminTask.id);
  assert.ok(adminEvent, 'an AdminOverrideApplied lifecycle_event was written');
  assert.equal(adminEvent.event_kind, 'AdminOverrideApplied');
  const adminPayload = JSON.parse(adminEvent.payload_json);
  assert.equal(adminPayload.kind, 'AdminOverrideApplied');
  assert.equal(adminPayload.target, 'completed');

  const adminReceipt = db.prepare(
    `SELECT command_kind, actor_kind, actor_id FROM command_receipts
      WHERE command_id=?`,
  ).get(adminCommandId);
  assert.equal(adminReceipt.actor_kind, 'admin');
  assert.equal(adminReceipt.actor_id, 'operator-alice');
  assert.equal(adminReceipt.command_kind, 'AdminOverrideLifecycle');

  // --- THE DISTINCTION (the load-bearing assertion) ------------------------
  // The two paths produce DIFFERENT event_kind values AND DIFFERENT actor
  // provenance. An audit reader can tell automated reaping from manual
  // override — they are never conflated.
  assert.notEqual(reaperEvent.event_kind, adminEvent.event_kind,
    'reaper (TaskReleased) and admin override (AdminOverrideApplied) emit DIFFERENT event_kind');
  assert.notEqual(reaperReceipt.actor_kind, adminReceipt.actor_kind,
    'reaper (controller) and admin override (admin) carry DIFFERENT actor_kind');
  assert.notEqual(reaperReceipt.command_kind, adminReceipt.command_kind,
    'reaper (ObserveProcessExited) and admin override (AdminOverrideLifecycle) carry DIFFERENT command_kind');
  assert.notEqual(reaperReceipt.actor_id, adminReceipt.actor_id,
    'reaper (reconciler) and admin override (operator id) carry DIFFERENT actor_id');
  // No admin override event is ever labelled as a controller/reconciler action
  // and vice-versa — the provenance is structurally distinct.
  const adminEventsFromReconciler = db.prepare(
    `SELECT COUNT(*) AS n FROM lifecycle_events le
      JOIN command_receipts cr ON le.command_id = cr.command_id
      WHERE le.event_kind='AdminOverrideApplied' AND cr.actor_id='reconciler'`,
  ).get().n;
  assert.equal(adminEventsFromReconciler, 0,
    'no AdminOverrideApplied event is ever attributed to the reconciler');
  const reaperEventsFromAdmin = db.prepare(
    `SELECT COUNT(*) AS n FROM lifecycle_events le
      JOIN command_receipts cr ON le.command_id = cr.command_id
      WHERE le.event_kind='TaskReleased' AND cr.actor_kind='admin'`,
  ).get().n;
  assert.equal(reaperEventsFromAdmin, 0,
    'no TaskReleased event is ever attributed to an admin actor');
});


