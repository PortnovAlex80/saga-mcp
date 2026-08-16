import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSqliteProductionCellProjectionPersistence } from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { cellEffectRepairReceiptBody } from '../../dist/infrastructure/workplace/sqlite-cell-final-acceptance.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      metadata TEXT NOT NULL,
      project_repository_id INTEGER,
      updated_at TEXT
    );
    CREATE TABLE factory_work_intents (
      id INTEGER PRIMARY KEY,
      retry_budget INTEGER NOT NULL
    );
    CREATE TABLE factory_gate_decisions (
      decision_key TEXT PRIMARY KEY,
      decision_digest TEXT NOT NULL DEFAULT '',
      gate_run_ref TEXT NOT NULL,
      gate_ref TEXT NOT NULL,
      workplace_ref TEXT NOT NULL,
      gate_phase TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL,
      check_plan_ref TEXT NOT NULL,
      check_plan_digest TEXT NOT NULL,
      check_receipt_refs TEXT NOT NULL,
      verdict TEXT NOT NULL,
      repair_target_role TEXT,
      recovery_issue_ref TEXT,
      decided_at TEXT NOT NULL
    );
    CREATE TABLE factory_workplace_gate_decision_heads (
      workplace_ref TEXT PRIMARY KEY,
      decision_key TEXT NOT NULL
    );
    CREATE TABLE factory_check_receipts (
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL DEFAULT '',
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      candidate_set_digest TEXT NOT NULL,
      role TEXT NOT NULL,
      subject_candidate_set_ref TEXT
    );
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL,
      PRIMARY KEY(candidate_set_ref, ordinal)
    );
    CREATE TABLE factory_cell_effect_repair_issues (
      effect_repair_ref TEXT PRIMARY KEY,
      workplace_ref TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      effect_version TEXT NOT NULL,
      effect_digest TEXT NOT NULL,
      candidate_set_ref TEXT NOT NULL,
      production_revision_ref TEXT NOT NULL,
      gate_decision_key TEXT NOT NULL,
      gate_decision_digest TEXT NOT NULL,
      acceptance_digest TEXT NOT NULL,
      expected_workplace_revision INTEGER NOT NULL,
      resulting_workplace_revision INTEGER NOT NULL,
      issue_snapshot TEXT NOT NULL,
      issue_digest TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      UNIQUE(workplace_ref,effect_id,gate_decision_key)
    );
  `);
  return db;
}

function baseTaskMetadata(role = 'author') {
  return {
    process_run_id: 7,
    process_node_id: 'define-acceptance-contract',
    process_module_ref: 'solution-formalization@1.0.0',
    workplace_ref: 'workplace/7/solution-formalization@1.0.0/formalization-acceptance/singleton',
    production_cell_id: 'formalization-acceptance',
    work_key: 'singleton',
    role,
    work_intent_id: 41,
  };
}

function insertCandidate(db, ref, role, subject = null, productRef = `${ref}:product`) {
  db.prepare(`INSERT INTO factory_candidate_sets
    (candidate_set_ref,candidate_set_digest,role,subject_candidate_set_ref)
    VALUES (?,?,?,?)`).run(ref, `${ref}:digest`, role, subject);
  db.prepare(`INSERT INTO factory_candidate_set_members
    (candidate_set_ref,ordinal,product_schema,product_ref,product_digest)
    VALUES (?,0,'factory.test-product.v1',?,?)`)
    .run(ref, productRef, `${productRef}:digest`);
}

function insertRepairDecision(db, {
  key = 'decision-1', run = 'gate-run-1', role = 'author',
  subject = 'candidate-author-1', assessment = [], decidedAt = '2026-08-09T07:00:00.000Z',
  evidenceRefs = ['evidence:1'],
} = {}) {
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,gate_run_ref,gate_ref,workplace_ref,gate_phase,
     subject_candidate_set_ref,assessment_candidate_set_refs,
     check_plan_ref,check_plan_digest,check_receipt_refs,verdict,
     repair_target_role,recovery_issue_ref,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      key,
      run,
      'formalization-acceptance-gate',
      baseTaskMetadata().workplace_ref,
      role === 'reviewer' ? 'final' : 'author',
      subject,
      JSON.stringify(assessment),
      'formalization-acceptance-plan',
      'plan-digest',
      JSON.stringify([`${run}:check:0`]),
      'repair_required',
      role,
      `recovery:${key}`,
      decidedAt,
    );
  db.prepare(`INSERT INTO factory_check_receipts
    (check_receipt_ref,check_run_ref,subject_candidate_set_ref,provider_id,provider_version,provider_digest,outcome,evidence_refs)
    VALUES (?,?,?,?,?,?,'failed',?)`).run(
      `${run}:check:0`, run, 'cs1', 'factory.test-check.v1', '1.0.0', 'provider-digest', JSON.stringify(evidenceRefs),
    );
  db.prepare(`INSERT INTO factory_workplace_gate_decision_heads(workplace_ref,decision_key)
    VALUES (?,?) ON CONFLICT(workplace_ref) DO UPDATE SET decision_key=excluded.decision_key`)
    .run(baseTaskMetadata().workplace_ref, key);
}

function bind(adapter, taskId = 10) {
  adapter.bindProjectedTaskProcessContext({
    taskId,
    processRunId: 7,
    nodeId: 'define-acceptance-contract',
    moduleRef: 'solution-formalization@1.0.0',
    processInputHash: 'process-input-hash',
    nodeInput: { business: 'same' },
    nodeInputHash: 'node-input-hash',
    semanticInputDigest: 'semantic-input-digest',
    projectRepositoryId: 3,
  });
}

test('Production Cell repair projects exact GateDecision/CandidateSet as recovery-feedback.json input', () => {
  const db = createDb();
  const meta = baseTaskMetadata('author');
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(meta));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,3)').run();
  insertCandidate(db, 'candidate-author-1', 'author');
  insertRepairDecision(db, { evidenceRefs: [encodeCheckDiagnostic({
    code: 'implementation-scope-overlap',
    message: "implementation items 'left' and 'right' overlap without a dependency order",
    subjectRef: 'candidate-author-1',
  })] });

  bind(createSqliteProductionCellProjectionPersistence(db));
  const stored = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata);
  const feedback = stored.recovery_feedback;

  assert.equal(feedback.schemaVersion, 'factory.production-cell-recovery-feedback.v1');
  assert.equal(feedback.workplaceRef, meta.workplace_ref);
  assert.equal(feedback.repairTargetRole, 'author');
  assert.equal(feedback.maxAttempts, 3);
  assert.equal(feedback.gateDecision.decisionRef, 'decision-1');
  assert.equal(feedback.issue.recoveryIssueRef, 'recovery:decision-1');
  assert.equal(feedback.issue.rejectedGateDecisionRef, 'decision-1');
  assert.equal(feedback.issue.subjectCandidateSetRef, 'candidate-author-1');
  assert.deepEqual(feedback.issue.failingCheckReceiptRefs, ['gate-run-1:check:0']);
  assert.equal(feedback.issue.findings[0].code,
    'factory.test-check.v1:implementation-scope-overlap');
  assert.equal(feedback.issue.findings[0].message,
    "implementation items 'left' and 'right' overlap without a dependency order");
  assert.equal(feedback.issue.findings[0].evidenceRefs[0], 'gate-run-1:check:0');
  assert.equal(feedback.rejectedCandidateSet.candidateSetRef, 'candidate-author-1');
  assert.equal(feedback.rejectedCandidateSet.productRefs[0].ref, 'candidate-author-1:product');
  assert.equal(stored.process_node_input.business, 'same', 'repair feedback stays outside semantic node input');
});

test('reviewer repair targets the rejected reviewer assessment CandidateSet, not author production', () => {
  const db = createDb();
  const meta = baseTaskMetadata('reviewer');
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(meta));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,2)').run();
  insertCandidate(db, 'candidate-author-1', 'author');
  insertCandidate(db, 'candidate-reviewer-1', 'reviewer', 'candidate-author-1');
  insertRepairDecision(db, {
    role: 'reviewer',
    subject: 'candidate-author-1',
    assessment: ['candidate-reviewer-1'],
  });

  bind(createSqliteProductionCellProjectionPersistence(db));
  const feedback = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata)
    .recovery_feedback;
  assert.equal(feedback.repairTargetRole, 'reviewer');
  assert.equal(feedback.issue.subjectCandidateSetRef, 'candidate-reviewer-1');
  assert.equal(feedback.rejectedCandidateSet.role, 'reviewer');
});

test('later accepted GateDecision clears stale recovery feedback', () => {
  const db = createDb();
  const meta = { ...baseTaskMetadata('author'), recovery_feedback: { stale: true } };
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(meta));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,3)').run();
  insertCandidate(db, 'candidate-author-1', 'author');
  insertRepairDecision(db, { decidedAt: '2026-08-09T07:00:00.000Z' });
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,gate_run_ref,gate_ref,workplace_ref,gate_phase,
     subject_candidate_set_ref,assessment_candidate_set_refs,
     check_plan_ref,check_plan_digest,check_receipt_refs,verdict,
     repair_target_role,recovery_issue_ref,decided_at)
    VALUES ('decision-2','gate-run-2','formalization-acceptance-gate',?,'author',
      'candidate-author-1','[]','formalization-acceptance-plan','plan-digest','[]',
      'accepted',NULL,NULL,'2026-08-09T07:01:00.000Z')`)
    .run(meta.workplace_ref);
  db.prepare(`UPDATE factory_workplace_gate_decision_heads SET decision_key='decision-2'
    WHERE workplace_ref=?`).run(meta.workplace_ref);

  bind(createSqliteProductionCellProjectionPersistence(db));
  const stored = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata);
  assert.equal(stored.recovery_feedback, null);
});

