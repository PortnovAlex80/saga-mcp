// tests/process-modules/finding-trajectory.test.mjs
//
// FINDING-TRAJECTORY BUDGET (docs/architecture/FINDING-TRAJECTORY-BUDGET.md,
// variant d hybrid) — the pure domain module: findingKey, findingSet,
// trajectory. These are the T1/T3/T4/T6 predicates of the budget contract:
//
//   T1 spinning  — a byte-identical key set is SPINNING (charged; the budget
//                  must never weaken for non-convergence);
//   T3 churning  — a count drop with ONE new key is CHURNING (cosmetic
//                  improvement is not convergence — 15→14 with a new key at a
//                  live core must still pay);
//   T4 severity  — a new FATAL key inside a strict subset is CHURNING
//                  (severity growth re-taxes the attempt);
//   T6 review    — ordinal review codes (review-finding-N,
//                  deferred-out-of-scope-N) are NOT compared: reviewer prose
//                  re-numbers between attempts and would manufacture a false
//                  waiver.
//
// Message normalization strips the volatile identity noise a re-run always
// churns: semver @tokens and hex runs >= 16 (digests, content hashes).

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  findingKey,
  findingSet,
  trajectory,
  convergingStreak,
} = await import('../../dist/process-modules/domain/workplace/finding-trajectory.js');

// The REAL stage-11 shape (development task-graph contract,
// development-settlement-policy.ts): pair-wise overlap diagnostics — each
// UNORDERED pair of implementation items without a dependency order is ONE
// finding. Stage-11 attempt 1 = 15 overlap findings (C(6,2) pairs over six
// items); attempt 2 = a strict 5-finding subset (10 resolved, 0 new).
const OVERLAP_CODE = 'development.task-graph:implementation-scope-overlap';
function overlapFinding(left, right, severity = 'error') {
  return {
    code: OVERLAP_CODE,
    severity,
    message: `implementation items '${left}' and '${right}' overlap without a dependency order`,
  };
}
function pairs(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) out.push([keys[i], keys[j]]);
  }
  return out;
}
const SIX_ITEMS = ['auth', 'billing', 'cart', 'deck', 'email', 'files'];
// Stage-11 attempt 1: every pair of the six items overlaps = 15 findings.
const STAGE_ELEVEN_FIRST = pairs(SIX_ITEMS).map(([a, b]) => overlapFinding(a, b));
// Stage-11 attempt 2: exactly 5 of those 15 pairs remain (strict subset).
const STAGE_ELEVEN_SECOND = [
  overlapFinding('auth', 'billing'),
  overlapFinding('auth', 'email'),
  overlapFinding('billing', 'email'),
  overlapFinding('cart', 'deck'),
  overlapFinding('email', 'files'),
];

test('findingKey is stable across volatile message noise (semver tokens, hex >= 16, whitespace)', () => {
  const base = findingKey({
    code: 'test.production-contract:contract-violation',
    severity: 'error',
    message: "Check test.production-contract@1.0.0 over digest 86e28119aaaabbbbccccddddeeeeffff00 rejected task 187",
  });
  const rerun = findingKey({
    code: 'test.production-contract:contract-violation',
    severity: 'error',
    message: "Check test.production-contract@2.3.4-rc.1 over digest 793c0704111122223333444455556666aa rejected task 187",
  });
  assert.equal(base, rerun,
    'provider semver bump + fresh run digest must not manufacture a NEW finding key (false churn)');
  const shortHex = findingKey({
    code: 'c:x', severity: 'error', message: 'hex a1b2c3d4e5f607 stays',
  });
  const shortHex2 = findingKey({
    code: 'c:x', severity: 'error', message: 'hex a1b2c3d4e5f608 stays',
  });
  assert.notEqual(shortHex, shortHex2,
    'hex runs SHORTER than 16 are identity (task-adjacent short ids must not be blurred)');
  const whitespace = findingKey({
    code: 'c:x', severity: 'error', message: 'same   words\nacross  lines',
  });
  assert.equal(whitespace, findingKey({ code: 'c:x', severity: 'error', message: 'same words across lines' }),
    'whitespace runs collapse before comparison');
});

test('findingSet digests the comparable key identity: keys, fatalKeys, count', () => {
  const set = findingSet([overlapFinding('a', 'b'), overlapFinding('b', 'c'), overlapFinding('a', 'c')]);
  assert.equal(set.count, 3);
  assert.deepEqual([...set.keys].sort(), set.keys, 'keys are canonically ordered');
  assert.deepEqual(set.fatalKeys, []);
  assert.match(set.digest, /^[a-f0-9]{64}$/);
  const same = findingSet([overlapFinding('b', 'c'), overlapFinding('a', 'c'), overlapFinding('a', 'b')]);
  assert.equal(set.digest, same.digest, 'order-insensitive digest');
});

test('T1 spinning: a byte-identical key set is SPINNING — the budget never weakens for non-convergence', () => {
  const first = findingSet(STAGE_ELEVEN_FIRST);
  const second = findingSet(STAGE_ELEVEN_FIRST.map(f => ({ ...f })));
  assert.equal(first.count, 15, 'fixture sanity: the stage-11 first attempt is 15 findings');
  assert.equal(trajectory(first, second), 'spinning');
});

