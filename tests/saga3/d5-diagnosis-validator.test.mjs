/**
 * D5 — diagnosis validator unit tests (matrix B1–B15 + causal coverage).
 *
 * Pure: no SQLite, no engine, no workers. Each test builds a minimal valid
 * report payload + case, then mutates one aspect and asserts the validator
 * accepts/rejects. Covers target binding, forbidden fields, reason coverage,
 * CAUSAL condition coverage (cited_condition_ids must exist in the policy trace
 * AND have contributed_to_decision===true), per-decision grounds (GO=passed go,
 * REJECT=passed reject, CLARIFY=failed clarify), reason-code agreement with
 * cited conditions, source refs, internal refs, outcome consistency,
 * confidence, and duplicate ids (§8).
 *
 * P0-4b: the report field `failed_condition_ids` was renamed to
 * `cited_condition_ids` (a cause may cite PASSED conditions for GO/REJECT
 * grounds OR FAILED conditions for CLARIFY grounds). The validator now enforces
 * the causal rules per-decision.
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

/** A valid GO report for goCase(). GO has empty causes (explains via residual risk). */
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
    cited_condition_ids: [], source_refs: ['certificate:100'],
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
      cited_condition_ids: ['no_blocking_gaps'], source_refs: ['certificate:100'],
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

// ---- B9: a non-contributing / unknown condition id is not citable ----------

test('D5 validator: citing unknown condition rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  // 'definitely_not_a_real_condition' is not in the policy trace at all.
  r.cause_analysis = [{
    cause_id: 'C1', category: 'policy_condition', description: 'd',
    severity: 'informational', reason_codes: ['GO_READY_AND_GROUNDED'],
    cited_condition_ids: ['definitely_not_a_real_condition'], source_refs: ['certificate:100'],
  }];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("unknown condition 'definitely_not_a_real_condition'")));
});

// ---- B10: GO with blocking cause ------------------------------------------

test('D5 validator: GO with blocking cause rejected', () => {
  const c = goCase();
  const r = validGoReport(c);
  // Cite a real GO-passed condition but mark it blocking — forbidden under GO.
  r.cause_analysis = [{
    cause_id: 'C1', category: 'residual_risk', description: 'd',
    severity: 'blocking',
    reason_codes: ['GO_READY_AND_GROUNDED'],
    cited_condition_ids: ['proposal_evidence_present'], source_refs: ['certificate:100'],
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
    // cause cites a passed reject condition + covers the reason code, but is NOT
    // blocking — must be rejected.
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'd',
      severity: 'material', reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'],
      cited_condition_ids: ['blocking_gaps_present'], source_refs: ['certificate:100'],
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
      { cause_id: 'C1', category: 'blocking_gap', description: 'd1', severity: 'blocking', reason_codes: ['CLARIFY_BLOCKING_GAPS'], cited_condition_ids: ['no_blocking_gaps'], source_refs: ['certificate:100'] },
      { cause_id: 'C1', category: 'blocking_gap', description: 'd2', severity: 'blocking', reason_codes: ['CLARIFY_BLOCKING_GAPS'], cited_condition_ids: ['no_blocking_gaps'], source_refs: ['certificate:100'] },
    ],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.8,
  };
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("'C1' is a duplicate")));
});

// ---------------------------------------------------------------------------
// NEW causal-coverage tests (P0-4b)
// ---------------------------------------------------------------------------

// ---- C-GO-OK: a valid GO diagnosis citing passed GO conditions -------------

test('D5 validator: valid GO diagnosis citing passed GO conditions accepted', () => {
  const c = goCase();
  const r = validGoReport(c);
  // Cite two GO-passed conditions; the cause's reason code agrees with their
  // emitted_reason_codes (GO_READY_AND_GROUNDED) and is carried by the cert.
  r.cause_analysis = [{
    cause_id: 'C1', category: 'policy_condition', description: 'Grounds for GO.',
    severity: 'informational', reason_codes: ['GO_READY_AND_GROUNDED'],
    cited_condition_ids: ['proposal_evidence_present', 'overall_readiness_ready'],
    source_refs: ['certificate:100'],
  }];
  validReportAccepts(c, r);
});

