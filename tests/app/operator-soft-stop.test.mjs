// tests/app/operator-soft-stop.test.mjs
//
// Operator SOFT-STOP protocol (schema v13) — durable phases, fence+rewind
// transaction atomicity, the mutating-tool fence, race-order safety, the boot
// reaper, recovery-budget fairness, dispatcher hold blocking and adoption's
// void-terminal rule.
//
// Pattern follows tests/architecture/worker-next-fence-rejection.test.mjs:
// a temp DB via DB_PATH + getDb(), hires staged through the REAL
// SqliteWorkAssignmentAdapter (the same path the dispatch loop uses), and the
// MCP tool handlers invoked directly. OS-process behaviour (real tree-kill,
// CLI verbs) lives in operator-soft-stop-process.test.mjs; the v12→v13
// migration lives in operator-soft-stop-migration.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  brakeEnginesForProject,
  executeWorkerStops,
  fenceAndRewindHire,
  planWorkerStops,
  reapInterruptedWorkerStops,
  releaseOperatorHolds,
} from '../../dist/app/operator-soft-stop.js';
import { adoptTerminalExecutionsAtEngineStart } from '../../dist/app/engine-start-adoption.js';
import { runFactoryBootRevision } from '../../dist/app/factory-boot-revision.js';
import { countTerminalExecutionsForTask } from '../../dist/app/product-lifecycle-runtime.js';
import { SqliteWorkAssignmentAdapter } from '../../dist/infrastructure/work/sqlite-work-assignment-adapter.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { handlers as dispatcher } from '../../dist/tools/dispatcher.js';
import { handlers as artifacts } from '../../dist/tools/artifacts.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-softstop-'));
process.env.DB_PATH = path.join(temp, 'softstop.db');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Staging helpers.
// ---------------------------------------------------------------------------

