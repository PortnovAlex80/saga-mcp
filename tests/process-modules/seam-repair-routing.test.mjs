import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// SEAM-ARCHITECT Layer 2 (c) — routing typed seam repair-issues back to the
// producing tasks THROUGH EXISTING mechanisms (no new authority path):
//   1. decodeFindingsForDecision — the ONE findings decoder feeding the
//      production-cell recovery-feedback sheet — must decode seam repair-issue
//      refs into findings carrying the seam kind and owner;
//   2. decodeSeamIssuesForReceipts — the typed projection the feedback sheet
//      exposes as issue.seamIssues;
//   3. readParentDefectEvidence — the continuation defect snapshot the re-plan
//      cycle injects into every repair task's objective — must decode seam
//      refs into typed entries (seamKind, producingTaskRef, localization);
//   4. the readiness-certification check plan must declare
//      failureOwnership:'upstream' for local-runnability so a producer defect
//      escalates to the conveyor instead of burning the certifier's repair
//      budget (bb968ecf dropped the flag while keeping the comment).

const { encodeSeamRepairIssue } = await import(
  '../../dist/process-modules/domain/workplace/seam-repair-issue.js'
);
const { encodeCheckDiagnostic } = await import(
  '../../dist/process-modules/domain/workplace/check-diagnostic.js'
);
const { decodeFindingsForDecision } = await import(
  '../../dist/infrastructure/workplace/sqlite-gate-finding-set-chain.js'
);
const { decodeSeamIssuesForReceipts } = await import(
  '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js'
);
const { readParentDefectEvidence } = await import(
  '../../dist/app/factory-continuation.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);

const SEAM_REF = encodeSeamRepairIssue({
  seamKind: 'test-command',
  producingTaskRef: 'task:201',
  localization: {
    phase: 'profile-test',
    substrate: 'host',
    command: 'npm test',
    fileHints: ['src/broken.ts', 'src/app.test.js'],
  },
  evidence: {
    summary: 'command failed (npm test): seam regression in src/broken.ts',
    digestRef: 'local-readiness:abc123',
  },
  subjectCandidateSetRef: 'candidate-set/test',
});

function receiptsDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_check_receipts(
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref,check_run_ref,subject_candidate_set_ref,provider_id,
        provider_version,provider_digest,outcome,evidence_refs,receipt_digest)
     VALUES ('receipt:1','run:1','candidate-set/test','factory.local-runnability.v1',
        '1.6.0','digest','failed',?, 'rd')`,
  ).run(JSON.stringify([SEAM_REF]));
  return db;
}

test('findings decoder maps a seam repair-issue ref into a finding that names seam and owner', () => {
  const db = receiptsDb();
  try {
    const findings = decodeFindingsForDecision(
      db, ['receipt:1'], 'candidate-set/test',
    );
    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert.equal(finding.code, 'factory.local-runnability.v1:seam:test-command');
    assert.equal(finding.severity, 'error');
    assert.match(finding.message, /seam regression in src\/broken\.ts/u);
    assert.match(finding.message, /producing task: task:201/u);
    assert.equal(finding.subjectRef, 'candidate-set/test');
    assert.ok(finding.evidenceRefs.includes('receipt:1'));
    assert.deepEqual(finding.fileHints, ['src/broken.ts', 'src/app.test.js']);
  } finally {
    db.close();
  }
});

test('decodeSeamIssuesForReceipts returns the typed seam issues for the feedback sheet', () => {
  const db = receiptsDb();
  try {
    const issues = decodeSeamIssuesForReceipts(db, ['receipt:1']);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].seamKind, 'test-command');
    assert.equal(issues[0].producingTaskRef, 'task:201');
    assert.deepEqual(issues[0].localization.fileHints, [
      'src/broken.ts', 'src/app.test.js',
    ]);
    assert.equal(issues[0].checkReceiptRef, 'receipt:1');
  } finally {
    db.close();
  }
});

test('continuation defect evidence decodes seam refs into typed repair entries', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_lifecycle_runs(id INTEGER PRIMARY KEY);
    CREATE TABLE factory_stage_runs(
      id INTEGER PRIMARY KEY, lifecycle_run_id INT, stage_id TEXT,
      attempt INT, process_run_id INT
    );
    CREATE TABLE factory_process_runs(id INTEGER PRIMARY KEY);
    CREATE TABLE factory_candidate_sets(
      candidate_set_ref TEXT PRIMARY KEY, workplace_ref TEXT
    );
    CREATE TABLE factory_check_receipts(
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    'INSERT INTO factory_lifecycle_runs(id) VALUES (77)',
  ).run();
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,stage_id,attempt,process_run_id)
     VALUES (1,77,'solution-development',1,9)`,
  ).run();
  db.prepare('INSERT INTO factory_process_runs(id) VALUES (9)').run();
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref) VALUES ('candidate-set/test','workplace/9/abc')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref,check_run_ref,subject_candidate_set_ref,provider_id,
        provider_version,provider_digest,outcome,evidence_refs,receipt_digest)
     VALUES ('receipt:1','run:1','candidate-set/test','factory.local-runnability.v1',
        '1.6.0','digest','failed',?,'rd')`,
  ).run(JSON.stringify([
    SEAM_REF,
    encodeCheckDiagnostic({
      code: 'local-runnability',
      message: 'legacy diagnostic without seam typing',
    }),
  ]));
  try {
    const evidence = readParentDefectEvidence(db, 77);
    // ONE typed entry per failed receipt: the seam projection REPLACES the
    // plain diagnostic line (it carries the same failure text plus the seam
    // kind, owner and localization) — no redundant context burn.
    assert.equal(evidence.length, 1);
    const seamEntry = evidence[0];
    assert.equal(seamEntry.providerId, 'factory.local-runnability.v1');
    assert.equal(seamEntry.seamKind, 'test-command');
    assert.equal(seamEntry.producingTaskRef, 'task:201');
    assert.deepEqual(seamEntry.localization.fileHints, [
      'src/broken.ts', 'src/app.test.js',
    ]);
    assert.match(seamEntry.message, /seam regression/u);
  } finally {
    db.close();
  }
});

test('continuation defect evidence keeps the plain diagnostic for untyped failures', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_lifecycle_runs(id INTEGER PRIMARY KEY);
    CREATE TABLE factory_stage_runs(
      id INTEGER PRIMARY KEY, lifecycle_run_id INT, stage_id TEXT,
      attempt INT, process_run_id INT
    );
    CREATE TABLE factory_process_runs(id INTEGER PRIMARY KEY);
    CREATE TABLE factory_candidate_sets(
      candidate_set_ref TEXT PRIMARY KEY, workplace_ref TEXT
    );
    CREATE TABLE factory_check_receipts(
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO factory_lifecycle_runs(id) VALUES (77)').run();
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,stage_id,attempt,process_run_id)
     VALUES (1,77,'solution-development',1,9)`,
  ).run();
  db.prepare('INSERT INTO factory_process_runs(id) VALUES (9)').run();
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref) VALUES ('candidate-set/legacy','workplace/9/old')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref,check_run_ref,subject_candidate_set_ref,provider_id,
        provider_version,provider_digest,outcome,evidence_refs,receipt_digest)
     VALUES ('receipt:2','run:2','candidate-set/legacy','some-check',
        '1.0.0','digest','failed',?,'rd2')`,
  ).run(JSON.stringify([
    encodeCheckDiagnostic({
      code: 'check-generic',
      message: 'legacy diagnostic without seam typing',
    }),
  ]));
  try {
    const evidence = readParentDefectEvidence(db, 77);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].seamKind, undefined);
    assert.match(evidence[0].message, /legacy diagnostic/u);
  } finally {
    db.close();
  }
});

test('readiness-certification plan escalates producer defects (failureOwnership upstream restored)', () => {
  const node = developmentProcessModule.flow.nodes.find(
    candidate => candidate.id === 'certify-product-readiness',
  );
  assert.ok(node, 'certify-product-readiness node exists');
  const entry = node.cellDefinition.authorGate.checkPlan.entries.find(
    e => e.check.providerId === 'factory.local-runnability.v1',
  );
  assert.ok(entry, 'local-runnability entry in the readiness plan');
  // bb968ecf dropped this flag while its explanatory comment stayed. Without
  // it, a failed runnability check (a PRODUCER defect on the frozen candidate)
  // burns the certifier's local repair budget on probe rewrites that cannot
  // fix the product — the seam repair-issue never reaches the producing task.
  assert.equal(entry.failureOwnership, 'upstream');
});
