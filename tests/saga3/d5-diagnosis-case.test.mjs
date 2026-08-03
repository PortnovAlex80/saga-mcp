/**
 * D5 — deterministic diagnosis case builder unit tests (matrix A1–A8 + causal).
 *
 * Pure: no SQLite, no engine, no workers. Each test builds a minimal
 * DiagnosisCase via buildDiagnosisCase and asserts the policy-trace shape, the
 * source-ref allowlist, and the case hash invariants.
 *
 * P0-4b: the case no longer carries a hand-rolled `policy_conditions` superset.
 * It carries `policy_trace: SettlementConditionTrace[]` produced by running the
 * deterministic settlement policy's evaluate() over a reconstructed snapshot.
 * The trace is causally exact: it contains ONLY predicates the policy actually
 * evaluated for the decided branch, so an alternative-branch predicate (e.g.
 * `worker_outcome_is_reject` under a GO) is ABSENT and cannot be mis-cited.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnosisCase,
  diagnosisCaseHash,
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
} from '../../dist/saga3/domain/discovery-diagnosis-case.js';
import { READINESS_DIMENSIONS } from '../../dist/modules/discovery/domain/discovery-readiness-assessment.js';
import { GO_MIN_CONFIDENCE } from '../../dist/modules/discovery/domain/discovery-settlement-policy.js';

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

/**
 * Build a case from proposal/readiness/cert fixtures. The certificate's
 * decision + reason_codes MUST match what the deterministic policy produces for
 * the given proposal+readiness (in production this is guaranteed because the
 * certificate was produced by the same policy over the same snapshot; in tests
 * we pass a consistent certificate so the case is causally coherent).
 */
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

/** Find a trace node by condition_id. Returns undefined when absent. */
function traceNode(caseData, id) {
  return caseData.policy_trace.find(n => n.condition_id === id);
}

// ---- A1: GO trace — all decided-branch nodes are go+passed+contributing ----

test('D5 case: GO trace marks supporting conditions passed and contributing', () => {
  const c = buildCase(); // ready assessment + go proposal + evidence
  assert.equal(c.decision, 'go');
  // Every GO-supporting predicate is in the trace, branch=go, evaluation=passed,
  // contributed_to_decision=true, emitting GO_READY_AND_GROUNDED.
  const goIds = [
    'worker_outcome_is_go', 'proposal_evidence_present', 'overall_readiness_ready',
    'no_blocking_gaps', 'evidence_grounding_sufficient', 'recommended_action_proceed',
    'confidence_above_go_threshold',
  ];
  for (const id of goIds) {
    const n = traceNode(c, id);
    assert.ok(n, `expected trace node '${id}'`);
    assert.equal(n.branch, 'go', `${id} branch should be go`);
    assert.equal(n.evaluation, 'passed', `${id} should be passed`);
    assert.equal(n.contributed_to_decision, true, `${id} should contribute`);
    assert.deepEqual([...n.emitted_reason_codes], ['GO_READY_AND_GROUNDED'], `${id} emitted code`);
    assert.equal(n.role, 'supporting', `${id} role`);
  }
  assert.equal(c.schema_version, DISCOVERY_DIAGNOSIS_CASE_SCHEMA);
  // CRITICAL (P0-4b): the reject-branch predicates are ABSENT from the trace —
  // they were never evaluated for this GO decision, so they cannot be mis-cited
  // as the cause of the GO. This is the bug the flat-superset model had.
  for (const rejectId of [
    'worker_outcome_is_reject', 'overall_readiness_not_ready', 'recommended_action_reject',
    'blocking_gaps_present', 'each_blocking_gap_grounded', 'confidence_above_reject_threshold',
  ]) {
    assert.equal(traceNode(c, rejectId), undefined, `reject predicate '${rejectId}' must be absent from a GO trace`);
  }
});

// ---- A2: clarify reason codes map to failed blocking trace nodes -----------

