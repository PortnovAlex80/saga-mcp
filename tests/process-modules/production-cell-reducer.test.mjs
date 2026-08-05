/**
 * ProductionCellTransitionReducer tests (Conveyor v4, step 2.2).
 *
 * Target contracts: REG-04 (Production Cell), REG-05 (Workplace), REG-13 (ОТК),
 * REG-28 (two-channel state). Covers the pure transition table from v4
 * §«Transition authority»:
 *
 *   - admission, worker lifecycle, gate outcomes, reviewer verdicts,
 *     terminal/human, repair re-queue.
 *   - REG-28-AC-02: crash/repair do NOT roll Kanban back to todo.
 *   - REG-28-AC-04: reviewer-defect is a SEMANTIC backward transition.
 *   - NO_TRANSITION throws on inapplicable events.
 *   - revision bumps on every accepted transition.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reduceWorkplaceEvent,
} from '../../dist/process-modules/domain/workplace/production-cell-reducer.js';
import {
  initialWorkplaceState,
} from '../../dist/process-modules/domain/workplace/workplace-state.js';

function atRev(n) {
  return { ...initialWorkplaceState(), revision: n };
}

// ---------------------------------------------------------------------------
// Admission + worker lifecycle.
// ---------------------------------------------------------------------------

test('work-admitted: todo/idle → in_progress/queued/author', () => {
  const next = reduceWorkplaceEvent(initialWorkplaceState(), { kind: 'work-admitted' });
  assert.equal(next.kanbanPhase, 'in_progress');
  assert.equal(next.loopState, 'queued');
  assert.equal(next.nextRole, 'author');
  assert.equal(next.revision, 1);
});

test('worker lifecycle: queued → leased → running → verifying (Kanban unchanged)', () => {
  let s = reduceWorkplaceEvent(initialWorkplaceState(), { kind: 'work-admitted' });
  assert.equal(s.kanbanPhase, 'in_progress');
  s = reduceWorkplaceEvent(s, { kind: 'worker-leased', reservationRef: 'r1' });
  assert.equal(s.loopState, 'leased');
  assert.equal(s.kanbanPhase, 'in_progress');
  s = reduceWorkplaceEvent(s, { kind: 'worker-started' });
  assert.equal(s.loopState, 'running');
  s = reduceWorkplaceEvent(s, { kind: 'candidate-sealed' });
  assert.equal(s.loopState, 'verifying');
  // Kanban never moved.
  assert.equal(s.kanbanPhase, 'in_progress');
  assert.equal(s.revision, 4); // 4 transitions from initial rev 0
});

// ---------------------------------------------------------------------------
// REG-28-AC-02: crash does NOT roll Kanban back to todo.
// ---------------------------------------------------------------------------

test('REG-28-AC-02: worker-crashed leaves Kanban in_progress, loop=repair_wait', () => {
  let s = reduceWorkplaceEvent(initialWorkplaceState(), { kind: 'work-admitted' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-leased', reservationRef: 'r1' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-started' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-crashed' });
  assert.equal(s.kanbanPhase, 'in_progress'); // NOT todo
  assert.equal(s.loopState, 'repair_wait');
});

test('REG-28-AC-02: worker-lost leaves Kanban in_progress, loop=repair_wait', () => {
  let s = reduceWorkplaceEvent(initialWorkplaceState(), { kind: 'work-admitted' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-leased', reservationRef: 'r1' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-started' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-lost' });
  assert.equal(s.kanbanPhase, 'in_progress');
  assert.equal(s.loopState, 'repair_wait');
});

// ---------------------------------------------------------------------------
// Gate outcomes (author).
// ---------------------------------------------------------------------------

function authorRunning() {
  let s = reduceWorkplaceEvent(initialWorkplaceState(), { kind: 'work-admitted' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-leased', reservationRef: 'r1' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-started' });
  s = reduceWorkplaceEvent(s, { kind: 'candidate-sealed' });
  return s; // in_progress/verifying
}

test('gate-author-accepted-final: in_progress/verifying → done/terminal(accepted)', () => {
  const s = reduceWorkplaceEvent(authorRunning(), { kind: 'gate-author-accepted-final' });
  assert.equal(s.kanbanPhase, 'done');
  assert.equal(s.loopState, 'terminal');
  assert.equal(s.terminalReason, 'accepted');
});

test('gate-author-accepted-with-review: in_progress/verifying → review/queued/reviewer', () => {
  const s = reduceWorkplaceEvent(authorRunning(), { kind: 'gate-author-accepted-with-review' });
  assert.equal(s.kanbanPhase, 'review');
  assert.equal(s.loopState, 'queued');
  assert.equal(s.nextRole, 'reviewer');
});

test('gate-repair-required (author): in_progress/verifying → repair_wait, author', () => {
  const s = reduceWorkplaceEvent(authorRunning(), {
    kind: 'gate-repair-required',
    repairTargetRole: 'author',
  });
  assert.equal(s.kanbanPhase, 'in_progress'); // unchanged
  assert.equal(s.loopState, 'repair_wait');
  assert.equal(s.nextRole, 'author');
});

test('gate-repair-required with wrong role rejected', () => {
  // in_progress requires author; reviewer is incompatible here.
  assert.throws(
    () => reduceWorkplaceEvent(authorRunning(), {
      kind: 'gate-repair-required',
      repairTargetRole: 'reviewer',
    }),
    /not compatible/,
  );
});

// ---------------------------------------------------------------------------
// Reviewer (E2E-04, E2E-05).
// ---------------------------------------------------------------------------

function reviewerVerifying() {
  let s = reduceWorkplaceEvent(authorRunning(), { kind: 'gate-author-accepted-with-review' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-leased', reservationRef: 'r2' });
  s = reduceWorkplaceEvent(s, { kind: 'worker-started' });
  s = reduceWorkplaceEvent(s, { kind: 'candidate-sealed' });
  return s; // review_in_progress/verifying
}

test('E2E-04: reviewer-verdict(invalid-output) retries reviewer role', () => {
  const s = reduceWorkplaceEvent(reviewerVerifying(), {
    kind: 'reviewer-verdict',
    verdict: 'invalid-output',
  });
  assert.equal(s.kanbanPhase, 'review_in_progress'); // unchanged
  assert.equal(s.loopState, 'repair_wait');
  assert.equal(s.nextRole, 'reviewer');
});

test('E2E-05: reviewer-verdict(defect-proven) returns to author (SEMANTIC backward)', () => {
  const s = reduceWorkplaceEvent(reviewerVerifying(), {
    kind: 'reviewer-verdict',
    verdict: 'defect-proven',
  });
  assert.equal(s.kanbanPhase, 'in_progress'); // REG-28-AC-04 backward
  assert.equal(s.loopState, 'repair_wait');
  assert.equal(s.nextRole, 'author');
});

test('E2E-02: reviewer-verdict(accepted) → done/terminal(accepted)', () => {
  const s = reduceWorkplaceEvent(reviewerVerifying(), {
    kind: 'reviewer-verdict',
    verdict: 'accepted',
  });
  assert.equal(s.kanbanPhase, 'done');
  assert.equal(s.loopState, 'terminal');
  assert.equal(s.terminalReason, 'accepted');
});

// ---------------------------------------------------------------------------
// Repair re-queue.
// ---------------------------------------------------------------------------

test('repair-requeued: repair_wait → queued (same role)', () => {
  let s = reduceWorkplaceEvent(authorRunning(), {
    kind: 'gate-repair-required',
    repairTargetRole: 'author',
  });
  s = reduceWorkplaceEvent(s, { kind: 'repair-requeued', role: 'author' });
  assert.equal(s.loopState, 'queued');
  assert.equal(s.nextRole, 'author');
});

test('repair-requeued with wrong role rejected', () => {
  let s = reduceWorkplaceEvent(authorRunning(), {
    kind: 'gate-repair-required',
    repairTargetRole: 'author',
  });
  assert.throws(
    () => reduceWorkplaceEvent(s, { kind: 'repair-requeued', role: 'reviewer' }),
    /not compatible/,
  );
});

// ---------------------------------------------------------------------------
// Terminal / human.
// ---------------------------------------------------------------------------

test('human-required: * → blocked/paused', () => {
  const s = reduceWorkplaceEvent(authorRunning(), { kind: 'human-required' });
  assert.equal(s.kanbanPhase, 'blocked');
  assert.equal(s.loopState, 'paused');
});

test('gate-failed: → failed/terminal(failed)', () => {
  const s = reduceWorkplaceEvent(authorRunning(), { kind: 'gate-failed' });
  assert.equal(s.kanbanPhase, 'failed');
  assert.equal(s.loopState, 'terminal');
  assert.equal(s.terminalReason, 'failed');
});

test('authorized-cancel: → cancelled/terminal(cancelled)', () => {
  const s = reduceWorkplaceEvent(authorRunning(), { kind: 'authorized-cancel' });
  assert.equal(s.kanbanPhase, 'cancelled');
  assert.equal(s.loopState, 'terminal');
  assert.equal(s.terminalReason, 'cancelled');
});

// ---------------------------------------------------------------------------
// NO_TRANSITION discipline.
// ---------------------------------------------------------------------------

test('NO_TRANSITION: candidate-sealed on queued workplace throws', () => {
  const s = reduceWorkplaceEvent(initialWorkplaceState(), { kind: 'work-admitted' });
  assert.throws(
    () => reduceWorkplaceEvent(s, { kind: 'candidate-sealed' }),
    /NO_TRANSITION/,
  );
});

test('NO_TRANSITION: work-admitted twice throws', () => {
  const s = reduceWorkplaceEvent(initialWorkplaceState(), { kind: 'work-admitted' });
  assert.throws(
    () => reduceWorkplaceEvent(s, { kind: 'work-admitted' }),
    /NO_TRANSITION/,
  );
});

test('NO_TRANSITION: reviewer-verdict on in_progress (not review_in_progress) throws', () => {
  assert.throws(
    () => reduceWorkplaceEvent(authorRunning(), {
      kind: 'reviewer-verdict',
      verdict: 'accepted',
    }),
    /NO_TRANSITION/,
  );
});

test('revision bumps on every accepted transition', () => {
  let s = initialWorkplaceState();
  assert.equal(s.revision, 0);
  s = reduceWorkplaceEvent(s, { kind: 'work-admitted' });
  assert.equal(s.revision, 1);
  s = reduceWorkplaceEvent(s, { kind: 'worker-leased', reservationRef: 'r1' });
  assert.equal(s.revision, 2);
  s = reduceWorkplaceEvent(s, { kind: 'worker-started' });
  assert.equal(s.revision, 3);
});
