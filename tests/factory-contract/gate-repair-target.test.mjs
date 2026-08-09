import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { driveGateRun } from '../../dist/process-modules/application/gate-run-driver.js';
import { buildCheckPlan } from '../../dist/process-modules/application/standard-check-providers.js';
import { createReviewVerdictCheckProvider } from '../../dist/process-modules/application/review-verdict-check-provider.js';

const workplaceRef = {
  processRunId: 1,
  moduleRef: 'solution-development@1.0.0',
  productionCellId: 'development-implementation',
  workKey: 'impl-1',
};

function drive(outcomes, checks) {
  const receipts = [];
  const decisions = [];
  const repo = {
    createGateRun() {},
    setGateRunState() {},
    recordCheckReceipt(receipt) { receipts.push(receipt); return receipt; },
    recordDecision(decision) { decisions.push(decision); return { decision, replayed: false }; },
  };
  const providers = {
    resolve(providerId) {
      const outcome = outcomes[providerId];
      if (!outcome) return null;
      return { providerId, version: '1.0.0', run: () => outcome };
    },
  };
  const plan = buildCheckPlan('test.final', checks.map(check => ({
    providerId: check.providerId,
    version: '1.0.0',
    providerDigest: `${check.providerId}:digest`,
    repairTargetRoleOnFailure: check.failure,
    repairTargetRoleOnIndeterminate: check.indeterminate,
  })), { includeProductContract: false });
  return driveGateRun(repo, providers, {
    workplaceRef,
    subjectCandidateSetRef: 'author-set',
    assessmentCandidateSetRefs: ['review-set'],
    checkPlan: plan,
    gatePhase: 'final',
    expectedWorkplaceRevision: 5,
    gateLeaseRef: 'lease:1',
    installationDigest: 'install:1',
    checkParameters: {},
    environmentRef: null,
  }).decision;
}

test('valid negative reviewer verdict targets author repair', () => {
  const decision = drive(
    { review: 'failed' },
    [{ providerId: 'review', failure: 'author', indeterminate: 'reviewer' }],
  );
  assert.equal(decision.verdict, 'repair_required');
  assert.equal(decision.repairTargetRole, 'author');
});

test('invalid/unknown reviewer output targets reviewer repair', () => {
  const decision = drive(
    { review: 'unknown' },
    [{ providerId: 'review', failure: 'author', indeterminate: 'reviewer' }],
  );
  assert.equal(decision.verdict, 'repair_required');
  assert.equal(decision.repairTargetRole, 'reviewer');
});

test('conflicting repair ownership stops the line instead of guessing', () => {
  const decision = drive(
    { semantic: 'failed', review: 'unknown' },
    [
      { providerId: 'semantic', failure: 'author', indeterminate: 'author' },
      { providerId: 'review', failure: 'author', indeterminate: 'reviewer' },
    ],
  );
  assert.equal(decision.verdict, 'human_required');
  assert.equal(decision.repairTargetRole, null);
});

function reviewOutcome(payload) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE factory_managed_node_submissions (
    id INTEGER PRIMARY KEY, schema_version TEXT NOT NULL,
    payload_snapshot TEXT NOT NULL, content_hash TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO factory_managed_node_submissions
    (id,schema_version,payload_snapshot,content_hash) VALUES (1,?,?,?)`).run(
      'factory.development-review-verdict.v1', JSON.stringify(payload), 'digest-1',
    );
  const candidateSets = {
    read(ref) {
      if (ref !== 'review-set') return null;
      return {
        role: 'reviewer',
        subjectCandidateSetRef: 'author-set',
        members: [{
          productRef: {
            schemaId: 'factory.development-review-verdict.v1',
            ref: 'managed-node-submission:1',
            digest: 'digest-1',
          },
        }],
      };
    },
  };
  const provider = createReviewVerdictCheckProvider({ db, candidateSets });
  const outcome = provider.run({
    subjectCandidateSetRef: 'author-set',
    parameters: {
      assessmentCandidateSetRefs: ['review-set'],
      verdictSchemaRef: 'factory.development-review-verdict.v1',
    },
    environmentRef: null,
    candidateSnapshot: {},
  });
  db.close();
  return outcome;
}

test('review provider distinguishes valid changes_requested from malformed review output', () => {
  assert.equal(reviewOutcome({
    subject_candidate_set_ref: 'author-set', verdict: 'changes_requested', findings: ['bug'],
  }), 'failed');
  assert.equal(reviewOutcome({ verdict: 'changes_requested', findings: ['bug'] }), 'unknown');
  assert.equal(reviewOutcome({
    subject_candidate_set_ref: 'author-set', verdict: 'approved', findings: [],
  }), 'passed');
});
