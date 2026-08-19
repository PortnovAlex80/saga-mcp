import assert from 'node:assert/strict';
import test from 'node:test';

// SEAM-ARCHITECT Layer 2 (d) — X3: settlement sees FAILED evidence, not a
// binary passed/failed collapse. Three blindnesses fixed:
//   1. a localReadinessReceipt with outcome 'failed' must yield a DISTINCT
//      reason code ('local-readiness-failed') whose rationale carries the
//      DECODED failure text (the check diagnostics inside evidenceRefs), not
//      the generic local-readiness-missing message;
//   2. acceptance-verification evidence with outcome 'failed' must surface as
//      'verification-failed' naming WHICH AC (code + artifact id) failed with
//      WHICH evidence ref — previously failed receipts were invisible (the
//      trusted reader admitted passed only) and settlement collapsed to a
//      generic verification-evidence-missing binary;
//   3. when the runnable candidate was never bound BECAUSE readiness failed,
//      the candidate-missing rationale must still name the readiness failure
//      (the certificate is the durable failure record the continuation reads).

const developmentSchemas = await import(
  '../../dist/modules/development/domain/development-schemas.js'
);
const developmentPolicy = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);
const { encodeCheckDiagnostic } = await import(
  '../../dist/process-modules/domain/workplace/check-diagnostic.js'
);
const { buildCanonicalDevelopmentTaskGraph } = await import(
  '../../dist/modules/development/domain/development-task-graph.js'
);

function ref(schema, name, hash) {
  return { schema, ref: `${name}:${hash}`, hash };
}

const READINESS_FAILURE_TEXT =
  'command failed (npm test) --- stderr ---\nFAIL src/app.test.js\n  ✖ renders the seam';

/**
 * Build a settlement input valid through every check BEFORE the varied knob.
 * `mutate(input)` receives the built input and may null the candidate /
 * replace receipt outcomes; every hash that covers mutated material is
 * recomputed so the policy's integrity gates stay green and the varied branch
 * is the ONLY thing that can fire.
 */
function buildInput(mutate) {
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
    acceptanceCriteria: [
      {
        artifactId: 101,
        code: 'AC-1',
        acceptedHash: 'ac-1-hash',
        implementationRequired: true,
      },
      {
        artifactId: 102,
        code: 'AC-2',
        acceptedHash: 'ac-2-hash',
        implementationRequired: false,
      },
    ],
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
      changeScopes: ['src/'],
      dependsOnKeys: [],
      required: true,
    }],
    verificationItems: [
      {
        key: 'verify-ac-1',
        kind: 'verification',
        taskKind: 'verification.ac',
        executionSkill: 'saga-verifier',
        executionMode: 'read_only_evidence',
        projectRepositoryId: 5,
        acceptanceCriterionIds: [101],
        dependsOnKeys: ['implement-ac-1'],
        required: true,
      },
      {
        key: 'verify-ac-2',
        kind: 'verification',
        taskKind: 'verification.ac',
        executionSkill: 'saga-verifier',
        executionMode: 'read_only_evidence',
        projectRepositoryId: 5,
        acceptanceCriterionIds: [102],
        dependsOnKeys: ['implement-ac-1'],
        required: true,
      },
    ],
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
    schemaVersion: developmentSchemas.DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
    taskGraphHash: taskGraph.graphHash,
    results: [{
      key: 'implement-ac-1',
      status: 'succeeded',
      taskId: 201,
      reviewedSourceCommit: 'reviewed-source-commit',
      result: ref('factory.implementation-result.v1', 'artifact', 'result-hash'),
      reasonCodes: [],
    }],
    complete: true,
    blockingItemKeys: [],
  };
  const implementationWorkset = {
    ...implementationBody,
    worksetHash: developmentPolicy.hashImplementationWorkset(implementationBody),
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
      ref: 'build:seam-app',
      digest: 'build-digest',
    }],
    integrationIntentRefs: ['integration-intent:1'],
    frozen: true,
  };
  const integratedCandidate = {
    ...candidateBody,
    candidateHash: developmentPolicy.hashIntegratedCandidate(candidateBody),
  };
  const evidenceFor = (itemKey, taskId, criterionId, criterionHash, candidateHash, outcome, evidenceHash) => ({
    verificationItemKey: itemKey,
    taskId,
    acceptanceCriterionId: criterionId,
    acceptedCriterionHash: criterionHash,
    candidateHash,
    outcome,
    evidence: ref('factory.verification-evidence.v1', 'evidence', evidenceHash),
    provider: {
      providerId: 1,
      name: 'deterministic-test-provider',
      version: '1.0.0',
      category: 'deterministic_evidence',
      trusted: true,
    },
  });
  const verificationBody = {
    schemaVersion: developmentSchemas.ACCEPTANCE_VERIFICATION_SCHEMA,
    acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
    candidateHash: integratedCandidate.candidateHash,
    evidence: [
      evidenceFor('verify-ac-1', 301, 101, 'ac-1-hash',
        integratedCandidate.candidateHash, 'passed', 'evidence-hash-1'),
      evidenceFor('verify-ac-2', 302, 102, 'ac-2-hash',
        integratedCandidate.candidateHash, 'passed', 'evidence-hash-2'),
    ],
    complete: true,
  };
  const acceptanceVerification = {
    ...verificationBody,
    verificationHash: developmentPolicy.hashAcceptanceVerification(verificationBody),
  };
  const input = {
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
    localReadinessReceipt: null,
  };
  return mutate(input);
}

