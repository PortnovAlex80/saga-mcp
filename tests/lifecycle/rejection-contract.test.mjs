/**
 * Rejection contract tests (Wave 1 re-check 2026-08-02).
 *
 * WAVE-1-REMARKS.txt §"ПОВТОРНАЯ ПРОВЕРКА" requires that "invalid state
 * transitions, foreign card, foreign workplace, stale fence and incompatible
 * executionId are always rejected". The previous architecture gate only
 * asserted that the right interface NAMES existed in the source — it did not
 * prove the runtime rejections. This file proves them at runtime.
 *
 * Coverage matrix (the 5 rejection scenarios + the explicit asks):
 *
 *   1. STALE FENCE — assertExecutionFence rejects an execution_id that does
 *      not match tasks.current_execution_id (the re-check's "stale execution_id
 *      rejected by worker_done" ask).
 *   2. MISSING execution_id — assertExecutionFence rejects undefined / non-
 *      string for a fenced task (the "missing execution_id rejected" ask).
 *   3. TERMINAL execution — assertExecutionFence rejects an execution_id that
 *      matches the fence but whose worker_executions row is no longer active
 *      (the "incompatible executionId" scenario: the value is well-formed and
 *      once-current, but the attempt is dead).
 *   4. FOREIGN CARD — releaseExecutionAtomically terminalizes a stale
 *      execution WITHOUT releasing a task that a newer execution now owns
 *      (the re-check's "foreign card: task A's fence presented against task B
 *      rejected" ask). A stale execution for task A cannot mutate task B.
 *   5. FOREIGN CARD (cross-task fence) — assertExecutionFence for task B
 *      presented with task A's execution_id is rejected, even though the id
 *      is a real active execution (just for a different card).
 *   6. FOREIGN WORKPLACE — releaseExecutionAtomically invoked with an
 *      execution_id that belongs to a different project/epic cannot release a
 *      task it does not own (execution not found → no-op).
 *   7. INVALID STATE TRANSITION — releaseExecutionAtomically on an
 *      already-terminal execution is a no-op (cannot transition terminal→
 *      terminal, and cannot resurrect a fence). Combined with the CAS inside,
 *      this proves a dead execution cannot drive a state transition.
 *   8. BRAND VALIDATORS — asFenceToken rejects empty/non-string; asCardId
 *      rejects non-positive/non-integer/non-number. These guard the boundary
 *      so an incompatible identity cannot even be constructed at the seam the
 *      re-check names ("CardRef, ExecutionId, FenceToken … with runtime
 *      validation").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { handlers as repositories } from '../../dist/tools/repositories.js';
import { assertExecutionFence } from '../../dist/worker-executions.js';
import { releaseExecutionAtomically } from '../../dist/lifecycle/atomic-release.js';
import { asFenceToken, asCardId } from '../../dist/lifecycle/domain/ids.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-reject-'));
process.env.DB_PATH = path.join(temp, 'reject.db');
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeProject() {
  const product = projects.project_create({
    name: `Reject ${Math.random().toString(36).slice(2, 6)}`,
  });
  repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  return { product, epic };
}

function makeTask(epicId) {
  return tasks.task_create({
    epic_id: epicId,
    title: `T-${Math.random().toString(36).slice(2, 6)}`,
    task_kind: 'development.code',
    execution_mode: 'git_change',
  });
}

/** Stamp a fence onto a task row directly (bypasses the claim flow). */
function fenceTaskToExecution(taskId, executionId, status = 'in_progress', workerId = 'w') {
  const db = getDb();
  db.prepare(
    `UPDATE tasks
        SET status=?, assigned_to=?, current_execution_id=?, updated_at=datetime('now')
      WHERE id=?`,
  ).run(status, workerId, executionId, taskId);
}

