// Slice 1 (saga4, commit 49ac316) — mandatory AssignedWork node-breaker.
//
// HISTORICAL NOTE: this file used to drive ClaudeBoardRunner through the
// internal pump-loop contract: caller passed { projectId, concurrency } and
// the runner claimed cards itself via the `claimTask` callback inside a
// `while (run.active.size < concurrency)` loop. Slice 1 removed that branch
// entirely — the runner is now a strictly one-card process host. The global
// concurrency budget + card selection now live in src/app/dispatch-loop.ts
// (distributeQueuedTasks loops `while (active.size < concurrency)` calling
// assignTask then start with concurrency:1 + the resulting AssignedWork).
//
// Consequences for these tests:
//   - `start()` now REQUIRES `assignment: AssignedWork` (the dispatcher
//     pre-assigns the card before launch).
//   - `claimTask` is no longer called by the runner — it is dead in this
//     harness. `getTask` is now REQUIRED (the runner fetches the fresh task
//     row via assignmentFromAssignedWork).
//   - One run = one card. Multi-card rotation tests are gone (see
//     tests/dispatcher-race/parallel-concurrency.mjs for the skip rationale;
//     the equivalent invariant for the new dispatcher is Wave 4 REAL-GAP #4).
//
// What survives (and is still asserted below):
//   - the spawn argv shape (claude -p, --no-session-persistence, the
//     worker_next disallow, bypassPermissions, --dangerously-skip-permissions,
//     cwd = workspace),
//   - the empty-queue no-spawn completion,
//   - the recover-on-pre-term-exit path (close handler calls recoverAssignment),
//   - per-repository cwd routing (assignment.repository.local_path wins).
// What was removed (pump-loop contract) is skipped with a pointer to Slice 1.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeBoardRunner } from '../tracker-view/claude-runner.mjs';

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 143));
    return true;
  };
  return child;
}

// Minimal AssignedWork builder for the one-card runner contract (mirrors the
// shape built by WorkAssignmentPort.assignTask — see
// tests/saga3/_conveyor-fakes.mjs fakeWorkAssignment). The dispatcher hands the
// runner exactly one pre-assigned card; the runner never claims.
//
// workerExecutionId is intentionally EMPTY: when present, launch() calls
// markExecutionRunning/markExecutionExited against this.dbPath, which needs a
// real OS process birth token + a real saga.db. Fake EventEmitter children
// have neither. The behaviors under test here (spawn argv, cwd routing,
// recover-on-pre-term-exit) do not depend on the execution fence — same
// discipline as tests/w5-a6-claude-runner-launch-spec.test.mjs (see its
// claimTask note on omitting execution_id).
function fakeAssignment({ taskId, workerId, repository = null, status = 'in_progress' }) {
  return {
    taskId,
    epicId: 0,
    projectId: 7,
    status,
    skill: 'saga-developer',
    workerExecutionId: '',
    fenceToken: '',
    runId: 'test-run',
    workerId,
    machineId: 'test-host',
    repository,
    executionContext: null,
  };
}

test('board runner launches one fresh Claude process for the assigned card (argv contract)', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-runner-test-'));
  const spawns = [];
  let pid = 1000;
  const taskId = 101;

  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name:'test-project', tags:'[]' }),
    resolveWorkspace: () => temp,
    // claimTask is no longer called by the runner (Slice 1); kept only so the
    // constructor shape stays compatible with older harnesses.
    claimTask: () => ({ task:null, skill:null }),
    getTask: id => ({
      id, title:`Task ${id}`, status:'in_progress', tags:'[]', description:'test',
      task_kind: null, workflow_stage: null, execution_mode: 'git_change',
    }),
    getTaskState: id => ({ id, status:'review', assigned_to:null }),
    recoverAssignment: () => {
      throw new Error('recovery should not run');
    },
    spawn: (command, args, options) => {
      const child = fakeChild(++pid);
      spawns.push({ command, args, options, child });
      setTimeout(() => {
        child.emit('close', 0);
      }, 20);
      return child;
    },
  });

  try {
    const assignment = fakeAssignment({ taskId, workerId: 'w-101' });
    const initial = runner.start({ projectId:7, concurrency:1, assignment });
    assert.equal(initial.concurrency, 1);
    await waitFor(() => runner.status(7)?.status === 'completed');

    const result = runner.status(7);
    assert.equal(result.claimed, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(spawns.length, 1);
    assert.equal(new Set(spawns.map(call => call.options.env.SAGA_WORKER_ID)).size, 1);
    assert.deepEqual(
      spawns.map(call => Number(call.options.env.SAGA_TASK_ID)).sort(),
      [101],
    );
    for (const call of spawns) {
      assert.equal(call.command, 'claude');
      assert.ok(call.args.includes('--no-session-persistence'));
      assert.ok(call.args.includes('bypassPermissions'));
      assert.ok(call.args.includes('--dangerously-skip-permissions'));
      assert.equal(call.options.cwd, temp);
    }
  } finally {
    runner.dispose();
    rmSync(temp, { recursive:true, force:true });
  }
});