test('accepted Gate effect repair projects exact actionable feedback and a later Gate suppresses it', () => {
  const db = createDb();
  const meta = baseTaskMetadata('author');
  const workplaceRef = meta.workplace_ref;
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(meta));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,3)').run();
  insertCandidate(db, 'candidate-author-1', 'author');
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,decision_digest,gate_run_ref,gate_ref,workplace_ref,gate_phase,
     subject_candidate_set_ref,assessment_candidate_set_refs,
     check_plan_ref,check_plan_digest,check_receipt_refs,verdict,
     repair_target_role,recovery_issue_ref,decided_at)
    VALUES ('decision-accepted','decision-digest','gate-run-accepted','gate-final',?,'final',
      'candidate-author-1','[]','plan','plan-digest','[]',
      'accepted',NULL,NULL,'2026-08-09T07:01:00.000Z')`)
    .run(workplaceRef);
  db.prepare(`INSERT INTO factory_workplace_gate_decision_heads(workplace_ref,decision_key)
    VALUES (?,'decision-accepted')`).run(workplaceRef);
  const issue = {
    schemaVersion: 'factory.recovery-issue.v1',
    policyId: 'acceptance-effect:git-integration',
    disposition: 'repair',
    reasonCode: 'ACCEPTANCE_EFFECT_REPAIR_REQUIRED',
    summary: 'integration conflict',
    findings: [{
      code: 'git-integration:repair-required', severity: 'error',
      message: 'integration conflict', subjectRef: 'candidate-author-1',
      actual: { path: 'src/app.ts' }, evidenceRefs: ['decision-accepted'],
    }],
    subjectRefs: [
      { kind: 'candidate-set', ref: 'candidate-author-1' },
      { kind: 'production-revision', ref: 'revision-1' },
    ],
    acceptanceCriteria: ['git integration must succeed'],
    allowedChanges: ['factory.test-product.v1:candidate-author-1:product'],
    context: {
      source: 'acceptance-effect', effectId: 'git-integration',
      effectVersion: '1.0.0', effectDigest: 'effect-digest', workplaceRef,
      candidateSetRef: 'candidate-author-1', productionRevisionRef: 'revision-1',
      gateDecisionKey: 'decision-accepted', acceptanceDigest: 'acceptance-digest',
      evidence: { path: 'src/app.ts' },
    },
  };
  const issueDigest = sha256Hex(issue);
  const receiptDigest = sha256Hex(cellEffectRepairReceiptBody({
    workplaceRef,
    effect: { effectId: 'git-integration', version: '1.0.0', effectDigest: 'effect-digest' },
    candidateSetRef: 'candidate-author-1',
    productionRevisionRef: 'revision-1',
    gateDecisionKey: 'decision-accepted',
    gateDecisionDigest: 'decision-digest',
    acceptanceDigest: 'acceptance-digest',
    expectedWorkplaceRevision: 7,
    resultingWorkplaceRevision: 8,
    issue,
  }));
  const repairRef = `cell-effect-repair:${receiptDigest}`;
  db.prepare(`INSERT INTO factory_cell_effect_repair_issues
    (effect_repair_ref,workplace_ref,effect_id,effect_version,effect_digest,candidate_set_ref,
     production_revision_ref,gate_decision_key,gate_decision_digest,acceptance_digest,
     expected_workplace_revision,resulting_workplace_revision,
     issue_snapshot,issue_digest,receipt_digest)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    repairRef, workplaceRef, 'git-integration', '1.0.0', 'effect-digest', 'candidate-author-1',
    'revision-1', 'decision-accepted', 'decision-digest', 'acceptance-digest', 7, 8,
    JSON.stringify(issue), issueDigest, receiptDigest,
  );

  const persistence = createSqliteProductionCellProjectionPersistence(db);
  bind(persistence);
  let stored = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata);
  assert.equal(stored.recovery_feedback.schemaVersion,
    'factory.acceptance-effect-recovery-feedback.v1');
  assert.equal(stored.recovery_feedback.recoveryCaseRef, repairRef);
  assert.equal(stored.recovery_feedback.issue.summary, 'integration conflict');
  assert.equal(stored.recovery_feedback.issue.findings[0].actual.path, 'src/app.ts');
  assert.equal(stored.recovery_feedback.acceptedAuthority.gateDecisionKey, 'decision-accepted');

  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,decision_digest,gate_run_ref,gate_ref,workplace_ref,gate_phase,
     subject_candidate_set_ref,assessment_candidate_set_refs,
     check_plan_ref,check_plan_digest,check_receipt_refs,verdict,
     repair_target_role,recovery_issue_ref,decided_at)
    VALUES ('decision-new','new-digest','gate-run-new','gate-final',?,'final',
      'candidate-author-1','[]','plan','plan-digest','[]','accepted',
      NULL,NULL,'2026-08-09T08:01:00.000Z')`).run(workplaceRef);
  db.prepare(`UPDATE factory_workplace_gate_decision_heads SET decision_key='decision-new'
    WHERE workplace_ref=?`).run(workplaceRef);
  bind(persistence);
  stored = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata);
  assert.equal(stored.recovery_feedback, null,
    'a new exact Gate head structurally suppresses the historical effect issue');
});

test('submission-preflight rejection survives projection before any CandidateSet/GateDecision', () => {
  const db = createDb();
  const feedback = {
    schemaVersion: 'factory.submission-validation-recovery-feedback.v1',
    rejectionRef: 'submission-validation-rejection:abc',
    rejectionDigest: 'abc',
    rejectionCode: 'FORMALIZATION_SRS_INCOMPLETE',
    issue: {
      schemaVersion: 'factory.recovery-issue.v1',
      findings: [{ code: 'd2-representation', message: 'Use canonical YAML.' }],
    },
  };
  const meta = { ...baseTaskMetadata('author'), recovery_feedback: feedback };
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(meta));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,3)').run();

  bind(createSqliteProductionCellProjectionPersistence(db));

  const stored = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata);
  assert.deepEqual(stored.recovery_feedback, feedback,
    'projection must not erase a durable pre-CandidateSet validator rejection');
  assert.equal(stored.process_node_input.business, 'same',
    'submission feedback remains outside semantic node input');
});