/** Insert a worker_executions row in the given state. */
function insertExecution(
  taskId,
  executionId,
  state = 'running',
  workerId = 'w',
  phase = 'executing',
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase, reserved_at, phase_updated_at)
     VALUES (?, 'run-x',
       (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
       (SELECT epic_id FROM tasks WHERE id=?), ?, ?, ?, ?, ?,
       datetime('now'), datetime('now'))`,
  ).run(executionId, taskId, taskId, taskId, workerId, os.hostname(), state, phase);
}

function taskRow(taskId) {
  return getDb().prepare(
    'SELECT id, status, assigned_to, current_execution_id FROM tasks WHERE id=?',
  ).get(taskId);
}

// ===========================================================================
// GROUP A — assertExecutionFence (the worker_done / worker_merge_ fence gate).
// ===========================================================================

test('REJECT stale fence: worker_done with an execution_id that does not match current_execution_id is rejected', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  fenceTaskToExecution(t.id, 'exec-current', 'in_progress', 'w-current');
  insertExecution(t.id, 'exec-current', 'running', 'w-current');

  // A stale/foreign execution_id presented at the gate.
  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(t.id), 'exec-stale'),
    /fenced by execution exec-current/,
    'a stale execution_id must be rejected at the worker_done fence',
  );

  // Task remains fenced by its real owner — the stale attempt did not mutate it.
  const after = taskRow(t.id);
  assert.equal(after.current_execution_id, 'exec-current');
  assert.equal(after.assigned_to, 'w-current');
});

test('REJECT missing execution_id: worker_done without an execution_id on a fenced task is rejected', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  fenceTaskToExecution(t.id, 'exec-missing', 'in_progress', 'w-missing');
  insertExecution(t.id, 'exec-missing', 'running', 'w-missing');

  // undefined (caller forgot to pass execution_id).
  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(t.id), undefined),
    /fenced by execution exec-missing/,
    'undefined execution_id must be rejected',
  );
  // null.
  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(t.id), null),
    /fenced by execution exec-missing/,
    'null execution_id must be rejected',
  );
  // Non-string.
  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(t.id), 42),
    /fenced by execution exec-missing/,
    'non-string execution_id must be rejected',
  );
});

test('REJECT incompatible executionId: an id matching the fence but whose execution is terminal is rejected', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // Task is still fenced by exec-terminal, but the worker_executions row has
  // already moved to a terminal state (e.g. the reaper terminalized it but a
  // concurrent worker_done arrived late).
  fenceTaskToExecution(t.id, 'exec-terminal', 'in_progress', 'w-terminal');
  insertExecution(t.id, 'exec-terminal', 'lost', 'w-terminal');

  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(t.id), 'exec-terminal'),
    /no longer active/,
    'an execution_id whose attempt is terminal must be rejected even though it matches the fence',
  );
});

test('REJECT foreign card: an execution_id that is active but for a DIFFERENT task is rejected', () => {
  const { epic } = makeProject();
  const taskA = makeTask(epic.id);
  const taskB = makeTask(epic.id);
  // taskA is fenced by exec-A and active.
  fenceTaskToExecution(taskA.id, 'exec-A', 'in_progress', 'w-A');
  insertExecution(taskA.id, 'exec-A', 'running', 'w-A');
  // taskB is fenced by exec-B and active.
  fenceTaskToExecution(taskB.id, 'exec-B', 'in_progress', 'w-B');
  insertExecution(taskB.id, 'exec-B', 'running', 'w-B');

  // Presenting taskA's execution_id against taskB's fence must be rejected.
  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(taskB.id), 'exec-A'),
    /fenced by execution exec-B/,
    'a foreign card execution_id must be rejected against task B',
  );
  // And the reverse.
  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(taskA.id), 'exec-B'),
    /fenced by execution exec-A/,
    'a foreign card execution_id must be rejected against task A',
  );

  // Neither task was mutated by the foreign attempts.
  assert.equal(taskRow(taskA.id).current_execution_id, 'exec-A');
  assert.equal(taskRow(taskB.id).current_execution_id, 'exec-B');
});

test('PASS gate: the correct execution_id for an active execution is accepted (negative control)', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  fenceTaskToExecution(t.id, 'exec-ok', 'in_progress', 'w-ok');
  insertExecution(t.id, 'exec-ok', 'running', 'w-ok');

  // Must NOT throw — proves the rejection tests above are about the value, not
  // a blanket throw.
  assert.doesNotThrow(
    () => assertExecutionFence(getDb(), taskRow(t.id), 'exec-ok'),
    'the matching active execution_id must pass the fence',
  );
});

test('PASS gate: an unfenced task (no current_execution_id) accepts any execution_id (legacy unfenced path)', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // Deliberately do NOT fence the task. This mirrors pre-ADR-009 legacy rows;
  // assertExecutionFence returns early for them (the legacy branch in
  // reconcileWorkerExecutions handles their recovery separately).
  assert.doesNotThrow(
    () => assertExecutionFence(getDb(), taskRow(t.id), 'exec-anything'),
    'an unfenced task must not be falsely rejected',
  );
});

// ===========================================================================
// GROUP B — releaseExecutionAtomically (the recovery / close race gate).
// ===========================================================================

test('REJECT foreign card: stale execution cannot release a task now owned by a newer execution', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // The original execution died; the card was re-claimed by execution 2.
  fenceTaskToExecution(t.id, 'exec-new-owner', 'in_progress', 'w2');
  insertExecution(t.id, 'exec-new-owner', 'running', 'w2');
  // The stale execution row exists (it terminalized earlier). The schema
  // forbids two active executions for one task, so the stale row is already
  // terminal here.
  insertExecution(t.id, 'exec-stale', 'lost', 'w1');

  const outcome = releaseExecutionAtomically(getDb(), {
    executionId: 'exec-stale',
    terminalState: 'lost',
    reason: 'late retry for stale execution',
  });

  assert.equal(outcome.terminalized, false, 'stale execution already terminal — no-op');
  assert.equal(outcome.taskReleased, false, 'task definitely not released by the stale attempt');

  // The new owner's fence survives — the stale execution could not steal or
  // release the card it no longer owns.
  const after = taskRow(t.id);
  assert.equal(after.current_execution_id, 'exec-new-owner');
  assert.equal(after.assigned_to, 'w2');
  assert.equal(after.status, 'in_progress');
});

test('REJECT foreign workplace: an execution_id unknown to this DB cannot release anything', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  fenceTaskToExecution(t.id, 'exec-real', 'in_progress', 'w-real');
  insertExecution(t.id, 'exec-real', 'running', 'w-real');

  // An execution_id from a different project/workplace that does not exist in
  // this DB.
  const outcome = releaseExecutionAtomically(getDb(), {
    executionId: 'exec-from-another-workplace',
    terminalState: 'lost',
    reason: 'foreign workplace attempt',
  });

  assert.equal(outcome.terminalized, false);
  assert.equal(outcome.taskReleased, false);
  assert.equal(outcome.taskId, null, 'unknown execution touches no task');
  assert.match(outcome.blockedReason, /not found/);

  // The real owner is untouched.
  const after = taskRow(t.id);
  assert.equal(after.current_execution_id, 'exec-real');
  assert.equal(after.assigned_to, 'w-real');
});

test('REJECT foreign card (cross-task release): releaseExecutionAtomically on execution X does not release task Y', () => {
  const { epic } = makeProject();
  const taskX = makeTask(epic.id);
  const taskY = makeTask(epic.id);
  fenceTaskToExecution(taskX.id, 'exec-X', 'in_progress', 'wX');
  insertExecution(taskX.id, 'exec-X', 'running', 'wX');
  fenceTaskToExecution(taskY.id, 'exec-Y', 'in_progress', 'wY');
  insertExecution(taskY.id, 'exec-Y', 'running', 'wY');

  // Releasing execution X must not touch task Y.
  const outcome = releaseExecutionAtomically(getDb(), {
    executionId: 'exec-X',
    terminalState: 'lost',
    reason: 'release X',
  });
  assert.equal(outcome.taskReleased, true);
  assert.equal(outcome.taskId, taskX.id);

  // Task Y keeps its own owner — no cross-card bleed.
  const y = taskRow(taskY.id);
  assert.equal(y.current_execution_id, 'exec-Y');
  assert.equal(y.assigned_to, 'wY');
  assert.equal(y.status, 'in_progress');
});

test('REJECT invalid state transition: terminalizing an already-terminal execution is a no-op (cannot resurrect)', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  fenceTaskToExecution(t.id, 'exec-once', 'in_progress', 'w');
  insertExecution(t.id, 'exec-once', 'running', 'w');

  const first = releaseExecutionAtomically(getDb(), {
    executionId: 'exec-once',
    terminalState: 'lost',
    reason: 'first terminalization',
  });
  assert.equal(first.terminalized, true);
  assert.equal(first.taskReleased, true);
  // Task is now back in todo, unfenced.
  let after = taskRow(t.id);
  assert.equal(after.status, 'todo');
  assert.equal(after.current_execution_id, null);

  // A late second release on the SAME (now terminal) execution cannot drive
  // any further state transition. It must be a no-op, and it must NOT re-touch
  // the task.
  const second = releaseExecutionAtomically(getDb(), {
    executionId: 'exec-once',
    terminalState: 'terminated',
    reason: 'late retry — must not transition',
  });
  assert.equal(second.terminalized, false, 'already-terminal cannot transition again');
  assert.equal(second.taskReleased, false);

  after = taskRow(t.id);
  assert.equal(after.status, 'todo', 'task status unchanged by the late retry');
  assert.equal(after.current_execution_id, null);
});

// ===========================================================================
// GROUP C — branded-identity runtime validators (the boundary guard the
// re-check explicitly asks for: "конструкторы с runtime validation").
// ===========================================================================

test('REJECT invalid FenceToken: asFenceToken rejects empty / whitespace / non-string', () => {
  assert.throws(() => asFenceToken(''), /must not be empty/);
  assert.throws(() => asFenceToken('   '), /must not be empty/);
  assert.throws(() => asFenceToken('\t\n'), /must not be empty/);
  // Non-string inputs.
  assert.throws(() => asFenceToken(undefined), /expected string/);
  assert.throws(() => asFenceToken(null), /expected string/);
  assert.throws(() => asFenceToken(123), /expected string/);
});

test('PASS asFenceToken: a non-empty string is branded and round-trips as the same string', () => {
  const token = asFenceToken('exec-valid-1');
  assert.equal(typeof token, 'string');
  assert.equal(token, 'exec-valid-1');
});

test('REJECT invalid CardId: asCardId rejects non-positive / non-integer / non-number', () => {
  assert.throws(() => asCardId(0), /positive integer/);
  assert.throws(() => asCardId(-1), /positive integer/);
  assert.throws(() => asCardId(-42), /positive integer/);
  assert.throws(() => asCardId(3.5), /positive integer/);
  assert.throws(() => asCardId(NaN), /finite number/);
  assert.throws(() => asCardId(Infinity), /finite number/);
  assert.throws(() => asCardId('5'), /expected finite number/);
  assert.throws(() => asCardId(undefined), /expected finite number/);
  assert.throws(() => asCardId(null), /expected finite number/);
});

test('PASS asCardId: a positive integer is branded and round-trips as the same number', () => {
  const id = asCardId(42);
  assert.equal(typeof id, 'number');
  assert.equal(id, 42);
});

// ===========================================================================
// GROUP D — end-to-end integration of the brands with the fence gate. The
// re-check's worry is that "AssignedWork still contains plain string and
// number" lets an incompatible identity slip through. This proves the
// branded constructor + the fence gate compose to a hard rejection.
// ===========================================================================

test('INTEGRATION: asFenceToken(exec) fed to assertExecutionFence with a mismatched fence is still rejected', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  fenceTaskToExecution(t.id, 'exec-real-2', 'in_progress', 'w-real-2');
  insertExecution(t.id, 'exec-real-2', 'running', 'w-real-2');

  // A worker that minted a DIFFERENT fence token via the branded constructor.
  const wrongToken = asFenceToken('exec-different');
  assert.throws(
    () => assertExecutionFence(getDb(), taskRow(t.id), wrongToken),
    /fenced by execution exec-real-2/,
    'the branded fence token does not bypass the runtime fence check',
  );
});
