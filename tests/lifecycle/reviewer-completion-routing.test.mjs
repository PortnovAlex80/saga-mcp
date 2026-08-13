import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { reduceWorkplaceEvent } from '../../dist/process-modules/domain/workplace/production-cell-reducer.js';

test('worker protocol bridge cannot translate reviewer prose/status into semantic verdicts', () => {
  const source = readFileSync(
    new URL('../../src/tools/conveyor-runtime-helper.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /reviewerCompletionEvent|reviewer-verdict|applyReviewerVerdict/);
  assert.match(source, /rt\.releaseExecution/);
});

test('only the reviewer Gate event can move a verifying reviewer Workplace', () => {
  const verifying = {
    kanbanPhase: 'review_in_progress',
    loopState: 'verifying',
    nextRole: 'reviewer',
    revision: 8,
    terminalReason: null,
  };
  assert.deepEqual(
    reduceWorkplaceEvent(verifying, { kind: 'reviewer-verdict', verdict: 'defect-proven' }),
    {
      kanbanPhase: 'in_progress',
      loopState: 'repair_wait',
      nextRole: 'author',
      revision: 9,
      terminalReason: null,
    },
  );
});
