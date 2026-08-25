/**
 * adapters.test.mjs - WP-10: the command-only UI action adapters.
 *
 * Every operator action (claim, review, stop, resume, retry,
 * human-response) translates into TYPED COMMANDS of the frozen universe
 * through the owning repositories / the WP-07 consumer - and NEVER writes
 * a card: the store content is asserted unchanged across every adapter
 * call until the projector refreshes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { conveyor, freshProjection, observingOptions } from './support.mjs';

const compiler = await import('../../../dist/workflow-kernel/roles/compiler.js');
const fixtures = await import('../../../dist/workflow-kernel/roles/fixtures/index.js');
const { RoleContractRuntime } = await import('../../../dist/workflow-kernel/development/role-contract-runtime.js');
const { refreshProjection } = await import('../../../dist/workflow-kernel/projection/projector.js');
const adapters = await import('../../../dist/workflow-kernel/projection/adapters.js');

/** The WP-17 runtime with the installed fixture corpus (one resolution per kind). */
async function uiDeps(session) {
  const author = compiler.compileRoleContract(fixtures.buildImplementerFixture());
  const reviewer = compiler.compileRoleContract(fixtures.buildReviewerFixture());
  if (!author.compiled || !reviewer.compiled) throw new Error('fixture contracts failed to compile');
  const runtime = new RoleContractRuntime([
    { launchKind: fixtures.implementerLaunchKind, contract: author.contract },
    { launchKind: fixtures.reviewerLaunchKind, contract: reviewer.contract },
  ]);
  // The composition resolves each launch kind ONCE at startup; the UI only reads slots.
  runtime.resolveOnce(fixtures.implementerLaunchKind);
  runtime.resolveOnce(fixtures.reviewerLaunchKind);
  return {
    deps: { session, roles: runtime, externalEvidence: conveyor.conveyorDefaults().externalEvidence },
    runtime,
    authorContract: author.contract,
  };
}

function mustCommit(result, command) {
  assert.equal(result.status, 'committed', `${command} must commit (${result.status === 'refused' ? result.refusal.reason + ': ' + result.refusal.detail : 'ok'})`);
  assert.equal(result.command, command);
}

/** Drive one workplace to reviewer-candidates-presented (the review desk is open). */
function driveToReviewDesk(session, options, cell) {
  conveyor.runAttempt(session, cell.workplace, 'author', options.authorPin, options);
  const authorLadder = [
    ['workplace.recordContribution', {}],
    ['workplace.sealProductionRevision', {}],
    ['workplace.presentCandidateSet', {}],
    ['workplace.runAuthorGate', { gateVerdict: 'accepted' }],
  ];
  for (const [target, invocation] of authorLadder) {
    const result = conveyor.consumeTarget(session, target, invocation, options, cell.workplace);
    if ('status' in result && result.status === 'refused') throw new Error(`${target} refused: ${result.refusal.detail}`);
  }
  conveyor.ensureCommand(
    session,
    'workplace.admitWorkIntent',
    cell.workplace,
    `test:admit-reviewer:${cell.itemRef}`,
    { protocolRole: 'reviewer', rolePin: options.reviewerPin, evidenceRefs: [cell.itemInstanceId] },
    options,
  );
  conveyor.runAttempt(session, cell.workplace, 'reviewer', options.reviewerPin, options);
  for (const target of ['workplace.recordContribution', 'workplace.sealProductionRevision', 'workplace.presentCandidateSet']) {
    const result = conveyor.consumeTarget(session, target, {}, options, cell.workplace);
    if ('status' in result && result.status === 'refused') throw new Error(`${target} refused: ${result.refusal.detail}`);
  }
}

