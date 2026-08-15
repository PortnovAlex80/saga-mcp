// tests/factory-contract/production-cell-transitions.test.mjs
//
// Workstream 7: Production Cell state machine coverage matrix (T01-T12).
//
// These tests exercise the PURE reducer — the domain logic that transitions
// Workplace states. No I/O, no DB — the reducer is the intended authority for
// state-machine transitions, and testing it directly IS testing at the right
// level.
//
// T01-T12 cover the declared transition classes from the Conveyor model.

import { test } from 'node:test';
import assert from 'node:assert';
import { reduceWorkplaceEvent } from '../../dist/process-modules/domain/workplace/production-cell-reducer.js';

function initialState(overrides = {}) {
  return {
    kanbanPhase: 'todo',
    loopState: 'idle',
    nextRole: 'author',
    revision: 0,
    terminalReason: null,
    ...overrides,
  };
}

// T01: author gate accepted (final) → done/terminal(accepted)
test('T01: author gate accepted(final) → done/terminal(accepted)', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'verifying', nextRole: 'author', revision: 3 });
  const next = reduceWorkplaceEvent(state, { kind: 'gate-author-accepted-final' });
  assert.equal(next.kanbanPhase, 'done');
  assert.equal(next.loopState, 'terminal');
  assert.equal(next.terminalReason, 'accepted');
  assert.equal(next.revision, 4);
});

// T02: author accepted (with review) → review/queued → reviewer execution
test('T02: author accepted(with review) → review/queued', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'verifying', nextRole: 'author', revision: 3 });
  const next = reduceWorkplaceEvent(state, { kind: 'gate-author-accepted-with-review' });
  assert.equal(next.kanbanPhase, 'review');
  assert.equal(next.loopState, 'queued');
  assert.equal(next.nextRole, 'reviewer');
});

// T03: reviewer accepted → done/terminal(accepted)
test('T03: reviewer accepted → done/terminal(accepted)', () => {
  const state = initialState({ kanbanPhase: 'review_in_progress', loopState: 'verifying', nextRole: 'reviewer', revision: 5 });
  const next = reduceWorkplaceEvent(state, { kind: 'reviewer-verdict', verdict: 'accepted' });
  assert.equal(next.kanbanPhase, 'done');
  assert.equal(next.loopState, 'terminal');
  assert.equal(next.terminalReason, 'accepted');
});

// T04: author gate repair_required → repair_wait, Kanban preserved
test('T04: author gate repair_required → repair_wait, Kanban stays in_progress', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'verifying', nextRole: 'author', revision: 3 });
  const next = reduceWorkplaceEvent(state, { kind: 'gate-repair-required', repairTargetRole: 'author' });
  assert.equal(next.loopState, 'repair_wait');
  assert.equal(next.kanbanPhase, 'in_progress', 'Kanban preserved (REG-28-AC-02)');
  assert.equal(next.nextRole, 'author');
});

// T05: reviewer finds proven defect → semantic backward to author repair
test('T05: reviewer defect-proven → in_progress/repair_wait (semantic backward)', () => {
  const state = initialState({ kanbanPhase: 'review_in_progress', loopState: 'verifying', nextRole: 'reviewer', revision: 5 });
  const next = reduceWorkplaceEvent(state, { kind: 'reviewer-verdict', verdict: 'defect-proven' });
  assert.equal(next.kanbanPhase, 'in_progress', 'Kanban moves back to in_progress (REG-28-AC-04)');
  assert.equal(next.loopState, 'repair_wait');
  assert.equal(next.nextRole, 'author');
});

// T06: reviewer output invalid → reviewer repair path
test('T06: reviewer invalid-output → repair_wait, reviewer retries', () => {
  const state = initialState({ kanbanPhase: 'review_in_progress', loopState: 'verifying', nextRole: 'reviewer', revision: 5 });
  const next = reduceWorkplaceEvent(state, { kind: 'reviewer-verdict', verdict: 'invalid-output' });
  assert.equal(next.kanbanPhase, 'review_in_progress', 'Kanban stays review_in_progress');
  assert.equal(next.loopState, 'repair_wait');
  assert.equal(next.nextRole, 'reviewer');
});

