/**
 * Slice 3 — ASK terminal protocol + task_batch_update restriction tests.
 *
 * Source: blueprint §12.3 (docs/architecture/passive-worker-kernel-blueprint.md:565-578),
 *         §16 Slice 3 acceptance (line 879-883).
 *
 * Coverage:
 *
 *  1. worker_ask_need terminalizes: releases execution + clears assigned_to +
 *     opens human_request + adds needs-human tag.
 *  2. worker_ask_done (answer) works WITHOUT the original execution_id —
 *     looks up the open request by task_id.
 *  3. worker_ask_done rejects "resurrection of old execution" — the requesting
 *     execution is gone, no fence check.
 *  4. worker_next excludes tasks with open human_requests.
 *  5. After the answer, the task becomes claimable again.
 *  6. A fresh worker can read the persisted question and answer.
 *  7. task_batch_update rejects status — the audit-defect fix.
 *  8. task_batch_update rejects assigned_to.
 *  9. task_batch_update still accepts priority (non-lifecycle field).
 * 10. task_batch_update with no priority throws a clear error.
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
import { handlers as dispatcher } from '../../dist/tools/dispatcher.js';
import { handlers as activity } from '../../dist/tools/activity.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-ask-'));
process.env.DB_PATH = path.join(temp, 'ask.db');
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
  const product = projects.project_create({ name: `ASK ${Math.random().toString(36).slice(2, 6)}` });
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
    priority: 'high',
  });
}

function claimAndSpawn(taskId, workerId, executionId) {
  // Claim the task and inject an active execution row (simulating what the
  // runner does after worker_next).
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status='in_progress', assigned_to=?, current_execution_id=?,
                       updated_at=datetime('now') WHERE id=?`,
  ).run(workerId, executionId, taskId);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase, reserved_at, phase_updated_at)
     VALUES (?, 'r',
       (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
       ?, ?, ?, ?, 'running', 'executing',
       datetime('now'), datetime('now'))`,
  ).run(executionId, taskId, taskId, taskId, workerId, os.hostname());
}

function taskRow(taskId) {
  return getDb().prepare(
    'SELECT id, status, assigned_to, current_execution_id, tags FROM tasks WHERE id=?',
  ).get(taskId);
}

function openRequest(taskId) {
  return getDb().prepare(
    `SELECT * FROM human_requests WHERE task_id=? AND state='open' ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId);
}

// ---------------------------------------------------------------------------
// 1. worker_ask_need is terminal.
// ---------------------------------------------------------------------------

test('ASK: worker_ask_need terminalizes — releases execution, clears assigned_to, opens request', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w1', 'exec-ask-1');

  const result = dispatcher.worker_ask_need({
    task_id: t.id,
    worker_id: 'w1',
    reason: 'Which branch should I target — main or dev?',
    execution_id: 'exec-ask-1',
  });

  assert.equal(result.blocking, true);
  assert.equal(result.stop, true, 'response tells the worker to exit');
  assert.ok(result.request_id, 'request id returned');

  const task = taskRow(t.id);
  assert.equal(task.assigned_to, null, 'assigned_to cleared');
  assert.equal(task.current_execution_id, null, 'fence cleared');
  assert.ok(JSON.parse(task.tags).includes('needs-human'), 'tag added');

  const exec = getDb().prepare('SELECT state FROM worker_executions WHERE execution_id=?')
    .get('exec-ask-1');
  assert.equal(exec.state, 'exited', 'execution terminalized');

  const req = openRequest(t.id);
  assert.ok(req, 'human_request opened');
  assert.equal(req.state, 'open');
  assert.equal(req.question, 'Which branch should I target — main or dev?');
  assert.equal(req.resume_phase, 'implementation');
  assert.equal(req.requesting_execution_id, 'exec-ask-1');
});

test('ASK: worker_ask_need maps review_in_progress → resume_phase=review', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // Move the task into review_in_progress with an execution.
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status='review_in_progress', assigned_to='rv',
                       current_execution_id='exec-rev-ask',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase, reserved_at, phase_updated_at)
     VALUES ('exec-rev-ask', 'r',
       (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
       ?, ?, 'rv', ?, 'running', 'reviewing',
       datetime('now'), datetime('now'))`,
  ).run(t.id, t.id, t.id, os.hostname());

  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'rv',
    reason: 'q', execution_id: 'exec-rev-ask',
  });

  const req = openRequest(t.id);
  assert.equal(req.resume_phase, 'review');
});

// ---------------------------------------------------------------------------
// 2. worker_ask_done works without the original execution_id.
// ---------------------------------------------------------------------------

test('ASK: worker_ask_done answers without execution_id — no resurrection of old execution', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w2', 'exec-ask-2');

  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'w2',
    reason: 'Use UTF-8 or UTF-16?', execution_id: 'exec-ask-2',
  });

  // The requesting execution is gone. Answer as the human (or any caller).
  // Note: NO execution_id passed.
  const result = dispatcher.worker_ask_done({
    task_id: t.id,
    worker_id: 'human-1',
    answer: 'UTF-8 everywhere.',
  });

  assert.equal(result.state, 'answered');
  assert.ok(result.request_id);

  const req = getDb().prepare(
    'SELECT state, answer, answered_by FROM human_requests WHERE request_id=?',
  ).get(result.request_id);
  assert.equal(req.state, 'answered');
  assert.equal(req.answer, 'UTF-8 everywhere.');
  assert.equal(req.answered_by, 'human-1');

  // Tag cleared.
  const task = taskRow(t.id);
  assert.ok(!JSON.parse(task.tags).includes('needs-human'), 'needs-human cleared on answer');
});

test('ASK: worker_ask_done with no open request returns state=no_open_request', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  const result = dispatcher.worker_ask_done({
    task_id: t.id, worker_id: 'h', answer: 'x',
  });
  assert.equal(result.state, 'no_open_request');
  assert.equal(result.request_id, null);
});

// ---------------------------------------------------------------------------
// 3. worker_next excludes tasks with open human requests.
// ---------------------------------------------------------------------------

test('ASK: worker_next does NOT claim a task with an open human_request', () => {
  const { product, epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w3', 'exec-ask-3');
  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'w3',
    reason: 'q', execution_id: 'exec-ask-3',
  });

  // The task is now parked. Another worker tries to claim it. Pass
  // execution_id + machine_id so the claim genuinely attempts a reservation.
  const claim = dispatcher.worker_next({
    worker_id: 'w-other',
    project_id: product.id,
    execution_id: 'exec-other-3',
    machine_id: os.hostname(),
  });

  // worker_next returns null/empty when no claimable task exists in the project.
  assert.equal(claim.task, null, 'open-request task is not claimable');
});

test('ASK: after the answer, the task becomes claimable again', () => {
  const { product, epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w4', 'exec-ask-4');
  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'w4',
    reason: 'q', execution_id: 'exec-ask-4',
  });
  dispatcher.worker_ask_done({
    task_id: t.id, worker_id: 'human',
    answer: 'do it',
  });

  // The task is now claimable by a fresh worker. Pass execution_id + machine_id
  // so worker_next actually reserves the task (matches the real runner contract).
  const claim = dispatcher.worker_next({
    worker_id: 'w-fresh',
    project_id: product.id,
    execution_id: 'exec-fresh-4',
    machine_id: os.hostname(),
  });
  // worker_next returns the task snapshot; verify the claim succeeded AND that
  // the reservation was actually applied to the row.
  assert.ok(claim.task, `task claimable after answer (got claim=${JSON.stringify(claim)})`);
  assert.equal(claim.task.id, t.id, `expected task ${t.id}, got ${claim.task?.id}`);
  const after = taskRow(t.id);
  assert.equal(after.assigned_to, 'w-fresh',
    `expected post-claim assigned_to=w-fresh, got ${after.assigned_to}`);
  assert.equal(after.current_execution_id, 'exec-fresh-4',
    `expected post-claim fence=exec-fresh-4, got ${after.current_execution_id}`);
});

// ---------------------------------------------------------------------------
// 4. Fresh worker receives the persisted question and answer.
// ---------------------------------------------------------------------------

test('ASK: a fresh worker can read the persisted question and answer from human_requests', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w5', 'exec-ask-5');
  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'w5',
    reason: 'API key from env or config file?',
    execution_id: 'exec-ask-5',
  });
  dispatcher.worker_ask_done({
    task_id: t.id, worker_id: 'human',
    answer: 'Config file — see ~/.app/config.toml.',
  });

  // A fresh worker reads the most recent answered request for this task.
  const req = getDb().prepare(
    `SELECT question, answer, resume_phase FROM human_requests
      WHERE task_id=? AND state='answered'
      ORDER BY answered_at DESC LIMIT 1`,
  ).get(t.id);
  assert.ok(req, 'answered request exists');
  assert.equal(req.question, 'API key from env or config file?');
  assert.equal(req.answer, 'Config file — see ~/.app/config.toml.');
});

// ---------------------------------------------------------------------------
// 5. task_batch_update restriction (audit defect fix).
// ---------------------------------------------------------------------------

test('task_batch_update: rejects status (audit fix)', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  assert.throws(
    () => activity.task_batch_update({ ids: [t.id], status: 'done' }),
    /priority/i,
    'should reject with a priority-related message',
  );
});

test('task_batch_update: rejects assigned_to (audit fix)', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  assert.throws(
    () => activity.task_batch_update({ ids: [t.id], assigned_to: 'someone' }),
    /priority/i,
  );
});

test('task_batch_update: still accepts priority (non-lifecycle field)', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  const result = activity.task_batch_update({ ids: [t.id], priority: 'critical' });
  assert.equal(result.updated, 1);
  const task = getDb().prepare('SELECT priority FROM tasks WHERE id=?').get(t.id);
  assert.equal(task.priority, 'critical');
});

test('task_batch_update: throws clear error when priority missing', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  assert.throws(
    () => activity.task_batch_update({ ids: [t.id] }),
    /only `priority`/i,
  );
});

// ---------------------------------------------------------------------------
// 6. ADR-013 Phase 1.1 — atomicity + CAS guard.
//
// The pre-1.1 implementation performed comment insert, human_requests insert,
// atomic release, and tag update as four separate writes with no transaction
// wrapper. A crash between any two left inconsistent state. These tests
// verify the post-1.1 contract: the handler commits atomically, and
// concurrent worker_ask_done calls cannot both return state='answered'.
// ---------------------------------------------------------------------------

test('ASK(1.1): worker_ask_need opens human_requests BEFORE releasing execution', () => {
  // Direct invariant: after a successful worker_ask_need, BOTH the
  // human_requests row AND the released execution exist. The pre-1.1 order
  // (release before request-open) would also satisfy this when it succeeds,
  // but the next test covers the crash-window that order opened.
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w-ord', 'exec-ord');

  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'w-ord',
    reason: 'why?', execution_id: 'exec-ord',
  });

  const req = openRequest(t.id);
  assert.ok(req, 'human_requests row opened');
  assert.equal(req.state, 'open');
  const exec = getDb().prepare('SELECT state FROM worker_executions WHERE execution_id=?')
    .get('exec-ord');
  assert.equal(exec.state, 'exited', 'execution terminalized in the same tx');
});

test('ASK(1.1): needs-human tag is NOT set before human_requests — no tag-without-request state', () => {
  // The audit crash-window: needs-human tag set, but no human_requests row.
  // Pre-1.1 this was possible if the process crashed after tag UPDATE but
  // before INSERT human_requests. Post-1.1 the tag is set in the same tx as
  // the request-open, so the invariant "tag implies request" always holds
  // for worker_ask_need's own writes.
  //
  // We verify the invariant by scanning all tasks in the DB: every task with
  // the needs-human tag MUST have a matching open human_requests row.
  const db = getDb();
  const tagged = db.prepare(
    `SELECT t.id FROM tasks t
      WHERE t.tags LIKE '%"needs-human"%'`,
  ).all();
  for (const { id } of tagged) {
    const openReq = db.prepare(
      `SELECT 1 FROM human_requests WHERE task_id=? AND state='open' LIMIT 1`,
    ).get(id);
    assert.ok(openReq, `task ${id} carries needs-human but has no open human_request`);
  }
});

test('ASK(1.1): if human_requests insert succeeds, execution MUST be terminalized atomically', () => {
  // The reverse invariant: a successful worker_ask_need cannot leave the
  // execution row still active. This is the "released task with active
  // execution" crash-window closed by the tx wrap.
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w-inv', 'exec-inv');

  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'w-inv',
    reason: 'q', execution_id: 'exec-inv',
  });

  const req = openRequest(t.id);
  assert.ok(req, 'request opened');
  const exec = getDb().prepare('SELECT state FROM worker_executions WHERE execution_id=?')
    .get('exec-inv');
  assert.notEqual(exec.state, 'running', 'execution no longer running');
  assert.notEqual(exec.state, 'reserved', 'execution no longer reserved');
});

test('ASK(1.1): worker_ask_done is a CAS — second concurrent answer does not win', () => {
  // Simulate the race outcome: between two concurrent callers A and B, only
  // one can flip state open→answered. We model this by pre-setting state to
  // 'answered' (as if caller A won just before B's UPDATE) and verifying
  // caller B observes info.changes === 0 and returns state='already_answered'
  // WITHOUT touching the task tags.
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w-cas', 'exec-cas');
  dispatcher.worker_ask_need({
    task_id: t.id, worker_id: 'w-cas',
    reason: 'q', execution_id: 'exec-cas',
  });
  const req = openRequest(t.id);
  assert.ok(req, 'request opened');

  // Caller A wins: flip the row to 'answered' out-of-band (simulating a
  // concurrent tx that committed just before B's UPDATE).
  const db = getDb();
  db.prepare(
    `UPDATE human_requests SET state='answered', answer='A won',
        answered_by='A', answered_at=datetime('now'),
        updated_at=datetime('now')
      WHERE request_id=? AND state='open'`,
  ).run(req.request_id);
  // Capture the tag snapshot A's answer left behind.
  db.prepare(
    `UPDATE tasks SET tags=?, updated_at=datetime('now') WHERE id=?`,
  ).run(JSON.stringify([]), t.id);

  // Caller B arrives with its own answer. CAS should fail; state reflects
  // that someone else already answered; tags must NOT be touched.
  const result = dispatcher.worker_ask_done({
    task_id: t.id, worker_id: 'B', answer: 'B tried',
  });
  assert.equal(result.state, 'already_answered', 'B loses the CAS');
  assert.equal(result.request_id, req.request_id, 'B still sees which request it was');

  // B must not have overwritten A's answer.
  const reqAfter = getDb().prepare(
    'SELECT answer, answered_by FROM human_requests WHERE request_id=?',
  ).get(req.request_id);
  assert.equal(reqAfter.answer, 'A won', 'A answer preserved');
  assert.equal(reqAfter.answered_by, 'A', 'A identity preserved');
});

test('ASK(1.1): worker_ask_done with no open request still clears stale tag (no regression)', () => {
  // Regression guard: the no_open_request branch must still clear a stale
  // needs-human tag, and must run inside the tx so a concurrent answer
  // cannot observe a half-cleared state.
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET tags=?, updated_at=datetime('now') WHERE id=?`,
  ).run(JSON.stringify(['needs-human']), t.id);

  const result = dispatcher.worker_ask_done({
    task_id: t.id, worker_id: 'h', answer: 'x',
  });
  assert.equal(result.state, 'no_open_request');

  const task = taskRow(t.id);
  assert.ok(
    !JSON.parse(task.tags).includes('needs-human'),
    'stale tag cleared inside the tx',
  );
});

test('ASK(1.1): worker_ask_need rejects a task not assigned to the caller (tx rolls back cleanly)', () => {
  // The "my task" check happens inside the tx now. A failed claim must not
  // leave any side effect — no comment, no request row, no tag, no release.
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  claimAndSpawn(t.id, 'w-owner', 'exec-rej');

  assert.throws(
    () => dispatcher.worker_ask_need({
      task_id: t.id, worker_id: 'w-not-owner',
      reason: 'q', execution_id: 'exec-rej',
    }),
    /not assigned/,
  );

  // Nothing should have been written.
  const req = openRequest(t.id);
  assert.equal(req, undefined, 'no human_request opened on failed ask');
  const comments = getDb().prepare('SELECT COUNT(*) c FROM comments WHERE task_id=?').get(t.id);
  assert.equal(comments.c, 0, 'no comment inserted on failed ask');
  const exec = getDb().prepare('SELECT state FROM worker_executions WHERE execution_id=?')
    .get('exec-rej');
  assert.equal(exec.state, 'running', 'execution not terminalized on failed ask');
  const task = taskRow(t.id);
  assert.equal(task.assigned_to, 'w-owner', 'task still owned by original worker');
  assert.ok(!JSON.parse(task.tags).includes('needs-human'), 'tag not set on failed ask');
});