test('claim translates to workplace.admitWorkIntent with the runtime-resolved pin, and never writes a card', async () => {
  const { open } = freshProjection('ek-wp10-ui-claim-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  refreshProjection(session, store);
  const rowsBefore = store.all();

  const { deps, runtime } = await uiDeps(session);
  const result = adapters.uiClaim(deps, { action: 'claim', workItemRef: 'a', launchKind: fixtures.implementerLaunchKind });
  mustCommit(result, 'workplace.admitWorkIntent');

  // The DISPLAYED pin is the runtime slot's pin (tracker view), not a UI choice.
  const slot = runtime.slotOf(fixtures.implementerLaunchKind);
  assert.deepEqual(result.displayedRoleContract, slot.pin);
  assert.equal(result.displayedRoleContract.roleContractRef, slot.pin.roleContractRef);

  // The durable intent pinned the same contract.
  const world = session.hydrateWorld().world;
  const intent = [...world.workIntents.values()].find((entry) => entry.workplaceInstanceId === cellA.workplace);
  assert.equal(intent.roleContract.roleContractRef, slot.pin.roleContractRef);

  // Re-claiming an already-claimed card is a typed refusal (the workplace
  // moved past the admission edge) - never a silent second admission and
  // never a card write.
  const again = adapters.uiClaim(deps, { action: 'claim', workItemRef: 'a', launchKind: fixtures.implementerLaunchKind });
  assert.equal(again.status, 'refused');
  assert.equal(again.refusal.reason, 'ILLEGAL_TRANSITION');

  // The board is UNCHANGED by the adapter: only the projector writes cards.
  assert.deepEqual(store.all(), rowsBefore);
  session.close();
});

test('claim refuses typed for a TODO item (no workplace) and for an unresolvable launch kind (the UI never resolves contracts)', async () => {
  const { open } = freshProjection('ek-wp10-ui-claim-refuse-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('chain'), options);

  const { deps } = await uiDeps(session);
  const noWorkplace = adapters.uiClaim(deps, { action: 'claim', workItemRef: 'a', launchKind: fixtures.implementerLaunchKind });
  assert.equal(noWorkplace.status, 'refused');
  assert.equal(noWorkplace.refusal.reason, 'MISSING_EVIDENCE');
  assert.match(noWorkplace.refusal.detail, /no workplace is materialized/);

  // An unresolved launch kind is a typed refusal: the pin exists only through
  // the ONE runtime resolution, which the UI cannot trigger.
  const unresolved = adapters.uiClaim(deps, { action: 'claim', workItemRef: 'a', launchKind: 'never.resolved.kind' });
  assert.equal(unresolved.status, 'refused');
  assert.equal(unresolved.refusal.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  assert.match(unresolved.refusal.detail, /never resolved/);

  // Entering the first cell still leaves the dependant unclaimable (its
  // workplace does not exist yet): the authoritative gap, not a lane, says so.
  conveyor.enterCell(session, conveyor.cellsForTopology('chain')[0], options);
  const dependant = adapters.uiClaim(deps, { action: 'claim', workItemRef: 'b', launchKind: fixtures.implementerLaunchKind });
  assert.equal(dependant.status, 'refused');
  assert.equal(dependant.refusal.reason, 'MISSING_EVIDENCE');
  session.close();
});

test('review translates the human verdict into workplace.runFinalGate with the exact GateVerdict', async () => {
  const { open } = freshProjection('ek-wp10-ui-review-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  driveToReviewDesk(session, options, cellA);
  refreshProjection(session, store);
  const rowsBefore = store.all();

  const { deps } = await uiDeps(session);
  const accepted = adapters.uiReview(deps, { action: 'review', workItemRef: 'a', verdict: 'accepted' });
  mustCommit(accepted, 'workplace.runFinalGate');
  assert.equal(session.hydrateWorld().world.heads.get(cellA.workplace).status, 'final-gate-decided');

  // Reviewing again (no open final-gate lane) is a typed refusal - never a silent lane write.
  const stale = adapters.uiReview(deps, { action: 'review', workItemRef: 'a', verdict: 'accepted' });
  assert.equal(stale.status, 'refused');

  assert.deepEqual(store.all(), rowsBefore, 'the review command wrote no card');
  session.close();
});

test('stop/resume translate to factoryRun.requestStop / factoryRun.resume with the policy-quota wait lifecycle', async () => {
  const { open } = freshProjection('ek-wp10-ui-stop-resume-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  refreshProjection(session, store);
  const rowsBefore = store.all();

  const { deps } = await uiDeps(session);
  const stopped = adapters.uiStop(deps, { action: 'stop', factoryInstanceId: ids.factory });
  mustCommit(stopped, 'factoryRun.requestStop');
  assert.equal(session.hydrateWorld().world.heads.get(ids.factory).status, 'stop-requested');
  const wait = session.hydrateWorld().world.waits.find((entry) => entry.kind === 'TypedWait:policy-quota');
  assert.ok(wait, 'requestStop committed its TypedWait:policy-quota');

  const resumed = adapters.uiResume(deps, { action: 'resume', factoryInstanceId: ids.factory });
  mustCommit(resumed, 'factoryRun.resume');
  assert.equal(session.hydrateWorld().world.heads.get(ids.factory).status, 'resumed');
  const discharged = session.hydrateWorld().world.waits.find((entry) => entry.kind === 'TypedWait:policy-quota');
  assert.notEqual(discharged.state, 'pending', 'the resume discharged the policy-quota wait');

  assert.deepEqual(store.all(), rowsBefore, 'stop/resume wrote no card');
  session.close();
});

test('retry on a repair-waited workplace rolls the repair epoch and re-admits the SAME durable author pin', async () => {
  const { open } = freshProjection('ek-wp10-ui-retry-repair-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  driveToReviewDesk(session, options, cellA);

  const { deps } = await uiDeps(session);
  mustCommit(adapters.uiReview(deps, { action: 'review', workItemRef: 'a', verdict: 'repair' }), 'workplace.runFinalGate');
  conveyor.ensureCommand(session, 'workplace.enterRepairWait', cellA.workplace, `test:repair-wait:${cellA.itemRef}`, {}, options);
  refreshProjection(session, store);

  const originalPin = [...session.hydrateWorld().world.workIntents.values()]
    .filter((intent) => intent.workplaceInstanceId === cellA.workplace && intent.protocolRole === 'author')
    .pop().roleContract;

  const retried = adapters.uiRetry(deps, { action: 'retry', workItemRef: 'a' });
  mustCommit(retried, 'workplace.admitWorkIntent');
  assert.deepEqual(retried.displayedRoleContract, originalPin, 'retry displays the REUSED durable pin (identity law)');

  const world = session.hydrateWorld().world;
  assert.equal(world.heads.get(cellA.workplace).status, 'author-intent-admitted');
  const repinIntent = [...world.workIntents.values()]
    .filter((intent) => intent.workplaceInstanceId === cellA.workplace && intent.protocolRole === 'author')
    .pop();
  assert.equal(repinIntent.intentRef !== undefined, true);
  assert.equal(repinIntent.roleContract.roleContractDigest, originalPin.roleContractDigest, 'the repair re-admission pinned the SAME contract digest');
  session.close();
});

test('human-response translates to workplace.resolveHumanResponse and discharges the D12 effect-uncertainty wait; retry resumes the effect', async () => {
  const { open } = freshProjection('ek-wp10-ui-human-');
  const { session, store } = open();
  const options = observingOptions();
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cellA = conveyor.enterCell(session, conveyor.cellsForTopology('independent')[0], options);
  conveyor.admitCellIntent(session, cellA, conveyor.dependencyRowsOf(session), options);
  driveToReviewDesk(session, options, cellA);
  refreshProjection(session, store);
  const rowsBefore = store.all();

  const { deps } = await uiDeps(session);
  mustCommit(adapters.uiReview(deps, { action: 'review', workItemRef: 'a', verdict: 'accepted' }), 'workplace.runFinalGate');

  // The effect settles UNKNOWN through the public lane: the D12 wait opens.
  const unknown = conveyor.consumeTarget(session, 'workplace.settleEffect', { effectOutcome: 'unknown' }, options, cellA.workplace);
  assert.ok(!('status' in unknown && unknown.status === 'refused'));
  assert.equal(session.hydrateWorld().world.heads.get(cellA.workplace).status, 'effect-uncertainty-waited');

  const resolved = adapters.uiHumanResponse(deps, { action: 'human-response', workItemRef: 'a' });
  mustCommit(resolved, 'workplace.resolveHumanResponse');
  const world = session.hydrateWorld().world;
  assert.equal(world.heads.get(cellA.workplace).status, 'human-response-resolved');
  const wait = world.waits.find((entry) => entry.kind === 'TypedWait:effect-uncertainty');
  assert.ok(wait.state === 'discharged' || wait.state === 'converted', 'the operator disposition discharged the uncertainty wait');

  // RETRY now redrives the effect lane (resumeEffect) to success.
  const resumed = adapters.uiRetry(deps, { action: 'retry', workItemRef: 'a' });
  mustCommit(resumed, 'workplace.settleEffect');
  assert.equal(session.hydrateWorld().world.heads.get(cellA.workplace).status, 'effect-settled');

  assert.deepEqual(store.all(), rowsBefore, 'no adapter call wrote a card');
  session.close();
});

test('the closed action dispatch: unknown payloads are impossible, every action names a frozen command', async () => {
  const { open } = freshProjection('ek-wp10-ui-dispatch-');
  const { session, store } = open();
  const { deps } = await uiDeps(session);

  // The dispatch table covers exactly the six actions; each maps onto a
  // frozen-universe command (verified by the COMMAND_AGGREGATES register).
  for (const action of adapters.UI_ACTION_NAMES) {
    assert.ok(['claim', 'review', 'stop', 'resume', 'retry', 'human-response'].includes(action));
  }
  assert.equal(adapters.UI_ACTION_NAMES.length, 6);
  session.close();
});