// T07: repair budget exhausted → human_required → blocked/paused
test('T07: human_required → blocked/paused', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'repair_wait', nextRole: 'author', revision: 7 });
  const next = reduceWorkplaceEvent(state, { kind: 'human-required' });
  assert.equal(next.kanbanPhase, 'blocked');
  assert.equal(next.loopState, 'paused');
});

// T08: (same as T07 conceptually — human_required is the pause path)
test('T08: human_required from any state → blocked/paused', () => {
  const state = initialState({ kanbanPhase: 'review_in_progress', loopState: 'verifying', nextRole: 'reviewer', revision: 5 });
  const next = reduceWorkplaceEvent(state, { kind: 'human-required' });
  assert.equal(next.kanbanPhase, 'blocked');
  assert.equal(next.loopState, 'paused');
});

// T09: terminal failure → failed/terminal(failed)
test('T09: gate-failed → terminal(failed)', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'verifying', nextRole: 'author', revision: 3 });
  const next = reduceWorkplaceEvent(state, { kind: 'gate-failed' });
  assert.equal(next.loopState, 'terminal');
  assert.equal(next.terminalReason, 'failed');
});

// T10: worker crash → repair_wait, Kanban must NOT reset to todo
test('T10: worker crash → repair_wait, Kanban preserved', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', revision: 2 });
  const next = reduceWorkplaceEvent(state, { kind: 'worker-crashed' });
  assert.equal(next.loopState, 'repair_wait');
  assert.equal(next.kanbanPhase, 'in_progress', 'Kanban must NOT reset to todo (REG-28-AC-02)');
});

// T11: worker lost → repair_wait
test('T11: worker lost → repair_wait', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', revision: 2 });
  const next = reduceWorkplaceEvent(state, { kind: 'worker-lost' });
  assert.equal(next.loopState, 'repair_wait');
  assert.notEqual(next.kanbanPhase, 'todo');
});

// T12: repair requeue → queued, correct role
test('T12: repair-requeued → queued, correct role', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'repair_wait', nextRole: 'author', revision: 4 });
  const next = reduceWorkplaceEvent(state, { kind: 'repair-requeued', role: 'author' });
  assert.equal(next.loopState, 'queued');
  assert.equal(next.nextRole, 'author');
  assert.equal(next.kanbanPhase, 'in_progress');
});

test('T12b: repair-requeued from blocked/paused → active phase restored', () => {
  const state = initialState({ kanbanPhase: 'blocked', loopState: 'paused', nextRole: 'author', revision: 5 });
  const next = reduceWorkplaceEvent(state, { kind: 'repair-requeued', role: 'author' });
  assert.equal(next.kanbanPhase, 'in_progress', 'blocked → in_progress on requeue');
  assert.equal(next.loopState, 'queued');
});

// Additional: CAS revision protection
test('CAS: revision increments by exactly 1 per transition', () => {
  let state = initialState();
  state = reduceWorkplaceEvent(state, { kind: 'work-admitted' });
  assert.equal(state.revision, 1);
  state = reduceWorkplaceEvent(state, { kind: 'worker-leased', reservationRef: 'exec-1' });
  assert.equal(state.revision, 2);
  state = reduceWorkplaceEvent(state, { kind: 'worker-started' });
  assert.equal(state.revision, 3);
});

// Additional: authorized cancel
test('CANCEL: authorized-cancel → terminal(cancelled)', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', revision: 2 });
  const next = reduceWorkplaceEvent(state, { kind: 'authorized-cancel' });
  assert.equal(next.loopState, 'terminal');
  assert.equal(next.terminalReason, 'cancelled');
});

// Additional: invalid transitions throw
test('INVALID: candidate-sealed on queued state throws', () => {
  const state = initialState({ kanbanPhase: 'in_progress', loopState: 'queued', nextRole: 'author', revision: 1 });
  assert.throws(() => reduceWorkplaceEvent(state, { kind: 'candidate-sealed' }));
});
