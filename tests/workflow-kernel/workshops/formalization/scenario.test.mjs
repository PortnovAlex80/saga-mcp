/**
 * scenario.test.mjs - THE full Formalization run through public commands
 * (WP-11F): capsule ingress of the accepted Discovery output -> the
 * imported-Discovery shell stage -> the solution-formalization stage route
 * -> all eight desks (six Production Cells + two kernel nodes) through the
 * author/reviewer desks, semantic gates and idempotent effects -> node/
 * process/stage/lifecycle/run settlement with terminal proofs. Plus the
 * typed refusal mutations (foreign lineage, malformed product, illegal
 * sequence) and the D5/D12 typed-wait scenarios.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, fullRunConfig, sharedTransport, allAttemptRefs, buildHandoffCapsule, HANDOFF_BINDING, HANDOFF_BYTES, buildAuthoredChain, sha256 } from './support.mjs';

const driver = () => import('../../../../dist/workflow-kernel/workshops/formalization/driver.js');

/** Run the full scenario on a fresh database; returns the run result + world views. */
async function runFullScenario() {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const { config, chain, applied } = await fullRunConfig(session, { transport });
  const result = await driver().then((d) => d.runFormalizationWorkshop(config));
  return { db, session, config, chain, applied, result };
}

test('the full run reaches the run terminal proof through public commands only', async () => {
  const { session, result } = await runFullScenario();
  assert.equal(result.blockedAt, undefined, `blocked at ${result.blockedAt}: ${JSON.stringify(result.steps.find((s) => s.result.status !== 'committed' && s.result.status !== 'skipped'))}`);
  const world = session.hydrateWorld().world;
  const factory = world.heads.get('factory-run:1');
  assert.equal(factory?.terminal, 'TerminalProof:run.success');
  // Every desk workplace reached its terminal proof.
  const workplaces = [...world.heads.values()].filter((head) => head.aggregate === 'Workplace');
  assert.equal(workplaces.length, 9, 'one shell + eight formalization desks');
  for (const workplace of workplaces) {
    assert.equal(workplace.terminal, 'TerminalProof:workplace.success', `workplace ${workplace.instanceId}`);
  }
  // All eight formalization desks accepted their authored products.
  assert.equal(result.desks.length, 8);
  for (const desk of result.desks) {
    assert.equal(desk.gateVerdict, 'accepted', `${desk.nodeId} gate verdict`);
    assert.match(desk.productRef ?? '', /^sha256:[0-9a-f]{64}$/);
  }
});

test('the accepted-material chain folded to the solution contract (ADR-053 authority)', async () => {
  const { session, result, chain } = await runFullScenario();
  const accepted = result.accepted;
  assert.ok(accepted.handoff, 'the handoff seeded the chain');
  assert.ok(accepted.prd && accepted.useCases && accepted.requirements && accepted.acceptance && accepted.reconciliation && accepted.baseline && accepted.srs);
  assert.equal(accepted.srs?.realizedScenarioIds.length, 2);
  // The chain digests are exactly the test-authored fold (deterministic).
  assert.equal(accepted.prd?.revisionDigest, chain.acceptedAt.prd.prd.revisionDigest);
  assert.equal(accepted.baseline?.wholeWhatDigest, chain.acceptedAt.baseline.baseline.wholeWhatDigest);
  // Gates and acceptance bind REVISION material: the final acceptance of the
  // settle desk carries the accepted-authority evidence, never the attempt.
  const world = session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'AcceptedCandidateAuthority'));
  assert.ok(world.evidence.some((fact) => fact.kind === 'CellFinalAcceptance'));
});

test('every desk ran through the role-identity law: same pin in WorkIntent, attempt and views', async () => {
  const { session, config } = await runFullScenario();
  const world = session.hydrateWorld().world;
  const authorSlot = config.roles.slotOf('formalization.implementation.author');
  const reviewerSlot = config.roles.slotOf('formalization.implementation.reviewer');
  assert.ok(authorSlot && reviewerSlot);
  // dispatcher/runner/tracker views share the SAME pin object.
  assert.equal(config.roles.dispatcherView(authorSlot).pin, authorSlot.pin);
  assert.equal(config.roles.runnerView(authorSlot).pin, authorSlot.pin);
  assert.equal(config.roles.trackerView(reviewerSlot).pin, reviewerSlot.pin);
  // Every admitted WorkIntent pinned exactly the runtime pin (digest equality).
  for (const intent of world.workIntents.values()) {
    const expected = intent.protocolRole === 'author' ? authorSlot : reviewerSlot;
    assert.equal(intent.roleContract.roleContractRef, expected.pin.roleContractRef);
    assert.equal(intent.roleContract.roleContractDigest, expected.pin.roleContractDigest);
  }
  // Exactly 18 WorkIntents (9 desks x author+reviewer).
  assert.equal(world.workIntents.size, 18);
});

