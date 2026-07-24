/**
 * D5 — Advisory Discovery Diagnosis persistence tests (matrix C1–C12).
 *
 * Tests the D5 persistence layer directly against a temp-file better-sqlite3 DB:
 *   - ensureSaga3DiagnosisSchema idempotency + migration (C1, C2)
 *   - one ControlIntent per immutable certificate target (C3, C8)
 *   - report idempotency: same content under new execution reuses (C4)
 *   - corrected content creates a new report (C5)
 *   - rejected report durability (C6)
 *   - accepted report has no mutation path (C7)
 *   - target mismatch rejected (C9)
 *   - restart returns same id + hash (C10)
 *   - atomic insert re-verifies target lineage (C11 — TOCTOU tamper)
 *   - atomic insert rejects co-tamper (C12 — payload+hash changed together)
 *
 * The fixture mirrors d4-settlement-* tests: mkdtempSync, DB_PATH, getDb(),
 * cleanup with closeDb + rmSync. Tests import from ../../dist/... so `tsc` must
 * run first. The repo is exercised directly (not through the service — that is
 * Stage 3) and through the SqliteSaga3DiscoveryRuntime adapter port for the
 * ensureDiagnosisControl / setDiagnosisControlStatus paths.
 *
 * FK chain seeded so the control row (REFERENCES saga3_discovery_outcome_certificates)
 * can be inserted:
 *   tasks(100) → saga3_work_intents(1) → saga3_proposals(50) →
 *   saga3_discovery_settlements(1) → saga3_discovery_outcome_certificates(1)
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const {
  canonicalJson,
  sha256Hex,
} = await import('../../dist/saga3/shared/discovery-canonical.js');
const { ensureSaga3SettlementSchema } = await import(
  '../../dist/saga3/persistence/saga3-settlement-repository.js'
);
const {
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
  buildDiagnosisCase,
  diagnosisCaseHash,
} = await import('../../dist/saga3/domain/discovery-diagnosis-case.js');
const {
  DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
  hashDiagnosisReport,
} = await import('../../dist/saga3/domain/discovery-diagnosis-report.js');
const {
  ensureSaga3DiagnosisSchema,
  findDiagnosisControlByTarget,
  readAcceptedDiagnosisReportForControl,
  readDiagnosisControlById,
  readLatestDiagnosisReportForControl,
  submitDiagnosisReportAtomically,
} = await import('../../dist/saga3/persistence/saga3-diagnosis-repository.js');
const { SqliteSaga3DiscoveryRuntime } = await import(
  '../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js'
);
const { READINESS_DIMENSIONS } = await import(
  '../../dist/saga3/domain/discovery-readiness-assessment.js'
);

// ---------------------------------------------------------------------------
// Fixture scaffolding (mirrors d4-settlement-persistence.test)
// ---------------------------------------------------------------------------

/**
 * A canonical GO-able proposal payload. The diagnosis case embeds it; its hash
 * feeds the certificate + settlement_input_hash lineage. kept stable across
 * tests so hashes are deterministic.
 */
const PROPOSAL_PAYLOAD = {
  problem_statement: 'the problem',
  observed_context: 'the context',
  stakeholders_or_actors: ['user'],
  assumptions: ['assumption'],
  unknowns: ['unknown'],
  risks: ['risk'],
  candidate_scope: 'scope',
  evidence_refs: ['artifact:req-1'],
  recommended_outcome: 'go',
  rationale: 'rationale',
};
const PROPOSAL_HASH = createHash('sha256').update(canonicalJson(PROPOSAL_PAYLOAD)).digest('hex');

/** A stable settlement input_hash (the certificate target lineage anchor). */
const SETTLEMENT_INPUT_HASH = 'a'.repeat(64);

/**
 * Seed the shared base FK chain once (tasks/work_intents/proposals). Uses
 * INSERT OR IGNORE so it is safe to call before every `seedCertificate` even
 * when the rows already exist (C8 seeds two certificates off one chain).
 * Settlements are NOT seeded here — `seedCertificate` seeds its own settlement
 * because the outcome certificate is 1:1 UNIQUE with a settlement.
 */
