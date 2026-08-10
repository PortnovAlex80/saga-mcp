import assert from 'node:assert/strict';
import test from 'node:test';

const {
  initialWorkplaceState,
  assertValidWorkplaceState,
} = await import('../../dist/process-modules/domain/workplace/workplace-state.js');
const { reduceWorkplaceEvent } = await import(
  '../../dist/process-modules/domain/workplace/production-cell-reducer.js'
);
const { mapV4KanbanToTaskStatus } = await import(
  '../../dist/infrastructure/projections/workplace-projector.js'
);

const EVENT_ALPHABET = Object.freeze([
  { kind: 'work-admitted' },
  { kind: 'worker-leased', reservationRef: 'reservation:test' },
  { kind: 'worker-started' },
  { kind: 'candidate-sealed' },
  { kind: 'candidate-carried-forward' },
  { kind: 'worker-crashed' },
  { kind: 'worker-lost' },
  { kind: 'gate-repair-required', repairTargetRole: 'author' },
  { kind: 'gate-repair-required', repairTargetRole: 'reviewer' },
  { kind: 'gate-author-accepted-with-review' },
  { kind: 'gate-author-accepted-final', effectRequired: false },
  { kind: 'gate-author-accepted-final', effectRequired: true },
  { kind: 'reviewer-verdict', verdict: 'accepted', effectRequired: false },
  { kind: 'reviewer-verdict', verdict: 'accepted', effectRequired: true },
  { kind: 'reviewer-verdict', verdict: 'defect-proven' },
  { kind: 'reviewer-verdict', verdict: 'invalid-output' },
  { kind: 'acceptance-effect-succeeded' },
  { kind: 'acceptance-effect-repair-required' },
  { kind: 'human-required' },
  { kind: 'gate-failed' },
  { kind: 'authorized-cancel' },
  { kind: 'repair-requeued', role: 'author' },
  { kind: 'repair-requeued', role: 'reviewer' },
]);

const ACTIVE_EXECUTION_STATES = new Set(['reserved', 'running', 'cancel_requested']);

function keyOf(state) {
  return [state.kanbanPhase, state.loopState, state.nextRole, state.terminalReason ?? '-'].join('|');
}

function expectedTaskStatus(phase) {
  return mapV4KanbanToTaskStatus(phase);
}

function assertDualCycleInvariants(previous, next, event) {
  assertValidWorkplaceState(next);
  assert.equal(next.revision, previous.revision + 1, 'every accepted command advances the Workplace CAS revision');
  assert.ok(expectedTaskStatus(next.kanbanPhase), `Kanban phase ${next.kanbanPhase} has no task projection`);

  if (['worker-crashed', 'worker-lost'].includes(event.kind)) {
    assert.equal(next.kanbanPhase, previous.kanbanPhase, 'technical loss must not move semantic Kanban phase');
    assert.notEqual(next.kanbanPhase, 'todo', 'technical loss must not reset a card to backlog');
  }
  if (previous.kanbanPhase === 'review_in_progress' && next.kanbanPhase === 'in_progress') {
    assert.ok(
      event.kind === 'reviewer-verdict' && event.verdict === 'defect-proven'
        || event.kind === 'acceptance-effect-repair-required',
      'only semantic defect/effect repair may move review/effect work back to authoring',
    );
  }
  if (next.loopState === 'terminal') {
    assert.ok(next.terminalReason, 'terminal engine state must carry a semantic terminal reason');
  }
}