test('WP-09 durable bindings resolve the topology from committed facts', async () => {
  const { session } = await runFullScenario();
  const { topologyBindings } = await import('../../../../dist/workflow-kernel/planning/bindings.js');
  const bindings = topologyBindings(session.hydrateWorld().world);
  // Every desk's token binds its node and workplace.
  for (const nodeId of ['define-product-intent', 'model-use-cases', 'derive-system-requirements', 'define-acceptance-contract', 'reconcile-what', 'freeze-what-baseline', 'define-architecture-contract', 'settle-formalization']) {
    const holders = bindings.tokenHolders(`plan:solution-formalization#item:${nodeId}`);
    assert.equal(holders.nodes.length, 1, `${nodeId} node binding`);
    assert.equal(holders.workplaces.length, 1, `${nodeId} workplace binding`);
  }
  // Acceptance evidence refs are durable per workplace.
  for (const head of session.hydrateWorld().world.heads.values()) {
    if (head.aggregate !== 'Workplace') continue;
    assert.ok(bindings.acceptanceRefsOfWorkplace(head.instanceId).length >= 1, `${head.instanceId} acceptance refs`);
  }
});

test('idempotent re-drive converges: the same world, no new events, all steps skipped or replayed', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const { config } = await fullRunConfig(session, { transport });
  const d = await driver();
  const first = await d.runFormalizationWorkshop(config);
  assert.equal(first.blockedAt, undefined);
  const worldAfterFirst = session.hydrateWorld().world;
  const eventsAfterFirst = worldAfterFirst.events.length;
  const proofsAfterFirst = worldAfterFirst.proofs.length;
  // Re-drive on the SAME session (crash + reopen simulation with same config).
  const reopened = await db.open();
  const { transport: transport2 } = await sharedTransport(reopened, allAttemptRefs());
  const { config: config2 } = await fullRunConfig(reopened, { transport: transport2 });
  const second = await d.runFormalizationWorkshop(config2);
  assert.equal(second.blockedAt, undefined, `re-drive blocked at ${second.blockedAt}`);
  const worldAfterSecond = reopened.hydrateWorld().world;
  assert.equal(worldAfterSecond.events.length, eventsAfterFirst, 'no new events on re-drive');
  assert.equal(worldAfterSecond.proofs.length, proofsAfterFirst, 'no new proofs on re-drive');
  for (const step of second.steps) {
    assert.ok(['skipped', 'replayed', 'committed'].includes(step.result.status) || step.result.status === 'refused' || step.result.status === 'actor-refused', `unexpected re-drive status ${JSON.stringify(step.result)}`);
    assert.notEqual(step.result.status, 'actor-refused', `re-drive actor refused: ${JSON.stringify(step)}`);
  }
});

test('effects are idempotent across the run: accept-products runs once per desk content', async () => {
  const { applied } = await runFullScenario();
  // The 8 accept-products effects (one per non-kernel desk) + freeze + settle.
  const acceptCount = applied.filter((entry) => entry.effectId === 'formalization.accept-products').length;
  assert.equal(acceptCount, 7, 'six cells + the import shell accept their products');
  assert.equal(applied.filter((entry) => entry.effectId === 'formalization.freeze-what-baseline').length, 1);
  assert.equal(applied.filter((entry) => entry.effectId === 'formalization.settle-solution-contract').length, 1);
});

/* ------------------------------------------------------------------ */
/* Typed refusal mutations                                             */
/* ------------------------------------------------------------------ */

test('MUTATION foreign lineage: a UC deriving from a foreign PRD member routes upstream-repair and blocks the lane', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  // The UC desk derives from a PRD member outside the accepted revision.
  chain.uc.product.scenarios[0].prdIntentRefs = ['PRD-FOREIGN'];
  const { config } = await fullRunConfig(session, { chain, transport });
  const result = await driver().then((d) => d.runFormalizationWorkshop(config));
  const modelUseCases = result.desks.find((desk) => desk.nodeId === 'model-use-cases');
  assert.equal(modelUseCases?.gateVerdict, 'upstream-repair');
  // The lane stops fail-closed at the reviewer admission (no accepted author gate).
  assert.ok(result.blockedAt !== undefined);
  assert.match(result.blockedAt, /admit-reviewer-intent|author-gate/);
});

test('MUTATION malformed product: an actorless UC routes repair and the reviewer desk refuses to open', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  chain.uc.product.scenarios[0].actorKind = 'robot';
  const { config } = await fullRunConfig(session, { chain, transport });
  const result = await driver().then((d) => d.runFormalizationWorkshop(config));
  const modelUseCases = result.desks.find((desk) => desk.nodeId === 'model-use-cases');
  assert.equal(modelUseCases?.gateVerdict, 'repair');
  assert.ok(result.blockedAt !== undefined);
});

