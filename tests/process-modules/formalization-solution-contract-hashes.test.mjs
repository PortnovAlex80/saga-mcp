import assert from 'node:assert/strict';
import test from 'node:test';

const { buildSolutionContractPayload } = await import(
  '../../dist/modules/formalization/application/formalization-production-cell-installation.js'
);

test('solution contract preserves document acceptance and atomic criterion hashes', () => {
  const documentHash = 'a'.repeat(64);
  const firstCriterionHash = '1'.repeat(64);
  const secondCriterionHash = '2'.repeat(64);
  const srsHash = 'b'.repeat(64);
  const artifacts = [
    {
      id: 30,
      projectId: 1,
      epicId: 100,
      type: 'AC',
      code: 'AC',
      status: 'accepted',
      contentHash: documentHash,
      acceptedHash: documentHash,
      driftState: 'clean',
      tags: [],
      metadata: {},
    },
    {
      id: 40,
      projectId: 1,
      epicId: 100,
      type: 'SRS',
      code: 'SRS-1',
      status: 'accepted',
      contentHash: srsHash,
      acceptedHash: srsHash,
      driftState: 'clean',
      tags: [],
      metadata: {},
    },
  ];
  const srs = [
    '# SRS',
    '### §D2. AC Map',
    '```yaml',
    '- ac: AC-1',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '- ac: AC-2',
    '  ac_kind: verification',
    '  criticality: degradable',
    '```',
  ].join('\n');
  const deps = {
    graph: {
      readArtifactsByIds(ids) {
        return artifacts.filter(row => ids.includes(row.id));
      },
      readOutgoingArtifactTraces() {
        return [];
      },
    },
    baselineRepository: {
      readByProcessRun() {
        return {
          payload: {
            acceptanceCriteria: [
              { artifactId: 30, code: 'AC-1', title: 'First', contentHash: firstCriterionHash },
              { artifactId: 30, code: 'AC-2', title: 'Second', contentHash: secondCriterionHash },
            ],
          },
        };
      },
    },
    readArtifactContent(id) {
      assert.equal(id, 40);
      return srs;
    },
  };
  const formalizationCase = {
    discoveryCertificateRef: 'certificate:discovery',
    discoveryCertificateHash: 'c'.repeat(64),
  };
  const bundle = {
    prdArtifactId: null,
    frArtifactIds: [],
    nfrArtifactIds: [],
    ruleArtifactIds: [],
    ucArtifactIds: [],
    acArtifactIds: [30],
    srsArtifactId: 40,
  };

  const payload = buildSolutionContractPayload(
    deps,
    { processRunId: 77, epicId: 100 },
    formalizationCase,
    bundle,
    'formalization-baseline:77',
    'd'.repeat(64),
  );

  assert.deepEqual(payload.acceptanceCriteria.map(item => ({
    code: item.code,
    acceptedHash: item.acceptedHash,
    criterionHash: item.criterionHash,
    implementationRequired: item.implementationRequired,
  })), [
    {
      code: 'AC-1',
      acceptedHash: documentHash,
      criterionHash: firstCriterionHash,
      implementationRequired: true,
    },
    {
      code: 'AC-2',
      acceptedHash: documentHash,
      criterionHash: secondCriterionHash,
      implementationRequired: false,
    },
  ]);
});
