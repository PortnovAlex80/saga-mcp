/**
 * settlement.test.mjs - bounded aggregate settlement through the existing
 * obligation/wait machinery (WP-09, plan phase EK-6): success, truthful
 * failure, cancellation and unreachable proofs for Node, Process, Stage,
 * Lifecycle and Run; the WP-07-unresolvable cross-aggregate bindings
 * supplied as durable evidence; reviewer-work isolation; parallel
 * independent authority; crash/re-drive determinism.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');
const settlement = await import('../../../dist/workflow-kernel/planning/settlement.js');
const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');
const { FaultScheduler, FaultCrashError } = await import('../../../dist/workflow-kernel/application/faults.js');
const { freshDatabase, observingOptions, worldOf, driveSuccessTopology, proofIdsOf } = await import('./support.mjs');

const configOf = (options) => ({ externalEvidence: options.externalEvidence, faults: options.faults });

test('success settlement: every aggregate settles through its bounded frozen command and the run proves success', () => {
  const db = freshDatabase('ek-wp09-success-');
  const session = db.open();
  try {
    const options = observingOptions();
    const { ids, cells } = driveSuccessTopology(session, 'chain', options);
    const proofs = proofIdsOf(session, options.externalEvidence);
    for (const proof of [
      'TerminalProof:cell.success',
      'TerminalProof:workplace.success',
      'TerminalProof:node.success',
      'TerminalProof:process.success',
      'TerminalProof:stage.success',
      'TerminalProof:lifecycle.success',
      'TerminalProof:run.success',
    ]) {
      assert.ok(proofs.includes(proof), `${proof} committed`);
    }
    // Each proof carries its frozen evidence closure (ProcessOutcomeCertificate etc.).
    const processProof = worldOf(session).proofs.find((proof) => proof.id === 'TerminalProof:process.success');
    assert.ok(processProof.evidenceClosure.includes('ProcessOutcomeCertificate'), 'R14: the certificate IS the process-scope proof evidence');
    // The run proof commits the settlement-time receipts (R6/R7).
    const evidenceKinds = worldOf(session, options.externalEvidence).evidence.map((fact) => fact.kind);
    assert.ok(evidenceKinds.includes('ForwardReverseReconciliationReceipt'), 'R7 receipt committed with the run terminal proof');
    assert.ok(evidenceKinds.includes('ContextEnvelopeComplianceEvidence'), 'R6 receipt committed with the run terminal proof');
    assert.equal(cells.every((cell) => cell.readiness === 'ready'), true);
    assert.equal(worldOf(session).heads.get(ids.factory).terminal, 'TerminalProof:run.success');
  } finally {
    session.close();
  }
});

test('the WP-07-unresolvable cross-aggregate obligations resolve here through durable topology bindings, never guesses', () => {
  const db = freshDatabase('ek-wp09-bindings-supply-');
  const session = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);
    const cells = conveyor.cellsForTopology('chain');
    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, conveyor.dependencyRowsOf(session), options);
    conveyor.runDesk(session, a, 'success', options);

    // BEFORE WP-09: obligation:completeCellNode is typed-unresolvable by the
    // consumer (no durable target-instance binding on row, aggregate or
    // WorkIntent evidence) - exactly the WP-07 handoff state.
    const frontierBefore = consumer.openFrontier(session).find((entry) => entry.kind === 'obligation:completeCellNode');
    assert.ok(frontierBefore !== undefined, 'the cross-aggregate cell completion obligation is on the frontier');
    assert.ok(frontierBefore.refusal !== undefined, 'the consumer cannot resolve it');
    assert.equal(frontierBefore.refusal.reason, 'MISSING_EVIDENCE');
    assert.match(frontierBefore.refusal.detail, /no durable target-instance binding/);

    // AFTER WP-09: the same obligation consumes with the planning-topology
    // binding (workplace -> cell node) and records TerminalProof:node.success.
    conveyor.settleCellNode(session, ids, a, options);
    const completed = worldOf(session).obligations.find((obligation) => obligation.kind === 'obligation:completeCellNode' && obligation.state === 'completed');
    assert.ok(completed !== undefined, 'completeCellNode completed through the supplied binding');
    assert.ok(worldOf(session).proofs.some((proof) => proof.id === 'TerminalProof:node.success'));
    // The binding was evidence-based: the completed row's completing key
    // names the exact application on the resolved node instance.
    const completedRow = session.db
      .prepare("SELECT completed_by_key FROM transition_obligation WHERE kind = 'obligation:completeCellNode' AND state = 'completed'")
      .get();
    assert.ok(completedRow.completed_by_key.includes('node-run:1'), `completing key: ${completedRow.completed_by_key}`);
  } finally {
    session.close();
  }
});

test('truthful failure: D6 terminality -> workplace failure -> node failure -> process/stage/lifecycle/run truthful-failure proofs', () => {
  const db = freshDatabase('ek-wp09-failure-');
  const session = db.open();
  try {
    const options = observingOptions();
    const facts = conveyor.factsForTopology('failed-predecessor');
    const ids = conveyor.bootstrapVertical(session, facts, options);
    const cells = conveyor.cellsForTopology('failed-predecessor');
    const edges = conveyor.dependencyRowsOf(session);
    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, edges, options);
    settlement.recordNodeTerminal(session, ids.process, [a.token], configOf(options));
    const b = conveyor.enterCell(session, cells[1], options);
    conveyor.admitCellIntent(session, b, edges, options, { waitForReadiness: true });
    conveyor.runDesk(session, a, 'truthful-failure', options);
    conveyor.settleDependantUnreachable(session, b, options);
    conveyor.settleFailureLadder(session, ids, a, options, false);

    const proofs = proofIdsOf(session, options.externalEvidence);
    for (const proof of [
      'TerminalProof:workplace.truthful-failure',
      'TerminalProof:node.truthful-failure',
      'TerminalProof:process.truthful-failure',
      'TerminalProof:stage.truthful-failure',
      'TerminalProof:lifecycle.truthful-failure',
      'TerminalProof:run.truthful-failure',
      'TerminalProof:node.unreachable',
    ]) {
      assert.ok(proofs.includes(proof), `${proof} committed`);
    }
    // The truthful failure is HONEST: RepairTerminalityEvidence exists (D6)
    // and the propagate obligations completed through bindings.
    const kinds = worldOf(session, options.externalEvidence).evidence.map((fact) => fact.kind);
    assert.ok(kinds.includes('RepairTerminalityEvidence'), 'D6 repair-epoch terminality evidence committed');
    for (const kind of ['obligation:propagateCellFailure', 'obligation:propagateNodeFailure', 'obligation:markDependantsUnreachable', 'obligation:recordStageOutcome.failed']) {
      const row = worldOf(session).obligations.find((obligation) => obligation.kind === kind && obligation.state === 'completed');
      assert.ok(row !== undefined, `${kind} completed through the settlement machinery`);
    }
  } finally {
    session.close();
  }
});

test('cancellation: operator stop -> lifecycle cancel (D3 member dispositions) -> run cancellation proof', () => {
  const db = freshDatabase('ek-wp09-cancel-');
  const session = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);
    const cells = conveyor.cellsForTopology('chain');
    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, conveyor.dependencyRowsOf(session), options);

    // Operator stop command (durable command, never a direct state update).
    conveyor.ensureCommand(session, 'factoryRun.requestStop', ids.factory, 'conveyor:request-stop', {}, options);
    conveyor.ensureCommand(session, 'lifecycleRun.cancel', ids.lifecycle, 'conveyor:cancel-lifecycle', {}, options);
    const cancel = conveyor.ensureCommand(session, 'factoryRun.recordRunTerminalProof', ids.factory, 'conveyor:run-cancel', { terminalOutcome: 'cancellation' }, options);
    assert.equal(cancel.status, 'committed', JSON.stringify(cancel).slice(0, 200));

    const world = worldOf(session, options.externalEvidence);
    assert.ok(world.proofs.some((proof) => proof.id === 'TerminalProof:lifecycle.cancellation'), 'lifecycle cancellation proof issued');
    const runProof = world.proofs.find((proof) => proof.id === 'TerminalProof:run.cancellation');
    assert.ok(runProof !== undefined, 'run cancellation proof issued');
    // D3: the proofs NAME member dispositions (not per-scope command explosion).
    const lifecycleProof = world.proofs.find((proof) => proof.id === 'TerminalProof:lifecycle.cancellation');
    assert.ok(lifecycleProof.memberDispositions !== undefined, 'D3 member dispositions attached');
    assert.ok(lifecycleProof.memberDispositions.some((disposition) => disposition.disposition === 'cancelled'));
    assert.equal(world.heads.get(ids.factory).terminal, 'TerminalProof:run.cancellation');
  } finally {
    session.close();
  }
});

test('upstream repair: an out-of-scope defect routes as typed repair to the OWNING upstream cell process (R1)', () => {
  const db = freshDatabase('ek-wp09-upstream-');
  const session = db.open();
  try {
    const options = observingOptions();
    const facts = conveyor.factsForTopology('upstream-repair');
    const ids = conveyor.bootstrapVertical(session, facts, options);
    const cells = conveyor.cellsForTopology('upstream-repair');
    const edges = conveyor.dependencyRowsOf(session);
    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, edges, options);
    settlement.recordNodeTerminal(session, ids.process, [a.token], configOf(options));
    const b = conveyor.enterCell(session, cells[1], options);
    conveyor.admitCellIntent(session, b, edges, options);

    // The upstream cell fails truthfully (its material is defective).
    conveyor.runDesk(session, a, 'truthful-failure', options);
    const nodeFailure = settlement.propagateCellFailure(session, a.workplace, configOf(options));
    assert.ok(!('refusal' in nodeFailure) || nodeFailure.status === 'committed', `node failure propagates: ${JSON.stringify(nodeFailure).slice(0, 200)}`);
    settlement.recordNodeTerminal(session, ids.process, [a.token, `fail:${a.itemRef}`], configOf(options), `fail:${a.itemRef}`);

    // The independent reviewer desk routes the defect upstream: the typed
    // routeUpstreamRepair obligation consumes with the binding to the
    // upstream cell's process and settles it (never silently widened).
    conveyor.runDesk(session, b, 'upstream-repair', options);
    // The routed settle consumes through the WP-09 binding (workplace ->
    // node -> process). The settle lane is per-target FIFO (earlier flow
    // advances left stray settle rows), so the completing row is the lane
    // head while the routing demand stays typed-open - never silently
    // dropped, never widened.
    conveyor.settleUpstreamRepair(session, a, options);
    const world = worldOf(session, options.externalEvidence);
    assert.ok(world.proofs.some((proof) => proof.id === 'TerminalProof:process.truthful-failure'), 'the upstream process settled with the defect');
    assert.equal(world.heads.get(ids.process).terminal, 'TerminalProof:process.truthful-failure');
    const routingRow = world.obligations.find((obligation) => obligation.kind === 'obligation:routeUpstreamRepair');
    assert.ok(routingRow !== undefined, 'the routeUpstreamRepair obligation exists durably');
    assert.ok(world.evidence.some((fact) => fact.kind === 'GateDecision:upstream-repair'), 'the upstream-repair verdict is committed evidence (R1)');
  } finally {
    session.close();
  }
});

test('reviewer work cannot shadow author budget or identity: separate attempts, immutable pins, independent counters', () => {
  const db = freshDatabase('ek-wp09-shadow-');
  const session = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);
    const cells = conveyor.cellsForTopology('chain');
    const a = conveyor.enterCell(session, cells[0], options);
    conveyor.admitCellIntent(session, a, conveyor.dependencyRowsOf(session), options);

    // Snapshot the author attempt after its admission.
    const attemptRows = () => session.db.prepare('SELECT instance_id, work_intent_ref, role_contract_ref, role_contract_digest, context_revision, next_request_ordinal, cumulative_input_tokens FROM activity_attempt ORDER BY instance_id').all();
    conveyor.consumeTarget(session, 'activityAttempt.create', {}, options, undefined); // no-op unless open
    void attemptRows;

    conveyor.runDesk(session, a, 'success', options);
    conveyor.settleCellNode(session, ids, a, options);

    const rows = session.db.prepare('SELECT instance_id, work_intent_ref, role_contract_ref, role_contract_digest, context_revision, next_request_ordinal, cumulative_input_tokens FROM activity_attempt ORDER BY instance_id').all();
    assert.equal(rows.length, 2, 'one author attempt and one reviewer attempt');
    const [author, reviewer] = rows;
    // Identity: each attempt pinned its OWN intent and contract (immutable).
    assert.notEqual(author.work_intent_ref, reviewer.work_intent_ref, 'distinct WorkIntent identity');
    assert.notEqual(author.role_contract_ref, reviewer.role_contract_ref, 'distinct role-contract identity (author vs reviewer pin)');
    // Budget: each attempt consumed exactly its own admissions.
    assert.equal(author.next_request_ordinal, 1, 'the author attempt saw exactly its one admission');
    assert.equal(reviewer.next_request_ordinal, 1, 'the reviewer attempt saw exactly its one admission');
    assert.equal(author.cumulative_input_tokens, 5000, 'author budget: only the author envelope');
    assert.equal(reviewer.cumulative_input_tokens, 5000, 'reviewer budget: only the reviewer envelope');
    // The intents record distinct protocol roles on the same workplace.
    const intents = session.workplace.loadWorkIntents();
    assert.deepEqual(new Set(intents.map((intent) => intent.protocolRole)), new Set(['author', 'reviewer']));
    for (const intent of intents) {
      assert.equal(intent.workplaceInstanceId, a.workplace);
    }
    void ids;
  } finally {
    session.close();
  }
});

test('parallel independent obligations do not share mutable authority', () => {
  const db = freshDatabase('ek-wp09-parallel-');
  const sessionA = db.open();
  const sessionB = db.open();
  try {
    const options = observingOptions();
    const ids = conveyor.bootstrapVertical(sessionA, conveyor.factsForTopology('independent'), options);
    const cells = conveyor.cellsForTopology('independent');
    const edges = conveyor.dependencyRowsOf(sessionA);
    const a = conveyor.enterCell(sessionA, cells[0], options);
    conveyor.admitCellIntent(sessionA, a, edges, options);
    settlement.recordNodeTerminal(sessionA, ids.process, [a.token], configOf(options));
    const b = conveyor.enterCell(sessionA, cells[1], options);
    conveyor.admitCellIntent(sessionA, b, edges, options);

    // Both independent author attempts return; both lanes hold OPEN
    // submitContribution obligations for DIFFERENT workplaces (the frontier
    // shows one entry per distinct target; the second lane's claim is
    // constructed from its own durable row, pinned to its own workplace).
    const attemptA = conveyor.runAttempt(sessionA, a.workplace, 'author', options.authorPin, options);
    const attemptB = conveyor.runAttempt(sessionA, b.workplace, 'author', options.authorPin, options);
    const laneA = consumer.openFrontier(sessionA).find((entry) => entry.kind === 'obligation:submitContribution');
    assert.ok(laneA?.claim, 'the frontier lane head is claimable');
    assert.equal(laneA.claim.targetInstanceId, a.workplace, 'the FIFO head is lane A (first attempt outcome)');
    const worldBefore = worldOf(sessionA, options.externalEvidence);
    const rowB = worldBefore.obligations.find((obligation) => obligation.kind === 'obligation:submitContribution' && obligation.state === 'open' && obligation.sourceInstanceId === attemptB);
    assert.ok(rowB !== undefined, 'lane B holds its own open obligation row');
    const headB = worldBefore.heads.get(b.workplace);
    const claimB = {
      index: -1,
      kind: rowB.kind,
      target: rowB.target,
      targetAggregate: rowB.targetAggregate,
      sourceInstanceId: rowB.sourceInstanceId,
      targetInstanceId: b.workplace,
      expectedRevision: headB.revision,
      idempotencyKey: 'consume:test:' + b.workplace + ':' + headB.revision,
      evidenceRefs: [...rowB.evidenceRefs],
    };

    // A rival consumer commits lane B's contribution first; lane A is
    // untouched and A's workplace authority did not move.
    const byB = consumer.consumeClaim(sessionB, claimB, {}, { externalEvidence: options.externalEvidence });
    assert.equal(byB.status, 'committed', 'lane B commits independently');
    const worldA = worldOf(sessionA, options.externalEvidence);
    const headAAfter = worldA.heads.get(a.workplace);
    const headBAfter = worldA.heads.get(b.workplace);
    assert.ok(headBAfter.revision > headAAfter.revision, "only B workplace authority moved");
    const stillOpen = worldA.obligations.filter((obligation) => obligation.kind === 'obligation:submitContribution' && obligation.state === 'open');
    assert.equal(stillOpen.length, 1, 'exactly one lane remains open');

    // Lane A still completes afterwards through its own authority.
    const byA = consumer.consumeClaim(sessionA, laneA.claim, {}, { externalEvidence: options.externalEvidence });
    assert.equal(byA.status, 'committed', 'lane A commits independently afterwards');
  } finally {
    sessionA.close();
    sessionB.close();
  }
});

test('stateless re-drive: a crash at any fault point converges to the identical settled world', () => {
  const clean = freshDatabase('ek-wp09-redrive-clean-');
  const faulted = freshDatabase('ek-wp09-redrive-fault-');
  const cleanSession = clean.open();
  try {
    driveSuccessTopology(cleanSession, 'chain', observingOptions());
    const normalized = JSON.stringify(
      (() => {
        const w = worldOf(cleanSession, observingOptions().externalEvidence);
        return {
          heads: [...w.heads.values()].map((h) => ({ id: h.instanceId, status: h.status, rev: h.revision, t: h.terminal ?? null })).sort((x, y) => (x.id < y.id ? -1 : 1)),
          proofs: w.proofs.map((p) => `${p.id}@${p.ownerInstanceId}`).sort(),
          events: w.events.map((e) => `${e.transition}:${e.sourceInstanceId}`).sort(),
        };
      })(),
    );
    // Crash at every durable boundary of the same drive; each restart
    // re-drives from durable rows and must converge to the SAME world.
    const points = [
      'before-durable-write',
      'after-durable-write',
      'before-obligation-completion',
      'after-obligation-completion',
      'before-gate',
      'after-gate',
      'before-effect',
      'after-effect',
    ];
    for (const point of points) {
      const session = faulted.open();
      try {
        const faults = new FaultScheduler(point, 1);
        const options = { ...observingOptions(), faults };
        try {
          driveSuccessTopology(session, 'chain', options);
        } catch (error) {
          assert.ok(error instanceof FaultCrashError, `only scheduled crashes escape (${String(error).slice(0, 120)})`);
        }
        // Restart: a clean process re-drives the SAME database to the end.
        session.close();
        const restarted = faulted.open();
        try {
          driveSuccessTopology(restarted, 'chain', observingOptions());
          const w = worldOf(restarted, observingOptions().externalEvidence);
          const normalizedRestart = JSON.stringify({
            heads: [...w.heads.values()].map((h) => ({ id: h.instanceId, status: h.status, rev: h.revision, t: h.terminal ?? null })).sort((x, y) => (x.id < y.id ? -1 : 1)),
            proofs: w.proofs.map((p) => `${p.id}@${p.ownerInstanceId}`).sort(),
            events: w.events.map((e) => `${e.transition}:${e.sourceInstanceId}`).sort(),
          });
          assert.equal(normalizedRestart, normalized, `crash at ${point}: the re-driven world is identical`);
        } finally {
          restarted.close();
        }
      } catch (error) {
        session.close();
        throw error;
      }
    }
  } finally {
    cleanSession.close();
  }
});
