/**
 * D1 — Saga 3 Discovery engine mock E2E.
 *
 * No LM, no real worker spawn. A fake WorkerExecutor + fake
 * Saga3DiscoveryRuntimePersistence simulate the worker plane: when the engine
 * starts the executor and begins polling, the fake "runs the worker" by
 * recording a proposal and flipping the task to done.
 *
 * Covers the review's vertical-slice scenarios:
 *   1. Proposal appears before task done → engine keeps waiting (does NOT kill
 *      the worker between proposal_submit and worker_done).
 *   2. scopeCompleted is true for a valid proposal + terminal worker,
 *      independent of the business outcome (go vs clarify vs inconclusive).
 *   3. Task terminal without a proposal → honest incomplete (scopeCompleted=false).
 *   4. CAS: intent open → executing → concluded.
 *   5. Run result carries outcomeAuthority / proposalId / proposalHash.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const { Saga3DiscoveryEngine } = await import(
  '../../dist/engines/saga3-discovery-engine.js'
);

// --- fakes -----------------------------------------------------------------

/**
 * In-memory fake of Saga3DiscoveryRuntimePersistence. Records every mutation
 * so assertions can inspect the intent lifecycle and task transitions.
 */
function makeFakeRuntime({ proposalPayload, workerDelaysDone = true, workerReachesTerminal = true, finalTaskStatus = 'done' }) {
  const events = [];
  let intent = null;          // {id, kind, status, projected_task_id, ...}
  let task = null;            // {id, status}
  let ticksSeenProposal = 0;
  let proposal = null;        // ProposalRecord or null
  let nextId = 1;
  let taskId = 100;

  return {
    events,
    readEpicObjective(epicId) {
      return { name: `epic-${epicId}`, description: 'discover the idea' };
    },
    readOpenIntent(_epicId, kind) {
      return intent && intent.kind === kind && (intent.status === 'open' || intent.status === 'executing' || intent.status === 'paused') ? intent : null;
    },
    createIntent(command) {
      intent = { id: nextId++, epic_id: command.epic_id, kind: command.kind, objective: command.objective,
        authority_scope: command.authority_scope, output_schema: command.output_schema,
        projected_task_id: null, status: 'open', created_at: 't' };
      events.push(['createIntent', intent.id, intent.status]);
      return intent;
    },
    setProjectedTask(intentId, tid) {
      intent.projected_task_id = tid;
      events.push(['setProjectedTask', intentId, tid]);
    },
    setIntentStatus(intentId, expected, next) {
      if (intent && intent.id === intentId && intent.status === expected) {
        intent.status = next;
        events.push(['setIntentStatus', intentId, `${expected}->${next}`]);
        return true;
      }
      events.push(['setIntentStatus-CAS-FAIL', intentId, `${expected}->${next}`]);
      return false;
    },
    ensureProjectedTask(input) {
      if (!task) {
        task = { id: taskId++, status: 'todo' };
        events.push(['ensureProjectedTask-create', task.id]);
      } else {
        events.push(['ensureProjectedTask-reuse', task.id]);
      }
      return task.id;
    },
    readTaskState(tid) { return task && task.id === tid ? task.status : null; },
    prepareIntentForExecution(_intentId, tid) {
      if (!task || task.id !== tid) throw new Error('task missing');
      if (task.status === 'done') return { state: 'done', intentStatus: intent.status, taskStatus: 'done' };
      if (task.status === 'blocked') {
        if (intent.status === 'executing') intent.status = 'paused';
        return { state: 'blocked', intentStatus: 'paused', taskStatus: 'blocked', detail: 'blocked' };
      }
      if (task.status === 'in_progress') task.status = 'todo';
      if (task.status === 'review_in_progress') task.status = 'review';
      if (intent.status === 'executing') intent.status = 'paused';
      return { state: 'ready', intentStatus: intent.status, taskStatus: task.status };
    },
    readLatestProposal(_intentId) { return proposal; },

    // Worker-plane simulation hooks (not part of the port — test internals).
    _simulateWorkerTick() {
      // Called by the fake executor on each poll. First registers the proposal
      // (when a payload is configured); subsequent ticks flip the task to the
      // final status (simulating worker_done). When no payload is configured,
      // the worker still reaches the final status on its second tick (it bailed
      // without submitting).
      if (proposalPayload && !proposal) {
        proposal = {
          id: 1, intent_id: intent.id, task_id: task.id, execution_id: 'fake-exec',
          kind: 'discovery', schema_version: 'saga3.discovery-proposal.v1',
          payload: proposalPayload, content_hash: 'a'.repeat(64), status: 'submitted',
          provenance: null, created_at: 't',
        };
        events.push(['worker-submitted-proposal', proposal.id]);
        ticksSeenProposal = 1;
        if (!workerDelaysDone) {
          task.status = finalTaskStatus;
          events.push(['worker-terminal', task.id, finalTaskStatus]);
        }
        return;
      }
      // Second tick (or first tick when no proposal payload): reach terminal.
      if (workerReachesTerminal && task && task.status === 'todo') {
        const ready = proposal ? ticksSeenProposal >= 1 : true;
        if (ready) {
          task.status = finalTaskStatus;
          events.push(['worker-terminal', task.id, finalTaskStatus]);
        }
      }
      if (proposal) ticksSeenProposal += 1;
    },
  };
}

