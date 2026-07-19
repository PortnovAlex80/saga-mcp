/**
 * Slice 6 — dependency reconciliation + claimability tests.
 *
 * Source: blueprint §16 Slice 6 (docs/architecture/passive-worker-kernel-blueprint.md:914-924),
 *         §18 architecture (line 1117-1124: 'engine count uses the same claimability
 *         query as claim').
 *
 * Coverage:
 *
 *  Dependency reconciliation audit fix (blueprint §16:921-922):
 *    1. A queued task with unmet deps → blocked.
 *    2. A FENCED ACTIVE task (in_progress + assigned_to + execution) with
 *       unmet deps is NOT auto-blocked — the worker is left alone.
 *    3. After the worker releases (worker_done), the next dep-check blocks
 *       the task if its deps are still unmet.
 *    4. A blocked task with all deps met → unblocked to todo.
 *
 *  Claimability equivalence (blueprint §18:1123):
 *    5. The predicate worker_next uses for claiming matches the predicate
 *       a hypothetical engine-count query would use (we verify by counting
 *       the same way the SQL does).
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
import { reevaluateDownstream } from '../../dist/tools/tasks.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-dep-'));
process.env.DB_PATH = path.join(temp, 'dep.db');
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
  const product = projects.project_create({ name: `D ${Math.random().toString(36).slice(2, 6)}` });
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
    priority: 'high',
    ...overrides,
  });
}

function fenceToActive(taskId, workerId, executionId, status = 'in_progress') {
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status=?, assigned_to=?, current_execution_id=?,
                       updated_at=datetime('now') WHERE id=?`,
  ).run(status, workerId, executionId, taskId);
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

function setStatus(taskId, status) {
  getDb().prepare('UPDATE tasks SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(status, taskId);
}

function taskStatus(taskId) {
  return getDb().prepare('SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?').get(taskId);
}

// ---------------------------------------------------------------------------
// 1. Queued task with unmet deps → blocked.
// ---------------------------------------------------------------------------

test('dep-reconcile: queued task with unmet deps is auto-blocked', () => {
  const { epic } = makeProject();
  const upstream = makeTask(epic.id);
  const downstream = makeTask(epic.id);
  tasks.task_update({ id: downstream.id, depends_on: [upstream.id] });

  // Trigger re-evaluation by completing the upstream of the downstream's deps.
  // Simpler: directly re-evaluate by setting upstream to todo (unmet).
  setStatus(upstream.id, 'todo');

  // Manually call reevaluateDownstream on the upstream — it walks dependents.
  // But upstream is not done; we want to verify downstream is blocked because
  // upstream is not done. task_update on downstream triggers evaluateAndUpdateDependencies.
  tasks.task_update({ id: downstream.id, title: 'trigger' });

  const d = taskStatus(downstream.id);
  assert.equal(d.status, 'blocked', 'queued downstream with unmet dep is blocked');
  assert.equal(d.assigned_to, null, 'blocked implies assigned_to=null');
});

// ---------------------------------------------------------------------------
// 2. FENCED ACTIVE task with unmet deps is NOT auto-blocked (audit fix).
// ---------------------------------------------------------------------------

test('audit-fix: fenced active task is NOT auto-blocked when deps become unmet', () => {
  const { epic } = makeProject();
  const upstream = makeTask(epic.id);
  const downstream = makeTask(epic.id);
  tasks.task_update({ id: downstream.id, depends_on: [upstream.id] });

  // downstream is claimed and fenced.
  fenceToActive(downstream.id, 'worker-A', 'exec-A');
  // Mark upstream as not-done (unmet). Trigger dep re-eval.
  setStatus(upstream.id, 'todo');
  // The engine typically calls reevaluateDownstream when an upstream changes.
  // We simulate that the upstream re-opened (was done, now todo).
  reevaluateDownstream(getDb(), upstream.id);

  const d = taskStatus(downstream.id);
  assert.equal(d.status, 'in_progress', 'fenced active task NOT auto-blocked');
  assert.equal(d.assigned_to, 'worker-A', 'assignment preserved');
  assert.equal(d.current_execution_id, 'exec-A', 'fence preserved');
});

// ---------------------------------------------------------------------------
// 3. After the worker releases, the next dep-check blocks the task.
// ---------------------------------------------------------------------------

test('dep-reconcile: after worker releases, task with still-unmet deps is blocked on next claim attempt', () => {
  const { epic } = makeProject();
  const upstream = makeTask(epic.id);
  const downstream = makeTask(epic.id);
  tasks.task_update({ id: downstream.id, depends_on: [upstream.id] });

  fenceToActive(downstream.id, 'worker-B', 'exec-B');
  setStatus(upstream.id, 'todo'); // unmet

  // Worker finishes; worker_done would normally advance, but here we simulate
  // a crash: the atomic-release returns the task to todo.
  getDb().prepare(
    `UPDATE tasks SET status='todo', assigned_to=NULL, current_execution_id=NULL,
                       updated_at=datetime('now') WHERE id=?`,
  ).run(downstream.id);

  // Now re-evaluate: task is queued (todo) with unmet deps → blocked.
  // Trigger via reevaluateDownstream on the upstream (the engine's normal path).
  reevaluateDownstream(getDb(), upstream.id);
  const d = taskStatus(downstream.id);
  assert.equal(d.status, 'blocked', 'after release, queued task with unmet deps blocks');
});

// ---------------------------------------------------------------------------
// 4. Blocked task with all deps met → unblocked.
// ---------------------------------------------------------------------------

test('dep-reconcile: blocked task with all deps met is unblocked to todo', () => {
  const { epic } = makeProject();
  const upstream = makeTask(epic.id);
  const downstream = makeTask(epic.id);
  tasks.task_update({ id: downstream.id, depends_on: [upstream.id] });

  // Make upstream done+merged → deps met.
  getDb().prepare(
    `UPDATE tasks SET status='done', integration_state='merged',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(upstream.id);

  // downstream is blocked.
  setStatus(downstream.id, 'blocked');
  // Trigger re-eval via reevaluateDownstream on the upstream (now done+merged).
  reevaluateDownstream(getDb(), upstream.id);

  const d = taskStatus(downstream.id);
  assert.equal(d.status, 'todo', 'unblocked when deps met');
});

// ---------------------------------------------------------------------------
// 5. Claimability predicate matches between worker_next and a manual count.
// ---------------------------------------------------------------------------

test('claimability: worker_next and a count query use the same predicate', () => {
  const { product, epic } = makeProject();
  // Two tasks, but only one is claimable.
  const claimable = makeTask(epic.id);
  const blockedByHumanRequest = makeTask(epic.id);
  // Inject an open human_request on the second.
  getDb().prepare(
    `INSERT INTO human_requests (request_id, task_id, resume_phase, question, state)
     VALUES (?, ?, 'implementation', 'q', 'open')`,
  ).run(`hr-${blockedByHumanRequest.id}`, blockedByHumanRequest.id);

  // Count claimable using the same SQL shape worker_next uses.
  const count = getDb().prepare(
    `SELECT COUNT(*) AS c FROM tasks t
      WHERE t.status IN ('todo','review')
        AND (t.assigned_to IS NULL OR t.assigned_to = '')
        AND t.priority IN ('critical','high','medium')
        AND t.epic_id IN (SELECT id FROM epics WHERE project_id = ?)
        AND t.current_execution_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM worker_executions we
                         WHERE we.task_id=t.id
                           AND we.state IN ('reserved','running','cancel_requested'))
        AND NOT EXISTS (SELECT 1 FROM human_requests hr
                         WHERE hr.task_id=t.id AND hr.state='open')`,
  ).get(product.id).c;

  assert.equal(count, 1, 'only one task is claimable (the other has open human_request)');

  // worker_next claims it — must be the claimable one.
  const claim = dispatcher.worker_next({
    worker_id: 'w-count', project_id: product.id,
    execution_id: 'exec-count', machine_id: os.hostname(),
  });
  assert.ok(claim.task);
  assert.equal(claim.task.id, claimable.id);
});
