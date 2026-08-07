import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
} = await import('../../dist/modules/development/domain/development-schemas.js');
const {
  ReferenceDevelopmentTaskGraphPolicy,
  hashDevelopmentPolicy,
} = await import('../../dist/modules/development/domain/development-settlement-policy.js');
const {
  buildCanonicalDevelopmentTaskGraph,
} = await import('../../dist/modules/development/domain/development-task-graph.js');

function developmentCase() {
  const policySeed = {
    id: 'test-development-policy',
    version: '1.0.0',
    contentHash: '',
  };
  const policy = {
    ...policySeed,
    contentHash: hashDevelopmentPolicy(policySeed),
  };
  return {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 10,
    formalizationCertificate: {
      schema: 'factory.formalization-certificate.v1',
      ref: 'certificate:formalization:1',
      hash: '1'.repeat(64),
      decision: 'formalized',
    },
    solutionContract: {
      schema: 'factory.solution-contract.v1',
      ref: 'solution-contract:1',
      hash: '2'.repeat(64),
    },
    acceptanceBaselineHash: '3'.repeat(64),
    srs: {
      schema: 'factory.srs.v1',
      ref: 'srs:1',
      hash: '4'.repeat(64),
    },
    acceptanceCriteria: [
      {
        artifactId: 11,
        code: 'AC-1',
        acceptedHash: '5'.repeat(64),
        implementationRequired: true,
        criticality: 'blocker',
      },
      {
        artifactId: 12,
        code: 'AC-2',
        acceptedHash: '6'.repeat(64),
        implementationRequired: true,
        criticality: 'blocker',
      },
    ],
    repositories: [{
      projectRepositoryId: 7,
      integrationBranch: 'dev',
      expectedBaseCommit: 'abc123',
    }],
    policy,
    initiatedBy: 'test',
  };
}

function proposal(coveredIds = [11, 12]) {
  const implementationKey = 'implement-coherent-toggle';
  return {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: [{
      key: implementationKey,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: 7,
      acceptanceCriterionIds: coveredIds,
      dependsOnKeys: [],
      changeScopes: ['product'],
      required: true,
      criticality: 'blocker',
    }],
    verificationItems: [11, 12].map(id => ({
      key: `verify-${id}`,
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: 7,
      acceptanceCriterionIds: [id],
      dependsOnKeys: [implementationKey],
      changeScopes: [],
      required: true,
      criticality: 'blocker',
    })),
    integrationTargets: [{
      projectRepositoryId: 7,
      sourceWorkItemKeys: [implementationKey],
      targetBranch: 'dev',
      expectedBaseCommit: 'abc123',
    }],
  };
}

function validate(coveredIds) {
  const input = developmentCase();
  const graph = buildCanonicalDevelopmentTaskGraph(
    input,
    proposal(coveredIds),
    {
      schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      ref: 'planner-submission:1',
      hash: '7'.repeat(64),
    },
  );
  return new ReferenceDevelopmentTaskGraphPolicy().validate(input, graph);
}

test('one coherent implementation item may cover multiple implementation-required ACs', () => {
  const result = validate([11, 12]);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.reasonCodes.includes('implementation-coverage-gap'), false);
});

test('coverage policy rejects missing AC coverage, not task cardinality', () => {
  const result = validate([11]);
  assert.equal(result.valid, false);
  assert.equal(result.reasonCodes.includes('implementation-coverage-gap'), true);
});
