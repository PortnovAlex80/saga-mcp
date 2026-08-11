import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDevelopmentTaskGraphSubmitCallFromCase,
  isReusableDevelopmentTaskGraphCall,
  prepareDevelopmentWorkspaceTemplate,
} from '../../dist/modules/development/application/development-workspace-preparation.js';

const developmentCase = {
  schemaVersion: 'factory.development-case.v1',
  projectId: 7,
  epicId: 51,
  formalizationCertificate: {
    schema: 'certificate',
    ref: 'certificate:1',
    hash: 'certificate-hash',
    decision: 'formalized',
  },
  solutionContract: {
    schema: 'contract',
    ref: 'contract:1',
    hash: 'contract-hash',
  },
  acceptanceBaselineHash: 'baseline-hash',
  srs: { schema: 'srs', ref: 'artifact:9', hash: 'srs-hash' },
  acceptanceCriteria: [
    {
      criterionId: 15,
      artifactId: 15,
      code: 'AC-15',
      acceptedHash: 'ac-15-hash',
      implementationRequired: true,
    },
    {
      criterionId: 16,
      artifactId: 16,
      code: 'AC-16',
      acceptedHash: 'ac-16-hash',
      implementationRequired: false,
    },
  ],
  repositories: [
    {
      projectRepositoryId: 65,
      integrationBranch: 'integration',
      expectedBaseCommit: 'abc123',
    },
  ],
  policy: { id: 'development', version: '1', contentHash: 'policy-hash' },
  initiatedBy: 'test',
};

function preparationContext(currentContent) {
  return {
    module: {
      identity: {
        name: 'solution-development',
        version: '1.2.0',
        kind: 'development',
      },
    },
    profile: { id: 'development-task-graph-planner' },
    task: {
      id: 8,
      metadata: {
        process_node_input: developmentCase,
      },
    },
    projectId: 7,
    epicId: 51,
    nodeId: 'plan-task-graph',
    declaredPath: 'package/resources/task-graph-submit-call-template.json',
    materializedName: 'task-graph-submit-call.json',
    sourceContent: '{}',
    currentContent,
    isFresh: false,
  };
}

test('seed machine-fills lineage but leaves semantic implementation decomposition to the planner', () => {
  const call = buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase);
  const payload = call.content;

  assert.deepEqual(payload.implementationItems, []);
  assert.deepEqual(
    payload.verificationItems.flatMap(item => item.acceptanceCriterionIds),
    [15, 16],
    'every accepted criterion must still be verified',
  );
  assert.equal(payload.integrationTargets[0].projectRepositoryId, 65);
  assert.equal(payload.integrationTargets[0].targetBranch, 'integration');
  assert.equal(payload.integrationTargets[0].expectedBaseCommit, 'abc123');
  assert.deepEqual(payload.integrationTargets[0].sourceWorkItemKeys, []);
  assert.ok(!JSON.stringify(call).includes('FILL_'));
});

test('atomic criterion identity preserves multiple criteria from one document container', () => {
  // ADR-053: each criterion has its own DB artifact ID — even criteria from
  // the same document container get distinct atomic artifact rows. The
  // identity is the artifactId (the DB row the acceptance check queries by).
  const sharedDocumentCase = structuredClone(developmentCase);
  sharedDocumentCase.acceptanceCriteria = [
    { ...sharedDocumentCase.acceptanceCriteria[0], criterionId: 1501, artifactId: 15 },
    { ...sharedDocumentCase.acceptanceCriteria[1], criterionId: 1502, artifactId: 16 },
  ];
  const payload = buildDevelopmentTaskGraphSubmitCallFromCase(sharedDocumentCase).content;
  assert.deepEqual(
    payload.verificationItems.flatMap(item => item.acceptanceCriterionIds),
    [15, 16],
  );
});

test('preparer replaces an empty, placeholder, or wrong-lineage draft', () => {
  for (const content of [
    '',
    '{}',
    '{"schema":"factory.development-task-graph-proposal.v1","content":{"implementationItems":[]}}',
    JSON.stringify({
      ...buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase),
      content: {
        ...buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase).content,
        integrationTargets: [{
          projectRepositoryId: 77,
          sourceWorkItemKeys: [],
          targetBranch: 'wrong',
          expectedBaseCommit: 'wrong',
        }],
      },
    }),
  ]) {
    const prepared = prepareDevelopmentWorkspaceTemplate(
      preparationContext(content),
    );
    assert.ok(prepared, `expected replacement for ${content}`);
    assert.equal(
      JSON.parse(prepared).content.integrationTargets[0]
        .projectRepositoryId,
      65,
    );
  }
});

test('preparer preserves a reusable semantic draft scoped to the frozen case', () => {
  const original = buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase);
  const customized = structuredClone(original);
  customized.content.implementationItems.push({
    key: 'model-owned-key',
    kind: 'implementation',
    taskKind: 'development.code',
    executionSkill: 'saga-worker',
    executionMode: 'git_change',
    projectRepositoryId: 65,
    acceptanceCriterionIds: [15],
    dependsOnKeys: [],
    changeScopes: ['product-foundation'],
    required: true,
    criticality: 'blocker',
  });
  customized.content.verificationItems[0].dependsOnKeys = [
    'model-owned-key',
  ];
  customized.content.integrationTargets[0].sourceWorkItemKeys = [
    'model-owned-key',
  ];
  const content = `${JSON.stringify(customized, null, 2)}\n`;

  assert.equal(
    isReusableDevelopmentTaskGraphCall(content, developmentCase),
    true,
  );
  assert.equal(
    prepareDevelopmentWorkspaceTemplate(preparationContext(content)),
    null,
  );
});
