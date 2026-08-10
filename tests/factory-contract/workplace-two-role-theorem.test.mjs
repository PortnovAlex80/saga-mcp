import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reduceWorkplaceEvent } from '../../dist/process-modules/domain/workplace/production-cell-reducer.js';

function apply(state, event, expected) {
  const next = reduceWorkplaceEvent(state, event);
  assert.deepEqual(
    {
      phase: next.kanbanPhase,
      loop: next.loopState,
      role: next.nextRole,
      terminal: next.terminalReason,
    },
    expected,
  );
  return next;
}

test('one Workplace survives author -> reviewer defect -> author repair -> reviewer acceptance', () => {
  let s = {
    kanbanPhase: 'todo',
    loopState: 'idle',
    nextRole: 'author',
    revision: 0,
    terminalReason: null,
  };

  s = apply(s, { kind: 'work-admitted' },
    { phase: 'in_progress', loop: 'queued', role: 'author', terminal: null });
  s = apply(s, { kind: 'worker-leased', reservationRef: 'author-1' },
    { phase: 'in_progress', loop: 'leased', role: 'author', terminal: null });
  s = apply(s, { kind: 'worker-started' },
    { phase: 'in_progress', loop: 'running', role: 'author', terminal: null });
  s = apply(s, { kind: 'candidate-sealed' },
    { phase: 'in_progress', loop: 'verifying', role: 'author', terminal: null });
  s = apply(s, { kind: 'gate-author-accepted-with-review' },
    { phase: 'review', loop: 'queued', role: 'reviewer', terminal: null });

  s = apply(s, { kind: 'worker-leased', reservationRef: 'review-1' },
    { phase: 'review_in_progress', loop: 'leased', role: 'reviewer', terminal: null });
  s = apply(s, { kind: 'worker-started' },
    { phase: 'review_in_progress', loop: 'running', role: 'reviewer', terminal: null });
  s = apply(s, { kind: 'candidate-sealed' },
    { phase: 'review_in_progress', loop: 'verifying', role: 'reviewer', terminal: null });
  s = apply(s, { kind: 'reviewer-verdict', verdict: 'defect-proven' },
    { phase: 'in_progress', loop: 'repair_wait', role: 'author', terminal: null });

  s = apply(s, { kind: 'repair-requeued', role: 'author' },
    { phase: 'in_progress', loop: 'queued', role: 'author', terminal: null });
  s = apply(s, { kind: 'worker-leased', reservationRef: 'author-2' },
    { phase: 'in_progress', loop: 'leased', role: 'author', terminal: null });
  s = apply(s, { kind: 'worker-started' },
    { phase: 'in_progress', loop: 'running', role: 'author', terminal: null });
  s = apply(s, { kind: 'candidate-sealed' },
    { phase: 'in_progress', loop: 'verifying', role: 'author', terminal: null });
  s = apply(s, { kind: 'gate-author-accepted-with-review' },
    { phase: 'review', loop: 'queued', role: 'reviewer', terminal: null });

  s = apply(s, { kind: 'worker-leased', reservationRef: 'review-2' },
    { phase: 'review_in_progress', loop: 'leased', role: 'reviewer', terminal: null });
  s = apply(s, { kind: 'worker-started' },
    { phase: 'review_in_progress', loop: 'running', role: 'reviewer', terminal: null });
  s = apply(s, { kind: 'candidate-sealed' },
    { phase: 'review_in_progress', loop: 'verifying', role: 'reviewer', terminal: null });
  s = apply(s, { kind: 'reviewer-verdict', verdict: 'accepted' },
    { phase: 'done', loop: 'terminal', role: 'reviewer', terminal: 'accepted' });

  assert.equal(s.revision, 18, 'the same aggregate revision advances through the full loop');
});

test('technical worker loss changes only machine loop, then requeues same role', () => {
  let s = {
    kanbanPhase: 'in_progress',
    loopState: 'running',
    nextRole: 'author',
    revision: 10,
    terminalReason: null,
  };
  s = apply(s, { kind: 'worker-lost' },
    { phase: 'in_progress', loop: 'repair_wait', role: 'author', terminal: null });
  s = apply(s, { kind: 'repair-requeued', role: 'author' },
    { phase: 'in_progress', loop: 'queued', role: 'author', terminal: null });
  assert.equal(s.revision, 12);
});

test('human-required is an explicit pause, not an automatic retry state', () => {
  const paused = reduceWorkplaceEvent({
    kanbanPhase: 'in_progress',
    loopState: 'repair_wait',
    nextRole: 'author',
    revision: 4,
    terminalReason: null,
  }, { kind: 'human-required' });

  assert.equal(paused.kanbanPhase, 'blocked');
  assert.equal(paused.loopState, 'paused');
});
