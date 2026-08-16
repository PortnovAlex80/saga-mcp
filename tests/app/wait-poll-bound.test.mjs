// tests/app/wait-poll-bound.test.mjs
//
// FIX 2 (2026-08-16 incident, project 4) — bounded wait-poll. The engine
// spin-waited on one worker's completion poll ([wait-poll] task=187 polls=230
// durable=false) and a single stuck task froze the whole engine. The wait is
// now hard-bounded (max polls OR max wall time, whichever first) and the
// bound ESCALATES TO SUPERVISION instead of declaring anything dead.
//
// Coverage:
//   (e1) unit: the pure bound decision — polls/ms → wait vs escalate, with
//        the anti-spurious contract (a FRESH heartbeat never suppresses
//        escalation, because escalation is not a death declaration);
//   (e2) unit: env resolution SAGA_WAIT_POLL_MAX_POLLS / SAGA_WAIT_POLL_MAX_MS
//        with fail-closed fallback to the defaults;
//   (e3) integration: an exhausted wait returns 0, emits the typed EXHAUSTED
//        line, and does NOT dispose the executor (dispose would kill the
//        worker — an escalated worker is presumed alive);
//   (e4) integration: without the durable terminal probe the bound is not
//        applied (a pure in-memory drain has no supervision to defer to).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WAIT_POLL_MAX_MS,
  DEFAULT_WAIT_POLL_MAX_POLLS,
  decideWaitPollAction,
  distributeQueuedTasks,
  resolveWaitPollBounds,
} from '../../dist/app/dispatch-loop.js';

const BOUNDS = { maxPolls: 60, maxMs: 15 * 60 * 1000 };

test('(e1) decideWaitPollAction waits under both bounds', () => {
  assert.equal(decideWaitPollAction({
    polls: 59, elapsedMs: 14 * 60 * 1000, ...BOUNDS, workerHeartbeatFresh: true,
  }), 'wait');
  assert.equal(decideWaitPollAction({
    polls: 1, elapsedMs: 1_000, ...BOUNDS, workerHeartbeatFresh: false,
  }), 'wait', 'a stale heartbeat does not ACCELERATE the bound either');
});

test('(e1) decideWaitPollAction escalates on the poll bound', () => {
  assert.equal(decideWaitPollAction({
    polls: 60, elapsedMs: 30_000, ...BOUNDS, workerHeartbeatFresh: true,
  }), 'escalate');
});

test('(e1) decideWaitPollAction escalates on the wall-clock bound', () => {
  assert.equal(decideWaitPollAction({
    polls: 10, elapsedMs: 15 * 60 * 1000, ...BOUNDS, workerHeartbeatFresh: true,
  }), 'escalate');
});

test('(e1) anti-spurious: a FRESH heartbeat never suppresses escalation', () => {
  // durable=false for the whole window on a LIVE worker with a fresh
  // heartbeat is LEGITIMATE (one big LLM call). Escalation is still correct:
  // it only defers to supervision (which checks real liveness); it never
  // declares the worker dead.
  for (const workerHeartbeatFresh of [true, false]) {
    assert.equal(
      decideWaitPollAction({
        polls: 60, elapsedMs: 15 * 60 * 1000, ...BOUNDS, workerHeartbeatFresh,
      }),
      'escalate',
      `heartbeatFresh=${workerHeartbeatFresh} must not change the bound verdict`,
    );
  }
});

test('(e2) resolveWaitPollBounds defaults and env overrides (fail-closed)', () => {
  assert.deepEqual(resolveWaitPollBounds({}), {
    maxPolls: DEFAULT_WAIT_POLL_MAX_POLLS,
    maxMs: DEFAULT_WAIT_POLL_MAX_MS,
  });
  assert.equal(DEFAULT_WAIT_POLL_MAX_POLLS, 60);
  assert.equal(DEFAULT_WAIT_POLL_MAX_MS, 15 * 60 * 1000);

  assert.deepEqual(
    resolveWaitPollBounds({
      SAGA_WAIT_POLL_MAX_POLLS: '5',
      SAGA_WAIT_POLL_MAX_MS: '12345',
    }),
    { maxPolls: 5, maxMs: 12345 },
    'valid overrides apply',
  );

  for (const invalid of ['abc', '0', '-3', ' ']) {
    const bounds = resolveWaitPollBounds({ SAGA_WAIT_POLL_MAX_POLLS: invalid });
    assert.equal(
      bounds.maxPolls,
      DEFAULT_WAIT_POLL_MAX_POLLS,
      `invalid SAGA_WAIT_POLL_MAX_POLLS '${invalid}' fails closed to the default`,
    );
  }
  for (const invalid of ['abc', '0', '-1']) {
    const bounds = resolveWaitPollBounds({ SAGA_WAIT_POLL_MAX_MS: invalid });
    assert.equal(
      bounds.maxMs,
      DEFAULT_WAIT_POLL_MAX_MS,
      `invalid SAGA_WAIT_POLL_MAX_MS '${invalid}' fails closed to the default`,
    );
  }
});

