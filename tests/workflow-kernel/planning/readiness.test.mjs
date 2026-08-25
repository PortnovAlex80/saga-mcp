/**
 * readiness.test.mjs - readiness over AUTHORITATIVE predecessor evidence
 * (WP-09, plan phase EK-6): exact chain, diamond, fan-in, fan-out and
 * independent-branch topologies; failed predecessors convert to
 * unreachable (D7) instead of blocking; bindings derive from durable rows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');
const settlement = await import('../../../dist/workflow-kernel/planning/settlement.js');
const { topologyBindings } = await import('../../../dist/workflow-kernel/planning/bindings.js');
const { evaluateReadiness } = await import('../../../dist/workflow-kernel/planning/readiness.js');
const { freshDatabase, observingOptions, worldOf } = await import('./support.mjs');

const readinessOf = (session, edges, itemInstanceId) =>
  evaluateReadiness(edges, topologyBindings(worldOf(session)), itemInstanceId);

test('chain topology: each successor becomes ready exactly over its predecessor acceptance evidence', () => {
  const db = freshDatabase('ek-wp09-chain-');
  const session = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);
    const cells = conveyor.cellsForTopology('chain');
    const edges = conveyor.dependencyRowsOf(session);

    // Before anything ran: b and c wait (a has no workplace yet).
    assert.equal(readinessOf(session, edges, 'work-item:a').state, 'ready', 'a has no predecessors');
    const bBefore = readinessOf(session, edges, 'work-item:b');
    assert.equal(bBefore.state, 'waiting');
    assert.deepEqual(bBefore.gaps.map((gap) => gap.reason), ['no-workplace']);

    // a completes: b becomes ready with a's exact acceptance refs as input evidence.
    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, edges, options);
    conveyor.runDesk(session, a, 'success', options);
    conveyor.settleCellNode(session, ids, a, options);
    const bAfter = readinessOf(session, edges, 'work-item:b');
    assert.equal(bAfter.state, 'ready');
    const acceptanceA = topologyBindings(worldOf(session)).acceptanceRefsOfWorkplace(a.workplace);
    assert.ok(acceptanceA.length > 0, 'authoritative acceptance evidence exists');
    for (const ref of acceptanceA) assert.ok(bAfter.inputEvidenceRefs.includes(ref), `b carries predecessor ref ${ref}`);
    // The effect receipt (the declared effect settled success) is carried too.
    const effectsA = topologyBindings(worldOf(session)).effectSuccessRefsOfWorkplace(a.workplace);
    assert.ok(effectsA.length > 0, 'a declared and settled an effect');
    for (const ref of effectsA) assert.ok(bAfter.inputEvidenceRefs.includes(ref));

    // b completes: c ready (b's acceptance + effects, and a's through b).
    const b = conveyor.enterCell(session, cells[1], options);
    conveyor.admitCellIntent(session, b, edges, options);
    conveyor.runDesk(session, b, 'success', options);
    conveyor.settleCellNode(session, ids, b, options);
    assert.equal(readinessOf(session, edges, 'work-item:c').state, 'ready');
  } finally {
    session.close();
  }
});

test('diamond topology: fan-out (b, c independent after a) and fan-in (d needs BOTH b and c)', () => {
  const db = freshDatabase('ek-wp09-diamond-');
  const session = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('diamond'), options);
    const cells = conveyor.cellsForTopology('diamond');
    const edges = conveyor.dependencyRowsOf(session);

    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, edges, options);
    conveyor.runDesk(session, a, 'success', options);
    conveyor.settleCellNode(session, ids, a, options);

    // Fan-out: both b and c are ready over a.
    assert.equal(readinessOf(session, edges, 'work-item:b').state, 'ready');
    assert.equal(readinessOf(session, edges, 'work-item:c').state, 'ready');

    // b completes; d still waits on c (fan-in: every predecessor must accept).
    const b = conveyor.enterCell(session, cells[1], options);
    conveyor.admitCellIntent(session, b, edges, options);
    conveyor.runDesk(session, b, 'success', options);
    conveyor.settleCellNode(session, ids, b, options);
    const dPartial = readinessOf(session, edges, 'work-item:d');
    assert.equal(dPartial.state, 'waiting');
    assert.equal(dPartial.gaps.length, 1);
    assert.equal(dPartial.gaps[0].itemRef, 'work-item:c');
    assert.equal(dPartial.gaps[0].reason, 'no-workplace');

    const c = conveyor.enterCell(session, cells[2], options);
    conveyor.admitCellIntent(session, c, edges, options);
    conveyor.runDesk(session, c, 'success', options);
    conveyor.settleCellNode(session, ids, c, options);
    const dReady = readinessOf(session, edges, 'work-item:d');
    assert.equal(dReady.state, 'ready', 'fan-in satisfied only after BOTH predecessors');
    const acceptanceB = topologyBindings(worldOf(session)).acceptanceRefsOfWorkplace(b.workplace);
    const acceptanceC = topologyBindings(worldOf(session)).acceptanceRefsOfWorkplace(c.workplace);
    for (const ref of [...acceptanceB, ...acceptanceC]) {
      assert.ok(dReady.inputEvidenceRefs.includes(ref), `d carries both fan-in refs (${ref})`);
    }
  } finally {
    session.close();
  }
});

test('independent branches: no edge means no readiness coupling', () => {
  const db = freshDatabase('ek-wp09-independent-');
  const session = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
    const cells = conveyor.cellsForTopology('independent');
    const edges = conveyor.dependencyRowsOf(session);
    assert.equal(edges.length, 0, 'the independent topology declares zero edges');
    assert.equal(readinessOf(session, edges, 'work-item:a').state, 'ready');
    assert.equal(readinessOf(session, edges, 'work-item:b').state, 'ready');

    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, edges, options);
    // a is mid-flight (contribution recorded, nothing accepted): b unaffected.
    assert.equal(readinessOf(session, edges, 'work-item:b').state, 'ready');
    conveyor.runDesk(session, a, 'success', options);
    conveyor.settleCellNode(session, ids, a, options);
    assert.equal(readinessOf(session, edges, 'work-item:b').state, 'ready');
  } finally {
    session.close();
  }
});

test('a failed predecessor converts dependants to UNREACHABLE (D7), never a permanent block or dead wait', () => {
  const db = freshDatabase('ek-wp09-failed-');
  const session = db.open();
  try {
    const options = observingOptions();
    const facts = conveyor.factsForTopology('failed-predecessor');
    const ids = conveyor.bootstrapVertical(session, facts, options);
    const cells = conveyor.cellsForTopology('failed-predecessor');
    const edges = conveyor.dependencyRowsOf(session);

    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, edges, options);
    // The flow advances and the dependant enters + waits on readiness.
    settlement.recordNodeTerminal(session, ids.process, [a.token], { externalEvidence: options.externalEvidence, faults: options.faults });
    const b = conveyor.enterCell(session, cells[1], options);
    const admitted = conveyor.admitCellIntent(session, b, edges, options, { waitForReadiness: true });
    assert.equal(admitted.readiness, 'waiting');
    const waitBefore = worldOf(session).waits.find((wait) => wait.kind === 'TypedWait:readiness');
    assert.equal(waitBefore.state, 'pending', 'the dependant holds a pending readiness wait');

    // The predecessor fails truthfully: the wait CONVERTS and the dependant
    // becomes unreachable - no dead wake source, no permanent block.
    conveyor.runDesk(session, a, 'truthful-failure', options);
    const waitAfter = worldOf(session).waits.find((wait) => wait.kind === 'TypedWait:readiness');
    assert.equal(waitAfter.state, 'converted', 'D7 conversion fired at the failure commit');
    const dState = readinessOf(session, edges, 'work-item:b');
    assert.equal(dState.state, 'unreachable');
    assert.deepEqual(dState.failedPredecessors, ['work-item:a']);

    // The dependant settles unreachable (workplace + node) and the ladder
    // terminates truthfully - descendants are TERMINAL, never blocked.
    conveyor.settleDependantUnreachable(session, b, options);
    conveyor.settleFailureLadder(session, ids, a, options, false);
    const world = worldOf(session, options.externalEvidence);
    assert.ok(world.proofs.some((proof) => proof.id === 'TerminalProof:workplace.unreachable'));
    assert.ok(world.proofs.some((proof) => proof.id === 'TerminalProof:node.unreachable'));
    assert.ok(world.proofs.some((proof) => proof.id === 'TerminalProof:run.truthful-failure'));
    const stillPending = world.waits.filter((wait) => wait.state === 'pending' && wait.kind === 'TypedWait:readiness');
    assert.deepEqual(stillPending, [], 'no readiness wait survived the failure (nothing waits on a dead source)');
  } finally {
    session.close();
  }
});

test('durable topology bindings derive from committed rows: factory<-lifecycle<-stage<-process and node<->workplace', () => {
  const db = freshDatabase('ek-wp09-bindings-');
  const session = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);
    const cells = conveyor.cellsForTopology('chain');
    const a = conveyor.enterCell(session, cells[0], options);
    const bindings = topologyBindings(worldOf(session));
    assert.equal(bindings.factoryOfLifecycle(ids.lifecycle).value, ids.factory);
    assert.equal(bindings.lifecycleOfStage(ids.stage).value, ids.lifecycle);
    assert.equal(bindings.stageOfProcess(ids.process).value, ids.stage);
    const nodeOfA = bindings.nodeOfWorkplace(a.workplace);
    assert.equal(nodeOfA.resolved, true, 'the planning token join binds the cell node');
    assert.equal(nodeOfA.value, a.node);
    assert.equal(bindings.workplaceOfNode(a.node).value, a.workplace);
    // The process binding of the node needs the recordNodeTerminal evidence
    // join (stamped with the cell token) - durable, not chronological.
    assert.equal(bindings.processOfNode(a.node).resolved, false, 'before recordNodeTerminal the join is honestly absent');
    conveyor.settleCellNode(session, ids, { ...a, workplace: a.workplace }, options);
    const after = topologyBindings(worldOf(session));
    assert.equal(after.processOfNode(a.node).value, ids.process);
    // Unresolvable bindings are typed, never guessed.
    assert.equal(after.factoryOfLifecycle('lifecycle-run:99').resolved, false);
  } finally {
    session.close();
  }
});
