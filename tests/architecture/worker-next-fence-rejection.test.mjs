// tests/architecture/worker-next-fence-rejection.test.mjs
//
// WAVE-3 (conveyor-wave-review ПОВТОРНАЯ ПРОВЕРКА 2026-08-02) — server-side
// fence rejection gate for worker_next.
//
// The exit criterion: "one launch = one card". A worker execution that ALREADY
// holds an active assignment must be REJECTED by worker_next BEFORE the queue is
// read, regardless of which client or launcher issued the call. The per-launcher
// --disallowedTools flag only constrains ONE launcher (the Claude runner); this
// test proves the guarantee is enforced SERVER-SIDE in the handler, which is the
// single chokepoint covering MCP-direct callers, every launcher, and tests.
//
// What this file proves:
//   1. A worker_next call carrying an execution_id that has an ACTIVE
//      worker_executions row is rejected with AUTHORITY_DENIED — no card is
//      claimed, even when a claimable card exists in the queue.
//   2. A worker_next call carrying an execution_id that some task holds as
//      current_execution_id (the fence) is rejected likewise, even if the
//      worker_executions row has already gone terminal (defence-in-depth: the
//      task fence alone is enough).
//   3. The rejection runs BEFORE the queue is read: a sibling claimable card
//      remains unassigned (status='todo', assigned_to=NULL) after the rejected
//      call. No claim SQL executed.
//   4. Control: a worker_next WITHOUT an execution_id, or with an execution_id
//      that holds NO active assignment, claims normally. The gate does not break
//      the legitimate first-claim path or the dispatcher surface.
//
// Pattern follows tests/architecture/work-assignment-contract.test.mjs:
// SqliteWorkAssignmentAdapter + a temp DB stages an active assignment, then the
// worker_next MCP handler (the unit under test) is invoked directly.

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
import { SqliteWorkAssignmentAdapter } from '../../dist/infrastructure/work/sqlite-work-assignment-adapter.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-fence-'));
process.env.DB_PATH = path.join(temp, 'fence.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

/** Stamp process_run_id onto a task's metadata — the saga4 authority gate. */
function stampProcessRun(taskId, processRunId = 1) {
  const db = getDb();
  const row = db.prepare('SELECT metadata FROM tasks WHERE id=?').get(taskId);
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
  meta.process_run_id = processRunId;
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), taskId);
}

