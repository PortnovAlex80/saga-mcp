/**
 * conveyor.test.mjs - WP-11L: the FULL release scenario through public
 * commands only - verified bundle ingress -> preflight -> conveyor spine
 * (delivery-release routing) -> desks -> final gate -> THE APPROVAL PAUSE
 * (TypedWait, D12) -> scripted operator disposition -> local packaging
 * (exactly-once) -> release record -> run terminal proof.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootReleaseWorld, authorScript, reviewerScript, operatorDecisionOf,
  freshDatabase, buildVerifiedBundle, LINEAGE, PACKAGE_BYTES, sha256,
} from './support.mjs';

const conveyor = await import('../../../../dist/workflow-kernel/workshops/delivery/conveyor.js');
const approval = await import('../../../../dist/workflow-kernel/workshops/delivery/approval.js');
const packaging = await import('../../../../dist/workflow-kernel/workshops/delivery/packaging.js');

/** Boot a lawful release world and drive it to the terminal proof + record. */
async function fullReleaseRun({ decisionOverrides } = {}) {
  const world = await bootReleaseWorld();
  const operatorDecision = await operatorDecisionOf(world.config, decisionOverrides);
  const run = await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision,
  });
  return { ...world, run, operatorDecision };
}

test('the full release run: ingress -> preflight -> packaging -> release record -> run terminal proof', async () => {
  const { session, run, stores } = await fullReleaseRun();
  const blocked = run.steps.filter((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'approval-refused' || step.result.status === 'packaging-refused');
  assert.deepEqual(blocked, [], `no step may refuse: ${JSON.stringify(blocked, null, 2)}`);
  assert.equal(run.blockedAt, undefined);

  // The delivery stage entered through the lifecycle's own first enterStage
  // lane; the delivery-release routing edge stays declared vocabulary
  // (asserted on the frozen universe below).
  const world = session.hydrateWorld().world;
  assert.ok(world.heads.has('stage-run:1'), 'the release stage materialized');
  const universe = await import('../../../../dist/workflow-kernel/domain/universe.js');
  assert.ok(universe.OBLIGATION_KINDS.includes('obligation:enterStage.delivery-release'), 'the delivery-release routing edge is frozen vocabulary');
  assert.ok(world.evidence.some((fact) => fact.kind === 'LifecycleRoutingReceipt'));

  // Every terminal proof of the ladder issued.
  const proofKinds = new Set(world.proofs.map((proof) => proof.id));
  for (const kind of [
    'TerminalProof:cell.success',
    'TerminalProof:workplace.success',
    'TerminalProof:node.success',
    'TerminalProof:process.success',
    'TerminalProof:stage.success',
    'TerminalProof:lifecycle.success',
    'TerminalProof:run.success',
  ]) {
    assert.ok(proofKinds.has(kind), `${kind} issued`);
  }
  assert.equal(world.heads.get('factory-run:1')?.status, 'terminal');

  // The effect settled over the VERIFIED local package (exactly-once).
  const effectKinds = world.evidence.filter((fact) => fact.kind.startsWith('EffectReceipt:')).map((fact) => fact.kind);
  assert.ok(effectKinds.includes('EffectReceipt:success'), `effect receipts: ${effectKinds.join(', ')}`);

  // The immutable release record sealed (write-once).
  assert.ok(run.releaseRecord, 'the release record sealed');
  assert.match(run.releaseRecord.recordDigest, /^[0-9a-f]{64}$/);
  assert.equal(run.releaseRecord.approvalRef.startsWith('delivery-approval:'), true);
  session.close();
});

test('the approval pause: the flow stops on a pending TypedWait:human-input with the D12 wake sources', async () => {
  const world = await bootReleaseWorld();
  const run = await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config),
    pauseAtApproval: true,
  });
  assert.equal(run.blockedAt, undefined); // a pause is not a refusal
  const pause = conveyor.approvalPauseOf(world.config);
  assert.equal(pause.paused, true, 'the flow pauses while the request is open');
  assert.deepEqual([...pause.waitWakeCommands], ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision'], 'the wake sources are exactly the frozen D5/D12 commands');
  // The workplace is IN the pause (effect-human-waited), the request is open.
  assert.equal(world.session.hydrateWorld().world.heads.get('workplace:1')?.status, 'effect-human-waited');
  const requestId = conveyor.approvalRequestIdOf(world.config);
  assert.equal(approval.readApprovalRequest(world.stores.inboxRoot, requestId)?.state, 'open');
  // NOTHING packaged while paused: no package, no record.
  const packaged = packaging.verifyPackagedRelease(world.stores.storeRoot, world.config.bundle.integratedCandidate.digest);
  assert.equal(packaged.ok, false, 'no package exists while the approval is pending');
  // No automatic duplicate: no EffectReceipt:success while paused.
  assert.equal(world.session.hydrateWorld().world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'), false);
  world.session.close();
});

