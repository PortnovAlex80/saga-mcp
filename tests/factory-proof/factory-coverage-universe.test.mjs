// tests/factory-proof/factory-coverage-universe.test.mjs
//
// The global coverage ratchet (DELIVERY-KERNEL-REPAIR-PLAN §2.3): the
// Factory Coverage Universe is DETERMINISTIC DATA derived from the packs'
// declarations. Workshop closure statuses are computed by set-equality, not
// prose — "all four workshops green" cannot be asserted accidentally. The
// exact counts below are the ratchet: the uncovered set may only shrink by
// DECLARING a covering scenario in a pack.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFactoryCoverageUniverse,
  renderFactoryCoverageReport,
} from './factory-coverage-universe.mjs';

const universe = buildFactoryCoverageUniverse();

test('workshop closure statuses are data: 2 CLOSED, 2 SPINE', () => {
  const statuses = Object.fromEntries(
    universe.perWorkshop.map(w => [w.workshop, w.status]),
  );
  assert.deepEqual(statuses, {
    discovery: 'CLOSED',
    formalization: 'CLOSED',
    development: 'SPINE',
    delivery: 'SPINE',
  });
});

test('CLOSED means set-equality: zero uncovered, zero pending', () => {
  for (const w of universe.perWorkshop.filter(x => x.status === 'CLOSED')) {
    assert.deepEqual(w.uncoveredRequired, [],
      `${w.workshop} must cover its entire declared universe`);
    assert.equal(w.pendingSize, 0);
    assert.ok(w.scenarioCount > 0);
  }
});

test('SPINE means an honest pending ledger — the exact global uncovered set is ratcheted', () => {
  assert.equal(universe.totals.pendingTotal, 22,
    '22 pending: development 19 + delivery 3');
  assert.equal(universe.globalUncovered.length, 22);
  const dev = universe.perWorkshop.find(w => w.workshop === 'development');
  const dl = universe.perWorkshop.find(w => w.workshop === 'delivery');
  assert.equal(dev.pendingSize, 19, 'D2–D10 + the git-change desk-replay seam');
  assert.equal(dl.pendingSize, 3, 'delivery pending (grant-mismatch landed as a typed fail-closed refusal)');
});

test('inter-workshop aggregate exists: shared cross-cutting tokens', () => {
  assert.ok(universe.interWorkshopTokens.length > 0,
    'handoff/obligation tokens shared by multiple workshops');
  assert.ok(universe.interWorkshopTokens.includes('obligation:handoff.route-lifecycle'));
});

test('universe totals are ratcheted', () => {
  assert.equal(universe.totals.universeTokens, 144);
  assert.equal(universe.totals.platformFaultEdges, 6,
    'K4-owned platform fault edges (1 discovery + 5 formalization)');
});

test('report renders the honest table', () => {
  const text = renderFactoryCoverageReport(universe);
  assert.match(text, /\| discovery \| CLOSED \|/);
  assert.match(text, /\| development \| SPINE \|/);
  assert.match(text, /\| delivery \| SPINE \|/);
  assert.match(text, /global uncovered: 22/);
});
