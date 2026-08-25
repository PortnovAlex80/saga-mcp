/**
 * observed-graphs.test.mjs - forward and reverse observed graphs compared
 * with the independently declared protocol graphs (WP-09, plan phase EK-6):
 * exact typed equality after settlement, typed divergences before it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');
const {
  forwardObservedGraph,
  declaredPlanningGraph,
  reverseObservedGraph,
  reverseClosureReconciliation,
  compareGraphs,
  forwardReverseReconciliation,
} = await import('../../../dist/workflow-kernel/planning/observed-graphs.js');
const { PROOFS } = await import('../../../dist/workflow-kernel/domain/universe.js');
const { freshDatabase, observingOptions, worldOf, driveSuccessTopology } = await import('./support.mjs');

test('after full settlement the forward observed graph EXACTLY equals the declared planning graph (typed equality)', () => {
  const db = freshDatabase('ek-wp09-fwd-');
  const session = db.open();
  try {
    const options = observingOptions();
    driveSuccessTopology(session, 'diamond', options);
    const edges = conveyor.dependencyRowsOf(session);
    const snapshot = worldOf(session, options.externalEvidence);
    const comparison = compareGraphs(forwardObservedGraph(snapshot, edges), declaredPlanningGraph(edges));
    assert.deepEqual(
      comparison,
      { equal: true, nodeCount: 4, edgeCount: 4 },
      'the diamond: 4 accepted items, 4 observed dependency-consumption edges',
    );
    const forward = forwardObservedGraph(snapshot, edges);
    assert.deepEqual(
      forward.edges.map((edge) => `${edge.from}->${edge.to}`).sort(),
      ['work-item:a->work-item:b', 'work-item:a->work-item:c', 'work-item:b->work-item:d', 'work-item:c->work-item:d'].sort(),
      'the observed edges are the declared edges, consumed as predecessor evidence',
    );
  } finally {
    session.close();
  }
});

test('partial settlement yields typed EDGE_MISSING divergences (never a silent pass)', () => {
  const db = freshDatabase('ek-wp09-partial-');
  const session = db.open();
  try {
    const options = observingOptions();
    // Drive only the first cell of the chain: a accepted, b and c pending.
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);
    const cells = conveyor.cellsForTopology('chain');
    const edges = conveyor.dependencyRowsOf(session);
    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, edges, options);
    conveyor.runDesk(session, a, 'success', options);
    conveyor.settleCellNode(session, ids, a, options);

    const snapshot = worldOf(session, options.externalEvidence);
    const comparison = compareGraphs(forwardObservedGraph(snapshot, edges), declaredPlanningGraph(edges));
    assert.equal(comparison.equal, false);
    const missing = comparison.divergences.filter((divergence) => divergence.kind === 'EDGE_MISSING');
    assert.equal(missing.length, 2, 'the b and c edges are typed-missing');
    assert.ok(missing.every((divergence) => divergence.to === 'work-item:b' || divergence.to === 'work-item:c'));
  } finally {
    session.close();
  }
});

test('the reverse observed graph walks terminal proofs back to their producing sources', () => {
  const db = freshDatabase('ek-wp09-rev-');
  const session = db.open();
  try {
    const options = observingOptions();
    driveSuccessTopology(session, 'chain', options);
    const snapshot = worldOf(session, options.externalEvidence);
    const reverse = reverseObservedGraph(snapshot);
    const proofNodes = reverse.nodes.filter((node) => node.kind === 'terminal-proof');
    assert.ok(proofNodes.length >= 7, `every ladder proof is a reverse node (${proofNodes.length})`);
    const runProof = proofNodes.find((node) => node.id.startsWith('proof:TerminalProof:run.success'));
    assert.ok(runProof !== undefined, 'the run proof anchors the reverse walk');
    const runEdges = reverse.edges.filter((edge) => edge.from === runProof.id);
    assert.ok(runEdges.length > 0, 'the run proof closure reaches producing sources');
    assert.ok(
      runEdges.every((edge) => edge.to.startsWith('source:') || edge.to.startsWith('proof:')),
      'reverse edges terminate at evidence sources or resting proofs',
    );
    assert.ok(runEdges.some((edge) => edge.to.startsWith('source:')), 'at least one producing source is reached');
  } finally {
    session.close();
  }
});

test('reverse typed equality: every committed closure kind set equals the frozen proof registry', () => {
  const db = freshDatabase('ek-wp09-closure-');
  const session = db.open();
  try {
    const options = observingOptions();
    driveSuccessTopology(session, 'chain', options);
    const snapshot = worldOf(session, options.externalEvidence);
    const reconciliation = reverseClosureReconciliation(snapshot);
    assert.deepEqual(reconciliation, { equal: true, nodeCount: snapshot.proofs.length, edgeCount: reconciliation.edgeCount });
    // The comparison is real: the registry closure for the run proof names
    // the exact kinds the observed walk found.
    const declaredRun = PROOFS.find((proof) => proof.id === 'TerminalProof:run.success');
    assert.ok(declaredRun.requiredEvidenceClosure.includes('ProductVerificationEvidence'));
  } finally {
    session.close();
  }
});

test('a closure divergence is typed: a missing declared closure kind fails the reverse reconciliation', () => {
  // Synthesize a proof-shaped snapshot with an incomplete closure (pure
  // input mutation - the oracle must name the exact missing kind).
  const snapshot = {
    events: [],
    obligations: [],
    heads: new Map(),
    workIntents: new Map(),
    evidence: [
      { kind: 'OperatorStopCommand', ref: 'evidence:OperatorStopCommand#1', producer: 'x' },
      { kind: 'TypedWaitDisposition', ref: 'evidence:TypedWaitDisposition#1', producer: 'x' },
    ],
    proofs: [
      {
        id: 'TerminalProof:lifecycle.cancellation',
        scope: 'lifecycle',
        ownerAggregate: 'LifecycleRun',
        ownerInstanceId: 'lifecycle-run:1',
        evidenceClosure: ['OperatorStopCommand'],
      },
    ],
    waits: [],
  };
  const result = forwardReverseReconciliation(snapshot, []);
  assert.equal(result.equal, false);
  const divergence = result.divergences.find((entry) => entry.kind === 'CLOSURE_KIND_MISSING');
  assert.ok(divergence !== undefined);
  assert.equal(divergence.closureKind, 'TypedWaitDisposition');
});

test('the full forward/reverse reconciliation is green exactly when both directions are (R7)', () => {
  const db = freshDatabase('ek-wp09-r7-');
  const session = db.open();
  try {
    const options = observingOptions();
    driveSuccessTopology(session, 'fan-in', options);
    const edges = conveyor.dependencyRowsOf(session);
    const result = forwardReverseReconciliation(worldOf(session, options.externalEvidence), edges);
    assert.equal(result.equal, true);
    // The R7 receipt the run terminal proof committed names this comparison.
    const kinds = worldOf(session, options.externalEvidence).evidence.map((fact) => fact.kind);
    assert.ok(kinds.includes('ForwardReverseReconciliationReceipt'));
  } finally {
    session.close();
  }
});
