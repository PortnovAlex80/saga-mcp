import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createDevelopmentKernelHandlers,
  DEVELOPMENT_NODE_IDS,
} = await import(
  '../../dist/modules/development/application/development-installation.js'
);
const {
  DEVELOPMENT_KERNEL_HANDLER_IDS,
} = await import(
  '../../dist/modules/development/domain/development-kernel-ports.js'
);
const {
  developmentProcessModule,
} = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
} = await import(
  '../../dist/modules/development/domain/development-schemas.js'
);
const {
  ReferenceDevelopmentTaskGraphPolicy,
  hashDevelopmentPolicy,
} = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

function developmentCase() {
  const policyBody = { id: 'development-reference', version: '1.0.0' };
  return {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 10,
    formalizationCertificate: {
      schema: 'factory.solution-contract-certificate.v1',
      ref: 'certificate:formalization:1',
      hash: 'formal-cert-hash',
      decision: 'formalized',
    },
    solutionContract: {
      schema: 'factory.solution-contract-certificate.v1',
      ref: 'solution-contract:1',
      hash: 'solution-contract-hash',
    },
    acceptanceBaselineHash: 'acceptance-baseline-hash',
    srs: {
      schema: 'factory.srs.v1',
      ref: 'artifact:201',
      hash: 'srs-hash',
    },
    acceptanceCriteria: [{
      artifactId: 101,
      code: 'AC-1',
      acceptedHash: 'accepted-ac-hash',
      implementationRequired: true,
    }],
    repositories: [{
      projectRepositoryId: 5,
      integrationBranch: 'integration/epic-10',
      expectedBaseCommit: 'base-commit',
    }],
    policy: {
      ...policyBody,
      contentHash: hashDevelopmentPolicy(policyBody),
    },
    initiatedBy: 'test',
  };
}

function validProposal() {
  return {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: [{
      key: 'implement-circle',
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-developer',
      executionMode: 'git_change',
      projectRepositoryId: 5,
      acceptanceCriterionIds: [101],
      dependsOnKeys: [],
      changeScopes: ['product-foundation'],
      required: true,
    }],
    verificationItems: [{
      key: 'verify-ac-1',
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: 5,
      acceptanceCriterionIds: [101],
      dependsOnKeys: ['implement-circle'],
      changeScopes: [],
      required: true,
    }],
    integrationTargets: [{
      projectRepositoryId: 5,
      sourceWorkItemKeys: ['implement-circle'],
      targetBranch: 'integration/epic-10',
      expectedBaseCommit: 'base-commit',
    }],
  };
}

function resolverContext(runInput, proposal) {
  return {
    projectId: 1,
    epicId: 10,
    processRunId: 77,
    node: developmentProcessModule.flow.nodes.find(
      node => node.id === DEVELOPMENT_NODE_IDS.resolveTaskGraph,
    ),
    input: {
      kind: 'task-execution',
      executorKind: 'lm',
      intentId: 501,
      taskId: 601,
      executionId: 'execution-701',
      runtimeStatus: 'completed',
      replayed: false,
    },
    frame: {
      runInput,
      productions: {},
      receipts: {},
    },
    nodeProducts: {
      artifacts: [],
      traces: [],
      submission: {
        submissionId: 1,
        processRunId: 77,
        moduleRef: 'solution-development@1.0.0',
        nodeId: DEVELOPMENT_NODE_IDS.planner,
        intentId: 501,
        taskId: 601,
        executionId: 'execution-701',
        schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
        payload: proposal,
        contentHash: sha256Hex(proposal),
        artifactRef: 'managed-node-submission:1',
        submittedAt: '2026-07-26 12:00:00',
      },
    },
    initiatedBy: 'test',
  };
}