function seedBaseChain(db) {
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'Discovery','done','discovery.work')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (1,10,'discovery','discover','{}','saga3.work-intent.discovery.v1',0,0,100,'concluded')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO saga3_proposals
       (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance)
     VALUES (50,1,100,'product-exec','discovery','saga3.discovery-proposal.v1',?,?, 'submitted','{}')`,
  ).run(canonicalJson(PROPOSAL_PAYLOAD), PROPOSAL_HASH);
}

/**
 * Seed ONE settlement + its 1:1 outcome-certificate (id `certId`, hash
 * `certHash`). `settlementId` defaults to `certId` and `readinessHash` varies
 * per call so two settlements form DISTINCT D4 input targets — the
 * idx_saga3_settlement_input UNIQUE index keys on
 * (proposal_id, proposal_content_hash, readiness_assessment_hash,
 * policy_version, policy_hash), so two settlements for the same proposal MUST
 * differ on readiness_assessment_hash to coexist (C8 seeds two targets).
 * Seeds the shared base chain first (idempotent).
 */
function seedCertificate(db, {
  certId = 1,
  certHash = null,
  settlementId,
  readinessHash = 'none',
  decision = 'go',
} = {}) {
  seedBaseChain(db);
  const sid = settlementId ?? certId;
  const hash = certHash ?? createHash('sha256').update(`cert-${certId}-${decision}`).digest('hex');
  db.prepare(
    `INSERT OR IGNORE INTO saga3_discovery_settlements
       (id,epic_id,proposal_id,proposal_content_hash,readiness_assessment_id,
        readiness_assessment_hash,policy_version,policy_hash,input_snapshot,
        input_hash,decision,reason_codes,rationale,status)
     VALUES (?,10,50,?,NULL,?,'saga3.settlement-policy.v1','${'p'.repeat(64)}',
        '{}',?,?,'["GO_READY_AND_GROUNDED"]','ready','certificate_issued')`,
  ).run(sid, PROPOSAL_HASH, readinessHash, SETTLEMENT_INPUT_HASH, decision);
  db.prepare(
    `INSERT INTO saga3_discovery_outcome_certificates
       (id,settlement_id,epic_id,proposal_id,proposal_content_hash,
        readiness_assessment_id,readiness_assessment_hash,policy_version,
        policy_hash,decision,reason_codes,input_hash,certificate_payload,
        certificate_hash,issued_at)
     VALUES (?,?,10,50,?,NULL,?,'saga3.settlement-policy.v1','${'p'.repeat(64)}',
        ?,?,'${SETTLEMENT_INPUT_HASH}','{}',?,'2026-07-24T00:00:00.000Z')`,
  ).run(certId, sid, PROPOSAL_HASH, readinessHash, decision, JSON.stringify(['GO_READY_AND_GROUNDED']), hash);
  return { certId, certHash: hash };
}

/**
 * Build a valid DiagnosisCase for a GO certificate, with an accepted readiness
 * ref. Used as the immutable `diagnosisCase` text on the control row.
 */
function buildGoCase(certId, certHash, settlementId = certId) {
  const dimension_assessments = {};
  for (const dimension of READINESS_DIMENSIONS) {
    dimension_assessments[dimension] = {
      status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'],
    };
  }
  const readinessPayload = {
    proposal_id: 50,
    proposal_content_hash: PROPOSAL_HASH,
    overall_readiness: 'ready',
    dimension_assessments,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'ready',
  };
  const certRef = {
    id: certId,
    hash: certHash,
    decision: 'go',
    reason_codes: ['GO_READY_AND_GROUNDED'],
    policy_version: 'saga3.discovery-settlement-policy.v1',
    policy_hash: 'p'.repeat(64),
    settlement_id: settlementId,
    settlement_input_hash: SETTLEMENT_INPUT_HASH,
  };
  return buildDiagnosisCase({
    epic_id: 10,
    certificate: certRef,
    proposal: { id: 50, hash: PROPOSAL_HASH, payload: PROPOSAL_PAYLOAD },
    readiness: {
      status: 'accepted_by_kernel', assessment_id: 7,
      hash: sha256Hex(readinessPayload), payload: readinessPayload,
    },
    proposal_source_submission_id: null,
    proposal_normalization_proposal_id: null,
    captured_at: '2026-07-24T00:00:00.000Z',
  });
}

/**
 * A minimal valid GO diagnosis report payload. The validator is NOT under test
 * here (those are the B-series pure tests); the persistence layer accepts any
 * payload + its recomputed hash. We keep the shape faithful so future service
 * tests reuse this fixture.
 */
function validReportPayload(certId, certHash, decision = 'go', overrides = {}) {
  return {
    schema_version: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
    target: {
      certificate_id: certId,
      certificate_hash: certHash,
      settlement_input_hash: SETTLEMENT_INPUT_HASH,
      decision,
    },
    executive_summary: 'The go decision is grounded in sufficient evidence.',
    cause_analysis: [],
    information_requests: [],
    recommended_actions: [
      {
        action_id: 'act-1',
        action: 'proceed_with_monitoring',
        description: 'Proceed; monitor residual risks.',
        resolves_cause_ids: [],
        source_refs: [`certificate:${certId}`],
      },
    ],
    residual_risks: [{ risk: 'adoption velocity', source_refs: [`certificate:${certId}`] }],
    confidence: 0.8,
    ...overrides,
  };
}

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d5-diag-'));
  process.env.DB_PATH = path.join(temp, 'd5.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  ensureSaga3SettlementSchema(db);
  ensureSaga3DiagnosisSchema(db);
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/** Build a EnsureDiagnosisControl input for a GO certificate target. */
function ensureInput(certId, certHash, overrides = {}) {
  const caseData = buildGoCase(certId, certHash, certId);
  const caseText = canonicalJson(caseData);
  const caseHash = diagnosisCaseHash(caseData);
  return {
    epicId: 10,
    projectId: 1,
    certificateId: certId,
    certificateHash: certHash,
    settlementId: certId,
    settlementInputHash: SETTLEMENT_INPUT_HASH,
    sourceIntentId: 1,
    objective: 'explain the go outcome',
    diagnosisCase: caseText,
    diagnosisCaseHash: caseHash,
    diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
    ...overrides,
  };
}

/** Build a report-insert input from a payload (hash recomputed from it). */
function reportInput(controlIntentId, payload, overrides = {}) {
  return {
    controlIntentId,
    executionId: 'diag-exec-1',
    payload,
    provenance: { worker_id: 'diag-worker', model: 'test-model' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// C1 — fresh schema idempotent
// ---------------------------------------------------------------------------

test('D5 persistence: fresh schema idempotent', () => {
  const { temp, db } = fixture();
  try {
    // getDb() already ran ensureSaga3DiagnosisSchema via the runtime's DDL in
    // SCHEMA_SQL; calling it again must be a no-op (CREATE TABLE IF NOT EXISTS).
    ensureSaga3DiagnosisSchema(db);
    ensureSaga3DiagnosisSchema(db);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('saga3_discovery_diagnosis_control_intents','saga3_discovery_diagnosis_reports')
        ORDER BY name`,
    ).all();
    assert.deepEqual(
      tables.map((t) => t.name),
      [
        'saga3_discovery_diagnosis_control_intents',
        'saga3_discovery_diagnosis_reports',
      ],
    );
    // Indexes present.
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index'
        AND name IN ('idx_saga3_diagnosis_control_target','idx_saga3_diagnosis_control_epic',
                     'idx_saga3_diagnosis_reports_control','idx_saga3_diagnosis_reports_idempotency')
        ORDER BY name`,
    ).all();
    assert.equal(idx.length, 4, 'all four D5 indexes must exist');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C2 — migration from a pre-D5 DB (D4 rows present, no D5 tables)
// ---------------------------------------------------------------------------

test('D5 persistence: migration from pre-D5 DB', () => {
  const { temp, db } = fixture();
  try {
    // Simulate a pre-D5 database: drop the D5 tables (their FK targets — the
    // D4 certificate/settlement tables — remain). A real upgrade runs
    // ensureSaga3DiagnosisSchema against this state.
    db.exec('DROP TABLE IF EXISTS saga3_discovery_diagnosis_reports');
    db.exec('DROP TABLE IF EXISTS saga3_discovery_diagnosis_control_intents');
    // Seed a D4 certificate so the migration lands against real lineage.
    seedCertificate(db);

    // The DDL must apply cleanly with no D5 tables present.
    ensureSaga3DiagnosisSchema(db);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND name LIKE 'saga3_discovery_diagnosis%' ORDER BY name`,
    ).all();
    assert.equal(tables.length, 2);

    // FK integrity: inserting a control bound to a real certificate must succeed
    // and the FK-check passes. (A control bound to a non-existent certificate
    // would fail FK — but we do not need to assert that here, only that the
    // migrated schema honours its FK to the D4 certificate table.)
    db.prepare(
      `INSERT INTO saga3_work_intents
         (id,epic_id,kind,objective,authority_scope,output_schema,
          token_budget,retry_budget,projected_task_id,status)
       VALUES (2,10,'discovery.diagnose','o','{}','saga3.work-intent.discovery-diagnosis.v1',0,0,100,'open')`,
    ).run();
    db.prepare(
      `INSERT INTO saga3_discovery_diagnosis_control_intents
         (epic_id,kind,certificate_id,certificate_hash,settlement_input_hash,
          diagnosis_case,diagnosis_case_hash,diagnosis_contract_version,
          authority_intent_id,status)
       VALUES (10,'DiagnoseDiscoveryOutcome',1,?,'${SETTLEMENT_INPUT_HASH}',
         '{}','${'c'.repeat(64)}',?,2,'open')`,
    ).run('d'.repeat(64), DISCOVERY_DIAGNOSIS_CONTRACT_VERSION);
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    assert.deepEqual(fkViolations, [], 'no FK violations after migration');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C3 — one ControlIntent per target (idempotent ensure)
// ---------------------------------------------------------------------------

