import assert from 'node:assert/strict';
import test from 'node:test';

const developmentSchemas = await import(
  '../../dist/process-modules/modules/development/development-schemas.js'
);
const developmentPolicy = await import(
  '../../dist/process-modules/modules/development/development-settlement-policy.js'
);
const {
  buildCanonicalDevelopmentTaskGraph,
} = await import(
  '../../dist/process-modules/modules/development/development-task-graph.js'
);
const deliverySchemas = await import(
  '../../dist/process-modules/modules/delivery/delivery-schemas.js'
);
const deliveryPolicy = await import(
  '../../dist/process-modules/modules/delivery/delivery-settlement-policy.js'
);

function ref(schema, name, hash) {
  return { schema, ref: `${name}:${hash}`, hash };
}

function developmentFixture() {
  const policyBody = { id: 'development-reference', version: '1.0.0' };
  const developmentCase = {
    schemaVersion: developmentSchemas.DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 10,
    formalizationCertificate: {
      ...ref('saga3.formalization-certificate.v1', 'certificate', 'formal-cert'),
      decision: 'formalized',
    },
    solutionContract: ref(
      'saga3.solution-contract-certificate.v1',
      'solution-contract',
      'solution-contract-hash',
    ),
    acceptanceBaselineHash: 'baseline-hash',
    srs: ref('saga3.formalization-srs.v1', 'artifact', 'srs-hash'),
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
      result: ref('saga3.implementation-result.v1', 'artifact', 'result-hash'),
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
      evidence: ref('saga3.verification-evidence.v1', 'evidence', 'evidence-hash'),
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
  };
}

