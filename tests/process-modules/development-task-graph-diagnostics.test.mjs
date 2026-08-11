import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
} = await import('../../dist/modules/development/domain/development-schemas.js');
const { hashDevelopmentPolicy } = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);
const { createDevelopmentTaskGraphCheckProvider } = await import(
  '../../dist/modules/development/application/development-check-providers.js'
);
const { decodeCheckDiagnostic } = await import(
  '../../dist/process-modules/domain/workplace/check-diagnostic.js'
);

function developmentCase() {
  const policySeed = { id: 'policy', version: '1.0.0', contentHash: '' };
  return {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 1,
    formalizationCertificate: { schema: 'cert', ref: 'cert:1', hash: '1'.repeat(64), decision: 'formalized' },
    solutionContract: { schema: 'contract', ref: 'contract:1', hash: '2'.repeat(64) },
    acceptanceBaselineHash: '3'.repeat(64),
    srs: { schema: 'srs', ref: 'srs:1', hash: '4'.repeat(64) },
    acceptanceCriteria: [{ artifactId: 10, code: 'AC-1', acceptedHash: '5'.repeat(64), implementationRequired: true, criticality: 'blocker' }],
    repositories: [{ projectRepositoryId: 1, integrationBranch: 'dev', expectedBaseCommit: 'abc' }],
    policy: { ...policySeed, contentHash: hashDevelopmentPolicy(policySeed) },
    initiatedBy: 'test',
  };
}

test('task-graph provider preserves exact policy failures as content-addressed diagnostics', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, process_run_id INTEGER, execution_id TEXT,
      schema_version TEXT, payload_snapshot TEXT, content_hash TEXT
    );
    CREATE TABLE factory_process_runs (
      id INTEGER PRIMARY KEY, input_schema TEXT, input_snapshot TEXT
    );
  `);
  const proposal = {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: ['left', 'right'].map(key => ({
      key, kind: 'implementation', taskKind: 'development.code',
      executionSkill: 'saga-worker', executionMode: 'git_change',
      projectRepositoryId: 1, acceptanceCriterionIds: [10],
      dependsOnKeys: [], changeScopes: ['src/shared/'], required: true,
      criticality: 'blocker',
    })),
    verificationItems: [{
      key: 'verify', kind: 'verification', taskKind: 'verification.ac',
      executionSkill: 'saga-verifier', executionMode: 'read_only_evidence',
      projectRepositoryId: 1, acceptanceCriterionIds: [10],
      dependsOnKeys: ['left', 'right'], changeScopes: [], required: true,
      criticality: 'blocker',
    }],
    integrationTargets: [{ projectRepositoryId: 1, sourceWorkItemKeys: ['left', 'right'], targetBranch: 'dev', expectedBaseCommit: 'abc' }],
  };
  db.prepare('INSERT INTO factory_process_runs VALUES (1,?,?)')
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(developmentCase()));
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1,1,?,?,?,?)')
    .run('execution:1', DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA, JSON.stringify(proposal), 'a'.repeat(64));
  const provider = createDevelopmentTaskGraphCheckProvider({
    db,
    candidateSets: { read: () => ({ role: 'author', producerExecutionRef: 'execution:1' }) },
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
    environmentRef: null, candidateSnapshot: {},
  });
  assert.equal(result.outcome, 'failed');
  const diagnostics = result.evidenceRefs.map(decodeCheckDiagnostic);
  assert.equal(diagnostics.every(Boolean), true);
  assert.equal(diagnostics.some(item => item.code === 'implementation-scope-overlap'), true);
  assert.equal(diagnostics.some(item => item.message.includes("'left' and 'right'")), true);
  assert.equal(diagnostics.every(item => item.subjectRef === 'candidate-set/1'), true);
  db.close();
});