test('D5 persistence: one control per target', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const rt = new SqliteSaga3DiscoveryRuntime();
    const first = rt.ensureDiagnosisControl(ensureInput(certId, certHash));
    const second = rt.ensureDiagnosisControl(ensureInput(certId, certHash));
    assert.equal(second.controlIntentId, first.controlIntentId);
    assert.equal(second.authorityIntentId, first.authorityIntentId);
    assert.equal(second.taskId, first.taskId);
    // Exactly one control row for this target.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_control_intents').get().c,
      1,
    );
    // Exactly one authority WorkIntent (idempotent createIntent reused).
    assert.equal(
      db.prepare(`SELECT COUNT(*) c FROM saga3_work_intents WHERE kind='discovery.diagnose'`).get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C4 — same content under new execution reuses report (idempotency)
// ---------------------------------------------------------------------------

test('D5 persistence: same content reuses report', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payload = validReportPayload(certId, certHash);

    const first = submitDiagnosisReportAtomically(db, reportInput(control.controlIntentId, payload));
    assert.equal(first.inserted, true);
    assert.equal(first.replayed, false);
    assert.equal(first.record.status, 'accepted_by_kernel');

    // Resubmit the SAME content under a DIFFERENT execution_id — must reuse.
    const second = submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload, { executionId: 'diag-exec-2' }),
    );
    assert.equal(second.inserted, false);
    assert.equal(second.replayed, true);
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.content_hash, first.record.content_hash);
    // Exactly one report row (no duplicate).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C5 — corrected content creates a new report