function setupProject() {
  const p = projects.project_create({ name: `softstop-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const e = epics.epic_create({ project_id: p.id, name: 'softstop epic' });
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

/**
 * Stage one full hire through the REAL assignment adapter: claims the card,
 * writes the worker_executions row and leases the workplace (loop='running',
 * active_reservation_ref=executionId) — exactly what the dispatch loop does
 * before spawning a worker.
 */
function stageHire(projectId, epicId, { executionId, workerId, title }) {
  const task = tasks.task_create({ epic_id: epicId, title: title ?? 't' });
  stampProcessRun(task.id, task.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId,
    workerId,
    workerExecutionId: executionId,
    runId: `run-${executionId}`,
    machineId: os.hostname(),
  });
  assert.notEqual(work, null, `hire must claim task ${task.id}`);
  assert.equal(work.workerExecutionId, executionId);
  return { taskId: task.id, executionId };
}

function workplaceOf(taskId) {
  return getDb()
    .prepare('SELECT workplace_ref FROM tasks WHERE id=?')
    .get(taskId).workplace_ref;
}

function stopRow(executionId) {
  return getDb()
    .prepare('SELECT * FROM factory_worker_stops WHERE worker_execution_ref=?')
    .get(executionId);
}

/** Fake engine-brake/kill deps so no OS process is touched in this file. */
const deadKillDeps = { isAlive: () => false, killVerified: () => true };
const noEngineBrake = {
  isAlive: () => false,
  readCommandLine: () => null,
  killTree: () => true,
};

// ---------------------------------------------------------------------------
// Phase 1 — plan / dry-run.
// ---------------------------------------------------------------------------

test('plan lists active executions on hired workplaces; dry-run writes nothing', async () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-plan', workerId: 'w-plan' });

  const planned = planWorkerStops(getDb(), { projectId });
  const mine = planned.filter(item => item.executionId === 'exec-plan');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].taskId, hire.taskId);
  assert.equal(mine[0].workplaceRef, workplaceOf(hire.taskId));
  assert.equal(mine[0].workplaceLoopState, 'running');
  assert.equal(mine[0].workplaceKanbanPhase, 'in_progress');
  assert.equal(mine[0].action, 'rewind');

  const result = await executeWorkerStops({
    db: getDb(),
    projectId,
    reason: 'dry-run check',
    createdBy: 'test',
    dryRun: true,
    engineBrakeDeps: noEngineBrake,
    killDeps: deadKillDeps,
    log: () => {},
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.stops.length, 0, 'dry-run stops nothing');
  assert.equal(stopRow('exec-plan'), undefined, 'dry-run writes no stop row');
  const exec = getDb().prepare('SELECT state, voided_at FROM worker_executions WHERE execution_id=?').get('exec-plan');
  assert.equal(exec.state, 'reserved');
  assert.equal(exec.voided_at, null);
});

test('plan treats kernel-owned (verifying) workplaces as listed-but-untouched', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-verify', workerId: 'w-verify' });
  const ref = workplaceOf(hire.taskId);
  // Move the workplace into the kernel-owned verifying state (running →
  // verifying is the candidate-sealed edge).
  const wp = getDb().prepare('SELECT revision FROM factory_workplaces WHERE workplace_ref=?').get(ref);
  getDb().prepare(
    `UPDATE factory_workplaces SET loop_state='verifying', revision=? WHERE workplace_ref=?`,
  ).run(wp.revision + 1, ref);

  const mine = planWorkerStops(getDb(), { projectId }).filter(item => item.executionId === 'exec-verify');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].action, 'kernel_owned');
});

test('plan fails closed on an execution state the protocol does not know', () => {
  // A scratch DB whose worker_executions has no state CHECK lets an unknown
  // state exist — the plan guard must refuse it with a typed error.
  const db = getDb();
  const scratch = new (db.constructor)(':memory:');
  scratch.exec(SCHEMA_SQL);
  scratch.exec('DROP TABLE worker_executions');
  scratch.exec(`
    CREATE TABLE worker_executions (
      execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id INTEGER NOT NULL,
      epic_id INTEGER NOT NULL, task_id INTEGER NOT NULL, worker_id TEXT NOT NULL,
      machine_id TEXT NOT NULL, launcher TEXT NOT NULL DEFAULT 'claude_cli',
      state TEXT NOT NULL DEFAULT 'reserved',
      phase TEXT NOT NULL DEFAULT 'executing', pid INTEGER, process_birth_token TEXT,
      log_path TEXT, reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT, phase_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT, exit_code INTEGER, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', lease_expires_at TEXT, heartbeat_at TEXT,
      progress_at TEXT, suspected_stuck_at TEXT, cancel_requested_at TEXT,
      stuck_state TEXT NOT NULL DEFAULT 'active',
      stop_fence INTEGER NOT NULL DEFAULT 0, voided_at TEXT
    )`);
  scratch.prepare("INSERT INTO projects (id,name) VALUES (9,'p9')").run();
  scratch.prepare("INSERT INTO epics (id,project_id,name) VALUES (9,9,'e9')").run();
  scratch.prepare("INSERT INTO tasks (id,epic_id,title,status) VALUES (9,9,'t9','in_progress')").run();
  scratch.prepare(
    `INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state)
     VALUES ('exec-mystery','r',9,9,9,'w','m','mystery')`,
  ).run();
  assert.throws(
    () => planWorkerStops(scratch, {}),
    /WORKER_STOP_PLAN_UNKNOWN_EXECUTION_STATE.*mystery/s,
  );
  scratch.close();
});

// ---------------------------------------------------------------------------
// Phase 2 — engine brake.
// ---------------------------------------------------------------------------

test('engine brake: dead persisted pid, guarded pid-reuse, braked, and fail-closed survivor', () => {
  const { projectId } = setupProject();
  const db = getDb();
  const insertControl = (name, pid) => {
    const e = epics.epic_create({ project_id: projectId, name });
    db.prepare(
      'INSERT INTO lifecycle_execution_controls (epic_id, engine_state, engine_pid) VALUES (?, ?, ?)',
    ).run(e.id, 'running', pid);
    return e.id;
  };

  // One stateful fake: a set of alive pids the killTree can (or cannot) reap.
  const alive = new Set();
  const depsFor = () => ({
    isAlive: pid => alive.has(pid),
    readCommandLine: pid => (pid === 424243 ? 'C:/somewhere/unrelated.exe --serve' : 'node dist/orchestrate-cli.js --launch-ref=x'),
    killTree: pid => {
      if (pid === 424245) return false; // the 424245 engine SURVIVES the kill
      alive.delete(pid);
      return true;
    },
  });

  // e1: persisted pid already dead → already_dead, control marked stopped.
  const e1 = insertControl('brake-1', 424242);
  // e2: live pid of an UNRELATED process (pid reuse) → guarded skip.
  const e2 = insertControl('brake-2', 424243);
  alive.add(424243);
  // e3: live verified engine that dies on the kill → braked.
  const e3 = insertControl('brake-3', 424244);
  alive.add(424244);
  // e4: live verified engine that SURVIVES the kill → ENGINE_BRAKE_FAILED.
  const e4 = insertControl('brake-4', 424245);
  alive.add(424245);

  try {
    assert.throws(
      () => brakeEnginesForProject(db, { projectId }, depsFor()),
      /ENGINE_BRAKE_FAILED: persisted engine pid 424245/,
    );
  } finally {
    // The survivor threw the fail-closed error; e3 was already killed by the
    // aborted pass. Re-arm e3 so the retry exercises the braked path, and
    // strip the survivor (the operator's manual cleanup killed it).
    alive.delete(424244);
    alive.delete(424245);
    alive.add(424244);
  }

  // Retry with the survivor gone: everything converges, controls stopped.
  const results = brakeEnginesForProject(db, { projectId }, {
    isAlive: pid => alive.has(pid),
    readCommandLine: pid => (pid === 424243 ? 'unrelated.exe' : 'node dist/orchestrate-cli.js'),
    killTree: pid => { alive.delete(pid); return true; },
  });
  const byEpic = new Map(results.map(item => [item.epicId, item.outcome]));
  assert.equal(byEpic.get(e1), 'already_dead');
  assert.equal(byEpic.get(e2), 'pid_reused_foreign', 'a reused foreign pid is never killed');
  assert.equal(byEpic.get(e3), 'braked');
  assert.equal(byEpic.get(e4), 'already_dead', 'post-cleanup survivor is dead');
  for (const epicId of [e1, e2, e3, e4]) {
    assert.equal(
      db.prepare('SELECT engine_state FROM lifecycle_execution_controls WHERE epic_id=?').get(epicId).engine_state,
      'stopped',
    );
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — fence + rewind atomicity.
// ---------------------------------------------------------------------------

test('fence+rewind: running→queued, lease cleared, void set, stop_fence bumped, hold present', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-fence', workerId: 'w-fence' });
  const db = getDb();
  const ref = workplaceOf(hire.taskId);

  // Seed a leased transition obligation covering the workplace (the engine's
  // reconciler holds it; the rewind must return it to the pending queue).
  db.prepare(
    `INSERT INTO factory_transition_obligations
       (obligation_key, source_kind, source_ref, source_digest, subject_ref,
        handoff_kind, owner_capability, fence, state, lease_owner, lease_expires_at)
     VALUES ('obl-1','gate','gate-1','d', ?, 'handoff','cap', 1, 'in_progress',
             'engine-uuid', datetime('now', '+10 minutes'))`,
  ).run(ref);

  // Execution must be ACTIVE (running) to be fenced.
  db.prepare(
    `UPDATE worker_executions SET state='running', pid=NULL WHERE execution_id=?`,
  ).run('exec-fence');

  const result = fenceAndRewindHire(db, {
    stopRef: 'stop-fence-1',
    executionId: 'exec-fence',
    workplaceRef: ref,
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });

  assert.equal(result.outcome, 'fenced');
  assert.equal(result.workplaceRewound, true);
  assert.equal(result.taskReleased, true);

  // Workplace: pre-hire point, Kanban + role preserved (REG-28-AC-02).
  const wp = db.prepare(
    'SELECT kanban_phase, loop_state, next_role, active_reservation_ref, revision FROM factory_workplaces WHERE workplace_ref=?',
  ).get(ref);
  assert.equal(wp.loop_state, 'queued');
  assert.equal(wp.kanban_phase, 'in_progress');
  assert.equal(wp.next_role, 'author');
  assert.equal(wp.active_reservation_ref, null);

  // Execution: audit-only VOID (terminal state + voided_at + stop_fence).
  const exec = db.prepare('SELECT state, voided_at, stop_fence FROM worker_executions WHERE execution_id=?').get('exec-fence');
  assert.equal(exec.state, 'terminated');
  assert.notEqual(exec.voided_at, null);
  assert.equal(exec.stop_fence, 1);

  // Task: fence cleared, back in the claimable queue.
  const task = db.prepare('SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?').get(hire.taskId);
  assert.equal(task.status, 'todo');
  assert.equal(task.assigned_to, null);
  assert.equal(task.current_execution_id, null);

  // Obligation lease cleared, obligation back to pending.
  const obligation = db.prepare(
    'SELECT state, lease_owner, lease_expires_at FROM factory_transition_obligations WHERE obligation_key=?',
  ).get('obl-1');
  assert.equal(obligation.state, 'pending');
  assert.equal(obligation.lease_owner, null);
  assert.equal(obligation.lease_expires_at, null);

  // Operator hold present and active.
  const hold = db.prepare(
    `SELECT * FROM factory_operator_holds WHERE hold_ref=?`,
  ).get(result.holdRef);
  assert.equal(hold.subject_kind, 'workplace');
  assert.equal(hold.subject_ref, ref);
  assert.equal(hold.released_at, null);

  // Durable stop row persisted at the detached phase.
  const stop = stopRow('exec-fence');
  assert.equal(stop.phase, 'detached');
  assert.equal(stop.workplace_ref, ref);
  assert.equal(stop.project_id, projectId);

  // Idempotent replay: the same fence is a no-op that keeps the hold handle.
  const replay = fenceAndRewindHire(db, {
    stopRef: 'stop-fence-1',
    executionId: 'exec-fence',
    workplaceRef: ref,
    projectId,
    reason: 'operator recall (replay)',
    createdBy: 'test',
  });
  assert.equal(replay.outcome, 'already_void');
  assert.equal(replay.holdRef, result.holdRef);
});

test('fence+rewind: leased→queued (pre-spawn hire) and reviewer Kanban preserved', () => {
  const { projectId, epicId } = setupProject();
  // Review task: created in review state so the claim leases a reviewer.
  const task = tasks.task_create({ epic_id: epicId, title: 'review-card' });
  stampProcessRun(task.id, task.id);
  const db = getDb();
  // A review-status card leases a reviewer (worker-leased advances Kanban to
  // review_in_progress). Stage directly through the adapter.
  db.prepare(`UPDATE tasks SET status='review' WHERE id=?`).run(task.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId, workerId: 'w-rev', workerExecutionId: 'exec-leased', runId: 'r', machineId: os.hostname(),
  });
  assert.notEqual(work, null);
  const ref = workplaceOf(task.id);
  // Rewind the workplace to 'leased' (the pre-spawn point) to exercise the
  // leased→queued edge.
  db.prepare(`UPDATE factory_workplaces SET loop_state='leased' WHERE workplace_ref=?`).run(ref);

  const result = fenceAndRewindHire(db, {
    stopRef: 'stop-leased-1',
    executionId: 'exec-leased',
    workplaceRef: ref,
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });
  assert.equal(result.outcome, 'fenced');
  const wp = db.prepare('SELECT kanban_phase, loop_state, next_role FROM factory_workplaces WHERE workplace_ref=?').get(ref);
  assert.equal(wp.loop_state, 'queued');
  assert.equal(wp.kanban_phase, 'review_in_progress', 'reviewer Kanban preserved');
  assert.equal(wp.next_role, 'reviewer');
  // Reviewer card returns to the review buffer.
  const after = db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id);
  assert.equal(after.status, 'review');
});

test('fence+rewind leaves kernel-owned (verifying) workplaces untouched', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-kernel', workerId: 'w-kernel' });
  const db = getDb();
  const ref = workplaceOf(hire.taskId);
  db.prepare(`UPDATE factory_workplaces SET loop_state='verifying' WHERE workplace_ref=?`).run(ref);
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-kernel'`).run();

  const result = fenceAndRewindHire(db, {
    stopRef: 'stop-kernel-1',
    executionId: 'exec-kernel',
    workplaceRef: ref,
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });
  assert.equal(result.outcome, 'fenced');
  assert.equal(result.kernelOwnedSkipped, true);
  assert.equal(result.workplaceRewound, false);
  const wp = db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?').get(ref);
  assert.equal(wp.loop_state, 'verifying', 'kernel-owned loop untouched');
});

