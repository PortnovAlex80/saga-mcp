/**
 * roles.test.mjs - FRF-WP05 role binding via the WP-17 pattern: the ONE
 * compiler/resolver path, exactly-once resolution per launch kind, the
 * shared frozen pin objects, the kernel protocol-role universe fence and
 * the desk-skill pinning of both cognition seats.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cell, dist } from './support.mjs';

test('the Cell binds exactly the two frozen-manifest launch kinds of the workshop', async () => {
  const c = await cell();
  const compiler = await dist('workflow-kernel/roles/compiler.js');
  const authorBinding = compiler.manifestBindingByLaunchKind('formalization.implementation.author');
  const reviewerBinding = compiler.manifestBindingByLaunchKind('formalization.implementation.reviewer');
  assert.ok(authorBinding, 'the author launch kind is in the frozen manifest');
  assert.ok(reviewerBinding, 'the reviewer launch kind is in the frozen manifest');
  const author = c.buildSystemRequirementsAuthorFixture();
  const reviewer = c.buildSystemRequirementsReviewerFixture();
  assert.equal(author.binding.launchKind, 'formalization.implementation.author');
  assert.equal(reviewer.binding.launchKind, 'formalization.implementation.reviewer');
  assert.equal(author.binding.protocolRole, 'author');
  assert.equal(reviewer.binding.protocolRole, 'reviewer');
});

test('both role contracts compile through the ONE compiler and pin the desk skill', async () => {
  const c = await cell();
  const compiler = await dist('workflow-kernel/roles/compiler.js');
  for (const build of [c.buildSystemRequirementsAuthorFixture, c.buildSystemRequirementsReviewerFixture]) {
    const outcome = compiler.compileRoleContract(build());
    assert.equal(outcome.compiled, true, `compile errors: ${JSON.stringify(outcome.errors ?? [])}`);
    assert.equal(outcome.contract.semanticSkillDigest, c.SYSTEM_REQUIREMENTS_SKILL_DECLARATION.digest);
    assert.match(outcome.contract.semanticSkillRef, /^sha256:[0-9a-f]{64}$/);
    assert.equal(outcome.contract.roleContractRef, `sha256:${outcome.contract.contractDigest}`);
  }
});

test('the author contract consumes the upstream surfaces and produces the bundle contract kinds', async () => {
  const c = await cell();
  const compiler = await dist('workflow-kernel/roles/compiler.js');
  const support = await dist('workflow-kernel/roles/fixtures/support.js');
  const outcome = compiler.compileRoleContract(c.buildSystemRequirementsAuthorFixture());
  assert.ok(outcome.compiled);
  // Product-contract refs are content-addressed through the one synthetic
  // helper (the workshop convention): the author consumes the two upstream
  // surfaces and produces the bundle + desk product kinds.
  assert.deepEqual(
    outcome.contract.inputProductContracts,
    [
      support.syntheticProductContractRef('frf-contracts.prd-intent-member.v1'),
      support.syntheticProductContractRef('frf-contracts.uc-scenario-member.v1'),
    ],
  );
  assert.deepEqual(
    outcome.contract.outputProductContracts,
    [
      support.syntheticProductContractRef('frf-contracts.requirements-bundle.v1'),
      support.syntheticProductContractRef('formalization.system-requirements.v1'),
    ],
  );
});

test('install + resolve: each launch kind resolves EXACTLY ONCE; consumers share the frozen pin', async () => {
  const c = await cell();
  const install = c.installSystemRequirementsRoles();
  const { runtime } = install;
  assert.equal(runtime.resolutionCount, 0, 'nothing resolved before the first resolveOnce');
  const authorFirst = runtime.resolveOnce(install.authorLaunchKind);
  assert.equal(authorFirst.resolved, true);
  const authorAgain = runtime.resolveOnce(install.authorLaunchKind);
  assert.equal(authorAgain.resolved, true);
  assert.equal(runtime.resolutionCount, 1, 'the second resolveOnce is the SAME cached slot, not a second resolution');
  assert.equal(authorAgain.slot, authorFirst.slot, 'identity-stable slot object');
  const reviewerFirst = runtime.resolveOnce(install.reviewerLaunchKind);
  assert.equal(reviewerFirst.resolved, true);
  assert.equal(runtime.resolutionCount, 2);
  // The four consumers receive the same pin object.
  const dispatcher = runtime.dispatcherView(authorFirst.slot);
  const runner = runtime.runnerView(authorFirst.slot);
  const promptBuilder = runtime.promptBuilderView(authorFirst.slot);
  const tracker = runtime.trackerView(authorFirst.slot);
  for (const view of [dispatcher, runner, promptBuilder, tracker]) {
    assert.equal(view.pin, authorFirst.slot.pin, `${view.consumer} shares the frozen pin object`);
    assert.equal(view.launchKind, 'formalization.implementation.author');
  }
  assert.equal(dispatcher.pin, tracker.pin);
});

test('reclassification of a resolved slot is refused (semantic profiles are not kernel roles)', async () => {
  const c = await cell();
  const install = c.installSystemRequirementsRoles();
  const author = install.runtime.resolveOnce(install.authorLaunchKind);
  assert.equal(author.resolved, true);
  for (const requested of ['planner', 'implementer', 'reviewer', 'certifier', 'author']) {
    const reclassification = install.runtime.reclassify(author.slot, requested);
    // Every route out of the frozen slot is a typed refusal or a
    // reclassified:false outcome - never a re-keyed slot.
    assert.ok(
      reclassification.refused === true || reclassification.reclassified === false,
      `${requested} can never re-key a resolved slot`,
    );
  }
});

test('an unknown launch kind is refused typed (no second resolution path)', async () => {
  const c = await cell();
  const install = c.installSystemRequirementsRoles();
  const outcome = install.runtime.resolveOnce('formalization.implementation.certifier');
  assert.equal(outcome.resolved, undefined);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'ROLE_CONTRACT_REF_MISMATCH');
});

test('both contracts stay inside the kernel protocol-role universe', async () => {
  const c = await cell();
  const install = c.installSystemRequirementsRoles();
  for (const launchKind of [install.authorLaunchKind, install.reviewerLaunchKind]) {
    const resolution = install.runtime.resolveOnce(launchKind);
    assert.equal(resolution.resolved, true);
    assert.ok(['author', 'reviewer'].includes(resolution.slot.protocolRole));
  }
});
