import assert from 'node:assert/strict';
import test from 'node:test';

// LR-07 / W5 — bind Development settlement's terminal `verified` decision to
// the EXACT local-ready proof. These focused tests exercise the settlement
// policy directly: the terminal state may be reached ONLY with a local-readiness
// receipt that is present, outcome `passed`, and bound to the exact frozen
// integrated candidate (receipt.candidateHash === candidate.candidateHash).
// Otherwise settlement returns blocked / local-readiness-missing (W5 closed).

const developmentSchemas = await import(
  '../../dist/modules/development/domain/development-schemas.js'
);
const developmentPolicy = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);
const {
  buildCanonicalDevelopmentTaskGraph,
} = await import(
  '../../dist/modules/development/domain/development-task-graph.js'
);

function ref(schema, name, hash) {
  return { schema, ref: `${name}:${hash}`, hash };
}

// Builds a settlement input that is valid through EVERY check that precedes the
// local-readiness gate (implementation complete, candidate frozen + observed,
// acceptance verification passed, no open human gates). Only the
// localReadinessReceipt varies — it is the single load-bearing knob for W5.
function buildInput(localReadinessReceipt) {
  const policyBody = { id: 'development-reference', version: '1.0.0' };
  const developmentCase = {
    schemaVersion: developmentSchemas.DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 10,
    formalizationCertificate: {
      ...ref('factory.formalization-certificate.v1', 'certificate', 'formal-cert'),
      decision: 'formalized',
    },
    solutionContract: ref(
      'factory.solution-contract-certificate.v1',
      'solution-contract',
      'solution-contract-hash',
    ),
    acceptanceBaselineHash: 'baseline-hash',
    srs: ref('factory.formalization-srs.v1', 'artifact', 'srs-hash'),
    acceptanceCriteria: [{
      artifactId: 101,
      code: 'AC-1',
      acceptedHash: 'ac-1-hash',
      implementationRequired: true,
    }],
    repositories: [{
      projectRepositoryId: 5,
      integrationBranch: 'integration/epic-10',
      expectedBaseCommit: 'base-commit',
    }],
    policy: {
      ...policyBody,
      contentHash: developmentPolicy.hashDevelopmentPolicy(policyBody),
    },
    initiatedBy: 'test',
  };
  const proposal = {
    schemaVersion: developmentSchemas.DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: [{
      key: 'implement-ac-1',
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-developer',
      executionMode: 'git_change',
      projectRepositoryId: 5,
      acceptanceCriterionIds: [101],
      dependsOnKeys: [],
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
      dependsOnKeys: ['implement-ac-1'],
      required: true,
    }],
    integrationTargets: [{
      projectRepositoryId: 5,
      sourceWorkItemKeys: ['implement-ac-1'],
      targetBranch: 'integration/epic-10',
      expectedBaseCommit: 'base-commit',
    }],
  };
  const taskGraph = buildCanonicalDevelopmentTaskGraph(
    developmentCase,
    proposal,
    ref(
      developmentSchemas.DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      'managed-node-submission',
      'planner-hash',
    ),
  );
  const implementationBody = {
    schemaVersion:
      developmentSchemas.DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
    taskGraphHash: taskGraph.graphHash,
    results: [{
      key: 'implement-ac-1',
      status: 'succeeded',
      taskId: 201,
      implementationExecutionId: 'implementation-execution',
      reviewExecutionId: 'review-execution',
      reviewedSourceCommit: 'reviewed-source-commit',
      result: ref('factory.implementation-result.v1', 'artifact', 'result-hash'),
      reasonCodes: [],
    }],
    complete: true,
    blockingItemKeys: [],
  };
  const implementationWorkset = {
    ...implementationBody,
    worksetHash: developmentPolicy.hashImplementationWorkset(
      implementationBody,
    ),
  };
  const candidateBody = {
    schemaVersion: developmentSchemas.INTEGRATED_CANDIDATE_SCHEMA,
    taskGraphHash: taskGraph.graphHash,
    implementationWorksetHash: implementationWorkset.worksetHash,
    repositories: [{
      projectRepositoryId: 5,
      branch: 'integration/epic-10',
      commitSha: 'integrated-commit',
      treeHash: 'tree-hash',
    }],
    buildProducts: [{
      kind: 'application',
      ref: 'build:circle-app',
      digest: 'build-digest',
    }],
    integrationIntentRefs: ['integration-intent:1'],
    frozen: true,
  };
  const integratedCandidate = {
    ...candidateBody,
    candidateHash: developmentPolicy.hashIntegratedCandidate(candidateBody),
  };
  const verificationBody = {
    schemaVersion: developmentSchemas.ACCEPTANCE_VERIFICATION_SCHEMA,
    acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
    candidateHash: integratedCandidate.candidateHash,
    evidence: [{
      verificationItemKey: 'verify-ac-1',
      taskId: 301,
      executionId: 'verification-execution',
      acceptanceCriterionId: 101,
      acceptedCriterionHash: 'ac-1-hash',
      candidateHash: integratedCandidate.candidateHash,
      outcome: 'passed',
      evidence: ref('factory.verification-evidence.v1', 'evidence', 'evidence-hash'),
      provider: {
        providerId: 1,
        name: 'deterministic-test-provider',
        version: '1.0.0',
        category: 'deterministic_evidence',
        trusted: true,
      },
    }],
    complete: true,
  };
  const acceptanceVerification = {
    ...verificationBody,
    verificationHash: developmentPolicy.hashAcceptanceVerification(
      verificationBody,
    ),
  };
  return {
    schemaVersion: developmentSchemas.DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA,
    developmentCase,
    taskGraph,
    implementationWorkset,
    integratedCandidate,
    observedCandidateHash: integratedCandidate.candidateHash,
    acceptanceVerification,
    productReferences: {
      taskGraph: ref(
        developmentSchemas.DEVELOPMENT_TASK_GRAPH_SCHEMA,
        'task-graph',
        taskGraph.graphHash,
      ),
      implementationWorkset: ref(
        developmentSchemas.DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
        'implementation-workset',
        implementationWorkset.worksetHash,
      ),
      integratedCandidate: ref(
        developmentSchemas.INTEGRATED_CANDIDATE_SCHEMA,
        'candidate',
        integratedCandidate.candidateHash,
      ),
      acceptanceVerification: ref(
        developmentSchemas.ACCEPTANCE_VERIFICATION_SCHEMA,
        'verification',
        acceptanceVerification.verificationHash,
      ),
    },
    openHumanGateIds: [],
    localReadinessReceipt,
  };
}

