// tests/process-modules/finding-trajectory-replan.test.mjs
//
// RE-PLAN CYCLE (docs/architecture/REPLAN-CYCLE-TZ.md §1) — the pure-module
// scope-impossible verdict, unit T1 of 9. The trajectory table gains a third
// row: a cross-seam defect (the worker physically cannot write into another
// item's changeScopes) is recognized on the SAME finding-set chain that drives
// the convergence budget:
//
//   | scope-impossible | the same `path-outside-authority` key is in latest
//   |                  | AND in previous while the overall trajectory is
//   |                  | spinning or churning → RE-PLAN MANDATE.
//
// The finding shape is the REAL stage-11 authority check
// (development-check-providers.ts path-outside-authority):
//   development.implementation-scope.v1:path-outside-authority
//   :: Git paths [src/physics/spacecraft.js] are outside frozen changeScopes
//      [package.json, src/game/, tests/].
//
// T9-guard assertions live here too (they are pure-module concerns): the
// convergence waiver and the spin charge are NOT weakened by the new verdict —
// overlap-only sets behave exactly as before.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  findingSet,
  trajectory,
  convergingStreak,
  survivingScopeViolationKeys,
  isPathOutsideAuthorityKey,
} = await import('../../dist/process-modules/domain/workplace/finding-trajectory.js');

// The REAL stage-11 composed provider-scoped code + message shape.
const SCOPE_PROVIDER = 'development.implementation-scope.v1';
const POA_CODE = `${SCOPE_PROVIDER}:path-outside-authority`;
function authorityViolation(path, scopes = 'package.json, src/game/, tests/') {
  return {
    code: POA_CODE,
    severity: 'error',
    message: `Git paths [${path}] are outside frozen changeScopes [${scopes}].`,
  };
}
const OVERLAP_CODE = 'development.task-graph:implementation-scope-overlap';
function overlap(left, right) {
  return {
    code: OVERLAP_CODE,
    severity: 'error',
    message: `implementation items '${left}' and '${right}' overlap without a dependency order`,
  };
}

// The live stage-11 burn: the physics worker keeps touching src/physics/spacecraft.js
// while its frozen scope only owns package.json, src/game/ and tests/.
const SPACECRAFT = authorityViolation('src/physics/spacecraft.js');

test('T1 spinning + surviving path-outside-authority key: trajectory is SCOPE-IMPOSSIBLE (re-plan, not budget)', () => {
  const first = findingSet([SPACECRAFT, overlap('auth', 'billing')]);
  const second = findingSet([{ ...SPACECRAFT }, overlap('auth', 'billing')]);
  assert.equal(trajectory(first, second), 'scope-impossible',
    'the same path-outside-authority key surviving two consecutive rejections is a cross-seam defect — distributed repair is impossible');
});

test('T1 churning + surviving path-outside-authority key: trajectory is SCOPE-IMPOSSIBLE (new keys do not mask the cross-seam burn)', () => {
  const first = findingSet([SPACECRAFT]);
  const second = findingSet([{ ...SPACECRAFT }, overlap('guest', 'hooks')]);
  assert.equal(trajectory(first, second), 'scope-impossible');
});

test('T1 negative: the path-outside-authority key RESOLVED (absent from latest) is not scope-impossible', () => {
  const first = findingSet([SPACECRAFT, overlap('auth', 'billing')]);
  // The worker moved the file inside its scope; a brand-new overlap remains.
  const second = findingSet([overlap('guest', 'hooks')]);
  assert.equal(trajectory(first, second), 'churning',
    'a resolved authority violation is ordinary churn/coverage — the worker CAN fix it in-boundary');
});

test('T1 negative: an overlap-only spin stays SPINNING (the new verdict never fires without the authority key)', () => {
  const first = findingSet([overlap('auth', 'billing'), overlap('cart', 'deck')]);
  const second = findingSet([overlap('auth', 'billing'), overlap('cart', 'deck')]);
  assert.equal(trajectory(first, second), 'spinning');
});

test('survivingScopeViolationKeys returns exactly the path-outside-authority keys present in BOTH sets', () => {
  const otherViolation = authorityViolation('src/render/vfx.js', 'src/ui/');
  const first = findingSet([SPACECRAFT, otherViolation, overlap('auth', 'billing')]);
  const second = findingSet([{ ...SPACECRAFT }, overlap('guest', 'hooks')]);
  const surviving = survivingScopeViolationKeys(first, second);
  assert.deepEqual(surviving, [
    `${POA_CODE}::Git paths [src/physics/spacecraft.js] are outside frozen changeScopes [package.json, src/game/, tests/].`,
  ]);
  assert.equal(isPathOutsideAuthorityKey(surviving[0]), true);
  assert.equal(isPathOutsideAuthorityKey(`${OVERLAP_CODE}::noise`), false);
});

test('T9 companion (pure): converging strict subsets still converge and scope-impossible breaks the streak exactly like spin', () => {
  const big = findingSet([SPACECRAFT, overlap('a', 'b'), overlap('c', 'd')]);
  const smaller = findingSet([overlap('a', 'b')]);
  assert.equal(trajectory(big, smaller), 'converging',
    'a strict subset without the authority key still rides the convergence waiver');
  const chain = [big, findingSet([{ ...SPACECRAFT }]), findingSet([{ ...SPACECRAFT }])];
  assert.equal(convergingStreak(chain), 0,
    'scope-impossible steps are non-converging — no waiver may fire');
});
