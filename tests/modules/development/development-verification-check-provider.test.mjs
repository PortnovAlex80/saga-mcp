// Worker feedback loop map, Fix-A3: the development verification provider
// returned bare 'failed' on its binding/lineage branches — the recovery
// feedback then degraded to "Check ... returned failed." with zero evidence
// (two live blind receipts in the testbed). Every failure must carry an
// encoded diagnostic via the existing scopeFailure wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { createDevelopmentVerificationCheckProvider } = await import(
  '../../../dist/modules/development/application/development-check-providers.js'
);
const { DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA } = await import(
  '../../../dist/modules/development/domain/development-schemas.js'
);
const { decodeCheckDiagnostic } = await import(
  '../../../dist/process-modules/domain/workplace/check-diagnostic.js'
);

const SUBJECT = 'candidate-set/7/development@1.4.3/development-implementation/w1/author';

function makeProvider(candidate) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, process_run_id INTEGER NOT NULL, task_id INTEGER,
      schema_version TEXT NOT NULL, payload_snapshot TEXT NOT NULL,
      content_hash TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, verification_target_artifact_id INTEGER, metadata TEXT);
    CREATE TABLE artifacts (id INTEGER PRIMARY KEY, accepted_hash TEXT);
  `);
  return {
    provider: createDevelopmentVerificationCheckProvider({
      db,
      candidateSets: { read: () => candidate },
    }),
    db,
  };
}

function decode(result) {
  assert.equal(typeof result, 'object', 'result carries evidence');
  assert.equal(result.outcome, 'failed');
  const diagnostics = result.evidenceRefs
    .map(decodeCheckDiagnostic)
    .filter(diagnostic => diagnostic !== null);
  assert.ok(diagnostics.length >= 1, 'evidence decodes');
  return diagnostics;
}

test('verification provider: non-author or multi-member candidate fails with a decodable cause', () => {
  const { provider } = makeProvider({
    role: 'author',
    workplaceRef: { processRunId: 7 },
    members: [],
  });
  const diagnostics = decode(provider.run({
    subjectCandidateSetRef: SUBJECT,
    parameters: { processRunId: 7 },
  }));
  assert.equal(diagnostics[0].code, 'submission-binding-invalid');
  assert.match(diagnostics[0].message, /exactly one author CandidateSet member/);
  assert.equal(diagnostics[0].subjectRef, SUBJECT);
});

test('verification provider: wrong product schema fails with a decodable cause', () => {
  const { provider } = makeProvider({
    role: 'author',
    workplaceRef: { processRunId: 7 },
    members: [{
      productRef: {
        schemaId: 'factory.unknown-schema.v1',
        ref: 'artifact:whatever',
        digest: 'digest',
      },
    }],
  });
  const diagnostics = decode(provider.run({
    subjectCandidateSetRef: SUBJECT,
    parameters: { processRunId: 7 },
  }));
  assert.equal(diagnostics[0].code, 'submission-binding-invalid');
  assert.match(diagnostics[0].message, /managed-node-submission/);
});

test('verification provider: non-numeric submission id fails with a decodable cause', () => {
  const { provider } = makeProvider({
    role: 'author',
    workplaceRef: { processRunId: 7 },
    members: [{
      productRef: {
        schemaId: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
        ref: 'managed-node-submission:not-a-number',
        digest: 'digest',
      },
    }],
  });
  const diagnostics = decode(provider.run({
    subjectCandidateSetRef: SUBJECT,
    parameters: { processRunId: 7 },
  }));
  assert.equal(diagnostics[0].code, 'submission-binding-invalid');
  assert.match(diagnostics[0].message, /numeric managed-node-submission id/);
});