test('board runner completes without spawning when no card is assigned', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-runner-empty-'));
  let spawnCount = 0;
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name:'empty', tags:'[]' }),
    resolveWorkspace: () => temp,
    claimTask: () => ({ task:null, skill:null }),
    getTask: () => null,
    getTaskState: () => null,
    recoverAssignment: () => false,
    spawn: () => {
      spawnCount += 1;
      return fakeChild(1);
    },
  });

  try {
    // No assignment: the defensive null-guard in pump() finishes the run as
    // completed with zero spawns. This mirrors the empty-queue path the
    // dispatcher hits when distributeQueuedTasks finds nothing claimable.
    runner.start({ projectId:8, concurrency:1 });
    await waitFor(() => runner.status(8)?.status === 'completed');
    assert.equal(spawnCount, 0);
    assert.equal(runner.status(8).claimed, 0);
  } finally {
    runner.dispose();
    rmSync(temp, { recursive:true, force:true });
  }
});

test('board runner recovers a claim when Claude exits before worker_done', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-runner-fail-'));
  const recoveries = [];
  const taskId = 201;
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name:'failure', tags:'[]' }),
    resolveWorkspace: () => temp,
    claimTask: () => ({ task:null, skill:null }),
    getTask: id => ({ id, title:'Failing task', status:'in_progress', tags:'[]' }),
    // The task is still in_progress + owned when the worker dies pre-done →
    // the close handler counts it as failed and calls recoverAssignment.
    getTaskState: () => ({ id:201, status:'in_progress', assigned_to:'still-owned' }),
    recoverAssignment: input => {
      recoveries.push(input);
      return true;
    },
    spawn: () => {
      const child = fakeChild(2001);
      setTimeout(() => child.emit('close', 1), 10);
      return child;
    },
  });

  try {
    const assignment = fakeAssignment({ taskId, workerId: 'w-201' });
    runner.start({ projectId:9, concurrency:1, assignment });
    await waitFor(() => runner.status(9)?.status === 'failed');
    assert.equal(runner.status(9).failed, 1);
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0].taskId, 201);
  } finally {
    runner.dispose();
    rmSync(temp, { recursive:true, force:true });
  }
});

test('board runner launches the assigned typed task in its repository checkout', async () => {
  // Slice 1 note: the runner is one-card, so the former two-repo rotation
  // (cards 301→repoA, 302→repoB claimed in a pump loop) no longer applies.
  // The per-task cwd routing contract STILL HOLDS: when the AssignedWork
  // carries a repository, launch() uses repository.local_path as cwd. This
  // single-card test preserves that assertion.
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-runner-multirepo-'));
  const legacyRoot = path.join(temp, 'legacy');
  const repoA = path.join(temp, 'repo-a');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(legacyRoot); mkdirSync(repoA);
  const taskId = 301;
  const cwdByTask = new Map();
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name:'multi-repo', tags:'[]' }),
    resolveWorkspace: () => legacyRoot,
    claimTask: () => ({ task:null, skill:null }),
    getTask: id => ({
      id, title:`Task ${id}`, status:'in_progress', tags:'[]',
      task_kind:'development.code', workflow_stage:'development', execution_mode:'git_change',
    }),
    getTaskState: id => ({ id, status:'review', assigned_to:null }),
    recoverAssignment: () => { throw new Error('recovery should not run'); },
    spawn: (_command, _args, options) => {
      const child = fakeChild(3000 + cwdByTask.size);
      const tid = Number(options.env.SAGA_TASK_ID);
      cwdByTask.set(tid, options.cwd);
      setTimeout(() => child.emit('close', 0), 10);
      return child;
    },
  });
  try {
    const assignment = fakeAssignment({
      taskId,
      workerId: 'w-301',
      repository: { id:1, repository_id:1, name:'repo-a', local_path:repoA, role:'component', integration_branch:'dev', default_branch:'main' },
    });
    runner.start({ projectId:10, concurrency:1, assignment });
    await waitFor(() => runner.status(10)?.status === 'completed');
    assert.equal(cwdByTask.get(301), repoA);
  } finally {
    runner.dispose();
    rmSync(temp, { recursive:true, force:true });
  }
});

// REMOVED CONTRACT (Slice 1, saga4, commit 49ac316): the former
// "launches one fresh Claude process per claimed task" test drove a 3-card
// queue through the pump-loop concurrency rotation (claimTask +
// `while (active.size < concurrency)`). That branch was deleted — the runner
// is one-card, and the dispatcher (src/app/dispatch-loop.ts) owns the
// concurrency budget + card selection. The multi-card spawn-count,
// maxLive=concurrency, and worker-id uniqueness assertions are therefore
// obsolete. The argv-shape portion of that test survives in the single-card
// test above. The dispatch-loop overlap invariant is tracked as Wave 4
// REAL-GAP #4 (see tests/dispatcher-race/parallel-concurrency.mjs).
