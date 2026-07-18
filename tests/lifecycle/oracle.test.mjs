/**
 * Characterization tests for the pure lifecycle domain oracle (Slice 0).
 *
 * Source: blueprint §16 Slice 0 (docs/architecture/passive-worker-kernel-blueprint.md:815-827),
 *         §18 Pure domain (line 1071-1078), §22 brief (line 1208-1216).
 *
 * Strategy:
 *   1. Fixture-driven: each JSON in ./fixtures declares its expected decoding.
 *      The test loads the fixture, calls decodeManagedState, asserts.
 *   2. Transition coverage: for each command in the §11 transition table, a
 *      dedicated subtest with a representative pre-state, asserting the
 *      events/effects/newState match the table row.
 *   3. Property: every accepted decision's events.reduce(evolve, preState)
 *      satisfies compositeInvariants.
 *   4. Determinism: same input → byte-equivalent output across 100 repeats.
 *   5. Immutability: pre-state object is not mutated by decide/evolve.
 *
 * Imports compiled JS from dist/ — `npm run build` or `tsc` (run by `npm test`)
 * must produce dist/ first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decodeManagedState,
  decide,
  evolve,
  compositeInvariants,
  asCommandId,
  asExecutionId,
  asIntegrationId,
  asHumanRequestId,
  PERMISSIVE_FACTS,
} from '../../dist/lifecycle/domain/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function loadFixture(name) {
  const raw = readFileSync(join(fixturesDir, `${name}.json`), 'utf8');
  return JSON.parse(raw);
}

function loadAllFixtures() {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')));
}

function envelope(command, actor) {
  return {
    commandId: asCommandId(`test-${command.kind}-${Math.random().toString(36).slice(2, 8)}`),
    actor: actor ?? { kind: 'controller', id: 'test-controller' },
    command,
  };
}

// ---------------------------------------------------------------------------
// 1. Fixture-driven decoder tests.
// ---------------------------------------------------------------------------

test('oracle: every fixture decodes to its declared expectation', () => {
  const fixtures = loadAllFixtures();
  assert.ok(fixtures.length >= 12, `expected ≥12 fixtures, got ${fixtures.length}`);

  for (const fx of fixtures) {
    const decoded = decodeManagedState(fx.snapshot);
    if (fx.expected === 'valid_managed') {
      assert.equal(
        decoded.kind,
        'valid',
        `${fx.name}: expected valid, got ${decoded.kind} (${decoded.code ?? ''} ${decoded.detail ?? ''})`,
      );
      if (fx.expectedStateKind) {
        assert.equal(
          decoded.state.kind,
          fx.expectedStateKind,
          `${fx.name}: expected state.kind=${fx.expectedStateKind}, got ${decoded.state.kind}`,
        );
      }
    } else if (fx.expected === 'valid_legacy') {
      // valid_legacy is a scanner-level classification; the pure decoder
      // reports the underlying ACTIVE_WITHOUT_EXECUTION violation.
      assert.equal(decoded.kind, 'violation', `${fx.name}: expected violation`);
      assert.equal(
        decoded.code,
        fx.expectedDecoderCode,
        `${fx.name}: expected decoder code ${fx.expectedDecoderCode}, got ${decoded.code}`,
      );
    } else if (fx.expected === 'named_violation') {
      assert.equal(decoded.kind, 'violation', `${fx.name}: expected violation`);
      assert.equal(
        decoded.code,
        fx.expectedCode,
        `${fx.name}: expected code ${fx.expectedCode}, got ${decoded.code}`,
      );
    } else {
      assert.fail(`${fx.name}: fixture has unknown expected=${fx.expected}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Specific named-violation coverage (one subtest per InvariantCode).
// ---------------------------------------------------------------------------

test('oracle: ACTIVE_WITHOUT_EXECUTION is reported, not normalized', () => {
  const decoded = decodeManagedState(loadFixture('violation-active-without-execution').snapshot);
  assert.equal(decoded.kind, 'violation');
  assert.equal(decoded.code, 'ACTIVE_WITHOUT_EXECUTION');
});

test('oracle: ACTIVE_WITHOUT_OWNER is reported', () => {
  const decoded = decodeManagedState({
    task: {
      id: 1,
      status: 'in_progress',
      assigned_to: null,
      current_execution_id: 'exec-x',
      integration_state: null,
      tags: [],
      task_kind: 'development.code',
      execution_mode: 'git_change',
    },
    execution: {
      execution_id: 'exec-x',
      task_id: 1,
      state: 'running',
      phase: null,
      worker_id: 'w',
    },
    integration: null,
    humanRequest: null,
  });
  assert.equal(decoded.code, 'ACTIVE_WITHOUT_OWNER');
});

test('oracle: BUFFER_WITH_OWNER is reported', () => {
  const decoded = decodeManagedState(loadFixture('violation-buffer-with-owner').snapshot);
  assert.equal(decoded.code, 'BUFFER_WITH_OWNER');
});

test('oracle: TASK_FENCE_WITHOUT_ACTIVE_EXECUTION (ghost fence) is reported', () => {
  const decoded = decodeManagedState(loadFixture('violation-task-fence-without-active-execution').snapshot);
  assert.equal(decoded.code, 'TASK_FENCE_WITHOUT_ACTIVE_EXECUTION');
});

test('oracle: TERMINAL_EXECUTION_OWNS_TASK (split transaction signature) is reported', () => {
  const decoded = decodeManagedState(loadFixture('violation-terminal-execution-owns-task').snapshot);
  assert.equal(decoded.code, 'TERMINAL_EXECUTION_OWNS_TASK');
});

test('oracle: DONE_PENDING_WITHOUT_INTEGRATION_INTENT (audit seam) is reported', () => {
  const decoded = decodeManagedState(loadFixture('violation-done-pending-without-integration').snapshot);
  assert.equal(decoded.code, 'DONE_PENDING_WITHOUT_INTEGRATION_INTENT');
});

test('oracle: WAITING_HUMAN_WITH_ACTIVE_EXECUTION (ASK dead-assignment) is reported', () => {
  const decoded = decodeManagedState(loadFixture('violation-waiting-human-with-active-execution').snapshot);
  assert.equal(decoded.code, 'WAITING_HUMAN_WITH_ACTIVE_EXECUTION');
});

test('oracle: COMPLETED_WITH_UNFINISHED_INTEGRATION is reported', () => {
  const decoded = decodeManagedState(loadFixture('violation-completed-with-unfinished-integration').snapshot);
  assert.equal(decoded.code, 'COMPLETED_WITH_UNFINISHED_INTEGRATION');
});

// ---------------------------------------------------------------------------
// 3. Transition table coverage (§11). One subtest per row.
// ---------------------------------------------------------------------------

test('oracle: ReserveWorkItem(implementation) transitions queued→active', () => {
  const state = { kind: 'queued', phase: 'implementation' };
  const cmd = {
    kind: 'ReserveWorkItem',
    taskId: 1,
    phase: 'implementation',
    workItemId: 'wi-1',
    attemptId: 'att-1',
    executionId: asExecutionId('exec-1'),
    workerId: 'w-1',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].kind, 'WorkAttemptReserved');
  assert.equal(result.events[1].kind, 'ExecutionReserved');
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].kind, 'worker.spawn');
  const post = result.events.reduce(evolve, state);
  assert.equal(post.kind, 'active');
  assert.equal(post.phase, 'implementation');
});

test('oracle: ReserveWorkItem on active task is NO_TRANSITION', () => {
  const state = { kind: 'active', phase: 'implementation', workerId: 'w', executionId: asExecutionId('e') };
  const cmd = {
    kind: 'ReserveWorkItem',
    taskId: 1,
    phase: 'implementation',
    workItemId: 'wi',
    attemptId: 'att',
    executionId: asExecutionId('e2'),
    workerId: 'w2',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_TRANSITION');
});

test('oracle: ReportImplementationCompleted freezes sourceSha and queues review', () => {
  const state = {
    kind: 'active',
    phase: 'implementation',
    workerId: 'w',
    executionId: asExecutionId('e'),
  };
  const cmd = {
    kind: 'ReportImplementationCompleted',
    taskId: 1,
    workItemId: 'wi',
    attemptId: 'att',
    sourceSha: 'abc123',
    summary: 'done',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  const implEvent = result.events.find((e) => e.kind === 'ImplementationCompleted');
  assert.ok(implEvent, 'ImplementationCompleted event emitted');
  assert.equal(implEvent.sourceSha, 'abc123', 'sourceSha is frozen on the event');
  assert.ok(result.events.some((e) => e.kind === 'ReviewItemCreated'));
});

test('oracle: SubmitReviewVerdict(approved, non-git) completes task', () => {
  const state = { kind: 'active', phase: 'review', workerId: 'rw', executionId: asExecutionId('re') };
  const cmd = {
    kind: 'SubmitReviewVerdict',
    taskId: 1,
    workItemId: 'wi',
    attemptId: 'att',
    verdict: 'approved',
    summary: 'lgtm',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'ReviewApproved'));
  assert.ok(!result.events.some((e) => e.kind === 'IntegrationRequested'),
    'non-git approval does not create integration');
  assert.ok(result.effects.some((e) => e.kind === 'workflow.generate'));
});

test('oracle: SubmitReviewVerdict(approved, git) creates integration intent', () => {
  const state = { kind: 'active', phase: 'review', workerId: 'rw', executionId: asExecutionId('re') };
  const cmd = {
    kind: 'SubmitReviewVerdict',
    taskId: 1,
    workItemId: 'wi',
    attemptId: 'att',
    verdict: 'approved',
    reviewedSourceSha: 'abc123',
    summary: 'lgtm',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'IntegrationRequested'));
  assert.ok(result.effects.some((e) => e.kind === 'integration.execute'));
});

test('oracle: SubmitReviewVerdict(changes_requested) creates fresh implementation cycle', () => {
  const state = { kind: 'active', phase: 'review', workerId: 'rw', executionId: asExecutionId('re') };
  const cmd = {
    kind: 'SubmitReviewVerdict',
    taskId: 1,
    workItemId: 'wi',
    attemptId: 'att',
    verdict: 'changes_requested',
    summary: 'redo',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'ReviewChangesRequested'));
  assert.ok(result.events.some((e) => e.kind === 'ImplementationItemCreated'));
  // Reviewer is NOT re-assigned — fresh dev cycle (audit fix).
  const post = result.events.reduce(evolve, state);
  assert.notEqual(post.kind, 'active', 'reviewer does not stay active');
});

test('oracle: ObserveProcessExited AFTER accepted terminal report is bookkeeping', () => {
  // Reviewer already approved (finishing state). Process exits. No TaskReleased.
  const state = { kind: 'finishing', completedPhase: 'review', executionId: asExecutionId('re') };
  const cmd = { kind: 'ObserveProcessExited', taskId: 1, executionId: asExecutionId('re'), exitCode: 0 };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'ExecutionExited'));
  assert.ok(!result.events.some((e) => e.kind === 'TaskReleased'),
    'terminal report preserves committed post-state');
});

test('oracle: ObserveProcessExited WITHOUT terminal report releases task', () => {
  const state = { kind: 'active', phase: 'implementation', workerId: 'w', executionId: asExecutionId('e') };
  const cmd = { kind: 'ObserveProcessExited', taskId: 1, executionId: asExecutionId('e'), exitCode: 1 };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'ExecutionExited'));
  assert.ok(result.events.some((e) => e.kind === 'TaskReleased'),
    'non-terminal exit returns task to queue');
});

test('oracle: ObserveProcessLost AFTER approval does NOT rewind review', () => {
  // The audit's central bug: review approval rewinds on integration crash.
  // Post-Slice 5 design: review stays terminal; only integration requeues.
  const state = { kind: 'awaiting_integration', integrationId: asIntegrationId('int-1') };
  const cmd = { kind: 'ObserveProcessLost', taskId: 1, executionId: asExecutionId('re-dead') };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'ExecutionLost'));
  assert.ok(!result.events.some((e) => e.kind === 'ReviewChangesRequested'),
    'lost integration executor never rewinds review');
  assert.ok(!result.events.some((e) => e.kind === 'TaskReleased'),
    'integration-loss does not release task');
});

test('oracle: ObserveProcessLost on active execution releases task', () => {
  const state = { kind: 'active', phase: 'implementation', workerId: 'w', executionId: asExecutionId('e') };
  const cmd = { kind: 'ObserveProcessLost', taskId: 1, executionId: asExecutionId('e') };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'WorkAttemptLost'));
  assert.ok(result.events.some((e) => e.kind === 'TaskReleased'));
});

test('oracle: ParkForHuman is terminal — task enters waiting_human', () => {
  const state = { kind: 'active', phase: 'implementation', workerId: 'w', executionId: asExecutionId('e') };
  const cmd = {
    kind: 'ParkForHuman',
    taskId: 1,
    workItemId: 'wi',
    attemptId: 'att',
    resumePhase: 'implementation',
    question: 'which branch?',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  assert.ok(result.events.some((e) => e.kind === 'HumanInputRequested'));
  assert.ok(result.effects.some((e) => e.kind === 'human.notify'));
  const post = result.events.reduce(evolve, state);
  assert.equal(post.kind, 'waiting_human');
});

test('oracle: RecordHumanAnswer returns task to queue', () => {
  const state = {
    kind: 'waiting_human',
    resumePhase: 'implementation',
    requestId: asHumanRequestId('hr-1'),
  };
  const cmd = {
    kind: 'RecordHumanAnswer',
    taskId: 1,
    requestId: asHumanRequestId('hr-1'),
    answer: 'use main',
  };
  const result = decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(result.ok, true);
  const post = result.events.reduce(evolve, state);
  assert.equal(post.kind, 'queued');
});

test('oracle: ReconcileDependencies(blocked) only blocks queued tasks', () => {
  // Queued → blocked ok.
  const okResult = decide(
    { kind: 'queued', phase: 'implementation' },
    envelope({ kind: 'ReconcileDependencies', taskId: 1, blocked: true }),
    PERMISSIVE_FACTS,
  );
  assert.equal(okResult.ok, true);
  // Active task MUST NOT be blocked directly (audit fix: dependency reconcile
  // must not flip a fenced task).
  const blockedResult = decide(
    { kind: 'active', phase: 'implementation', workerId: 'w', executionId: asExecutionId('e') },
    envelope({ kind: 'ReconcileDependencies', taskId: 1, blocked: true }),
    PERMISSIVE_FACTS,
  );
  assert.equal(blockedResult.ok, false);
  assert.equal(blockedResult.code, 'NO_TRANSITION');
});

test('oracle: AdminOverrideLifecycle requires admin actor', () => {
  const state = { kind: 'queued', phase: 'implementation' };
  const cmd = {
    kind: 'AdminOverrideLifecycle',
    taskId: 1,
    expectedStateFence: 'queued:implementation',
    target: 'completed',
  };
  // Controller actor — rejected.
  const controllerResult = decide(state, envelope(cmd, { kind: 'controller', id: 'c' }), PERMISSIVE_FACTS);
  assert.equal(controllerResult.ok, false);
  assert.equal(controllerResult.code, 'NOT_AUTHORIZED');
  // Admin actor — accepted.
  const adminResult = decide(
    state,
    envelope(cmd, { kind: 'admin', id: 'admin', reason: 'manual recovery' }),
    PERMISSIVE_FACTS,
  );
  assert.equal(adminResult.ok, true);
});

// ---------------------------------------------------------------------------
// 4. Property: compositeInvariants holds after every accepted transition.
// ---------------------------------------------------------------------------

test('oracle: compositeInvariants holds after every accepted transition', () => {
  const fixtures = loadAllFixtures();
  for (const fx of fixtures) {
    if (fx.expected !== 'valid_managed') continue;
    const decoded = decodeManagedState(fx.snapshot);
    if (decoded.kind !== 'valid') continue;
    // For each command, attempt a transition. If accepted, verify invariants.
    const sample = sampleCommandsFor(decoded.state, fx.snapshot.task.id);
    for (const cmd of sample) {
      const result = decide(decoded.state, envelope(cmd), PERMISSIVE_FACTS);
      if (!result.ok) continue;
      const post = result.events.reduce(evolve, decoded.state);
      const check = compositeInvariants(post);
      assert.ok(
        check.ok,
        `${fx.name} + ${cmd.kind}: post-state violates ${check.rule ?? '?'}: ${check.detail ?? ''}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Determinism: same input → same output.
// ---------------------------------------------------------------------------

test('oracle: decide is deterministic across 100 repeats', () => {
  const state = { kind: 'queued', phase: 'implementation' };
  const cmd = {
    kind: 'ReserveWorkItem',
    taskId: 1,
    phase: 'implementation',
    workItemId: 'wi',
    attemptId: 'att',
    executionId: asExecutionId('e'),
    workerId: 'w',
  };
  const env = envelope(cmd);
  const first = JSON.stringify(decide(state, env, PERMISSIVE_FACTS));
  for (let i = 0; i < 100; i += 1) {
    assert.equal(JSON.stringify(decide(state, env, PERMISSIVE_FACTS)), first);
  }
});

// ---------------------------------------------------------------------------
// 6. Immutability: pre-state is not mutated.
// ---------------------------------------------------------------------------

test('oracle: decide does not mutate input state', () => {
  const state = { kind: 'queued', phase: 'implementation' };
  const snapshot = JSON.stringify(state);
  const cmd = {
    kind: 'ReserveWorkItem',
    taskId: 1,
    phase: 'implementation',
    workItemId: 'wi',
    attemptId: 'att',
    executionId: asExecutionId('e'),
    workerId: 'w',
  };
  decide(state, envelope(cmd), PERMISSIVE_FACTS);
  assert.equal(JSON.stringify(state), snapshot, 'input state was mutated');
});

// ---------------------------------------------------------------------------
// Helpers: produce a few candidate commands for a state to exercise property.
// ---------------------------------------------------------------------------

function sampleCommandsFor(state, taskId) {
  const execId = 'exec-sample';
  const all = [
    {
      kind: 'ReserveWorkItem',
      taskId,
      phase: 'implementation',
      workItemId: 'wi',
      attemptId: 'att',
      executionId: asExecutionId(execId),
      workerId: 'w',
    },
    {
      kind: 'ReportImplementationCompleted',
      taskId,
      workItemId: 'wi',
      attemptId: 'att',
      sourceSha: 'abc',
      summary: 's',
    },
    {
      kind: 'ObserveProcessExited',
      taskId,
      executionId: asExecutionId(execId),
      exitCode: 0,
    },
    {
      kind: 'ObserveProcessLost',
      taskId,
      executionId: asExecutionId(execId),
    },
    {
      kind: 'ReconcileDependencies',
      taskId,
      blocked: true,
    },
    {
      kind: 'RecordHumanAnswer',
      taskId,
      requestId: asHumanRequestId('hr'),
      answer: 'a',
    },
  ];
  return all;
}
