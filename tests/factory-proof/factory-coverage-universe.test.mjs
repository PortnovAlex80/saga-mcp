// tests/factory-proof/factory-coverage-universe.test.mjs
//
// The global coverage ratchet. The Factory Coverage Universe is DETERMINISTIC
// DATA derived from the packs' declarations — and it is MONOTONIC:
//
//   U_{t+1} ⊇ U_t
//
// Landing an obligation MOVES its token pending → required (demonstrated at
// the declared layer); the token NEVER leaves U. These pins make the old
// defect — deleting landed tokens from the denominator to shrink "uncovered"
// — structurally visible: universeTokens may only grow.
//
// SCOPE HONESTY: this module is the DECLARED coverage universe. Workshop
// closure statuses computed here prove declarations, not live drives —
// demonstrated coverage (PASS ScenarioEvidenceBundles from real drives) is
// the coverage-kernel's separate layer. "CLOSED" below means
// declared-closed.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFactoryCoverageUniverse,
  renderFactoryCoverageReport,
} from './factory-coverage-universe.mjs';
import {
  DELIVERY_REQUIRED_UNIVERSE,
  DELIVERY_PENDING_UNIVERSE,
} from './delivery-scenario-pack.mjs';
import {
  DEVELOPMENT_REQUIRED_UNIVERSE,
  DEVELOPMENT_PENDING_UNIVERSE,
} from './development-scenario-pack.mjs';

const universe = buildFactoryCoverageUniverse();

test('workshop closure statuses are data: 2 declared-CLOSED, 2 SPINE', () => {
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

test('MONOTONIC UNIVERSE: landed obligations live in required, never vanish from U', () => {
  // The universe denominator includes every landed token. These are the
  // exact pins the 2026-08-22 operator review restored — do NOT shrink them:
  // landing new scenarios may only MOVE tokens (pending→required) or ADD
  // tokens, never delete.
  assert.equal(universe.totals.universeTokens, 147,
    'U restored + split: 6 restored tokens (3 delivery landed, 2 development landed, 1 delivery restart) + the D2 bundle split into dependency-order and concurrency-cap (-1 +2)');
  for (const w of universe.perWorkshop) {
    // every required token must be declared by a scenario — else landing
    // claims are lies
    assert.deepEqual(w.uncoveredRequired, [],
      `${w.workshop} required tokens must all be declared covered`);
  }
  assert.deepEqual(
    DELIVERY_REQUIRED_UNIVERSE.filter(t => DELIVERY_PENDING_UNIVERSE.includes(t)),
    [], 'a token cannot be pending and required at once (delivery)');
  assert.deepEqual(
    DEVELOPMENT_REQUIRED_UNIVERSE.filter(t => DEVELOPMENT_PENDING_UNIVERSE.includes(t)),
    [], 'a token cannot be pending and required at once (development)');
});

test('SPINE means an honest pending ledger — the exact global uncovered set is ratcheted', () => {
  assert.equal(universe.totals.pendingTotal, 18,
    '18 pending: development 16 + delivery 2');
  assert.equal(universe.globalUncovered.length, 18);
  const dev = universe.perWorkshop.find(w => w.workshop === 'development');
  const dl = universe.perWorkshop.find(w => w.workshop === 'delivery');
  assert.equal(dev.pendingSize, 16,
    'D2 sibling-isolation, D3 claim-monotonicity, D4–D10, restarts, feedback + the desk-replay seam');
  assert.equal(dev.requiredUniverseSize, 4,
    'landed: D2 dependency-order, D2 concurrency-cap (parallel burst, peak==cap), D2 fanin, D3 impl-scope — moved to required, still in U');
  assert.equal(dl.pendingSize, 2,
    'K4 crash-after-effect + restart:delivery:idempotent-settlement '
    + '(BLOCKED_BY restart:development:git-change-desk-replay — an upstream '
    + 'finding does not discharge the Delivery obligation)');
  assert.equal(dl.requiredUniverseSize, 3,
    'landed: approval-binds, candidate-drift, observe-before-retry — moved to required, still in U');
  assert.ok(dl.pendingItems.includes('restart:delivery:idempotent-settlement'),
    'the delivery restart obligation stays pending until actually proven');
});

test('inter-workshop aggregate exists: shared cross-cutting tokens', () => {
  assert.ok(universe.interWorkshopTokens.length > 0,
    'handoff/obligation tokens shared by multiple workshops');
  assert.ok(universe.interWorkshopTokens.includes('obligation:handoff.route-lifecycle'));
});

test('universe totals are ratcheted', () => {
  assert.equal(universe.totals.universeTokens, 147);
  assert.equal(universe.totals.platformFaultEdges, 6,
    'K4-owned platform fault edges (1 discovery + 5 formalization)');
});

test('report renders the honest table', () => {
  const text = renderFactoryCoverageReport(universe);
  assert.match(text, /\| discovery \| CLOSED \|/);
  assert.match(text, /\| development \| SPINE \|/);
  assert.match(text, /\| delivery \| SPINE \|/);
  assert.match(text, /global uncovered: 18/);
});
