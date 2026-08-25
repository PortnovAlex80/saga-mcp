/**
 * role-bindings.test.mjs - WP-11D deliverable 7: the CanonicalRoleContract
 * bindings of the Discovery roles - ONE WP-17 compile path, ONE resolver
 * path, EXACT role-universe equality, and the identity-stable
 * dispatcher/runner/tracker views proving the same digest.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from './support.mjs';

const bindings = await import('../../../../dist/workflow-kernel/workshops/discovery/role-bindings.js');
const manifestModule = await import('../../../../dist/workflow-kernel/workshops/discovery/installed-manifest.js');
const resolver = await import('../../../../dist/workflow-kernel/roles/resolver.js');

const manifest = manifestModule.installedWorkshopManifest();
const AUTHOR = manifestModule.DISCOVERY_LAUNCH_KINDS.author;
const REVIEWER = manifestModule.DISCOVERY_LAUNCH_KINDS.reviewer;

test('both launch kinds compile through the ONE WP-17 compiler path', () => {
  for (const launchKind of [AUTHOR, REVIEWER]) {
    const compiled = bindings.compileDiscoveryRole(launchKind, manifest);
    assert.equal(compiled.compiled, true, JSON.stringify(compiled.errors ?? compiled));
    assert.match(compiled.pin.roleContractRef, /^sha256:[0-9a-f]{64}$/);
    assert.equal(compiled.pin.roleContractRef, `sha256:${compiled.contract.contractDigest}`);
    // The contract's tools/capabilities are the manifest declarations (data).
    assert.deepEqual(compiled.contract.allowedToolRefs, manifest.tools.map((tool) => tool.toolId));
  }
});

test('the author and reviewer identities are exact and separate', () => {
  const author = bindings.compileDiscoveryRole(AUTHOR, manifest);
  const reviewer = bindings.compileDiscoveryRole(REVIEWER, manifest);
  assert.notEqual(author.pin.roleContractDigest, reviewer.pin.roleContractDigest);
  assert.equal(author.contract.protocolRole, 'author');
  assert.equal(reviewer.contract.protocolRole, 'reviewer');
});

test('the frozen manifest rows are the binding source (discovery rows exist and bind the right profiles)', async () => {
  const compiler = await import('../../../../dist/workflow-kernel/roles/compiler.js');
  const authorRow = compiler.manifestBindingByLaunchKind(AUTHOR);
  const reviewerRow = compiler.manifestBindingByLaunchKind(REVIEWER);
  assert.equal(authorRow.workshop + '.' + authorRow.cellKind + '.' + authorRow.protocolRole, AUTHOR);
  assert.equal(reviewerRow.workshop + '.' + reviewerRow.cellKind + '.' + reviewerRow.protocolRole, REVIEWER);
  assert.equal(authorRow.semanticProfile, 'implementer');
  assert.equal(reviewerRow.semanticProfile, 'reviewer');
});

test('the runtime resolves each launch kind exactly ONCE through the WP-17 resolver', () => {
  const runtime = bindings.discoveryRoleRuntime(manifest);
  assert.equal(runtime.resolutionCount, 2);
  const again = runtime.resolveOnce(AUTHOR);
  assert.equal(again.resolved, true);
  assert.equal(runtime.resolutionCount, 2, 'a cached resolution never re-resolves');
  assert.equal(runtime.isResolved(REVIEWER), true);
});

test('EXACT role-universe equality: the bound protocol roles are exactly {author, reviewer}', () => {
  const runtime = bindings.discoveryRoleRuntime(manifest);
  const equality = bindings.assertRoleUniverseEquality(runtime);
  assert.equal(equality.equal, true, equality.detail);
  assert.deepEqual(equality.protocolRoles, ['author', 'reviewer']);
});

test('a stretched universe is reported, never tolerated', () => {
  // Bind the REVIEWER contract under the AUTHOR launch kind: the exact
  // equality check must report the role swap, never tolerate it.
  const reviewer = bindings.compileDiscoveryRole(REVIEWER, manifest);
  const author = bindings.compileDiscoveryRole(AUTHOR, manifest);
  const swapped = new bindings.DiscoveryRoleRuntime([
    { launchKind: AUTHOR, contract: reviewer.contract },
    { launchKind: REVIEWER, contract: author.contract },
  ]);
  swapped.resolveOnce(AUTHOR);
  swapped.resolveOnce(REVIEWER);
  const equality = bindings.assertRoleUniverseEquality(swapped);
  assert.equal(equality.equal, false);
  assert.match(equality.detail, /author launch kind must bind protocolRole author/);
});

test('dispatcher/runner/tracker views see the SAME digest (one pin object)', () => {
  const runtime = bindings.discoveryRoleRuntime(manifest);
  for (const launchKind of [AUTHOR, REVIEWER]) {
    const slot = runtime.slotOf(launchKind);
    const dispatcher = runtime.dispatcherView(slot);
    const runner = runtime.runnerView(slot);
    const tracker = runtime.trackerView(slot);
    assert.equal(dispatcher.pin, slot.pin, 'the pin is the SAME object');
    assert.equal(runner.pin, dispatcher.pin);
    assert.equal(tracker.pin, dispatcher.pin);
    assert.deepEqual(
      bindings.viewDigests(runtime, launchKind).map((view) => `${view.consumer}:${view.digest}`),
      [`dispatcher:${dispatcher.roleContractDigest}`, `runner:${dispatcher.roleContractDigest}`, `tracker:${dispatcher.roleContractDigest}`],
      'every consumer view transports the identical digest',
    );
  }
});

test('fence: a drifted pin is refused by the resolver (conditional identity, family 2)', () => {
  const author = bindings.compileDiscoveryRole(AUTHOR, manifest);
  const installed = resolver.installRoleContracts([author.contract]);
  assert.equal(installed.installed, true);
  const drifted = resolver.resolveRoleContract(installed.set, {
    roleContractRef: author.pin.roleContractRef,
    roleContractDigest: sha256('drifted-body'),
  });
  assert.equal(drifted.refused, true);
  assert.equal(drifted.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
});

test('fence: a pin outside the closed installed set is refused', () => {
  const author = bindings.compileDiscoveryRole(AUTHOR, manifest);
  const installed = resolver.installRoleContracts([author.contract]);
  assert.equal(installed.installed, true);
  const foreign = resolver.resolveRoleContract(installed.set, {
    roleContractRef: 'sha256:' + sha256('never-installed'),
    roleContractDigest: sha256('never-installed'),
  });
  assert.equal(foreign.refused, true);
  assert.equal(foreign.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  assert.match(foreign.detail, /outside the closed installed set/);
});

test('the route table selects exactly one rule per launch kind (decidable routing)', async () => {
  const compiler = await import('../../../../dist/workflow-kernel/roles/compiler.js');
  const authorInput = bindings.discoveryRoleContractInput(AUTHOR, manifest);
  const reviewerInput = bindings.discoveryRoleContractInput(REVIEWER, manifest);
  const authorTable = authorInput.compileInput.artifacts.executorRoutePolicyTable;
  const reviewerTable = reviewerInput.compileInput.artifacts.executorRoutePolicyTable;
  assert.equal(compiler.countMatchingRouteRules(authorTable, { launchKind: AUTHOR, protocolRole: 'author', semanticProfile: 'implementer' }), 1);
  assert.equal(compiler.countMatchingRouteRules(reviewerTable, { launchKind: REVIEWER, protocolRole: 'reviewer', semanticProfile: 'reviewer' }), 1);
  // Cross-launch-kind facts match zero rules (no accidental multi-match).
  assert.equal(compiler.countMatchingRouteRules(authorTable, { launchKind: REVIEWER, protocolRole: 'reviewer', semanticProfile: 'reviewer' }), 0);
});