test('D5 case: clarify reason codes map to failed blocking trace nodes', () => {
  const c = buildCase({
    cert: certificateRef({
      decision: 'clarify',
      reason_codes: ['CLARIFY_CONDITIONALLY_READY', 'CLARIFY_BLOCKING_GAPS', 'CLARIFY_MANUAL_REVIEW_RECOMMENDED'],
    }),
    prop: proposal({ recommended_outcome: 'go' }),
    assessment: readyAssessment({
      overall_readiness: 'conditionally_ready',
      blocking_gaps: [{ code: 'G1', description: 'gap', source_refs: ['$.problem_statement'] }],
      recommended_next_action: 'manual_review',
    }),
  });
  assert.equal(c.decision, 'clarify');
  // Each blocking predicate that prevented GO is in the trace as clarify+failed.
  const overall = traceNode(c, 'overall_readiness_ready');
  assert.ok(overall);
  assert.equal(overall.branch, 'clarify');
  assert.equal(overall.evaluation, 'failed');
  assert.equal(overall.contributed_to_decision, true);
  assert.ok(overall.emitted_reason_codes.includes('CLARIFY_CONDITIONALLY_READY'));

  const gaps = traceNode(c, 'no_blocking_gaps');
  assert.equal(gaps.branch, 'clarify');
  assert.equal(gaps.evaluation, 'failed');
  assert.ok(gaps.emitted_reason_codes.includes('CLARIFY_BLOCKING_GAPS'));

  const action = traceNode(c, 'recommended_action_proceed');
  assert.equal(action.branch, 'clarify');
  assert.equal(action.evaluation, 'failed');
  assert.ok(action.emitted_reason_codes.includes('CLARIFY_MANUAL_REVIEW_RECOMMENDED'));
});

// ---- A3: reject grounds are PASSED reject conditions (NOT failed) ----------

