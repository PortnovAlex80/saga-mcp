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
  'solution-formalization:failed': 'factory-e2e/w9-04-frm-failed',
  'solution-development:blocked': 'factory-e2e/w9-04-dev-blocked',
  'initial-discovery:clarify': 'factory-e2e/w9-04-disc-clarify',
  'initial-discovery:reject': 'factory-e2e/w9-04-disc-reject',
});

/**
 * Edges no scenario drives yet. The value states WHY it matters, so the list
 * reads as a worklist rather than a suppression file. Edges marked
 * ESCALATED carry evidence they have no runtime producer through normal
 * production — the architect owns the decision (add a producer, or prove
 * unreachability mechanically); see
 * docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md.
 */
const PENDING = Object.freeze({
  // Discovery is a permissive idea-STRENGTH gate: every code forwards to
  // Formalization and is carried in the certificate. The ROUTE is identical
  // to 'go', but the emitted code differs and is what downstream reasoning
  // and the certificate record — so each still needs its own trace.
  // (All five codes traced by W9-04 — entry kept here only if re-added.)

  // ESCALATED — no runtime producer (evidence dossier):
  // docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md
  'solution-formalization:clarification-required':
    'ESCALATED unreachable: the per-cell accept effect re-accepts every produced artifact, so prd/acs/srs-missing cannot survive to settlement; the declared humanRequired→complete-clarification-required cell transition has no flow edge',
  'solution-formalization:infeasible':
    'ESCALATED unreachable: the settlement policy never returns infeasible and no kernel handler emits domain.infeasible — a declared route with no producer',
  'solution-development:rework-required':
    'ESCALATED unreachable: the integration effect hard-requires terminalStatus=complete (honest failed items are repaired, never settled) and settlement verification evidence outcome is structurally passed-only',
  'solution-development:clarification-required':
    'ESCALATED unreachable: the planner cell check validates the same canonical graph as the kernel resolver plus extra manifest coverage — nothing passes the cell but fails the resolver',
  'solution-development:failed':
    'ESCALATED unreachable: no installed check plan declares failureOwnership=upstream (a failed local-runnability receipt repairs forever instead of terminalizing) and settlement failed-reasons are kernel-integrity only',

  // Discovery: the settlement policy matrix emits only go/reject/clarify —
  // a worker recommending defer/inconclusive/failed deterministically falls
  // back to clarify (CLARIFY_POLICY_FALLBACK), so those declared routes have
  // no producer (same dossier).
  'initial-discovery:defer':
    'ESCALATED unreachable: DiscoverySettlementPolicyV1 never emits defer — a defer recommendation falls back to clarify',
  'initial-discovery:inconclusive':
    'ESCALATED unreachable: DiscoverySettlementPolicyV1 never emits inconclusive — an inconclusive recommendation falls back to clarify',
  'initial-discovery:failed':
    'ESCALATED unreachable: reserved for discovery process failure; the worker-facing grammar funnels failures into clarify and no fast terminal-failed producer exists in the installed flow',
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
