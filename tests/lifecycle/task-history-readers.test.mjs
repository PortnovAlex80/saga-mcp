// tests/lifecycle/task-history-readers.test.mjs
//
// BLINDSIGHT Worker/Tool layer — typed history readers for prompt delivery.
//
// The factory persistently RECORDS the right information and consistently
// fails to READ it at the point of decision (PREVENTIVE-HUNT «Слепота по
// слоям»). These tests pin the two readers that close the delivery gap:
//
//   readTaskFeedbackHistory — the FULL multi-round feedback history from
//     durable append-only sources (factory_submission_validation_rejections +
//     comments; review rounds classified via command_receipts). Depth is NOT
//     1: metadata.managed_review_last_feedback is overwritten every round,
//     but these tables are append-only, so history accumulates.
//
//   readTaskDeathHistory — prior abnormal executions of a card
//     (worker_executions state lost/spawn_failed/terminated + exited-with-
//     last_error, carrying last_error incl. REPEATED_TOOL_LOOP). The claim SQL
//     only ever looks at live states, so without this reader a card that
//     killed 4 workers with the same error looks identical to a healthy card.
//
// Hermetic: tmp SQLite DB created through the normal db.ts schema path; no
// factory run, no shared DB touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-history-readers-'));
process.env.DB_PATH = path.join(temp, 'history.db');

const { closeDb, getDb } = await import('../../dist/db.js');
const projects = (await import('../../dist/tools/projects.js')).handlers;
const epics = (await import('../../dist/tools/epics.js')).handlers;
const tasks = (await import('../../dist/tools/tasks.js')).handlers;
const {
  readTaskFeedbackHistory,
  readTaskDeathHistory,
} = await import('../../dist/lifecycle/task-history-readers.js');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function makeTask() {
  const product = projects.project_create({
    name: `History ${Math.random().toString(36).slice(2, 6)}`,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  const task = tasks.task_create({
    epic_id: epic.id,
    title: `T-${Math.random().toString(36).slice(2, 6)}`,
    task_kind: 'development.code',
    execution_mode: 'git_change',
  });
  return task;
}

function insertSubmissionRejection(taskId, executionId, code, at, gapMessages) {
  getDb().prepare(
    `INSERT INTO factory_submission_validation_rejections
       (rejection_ref, rejection_digest, validator_id, validator_version,
        process_run_id, module_ref, node_id, execution_id, task_id,
        actor_kind, rejection_code, gaps_json, details_json,
        input_snapshot_hash, observed_artifacts, observed_set_digest,
        feedback_json, rejected_at)
     VALUES (?, ?, 'test-validator', '1.0.0', 10, 'dev@1.0.0', 'author', ?, ?,
             'managed_execution', ?, ?, '{}',
             'hash-1', '[]', 'digest-1', '{}', ?)`,
  ).run(
    `rej-${executionId}-${code}`,
    `digest-${executionId}-${code}`,
    executionId,
    taskId,
    code,
    JSON.stringify(gapMessages.map((message, index) => ({
      artifactId: index + 1,
      artifactCode: `artifact-${index + 1}`,
      message,
      missing: { relation: 'trace', requiredTargetTypes: ['verification'] },
      existingTargets: [],
    }))),
    at,
  );
}

function insertReviewRejection(taskId, executionId, reviewerWorkerId, feedbackText, at) {
  const db = getDb();
  // The receipt the dispatcher's worker_done writes for changes_requested.
  db.prepare(
    `INSERT INTO command_receipts
       (command_id, command_kind, actor_kind, actor_id, execution_id, task_id,
        payload_hash, accepted, rejection_code, result_json, reply_json, accepted_at)
     VALUES (?, 'worker_done', 'managed_execution', ?, ?, ?, 'ph', 1, NULL,
             '{}', '{}', ?)`,
  ).run(
    `${executionId}:worker-done:changes_requested`,
    reviewerWorkerId,
    executionId,
    taskId,
    at,
  );
  // The durable comment carrying the reviewer's full feedback text (same
  // transaction in production → same timestamp).
  db.prepare(
    'INSERT INTO comments (task_id, author, content, created_at) VALUES (?, ?, ?, ?)',
  ).run(taskId, reviewerWorkerId, feedbackText, at);
}

function insertAuthorResultComment(taskId, authorWorkerId, text, at) {
  getDb().prepare(
    'INSERT INTO comments (task_id, author, content, created_at) VALUES (?, ?, ?, ?)',
  ).run(taskId, authorWorkerId, text, at);
}

test('readTaskFeedbackHistory accumulates ALL rounds from durable sources, not just the last', () => {
  const task = makeTask();
  // Round 1: author submits; submission validation rejects.
  insertSubmissionRejection(task.id, 'exec-h1', 'SUBMISSION_TRACE_MISSING', '2026-08-17 10:00:00', [
    "artifact-1: trace relation requires verification",
  ]);
  // Round 2: author resubmits and completes; reviewer sends it back.
  insertReviewRejection(
    task.id, 'exec-h2', 'reviewer-1',
    'Round 1 review: AC-2 step missing.',
    '2026-08-17 11:00:00',
  );
  // Round 3: second review rejection (the metadata copy keeps ONLY this one).
  insertReviewRejection(
    task.id, 'exec-h3', 'reviewer-2',
    'Round 2 review: merge crash on null input still present.',
    '2026-08-17 12:00:00',
  );
  // An author completion summary comment (no rejection receipt) must be kept
  // as worker_result_comment, not lost.
  insertAuthorResultComment(
    task.id, 'author-1',
    'Implemented merge guard; all local tests pass.',
    '2026-08-17 10:30:00',
  );

  const history = readTaskFeedbackHistory(getDb(), task.id);
  assert.ok(history, 'history must be returned when any durable feedback exists');
  assert.equal(history.taskId, task.id);
  assert.equal(history.entries.length, 4, 'every round must appear — depth is not 1');

  const kinds = history.entries.map(entry => entry.kind);
  assert.deepEqual(kinds, [
    'submission_rejection',
    'worker_result_comment',
    'review_rejection',
    'review_rejection',
  ], 'entries must be chronological and kind-classified');

  const [submission, authorComment, review1, review2] = history.entries;
  assert.equal(submission.kind, 'submission_rejection');
  assert.equal(submission.rejectionCode, 'SUBMISSION_TRACE_MISSING');
  assert.deepEqual(submission.findingMessages, [
    'artifact-1: trace relation requires verification',
  ]);
  assert.equal(submission.executionId, 'exec-h1');

  assert.equal(authorComment.kind, 'worker_result_comment');
  assert.equal(authorComment.author, 'author-1');
  assert.equal(authorComment.content, 'Implemented merge guard; all local tests pass.');

  assert.equal(review1.kind, 'review_rejection');
  assert.equal(review1.feedback, 'Round 1 review: AC-2 step missing.');
  assert.equal(review1.reviewerWorkerId, 'reviewer-1');
  assert.equal(review2.feedback, 'Round 2 review: merge crash on null input still present.');

  assert.equal(history.reviewRejections, 2);
  assert.equal(history.submissionRejections, 1);
});

test('readTaskFeedbackHistory returns null for a card with no durable feedback', () => {
  const task = makeTask();
  assert.equal(readTaskFeedbackHistory(getDb(), task.id), null);
});

test('readTaskFeedbackHistory keeps a review rejection even when its comment row is missing (fail-visible)', () => {
  const task = makeTask();
  const db = getDb();
  db.prepare(
    `INSERT INTO command_receipts
       (command_id, command_kind, actor_kind, actor_id, execution_id, task_id,
        payload_hash, accepted, result_json, reply_json, accepted_at)
     VALUES (?, 'worker_done', 'managed_execution', 'reviewer-x', 'exec-orphan', ?,
             'ph', 1, '{}', '{}', '2026-08-17 13:00:00')`,
  ).run('exec-orphan:worker-done:changes_requested', task.id);

  const history = readTaskFeedbackHistory(db, task.id);
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].kind, 'review_rejection');
  assert.equal(history.entries[0].feedback, null, 'missing text is visible as null, never fabricated');
});

