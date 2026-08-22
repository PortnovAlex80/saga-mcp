// Workshop fix (г) — honest verdict for the synthetic missing-product
// placeholder. When the workset builder cannot bind an accepted product to
// an item it emits {status:'blocked', taskId:0, reasonCodes:
// ['accepted-cell-product-missing']}. The malformed-results disjunct
// `item.taskId <= 0` used to fire on exactly this placeholder and killed
// settlement with failed/implementation-workset-hash-invalid (units epic-8
// cert#37, tips epic-5 cert#40). The placeholder is a settlement INPUT gap:
// the policy must return blocked/implementation-incomplete naming the keys,
// never failed/malformed. Worker-reported blocked items keep their existing
// blocked/implementation-blocked routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  ReferenceDevelopmentSettlementPolicy,
  hashDevelopmentPolicy,
  hashDevelopmentTaskGraph,
  hashImplementationWorkset,
} = await import('../../../dist/modules/development/domain/development-settlement-policy.js');
const {
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
} = await import('../../../dist/modules/development/domain/development-schemas.js');
const { DEVELOPMENT_CASE_SCHEMA } = await import(
  '../../../dist/process-modules/lifecycles/product-delivery-module-contracts.js'
);

const ITEM_KEY = 'item/core';
const COMMIT = 'a'.repeat(40);

function ref(schema, refPath) {
  return { schema, ref: refPath, hash: `${refPath.length}`.padEnd(64, '0') };
}

function makeDevelopmentCase() {
  const policySnapshot = { id: 'dev-policy', version: '1.0.0', contentHash: '' };
  policySnapshot.contentHash = hashDevelopmentPolicy(policySnapshot);
  return {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 7,
    epicId: 8,
    formalizationCertificate: {
      ...ref('factory.development-certificate.v1', 'certificate/8'),
      decision: 'formalized',
    },
    solutionContract: ref('factory.solution-contract.v1', 'solution-contract/8'),
    acceptanceBaselineHash: 'b'.repeat(64),
    srs: ref('artifact.srs.v1', 'artifact/srs/8'),
    acceptanceCriteria: [{
      artifactId: 1,
      code: 'AC-1',
      acceptedHash: 'c'.repeat(64),
      implementationRequired: true,
      criticality: 'blocker',
    }],
    repositories: [{
      projectRepositoryId: 1,
      integrationBranch: 'main',
      expectedBaseCommit: COMMIT,
    }],
    policy: policySnapshot,
    initiatedBy: 'workshop-test',
  };
}

function makeTaskGraph(developmentCase) {
  const body = {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_SCHEMA,
    epicId: developmentCase.epicId,
    formalizationCertificateHash: developmentCase.formalizationCertificate.hash,
    solutionContractHash: developmentCase.solutionContract.hash,
    acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
    srsHash: developmentCase.srs.hash,
    plannerSubmission: ref(DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA, 'proposal/8'),
    implementationItems: [{
      key: ITEM_KEY,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: 1,
      acceptanceCriterionKeys: ['1:AC-1'],
      dependsOnKeys: [],
      changeScopes: ['src/'],
      required: true,
      criticality: 'blocker',
    }],
    verificationItems: [{
      key: `${ITEM_KEY}.verify`,
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: 1,
      acceptanceCriterionKeys: ['1:AC-1'],
      dependsOnKeys: [ITEM_KEY],
      changeScopes: [],
      required: true,
      criticality: 'blocker',
    }],
    integrationTargets: [{
      projectRepositoryId: 1,
      sourceWorkItemKeys: [ITEM_KEY],
      targetBranch: 'main',
      expectedBaseCommit: COMMIT,
    }],
  };
  return { ...body, graphHash: hashDevelopmentTaskGraph(body) };
}

function makeWorkset(taskGraph, result) {
  const body = {
    schemaVersion: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
    taskGraphHash: taskGraph.graphHash,
    results: [result],
    complete: result.status === 'succeeded',
    blockingItemKeys: result.status === 'succeeded' ? [] : [ITEM_KEY],
  };
  return { ...body, worksetHash: hashImplementationWorkset({ ...body, worksetHash: '' }) };
}

function settle(worksetResult) {
  const developmentCase = makeDevelopmentCase();
  const taskGraph = makeTaskGraph(developmentCase);
  const workset = makeWorkset(taskGraph, worksetResult);
  return new ReferenceDevelopmentSettlementPolicy().settle({
    schemaVersion: 'factory.development-settlement-input.v1',
    developmentCase,
    taskGraph,
    implementationWorkset: workset,
    integratedCandidate: null,
    observedCandidateHash: null,
    acceptanceVerification: null,
    productReferences: {
      taskGraph: {
        schema: DEVELOPMENT_TASK_GRAPH_SCHEMA,
        ref: `development-task-graph:${taskGraph.graphHash}`,
        hash: taskGraph.graphHash,
      },
      implementationWorkset: {
        schema: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
        ref: `development-implementation-workset:${workset.worksetHash}`,
        hash: workset.worksetHash,
      },
      integratedCandidate: null,
      acceptanceVerification: null,
    },
    openHumanGateIds: [],
    localReadinessReceipt: null,
  });
}

test('placeholder (taskId:0 / accepted-cell-product-missing) settles blocked/implementation-incomplete, not failed/malformed', () => {
  const outcome = settle({
    key: ITEM_KEY,
    status: 'blocked',
    taskId: 0,
    reviewedSourceCommit: null,
    result: null,
    reasonCodes: ['accepted-cell-product-missing'],
  });
  assert.equal(outcome.decision, 'blocked');
  assert.deepEqual(outcome.reasonCodes, ['implementation-incomplete']);
  assert.match(outcome.rationale, new RegExp(ITEM_KEY),
    'the verdict must name the incomplete item keys');
  assert.ok(!outcome.reasonCodes.includes('implementation-workset-hash-invalid'),
    'a missing accepted product is an input gap, never a malformed workset');
});

test('worker-reported blocked item keeps its blocked/implementation-blocked routing', () => {
  const outcome = settle({
    key: ITEM_KEY,
    status: 'blocked',
    taskId: 901,
    reviewedSourceCommit: null,
    result: null,
    reasonCodes: ['worker-stuck'],
  });
  assert.equal(outcome.decision, 'blocked');
  assert.deepEqual(outcome.reasonCodes, ['implementation-blocked']);
});

test('regression: succeeded item passes the implementation checks and reaches the candidate gate', () => {
  const outcome = settle({
    key: ITEM_KEY,
    status: 'succeeded',
    taskId: 901,
    reviewedSourceCommit: COMMIT,
    result: ref('factory.development-implementation-result.v1', 'managed-node-submission:41'),
    reasonCodes: [],
  });
  // No integrated candidate is provided, so the happy path proves itself by
  // advancing PAST every implementation check to the candidate-missing gate.
  assert.equal(outcome.decision, 'blocked');
  assert.deepEqual(outcome.reasonCodes, ['candidate-missing']);
});
