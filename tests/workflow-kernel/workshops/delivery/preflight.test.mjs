/**
 * preflight.test.mjs - WP-11L: the CheckPlan + semantic gates over the
 * verified bundle - deterministic declared providers, fail-closed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVerifiedBundle } from './support.mjs';

const preflight = await import('../../../../dist/workflow-kernel/workshops/delivery/preflight.js');
const manifest = await import('../../../../dist/workflow-kernel/workshops/delivery/manifest.js');

test('the declared release policy preflights green over the verified bundle', async () => {
  const bundle = await buildVerifiedBundle();
  const run = preflight.runPreflight(bundle);
  assert.equal(run.refused, undefined, JSON.stringify(run));
  assert.equal(run.complete, true);
  assert.deepEqual(
    run.checks.map((check) => [check.checkId, check.outcome]),
    manifest.DELIVERY_CHECK_IDS.map((checkId) => [checkId, 'passed']),
    'every declared check ran through its deterministic provider',
  );
  assert.match(run.preflightDigest, /^[0-9a-f]{64}$/);
  assert.equal(run.candidateDigest, bundle.integratedCandidate.digest, 'the snapshot binds the exact candidate');
  assert.equal(run.policyDigest, manifest.deliveryPolicyDigestOf(manifest.DELIVERY_RELEASE_POLICY));
});

test('the preflight snapshot is a pure function of the bundle + policy (deterministic)', async () => {
  const bundle = await buildVerifiedBundle();
  const first = preflight.runPreflight(bundle);
  const second = preflight.runPreflight(bundle);
  assert.equal(first.preflightDigest, second.preflightDigest);
  const otherBundle = await buildVerifiedBundle({ certificateDecision: 'verified' });
  assert.equal(preflight.runPreflight(otherBundle).preflightDigest, first.preflightDigest);
});

test('refusal: PREFLIGHT_FAILED - an unverified certificate fails the gate typed', async () => {
  const bundle = await buildVerifiedBundle({ certificateDecision: 'self-declared' });
  const run = preflight.runPreflight(bundle);
  assert.equal(run.refused, true);
  assert.equal(run.reason, 'PREFLIGHT_FAILED');
  assert.deepEqual([...run.checkIds], ['certificate-verified'], 'the exact failed check is named');
});

test('refusal: UNDECLARED_CHECK - an undeclared check id never runs (fail-closed)', async () => {
  const bundle = await buildVerifiedBundle();
  const run = preflight.runPreflight(bundle, {
    ...manifest.DELIVERY_RELEASE_POLICY,
    requiredCheckIds: [...manifest.DELIVERY_CHECK_IDS, 'deploy-to-production'],
  });
  assert.equal(run.refused, true);
  assert.equal(run.reason, 'UNDECLARED_CHECK');
  assert.deepEqual([...run.checkIds], ['deploy-to-production']);
  assert.match(run.detail, /never runs/);
});

test('refusal: POLICY_NOT_LOCAL - an external-deployment policy never preflights', async () => {
  const bundle = await buildVerifiedBundle();
  const run = preflight.runPreflight(bundle, { ...manifest.DELIVERY_RELEASE_POLICY, externalDeployment: true });
  assert.equal(run.refused, true);
  assert.equal(run.reason, 'POLICY_NOT_LOCAL');
  assert.match(run.detail, /credential|local/i);
});

test('refusal: POLICY_NOT_LOCAL - a credential-dependent policy never preflights', async () => {
  const bundle = await buildVerifiedBundle();
  const run = preflight.runPreflight(bundle, { ...manifest.DELIVERY_RELEASE_POLICY, credentials: 'registry-token' });
  assert.equal(run.refused, true);
  assert.equal(run.reason, 'POLICY_NOT_LOCAL');
});

test('the workshop manifest is declaration data: role universe, providers, product contracts', () => {
  // Exact role-universe equality over the frozen manifest rows.
  const bindings = manifest.deliveryBindings();
  assert.equal(bindings.length, 2);
  const universe = manifest.assertDeliveryRoleUniverse(bindings);
  assert.equal(universe.ok, true, JSON.stringify(universe));
  assert.deepEqual([...universe.roles], ['author', 'reviewer']);
  // The workshop identity derives from the launch-kind prefix, never a quoted literal.
  assert.equal(manifest.workshopOfLaunchKind(manifest.DELIVERY_AUTHOR_LAUNCH_KIND).length > 0, true);
  // Declared providers are deterministic and local.
  for (const checkId of manifest.DELIVERY_CHECK_IDS) {
    assert.equal(typeof manifest.DECLARED_CHECK_PROVIDERS[checkId], 'function', `${checkId} has a declared provider`);
  }
  assert.equal(manifest.DELIVERY_RELEASE_POLICY.externalDeployment, false);
  assert.equal(manifest.DELIVERY_RELEASE_POLICY.credentials, 'none');
  assert.deepEqual([...manifest.DELIVERY_RELEASE_POLICY.requiredCheckIds], [...manifest.DELIVERY_CHECK_IDS]);
});

test('refusal: ROLE_UNIVERSE_MISMATCH - a widened role universe is refused typed', () => {
  const widened = manifest.assertDeliveryRoleUniverse([
    ...manifest.deliveryBindings(),
    { ...manifest.deliveryBinding(manifest.DELIVERY_AUTHOR_LAUNCH_KIND), protocolRole: 'certifier' },
  ]);
  assert.equal(widened.refused, true);
  assert.equal(widened.reason, 'ROLE_UNIVERSE_MISMATCH');
});
