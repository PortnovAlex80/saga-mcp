import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  child.stdin = new PassThrough();
  child.prompt = '';
  child.stdin.on('data', chunk => { child.prompt += chunk.toString('utf8'); });
  child.kill = () => true;
  return child;
}

function makeHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  const skills = path.join(root, 'package', 'skills');
  const protocolPath = path.join(skills, 'protocol', 'SKILL.md');
  const authorPath = path.join(skills, 'author', 'SKILL.md');
  const reviewerPath = path.join(skills, 'reviewer', 'SKILL.md');
  for (const file of [protocolPath, authorPath, reviewerPath]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `instructions:${path.basename(path.dirname(file))}`, 'utf8');
  }
  const spawns = [];
  const executionEvents = [];
  const task = {
    id: 101, title: 'Build target', status: 'in_progress', tags: '[]', description: 'test',
    task_kind: 'factory.author', workflow_stage: 'development', execution_mode: 'git_change',
  };
  const profile = {
    protocolSkill: 'protocol', semanticSkill: 'author', reviewSkill: 'reviewer',
  };
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(root, 'saga.db'), sagaEntry: path.join(root, 'index.js'),
    sagaSkillRoot: path.join(root, 'unused'), logRoot: path.join(root, 'logs'),
    getProject: id => ({ id, name: 'target-project', tags: '[]' }),
    resolveWorkspace: () => root, getTask: () => task,
    getTaskState: () => ({ id: task.id, status: 'review', assigned_to: null }),
    recoverAssignment: event => executionEvents.push(['recover', event]),
    resolveProfile: () => ({ profile }),
    resolveLaunchSpec: () => ({
      installationId: 77, role: profile, allowedToolIds: ['Read', 'Edit'],
      strictResources: true,
      resolveSkill: name => ({ protocol: protocolPath, author: authorPath, reviewer: reviewerPath })[name] ?? null,
    }),
    executionStore: {
      markExited: (...args) => executionEvents.push(['exited', args]),
      markProgress: () => {}, markRunning: (...args) => executionEvents.push(['running', args]),
      markSpawnFailed: (...args) => executionEvents.push(['spawn-failed', args]),
      readBirthToken: () => 'birth-token',
    },
    spawn: (command, args, options) => {
      const child = fakeChild(1001);
      spawns.push({ command, args, options, child });
      setTimeout(() => child.emit('close', 0), 20);
      return child;
    },
  });
  const assignment = {
    taskId: task.id, epicId: 1, projectId: 7, status: 'in_progress', skill: 'author',
    workerExecutionId: 'exec-101', fenceToken: 'fence-101', runId: 'run-101',
    workerId: 'worker-101', machineId: 'test-host',
    repository: { name: 'product', local_path: root },
    executionContext: {
      policy_version: 'factory.execution.v1', authority: { enforcement: 'strict', allowed_saga_tools: ['task_get', 'worker_done'] },
      model_route: { provider: 'zai', model: null, effort: 'high' }, captured_at: new Date().toISOString(),
    },
  };
  return { root, runner, assignment, spawns, executionEvents };
}

test('runner rejects any launch that is not preassigned and fenced', () => {
  const h = makeHarness();
  try {
    assert.throws(() => h.runner.start({ projectId: 7, concurrency: 1 }), /PREASSIGNED_WORK_REQUIRED/);
  } finally { h.runner.dispose(); rmSync(h.root, { recursive: true, force: true }); }
});

test('runner launches one frozen card with pinned skills, tools, repository and execution identity', async () => {
  const h = makeHarness();
  try {
    h.runner.start({ projectId: 7, epicId: 1, concurrency: 1, assignment: h.assignment });
    await waitFor(() => h.runner.status(7)?.status === 'completed');
    assert.equal(h.spawns.length, 1);
    const call = h.spawns[0];
    assert.equal(call.options.cwd, h.root);
    assert.equal(call.options.env.SAGA_EXECUTION_ID, 'exec-101');
    const prompt = call.child.prompt;
    assert.match(prompt, /instructions:protocol/);
    assert.match(prompt, /instructions:author/);
    assert.match(prompt, /launch_spec_installation=77/);
    const allowed = call.args[call.args.indexOf('--allowedTools') + 1];
    assert.match(allowed, /Read/);
    assert.match(allowed, /Edit/);
    assert.match(allowed, /mcp__saga__task_get/);
    const disallowed = call.args[call.args.indexOf('--disallowedTools') + 1];
    assert.match(disallowed, /mcp__saga__worker_next/);
    assert.match(disallowed, /Bash/);
    assert.match(disallowed, /Write/);
    assert.match(disallowed, /MultiEdit/);
    assert.match(disallowed, /Task/);
    assert.doesNotMatch(disallowed, /(?:^|,)Read(?:,|$)/);
    assert.doesNotMatch(disallowed, /(?:^|,)Edit(?:,|$)/);
    assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
    assert.doesNotMatch(prompt, /bash -c/);
    assert.match(prompt, /Runtime owns the operator heartbeat/);
    const runnerSource = readFileSync(
      new URL('../tracker-view/claude-runner.mjs', import.meta.url),
      'utf8',
    );
    assert.match(runnerSource, /tracker is runtime-owned for this read-only profile/);
    assert.match(runnerSource, /modelMayUpdateTracker/);
    assert.ok(h.executionEvents.some(([event]) => event === 'running'));
    assert.ok(h.executionEvents.some(([event]) => event === 'exited'));
  } finally { h.runner.dispose(); rmSync(h.root, { recursive: true, force: true }); }
});

test('runner starts a repository task in the exact Factory-provisioned desk', async () => {
  const h = makeHarness();
  const desk = path.join(h.root, '.worktrees', 'task-101');
  mkdirSync(desk, { recursive: true });
  h.runner.prepareWorkspace = () => ({
    repositoryDesk: {
      executionPath: desk,
      repositoryRoot: h.root,
      role: 'author',
      git: { branch: 'task/101', baseCommit: 'base', integrationBranch: 'dev', detached: false },
    },
  });
  try {
    h.runner.start({ projectId: 7, epicId: 1, concurrency: 1, assignment: h.assignment });
    await waitFor(() => h.runner.status(7)?.status === 'completed');
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].options.cwd, desk);
  } finally { h.runner.dispose(); rmSync(h.root, { recursive: true, force: true }); }
});
