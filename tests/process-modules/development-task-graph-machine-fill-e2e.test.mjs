import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { materializePinnedWorkspace } from '../../dist/process-modules/application/pinned-workspace-materializer.js';
import { prepareDevelopmentWorkspaceTemplate } from '../../dist/modules/development/application/development-workspace-preparation.js';

const encoder = new TextEncoder();
const trackerPath = 'resources/process-module-stage-tracker.md';
const callPath = 'resources/task-graph-submit-call-template.json';
const resources = [
  {
    logicalId: 'tracker',
    relativePath: trackerPath,
    kind: 'template',
    content: [
      '# Development',
      '- submission_state: `not-submitted`',
      '- submission_ref:',
      '- submission_hash:',
      '',
    ].join('\n'),
  },
  {
    logicalId: 'call',
    relativePath: callPath,
    kind: 'template',
    content: '{"schema":"factory.development-task-graph-proposal.v1","content":{"schemaVersion":"factory.development-task-graph-proposal.v1","implementationItems":[],"verificationItems":[],"integrationTargets":[]}}\n',
  },
].map(resource => ({
  ...resource,
  digest: `${resource.logicalId}-digest`,
  bytes: encoder.encode(resource.content),
}));

const developmentCase = {
  schemaVersion: 'factory.development-case.v1',
  projectId: 1,
  epicId: 1,
  formalizationCertificate: {
    schema: 'certificate',
    ref: 'certificate:1',
    hash: 'cert-hash',
    decision: 'formalized',
  },
  solutionContract: {
    schema: 'contract',
    ref: 'contract:1',
    hash: 'contract-hash',
  },
  acceptanceBaselineHash: 'baseline-hash',
  srs: { schema: 'srs', ref: 'artifact:1', hash: 'srs-hash' },
  acceptanceCriteria: [{
    artifactId: 101,
    code: 'AC-1',
    acceptedHash: 'ac-hash',
    implementationRequired: true,
  }],
  repositories: [{
    projectRepositoryId: 65,
    integrationBranch: 'integration',
    expectedBaseCommit: 'base-commit',
  }],
  policy: { id: 'policy', version: '1', contentHash: 'policy-hash' },
  initiatedBy: 'test',
};

function request(root, executionId, additionalBindings = {}) {
  const projectionResources = resources.map(({ content: _content, bytes: _bytes, ...item }) => item);
  return {
    projection: {
      installationId: 1,
      moduleRef: 'solution-development@1.1.0',
      packageDigest: 'development-digest',
      storeLocation: 'unused',
      nodeId: 'plan-task-graph',
      executionProfileId: 'development-task-graph-planner',
      skills: {},
      templates: projectionResources,
      checklists: [],
      instructions: [],
      allResources: projectionResources,
      description: {},
    },
    storedPackage: {
      manifest: { definition: {}, assistance: [] },
      resources: resources.map(({ relativePath: _path, content: _content, ...item }) => item),
      packageDigest: 'development-digest',
      storedAt: 'memory',
    },
    workspaceRoot: root,
    module: {
      identity: {
        name: 'solution-development',
        version: '1.1.0',
        kind: 'development',
      },
      flow: { nodes: [] },
    },
    profile: {
      id: 'development-task-graph-planner',
      trackerTemplate: trackerPath,
      workspaceTemplates: [],
      callTemplates: [callPath],
      checklists: [],
      outputSchema: { id: 'factory.development-task-graph-proposal.v1' },
      allowedTools: ['task_get', 'process_node_submit', 'worker_done'],
      semanticSkill: 'saga-planner',
      retryPolicy: { maxAttempts: 15 },
    },
    projectId: 1,
    epicId: 1,
    task: {
      id: 8,
      metadata: {
        process_run_id: 98,
        process_node_id: 'plan-task-graph',
        process_node_input: developmentCase,
      },
    },
    executionId,
    workerId: `worker-${executionId}`,
    additionalBindings,
    templatePreparer: prepareDevelopmentWorkspaceTemplate,
  };
}

test('pinned workspace machine-fills the exact call file read by the reviewer', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-pinned-development-'));
  try {
    const workspace = materializePinnedWorkspace(
      request(root, 'exec-1', {
        SUBMISSION_STATE: 'not-submitted',
        SUBMISSION_REF: '',
        SUBMISSION_HASH: '',
      }),
    );
    const call = JSON.parse(
      readFileSync(path.join(root, workspace.callFiles[0]), 'utf8'),
    );
    assert.equal(
      call.content.integrationTargets[0].projectRepositoryId,
      65,
    );
    assert.deepEqual(
      call.content.verificationItems[0].acceptanceCriterionKeys,
      ['101:AC-1'],
    );
    assert.ok(!JSON.stringify(call).includes('FILL_'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a retry replaces inherited wrong-lineage content and projects submission state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-pinned-development-retry-'));
  try {
    const first = materializePinnedWorkspace(request(root, 'exec-1'));
    writeFileSync(
      path.join(root, first.callFiles[0]),
      '{"schema":"factory.development-task-graph-proposal.v1","content":{"schemaVersion":"factory.development-task-graph-proposal.v1","implementationItems":[],"verificationItems":[],"integrationTargets":[{"projectRepositoryId":77}]}}\n',
    );

    const second = materializePinnedWorkspace(
      request(root, 'exec-2', {
        SUBMISSION_STATE: 'submitted',
        SUBMISSION_REF: 'managed-node-submission:35',
        SUBMISSION_HASH: 'submission-hash',
      }),
    );
    const call = JSON.parse(
      readFileSync(path.join(root, second.callFiles[0]), 'utf8'),
    );
    assert.equal(
      call.content.integrationTargets[0].projectRepositoryId,
      65,
      'frozen DevelopmentCase wins over mutable/current repository state',
    );
    const tracker = readFileSync(second.trackerAbsolutePath, 'utf8');
    assert.match(tracker, /submission_state: `submitted`/);
    assert.match(tracker, /submission_ref: `managed-node-submission:35`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
