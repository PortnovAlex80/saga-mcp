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
function makeFakeRuntime({ proposalPayload, workerDelaysDone = true, workerReachesTerminal = true }) {
  const events = [];
  let intent = null;          // {id, kind, status, projected_task_id, ...}
  let task = null;            // {id, status}
  let proposal = null;        // ProposalRecord or null
  let nextId = 1;
  let taskId = 100;

  return {
    events,
    readEpicObjective(epicId) {
      return { name: `epic-${epicId}`, description: 'discover the idea' };
    },
    readOpenIntent(_epicId, kind) {
      return intent && intent.kind === kind && (intent.status === 'open' || intent.status === 'executing') ? intent : null;
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
    readLatestProposal(_intentId) { return proposal; },

    // Worker-plane simulation hooks (not part of the port — test internals).
    _simulateWorkerTick() {
      // Called by the fake executor on each poll. First registers the proposal;
      // subsequent ticks flip the task to done (simulating worker_done).
      if (proposalPayload && !proposal) {
        proposal = {
          id: 1, intent_id: intent.id, task_id: task.id, execution_id: 'fake-exec',
          kind: 'discovery', schema_version: 'saga3.discovery-proposal.v1',
          payload: proposalPayload, content_hash: 'a'.repeat(64), status: 'submitted',
          provenance: null, created_at: 't',
        };
        events.push(['worker-submitted-proposal', proposal.id]);
        if (!workerDelaysDone) {
          task.status = 'done';
          events.push(['worker-done', task.id]);
        }
      } else if (workerReachesTerminal && proposal && task.status !== 'done') {
        task.status = 'done';
        events.push(['worker-done', task.id]);
      }
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
  assert.ok(runtime.events.some(([e]) => e === 'worker-done'), 'worker reached done');
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

test('task terminal without a proposal → honest incomplete (scopeCompleted=false, outcome=failed)', async () => {
  const runtime = makeFakeRuntime({ proposalPayload: null });
  // Force the worker to finish with no proposal: flip task to done without ever
  // submitting. Override the simulate hook.
  runtime._simulateWorkerTick = function () {
    if (runtime.events.every(([e]) => e !== 'worker-done')) {
      // reach into the closure's task via ensureProjectedTask side effect
      const tid = runtime.ensureProjectedTask({ epicId: 10, projectId: 1, intentId: 1, objective: 'o', taskKind: 'discovery.work', executionSkill: 'saga-discovery-worker', generationKey: 'k' });
      runtime.readTaskState; // noop
      // flip the task done directly through a re-read trick: use readTaskState
      // path by marking done via a custom field
      this._forceDone = true;
    }
  };
  // Simpler: just make the fake task done immediately on first poll, no proposal.
  const rt2 = makeFakeRuntime({ proposalPayload: null });
  rt2._simulateWorkerTick = function () {
    if (!this._done) {
      // The engine created task via ensureProjectedTask on a prior readEpic? No —
      // ensureProjectedTask runs during runDiscovery. Simulate by setting an
      // internal done flag the readTaskState will honour.
      this._done = true;
    }
  };
  // Patch readTaskState to report done after the first tick.
  let tickCount = 0;
  const origReadTask = rt2.readTaskState.bind(rt2);
  rt2.readTaskState = (tid) => { tickCount += 1; return tickCount > 1 ? 'done' : origReadTask(tid); };
  const executor = makeFakeExecutor(() => rt2._simulateWorkerTick(), []);
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: rt2, pollMs: 0,
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
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => makeFakeExecutor(() => {}, []),
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0, maxRunSeconds: 0,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.reason, 'paused_timeout');
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.scopeCompleted, false);
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
