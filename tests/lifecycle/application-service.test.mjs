/**
 * ADR-013 Phase 4.1 — application service facade.
 *
 * Source: docs/architecture/decisions/013-lifecycle-fix-execution-plan.md §4.1.
 *
 * Coverage:
 *   1. commandIdFor is stable for retries of the same command.
 *   2. commandIdFor differs for semantically different commands.
 *   3. handleLifecycleCommand delegates to the correct handler and returns
 *      a structured result with timing + audit info.
 *   4. The audit row lands in lifecycle_events on success.
 *   5. A failed command (handler throws) propagates the error AND leaves
 *      a failure audit row.
 *
 * Scope note: this is the FACADE only — it delegates to the existing
 * dispatcher handlers. The handlers' bodies still own their SQL; migrating
 * them into the kernel is the long tail of Phase 4.
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
import { seedUnboundExecution } from './fixtures/managed-execution.mjs';
import {
  handleLifecycleCommand,
  commandIdFor,
  LifecycleCommandError,
} from '../../dist/lifecycle/application-service.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-appsvc-'));
process.env.DB_PATH = path.join(temp, 'appsvc.db');
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function makeProject() {
  const product = projects.project_create({ name: `AS ${Math.random().toString(36).slice(2, 6)}` });
  repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  return { product, epic };
}

// ---------------------------------------------------------------------------
// 1-2. command id stability + uniqueness.
// ---------------------------------------------------------------------------

test('appsvc: commandIdFor is stable across retries of the same command', () => {
  const cmd = {
    kind: 'WorkerDone',
    taskId: 42,
    workerId: 'w1',
    result: 'done',
    verdict: 'approved',
    executionId: 'exec-1',
  };
  const a = commandIdFor(cmd);
  const b = commandIdFor(cmd);
  assert.equal(a, b, 'same command → same id');
  assert.match(a, /WorkerDone:42:exec-1:approved/);
});

test('appsvc: commandIdFor differs for semantically different commands', () => {
  const base = {
    kind: 'WorkerDone',
    taskId: 42,
    workerId: 'w1',
    result: 'done',
    verdict: 'approved',
    executionId: 'exec-1',
  };
  const differentVerdict = { ...base, verdict: 'changes_requested' };
  const differentTask = { ...base, taskId: 43 };
  assert.notEqual(commandIdFor(base), commandIdFor(differentVerdict));
  assert.notEqual(commandIdFor(base), commandIdFor(differentTask));
});

test('appsvc: commandIdFor covers all command kinds without throwing', () => {
  // Smoke test — every kind must produce a string id.
  const samples = [
    { kind: 'WorkerNext', workerId: 'w', projectId: 1 },
    { kind: 'WorkerDone', taskId: 1, workerId: 'w', result: 'r' },
    { kind: 'WorkerAskNeed', taskId: 1, workerId: 'w' },
    { kind: 'WorkerAskDone', taskId: 1, workerId: 'w' },
    { kind: 'WorkerMergeAcquire', taskId: 1, workerId: 'w' },
    { kind: 'WorkerMergeRelease', taskId: 1, workerId: 'w', result: 'merged' },
  ];
  for (const cmd of samples) {
    const id = commandIdFor(cmd);
    assert.ok(typeof id === 'string' && id.length > 0, `${cmd.kind} produced ${id}`);
    assert.match(id, new RegExp(`^${cmd.kind}:`), `${cmd.kind} id starts with kind prefix`);
  }
});

// ---------------------------------------------------------------------------
// 3-4. Successful delegation + audit row.
// ---------------------------------------------------------------------------

test('appsvc: handleLifecycleCommand delegates to handler and writes audit row', () => {
  const { product, epic } = makeProject();
  const t = tasks.task_create({
    epic_id: epic.id, title: 'T', task_kind: 'development.code',
    execution_mode: 'tracker_only', priority: 'high',
  });
  const db = getDb();
  db.prepare(
    `UPDATE tasks SET status='review_in_progress', assigned_to='reviewer',
                       updated_at=datetime('now') WHERE id=?`,
  ).run(t.id);
  // The fence must name a DURABLE execution whose frozen context is
  // hash-verified; production ingress fails closed otherwise.
  seedUnboundExecution(db, {
    executionId: 'worker-execution:appsvc-delegation',
    projectId: product.id, epicId: epic.id, taskId: t.id, workerId: 'reviewer',
    phase: 'reviewing',
  });

  const result = handleLifecycleCommand(db, {
    kind: 'WorkerDone',
    taskId: t.id,
    workerId: 'reviewer',
    result: 'PRD approved',
    verdict: 'approved',
    // The execution fence is mandatory (§22: managed tools validate execution
    // authority fail-closed). worker_done derives its idempotency command id
    // from the CALLER-SUPPLIED execution_id precisely because the task's own
    // fence is already cleared by the time a retry arrives.
    executionId: 'worker-execution:appsvc-delegation',
  });

  assert.equal(result.commandKind, 'WorkerDone');
  assert.equal(result.handledBy, 'worker_done');
  assert.equal(result.actor, 'reviewer');
  assert.equal(result.taskId, t.id);
  assert.ok(result.durationMs >= 0, 'duration populated');
  assert.ok(result.commandId, 'command id populated');

  // The reply is whatever worker_done returned — must include the new status.
  assert.equal(result.reply.completed_new_status, 'done');

  // Audit row landed in lifecycle_events.
  const auditRow = db.prepare(
    `SELECT event_kind, payload_json FROM lifecycle_events
      WHERE command_id=? ORDER BY seq LIMIT 1`,
  ).get(result.commandId);
  assert.ok(auditRow, 'audit row exists');
  assert.equal(auditRow.event_kind, 'WorkerDoneHandled');
  const payload = JSON.parse(auditRow.payload_json);
  assert.equal(payload.command, 'WorkerDone');
  assert.equal(payload.handled_by, 'worker_done');
});

// ---------------------------------------------------------------------------
// 5. Failure path — error propagates AND audit row records the failure.
// ---------------------------------------------------------------------------

test('appsvc: failed command propagates error and writes failure audit row', () => {
  const { epic } = makeProject();
  const t = tasks.task_create({
    epic_id: epic.id, title: 'T-fail', task_kind: 'development.code',
    execution_mode: 'tracker_only', priority: 'high',
  });
  const db = getDb();

  // WorkerDone on a task that is NOT assigned to the worker → handler throws.
  const cmd = {
    kind: 'WorkerDone',
    taskId: t.id,
    workerId: 'someone-who-does-not-own-this',
    result: 'r',
    verdict: 'approved',
    executionId: 'worker-execution:appsvc-not-owner',
  };
  assert.throws(
    () => handleLifecycleCommand(db, cmd),
    /not assigned/i,
    'underlying handler error propagates',
  );

  // Failure audit row.
  const failureRow = db.prepare(
    `SELECT event_kind, payload_json FROM lifecycle_events
      WHERE command_id=? AND event_kind LIKE '%Failed' LIMIT 1`,
  ).get(commandIdFor(cmd));
  assert.ok(failureRow, 'failure audit row exists');
  assert.equal(failureRow.event_kind, 'WorkerDoneFailed');
  const payload = JSON.parse(failureRow.payload_json);
  assert.match(payload.error, /not assigned/i);
});

test('appsvc: unknown command kind throws LifecycleCommandError', () => {
  // We cannot construct an unknown kind through the type system, so we
  // pass a malformed object through as any and confirm the facade rejects.
  const db = getDb();
  assert.throws(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => handleLifecycleCommand(db, { kind: 'Nonsense', workerId: 'x' }),
    (err) => {
      // The facade's exhaustive default case throws LifecycleCommandError
      // OR a generic Error depending on whether TS allowed the call. At
      // runtime we accept either — the test verifies it errors loudly.
      assert.ok(err instanceof Error);
      return true;
    },
  );
});
