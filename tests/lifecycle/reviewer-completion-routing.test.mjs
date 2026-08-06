import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewerCompletionEvent } from '../../dist/tools/conveyor-runtime-helper.js';
import { reduceWorkplaceEvent } from '../../dist/process-modules/domain/workplace/index.js';

const REVIEWING = Object.freeze({
  kanbanPhase: 'review_in_progress',
  loopState: 'verifying',
  nextRole: 'reviewer',
  revision: 11,
  terminalReason: null,
});

test('reviewer approved routes through reviewer-verdict accepted', () => {
  const event = reviewerCompletionEvent('done');
  assert.deepEqual(event, {
    kind: 'reviewer-verdict',
    verdict: 'accepted',
  });

  const next = reduceWorkplaceEvent(REVIEWING, event);
  assert.equal(next.kanbanPhase, 'done');
  assert.equal(next.loopState, 'terminal');
  assert.equal(next.terminalReason, 'accepted');
});

test('reviewer changes_requested routes through reviewer-verdict defect-proven', () => {
  const event = reviewerCompletionEvent('todo');
  assert.deepEqual(event, {
    kind: 'reviewer-verdict',
    verdict: 'defect-proven',
  });

  const next = reduceWorkplaceEvent(REVIEWING, event);
  assert.equal(next.kanbanPhase, 'in_progress');
  assert.equal(next.loopState, 'repair_wait');
  assert.equal(next.nextRole, 'author');
});

test('exhausted reviewer budget pauses the workplace for human action', () => {
  const event = reviewerCompletionEvent('blocked');
  assert.deepEqual(event, { kind: 'human-required' });

  const next = reduceWorkplaceEvent(REVIEWING, event);
  assert.equal(next.kanbanPhase, 'blocked');
  assert.equal(next.loopState, 'paused');
});

test('unknown reviewer completion status retries reviewer as invalid output', () => {
  const event = reviewerCompletionEvent('review_in_progress');
  assert.deepEqual(event, {
    kind: 'reviewer-verdict',
    verdict: 'invalid-output',
  });

  const next = reduceWorkplaceEvent(REVIEWING, event);
  assert.equal(next.kanbanPhase, 'review_in_progress');
  assert.equal(next.loopState, 'repair_wait');
  assert.equal(next.nextRole, 'reviewer');
});
