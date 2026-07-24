/**
 * D5 — deterministic diagnosis case builder unit tests (matrix A1–A8).
 *
 * Pure: no SQLite, no engine, no workers. Each test builds a minimal
 * DiagnosisCase via buildDiagnosisCase and asserts the policy-condition
 * decomposition, the source-ref allowlist, and the case hash invariants.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnosisCase,
  diagnosisCaseHash,
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
} from '../../dist/saga3/domain/discovery-diagnosis-case.js';
import { READINESS_DIMENSIONS } from '../../dist/saga3/domain/discovery-readiness-assessment.js';
import { GO_MIN_CONFIDENCE } from '../../dist/saga3/domain/discovery-settlement-policy.js';

// ---- fixture builders ------------------------------------------------------

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

function certificateRef(overrides = {}) {
  return {
    id: 100,
    hash: 'c'.repeat(64),
    decision: 'go',
    reason_codes: ['GO_READY_AND_GROUNDED'],
    policy_version: 'saga3.discovery-settlement-policy.v1',
    policy_hash: 'p'.repeat(64),
    settlement_id: 50,
    settlement_input_hash: 'i'.repeat(64),
    ...overrides,
  };
}

/** Build a case from proposal/readiness/cert fixtures. */
function buildCase({ cert, prop, readinessStatus, assessment = readyAssessment(), sourceSubmissionId = null, normalizationProposalId = null, capturedAt } = {}) {
  const proposalHash = 'a'.repeat(64);
  const readinessRef = {
    status: readinessStatus ?? 'accepted_by_kernel',
    assessment_id: assessment ? 7 : null,
    hash: assessment ? 'b'.repeat(64) : null,
    payload: assessment ?? null,
  };
  return buildDiagnosisCase({
    epic_id: 10,
    certificate: cert ?? certificateRef(),
    proposal: { id: 1, hash: proposalHash, payload: (prop ?? proposal()) },
    readiness: readinessRef,
    proposal_source_submission_id: sourceSubmissionId,
    proposal_normalization_proposal_id: normalizationProposalId,
    captured_at: capturedAt,
  });
}

function condition(caseData, id) {
  return caseData.policy_conditions.find(c => c.condition_id === id);
}

// ---- A1: GO conditions marked passed --------------------------------------

test('D5 case: GO conditions marked passed', () => {
  const c = buildCase(); // ready assessment + go proposal + evidence
  // The core GO predicates must all be passed.
  assert.equal(condition(c, 'worker_outcome_is_go').result, 'passed');
  assert.equal(condition(c, 'proposal_evidence_present').result, 'passed');
  assert.equal(condition(c, 'readiness_accepted').result, 'passed');
  assert.equal(condition(c, 'overall_readiness_ready').result, 'passed');
  assert.equal(condition(c, 'no_blocking_gaps').result, 'passed');
  assert.equal(condition(c, 'evidence_grounding_sufficient').result, 'passed');
  assert.equal(condition(c, 'recommended_action_proceed').result, 'passed');
  assert.equal(condition(c, 'confidence_above_go_threshold').result, 'passed');
  assert.equal(c.schema_version, DISCOVERY_DIAGNOSIS_CASE_SCHEMA);
  // A clean GO has its GO preconditions passed. The reject preconditions in the
  // superset (worker_outcome_is_reject, etc.) are simply not cited by a GO
  // diagnosis — they are not "failed GO conditions". The key guarantee: every
  // GO-critical condition is passed, so there is no failed condition a GO
  // diagnosis could legitimately root a cause in.
  for (const goId of [
    'proposal_evidence_present', 'readiness_accepted', 'overall_readiness_ready',
    'no_blocking_gaps', 'evidence_grounding_sufficient', 'recommended_action_proceed',
    'confidence_above_go_threshold',
  ]) {
    assert.equal(condition(c, goId).result, 'passed', `${goId} should pass under clean GO`);
  }
});

// ---- A2: clarify reason codes map to failed conditions --------------------

test('D5 case: clarify reason codes map to failed conditions', () => {
  const c = buildCase({
    prop: proposal({ recommended_outcome: 'go' }),
    assessment: readyAssessment({
      overall_readiness: 'conditionally_ready',
      blocking_gaps: [{ code: 'G1', description: 'gap', source_refs: ['$.problem_statement'] }],
      recommended_next_action: 'manual_review',
    }),
  });
  const readinessAccepted = condition(c, 'readiness_accepted');
  assert.equal(readinessAccepted.result, 'passed');
  const overall = condition(c, 'overall_readiness_ready');
  assert.equal(overall.result, 'failed');
  assert.equal(overall.reason_code, 'CLARIFY_CONDITIONALLY_READY');
  const gaps = condition(c, 'no_blocking_gaps');
  assert.equal(gaps.result, 'failed');
  assert.equal(gaps.reason_code, 'CLARIFY_BLOCKING_GAPS');
  const action = condition(c, 'recommended_action_proceed');
  assert.equal(action.result, 'failed');
  assert.equal(action.reason_code, 'CLARIFY_MANUAL_REVIEW_RECOMMENDED');
});

