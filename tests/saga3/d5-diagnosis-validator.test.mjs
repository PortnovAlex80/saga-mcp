/**
 * D5 — diagnosis validator unit tests (matrix B1–B15).
 *
 * Pure: no SQLite, no engine, no workers. Each test builds a minimal valid
 * report payload + case, then mutates one aspect and asserts the validator
 * accepts/rejects. Covers target binding, forbidden fields, reason coverage,
 * condition coverage, source refs, internal refs, outcome consistency,
 * confidence, and duplicate ids (§8).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnosisCase,
} from '../../dist/saga3/domain/discovery-diagnosis-case.js';
import { validateDiagnosisReport } from '../../dist/saga3/domain/discovery-diagnosis-validator.js';
import { READINESS_DIMENSIONS } from '../../dist/saga3/domain/discovery-readiness-assessment.js';

// ---- fixtures --------------------------------------------------------------

function dim(status) {
  return { status, rationale: 'r', source_refs: ['$.problem_statement'] };
}

function readyAssessment(overrides = {}) {
  const dimension_assessments = {};
  for (const d of READINESS_DIMENSIONS) dimension_assessments[d] = dim('sufficient');
  return {
    proposal_id: 1,
    proposal_content_hash: 'a'.repeat(64),
    overall_readiness: 'ready',
    dimension_assessments,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'advisor rationale',
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    problem_statement: 'p',
    observed_context: 'o',
    stakeholders_or_actors: ['s'],
    assumptions: ['a'],
    unknowns: ['u'],
    risks: ['r'],
    candidate_scope: 'scope',
    evidence_refs: ['evidence:e1'],
    recommended_outcome: 'go',
    rationale: 'rationale',
    ...overrides,
  };
}

function goCase() {
  return buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 100, hash: 'c'.repeat(64), decision: 'go',
      reason_codes: ['GO_READY_AND_GROUNDED'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 50, settlement_input_hash: 'i'.repeat(64),
    },
    proposal: { id: 1, hash: 'a'.repeat(64), payload: proposal() },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: 'b'.repeat(64), payload: readyAssessment() },
    proposal_source_submission_id: null,
    proposal_normalization_proposal_id: null,
  });
}

/** A valid GO report for goCase(). */
function validGoReport(caseData) {
  return {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: {
      certificate_id: caseData.certificate.id,
      certificate_hash: caseData.certificate.hash,
      settlement_input_hash: caseData.certificate.settlement_input_hash,
      decision: 'go',
    },
    executive_summary: 'All GO conditions met.',
    cause_analysis: [],
    information_requests: [],
    recommended_actions: [{
      action_id: 'A1',
      action: 'proceed_with_monitoring',
      description: 'Proceed, monitor residual risks.',
      resolves_cause_ids: [],
      source_refs: ['certificate:100'],
    }],
    residual_risks: [{
      risk: 'Market timing',
      source_refs: ['$.observed_context'],
    }],
    confidence: 0.85,
  };
}

function validReportAccepts(caseData, report) {
  const result = validateDiagnosisReport(report, caseData);
  assert.equal(result.valid, true, `expected valid, got errors: ${result.errors.join('; ')}`);
}

// ---- B1: exact target accepted --------------------------------------------

test('D5 validator: exact target accepted', () => {
  const c = goCase();
  validReportAccepts(c, validGoReport(c));
});

// ---- B2: wrong certificate_id ---------------------------------------------

test('D5 validator: wrong certificate id rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  r.target.certificate_id = 999;
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('target.certificate_id')));
});

// ---- B3: wrong certificate_hash -------------------------------------------

test('D5 validator: wrong certificate hash rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  r.target.certificate_hash = 'x'.repeat(64);
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('target.certificate_hash')));
});

// ---- B4: unknown reason code ----------------------------------------------

test('D5 validator: unknown reason code rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  // Add a cause citing a code the certificate does not carry.
  r.cause_analysis = [{
    cause_id: 'C1', category: 'policy_condition', description: 'd',
    severity: 'informational', reason_codes: ['BOGUS_CODE'],
    failed_condition_ids: [], source_refs: ['certificate:100'],
  }];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("'BOGUS_CODE' not carried")));
});

// ---- B5: missing reason coverage ------------------------------------------

test('D5 validator: missing reason coverage rejected', () => {
  // Build a clarify case (certificate carries a clarify code) and a report
  // that covers NONE of the certificate reason codes.
  const c = buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 100, hash: 'c'.repeat(64), decision: 'clarify',
      reason_codes: ['CLARIFY_BLOCKING_GAPS'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 50, settlement_input_hash: 'i'.repeat(64),
    },
    proposal: { id: 1, hash: 'a'.repeat(64), payload: proposal() },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: 'b'.repeat(64),
      payload: readyAssessment({ blocking_gaps: [{ code: 'G1', description: 'gap', source_refs: ['$.problem_statement'] }] }) },
  });
  const r = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'clarify' },
    executive_summary: 's',
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'd',
      severity: 'blocking', reason_codes: [], // covers no code
      failed_condition_ids: ['no_blocking_gaps'], source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.5,
  };
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("'CLARIFY_BLOCKING_GAPS' is not covered")));
});

// ---- B6: invented source ref ----------------------------------------------

test('D5 validator: invented source ref rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  r.residual_risks[0].source_refs = ['$.totally_invented_field'];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('unresolved source ref')));
});

