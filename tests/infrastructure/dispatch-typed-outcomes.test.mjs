// Plan item 19 — typed dispatch outcomes: dispatch fatality granularity.
//
// W2 diagnosis (docs/testing/W2-SPEED-AND-RECOVERY-ARCHITECTURE-ANALYSIS.md):
// "13 recovery mechanisms, and all of them treat executor death — none treat
// owner death." The engine used to die entirely (exit 1) when ONE card threw
// a recoverable error at dispatch time (the live symptom was
// REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS escaping bindReplayToClaim through
// assignTask and killing orchestrate-cli).
//
// After item 19, distributeQueuedTasks converts recoverable per-card failures
// into a `card_error` typed outcome: log, release, poison the card for the
// rest of the drain, continue with the next card. Only provably engine-wide
// failures (authority/policy binding, DB) still throw.
//
// The WorkAssignmentPort mocks below mirror the REAL adapter contract
// (src/infrastructure/work/sqlite-work-assignment-adapter.ts):
//   - a per-card assignTask failure is released BEFORE the rethrow, and the
//     rethrown error carries `taskId` (the adapter annotates it);
//   - `excludeTaskIds` on subsequent calls must be respected, because the
//     production claim SQL has a deterministic priority order that would
//     otherwise re-serve the same broken card forever.
import assert from 'node:assert/strict';
import test from 'node:test';
import { distributeQueuedTasks } from '../../dist/app/dispatch-loop.js';

// ---------------------------------------------------------------------------
// Fake infrastructure (IdGenerator, WorkAssignmentPort, WorkerExecutorFactory)
// ---------------------------------------------------------------------------

function makeIdGenerator() {
  let n = 0;
  return {
    newId: () => `id-${++n}`,
    newTypedId: (prefix) => `${prefix}-${++n}`,
  };
}

/**
 * WorkAssignmentPort double that mirrors the real adapter semantics:
 * - respects `excludeTaskIds` when selecting the next card (poison guard);
 * - broken cards throw an adapter-style annotated error AFTER recording the
 *   release (the real adapter releases the reservation before rethrowing);
 * - healthy cards are handed out once and never re-queued.
 */
function makeWorkAssignment({ taskIds, brokenTaskIds = new Set() }) {
  const queue = [...taskIds];
  const calls = [];
  const released = [];
  const adapterReleases = [];
  return {
    calls,
    released,
    adapterReleases,
    assignTask(input) {
      const exclude = new Set(input.excludeTaskIds ?? []);
      calls.push({ excludeTaskIds: input.excludeTaskIds });
      const index = queue.findIndex((id) => !exclude.has(id));
      if (index === -1) return null;
      const taskId = queue[index];
      if (brokenTaskIds.has(taskId)) {
        // Real adapter: release the reservation, then rethrow annotated.
        adapterReleases.push({
          taskId,
          reason: `AssignedWork build failed: REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS (task ${taskId})`,
        });
        const error = new Error(
          `REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS: 3 capsules share replay_key task-${taskId}`,
        );
        error.taskId = taskId;
        throw error;
      }
      queue.splice(index, 1);
      return {
        taskId,
        epicId: 7,
        projectId: 42,
        status: 'in_progress',
        skill: 'saga-worker',
        workerExecutionId: input.workerExecutionId,
        fenceToken: input.workerExecutionId,
        runId: input.runId,
        workerId: input.workerId,
        machineId: input.machineId,
        repository: null,
        executionContext: null,
      };
    },
    countClaimable: () => queue.length,
    releaseAssignment: ({ taskId, reason }) => {
      released.push({ taskId, reason });
    },
  };
}

/**
 * Executor factory double. `startFailures` maps taskId -> Error thrown from
 * start() (spawn path). Healthy executors stay running until the test
 * watchdog finishes them, mirroring a real worker process lifetime.
 */
function makeFakeFactory() {
  const started = []; // { taskId, executor }
  let aliveNow = 0;
  const factory = (startFailures) => (ctx) => {
    const executor = {
      _ctx: ctx,
      _taskId: null,
      _finished: false,
      start(input) {
        this._taskId = Number(input.assignment.taskId);
        const failure = startFailures?.get(this._taskId);
        if (failure) throw failure;
        started.push({ taskId: this._taskId, executor: this });
        aliveNow += 1;
        return null;
      },
      stop() {},
      status(projectId) {
        if (this._finished) {
          return {
            id: `run-${this._taskId}`,
            project_id: projectId,
            concurrency: 1,
            status: 'completed',
            active: [],
            completed: 1,
            failed: 0,
            claimed: 1,
          };
        }
        return {
          id: `run-${this._taskId}`,
          project_id: projectId,
          concurrency: 1,
          status: 'running',
          active: [],
          completed: 0,
          failed: 0,
          claimed: 1,
        };
      },
      setConcurrency() {},
      dispose() {},
      finish() {
        if (this._finished) return;
        this._finished = true;
        aliveNow -= 1;
      },
    };
    return executor;
  };
  return {
    factory,
    started,
    get aliveNow() { return aliveNow; },
  };
}