// ---- C-GO-REJECT: a GO cause citing a reject-branch condition --------------

test('D5 validator: GO cause citing a reject-branch condition rejected', () => {
  // This is the bug the flat-superset model enabled: a diagnosis citing an
  // alternative-branch predicate as the cause of the actual decision. Under the
  // trace model the reject predicate is ABSENT from a GO case, so the cite is
  // 'unknown condition' (it cannot be mis-cited because it is not in the trace).
  const c = goCase();
  const r = validGoReport(c);
  r.cause_analysis = [{
    cause_id: 'C1', category: 'policy_condition', description: 'd',
    severity: 'informational', reason_codes: ['GO_READY_AND_GROUNDED'],
    cited_condition_ids: ['worker_outcome_is_reject'], // reject-branch — absent from GO trace
    source_refs: ['certificate:100'],
  }];
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("unknown condition 'worker_outcome_is_reject'")),
    `expected unknown-condition error, got: ${result.errors.join('; ')}`);
});

// ---- C-CLARIFY-PASSED: a CLARIFY cause citing a passed condition -----------

test('D5 validator: CLARIFY cause citing a passed condition rejected', () => {
  // Worker-requested clarify: the trace has a single node 'worker_requested_clarify'
  // with branch='clarify', evaluation='passed', contributed=true. A CLARIFY
  // cause may cite ONLY clarify-branch FAILED conditions, so citing this PASSED
  // clarify node must be rejected.
  const c = buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 100, hash: 'c'.repeat(64), decision: 'clarify',
      reason_codes: ['CLARIFY_WORKER_REQUESTED'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 50, settlement_input_hash: 'i'.repeat(64),
    },
    proposal: { id: 1, hash: 'a'.repeat(64), payload: proposal({ recommended_outcome: 'clarify' }) },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: 'b'.repeat(64), payload: readyAssessment() },
  });
  const r = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'clarify' },
    executive_summary: 's',
    cause_analysis: [{
      cause_id: 'C1', category: 'policy_condition', description: 'd',
      severity: 'blocking', reason_codes: ['CLARIFY_WORKER_REQUESTED'],
      cited_condition_ids: ['worker_requested_clarify'], // passed clarify node — not citable
      source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.5,
  };
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('may cite only clarify-branch failed conditions')),
    `expected clarify-passed grounds error, got: ${result.errors.join('; ')}`);
});

// ---- C-REJECT-NO-PASSED: a REJECT cause citing only failed conditions ------

test('D5 validator: REJECT cause citing only failed conditions rejected', () => {
  // Construct a reject case where the policy emits a REJECT (all reject
  // preconditions pass). The reject trace contains ONLY reject-branch PASSED
  // nodes. A cause that cites a failed condition cannot exist legitimately here
  // — so we fabricate a 'failed' id that is NOT in the trace (unknown) to model
  // "a reject cause grounded in a failed predicate". It must be rejected.
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
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'd',
      severity: 'blocking', reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'],
      // Cite a node from the GO branch — it is absent from the reject trace, so
      // this models "a reject cause not grounded in a passed reject condition".
      cited_condition_ids: ['overall_readiness_ready'],
      source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.9,
  };
  const result = validateDiagnosisReport(r, c);
  assert.equal(result.valid, false);
  // Must be rejected: cited condition is unknown (GO predicate absent from a
  // reject trace) AND no passed reject condition is cited.
  assert.ok(result.errors.length > 0,
    `reject cause with no passed reject ground must be rejected`);
});

// ---- C-REJECT-OK: a valid REJECT diagnosis grounded in passed reject cond ---

test('D5 validator: valid REJECT diagnosis grounded in passed reject conditions accepted', () => {
  // This is the scenario that was IMPOSSIBLE under the old failed_condition_ids
  // model (which could only express "cited because it FAILED"). A REJECT is now
  // correctly explained by citing its PASSED reject conditions.
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
    executive_summary: 'Worker and advisor agree the proposal should be rejected.',
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'Blocking gaps grounded.',
      severity: 'blocking', reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'],
      cited_condition_ids: ['worker_outcome_is_reject', 'blocking_gaps_present', 'overall_readiness_not_ready'],
      source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.9,
  };
  validReportAccepts(c, r);
});