/**
 * Fake WorkerExecutor. `statusOverride` lets a scenario force the run into a
 * terminal state (failed/completed/stopped) with an optional active worker, to
 * exercise the lifecycle-closure logic. By default the run stays 'running'
 * with no active workers.
 */
function makeFakeExecutor(onPoll, callLog, statusOverride) {
  let stopped = false;
  let startCmd = null;
  return {
    start(cmd) { startCmd = cmd; callLog.push(['start', cmd]); },
    stop() { stopped = true; callLog.push(['stop']); },
    status() {
      // Each status poll is the engine's tick — simulate worker progress here.
      if (!stopped) onPoll();
      if (stopped) return null;
      if (statusOverride) return statusOverride;
      return { id: 'fake-run', project_id: 1, concurrency: 1, status: 'running', active: [], completed: 0, failed: 0, claimed: 1 };
    },
    setConcurrency() {},
    dispose() {},
    _startCmd: () => startCmd,
  };
}

function fakeHost() {
  const heartbeats = [];
  return {
    processId: 42,
    workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s' },
    now: () => new Date('2026-07-23T00:00:00.000Z'),
    sleep: async () => {},
    heartbeat: (_ctx, event, msg) => heartbeats.push([event, msg]),
    acquireEngineLock: () => ({ status: 'acquired', ownerPid: 42 }),
    releaseEngineLock: () => {},
    scanRateLimitSignals: () => 0,
    heartbeats,
  };
}

const fullConfig = () => ({
  dbPath: '/tmp/saga.db', claudePath: '/c', lmStudioUrl: 'http://lm:1234/v1',
  zaiBaseUrl: 'http://zai', trackerAutostart: false, trackerPort: 4321,
  trackerReloadSec: 5, trackerSpawned: false, trackerNoBrowser: true,
  orchestrationMode: 'saga3-discovery',
});

function validPayload(outcome) {
  return {
    problem_statement: 'p', observed_context: 'c', stakeholders_or_actors: [],
    assumptions: [], unknowns: [], risks: [], candidate_scope: 's',
    evidence_refs: [], recommended_outcome: outcome, rationale: 'r',
  };
}

// --- scenarios -------------------------------------------------------------

test('engine waits for worker_done after proposal; does not kill the worker (no executor.stop on clean exit)', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go'), workerDelaysDone: true });
  const execLog = [];
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick(), execLog);
  const host = fakeHost();
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host, runtimePersistence: runtime, pollMs: 0,
  });

  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });

  // The worker submitted a proposal, then (one tick later) reached done.
  assert.ok(runtime.events.some(([e]) => e === 'worker-submitted-proposal'), 'proposal was submitted');
  assert.ok(runtime.events.some(([e]) => e === 'worker-terminal'), 'worker reached a terminal status');
  // CRITICAL: on a clean (task_terminal) exit the engine must NOT call stop —
  // that would race the worker's worker_done. stop only runs on hard exit.
  assert.equal(execLog.some(([e]) => e === 'stop'), false,
    'engine must not stop() the substrate when the task reached done');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.outcome, 'go');
  assert.equal(result.outcomeAuthority, 'worker_proposal');
});

test('scopeCompleted is decoupled from business outcome: valid inconclusive + done worker still completes the scope', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('inconclusive'), workerDelaysDone: true });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick(), []);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });

  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  // Business outcome is inconclusive (worker couldn't decide), but the worker
  // reached done — the discovery SCOPE ran to completion.
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.scopeCompleted, true, 'valid proposal + terminal worker => scope complete regardless of business verdict');
});

