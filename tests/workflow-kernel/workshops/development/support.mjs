/**
 * support.mjs - shared WP-11V Development-workshop fixtures: reuses the
 * WP-08 vertical fixtures (fresh database, capsule, role runtime, shared
 * transport, product verifier) and adds the workshop-package wiring (the
 * installed CheckPlan evidence + the scenario config builder).
 */
import { createHash } from 'node:crypto';
import {
  freshDatabase, buildCapsuleFixture, roleRuntime, sharedTransport, taskManifest,
  authorScript, reviewerScript, productVerifier, driveToWorkplace, LINEAGE, CAPSULE_BYTES,
} from '../../development/support.mjs';

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
export {
  freshDatabase, buildCapsuleFixture, roleRuntime, sharedTransport, taskManifest,
  authorScript, reviewerScript, productVerifier, driveToWorkplace, LINEAGE, CAPSULE_BYTES,
};

export const dist = (relative) => import(`../../../../dist/${relative}`);

/** The installed external Input authority evidence of the workshop (its real CheckPlan rows). */
export async function workshopExternalEvidence(digest = sha256('workshop-product-evidence')) {
  const { developmentCheckPlanEvidence } = await dist('workflow-kernel/workshops/development/checkplans.js');
  return [
    ...developmentCheckPlanEvidence(),
    { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#workshop', producer: 'external-input', payloadDigest: digest },
    { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#workshop', producer: 'external-input', payloadDigest: sha256('workshop-product-evidence-failure') },
  ];
}

/** Build the full WP-11V scenario config over a fresh session (capsule NOT yet ingested). */
export async function scenarioConfig(options = {}) {
  const session = await (await freshDatabase('ek-wp11v-')).open();
  const capsule = await buildCapsuleFixture();
  const { runtime, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
  const authorSlot = runtime.resolveOnce(authorLaunchKind);
  const reviewerSlot = runtime.resolveOnce(reviewerLaunchKind);
  if (!authorSlot.resolved || !reviewerSlot.resolved) {
    throw new Error('workshop scenario: the role contracts failed their one resolution');
  }
  const task = await taskManifest();
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
  const config = {
    session,
    roles: runtime,
    authorLaunchKind,
    reviewerLaunchKind,
    transport,
    taskSummary: 'Build the simple-server product against the acceptance contract',
    requiredInfo: task,
    verifyProduct: options.verifyProduct ?? (await productVerifier()),
    externalEvidence: await workshopExternalEvidence(),
  };
  return {
    session,
    config,
    capsule,
    lineage: { expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef },
    packageBytes: new Uint8Array(CAPSULE_BYTES),
  };
}
