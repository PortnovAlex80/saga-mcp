/**
 * scenario.test.mjs - WP-11V deliverable 5: the FULL Development workshop
 * run through public commands and scripted actors:
 *
 *   capsule -> implementation -> review -> integration (accepted final
 *   gate) -> freeze (machine-verified product, human-wait settlement) ->
 *   readiness certification (the Elite-2 human gate: the operator
 *   disposes the readiness manifest through the D12-disciplined public
 *   command path; the effect resumes idempotently as already-applied) ->
 *   verified (CellFinalAcceptance, closePresentation, the settlement
 *   ladder, lifecycleRun.verifyTerminalClaims and every terminal proof
 *   through TerminalProof:run.success).
 *
 * Plus: the D12 effect-uncertainty arm (an automatic wake is a typed
 * refusal; the operator disposition wakes it) and idempotent re-drive.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { scenarioConfig, authorScript, reviewerScript } from './support.mjs';

const runbook = await import('../../../../dist/workflow-kernel/workshops/development/runbook.js');
const chain = await import('../../../../dist/workflow-kernel/development/material-chain.js');
const consumer = await import('../../../../dist/workflow-kernel/application/obligation-consumer.js');

const OPERATOR = { operatorId: 'operator:ek-wp11v', note: 'readiness certified from the freeze report' };

test('the full staged scenario: capsule -> implementation -> review -> integration -> freeze -> readiness certification -> verified', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig();
  const result = await runbook.runDevelopmentWorkshopScenario(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
    capsule,
    packageBytes,
    lineage,
    operator: OPERATOR,
  });

  // No phase refused and nothing is blocked.
  assert.equal(result.blockedAt, undefined, JSON.stringify(result.blockedAt));
  const refusedSteps = [
    ...result.integration.steps,
    ...result.completion.steps,
  ].filter((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
  assert.deepEqual(refusedSteps, [], JSON.stringify(refusedSteps, null, 2));

  // --- integration: the final gate was DECIDED by the declared rules ---
  assert.equal(result.finalGateVerdict, 'accepted');
  const integrationSteps = result.integration.steps.map((step) => step.step);
  assert.ok(integrationSteps.includes('final-gate'), 'phase A reached the final gate');

  // --- certification: the Elite-2 human gate through the public path ---
  const certification = result.certification;
  assert.equal(certification.machineObservation.ok, true, 'the machine verified the product');
  assert.equal(certification.gate.verdict, 'human-wait', 'the declared certification gate decides human-wait (readiness is not machine-observable)');
  assert.equal(certification.settle.status, 'committed', 'the effect settled human-wait');
  assert.equal(certification.wake.status, 'discharged', 'the operator disposition discharged the typed wait');
  assert.equal(certification.wake.waitKind, 'TypedWait:human-input');
  assert.match(certification.wake.dischargeEvidenceRef, /^evidence:WakeDischarge#/);
  assert.equal(certification.resume.status, 'committed', 'the effect resumed idempotently');
  // The readiness manifest product: machine observation carried, readiness named unobservable.
  assert.equal(certification.readinessManifest.mapped, true);
  assert.equal(certification.readinessManifest.value.machineObservation, 'product-verified');
  assert.equal(certification.readinessManifest.value.unobservable, 'readiness-for-certification');
  assert.ok(certification.readinessManifest.value.settledEvidenceKinds.includes('EffectReceipt:human-wait'));
  // The operator disposition receipt is content-addressed and named by the wake evidence.
  assert.match(certification.disposition.ref, /^sha256:[0-9a-f]{64}$/);
  assert.ok(certification.disposition.decision === 'readiness-certified');

  // --- verified: every terminal proof, the D4 certifier evidence, the run terminal ---
  const world = session.hydrateWorld().world;
  for (const kind of [
    'TerminalProof:cell.success',
    'TerminalProof:workplace.success',
    'TerminalProof:node.success',
    'TerminalProof:process.success',
    'TerminalProof:stage.success',
    'TerminalProof:lifecycle.success',
    'TerminalProof:run.success',
  ]) {
    assert.ok(result.terminalProofs.includes(kind), `${kind} issued`);
  }
  assert.equal(world.heads.get('factory-run:1')?.terminal, 'TerminalProof:run.success');
  assert.equal(result.claimsVerified, true, 'lifecycleRun.verifyTerminalClaims committed its ExecutableVerifierResult (D4 certifier)');
  assert.equal(world.evidence.some((fact) => fact.kind === 'WakeDischarge:human-response-command'), true, 'the operator disposition left durable discharge evidence');

  // The effect receipts: exactly ONE human-wait (the certification wait), ONE
  // success (the dispositioned freeze execution) - deduplicated by evidence
  // ref (the hydrated view may repeat a fact across hydration contexts).
  const effectFacts = [...new Map(world.evidence.filter((fact) => fact.kind.startsWith('EffectReceipt:')).map((fact) => [fact.ref, fact.kind])).entries()];
  assert.equal(effectFacts.filter(([, kind]) => kind === 'EffectReceipt:human-wait').length, 1, 'exactly one certification wait receipt');
  assert.equal(effectFacts.filter(([, kind]) => kind === 'EffectReceipt:success').length, 1, 'exactly one dispositioned success receipt');
  assert.equal(session.db.prepare("SELECT COUNT(*) AS n FROM workplace_effect_receipt WHERE outcome = 'human-wait'").get().n, 1, 'exactly one human-wait effect row');
  assert.equal(session.db.prepare("SELECT COUNT(*) AS n FROM workplace_effect_receipt WHERE outcome = 'success'").get().n, 1, 'exactly one success effect row');

  // The workshop output product mapped from the terminal facts.
  assert.equal(result.verifiedBundle.mapped, true, JSON.stringify(result.verifiedBundle));
  assert.equal(result.verifiedBundle.value.runTerminalOutcome, 'success');
  assert.match(result.verifiedBundle.value.acceptanceDigest, /^[0-9a-f]{64}$/, 'D11: the bundle carries the acceptance digest');

  // The staged vertical's material-chain rows are intact (ADR-053).
  const revisions = session.db.prepare('SELECT COUNT(*) AS n FROM workplace_production_revision').get().n;
  assert.equal(revisions, 2, 'one author revision + one reviewer revision');
  const acceptance = session.db.prepare('SELECT COUNT(*) AS n FROM workplace_cell_final_acceptance').get().n;
  assert.equal(acceptance, 1, 'exactly one CellFinalAcceptance');
  session.close();
});

test('the certification scenario is idempotent: a full re-drive converges without new facts', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig();
  const options = {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
    capsule, packageBytes, lineage, operator: OPERATOR,
  };
  const first = await runbook.runDevelopmentWorkshopScenario(config, options);
  assert.equal(first.blockedAt, undefined);
  const eventsAfterFirst = session.hydrateWorld().world.events.length;
  const acceptanceAfterFirst = session.db.prepare('SELECT COUNT(*) AS n FROM workplace_cell_final_acceptance').get().n;

  // Re-run the WHOLE scenario against the same database: everything replays/skips.
  const second = await runbook.runDevelopmentWorkshopScenario(config, options);
  assert.equal(second.blockedAt, undefined, JSON.stringify(second.certification));
  const world = session.hydrateWorld().world;
  assert.equal(world.events.length, eventsAfterFirst, 'no duplicate WorkflowEvents on re-drive');
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM workplace_cell_final_acceptance').get().n, acceptanceAfterFirst);
  assert.equal(world.heads.get('factory-run:1')?.terminal, 'TerminalProof:run.success');
  session.close();
});

test('the D12 effect-uncertainty arm: an automatic redrive is refused typed; the operator disposition wakes it', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig();
  // Ingest + drive to the accepted final gate (phase A).
  const ingress = await import('../../../../dist/workflow-kernel/development/capsule.js');
  assert.equal(ingress.ingestCapsule(session, capsule, packageBytes, lineage).imported, true);
  const phaseA = await chain.driveDevelopmentVertical(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
    finalGateVerdict: 'accepted',
    stopAfter: 'final-gate',
  });
  assert.equal(phaseA.blockedAt, undefined, JSON.stringify(phaseA.steps.filter((s) => s.result.status !== 'committed' && s.result.status !== 'skipped')));

  // The arm: settle UNKNOWN -> automatic wake refused -> operator wake -> the dispositioned execution.
  const arm = runbook.effectUncertaintyArm(config, OPERATOR);
  assert.equal(arm.settle.status, 'committed', 'the uncertain settlement committed');
  assert.equal(arm.refusedWithoutDisposition.status, 'refused', 'the AUTOMATIC wake is refused');
  assert.equal(arm.refusedWithoutDisposition.refusal.reason, 'WAIT_WITHOUT_WAKE_SOURCE');
  assert.match(arm.refusedWithoutDisposition.refusal.detail, /D12/);
  assert.equal(arm.wake.status, 'discharged', 'the operator disposition wakes it');
  assert.equal(arm.wake.waitKind, 'TypedWait:effect-uncertainty');
  assert.equal(arm.resume.status, 'committed', 'the dispositioned effect settled success');

  // The world converges to the run terminal proof afterwards.
  const completion = await chain.driveDevelopmentVertical(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
  });
  assert.equal(completion.blockedAt, undefined, JSON.stringify(completion.steps.filter((s) => s.result.status !== 'committed' && s.result.status !== 'skipped')));
  assert.equal(session.hydrateWorld().world.heads.get('factory-run:1')?.terminal, 'TerminalProof:run.success');
  session.close();
});

test('the already-applied resume arm: lawful and success-shaped for acceptance; the run-proof guard boundary is documented', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig();
  const ingress = await import('../../../../dist/workflow-kernel/development/capsule.js');
  assert.equal(ingress.ingestCapsule(session, capsule, packageBytes, lineage).imported, true);
  const phaseA = await chain.driveDevelopmentVertical(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
    finalGateVerdict: 'accepted',
    stopAfter: 'final-gate',
  });
  assert.equal(phaseA.blockedAt, undefined);

  const arm = runbook.alreadyAppliedResumeArm(config, OPERATOR);
  assert.equal(arm.settle.status, 'committed');
  assert.equal(arm.wake.status, 'discharged');
  assert.equal(arm.resume.status, 'committed', 'the already-applied resume is lawful from the resolved wait');
  const world = session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'EffectReceipt:already-applied'), 'the idempotent resume receipt exists');

  // Success-shaped for cell acceptance: recordFinalAcceptance is legal after already-applied.
  const acceptance = session.workplace.applyCommand({
    command: 'workplace.recordFinalAcceptance', instanceId: 'workplace:1',
    expectedRevision: session.hydrateWorld().world.heads.get('workplace:1')?.revision ?? 0,
    idempotencyKey: 'scenario:already-applied-acceptance',
  });
  assert.equal('refused' in acceptance ? acceptance.reason : 'committed', 'committed', 'already-applied is a success-shaped receipt for final acceptance');

  // FROZEN-UNIVERSE BOUNDARY (documented residual, not worked around): the
  // run-success guard accepts only EffectReceipt:success, so this world
  // cannot reach the run terminal proof without a success settlement.
  const completion = await chain.driveDevelopmentVertical(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
  });
  assert.equal(completion.blockedAt, 'run-terminal-proof');
  const refusal = completion.steps.find((step) => step.step === 'run-terminal-proof')?.result;
  assert.equal(refusal.refusal.reason, 'MISSING_EVIDENCE');
  assert.match(refusal.refusal.detail, /EffectReceipt:success/);
  session.close();
});

test('the final gate decides by the declared rules: a verification failure blocks integration (fail-closed)', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig({
    verifyProduct: async () => ({ ok: false, detail: 'PRODUCT_LOOPBACK_FAILED: /healthz did not answer', digest: 'f'.repeat(64) }),
  });
  const result = await runbook.runDevelopmentWorkshopScenario(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
    capsule, packageBytes, lineage, operator: OPERATOR,
  });
  // The declared rules decided terminal-reject (verification-evidence failed) -> the scenario reports a blocked lane.
  assert.equal(result.finalGateVerdict, 'terminal-reject');
  assert.equal(result.blockedAt, 'final-gate');
  assert.equal(result.verifiedBundle.refused, true, 'no verified bundle without an accepted integration');
  // No acceptance/proof was invented.
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM workplace_cell_final_acceptance').get().n, 0);
  assert.equal(session.hydrateWorld().world.proofs.length === 0 || session.hydrateWorld().world.proofs.every((proof) => !proof.id.endsWith('run.success')), true);
  session.close();
});

test('the effect never settles over an unverified product (no silent pass)', async () => {
  const { session, config, capsule, lineage, packageBytes } = await scenarioConfig({
    verifyProduct: async () => ({ ok: false, detail: 'PRODUCT_BUILD_FAILED: the build emitted no manifest', digest: 'e'.repeat(64) }),
  });
  const ingress = await import('../../../../dist/workflow-kernel/development/capsule.js');
  assert.equal(ingress.ingestCapsule(session, capsule, packageBytes, lineage).imported, true);
  // The final gate check fails by the declared rules; force the lane forward through the vertical
  // to the effect to prove the kernel/workshop refuses the settlement over an unverified product.
  const run = await chain.driveDevelopmentVertical(config, {
    authorScript: await authorScript(),
    reviewerScript: await reviewerScript('accepted'),
    finalGateVerdict: 'accepted',
  });
  const settle = run.steps.find((step) => step.step === 'settle-effect');
  assert.ok(settle, 'the vertical reached the effect settlement');
  assert.equal(settle.result.status, 'acceptance-refused');
  assert.equal(settle.result.reason, 'PRODUCT_VERIFICATION');
  assert.equal(run.blockedAt, 'settle-effect');
  const effectSuccess = session.hydrateWorld().world.evidence.filter((fact) => fact.kind === 'EffectReceipt:success');
  assert.deepEqual(effectSuccess, [], 'no success receipt may exist for an unverified product');
  void consumer;
  session.close();
});