test('the scripted operator disposition discharges the pause through the PUBLIC command path', async () => {
  const world = await bootReleaseWorld();
  // Part 1: pause.
  await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config),
    pauseAtApproval: true,
  });
  assert.equal(conveyor.approvalPauseOf(world.config).paused, true);
  // Part 2: the operator records the decision and resolves (public commands).
  const disposition = conveyor.operatorDisposition(world.config, await operatorDecisionOf(world.config));
  assert.equal(disposition.decision.status, 'committed', JSON.stringify(disposition.decision));
  assert.equal(disposition.resolve.status, 'committed', JSON.stringify(disposition.resolve));
  // The wait DISCHARGED atomically with the disposition command (D5).
  const waits = world.session.hydrateWorld().world.waits.filter((wait) => wait.kind === 'TypedWait:human-input');
  assert.equal(waits[0]?.state, 'discharged');
  assert.ok(world.session.hydrateWorld().world.evidence.some((fact) => fact.kind === 'WakeDischarge:human-response-command'));
  // The decision evidence is bound on the resolve event (immutable, policy-bound).
  const resolveEvent = world.session.hydrateWorld().world.events.find((event) => event.transition === 'workplace.resolveHumanResponse');
  assert.deepEqual([...resolveEvent.evidenceRefs], [disposition.decisionRecord.decisionRef]);
  // Part 3: re-drive the conveyor to the terminal proof (stateless convergence).
  const resume = await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config),
  });
  assert.equal(resume.blockedAt, undefined, JSON.stringify(resume.steps.filter((s) => s.result.status.includes('refused'))));
  assert.ok(resume.releaseRecord, 'the release record sealed after the disposition');
  world.session.close();
});

test('a DENIED disposition settles policy-terminal: no packaging, no record, no success path (D12)', async () => {
  const world = await bootReleaseWorld();
  const run = await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config, { status: 'denied', rationale: 'preflight evidence re-checked: candidate stale' }),
  });
  assert.equal(run.blockedAt, 'release-denied');
  const worldAfter = world.session.hydrateWorld().world;
  assert.ok(worldAfter.evidence.some((fact) => fact.kind === 'EffectReceipt:policy-terminal'), 'the denial settles policy-terminal (no implicit rollback)');
  assert.equal(worldAfter.evidence.some((fact) => fact.kind === 'EffectReceipt:success'), false, 'no success receipt on denial');
  assert.equal(worldAfter.heads.get('workplace:1')?.terminal, undefined, 'no workplace acceptance on denial');
  const packaged = packaging.verifyPackagedRelease(world.stores.storeRoot, world.config.bundle.integratedCandidate.digest);
  assert.equal(packaged.ok, false, 'denial never packages');
  assert.equal(run.releaseRecord, undefined, 'denial never records a release');
  world.session.close();
});

test('the release run is idempotent: a full re-drive converges without duplicate facts', async () => {
  const world = await bootReleaseWorld();
  const first = await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config),
  });
  assert.equal(first.blockedAt, undefined);
  const eventsAfterFirst = world.session.hydrateWorld().world.events.length;
  const second = await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config),
  });
  assert.equal(second.blockedAt, undefined);
  const world2 = world.session.hydrateWorld().world;
  assert.equal(world2.events.length, eventsAfterFirst, 'no duplicate WorkflowEvents on re-drive');
  assert.equal(world2.proofs.filter((proof) => proof.id === 'TerminalProof:run.success').length, 1);
  assert.ok(second.releaseRecord, 'the record replays/seals on re-drive');
  assert.equal(second.releaseRecord.recordDigest, first.releaseRecord.recordDigest);
  world.session.close();
});

