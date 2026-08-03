/** D5 correction integrity matrix: frozen-case, lineage and accepted-report attacks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { canonicalJson } = await import('../../dist/shared/canonical-json.js');
const { READINESS_DIMENSIONS } = await import('../../dist/modules/discovery/domain/discovery-readiness-assessment.js');
const {
  buildDiagnosisCase,
  diagnosisCaseHash,
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
} = await import('../../dist/saga3/domain/discovery-diagnosis-case.js');
const {
  DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
  hashDiagnosisReport,
} = await import('../../dist/saga3/domain/discovery-diagnosis-report.js');
const { ensureSaga3SettlementSchema } = await import('../../dist/modules/discovery/infrastructure/saga3-settlement-repository.js');
const { ensureSaga3DiagnosisSchema } = await import('../../dist/saga3/persistence/saga3-diagnosis-repository.js');
const { SqliteSaga3DiscoveryRuntime } = await import('../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js');
const { verifyAcceptedDiagnosisReport } = await import('../../dist/saga3/application/discovery-diagnosis-service.js');

const PROPOSAL = {
  problem_statement: 'p', observed_context: 'o', stakeholders_or_actors: ['s'],
  assumptions: ['a'], unknowns: ['u'], risks: ['r'], candidate_scope: 'scope',
  evidence_refs: ['artifact:e'], recommended_outcome: 'go', rationale: 'r',
};
const PROPOSAL_HASH = createHash('sha256').update(canonicalJson(PROPOSAL)).digest('hex');
const dimensions = Object.fromEntries(READINESS_DIMENSIONS.map(dimension => [dimension, {
  status: 'sufficient', rationale: 'grounded', source_refs: ['$.problem_statement'],
}]));
const ASSESSMENT = {
  proposal_id: 50, proposal_content_hash: PROPOSAL_HASH,
  overall_readiness: 'ready', dimension_assessments: dimensions,
  blocking_gaps: [], non_blocking_gaps: [],
  recommended_next_action: 'proceed_to_settlement', confidence: 0.9, rationale: 'ready',
};
const ASSESSMENT_HASH = createHash('sha256').update(canonicalJson(ASSESSMENT)).digest('hex');
const CERT_HASH = 'c'.repeat(64);
const INPUT_HASH = 'i'.repeat(64);

function caseData() {
  return buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 1, hash: CERT_HASH, decision: 'go', reason_codes: ['GO_READY_AND_GROUNDED'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 1, settlement_input_hash: INPUT_HASH,
    },
    proposal: { id: 50, hash: PROPOSAL_HASH, payload: PROPOSAL },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: ASSESSMENT_HASH, payload: ASSESSMENT },
    proposal_source_submission_id: null,
    proposal_normalization_proposal_id: null,
    captured_at: '2026-07-24T00:00:00.000Z',
  });
}

function validReport(c = caseData()) {
  return {
    schema_version: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
    target: {
      certificate_id: c.certificate.id,
      certificate_hash: c.certificate.hash,
      settlement_input_hash: c.certificate.settlement_input_hash,
      decision: 'go',
    },
    executive_summary: 'All GO conditions hold.',
    cause_analysis: [], information_requests: [],
    recommended_actions: [{
      action_id: 'A1', action: 'proceed_with_monitoring', description: 'Proceed and monitor.',
      resolves_cause_ids: [], source_refs: ['certificate:1'],
    }],
    residual_risks: [{ risk: 'timing', source_refs: ['$.observed_context'] }],
    confidence: 0.9,
  };
}

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d5-integrity-'));
  process.env.DB_PATH = path.join(temp, 'integrity.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  ensureSaga3SettlementSchema(db);
  ensureSaga3DiagnosisSchema(db);
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO saga3_discovery_settlements
       (id,epic_id,proposal_id,proposal_content_hash,readiness_assessment_id,readiness_assessment_hash,
        policy_version,policy_hash,input_snapshot,input_hash,decision,reason_codes,rationale,status)
     VALUES (1,10,50,?,7,?,'v','p','{}',?,'go','["GO_READY_AND_GROUNDED"]','r','certificate_issued')`,
  ).run(PROPOSAL_HASH, `accepted:${ASSESSMENT_HASH}`, INPUT_HASH);
  db.prepare(
    `INSERT INTO saga3_discovery_outcome_certificates
       (id,settlement_id,epic_id,proposal_id,proposal_content_hash,readiness_assessment_id,
        readiness_assessment_hash,policy_version,policy_hash,decision,reason_codes,input_hash,
        certificate_payload,certificate_hash,issued_at)
     VALUES (1,1,10,50,?,7,?,'v','p','go','["GO_READY_AND_GROUNDED"]',?,'{}',?,'t')`,
  ).run(PROPOSAL_HASH, `accepted:${ASSESSMENT_HASH}`, INPUT_HASH, CERT_HASH);
  db.pragma('foreign_keys = ON');
  const runtime = new SqliteSaga3DiscoveryRuntime();
  const c = caseData();
  const input = {
    epicId: 10, projectId: 1, certificateId: 1, certificateHash: CERT_HASH,
    settlementId: 1, settlementInputHash: INPUT_HASH, sourceIntentId: 1, objective: 'o',
    diagnosisCase: canonicalJson(c), diagnosisCaseHash: diagnosisCaseHash(c),
    diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  };
  const control = runtime.ensureDiagnosisControl(input);
  return { temp, db, runtime, c, input, control };
}
function cleanup(temp) { closeDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.DB_PATH; }
function submit(runtime, control, payload = validReport()) {
  return runtime.submitDiagnosisReportAtomically({
    controlIntentId: control.controlIntentId,
    executionId: 'integrity-exec', payload,
    provenance: { worker_id: 'w', execution_id: 'integrity-exec' },
  });
}

test('D5 integrity: case tamper with unchanged hash is rejected inside atomic submit', () => {
  const { temp, db, runtime, control } = fixture();
  try {
    const stored = JSON.parse(db.prepare('SELECT diagnosis_case FROM saga3_discovery_diagnosis_control_intents WHERE id=?').get(control.controlIntentId).diagnosis_case);
    stored.allowed_source_refs.push('$.invented');
    db.prepare('UPDATE saga3_discovery_diagnosis_control_intents SET diagnosis_case=? WHERE id=?')
      .run(canonicalJson(stored), control.controlIntentId);
    assert.throws(() => submit(runtime, control), /diagnosis_case_hash does not match.*tampered case/i);
  } finally { cleanup(temp); }
});

test('D5 integrity: coherent case+hash allowlist expansion is rejected by independent task anchor', () => {
  const { temp, db, runtime, control } = fixture();
  try {
    const stored = JSON.parse(db.prepare('SELECT diagnosis_case FROM saga3_discovery_diagnosis_control_intents WHERE id=?').get(control.controlIntentId).diagnosis_case);
    stored.allowed_source_refs.push('$.invented');
    const newHash = diagnosisCaseHash(stored);
    db.prepare('UPDATE saga3_discovery_diagnosis_control_intents SET diagnosis_case=?, diagnosis_case_hash=? WHERE id=?')
      .run(canonicalJson(stored), newHash, control.controlIntentId);
    assert.throws(() => submit(runtime, control), /metadata\.diagnosis_case_hash/i);
  } finally { cleanup(temp); }
});

test('D5 integrity: ensure-control reuse rejects coherent stored-case drift from freshly rebuilt bundle case', () => {
  const { temp, db, runtime, input, control } = fixture();
  try {
    const stored = JSON.parse(db.prepare('SELECT diagnosis_case FROM saga3_discovery_diagnosis_control_intents WHERE id=?').get(control.controlIntentId).diagnosis_case);
    stored.allowed_source_refs.push('$.invented');
    db.prepare('UPDATE saga3_discovery_diagnosis_control_intents SET diagnosis_case=?, diagnosis_case_hash=? WHERE id=?')
      .run(canonicalJson(stored), diagnosisCaseHash(stored), control.controlIntentId);
    assert.throws(() => runtime.ensureDiagnosisControl(input), /diagnosis_case_hash .* != expected/i);
  } finally { cleanup(temp); }
});

test('D5 integrity: contract, task, authority and control lifecycle drift fail closed', () => {
  const attacks = [
    ['contract', db => db.prepare('UPDATE saga3_discovery_diagnosis_control_intents SET diagnosis_contract_version=? WHERE id=1').run('v2'), /diagnosis_contract_version|contract version/i],
    ['task metadata', db => db.prepare("UPDATE tasks SET metadata=json_set(metadata,'$.certificate_hash','evil') WHERE task_kind='discovery.diagnose'").run(), /metadata\.certificate_hash/i],
    ['authority kind', db => db.prepare("UPDATE saga3_work_intents SET kind='evil' WHERE kind='discovery.diagnose'").run(), /authority WorkIntent .* kind/i],
    ['authority task', db => db.prepare("UPDATE saga3_work_intents SET projected_task_id=NULL WHERE kind='discovery.diagnose'").run(), /projected_task_id/i],
    ['control status', db => db.prepare("UPDATE saga3_discovery_diagnosis_control_intents SET status='concluded' WHERE id=1").run(), /status 'concluded' is not active/i],
  ];
  for (const [name, attack, pattern] of attacks) {
    const { temp, db, runtime, control } = fixture();
    try {
      attack(db);
      assert.throws(() => submit(runtime, control), pattern, name);
    } finally { cleanup(temp); }
  }
});

test('D5 integrity: accepted-report verifier rejects schema/control/task/target and coherent payload+hash drift', () => {
  const c = caseData();
  const payload = validReport(c);
  const control = {
    controlIntentId: 11, certificateId: 1, certificateHash: CERT_HASH,
    settlementInputHash: INPUT_HASH, controlStatus: 'executing',
    authorityIntentId: 12, authorityIntentStatus: 'executing', taskId: 13,
    diagnosisCase: canonicalJson(c), diagnosisCaseHash: diagnosisCaseHash(c),
  };
  const base = {
    id: 21, control_intent_id: 11, certificate_id: 1, certificate_hash: CERT_HASH,
    task_id: 13, execution_id: 'x', schema_version: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
    payload, content_hash: hashDiagnosisReport(payload), status: 'accepted_by_kernel',
    validation_errors: [], provenance: {}, created_at: 't',
  };
  verifyAcceptedDiagnosisReport(base, c, control);
  const attacks = [
    ['control', { control_intent_id: 99 }, /control_intent_id/],
    ['schema', { schema_version: 'wrong' }, /schema_version/],
    ['task', { task_id: 99 }, /task_id/],
    ['status', { status: 'rejected_by_kernel' }, /status/],
    ['errors', { validation_errors: ['x'] }, /non-empty validation_errors/],
  ];
  for (const [name, patch, pattern] of attacks) {
    assert.throws(() => verifyAcceptedDiagnosisReport({ ...base, ...patch }, c, control), pattern, name);
  }
  const wrongTargetPayload = structuredClone(payload);
  wrongTargetPayload.target.certificate_id = 99;
  assert.throws(
    () => verifyAcceptedDiagnosisReport({ ...base, payload: wrongTargetPayload, content_hash: hashDiagnosisReport(wrongTargetPayload) }, c, control),
    /target\.certificate_id|failed re-validation/,
  );
  const coherentInvalid = structuredClone(payload);
  coherentInvalid.residual_risks[0].source_refs = ['$.invented'];
  assert.throws(
    () => verifyAcceptedDiagnosisReport({ ...base, payload: coherentInvalid, content_hash: hashDiagnosisReport(coherentInvalid) }, c, control),
    /failed re-validation.*invented/i,
  );
});
