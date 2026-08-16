import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSqliteProductionCellProjectionPersistence } from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

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
    CREATE TABLE factory_external_effect_actions (
      id INTEGER PRIMARY KEY,
      provider_namespace TEXT NOT NULL,
      request_snapshot TEXT NOT NULL,
      state TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// ---------------------------------------------------------------------------
// Fix-2 (worker feedback loop map) — effect-repair closes the feedback loop.
// The stopwatch case: the final gate ACCEPTED the candidate, then the
// post-acceptance effect failed (PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH).
// The head stays `accepted`, so the old collector wiped the desk to null and
// the repair hire started blind. The feedback must now be rebuilt from the
// failed external-effect action instead.
// ---------------------------------------------------------------------------

test('Fix-2: accepted head + failed post-acceptance effect projects ledger cause as recovery feedback', () => {
  const db = createDb();
  const meta = baseTaskMetadata('author');
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(meta));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,3)').run();
  insertCandidate(db, 'candidate-author-1', 'author');
  // Accepted final gate whose subject is the accepted author set.
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,gate_run_ref,gate_ref,workplace_ref,gate_phase,
     subject_candidate_set_ref,assessment_candidate_set_refs,
     check_plan_ref,check_plan_digest,check_receipt_refs,verdict,
     repair_target_role,recovery_issue_ref,decided_at)
    VALUES ('decision-accepted','gate-run-2','formalization-acceptance-gate',?,'final',
      'candidate-author-1','[]','formalization-acceptance-plan','plan-digest','[]',
      'accepted',NULL,NULL,'2026-08-09T07:01:00.000Z')`)
    .run(meta.workplace_ref);
  db.prepare(`INSERT INTO factory_workplace_gate_decision_heads(workplace_ref,decision_key)
    VALUES (?,?) ON CONFLICT(workplace_ref) DO UPDATE SET decision_key=excluded.decision_key`)
    .run(meta.workplace_ref, 'decision-accepted');
  // The failed git-integration action for the accepted candidate set.
  db.prepare(`INSERT INTO factory_external_effect_actions
    (id,provider_namespace,request_snapshot,state,last_error)
    VALUES (2,'factory.git-integration.v1',?,'failed',?)`).run(
    JSON.stringify({
      schema: 'factory.git-integration-request.v1',
      workplaceRef: meta.workplace_ref,
      candidateSetRef: 'candidate-author-1',
    }),
    'PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task 187 submitted '
      + '86e28119e0edcfbc8f80ab31798fe50a65806067 but branch is '
      + '793c0704afe45e396426a756a84dbcdf95788b44',
  );

  bind(createSqliteProductionCellProjectionPersistence(db));
  const feedback = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata)
    .recovery_feedback;

  assert.ok(feedback, 'effect-repair feedback is projected instead of being wiped to null');
  assert.equal(feedback.schemaVersion, 'factory.production-cell-recovery-feedback.v1');
  assert.equal(feedback.repairTargetRole, 'author');
  assert.equal(feedback.issue.reasonCode, 'acceptance-effect-repair-required');
  assert.equal(feedback.issue.findings[0].code, 'effect:PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH');
  assert.match(feedback.issue.findings[0].message, /86e28119e0edcfbc8f80ab31798fe50a65806067/);
  assert.match(feedback.issue.findings[0].message, /793c0704afe45e396426a756a84dbcdf95788b44/);
  assert.deepEqual(feedback.issue.findings[0].evidenceRefs, ['external-effect-action:2']);
  assert.equal(feedback.rejectedCandidateSet.candidateSetRef, 'candidate-author-1');
  assert.equal(feedback.gateDecision.decisionRef, 'decision-accepted');
});

test('Fix-2: accepted head without a failed effect action still clears stale feedback', () => {
  const db = createDb();
  const meta = { ...baseTaskMetadata('author'), recovery_feedback: { stale: true } };
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(meta));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,3)').run();
  insertCandidate(db, 'candidate-author-1', 'author');
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,gate_run_ref,gate_ref,workplace_ref,gate_phase,
     subject_candidate_set_ref,assessment_candidate_set_refs,
     check_plan_ref,check_plan_digest,check_receipt_refs,verdict,
     repair_target_role,recovery_issue_ref,decided_at)
    VALUES ('decision-accepted','gate-run-2','formalization-acceptance-gate',?,'final',
      'candidate-author-1','[]','formalization-acceptance-plan','plan-digest','[]',
      'accepted',NULL,NULL,'2026-08-09T07:01:00.000Z')`)
    .run(meta.workplace_ref);
  db.prepare(`INSERT INTO factory_workplace_gate_decision_heads(workplace_ref,decision_key)
    VALUES (?,?) ON CONFLICT(workplace_ref) DO UPDATE SET decision_key=excluded.decision_key`)
    .run(meta.workplace_ref, 'decision-accepted');
  // A SUCCEEDED action for the same set must not produce effect-repair feedback.
  db.prepare(`INSERT INTO factory_external_effect_actions
    (id,provider_namespace,request_snapshot,state,last_error)
    VALUES (5,'factory.git-integration.v1',?,'succeeded',NULL)`).run(
    JSON.stringify({
      schema: 'factory.git-integration-request.v1',
      workplaceRef: meta.workplace_ref,
      candidateSetRef: 'candidate-author-1',
    }),
  );

  bind(createSqliteProductionCellProjectionPersistence(db));
  const stored = JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata);
  assert.equal(stored.recovery_feedback, null,
    'no failed effect action → the accepted head clears feedback as before');
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
