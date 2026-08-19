// tests/app/graceful-drain-pause.test.mjs
//
// Graceful-drain PAUSE contract (docs/architecture/PAUSE-DESIGN.md).
//
// The pause is ONE durable project-scope operator hold — nothing else:
//   T1 — the claim predicate (work-assignment-core :479-489) refuses every
//        card of the held project while a WITHOUT-hold control project still
//        claims. Pinned as THE pause contract.
//   T3 — drain semantics: with the hold placed and one active (stub)
//        execution, dispatch starts NOTHING new, the active card completes
//        through the real worker_done path, and the engine's exit-2 tail
//        (finishFactoryLaunch 'paused') settles the launch in a temp DB.
//   T4src — placeProjectHold is idempotent: a double-click yields exactly one
//        unreleased hold row (the endpoint-level T4 lives in
//        tests/architecture/panel-pause-wiring.test.mjs).
//
// Pattern follows tests/app/operator-soft-stop.test.mjs: temp DB via DB_PATH
// + getDb(), hires staged through the REAL SqliteWorkAssignmentAdapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { placeProjectHold, releaseOperatorHolds } from '../../dist/app/operator-soft-stop.js';
import { distributeQueuedTasks } from '../../dist/app/dispatch-loop.js';
import {
  claimFactoryLaunch,
  finishFactoryLaunch,
  markFactoryLaunchRunning,
  requestFactoryLaunch,
} from '../../dist/infrastructure/factory/sqlite-factory-launch-repository.js';
import { SqliteWorkAssignmentAdapter } from '../../dist/infrastructure/work/sqlite-work-assignment-adapter.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { handlers as dispatcher } from '../../dist/tools/dispatcher.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-drainpause-'));
process.env.DB_PATH = path.join(temp, 'drainpause.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Staging helpers (same shape as operator-soft-stop.test.mjs).
// ---------------------------------------------------------------------------

let projectCounter = 0;
function setupProject() {
  projectCounter += 1;
  const p = projects.project_create({ name: `drainpause-${Date.now()}-${projectCounter}` });
  const e = epics.epic_create({ project_id: p.id, name: `drainpause epic ${projectCounter}` });
  return { projectId: p.id, epicId: e.id };
}

/** Stamp process_run_id onto a task's metadata — the saga4 authority gate. */
function stampProcessRun(taskId, processRunId) {
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

/** Stage one claimable card WITHOUT hiring it. */
function stageCard(epicId, title) {
  const task = tasks.task_create({ epic_id: epicId, title });
  stampProcessRun(task.id, task.id);
  return task.id;
}

/** Stage one full hire through the REAL assignment adapter. */
function stageHire(projectId, epicId, { executionId, workerId }) {
  const taskId = stageCard(epicId, `hire-${executionId}`);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId,
    workerId,
    workerExecutionId: executionId,
    runId: `run-${executionId}`,
    machineId: os.hostname(),
  });
  assert.notEqual(work, null, `hire must claim task ${taskId}`);
  return { taskId, executionId };
}

function tryClaim(projectId, executionId) {
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  return adapter.assignTask({
    projectId,
    workerId: `w-${executionId}`,
    workerExecutionId: executionId,
    runId: `run-${executionId}`,
    machineId: os.hostname(),
  });
}

function activeProjectHolds(projectId) {
  return getDb().prepare(
    `SELECT * FROM factory_operator_holds
      WHERE subject_kind='project' AND subject_ref=? AND released_at IS NULL`,
  ).all(String(projectId));
}

// ---------------------------------------------------------------------------
// T1 — the pause contract on the claim predicate.
// ---------------------------------------------------------------------------