function setupProject() {
  const p = projects.project_create({ name: `fence-test-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const e = epics.epic_create({ project_id: p.id, name: 'Fence epic' });
  return { projectId: p.id, epicId: e.id };
}

function makeTodoTask(epicId, overrides = {}) {
  return tasks.task_create({ epic_id: epicId, title: overrides.title ?? 't', ...overrides });
}

/** Read the claim state of a task row. */
function claimState(taskId) {
  return getDb()
    .prepare('SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?')
    .get(taskId);
}

// ---------------------------------------------------------------------------
// §1 Active worker_executions row ⇒ worker_next rejected before queue read.
// ---------------------------------------------------------------------------

test('worker_next is AUTHORITY_DENIED when execution_id has an active worker_executions row', () => {
  const { projectId, epicId } = setupProject();
  // Two claimable cards. The first is pre-assigned to exec-held via the adapter
  // (this is what the dispatch loop does BEFORE launching the worker). The
  // second remains in the queue, claimable.
  const heldTask = makeTodoTask(epicId, { title: 'held' });
  const queuedTask = makeTodoTask(epicId, { title: 'queued' });
  stampProcessRun(heldTask.id);
  stampProcessRun(queuedTask.id);

  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId,
    workerId: 'w-held',
    workerExecutionId: 'exec-held',
    runId: 'r-held',
    machineId: 'm1',
  });
  assert.notEqual(work, null);
  assert.equal(work.workerExecutionId, 'exec-held');

  // The worker is now launched with exec-held. It MUST NOT re-enter the queue.
  // worker_next with the same execution_id must be rejected before reading it.
  assert.throws(
    () => dispatcher.worker_next({
      worker_id: 'w-held',
      project_id: projectId,
      execution_id: 'exec-held',
      machine_id: 'm1',
    }),
    (err) => /AUTHORITY_DENIED/.test(err.message)
      && /exec-held/.test(err.message)
      && /one launch = one card/i.test(err.message),
    'worker_next for an execution that already holds a card must throw AUTHORITY_DENIED',
  );

  // Proof the rejection happened BEFORE the queue was read: the queued card is
  // still untouched (no claim SQL ran for it).
  const queued = claimState(queuedTask.id);
  assert.equal(queued.status, 'todo');
  assert.equal(queued.assigned_to, null);
  assert.equal(queued.current_execution_id, null);
});

// ---------------------------------------------------------------------------
// §2 Task fence alone (current_execution_id) ⇒ rejected, even with a terminal
//    worker_executions row. Defence-in-depth: the task fence is an independent
//    signal of "this execution already owns a card".
// ---------------------------------------------------------------------------

test('worker_next is AUTHORITY_DENIED when execution_id matches a task current_execution_id fence', () => {
  const { projectId, epicId } = setupProject();
  const heldTask = makeTodoTask(epicId, { title: 'fence-held' });
  const queuedTask = makeTodoTask(epicId, { title: 'fence-queued' });
  stampProcessRun(heldTask.id);
  stampProcessRun(queuedTask.id);

  // Stage an assignment, then terminalize the worker_executions row but LEAVE
  // the task fence in place (simulates a half-released / crashed-mid-release
  // state, or a task whose execution exited but the card is still owned).
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  adapter.assignTask({
    projectId,
    workerId: 'w-fence',
    workerExecutionId: 'exec-fence',
    runId: 'r-fence',
    machineId: 'm1',
  });
  getDb()
    .prepare("UPDATE worker_executions SET state='exited', finished_at=datetime('now') WHERE execution_id=?")
    .run('exec-fence');
  // The task fence survives the terminalized execution row.
  const held = claimState(heldTask.id);
  assert.equal(held.current_execution_id, 'exec-fence');

  assert.throws(
    () => dispatcher.worker_next({
      worker_id: 'w-fence',
      project_id: projectId,
      execution_id: 'exec-fence',
      machine_id: 'm1',
    }),
    (err) => /AUTHORITY_DENIED/.test(err.message) && /exec-fence/.test(err.message),
    'worker_next for an execution_id that fences a task must throw AUTHORITY_DENIED',
  );

  // Queue untouched.
  const queued = claimState(queuedTask.id);
  assert.equal(queued.status, 'todo');
  assert.equal(queued.assigned_to, null);
});

// ---------------------------------------------------------------------------
// §3 Rejection is independent of client/launcher: the error surfaces as a
//    thrown Error from the handler (the MCP layer translates throws to the
//    client). This is the same propagation path every caller uses.
// ---------------------------------------------------------------------------

test('the AUTHORITY_DENIED rejection carries the one-launch-one-card rationale', () => {
  const { projectId, epicId } = setupProject();
  const heldTask = makeTodoTask(epicId, { title: 'rationale-held' });
  stampProcessRun(heldTask.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  adapter.assignTask({
    projectId,
    workerId: 'w-rat',
    workerExecutionId: 'exec-rat',
    runId: 'r-rat',
    machineId: 'm1',
  });

  let caught;
  try {
    dispatcher.worker_next({
      worker_id: 'w-rat',
      project_id: projectId,
      execution_id: 'exec-rat',
      machine_id: 'm1',
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'worker_next must throw');
  // The message must name the server-side, launcher-independent nature of the
  // guarantee so an operator reading the error understands it is NOT a
  // client-side flag they can work around.
  assert.match(caught.message, /server-side/i);
  assert.match(caught.message, /independent of any client --disallowedTools flag/i);
});

// ---------------------------------------------------------------------------
// §4 Control: legitimate first-claim paths are NOT broken.
// ---------------------------------------------------------------------------

test('control: worker_next WITHOUT execution_id claims normally (first claim, no fence)', () => {
  const { projectId, epicId } = setupProject();
  const task = makeTodoTask(epicId, { title: 'control-no-exec' });
  stampProcessRun(task.id);

  const result = dispatcher.worker_next({
    worker_id: 'w-control-1',
    project_id: projectId,
  });
  assert.notEqual(result.task, null);
  assert.equal(result.task.id, task.id);
  const after = claimState(task.id);
  assert.equal(after.status, 'in_progress');
  assert.equal(after.assigned_to, 'w-control-1');
});

test('control: worker_next with an execution_id that holds NO card claims normally', () => {
  const { projectId, epicId } = setupProject();
  const task = makeTodoTask(epicId, { title: 'control-fresh-exec' });
  stampProcessRun(task.id);

  // exec-fresh has never been used to assign a card — it is a brand new launch.
  const result = dispatcher.worker_next({
    worker_id: 'w-control-2',
    project_id: projectId,
    execution_id: 'exec-fresh',
    machine_id: 'm1',
  });
  assert.notEqual(result.task, null);
  assert.equal(result.task.id, task.id);
  const after = claimState(task.id);
  assert.equal(after.status, 'in_progress');
  assert.equal(after.current_execution_id, 'exec-fresh');
});

test('control: a TERMINAL (released) execution does not poison the queue for a fresh launch', () => {
  // After a card is properly released (worker_done/ask_need terminalizes the
  // execution AND clears the task fence), a fresh launch — which always gets a
  // FRESH execution_id (execution_id is the worker_executions PRIMARY KEY, so it
  // is single-use by design) — must be able to claim the next card. This proves
  // the gate does not over-trigger on the presence of a past, now-terminal
  // execution: it keys only on ACTIVE rows and live task fences.
  const { projectId, epicId } = setupProject();
  const firstTask = makeTodoTask(epicId, { title: 'released-first' });
  const secondTask = makeTodoTask(epicId, { title: 'released-second' });
  stampProcessRun(firstTask.id);
  stampProcessRun(secondTask.id);

  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  adapter.assignTask({
    projectId,
    workerId: 'w-reuse',
    workerExecutionId: 'exec-old',
    runId: 'r-old',
    machineId: 'm1',
  });
  // Fully release: terminalize the execution row AND clear the task fence.
  const db = getDb();
  db.prepare("UPDATE worker_executions SET state='exited', finished_at=datetime('now') WHERE execution_id=?")
    .run('exec-old');
  db.prepare('UPDATE tasks SET current_execution_id=NULL, assigned_to=NULL, status=? WHERE id=?')
    .run('todo', firstTask.id);

  // A fresh launch gets a fresh execution_id. It must claim a card unhindered —
  // the gate sees no active row and no live fence for exec-new. The oldest
  // claimable card (firstTask, reset to todo above) wins by created_at ordering,
  // which is exactly the normal dispatcher behaviour the gate must preserve.
  const result = dispatcher.worker_next({
    worker_id: 'w-reuse',
    project_id: projectId,
    execution_id: 'exec-new',
    machine_id: 'm1',
  });
  assert.notEqual(result.task, null, 'fresh launch must claim a card (gate did not over-trigger)');
  const claimedId = result.task.id;
  assert.ok(
    claimedId === firstTask.id || claimedId === secondTask.id,
    `fresh launch must claim one of the claimable cards, got ${claimedId}`,
  );
  const after = claimState(claimedId);
  assert.equal(after.status, 'in_progress');
  assert.equal(after.current_execution_id, 'exec-new');
});