test('task done without a proposal → honest incomplete (scopeCompleted=false, outcome=failed)', async () => {
  // Worker reaches 'done' but never submitted a proposal (bail / error). The
  // terminal verdict is 'clean' (task done, process gone), but scopeCompleted
  // is false because there is no valid proposal, and outcome is 'failed'.
  const runtime = makeFakeRuntime({ proposalPayload: null, finalTaskStatus: 'done' });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick(), []);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });

  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.scopeCompleted, false);
  assert.equal(result.outcome, 'failed');
});

test('CAS intent transitions: open → executing → concluded', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go'), workerDelaysDone: true });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick(), []);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });

  await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });

  const transitions = runtime.events.filter(([e]) => e === 'setIntentStatus').map(([, , t]) => t);
  assert.deepEqual(transitions, ['open->executing', 'executing->concluded'],
    'intent must move open → executing (after start) → concluded (after task terminal)');
});

test('run result carries provisional outcome authority + proposal provenance', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('reject'), workerDelaysDone: true });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick(), []);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });

  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.outcomeAuthority, 'worker_proposal');
  assert.equal(typeof result.proposalId, 'number');
  assert.match(result.proposalHash, /^[0-9a-f]+$/);
  assert.equal(result.pipelineScope, 'discovery_only');
});

test('engine does not call executor.stop on timeout when task already terminal (only on hard exit)', async () => {
  // Even in a timeout scenario, once the task is terminal the engine treats it
  // as a clean exit. This is the contract: stop() is reserved for hard reclaim.
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('clarify'), workerDelaysDone: false });
  const execLog = [];
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick(), execLog);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0, maxRunSeconds: 60,
  });

  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.scopeCompleted, true);
  assert.equal(execLog.some(([e]) => e === 'stop'), false, 'no stop on clean task-terminal exit');
});

// --- lifecycle-closure scenarios (terminal runner states w/o terminal task) ---
// These exercise the new poll-loop logic that does NOT wait 30min for a timeout
// when the substrate already gave up.

test('executor failed without terminal task → reason=failed, executor.stop() called, no 30min wait', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: null });
  // Run enters 'failed' immediately, task stays todo (spawn never succeeded).
  const failedRun = { id: 'r', project_id: 1, concurrency: 1, status: 'failed', active: [], completed: 0, failed: 1, claimed: 0 };
  const execLog = [];
  const executor = makeFakeExecutor(() => {}, execLog, failedRun);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0, maxRunSeconds: 60,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'failed');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.scopeCompleted, false);
  assert.ok(execLog.some(([e]) => e === 'stop'), 'hard exit must call executor.stop()');
  assert.match(result.lastError, /executor_failed|without clean worker closure/);
});

test('executor completed without worker_done (task unclaimed) → reason=failed, no 30min wait', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: null });
  // Run reaches 'completed' (pump drained) but the task never reached done —
  // the worker never claimed it. The engine must not wait for a timeout.
  const completedRun = { id: 'r', project_id: 1, concurrency: 1, status: 'completed', active: [], completed: 0, failed: 0, claimed: 0 };
  const execLog = [];
  const executor = makeFakeExecutor(() => {}, execLog, completedRun);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0, maxRunSeconds: 60,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'failed');
  assert.equal(result.scopeCompleted, false);
  assert.match(result.lastError, /task_unclaimed|without clean worker closure/);
});

test('executor status null (run vanished) → reason=failed, terminal=executor_dead', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: null });
  // status() returns null → run vanished (e.g. process died). No override.
  const executor = makeFakeExecutor(() => {}, [], null);
  // Force null return: override status after construction.
  executor.status = () => null;
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'failed');
  assert.match(result.lastError, /executor_dead|without clean worker closure/);
});

test('timeout → reason=paused_timeout (not completed), executor.stop() called', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: null });
  // Run stays 'running' forever; the worker never produces a proposal and never
  // reaches done. The engine must hit maxRunMs and exit paused_timeout.
  const execLog = [];
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => makeFakeExecutor(() => {}, execLog),
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0, maxRunSeconds: 0,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'paused_timeout');
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.scopeCompleted, false);
  assert.ok(execLog.some(([e]) => e === 'stop'), 'timeout must call executor.stop() to reclaim the worker');
});

