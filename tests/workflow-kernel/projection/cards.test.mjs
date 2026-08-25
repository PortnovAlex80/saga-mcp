/**
 * cards.test.mjs - WP-10: the Kanban projection over authoritative facts.
 *
 * Proves every lane of the board is a HUMAN VIEW derived from committed
 * facts: todo (planned, no workplace), in-progress (author chain / effect
 * chain), review (reviewer desk), waiting (pending typed waits with exact
 * wake sources), repair (repair-family statuses) and terminal (exact
 * proofs); plus the pinned role-contract and prompt-receipt references the
 * operator UI displays (never selects).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conveyor,
  freshProjection,
  observingOptions,
} from './support.mjs';

const { refreshProjection, projectKanban } = await import('../../../dist/workflow-kernel/projection/projector.js');

/** Step the desk of one workplace through the frontier lane of one target command. */
function step(session, options, target, invocation = {}, pinned) {
  const result = conveyor.consumeTarget(session, target, invocation, options, pinned);
  if ('status' in result && result.status === 'refused') {
    throw new Error(`step ${target} refused: ${result.refusal.reason}: ${result.refusal.detail}`);
  }
  return result;
}

/** Apply one exempt command driver-direct through its owning repository. */
function direct(session, options, command, instanceId, key, fields = {}) {
  const result = conveyor.ensureCommand(session, command, instanceId, key, fields, options);
  if (result.status === 'refused') {
    throw new Error(`direct ${command} refused: ${result.refusal.reason}: ${result.refusal.detail}`);
  }
  return result;
}

