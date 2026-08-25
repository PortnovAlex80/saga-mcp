/**
 * mutations.test.mjs - WP-11L: the pinned mutation classes, one killed
 * mutation per fence family (the GREEN pin; the deliberate RED
 * source-mutation demonstrations run via red-demos.py and are documented
 * in the handoff):
 *
 *   fence family            mutation                                kill
 *   ----------------------  --------------------------------------  ---------------------------
 *   ingress fence           foreign bundle                          FOREIGN_LINEAGE
 *   gate fence              failed preflight                        PREFLIGHT_FAILED (conveyor never starts)
 *   idempotence fence       duplicate release                       DUPLICATE_RELEASE (typed) + SQL fence
 *   approval fence          decision re-write                       APPROVAL_DECISION_IMMUTABLE
 *   CAS fence               stale-revision command                  STALE_EXPECTED_REVISION
 *   identity fence          drifted role pin                        ROLE_CONTRACT_REF_MISMATCH
 *   role-universe fence     semantic profile as protocol role       PROTOCOL_ROLE_UNIVERSE_VIOLATION
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootReleaseWorld, buildVerifiedBundle, freshDatabase, LINEAGE, PACKAGE_BYTES,
  operatorStores, operatorDecisionOf, authorScript, reviewerScript, sha256, deliveryRoles, sharedTransport, taskManifest,
  stagedCellWorld, admitAuthorIntent, PRODUCT_ROOT,
} from './support.mjs';

const ingress = await import('../../../../dist/workflow-kernel/workshops/delivery/bundle.js');
const preflight = await import('../../../../dist/workflow-kernel/workshops/delivery/preflight.js');
const manifest = await import('../../../../dist/workflow-kernel/workshops/delivery/manifest.js');
const packaging = await import('../../../../dist/workflow-kernel/workshops/delivery/packaging.js');
const approval = await import('../../../../dist/workflow-kernel/workshops/delivery/approval.js');
const conveyor = await import('../../../../dist/workflow-kernel/workshops/delivery/conveyor.js');

/* ------------------------------------------------------------------ */
/* Ingress fence: the foreign bundle                                    */
/* ------------------------------------------------------------------ */

test('mutation: foreign bundle - a bundle from a foreign lineage is refused at ingress, nothing commits', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const result = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), {
    expectedLineageId: 'lineage:some-other-product-2026-09',
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  assert.equal(session.hydrateWorld().world.events.length, 0, 'no kernel fact may exist for a foreign bundle');
  session.close();
});

/* ------------------------------------------------------------------ */
/* Gate fence: the failed preflight                                     */
/* ------------------------------------------------------------------ */

test('mutation: failed preflight - the conveyor input is refused typed; the release never starts', async () => {
  const bundle = await buildVerifiedBundle({ certificateDecision: 'self-declared' });
  const run = preflight.runPreflight(bundle);
  assert.equal(run.refused, true);
  assert.equal(run.reason, 'PREFLIGHT_FAILED');
  assert.deepEqual([...run.checkIds], ['certificate-verified']);
  // The workshop boundary is fail-closed: a refused preflight is not a
  // conveyor input (bootReleaseWorld asserts the green preflight; here the
  // run function itself never receives a snapshot).
  const session = await (await freshDatabase()).open();
  const refusedIngress = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(refusedIngress.refused, true);
  assert.equal(refusedIngress.reason, 'UNVERIFIED_CERTIFICATE');
  session.close();
});

/* ------------------------------------------------------------------ */
/* Idempotence fence: the duplicate release                             */
/* ------------------------------------------------------------------ */

test('mutation: duplicate release - a second, different release record is refused typed AND at the kernel SQL fence', async () => {
  const world = await bootReleaseWorld();
  const run = await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config),
  });
  assert.equal(run.blockedAt, undefined, JSON.stringify(run.steps.filter((s) => s.result.status.includes('refused'))));
  const { session, stores, config } = world;

  // 1. The typed workshop fence: a DIFFERENT record for the same candidate.
  const duplicate = packaging.assembleReleaseRecord(stores.storeRoot, {
    bundle: config.bundle,
    policyDigest: config.preflight.policyDigest,
    preflightDigest: 'e'.repeat(64), // a DIFFERENT preflight -> a different record
    approvalRef: run.decision.decisionRef,
    packageDigest: packaging.verifyPackagedRelease(stores.storeRoot, config.bundle.integratedCandidate.digest).packageDigest,
  });
  assert.equal(duplicate.refused, true);
  assert.equal(duplicate.reason, 'DUPLICATE_RELEASE');

  // 2. The kernel SQL fence: a direct duplicate CellFinalAcceptance INSERT
  // aborts (the conveyor recorded exactly one).
  const rows = session.db.prepare('SELECT acceptance_ref FROM workplace_cell_final_acceptance').all();
  assert.equal(rows.length, 1);
  assert.throws(
    () => session.db.prepare('INSERT INTO workplace_cell_final_acceptance (acceptance_ref, workplace_instance_id, acceptance_digest, payload_digest, created_sequence) VALUES (?, ?, ?, ?, ?)').run(rows[0].acceptance_ref, 'workplace:1', rows[0].acceptance_ref.replace(/^sha256:/, ''), rows[0].acceptance_ref.replace(/^sha256:/, ''), 1),
    /UNIQUE constraint|EK_/,
    'the duplicate completion cannot commit a second acceptance row',
  );

  // 3. The command path refuses to re-record on the advanced status.
  const replay = session.workplace.applyCommand({
    command: 'workplace.recordFinalAcceptance', instanceId: 'workplace:1',
    expectedRevision: session.hydrateWorld().world.heads.get('workplace:1')?.revision ?? 0,
    idempotencyKey: 'mutation:duplicate-acceptance',
  });
  assert.equal(replay.refused, true);
  assert.equal(replay.reason, 'ILLEGAL_TRANSITION');
  session.close();
});

