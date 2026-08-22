// tests/factory-proof/conformance-engine.test.mjs
//
// Factory Conformance Engine v1 — the demonstrated-layer pins. The v1 exit
// criteria (operator directive 2026-08-22) as DATA:
//   1. the committed evidence snapshot validates (no fake bundles);
//   2. Discovery and Formalization are 100% DEMONSTRATED (PASS bundles from
//      real drives, not declarations);
//   3. blocked obligations stay in U and stay pending (never counted
//      covered, never deleted);
//   4. the declared layer and the demonstrated layer are DIFFERENT numbers —
//      the instrument must never merge them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const reportJson = execFileSync(
  process.execPath,
  [path.join(HERE, 'conformance-engine.mjs')],
  { encoding: 'utf8', timeout: 120_000 },
);
const report = JSON.parse(
  reportJson.trim().split('\n').find(l => l.startsWith('{')),
);

test('v1: the committed evidence snapshot validates', () => {
  assert.equal(report.demonstrated.nonPassRuns, 0,
    'every committed bundle must be a PASS bundle');
  assert.ok(report.demonstrated.passBundles >= 60,
    `expected the full-harvest snapshot, got ${report.demonstrated.passBundles} bundles`);
  for (const run of report.runs) {
    assert.notEqual(run.verdict, 'invalid-bundle', `${run.scenario} bundle failed validation`);
    assert.notEqual(run.verdict, 'unparseable', `${run.scenario} evidence unparseable`);
  }
});

test('v1: reference workshops are 100% DEMONSTRATED (PASS bundles, not declarations)', () => {
  for (const id of ['discovery', 'formalization']) {
    const w = report.demonstrated.byWorkshop.find(x => x.workshop === id);
    assert.equal(w.percent, 100, `${id} must be demonstrated-closed`);
    assert.equal(w.uncovered.length, 0);
  }
});

test('v1: Development and Delivery are honestly measured, fully inventoried', () => {
  for (const id of ['development', 'delivery']) {
    const w = report.demonstrated.byWorkshop.find(x => x.workshop === id);
    assert.ok(w.universe > 0, `${id} universe must be catalogued`);
    assert.ok(w.percent < 100, `${id} is not closure-complete — v1 measures, it does not claim`);
    assert.equal(
      w.uncovered.length + w.demonstratedCovered,
      w.universe,
      `${id} covered + uncovered must equal U (every gap has a name)`,
    );
  }
});

test('v1: blocked obligations stay pending and are never counted covered', () => {
  const delivery = report.demonstrated.byWorkshop.find(x => x.workshop === 'delivery');
  const blocked = delivery.blocked.find(
    b => b.token === 'restart:delivery:idempotent-settlement');
  assert.ok(blocked, 'the delivery restart must be listed BLOCKED_BY its development prerequisite');
  assert.ok(delivery.uncovered.includes(blocked.token),
    'a blocked token is uncovered by definition');
});

test('v1: declared and demonstrated are different layers — the report carries both', () => {
  assert.ok(report.declared.universeTokens >= 147,
    'the declared universe is the monotonic denominator');
  assert.ok(typeof report.demonstrated.passBundles === 'number');
  assert.equal(report.demonstrated.dimensions.mutationKillRate.measured, false,
    'mutation kill rate must not be claimed before the K4 fault scheduler lands');
});
