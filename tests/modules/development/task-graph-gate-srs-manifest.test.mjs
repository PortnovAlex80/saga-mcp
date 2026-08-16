// Workshop fixes C + D + E:
//   C — the task-graph gate filtered implementation items by item.required
//       BEFORE the extra-id membership check, so NON-required items carrying
//       foreign/invalid AC ids passed the gate and only exploded later at
//       kernel materialization (PRODUCTION_CELL_SOURCE_ARTIFACT_INVALID).
//   D — nothing compared the accepted plan to the SRS §2.2 Module Manifest,
//       so a planner could drop whole SRS modules (todo lost
//       renderer/events/index.html).
//   E — coverage findings render AC codes alongside raw artifact ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
} = await import('../../../dist/modules/development/domain/development-schemas.js');
const { hashDevelopmentPolicy, ReferenceDevelopmentTaskGraphPolicy } = await import(
  '../../../dist/modules/development/domain/development-settlement-policy.js'
);
const { buildCanonicalDevelopmentTaskGraph } = await import(
  '../../../dist/modules/development/domain/development-task-graph.js'
);
const { createDevelopmentTaskGraphCheckProvider } = await import(
  '../../../dist/modules/development/application/development-check-providers.js'
);
const { decodeCheckDiagnostic } = await import(
  '../../../dist/process-modules/domain/workplace/check-diagnostic.js'
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
    srs: { schema: 'srs', ref: 'artifact:55', hash: '4'.repeat(64) },
    acceptanceCriteria: [
      { artifactId: 11, code: 'AC-1', acceptedHash: '5'.repeat(64), implementationRequired: true, criticality: 'blocker' },
      { artifactId: 12, code: 'AC-2', acceptedHash: '6'.repeat(64), implementationRequired: true, criticality: 'blocker' },
    ],
    repositories: [{ projectRepositoryId: 1, integrationBranch: 'dev', expectedBaseCommit: 'abc' }],
    policy: { ...policySeed, contentHash: hashDevelopmentPolicy(policySeed) },
    initiatedBy: 'test',
  };
}

function implementationItem(key, extra = {}) {
  return {
    key,
    kind: 'implementation',
    taskKind: 'development.code',
    executionSkill: 'saga-worker',
    executionMode: 'git_change',
    projectRepositoryId: 1,
    acceptanceCriterionIds: [11, 12],
    dependsOnKeys: [],
    changeScopes: ['data/', 'engine/', 'ui/', 'app.js'],
    required: true,
    criticality: 'blocker',
    ...extra,
  };
}

function proposal(implementationItems) {
  return {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems,
    verificationItems: [11, 12].map(id => ({
      key: `verify-${id}`,
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: 1,
      acceptanceCriterionIds: [id],
      dependsOnKeys: ['impl'],
      changeScopes: [],
      required: true,
      criticality: 'blocker',
    })),
    integrationTargets: [{
      projectRepositoryId: 1,
      sourceWorkItemKeys: implementationItems
        .filter(item => item.required).map(item => item.key),
      targetBranch: 'dev',
      expectedBaseCommit: 'abc',
    }],
  };
}

function validateProposal(input, items) {
  const graph = buildCanonicalDevelopmentTaskGraph(input, proposal(items), {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    ref: 'planner-submission:1',
    hash: '7'.repeat(64),
  });
  return new ReferenceDevelopmentTaskGraphPolicy().validate(input, graph);
}

// ---------------------------------------------------------------------------
// C: the non-required blind spot.
// ---------------------------------------------------------------------------

test('policy rejects a NON-required implementation item carrying a foreign AC id', () => {
  const input = developmentCase();
  const valid = validateProposal(input, [implementationItem('impl')]);
  assert.equal(valid.valid, true, valid.errors.join('; '));

  const withBlindSpot = validateProposal(input, [
    implementationItem('impl'),
    implementationItem('optional', {
      key: 'optional',
      required: false,
      acceptanceCriterionIds: [999],
      changeScopes: ['vendor/'],
    }),
  ]);
  assert.equal(withBlindSpot.valid, false);
  assert.equal(withBlindSpot.reasonCodes.includes('implementation-coverage-gap'), true);
  const message = withBlindSpot.errors
    .find(error => error.includes('every implementation item (required or not)'));
  assert.ok(message, 'the non-required extra-id finding exists');
  assert.match(message, /extra AC artifact ids: \[999\]/);
});

