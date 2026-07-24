/**
 * D5 — Advisory Discovery Diagnosis SERVICE tests (matrix E1–E8).
 *
 * Runs the REAL Saga3DiscoveryDiagnosisService over a real better-sqlite3
 * temp-file DB, with a fake worker executor that flips the diagnosis task to
 * 'done' and inserts a report via the port (mirroring what diagnosis_submit
 * persists). The fixture seeds the full D4 FK chain
 * (projects → epics → episode_workflows → tasks → work_intents → proposals →
 * settlement → certificate) exactly as d4-settlement-recovery.test.mjs does,
 * then adds the readiness control + accepted assessment the snapshot embeds.
 *
 * Coverage (D5-TEST-MATRIX §E):
 *   E1 — exact certificate load + lineage verification
 *   E2 — accepted report exists ⇒ reuse (no worker spawned)
 *   E3 — resumable control ⇒ resume (paused control with no accepted report)
 *   E4 — invalid report durable rejected (invented source ref)
 *   E5 — worker throws ⇒ service returns failed; D4 rows untouched
 *   E6 — wrong certificate target in report ⇒ rejected
 *   E7 — service writes ONLY diagnosis tables (snapshot diff)
 *   E8 — result shape is advisory only (authority never kernel_policy)
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
const { DISCOVERY_DIAGNOSIS_REPORT_SCHEMA } = await import(
  '../../dist/saga3/domain/discovery-diagnosis-report.js'
);
const { validateDiagnosisReport } = await import(
  '../../dist/saga3/domain/discovery-diagnosis-validator.js'
);
const { buildDiagnosisCase, diagnosisCaseHash } = await import(
  '../../dist/saga3/domain/discovery-diagnosis-case.js'
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

// ---------------------------------------------------------------------------
// Fixture scaffolding (mirrors d4-settlement-recovery.test.mjs)
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

/** The canonical settlement input snapshot the D4 service would have built. */
function buildSettlementSnapshot() {
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
    policy: {
      version: 'saga3.settlement-policy.v1',
      content_hash: 'p'.repeat(64),
    },
    captured_at: '2026-07-24T00:00:00.000Z',
  };
}

const SETTLEMENT_SNAPSHOT = buildSettlementSnapshot();
const SETTLEMENT_INPUT_HASH = createHash('sha256').update(canonicalJson(SETTLEMENT_SNAPSHOT)).digest('hex');
const POLICY_HASH = 'p'.repeat(64);

/**
 * Seed the full D4 FK chain + the readiness control + accepted assessment.
 * Produces ONE settlement (id 1) + ONE outcome certificate (id 1, decision go).
 * Mirrors d4-settlement-recovery.test.mjs buildLiveFixture, but also inserts
 * the settlement + certificate rows so the diagnosis service has a target.
 */