test('readTaskDeathHistory surfaces prior abnormal executions with last_error', () => {
  const task = makeTask();
  const db = getDb();
  const insertExecution = (executionId, workerId, state, lastError, finishedAt) => {
    db.prepare(
      `INSERT INTO worker_executions
         (execution_id, run_id, project_id, epic_id, task_id, worker_id,
          machine_id, state, phase, last_error, finished_at, reserved_at, phase_updated_at)
       VALUES (?, 'run-x',
         (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
         (SELECT epic_id FROM tasks WHERE id=?), ?, ?, 'host-1', ?, 'executing', ?, ?,
         datetime('now'), datetime('now'))`,
    ).run(executionId, task.id, task.id, task.id, workerId, state, lastError, finishedAt);
  };
  insertExecution('exec-d1', 'worker-a', 'spawn_failed', 'Claude spawn failed: ENOENT', '2026-08-17 01:00:00');
  insertExecution('exec-d2', 'worker-b', 'lost', 'REPEATED_TOOL_LOOP: Write repeated 12 times with identical input', '2026-08-17 02:00:00');
  insertExecution('exec-d3', 'worker-c', 'terminated', 'progress silence past cancel grace', '2026-08-17 03:00:00');
  // Abnormal exit WITH a durable error must not be invisible either.
  insertExecution('exec-d4', 'worker-d', 'exited', 'crashed with diagnostics', '2026-08-17 04:00:00');
  // Normal completions must NOT count as deaths.
  insertExecution('exec-ok1', 'worker-e', 'exited', null, '2026-08-17 05:00:00');
  // Live states must NOT count.
  insertExecution('exec-live', 'worker-f', 'running', null, null);

  const deaths = readTaskDeathHistory(db, task.id);
  assert.equal(deaths.taskId, task.id);
  assert.equal(deaths.priorAttempts, 4, 'spawn_failed/lost/terminated/exited-with-error count; clean exits and live rows do not');
  assert.deepEqual(deaths.deaths.map(death => death.state), [
    'spawn_failed', 'lost', 'terminated', 'exited',
  ]);
  const loop = deaths.deaths.find(death => death.executionId === 'exec-d2');
  assert.equal(
    loop.lastError,
    'REPEATED_TOOL_LOOP: Write repeated 12 times with identical input',
    'the last_error that killed prior workers must be readable by the next worker',
  );
  assert.equal(loop.workerId, 'worker-b');
});

test('readTaskDeathHistory is zero for a healthy card', () => {
  const task = makeTask();
  const deaths = readTaskDeathHistory(getDb(), task.id);
  assert.equal(deaths.priorAttempts, 0);
  assert.deepEqual(deaths.deaths, []);
});
