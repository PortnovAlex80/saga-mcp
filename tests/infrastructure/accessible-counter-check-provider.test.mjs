import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  evaluateAccessibleCounterFixture,
} from '../../dist/infrastructure/verification/accessible-counter-check-providers.js';

// This suite pins the automated AC checks against the EXACT integrated
// candidate of a historical run. Its subject is a specific commit inside an
// ephemeral sandbox worktree (.factory-sandboxes is scratch space, not tracked
// product): on a machine where that run was never replayed the objects simply
// do not exist, and every assertion fails for a reason that has nothing to do
// with the check provider.
//
// The theorem is only meaningful with the exact material, so the suite declares
// its precondition instead of failing on absence. When the sandbox is present
// the checks run exactly as before.
const repository = '.factory-sandboxes/meaning-run-20260809/product';
const commit = '805c95e89a1be1b6cb0c1661411ca2d588988e8f';

let files = null;
let unavailable = null;
try {
  files = {
    html: show('index.html'),
    css: show('css/styles.css'),
    js: show('js/app.js'),
  };
} catch (error) {
  unavailable = `exact sandbox candidate is unavailable (${repository} @ ${commit.slice(0, 8)})`;
  void error;
}

for (let number = 1; number <= 8; number += 1) {
  test(`exact integrated candidate passes automated AC-${number} sandbox checks`,
    { skip: unavailable }, () => {
      const result = evaluateAccessibleCounterFixture(`AC-${number}`, files);
      assert.equal(result.passed, true, JSON.stringify(result));
    });
}

test('sandbox check rejects an unknown criterion instead of passing open',
  { skip: unavailable }, () => {
    assert.equal(evaluateAccessibleCounterFixture('AC-999', files).passed, false);
  });

// The fail-closed property does NOT depend on the sandbox: an unknown criterion
// must never pass open, whatever material it is handed.
test('an unknown criterion never passes open, independent of the fixture', () => {
  assert.equal(evaluateAccessibleCounterFixture('AC-999', { html: '', css: '', js: '' }).passed, false);
});

function show(path) {
  return execFileSync('git', ['-C', repository, 'show', `${commit}:${path}`], {
    encoding: 'utf8',
  });
}
