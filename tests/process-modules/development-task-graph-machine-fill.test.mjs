import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDevelopmentTaskGraphSubmitCallFromCase,
  isReusableDevelopmentTaskGraphCall,
  prepareDevelopmentWorkspaceTemplate,
} from '../../dist/process-modules/modules/development/development-workspace-preparation.js';

const developmentCase = {
  schemaVersion: 'saga3.development-case.v1',
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
      artifactId: 15,
      code: 'AC-15',
      acceptedHash: 'ac-15-hash',
      implementationRequired: true,
    },
    {
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
        version: '1.0.0',
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

test('seed comes only from the frozen DevelopmentCase and covers every AC correctly', () => {
  const call = buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase);
  const payload = call.arguments.payload;

  assert.deepEqual(
    payload.implementationItems.flatMap(item => item.acceptanceCriterionIds),
    [15],
    'implementationRequired=false must not create implementation work',
  );
  assert.deepEqual(
    payload.verificationItems.flatMap(item => item.acceptanceCriterionIds),
    [15, 16],
    'every accepted criterion must still be verified',
  );
  assert.equal(payload.integrationTargets[0].projectRepositoryId, 65);
  assert.equal(payload.integrationTargets[0].targetBranch, 'integration');
  assert.equal(payload.integrationTargets[0].expectedBaseCommit, 'abc123');
  assert.ok(!JSON.stringify(call).includes('FILL_'));
});

test('preparer replaces an empty, placeholder, or wrong-lineage draft', () => {
  for (const content of [
    '',
    '{}',
    '{"tool":"process_node_submit","arguments":{"payload":{"implementationItems":[]}}}',
    JSON.stringify({
      ...buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase),
      arguments: {
        ...buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase).arguments,
        payload: {
          ...buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase).arguments.payload,
          integrationTargets: [{
            projectRepositoryId: 77,
            sourceWorkItemKeys: [],
            targetBranch: 'wrong',
            expectedBaseCommit: 'wrong',
          }],
        },
      },
    }),
  ]) {
    const prepared = prepareDevelopmentWorkspaceTemplate(
      preparationContext(content),
    );
    assert.ok(prepared, `expected replacement for ${content}`);
    assert.equal(
      JSON.parse(prepared).arguments.payload.integrationTargets[0]
        .projectRepositoryId,
      65,
    );
  }
});

test('preparer preserves a reusable semantic draft scoped to the frozen case', () => {
  const original = buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase);
  const customized = structuredClone(original);
  customized.arguments.payload.implementationItems[0].key = 'model-owned-key';
  customized.arguments.payload.verificationItems[0].dependsOnKeys = [
    'model-owned-key',
  ];
  customized.arguments.payload.integrationTargets[0].sourceWorkItemKeys = [
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