function makeDispatchInput({ workAssignment, startFailures = null, pollMs = 3 }) {
  const fake = makeFakeFactory();
  return {
    dispatchInput: {
      projectId: 42,
      epicId: 7,
      readConcurrencyAdmission: () => ({
        operatorConcurrency: 3,
        modelConcurrencyLimit: 3,
        effectiveConcurrency: 3,
        activeExecutions: fake.aliveNow,
      }),
      workerExecutorFactory: fake.factory(startFailures),
      workAssignment,
      idGenerator: makeIdGenerator(),
      machineId: 'test-host',
      pollMs,
      factoryContext: {
        projectId: 42,
        epicId: 7,
        workspaceRoot: '/tmp/ws',
        dbPath: '/tmp/db.sqlite',
        sagaEntry: '/tmp/entry',
        sagaSkillRoot: '/tmp/skills',
        claudePath: 'node',
        lmStudioUrl: 'http://localhost:1234',
      },
    },
    fake,
  };
}

/** Auto-finish every running executor — drives healthy workers terminal. */
function autoFinishWatchdog(fake) {
  return setInterval(() => {
    for (const rec of fake.started) {
      if (!rec.executor._finished) rec.executor.finish();
    }
  }, 8);
}

// ---------------------------------------------------------------------------
// SCENARIO 1 — one broken card among three: the engine survives and drains
// the healthy ones.
//
// Cards 1000/1002 dispatch and complete; card 1001 throws the live-incident
// error (REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS, annotated by the adapter). The
// drain must NOT die, must NOT dispatch an executor for 1001, and must pass
// excludeTaskIds=[1001] on every subsequent assignment attempt.
// ---------------------------------------------------------------------------

