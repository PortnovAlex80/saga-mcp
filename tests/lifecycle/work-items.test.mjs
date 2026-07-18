/**
 * Slice 2 — work-item shadow model tests.
 *
 * Source: blueprint §16 Slice 2 acceptance (docs/architecture/passive-worker-kernel-blueprint.md:864-869),
 *         §17 WP-4 deliverables (line 1002-1006).
 *
 * Coverage:
 *
 * 1. backfill-migration — every status maps to a synthetic pipeline.
 * 2. backfill idempotency — re-running is a no-op.
 * 3. backfill honesty — never invents prior cycle history.
 * 4. equivalence — legacy rows match derived projection for every status.
 * 5. integration-retry — review approval survives loss of integration attempt
 *    (the audit's central fix at the shadow-model level).
 * 6. orphan attempt detection.
 * 7. multiple-active-item detection.
 *
 * Builds a real SQLite DB and exercises the repository + projector + backfill
 * against it. No mocking.
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
import {
  WorkItemRepository,
} from '../../dist/lifecycle/work-item-repository.js';
import {
  projectToLegacy,
  checkEquivalence,
  computeExpectedPipeline,
} from '../../dist/lifecycle/compatibility-projector.js';
import { backfillWorkItemShadow } from '../../dist/lifecycle/backfill-migration.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-wi-'));
process.env.DB_PATH = path.join(temp, 'wi.db');
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
  const product = projects.project_create({ name: `WI ${Math.random().toString(36).slice(2, 6)}` });
  repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  return { product, epic };
}

function makeTask(epicId, overrides = {}) {
  return tasks.task_create({
    epic_id: epicId,
    title: `T-${Math.random().toString(36).slice(2, 6)}`,
    task_kind: 'development.code',
    execution_mode: 'git_change',
    ...overrides,
  });
}

function legacySnapshot(taskId) {
  const t = getDb().prepare(
    `SELECT id, status, assigned_to, current_execution_id,
            integration_state, tags, execution_mode, task_kind
       FROM tasks WHERE id=?`,
  ).get(taskId);
  return {
    task_id: t.id,
    status: t.status,
    assigned_to: t.assigned_to,
    current_execution_id: t.current_execution_id,
    integration_state: t.integration_state,
    tags: JSON.parse(t.tags || '[]'),
    execution_mode: t.execution_mode,
    task_kind: t.task_kind,
  };
}

// ---------------------------------------------------------------------------
// 1. Backfill — every status maps to a synthetic pipeline.
// ---------------------------------------------------------------------------

test('backfill: todo task gets a single ready implementation item', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // Backfill is a one-shot migration at DB-open time. In tests we trigger it
  // explicitly after creating the task to verify the mapping.
  backfillWorkItemShadow(getDb());
  const repo = new WorkItemRepository(getDb());
  const items = repo.listWorkItemsForTask(t.id);
  assert.ok(items.length >= 1, 'at least one work item synthesized');
  const impl = items.find((i) => i.kind === 'implementation');
  assert.ok(impl, 'has implementation item');
  assert.equal(impl.state, 'ready');
  assert.equal(impl.history_complete, 0, 'marked as backfilled, not observed');
});

test('backfill: in_progress task gets active implementation + running attempt', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // Force the task into in_progress with an execution fence.
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status='in_progress', assigned_to='w1',
                       current_execution_id='exec-test-ip',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase, reserved_at, phase_updated_at)
     VALUES ('exec-test-ip', 'r',
       (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
       ?, ?, 'w1', ?, 'running', 'executing',
       datetime('now'), datetime('now'))`,
  ).run(t.id, t.epic_id, t.id, os.hostname());

  // Clear the auto-backfill and re-run to test the in_progress path.
  const repo = new WorkItemRepository(db);
  repo.clearTaskShadow(t.id);
  const stats = backfillWorkItemShadow(db);

  const items = repo.listWorkItemsForTask(t.id);
  const activeImpl = items.find((i) => i.kind === 'implementation' && i.state === 'active');
  assert.ok(activeImpl, 'has active implementation item');
  const attempts = repo.listAttemptsForItem(activeImpl.work_item_id);
  assert.equal(attempts.length, 1, 'one running attempt synthesized');
  assert.equal(attempts[0].state, 'running');
  assert.equal(attempts[0].worker_id, 'w1');
  assert.equal(attempts[0].execution_id, 'exec-test-ip');
  assert.ok(stats.backfilled >= 1);
});

test('backfill: review task gets completed impl + ready review', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  getDb().prepare(
    `UPDATE tasks SET status='review', updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);

  const repo = new WorkItemRepository(getDb());
  repo.clearTaskShadow(t.id);
  backfillWorkItemShadow(getDb());

  const items = repo.listWorkItemsForTask(t.id);
  const completedImpl = items.find((i) => i.kind === 'implementation' && i.state === 'completed');
  const readyReview = items.find((i) => i.kind === 'review' && i.state === 'ready');
  assert.ok(completedImpl, 'has completed implementation');
  assert.ok(readyReview, 'has ready review');
});

test('backfill: done+merged task gets completed impl + approved review + completed integration', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  getDb().prepare(
    `UPDATE tasks SET status='done', integration_state='merged',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);

  const repo = new WorkItemRepository(getDb());
  repo.clearTaskShadow(t.id);
  backfillWorkItemShadow(getDb());

  const items = repo.listWorkItemsForTask(t.id);
  const kinds = items.map((i) => `${i.kind}:${i.state}`).sort();
  assert.ok(kinds.includes('implementation:completed'));
  assert.ok(kinds.includes('review:completed'));
  assert.ok(kinds.includes('integration:completed'));
});

test('backfill: done+pending task gets approved review + ready integration', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  getDb().prepare(
    `UPDATE tasks SET status='done', integration_state='pending',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);

  const repo = new WorkItemRepository(getDb());
  repo.clearTaskShadow(t.id);
  backfillWorkItemShadow(getDb());

  const items = repo.listWorkItemsForTask(t.id);
  const approved = items.find((i) => i.kind === 'review' && i.outcome === 'approved');
  const readyInt = items.find((i) => i.kind === 'integration' && i.state === 'ready');
  assert.ok(approved, 'review is approved (not lost)');
  assert.ok(readyInt, 'integration ready');
});

// ---------------------------------------------------------------------------
// 2. Backfill idempotency.
// ---------------------------------------------------------------------------

test('backfill: re-running does not duplicate shadow rows', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // First backfill populates the shadow.
  backfillWorkItemShadow(getDb());
  const repo = new WorkItemRepository(getDb());
  const firstCount = repo.listWorkItemsForTask(t.id).length;
  assert.ok(firstCount >= 1);

  // Run backfill again — should skip this task.
  const stats = backfillWorkItemShadow(getDb());
  const secondCount = repo.listWorkItemsForTask(t.id).length;

  assert.equal(secondCount, firstCount, 'no duplicate rows');
  assert.ok(stats.skipped >= 1, 'task reported as skipped');
});

// ---------------------------------------------------------------------------
// 3. Backfill honesty — no fabricated cycles.
// ---------------------------------------------------------------------------

test('backfill: never invents prior implementation/review cycles', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  getDb().prepare(
    `UPDATE tasks SET status='review', updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);

  const repo = new WorkItemRepository(getDb());
  repo.clearTaskShadow(t.id);
  backfillWorkItemShadow(getDb());

  const items = repo.listWorkItemsForTask(t.id);
  // Every item must be cycle_no=1 — no synthesized prior cycles.
  for (const item of items) {
    assert.equal(item.cycle_no, 1, `${item.work_item_id} must be cycle 1 (no fabricated history)`);
  }
  // And all must have history_complete=0 (backfilled, not observed).
  for (const item of items) {
    assert.equal(item.history_complete, 0, `${item.work_item_id} flagged as backfilled`);
  }
});

// ---------------------------------------------------------------------------
// 4. Equivalence — derived matches legacy.
// ---------------------------------------------------------------------------

test('equivalence: todo task — derived status matches legacy', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  backfillWorkItemShadow(getDb());
  const repo = new WorkItemRepository(getDb());
  const items = repo.listWorkItemsForTask(t.id);
  const derived = projectToLegacy(items, []);
  assert.ok(derived, 'projectable');
  assert.equal(derived.status, 'todo');
  const report = checkEquivalence(legacySnapshot(t.id), items, []);
  assert.equal(report.ok, true, `expected equivalence, got: ${JSON.stringify(report.mismatches)}`);
});

test('equivalence: done+merged — derived matches legacy', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status='done', integration_state='merged',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);
  const repo = new WorkItemRepository(db);
  repo.clearTaskShadow(t.id);
  backfillWorkItemShadow(db);

  const items = repo.listWorkItemsForTask(t.id);
  const report = checkEquivalence(legacySnapshot(t.id), items, []);
  assert.equal(report.ok, true, `mismatches: ${JSON.stringify(report.mismatches)}`);
});

test('equivalence: detects STATUS_DRIFT when shadow is wrong', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // Legacy is 'todo', but poison the shadow to claim active review.
  const repo = new WorkItemRepository(getDb());
  repo.clearTaskShadow(t.id);
  repo.insertWorkItem({
    work_item_id: `poison-${t.id}`,
    task_id: t.id,
    kind: 'review',
    cycle_no: 1,
    state: 'active',
    history_complete: false,
  });
  const items = repo.listWorkItemsForTask(t.id);
  const report = checkEquivalence(legacySnapshot(t.id), items, []);
  assert.equal(report.ok, false);
  assert.ok(report.mismatches.some((m) => m.code === 'STATUS_DRIFT'));
});

test('equivalence: detects ORPHAN_ATTEMPT (attempt on missing item)', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  // Insert an orphan attempt directly via SQL, bypassing the FK. The schema
  // declares work_attempts.work_item_id REFERENCES task_work_items; under
  // foreign_keys=ON the insert would fail. The equivalence checker must
  // detect the orphan even when it slipped in via a back-door (e.g. an older
  // DB where the FK was not enforced, or a future migration that broke the
  // link). We toggle FK off for the insert, then back on.
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(
      `INSERT INTO work_attempts (attempt_id, work_item_id, ordinal, state)
       VALUES (?, 'does-not-exist', 1, 'running')`,
    ).run(`ghost-att-${t.id}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const repo = new WorkItemRepository(db);
  const items = repo.listWorkItemsForTask(t.id);
  // listAttemptsForTask only joins via work_item_id; pull all attempts and
  // filter to those touching our task's items OR orphaned.
  const allAttempts = db.prepare('SELECT * FROM work_attempts').all();
  const report = checkEquivalence(legacySnapshot(t.id), items, allAttempts);
  assert.ok(
    report.mismatches.some((m) => m.code === 'ORPHAN_ATTEMPT'),
    `expected ORPHAN_ATTEMPT, got: ${JSON.stringify(report.mismatches)}`,
  );
});

test('equivalence: detects MULTIPLE_CURRENT_ITEMS', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  const repo = new WorkItemRepository(getDb());
  repo.clearTaskShadow(t.id);
  // Two active items — structurally invalid.
  repo.insertWorkItem({
    work_item_id: `a1-${t.id}`, task_id: t.id, kind: 'implementation',
    cycle_no: 1, state: 'active', history_complete: false,
  });
  repo.insertWorkItem({
    work_item_id: `a2-${t.id}`, task_id: t.id, kind: 'review',
    cycle_no: 1, state: 'active', history_complete: false,
  });
  const items = repo.listWorkItemsForTask(t.id);
  const report = checkEquivalence(legacySnapshot(t.id), items, []);
  assert.ok(report.mismatches.some((m) => m.code === 'MULTIPLE_CURRENT_ITEMS'));
});

// ---------------------------------------------------------------------------
// 5. THE CENTRAL AUDIT FIX — integration-retry does not rewind review.
//    At the shadow level: losing an integration attempt reverts the
//    integration item to 'ready' but leaves the review item 'completed'.
// ---------------------------------------------------------------------------

test('audit-fix: review approval survives loss of integration attempt', () => {
  const { epic } = makeProject();
  const t = makeTask(epic.id);
  const db = getDb();
  // Set up the post-approval state.
  db.prepare(
    `UPDATE tasks SET status='done', integration_state='pending',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);
  const repo = new WorkItemRepository(db);
  repo.clearTaskShadow(t.id);
  backfillWorkItemShadow(db);

  // Shadow: approved review + ready integration. Create the integration
  // attempt that will fail.
  const integrationItem = repo.listWorkItemsForTask(t.id)
    .find((i) => i.kind === 'integration');
  assert.ok(integrationItem, 'integration item exists');
  repo.updateWorkItemState(integrationItem.work_item_id, 'active');

  // The attempt references an execution_id; insert the execution row first
  // to satisfy the FK (work_attempts.execution_id REFERENCES worker_executions).
  const execId1 = `exec-int-${t.id}`;
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase, reserved_at, phase_updated_at)
     VALUES (?, 'r',
       (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
       ?, ?, 'executor-1', ?, 'running', 'integrating',
       datetime('now'), datetime('now'))`,
  ).run(execId1, t.id, t.epic_id, t.id, os.hostname());
  repo.insertWorkAttempt({
    attempt_id: `int-att-${t.id}`,
    work_item_id: integrationItem.work_item_id,
    ordinal: 1,
    state: 'running',
    worker_id: 'executor-1',
    execution_id: execId1,
  });

  // Now simulate: integration executor dies.
  repo.updateAttemptState(`int-att-${t.id}`, 'lost', {
    lastError: 'process died mid-merge',
  });
  // Terminalize the execution row so the retry can be inserted (the schema
  // enforces one active execution per task).
  db.prepare(
    `UPDATE worker_executions SET state='lost', finished_at=datetime('now')
      WHERE execution_id=?`,
  ).run(execId1);
  // Audit fix: integration item reverts to ready, NOT the review.
  repo.updateWorkItemState(integrationItem.work_item_id, 'ready', null, null);

  // Verify: review item is STILL completed+approved.
  const reviewItem = repo.listWorkItemsForTask(t.id)
    .find((i) => i.kind === 'review');
  assert.equal(reviewItem.state, 'completed', 'review state preserved');
  assert.equal(reviewItem.outcome, 'approved', 'review approval preserved');

  // And integration is back to ready for a fresh attempt.
  const refreshedIntegration = repo.getWorkItem(integrationItem.work_item_id);
  assert.equal(refreshedIntegration.state, 'ready', 'integration back to ready');

  // A new attempt can be created — second execution row for the retry.
  const execId2 = `exec-int2-${t.id}`;
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase, reserved_at, phase_updated_at)
     VALUES (?, 'r',
       (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
       ?, ?, 'executor-2', ?, 'running', 'integrating',
       datetime('now'), datetime('now'))`,
  ).run(execId2, t.id, t.epic_id, t.id, os.hostname());
  repo.insertWorkAttempt({
    attempt_id: `int-att2-${t.id}`,
    work_item_id: integrationItem.work_item_id,
    ordinal: 2,
    state: 'running',
    worker_id: 'executor-2',
    execution_id: execId2,
  });
  const attempts = repo.listAttemptsForItem(integrationItem.work_item_id);
  assert.equal(attempts.length, 2, 'two attempts recorded — retry did not erase history');
  assert.equal(attempts[0].state, 'lost');
  assert.equal(attempts[1].state, 'running');
});

// ---------------------------------------------------------------------------
// 6. computeExpectedPipeline — direct unit tests.
// ---------------------------------------------------------------------------

test('computeExpectedPipeline: returns null for unknown status', () => {
  const result = computeExpectedPipeline({
    task_id: 1,
    status: 'totally-bogus',
    assigned_to: null,
    current_execution_id: null,
    integration_state: null,
    tags: [],
    execution_mode: 'git_change',
    task_kind: 'development.code',
  });
  assert.equal(result, null);
});

test('computeExpectedPipeline: blocked task gets ready implementation', () => {
  const result = computeExpectedPipeline({
    task_id: 1,
    status: 'blocked',
    assigned_to: null,
    current_execution_id: null,
    integration_state: null,
    tags: [],
    execution_mode: 'git_change',
    task_kind: 'development.code',
  });
  assert.ok(result);
  assert.equal(result[0].kind, 'implementation');
  assert.equal(result[0].state, 'ready');
});

test('computeExpectedPipeline: non-git done does not synthesize integration', () => {
  const result = computeExpectedPipeline({
    task_id: 1,
    status: 'done',
    assigned_to: null,
    current_execution_id: null,
    integration_state: 'not_required',
    tags: [],
    execution_mode: 'tracker_only',
    task_kind: 'development.code',
  });
  assert.ok(result);
  const hasIntegration = result.some((i) => i.kind === 'integration');
  assert.equal(hasIntegration, false, 'non-git done has no integration item');
});
