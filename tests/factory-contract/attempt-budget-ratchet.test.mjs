import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('attempt budget counts role-specific crashes even after a sealed CandidateSet exists', () => {
  const source = readFileSync(
    new URL('../../src/process-modules/application/node-executors/production-cell-node-executor.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /readProjectedRoleTask\?\.\(ref, role\)/);
  assert.match(source, /sealedAttempts \+ failedExecutions/);
  assert.doesNotMatch(
    source,
    /sealedAttempts === 0 && state\.loopState === 'repair_wait'/,
  );
});