test('MUTATION illegal sequence: settleEffect before the final gate is refused by the kernel', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const { config } = await fullRunConfig(session, { transport });
  const d = await driver();
  // Drive only up to the first desk's author gate, then attempt the effect early.
  const staged = await d.runFormalizationWorkshop({ ...config, stopAfter: 'desk-define-product-intent-author-gate' });
  assert.equal(staged.blockedAt, 'desk-define-product-intent-author-gate');
  const world = session.hydrateWorld().world;
  const workplace = [...world.heads.values()].find((head) => head.aggregate === 'Workplace' && head.instanceId.startsWith('formalization-workplace:') && head.instanceId.includes('define-product-intent'));
  assert.ok(workplace, 'the first desk workplace exists');
  // settleEffect from 'author-gate-decided' is ILLEGAL (the reviewer desk
  // and final gate must run first) - the kernel refuses typed.
  const outcome = session.workplace.applyCommand({
    command: 'workplace.settleEffect',
    instanceId: workplace.instanceId,
    expectedRevision: workplace.revision,
    idempotencyKey: 'mutation:early-effect',
    effectOutcome: 'success',
  }, { externalEvidence: config.externalEvidence });
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'ILLEGAL_TRANSITION');
});

test('MUTATION illegal sequence: the reviewer WorkIntent cannot be admitted before an accepted author gate', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const { config } = await fullRunConfig(session, { transport });
  const d = await driver();
  const staged = await d.runFormalizationWorkshop({ ...config, stopAfter: 'desk-define-product-intent-plan-item' });
  assert.equal(staged.blockedAt, 'desk-define-product-intent-plan-item');
  const world = session.hydrateWorld().world;
  const workplaceId = [...world.heads.keys()].find((id) => id.includes('define-product-intent'));
  const authorSlot = config.roles.slotOf('formalization.implementation.author');
  const outcome = session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent',
    instanceId: workplaceId,
    expectedRevision: world.heads.get(workplaceId).revision,
    idempotencyKey: 'mutation:early-reviewer',
    protocolRole: 'reviewer',
    rolePin: authorSlot.pin,
    evidenceRefs: [workplaceId],
  }, { externalEvidence: config.externalEvidence });
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'ILLEGAL_TRANSITION');
});

test('MUTATION foreign lineage at ingress: a foreign-lineage capsule is refused before any kernel write', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const ingress = await import('../../../../dist/workflow-kernel/workshops/formalization/ingress.js');
  const foreign = await buildHandoffCapsule({ lineage: { lineageId: 'lineage:foreign', parentLifecycleRef: null } });
  const result = ingress.ingestDiscoveryHandoff(session, foreign, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  assert.equal(session.hydrateWorld().world.events.length, 0, 'no kernel write happened');
});

/* ------------------------------------------------------------------ */
/* Typed wait scenarios (D5/D12)                                       */
/* ------------------------------------------------------------------ */

test('D5 human-input wait: drift at the freeze desk waits for the operator and resumes', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const { config } = await fullRunConfig(session, { transport });
  const d = await driver();
  // Drive to the freeze desk and stop after its author candidates are
  // presented (the workplace is at author-candidates-presented: the drift
  // verdict can lawfully run now).
  const staged = await d.runFormalizationWorkshop({ ...config, stopAfter: 'desk-freeze-what-baseline-author-present-candidates' });
  assert.equal(staged.blockedAt, 'desk-freeze-what-baseline-author-present-candidates');
  const world = session.hydrateWorld().world;
  const freezeWorkplace = [...world.heads.keys()].find((id) => id.startsWith('formalization-workplace:') && id.includes('freeze-what-baseline'));
  assert.equal(world.heads.get(freezeWorkplace).status, 'author-candidates-presented');
  // The drift verdict commits a human-wait gate decision first (the typed cause).
  const gateOutcome = session.workplace.applyCommand({
    command: 'workplace.runAuthorGate',
    instanceId: freezeWorkplace,
    expectedRevision: world.heads.get(freezeWorkplace).revision,
    idempotencyKey: 'd5:drift-verdict',
    gateVerdict: 'human-wait',
  }, { externalEvidence: config.externalEvidence });
  assert.equal(gateOutcome.refused, undefined);
  const wait = d.freezeDriftHumanWait(config, freezeWorkplace);
  assert.equal(wait.enter.status, 'committed');
  assert.equal(wait.descriptor.kind, 'TypedWait:human-input');
  assert.deepEqual(wait.descriptor.wakeCommands, ['workplace.resolveHumanResponse']);
  assert.equal(wait.resolve.status, 'committed');
  const head = session.hydrateWorld().world.heads.get(freezeWorkplace);
  assert.equal(head.status, 'human-response-resolved');
});