// ---------------------------------------------------------------------------
// Phase 4/5 — orchestrator: durable phase transitions.
// ---------------------------------------------------------------------------

test('executeWorkerStops persists the phase chain and checkpoints at the end', async () => {
  const { projectId, epicId } = setupProject();
  stageHire(projectId, epicId, { executionId: 'exec-phases', workerId: 'w-phases' });
  const db = getDb();
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-phases'`).run();

  let hookCalls = 0;
  const result = await executeWorkerStops({
    db,
    projectId,
    reason: 'protocol test',
    createdBy: 'test',
    engineBrakeDeps: noEngineBrake,
    killDeps: deadKillDeps,
    runnerStopHook: () => { hookCalls += 1; },
    captureCheckpoint: async () => { /* capture succeeded */ },
    log: () => {},
  });

  assert.equal(result.stops.length, 1);
  assert.equal(hookCalls, 1, 'runner stop hook invoked best-effort');
  assert.equal(result.checkpoint.captured, true);
  const stop = stopRow('exec-phases');
  assert.equal(stop.phase, 'checkpointed', 'final phase after checkpoint');
  assert.equal(stop.reason, 'protocol test');

  // Without a checkpoint capture the protocol settles at 'killed'.
  const second = stageHire(projectId, epicId, { executionId: 'exec-phases2', workerId: 'w-phases2' });
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-phases2'`).run();
  void second;
  await executeWorkerStops({
    db, projectId, reason: 'no checkpoint', createdBy: 'test',
    engineBrakeDeps: noEngineBrake, killDeps: deadKillDeps, log: () => {},
  });
  assert.equal(stopRow('exec-phases2').phase, 'killed');
});

