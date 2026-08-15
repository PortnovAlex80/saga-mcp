/**
 * WorkAssignmentPort contract tests — the conveyor-physics acceptance gate.
 *
 * WORK-ASSIGNMENT-REFACTOR-SPEC §4 Wave A acceptance:
 *   - assignTask is one transaction (BEGIN IMMEDIATE … COMMIT).
 *   - Returns AssignedWork | null; null when no card claimable.
 *   - SELECT includes ALL gates: status, unassigned, project/epic,
 *     process_run_id authority, current_execution_id fence, no active
 *     worker_executions, dependencies done+merged, conflict-key serialization.
 *   - ORDER BY review-first → priority ASC → created_at.
 *   - INSERT worker_executions with frozen execution_context + hash.
 *   - Same atomic core as worker_next (single source of truth).
 *
 * These tests verify the adapter delegates to the proven findNextClaimable
 * path and produces a correctly-shaped AssignedWork.
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
import { SqliteWorkAssignmentAdapter } from '../../dist/infrastructure/work/sqlite-work-assignment-adapter.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-wa-'));
process.env.DB_PATH = path.join(temp, 'wa.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

/** Stamp process_run_id onto a task's metadata — the saga4 authority gate. */
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

function setupProject() {
  const p = projects.project_create({ name: `wa-test-${Date.now()}` });
  const e = epics.epic_create({ project_id: p.id, name: 'WA epic' });
  return { projectId: p.id, epicId: e.id };
}

function makeTodoTask(epicId, overrides = {}) {
  return tasks.task_create({ epic_id: epicId, title: overrides.title ?? 't', ...overrides });
}

test('assignTask returns null when no card is claimable (empty queue)', () => {
  const { projectId } = setupProject();
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const result = adapter.assignTask({
    projectId,
    workerId: 'w1',
    workerExecutionId: 'exec-empty-1',
    runId: 'r1',
    machineId: 'm1',
  });
  assert.equal(result, null);
});

test('assignTask flips todo→in_progress and sets the fence (current_execution_id)', () => {
  const { projectId, epicId } = setupProject();
  const task = makeTodoTask(epicId, { title: 'claimable' });
  stampProcessRun(task.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  const work = adapter.assignTask({
    projectId,
    workerId: 'w-claim',
    workerExecutionId: 'exec-fence-1',
    runId: 'r1',
    machineId: 'm1',
  });

  assert.notEqual(work, null);
  assert.equal(work.taskId, task.id);
  assert.equal(work.status, 'in_progress');
  assert.equal(work.fenceToken, 'exec-fence-1');
  assert.equal(work.workerExecutionId, 'exec-fence-1');
  assert.equal(work.workerId, 'w-claim');

  // The fence is stamped on the task row.
  const row = getDb().prepare('SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?').get(task.id);
  assert.equal(row.status, 'in_progress');
  assert.equal(row.assigned_to, 'w-claim');
  assert.equal(row.current_execution_id, 'exec-fence-1');
});

test('assignTask chooses review before todo (review-first ordering)', () => {
  const { projectId, epicId } = setupProject();
  const todoTask = makeTodoTask(epicId, { title: 'todo', priority: 'critical' });
  // Create the review task AFTER the todo, so created_at would favor todo if
  // ordering ignored status. Review must still win.
  const reviewTask = makeTodoTask(epicId, { title: 'review', priority: 'low' });
  stampProcessRun(todoTask.id);
  stampProcessRun(reviewTask.id);
  // task_update ignores status (only the dispatcher may change it). A review-
  // buffer card is produced by worker_done moving in_progress→review. We set
  // the status directly here to stage the ordering test without the full
  // worker_done cycle.
  getDb().prepare("UPDATE tasks SET status='review' WHERE id=?").run(reviewTask.id);

  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId,
    workerId: 'w-order',
    workerExecutionId: 'exec-order-1',
    runId: 'r1',
    machineId: 'm1',
  });

  assert.notEqual(work, null);
  assert.equal(work.taskId, reviewTask.id, 'review task chosen before todo despite lower priority');
  assert.equal(work.status, 'review_in_progress');
});

test('assignTask returns null when the only card lacks process_run_id (authority gate)', () => {
  const { projectId, epicId } = setupProject();
  const task = makeTodoTask(epicId, { title: 'no-authority' });
  // Deliberately do NOT stamp process_run_id.
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId,
    workerId: 'w-auth',
    workerExecutionId: 'exec-auth-1',
    runId: 'r1',
    machineId: 'm1',
  });
  assert.equal(work, null, 'a card without process_run_id must not be assignable');
});

test('assignTask excludes a card whose dependencies are not done', () => {
  const { projectId, epicId } = setupProject();
  const dep = makeTodoTask(epicId, { title: 'dep' });
  const dependent = makeTodoTask(epicId, { title: 'dependent', depends_on: [dep.id] });
  stampProcessRun(dep.id);
  stampProcessRun(dependent.id);

  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId,
    workerId: 'w-dep',
    workerExecutionId: 'exec-dep-1',
    runId: 'r1',
    machineId: 'm1',
  });

  // dep is claimable (no deps); dependent is not. The claim returns dep, not dependent.
  assert.notEqual(work, null);
  assert.equal(work.taskId, dep.id, 'the dependency-free card is chosen, the dependent is excluded');
});

test('assignTask creates a worker_executions row with the fence token', () => {
  const { projectId, epicId } = setupProject();
  const task = makeTodoTask(epicId, { title: 'exec-row' });
  stampProcessRun(task.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  adapter.assignTask({
    projectId,
    workerId: 'w-exec',
    workerExecutionId: 'exec-row-1',
    runId: 'run-1',
    machineId: 'm1',
  });

  const exec = getDb().prepare('SELECT execution_id, task_id, state, phase FROM worker_executions WHERE execution_id=?').get('exec-row-1');
  assert.notEqual(exec, null, 'worker_executions row created at assign time');
  assert.equal(exec.task_id, task.id);
  assert.equal(exec.state, 'reserved');
  assert.equal(exec.phase, 'executing');
});

test('assignTask two callers for the same scope never both win (fence excludes 2nd)', () => {
  const { projectId, epicId } = setupProject();
  const task = makeTodoTask(epicId, { title: 'race' });
  stampProcessRun(task.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  const first = adapter.assignTask({
    projectId,
    workerId: 'w-a',
    workerExecutionId: 'exec-race-a',
    runId: 'r1',
    machineId: 'm1',
  });
  const second = adapter.assignTask({
    projectId,
    workerId: 'w-b',
    workerExecutionId: 'exec-race-b',
    runId: 'r1',
    machineId: 'm1',
  });

  assert.notEqual(first, null);
  assert.equal(first.taskId, task.id);
  assert.equal(second, null, 'second caller gets null — the card is already fenced by the first');
});

test('releaseAssignment returns the card to the queue', () => {
  const { projectId, epicId } = setupProject();
  const task = makeTodoTask(epicId, { title: 'release' });
  stampProcessRun(task.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  const work = adapter.assignTask({
    projectId,
    workerId: 'w-rel',
    workerExecutionId: 'exec-rel-1',
    runId: 'r1',
    machineId: 'm1',
  });
  assert.notEqual(work, null);

  adapter.releaseAssignment({
    taskId: task.id,
    workerExecutionId: 'exec-rel-1',
    reason: 'spawn-failure test',
  });

  const row = getDb().prepare('SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?').get(task.id);
  assert.equal(row.status, 'todo', 'card returned to todo after release');
  assert.equal(row.assigned_to, null, 'assignment cleared');
  assert.equal(row.current_execution_id, null, 'fence cleared');
});