// ---------------------------------------------------------------------------

test('D5 persistence: corrected content new report', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payloadA = validReportPayload(certId, certHash);
    const first = submitDiagnosisReportAtomically(db, reportInput(control.controlIntentId, payloadA));

    // A DIFFERENT content_hash (corrected payload) under the same control
    // creates a NEW report row. The first was accepted; the second accepted
    // attempt for the same target must be rejected (at-most-one-accepted), so
    // this second insert throws — proving the new content is a distinct report
    // that the atomic guard correctly refuses to accept alongside the first.
    const payloadB = validReportPayload(certId, certHash, 'go', {
      executive_summary: 'revised explanation',
    });
    assert.notEqual(hashDiagnosisReport(payloadB), hashDiagnosisReport(payloadA));
    assert.throws(
      () => submitDiagnosisReportAtomically(
        db,
        reportInput(control.controlIntentId, payloadB, { executionId: 'diag-exec-2' }),
      ),
      /at-most-one-accepted/i,
    );
    // The new report row must NOT have been persisted (the tx rolled back).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      1,
    );
    assert.equal(first.record.id, db.prepare('SELECT id FROM saga3_discovery_diagnosis_reports').get().id);

    // A CORRECTED report that is REJECTED (not a second accepted) does persist
    // as a new durable row — corrected content under a new hash lands.
    const payloadC = validReportPayload(certId, certHash, 'go', { executive_summary: 'third try' });
    payloadC.residual_risks[0].source_refs = ['$.invented'];
    const rejected = submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payloadC, { executionId: 'diag-exec-3' }),
    );
    assert.equal(rejected.inserted, true);
    assert.notEqual(rejected.record.id, first.record.id);
    assert.equal(rejected.record.status, 'rejected_by_kernel');
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      2,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C6 — rejected report durability (row + validation_errors survive)
// ---------------------------------------------------------------------------