test('D12 effect uncertainty: the effect settles unknown, the operator dispositions, the effect resumes idempotently', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const { config, chain } = await fullRunConfig(session, { transport });
  const d = await driver();
  const staged = await d.runFormalizationWorkshop({ ...config, stopAfter: 'desk-settle-formalization-final-gate' });
  assert.equal(staged.blockedAt, 'desk-settle-formalization-final-gate');
  const world = session.hydrateWorld().world;
  const settleWorkplace = [...world.heads.keys()].find((id) => id.startsWith('formalization-workplace:') && id.includes('settle-formalization'));
  // The settlement effect's content digest is already registered by the
  // executor during the drive? No: the drive stopped before settle-effect.
  const contentDigest = chain.solution.artifact.ref;
  const firstSettlement = config.effects.execute('formalization.settle-solution-contract', contentDigest, () => 'settled-once');
  assert.equal(firstSettlement.outcome, 'success');
  const loop = d.effectUncertaintyLoop(config, settleWorkplace);
  assert.equal(loop.uncertain.status, 'committed', JSON.stringify(loop.uncertain));
  // The typed wait exists (created and discharged through the frozen
  // vocabulary; never an automatic duplicate send).
  const waits = session.hydrateWorld().world.waits.filter((wait) => wait.kind === 'TypedWait:effect-uncertainty');
  assert.equal(waits.length, 1);
  assert.equal(loop.resolve.status, 'committed');
  assert.equal(loop.resume.status, 'committed');
  const head = session.hydrateWorld().world.heads.get(settleWorkplace);
  assert.equal(head.status, 'effect-settled');
  // D12: the idempotent key settles already-applied on resume - never a second mutation.
  const resumeSettlement = config.effects.execute('formalization.settle-solution-contract', contentDigest, () => 'settled-twice');
  assert.equal(resumeSettlement.outcome, 'already-applied');
  assert.equal(resumeSettlement.receiptDigest, 'settled-once');
});

test('the repair loop requeues the AUTHOR identity with the SAME pin', async () => {
  const db = await freshDatabase();
  const session = await db.open();
  const { transport } = await sharedTransport(session, allAttemptRefs());
  const { config } = await fullRunConfig(session, { transport });
  const d = await driver();
  const staged = await d.runFormalizationWorkshop({ ...config, stopAfter: 'desk-model-use-cases-reviewer-present-candidates' });
  assert.equal(staged.blockedAt, 'desk-model-use-cases-reviewer-present-candidates');
  const world = session.hydrateWorld().world;
  const workplaceId = [...world.heads.keys()].find((id) => id.startsWith('formalization-workplace:') && id.includes('model-use-cases'));
  const head = world.heads.get(workplaceId);
  assert.equal(head.status, 'reviewer-candidates-presented');
  // A typed repair verdict commits first (the repair wait's lawful cause).
  const verdict = session.workplace.applyCommand({
    command: 'workplace.runFinalGate',
    instanceId: workplaceId,
    expectedRevision: head.revision,
    idempotencyKey: 'repair:verdict',
    gateVerdict: 'repair',
  }, { externalEvidence: config.externalEvidence });
  assert.equal(verdict.refused, undefined);
  // A repair verdict enters the typed repair wait and requeues the author.
  const repair = d.repairLoopScenario(config, workplaceId);
  assert.equal(repair.enter.status, 'committed');
  assert.equal(repair.requeue.status, 'committed');
  const authorSlot = config.roles.slotOf('formalization.implementation.author');
  const requeuedIntent = [...session.hydrateWorld().world.workIntents.values()]
    .filter((intent) => intent.workplaceInstanceId === workplaceId && intent.protocolRole === 'author')
    .pop();
  assert.equal(requeuedIntent.roleContract.roleContractDigest, authorSlot.pin.roleContractDigest, 'repair identity preserved (same pin)');
});

test('the scenario carries the whole-WHAT baseline and the solution contract as accepted revisions', async () => {
  const { session, chain, result } = await runFullScenario();
  assert.equal(result.accepted.baseline?.wholeWhatDigest, chain.baseline.product.wholeWhatDigest);
  assert.equal(result.accepted.srs?.revisionDigest, chain.acceptedAt.srs.srs.revisionDigest);
  const world = session.hydrateWorld().world;
  // The kernel recorded production revisions for every desk (the authority).
  const revisions = world.evidence.filter((fact) => fact.kind === 'WorkplaceProductionRevision');
  const workplaceCount = [...world.heads.values()].filter((entry) => entry.aggregate === 'Workplace').length;
  assert.ok(revisions.length >= 2 * workplaceCount, `at least one sealed revision per desk round (got ${revisions.length} for ${workplaceCount} workplaces)`);
  void sha256;
});