// ---- C-REASON-DISAGREE: cause reason_codes disagree with cited conditions ---

test('D5 validator: cause reason code disagreeing with cited condition rejected', () => {
  // GO case: cite a GO-passed condition (which emits GO_READY_AND_GROUNDED) but
  // state a reason code it did not emit. The reason code is carried by the cert
  // so it passes step 11, but it disagrees with the cited condition's emitted
  // codes -> rejected at step 10.
  const c = goCase();
  const r = validGoReport(c);
  // 'CLARIFY_BLOCKING_GAPS' is NOT emitted by 'proposal_evidence_present'
  // (which emits GO_READY_AND_GROUNDED). It is also not carried by a GO cert, so
  // we use a GO cert code that the GO condition does not emit — but all GO
  // conditions emit only GO_READY_AND_GROUNDED, so any other cert code would
  // work. Use GO_READY_AND_GROUNDED on a condition that emits it would pass, so
  // instead cite a condition and claim a code it does not emit: we synthesize by
  // adding a fake second code. Since cert only carries GO_READY_AND_GROUNDED,
  // fabricate a disagreement via an extra reason code not in the trace.
  r.cause_analysis = [{
    cause_id: 'C1', category: 'policy_condition', description: 'd',
    severity: 'informational',
    // GO_READY_AND_GROUNDED agrees; CLARIFY_LOW_CONFIDENCE does NOT agree and is
    // also not carried by the GO cert -> caught. To isolate the DISAGREE rule
    // (not the unknown-cert-code rule), cite two codes where one agrees and the
    // other is carried by the cert. But a GO cert carries only
    // GO_READY_AND_GROUNDED. So instead test the disagree rule by citing a
    // condition whose emitted codes do NOT include the cause's (only) code,
    // while keeping the code cert-carried: impossible for a single-code GO cert.
    // Therefore the meaningful disagree test uses a CLARIFY case below.
    reason_codes: ['GO_READY_AND_GROUNDED'],
    cited_condition_ids: ['proposal_evidence_present'],
    source_refs: ['certificate:100'],
  }];
  // Sanity: the agreeing GO cause is accepted (this mirrors C-GO-OK).
  validReportAccepts(c, r);

  // Now the real disagree test: a CLARIFY case where a cause cites a clarify
  // condition emitting CLARIFY_BLOCKING_GAPS but states CLARIFY_LOW_CONFIDENCE
  // (a different code, which the cert must also carry for the unknown-code rule
  // NOT to fire first). Build a clarify cert carrying both codes.
  const c2 = buildDiagnosisCase({
    epic_id: 10,
    certificate: {
      id: 100, hash: 'c'.repeat(64), decision: 'clarify',
      reason_codes: ['CLARIFY_BLOCKING_GAPS', 'CLARIFY_LOW_CONFIDENCE'],
      policy_version: 'saga3.discovery-settlement-policy.v1', policy_hash: 'p'.repeat(64),
      settlement_id: 50, settlement_input_hash: 'i'.repeat(64),
    },
    proposal: { id: 1, hash: 'a'.repeat(64), payload: proposal() },
    readiness: { status: 'accepted_by_kernel', assessment_id: 7, hash: 'b'.repeat(64),
      payload: readyAssessment({ blocking_gaps: [{ code: 'G1', description: 'g', source_refs: ['$.problem_statement'] }], confidence: 0.4 }) },
  });
  const r2 = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'clarify' },
    executive_summary: 's',
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'd',
      severity: 'blocking',
      // Cite 'no_blocking_gaps' which emits CLARIFY_BLOCKING_GAPS, but state
      // CLARIFY_LOW_CONFIDENCE — a cert-carried code it does NOT emit.
      reason_codes: ['CLARIFY_LOW_CONFIDENCE'],
      cited_condition_ids: ['no_blocking_gaps'],
      source_refs: ['certificate:100'],
    }, {
      cause_id: 'C2', category: 'blocking_gap', description: 'covers the other code',
      severity: 'blocking', reason_codes: ['CLARIFY_BLOCKING_GAPS'],
      cited_condition_ids: ['no_blocking_gaps'],
      source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.5,
  };
  const result2 = validateDiagnosisReport(r2, c2);
  assert.equal(result2.valid, false);
  assert.ok(result2.errors.some(e => e.includes("'CLARIFY_LOW_CONFIDENCE' is not emitted by any of its cited conditions")),
    `expected disagree error, got: ${result2.errors.join('; ')}`);
});