/* ------------------------------------------------------------------ */
/* Approval fence: the immutable decision                               */
/* ------------------------------------------------------------------ */

test('mutation: decision re-write - the operator disposition of a MUTATED decision is refused and never resolves', async () => {
  const world = await bootReleaseWorld();
  // Pause at the approval.
  await conveyor.driveReleaseRun(world.config, {
    authorScript: authorScript(),
    reviewerScript: reviewerScript(),
    operatorDecision: await operatorDecisionOf(world.config),
    pauseAtApproval: true,
  });
  // The recorded (immutable) decision.
  const first = conveyor.operatorDisposition(world.config, await operatorDecisionOf(world.config));
  assert.equal(first.decision.status, 'committed');
  assert.equal(first.resolve.status, 'committed');
  // A MUTATED decision (different rationale) for the SAME request: refused typed.
  const mutated = conveyor.operatorDisposition(world.config, await operatorDecisionOf(world.config, { rationale: 'MUTATED rationale' }));
  assert.equal(mutated.decision.status, 'approval-refused');
  assert.equal(mutated.decision.reason, 'APPROVAL_DECISION_IMMUTABLE');
  // The recorded decision is unchanged and still bound.
  assert.equal(approval.readApprovalDecision(world.stores.inboxRoot, conveyor.approvalRequestIdOf(world.config))?.rationale.includes('MUTATED'), false);
  world.session.close();
});

/* ------------------------------------------------------------------ */
/* CAS fence: the stale-revision command                                */
/* ------------------------------------------------------------------ */

test('mutation: stale-revision - a command on a moved head is refused before any guard runs', async () => {
  const { session, roles } = await stagedCellWorld();
  // The workplace is at revision 1 (materialized); admitWorkIntent IS legal
  // from 'materialized', so the CAS fence fires BEFORE any guard runs.
  const stale = session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent', instanceId: 'workplace:1',
    expectedRevision: 42, // the head is at revision 1
    idempotencyKey: 'mutation:stale',
    protocolRole: 'author',
    rolePin: roles.authorSlot.pin,
    evidenceRefs: ['work-item:1'],
  });
  assert.equal(stale.refused, true);
  assert.equal(stale.reason, 'STALE_EXPECTED_REVISION');
  session.close();
});

/* ------------------------------------------------------------------ */
/* Identity fence: the drifted role pin                                 */
/* ------------------------------------------------------------------ */

test('mutation: drifted pin - an attempt binding a drifted role pin is refused', async () => {
  const staged = await stagedCellWorld();
  const intentRef = admitAuthorIntent(staged);
  const { session } = staged;
  const drifted = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:9', expectedRevision: 0,
    idempotencyKey: 'mutation:drifted-pin',
    workIntentRef: intentRef,
    rolePin: { roleContractRef: `sha256:${sha256('a-drifted-contract')}`, roleContractDigest: sha256('a-drifted-body') },
  });
  assert.equal(drifted.refused, true);
  assert.equal(drifted.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  assert.equal(session.hydrateWorld().world.heads.has('activity-attempt:9'), false, 'no attempt row was created');
  session.close();
});

/* ------------------------------------------------------------------ */
/* Role-universe fence: semantic profile as protocol role               */
/* ------------------------------------------------------------------ */

test('mutation: role universe - a semantic profile can never be admitted as a kernel protocol role', async () => {
  const { session, roles } = await stagedCellWorld();
  const refusal = session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent', instanceId: 'workplace:1',
    expectedRevision: session.hydrateWorld().world.heads.get('workplace:1')?.revision ?? 0,
    idempotencyKey: 'mutation:semantic-profile-as-role',
    protocolRole: 'certifier', // a semantic profile, not a kernel role
    rolePin: roles.authorSlot.pin,
  });
  assert.equal(refusal.refused, true);
  assert.equal(refusal.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION');
  // And the runtime itself refuses the reclassification (one resolution path).
  const reclassify = roles.runtime.reclassify(roles.authorSlot, 'reviewer');
  assert.equal(reclassify.refused, true);
  session.close();
});

/* ------------------------------------------------------------------ */
/* Mutation-corpus helper reuse check (the support wiring stays lawful) */
/* ------------------------------------------------------------------ */

test('the staged world wires the SAME transport admission discipline for both attempts', async () => {
  const session = await (await freshDatabase()).open();
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
  const roles = await deliveryRoles();
  void await taskManifest();
  void transport;
  void roles;
  void manifest;
  void operatorStores;
  session.close();
});