// ---- B7: empty source refs -------------------------------------------------

test('D5 validator: empty source refs rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  r.residual_risks[0].source_refs = [];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('must cite at least one source')));
});

// ---- B8: dangling internal ref --------------------------------------------

test('D5 validator: dangling cause ref rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  r.recommended_actions[0].resolves_cause_ids = ['NONEXISTENT_CAUSE'];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("references unknown cause 'NONEXISTENT_CAUSE'")));
});

// ---- B9: passed condition as root cause -----------------------------------

test('D5 validator: passed condition as root cause rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  // Under a clean GO, 'proposal_evidence_present' is passed. Citing it as a
  // root cause must be rejected — the policy already cleared it.
  r.cause_analysis = [{
    cause_id: 'C1', category: 'policy_condition', description: 'd',
    severity: 'informational', reason_codes: ['GO_READY_AND_GROUNDED'],
    failed_condition_ids: ['proposal_evidence_present'], source_refs: ['certificate:100'],
  }];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("'proposal_evidence_present' which is not 'failed'")));
});

// ---- B10: GO with blocking cause ------------------------------------------

test('D5 validator: GO with blocking cause rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  r.cause_analysis = [{
    cause_id: 'C1', category: 'residual_risk', description: 'd',
    severity: 'blocking', // GO diagnosis must not create blocking causes
    reason_codes: ['GO_READY_AND_GROUNDED'],
    failed_condition_ids: [], source_refs: ['certificate:100'],
  }];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("severity 'blocking'")));
});

// ---- B11: clarify with empty causes ---------------------------------------

test('D5 validator: clarify with empty causes rejected', () => {
  const c = buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 100, hash: 'c'.repeat(64), decision: 'clarify',
      reason_codes: ['CLARIFY_BLOCKING_GAPS'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 50, settlement_input_hash: 'i'.repeat(64),
    },
    proposal: { id: 1, hash: 'a'.repeat(64), payload: proposal() },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: 'b'.repeat(64),
      payload: readyAssessment({ blocking_gaps: [{ code: 'G1', description: 'gap', source_refs: ['$.problem_statement'] }] }) },
  });
  const r = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'clarify' },
    executive_summary: 's',
    cause_analysis: [], // empty — must be rejected for clarify
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.5,
  };
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("'clarify' but cause_analysis is empty")));
});

// ---- B12: reject without blocking cause -----------------------------------

test('D5 validator: reject without blocking cause rejected', () => {
  const c = buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 100, hash: 'c'.repeat(64), decision: 'reject',
      reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 50, settlement_input_hash: 'i'.repeat(64),
    },
    proposal: { id: 1, hash: 'a'.repeat(64), payload: proposal({ recommended_outcome: 'reject' }) },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: 'b'.repeat(64),
      payload: readyAssessment({ overall_readiness: 'not_ready', recommended_next_action: 'reject',
        blocking_gaps: [{ code: 'G1', description: 'gap', source_refs: ['$.problem_statement'] }] }) },
  });
  const r = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'reject' },
    executive_summary: 's',
    // cause covers the reason code but is NOT blocking — must be rejected.
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'd',
      severity: 'material', reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'],
      failed_condition_ids: [], source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.9,
  };
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("no cause has severity 'blocking'")));
});

// ---- B13: confidence out of range -----------------------------------------

test('D5 validator: confidence out of range rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  r.confidence = 1.5;
  let result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('confidence')));
  r.confidence = -0.1;
  result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('confidence')));
});

// ---- B14: forbidden fields present ----------------------------------------

test('D5 validator: forbidden authority fields rejected', () => {
  const c = goCase();
  for (const field of ['new_outcome', 'override_decision', 'approved', 'settled', 'transition_stage', 'new_certificate']) {
    const r = validGoReport(c);
    r[field] = 'go';
    const result = validateDiagnosisReport(r, c);
    assert.equal(result.valid, false, `payload with '${field}' must be rejected`);
    assert.ok(result.errors.some(e => e.includes(`forbidden field '${field}'`)));
  }
});

// ---- B15: duplicate ids ----------------------------------------------------

test('D5 validator: duplicate ids rejected', () => {
  const c = buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 100, hash: 'c'.repeat(64), decision: 'clarify',
      reason_codes: ['CLARIFY_BLOCKING_GAPS'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 50, settlement_input_hash: 'i'.repeat(64),
    },
    proposal: { id: 1, hash: 'a'.repeat(64), payload: proposal() },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: 'b'.repeat(64),
      payload: readyAssessment({ blocking_gaps: [{ code: 'G1', description: 'gap', source_refs: ['$.problem_statement'] }] }) },
  });
  const r = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'clarify' },
    executive_summary: 's',
    cause_analysis: [
      { cause_id: 'C1', category: 'blocking_gap', description: 'd1', severity: 'blocking', reason_codes: ['CLARIFY_BLOCKING_GAPS'], failed_condition_ids: ['no_blocking_gaps'], source_refs: ['certificate:100'] },
      { cause_id: 'C1', category: 'blocking_gap', description: 'd2', severity: 'blocking', reason_codes: ['CLARIFY_BLOCKING_GAPS'], failed_condition_ids: ['no_blocking_gaps'], source_refs: ['certificate:100'] },
    ],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.8,
  };
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("'C1' is a duplicate")));
});