// ---- C-NONCONTRIB: citing a trace node that did not contribute --------------

test('D5 validator: citing a non-contributing condition rejected', () => {
  // Defensive: a condition in the trace but with contributed_to_decision=false
  // must not be citable. In v1 every trace node contributes, so this is
  // guarded by constructing a case whose trace we then tamper with.
  const c = goCase();
  const tampered = {
    ...c,
    policy_trace: c.policy_trace.map(n =>
      n.condition_id === 'proposal_evidence_present'
        ? { ...n, contributed_to_decision: false }
        : n,
    ),
  };
  const r = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: {
      certificate_id: tampered.certificate.id, certificate_hash: tampered.certificate.hash,
      settlement_input_hash: tampered.certificate.settlement_input_hash, decision: 'go',
    },
    executive_summary: 's',
    cause_analysis: [{
      cause_id: 'C1', category: 'policy_condition', description: 'd',
      severity: 'informational', reason_codes: ['GO_READY_AND_GROUNDED'],
      cited_condition_ids: ['proposal_evidence_present'], source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.5,
  };
  const result = validateDiagnosisReport(r, tampered);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("'proposal_evidence_present' which did not contribute to the decision")),
    `expected non-contributing error, got: ${result.errors.join('; ')}`);
});

// ---- C-CLARIFY-OK: a valid CLARIFY diagnosis citing failed clarify cond -----

test('D5 validator: valid CLARIFY diagnosis citing failed clarify conditions accepted', () => {
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
      payload: readyAssessment({ blocking_gaps: [{ code: 'G1', description: 'g', source_refs: ['$.problem_statement'] }] }) },
  });
  const r = {
    schema_version: 'saga3.discovery-diagnosis.v1',
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'clarify' },
    executive_summary: 'Blocking gaps prevent proceeding.',
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'Blocking gaps remain.',
      severity: 'blocking', reason_codes: ['CLARIFY_BLOCKING_GAPS'],
      cited_condition_ids: ['no_blocking_gaps'], // clarify-branch FAILED
      source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.6,
  };
  validReportAccepts(c, r);
});

// Regression: payload MUST be accepted even WITHOUT schema_version in payload.
// schema_version is a TOP-LEVEL arg of diagnosis_submit (enforced at the MCP
// handler boundary in saga3-diagnosis.ts), never inside payload. Previously
// discovery-diagnosis-validator.ts:102 checked payload.schema_version, which
// was always undefined (handler passes args.payload without schema_version),
// causing every diagnosis_submit to be falsely rejected with
// "schema_version got undefined". Epic 32/34 diagnosis failures were this bug.
test('regression: payload without schema_version is valid (schema_version is top-level arg)', () => {
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
      payload: readyAssessment({ blocking_gaps: [{ code: 'G1', description: 'g', source_refs: ['$.problem_statement'] }] }) },
  });
  // NO schema_version field — mirrors what the handler actually passes.
  const r = {
    target: { certificate_id: 100, certificate_hash: 'c'.repeat(64), settlement_input_hash: 'i'.repeat(64), decision: 'clarify' },
    executive_summary: 'Blocking gaps prevent proceeding.',
    cause_analysis: [{
      cause_id: 'C1', category: 'blocking_gap', description: 'Blocking gaps remain.',
      severity: 'blocking', reason_codes: ['CLARIFY_BLOCKING_GAPS'],
      cited_condition_ids: ['no_blocking_gaps'], // clarify-branch FAILED
      source_refs: ['certificate:100'],
    }],
    information_requests: [], recommended_actions: [], residual_risks: [], confidence: 0.6,
  };
  const v = validateDiagnosisReport(r, c);
  assert.equal(v.valid, true, `payload without schema_version must be valid; got: ${JSON.stringify(v.errors)}`);
  assert.ok(!v.errors.some(e => e.includes('schema_version')),
    `validator must NOT emit schema_version errors for payload; got: ${JSON.stringify(v.errors)}`);
});