test('stage-11 shape: 15 -> strict 5 subset is CONVERGING (10 removed, 0 new)', () => {
  const first = findingSet(STAGE_ELEVEN_FIRST);
  const second = findingSet(STAGE_ELEVEN_SECOND);
  assert.equal(trajectory(first, second), 'converging');
  assert.equal(second.count, 5);
});

test('T3 churning: 15 -> 14 with ONE new key is CHURNING — cosmetic count-drop is not convergence', () => {
  const first = findingSet(STAGE_ELEVEN_FIRST);
  // 13 old pairs survive, 2 old pairs are resolved, ONE brand-new pair appears
  // at the live core: the count fell 15 -> 14, the set is NOT a subset.
  const second = findingSet([
    ...STAGE_ELEVEN_FIRST.slice(0, 13),
    overlapFinding('guest', 'hooks'),
  ]);
  assert.equal(second.count, 14, 'fixture sanity: the count fell');
  assert.equal(trajectory(first, second), 'churning',
    'a new key at a live core must re-tax the attempt even when the count fell');
});

test('T4 severity: a strict subset that grows a FATAL key is CHURNING (fatal non-decrease)', () => {
  const first = findingSet([
    overlapFinding('a', 'b'),
    overlapFinding('b', 'c'),
    { code: 'p:hard', severity: 'error', message: 'soft failure' },
  ]);
  const second = findingSet([
    overlapFinding('a', 'b'),
    { code: 'p:hard', severity: 'fatal', message: 'soft failure' },
  ]);
  assert.equal(trajectory(first, second), 'churning',
    'the same key escalating error -> fatal must not ride the convergence waiver');
});

test('T4 companion: a strict subset with a NON-GROWING fatal key set is still converging', () => {
  const first = findingSet([
    { code: 'p:hard', severity: 'fatal', message: 'fatal one' },
    { code: 'p:soft', severity: 'error', message: 'soft one' },
    { code: 'p:soft2', severity: 'error', message: 'soft two' },
  ]);
  const second = findingSet([
    { code: 'p:hard', severity: 'fatal', message: 'fatal one' },
    { code: 'p:soft', severity: 'error', message: 'soft one' },
  ]);
  assert.equal(trajectory(first, second), 'converging');
});

test('T6 review-path exclusion: ordinal review codes are not compared (no false waiver)', () => {
  const attemptOne = findingSet([
    { code: 'review-verdict:review-finding-1', severity: 'error', message: 'prose A' },
    { code: 'review-verdict:review-finding-2', severity: 'error', message: 'prose B' },
    { code: OVERLAP_CODE, severity: 'error', message: "implementation items 'x' and 'y' overlap without a dependency order" },
  ]);
  const attemptTwo = findingSet([
    { code: 'review-verdict:review-finding-1', severity: 'error', message: 'ENTIRELY DIFFERENT PROSE' },
    { code: 'review-verdict:deferred-out-of-scope-3', severity: 'error', message: 'other prose' },
    { code: OVERLAP_CODE, severity: 'error', message: "implementation items 'x' and 'y' overlap without a dependency order" },
  ]);
  assert.equal(attemptOne.count, 1, 'ordinal review findings are excluded from the comparable set');
  assert.equal(attemptTwo.count, 1);
  assert.equal(trajectory(attemptOne, attemptTwo), 'spinning',
    'identical comparable core with renumbered reviewer prose is spin, not convergence');
  const allOrdinalA = findingSet([
    { code: 'review-verdict:review-finding-1', severity: 'error', message: 'a' },
    { code: 'review-verdict:review-finding-2', severity: 'error', message: 'b' },
  ]);
  const allOrdinalB = findingSet([
    { code: 'review-verdict:review-finding-1', severity: 'error', message: 'a' },
  ]);
  assert.equal(trajectory(allOrdinalA, allOrdinalB), 'spinning',
    'two empty comparable sets are spin (fail-safe: over-tax, never under-tax)');
});

test('convergingStreak counts the consecutive strict-subset run and stops at churn/identity', () => {
  const trailingIdentity = [
    findingSet(STAGE_ELEVEN_FIRST),
    findingSet(STAGE_ELEVEN_FIRST.slice(0, 10)),
    findingSet(STAGE_ELEVEN_SECOND),
    findingSet(STAGE_ELEVEN_SECOND),
  ];
  assert.equal(convergingStreak(trailingIdentity), 0,
    'the final identity step breaks the streak: spinning is not convergence');
  const midIdentity = [
    findingSet(STAGE_ELEVEN_FIRST),
    findingSet(STAGE_ELEVEN_FIRST.slice(0, 5)),
    findingSet(STAGE_ELEVEN_FIRST.slice(0, 5)),
    findingSet(STAGE_ELEVEN_FIRST.slice(0, 2)),
  ];
  assert.equal(convergingStreak(midIdentity), 1,
    'only the consecutive run ENDING at the last set counts');
  const growing = [
    findingSet(STAGE_ELEVEN_FIRST),
    findingSet(STAGE_ELEVEN_FIRST.slice(0, 10)),
    findingSet(STAGE_ELEVEN_FIRST.slice(0, 5)),
    findingSet(STAGE_ELEVEN_FIRST.slice(0, 2)),
  ];
  assert.equal(convergingStreak(growing), 3,
    '15 -> 10 -> 5 -> 2 is a streak of 3 converging steps');
  assert.equal(convergingStreak([findingSet(STAGE_ELEVEN_FIRST)]), 0,
    'a single row cannot converge against nothing');
});