test('D5 persistence: rejected report durable', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payload = validReportPayload(certId, certHash);
    payload.residual_risks[0].source_refs = ['$.invented_source_ref'];
    submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload),
    );
    // Re-read via the repo: the row + status + validation_errors survive.
    const latest = readLatestDiagnosisReportForControl(db, control.controlIntentId);
    assert.ok(latest);
    assert.equal(latest.status, 'rejected_by_kernel');
    assert.ok(latest.validation_errors.some(error => error.includes('invented_source_ref')));
    // No accepted report exists for this target.
    const accepted = readAcceptedDiagnosisReportForControl(db, control.controlIntentId);
    assert.equal(accepted, null);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C7 — accepted report has no mutation path (API surface)
// ---------------------------------------------------------------------------

test('D5 persistence: accepted report has no mutation path', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payload = validReportPayload(certId, certHash);
    const { record } = submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload),
    );

    // The repository exports NO function that updates an accepted report's
    // payload or status. The only writes are: submitDiagnosisReportAtomically
    // (insert-only) and setDiagnosisControlStatus (control lifecycle, not the
    // report). Assert the accepted row is read-back byte-identical and that the
    // idempotent re-insert does NOT mutate it.
    const before = readAcceptedDiagnosisReportForControl(db, control.controlIntentId);
    submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload, { executionId: 'exec-2' }),
    );
    const after = readAcceptedDiagnosisReportForControl(db, control.controlIntentId);
    assert.deepEqual(after, before);
    assert.equal(after.id, record.id);
    assert.equal(after.content_hash, record.content_hash);
    assert.equal(after.status, 'accepted_by_kernel');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C8 — certificate hash change => new ControlIntent
// ---------------------------------------------------------------------------

test('D5 persistence: new certificate hash new control', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash: hashA } = seedCertificate(db, { certId: 1, readinessHash: 'none' });
    // A distinct certificate target requires a distinct D4 settlement input
    // target (the settlement UNIQUE index keys on readiness_assessment_hash).
    // certId=2 binds to a settlement whose readiness_hash differs -> a new
    // settlement + certificate, hence a new diagnosis target.
    const { certHash: hashB } = seedCertificate(db, { certId: 2, readinessHash: 'failed' });
    const rt = new SqliteSaga3DiscoveryRuntime();
    const a = rt.ensureDiagnosisControl(ensureInput(certId, hashA));
    const b = rt.ensureDiagnosisControl(ensureInput(2, hashB));
    assert.notEqual(b.controlIntentId, a.controlIntentId);
    assert.notEqual(b.authorityIntentId, a.authorityIntentId);
    assert.notEqual(b.taskId, a.taskId);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_control_intents').get().c,
      2,
    );
    // findDiagnosisControlByTarget returns the distinct control per target.
    const foundA = findDiagnosisControlByTarget(db, certId, hashA);
    const foundB = findDiagnosisControlByTarget(db, 2, hashB);
    assert.equal(foundA.id, a.controlIntentId);
    assert.equal(foundB.id, b.controlIntentId);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C9 — report target mismatch rejected (TOCTOU inside atomic insert)
// ---------------------------------------------------------------------------

test('D5 persistence: report target mismatch rejected', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payload = validReportPayload(certId, certHash);
    payload.target.certificate_hash = '0'.repeat(64);
    const result = submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload),
    );
    assert.equal(result.record.status, 'rejected_by_kernel');
    assert.ok(result.record.validation_errors.some(error => error.includes('target.certificate_hash')));
  } finally {
    cleanup(temp);
  }
});


// ---------------------------------------------------------------------------
// C10 — restart returns same id + content_hash
// ---------------------------------------------------------------------------