test('T1 pause contract: project hold from placeProjectHold returns null for EVERY card of the project while a WITHOUT-hold control project still claims', () => {
  const held = setupProject();
  const control = setupProject();
  const heldCard1 = stageCard(held.epicId, 'held-1');
  const heldCard2 = stageCard(held.epicId, 'held-2');
  const controlCard = stageCard(control.epicId, 'control-1');

  const placement = placeProjectHold(getDb(), {
    projectId: held.projectId,
    reason: 'panel-drain-pause',
    createdBy: 'panel',
  });
  assert.equal(placement.placed, true,
    'T1: placeProjectHold must place the durable project-scope hold (the whole pause)');

  assert.equal(tryClaim(held.projectId, 'exec-t1-a'), null,
    'T1: claimNextTask must return null for every card of the held project (pause contract)');
  assert.equal(tryClaim(held.projectId, 'exec-t1-b'), null,
    'T1: a second worker must ALSO get null — the fence is per-claim, not per-worker');

  const free = tryClaim(control.projectId, 'exec-t1-control');
  assert.notEqual(free, null,
    'T1: the WITHOUT-hold control project must still claim while the held project is paused');
  assert.equal(free.taskId, controlCard);

  // ▶ unlock counterpart: releasing the hold restores hiring of the SAME cards.
  const released = releaseOperatorHolds(getDb(), { projectId: held.projectId, releasedBy: 'test' });
  assert.ok(released.released >= 1, 'T1: releaseOperatorHolds(projectId) must release the project hold');
  const resumed = tryClaim(held.projectId, 'exec-t1-resume');
  assert.notEqual(resumed, null,
    'T1: after the release the held project must hire again (the unpark surface)');
  assert.ok([heldCard1, heldCard2].includes(resumed.taskId));
});

// ---------------------------------------------------------------------------
// T3 — drain semantics: no new claims, active completes, engine parks paused.
// ---------------------------------------------------------------------------

