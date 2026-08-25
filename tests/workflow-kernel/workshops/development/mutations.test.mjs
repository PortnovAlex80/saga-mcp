/**
 * mutations.test.mjs - WP-11V deliverable 6: one killed mutation per fence
 * family (the GREEN pins; the deliberate RED source-mutation demonstrations
 * run separately and are documented in the handoff):
 *
 *   1. CONDITIONAL IDENTITY  - a role-pin drift / reclassification is a
 *      typed kernel refusal; the identity law has no conditional branch;
 *   2. GATE BYPASS           - a gate without its installed CheckPlan
 *      evidence is refused; an unverified product never settles;
 *   3. WAIT-KIND INVENTION   - an invented wait kind / wake source / D12
 *      auto-wake is refused typed at every layer;
 *   4. SYNTHETIC-WORKSHOP KERNEL MODIFICATION - lives in
 *      ../synthetic/mutations.test.mjs (the fence refuses new kinds).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  freshDatabase, driveToWorkplace, buildCapsuleFixture, roleRuntime, taskManifest,
  authorScript, reviewerScript, LINEAGE, CAPSULE_BYTES, sha256,
} from './support.mjs';
import { scenarioConfig } from './support.mjs';

const ingress = await import('../../../../dist/workflow-kernel/development/capsule.js');
const chain = await import('../../../../dist/workflow-kernel/development/material-chain.js');
const consumer = await import('../../../../dist/workflow-kernel/application/obligation-consumer.js');
const resolver = await import('../../../../dist/workflow-kernel/roles/resolver.js');
const installation = await import('../../../../dist/workflow-kernel/workshops/development/installation.js');
const manifest = await import('../../../../dist/workflow-kernel/workshops/development/manifest.js');

/** A lawful world staged to the production workplace with an author intent. */
async function stagedWorld() {
  const session = await (await freshDatabase('ek-wp11v-mut-')).open();
  const capsule = await buildCapsuleFixture();
  assert.equal(ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  }).imported, true);
  await driveToWorkplace(session);
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', expectedRevision: 1,
    idempotencyKey: 'mutation:author-intent', protocolRole: 'author', rolePin: slot.slot.pin,
    evidenceRefs: ['work-item:1', 'evidence:scope'],
  });
  const intentRef = [...session.hydrateWorld().world.workIntents.keys()][0];
  return { session, slot, intentRef, runtime };
}

/* ------------------------------------------------------------------ */
/* Fence family 1: conditional identity                                */
/* ------------------------------------------------------------------ */

test('FENCE conditional-identity: a drifted pin is refused at attempt creation and resolution', async () => {
  const { session, slot, intentRef } = await stagedWorld();
  // Pin drift (ref A vs digest B) at the attempt boundary.
  const drifted = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:9', expectedRevision: 0,
    idempotencyKey: 'mutation:drifted-pin',
    workIntentRef: intentRef,
    rolePin: { roleContractRef: `sha256:${sha256('other-contract')}`, roleContractDigest: sha256('other-body') },
  });
  assert.equal(drifted.refused, true);
  assert.equal(drifted.reason, 'ROLE_CONTRACT_REF_MISMATCH');

  // A foreign pin (outside the closed installed set) never resolves.
  const install = resolver.installRoleContracts([slot.slot.contract]);
  assert.equal(install.installed, true);
  const foreignResolution = resolver.resolveRoleContract(install.set, {
    roleContractRef: `sha256:${sha256('never-compiled')}`,
    roleContractDigest: sha256('never-compiled-body'),
  });
  assert.equal(foreignResolution.refused, true);
  assert.equal(foreignResolution.reason, 'ROLE_CONTRACT_REF_MISMATCH');

  // The lawful attempt copies the SAME pin object from its exact WorkIntent.
  const lawful = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:10', expectedRevision: 0,
    idempotencyKey: 'mutation:lawful-pin', workIntentRef: intentRef, rolePin: slot.slot.pin,
  });
  assert.equal('refused' in lawful ? lawful.reason : 'committed', 'committed');
  const row = session.db.prepare('SELECT role_contract_ref, role_contract_digest FROM activity_attempt WHERE instance_id = ?').get('activity-attempt:10');
  assert.equal(row.role_contract_ref, slot.slot.pin.roleContractRef);
  assert.equal(row.role_contract_digest, slot.slot.pin.roleContractDigest);
  session.close();
});

test('FENCE conditional-identity: reclassification by semantic profile is refused (mutation k)', async () => {
  const { session, runtime, slot } = await stagedWorld();
  for (const profile of ['certifier', 'reviewer', 'implementer', 'planner']) {
    const refusal = runtime.reclassify(slot.slot, profile);
    assert.equal(refusal.refused, true);
    assert.equal(refusal.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION');
  }
  session.close();
});

/* ------------------------------------------------------------------ */
/* Fence family 2: gate bypass                                         */
/* ------------------------------------------------------------------ */

test('FENCE gate-bypass: a gate without the installed CheckPlan evidence is refused by the kernel guard', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig();
  assert.equal(ingress.ingestCapsule(session, capsule, packageBytes, lineage).imported, true);
  // Drive with externalEvidence that carries NO CheckPlan fact at all.
  const strippedConfig = { ...config, externalEvidence: config.externalEvidence.filter((fact) => fact.kind !== 'CheckPlan') };
  const run = await chain.driveDevelopmentVertical(strippedConfig, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
  });
  const authorGate = run.steps.find((step) => step.step === 'author-gate');
  assert.ok(authorGate, 'the vertical reached the author gate');
  assert.equal(authorGate.result.status, 'refused', 'the gate is refused without the installed CheckPlan');
  assert.equal(authorGate.result.refusal.reason, 'MISSING_EVIDENCE');
  assert.match(authorGate.result.refusal.detail, /CheckPlan/);
  assert.equal(run.blockedAt, 'author-gate');
  // No gate decision was committed: the bypass is dead.
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM workplace_gate_decision').get().n, 0);
  session.close();
});

