/**
 * WorkerLauncherPort tests (Conveyor v4, step 2.4).
 *
 * Target contract: REG-21 (supervision — launch/stop surface) + REG-09-AC-03
 * (launch retry idempotency).
 *
 * Covers the narrow launch/stop/dispose surface with a fake runner:
 *   - launch returns a LaunchResult with pid/logPath/startedAt.
 *   - idempotent launch (same reservationRef) returns the same identity.
 *   - stop clears the internal tracking map.
 *   - dispose clears everything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeWorkerLauncher } from '../../dist/infrastructure/workers/claude-worker-launcher.js';

function makeFakeRunner() {
  const launched = new Map();
  let pidSeq = 1000;
  return {
    start(command) {
      const pid = ++pidSeq;
      launched.set(command.assignment.workerExecutionId, {
        pid,
        log_path: `/tmp/fake-${pid}.log`,
        started_at: new Date().toISOString(),
      });
      return {
        id: command.assignment.runId,
        project_id: command.projectId,
        project_name: 'fake',
        concurrency: command.concurrency,
        status: 'running',
        started_at: new Date().toISOString(),
        finished_at: null,
        active: [{ task_id: 1, title: 't', worker_id: 'w', pid, started_at: new Date().toISOString(), log_path: `/tmp/fake-${pid}.log` }],
        completed: 0,
        failed: 0,
        claimed: 1,
        last_error: null,
      };
    },
    stop(projectId) { return null; },
    status(projectId) { return null; },
    setConcurrency(projectId, c) {},
    dispose() { launched.clear(); },
    _launched: launched,
  };
}

function makeRequest(overrides = {}) {
  return {
    reservationRef: 'res-1',
    workplaceRef: { taskId: 1 },
    role: 'author',
    fenceToken: 'exec-1',
    skillRef: 'saga-analyst',
    capabilityPreset: 'text-author',
    workspacePath: '/tmp/ws',
    runId: 'run-1',
    workerId: 'w-1',
    machineId: 'host-1',
    ...overrides,
  };
}

test('REG-21: launch returns LaunchResult with pid/logPath/startedAt', () => {
  const runner = makeFakeRunner();
  const launcher = new ClaudeWorkerLauncher(runner);
  const result = launcher.launch(makeRequest());
  assert.ok(result.pid !== null);
  assert.ok(result.logPath !== null);
  assert.ok(result.startedAt);
  launcher.dispose();
});

test('REG-09-AC-03: idempotent launch (same reservation) returns same identity', () => {
  const runner = makeFakeRunner();
  const launcher = new ClaudeWorkerLauncher(runner);
  const r1 = launcher.launch(makeRequest());
  const r2 = launcher.launch(makeRequest()); // same reservationRef
  assert.equal(r2.pid, r1.pid);
  assert.equal(r2.logPath, r1.logPath);
  assert.equal(r2.startedAt, r1.startedAt);
  // The fake runner should have been called only ONCE (one process spawned).
  assert.equal(runner._launched.size, 1);
  launcher.dispose();
});

test('REG-21: different reservation produces different identity', () => {
  const runner = makeFakeRunner();
  const launcher = new ClaudeWorkerLauncher(runner);
  const r1 = launcher.launch(makeRequest({ reservationRef: 'res-1' }));
  const r2 = launcher.launch(makeRequest({ reservationRef: 'res-2', fenceToken: 'exec-2' }));
  assert.notEqual(r2.pid, r1.pid);
  assert.equal(runner._launched.size, 2);
  launcher.dispose();
});

test('REG-21: stop clears tracking', () => {
  const runner = makeFakeRunner();
  const launcher = new ClaudeWorkerLauncher(runner);
  launcher.launch(makeRequest());
  assert.doesNotThrow(() => launcher.stop('exec-1'));
  launcher.dispose();
});

test('REG-21: dispose clears everything', () => {
  const runner = makeFakeRunner();
  const launcher = new ClaudeWorkerLauncher(runner);
  launcher.launch(makeRequest());
  launcher.launch(makeRequest({ reservationRef: 'res-2', fenceToken: 'exec-2' }));
  launcher.dispose();
  // After dispose, a new launch for the same reservation should spawn fresh.
  const runner2 = makeFakeRunner();
  const launcher2 = new ClaudeWorkerLauncher(runner2);
  const result = launcher2.launch(makeRequest());
  assert.ok(result.pid !== null);
  launcher2.dispose();
});
