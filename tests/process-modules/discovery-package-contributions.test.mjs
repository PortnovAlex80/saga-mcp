import assert from 'node:assert/strict';
import test from 'node:test';

const manifestModule = await import(
  '../../dist/process-modules/modules/discovery/package/manifest.js'
);
const contributions = await import(
  '../../dist/process-modules/modules/discovery/package/contributions/index.js'
);

test('ADR-095: Discovery package declares exactly the live settlement handler', () => {
  assert.deepEqual(manifestModule.DISCOVERY_HANDLER_IDS, {
    settlementPolicy: 'discovery-settlement-policy',
  });
  assert.deepEqual(
    manifestModule.discoveryPackageManifest.handlerRefs.map((ref) => ref.logicalId),
    ['discovery-settlement-policy'],
  );
  assert.ok(manifestModule.discoveryPackageManifest.handlerRefs[0].version > '1.0.0');
});

test('ADR-095: retained capability and guard aggregates contain only live rows', () => {
  assert.deepEqual(
    contributions.DISCOVERY_CAPABILITY_REQUIREMENTS.map((item) => item.ref),
    [
      'capability.saga.managed-production-ledger',
      'capability.saga.discovery-outcome-certificate-issuer',
      'capability.saga.lm-node-execution-persistence',
    ],
  );
  assert.deepEqual(
    contributions.DISCOVERY_GUARD_BINDINGS.map((item) => item.ref),
    [
      'guard.saga.authority.fence',
      'guard.saga.managed-production.provenance',
      'guard.saga.node-allowed-tools',
      'guard.saga.execution-id.fence',
    ],
  );
});

test('ADR-095: retained output contracts match the production-cell flow', () => {
  assert.deepEqual(
    contributions.DISCOVERY_NODE_OUTPUT_CONTRACTS.map((item) => item.schemaId),
    [
      'factory.discovery-proposal.v1',
      'factory.discovery-readiness-assessment.v2',
      'factory.discovery-settlement-input.v1',
    ],
  );
});

test('ADR-095: retained skill resources contain no normalizer or diagnosis lane', () => {
  const ids = contributions.DISCOVERY_SKILL_RESOURCES.map((item) => item.logicalId);
  assert.deepEqual(ids, [
    'discovery.skill.reviewer.readiness',
    'discovery.skill.worker',
    'discovery.skill.protocol',
    'discovery.skill.reviewer.kickstart',
  ]);
  assert.equal(ids.some((id) => /normaliz|diagnos/.test(id)), false);
});

test('ADR-095: contributions barrel exports no dead adapter/tool surface', () => {
  for (const name of [
    'DISCOVERY_TOOL_CONTRIBUTIONS',
    'createDiscoveryPackageHandlerAdapter',
    'createFakeDiscoveryBriefProvisioningPort',
    'DISCOVERY_CAP_RUNTIME_PERSISTENCE',
    'DISCOVERY_CAP_SETTLEMENT_POLICY_REPOSITORY',
    'DISCOVERY_GUARD_DIAGNOSIS_ADVISORY',
  ]) {
    assert.equal(Object.hasOwn(contributions, name), false, `${name} must stay retired`);
  }
});
