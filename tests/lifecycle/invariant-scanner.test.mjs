/**
 * Invariant scanner tests (Slice 0).
 *
 * Source: blueprint §16 Slice 0 (docs/architecture/passive-worker-kernel-blueprint.md:815-827),
 *         §22 brief (line 1208-1216).
 *
 * Strategy: build a real SQLite DB via the existing handler API (project,
 * epic, task, dispatcher), inject named invariant-violation states directly
 * via SQL, then verify the scanner classifies each correctly.
 *
 * This exercises the SHELL half of functional-core/imperative-shell: the
 * scanner reads SQLite and delegates to the pure decoder. The pure half is
 * covered by oracle.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { handlers as repositories } from '../../dist/tools/repositories.js';
import { scanProject, classifyTask } from '../../dist/lifecycle/invariant-scanner.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-scanner-'));
process.env.DB_PATH = path.join(temp, 'scanner.db');

const repoPath = path.join(temp, 'repo');
import { mkdirSync } from 'node:fs';
mkdirSync(repoPath);

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeProject() {
  const product = projects.project_create({ name: `Scanner Test ${Math.random().toString(36).slice(2, 6)}` });
  repositories.repository_register({
    project_id: product.id,
    name: 'repo',
    local_path: repoPath,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  return { product, epic };
}

function makeManagedTask(epicId, overrides = {}) {
  const t = tasks.task_create({
    epic_id: epicId,
    title: `T-${Math.random().toString(36).slice(2, 6)}`,
    task_kind: 'development.code',
    execution_mode: 'git_change',
    ...overrides,
  });
  return t;
}

/** Set raw task columns bypassing handlers — simulates invariant-violating states. */
function setRawTask(taskId, patch) {
  const db = getDb();
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      sets.push(`${k} = NULL`);
    } else {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }
  sets.push("updated_at = datetime('now')");
  params.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function insertExecution(taskId, executionId, state, workerId = 'w', phase = 'executing') {
  const db = getDb();
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase, reserved_at, phase_updated_at)
     VALUES (?, ?, (SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?),
             (SELECT epic_id FROM tasks WHERE id=?), ?, ?, ?, ?, ?,
             datetime('now'), datetime('now'))`,
  ).run(executionId, 'run-x', taskId, taskId, taskId, workerId, os.hostname(), state, phase);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('scanner: clean queued task classifies as valid_managed', () => {
  const { product, epic } = makeProject();
  const t = makeManagedTask(epic.id);
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'valid_managed');
  const report = scanProject(getDb(), product.id);
  assert.ok(report.validManaged >= 1);
  assert.equal(report.violations, 0);
});

test('scanner: clean active task (in_progress + fence + execution) classifies as valid_managed', () => {
  const { product, epic } = makeProject();
  const t = makeManagedTask(epic.id);
  setRawTask(t.id, { status: 'in_progress', assigned_to: 'w-1', current_execution_id: 'exec-act' });
  insertExecution(t.id, 'exec-act', 'running', 'w-1');
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'valid_managed');
});

test('scanner: needs-human + active execution → WAITING_HUMAN_WITH_ACTIVE_EXECUTION', () => {
  const { product, epic } = makeProject();
  const t = makeManagedTask(epic.id);
  setRawTask(t.id, {
    status: 'in_progress',
    assigned_to: 'w-ask',
    current_execution_id: 'exec-ask',
  });
  insertExecution(t.id, 'exec-ask', 'running', 'w-ask');
  // Inject the needs-human tag — the ASK dead-assignment signature.
  const db = getDb();
  db.prepare("UPDATE tasks SET tags = ? WHERE id = ?").run(JSON.stringify(['needs-human']), t.id);
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'named_violation');
  assert.equal(cls.code, 'WAITING_HUMAN_WITH_ACTIVE_EXECUTION');
});

test('scanner: buffer status with assigned_to → BUFFER_WITH_OWNER', () => {
  const { epic } = makeProject();
  const t = makeManagedTask(epic.id);
  setRawTask(t.id, { status: 'todo', assigned_to: 'stale-worker' });
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'named_violation');
  assert.equal(cls.code, 'BUFFER_WITH_OWNER');
});

test('scanner: ghost fence (no execution row) → TASK_FENCE_WITHOUT_ACTIVE_EXECUTION', () => {
  const { epic } = makeProject();
  const t = makeManagedTask(epic.id);
  setRawTask(t.id, {
    status: 'in_progress',
    assigned_to: 'w-1',
    current_execution_id: 'exec-ghost',
  });
  // No insertExecution — execution row is missing.
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'named_violation');
  assert.equal(cls.code, 'TASK_FENCE_WITHOUT_ACTIVE_EXECUTION');
});

test('scanner: terminal execution owning task → TERMINAL_EXECUTION_OWNS_TASK', () => {
  const { epic } = makeProject();
  const t = makeManagedTask(epic.id);
  setRawTask(t.id, {
    status: 'in_progress',
    assigned_to: 'w-dead',
    current_execution_id: 'exec-term',
  });
  insertExecution(t.id, 'exec-term', 'lost', 'w-dead');
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'named_violation');
  assert.equal(cls.code, 'TERMINAL_EXECUTION_OWNS_TASK');
});

test('scanner: done+pending → DONE_PENDING_WITHOUT_INTEGRATION_INTENT (audit seam)', () => {
  const { epic } = makeProject();
  const t = makeManagedTask(epic.id);
  setRawTask(t.id, {
    status: 'done',
    integration_state: 'pending',
    assigned_to: null,
    current_execution_id: null,
  });
  // No synthetic integration id in metadata → violation.
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'named_violation');
  assert.equal(cls.code, 'DONE_PENDING_WITHOUT_INTEGRATION_INTENT');
});

test('scanner: terminal merged task → valid_managed (completed)', () => {
  const { epic } = makeProject();
  const t = makeManagedTask(epic.id);
  setRawTask(t.id, {
    status: 'done',
    integration_state: 'merged',
    assigned_to: null,
    current_execution_id: null,
  });
  const cls = classifyTask(getDb(), t.id);
  assert.equal(cls.kind, 'valid_managed');
});

test('scanner: scanProject totals add up', () => {
  const { product, epic } = makeProject();
  // One clean queued task.
  makeManagedTask(epic.id);
  // One violation.
  const bad = makeManagedTask(epic.id);
  setRawTask(bad.id, { status: 'todo', assigned_to: 'stale' });
  const report = scanProject(getDb(), product.id, epic.id);
  assert.equal(report.totalTasks, report.validManaged + report.validLegacy + report.violations);
  assert.ok(report.violations >= 1);
});
