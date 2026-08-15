import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createDiscoveryLifecycleOutputPayloadResolver,
  createDiscoveryOutputResolver,
} = await import(
  '../../dist/modules/discovery/application/discovery-production-cell-installation.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { sha256Hex } = await import('../../dist/shared/canonical-json.js');

const schema = 'factory.discovery-proposal.v1';
const payload = {
  problem_statement: 'Teach students to compare Mars and Venus trajectories.',
  candidate_scope: 'A locally runnable ballistic calculator with a backend.',
  recommended_outcome: 'go',
};
const digest = sha256Hex(payload);
const processArtifactRef = `product:${schema}:${digest}`;

function dbWithProposal(overrides = {}) {
  const row = {
    schema_id: schema,
    artifact_ref: processArtifactRef,
    product_hash: digest,
    payload_snapshot: JSON.stringify(payload),
    payload_hash: digest,
    ...overrides,
  };
  return {
    prepare() {
      return { all: () => [row] };
    },
  };
}

test('Discovery handoff resolves CandidateSet submission identity to exact process product', () => {
  const resolveOutput = createDiscoveryOutputResolver(dbWithProposal());
  const output = resolveOutput(
    discoveryProcessModule,
    'go',
    {
      event: 'go',
      production: {
        schema: 'factory.discovery-outcome-certificate.v1',
        artifactRef: 'discovery-settlement:1',
        contentHash: 'certificate-hash',
        bindings: {
          proposalSchema: schema,
          proposalRef: 'managed-node-submission:1',
          proposalHash: digest,
        },
      },
    },
    { processRunId: 1, projectId: 1, epicId: 1 },
  );

  assert.deepEqual(output, {
    schema,
    artifactRef: processArtifactRef,
    contentHash: digest,
  });

  const resolvePayload = createDiscoveryLifecycleOutputPayloadResolver(dbWithProposal());
  assert.deepEqual(resolvePayload({
    processRunId: 1,
    moduleRef: discoveryProcessModule.identity,
    projectId: 1,
    epicId: 1,
    output,
  }), payload);
});

test('Discovery handoff fails closed on payload drift', () => {
  const resolvePayload = createDiscoveryLifecycleOutputPayloadResolver(
    dbWithProposal({ payload_snapshot: JSON.stringify({ ...payload, recommended_outcome: 'reject' }) }),
  );
  assert.throws(
    () => resolvePayload({
      processRunId: 1,
      moduleRef: discoveryProcessModule.identity,
      projectId: 1,
      epicId: 1,
      output: { schema, artifactRef: processArtifactRef, contentHash: digest },
    }),
    /does not resolve to the exact proposal/,
  );
});