test('T3 drain: hold placed + one active execution → dispatch starts nothing, worker_done completes, engine tail parks the launch paused (exit-2)', async () => {
  const { projectId, epicId } = setupProject();
  const active = stageHire(projectId, epicId, { executionId: 'exec-drain', workerId: 'w-drain' });
  // A second, still-queued card that MUST NOT be claimed while the hold is up.
  const queuedCard = stageCard(epicId, 'queued-while-paused');
  getDb().prepare(
    `UPDATE worker_executions SET state='running' WHERE execution_id='exec-drain'`,
  ).run();

  placeProjectHold(getDb(), { projectId, reason: 'panel-drain-pause', createdBy: 'panel' });

  // (a) The dispatch drain: the queue is fenced — the executor factory must
  // never be consulted (no new hire), and the drain returns 0 terminal
  // workers. capacity_blocked/Promise.race(active) already handles the
  // active tail; here the queue itself is empty-for-this-engine by the hold.
  let factoryCalls = 0;
  const dispatched = await distributeQueuedTasks({
    projectId,
    epicId,
    readConcurrencyAdmission: () => ({
      operatorConcurrency: 2,
      modelConcurrencyLimit: 2,
      effectiveConcurrency: 2,
      activeExecutions: 0,
    }),
    workerExecutorFactory: () => {
      factoryCalls += 1;
      throw new Error(
        'T3: the executor factory must never be called while the project hold fences the queue',
      );
    },
    workAssignment: new SqliteWorkAssignmentAdapter(getDb()),
    idGenerator: {
      newId: () => `id-${Math.random()}`,
      newTypedId: prefix => `${prefix}-${Math.random()}`,
    },
    machineId: os.hostname(),
    pollMs: 10,
  });
  assert.equal(factoryCalls, 0,
    'T3: no new worker may be hired while the hold fences the queue (drain, not kill)');
  assert.equal(dispatched, 0,
    'T3: the drain must report zero terminal workers — nothing was started under the hold');

  // (b) The ACTIVE execution is not fenced by the hold: it completes through
  // the real worker_done path (holds are consulted only on claim).
  const reply = dispatcher.worker_done({
    task_id: active.taskId,
    worker_id: 'w-drain',
    result: 'drained card finished its turn',
    execution_id: 'exec-drain',
  });
  assert.equal(reply.completed, active.taskId,
    'T3: the active worker must finish its turn under the hold (worker_done accepted)');
  assert.equal(activeProjectHolds(projectId).length, 1,
    'T3: the worker completion must NOT release the operator hold (durable pause)');

  // (c) The still-queued card remains fenced after the drain.
  assert.equal(tryClaim(projectId, 'exec-drain-post'), null,
    'T3: after the active card completes, the queued card must stay fenced (engine self-parks)');

  // (d) The engine tail — the exact call orchestrate-cli makes on the
  // 3-streak empty-queue path (exit 2): finishFactoryLaunch('paused').
  // Paused is terminal-for-this-launch: completed_at is stamped and the
  // one-active slot is freed so the next ▶ can create a fresh launch.
  const db = getDb();
  const orderRef = `order-drain-${projectId}`;
  db.prepare(
    `INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state)
     VALUES (?, ?, ?, 'existing_project', 'provisioned')`,
  ).run(orderRef, projectId, epicId);
  const launchRef = requestFactoryLaunch({
    orderRef, mode: 'new', projectId, epicId,
    initiatedBy: 'test', idempotencyKey: `drain-park-${projectId}`, concurrency: 1,
  }, db);
  const claimToken = `tok-drain-${projectId}`;
  claimFactoryLaunch(launchRef, claimToken, db);
  const lifecycleRunId = 9000 + projectId;
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
        description, definition_snapshot, definition_hash, project_id, epic_id,
        initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
        status, entry_stage_id)
     VALUES (?, 'lf', '1', 'lf@1', 'd', '', '{}', 'h', ?, ?, 'op', ?,
             's', '{}', 'ih', 'paused', 'e')`,
  ).run(lifecycleRunId, projectId, epicId, `ik-drain-${projectId}`);
  markFactoryLaunchRunning(launchRef, claimToken, lifecycleRunId, db);

  finishFactoryLaunch(launchRef, claimToken, 'paused', null, 'paused', db);

  const launch = db.prepare(
    `SELECT state, completed_at FROM factory_launch_requests WHERE launch_ref=?`,
  ).get(launchRef);
  assert.equal(launch.state, 'paused',
    'T3: the parked engine must settle its launch as paused (exit-2), never completed');
  assert.ok(launch.completed_at,
    'T3: paused must stamp completed_at — terminal for THIS launch, the slot is freed');
  const order = db.prepare(`SELECT state FROM factory_orders WHERE order_ref=?`).get(orderRef);
  assert.equal(order.state, 'paused',
    'T3: the parked order must read paused so status readers cannot mistake it for convergence');

  // The freed slot: a resume launch under the same order succeeds.
  const resumeRef = requestFactoryLaunch({
    orderRef, mode: 'resume', projectId, epicId,
    initiatedBy: 'test', idempotencyKey: `drain-resume-${projectId}`, concurrency: 1,
    lifecycleRunId,
  }, db);
  assert.notEqual(resumeRef, launchRef,
    'T3: after the park the one-active-launch slot must be free for the next ▶');
});

// ---------------------------------------------------------------------------
// T4src — idempotent placement (the endpoint-level T4 lives in the wiring suite).
// ---------------------------------------------------------------------------

test('T4src: placeProjectHold is idempotent — a double-click yields exactly ONE hold row', () => {
  const { projectId } = setupProject();

  const first = placeProjectHold(getDb(), {
    projectId, reason: 'panel-drain-pause', createdBy: 'panel',
  });
  assert.equal(first.placed, true, 'T4src: the first click places the hold');

  const second = placeProjectHold(getDb(), {
    projectId, reason: 'panel-drain-pause', createdBy: 'panel',
  });
  assert.equal(second.placed, false,
    'T4src: the second click must be an idempotent no-op (placed=false)');
  assert.equal(second.holdRef, first.holdRef,
    'T4src: the idempotent replay must surface the SAME hold identity');

  assert.equal(activeProjectHolds(projectId).length, 1,
    'T4src: exactly ONE unreleased project hold row may exist for the project');
});