function settle(input) {
  return new developmentPolicy.ReferenceDevelopmentSettlementPolicy()
    .settle(input);
}

test('LR-07: terminal verified REQUIRES a passed local-readiness receipt bound to the exact candidate', () => {
  const candidateHash = buildInput(null).integratedCandidate.candidateHash;
  // (a) WITH a passed receipt bound to the exact candidateHash → verified.
  const passed = buildInput({
    candidateHash,
    outcome: 'passed',
    evidenceRefs: ['local-readiness:proof-1'],
  });
  const verifiedResult = settle(passed);
  assert.equal(verifiedResult.decision, 'verified');
  assert.deepEqual(verifiedResult.reasonCodes, []);
  assert.ok(verifiedResult.bundle, 'verified settlement emits the bundle');
});

test('LR-07: blocked / local-readiness-missing when the receipt is absent', () => {
  // (b) No receipt at all — terminal state MUST stay closed (W5).
  const result = settle(buildInput(null));
  assert.equal(result.decision, 'blocked');
  assert.ok(
    result.reasonCodes.includes('local-readiness-missing'),
    `expected local-readiness-missing in ${JSON.stringify(result.reasonCodes)}`,
  );
  assert.equal(result.bundle, null);
});

test('LR-07: blocked / local-readiness-missing when the receipt outcome is not passed', () => {
  const candidateHash = buildInput(null).integratedCandidate.candidateHash;
  // (c) Receipt present and bound to the exact candidate, but outcome `failed`
  //     (the candidate was proven NOT runnable locally) → blocked.
  const result = settle(buildInput({
    candidateHash,
    outcome: 'failed',
    evidenceRefs: ['local-readiness:proof-failed'],
  }));
  assert.equal(result.decision, 'blocked');
  assert.ok(
    result.reasonCodes.includes('local-readiness-missing'),
    `expected local-readiness-missing in ${JSON.stringify(result.reasonCodes)}`,
  );
  assert.equal(result.bundle, null);
});

test('LR-07: blocked / local-readiness-missing when the receipt subject MISMATCHES the candidateHash', () => {
  // (d) A different product's receipt (candidateHash mismatch) MUST NOT satisfy
  //     the gate, even when its outcome is `passed`. The binding is to the EXACT
  //     frozen candidate, so a foreign receipt keeps the terminal state closed.
  const result = settle(buildInput({
    candidateHash: '0'.repeat(64),
    outcome: 'passed',
    evidenceRefs: ['local-readiness:foreign-proof'],
  }));
  assert.equal(result.decision, 'blocked');
  assert.ok(
    result.reasonCodes.includes('local-readiness-missing'),
    `expected local-readiness-missing in ${JSON.stringify(result.reasonCodes)}`,
  );
  assert.equal(result.bundle, null);
});
