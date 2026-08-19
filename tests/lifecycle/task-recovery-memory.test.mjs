/**
 * BLINDSIGHT X2 — phantom skill contracts → real memory bridge.
 *
 * Census (docs/factory-run/stage11/PREVENTIVE-HUNT.md, Cross-Layer X2):
 * skills (saga-verifier + 5 others) promise a "memory bridge":
 *   - comment_add with a `RECOVERY:` prefix is parsed into
 *     metadata.attempt_history[].recovery_summary;
 *   - metadata.previous_failures is filled from durable history at claim;
 *   - metadata.attempt_history accumulates the same durable history;
 *   - metadata.hint tells a re-claiming worker the task was already in work.
 * ZERO lines of code implemented any of it. Workers followed a contract that
 * did not exist.
 *
 * This suite pins the bridge RED-first:
 *
 *   1. parseRecoveryComment — typed, fail-closed prefix parser.
 *   2. comment_add(RECOVERY:) — durable recovery note lands in the task's
 *      metadata.attempt_history / previous_failures immediately.
 *   3. claim materialization — worker_next returns the task with the memory
 *      fields materialized (delivery to the decision point, not just DB rows).
 *   4. metadata.hint — manual hints survive a claim; a task with prior
 *      attempts and no manual hint gets the machine notice at re-claim.
 *   5. submission-validation rejections count as durable failure history.
 *   6. idempotence — materialization is derived from append-only sources,
 *      so re-claiming never duplicates entries.
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
import { handlers as comments } from '../../dist/tools/comments.js';
import { handlers as dispatcher } from '../../dist/tools/dispatcher.js';
import {
  parseRecoveryComment,
  RECOVERY_COMMENT_PREFIX,
  materializeTaskRecoveryMemory,
  TASK_RECOVERY_MEMORY_SCHEMA,
} from '../../dist/lifecycle/task-recovery-memory.js';
import { seedRunningProcessRun } from './fixtures/managed-execution.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-recovery-memory-'));
process.env.DB_PATH = path.join(temp, 'memory.db');
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

let projectSeq = 0;

function makeProject() {
  const product = projects.project_create({
    name: `RM ${Date.now()} ${++projectSeq}`,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  return { product, epic };
}

function makeClaimableTask(epicId, projectId, overrides = {}) {
  const runId = seedRunningProcessRun(getDb(), {
    id: Math.floor(Math.random() * 1_000_000) + 10,
    projectId,
  });
  const task = tasks.task_create({
    epic_id: epicId,
    title: `T-${++projectSeq}`,
    task_kind: 'development.code',
    execution_mode: 'tracker_only',
    review_skill: null,
    ...overrides,
  });
  const db = getDb();
  db.prepare(
    `UPDATE tasks
        SET metadata=json_set(COALESCE(metadata,'{}'), '$.process_run_id', ?)
      WHERE id=?`,
  ).run(runId, task.id);
  return task;
}

function releaseTask(taskId) {
  getDb().prepare(
    `UPDATE tasks
        SET status='todo', assigned_to=NULL, current_execution_id=NULL,
            updated_at=datetime('now')
      WHERE id=?`,
  ).run(taskId);
}

function readMetadata(taskId) {
  const row = getDb()
    .prepare('SELECT metadata FROM tasks WHERE id=?')
    .get(taskId);
  return JSON.parse(row.metadata);
}

// ---------------------------------------------------------------------------
// 1. Typed prefix parser (pure).
// ---------------------------------------------------------------------------

test('parseRecoveryComment: accepts the exact RECOVERY: prefix and trims', () => {
  const parsed = parseRecoveryComment(
    'RECOVERY: Lighthouse=78 (need >=80); vendor/three.js 612KB blocks first paint',
  );
  assert.ok(parsed);
  assert.equal(
    parsed.summary,
    'Lighthouse=78 (need >=80); vendor/three.js 612KB blocks first paint',
  );
});

test('parseRecoveryComment: multiline summary is preserved after the prefix', () => {
  const parsed = parseRecoveryComment(
    'RECOVERY: axe=5 violations.\nTop reason: missing labels on form controls.',
  );
  assert.ok(parsed);
  assert.equal(
    parsed.summary,
    'axe=5 violations.\nTop reason: missing labels on form controls.',
  );
});

test('parseRecoveryComment: fail-closed on lowercase prefix', () => {
  assert.equal(parseRecoveryComment('recovery: lowercase prefix'), null);
});

test('parseRecoveryComment: fail-closed when prefix is not at the start', () => {
  assert.equal(
    parseRecoveryComment('some prose RECOVERY: embedded note'),
    null,
  );
});

test('parseRecoveryComment: fail-closed on empty summary', () => {
  assert.equal(parseRecoveryComment('RECOVERY:'), null);
  assert.equal(parseRecoveryComment('RECOVERY:    '), null);
});

test('parseRecoveryComment: fail-closed on non-string input', () => {
  assert.equal(parseRecoveryComment(undefined), null);
  assert.equal(parseRecoveryComment(42), null);
});

test('RECOVERY_COMMENT_PREFIX export matches the skill contract', () => {
  assert.equal(RECOVERY_COMMENT_PREFIX, 'RECOVERY:');
});

// ---------------------------------------------------------------------------
// 2. comment_add bridge: RECOVERY note → durable attempt history on the task.
// ---------------------------------------------------------------------------

test('comment_add with RECOVERY: prefix materializes attempt_history on the task', () => {
  const { product, epic } = makeProject();
  const task = tasks.task_create({
    epic_id: epic.id,
    title: 'C1',
    task_kind: 'development.code',
  });

  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: tsc: 6 errors, all in src/renderer.ts port drift',
    author: 'board-1-verifier',
  });

  const metadata = readMetadata(task.id);
  assert.equal(metadata.attempt_history.length, 1);
  const entry = metadata.attempt_history[0];
  assert.equal(
    entry.recovery_summary,
    'tsc: 6 errors, all in src/renderer.ts port drift',
  );
  assert.equal(entry.kind, 'recovery_note');
  assert.equal(entry.attempt, 1);
  assert.equal(entry.worker_id, 'board-1-verifier');
  assert.match(entry.source_ref, /^comment:/);
  assert.ok(entry.at);
  assert.deepEqual(
    metadata.previous_failures,
    ['tsc: 6 errors, all in src/renderer.ts port drift'],
  );
  assert.equal(metadata.attempt_count, 1);
  assert.ok(metadata.recovery_memory_schema === TASK_RECOVERY_MEMORY_SCHEMA);
  void product;
});

test('comment_add WITHOUT the prefix never writes memory fields', () => {
  const { epic } = makeProject();
  const task = tasks.task_create({
    epic_id: epic.id,
    title: 'C2',
    task_kind: 'development.code',
  });

  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY mid-sentence is not a prefix — must be ignored',
  });

  const metadata = readMetadata(task.id);
  assert.equal(metadata.attempt_history, undefined);
  assert.equal(metadata.previous_failures, undefined);
});

test('second RECOVERY comment accumulates (append-only, ordinal attempts)', () => {
  const { epic } = makeProject();
  const task = tasks.task_create({
    epic_id: epic.id,
    title: 'C3',
    task_kind: 'development.code',
  });

  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: attempt one — dynamic import gave +4 Lighthouse points only',
  });
  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: attempt two — manualChunks split failed on circular import',
  });

  const metadata = readMetadata(task.id);
  assert.equal(metadata.attempt_history.length, 2);
  assert.equal(metadata.attempt_history[0].attempt, 1);
  assert.equal(metadata.attempt_history[1].attempt, 2);
  assert.equal(metadata.attempt_count, 2);
  assert.equal(metadata.previous_failures.length, 2);
});

// ---------------------------------------------------------------------------
// 3. Claim materialization: the memory travels WITH the claim.
// ---------------------------------------------------------------------------

test('worker_next claim returns the task with materialized memory fields', () => {
  const { product, epic } = makeProject();
  const task = makeClaimableTask(epic.id, product.id);

  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: Lighthouse=78, vendor-three.js in entry chunk',
    author: 'board-1-verifier',
  });
  releaseTask(task.id);

  const claimed = dispatcher.worker_next({
    worker_id: 'board-1-retry',
    project_id: product.id,
  });
  assert.ok(claimed.task, 'queue must not be empty');
  assert.equal(claimed.task.id, task.id);

  const metadata = JSON.parse(claimed.task.metadata);
  assert.equal(metadata.attempt_count, 1);
  assert.equal(metadata.attempt_history.length, 1);
  assert.equal(
    metadata.attempt_history[0].recovery_summary,
    'Lighthouse=78, vendor-three.js in entry chunk',
  );
  assert.equal(metadata.previous_failures.length, 1);
  // Durable claim predicate keys must survive materialization.
  assert.ok(metadata.process_run_id);
});

test('claim materialization is idempotent across repeated claims', () => {
  const { product, epic } = makeProject();
  const task = makeClaimableTask(epic.id, product.id);

  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: flaky test on WebGPU fixture',
  });
  releaseTask(task.id);

  dispatcher.worker_next({ worker_id: 'w-a', project_id: product.id });
  releaseTask(task.id);
  const second = dispatcher.worker_next({
    worker_id: 'w-b',
    project_id: product.id,
  });
  releaseTask(task.id);

  const metadata = JSON.parse(second.task.metadata);
  assert.equal(metadata.attempt_count, 1, 'no duplication on re-claim');
  assert.equal(metadata.attempt_history.length, 1);
});

// ---------------------------------------------------------------------------
// 4. metadata.hint delivery.
// ---------------------------------------------------------------------------

test('manual metadata.hint survives a claim untouched', () => {
  const { product, epic } = makeProject();
  const task = makeClaimableTask(epic.id, product.id);

  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: first failure diagnostics',
  });
  getDb().prepare(
    `UPDATE tasks
        SET metadata=json_set(metadata, '$.hint',
          'AC-NFR-1 requires Vite bundle analysis, watch vendor/three.js')
      WHERE id=?`,
  ).run(task.id);
  releaseTask(task.id);

  const claimed = dispatcher.worker_next({
    worker_id: 'w-hint',
    project_id: product.id,
  });
  const metadata = JSON.parse(claimed.task.metadata);
  assert.equal(
    metadata.hint,
    'AC-NFR-1 requires Vite bundle analysis, watch vendor/three.js',
  );
  assert.equal(metadata.attempt_count, 1);
});

test('re-claim of a previously attempted task gets the machine hint notice', () => {
  const { product, epic } = makeProject();
  const task = makeClaimableTask(epic.id, product.id);

  const freshMetadata = readMetadata(task.id);
  assert.equal(freshMetadata.hint, undefined, 'no hint before any attempt');

  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: e2e harness lacks Safari WebGL fixture',
  });
  releaseTask(task.id);

  const claimed = dispatcher.worker_next({
    worker_id: 'w-notice',
    project_id: product.id,
  });
  const metadata = JSON.parse(claimed.task.metadata);
  assert.equal(metadata.attempt_count, 1);
  assert.ok(
    typeof metadata.hint === 'string' && metadata.hint.length > 0,
    're-claiming worker must see a hint that the task was in work',
  );
  assert.match(metadata.hint, /previous_failures|attempt_history/);
});

test('first claim of a never-attempted task sets no machine hint', () => {
  const { product, epic } = makeProject();
  makeClaimableTask(epic.id, product.id);

  const claimed = dispatcher.worker_next({
    worker_id: 'w-fresh',
    project_id: product.id,
  });
  const metadata = JSON.parse(claimed.task.metadata);
  assert.equal(metadata.hint, undefined);
  assert.equal(metadata.attempt_count, 0);
});

// ---------------------------------------------------------------------------
// 5. Submission validation rejections count as failure history.
// ---------------------------------------------------------------------------

test('submission-validation rejections feed previous_failures and attempt_history', () => {
  const { epic } = makeProject();
  const task = tasks.task_create({
    epic_id: epic.id,
    title: 'R1',
    task_kind: 'development.code',
  });
  const db = getDb();
  db.prepare(
    `INSERT INTO factory_submission_validation_rejections
       (rejection_ref, rejection_digest, validator_id, validator_version,
        process_run_id, module_ref, node_id, execution_id, task_id,
        actor_kind, rejection_code, gaps_json, details_json,
        input_snapshot_hash, observed_artifacts, observed_set_digest,
        feedback_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'submission-validation-rejection:test-1',
    'deadbeef',
    'test-validator',
    '1.0.0',
    1,
    'test-module@1.0.0',
    'node-1',
    'exec-r1',
    task.id,
    'managed_execution',
    'MISSING_ARTIFACT_RELATION',
    JSON.stringify([
      { artifactCode: 'SRS', missing: { relation: 'traces_to', requiredTargetTypes: ['AC'] } },
    ]),
    '{}',
    'hash-x',
    '[]',
    'digest-x',
    '{}',
  );

  const outcome = materializeTaskRecoveryMemory(db, task.id);
  assert.ok(outcome.changed);
  const metadata = readMetadata(task.id);
  assert.equal(metadata.attempt_count, 1);
  const entry = metadata.attempt_history[0];
  assert.equal(entry.kind, 'submission_rejection');
  assert.equal(entry.execution_id, 'exec-r1');
  assert.match(entry.recovery_summary, /MISSING_ARTIFACT_RELATION/);
  assert.match(entry.source_ref, /^submission-validation-rejection:/);
});

// ---------------------------------------------------------------------------
// 6. Ordering: rejection + recovery notes are ordered by durable time.
// ---------------------------------------------------------------------------

test('memory entries merge from both sources in durable order', () => {
  const { epic } = makeProject();
  const task = tasks.task_create({
    epic_id: epic.id,
    title: 'M1',
    task_kind: 'development.code',
  });
  const db = getDb();
  comments.comment_add({
    task_id: task.id,
    content: 'RECOVERY: verifier reflection after rejection',
  });
  db.prepare(
    `INSERT INTO factory_submission_validation_rejections
       (rejection_ref, rejection_digest, validator_id, validator_version,
        process_run_id, module_ref, node_id, execution_id, task_id,
        actor_kind, rejection_code, gaps_json, details_json,
        input_snapshot_hash, observed_artifacts, observed_set_digest,
        feedback_json, rejected_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'submission-validation-rejection:test-2',
    'deadbeee',
    'test-validator',
    '1.0.0',
    1,
    'test-module@1.0.0',
    'node-1',
    'exec-m1',
    task.id,
    'managed_execution',
    'MISSING_ARTIFACT_RELATION',
    '[]',
    '{}',
    'hash-y',
    '[]',
    'digest-y',
    '{}',
    datetimeMinusOneMinute(),
  );

  materializeTaskRecoveryMemory(db, task.id);
  const metadata = readMetadata(task.id);
  assert.equal(metadata.attempt_count, 2);
  // The rejection (older timestamp) must come first.
  assert.equal(metadata.attempt_history[0].kind, 'submission_rejection');
  assert.equal(metadata.attempt_history[1].kind, 'recovery_note');
});

function datetimeMinusOneMinute() {
  return new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
}