// ---------------------------------------------------------------------------
// Tool fence — typed refusal for a voided execution.
// ---------------------------------------------------------------------------

test('tool fence: worker_done on a voided execution is refused with WORKER_EXECUTION_VOIDED', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-void', workerId: 'w-void' });
  const db = getDb();
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-void'`).run();

  // Control: before the void the call path is reachable (it may fail on
  // product gates, but NOT on the void fence).
  fenceAndRewindHire(db, {
    stopRef: 'stop-void-1',
    executionId: 'exec-void',
    workplaceRef: workplaceOf(hire.taskId),
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });

  assert.throws(
    () => dispatcher.worker_done({
      task_id: hire.taskId,
      worker_id: 'w-void',
      result: 'done anyway',
      execution_id: 'exec-void',
    }),
    /WORKER_EXECUTION_VOIDED/,
  );
  // The task stays released by the rewind — the refused call wrote nothing.
  const task = db.prepare('SELECT status, current_execution_id FROM tasks WHERE id=?').get(hire.taskId);
  assert.equal(task.status, 'todo');
  assert.equal(task.current_execution_id, null);
});

test('tool fence: artifact_create on a voided managed execution is refused', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-art', workerId: 'w-art' });
  const db = getDb();
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-art'`).run();

  // Full managed provenance binding (what the MCP child env carries).
  const meta = {
    process_run_id: hire.taskId,
    process_node_id: 'author-node',
    process_module_ref: 'test-module@1.0.0',
    process_input_hash: 'a'.repeat(64),
    work_intent_id: 1,
  };
  db.prepare(
    `INSERT INTO factory_work_intents (id, epic_id, kind, objective, authority_scope, output_schema, token_budget, retry_budget, created_at)
     VALUES (1, ?, 'author', 'o', '{}', 'factory.source-change-candidate.v1', 1, 1, datetime('now'))`,
  ).run(epicId);
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), hire.taskId);

  const previousManaged = process.env.SAGA_MANAGED_EXECUTION;
  const previousExec = process.env.SAGA_EXECUTION_ID;
  const previousTask = process.env.SAGA_TASK_ID;
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = 'exec-art';
  process.env.SAGA_TASK_ID = String(hire.taskId);
  try {
    fenceAndRewindHire(db, {
      stopRef: 'stop-art-1',
      executionId: 'exec-art',
      workplaceRef: workplaceOf(hire.taskId),
      projectId,
      reason: 'operator recall',
      createdBy: 'test',
    });
    assert.throws(
      () => artifacts.artifact_create({
        project_id: projectId,
        epic_id: epicId,
        type: 'decision',
        title: 'voided worker write',
        path: 'docs/decision.md',
      }),
      /WORKER_EXECUTION_VOIDED/,
    );
    const count = db.prepare(
      "SELECT COUNT(*) AS n FROM artifacts WHERE title='voided worker write'",
    ).get();
    assert.equal(count.n, 0, 'no artifact row may survive the refused call');
  } finally {
    process.env.SAGA_MANAGED_EXECUTION = previousManaged;
    process.env.SAGA_EXECUTION_ID = previousExec;
    process.env.SAGA_TASK_ID = previousTask;
  }
});

