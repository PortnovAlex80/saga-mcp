/**
 * role-bindings.test.mjs - WP-11V deliverable 2: the REAL workshop
 * CanonicalRoleContract bindings - author/reviewer/certifier over the
 * actual compiled contracts - with EXACT role-universe equality against
 * the frozen installed manifest and the pre-cutover digest-consensus proof
 * (dispatcher, runner, prompt-builder and tracker see the SAME frozen
 * reference/digest pair, same pin object, one resolution per launch kind).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, driveToWorkplace, buildCapsuleFixture, LINEAGE, CAPSULE_BYTES } from './support.mjs';
import { scenarioConfig } from './support.mjs';

const bindings = await import('../../../../dist/workflow-kernel/workshops/development/bindings.js');
const runtimeModule = await import('../../../../dist/workflow-kernel/development/role-contract-runtime.js');
const compiler = await import('../../../../dist/workflow-kernel/roles/compiler.js');

test('the real contracts compile over the frozen manifest rows of this workshop', () => {
  const compiled = bindings.compileDevelopmentContracts();
  assert.equal(compiled.bound, true, JSON.stringify(compiled));
  const { author, reviewer, certifier, launchKinds } = compiled.value;
  assert.equal(launchKinds.author, 'development.implementation.author');
  assert.equal(launchKinds.reviewer, 'development.implementation.reviewer');
  assert.equal(launchKinds.certifier, 'lifecycle.certification.certifier');
  // The two Workplace identities are exact and separate (different digests).
  assert.notEqual(author.contractDigest, reviewer.contractDigest);
  assert.equal(author.protocolRole, 'author');
  assert.equal(reviewer.protocolRole, 'reviewer');
  // The certifier is the D4 operator contract over the lifecycle command, never a Workplace role.
  assert.equal(certifier.ownerAggregate, 'LifecycleRun');
  assert.equal(certifier.ownedCommand, 'lifecycleRun.verifyTerminalClaims');
  assert.ok(certifier.evidenceObligations.includes('obligation:verifyTerminalClaims'));
});

test('EXACT role-universe equality: the workshop universe equals the frozen manifest universe', () => {
  const compiled = bindings.compileDevelopmentContracts();
  const assertion = bindings.assertExactRoleUniverse(compiled.value);
  assert.equal(assertion.equal, true, JSON.stringify(assertion));
  assert.deepEqual([...assertion.manifest.protocolRoles].sort(), ['author', 'reviewer']);
  assert.deepEqual([...assertion.manifest.semanticProfiles].sort(), ['certifier', 'implementer', 'planner', 'reviewer']);
});

test('role-universe drift is a typed refusal (invented role, foreign launch kind, re-keyed row)', async () => {
  const compiled = bindings.compileDevelopmentContracts();
  const { RoleContractRuntime } = runtimeModule;

  // A semantic profile can never reclassify a resolved slot (mutation k).
  const runtime = new RoleContractRuntime([
    { launchKind: compiled.value.launchKinds.author, contract: compiled.value.author },
    { launchKind: compiled.value.launchKinds.reviewer, contract: compiled.value.reviewer },
  ]);
  const slot = runtime.resolveOnce(compiled.value.launchKinds.author);
  assert.equal(slot.resolved, true);
  for (const profile of ['planner', 'implementer', 'reviewer', 'certifier']) {
    const reclassification = runtime.reclassify(slot.slot, profile);
    assert.equal(reclassification.refused, true, `${profile} may never re-key a slot`);
    assert.equal(reclassification.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION');
  }

  // An unknown launch kind has no contract (fail-closed, no fallback).
  const foreign = runtime.resolveOnce('development.implementation.certifier');
  assert.equal(foreign.refused, true);
  assert.equal(foreign.reason, 'ROLE_CONTRACT_REF_MISMATCH');

  // A compile over a launch kind outside the manifest is impossible at the
  // source of truth: the fixture builders are keyed to frozen rows.
  assert.equal(compiler.manifestBindingByLaunchKind('reporting.implementation.author'), undefined, 'a foreign launch kind has no manifest row');

  // Kernel fence: workplace.admitWorkIntent with a semantic profile as the
  // protocol role is refused by the kernel guard (mutation k).
  const session = await (await freshDatabase('ek-wp11v-roles-')).open();
  const capsule = await buildCapsuleFixture();
  const ingress = await import('../../../../dist/workflow-kernel/development/capsule.js');
  assert.equal(ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  }).imported, true);
  await driveToWorkplace(session);
  const refused = session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', expectedRevision: 1,
    idempotencyKey: 'bindings:certifier-role', protocolRole: 'certifier',
    rolePin: slot.slot.pin, evidenceRefs: ['work-item:1'],
  });
  assert.equal(refused.refused, true);
  assert.equal(refused.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION');
  session.close();
});

test('PRE-CUTOVER DIGEST CONSENSUS: dispatcher, runner, prompt-builder and tracker see the same pair', () => {
  const consensus = bindings.bindingConsensus();
  assert.equal(consensus.bound, true, JSON.stringify(consensus));
  const rows = consensus.value;
  assert.equal(rows.length, 2, 'one consensus row per Workplace launch kind');
  const expectedConsumers = ['dispatcher', 'prompt-builder', 'runner', 'tracker'];
  for (const entry of rows) {
    assert.equal(entry.consensusHolds, true);
    assert.deepEqual(entry.consumers.map((row) => row.consumer).sort(), expectedConsumers);
    for (const consumer of entry.consumers) {
      assert.equal(consumer.samePinObject, true, `${consumer.consumer} carries the SAME pin object`);
      assert.equal(consumer.roleContractDigest, entry.consumers[0].roleContractDigest);
      assert.equal(consumer.roleContractRef, entry.consumers[0].roleContractRef);
    }
    // One resolution per launch kind (no re-resolution).
    assert.equal(entry.resolutionCount, rows.indexOf(entry) + 1);
  }
  // Author and reviewer pins differ (exact identities).
  assert.notEqual(rows[0].consumers[0].roleContractDigest, rows[1].consumers[0].roleContractDigest);
});

test('the exact pin of a launch kind is the pair a WorkIntent carries', async () => {
  const { config, session } = await scenarioConfig();
  const compiled = bindings.compileDevelopmentContracts();
  const pin = bindings.pinOfLaunchKind(compiled.value, config.authorLaunchKind);
  assert.match(pin.roleContractRef, /^sha256:[0-9a-f]{64}$/);
  assert.match(pin.roleContractDigest, /^[0-9a-f]{64}$/);
  session.close();
});
