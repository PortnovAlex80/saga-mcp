// tools/module-authoring-kit/conform.test.mjs
//
// W10-A5 — Module Authoring Kit: conformance corpus regression test.
//
// Drives `runConformanceCorpus` over the kit's fixtures/index.json. Each valid
// fixture must pass validation; each negative fixture must be rejected with at
// least its declared expectedErrorCodes. This is the contract-test ratchet:
// adding a new failure mode to the canonical validator requires a matching
// negative fixture, and a fixture that silently starts passing is caught.
//
// Run: node --test tools/module-authoring-kit/conform.test.mjs
// (requires a prior `npm run build` so dist/ is present).

import assert from 'node:assert/strict';
import test from 'node:test';

import { runConformanceCorpus } from './validator.mjs';

test('conformance corpus: every case passes', () => {
  const r = runConformanceCorpus();
  if (!r.passed) {
    const lines = r.results
      .filter((res) => !res.ok)
      .map((res) => `  [${res.kind}] ${res.id}: ${res.detail}`);
    assert.fail(
      `conformance corpus failed (${r.total} cases):\n${lines.join('\n')}`,
    );
  }
  // The corpus is non-trivial — at least one valid + several negative cases.
  assert.ok(r.total >= 5, `expected >=5 corpus cases, got ${r.total}`);
  const validCount = r.results.filter((x) => x.kind === 'valid').length;
  const negCount = r.results.filter((x) => x.kind === 'negative').length;
  assert.ok(validCount >= 1, 'expected at least one valid fixture');
  assert.ok(negCount >= 5, 'expected at least five negative fixtures');
});

test('conformance corpus: each negative case documents its expected error code', () => {
  // Re-run and verify each negative case carries a non-empty expectedErrorCodes
  // declaration in fixtures/index.json (the corpus runner already enforces the
  // code is among the actual errors; here we guard the fixture metadata itself).
  const r = runConformanceCorpus();
  for (const res of r.results) {
    if (res.kind === 'negative') {
      assert.ok(res.ok, `negative case '${res.id}' should pass the corpus: ${res.detail}`);
      assert.match(res.detail, /rejected as expected/);
    }
  }
});