test('tool fence: worker_next on a voided execution cannot claim a fresh card', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-next', workerId: 'w-next' });
  const queued = tasks.task_create({ epic_id: epicId, title: 'queued-after-stop' });
  stampProcessRun(queued.id, queued.id);
  const db = getDb();
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-next'`).run();

  fenceAndRewindHire(db, {
    stopRef: 'stop-next-1',
    executionId: 'exec-next',
    workplaceRef: workplaceOf(hire.taskId),
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });

  assert.throws(
    () => dispatcher.worker_next({
      worker_id: 'w-next',
      project_id: projectId,
      execution_id: 'exec-next',
      machine_id: 'm',
    }),
    /WORKER_EXECUTION_VOIDED/,
  );
  // The queued card is untouched — the refusal ran before the queue was read.
  const after = db.prepare('SELECT status, assigned_to FROM tasks WHERE id=?').get(queued.id);
  assert.equal(after.status, 'todo');
  assert.equal(after.assigned_to, null);
});

// ---------------------------------------------------------------------------
// Race-order safety — a tool that commits before the fence.
// ---------------------------------------------------------------------------

test('race: artifact committed before the fence sits inside the rewound scope', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-race1', workerId: 'w-race1' });
  const db = getDb();
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-race1'`).run();

  // A mutating tool commits DURING the brake window (execution still running):
  // it succeeds — the fence has not landed yet.
  const previousManaged = process.env.SAGA_MANAGED_EXECUTION;
  const previousExec = process.env.SAGA_EXECUTION_ID;
  const previousTask = process.env.SAGA_TASK_ID;
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = 'exec-race1';
  process.env.SAGA_TASK_ID = String(hire.taskId);
  try {
    const meta = {
      process_run_id: hire.taskId,
      process_node_id: 'author-node',
      process_module_ref: 'test-module@1.0.0',
      process_input_hash: 'a'.repeat(64),
      work_intent_id: 1,
    };
    db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), hire.taskId);
    const artifact = artifacts.artifact_create({
      project_id: projectId,
      epic_id: epicId,
      type: 'decision',
      title: 'racing write',
      path: 'docs/race.md',
    });
    assert.ok(artifact.id > 0, 'pre-fence tool call commits (order: tool first)');

    // The fence lands AFTER the tool: the hire is rewound — the racing
    // execution is voided and can never follow up.
    fenceAndRewindHire(db, {
      stopRef: 'stop-race-1',
      executionId: 'exec-race1',
      workplaceRef: workplaceOf(hire.taskId),
      projectId,
      reason: 'operator recall',
      createdBy: 'test',
    });
    const exec = db.prepare('SELECT state, voided_at, stop_fence FROM worker_executions WHERE execution_id=?').get('exec-race1');
    assert.equal(exec.state, 'terminated');
    assert.equal(exec.voided_at !== null, true);
    const wp = db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?').get(workplaceOf(hire.taskId));
    assert.equal(wp.loop_state, 'queued', 'rewind wins over the in-flight hire');
    const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(hire.taskId);
    assert.equal(task.status, 'todo', 'card back in the queue — the hire never happened');
    // Follow-ups are refused.
    assert.throws(
      () => artifacts.artifact_create({
        project_id: projectId, epic_id: epicId, type: 'decision',
        title: 'after the fence', path: 'docs/race2.md',
      }),
      /WORKER_EXECUTION_VOIDED/,
    );
  } finally {
    process.env.SAGA_MANAGED_EXECUTION = previousManaged;
    process.env.SAGA_EXECUTION_ID = previousExec;
    process.env.SAGA_TASK_ID = previousTask;
  }
});