function dependencies(proposal, onMaterialize) {
  const submission = {
    submissionId: 1,
    processRunId: 77,
    moduleRef: 'solution-development@1.0.0',
    nodeId: DEVELOPMENT_NODE_IDS.planner,
    intentId: 501,
    taskId: 601,
    executionId: 'execution-701',
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    payload: proposal,
    contentHash: sha256Hex(proposal),
    artifactRef: 'managed-node-submission:1',
    submittedAt: '2026-07-26 12:00:00',
  };
  const notExecuted = () => {
    throw new Error('unrelated dependency must not execute');
  };
  return {
    plannerSubmissions: {
      // CGAD P18: node-scoped read returns null here so the handler falls back
      // task-scoped fallback explicitly.
      readLatestForNode() { return null; },
      readLatestForTask(query) {
        assert.deepEqual(query, {
          processRunId: 77,
          moduleRef: 'solution-development@1.0.0',
          nodeId: DEVELOPMENT_NODE_IDS.planner,
          taskId: 601,
        });
        return submission;
      },
    },
    taskGraph: {
      materializeValidatedTaskGraph: onMaterialize,
    },
    taskGraphPolicy: new ReferenceDevelopmentTaskGraphPolicy(),
    implementationWorkset: { execute: notExecuted },
    candidateIntegration: { integrateAndFreeze: notExecuted },
    acceptanceVerification: { verify: notExecuted },
    settlementState: { buildSettlementInput: notExecuted },
    outputRepository: {
      persist: notExecuted,
      readByProcessRun: notExecuted,
    },
    settlementPolicy: { settle: notExecuted },
  };
}

test('invalid LM graph is rejected before any task materialization', async () => {
  const runInput = developmentCase();
  const proposal = {
    ...validProposal(),
    verificationItems: [],
  };
  let materializationCalls = 0;
  const handlers = createDevelopmentKernelHandlers(
    dependencies(proposal, () => {
      materializationCalls += 1;
      throw new Error('must not materialize invalid proposal');
    }),
  );
  const result = await handlers[
    DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph
  ](resolverContext(runInput, proposal));
  assert.equal(result.event, 'repair-required');
  assert.equal(result.production.bindings.resolutionStatus, 'rejected');
  assert.equal(
    result.recoveryIssue.policyId,
    'repair-development-task-graph',
  );
  assert.equal(result.recoveryIssue.disposition, 'repair');
  assert.match(
    result.recoveryIssue.summary,
    /verification work for every accepted AC/,
  );
  assert.equal(materializationCalls, 0);
});

test('verification work without an exact frozen repository is rejected', async () => {
  const runInput = developmentCase();
  const proposal = {
    ...validProposal(),
    verificationItems: validProposal().verificationItems.map(item => ({
      ...item,
      projectRepositoryId: null,
    })),
  };
  let materializationCalls = 0;
  const handlers = createDevelopmentKernelHandlers(
    dependencies(proposal, () => {
      materializationCalls += 1;
      throw new Error('must not materialize repository-free verification');
    }),
  );
  const result = await handlers[
    DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph
  ](resolverContext(runInput, proposal));
  assert.equal(result.event, 'repair-required');
  assert.match(result.recoveryIssue.summary, /projectRepositoryId must be an integer/);
  assert.equal(materializationCalls, 0);
});

test('kernel validates and canonicalizes before the materializer sees a graph', async () => {
  const runInput = developmentCase();
  const proposal = validProposal();
  let authorizedGraph = null;
  const handlers = createDevelopmentKernelHandlers(
    dependencies(proposal, ({ graph }) => {
      authorizedGraph = graph;
      return {
        graph,
        reference: {
          schema: DEVELOPMENT_TASK_GRAPH_SCHEMA,
          ref: `development-task-graph:${graph.graphHash}`,
          hash: graph.graphHash,
        },
      };
    }),
  );
  const result = await handlers[
    DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph
  ](resolverContext(runInput, proposal));
  assert.equal(result.event, 'valid');
  assert.equal(result.production.bindings.resolutionStatus, 'valid');
  assert.equal(authorizedGraph.plannerSubmission.ref, 'managed-node-submission:1');
  assert.equal(
    result.production.contentHash,
    authorizedGraph.graphHash,
  );
});
