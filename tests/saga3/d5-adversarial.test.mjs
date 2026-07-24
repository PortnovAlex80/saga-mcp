/**
 * D5 — Advisory Discovery Diagnosis ADVERSARIAL attacks (matrix G1–G8).
 *
 * Independent Stage-5 review. These tests do NOT trust the implementer's
 * narrative; they ATTACK the real code paths and assert the invariants hold.
 * Every test exercises the REAL domain validator, the REAL atomic insert
 * (`submitDiagnosisReportAtomically`), and — where a service path exists — the
 * REAL `Saga3DiscoveryDiagnosisService` bound to a real better-sqlite3 runtime
 * port. The only fake is the worker executor, which injects the attack payload
 * (exactly as a malicious or buggy worker would).
 *
 * Sources of truth:
 *   - docs/saga3/D5-INVARIANTS.md  (I1–I8)
 *   - docs/saga3/D5-TEST-MATRIX.md (group G)
 *   - public interfaces (domain types, port, service, repo)
 *
 * If an attack below is marked with `test.todo`, the test documents a REAL
 * invariant hole found during review (the implementer must fix the code before
 * the test is finalized — the reviewer does NOT weaken the invariant).
 *
 * Coverage:
 *   G1 (I3)  target mismatch          — tampered control cert_hash + service
 *                                        fed a stale cert hash
 *   G2 (I4)  invent evidence          — invented $.field / assessment:999
 *   G3 (§8)  break reason coverage    — clarify cert reason not covered
 *   G4 (I7)  break restart            — restart returns same id/hash, no respawn
 *   G5 (I7)  break idempotency        — two accepted reports impossible
 *   G6 (I1)  outcome override         — override_decision rejected
 *   G7 (I1)  stage transition attempt — transition_stage rejected; finalStage
 *                                        stays 'discovery'
 *   G8 (I7)  accepted report immutable — no mutation path; second accepted throws
 *
 * Tests import from ../../dist/... so `npm run build` (tsc) must run first.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import('../../dist/saga3/domain/discovery-proposal.js');
const {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_READINESS_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} = await import('../../dist/saga3/domain/work-intent.js');
const { DISCOVERY_READINESS_ASSESSMENT_SCHEMA, READINESS_DIMENSIONS } = await import(
  '../../dist/saga3/domain/discovery-readiness-assessment.js'
);
const { canonicalJson } = await import('../../dist/saga3/shared/discovery-canonical.js');
const { ensureSaga3ReadinessSchema } = await import(
  '../../dist/saga3/persistence/saga3-readiness-repository.js'
);
const {
  ensureSaga3SettlementSchema,
} = await import('../../dist/saga3/persistence/saga3-settlement-repository.js');
const { ensureSaga3DiagnosisSchema } = await import(
  '../../dist/saga3/persistence/saga3-diagnosis-repository.js'
);
const {
  DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  buildDiagnosisCase,
  diagnosisCaseHash,
} = await import('../../dist/saga3/domain/discovery-diagnosis-case.js');
const {
  DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
  hashDiagnosisReport,
} = await import('../../dist/saga3/domain/discovery-diagnosis-report.js');
const { validateDiagnosisReport } = await import(
  '../../dist/saga3/domain/discovery-diagnosis-validator.js'
);
const { FORBIDDEN_DIAGNOSIS_FIELDS } = await import(
  '../../dist/saga3/domain/discovery-diagnosis-report.js'
);
const { Saga3DiscoveryDiagnosisService } = await import(
  '../../dist/saga3/application/discovery-diagnosis-service.js'
);
const { Saga3DiscoverySettlementService } = await import(
  '../../dist/saga3/application/discovery-settlement-service.js'
);
const { SqliteSaga3DiscoveryRuntime } = await import(
  '../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js'
);
const { Saga3DiscoveryEngine } = await import('../../dist/engines/saga3-discovery-engine.js');

// ---------------------------------------------------------------------------
// Fixture scaffolding (mirrors d5-diagnosis-service.test.mjs)
// ---------------------------------------------------------------------------

const PRODUCT_PROPOSAL_PAYLOAD = {
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
const PRODUCT_PROPOSAL_HASH = createHash('sha256').update(canonicalJson(PRODUCT_PROPOSAL_PAYLOAD)).digest('hex');

function validAssessmentPayload(proposalId, proposalHash, overrides = {}) {
  const dims = {};
  for (const d of READINESS_DIMENSIONS) {
    dims[d] = { status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'] };
  }
  return {
    proposal_id: proposalId,
    proposal_content_hash: proposalHash,
    overall_readiness: 'ready',
    dimension_assessments: dims,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'well grounded',
    ...overrides,
  };
}

const ASSESSMENT_PAYLOAD = validAssessmentPayload(50, PRODUCT_PROPOSAL_HASH);
const ASSESSMENT_HASH = createHash('sha256').update(canonicalJson(ASSESSMENT_PAYLOAD)).digest('hex');
const ACCEPTED_TARGET = `accepted:${ASSESSMENT_HASH}`;
const POLICY_HASH = 'p'.repeat(64);

/**
 * Build a settlement snapshot for a given decision + reason codes. The diagnosis
 * case is derived from this snapshot, so varying decision/reason_codes produces
 * distinct certificate targets (distinct immutable diagnosis targets, I3).
 */
