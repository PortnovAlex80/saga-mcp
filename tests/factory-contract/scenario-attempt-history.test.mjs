import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scenarioAttemptNumber } from './scenario-engine.mjs';

test('scenario attempt identity survives physical worker replacement', () => {
  const keyStr = 'solution-formalization@1.0.0/node/reviewer/singleton';
  const prior = [
    { keyStr, attempt: 1 },
    { keyStr: 'other', attempt: 1 },
  ];

  assert.equal(scenarioAttemptNumber(prior, [], keyStr), 2);
  assert.equal(
    scenarioAttemptNumber(prior, [{ keyStr, attempt: 2 }], keyStr),
    3,
  );
});

test('different semantic desks keep independent attempt counters', () => {
  const prior = [
    { keyStr: 'module/a/reviewer/singleton', attempt: 1 },
    { keyStr: 'module/b/reviewer/singleton', attempt: 1 },
    { keyStr: 'module/a/reviewer/singleton', attempt: 2 },
  ];

  assert.equal(
    scenarioAttemptNumber(prior, [], 'module/a/reviewer/singleton'),
    3,
  );
  assert.equal(
    scenarioAttemptNumber(prior, [], 'module/b/reviewer/singleton'),
    2,
  );
});