test('todo cards: planned items with no workplace project to todo with readiness over authoritative predecessor evidence', async () => {
  const { open } = freshProjection('ek-wp10-cards-todo-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);

  const written = refreshProjection(session, store);
  assert.equal(written, 3, 'three planned work items project to three cards');
  const rows = store.all();
  assert.deepEqual(rows.map((row) => row.lane), ['todo', 'todo', 'todo']);
  const image = projectKanban(session);
  for (const card of image.cards) {
    assert.equal(card.workplaceInstanceId, null, 'no workplace materialized yet');
    assert.equal(card.terminalProof, null);
    assert.equal(card.pinnedRoleContracts.length, 0);
    // Chain topology: 'a' has no predecessors (ready), 'b' waits on 'a', 'c' on 'b'.
    if (card.workItemRef === 'a') assert.equal(card.readiness.state, 'ready');
    if (card.workItemRef === 'b') assert.equal(card.readiness.state, 'waiting');
    if (card.workItemRef === 'c') assert.equal(card.readiness.state, 'waiting');
  }
  session.close();
});

test('in-progress: a materialized workplace on the author chain projects in-progress and displays the pinned contract + prompt receipts', async () => {
  const { open } = freshProjection('ek-wp10-cards-progress-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cells = conveyor.cellsForTopology('independent');
  const cellA = conveyor.enterCell(session, cells[0], options);

  refreshProjection(session, store);
  let card = projectKanban(session).cards.find((entry) => entry.workItemRef === 'a');
  assert.equal(card.lane, 'in-progress');
  assert.equal(card.workplaceStatus, 'materialized');
  assert.ok(card.workplaceInstanceId.startsWith('workplace:'));

  // Claim (intent admission) + one cognition attempt round.
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  conveyor.runAttempt(session, cellA.workplace, 'author', options.authorPin, options);
  refreshProjection(session, store);
  card = projectKanban(session).cards.find((entry) => entry.workItemRef === 'a');
  assert.equal(card.workplaceStatus, 'author-intent-admitted');
  assert.equal(card.pinnedRoleContracts.length, 1, 'the admitted author intent pin is displayed');
  assert.equal(card.pinnedRoleContracts[0].protocolRole, 'author');
  assert.match(card.pinnedRoleContracts[0].roleContractRef, /^sha256:[0-9a-f]{64}$/);
  assert.ok(card.promptReceiptRefs.length >= 1, 'the attempt prompt receipts are displayed for diagnosis');
  assert.match(card.promptReceiptRefs[0].receiptRef, /^prompt-receipt:activity-attempt:/);

  // The author chain: contribution -> seal -> candidates -> gate accepted.
  step(session, options, 'workplace.recordContribution', {}, cellA.workplace);
  step(session, options, 'workplace.sealProductionRevision', {}, cellA.workplace);
  step(session, options, 'workplace.presentCandidateSet', {}, cellA.workplace);
  refreshProjection(session, store);
  card = projectKanban(session).cards.find((entry) => entry.workItemRef === 'a');
  assert.equal(card.lane, 'in-progress');
  assert.ok(card.evidence.productionRevisionRefs.length >= 1, 'the sealed production revision (ADR-053 authority) is shown as evidence');
  assert.ok(card.evidence.candidateSetRefs.length >= 1);
  session.close();
});

test('review: the reviewer desk owns the card while reviewer statuses hold', async () => {
  const { open } = freshProjection('ek-wp10-cards-review-');
  const { session, store } = open();
  const options = observingOptions();
  conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  conveyor.runAttempt(session, cellA.workplace, 'author', options.authorPin, options);
  step(session, options, 'workplace.recordContribution', {}, cellA.workplace);
  step(session, options, 'workplace.sealProductionRevision', {}, cellA.workplace);
  step(session, options, 'workplace.presentCandidateSet', {}, cellA.workplace);
  step(session, options, 'workplace.runAuthorGate', { gateVerdict: 'accepted' }, cellA.workplace);

  refreshProjection(session, store);
  let card = projectKanban(session).cards.find((entry) => entry.workItemRef === 'a');
  assert.equal(card.lane, 'review', 'author-gate-decided opens the reviewer desk');

  // The reviewer round: intent + attempt + desk steps keep the card in review.
  conveyor.ensureCommand(
    session,
    'workplace.admitWorkIntent',
    cellA.workplace,
    `test:admit-reviewer:${cellA.itemRef}`,
    { protocolRole: 'reviewer', rolePin: options.reviewerPin, evidenceRefs: [cellA.itemInstanceId] },
    options,
  );
  conveyor.runAttempt(session, cellA.workplace, 'reviewer', options.reviewerPin, options);
  step(session, options, 'workplace.recordContribution', {}, cellA.workplace);
  step(session, options, 'workplace.sealProductionRevision', {}, cellA.workplace);
  step(session, options, 'workplace.presentCandidateSet', {}, cellA.workplace);
  refreshProjection(session, store);
  card = projectKanban(session).cards.find((entry) => entry.workItemRef === 'a');
  assert.equal(card.lane, 'review');
  assert.equal(card.pinnedRoleContracts.length, 2, 'author + reviewer pins are both displayed');
  session.close();
});

test('waiting: an uncertain effect projects waiting with the exact typed wait and its D12 wake source', async () => {
  const { open } = freshProjection('ek-wp10-cards-waiting-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const descriptors = conveyor.cellsForTopology('independent');

  // Complete cell A fully so the flow advances and cell B can enter.
  const cellA = conveyor.enterCell(session, descriptors[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  conveyor.runDesk(session, cellA, 'success', options);
  conveyor.settleCellNode(session, ids, cellA, options);

  // Drive cell B to an accepted final gate, then settle the effect UNKNOWN.
  const cellB = conveyor.enterCell(session, descriptors[1], options);
  conveyor.admitCellIntent(session, cellB, conveyor.dependencyRowsOf(session), options);
  conveyor.runAttempt(session, cellB.workplace, 'author', options.authorPin, options);
  step(session, options, 'workplace.recordContribution', {}, cellB.workplace);
  step(session, options, 'workplace.sealProductionRevision', {}, cellB.workplace);
  step(session, options, 'workplace.presentCandidateSet', {}, cellB.workplace);
  step(session, options, 'workplace.runAuthorGate', { gateVerdict: 'accepted' }, cellB.workplace);
  direct(
    session,
    options,
    'workplace.admitWorkIntent',
    cellB.workplace,
    `test:admit-reviewer:${cellB.itemRef}`,
    { protocolRole: 'reviewer', rolePin: options.reviewerPin, evidenceRefs: [cellB.itemInstanceId] },
  );
  conveyor.runAttempt(session, cellB.workplace, 'reviewer', options.reviewerPin, options);
  step(session, options, 'workplace.recordContribution', {}, cellB.workplace);
  step(session, options, 'workplace.sealProductionRevision', {}, cellB.workplace);
  step(session, options, 'workplace.presentCandidateSet', {}, cellB.workplace);
  step(session, options, 'workplace.runFinalGate', { gateVerdict: 'accepted' }, cellB.workplace);
  step(session, options, 'workplace.settleEffect', { effectOutcome: 'unknown' }, cellB.workplace);

  refreshProjection(session, store);
  const card = projectKanban(session).cards.find((entry) => entry.workItemRef === 'b');
  assert.equal(card.lane, 'waiting');
  assert.equal(card.workplaceStatus, 'effect-uncertainty-waited');
  assert.equal(card.pendingWaits.length, 1);
  assert.equal(card.pendingWaits[0].kind, 'TypedWait:effect-uncertainty');
  assert.ok(card.pendingWaits[0].wakeCommands.includes('workplace.resolveHumanResponse'), 'the D12 operator disposition command is the exact wake source');

  // The operator resolves; the card leaves waiting through the command, never a lane write.
  direct(session, options, 'workplace.resolveHumanResponse', cellB.workplace, `test:resolve:${cellB.itemRef}`);
  refreshProjection(session, store);
  const resolved = projectKanban(session).cards.find((entry) => entry.workItemRef === 'b');
  assert.notEqual(resolved.lane, 'waiting');
  session.close();
});

test('repair: a repair verdict followed by enterRepairWait projects the repair lane', async () => {
  const { open } = freshProjection('ek-wp10-cards-repair-');
  const { session, store } = open();
  const options = observingOptions();
  conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  conveyor.runAttempt(session, cellA.workplace, 'author', options.authorPin, options);
  step(session, options, 'workplace.recordContribution', {}, cellA.workplace);
  step(session, options, 'workplace.sealProductionRevision', {}, cellA.workplace);
  step(session, options, 'workplace.presentCandidateSet', {}, cellA.workplace);
  step(session, options, 'workplace.runAuthorGate', { gateVerdict: 'accepted' }, cellA.workplace);
  conveyor.ensureCommand(
    session,
    'workplace.admitWorkIntent',
    cellA.workplace,
    `test:admit-reviewer:${cellA.itemRef}`,
    { protocolRole: 'reviewer', rolePin: options.reviewerPin, evidenceRefs: [cellA.itemInstanceId] },
    options,
  );
  conveyor.runAttempt(session, cellA.workplace, 'reviewer', options.reviewerPin, options);
  step(session, options, 'workplace.recordContribution', {}, cellA.workplace);
  step(session, options, 'workplace.sealProductionRevision', {}, cellA.workplace);
  step(session, options, 'workplace.presentCandidateSet', {}, cellA.workplace);
  step(session, options, 'workplace.runFinalGate', { gateVerdict: 'repair' }, cellA.workplace);
  direct(session, options, 'workplace.enterRepairWait', cellA.workplace, `test:repair-wait:${cellA.itemRef}`);

  refreshProjection(session, store);
  const card = projectKanban(session).cards.find((entry) => entry.workItemRef === 'a');
  assert.equal(card.lane, 'repair');
  assert.equal(card.workplaceStatus, 'repair-wait-entered');
  assert.ok(card.evidence.gateDecisionRefs.length >= 1, 'the repair verdict evidence is displayed');
  session.close();
});

test('terminal: the run-terminal workplace proof projects the terminal lane with its exact proof and closure', async () => {
  const { open } = freshProjection('ek-wp10-cards-terminal-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cells = [];
  for (const descriptor of conveyor.cellsForTopology('independent')) {
    const cell = conveyor.enterCell(session, descriptor, options);
    conveyor.admitCellIntent(session, cell, conveyor.dependencyRowsOf(session), options);
    conveyor.runDesk(session, cell, 'success', options);
    conveyor.settleCellNode(session, ids, cell, options);
    cells.push(cell);
  }
  conveyor.settleSuccessLadder(session, ids, options);

  refreshProjection(session, store);
  const image = projectKanban(session);
  for (const card of image.cards) {
    assert.equal(card.lane, 'terminal');
    assert.ok(card.terminalProof !== null, 'the card shows the exact terminal proof');
    assert.ok(card.terminalProof.evidenceClosure.length >= 1, 'the proof closure is displayed');
    assert.ok(card.evidence.cellFinalAcceptanceRefs.length >= 1, 'the D11 acceptance evidence is displayed');
  }
  const rows = store.all();
  assert.equal(rows.filter((row) => row.lane === 'terminal').length, image.cards.length);
  session.close();
});
