/**
 * CONVEYOR §23 — the progress-obligation invariant is executable.
 *
 * The model requires every nonterminal scope to carry exactly one truthful
 * progress explanation: live owner, runnable command, typed wait or transition
 * due. None of them means `stalled`; contradicting ones mean
 * `inconsistent_state`. Before this suite the invariant lived only in prose, so
 * a scope that lost its owner produced silence — observed live as 9004
 * consecutive runtime.paused NodeRuns on one node whose Workplace sat in
 * effect_pending with zero pending obligations.
 *
 * These tests pin the classification of every loop state, both healthy and
 * broken, so the invariant cannot silently regress into prose again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyWorkplaceProgress,
  isHealthyProgress,
  HEALTHY_PROGRESS_CLASSES,
} from '../../dist/application/progress/progress-classification.js';

const BASE = {
  workplaceRef: 'workplace/1/m@1.0.0/cell/wk',
  loopState: 'queued',
  terminalReason: null,
  activeReservationRef: null,
  execution: null,
  openObligations: [],
  effectAttempts: [],
  unsatisfiedDependencies: 0,
  repairAttempts: null,
  repairCap: null,
  effectAttemptCap: 30,
};

const facts = (overrides) => ({ ...BASE, ...overrides });
const classify = (overrides) => classifyWorkplaceProgress(facts(overrides)).classification;

test('a live unexpired lease is the live owner', () => {
  for (const loopState of ['leased', 'running']) {
    assert.equal(
      classify({ loopState, activeReservationRef: 'x', execution: { executionId: 'x', leaseExpired: false } }),
      'live_owner',
      `${loopState} with a live lease`,
    );
  }
});

test('an expired lease is a runnable command, not a stall — supervision can reap it', () => {
  assert.equal(
    classify({ loopState: 'running', activeReservationRef: 'x', execution: { executionId: 'x', leaseExpired: true } }),
    'runnable_command',
  );
});

test('a state that claims an owner with no durable execution is stalled', () => {
  // The reservation points at an execution that is already terminal/absent:
  // nothing owns the next mutation and nothing will re-drive it.
  assert.equal(
    classify({ loopState: 'leased', activeReservationRef: 'gone', execution: null }),
    'stalled',
  );
});

test('an admissible Workplace is a runnable command; a blocked one is a typed wait', () => {
  assert.equal(classify({ loopState: 'queued' }), 'runnable_command');
  assert.equal(classify({ loopState: 'idle' }), 'runnable_command');
  assert.equal(
    classify({ loopState: 'queued', unsatisfiedDependencies: 2 }),
    'typed_wait',
    'dependencies supply the wake source',
  );
});

test('an ownerless state holding a live lease is an inconsistent state', () => {
  assert.equal(
    classify({ loopState: 'queued', execution: { executionId: 'x', leaseExpired: false } }),
    'inconsistent_state',
  );
});

test('verifying is transition_due only while an obligation drives it', () => {
  assert.equal(
    classify({ loopState: 'verifying', openObligations: [{ handoffKind: 'run-gate', state: 'pending' }] }),
    'transition_due',
  );
  assert.equal(
    classify({ loopState: 'verifying', openObligations: [] }),
    'stalled',
    'sealed production with nothing driving it to a gate',
  );
});

test('effect_pending without any attempt or obligation is stalled — the observed 9004-cycle livelock', () => {
  const explanation = classifyWorkplaceProgress(facts({
    loopState: 'effect_pending',
    openObligations: [],
    effectAttempts: [],
  }));
  assert.equal(explanation.classification, 'stalled');
  assert.match(explanation.reason, /no EffectAttempt/);
});

test('effect_pending is a typed wait while attempts remain, and stalls at the budget', () => {
  const pendingAttempts = (n) =>
    Array.from({ length: n }, (_, i) => ({ attemptNo: i + 1, outcome: 'pending' }));

  assert.equal(
    classify({ loopState: 'effect_pending', effectAttempts: pendingAttempts(3), effectAttemptCap: 30 }),
    'typed_wait',
  );
  assert.equal(
    classify({ loopState: 'effect_pending', effectAttempts: pendingAttempts(30), effectAttemptCap: 30 }),
    'stalled',
    'an effect that never settles must not wait forever',
  );
});

test('a settled non-successful effect that nobody routed is an inconsistent state', () => {
  assert.equal(
    classify({
      loopState: 'effect_pending',
      effectAttempts: [{ attemptNo: 1, outcome: 'repair_required' }],
      openObligations: [],
    }),
    'inconsistent_state',
  );
});

test('repair_wait is runnable until its budget is exhausted', () => {
  assert.equal(classify({ loopState: 'repair_wait', repairAttempts: 3, repairCap: 30 }), 'runnable_command');
  assert.equal(classify({ loopState: 'repair_wait', repairAttempts: 30, repairCap: 30 }), 'stalled');
});

test('an explicit human park is a typed wait, never a stall', () => {
  assert.equal(classify({ loopState: 'paused' }), 'typed_wait');
});

test('healthy classes are exactly the four the model names', () => {
  assert.deepEqual(
    [...HEALTHY_PROGRESS_CLASSES].sort(),
    ['live_owner', 'runnable_command', 'transition_due', 'typed_wait'],
  );
  assert.equal(isHealthyProgress('stalled'), false);
  assert.equal(isHealthyProgress('inconsistent_state'), false);
});

test('every explanation carries an actionable reason', () => {
  for (const loopState of [
    'idle', 'queued', 'leased', 'running', 'verifying',
    'effect_pending', 'repair_wait', 'paused',
  ]) {
    const explanation = classifyWorkplaceProgress(facts({ loopState }));
    assert.equal(explanation.scopeKind, 'workplace');
    assert.ok(explanation.reason.length > 10, `${loopState} must explain itself`);
  }
});