// ---------------------------------------------------------------------------
// Integration fakes — the dispatch-loop-overlap.test.mjs shapes.
// ---------------------------------------------------------------------------

function makeIdGenerator() {
  let n = 0;
  return { newId: () => `id-${++n}`, newTypedId: prefix => `${prefix}-${++n}` };
}

function makeWorkAssignment(cardCount) {
  const queue = [];
  for (let i = 0; i < cardCount; i++) queue.push(1000 + i);
  return {
    assignTask({ workerId, workerExecutionId, runId, machineId }) {
      const taskId = queue.shift();
      if (taskId === undefined) return null;
      return {
        taskId, epicId: 7, projectId: 42, status: 'in_progress', skill: 'saga-worker',
        workerExecutionId, fenceToken: workerExecutionId, runId, workerId, machineId,
        repository: null, executionContext: null,
      };
    },
    countClaimable: () => queue.length,
    releaseAssignment: () => {},
  };
}

/**
 * Executor that stays "running" until externally finished; records dispose()
 * calls so the tests can prove an escalated worker is not killed/disposed.
 */
function makeHeldExecutorFactory() {
  const executors = [];
  const factory = () => {
    const executor = {
      disposed: 0,
      _finished: false,
      start() {
        return { id: 'run', project_id: 42, concurrency: 1, status: 'running', active: [], completed: 0, failed: 0, claimed: 1 };
      },
      stop() {},
      status() {
        return this._finished
          ? { id: 'run', project_id: 42, concurrency: 1, status: 'completed', active: [], completed: 1, failed: 0, claimed: 1 }
          : { id: 'run', project_id: 42, concurrency: 1, status: 'running', active: [], completed: 0, failed: 0, claimed: 1 };
      },
      setConcurrency() {},
      dispose() { this.disposed += 1; },
      finish() { this._finished = true; },
    };
    executors.push(executor);
    return executor;
  };
  return { factory, executors };
}

function makeDispatchInput(overrides) {
  const { factory, executors } = makeHeldExecutorFactory();
  const debugLines = [];
  const input = {
    projectId: 42,
    epicId: 7,
    readConcurrencyAdmission: () => ({
      operatorConcurrency: 1,
      modelConcurrencyLimit: 1,
      effectiveConcurrency: 1,
      activeExecutions: 0,
    }),
    workerExecutorFactory: factory,
    workAssignment: makeWorkAssignment(1),
    idGenerator: makeIdGenerator(),
    machineId: 'test-host',
    pollMs: 1,
    pollDebug: m => debugLines.push(m),
    factoryContext: {
      projectId: 42, epicId: 7, workspaceRoot: '/tmp/ws', dbPath: '/tmp/db.sqlite',
      sagaEntry: '/tmp/entry', sagaSkillRoot: '/tmp/skills', claudePath: 'node',
      lmStudioUrl: 'http://localhost:1234',
    },
    ...overrides,
  };
  return { input, executors, debugLines };
}

test('(e3) exhausted wait returns 0, logs EXHAUSTED, and does NOT dispose the executor', async () => {
  const { input, executors, debugLines } = makeDispatchInput({
    isExecutionDurableTerminal: () => false, // durable row never terminal
    waitPollMaxPolls: 3,
    waitPollMaxMs: 60_000,
  });
  const dispatched = await distributeQueuedTasks(input);
  assert.equal(dispatched, 0, 'escalation claims NO terminal count (lifecycle not failed)');
  assert.equal(executors.length, 1);
  assert.equal(executors[0].disposed, 0, 'escalated executor NOT disposed (worker may be alive)');
  assert.ok(
    debugLines.some(l => l.includes('EXHAUSTED task=1000 polls=3 — deferring to supervision')),
    `typed EXHAUSTED line emitted: ${debugLines.join(' | ')}`,
  );
});

test('(e4) without the durable terminal probe the bound is not applied', async () => {
  // A pure in-memory drain has no durable authority to defer to, so the
  // legacy unbounded in-memory wait is preserved for it.
  const { input, executors } = makeDispatchInput({
    waitPollMaxPolls: 2, // would fire after 2 polls if the bound applied
  });
  // Finish the worker after the would-be bound, proving the wait continued.
  setTimeout(() => { executors[0].finish(); }, 30);
  const dispatched = await distributeQueuedTasks(input);
  assert.equal(dispatched, 1, 'wait continued past the bound and resolved naturally');
  assert.equal(executors[0].disposed, 1, 'normal completion still disposes');
});

test('(e3-b) a durable terminal state resolves BEFORE the bound fires', async () => {
  const { input, executors } = makeDispatchInput({
    isExecutionDurableTerminal: () => true, // already terminal
    waitPollMaxPolls: 50,
    waitPollMaxMs: 60_000,
  });
  const dispatched = await distributeQueuedTasks(input);
  assert.equal(dispatched, 1, 'durable terminal resolves on the first poll');
  assert.equal(executors[0].disposed, 1, 'durable resolution still disposes');
});