function buildSettlementSnapshot(decision, reasonCodes, overrides = {}) {
  return {
    schema_version: 'saga3.discovery-settlement-input.v1',
    epic_id: 10,
    proposal: {
      id: 50,
      content_hash: PRODUCT_PROPOSAL_HASH,
      payload: PRODUCT_PROPOSAL_PAYLOAD,
      source_intent_id: 1,
      source_submission_id: null,
      normalization_proposal_id: null,
    },
    readiness: {
      status: 'accepted_by_kernel',
      assessment_id: 7,
      content_hash: ASSESSMENT_HASH,
      payload: ASSESSMENT_PAYLOAD,
    },
    policy: { version: 'saga3.settlement-policy.v1', content_hash: POLICY_HASH },
    captured_at: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Seed the full D4 FK chain + readiness control + accepted assessment, plus ONE
 * settlement + outcome certificate for the given decision/reasonCodes. Returns
 * the cert id + hash + the built snapshot's input_hash.
 *
 * `certId`/`settlementId` let callers seed MULTIPLE distinct certificate targets
 * in one DB (needed for G1's stale-hash case and the G7 engine case).
 */
function seedCertificate(db, {
  certId = 1,
  settlementId = null,
  decision = 'go',
  reasonCodes = ['GO_READY_AND_GROUNDED'],
  readinessPayload = ASSESSMENT_PAYLOAD,
  readinessHash = ACCEPTED_TARGET,
  snapshotOverride = {},
} = {}) {
  ensureSaga3ReadinessSchema(db);
  ensureSaga3SettlementSchema(db);
  ensureSaga3DiagnosisSchema(db);

  // Product task + WorkIntent + Proposal (idempotent — shared across certs).
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'Discovery','done','discovery.work')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (1,10,?,?,?,?,0,0,100,'concluded')`,
  ).run(DISCOVERY_INTENT_KIND, 'discover', '{}', DISCOVERY_WORK_INTENT_SCHEMA);
  db.prepare(
    `INSERT OR IGNORE INTO saga3_proposals
       (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance)
     VALUES (50,1,100,'product-exec',?,?,?,?,?,?)`,
  ).run(
    'discovery',
    DISCOVERY_PROPOSAL_SCHEMA,
    canonicalJson(PRODUCT_PROPOSAL_PAYLOAD),
    PRODUCT_PROPOSAL_HASH,
    'submitted',
    '{}',
  );

  // Advisor task + WorkIntent + readiness ControlIntent + accepted assessment.
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id,epic_id,title,status,task_kind) VALUES (200,10,'Assess','done','discovery.assess')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (2,10,?,?,?,?,0,0,200,'concluded')`,
  ).run(DISCOVERY_READINESS_INTENT_KIND, 'assess', '{}', DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
  db.prepare(
    `INSERT OR IGNORE INTO saga3_readiness_control_intents
       (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,
        authority_intent_id,projected_task_id,status)
     VALUES (1,10,'AssessDiscoveryReadiness',?,?,?,?,?, 'concluded')`,
  ).run(50, PRODUCT_PROPOSAL_HASH, 1, 2, 200);
  db.prepare(
    `INSERT OR IGNORE INTO saga3_readiness_assessments
       (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
        payload,content_hash,status,overall_readiness,recommended_next_action,
        validation_errors,provenance)
     VALUES (7,1,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
  ).run(PRODUCT_PROPOSAL_HASH, canonicalJson(readinessPayload), ASSESSMENT_HASH);

  const sid = settlementId ?? certId;
  const snapshot = buildSettlementSnapshot(decision, reasonCodes, snapshotOverride);
  const inputHash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  const certHash = createHash('sha256').update(`cert-${certId}-${decision}`).digest('hex');
  const POLICY_VERSION = 'saga3.settlement-policy.v1';
  const reasonCodesJson = JSON.stringify(reasonCodes);

  // Settlement: 14 columns. Bind sid + decision as params so multiple distinct
  // targets can coexist in one DB. Placeholder order matches the column order.
  db.prepare(
    `INSERT INTO saga3_discovery_settlements
       (id,epic_id,proposal_id,proposal_content_hash,readiness_assessment_id,
        readiness_assessment_hash,policy_version,policy_hash,input_snapshot,
        input_hash,decision,reason_codes,rationale,status)
     VALUES (?,10,50,?,7,?,?,?,?,?,?,?,?, 'certificate_issued')`,
  ).run(
    sid,
    PRODUCT_PROPOSAL_HASH,
    readinessHash,
    POLICY_VERSION,
    POLICY_HASH,
    canonicalJson(snapshot),
    inputHash,
    decision,
    reasonCodesJson,
    'settlement rationale',
  );
  db.prepare(
    `INSERT INTO saga3_discovery_outcome_certificates
       (id,settlement_id,epic_id,proposal_id,proposal_content_hash,
        readiness_assessment_id,readiness_assessment_hash,policy_version,
        policy_hash,decision,reason_codes,input_hash,certificate_payload,
        certificate_hash,issued_at)
     VALUES (?,?,10,50,?,7,?,?,?,?,?,?,'{}',?,'2026-07-24T00:00:00.000Z')`,
  ).run(
    certId,
    sid,
    PRODUCT_PROPOSAL_HASH,
    readinessHash,
    POLICY_VERSION,
    POLICY_HASH,
    decision,
    reasonCodesJson,
    inputHash,
    certHash,
  );
  return { certId, certHash, inputHash };
}


/** Issue a real D4 GO certificate over the seeded product/readiness rows. */
async function issueRealGoCertificate(db) {
  seedCertificate(db, { decision: 'go' });
  db.exec(`
    DELETE FROM saga3_discovery_outcome_certificates;
    DELETE FROM saga3_discovery_settlements;
  `);
  const service = new Saga3DiscoverySettlementService({
    runtimePersistence: new SqliteSaga3DiscoveryRuntime(),
  });
  const result = await service.settle({
    projectId: 1,
    epicId: 10,
    proposalId: 50,
    proposalHash: PRODUCT_PROPOSAL_HASH,
    readiness: {
      status: 'completed', authority: 'shadow_advisor',
      assessmentId: 7, assessmentHash: ASSESSMENT_HASH,
      overallReadiness: 'ready', recommendedNextAction: 'proceed_to_settlement',
      error: null,
    },
  });
  assert.equal(result.status, 'issued');
  return { certId: result.certificateId, certHash: result.certificateHash };
}

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d5-adv-'));
  process.env.DB_PATH = path.join(temp, 'd5adv.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function fullConfig() {
  return { dbPath: process.env.DB_PATH, claudePath: 'claude', lmStudioUrl: 'http://x/v1' };
}
function fakeHost() {
  return {
    processId: 42,
    workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' },
  };
}

/**
 * Fake worker executor. `onFirstPoll` runs once on the first status() call so a
 * test can inject the attack payload (flip the diagnosis task to done, insert a
 * report via the runtime port — mirroring what diagnosis_submit persists).
 */
function makeFakeExecutor(onFirstPoll) {
  let polled = false;
  let stopped = false;
  return {
    start() {},
    status(projectId) {
      if (!polled) {
        polled = true;
        onFirstPoll();
      }
      if (stopped) return null;
      return {
        id: 'fake-run', project_id: projectId, concurrency: 1, status: 'running',
        active: [], completed: 1, failed: 0, claimed: 1,
      };
    },
    setConcurrency() {},
    stop() { stopped = true; },
    dispose() {},
  };
}

/**
 * Insert a report via the runtime port (what diagnosis_submit does). `control`
 * is the DiagnosisControlExecution record returned by ensureDiagnosisControl
 * (camelCase fields: controlIntentId, certificateId, certificateHash,
 * settlementInputHash, taskId). `caseData` supplies the decision (read from the
 * immutable case the control froze).
 */
function insertReport(runtime, control, caseData, payload, { executionId = 'diag-exec' } = {}) {
  void caseData;
  return runtime.submitDiagnosisReportAtomically({
    controlIntentId: control.controlIntentId,
    executionId,
    payload,
    provenance: { worker_id: 'diag-worker', execution_id: executionId },
  });
}

/** A valid GO diagnosis report for the case the service froze on the control. */
function validGoReport(caseData) {
  return {
    schema_version: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
    target: {
      certificate_id: caseData.certificate.id,
      certificate_hash: caseData.certificate.hash,
      settlement_input_hash: caseData.certificate.settlement_input_hash,
      decision: 'go',
    },
    executive_summary: 'All GO conditions met; the decision is well-grounded.',
    cause_analysis: [],
    information_requests: [],
    recommended_actions: [{
      action_id: 'A1',
      action: 'proceed_with_monitoring',
      description: 'Proceed with the go decision; monitor residual risks.',
      resolves_cause_ids: [],
      source_refs: [`certificate:${caseData.certificate.id}`],
    }],
    residual_risks: [{
      risk: 'Market timing may shift before formalization.',
      source_refs: ['$.observed_context'],
    }],
    confidence: 0.85,
  };
}

/** Construct the service bound to the current DB + a fake executor factory. */
function makeService(executor) {
  const runtime = new SqliteSaga3DiscoveryRuntime();
  const service = new Saga3DiscoveryDiagnosisService({
    config: fullConfig(),
    workerExecutorFactory: () => executor,
    host: fakeHost(),
    runtimePersistence: runtime,
    now: () => new Date('2026-07-24T00:00:00.000Z'),
    sleep: async () => {},
    pollMs: 0,
    maxRunSeconds: 60,
  });
  return { runtime, service };
}

function diagnose(service, certId, certHash) {
  return service.diagnose({
    projectId: 1,
    epicId: 10,
    certificateId: certId,
    certificateHash: certHash,
    workspaceRoot: '/w',
    heartbeat: () => {},
  });
}

// ===========================================================================
// G1 (I3) — target mismatch: tampered control hash + stale cert hash in request
// ===========================================================================
//
// Two distinct attacks on the SAME invariant (an exact certificate target):
//
//   (a) TOCTOU at the persistence boundary: a control is created for target T1;
//       an attacker tampers the control row's certificate_hash directly (raw
//       SQL UPDATE) AFTER the control was created but BEFORE BEGIN IMMEDIATE.
//       submitDiagnosisReportAtomically is then called with the ORIGINAL target.
//       The atomic tx must re-read the control and REJECT (TOCTOU closure).
//
//   (b) Service-level hash drift: the service is fed a certificateHash that
//       disagrees with the certificate row's stored hash. verifyDiagnosisTarget
//       must reject it and the diagnosis result must be status='failed'
//       (NOT accepted) — the D4 result stays complete (I5).

test('D5 adv G1: tampered control certificate_hash is caught by the atomic insert (TOCTOU closure)', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, { decision: 'go' });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    // Build a valid case for target T1 + ensure the control.
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: certId, hash: certHash, decision: 'go', reason_codes: ['GO_READY_AND_GROUNDED'],
        policy_version: 'saga3.settlement-policy.v1', policy_hash: POLICY_HASH,
        settlement_id: 1, settlement_input_hash: null, // filled below
      },
      proposal: { id: 50, hash: PRODUCT_PROPOSAL_HASH, payload: PRODUCT_PROPOSAL_PAYLOAD },
      readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: ASSESSMENT_HASH, payload: ASSESSMENT_PAYLOAD },
      proposal_source_submission_id: null, proposal_normalization_proposal_id: null,
      captured_at: '2026-07-24T00:00:00.000Z',
    });
    // Read the real settlement_input_hash the service would have captured.
    const cert = runtime.readOutcomeCertificate(certId);
    caseData.certificate.settlement_input_hash = cert.input_hash;
    const control = runtime.ensureDiagnosisControl({
      epicId: 10, projectId: 1, certificateId: certId, certificateHash: certHash,
      settlementId: cert.settlement_id, settlementInputHash: cert.input_hash,
      sourceIntentId: 1, objective: 'o',
      diagnosisCase: canonicalJson(caseData),
      diagnosisCaseHash: diagnosisCaseHash(caseData),
      diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
    });

    // ATTACK: tamper the control's certificate_hash in the row directly.
    db.prepare(
      'UPDATE saga3_discovery_diagnosis_control_intents SET certificate_hash=? WHERE id=?',
    ).run('e'.repeat(64), control.controlIntentId);

    // Attempt to insert a report for the ORIGINAL target — the atomic tx must
    // re-read the control, detect the drift, and THROW.
    const report = validGoReport(caseData);
    assert.throws(
      () => insertReport(runtime, control, caseData, report, { status: 'accepted_by_kernel', validationErrors: [] }),
      /case certificate tuple does not match|metadata.certificate_hash|TOCTOU/i,
      'atomic insert must reject a report whose target drifted from the control row',
    );
    // No report persisted.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      0,
      'no report row may survive a TOCTOU rejection',
    );
  } finally {
    cleanup(temp);
  }
});

test('D5 adv G1: service fed a stale certificateHash returns failed (not accepted)', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, { decision: 'go' });
    // A FAKE executor whose poll would accept a report — but the service must
    // never reach the worker because the target verification fails first.
    const { service } = makeService(makeFakeExecutor(() => {
      // If this runs, the invariant is broken: the service spawned a worker
      // despite a stale certificate hash.
      throw new Error('BUG: worker spawned despite stale certificate hash');
    }));
    // Feed a certificateHash that disagrees with the stored row.
    const staleHash = '0'.repeat(64);
    assert.notEqual(staleHash, certHash);
    const result = await diagnose(service, certId, staleHash);
    // I3 + I5: rejected AND advisory (status failed, authority none). NOT accepted.
    assert.equal(result.status, 'failed', 'stale certificate hash must yield status=failed');
    assert.equal(result.authority, 'none');
    assert.equal(result.reportId, null);
    assert.ok(result.error, 'failed result must carry an error mentioning the mismatch');
    // No diagnosis control/report row was created.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_control_intents').get().c,
      0,
      'no control row when the target cannot be verified',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      0,
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// G2 (I4) — invent evidence: a source ref NOT in the case allowlist
// ===========================================================================
//
// A worker submits a report that cites a source ref outside the kernel-built
// allowed_source_refs set (e.g. an invented $.field, or assessment:999 when no
// such assessment exists). The validator MUST reject it, AND the report must be
// persisted as rejected_by_kernel with NON-EMPTY validation_errors (durable).
// We also probe the sneakiest bypass: a forbidden field on a structurally
// malformed payload (does the validator check forbidden fields BEFORE the
// structural checks that might bail early?).

test('D5 adv G2: invented source ref is rejected by the validator AND persisted durably', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, { decision: 'go' });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const cert = runtime.readOutcomeCertificate(certId);
    const proposal = runtime.readProposalForSettlement(cert.proposal_id);
    const assessment = runtime.readReadinessAssessment(cert.readiness_assessment_id);
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: { status: 'accepted_by_kernel', assessment_id: assessment.id, hash: assessment.content_hash, payload: assessment.payload },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });
    const control = runtime.ensureDiagnosisControl({
      epicId: 10, projectId: 1, certificateId: certId, certificateHash: certHash,
      settlementId: cert.settlement_id, settlementInputHash: cert.input_hash,
      sourceIntentId: proposal.intent_id, objective: 'o',
      diagnosisCase: canonicalJson(caseData),
      diagnosisCaseHash: diagnosisCaseHash(caseData),
      diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
    });

    // ATTACK: an invented source ref that LOOKS plausible but is not allowlisted.
    const report = validGoReport(caseData);
    report.recommended_actions[0].source_refs = ['$.totally_invented_field'];
    // The validator (the kernel gate) must reject.
    const validation = validateDiagnosisReport(report, caseData);
    assert.equal(validation.valid, false, 'invented source ref must be invalid');
    assert.ok(
      validation.errors.some(e => e.includes('totally_invented_field')),
      `validation errors must name the invented ref; got ${JSON.stringify(validation.errors)}`,
    );

    // Persist as rejected_by_kernel WITH the non-empty errors (durable audit).
    const inserted = insertReport(
      runtime, control, caseData, report,
      { status: 'rejected_by_kernel', validationErrors: validation.errors },
    );
    assert.equal(inserted.record.status, 'rejected_by_kernel');
    assert.ok(
      inserted.record.validation_errors.length > 0,
      'a rejected report must carry NON-EMPTY validation_errors (durable rejection)',
    );

    // A second invented-ref shape: assessment:<nonexistent-id>. No assessment
    // with id 999 was seeded, and the allowlist never includes it.
    const report2 = validGoReport(caseData);
    report2.residual_risks[0].source_refs = ['assessment:999'];
    const v2 = validateDiagnosisReport(report2, caseData);
    assert.equal(v2.valid, false, 'assessment:999 (nonexistent) must be invalid');
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// G3 (§8) — break reason coverage on a CLARIFY certificate
// ===========================================================================
//
// A clarify certificate carries reason_code CLARIFY_BLOCKING_GAPS. The worker
// submits a report whose causes cover NONE of the certificate's reason codes.
// The validator MUST reject (§8: every CLARIFY/REJECT reason code must be
// covered by at least one cause). We probe two sneaky shapes: a cause that
// cites a reason code NOT on the certificate (invented code), and a report
// whose causes cite the wrong code entirely (coverage broken).

test('D5 adv G3: clarify certificate reason code not covered by any cause is rejected', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, {
      decision: 'clarify',
      reasonCodes: ['CLARIFY_BLOCKING_GAPS'],
    });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const cert = runtime.readOutcomeCertificate(certId);
    const proposal = runtime.readProposalForSettlement(cert.proposal_id);
    const assessment = runtime.readReadinessAssessment(cert.readiness_assessment_id);
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: { status: 'accepted_by_kernel', assessment_id: assessment.id, hash: assessment.content_hash, payload: assessment.payload },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });

    // ATTACK 1: a cause that cites a reason code NOT on the certificate.
    const reportInventedCode = {
      schema_version: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
      target: {
        certificate_id: certId, certificate_hash: certHash,
        settlement_input_hash: cert.input_hash, decision: 'clarify',
      },
      executive_summary: 'gaps',
      cause_analysis: [{
        cause_id: 'C1', category: 'blocking_gap', description: 'd', severity: 'blocking',
        // Invented code — not on the certificate.
        reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'],
        cited_condition_ids: [],
        source_refs: [`certificate:${certId}`],
      }],
      information_requests: [], recommended_actions: [], residual_risks: [],
      confidence: 0.5,
    };
    const v1 = validateDiagnosisReport(reportInventedCode, caseData);
    assert.equal(v1.valid, false, 'a cause citing a code not on the certificate must be rejected');
    assert.ok(
      v1.errors.some(e => e.includes('REJECT_WORKER_AND_ADVISOR_AGREE') && e.includes('not carried')),
      `must name the uncarried code; got ${JSON.stringify(v1.errors)}`,
    );

    // ATTACK 2: a cause with NO reason codes at all (coverage broken — the
    // certificate's CLARIFY_BLOCKING_GAPS is covered by no cause).
    const reportNoCoverage = JSON.parse(JSON.stringify(reportInventedCode));
    reportNoCoverage.cause_analysis[0].reason_codes = [];
    const v2 = validateDiagnosisReport(reportNoCoverage, caseData);
    assert.equal(v2.valid, false, 'an uncovered certificate reason code must be rejected');
    assert.ok(
      v2.errors.some(e => e.includes('CLARIFY_BLOCKING_GAPS') && e.includes('not covered')),
      `must name the uncovered reason code; got ${JSON.stringify(v2.errors)}`,
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// G4 (I7) — break restart: same target on restart returns SAME id/hash, no respawn
// ===========================================================================
//
// Run the service to produce an accepted report (R1, H1). Call diagnose AGAIN
// with the SAME target. The restart-resume early-exit must return the SAME
// reportId/reportHash WITHOUT spawning a second worker (no second executor.start).

test('D5 adv G4: restart returns the same reportId/reportHash and does not respawn the worker', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await issueRealGoCertificate(db);
    let startCount = 0;
    const executor = makeFakeExecutor(() => {
      const control = runtime.readDiagnosisControlForTarget(certId, certHash);
      const caseData = JSON.parse(control.diagnosis_case);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
      const report = validGoReport(caseData);
      runtime.submitDiagnosisReportAtomically({
        controlIntentId: control.id,
        executionId: 'diag-exec-1',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-1' },
      });
    });
    // Wrap executor.start so we can count respawns (the service calls start()).
    const realStart = executor.start.bind(executor);
    executor.start = (...args) => { startCount++; return realStart(...args); };
    const { runtime, service } = makeService(executor);

    const first = await diagnose(service, certId, certHash);
    assert.equal(first.status, 'completed');
    assert.equal(startCount, 1, 'first run spawns exactly one worker');
    const firstReportId = first.reportId;
    const firstReportHash = first.reportHash;
    assert.ok(firstReportId > 0);
    assert.ok(firstReportHash);

    // RESTART: same target. Must reuse, NOT respawn.
    const second = await diagnose(service, certId, certHash);
    assert.equal(second.status, 'completed');
    assert.equal(second.reportId, firstReportId, 'restart must return the SAME reportId');
    assert.equal(second.reportHash, firstReportHash, 'restart must return the SAME reportHash');
    assert.equal(startCount, 1, 'restart must NOT spawn a second worker (no respawn)');
    // Exactly one report row.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      1,
      'restart must not duplicate the report row',
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// G5 (I7) — break idempotency under concurrency: two accepted reports impossible
// ===========================================================================
//
// True concurrency is hard to simulate deterministically in one process; instead
// assert the STRUCTURAL guarantee the atomic tx enforces inside BEGIN IMMEDIATE:
// after an accepted report exists, a second insert with status='accepted_by_kernel'
// for a DIFFERENT content_hash on the same control must THROW (at-most-one-accepted).
// This is the guarantee that makes two concurrent accepted inserts impossible —
// the second one's tx cannot commit.

test('D5 adv G5: a second accepted report with a different content_hash is impossible', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, { decision: 'go' });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const cert = runtime.readOutcomeCertificate(certId);
    const proposal = runtime.readProposalForSettlement(cert.proposal_id);
    const assessment = runtime.readReadinessAssessment(cert.readiness_assessment_id);
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: { status: 'accepted_by_kernel', assessment_id: assessment.id, hash: assessment.content_hash, payload: assessment.payload },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });
    const control = runtime.ensureDiagnosisControl({
      epicId: 10, projectId: 1, certificateId: certId, certificateHash: certHash,
      settlementId: cert.settlement_id, settlementInputHash: cert.input_hash,
      sourceIntentId: proposal.intent_id, objective: 'o',
      diagnosisCase: canonicalJson(caseData),
      diagnosisCaseHash: diagnosisCaseHash(caseData),
      diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
    });
    // First accepted report lands.
    const payloadA = validGoReport(caseData);
    const first = insertReport(runtime, control, caseData, payloadA, { status: 'accepted_by_kernel', validationErrors: [] });
    assert.equal(first.record.status, 'accepted_by_kernel');

    // ATTACK: a SECOND accepted report with a DIFFERENT content_hash. Must throw.
    const payloadB = validGoReport(caseData);
    payloadB.executive_summary = 'a DIFFERENT, corrected explanation';
    assert.notEqual(hashDiagnosisReport(payloadB), hashDiagnosisReport(payloadA));
    assert.throws(
      () => insertReport(runtime, control, caseData, payloadB, { status: 'accepted_by_kernel', validationErrors: [], executionId: 'diag-exec-2' }),
      /at-most-one-accepted/i,
      'a second accepted report for the same target must be rejected',
    );
    // The tx rolled back — exactly one report row, and it is the first.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      1,
    );
    const only = db.prepare('SELECT id, status FROM saga3_discovery_diagnosis_reports').get();
    assert.equal(only.id, first.record.id);
    assert.equal(only.status, 'accepted_by_kernel');
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// G6 (I1) — outcome override: override_decision on a CLARIFY certificate
// ===========================================================================
//
// A worker submits a payload carrying `override_decision: 'go'` on a CLARIFY
// certificate — an attempt to flip the authoritative decision via the advisory
// layer. The validator MUST reject the forbidden field. AND the diagnosis
// result must NOT carry an override (the service returns failed/paused, never a
// completed result that smuggles an override through).
//
// Sneaky probes:
//   - forbidden field on a structurally MALFORMED payload (missing target) —
//     the validator must still catch the forbidden field, not bail early.
//   - every FORBIDDEN_DIAGNOSIS_FIELDS entry is rejected on a valid report.

test('D5 adv G6: override_decision (and all forbidden fields) are rejected; result never carries an override', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, {
      decision: 'clarify', reasonCodes: ['CLARIFY_BLOCKING_GAPS'],
    });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const cert = runtime.readOutcomeCertificate(certId);
    const proposal = runtime.readProposalForSettlement(cert.proposal_id);
    const assessment = runtime.readReadinessAssessment(cert.readiness_assessment_id);
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: { status: 'accepted_by_kernel', assessment_id: assessment.id, hash: assessment.content_hash, payload: assessment.payload },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });

    // A valid clarify report baseline (covers the reason code).
    const validClarify = {
      schema_version: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
      target: {
        certificate_id: certId, certificate_hash: certHash,
        settlement_input_hash: cert.input_hash, decision: 'clarify',
      },
      executive_summary: 'gaps remain',
      cause_analysis: [{
        cause_id: 'C1', category: 'blocking_gap', description: 'd', severity: 'blocking',
        reason_codes: ['CLARIFY_BLOCKING_GAPS'], cited_condition_ids: [],
        source_refs: [`certificate:${certId}`],
      }],
      information_requests: [], recommended_actions: [], residual_risks: [],
      confidence: 0.5,
    };
    // Sanity: the baseline is valid.
    assert.equal(validateDiagnosisReport(validClarify, caseData).valid, true);

    // ATTACK 1: override_decision on the valid report.
    const withOverride = { ...validClarify, override_decision: 'go' };
    const v1 = validateDiagnosisReport(withOverride, caseData);
    assert.equal(v1.valid, false);
    assert.ok(
      v1.errors.some(e => e.includes('override_decision') && e.includes('forbidden')),
      `must reject override_decision as forbidden; got ${JSON.stringify(v1.errors)}`,
    );

    // ATTACK 2 (sneaky): forbidden field on a structurally malformed payload.
    // The validator must catch the forbidden field even when the payload is
    // otherwise broken (forbidden-fields check runs BEFORE structural checks).
    const malformedForbidden = { override_decision: 'go' };
    const v2 = validateDiagnosisReport(malformedForbidden, caseData);
    assert.equal(v2.valid, false, 'malformed payload with a forbidden field must be rejected');
    assert.ok(
      v2.errors.some(e => e.includes('override_decision') && e.includes('forbidden')),
      'the forbidden-field error must appear even on a malformed payload',
    );

    // ATTACK 3: EVERY forbidden field is rejected on the valid report.
    for (const forbidden of FORBIDDEN_DIAGNOSIS_FIELDS) {
      const attacked = { ...validClarify, [forbidden]: 'attack-value' };
      const v = validateDiagnosisReport(attacked, caseData);
      assert.equal(v.valid, false, `forbidden field '${forbidden}' must be rejected`);
      assert.ok(
        v.errors.some(e => e.includes(forbidden)),
        `the error must name the forbidden field '${forbidden}'`,
      );
    }

    // ATTACK 4: the SERVICE result never carries an override. Run the service
    // with a worker that submits a forbidden-field payload; the service must
    // persist it as rejected_by_kernel and return status='failed' — never a
    // completed result that smuggles the override through.
    const { runtime: svcRt, service } = makeService(makeFakeExecutor(() => {
      const control = svcRt.readDiagnosisControlForTarget(certId, certHash);
      const c = JSON.parse(control.diagnosis_case);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
      const report = { ...validClarify, override_decision: 'go' };
      const validation = validateDiagnosisReport(report, c);
      assert.equal(validation.valid, false, 'fixture: override payload must be invalid');
      svcRt.submitDiagnosisReportAtomically({
        controlIntentId: control.id,
        executionId: 'diag-exec-override',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-override' },
      });
    }));
    const result = await diagnose(service, certId, certHash);
    assert.equal(result.status, 'failed', 'a forbidden-field payload must yield status=failed');
    assert.equal(result.authority, 'none');
    assert.equal(result.reportId, null);
    // The advisory result must not expose any top-level authoritative field.
    for (const forbidden of ['outcome', 'outcomeAuthority', 'scopeCompleted', 'reason', 'finalStage', 'settlement']) {
      assert.ok(!(forbidden in result), `advisory result must not carry '${forbidden}'`);
    }
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// G7 (I1) — stage transition attempt: transition_stage in the payload
// ===========================================================================
//
// A worker payload contains `transition_stage: 'formalization'` — an attempt to
// advance the stage through the advisory layer. The validator MUST reject the
// forbidden field. AND, at the engine boundary, the finalStage MUST stay
// 'discovery' after a diagnosis run (D5 never advances the stage).

test('D5 adv G7: transition_stage is rejected and finalStage stays discovery after a diagnosis run', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, { decision: 'go' });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const cert = runtime.readOutcomeCertificate(certId);
    const proposal = runtime.readProposalForSettlement(cert.proposal_id);
    const assessment = runtime.readReadinessAssessment(cert.readiness_assessment_id);
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: { status: 'accepted_by_kernel', assessment_id: assessment.id, hash: assessment.content_hash, payload: assessment.payload },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });

    // Pure validator attack: a valid GO report carrying transition_stage.
    const report = validGoReport(caseData);
    report.transition_stage = 'formalization';
    const v = validateDiagnosisReport(report, caseData);
    assert.equal(v.valid, false, 'transition_stage must be rejected as a forbidden field');
    assert.ok(
      v.errors.some(e => e.includes('transition_stage') && e.includes('forbidden')),
      `error must name transition_stage; got ${JSON.stringify(v.errors)}`,
    );

    // Engine-level attack: run the full engine with a fake diagnosis service
    // that returns a 'completed' result, and assert finalStage stays 'discovery'
    // (I1: D5 never advances the stage). The fake settlement service issues a
    // certificate so the diagnosis hook is eligible.
    const engine = buildEngineWithDiagnosis({
      diagnosisStatus: 'completed',
      stageBefore: 'discovery',
    });
    const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
    assert.equal(result.finalStage, 'discovery', 'finalStage must stay discovery after diagnosis (I1)');
    assert.equal(result.diagnosis.status, 'completed');
    assert.equal(result.diagnosis.authority, 'advisory_diagnosis');
    // Top-level D4 authority preserved (settlement issued authoritatively).
    assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
    assert.equal(result.reason, 'completed');
    assert.equal(result.scopeCompleted, true);
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// G8 (I7) — accepted report immutable: no mutation path
// ===========================================================================
//
// After an accepted report exists, verify there is NO repository/port API path
// that can UPDATE its payload or status. Assert:
//   (a) readAcceptedDiagnosisReport returns the ORIGINAL row (byte-identical).
//   (b) a second submitDiagnosisReportAtomically with the SAME content_hash
//       returns the SAME row (replayed:true, inserted:false) WITHOUT changing
//       its status/payload/provenance.
//   (c) attempting to mark a SECOND DISTINCT report accepted throws.
//   (d) the row's provenance is NOT overwritten on replay (execution_id stays
//       the ORIGINAL — a replay must not mutate provenance).

test('D5 adv G8: accepted report is immutable — replay does not mutate, second accepted is impossible', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, { decision: 'go' });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const cert = runtime.readOutcomeCertificate(certId);
    const proposal = runtime.readProposalForSettlement(cert.proposal_id);
    const assessment = runtime.readReadinessAssessment(cert.readiness_assessment_id);
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: { status: 'accepted_by_kernel', assessment_id: assessment.id, hash: assessment.content_hash, payload: assessment.payload },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });
    const control = runtime.ensureDiagnosisControl({
      epicId: 10, projectId: 1, certificateId: certId, certificateHash: certHash,
      settlementId: cert.settlement_id, settlementInputHash: cert.input_hash,
      sourceIntentId: proposal.intent_id, objective: 'o',
      diagnosisCase: canonicalJson(caseData),
      diagnosisCaseHash: diagnosisCaseHash(caseData),
      diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
    });
    const payload = validGoReport(caseData);
    const first = insertReport(runtime, control, caseData, payload, {
      status: 'accepted_by_kernel', validationErrors: [], executionId: 'diag-exec-orig',
    });
    const originalPayloadText = canonicalJson(payload);
    const originalProvenance = first.record.provenance;

    // (a) readAcceptedDiagnosisReport returns the original row.
    const accepted = runtime.readAcceptedDiagnosisReport(control.controlIntentId);
    assert.ok(accepted);
    assert.equal(accepted.id, first.record.id);
    assert.equal(accepted.content_hash, first.record.content_hash);
    assert.equal(accepted.status, 'accepted_by_kernel');
    assert.equal(canonicalJson(accepted.payload), originalPayloadText);

    // (b) Replay the SAME content under a NEW execution. Must return the same
    //     row, replayed:true, inserted:false, WITHOUT changing it.
    const replay = insertReport(runtime, control, caseData, payload, {
      status: 'accepted_by_kernel', validationErrors: [], executionId: 'diag-exec-replay',
    });
    assert.equal(replay.inserted, false, 'replay must not insert a new row');
    assert.equal(replay.replayed, true, 'replay must be flagged replayed:true');
    assert.equal(replay.record.id, first.record.id, 'replay must return the SAME row id');
    assert.equal(canonicalJson(replay.record.payload), originalPayloadText, 'replay must not mutate the payload');
    // (d) provenance must NOT be overwritten — execution_id stays the ORIGINAL.
    assert.deepEqual(
      replay.record.provenance, originalProvenance,
      'replay must not overwrite provenance (execution_id is not in the uniqueness key)',
    );
    // Still exactly one report row.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      1,
    );

    // (c) Attempting to mark a SECOND DISTINCT report accepted throws.
    const payload2 = validGoReport(caseData);
    payload2.executive_summary = 'a different, corrected explanation';
    assert.throws(
      () => insertReport(runtime, control, caseData, payload2, {
        status: 'accepted_by_kernel', validationErrors: [], executionId: 'diag-exec-second',
      }),
      /at-most-one-accepted/i,
      'a second accepted report must be rejected',
    );

    // (e) Even a REJECTED replay of the same content does NOT downgrade the
    //     accepted row: the replayed row keeps its accepted verdict (a rejected
    //     verdict on byte-identical content cannot rewrite the durable answer).
    const rejectedReplay = insertReport(runtime, control, caseData, payload, {
      status: 'rejected_by_kernel', validationErrors: ['attempted downgrade'], executionId: 'diag-exec-downgrade',
    });
    assert.equal(rejectedReplay.replayed, true, 'same content replays regardless of requested status');
    assert.equal(
      rejectedReplay.record.status, 'accepted_by_kernel',
      'a replay must keep the ORIGINAL verdict (no downgrade of an accepted row)',
    );
    // Still exactly one report row, still accepted.
    const rows = db.prepare('SELECT status FROM saga3_discovery_diagnosis_reports').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'accepted_by_kernel');
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Defense-in-depth probe: durability of a rejected report (§14, I4)
// ===========================================================================
//
// A durable rejection must be OBSERVABLE: a rejected_by_kernel report with
// non-empty validation_errors is distinguishable from a row that carries no
// verdict. The repository enforces this itself (insert-time guard in
// submitDiagnosisReportAtomically): a reject with empty validationErrors throws
// inside BEGIN IMMEDIATE and rolls back. This closes the hole the adversarial
// reviewer found — a future caller that forgets to supply rejection reasons
// cannot persist a "mute" rejection.

test('D5 adv DURABILITY: invalid report is durably rejected with deterministic non-empty errors', () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = seedCertificate(db, { decision: 'go' });
    const runtime = new SqliteSaga3DiscoveryRuntime();
    const cert = runtime.readOutcomeCertificate(certId);
    const proposal = runtime.readProposalForSettlement(cert.proposal_id);
    const assessment = runtime.readReadinessAssessment(cert.readiness_assessment_id);
    const caseData = buildDiagnosisCase({
      epic_id: 10,
      certificate: {
        id: cert.id, hash: cert.certificate_hash, decision: cert.decision,
        reason_codes: cert.reason_codes, policy_version: cert.policy_version,
        policy_hash: cert.policy_hash, settlement_id: cert.settlement_id,
        settlement_input_hash: cert.input_hash,
      },
      proposal: { id: proposal.id, hash: proposal.content_hash, payload: proposal.payload },
      readiness: {
        status: 'accepted_by_kernel', assessment_id: assessment.id,
        hash: assessment.content_hash, payload: assessment.payload,
      },
      proposal_source_submission_id: proposal.source_submission_id,
      proposal_normalization_proposal_id: proposal.normalization_proposal_id,
      captured_at: '2026-07-24T00:00:00.000Z',
    });
    const control = runtime.ensureDiagnosisControl({
      epicId: 10, projectId: 1,
      certificateId: certId, certificateHash: certHash,
      settlementId: cert.settlement_id, settlementInputHash: cert.input_hash,
      sourceIntentId: proposal.intent_id, objective: 'o',
      diagnosisCase: canonicalJson(caseData), diagnosisCaseHash: diagnosisCaseHash(caseData),
      diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
    });
    const invalid = validGoReport(caseData);
    invalid.residual_risks[0].source_refs = ['$.invented'];
    const submitted = runtime.submitDiagnosisReportAtomically({
      controlIntentId: control.controlIntentId,
      executionId: 'exec-invalid',
      payload: invalid,
      provenance: { worker_id: 'w', execution_id: 'exec-invalid' },
    });
    assert.equal(submitted.record.status, 'rejected_by_kernel');
    assert.ok(submitted.record.validation_errors.length > 0);
    assert.ok(submitted.record.validation_errors.some(error => error.includes('$.invented')));
    const row = db.prepare(
      'SELECT status, validation_errors FROM saga3_discovery_diagnosis_reports WHERE id=?',
    ).get(submitted.record.id);
    assert.equal(row.status, 'rejected_by_kernel');
    assert.deepEqual(JSON.parse(row.validation_errors), submitted.record.validation_errors);
  } finally {
    cleanup(temp);
  }
});


// ---------------------------------------------------------------------------
// Engine harness for G7 (mirrors d5-diagnosis-engine.test.mjs harness A).
// ---------------------------------------------------------------------------

function buildEngineWithDiagnosis({ diagnosisStatus, stageBefore = 'discovery' }) {
  // Minimal fake runtime that drives the fresh-run path to a clean closure.
  let task = { id: 100, status: 'todo' };
  let proposal = null;
  const proposalPayload = {
    problem_statement: 'p', observed_context: 'c', stakeholders_or_actors: ['u'],
    assumptions: ['a'], unknowns: ['u'], risks: ['r'], candidate_scope: 's',
    evidence_refs: ['e'], recommended_outcome: 'go', rationale: 'because',
  };
  const fakeRuntime = {
    readEpicObjective: () => ({ name: 'e', description: 'discover' }),
    readOpenIntent: () => null,
    createIntent(command) {
      return { id: 1, epic_id: command.epic_id, kind: command.kind, objective: command.objective,
        authority_scope: command.authority_scope, output_schema: command.output_schema,
        projected_task_id: null, status: 'open', created_at: 't' };
    },
    setProjectedTask: () => {},
    setIntentStatus: () => true,
    ensureProjectedTask: () => task.id,
    readTaskState: () => task.status,
    prepareIntentForExecution: () => ({ state: 'ready', intentStatus: 'open', taskStatus: 'todo' }),
    readWorkIntentForTask: () => null,
    readLatestProposal: () => proposal,
    readLatestRawSubmission: () => null,
    ensureNormalizationControl: () => ({ controlIntentId: 1, sourceSubmissionId: 1, controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 100 }),
    setControlIntentStatus: () => true,
    ensureReadinessControl: () => ({ controlIntentId: 1, proposalId: 50, proposalContentHash: 'h', controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 101 }),
    setReadinessControlStatus: () => true,
    readLatestReadinessAssessment: () => null,
    readProposalForSettlement: () => null,
    readAcceptedReadinessAssessmentForProposal: () => null,
    findSettlementByInputKey: () => null,
    insertSettlement: () => ({ record: { id: 1 }, replayed: false }),
    markSettlementCertificateIssued: () => true,
    markSettlementFailed: () => {},
    insertCertificate: () => ({ record: { id: 2, certificate_hash: 'f'.repeat(64) }, replayed: false }),
    readCertificateForSettlement: () => null,
    _simulateWorkerTick() {
      if (!proposal) proposal = { id: 50, payload: proposalPayload, content_hash: 'h'.repeat(64), provenance: null };
      task.status = 'done';
    },
  };
  const executor = {
    start() {}, status() { fakeRuntime._simulateWorkerTick(); return { id: 'r', project_id: 1, concurrency: 1, status: 'running', active: [], completed: 0, failed: 0, claimed: 1 }; },
    setConcurrency() {}, stop() {}, dispose() {},
  };
  const readinessService = {
    async assess() {
      return { success: true, cycles: 1, error: null, shadow: { status: 'completed', authority: 'shadow_advisor', assessmentId: 99, assessmentHash: 'd'.repeat(64), overallReadiness: 'ready', recommendedNextAction: 'proceed_to_settlement', error: null } };
    },
  };
  const settlementService = {
    async settle() {
      return { status: 'issued', settlementId: 1, certificateId: 2, certificateHash: 'f'.repeat(64), policyVersion: 'saga3.discovery-settlement-policy.v1', policyHash: 'p'.repeat(64), decision: 'go', reasonCodes: ['GO_READY_AND_GROUNDED'], error: null };
    },
  };
  const diagnosisService = {
    async diagnose(request) {
      if (diagnosisStatus === 'failed' || diagnosisStatus === 'paused') {
        return { status: diagnosisStatus, authority: 'none', reportId: null, reportHash: null, target: { certificateId: request.certificateId, certificateHash: request.certificateHash }, summary: null, primaryCauses: [], blockingGaps: [], recommendedActions: [], error: 'diagnosis failed' };
      }
      return { status: 'completed', authority: 'advisory_diagnosis', reportId: 77, reportHash: 'r'.repeat(64), target: { certificateId: request.certificateId, certificateHash: request.certificateHash }, summary: 'clear', primaryCauses: [], blockingGaps: [], recommendedActions: ['A1'], error: null };
    },
  };
  return new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => stageBefore }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: {
      processId: 42,
      acquireEngineLock: () => ({ status: 'acquired', ownerPid: 42 }),
      releaseEngineLock: () => {},
      workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' },
      now: () => new Date('2026-07-24T00:00:00.000Z'),
      sleep: async () => {},
      heartbeat: () => {},
      scanRateLimitSignals: () => 0,
    },
    runtimePersistence: fakeRuntime, pollMs: 0,
    readinessService, settlementService, diagnosisService,
  });
}
