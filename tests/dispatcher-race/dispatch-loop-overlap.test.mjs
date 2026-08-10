// Wave 4 / REAL-GAP #4 — dispatch-loop overlap proof.
//
// Tests distributeQueuedTasks DIRECTLY with a fake WorkerExecutorFactory whose
// executors report controlled lifetimes. This replaces the two test.skip
// scenarios in parallel-concurrency.mjs that targeted the removed runner
// pump-loop concurrency (a contract that no longer exists).
//
// The three physical invariants Wave 4 requires:
//   N=2, >=2 cards available  → real temporal overlap (>=2 alive at once)
//   N=1, 2 cards              → strictly serial (maxAlive never exceeds 1)
//   for any N                 → maxAlive never exceeds N
//
// HOW THE FAKE CONTROLS TIMING:
// distributeQueuedTasks polls executor.status(projectId) every pollMs. Each
// fake executor is its own object; waitForAssignedWorker polls ITS OWN executor
// instance. So each fake independently decides when to flip to a terminal
// status. We keep them "running" until an external `finish()` is called, which
// lets us hold two workers alive simultaneously and prove genuine overlap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { distributeQueuedTasks } from '../../dist/app/dispatch-loop.js';

// ---------------------------------------------------------------------------
// Fake infra — IdGenerator, WorkAssignment, WorkerExecutorFactory.
// ---------------------------------------------------------------------------

/** Deterministic id generator so workerExecutionId/runId are stable per call. */
function makeIdGenerator() {
  let n = 0;
  return {
    newId: () => `id-${++n}`,
    newTypedId: (prefix) => `${prefix}-${++n}`,
  };
}

/**
 * In-memory WorkAssignmentPort. Hands out cards from a fixed pool, one per
 * assignTask call (FIFO). Returns null once the pool is empty so the dispatch
 * loop sees "queue exhausted". releaseAssignment is recorded but does not
 * re-queue (we test the happy path here; release-on-start-failure has its own
 * dedicated coverage in the assign-race suite).
 */
function makeWorkAssignment(cardCount) {
  const queue = [];
  for (let i = 0; i < cardCount; i++) queue.push(1000 + i); // taskIds 1000,1001,...
  const released = [];
  return {
    assignTask({ workerId, workerExecutionId, runId, machineId }) {
      const taskId = queue.shift();
      if (taskId === undefined) return null;
      return {
        taskId,
        epicId: 7,
        projectId: 42,
        status: 'in_progress',
        skill: 'saga-worker',
        workerExecutionId,
        fenceToken: workerExecutionId,
        runId,
        workerId,
        machineId,
        repository: null,
        executionContext: null,
      };
    },
    countClaimable: () => queue.length,
    releaseAssignment: ({ taskId, reason }) => {
      released.push({ taskId, reason });
    },
    _released: released,
  };
}

/**
 * Fake WorkerExecutorFactory. Each call returns a NEW executor that:
 *   - records start() immediately (used to measure alive windows), and
 *   - stays "running" until .finish() is called externally, after which
 *     status() returns a terminal snapshot (the dispatch loop then frees the
 *     slot and, if more cards remain, starts the next worker).
 *
 * The factory exposes a shared registry so the test can observe alive count
 * over time and drive completions in a controlled order.
 */