test('a SECOND release run of the SAME candidate re-packages already-applied and replays the record', async () => {
  // Run 1: a complete release into the shared release store.
  const first = await fullReleaseRun();
  first.session.close();
  // Run 2: a FRESH database, the SAME candidate + release store + inbox.
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const ingress = await import('../../../../dist/workflow-kernel/workshops/delivery/bundle.js');
  const preflightModule = await import('../../../../dist/workflow-kernel/workshops/delivery/preflight.js');
  const manifestModule = await import('../../../../dist/workflow-kernel/workshops/delivery/manifest.js');
  assert.equal(ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  }).imported, true);
  const roles = await (await import('./support.mjs')).deliveryRoles();
  const { sharedTransport, taskManifest, PRODUCT_ROOT } = await import('./support.mjs');
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
  const config = {
    session,
    roles: roles.runtime,
    authorLaunchKind: roles.authorLaunchKind,
    reviewerLaunchKind: roles.reviewerLaunchKind,
    transport,
    taskSummary: 're-release the same candidate',
    requiredInfo: await taskManifest(),
    bundle,
    preflight: preflightModule.runPreflight(bundle, manifestModule.DELIVERY_RELEASE_POLICY),
    policy: manifestModule.DELIVERY_RELEASE_POLICY,
    storeRoot: first.stores.storeRoot,
    inboxRoot: first.stores.inboxRoot,
    packaging: { productRoot: PRODUCT_ROOT, entries: [...packaging.DEFAULT_PACKAGING_ENTRIES] },
    requestedBy: 'release-conveyor',
  };
  const run = await conveyor.driveReleaseRun(config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(config),
  });
  // The frozen run-success guard demands EffectReceipt:success (the FIRST
  // release's receipt); a re-release of an already-released candidate holds
  // only the already-applied receipt, so the run-level proof refuses typed
  // (an honest frozen-guard outcome, documented as a residual for EK-8).
  assert.equal(run.blockedAt, 'run-terminal-proof', JSON.stringify(run.steps.filter((s) => s.result.status === 'refused')));
  const refusedStep = run.steps.find((step) => step.step === 'run-terminal-proof');
  assert.equal(refusedStep.result.refusal.reason, 'MISSING_EVIDENCE');
  assert.match(refusedStep.result.refusal.detail, /EffectReceipt:success/);
  const world = session.hydrateWorld().world;
  // The duplicate packaging settled already-applied (success-shaped, D2).
  assert.ok(world.evidence.some((fact) => fact.kind === 'EffectReceipt:already-applied'), 'the re-package settles already-applied');
  assert.equal(world.evidence.some((fact) => fact.kind === 'EffectReceipt:success'), false, 'no second success receipt in the re-release run');
  // Everything below the run scope still settles; the release record
  // replayed the ORIGINAL record (identical digest).
  assert.ok(world.proofs.some((proof) => proof.id === 'TerminalProof:lifecycle.success'), 'the re-release lifecycle still settles');
  assert.ok(run.releaseRecordOutcome && 'replayed' in run.releaseRecordOutcome, JSON.stringify(run.releaseRecordOutcome));
  assert.equal(run.releaseRecord.recordDigest, first.run.releaseRecord.recordDigest);
  session.close();
});

test('exact role pins and ONE resolution path (the identity law)', async () => {
  const { session, run, roles, config } = await fullReleaseRun();
  assert.equal(run.blockedAt, undefined);
  // The runtime resolved each launch kind EXACTLY once.
  assert.equal(roles.runtime.resolutionCount, 2, 'one resolution per launch kind');
  const intents = [...session.hydrateWorld().world.workIntents.values()];
  const authorIntent = intents.find((intent) => intent.protocolRole === 'author');
  const reviewerIntent = intents.find((intent) => intent.protocolRole === 'reviewer');
  assert.ok(authorIntent && reviewerIntent);
  assert.notEqual(authorIntent.roleContract.roleContractDigest, reviewerIntent.roleContract.roleContractDigest);
  assert.equal(authorIntent.roleContract.roleContractRef, roles.authorSlot.pin.roleContractRef);
  assert.equal(reviewerIntent.roleContract.roleContractRef, roles.reviewerSlot.pin.roleContractRef);
  // Every consumer view carries the SAME pin object (one resolution path).
  const dispatcherView = roles.runtime.dispatcherView(roles.authorSlot);
  const runnerView = roles.runtime.runnerView(roles.authorSlot);
  const trackerView = roles.runtime.trackerView(roles.authorSlot);
  assert.equal(dispatcherView.pin, runnerView.pin);
  assert.equal(runnerView.pin, trackerView.pin);
  assert.equal(dispatcherView.pin, roles.authorSlot.pin);
  // The attempts copied the SAME pins from their exact intents.
  const attempts = session.db.prepare('SELECT instance_id, work_intent_ref, role_contract_ref FROM activity_attempt ORDER BY instance_id').all();
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    const intent = intents.find((entry) => entry.intentRef === attempt.work_intent_ref);
    assert.ok(intent, `attempt ${attempt.instance_id} binds its exact WorkIntent`);
    assert.equal(attempt.role_contract_ref, intent.roleContract.roleContractRef);
  }
  // The durable receipts: one admitted request per attempt.
  const receipts = session.db.prepare('SELECT activity_attempt_instance_id, admission FROM activity_attempt_prompt_assembly_receipt ORDER BY created_sequence').all();
  assert.deepEqual(receipts, [
    { activity_attempt_instance_id: 'activity-attempt:1', admission: 'admitted' },
    { activity_attempt_instance_id: 'activity-attempt:2', admission: 'admitted' },
  ]);
  void config;
  void sha256;
  session.close();
});