test('policy keeps the required-coverage arithmetic unchanged', () => {
  const result = validateProposal(
    developmentCase(),
    [implementationItem('impl', { acceptanceCriterionIds: [11] })],
  );
  assert.equal(result.valid, false);
  const message = result.errors
    .find(error => error.includes('required implementation coverage does not equal'));
  assert.ok(message);
  // E: codes ride alongside the raw ids.
  assert.match(message, /missing AC artifact ids: \[12\] \(codes: AC-2\)/);
});

// ---------------------------------------------------------------------------
// D: the task-graph gate enforces the SRS §2.2 module manifest.
// ---------------------------------------------------------------------------

const UNITS_MANIFEST_SRS = `### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`data/categories\` | Static category definitions | \`data/categories.js\` |
| \`app\` | Application bootstrap | \`app.js\` |

### 2.3 Port Registry
`;

const TODO_MANIFEST_SRS = `### §2.2 Module Manifest

The product consists of five logical modules within a single HTML file (\`index.html\`):

| Module | Responsibility | Public Protocol | Dependencies |
|--------|---------------|-----------------|--------------|
| \`task-model\` | Task data structure | \`validateTask(data)\` | none |

### §2.3 Port Registry
`;

function makeProvider(readSrsContent, inputCase = developmentCase()) {
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
  db.prepare('INSERT INTO factory_process_runs VALUES (1,?,?)')
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(inputCase));
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1,1,?,?,?,?)')
    .run('execution:1', DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      JSON.stringify(proposal([implementationItem('impl')])), 'a'.repeat(64));
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
    readSrsContent,
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
  });
  db.close();
  return result;
}

test('task-graph gate passes a units-style plan whose scopes cover the manifest', () => {
  const result = makeProvider(
    () => ({ status: 'read', content: UNITS_MANIFEST_SRS }),
  );
  assert.equal(result, 'passed');
});

test('task-graph gate rejects a todo-style headless plan missing index.html', () => {
  const result = makeProvider(
    () => ({ status: 'read', content: TODO_MANIFEST_SRS }),
  );
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'srs-module-uncovered');
  assert.match(diagnostic.message, /index\.html/);
  assert.match(diagnostic.message, /changeScopes/);
});

test('task-graph gate emits an informational note when the manifest is absent', () => {
  const result = makeProvider(
    () => ({ status: 'read', content: '# SRS\n\n## §2 Architecture\n\nNo modules here.\n' }),
  );
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'passed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'srs-module-manifest-skip');
  assert.match(diagnostic.message, /no §2.2 Module Manifest section/);
});

test('task-graph gate emits an informational note when the SRS is unreadable (legacy tolerance)', () => {
  const result = makeProvider(
    () => ({ status: 'unavailable', reason: 'SRS artifact 55 has no repository binding' }),
  );
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'passed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'srs-module-manifest-skip');
  assert.match(diagnostic.message, /no repository binding/);
});

test('task-graph gate fails closed when the SRS artifact content has drifted', () => {
  const result = makeProvider(
    () => ({ status: 'drifted', path: 'docs/requirements/REQ-001/srs.md', expectedHash: 'e'.repeat(64) }),
  );
  assert.equal(typeof result, 'object');
  assert.equal(result.outcome, 'failed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'srs-artifact-drifted');
  assert.match(diagnostic.message, /no longer matches its registered content hash/);
});

test('task-graph gate merges manifest findings with policy failures for one-shot repair', () => {
  const input = developmentCase();
  // Policy-invalid proposal (missing AC coverage) AND an uncovered manifest:
  // both diagnostics ride the same failed receipt so the repair worker sees
  // the full defect list in one feedback pass.
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
  db.prepare('INSERT INTO factory_process_runs VALUES (1,?,?)')
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(input));
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1,1,?,?,?,?)')
    .run('execution:1', DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      JSON.stringify(proposal([implementationItem('impl', { acceptanceCriterionIds: [11] })])),
      'a'.repeat(64));
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
    readSrsContent: () => ({ status: 'read', content: TODO_MANIFEST_SRS }),
  });
  const result = provider.run({
    subjectCandidateSetRef: 'candidate-set/1', parameters: { processRunId: 1 },
  });
  db.close();
  assert.equal(result.outcome, 'failed');
  const diagnostics = result.evidenceRefs.map(decodeCheckDiagnostic);
  assert.equal(diagnostics.some(d => d.code === 'implementation-coverage-gap'), true);
  assert.equal(diagnostics.some(d => d.code === 'srs-module-uncovered'), true);
});