function makeFakeFactory() {
  const started = []; // { executor, taskName, startedAt, finishedAt|null }
  let maxAlive = 0;
  let aliveNow = 0;
  const all = []; // every executor created, in creation order

  const factory = (ctx) => {
    const executor = {
      _ctx: ctx,
      _finished: false,
      _startInput: null,
      start(input) {
        this._startInput = input;
        aliveNow += 1;
        if (aliveNow > maxAlive) maxAlive = aliveNow;
        const rec = { executor: this, taskName: `task-${input.assignment.taskId}`, startedAt: aliveNow, finishedAt: null };
        started.push(rec);
        all.push(rec);
        // Return a non-terminal snapshot. The dispatch loop ignores the
        // return value of start() for completion purposes; it polls status().
        return {
          id: `run-${input.assignment.taskId}`,
          project_id: input.projectId,
          concurrency: input.concurrency,
          status: 'running',
          active: [],
          completed: 0,
          failed: 0,
          claimed: 1,
        };
      },
      stop(projectId) { /* no-op for the fake */ },
      status(projectId) {
        if (this._finished) {
          return {
            id: `run-${this._startInput.assignment.taskId}`,
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
          id: `run-${this._startInput.assignment.taskId}`,
          project_id: projectId,
          concurrency: 1,
          status: 'running',
          active: [],
          completed: 0,
          failed: 0,
          claimed: 1,
        };
      },
      setConcurrency() { /* no-op */ },
      dispose() { /* no-op */ },
      // Test driver: flip this executor to terminal. The next status() poll by
      // waitForAssignedWorker returns 'completed' and the slot frees.
      finish() {
        if (this._finished) return;
        this._finished = true;
        aliveNow -= 1;
        const rec = all.find((r) => r.executor === this);
        if (rec) rec.finishedAt = started.length; // monotonic stamp
      },
    };
    return executor;
  };

  return { factory, started, get maxAlive() { return maxAlive; }, get aliveNow() { return aliveNow; }, all };
}

function makeInput({ concurrency, cardCount, pollMs = 5 }) {
  const idGen = makeIdGenerator();
  const workAssignment = makeWorkAssignment(cardCount);
  const fake = makeFakeFactory();
  const dispatchInput = {
    projectId: 42,
    epicId: 7,
    readConcurrencyAdmission: () => ({
      operatorConcurrency: concurrency,
      modelConcurrencyLimit: concurrency,
      effectiveConcurrency: concurrency,
      activeExecutions: fake.aliveNow,
    }),
    workerExecutorFactory: fake.factory,
    workAssignment,
    idGenerator: idGen,
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
  };
  return { dispatchInput, fake };
}

// ---------------------------------------------------------------------------
// TEST 1 — N=2 with >=2 cards produces real temporal overlap.
//
// Strategy: launch distributeQueuedTasks (don't await yet). After BOTH workers
// have started (the loop fills active to concurrency=2 before its first
// Promise.race), assert aliveNow >= 2 and maxAlive >= 2. Only then finish them.
// ---------------------------------------------------------------------------

test('dispatch-loop N=2 with 2 cards: two workers overlap in time', async () => {
  const { dispatchInput, fake } = makeInput({ concurrency: 2, cardCount: 2, pollMs: 3 });

  // Kick off the drain. It will fill active to 2, then Promise.race(active)
  // waits for a completion. We hold both workers alive so this await never
  // resolves until WE call finish().
  const drainPromise = distributeQueuedTasks(dispatchInput);

  // Wait until both workers have been started by the dispatch loop. The loop
  // claims+starts in a tight `while (active.size < concurrency)` loop, so both
  // start() calls happen in the SAME synchronous pass before the first poll.
  // Poll with small yields until we observe 2 starts (or time out).
  const deadline = Date.now() + 1000;
  while (fake.started.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(
    fake.started.length,
    2,
    `expected 2 workers started, got ${fake.started.length} — the loop should fill active to concurrency=2`,
  );

  // CORE INVARIANT — genuine temporal overlap. Both workers are alive right
  // now: neither has been finished, and both were started before either
  // completed. This is the physical proof Wave 4 requires.
  assert.equal(
    fake.aliveNow,
    2,
    `expected 2 alive workers during overlap, got ${fake.aliveNow}`,
  );
  assert.ok(
    fake.maxAlive >= 2,
    `maxAlive (${fake.maxAlive}) must reach >=2 to prove overlap at N=2`,
  );

  // Now release both. Order does not matter — finish them with a tiny gap so
  // the loop's Promise.race re-enters cleanly between completions.
  fake.started[0].executor.finish();
  // Yield once so the first completion is observed and active shrinks to 1.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fake.aliveNow, 1, 'after finishing one worker, exactly 1 should remain');
  fake.started[1].executor.finish();

  const terminal = await drainPromise;
  assert.equal(terminal, 2, `expected 2 terminal workers, got ${terminal}`);
  assert.equal(fake.aliveNow, 0, 'all workers should be finished after drain');
  assert.ok(
    fake.maxAlive <= 2,
    `maxAlive (${fake.maxAlive}) must never exceed concurrency=2`,
  );
});

// ---------------------------------------------------------------------------
// TEST 2 — N=1 with 2 cards is strictly serial.
//
// Strategy: with concurrency=1 the loop starts ONE worker, waits for it, then
// starts the next. We auto-finish each worker shortly after it starts. At no
// point can aliveNow exceed 1. To prove seriality we make the FIRST worker
// hold its slot briefly: if the loop were over-eager, a second would start
// before the first finished. We assert it does not.
// ---------------------------------------------------------------------------

test('dispatch-loop N=1 with 2 cards: never overlaps (strictly serial)', async () => {
  const { dispatchInput, fake } = makeInput({ concurrency: 1, cardCount: 2, pollMs: 3 });

  // Auto-finish each worker ~12ms after it starts. This is longer than the
  // poll interval, so if the loop incorrectly launched a 2nd worker while the
  // 1st was alive, we would observe maxAlive >= 2.
  const watchdog = setInterval(() => {
    for (const rec of fake.started) {
      if (!rec.executor._finished) rec.executor.finish();
    }
  }, 12);

  try {
    const terminal = await distributeQueuedTasks(dispatchInput);
    assert.equal(terminal, 2, `expected 2 terminal workers, got ${terminal}`);
  } finally {
    clearInterval(watchdog);
  }

  // CORE INVARIANT — strict seriality at N=1.
  assert.equal(
    fake.maxAlive,
    1,
    `concurrency=1 but maxAlive=${fake.maxAlive} — workers must never overlap at N=1`,
  );
  assert.equal(fake.aliveNow, 0, 'all workers finished after drain');
  // Both cards were processed.
  assert.equal(fake.started.length, 2, 'both cards should have been started');
});

// ---------------------------------------------------------------------------
// TEST 3 — maxAlive never exceeds N, at several N values with N+1 cards.
// A bounded-pool regression net: even under a fast finish watchdog, the
// concurrency ceiling holds.
// ---------------------------------------------------------------------------

test('dispatch-loop: maxAlive never exceeds concurrency for N in 1..4', async () => {
  for (const concurrency of [1, 2, 3, 4]) {
    const cardCount = concurrency + 1;
    const { dispatchInput, fake } = makeInput({ concurrency, cardCount, pollMs: 3 });

    const watchdog = setInterval(() => {
      for (const rec of fake.started) {
        if (!rec.executor._finished) rec.executor.finish();
      }
    }, 10);

    try {
      const terminal = await distributeQueuedTasks(dispatchInput);
      assert.equal(
        terminal,
        cardCount,
        `N=${concurrency}: expected ${cardCount} terminal workers, got ${terminal}`,
      );
      assert.ok(
        fake.maxAlive <= concurrency,
        `N=${concurrency}: maxAlive (${fake.maxAlive}) exceeded concurrency`,
      );
    } finally {
      clearInterval(watchdog);
    }
  }
});

test('dispatch-loop: lowering 3 to 2 is reread before the third assignment', async () => {
  const { dispatchInput, fake } = makeInput({ concurrency: 3, cardCount: 3, pollMs: 3 });
  let reads = 0;
  dispatchInput.readConcurrencyAdmission = () => {
    reads += 1;
    const limit = reads <= 2 ? 3 : 2;
    return {
      operatorConcurrency: limit,
      modelConcurrencyLimit: limit,
      effectiveConcurrency: limit,
      activeExecutions: fake.aliveNow,
    };
  };

  const drainPromise = distributeQueuedTasks(dispatchInput);
  const deadline = Date.now() + 1000;
  while (fake.started.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(fake.started.length, 2, 'the new cap must prevent a third immediate claim');
  assert.equal(fake.aliveNow, 2);

  fake.started[0].executor.finish();
  const replacementDeadline = Date.now() + 1000;
  while (fake.started.length < 3 && Date.now() < replacementDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(fake.started.length, 3, 'one replacement may start after active falls below 2');
  assert.ok(fake.maxAlive <= 2, `downshifted maxAlive was ${fake.maxAlive}`);
  fake.started[1].executor.finish();
  fake.started[2].executor.finish();
  assert.equal(await drainPromise, 3);
});

// ---------------------------------------------------------------------------
// TEST 4 — start failure releases the assignment (no fence leak).
//
// Wave 4 §4: "карточка уже assigned, а launcher упал до появления живого
// процесса." distributeQueuedTasks catches a start() throw, calls
// releaseAssignment, re-throws. We verify the card was released and the error
// propagates so the loop cannot strand an assigned-but-unlaunched card.
// ---------------------------------------------------------------------------

test('dispatch-loop: executor.start() failure releases the assignment and rethrows', async () => {
  const idGen = makeIdGenerator();
  const workAssignment = makeWorkAssignment(1);
  const released = workAssignment._released;

  // A factory whose executor.start() always throws (simulates spawn failure
  // before a live process exists).
  function failingFactory() {
    return {
      start() { throw new Error('spawn EAGAIN'); },
      stop() {},
      status: () => null,
      setConcurrency() {},
      dispose() {},
    };
  }

  const dispatchInput = {
    projectId: 42,
    epicId: 7,
    readConcurrencyAdmission: () => ({
      operatorConcurrency: 1,
      modelConcurrencyLimit: 1,
      effectiveConcurrency: 1,
      activeExecutions: 0,
    }),
    workerExecutorFactory: failingFactory,
    workAssignment,
    idGenerator: idGen,
    machineId: 'test-host',
    pollMs: 3,
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
  };

  await assert.rejects(
    () => distributeQueuedTasks(dispatchInput),
    /spawn EAGAIN/,
    'start failure must propagate',
  );
  assert.equal(
    released.length,
    1,
    `expected the assigned card to be released on start failure, got ${released.length} release(s)`,
  );
  assert.equal(released[0].taskId, 1000, 'the first card should have been released');
});

// ---------------------------------------------------------------------------
// TEST 5 — release-on-start-failure reason is auditable.
// Strengthens TEST 4: the release carries a human-readable reason mentioning
// the failure, satisfying Wave 4's "audit event" requirement.
// ---------------------------------------------------------------------------

test('dispatch-loop: start-failure release carries an audit reason', async () => {
  const idGen = makeIdGenerator();
  const workAssignment = makeWorkAssignment(1);
  const released = workAssignment._released;

  function failingFactory() {
    return {
      start() { throw new Error('ENOENT claude binary'); },
      stop() {},
      status: () => null,
      setConcurrency() {},
      dispose() {},
    };
  }

  const dispatchInput = {
    projectId: 42,
    epicId: 7,
    readConcurrencyAdmission: () => ({
      operatorConcurrency: 2,
      modelConcurrencyLimit: 2,
      effectiveConcurrency: 2,
      activeExecutions: 0,
    }),
    workerExecutorFactory: failingFactory,
    workAssignment,
    idGenerator: idGen,
    machineId: 'test-host',
    pollMs: 3,
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
  };

  await assert.rejects(() => distributeQueuedTasks(dispatchInput), /ENOENT/);
  assert.ok(released.length >= 1, 'at least one release must be recorded');
  const reason = released[0].reason;
  assert.ok(
    typeof reason === 'string' && reason.length > 0,
    'release reason must be a non-empty string',
  );
  assert.match(
    reason,
    /ENOENT claude binary/,
    'release reason must carry the original failure message for audit',
  );
});
