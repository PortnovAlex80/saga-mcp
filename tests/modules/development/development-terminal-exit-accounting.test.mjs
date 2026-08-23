// CC-GAP-8 TERMINAL-EXIT ROUTING — the mechanical enumeration of EVERY
// reachable Development terminal exit, and the invariant the independent
// state-machine review demanded after rejecting df7359fa:
//
//   BLOCKING COUNTEREXAMPLE (repaired): the Development flow had two
//   reachable post-ledger terminal exits that bypassed settle-development —
//   implement-work-items --domain.failed--> complete-failed and
//   certify-product-readiness --domain.failed--> complete-failed. Both could
//   leave every exact criterion ledger row forever pending with no terminal
//   fact/certificate. The production seam repair routes both through
//   settle-development (see development-process-module.ts); the behavioral
//   proof that settlement actually records the facts for both shapes lives in
//   tests/modules/development/verification-ledger.test.mjs.
//
// THE INVARIANT (checked over ALL FOUR installed Development flows — base,
// managed continuation, replan continuation, verification continuation):
//
//   every declared flow edge (X --> terminal outcome node) with X reachable
//   from the flow entry satisfies exactly one of:
//     ACCOUNTED  — X is settle-development: the settlement kernel records
//                  terminal-route facts for every decision (verified /
//                  blocked / failed) AND on its internal exception path
//                  (proven by the real-seam tests in verification-ledger).
//     PRE-LEDGER — X is reachable from the entry without traversing any
//                  OTHER ledger-opening node: the criterion-key ledger opens
//                  at graph materialization inside resolve-task-graph (and
//                  adopt-verification-baseline), so such an exit fires with
//                  ZERO ledger rows — nothing to account (the recorder is a
//                  typed no-op; pinned in verification-ledger).
//
// A post-ledger node exiting straight to a terminal outcome node fails this
// test — reintroducing the counterexample edge is mechanically red. The
// RED/GREEN test below proves the oracle detects the exact original defect.
//
// Two declared-but-producerless edges in the verification continuation are
// allowlisted with MECHANICAL producer pins (source scans): a kernel handler
// that never returns a 'failed' event, and the production-cell executor's
// closed domain-event vocabulary. If either pin breaks, the allowlist entry
// is stale and the edge must be re-audited in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { developmentProcessModule } = await import(
  '../../../dist/process-modules/modules/development/development-process-module.js'
);
const { developmentContinuationProcessModule } = await import(
  '../../../dist/process-modules/modules/development/development-continuation-process-module.js'
);
const {
  developmentReplanContinuationProcessModule,
} = await import(
  '../../../dist/process-modules/modules/development/development-continuation-process-module.js'
);
const {
  developmentVerificationContinuationProcessModule,
} = await import(
  '../../../dist/process-modules/modules/development/development-verification-continuation-process-module.js'
);

const SETTLEMENT_NODE = 'settle-development';

/**
 * The only flow nodes whose kernel handlers open the criterion-key ledger
 * (materializeValidatedTaskGraph / adoptVerificationBaseline -> the
 * transactional openVerificationLedgerAtGraphMaterialization call — pinned
 * by the behavioral tests in verification-ledger.test.mjs and the store
 * source). Reaching the node is not enough: the ledger opens only when the
 * node's own execution COMMITS materialization (its success path). A node's
 * failure edge therefore fires pre-ledger unless the node first succeeded —
 * and if it succeeded, the flow advanced past it on its success event.
 */
const LEDGER_OPENING_NODES = new Set([
  'resolve-task-graph',
  'adopt-verification-baseline',
]);

/** Nodes reachable from the flow entry without traversing the given blocked
 *  node set (the blocked nodes may be ORIGIN of the walk — matching the
 *  "the source itself is allowed, everything past it is not" semantics). */