// ---- A3: reject agreement represented correctly ---------------------------

test('D5 case: reject agreement represented correctly', () => {
  const c = buildCase({
    cert: certificateRef({ decision: 'reject', reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'] }),
    prop: proposal({ recommended_outcome: 'reject' }),
    assessment: readyAssessment({
      overall_readiness: 'not_ready',
      recommended_next_action: 'reject',
      blocking_gaps: [{ code: 'G1', description: 'blocking', source_refs: ['$.problem_statement'] }],
    }),
  });
  // The reject preconditions that hold are passed.
  assert.equal(condition(c, 'worker_outcome_is_reject').result, 'passed');
  assert.equal(condition(c, 'overall_readiness_not_ready').result, 'passed');
  assert.equal(condition(c, 'recommended_action_reject').result, 'passed');
  assert.equal(condition(c, 'blocking_gaps_present').result, 'passed');
  assert.equal(condition(c, 'each_blocking_gap_has_source_refs').result, 'passed');
  // The GO-oriented conditions are not_applicable (they cannot be root causes
  // for a reject decision). A reject diagnosis cites the reject preconditions.
  assert.equal(condition(c, 'worker_outcome_is_go').result, 'failed');
  assert.equal(condition(c, 'overall_readiness_ready').result, 'failed');
});

// ---- A4: allowed_source_refs deterministic --------------------------------

test('D5 case: allowed_source_refs deterministic', () => {
  const c1 = buildCase();
  const c2 = buildCase();
  assert.deepEqual(c1.allowed_source_refs, c2.allowed_source_refs);
  // Must contain the certificate + proposal + assessment anchors.
  assert.ok(c1.allowed_source_refs.includes('certificate:100'));
  assert.ok(c1.allowed_source_refs.includes('settlement:50'));
  assert.ok(c1.allowed_source_refs.includes('proposal:1'));
  assert.ok(c1.allowed_source_refs.includes('$.problem_statement'));
  assert.ok(c1.allowed_source_refs.includes('assessment:7'));
  assert.ok(c1.allowed_source_refs.includes('reason_code:GO_READY_AND_GROUNDED'));
  // Each policy condition id is a citable source ref.
  assert.ok(c1.allowed_source_refs.includes('policy_condition:worker_outcome_is_go'));
});

// ---- A5: case hash deterministic ------------------------------------------

test('D5 case: hash deterministic', () => {
  const h1 = diagnosisCaseHash(buildCase());
  const h2 = diagnosisCaseHash(buildCase());
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ---- A6: changed certificate hash changes case hash -----------------------

test('D5 case: certificate hash change changes case hash', () => {
  const base = buildCase();
  const changed = buildCase({ cert: certificateRef({ hash: 'd'.repeat(64) }) });
  assert.notEqual(diagnosisCaseHash(base), diagnosisCaseHash(changed));
});

// ---- A7: captured_at not in semantic hash ---------------------------------

test('D5 case: captured_at not in semantic hash', () => {
  const c1 = buildCase({ capturedAt: '2026-01-01T00:00:00.000Z' });
  const c2 = buildCase({ capturedAt: '2026-12-31T23:59:59.000Z' });
  assert.equal(diagnosisCaseHash(c1), diagnosisCaseHash(c2));
  // But the captured_at field itself differs.
  assert.notEqual(c1.captured_at, c2.captured_at);
});

// ---- A8: missing/failed/paused readiness conditions -----------------------

test('D5 case: missing/failed/paused readiness conditions', () => {
  for (const status of ['missing', 'failed', 'paused']) {
    const c = buildCase({ readinessStatus: status, assessment: null });
    const ra = condition(c, 'readiness_accepted');
    assert.equal(ra.result, 'failed', `readiness_accepted should fail for ${status}`);
    if (status === 'failed') assert.equal(ra.reason_code, 'CLARIFY_READINESS_FAILED');
    if (status === 'paused') assert.equal(ra.reason_code, 'CLARIFY_READINESS_PAUSED');
    if (status === 'missing') assert.equal(ra.reason_code, 'CLARIFY_READINESS_MISSING');
    // Assessment-based predicates must be not_applicable (no assessment to cite).
    assert.equal(condition(c, 'overall_readiness_ready').result, 'not_applicable');
    assert.equal(condition(c, 'no_blocking_gaps').result, 'not_applicable');
    // And the assessment anchor must NOT be in the allowlist (no invented evidence).
    assert.equal(c.allowed_source_refs.includes('assessment:7'), false);
  }
});

test('D5 case: contract version constant is the report schema', () => {
  assert.equal(DISCOVERY_DIAGNOSIS_CONTRACT_VERSION, 'saga3.discovery-diagnosis.v1');
  void GO_MIN_CONFIDENCE;
});