test('FENCE gate-bypass: a spoofed CheckPlan producer is refused at the ledger boundary', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig();
  assert.equal(ingress.ingestCapsule(session, capsule, packageBytes, lineage).imported, true);
  const spoofed = {
    ...config,
    externalEvidence: [
      { kind: 'CheckPlan', ref: 'checkplan:spoofed#1', producer: 'workshop:not-the-input-authority', payloadDigest: sha256('spoofed') },
    ],
  };
  await assert.rejects(
    async () => chain.driveDevelopmentVertical(spoofed, { authorScript: await authorScript(), reviewerScript: await reviewerScript('accepted') }),
    /must have producer "external-input"/,
    'external input evidence with a forged producer never enters the ledger',
  );
  session.close();
});

/* ------------------------------------------------------------------ */
/* Fence family 3: wait-kind invention (every layer)                   */
/* ------------------------------------------------------------------ */

test('FENCE wait-kind-invention: the installation validator refuses invented kinds, wakes and gate wait arms', () => {
  const base = manifest.developmentWorkshopInstallation();
  const inventedKind = structuredClone(base);
  inventedKind.waits = [...base.waits, { purpose: 'operator-mood', kind: 'TypedWait:operator-mood', wakeCommands: ['workplace.resolveHumanResponse'], operatorDispositionRequired: true, rationale: 'invented kind' }];
  assert.equal(installation.validateWorkshopInstallation(inventedKind).code, 'WAIT_KIND_OUTSIDE_UNIVERSE');

  const inventedWake = structuredClone(base);
  inventedWake.waits = base.waits.map((wait) => ({ ...wait, wakeCommands: ['workplace.renderReport'] }));
  assert.equal(installation.validateWorkshopInstallation(inventedWake).code, 'WAIT_WAKE_COMMAND_OUTSIDE_UNIVERSE');

  const registryForeign = structuredClone(base);
  registryForeign.waits = base.waits.map((wait) => ({ ...wait, wakeCommands: ['factoryRun.resume'] }));
  assert.equal(installation.validateWorkshopInstallation(registryForeign).code, 'WAIT_WAKE_COMMAND_OUTSIDE_REGISTRY');

  const inventedGateWait = structuredClone(base);
  inventedGateWait.gates = base.gates.map((gate, index) => index === 0 ? { ...gate, waitOn: { verdict: 'human-wait', waitKind: 'TypedWait:cognition-mood' } } : gate);
  assert.equal(installation.validateWorkshopInstallation(inventedGateWait).code, 'GATE_WAIT_KIND_OUTSIDE_UNIVERSE');
});

test('FENCE wait-kind-invention (D12): an automatic effect-uncertainty wake is refused typed', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig();
  assert.equal(ingress.ingestCapsule(session, capsule, packageBytes, lineage).imported, true);
  const phaseA = await chain.driveDevelopmentVertical(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
    finalGateVerdict: 'accepted',
    stopAfter: 'final-gate',
  });
  assert.equal(phaseA.blockedAt, undefined);
  // Settle UNKNOWN.
  const frontier = consumer.openFrontier(session).find((entry) => entry.target === 'workplace.settleEffect' && entry.claim !== undefined);
  const settle = consumer.consumeClaim(session, frontier.claim, { effectOutcome: 'unknown' }, { externalEvidence: config.externalEvidence });
  assert.equal(settle.status, 'committed');
  const waits = await import('../../../../dist/workflow-kernel/application/waits.js');
  const pending = waits.pendingWaits(session).find((wait) => wait.kind === 'TypedWait:effect-uncertainty');
  assert.ok(pending, 'the uncertainty wait is pending');
  // The D12 fence: no operator disposition receipt -> typed refusal, wait stays pending.
  const auto = waits.wakeByCommand(session, pending.rowId, {
    command: 'workplace.resolveHumanResponse',
    idempotencyKey: 'mutation:auto-redrive',
  });
  assert.equal(auto.status, 'refused');
  assert.equal(auto.refusal.reason, 'WAIT_WITHOUT_WAKE_SOURCE');
  assert.match(auto.refusal.detail, /D12/);
  assert.equal(waits.pendingWaits(session).some((wait) => wait.rowId === pending.rowId), true, 'the wait is still pending after the refused auto-wake');
  session.close();
});

test('FENCE wait-kind-invention: no wait exists without a declared wake source (mutation d)', async () => {
  const { session } = await stagedWorld();
  const waits = await import('../../../../dist/workflow-kernel/application/waits.js');
  for (const wait of waits.durableWaits(session)) {
    assert.ok(wait.wakeCommands.length > 0 || wait.wakeObligationKinds.length > 0, `${wait.kind} declares a durable wake source`);
  }
  assert.deepEqual(waits.durableWaits(session), [], 'a staged world before any wait holds no wait rows');
  session.close();
});