function deliveryFixture() {
  const action = {
    actionId: 'publish-package',
    kind: 'package-publish',
    target: 'registry.example/circle-app@1.0.0',
    desiredStateHash: 'published-state-hash',
    payloadHash: 'package-payload-hash',
    required: true,
  };
  const policyBody = {
    id: 'delivery-reference',
    version: '1.0.0',
    channel: 'stable',
    releaseVersion: '1.0.0',
    releaseTag: 'v1.0.0',
    humanApprovalRequired: true,
    requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [action],
  };
  const policy = {
    ...policyBody,
    contentHash: deliveryPolicy.hashDeliveryReleasePolicy(policyBody),
  };
  const deliveryCase = {
    schemaVersion: deliverySchemas.DELIVERY_RELEASE_CASE_SCHEMA,
    projectId: 1,
    epicId: 10,
    developmentCertificate: {
      ...ref(
        developmentSchemas.DEVELOPMENT_CERTIFICATE_SCHEMA,
        'certificate',
        'development-certificate-hash',
      ),
      decision: 'verified',
    },
    verifiedIntegrationBundle: ref(
      developmentSchemas.VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
      'development-output',
      'verified-bundle-hash',
    ),
    integratedCandidate: ref(
      developmentSchemas.INTEGRATED_CANDIDATE_SCHEMA,
      'candidate',
      'candidate-hash',
    ),
    policy,
    operatorAuthorization: {
      ...ref(
        'saga3.operator-release-authorization.v1',
        'authorization',
        'authorization-hash',
      ),
      requestedBy: 'release-operator',
      releasePolicyHash: policy.contentHash,
      candidateScope: {
        mode: 'exact',
        candidateHash: 'candidate-hash',
      },
    },
    initiatedBy: 'test',
  };
  const preflightBody = {
    schemaVersion: deliverySchemas.DELIVERY_PREFLIGHT_SCHEMA,
    candidateHash: 'candidate-hash',
    developmentCertificateHash: 'development-certificate-hash',
    releasePolicyHash: policy.contentHash,
    checks: [{
      checkId: 'candidate-integrity',
      subjectCandidateHash: 'candidate-hash',
      outcome: 'passed',
      evidence: ref('saga3.preflight-evidence.v1', 'evidence', 'preflight-evidence'),
      provider: {
        providerId: 2,
        name: 'ci',
        version: '1.0.0',
        category: 'deterministic_evidence',
        trusted: true,
      },
    }],
    complete: true,
  };
  const preflight = {
    ...preflightBody,
    preflightHash: deliveryPolicy.hashDeliveryPreflight(preflightBody),
  };
  const approvalBody = {
    schemaVersion: deliverySchemas.DELIVERY_APPROVAL_SCHEMA,
    status: 'approved',
    candidateHash: 'candidate-hash',
    preflightHash: preflight.preflightHash,
    releasePolicyHash: policy.contentHash,
    decision: ref(
      'saga3.authorized-release-decision.v1',
      'approval',
      'approval-decision-hash',
    ),
    provider: {
      providerId: 3,
      name: 'release-authority',
      version: '1.0.0',
      category: 'authorized_decision',
      trusted: true,
    },
  };
  const approval = {
    ...approvalBody,
    approvalHash: deliveryPolicy.hashDeliveryApproval(approvalBody),
  };
  const actionKey = deliveryPolicy.deliveryActionKey(deliveryCase, action);
  const publicationBody = {
    schemaVersion: deliverySchemas.DELIVERY_PUBLICATION_SCHEMA,
    candidateHash: 'candidate-hash',
    preflightHash: preflight.preflightHash,
    approvalHash: approval.approvalHash,
    plannedActions: [action],
    receipts: [{
      actionKey,
      actionId: action.actionId,
      kind: action.kind,
      target: action.target,
      payloadHash: action.payloadHash,
      desiredStateHash: action.desiredStateHash,
      status: 'uncertain',
      externalRef: 'registry-release:circle-app@1.0.0',
      resultHash: null,
      provider: {
        providerId: 4,
        name: 'package-registry',
        version: '1.0.0',
        category: 'authoritative_state',
        trusted: true,
      },
      replayed: false,
    }],
  };
  const publication = {
    ...publicationBody,
    publicationHash: deliveryPolicy.hashDeliveryPublication(publicationBody),
  };
  const observationBody = {
    schemaVersion: deliverySchemas.DELIVERY_OBSERVATION_SCHEMA,
    candidateHash: 'candidate-hash',
    publicationHash: publication.publicationHash,
    currentCandidateHash: 'candidate-hash',
    observations: [{
      actionKey,
      target: action.target,
      desiredStateHash: action.desiredStateHash,
      observedStateHash: action.desiredStateHash,
      outcome: 'matched',
      observation: ref(
        'saga3.authoritative-state-observation.v1',
        'observation',
        'observation-evidence-hash',
      ),
      provider: {
        providerId: 4,
        name: 'package-registry',
        version: '1.0.0',
        category: 'authoritative_state',
        trusted: true,
      },
    }],
    complete: true,
  };
  const observation = {
    ...observationBody,
    observationHash: deliveryPolicy.hashDeliveryObservation(observationBody),
  };
  return {
    schemaVersion: deliverySchemas.DELIVERY_SETTLEMENT_INPUT_SCHEMA,
    deliveryCase,
    preflight,
    approval,
    publication,
    observation,
    currentCandidateHash: 'candidate-hash',
    productReferences: {
      preflight: ref(
        deliverySchemas.DELIVERY_PREFLIGHT_SCHEMA,
        'preflight',
        preflight.preflightHash,
      ),
      approval: ref(
        deliverySchemas.DELIVERY_APPROVAL_SCHEMA,
        'approval',
        approval.approvalHash,
      ),
      publication: ref(
        deliverySchemas.DELIVERY_PUBLICATION_SCHEMA,
        'publication',
        publication.publicationHash,
      ),
      observation: ref(
        deliverySchemas.DELIVERY_OBSERVATION_SCHEMA,
        'observation',
        observation.observationHash,
      ),
    },
  };
}

test('Development settles only complete reviewed work for the unchanged candidate', () => {
  const input = developmentFixture();
  const result = new developmentPolicy.ReferenceDevelopmentSettlementPolicy()
    .settle(input);
  assert.equal(result.decision, 'verified');
  assert.deepEqual(result.reasonCodes, []);
  assert.ok(result.bundle);
  assert.equal(
    developmentPolicy.hashVerifiedIntegrationBundle(result.bundle),
    result.bundle.bundleHash,
  );
  assert.equal(
    result.bundle.integratedCandidate.hash,
    input.integratedCandidate.candidateHash,
  );
});

test('Development blocks candidate drift and inconclusive verification', () => {
  const policy = new developmentPolicy.ReferenceDevelopmentSettlementPolicy();
  const drifted = developmentFixture();
  drifted.observedCandidateHash = 'different-candidate-hash';
  assert.deepEqual(policy.settle(drifted).reasonCodes, [
    'candidate-drifted-after-freeze',
  ]);

  const inconclusive = developmentFixture();
  inconclusive.acceptanceVerification.evidence[0].outcome = 'unknown';
  inconclusive.acceptanceVerification.verificationHash =
    developmentPolicy.hashAcceptanceVerification(
      inconclusive.acceptanceVerification,
    );
  inconclusive.productReferences.acceptanceVerification = ref(
    developmentSchemas.ACCEPTANCE_VERIFICATION_SCHEMA,
    'verification',
    inconclusive.acceptanceVerification.verificationHash,
  );
  const result = policy.settle(inconclusive);
  assert.equal(result.decision, 'blocked');
  assert.deepEqual(result.reasonCodes, ['verification-inconclusive']);
});

