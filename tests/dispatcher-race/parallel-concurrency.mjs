// Wave 4 / mandatory scenario 2: with concurrency=N, no more than N workers
// run AND at least two run concurrently when two cards are available.
//
// HISTORICAL NOTE (Slice 1, saga4): this file used to test the concurrency
// loop INSIDE ClaudeBoardRunner.pump() — the `while (run.active.size <
// run.concurrency)` branch that claimed cards via the `claimTask` callback.
// Slice 1 removed that branch entirely: the runner is now a strictly
// one-card process host, and the global concurrency budget lives in
// src/app/dispatch-loop.ts (distributeQueuedTasks loops
// `while (active.size < concurrency)` calling assignTask then start with
// concurrency:1). These two tests therefore target a contract that no
// longer exists in the runner.
//
// They are SKIPped here to keep test:architecture green. The equivalent
// invariant for the NEW dispatcher (temporal overlap of >=2 executions at
// N>=2, max-alive <= N) is tracked as Wave 4 REAL-GAP #4 and must be
// re-implemented as a dispatch-loop overlap test. Do NOT re-add a
// claimTask/pump-loop test — that model is gone by design (see
// tests/architecture/no-claim-scope.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';

const { ClaudeBoardRunner } = await import('../../tracker-view/claude-runner.mjs');
const __dirname = dirname(fileURLToPath(import.meta.url));

function makeDb(dbPath) {
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + ext); } catch { /* not present */ }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedTwoCards(db) {
  db.prepare("INSERT INTO projects (name, description) VALUES ('parallel-test', 'wave4 parallel')").run();
  const projId = db.prepare("SELECT id FROM projects WHERE name='parallel-test'").get().id;
  db.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'parallel-epic')").run(projId);
  const epicId = db.prepare("SELECT id FROM epics WHERE name='parallel-epic'").get().id;
  const metadata = JSON.stringify({ process_run_id: 5001 });
  const ins = db.prepare(
    "INSERT INTO tasks (epic_id, title, status, priority, assigned_to, metadata) VALUES (?, ?, 'todo', 'high', NULL, ?)",
  );
  ins.run(epicId, 'card-A', metadata);
  ins.run(epicId, 'card-B', metadata);
  return { projId, epicId };
}

// A fake spawn that returns a ChildProcess-like object. It records the launch
// tick, stays alive until .kill() is called (the runner kills on completion),
// and emits 'close' asynchronously. We control timing with process.uptime() as
// a monotonic clock so the test is deterministic regardless of wall-clock.
test.skip('scenario 2: concurrency=3 with 2 cards launches 2 workers that overlap in time', async () => {
  // SKIPPED (Slice 1): tested the runner's internal pump-loop concurrency,
  // which was removed. See file header. Rewrite target: dispatch-loop overlap.
  const dbPath = join(__dirname, 'parallel-concurrency.db');
  const db = makeDb(dbPath);
  const { projId } = seedTwoCards(db);

  const launches = []; // { workerId, t }
  const closes = [];   // { workerId, t }
  let aliveCount = 0;
  let maxAlive = 0;

  // Fake spawn: returns an EventEmitter with .pid, .stdout, .stderr, .kill().
  // The runner registers 'close'/'error' listeners and calls .kill() to stop.
  function fakeSpawn() {
    const child = new EventEmitter();
    child.pid = Math.floor(Math.random() * 90000) + 1000;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      // Simulate the worker finishing shortly after kill is requested.
      // Defer so the pump's microtask re-enters and sees active.size shrink.
      queueMicrotask(() => {
        aliveCount--;
        closes.push({ workerId: child.sagaWorkerId, t: launches.length + closes.length });
        child.emit('close', 0, null);
      });
    };
    return child;
  }

  // Track live windows to compute overlap.
  const liveWindows = []; // [launchOrder, closeOrder]

  const runner = new ClaudeBoardRunner({
    claimTask: ({ worker_id, project_id }) => {
      // Mirror the real atomic claim: pick the next free todo card.
      const task = db.prepare(
        "SELECT * FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?) AND status='todo' AND assigned_to IS NULL LIMIT 1",
      ).get(project_id);
      if (!task) return { task: null };
      db.prepare("UPDATE tasks SET status='in_progress', assigned_to=? WHERE id=?").run(worker_id, task.id);
      return { task: { ...task, status: 'in_progress' }, execution_id: `exec-${worker_id}` };
    },
    getTaskState: (taskId) => db.prepare('SELECT status, assigned_to FROM tasks WHERE id=?').get(taskId),
    recoverAssignment: ({ taskId }) => {
      db.prepare("UPDATE tasks SET status='todo', assigned_to=NULL WHERE id=?").run(taskId);
    },
    spawn: (cmd, args, opts) => {
      const child = fakeSpawn();
      // Stash the worker id from the env the runner passes.
      child.sagaWorkerId = opts?.env?.SAGA_WORKER_ID ?? `w${launches.length}`;
      aliveCount++;
      maxAlive = Math.max(maxAlive, aliveCount);
      const launchOrder = launches.length;
      launches.push({ workerId: child.sagaWorkerId, t: launchOrder });
      // The runner expects the child to be alive immediately; it will call
      // .kill() when it wants the worker to finish (in the close handler path
      // of a real run). To make BOTH overlap, we do NOT kill here — we let the
      // runner's finish logic drive termination once the queue drains.
      return child;
    },
    claudePath: 'node',
    sagaEntry: '(unused)',
    sagaSkillRoot: '(unused)',
    dbPath,
    resolveWorkspace: () => os.tmpdir(),
    getProject: () => ({ id: projId, name: 'parallel-test' }),
  });

  // Drive the runner with concurrency=3.
  let snapshot;
  try {
    snapshot = runner.start({ projectId: projId, concurrency: 3 });
  } catch (err) {
    assert.fail(`runner.start threw: ${err.message}\n${err.stack}`);
  }

  // Pump runs on a microtask. Give it a few macrotask ticks to claim + launch
  // both cards. We poll the snapshot until the run terminates or a tick cap.
  // Because our fake children never self-close, we manually finish the run
  // after asserting both launched.
  // Wait for the microtask pump to fire and launch both workers.
  // The pump claims in a tight `while (active.size < concurrency)` loop, so
  // both launches happen synchronously within one pump() invocation.
  // We yield to let queueMicrotask(pump) run.
  const startStatus = runner.status(projId);

  // Both cards should be claimed + launched in the first pump pass because
  // concurrency=3 >= 2 cards.
  // Yield microtasks/macrotasks so pump() fires.
  // (We cannot truly await inside this synchronous test, but pump fires on a
  //  queueMicrotask which runs before any macrotask. Use a busy probe.)
  let probeCount = 0;
  while (launches.length < 2 && probeCount < 100) {
    // Yield to the event loop so queueMicrotask(pump) fires and claims/launches.
    await new Promise(r => setTimeout(r, 5));
    probeCount++;
  }

  assert.ok(launches.length >= 2,
    `expected at least 2 launches, got ${launches.length} (pump may not have fired synchronously)`);

  // INVARIANT A: at most `concurrency` (3) workers were ever alive at once.
  assert.ok(maxAlive <= 3, `max simultaneous alive (${maxAlive}) exceeded concurrency=3`);

  // INVARIANT B: at least 2 workers overlapped (both launched before either closed).
  // Since our fake spawn never self-closes, both are still alive now → overlap
  // is trivially proven. To make this a meaningful check we verify closes is
  // empty (neither finished yet) and 2 are alive.
  assert.equal(closes.length, 0, 'no worker should have closed before the overlap assertion');
  assert.ok(aliveCount >= 2, `expected >= 2 alive workers during overlap, got ${aliveCount}`);

  // Cleanup: stop the run so no orphan fence remains.
  try { runner.stop(projId); } catch { /* best effort */ }
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + ext); } catch { /* not present */ }
  }

  console.log(`[scenario-2] launches=${launches.length} maxAlive=${maxAlive} overlap=PASS`);
});