test('race: worker_done accepted before the fence — durable fence still wins for the void', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-race2', workerId: 'w-race2' });
  const db = getDb();
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-race2'`).run();

  // worker_done commits BEFORE the fence: the card completes, the workplace
  // seals into the kernel-owned verifying state.
  const reply = dispatcher.worker_done({
    task_id: hire.taskId,
    worker_id: 'w-race2',
    result: 'finished just in time',
    execution_id: 'exec-race2',
  });
  assert.equal(reply.completed, hire.taskId);
  const ref = workplaceOf(hire.taskId);
  assert.equal(
    db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?').get(ref).loop_state,
    'verifying',
    'sealed material entered kernel custody',
  );

  // The operator fence lands afterwards: the execution is still VOIDED — the
  // worker cannot fire any further tool — while the sealed material stays in
  // kernel custody (adoption/reconciler own it; never resurrect, never undo).
  const result = fenceAndRewindHire(db, {
    stopRef: 'stop-race-2',
    executionId: 'exec-race2',
    workplaceRef: ref,
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });
  assert.equal(result.outcome, 'fenced');
  assert.equal(result.kernelOwnedSkipped, true);
  const exec = db.prepare('SELECT state, voided_at, stop_fence FROM worker_executions WHERE execution_id=?').get('exec-race2');
  assert.equal(exec.state, 'terminated');
  assert.equal(exec.voided_at !== null, true, 'durable void marker set — fence wins over follow-ups');
  assert.equal(exec.stop_fence, 1);
  assert.equal(
    db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?').get(ref).loop_state,
    'verifying',
    'kernel-owned material untouched',
  );
  assert.throws(
    () => dispatcher.worker_done({
      task_id: hire.taskId,
      worker_id: 'w-race2',
      result: 'retry after the stop',
      execution_id: 'exec-race2',
    }),
    /WORKER_EXECUTION_VOIDED/,
    'a retry of the pre-fence worker_done gets the typed refusal, not the stored reply',
  );
});

