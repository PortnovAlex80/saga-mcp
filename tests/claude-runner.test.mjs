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

test('board runner launches one fresh Claude process per claimed task', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-runner-test-'));
  const queue = [101, 102, 103];
  const states = new Map(queue.map(id => [id, { id, status:'todo', assigned_to:null }]));
  const spawns = [];
  let live = 0;
  let maxLive = 0;
  let pid = 1000;

  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name:'test-project', tags:'[]' }),
    resolveWorkspace: () => temp,
    claimTask: ({ worker_id }) => {
      const id = queue.shift();
      if (!id) return { task:null, skill:null };
      states.set(id, { id, status:'in_progress', assigned_to:worker_id });
      return {
        task: { id, title:`Task ${id}`, status:'todo', tags:'[]', description:'test' },
        skill:'saga-developer',
      };
    },
    getTaskState: id => states.get(id),
    recoverAssignment: () => {
      throw new Error('recovery should not run');
    },
    spawn: (command, args, options) => {
      const child = fakeChild(++pid);
      live += 1;
      maxLive = Math.max(maxLive, live);
      spawns.push({ command, args, options, child });
      setTimeout(() => {
        const taskId = Number(options.env.SAGA_TASK_ID);
        states.set(taskId, { id:taskId, status:'review', assigned_to:null });
        live -= 1;
        child.emit('close', 0);
      }, 20);
      return child;
    },
  });

  try {
    const initial = runner.start({ projectId:7, concurrency:2 });
    assert.equal(initial.concurrency, 2);
    await waitFor(() => runner.status(7)?.status === 'completed');

    const result = runner.status(7);
    assert.equal(result.claimed, 3);
    assert.equal(result.completed, 3);
    assert.equal(result.failed, 0);
    assert.equal(spawns.length, 3);
    assert.equal(maxLive, 2);
    assert.equal(new Set(spawns.map(call => call.options.env.SAGA_WORKER_ID)).size, 3);
    assert.deepEqual(
      spawns.map(call => Number(call.options.env.SAGA_TASK_ID)).sort(),
      [101, 102, 103],
    );
    for (const call of spawns) {
      assert.equal(call.command, 'claude');
      assert.ok(call.args.includes('--no-session-persistence'));
      assert.ok(call.args.includes('mcp__saga__worker_next'));
      assert.ok(call.args.includes('bypassPermissions'));
      assert.ok(call.args.includes('--dangerously-skip-permissions'));
      assert.equal(call.options.cwd, temp);
    }
  } finally {
    runner.dispose();
    rmSync(temp, { recursive:true, force:true });
  }
});

test('board runner completes without spawning when queue is empty', async () => {
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
    getTaskState: () => null,
    recoverAssignment: () => false,
    spawn: () => {
      spawnCount += 1;
      return fakeChild(1);
    },
  });

  try {
    runner.start({ projectId:8, concurrency:5 });
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
  let claimed = false;
  const recoveries = [];
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name:'failure', tags:'[]' }),
    resolveWorkspace: () => temp,
    claimTask: ({ worker_id }) => {
      if (claimed) return { task:null, skill:null };
      claimed = true;
      return {
        task: { id:201, title:'Failing task', status:'todo', tags:'[]' },
        skill:'saga-developer',
        worker_id,
      };
    },
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
    runner.start({ projectId:9, concurrency:1 });
    await waitFor(() => runner.status(9)?.status === 'failed');
    assert.equal(runner.status(9).failed, 1);
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0].taskId, 201);
  } finally {
    runner.dispose();
    rmSync(temp, { recursive:true, force:true });
  }
});

test('board runner launches each typed task in its repository checkout', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-runner-multirepo-'));
  const legacyRoot = path.join(temp, 'legacy');
  const repoA = path.join(temp, 'repo-a');
  const repoB = path.join(temp, 'repo-b');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(legacyRoot); mkdirSync(repoA); mkdirSync(repoB);
  const queue = [
    { id:301, repo:{ id:1, name:'repo-a', local_path:repoA } },
    { id:302, repo:{ id:2, name:'repo-b', local_path:repoB } },
  ];
  const states = new Map();
  const cwdByTask = new Map();
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name:'multi-repo', tags:'[]' }),
    resolveWorkspace: () => legacyRoot,
    claimTask: ({ worker_id }) => {
      const next = queue.shift();
      if (!next) return { task:null, skill:null };
      states.set(next.id, { id:next.id, status:'in_progress', assigned_to:worker_id });
      return {
        task: {
          id:next.id, title:`Task ${next.id}`, status:'todo', tags:'[]',
          task_kind:'development.code', workflow_stage:'development', execution_mode:'git_change',
        },
        skill:'saga-developer',
        repository:next.repo,
      };
    },
    getTaskState: id => states.get(id),
    recoverAssignment: () => { throw new Error('recovery should not run'); },
    spawn: (_command, _args, options) => {
      const child = fakeChild(3000 + cwdByTask.size);
      const taskId = Number(options.env.SAGA_TASK_ID);
      cwdByTask.set(taskId, options.cwd);
      setTimeout(() => {
        states.set(taskId, { id:taskId, status:'review', assigned_to:null });
        child.emit('close', 0);
      }, 10);
      return child;
    },
  });
  try {
    runner.start({ projectId:10, concurrency:2 });
    await waitFor(() => runner.status(10)?.status === 'completed');
    assert.equal(cwdByTask.get(301), repoA);
    assert.equal(cwdByTask.get(302), repoB);
  } finally {
    runner.dispose();
    rmSync(temp, { recursive:true, force:true });
  }
});