test('card_error on the middle card: drain dispatches 1st and 3rd, skips the broken one, does not die', async () => {
  const workAssignment = makeWorkAssignment({
    taskIds: [1000, 1001, 1002],
    brokenTaskIds: new Set([1001]),
  });
  const { dispatchInput, fake } = makeDispatchInput({ workAssignment });
  const watchdog = autoFinishWatchdog(fake);

  try {
    const terminal = await distributeQueuedTasks(dispatchInput);
    // THE invariant of item 19: the two healthy cards completed, the loop
    // never died, the broken card consumed no executor.
    assert.equal(terminal, 2, 'cards 1000 and 1002 must reach terminal state');
    const startedIds = fake.started.map((rec) => rec.taskId).sort((a, b) => a - b);
    assert.deepEqual(startedIds, [1000, 1002], 'no executor may be spawned for the broken card');
    // The adapter-side release happened for the broken card (fence not leaked).
    assert.equal(workAssignment.adapterReleases.length, 1);
    assert.equal(workAssignment.adapterReleases[0].taskId, 1001);
    // Every assignment attempt AFTER the failed one excludes the poisoned
    // card (the failed call itself is calls[1]).
    const afterFailure = workAssignment.calls.slice(2);
    assert.ok(afterFailure.length >= 1, 'assignment must be retried after a card_error');
    for (const call of afterFailure) {
      assert.ok(
        Array.isArray(call.excludeTaskIds) && call.excludeTaskIds.includes(1001),
        `retry call must exclude the poisoned card 1001, got ${JSON.stringify(call.excludeTaskIds)}`,
      );
    }
  } finally {
    clearInterval(watchdog);
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 2 — all cards broken: dispatched=0, no throw. This is exactly the
// precondition the orchestrate-cli emptyDispatchStreak logic needs to exit
// the engine GRACEFULLY (exit 2, paused) instead of a fatal exit 1.
// ---------------------------------------------------------------------------

test('all cards broken: drain returns 0 without throwing (emptyDispatchStreak precondition)', async () => {
  const workAssignment = makeWorkAssignment({
    taskIds: [1000, 1001, 1002],
    brokenTaskIds: new Set([1000, 1001, 1002]),
  });
  const { dispatchInput, fake } = makeDispatchInput({ workAssignment });
  const watchdog = autoFinishWatchdog(fake);

  try {
    const terminal = await distributeQueuedTasks(dispatchInput);
    assert.equal(terminal, 0, 'no card may reach a terminal worker state');
    assert.equal(fake.started.length, 0, 'no executor may be spawned');
    // Three poisoned attempts + one final probe that sees only excluded cards.
    assert.equal(workAssignment.calls.length, 4);
    // All three reservations were released by the adapter before rethrowing.
    const releasedIds = workAssignment.adapterReleases.map((r) => r.taskId).sort((a, b) => a - b);
    assert.deepEqual(releasedIds, [1000, 1001, 1002]);
    // The last probe excluded everything — the queue is effectively empty.
    const lastCall = workAssignment.calls[workAssignment.calls.length - 1];
    assert.deepEqual(lastCall.excludeTaskIds, [1000, 1001, 1002]);
  } finally {
    clearInterval(watchdog);
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 3 — fatal classification still kills the engine.
// AUTHORITY_BINDING_INVALID is an authority/policy defect (ADR-053 territory:
// fail closed), not a per-card recoverable failure: it must propagate.
// ---------------------------------------------------------------------------

test('fatal policy error still propagates and kills the drain', async () => {
  const workAssignment = makeWorkAssignment({ taskIds: [1000, 1001, 1002] });
  workAssignment.assignTask = () => {
    throw new Error(
      'AUTHORITY_BINDING_INVALID: WorkIntent 17 projected_task_id 999 != task 1000',
    );
  };
  const { dispatchInput } = makeDispatchInput({ workAssignment });

  await assert.rejects(
    () => distributeQueuedTasks(dispatchInput),
    /AUTHORITY_BINDING_INVALID/,
    'authority/policy failures must stay fatal (fail-closed default)',
  );
});

// ---------------------------------------------------------------------------
// SCENARIO 4 — recoverable SPAWN failure on the middle card (executor path,
// not assignTask path): release with audit reason, other cards still drain.
// ---------------------------------------------------------------------------

test('recoverable spawn failure on one card: release with audit reason, other cards still drain', async () => {
  const workAssignment = makeWorkAssignment({ taskIds: [1000, 1001, 1002] });
  const startFailures = new Map();
  const spawnError = new Error('spawn worker EAGAIN');
  spawnError.code = 'EAGAIN';
  startFailures.set(1001, spawnError);

  const { dispatchInput, fake } = makeDispatchInput({ workAssignment, startFailures });
  const watchdog = autoFinishWatchdog(fake);

  try {
    const terminal = await distributeQueuedTasks(dispatchInput);
    assert.equal(terminal, 2, 'the two healthy cards must complete');
    const startedIds = fake.started.map((rec) => rec.taskId).sort((a, b) => a - b);
    assert.deepEqual(startedIds, [1000, 1002]);
    // The dispatcher released the assigned-but-unlaunched card with the
    // auditable reason (Wave 4 contract, kept by item 19).
    assert.equal(workAssignment.released.length, 1);
    assert.equal(workAssignment.released[0].taskId, 1001);
    assert.match(
      workAssignment.released[0].reason,
      /Worker start failed before supervision: .*EAGAIN/,
    );
    // And poisoned it for the rest of the drain (failed call is calls[1]).
    const afterFailure = workAssignment.calls.slice(2);
    for (const call of afterFailure) {
      assert.ok(
        Array.isArray(call.excludeTaskIds) && call.excludeTaskIds.includes(1001),
        `retry must exclude poisoned card 1001, got ${JSON.stringify(call.excludeTaskIds)}`,
      );
    }
  } finally {
    clearInterval(watchdog);
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 5 — safety valve for recoverable errors WITHOUT card identity.
// The drain stops after a bounded number of unresolved card errors instead
// of spinning forever on the deterministic queue order.
// ---------------------------------------------------------------------------

test('unresolvable card errors stop the drain after a bounded number of spins', async () => {
  let attempts = 0;
  const workAssignment = {
    assignTask() {
      attempts += 1;
      // No taskId annotation — dispatch cannot poison what it cannot identify.
      throw new Error('REPLAY_CERTIFICATION_INVALID: assessment_candidate_set_refs is not JSON');
    },
    countClaimable: () => 3,
    releaseAssignment: () => {},
  };
  const { dispatchInput } = makeDispatchInput({ workAssignment });

  const terminal = await distributeQueuedTasks(dispatchInput);
  assert.equal(terminal, 0);
  assert.ok(
    attempts >= 2 && attempts <= 50,
    `the drain must retry a bounded number of times, got ${attempts}`,
  );
});
