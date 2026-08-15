import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  evaluateAccessibleCounterFixture,
} from '../../dist/infrastructure/verification/accessible-counter-check-providers.js';

const repository = '.factory-sandboxes/meaning-run-20260809/product';
const commit = '805c95e89a1be1b6cb0c1661411ca2d588988e8f';
const files = {
  html: show('index.html'),
  css: show('css/styles.css'),
  js: show('js/app.js'),
};

for (let number = 1; number <= 8; number += 1) {
  test(`exact integrated candidate passes automated AC-${number} sandbox checks`, () => {
    const result = evaluateAccessibleCounterFixture(`AC-${number}`, files);
    assert.equal(result.passed, true, JSON.stringify(result));
  });
}

test('sandbox check rejects an unknown criterion instead of passing open', () => {
  assert.equal(evaluateAccessibleCounterFixture('AC-999', files).passed, false);
});

function show(path) {
  return execFileSync('git', ['-C', repository, 'show', `${commit}:${path}`], {
    encoding: 'utf8',
  });
}