// ---------------------------------------------------------------------------
// Boot reaper.
// ---------------------------------------------------------------------------

test('reaper completes an interrupted stop: fence re-driven idempotently, dead pid → reaped', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-reap', workerId: 'w-reap' });
  const db = getDb();
  const ref = workplaceOf(hire.taskId);
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-reap'`).run();
  // Crash window: the stop row exists at engine_braked, the fence never ran.
  db.prepare(
    `INSERT INTO factory_worker_stops
       (stop_ref, worker_execution_ref, workplace_ref, project_id, reason, phase)
     VALUES ('stop-reap-1', 'exec-reap', ?, ?, 'crash window', 'engine_braked')`,
  ).run(ref, projectId);

  const reaped = reapInterruptedWorkerStops(db, deadKillDeps, 'other-host');
  assert.ok(reaped.some(item => item.executionId === 'exec-reap' && item.outcome === 'fence_completed'));
  const stop = stopRow('exec-reap');
  assert.equal(stop.phase, 'reaped', 'dead pid converges to reaped');
  const exec = db.prepare('SELECT state, voided_at FROM worker_executions WHERE execution_id=?').get('exec-reap');
  assert.equal(exec.state, 'terminated');
  assert.notEqual(exec.voided_at, null);
  const wp = db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?').get(ref);
  assert.equal(wp.loop_state, 'queued');

  // Converged rows are not re-processed.
  const second = reapInterruptedWorkerStops(db, deadKillDeps, 'other-host');
  assert.equal(second.filter(item => item.executionId === 'exec-reap').length, 0);

  // The boot revision pass carries the reaper result.
  const revision = runFactoryBootRevision(db);
  assert.ok(Array.isArray(revision.workerStopReap));
});

// ---------------------------------------------------------------------------
// Recovery-budget fairness + adoption.
// ---------------------------------------------------------------------------

