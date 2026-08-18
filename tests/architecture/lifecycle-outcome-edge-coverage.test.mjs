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
 * This registry closes that gap in the only way that stays honest while the
 * scripted corpus grows: every edge is classified as either TRACED (a named
 * scenario drives it end to end) or PENDING (nobody drives it yet, with the
 * reason). Set equality against the installed lifecycle means a NEW edge cannot
 * be added without being classified here in the same commit, and an edge cannot
 * quietly regress from traced to untested.
 *
 * PENDING is not a permanent excuse — it is the stage-2 worklist. Each entry
 * converts to TRACED when a corpus-fed scenario drives it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { productBuildLifecycle } from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

/** edgeKey = `<stageId>:<outcomeCode>` */
const TRACED = Object.freeze({
  // Driven end-to-end by the scripted happy path (tests/factory-e2e/w9-02).
  'initial-discovery:go': 'factory-e2e/w9-02-happy-path',
  'solution-formalization:formalized': 'factory-e2e/w9-02-happy-path',
  'solution-development:verified': 'factory-e2e/w9-02-happy-path',
});

/**
 * Edges no scenario drives yet. The value states WHY it matters, so the list
 * reads as a worklist rather than a suppression file.
 */
const PENDING = Object.freeze({
  // Discovery is a permissive idea-STRENGTH gate: every code forwards to
  // Formalization and is carried in the certificate. The ROUTE is identical to
  // 'go', but the emitted code differs and is what downstream reasoning and the
  // certificate record — so each still needs its own trace.
  'initial-discovery:clarify': 'strength code recorded in the discovery certificate',
  'initial-discovery:reject': 'strength code recorded in the discovery certificate',
  'initial-discovery:defer': 'strength code recorded in the discovery certificate',
  'initial-discovery:inconclusive': 'strength code recorded in the discovery certificate',
  'initial-discovery:failed': 'discovery process failure still forwards; certificate must say so',

  // Formalization is the real go/no-go gate: all of these TERMINATE the run.
  // A terminal edge that no run has ever taken is exactly where settlement and
  // order projection break the first time it fires.
  'solution-formalization:clarification-required': 'terminal business outcome, never traversed',
  'solution-formalization:inconsistent': 'terminal business outcome, never traversed',
  'solution-formalization:infeasible': 'terminal business outcome, never traversed',
  'solution-formalization:failed': 'terminal failure routing, never traversed',

  // Development terminals other than the runnable-local success.
  'solution-development:rework-required': 'terminal business outcome, never traversed',
  'solution-development:clarification-required': 'terminal business outcome, never traversed',
  'solution-development:blocked': 'terminal business outcome, never traversed',
  'solution-development:failed': 'terminal failure routing, never traversed',
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

test('coverage is reported so the stage-2 worklist stays visible', () => {
  const installed = installedEdges();
  const traced = Object.keys(TRACED).length;
  const ratio = `${traced}/${installed.length}`;
  // Not an assertion about the ratio — a ratchet on the ratio would either
  // block honest edge additions or freeze the worklist. The number is printed
  // so a reader sees the real state of the harness.
  process.stdout.write(`# lifecycle outcome-edge runtime coverage: ${ratio}\n`);
  assert.ok(traced >= 3, 'the happy path must stay traced');
});