function rehashVerification(input) {
  input.acceptanceVerification.verificationHash =
    developmentPolicy.hashAcceptanceVerification(input.acceptanceVerification);
  input.productReferences.acceptanceVerification = ref(
    developmentSchemas.ACCEPTANCE_VERIFICATION_SCHEMA,
    'verification',
    input.acceptanceVerification.verificationHash,
  );
}

function settle(input) {
  return new developmentPolicy.ReferenceDevelopmentSettlementPolicy().settle(input);
}

test('X3: failed local-readiness receipt yields local-readiness-failed with the DECODED failure text', () => {
  const candidateHash = buildInput(x => x).integratedCandidate.candidateHash;
  const input = buildInput(x => {
    x.localReadinessReceipt = {
      candidateHash,
      outcome: 'failed',
      evidenceRefs: [
        'local-readiness:deadbeef',
        encodeCheckDiagnostic({ code: 'local-runnability', message: READINESS_FAILURE_TEXT }),
      ],
    };
    return x;
  });
  const result = settle(input);
  assert.equal(result.decision, 'blocked');
  assert.ok(
    result.reasonCodes.includes('local-readiness-failed'),
    `expected local-readiness-failed in ${JSON.stringify(result.reasonCodes)}`,
  );
  assert.ok(
    !result.reasonCodes.includes('local-readiness-missing'),
    'a FAILED receipt is not a MISSING receipt — the distinction is the X3 fix',
  );
  assert.match(result.rationale, /renders the seam/u);
  assert.match(result.rationale, /src\/app\.test\.js/u);
});

test('X3: readiness receipt failed for a DIFFERENT candidate stays local-readiness-missing (binding unchanged)', () => {
  const input = buildInput(x => {
    x.localReadinessReceipt = {
      candidateHash: 'different'.padEnd(64, '0'),
      outcome: 'failed',
      evidenceRefs: [],
    };
    return x;
  });
  const result = settle(input);
  assert.equal(result.decision, 'blocked');
  assert.ok(result.reasonCodes.includes('local-readiness-missing'));
});

test('X3: failed AC verification evidence yields verification-failed naming the AC and its evidence', () => {
  const input = buildInput(x => {
    const failed = x.acceptanceVerification.evidence.find(e => e.acceptanceCriterionId === 102);
    failed.outcome = 'failed';
    failed.evidence = ref(
      'factory.verification-evidence.v1',
      'evidence',
      'failed-ac-evidence',
    );
    rehashVerification(x);
    return x;
  });
  const result = settle(input);
  assert.equal(result.decision, 'blocked');
  assert.ok(
    result.reasonCodes.includes('verification-failed'),
    `expected verification-failed in ${JSON.stringify(result.reasonCodes)}`,
  );
  // Differentiated diagnostics: WHICH AC (code + artifact id) and WHICH evidence.
  assert.match(result.rationale, /AC-2/u);
  assert.match(result.rationale, /102/u);
  assert.match(result.rationale, /failed-ac-evidence/u);
});

test('X3: a failed readiness receipt BEFORE candidate binding reaches the candidate-missing rationale', () => {
  // The runnable candidate is never bound when readiness failed (the binder
  // admits passed receipts only). Settlement must still name WHY — the durable
  // certificate is the failure record the continuation/re-plan cycle reads.
  const input = buildInput(x => {
    x.integratedCandidate = null;
    x.observedCandidateHash = null;
    x.productReferences.integratedCandidate = null;
    x.localReadinessReceipt = {
      candidateHash: 'readiness-subject'.padEnd(64, '0'),
      outcome: 'failed',
      evidenceRefs: [
        encodeCheckDiagnostic({ code: 'local-runnability', message: READINESS_FAILURE_TEXT }),
      ],
    };
    return x;
  });
  const result = settle(input);
  assert.equal(result.decision, 'blocked');
  assert.ok(result.reasonCodes.includes('candidate-missing'));
  assert.ok(
    result.reasonCodes.includes('local-readiness-failed'),
    `expected local-readiness-failed in ${JSON.stringify(result.reasonCodes)}`,
  );
  assert.match(
    result.rationale,
    /renders the seam/u,
    'the settlement record must carry the failure text, not only the binary',
  );
});

test('X3: candidate-missing WITHOUT readiness failure keeps the plain rationale', () => {
  const input = buildInput(x => {
    x.integratedCandidate = null;
    x.observedCandidateHash = null;
    x.productReferences.integratedCandidate = null;
    return x;
  });
  const result = settle(input);
  assert.equal(result.decision, 'blocked');
  assert.deepEqual(result.reasonCodes, ['candidate-missing']);
  assert.doesNotMatch(result.rationale, /local readiness/u);
});
