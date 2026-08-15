import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { driveGateRun } from '../../dist/process-modules/application/gate-run-driver.js';
import { buildCheckPlan } from '../../dist/process-modules/application/standard-check-providers.js';
import { createReviewVerdictCheckProvider } from '../../dist/process-modules/application/review-verdict-check-provider.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

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
    recordGatePresentation() {},
    setGateRunState() {},
    recordCheckReceipt(receipt) { receipts.push(receipt); return receipt; },
    recordDecision(decision) { decisions.push(decision); return { decision, replayed: false }; },
    // ADR-053 C12 — this in-memory mock has no persisted terminal decision, so a
    // GateRun always runs fresh (returning null lets driveGateRun proceed).
    readTerminalDecisionForGateRun() { return null; },
  };
  const providers = {
    resolve(providerId) {
      const outcome = outcomes[providerId];
      if (!outcome) return null;
      // C10: digest must equal the value pinned by buildCheckPlan
      // (providerDigest: `${check.providerId}:digest`).
      return { providerId, version: '1.0.0', providerDigest: `${providerId}:digest`, run: () => outcome };
    },
  };
  const plan = buildCheckPlan('test.final', checks.map(check => ({
    providerId: check.providerId,
    version: '1.0.0',
    providerDigest: `${check.providerId}:digest`,
    repairTargetRoleOnFailure: check.failure,
    repairTargetRoleOnIndeterminate: check.indeterminate,
    indeterminateDisposition: check.disposition,
    failureOwnership: check.ownership,
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
    presentationRef: 'worker-execution:gate-repair-target',
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

test('missing external check authority stops the line without spending worker retries', () => {
  const decision = drive(
    { external: 'unknown' },
    [{
      providerId: 'external',
      failure: 'author',
      indeterminate: 'author',
      disposition: 'human-required',
    }],
  );
  assert.equal(decision.verdict, 'human_required');
  assert.equal(decision.repairTargetRole, null);
});

test('deterministic failure of an upstream-owned subject escalates to failed, not local repair', () => {
  // The runnability-style check: subject is the frozen integrated candidate
  // produced upstream. A deterministic 'failed' is a producer defect — no
  // local repair can fix it, so the verdict must be 'failed' (cell
  // terminates; continuation re-routes the defect to the producer) instead
  // of 'repair_required' burning this workplace's probe budget.
  const decision = drive(
    { runnability: 'failed', probe: 'passed' },
    [
      { providerId: 'runnability', failure: 'author', indeterminate: 'author', ownership: 'upstream' },
      { providerId: 'probe', failure: 'author', indeterminate: 'author' },
    ],
  );
  assert.equal(decision.verdict, 'failed');
  assert.equal(decision.repairTargetRole, null);
  assert.equal(decision.recoveryIssueRef, null);
});

test('indeterminate upstream-owned check still routes a local retry (substrate may be at fault)', () => {
  const decision = drive(
    { runnability: 'error' },
    [
      { providerId: 'runnability', failure: 'author', indeterminate: 'author', ownership: 'upstream' },
    ],
  );
  assert.equal(decision.verdict, 'repair_required');
  assert.equal(decision.repairTargetRole, 'author');
});

function reviewOutcome(payload) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE factory_managed_node_submissions (
    id INTEGER PRIMARY KEY, schema_version TEXT NOT NULL,
    payload_snapshot TEXT NOT NULL, content_hash TEXT NOT NULL
  )`);
  // ADR-062 provider reads the subject author task's changeScopes from the
  // tasks table; an empty table means "no scopes declared" (filter no-op).
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, workplace_ref TEXT, metadata TEXT
  )`);
  db.exec(`CREATE TABLE factory_accepted_authority_head (
    workplace_ref TEXT PRIMARY KEY,
    accepted_author_candidate_set_ref TEXT NOT NULL,
    accepted_author_task_id TEXT
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
        // ADR-062 scope filter reads the set's workplaceRef to find the
        // subject author task; the mock desk has no task row, so the filter
        // is a no-op (scopes === null).
        workplaceRef: {
          processRunId: 1,
          moduleRef: 'solution-development@1.2.0',
          productionCellId: 'development-implementation',
          workKey: 'impl-1',
        },
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
  const stringFinding = reviewOutcome({
    subject_candidate_set_ref: 'author-set', verdict: 'changes_requested', findings: ['bug'],
  });
  assert.equal(stringFinding.outcome, 'failed');
  assert.deepEqual(stringFinding.evidenceRefs.map(decodeCheckDiagnostic), [{
    code: 'review-finding-1', message: 'bug',
  }]);
  const structuredFinding = reviewOutcome({
    subject_candidate_set_ref: 'author-set',
    verdict: 'changes_requested',
    findings: [{ message: 'missing trace', severity: 'error', subjectRef: 'artifact:16' }],
  });
  assert.equal(structuredFinding.outcome, 'failed');
  assert.deepEqual(structuredFinding.evidenceRefs.map(decodeCheckDiagnostic), [{
    code: 'review-finding-1', message: 'missing trace', subjectRef: 'artifact:16',
  }]);
  assert.equal(reviewOutcome({ verdict: 'changes_requested', findings: ['bug'] }), 'unknown');
  assert.equal(reviewOutcome({
    subject_candidate_set_ref: 'author-set', verdict: 'approved', findings: [],
  }), 'passed');
});