async function buildLiveFixture(db) {
  ensureSaga3ReadinessSchema(db);
  ensureSaga3SettlementSchema(db);
  ensureSaga3DiagnosisSchema(db);

  // Product task + WorkIntent + Proposal.
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'Discovery','done','discovery.work')`,
  ).run();
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (1,10,?,?,?,?,0,0,100,'concluded')`,
  ).run(DISCOVERY_INTENT_KIND, 'discover', '{}', DISCOVERY_WORK_INTENT_SCHEMA);
  db.prepare(
    `INSERT INTO saga3_proposals
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
    `INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (200,10,'Assess','done','discovery.assess')`,
  ).run();
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,
        token_budget,retry_budget,projected_task_id,status)
     VALUES (2,10,?,?,?,?,0,0,200,'concluded')`,
  ).run(DISCOVERY_READINESS_INTENT_KIND, 'assess', '{}', DISCOVERY_READINESS_ASSESSMENT_SCHEMA);
  db.prepare(
    `INSERT INTO saga3_readiness_control_intents
       (id,epic_id,kind,proposal_id,proposal_content_hash,source_intent_id,
        authority_intent_id,projected_task_id,status)
     VALUES (1,10,'AssessDiscoveryReadiness',?,?,?,?,?, 'concluded')`,
  ).run(50, PRODUCT_PROPOSAL_HASH, 1, 2, 200);
  db.prepare(
    `INSERT INTO saga3_readiness_assessments
       (id,control_intent_id,proposal_id,proposal_content_hash,task_id,execution_id,
        payload,content_hash,status,overall_readiness,recommended_next_action,
        validation_errors,provenance)
     VALUES (7,1,50,?,200,'advisor-exec',?,?, 'accepted_by_kernel','ready','proceed_to_settlement','[]','{}')`,
  ).run(PRODUCT_PROPOSAL_HASH, canonicalJson(ASSESSMENT_PAYLOAD), ASSESSMENT_HASH);

  // Issue the authoritative D4 target through the real settlement service.
  const settlementService = new Saga3DiscoverySettlementService({
    runtimePersistence: new SqliteSaga3DiscoveryRuntime(),
  });
  const result = await settlementService.settle({
    projectId: 1,
    epicId: 10,
    proposalId: 50,
    proposalHash: PRODUCT_PROPOSAL_HASH,
    readiness: {
      status: 'completed',
      authority: 'shadow_advisor',
      assessmentId: 7,
      assessmentHash: ASSESSMENT_HASH,
      overallReadiness: 'ready',
      recommendedNextAction: 'proceed_to_settlement',
      error: null,
    },
  });
  assert.equal(result.status, 'issued');
  return { certId: result.certificateId, certHash: result.certificateHash };

}

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d5-svc-'));
  process.env.DB_PATH = path.join(temp, 'd5svc.db');
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
 * Build a fake WorkerExecutor. `onFirstPoll` runs once on the first status()
 * call: typically flips the diagnosis task to 'done' and inserts a report via
 * the runtime port (mirroring what diagnosis_submit persists). After that the
 * executor reports a completed run with no active workers, so the service's
 * terminal-detection loop sees task=done && !active → clean.
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

/** A valid GO diagnosis report for the case the service builds. */
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

/** The canonical diagnose() call. */
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

/** Snapshot the D4 authoritative tables for E5/E7 (no-change assertions). */
function snapshotD4(db) {
  const tables = [
    'saga3_proposals',
    'saga3_readiness_assessments',
    'saga3_discovery_settlements',
    'saga3_discovery_outcome_certificates',
  ];
  const snap = {};
  for (const t of tables) {
    snap[t] = JSON.stringify(
      db.prepare(`SELECT * FROM ${t} ORDER BY id`).all(),
    );
  }
  return snap;
}

function assertD4Unchanged(db, before, label) {
  const after = snapshotD4(db);
  for (const t of Object.keys(before)) {
    assert.equal(after[t], before[t], `${label}: D4 table ${t} must not change`);
  }
}

// ---------------------------------------------------------------------------
// E1 — exact certificate load + lineage verification
// ---------------------------------------------------------------------------

