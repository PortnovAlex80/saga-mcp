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
import {
  DOCUMENTATION_REQUIRED_UNIVERSE,
  DOCUMENTATION_PENDING_UNIVERSE,
} from './documentation-scenario-pack.mjs';

const universe = buildFactoryCoverageUniverse();

test('workshop closure statuses are data: 2 declared-CLOSED, 3 SPINE', () => {
  const statuses = Object.fromEntries(
    universe.perWorkshop.map(w => [w.workshop, w.status]),
  );
  assert.deepEqual(statuses, {
    discovery: 'CLOSED',
    formalization: 'CLOSED',
    development: 'SPINE',
    delivery: 'SPINE',
    documentation: 'SPINE',
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
  assert.equal(universe.totals.universeTokens, 204,
    '178 (2026-08-22 operator review) + 23 tokens admitted with the documentation workshop (13 declared-required spine + 10 honestly-pending fault/recovery tokens, 2026-08-24 ADR-096 gate item 4) + 3 W2 production-scale satisfiability tokens (SAT decided, cycle-UNSAT typed witness, SRS-identity UNSAT terminal) and the W2 universe restoration/split corrections. U only grows.');
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
  assert.deepEqual(
    DOCUMENTATION_REQUIRED_UNIVERSE.filter(t => DOCUMENTATION_PENDING_UNIVERSE.includes(t)),
    [], 'a token cannot be pending and required at once (documentation)');
});

test('SPINE means an honest pending ledger — the exact global uncovered set is ratcheted', () => {
  // W2 (2026-08-25) shrank development's pending ledger 19 → 6 (each residue
  // carrying its precise reason in the pack source); the ratchet may only
  // shrink by landing demonstrations. The documentation workshop's 10 honest
  // pending tokens (admission 2026-08-24) join the global pending ledger.
  assert.equal(universe.totals.pendingTotal, 18,
    '18 pending: development 6 (strong cap, bind stale-hash, the 2 CC-GAP-8 '
    + 'terminal-accounting tokens, 2 D10 continuation/replan — all honestly '
    + 'undemonstrable in the current harness) + delivery 2 + documentation 10 '
    + '(repair/fence/idempotency/crash families declared-not-driven)');
  assert.equal(universe.globalUncovered.length, 18);
  const dev = universe.perWorkshop.find(w => w.workshop === 'development');
  const dl = universe.perWorkshop.find(w => w.workshop === 'delivery');
  assert.equal(dev.pendingSize, 6,
    'the six honest residues: strong cap (structurally unreachable in the '
    + 'in-process lane), bind stale-hash (cross-lifecycle continuation seam), '
    + 'terminal-accounting unknown + human-required (substrate/human-gate '
    + 'seams not hosted by a lawful base-module drive), D10 continuation '
    + '+ replan (engine-CLI redevelop entry)');
  assert.equal(dev.requiredUniverseSize, 34,
    'landed W2: D2 sibling-isolation, D3 claim-monotonicity, D4 review/git-effect'
    + ' x2, D5 freeze, D6 readiness-mismatch, D8 evidence-pins + upstream-defect,'
    + ' D9 blocked/failed, restart x2, feedback — plus the 3 new '
    + 'production-scale satisfiability tokens');
  assert.equal(dl.pendingSize, 2,
    'K4 crash-after-effect + restart:delivery:idempotent-settlement '
    + '(BLOCKED_BY restart:development:git-change-desk-replay — an upstream '
    + 'finding does not discharge the Delivery obligation)');
  assert.equal(dl.requiredUniverseSize, 17,
    'landed: approval-binds, candidate-drift, observe-before-retry — moved to required, still in U');
  assert.ok(dl.pendingItems.includes('restart:delivery:idempotent-settlement'),
    'the delivery restart obligation stays pending until actually proven');
  const docs = universe.perWorkshop.find(w => w.workshop === 'documentation');
  assert.equal(docs.pendingSize, 10,
    'author-gate repair, review changes_requested repair, feedback counterfactuals, stale fence, duplicate submit, crash/replay idempotency + the documented render spine (needs the pdfkit engine)');
  assert.equal(docs.requiredUniverseSize, 13,
    'declared spine: fan-out author+final gates, transitions, exact handoff, honest blocked terminal + certificate, zero-bundle boundary');
});

test('inter-workshop aggregate exists: shared cross-cutting tokens', () => {
  assert.ok(universe.interWorkshopTokens.length > 0,
    'handoff/obligation tokens shared by multiple workshops');
  assert.ok(universe.interWorkshopTokens.includes('obligation:handoff.route-lifecycle'));
});

test('universe totals are ratcheted', () => {
  assert.equal(universe.totals.universeTokens, 204);
  assert.equal(universe.totals.platformFaultEdges, 8,
    'K4-owned platform fault edges (1 discovery + 5 formalization + 2 development)');
});

test('report renders the honest table', () => {
  const text = renderFactoryCoverageReport(universe);
  assert.match(text, /\| discovery \| CLOSED \|/);
  assert.match(text, /\| development \| SPINE \|/);
  assert.match(text, /\| delivery \| SPINE \|/);
  assert.match(text, /\| documentation \| SPINE \|/);
  assert.match(text, /global uncovered: 18/);
});