test.skip('scenario 2: concurrency=1 with 2 cards never overlaps (serial)', () => {
  // SKIPPED (Slice 1): tested the runner's internal pump-loop concurrency,
  // which was removed. See file header. Rewrite target: dispatch-loop serial.
  const dbPath = join(__dirname, 'parallel-concurrency-serial.db');
  const db = makeDb(dbPath);
  const { projId } = seedTwoCards(db);

  let maxAlive = 0;
  let aliveCount = 0;

  function fakeSpawn() {
    const child = new EventEmitter();
    child.pid = Math.floor(Math.random() * 90000) + 1000;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      queueMicrotask(() => {
        aliveCount--;
        child.emit('close', 0, null);
      });
    };
    return child;
  }

  const runner = new ClaudeBoardRunner({
    claimTask: ({ worker_id, project_id }) => {
      const task = db.prepare(
        "SELECT * FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?) AND status='todo' AND assigned_to IS NULL LIMIT 1",
      ).get(project_id);
      if (!task) return { task: null };
      db.prepare("UPDATE tasks SET status='in_progress', assigned_to=? WHERE id=?").run(worker_id, task.id);
      return { task: { ...task, status: 'in_progress' }, execution_id: `exec-${worker_id}` };
    },
    getTaskState: (taskId) => db.prepare('SELECT status, assigned_to FROM tasks WHERE id=?').get(taskId),
    recoverAssignment: ({ taskId }) => {
      db.prepare("UPDATE tasks SET status='todo', assigned_to=NULL WHERE id=?").run(taskId);
    },
    spawn: (cmd, args, opts) => {
      const child = fakeSpawn();
      aliveCount++;
      maxAlive = Math.max(maxAlive, aliveCount);
      return child;
    },
    claudePath: 'node',
    sagaEntry: '(unused)',
    sagaSkillRoot: '(unused)',
    dbPath,
    resolveWorkspace: () => os.tmpdir(),
    getProject: () => ({ id: projId, name: 'parallel-test' }),
  });

  runner.start({ projectId: projId, concurrency: 1 });

  // Pump fires on a microtask; with concurrency=1 only ONE worker launches.
  let probeCount = 0;
  while (probeCount < 1000) probeCount++;

  // INVARIANT: with concurrency=1, never more than 1 alive at once.
  assert.ok(maxAlive <= 1, `concurrency=1 but maxAlive=${maxAlive} (should never exceed 1)`);

  try { runner.stop(projId); } catch { /* best effort */ }
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + ext); } catch { /* not present */ }
  }
  console.log(`[scenario-2-serial] concurrency=1 maxAlive=${maxAlive} serial=PASS`);
});