test('Development rejects a succeeded item without independent review lineage', () => {
  const input = developmentFixture();
  input.implementationWorkset.results[0].reviewExecutionId = null;
  input.implementationWorkset.worksetHash =
    developmentPolicy.hashImplementationWorkset(input.implementationWorkset);
  input.productReferences.implementationWorkset = ref(
    developmentSchemas.DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
    'implementation-workset',
    input.implementationWorkset.worksetHash,
  );
  const result = new developmentPolicy.ReferenceDevelopmentSettlementPolicy()
    .settle(input);
  assert.equal(result.decision, 'failed');
  assert.deepEqual(result.reasonCodes, [
    'implementation-workset-hash-invalid',
  ]);
});

test('Delivery releases an uncertain response only after authoritative match', () => {
  const input = deliveryFixture();
  const result = new deliveryPolicy.ReferenceDeliverySettlementPolicy()
    .settle(input);
  assert.equal(result.decision, 'released');
  assert.deepEqual(result.reasonCodes, []);
  assert.ok(result.releaseRecord);
  assert.equal(
    deliveryPolicy.hashReleaseRecord(result.releaseRecord),
    result.releaseRecord.recordHash,
  );
  assert.equal(result.releaseRecord.destinations.length, 1);
});


test('Delivery requests approval when no operator authorization exists', () => {
  const input = deliveryFixture();
  input.deliveryCase.operatorAuthorization = null;
  const result = new deliveryPolicy.ReferenceDeliverySettlementPolicy()
    .settle(input);
  assert.equal(result.decision, 'approval-required');
  assert.deepEqual(result.reasonCodes, ['operator-authorization-missing']);
  assert.equal(result.releaseRecord, null);
});

test('Delivery accepts a Lifecycle-produced candidate grant and rejects a wrong exact hash', () => {
  const policy = new deliveryPolicy.ReferenceDeliverySettlementPolicy();
  const lifecycleGrant = deliveryFixture();
  lifecycleGrant.deliveryCase.operatorAuthorization.candidateScope = {
    mode: 'lifecycle-output',
  };
  assert.equal(policy.settle(lifecycleGrant).decision, 'released');

  const wrongExactGrant = deliveryFixture();
  wrongExactGrant.deliveryCase.operatorAuthorization.candidateScope = {
    mode: 'exact',
    candidateHash: 'another-candidate',
  };
  const result = policy.settle(wrongExactGrant);
  assert.equal(result.decision, 'blocked');
  assert.deepEqual(result.reasonCodes, ['operator-authorization-missing']);
});

test('Delivery blocks unknown observation and candidate drift', () => {
  const policy = new deliveryPolicy.ReferenceDeliverySettlementPolicy();
  const unknown = deliveryFixture();
  unknown.observation.observations[0].outcome = 'unknown';
  unknown.observation.observations[0].observedStateHash = null;
  unknown.observation.observationHash =
    deliveryPolicy.hashDeliveryObservation(unknown.observation);
  unknown.productReferences.observation = ref(
    deliverySchemas.DELIVERY_OBSERVATION_SCHEMA,
    'observation',
    unknown.observation.observationHash,
  );
  const uncertain = policy.settle(unknown);
  assert.equal(uncertain.decision, 'blocked');
  assert.deepEqual(uncertain.reasonCodes, ['action-uncertain']);

  const drifted = deliveryFixture();
  drifted.currentCandidateHash = 'different-candidate-hash';
  const drift = policy.settle(drifted);
  assert.equal(drift.decision, 'blocked');
  assert.deepEqual(drift.reasonCodes, ['candidate-drifted']);
});

test('Delivery requires a trusted authorized approval provider', () => {
  const input = deliveryFixture();
  input.approval.provider.trusted = false;
  input.approval.approvalHash =
    deliveryPolicy.hashDeliveryApproval(input.approval);
  input.productReferences.approval = ref(
    deliverySchemas.DELIVERY_APPROVAL_SCHEMA,
    'approval',
    input.approval.approvalHash,
  );
  const result = new deliveryPolicy.ReferenceDeliverySettlementPolicy()
    .settle(input);
  assert.equal(result.decision, 'blocked');
  assert.deepEqual(result.reasonCodes, ['approval-provider-untrusted']);
});