test('D5 case: reject grounds are passed reject conditions, not failed', () => {
  const c = buildCase({
    cert: certificateRef({ decision: 'reject', reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'] }),
    prop: proposal({ recommended_outcome: 'reject' }),
    assessment: readyAssessment({
      overall_readiness: 'not_ready',
      recommended_next_action: 'reject',
      blocking_gaps: [{ code: 'G1', description: 'blocking', source_refs: ['$.problem_statement'] }],
    }),
  });
  assert.equal(c.decision, 'reject');
  // The reject decision is grounded in PASSED reject conditions. This is the
  // scenario the old `failed_condition_ids` model could NOT represent — a REJECT
  // is explained by the supporting reject conditions that HELD, not by anything
  // that failed.
  for (const rejectId of [
    'worker_outcome_is_reject', 'overall_readiness_not_ready', 'recommended_action_reject',
    'blocking_gaps_present', 'each_blocking_gap_grounded', 'confidence_above_reject_threshold',
  ]) {
    const n = traceNode(c, rejectId);
    assert.ok(n, `expected reject trace node '${rejectId}'`);
    assert.equal(n.branch, 'reject', `${rejectId} branch`);
    assert.equal(n.evaluation, 'passed', `${rejectId} must be PASSED (reject grounds)`);
    assert.equal(n.contributed_to_decision, true);
    assert.ok(n.emitted_reason_codes.includes('REJECT_WORKER_AND_ADVISOR_AGREE'));
  }
  // CRITICAL: the GO-branch predicates are ABSENT — they cannot be mis-cited as
  // the cause of a REJECT.
  assert.equal(traceNode(c, 'worker_outcome_is_go'), undefined);
  assert.equal(traceNode(c, 'overall_readiness_ready'), undefined);
});

// ---- A4: allowed_source_refs deterministic + aggregate anchors -------------

test('D5 case: allowed_source_refs deterministic and includes trace refs', () => {
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
  // Aggregate assessment anchors are always citable when an assessment exists,
  // so a trace node citing e.g. `assessment.blocking_gaps` is always allowed.
  assert.ok(c1.allowed_source_refs.includes('assessment.blocking_gaps'));
  assert.ok(c1.allowed_source_refs.includes('assessment.non_blocking_gaps'));
  assert.ok(c1.allowed_source_refs.includes('assessment.dimension_assessments'));
  // Each trace condition_id is itself a citable source ref.
  assert.ok(c1.allowed_source_refs.includes('policy_condition:worker_outcome_is_go'));
});

// ---- A4b: every trace node's source_refs is a subset of allowed_source_refs -

test('D5 case: every trace node source_ref is citable (subset of allowlist)', () => {
  // Exercise GO, CLARIFY, REJECT, and worker-clarify: each produces a different
  // trace shape. For every node, every source_ref must be in the allowlist.
  const cases = [
    buildCase(), // GO
    buildCase({
      cert: certificateRef({ decision: 'clarify', reason_codes: ['CLARIFY_BLOCKING_GAPS'] }),
      assessment: readyAssessment({ blocking_gaps: [{ code: 'G1', description: 'g', source_refs: ['$.problem_statement'] }] }),
    }),
    buildCase({
      cert: certificateRef({ decision: 'reject', reason_codes: ['REJECT_WORKER_AND_ADVISOR_AGREE'] }),
      prop: proposal({ recommended_outcome: 'reject' }),
      assessment: readyAssessment({ overall_readiness: 'not_ready', recommended_next_action: 'reject',
        blocking_gaps: [{ code: 'G1', description: 'b', source_refs: ['$.problem_statement'] }] }),
    }),
    buildCase({
      cert: certificateRef({ decision: 'clarify', reason_codes: ['CLARIFY_WORKER_REQUESTED'] }),
      prop: proposal({ recommended_outcome: 'clarify' }),
    }),
  ];
  for (const c of cases) {
    const allow = new Set(c.allowed_source_refs);
    for (const n of c.policy_trace) {
      for (const ref of n.source_refs) {
        assert.ok(allow.has(ref), `decision=${c.decision}: trace node '${n.condition_id}' source_ref '${ref}' must be in allowlist`);
      }
    }
  }
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

// ---- A8: missing/failed/paused readiness → single failed clarify node ------

test('D5 case: missing/failed/paused readiness produces a failed clarify node only', () => {
  for (const status of ['missing', 'failed', 'paused']) {
    const expectedCode = status === 'failed' ? 'CLARIFY_READINESS_FAILED'
      : status === 'paused' ? 'CLARIFY_READINESS_PAUSED'
      : 'CLARIFY_READINESS_MISSING';
    const c = buildCase({
      readinessStatus: status,
      assessment: null,
      cert: certificateRef({ decision: 'clarify', reason_codes: [expectedCode] }),
    });
    const ra = traceNode(c, 'readiness_accepted');
    assert.ok(ra, `readiness_accepted node should exist for ${status}`);
    assert.equal(ra.branch, 'clarify', `readiness_accepted branch for ${status}`);
    assert.equal(ra.evaluation, 'failed', `readiness_accepted should fail for ${status}`);
    assert.equal(ra.contributed_to_decision, true);
    assert.ok(ra.emitted_reason_codes.includes(expectedCode), `${status} should emit ${expectedCode}`);
    // Assessment-based predicates are ABSENT (no assessment to cite) — they are
    // not 'not_applicable' anymore, they simply do not appear.
    assert.equal(traceNode(c, 'overall_readiness_ready'), undefined);
    assert.equal(traceNode(c, 'no_blocking_gaps'), undefined);
    // And the assessment anchor must NOT be in the allowlist (no invented evidence).
    assert.equal(c.allowed_source_refs.includes('assessment:7'), false);
  }
});

test('D5 case: contract version constant is the report schema', () => {
  assert.equal(DISCOVERY_DIAGNOSIS_CONTRACT_VERSION, 'saga3.discovery-diagnosis.v1');
  void GO_MIN_CONFIDENCE;
});