function reachableFromEntry(module, blockedNodes) {
  const outgoing = new Map();
  for (const transition of module.flow.transitions) {
    const list = outgoing.get(transition.from) ?? [];
    list.push(transition.to);
    outgoing.set(transition.from, list);
  }
  const seen = new Set([module.flow.entryNodeId]);
  const queue = [module.flow.entryNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next) || blockedNodes.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** Every declared terminal exit of the module: edges whose SOURCE is
 *  reachable from the entry and whose TARGET is a terminal outcome node. */
function enumerateTerminalExits(module) {
  const terminals = new Set(module.flow.terminalNodeIds);
  const reachable = reachableFromEntry(module, new Set());
  return module.flow.transitions
    .filter(transition =>
      reachable.has(transition.from) && terminals.has(transition.to))
    .map(transition =>
      `${transition.from} --${transition.on}--> ${transition.to}`)
    .sort();
}

/**
 * The invariant checker. Every terminal exit must be ACCOUNTED (from the
 * settlement kernel) or PRE-LEDGER (its source is reachable from the entry
 * with every OTHER ledger-opening node blocked). Returns the violations.
 */
function terminalExitViolations(module, allowlist = new Set()) {
  const terminals = new Set(module.flow.terminalNodeIds);
  const reachable = reachableFromEntry(module, new Set());
  const violations = [];
  for (const transition of module.flow.transitions) {
    if (!reachable.has(transition.from) || !terminals.has(transition.to)) {
      continue;
    }
    const edge = `${transition.from} --${transition.on}--> ${transition.to}`;
    if (allowlist.has(edge)) continue;
    if (transition.from === SETTLEMENT_NODE) continue; // ACCOUNTED
    const preLedgerReachable = reachableFromEntry(
      module,
      new Set([...LEDGER_OPENING_NODES].filter(node => node !== transition.from)),
    ).has(transition.from);
    if (preLedgerReachable) continue; // PRE-LEDGER: zero rows exist
    violations.push(edge);
  }
  return violations.sort();
}

function moduleLabel(module) {
  return `${module.identity.name}@${module.identity.version}`;
}

test('base flow: every reachable terminal exit is accounted (settlement) or provably pre-ledger', () => {
  const exits = enumerateTerminalExits(developmentProcessModule);
  // The exact honest enumeration of the base flow's settled terminal exits.
  assert.deepEqual(exits, [
    // The ONLY non-settlement exit: the planner cell fails BEFORE
    // resolve-task-graph materializes the graph — zero ledger rows exist, so
    // there is nothing to account (pinned behaviorally in verification-ledger).
    'plan-task-graph --domain.failed--> complete-failed',
    // Every other exit belongs to the settlement kernel, which records the
    // terminal-route facts on all three decisions and its exception path.
    'settle-development --domain.blocked--> complete-blocked',
    'settle-development --domain.failed--> complete-failed',
    'settle-development --domain.verified--> complete-verified',
  ]);

  assert.deepEqual(
    terminalExitViolations(developmentProcessModule),
    [],
    'no post-ledger terminal exit may bypass settlement',
  );

  // The repaired counterexample edges route through settlement on BOTH
  // surfaces (the flow table and the cell declarations the scenario tooling
  // reads).
  for (const node of ['implement-work-items', 'certify-product-readiness']) {
    const flowEdge = developmentProcessModule.flow.transitions.find(t =>
      t.from === node && t.on === 'domain.failed');
    assert.equal(flowEdge?.to, SETTLEMENT_NODE,
      `${node} --domain.failed--> must route through settlement`);
    const cell = developmentProcessModule.flow.nodes
      .find(candidate => candidate.id === node).cellDefinition;
    assert.equal(cell.transitions.failed, SETTLEMENT_NODE,
      `${node}'s cell declaration matches the flow table`);
    // Human parks stay pauses: the declared human-required target is
    // unchanged by the repair.
    assert.equal(cell.transitions.humanRequired, 'complete-blocked');
  }
});

test('managed continuation flows inherit the accounted terminal exits', () => {
  for (const module of [
    developmentContinuationProcessModule,
    developmentReplanContinuationProcessModule,
  ]) {
    const exits = enumerateTerminalExits(module);
    assert.deepEqual(
      terminalExitViolations(module),
      [],
      `${moduleLabel(module)}: no post-ledger terminal exit may bypass settlement`,
    );
    // The replan planner is the one pre-ledger exit of the continuation
    // family (it fails before the resolver materializes the cycle-2 graph);
    // the plain continuation enters AT the resolver, so ALL its exits are
    // settlement-owned.
    const nonSettlement = exits.filter(edge => !edge.startsWith(`${SETTLEMENT_NODE} `));
    if (module === developmentReplanContinuationProcessModule) {
      assert.deepEqual(nonSettlement,
        ['replan-task-graph --domain.failed--> complete-failed'],
        'the cycle-2 planner failure is the only pre-ledger exit');
    } else {
      assert.deepEqual(nonSettlement, [],
        'the plain continuation has no pre-ledger exit: entry IS the ledger opener');
    }
  }
});

test('verification continuation: the two producerless declared edges are allowlisted with mechanical producer pins', () => {
  const module = developmentVerificationContinuationProcessModule;
  const allowlist = new Set([
    // (1) adopt --domain.failed--> complete-failed: the adoption handler
    //     returns ONLY event 'valid' (all failures THROW — which fails the
    //     ProcessRun into crash recovery, a resumable state that settles
    //     nothing). Pinned by the source scan below: the handler file never
    //     returns a 'failed' event. Its durable failure modes all precede
    //     the TRANSACTIONAL ledger opening.
    'adopt-verification-baseline --domain.failed--> complete-failed',
    // (2) verify-acceptance --domain.human-required--> complete-blocked:
    //     production cells emit only 'accepted' | 'failed' domain events —
    //     a human park is a runtime PAUSE (a truthful typed wait), never a
    //     flow transition. Pinned by the executor vocabulary source scan.
    'verify-acceptance --domain.human-required--> complete-blocked',
  ]);
  assert.deepEqual(
    terminalExitViolations(module, allowlist),
    [],
    'with the producerless edges pinned, every producible exit is accounted',
  );
  // Both allowlist entries are still declared in the flow (if one is ever
  // deleted, drop its allowlist entry and its pin in the same commit).
  const exits = new Set(enumerateTerminalExits(module));
  for (const edge of allowlist) {
    assert.ok(exits.has(edge), `allowlisted edge must still be declared: ${edge}`);
  }

  // PRODUCER PIN (1): the adoption handler never returns a 'failed' event.
  const adoptionSource = readFileSync(new URL(
    '../../../src/modules/development/infrastructure/sqlite-development-verification-adoption.ts',
    import.meta.url,
  ), 'utf8');
  assert.ok(adoptionSource.includes("event: 'valid'"),
    'the adoption handler returns its valid event');
  assert.ok(!adoptionSource.includes("event: 'failed'"),
    'the adoption handler never returns a failed event — failures throw into '
    + 'crash recovery; if this pin breaks, the allowlist entry above is stale '
    + 'and the adopt failure edge must be re-audited');

  // PRODUCER PIN (2): the production-cell executor's domain-event vocabulary
  // is closed over {accepted, failed} — no human-required flow event exists.
  const executorSource = readFileSync(new URL(
    '../../../src/process-modules/application/node-executors/production-cell-node-executor.ts',
    import.meta.url,
  ), 'utf8');
  const domainEvents = [...executorSource.matchAll(/domainEvent:\s*'([^']+)'/g)]
    .map(match => match[1]);
  assert.ok(domainEvents.length > 0, 'the executor does emit domain events');
  assert.deepEqual([...new Set(domainEvents)].sort(), ['accepted', 'failed'],
    'cells emit only accepted|failed; a human park is a runtime pause — if '
    + 'this pin breaks, the allowlist entry above is stale and the '
    + 'human-required terminal edge must be re-audited');
});

test('RED/GREEN: the oracle detects the exact rejected counterexample edges', () => {
  // Reintroduce EACH original counterexample edge on a cloned flow and
  // require the checker to flag exactly it — the same defect the independent
  // review rejected at df7359fa must stay mechanically red if it returns.
  for (const node of ['implement-work-items', 'certify-product-readiness']) {
    const mutated = structuredClone(developmentProcessModule);
    const edge = mutated.flow.transitions.find(t =>
      t.from === node && t.on === 'domain.failed');
    assert.equal(edge.to, SETTLEMENT_NODE);
    edge.to = 'complete-failed'; // the rejected routing
    assert.deepEqual(
      terminalExitViolations(mutated),
      [`${node} --domain.failed--> complete-failed`],
      `the oracle must flag the reintroduced counterexample edge from ${node}`,
    );
  }

  // And a NOVEL edge of the same class (verify-acceptance bypassing
  // settlement) is caught too — the invariant is general, not incident-shaped.
  const novel = structuredClone(developmentProcessModule);
  novel.flow.transitions.find(t =>
    t.from === 'verify-acceptance' && t.on === 'domain.failed').to = 'complete-failed';
  assert.deepEqual(
    terminalExitViolations(novel),
    ['verify-acceptance --domain.failed--> complete-failed'],
  );

  // The lawful pre-ledger exit is NOT a violation (planner failure with an
  // unopened ledger) — the oracle does not over-flag.
  const planner = structuredClone(developmentProcessModule);
  assert.deepEqual(terminalExitViolations(planner), []);
  assert.ok(enumerateTerminalExits(planner)
    .includes('plan-task-graph --domain.failed--> complete-failed'));
});
