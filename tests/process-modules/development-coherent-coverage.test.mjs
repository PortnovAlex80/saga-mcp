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

function validateScopes(leftScopes, rightScopes, rightDependsOn = []) {
  const input = developmentCase();
  const proposalValue = proposal([11, 12]);
  proposalValue.implementationItems = [
    { ...proposalValue.implementationItems[0], key: 'left', acceptanceCriterionIds: [11], changeScopes: leftScopes },
    { ...proposalValue.implementationItems[0], key: 'right', acceptanceCriterionIds: [12], changeScopes: rightScopes, dependsOnKeys: rightDependsOn },
  ];
  proposalValue.verificationItems[0].dependsOnKeys = ['left'];
  proposalValue.verificationItems[1].dependsOnKeys = ['right'];
  proposalValue.integrationTargets[0].sourceWorkItemKeys = ['left', 'right'];
  const graph = buildCanonicalDevelopmentTaskGraph(input, proposalValue, {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:scope',
    hash: '8'.repeat(64),
  });
  return new ReferenceDevelopmentTaskGraphPolicy().validate(input, graph);
}

test('policy-required bootstrap scopes must be assigned to implementation work', () => {
  const input = developmentCase();
  input.policy = {
    id: 'product-build-development-policy',
    version: '1.1.0',
    requiredChangeScopes: ['package.json', 'tests/'],
    contentHash: '',
  };
  input.policy.contentHash = hashDevelopmentPolicy(input.policy);

  const missingGraph = buildCanonicalDevelopmentTaskGraph(input, proposal([11, 12]), {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:bootstrap-missing',
    hash: '9'.repeat(64),
  });
  const missing = new ReferenceDevelopmentTaskGraphPolicy().validate(input, missingGraph);
  assert.equal(missing.valid, false);
  assert.equal(missing.reasonCodes.includes('task-graph-required-scope-missing'), true);

  const completeProposal = proposal([11, 12]);
  completeProposal.implementationItems[0].changeScopes = ['product', 'package.json', 'tests/'];
  const completeGraph = buildCanonicalDevelopmentTaskGraph(input, completeProposal, {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:bootstrap-complete',
    hash: 'a'.repeat(64),
  });
  const complete = new ReferenceDevelopmentTaskGraphPolicy().validate(input, completeGraph);
  assert.equal(complete.valid, true, complete.errors.join('; '));
});

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

// ---------------------------------------------------------------------------
// Worker feedback loop map, Fix-A1: the coverage-gap messages must serialize
// the computable missing/extra AC diff. A generic "does not equal the accepted
// scope" forces the repair worker to re-derive the diff every attempt (the
// P01/counter blind loop).
// ---------------------------------------------------------------------------

test('implementation-coverage-gap message serializes the missing/extra AC diff', () => {
  const missingOnly = validate([11]);
  assert.equal(missingOnly.valid, false);
  const missingMessage = missingOnly.errors
    .find(error => error.includes('required implementation coverage does not equal'));
  assert.ok(missingMessage, 'the enriched coverage-gap message exists');
  assert.match(missingMessage, /missing AC artifact ids: \[12\]/);
  assert.match(missingMessage, /extra AC artifact ids: \[\]/);

  // Covering a NON-accepted AC must be listed as extra.
  const input = developmentCase();
  const extraProposal = proposal([11, 12, 99]);
  const graph = buildCanonicalDevelopmentTaskGraph(input, extraProposal, {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:extra-ac',
    hash: 'b'.repeat(64),
  });
  const extra = new ReferenceDevelopmentTaskGraphPolicy().validate(input, graph);
  assert.equal(extra.valid, false);
  const extraMessage = extra.errors
    .find(error => error.includes('required implementation coverage does not equal'));
  assert.ok(extraMessage);
  assert.match(extraMessage, /missing AC artifact ids: \[\]/);
  assert.match(extraMessage, /extra AC artifact ids: \[99\]/);
});

test('verification-plan-coverage-gap message serializes the missing AC diff', () => {
  const input = developmentCase();
  const proposalValue = proposal([11, 12]);
  proposalValue.verificationItems = proposalValue.verificationItems.slice(0, 1);
  const graph = buildCanonicalDevelopmentTaskGraph(input, proposalValue, {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:verification-gap',
    hash: 'c'.repeat(64),
  });
  const result = new ReferenceDevelopmentTaskGraphPolicy().validate(input, graph);
  assert.equal(result.valid, false);
  assert.equal(result.reasonCodes.includes('verification-plan-coverage-gap'), true);
  const message = result.errors
    .find(error => error.includes('verification work for every accepted AC'));
  assert.ok(message, 'the enriched verification-gap message exists');
  assert.match(message, /missing AC artifact ids: \[12\]/);
  assert.match(message, /extra AC artifact ids: \[\]/);
});

test('directory and descendant file scopes overlap and require dependency order', () => {
  const unordered = validateScopes(['src/ui/pages/'], ['src/ui/pages/mission-planner.ts']);
  assert.equal(unordered.valid, false);
  assert.equal(unordered.reasonCodes.includes('implementation-scope-overlap'), true);

  const ordered = validateScopes(['src/ui/pages/'], ['src/ui/pages/mission-planner.ts'], ['left']);
  assert.equal(ordered.valid, true, ordered.errors.join('; '));
});