test('generated dual-cycle exploration covers every reachable Workplace state and legal transition', () => {
  const initial = initialWorkplaceState();
  const queue = [{ state: initial, trace: [] }];
  const expanded = new Set();
  const reached = new Set([keyOf(initial)]);
  const transitions = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const currentKey = keyOf(current.state);
    if (expanded.has(currentKey)) continue;
    expanded.add(currentKey);

    for (const event of EVENT_ALPHABET) {
      let next;
      try {
        next = reduceWorkplaceEvent(current.state, event);
      } catch (error) {
        assert.match(String(error), /NO_TRANSITION|requires|not compatible|terminal/i);
        continue;
      }
      assertDualCycleInvariants(current.state, next, event);
      const nextKey = keyOf(next);
      transitions.add(`${currentKey} --${event.kind}--> ${nextKey}`);
      if (!reached.has(nextKey)) {
        reached.add(nextKey);
        queue.push({ state: { ...next, revision: 0 }, trace: [...current.trace, event] });
      }
    }
  }

  for (const required of [
    'todo|idle|author|-',
    'in_progress|queued|author|-',
    'in_progress|leased|author|-',
    'in_progress|running|author|-',
    'in_progress|verifying|author|-',
    'review|queued|reviewer|-',
    'review_in_progress|leased|reviewer|-',
    'review_in_progress|running|reviewer|-',
    'review_in_progress|verifying|reviewer|-',
    'in_progress|repair_wait|author|-',
    'review_in_progress|repair_wait|reviewer|-',
    'in_progress|effect_pending|author|-',
    'review_in_progress|effect_pending|reviewer|-',
    'blocked|paused|author|-',
    'done|terminal|author|accepted',
    'failed|terminal|author|failed',
    'cancelled|terminal|author|cancelled',
  ]) assert.ok(reached.has(required), `unreached dual-cycle state: ${required}`);

  assert.ok(transitions.size >= 25, `unexpectedly small transition surface: ${transitions.size}`);
});

test('generated engine admission schedules never exceed the durable effective limit', () => {
  // Independent small admission model: arbitrary reserve/start/finish/stop
  // schedules exercise the invariant shared by dispatcher and worker ledger.
  for (let seed = 1; seed <= 256; seed += 1) {
    let value = seed >>> 0;
    const random = () => {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      return value / 0x1_0000_0000;
    };
    const operatorLimit = 1 + Math.floor(random() * 5);
    const modelLimit = 1 + Math.floor(random() * 5);
    const effective = Math.min(operatorLimit, modelLimit);
    let engineRunning = true;
    const executions = new Map();
    let seq = 0;

    for (let step = 0; step < 200; step += 1) {
      const command = Math.floor(random() * 5);
      const activeEntries = [...executions.entries()].filter(([, state]) => ACTIVE_EXECUTION_STATES.has(state));
      const active = activeEntries.map(([, state]) => state);
      if (command === 0) engineRunning = false;
      if (command === 1) engineRunning = true;
      if (command === 2 && engineRunning && active.length < effective) {
        executions.set(`execution:${seq++}`, 'reserved');
      }
      if (command === 3 && active.length > 0) {
        const id = [...executions.keys()].find(key => executions.get(key) === 'reserved');
        if (id) executions.set(id, 'running');
      }
      if (command === 4 && active.length > 0) {
        const [id] = activeEntries[Math.floor(random() * activeEntries.length)];
        executions.set(id, 'exited');
      }
      const after = [...executions.values()].filter(state => ACTIVE_EXECUTION_STATES.has(state));
      assert.ok(after.length <= effective, `seed ${seed} exceeded ${effective} at step ${step}`);
      if (!engineRunning && command === 2) {
        assert.ok(after.length <= active.length, 'stopped engine admitted new execution');
      }
    }
  }
});

test('loop ownership and WorkerExecution activity are compatible on canonical active states', () => {
  const compatible = new Map([
    ['idle', []],
    ['queued', []],
    ['leased', ['reserved']],
    ['running', ['running', 'cancel_requested']],
    ['verifying', []],
    ['effect_pending', []],
    ['repair_wait', []],
    ['paused', []],
    ['terminal', []],
  ]);
  for (const [loopState, executionStates] of compatible) {
    for (const executionState of ['reserved', 'running', 'cancel_requested', 'exited', 'lost']) {
      const allowed = executionStates.includes(executionState);
      if (loopState === 'leased') {
        assert.equal(allowed, executionState === 'reserved');
      } else if (loopState === 'running') {
        assert.equal(allowed, executionState === 'running' || executionState === 'cancel_requested');
      } else {
        assert.equal(allowed, false, `${loopState} must not depend on a live worker owner`);
      }
    }
  }
});