test('D5 persistence: restart same report id/hash', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payload = validReportPayload(certId, certHash);
    const first = submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload),
    );
    // Simulate a restart: a fresh runtime + a replayed identical submission.
    new SqliteSaga3DiscoveryRuntime();
    const replayed = submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload, { executionId: 'restart-exec' }),
    );
    assert.equal(replayed.record.id, first.record.id);
    assert.equal(replayed.record.content_hash, first.record.content_hash);
    assert.equal(replayed.replayed, true);
    // readAcceptedDiagnosisReportForControl returns the same id+hash.
    const accepted = readAcceptedDiagnosisReportForControl(db, control.controlIntentId);
    assert.equal(accepted.id, first.record.id);
    assert.equal(accepted.content_hash, first.record.content_hash);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C11 — atomic insert verifies target lineage (tamper control's cert_hash)
// ---------------------------------------------------------------------------

test('D5 persistence: atomic insert verifies target lineage', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payload = validReportPayload(certId, certHash);

    // TOCTOU: another writer tampers the control's certificate_hash AFTER the
    // control was created but BEFORE BEGIN IMMEDIATE. The atomic insert must
    // re-read the control and reject the now-mismatched target lineage.
    db.prepare(
      'UPDATE saga3_discovery_diagnosis_control_intents SET certificate_hash=? WHERE id=?',
    ).run('e'.repeat(64), control.controlIntentId);

    assert.throws(
      () => submitDiagnosisReportAtomically(
        db,
        reportInput(control.controlIntentId, payload),
      ),
      /case certificate tuple does not match|metadata.certificate_hash/i,
    );
    // No report row persisted.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      0,
    );
    // Control row itself is untouched apart from the injected tamper (the tx
    // rolled back; it did not delete or further mutate the control).
    const ctrl = readDiagnosisControlById(db, control.controlIntentId);
    assert.equal(ctrl.certificate_hash, 'e'.repeat(64));
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// C12 — atomic insert rejects co-tamper (payload+hash changed together)
// ---------------------------------------------------------------------------

test('D5 persistence: atomic replay rejects coherent accepted-report tamper', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const control = new SqliteSaga3DiscoveryRuntime().ensureDiagnosisControl(ensureInput(certId, certHash));
    const payload = validReportPayload(certId, certHash);
    const inserted = submitDiagnosisReportAtomically(
      db,
      reportInput(control.controlIntentId, payload),
    );
    assert.equal(inserted.record.status, 'accepted_by_kernel');

    const tampered = structuredClone(payload);
    tampered.residual_risks[0].source_refs = ['$.invented_after_accept'];
    const tamperedHash = hashDiagnosisReport(tampered);
    db.prepare(
      `UPDATE saga3_discovery_diagnosis_reports SET payload=?, content_hash=? WHERE id=?`,
    ).run(canonicalJson(tampered), tamperedHash, inserted.record.id);

    assert.throws(
      () => submitDiagnosisReportAtomically(
        db,
        reportInput(control.controlIntentId, tampered, { executionId: 'diag-replay-tampered' }),
      ),
      /replayed diagnosis report .* no longer validates|verdict drift/i,
    );
  } finally {
    cleanup(temp);
  }
});


// ---------------------------------------------------------------------------
// Extra: setDiagnosisControlStatus CAS + DiagnosisControlExecution shape
// (guards the runtime adapter port methods the matrix exercises indirectly)
// ---------------------------------------------------------------------------

test('D5 persistence: setDiagnosisControlStatus CAS transitions', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db);
    const rt = new SqliteSaga3DiscoveryRuntime();
    const control = rt.ensureDiagnosisControl(ensureInput(certId, certHash));
    // The execution shape surfaces the immutable target + case.
    assert.equal(control.certificateId, certId);
    assert.equal(control.certificateHash, certHash);
    assert.equal(control.settlementInputHash, SETTLEMENT_INPUT_HASH);
    assert.equal(control.diagnosisCaseHash, diagnosisCaseHash(buildGoCase(certId, certHash)));
    assert.equal(control.controlStatus, 'open');

    // CAS: open -> executing succeeds; open -> concluded (stale expected) fails.
    assert.equal(rt.setDiagnosisControlStatus(control.controlIntentId, 'open', 'executing'), true);
    assert.equal(rt.setDiagnosisControlStatus(control.controlIntentId, 'open', 'concluded'), false);
    // executing -> concluded now succeeds.
    assert.equal(rt.setDiagnosisControlStatus(control.controlIntentId, 'executing', 'concluded'), true);
    const after = rt.readDiagnosisControl(control.controlIntentId);
    assert.equal(after.status, 'concluded');
  } finally {
    cleanup(temp);
  }
});
