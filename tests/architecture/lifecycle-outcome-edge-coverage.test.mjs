/**
 * CONVEYOR §23, mandatory L3/L4 item 7:
 *
 *   "every installed lifecycle outcome edge has a real-runtime trace or an
 *    explicit mechanically checked unreachable proof"
 *
 * A sibling suite (factory-contract/lifecycle-outcome-routes) proves each edge
 * is DECLARED. Declaration is not traversal: an outcome code can be routed in
 * the table and still never be produced by any run, so the first time the
 * factory emits it in production is the first time that path executes at all.
 *
 * This registry closes that gap: every edge is either TRACED (a named
 * scenario drives it end to end) or PENDING (a proven runtime producer
 * exists but no bounded scenario drives it). Set equality against the
 * installed lifecycle means a NEW edge cannot be added without being
 * classified here in the same commit, and an edge cannot quietly regress.
 *
 * The dead vocabulary was DELETED (stage 3): eight declared routes had no
 * runtime producer and were removed from BOTH the route table and the
 * worker-facing grammar — see docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md
 * (RESOLVED) and tests/architecture/lifecycle-outcome-vocabulary.test.mjs,
 * the mechanical ratchet that keeps routes and producers in lockstep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { productBuildLifecycle } from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

/** edgeKey = `<stageId>:<outcomeCode>` */
const TRACED = Object.freeze({
  // Driven end-to-end by the scripted happy path (tests/factory-e2e/w9-02).
  'initial-discovery:go': 'factory-e2e/w9-02-happy-path',
  'solution-formalization:formalized': 'factory-e2e/w9-02-happy-path',
  'solution-development:verified': 'factory-e2e/w9-02-happy-path',

  // Driven end-to-end by the W9-04 outcome-edge scenarios: one targeted
  // scripted-worker override per edge, the factory classifies through its
  // normal gates/checks/settlement (tests/factory-e2e/w9-04).
  'solution-formalization:inconsistent': 'factory-e2e/w9-04-frm-inconsistent',
  'solution-development:blocked': 'factory-e2e/w9-04-dev-blocked',
  'initial-discovery:clarify': 'factory-e2e/w9-04-disc-clarify',
  'initial-discovery:reject': 'factory-e2e/w9-04-disc-reject',
});

/**
 * Edges with a PROVEN runtime producer that no bounded-time scenario drives
 * yet. Per the stage-3 brief, `failed` edges are a different class from
 * business outcomes: the runtime produces them on process/kernel failure, so
 * the route stays even though no scripted scenario injects a kernel fault.
 */
const PENDING = Object.freeze({
  'initial-discovery:failed':
    'runtime producer exists (discovery settle-kernel catch → domain.failed → complete-failed); '
    + 'drivable only by a fault injected at the kernel seam, which the scripted harness does not expose',
  'solution-formalization:failed':
    'runtime producer exists (freeze/settle kernel throw → domain.failed → complete-failed). Its former '
    + 'scripted trace (w9-04-frm-failed) rode the freeze-kills-finished-runs defect class extinguished by '
    + 'the heading-resolution gate v1.2.0: contradictory AC headings are now rejected in-cell with a repair '
    + 'recipe, the §D2 gap is pre-validated (FORMALIZATION_SRS_INCOMPLETE), and drifted bytes route to '
    + 'complete-inconsistent. Remaining producers: kernel-seam faults (not exposed by the scripted harness) '
    + 'and the bounded budget ceilings (TOTAL-CAP/CONVERGENCE) — the budget-exhaustion family is the W1-5 '
    + 'gate-family brief route to re-trace this edge',
  'solution-development:failed':
    'runtime producer exists (freeze/binding/settle kernel failure paths → domain.failed → complete-failed); '
    + 'drivable only by a fault injected at the kernel seam, which the scripted harness does not expose',
});

function installedEdges() {
  const edges = [];
  for (const stage of productBuildLifecycle.stages) {
    for (const code of Object.keys(stage.outcomeRoutes ?? {})) {
      edges.push(`${stage.id}:${code}`);
    }
  }
  return edges.sort();
}

test('every installed outcome edge is classified as traced or pending (set equality)', () => {
  const installed = installedEdges();
  const classified = [...Object.keys(TRACED), ...Object.keys(PENDING)].sort();
  assert.deepEqual(
    installed,
    classified,
    'every lifecycle outcome edge must be classified in the same commit that '
    + 'introduces it: an unclassified edge is one nobody decided to prove.',
  );
});

test('an edge is never both traced and pending', () => {
  const both = Object.keys(TRACED).filter(edge => edge in PENDING);
  assert.deepEqual(both, [], 'an edge has exactly one honest status');
});

test('the happy path through the product-build lifecycle is traced end to end', () => {
  // The three edges that carry a product from an idea to a runnable revision.
  for (const edge of [
    'initial-discovery:go',
    'solution-formalization:formalized',
    'solution-development:verified',
  ]) {
    assert.ok(TRACED[edge], `${edge} must have a named runtime trace`);
  }
});

test('every terminal outcome of the build lifecycle is accounted for', () => {
  // Terminals are where settlement, certificates and order projection run. An
  // unaccounted terminal is the highest-risk untested edge in the conveyor.
  const terminals = [];
  for (const stage of productBuildLifecycle.stages) {
    for (const [code, route] of Object.entries(stage.outcomeRoutes ?? {})) {
      if (route.type === 'terminal') terminals.push(`${stage.id}:${code}`);
    }
  }
  assert.ok(terminals.length > 0, 'the build lifecycle must declare terminals');
  for (const edge of terminals) {
    assert.ok(
      edge in TRACED || edge in PENDING,
      `terminal edge ${edge} must be classified`,
    );
  }
});

test('coverage is reported and only runtime-only failed edges may stay pending', () => {
  const installed = installedEdges();
  const traced = Object.keys(TRACED).length;
  const ratio = `${traced}/${installed.length}`;
  // Not an assertion about the ratio — a ratchet on the ratio would either
  // block honest edge additions or freeze the worklist. The number is printed
  // so a reader sees the real state of the harness.
  process.stdout.write(`# lifecycle outcome-edge runtime coverage: ${ratio}\n`);
  assert.ok(traced >= 3, 'the happy path must stay traced');
  assert.ok(
    Object.keys(PENDING).every(edge => edge.endsWith(':failed')),
    'every non-failed edge must be traced or deleted',
  );
});
