/**
 * roles.test.mjs - the CanonicalRoleContract bindings of the Formalization
 * workshop (WP-11F): exact role-universe equality, ONE resolution path,
 * the SAME pin object seen by dispatcher/runner/prompt-builder/tracker,
 * and reclassification refusals (mutation k).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { formalizationRoles } from './support.mjs';

test('the workshop binds exactly the two frozen-manifest launch kinds with exact role-universe equality', async () => {
  const roles = await import('../../../../dist/workflow-kernel/workshops/formalization/roles.js');
  assert.equal(roles.FORMALIZATION_AUTHOR_LAUNCH_KIND, 'formalization.implementation.author');
  assert.equal(roles.FORMALIZATION_REVIEWER_LAUNCH_KIND, 'formalization.implementation.reviewer');
  assert.deepEqual(roles.KERNEL_PROTOCOL_ROLE_UNIVERSE, ['author', 'reviewer']);
  const { runtime, author, reviewer } = await formalizationRoles();
  assert.ok(['author', 'reviewer'].includes(author.protocolRole));
  assert.ok(['author', 'reviewer'].includes(reviewer.protocolRole));
  // The compiled contracts are content-addressed under the one canonical rule.
  assert.match(author.roleContractRef, /^sha256:[0-9a-f]{64}$/);
  assert.match(reviewer.roleContractRef, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(author.contractDigest, reviewer.contractDigest);
  // The runtime itself enforces the universe at construction (a foreign
  // protocol role cannot be installed - the forged contract is made
  // self-consistent so ONLY the universe fence can catch it).
  const { digestExcluding } = await import('../../../../dist/workflow-kernel/domain/digest.js');
  const { contractDigest, roleContractRef, ...authorBody } = author;
  void contractDigest;
  void roleContractRef;
  const forgedDigest = digestExcluding({ ...authorBody, protocolRole: 'planner' }, ['contractDigest', 'roleContractRef']);
  const forged = { ...authorBody, protocolRole: 'planner', contractDigest: forgedDigest, roleContractRef: `sha256:${forgedDigest}` };
  assert.throws(
    () => new roles.FormalizationRoleRuntime([{ launchKind: 'formalization.implementation.author', contract: forged }]),
    /FORMALIZATION_ROLE_UNIVERSE_VIOLATION/,
  );
});

test('ONE resolution path: each launch kind resolves exactly once (cached slot, counter stays at one per kind)', async () => {
  const { runtime, roles } = await formalizationRoles();
  const first = runtime.resolveOnce(roles.FORMALIZATION_AUTHOR_LAUNCH_KIND);
  assert.equal(first.resolved, true);
  for (let i = 0; i < 5; i += 1) {
    const again = runtime.resolveOnce(roles.FORMALIZATION_AUTHOR_LAUNCH_KIND);
    assert.equal(again.resolved, true);
    // The SAME slot object is returned (identity-stable, never re-resolved).
    assert.equal(again.slot, first.slot);
  }
  assert.equal(runtime.resolutionCount, 1, 'the author resolved exactly once');
  runtime.resolveOnce(roles.FORMALIZATION_REVIEWER_LAUNCH_KIND);
  assert.equal(runtime.resolutionCount, 2, 'the reviewer resolved exactly once');
});

test('a fresh runtime resolves one slot per launch kind over repeated calls', async () => {
  const { runtime, roles } = await formalizationRoles();
  const a1 = runtime.resolveOnce(roles.FORMALIZATION_AUTHOR_LAUNCH_KIND);
  const r1 = runtime.resolveOnce(roles.FORMALIZATION_REVIEWER_LAUNCH_KIND);
  assert.equal(a1.resolved && r1.resolved, true);
  assert.equal(runtime.resolutionCount, 2);
  runtime.resolveOnce(roles.FORMALIZATION_AUTHOR_LAUNCH_KIND);
  runtime.resolveOnce(roles.FORMALIZATION_REVIEWER_LAUNCH_KIND);
  assert.equal(runtime.resolutionCount, 2, 're-resolution never happens (cached slot)');
});

test('dispatcher, runner, prompt-builder and tracker see the SAME pin object and digest', async () => {
  const roles = await import('../../../../dist/workflow-kernel/workshops/formalization/roles.js');
  const { runtime } = await formalizationRoles();
  const slot = runtime.resolveOnce(roles.FORMALIZATION_AUTHOR_LAUNCH_KIND).slot;
  const views = [
    runtime.dispatcherView(slot),
    runtime.runnerView(slot),
    runtime.promptBuilderView(slot),
    runtime.trackerView(slot),
  ];
  assert.deepEqual(views.map((view) => view.consumer), ['dispatcher', 'runner', 'prompt-builder', 'tracker']);
  const [dispatcher, runner, builder, tracker] = views;
  assert.equal(dispatcher.pin, slot.pin);
  assert.equal(runner.pin, slot.pin);
  assert.equal(builder.pin, slot.pin);
  assert.equal(tracker.pin, slot.pin);
  assert.equal(dispatcher.roleContractDigest, runner.roleContractDigest);
  assert.equal(runner.roleContractDigest, builder.roleContractDigest);
  assert.equal(builder.roleContractDigest, tracker.roleContractDigest);
  assert.equal(dispatcher.roleContractRef, slot.pin.roleContractRef);
});

test('reclassification is refused: a semantic profile can never re-key a resolved slot (mutation k)', async () => {
  const roles = await import('../../../../dist/workflow-kernel/workshops/formalization/roles.js');
  const { runtime } = await formalizationRoles();
  const slot = runtime.resolveOnce(roles.FORMALIZATION_AUTHOR_LAUNCH_KIND).slot;
  for (const profile of ['planner', 'implementer', 'reviewer', 'certifier']) {
    const outcome = runtime.reclassify(slot, profile);
    assert.equal(outcome.refused, true, `${profile} must be refused`);
    assert.equal(outcome.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION');
  }
  const other = runtime.reclassify(slot, 'author');
  assert.equal(other.refused, true);
  assert.equal(other.reason, 'ROLE_CONTRACT_REF_MISMATCH');
});

test('an unknown launch kind is a typed refusal, never an inference', async () => {
  const roles = await import('../../../../dist/workflow-kernel/workshops/formalization/roles.js');
  const { runtime } = await formalizationRoles();
  const outcome = runtime.resolveOnce('formalization.implementation.certifier');
  assert.equal(outcome.resolved, undefined);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'ROLE_CONTRACT_REF_MISMATCH');
});