test('D5 service: loads and verifies certificate lineage', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    // The worker submits a valid report; the service must load the cert by id,
    // verify hash + settlement + snapshot lineage, build the case, run the
    // worker, and project a completed advisory result.
    const { runtime, service } = makeService(makeFakeExecutor(() => {
      // Simulate the worker: flip the diagnosis task to done + insert a valid
      // report. First ensure the control exists by calling diagnose up to the
      // worker phase — but the executor runs AFTER ensureDiagnosisControl, so
      // the control row + task already exist. We read the frozen case from the
      // control row to build a report that cites valid source refs.
      const control = runtime.readDiagnosisControlForTarget(certId, certHash);
      assert.ok(control, 'control must exist before the worker poll fires');
      const caseData = JSON.parse(control.diagnosis_case);
      // Flip the diagnosis task to done.
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
      // Insert a valid accepted report via the port (what diagnosis_submit does).
      const report = validGoReport(caseData);
      const validation = validateDiagnosisReport(report, caseData);
      assert.equal(validation.valid, true, `fixture report must be valid: ${validation.errors.join('; ')}`);
      runtime.submitDiagnosisReportAtomically({
        controlIntentId: control.id,
        executionId: 'diag-exec-1',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-1' },
      });
    }));
    const result = await diagnose(service, certId, certHash);
    assert.equal(result.status, 'completed');
    assert.equal(result.authority, 'advisory_diagnosis');
    assert.equal(result.target.certificateId, certId);
    assert.equal(result.target.certificateHash, certHash);
    assert.ok(result.reportId > 0);
    assert.ok(result.reportHash);
    assert.equal(result.error, null);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// E2 — accepted report exists ⇒ reuse (no worker spawned)
// ---------------------------------------------------------------------------

test('D5 service: accepted report reused', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    let spawnCount = 0;
    const executor = makeFakeExecutor(() => {
      spawnCount++;
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
    const { runtime, service } = makeService(executor);
    const first = await diagnose(service, certId, certHash);
    assert.equal(first.status, 'completed');
    assert.equal(spawnCount, 1);
    const firstReportId = first.reportId;
    const firstReportHash = first.reportHash;

    // Second diagnose: an accepted report already exists → NO worker spawn,
    // SAME reportId/reportHash returned (invariant I7).
    const second = await diagnose(service, certId, certHash);
    assert.equal(second.status, 'completed');
    assert.equal(second.reportId, firstReportId, 'restart must reuse the same reportId');
    assert.equal(second.reportHash, firstReportHash, 'restart must reuse the same reportHash');
    assert.equal(spawnCount, 1, 'no second worker spawn when an accepted report exists');
    // Exactly one report row.
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      1,
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// E3 — resumable control ⇒ resume (paused control, no accepted report)
// ---------------------------------------------------------------------------

test('D5 service: resumable control resumed', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    // Seed a pre-existing diagnosis control in 'paused' state with NO accepted
    // report (simulating a prior interrupted run). The service must RESUME it
    // (same ControlIntent, same task) rather than creating a new one.
    const control = runtime_readOrCreateControl(db, certId, certHash);
    let spawnCount = 0;
    const { runtime, service } = makeService(makeFakeExecutor(() => {
      spawnCount++;
      const c = runtime.readDiagnosisControlForTarget(certId, certHash);
      const caseData = JSON.parse(c.diagnosis_case);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', c.projected_task_id);
      const report = validGoReport(caseData);
      runtime.submitDiagnosisReportAtomically({
        controlIntentId: c.id,
        executionId: 'diag-exec-resume',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-resume' },
      });
    }));
    const result = await diagnose(service, certId, certHash);
    assert.equal(result.status, 'completed');
    // The service reused the SAME control (did not create a second one).
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_control_intents').get().c,
      1,
      'resumable control must be reused, not duplicated',
    );
    assert.equal(spawnCount, 1);
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// E4 — invalid report durable rejected (invented source ref)
// ---------------------------------------------------------------------------

test('D5 service: invalid report durable rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    const { runtime, service } = makeService(makeFakeExecutor(() => {
      const control = runtime.readDiagnosisControlForTarget(certId, certHash);
      const caseData = JSON.parse(control.diagnosis_case);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
      // Build a report that cites an INVENTED source ref (not in the allowlist).
      const report = validGoReport(caseData);
      report.recommended_actions[0].source_refs = ['$.invented_field_not_in_allowlist'];
      // The worker would have called diagnosis_submit, which runs the validator
      // and persists rejected_by_kernel. We simulate that here.
      const validation = validateDiagnosisReport(report, caseData);
      assert.equal(validation.valid, false, 'fixture: invented source ref must be invalid');
      runtime.submitDiagnosisReportAtomically({
        controlIntentId: control.id,
        executionId: 'diag-exec-reject',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-reject' },
      });
    }));
    const before = snapshotD4(db);
    const result = await diagnose(service, certId, certHash);
    // The report was rejected → diagnosis failed (advisory; D4 untouched).
    assert.equal(result.status, 'failed');
    assert.equal(result.authority, 'none');
    assert.ok(result.error, 'failed result must carry an error');
    assert.equal(result.reportId, null);
    // The rejected report is DURABLE — it survives for audit with non-empty
    // validation_errors.
    const row = db.prepare(
      `SELECT status, validation_errors FROM saga3_discovery_diagnosis_reports WHERE control_intent_id=?`,
    ).get(runtime.readDiagnosisControlForTarget(certId, certHash).id);
    assert.equal(row.status, 'rejected_by_kernel');
    const errors = JSON.parse(row.validation_errors);
    assert.ok(errors.length > 0, 'rejected report must carry non-empty validation_errors');
    assert.ok(errors.some(e => e.includes('invented_field_not_in_allowlist')),
      `validation_errors must mention the invented ref; got ${JSON.stringify(errors)}`);
    // D4 rows untouched (invariant I5).
    assertD4Unchanged(db, before, 'E4');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// E5 — worker throws ⇒ service returns failed; D4 rows untouched
// ---------------------------------------------------------------------------

test('D5 service: worker throw isolated', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    const before = snapshotD4(db);
    // A fake executor whose status() throws — simulates a worker-substrate
    // crash. The service must catch it and return status='failed' without
    // touching D4 rows.
    const crashingExecutor = {
      start() {},
      status() { throw new Error('worker substrate crashed'); },
      setConcurrency() {},
      stop() {},
      dispose() {},
    };
    const { service } = makeService(crashingExecutor);
    const result = await diagnose(service, certId, certHash);
    assert.equal(result.status, 'failed');
    assert.equal(result.authority, 'none');
    assert.ok(result.error.includes('crashed'), `error must surface the crash; got '${result.error}'`);
    // D4 rows untouched (invariant I5).
    assertD4Unchanged(db, before, 'E5');
    // No diagnosis report accepted.
    const control = db.prepare(
      `SELECT id FROM saga3_discovery_diagnosis_control_intents WHERE certificate_id=?`,
    ).get(certId);
    if (control) {
      const accepted = db.prepare(
        `SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports WHERE control_intent_id=? AND status='accepted_by_kernel'`,
      ).get(control.id).c;
      assert.equal(accepted, 0, 'no accepted report after a worker crash');
    }
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// E6 — wrong certificate target in report ⇒ rejected
// ---------------------------------------------------------------------------

test('D5 service: wrong target rejected', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    const { runtime, service } = makeService(makeFakeExecutor(() => {
      const control = runtime.readDiagnosisControlForTarget(certId, certHash);
      const caseData = JSON.parse(control.diagnosis_case);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
      // Build a report that targets a DIFFERENT certificate_id than the control.
      const report = validGoReport(caseData);
      report.target.certificate_id = 9999;
      report.target.certificate_hash = '0'.repeat(64);
      const validation = validateDiagnosisReport(report, caseData);
      assert.equal(validation.valid, false, 'fixture: wrong target must be invalid');
      runtime.submitDiagnosisReportAtomically({
        controlIntentId: control.id,
        executionId: 'diag-exec-wrong-target',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-wrong-target' },
      });
    }));
    const result = await diagnose(service, certId, certHash);
    assert.equal(result.status, 'failed');
    assert.equal(result.authority, 'none');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// E7 — service writes ONLY diagnosis tables (snapshot diff)
// ---------------------------------------------------------------------------

test('D5 service: only diagnosis tables written', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    const before = snapshotD4(db);
    const { runtime, service } = makeService(makeFakeExecutor(() => {
      const control = runtime.readDiagnosisControlForTarget(certId, certHash);
      const caseData = JSON.parse(control.diagnosis_case);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
      const report = validGoReport(caseData);
      runtime.submitDiagnosisReportAtomically({
        controlIntentId: control.id,
        executionId: 'diag-exec-e7',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-e7' },
      });
    }));
    const result = await diagnose(service, certId, certHash);
    assert.equal(result.status, 'completed');
    // After a successful diagnose(), NO D4 row changed (invariant I6).
    assertD4Unchanged(db, before, 'E7');
    // The diagnosis tables DID get written.
    assert.ok(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_control_intents').get().c >= 1,
      'diagnosis control must be written',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM saga3_discovery_diagnosis_reports').get().c,
      1,
      'exactly one diagnosis report row',
    );
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// E8 — result shape is advisory only (authority never kernel_policy)
// ---------------------------------------------------------------------------

test('D5 service: result shape is advisory only', async () => {
  const { temp, db } = fixture();
  try {
    const { certId, certHash } = await buildLiveFixture(db);
    const { runtime, service } = makeService(makeFakeExecutor(() => {
      const control = runtime.readDiagnosisControlForTarget(certId, certHash);
      const caseData = JSON.parse(control.diagnosis_case);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done', control.projected_task_id);
      const report = validGoReport(caseData);
      runtime.submitDiagnosisReportAtomically({
        controlIntentId: control.id,
        executionId: 'diag-exec-e8',
        payload: report,
        provenance: { worker_id: 'diag-worker', execution_id: 'diag-exec-e8' },
      });
    }));

    // Completed result: authority must be advisory_diagnosis, NEVER kernel_policy
    // or discovery_settlement_policy (invariant I2). The result must NOT carry
    // any field the engine could mistake for an outcome override (no outcome,
    // no scopeCompleted, no reason, no finalStage, no settlement section).
    const completed = await diagnose(service, certId, certHash);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.authority, 'advisory_diagnosis');
    assert.notEqual(completed.authority, 'kernel_policy');
    assert.notEqual(completed.authority, 'discovery_settlement_policy');
    // No authoritative top-level fields present on the advisory result.
    for (const forbidden of ['outcome', 'outcomeAuthority', 'scopeCompleted', 'reason', 'finalStage', 'settlement']) {
      assert.ok(!(forbidden in completed), `advisory result must not carry '${forbidden}'`);
    }

    // Failed result: a stale target is rejected as advisory failure. Authority
    // remains none and no authoritative field is surfaced.
    const { service: failService } = makeService({
      start() {}, status() { throw new Error('must not spawn for stale target'); },
      setConcurrency() {}, stop() {}, dispose() {},
    });
    const failed = await diagnose(failService, certId, '0'.repeat(64));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.authority, 'none');
    assert.notEqual(failed.authority, 'kernel_policy');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// Helper: pre-seed a paused diagnosis control (for E3) by invoking the real
// ensureDiagnosisControl port once, then forcing the row to 'paused' + the
// task to 'todo' (so prepareIntentForExecution returns 'ready').
// ---------------------------------------------------------------------------

function runtime_readOrCreateControl(db, certId, certHash) {
  const runtime = new SqliteSaga3DiscoveryRuntime();
  const cert = runtime.readOutcomeCertificate(certId);
  const settlement = runtime.readSettlement(cert.settlement_id);
  const proposal = runtime.readProposalForSettlement(settlement.proposal_id);
  const assessment = runtime.readReadinessAssessment(settlement.readiness_assessment_id);
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
  const caseHash = diagnosisCaseHash(caseData)
  const control = runtime.ensureDiagnosisControl({
    epicId: 10, projectId: 1, certificateId: certId, certificateHash: certHash,
    settlementId: settlement.id, settlementInputHash: settlement.input_hash,
    sourceIntentId: proposal.intent_id,
    objective: 'pre-seeded paused control',
    diagnosisCase: canonicalJson(caseData),
    diagnosisCaseHash: caseHash,
    diagnosisContractVersion: 'saga3.discovery-diagnosis.v1',
  });
  // Force the control + authority into a 'paused' state with the task in
  // 'todo', so a later diagnose() call resumes (not restart-done).
  db.prepare('UPDATE saga3_discovery_diagnosis_control_intents SET status=? WHERE id=?')
    .run('paused', control.controlIntentId);
  db.prepare('UPDATE saga3_work_intents SET status=? WHERE id=?')
    .run('paused', control.authorityIntentId);
  db.prepare('UPDATE tasks SET status=? WHERE id=?')
    .run('todo', control.taskId);
  return control;
}
