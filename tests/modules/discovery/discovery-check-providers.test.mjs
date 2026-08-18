// Worker feedback loop map, Fix-A2: Discovery gate providers must return
// ENCODED diagnostics instead of a bare 'failed'. The validators already
// compute `errors[]`; the provider used to discard them, leaving the repair
// worker with only "Check discovery.*@1.0.0 returned failed." (live blind
// rejection: task 14, workplace/9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const {
  createDiscoveryProposalCheckProvider,
  createDiscoveryReadinessCheckProvider,
} = await import('../../../dist/modules/discovery/application/discovery-check-providers.js');
const { decodeCheckDiagnostic } = await import(
  '../../../dist/process-modules/domain/workplace/check-diagnostic.js'
);
const { DISCOVERY_PROPOSAL_SCHEMA } = await import(
  '../../../dist/modules/discovery/domain/discovery-proposal.js'
);
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA } = await import(
  '../../../dist/modules/discovery/domain/discovery-readiness-assessment.js'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY,
      process_run_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
  `);
  return db;
}

function candidateSetsFor(submissionId, schemaId, digest) {
  return {
    read() {
      return {
        role: 'author',
        workplaceRef: { processRunId: 7 },
        members: [{
          productRef: {
            ref: `managed-node-submission:${submissionId}`,
            schemaId,
            digest,
          },
        }],
      };
    },
  };
}

function insertSubmission(db, {
  id = 1, nodeId = 'produce-proposal', schema = DISCOVERY_PROPOSAL_SCHEMA, payload,
}) {
  const snapshot = JSON.stringify(payload);
  const contentHash = `hash-${id}`;
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,node_id,execution_id,schema_version,payload_snapshot,content_hash)
     VALUES (?,7,?,'execution:x',?,?,?)`,
  ).run(id, nodeId, schema, snapshot, contentHash);
  return { id, schema, digest: contentHash };
}

function decodeEvidence(result) {
  assert.equal(typeof result, 'object', 'provider returns an evidence-carrying result');
  assert.equal(result.outcome, 'failed');
  return result.evidenceRefs
    .map(decodeCheckDiagnostic)
    .filter(diagnostic => diagnostic !== null);
}

const SUBJECT = 'candidate-set/7/discovery@1.0.0/discovery-proposal/singleton/author';

test('proposal provider: invalid payload returns one decoded diagnostic per validator error', () => {
  const db = makeDb();
  const submission = insertSubmission(db, {
    payload: {
      problem_statement: '',
      observed_context: 'context',
      stakeholders_or_actors: ['actor'],
      assumptions: [],
      unknowns: [],
      risks: [],
      candidate_scope: 'scope',
      evidence_refs: [],
      recommended_outcome: 'go',
      rationale: 'rationale',
    },
  });
  const provider = createDiscoveryProposalCheckProvider({
    db,
    candidateSets: candidateSetsFor(submission.id, submission.schema, submission.digest),
  });
  const diagnostics = decodeEvidence(provider.run({ subjectCandidateSetRef: SUBJECT }));
  assert.ok(diagnostics.length >= 1);
  assert.equal(diagnostics[0].code, 'proposal-contract-invalid');
  assert.match(diagnostics[0].message, /problem_statement/);
  assert.equal(diagnostics[0].subjectRef, SUBJECT);
});

test('proposal provider: missing desk submission explains itself instead of a bare failed', () => {
  const db = makeDb();
  const provider = createDiscoveryProposalCheckProvider({
    db,
    candidateSets: candidateSetsFor(999, 'factory.unknown.v1', 'hash-999'),
  });
  const diagnostics = decodeEvidence(provider.run({ subjectCandidateSetRef: SUBJECT }));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'proposal-contract-invalid');
  assert.match(diagnostics[0].message, /missing from the desk|schema is not/);
});

test('proposal provider: a valid payload still passes', () => {
  const db = makeDb();
  const submission = insertSubmission(db, {
    payload: {
      problem_statement: 'problem',
      observed_context: 'context',
      stakeholders_or_actors: ['actor'],
      assumptions: ['assumption'],
      unknowns: ['unknown'],
      risks: ['risk'],
      candidate_scope: 'scope',
      evidence_refs: ['evidence:1'],
      recommended_outcome: 'go',
      rationale: 'rationale',
    },
  });
  const provider = createDiscoveryProposalCheckProvider({
    db,
    candidateSets: candidateSetsFor(submission.id, submission.schema, submission.digest),
  });
  assert.equal(provider.run({ subjectCandidateSetRef: SUBJECT }), 'passed');
});

test('readiness provider: malformed binding fields carry decoded diagnostics', () => {
  const db = makeDb();
  const submission = insertSubmission(db, {
    id: 2,
    nodeId: 'assess-readiness',
    schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
    payload: {},
  });
  const provider = createDiscoveryReadinessCheckProvider({
    db,
    candidateSets: candidateSetsFor(submission.id, submission.schema, submission.digest),
  });
  const diagnostics = decodeEvidence(provider.run({
    subjectCandidateSetRef: SUBJECT,
    parameters: { processRunId: 7 },
  }));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'readiness-contract-invalid');
  assert.match(diagnostics[0].message, /proposal_content_hash/);
});

test('readiness provider: validator errors are decoded, not discarded', () => {
  const db = makeDb();
  const proposalSubmission = insertSubmission(db, {
    id: 3,
    payload: {
      problem_statement: 'problem',
      observed_context: 'context',
      stakeholders_or_actors: ['actor'],
      assumptions: [],
      unknowns: [],
      risks: [],
      candidate_scope: 'scope',
      evidence_refs: [],
      recommended_outcome: 'go',
      rationale: 'rationale',
    },
  });
  const readinessSubmission = insertSubmission(db, {
    id: 4,
    nodeId: 'assess-readiness',
    schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
    payload: {
      proposal_content_hash: proposalSubmission.digest,
      // Missing dimensions/gaps/confidence — validateReadinessAssessment
      // computes the exact field errors; the provider must forward them.
      recommended_next_action: 'proceed_to_settlement',
      overall_readiness: 'ready',
      rationale: 'rationale',
    },
  });
  const provider = createDiscoveryReadinessCheckProvider({
    db,
    candidateSets: candidateSetsFor(readinessSubmission.id, readinessSubmission.schema, readinessSubmission.digest),
  });
  const diagnostics = decodeEvidence(provider.run({
    subjectCandidateSetRef: SUBJECT,
    parameters: { processRunId: 7 },
  }));
  assert.ok(diagnostics.length >= 3, 'each validator error becomes one diagnostic');
  const messages = diagnostics.map(diagnostic => diagnostic.message).join('\n');
  assert.match(messages, /dimension_assessments/);
  assert.match(messages, /confidence/);
  assert.match(messages, /blocking_gaps/);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.code, 'readiness-contract-invalid');
    assert.equal(diagnostic.subjectRef, SUBJECT);
  }
});
