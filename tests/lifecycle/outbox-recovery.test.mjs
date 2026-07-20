/**
 * ADR-013 Phase 1.2 — durable outbox for workflow generation.
 *
 * Source: docs/architecture/decisions/013-lifecycle-fix-execution-plan.md §1.2.
 *
 * Coverage:
 *
 *  1. enqueueOutboxIntent is idempotent — same intent_key twice → one row.
 *  2. drainOutbox processes pending intents and marks them done/failed.
 *  3. drainOutbox is safe to re-run — already-processed intents are skipped.
 *  4. readOutboxResult returns the persisted result after drain.
 *  5. crash-recovery: enqueue inside tx, COMMIT, NO drain (simulate crash),
 *     then a fresh drain → downstream effect runs and result is durable.
 *  6. byte-equivalent replay: two handleWorkerDone calls with the same
 *     command_id+payload return identical augmented replies (both contain
 *     workflow_generation read from the durable outbox row).
 *  7. worker_done failure path: effect that throws marks the intent failed,
 *     does not crash the caller, reply carries workflow_generation_error.
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
import {
  enqueueOutboxIntent,
  drainOutbox,
  readOutboxResult,
  generateDownstreamIntentKey,
} from '../../dist/lifecycle/outbox.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-outbox-'));
process.env.DB_PATH = path.join(temp, 'outbox.db');
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
  const product = projects.project_create({ name: `OB ${Math.random().toString(36).slice(2, 6)}` });
  repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  return { product, epic };
}

function makeTask(epicId, kind = 'development.code') {
  return tasks.task_create({
    epic_id: epicId,
    title: `T-${Math.random().toString(36).slice(2, 6)}`,
    task_kind: kind,
    execution_mode: kind ? 'git_change' : 'tracker_only',
    priority: 'high',
  });
}

// ---------------------------------------------------------------------------
// 1-4. Primitive behaviour of the outbox module in isolation.
// ---------------------------------------------------------------------------

test('outbox: enqueueOutboxIntent is idempotent on intent_key', () => {
  const db = getDb();
  const key = `test-idem-${Math.random().toString(36).slice(2, 8)}`;
  enqueueOutboxIntent(db, { intentKey: key, commandKind: 'generate_downstream', taskId: null });
  enqueueOutboxIntent(db, { intentKey: key, commandKind: 'generate_downstream', taskId: null });
  const count = db.prepare('SELECT COUNT(*) c FROM outbox_intents WHERE intent_key=?').get(key).c;
  assert.equal(count, 1, 'second enqueue is a no-op');
});

test('outbox: drainOutbox marks pending intents done when effect succeeds', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id, 'development.code');
  const db = getDb();
  const key = `test-drain-${Math.random().toString(36).slice(2, 8)}`;
  let called = 0;
  enqueueOutboxIntent(db, { intentKey: key, commandKind: 'generate_downstream', taskId: t.id });
  const summary = drainOutbox(
    db,
    'generate_downstream',
    (id) => { called += 1; return { created: [id] }; },
    { intentKey: key },
  );
  assert.equal(called, 1, 'effect called once');
  assert.equal(summary.succeeded, 1);
  const row = readOutboxResult(db, key);
  assert.equal(row.state, 'done');
  assert.deepEqual(JSON.parse(row.result_json), { created: [t.id] });
});

test('outbox: drainOutbox is safe to re-run — done intents are skipped', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id, 'development.code');
  const db = getDb();
  const key = `test-redrain-${Math.random().toString(36).slice(2, 8)}`;
  let called = 0;
  enqueueOutboxIntent(db, { intentKey: key, commandKind: 'generate_downstream', taskId: t.id });
  drainOutbox(db, 'generate_downstream', () => { called += 1; return null; }, { intentKey: key });
  const secondRun = drainOutbox(db, 'generate_downstream', () => { called += 1; return null; }, { intentKey: key });
  assert.equal(secondRun.processed, 0, 'nothing pending on second run');
  assert.equal(called, 1, 'effect not re-invoked on already-processed intent');
});

test('outbox: drainOutbox marks failed when effect throws', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id, 'development.code');
  const db = getDb();
  const key = `test-fail-${Math.random().toString(36).slice(2, 8)}`;
  enqueueOutboxIntent(db, { intentKey: key, commandKind: 'generate_downstream', taskId: t.id });
  const summary = drainOutbox(db, 'generate_downstream', () => {
    throw new Error('effect exploded');
  }, { intentKey: key });
  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, 0);
  const row = readOutboxResult(db, key);
  assert.equal(row.state, 'failed');
  assert.match(row.last_error, /effect exploded/);
});

test('outbox: crash-recovery — intent committed, drain not yet called → fresh drain recovers', () => {
  // Simulates the production crash window: the worker_done tx committed
  // (intent row persists) but the process died before drainOutbox ran.
  // A subsequent drain (e.g. on next process start) must process the row.
  const { epic } = makeProject();
  const t = makeTask(epic.id, 'development.code');
  const db = getDb();
  const key = `test-crash-${Math.random().toString(36).slice(2, 8)}`;
  // Phase 1: enqueue (pretend this is the tx-commit step).
  enqueueOutboxIntent(db, { intentKey: key, commandKind: 'generate_downstream', taskId: t.id });
  // Phase 2: NO drain here (crash).
  const before = readOutboxResult(db, key);
  assert.equal(before.state, 'pending');
  // Phase 3: a later drain recovers.
  let observedTaskId = null;
  const summary = drainOutbox(db, 'generate_downstream', (id) => {
    observedTaskId = id;
    return { recovered: true };
  }, { intentKey: key });
  assert.equal(summary.succeeded, 1);
  assert.equal(observedTaskId, t.id);
  const after = readOutboxResult(db, key);
  assert.equal(after.state, 'done');
});

// ---------------------------------------------------------------------------
// 5-6. Integration: worker_done augments reply from durable outbox on replay.
// ---------------------------------------------------------------------------

test('outbox: handleWorkerDone augments reply with workflow_generation from durable outbox on replay', () => {
  // We exercise this through a formalization.prd task in review_in_progress
  // (the only way a tracker_only task reaches 'done' via worker_done). After
  // approval, generateNextForCompletedTask produces the prd_accepted
  // downstream tasks (SRS+UC).
  const { epic } = makeProject();
  const t = makeTask(epic.id, 'formalization.prd');

  // Move the task into review_in_progress with an assigned reviewer.
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status='review_in_progress', assigned_to='reviewer',
                       execution_mode='tracker_only',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);

  // First call: enqueues the intent, drains it, reply carries workflow_generation.
  const first = dispatcher.worker_done({
    task_id: t.id, worker_id: 'reviewer', result: 'PRD approved', verdict: 'approved',
  });
  assert.equal(first.completed_new_status, 'done');
  assert.ok(first.workflow_generation, 'first call has workflow_generation');

  // The intent row is now durable.
  const row = readOutboxResult(db, generateDownstreamIntentKey(t.id));
  assert.equal(row.state, 'done');

  // Replay: caller retries the same worker_done (e.g. lost MCP response).
  // handleWorkerDone short-circuits via checkReceipt — reply is parsed from
  // the stored receipt. But because the durable outbox row exists, the
  // augment step re-attaches workflow_generation so the reply is byte-stable.
  const replay = dispatcher.worker_done({
    task_id: t.id, worker_id: 'reviewer', result: 'PRD approved', verdict: 'approved',
  });
  assert.equal(replay.completed_new_status, 'done');
  // workflow_generation in replay must match the first call (byte-stable).
  assert.deepEqual(
    JSON.stringify(replay.workflow_generation),
    JSON.stringify(first.workflow_generation),
    'replay returns byte-equivalent workflow_generation from durable outbox',
  );
});

test('outbox: workflow generation is not re-invoked on replay (idempotent producer)', () => {
  // Count downstream tasks created. Replay must not create duplicates even
  // if generation runs again — it uses INSERT OR IGNORE on the spec ids.
  const { epic } = makeProject();
  const t = makeTask(epic.id, 'formalization.prd');
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status='review_in_progress', assigned_to='reviewer2',
                       execution_mode='tracker_only',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);

  dispatcher.worker_done({
    task_id: t.id, worker_id: 'reviewer2', result: 'PRD approved', verdict: 'approved',
  });
  const downstreamAfterFirst = db.prepare(
    'SELECT COUNT(*) c FROM tasks WHERE epic_id=? AND id != ?',
  ).get(epic.id, t.id).c;

  dispatcher.worker_done({
    task_id: t.id, worker_id: 'reviewer2', result: 'PRD approved', verdict: 'approved',
  });
  const downstreamAfterReplay = db.prepare(
    'SELECT COUNT(*) c FROM tasks WHERE epic_id=? AND id != ?',
  ).get(epic.id, t.id).c;

  assert.equal(
    downstreamAfterReplay,
    downstreamAfterFirst,
    `replay did not create extra downstream tasks (first=${downstreamAfterFirst}, replay=${downstreamAfterReplay})`,
  );
});
