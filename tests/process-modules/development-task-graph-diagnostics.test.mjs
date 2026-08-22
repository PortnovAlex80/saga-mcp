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
    candidateSets: { read: () => ({
      role: 'author',
      members: [{
        productRef: {
          schemaId: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
          ref: 'managed-node-submission:1',
          digest: 'a'.repeat(64),
        },
      }],
    }) },
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
    environmentRef: null, candidateSnapshot: {},
  });
  assert.equal(result.outcome, 'failed');
  const diagnostics = result.evidenceRefs.map(decodeCheckDiagnostic);
  assert.equal(diagnostics.every(Boolean), true);
  assert.equal(diagnostics.some(item => item.code === 'implementation-scope-overlap'), true);
  // F-B: the rejection serializes the COMPUTED unordered-overlap pair set
  // (deterministic repair assistance) — pair keys plus the overlapping scopes.
  assert.equal(diagnostics.some(item =>
    item.code === 'implementation-scope-overlap'
    && item.message.includes("'left' <-> 'right'")
    && item.message.includes('overlapping scopes:')
    && /add a dependency path in ONE direction for each computed pair/.test(item.message)), true);
  assert.equal(diagnostics.every(item => item.subjectRef === 'candidate-set/1'), true);

  const malformed = structuredClone(proposal);
  delete malformed.implementationItems[0].required;
  db.prepare('UPDATE factory_managed_node_submissions SET payload_snapshot=? WHERE id=1')
    .run(JSON.stringify(malformed));
  const malformedResult = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
    environmentRef: null, candidateSnapshot: {},
  });
  assert.equal(malformedResult.outcome, 'failed');
  const malformedDiagnostics = malformedResult.evidenceRefs.map(decodeCheckDiagnostic);
  assert.equal(malformedDiagnostics.some(item =>
    item.code === 'task-graph-decode-invalid'
    && item.message === 'implementationItems[0].required must be a boolean'), true);
  db.close();
});

// F-B — deterministic repair assistance: the factory computes the complete
// unordered-overlap set so the planner receives every conflicting pair (with
// scopes) in one shot instead of re-deriving the pairwise matrix.
test('computeUnorderedOverlapPairs returns every scope-overlapping unordered pair', async () => {
  const { computeUnorderedOverlapPairs } = await import(
    '../../dist/modules/development/domain/development-settlement-policy.js');
  const pairs = computeUnorderedOverlapPairs({
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    graphHash: 'x',
    developmentCaseRef: { schema: 's', hash: 'h', ref: 'r' },
    integrationTargets: [],
    implementationItems: [
      // a<->b overlap (src/ dir vs src/a.ts), no dependency edge — conflict.
      { key: 'a', kind: 'implementation', taskKind: 'development.impl', executionMode: 'git_change',
        projectRepositoryId: 1, changeScopes: ['src/'], acceptanceCriterionIds: [1],
        required: true, dependsOnKeys: [] },
      { key: 'b', kind: 'implementation', taskKind: 'development.impl', executionMode: 'git_change',
        projectRepositoryId: 1, changeScopes: ['src/a.ts'], acceptanceCriterionIds: [1],
        required: true, dependsOnKeys: [] },
      // c overlaps a but depends on it — ordered, NOT a conflict.
      { key: 'c', kind: 'implementation', taskKind: 'development.impl', executionMode: 'git_change',
        projectRepositoryId: 1, changeScopes: ['src/b.ts', 'src/'], acceptanceCriterionIds: [1],
        required: true, dependsOnKeys: ['a'] },
      // d: different repository — never a same-repo conflict.
      { key: 'd', kind: 'implementation', taskKind: 'development.impl', executionMode: 'git_change',
        projectRepositoryId: 2, changeScopes: ['src/'], acceptanceCriterionIds: [1],
        required: true, dependsOnKeys: [] },
    ],
    verificationItems: [],
  });
  assert.deepEqual(
    pairs.map(pair => [pair.leftKey, pair.rightKey]),
    [['a', 'b'], ['b', 'c']],
    'exactly the unordered same-repo scope overlaps: a<->b and b<->c (c is ordered against a via dependency, but b<->c is not)');
  const ab = pairs[0];
  assert.deepEqual([...ab.leftScopes], ['src/']);
  assert.deepEqual([...ab.rightScopes], ['src/a.ts']);
});
