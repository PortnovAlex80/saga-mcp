import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

const {
  SqliteRecoveryCaseRepository,
} = await import(
  '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
);
const {
  RECOVERY_ISSUE_SCHEMA,
} = await import('../../dist/process-modules/domain/recovery.js');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE factory_process_runs (
      id INTEGER PRIMARY KEY
    );
    CREATE TABLE factory_node_runs (
      id INTEGER PRIMARY KEY
    );
  `);
  db.prepare('INSERT INTO factory_process_runs (id) VALUES (1)').run();
  for (const id of [101, 102, 103, 104, 105]) {
    db.prepare('INSERT INTO factory_node_runs (id) VALUES (?)').run(id);
  }
  return { db, repo: new SqliteRecoveryCaseRepository(db) };
}

function recordInput(sourceNodeRunId, suffix = String(sourceNodeRunId)) {
  return {
    processRunId: 1,
    moduleRef: { name: 'test-module', version: '1.0.0' },
    sourceNodeRunId,
    verifyNodeId: 'verify-contract',
    repairNodeId: 'repair-contract',
    maxAttempts: 2,
    issue: {
      schemaVersion: RECOVERY_ISSUE_SCHEMA,
      policyId: 'repair-test-contract',
      disposition: 'repair',
      reasonCode: 'TEST_CONTRACT_REJECTED',
      summary: `contract still rejected ${suffix}`,
      findings: [{
        code: 'contract-rejected',
        severity: 'error',
        message: `rejected ${suffix}`,
        subjectRef: `candidate:${suffix}`,
        expected: ['valid candidate'],
        actual: { suffix },
        evidenceRefs: [`candidate:${suffix}`],
      }],
      subjectRefs: [{
        kind: 'node-production',
        ref: `candidate:${suffix}`,
        schema: 'test.candidate.v1',
        contentHash: 'a'.repeat(64),
      }],
      acceptanceCriteria: ['candidate is valid'],
      allowedChanges: ['candidate'],
      context: { suffix },
    },
    sourceProduction: {
      schema: 'test.verifier-result.v1',
      artifactRef: `verifier:${suffix}`,
      contentHash: 'b'.repeat(64),
      bindings: { suffix },
    },
  };
}

test('exhausted recovery budget is sticky across failed resume probes', () => {
  const { db, repo } = fixture();
  try {
    const first = repo.recordIssue(recordInput(101));
    assert.equal(first.exhausted, false);
    assert.equal(first.attemptRecord.attempt, 1);

    const second = repo.recordIssue(recordInput(102));
    assert.equal(second.exhausted, false);
    assert.equal(second.attemptRecord.attempt, 2);

    const exhausted = repo.recordIssue(recordInput(103));
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.caseRecord.status, 'exhausted');
    assert.equal(exhausted.attemptRecord.attempt, 3);

    // GenericFlowExecutor calls resolveActive with the SAME failed verifier
    // NodeRun before probing an exhausted pause. Resume itself must not erase
    // exhaustion or grant a fresh case.
    assert.equal(
      repo.resolveActive(1, 'repair-test-contract', 103),
      null,
    );
    assert.equal(repo.readCase(exhausted.caseRecord.id)?.status, 'exhausted');

    // The resume probe rejects again. No new case and no attempt #4 are minted.
    const rejectedProbe = repo.recordIssue(recordInput(104, 'resume-probe'));
    assert.equal(rejectedProbe.exhausted, true);
    assert.equal(rejectedProbe.replayed, true);
    assert.equal(rejectedProbe.caseRecord.id, exhausted.caseRecord.id);
    assert.equal(rejectedProbe.attemptRecord.attempt, 3);
    assert.equal(repo.listForProcessRun(1).length, 1);
    assert.equal(repo.listAttempts(exhausted.caseRecord.id).length, 3);
    assert.equal(repo.readCase(exhausted.caseRecord.id)?.status, 'exhausted');

    // A later successful verifier run is allowed to resolve the exhausted case.
    const resolved = repo.resolveActive(1, 'repair-test-contract', 105);
    assert.ok(resolved);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolvedByNodeRunId, 105);
  } finally {
    db.close();
  }
});