test('voided executions do not burn recovery budget', () => {
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-budget', workerId: 'w-budget' });
  const db = getDb();
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-budget'`).run();
  fenceAndRewindHire(db, {
    stopRef: 'stop-budget-1',
    executionId: 'exec-budget',
    workplaceRef: workplaceOf(hire.taskId),
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });
  // A genuine model failure on the same task (terminal, never voided).
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase)
     VALUES ('exec-fail','r',?,? ,?,'w2','m','lost','executing')`,
  ).run(projectId, epicId, hire.taskId);

  // Only the genuine failure counts: the operator recall is not a model
  // failure and must not spend budget or epochs.
  assert.equal(countTerminalExecutionsForTask(db, hire.taskId), 1);
});

test('adoption treats void as terminal — never resurrected, never repaired', () => {
  const db = getDb();
  const { projectId, epicId } = setupProject();
  const hire = stageHire(projectId, epicId, { executionId: 'exec-adopt-void', workerId: 'w-av' });
  const ref = workplaceOf(hire.taskId);
  db.prepare(`UPDATE worker_executions SET state='running' WHERE execution_id='exec-adopt-void'`).run();
  fenceAndRewindHire(db, {
    stopRef: 'stop-adopt-1',
    executionId: 'exec-adopt-void',
    workplaceRef: ref,
    projectId,
    reason: 'operator recall',
    createdBy: 'test',
  });
  // Kernel-owned + voided presenter: adoption must skip it entirely.
  db.prepare(`UPDATE factory_workplaces SET loop_state='verifying', active_reservation_ref=? WHERE workplace_ref=?`)
    .run('exec-adopt-void', ref);
  const result = adoptTerminalExecutionsAtEngineStart(db);
  assert.equal(
    result.details.filter(item => item.executionId === 'exec-adopt-void').length,
    0,
    'voided execution is not adopted',
  );
  assert.equal(
    result.repaired.filter(item => item.executionId === 'exec-adopt-void').length,
    0,
    'voided execution is not repaired into a fresh hire',
  );
});

// ---------------------------------------------------------------------------
// Dispatcher holds — block hiring, release to resume.
// ---------------------------------------------------------------------------

test('active operator holds block hiring; released holds hire again', () => {
  const { projectId, epicId } = setupProject();
  const db = getDb();
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  // A REWOUND hire shape: the card was hired once, the operator stopped it,
  // and the fence+rewind returned the workplace to queued with the task
  // binding intact (tasks.workplace_ref set) — exactly what unpark gates.
  const held = tasks.task_create({ epic_id: epicId, title: 'held card' });
  stampProcessRun(held.id, held.id);
  const heldRef = `workplace/${held.id}/test-module@1.0.0/default/task-${held.id}`;
  const meta = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=?').get(held.id).metadata || '{}');
  meta.workplace_ref = heldRef;
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), held.id);
  db.prepare('UPDATE tasks SET workplace_ref=? WHERE id=?').run(heldRef, held.id);
  db.prepare(
    `INSERT OR IGNORE INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key, kanban_phase, loop_state, next_role)
     VALUES (?, ?, 'test-module@1.0.0', 'default', ?, 'in_progress', 'queued', 'author')`,
  ).run(heldRef, held.id, `task-${held.id}`);

  // No hold yet → the card is claimable (control).
  const control = adapter.assignTask({
    projectId, workerId: 'w-ctrl', workerExecutionId: 'exec-hold-ctrl', runId: 'r', machineId: 'm',
  });
  assert.notEqual(control, null, 'control claim succeeds with no hold');
  assert.equal(control.taskId, held.id);
  // Release the control claim so the card is claimable again for the hold.
  db.prepare(
    `UPDATE worker_executions SET state='exited', finished_at=datetime('now') WHERE execution_id='exec-hold-ctrl'`,
  ).run();
  db.prepare(
    `UPDATE tasks SET status='todo', assigned_to=NULL, current_execution_id=NULL WHERE id=?`,
  ).run(held.id);
  db.prepare(`UPDATE factory_workplaces SET loop_state='queued', active_reservation_ref=NULL WHERE workplace_ref=?`).run(heldRef);

  // Active workplace hold → the re-hire is refused (the card is skipped).
  db.prepare(
    `INSERT INTO factory_operator_holds (hold_ref, subject_kind, subject_ref, reason, created_by)
     VALUES ('hold-test-1', 'workplace', ?, 'operator hold', 'test')`,
  ).run(heldRef);
  const blocked = adapter.assignTask({
    projectId, workerId: 'w-held', workerExecutionId: 'exec-hold-1', runId: 'r', machineId: 'm',
  });
  assert.equal(blocked, null, 'held workplace is not hired');

  // Release the hold → the same card hires again.
  const released = releaseOperatorHolds(db, { workplaceRef: heldRef, releasedBy: 'test' });
  assert.equal(released.released, 1);
  const after = adapter.assignTask({
    projectId, workerId: 'w-held', workerExecutionId: 'exec-hold-2', runId: 'r', machineId: 'm',
  });
  assert.notEqual(after, null, 'released hold hires again');
  assert.equal(after.taskId, held.id);
});

test('project-scope hold blocks every card in the project until released', () => {
  const { projectId, epicId } = setupProject();
  const task = tasks.task_create({ epic_id: epicId, title: 'project-held' });
  stampProcessRun(task.id, task.id);
  const db = getDb();
  db.prepare(
    `INSERT INTO factory_operator_holds (hold_ref, subject_kind, subject_ref, reason, created_by)
     VALUES ('hold-proj-1', 'project', ?, 'stop the line', 'test')`,
  ).run(String(projectId));

  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const blocked = adapter.assignTask({
    projectId, workerId: 'w-proj', workerExecutionId: 'exec-proj-1', runId: 'r', machineId: 'm',
  });
  assert.equal(blocked, null, 'project hold blocks hiring');

  const released = releaseOperatorHolds(db, { projectId });
  assert.ok(released.released >= 1);
  const after = adapter.assignTask({
    projectId, workerId: 'w-proj', workerExecutionId: 'exec-proj-2', runId: 'r', machineId: 'm',
  });
  assert.notEqual(after, null, 'project hiring resumes after unpark');
});