test('clean closure requires the worker process to leave run.active (not just task done)', async () => {
  // worker_done flips task to done, but the claude process is still closing —
  // run.active still lists this task. The engine must keep waiting one more
  // tick until the process is gone, then exit clean.
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go'), workerDelaysDone: false });
  // Custom executor: first poll worker is active + task done; second poll
  // worker has left active.
  let pollCount = 0;
  const executor = {
    start(cmd) {}, stop() {},
    status() {
      pollCount += 1;
      runtime._simulateWorkerTick(); // marks proposal + (here) task done immediately
      const taskDone = runtime.readTaskState(runtime._taskId()) === 'done';
      const stillActive = taskDone && pollCount === 1; // process closing on tick 1
      return {
        id: 'r', project_id: 1, concurrency: 1, status: 'running',
        active: stillActive ? [{ task_id: runtime._taskId(), worker_id: 'w', pid: 1, started_at: 't' }] : [],
        completed: stillActive ? 0 : 1, failed: 0, claimed: 1,
      };
    },
    setConcurrency() {}, dispose() {},
  };
  // Expose task id helper on the runtime fake.
  runtime._taskId = () => runtime.events.find(([e]) => e === 'ensureProjectedTask-create')?.[1] ?? 100;
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.ok(pollCount >= 2, 'engine polled at least twice — waited for the process to leave run.active');
  assert.equal(result.reason, 'completed');
  assert.equal(result.scopeCompleted, true);
});

// --- blocked semantics (review P0): blocked is NOT a clean worker_done ---

test('blocked task + valid proposal + inactive worker → reason=failed, scopeCompleted=false', async () => {
  // The worker hit a blocker, the task went to 'blocked' (NOT 'done'), and the
  // process has left run.active. Even though a valid proposal exists, this is
  // NOT a clean closure: blocked means the work did not complete. The engine
  // must report reason=failed and scopeCompleted=false.
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go'), finalTaskStatus: 'blocked' });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick(), []);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'failed');
  assert.equal(result.scopeCompleted, false, 'blocked task must not count as a completed discovery scope');
  assert.match(result.lastError, /task_blocked/);
});

test('task done + run.status=failed + active=[] → reason=failed (runFailed checked before clean)', async () => {
  // The task reached 'done' but the run is in 'failed' state (substrate error).
  // runFailed must be checked BEFORE the clean-closure branch, otherwise the
  // substrate failure is masked as 'completed'. The onPoll advances the worker
  // (proposal + done); once the task is done, status() returns 'failed' with
  // empty active — the exact condition that would wrongly fire 'clean' if
  // runFailed were checked after the clean branch.
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go'), finalTaskStatus: 'done' });
  runtime._taskId = () => runtime.events.find(([e]) => e === 'ensureProjectedTask-create')?.[1] ?? null;
  let polls = 0;
  const executor = {
    start(cmd) {}, stop() {},
    status() {
      polls += 1;
      runtime._simulateWorkerTick();
      const tid = runtime._taskId();
      const taskDone = tid !== null && runtime.readTaskState(tid) === 'done';
      return {
        id: 'r', project_id: 1, concurrency: 1,
        status: taskDone ? 'failed' : 'running',
        active: [], completed: 0, failed: 1, claimed: 1,
      };
    },
    setConcurrency() {}, dispose() {},
  };
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0, maxRunSeconds: 5,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'failed', 'runFailed must win over clean when task=done + run.status=failed');
  assert.match(result.lastError, /executor_failed/);
});


test('non-clean executor failure pauses intent instead of concluding it', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go') });
  const failedRun = { id: 'r', project_id: 1, concurrency: 1, status: 'failed', active: [], completed: 0, failed: 1, claimed: 0 };
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => makeFakeExecutor(() => {}, [], failedRun),
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'failed');
  const transitions = runtime.events.filter(([e]) => e === 'setIntentStatus').map(([, , t]) => t);
  assert.deepEqual(transitions, ['open->executing', 'executing->paused']);
});

test('restart reuses paused intent and projected task, then concludes cleanly', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go') });
  const failedRun = { id: 'r1', project_id: 1, concurrency: 1, status: 'failed', active: [], completed: 0, failed: 1, claimed: 0 };
  const first = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => makeFakeExecutor(() => {}, [], failedRun),
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });
  await first.run({ projectId: 1, epicId: 10, concurrency: 1 });
  const secondExecutor = makeFakeExecutor(() => runtime._simulateWorkerTick(), []);
  const second = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => secondExecutor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
  });
  const result = await second.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'completed');
  assert.equal(runtime.events.filter(([e]) => e === 'createIntent').length, 1);
  assert.equal(runtime.events.filter(([e]) => e === 'ensureProjectedTask-create').length, 1);
  const transitions = runtime.events.filter(([e]) => e === 'setIntentStatus').map(([, , t]) => t);
  assert.ok(transitions.includes('paused->executing'));
  assert.ok(transitions.includes('executing->concluded'));
});
