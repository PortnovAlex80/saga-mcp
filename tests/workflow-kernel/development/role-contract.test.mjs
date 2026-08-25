/**
 * role-contract.test.mjs - WP-08 deliverable 3: resolve the frozen
 * CanonicalRoleContract ONCE at WorkIntent creation; dispatcher, runner,
 * prompt builder and tracker receive the SAME reference/digest without
 * reclassification.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { roleRuntime } from './support.mjs';

test('each launch kind resolves exactly once; repeated calls never re-resolve', async () => {
  const { runtime, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
  const first = runtime.resolveOnce(authorLaunchKind);
  assert.equal(first.resolved, true);
  for (let index = 0; index < 5; index += 1) {
    const again = runtime.resolveOnce(authorLaunchKind);
    assert.equal(again.resolved, true);
    assert.equal(again.slot, first.slot, 'the SAME slot object is returned (cached, no re-resolution)');
  }
  runtime.resolveOnce(reviewerLaunchKind);
  runtime.resolveOnce(reviewerLaunchKind);
  assert.equal(runtime.resolutionCount, 2, 'exactly one resolution per launch kind');
});

test('dispatcher, runner, prompt builder and tracker receive the same reference/digest', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const { slot } = runtime.resolveOnce(authorLaunchKind);
  const dispatcher = runtime.dispatcherView(slot);
  const runner = runtime.runnerView(slot);
  const promptBuilder = runtime.promptBuilderView(slot);
  const tracker = runtime.trackerView(slot);
  // Object identity: the SAME pin object travels everywhere.
  assert.equal(dispatcher.pin, slot.pin);
  assert.equal(runner.pin, slot.pin);
  assert.equal(promptBuilder.pin, slot.pin);
  assert.equal(tracker.pin, slot.pin);
  assert.equal(dispatcher.pin, runner.pin);
  assert.equal(dispatcher.pin, tracker.pin);
  // Value equality of the reference/digest across all four consumers.
  for (const view of [dispatcher, runner, promptBuilder, tracker]) {
    assert.equal(view.roleContractRef, slot.pin.roleContractRef);
    assert.equal(view.roleContractDigest, slot.pin.roleContractDigest);
    assert.equal(view.launchKind, authorLaunchKind);
    assert.equal(view.protocolRole, slot.protocolRole);
  }
  // Views are cheap and re-derivation-free: no resolution happened.
  assert.equal(runtime.resolutionCount, 1);
});

test('the pin verifies against the WP-17 resolver (the one resolution path)', async () => {
  const resolver = await import('../../../dist/workflow-kernel/roles/resolver.js');
  const digest = await import('../../../dist/workflow-kernel/domain/digest.js');
  const { runtime, authorLaunchKind, author } = await roleRuntime();
  const { slot } = runtime.resolveOnce(authorLaunchKind);
  const resolution = resolver.resolveRoleContract(
    resolver.installRoleContracts([author]).set,
    slot.pin,
  );
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.contract.contractDigest, digest.contractDigestOf(author));
  assert.equal(slot.pin.roleContractDigest, author.contractDigest);
  // A drifted digest is refused fail-closed (no substitute contract).
  const drifted = resolver.resolveRoleContract(
    resolver.installRoleContracts([author]).set,
    { roleContractRef: slot.pin.roleContractRef, roleContractDigest: 'f'.repeat(64) },
  );
  assert.equal(drifted.refused, true);
  assert.equal(drifted.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
});

test('reclassification is refused: semantic profiles are never kernel roles (mutation k)', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const { slot } = runtime.resolveOnce(authorLaunchKind);
  for (const semantic of ['planner', 'implementer', 'reviewer', 'certifier']) {
    const attempt = runtime.reclassify(slot, semantic);
    assert.equal(attempt.refused, true, `${semantic} must be refused`);
    assert.equal(attempt.reason, 'PROTOCOL_ROLE_UNIVERSE_VIOLATION');
  }
  // Even a legal protocol role name cannot re-key a resolved slot.
  const roleSwap = runtime.reclassify(slot, 'author');
  assert.equal(roleSwap.refused, true);
  assert.equal(roleSwap.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  // The slot itself is unchanged.
  assert.equal(slot.protocolRole, 'author');
});

test('unknown launch kinds are refused; the runtime never guesses a contract', async () => {
  const { runtime } = await roleRuntime();
  const outcome = runtime.resolveOnce('development.does-not-exist.author');
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  assert.equal(runtime.resolutionCount, 0);
});

test('author and reviewer launch kinds pin DIFFERENT contracts (exact identity separation)', async () => {
  const { runtime, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
  const author = runtime.resolveOnce(authorLaunchKind);
  const reviewer = runtime.resolveOnce(reviewerLaunchKind);
  assert.notEqual(author.slot.pin.roleContractDigest, reviewer.slot.pin.roleContractDigest);
  assert.equal(author.slot.protocolRole, 'author');
  assert.equal(reviewer.slot.protocolRole, 'reviewer');
});
