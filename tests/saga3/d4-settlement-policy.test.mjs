/**
 * D4 — deterministic discovery settlement policy unit tests.
 *
 * Pure: no SQLite, no engine, no workers. Each test builds a minimal
 * DiscoverySettlementInputSnapshot and asserts the policy's decision +
 * reason codes. Covers the §15 decision matrix and the exit-gate invariants:
 * GO requires agreement + grounding + confidence; REJECT requires coherent
 * worker+advisor rejection; everything else fail-closes to CLARIFY.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DiscoverySettlementPolicyV1,
  DISCOVERY_SETTLEMENT_POLICY_VERSION,
  GO_MIN_CONFIDENCE,
  POLICY_V1_CONTENT_HASH,
  POLICY_V1_MANIFEST,
  REJECT_MIN_CONFIDENCE,
} from '../../dist/saga3/domain/discovery-settlement-policy.js';
import {
  DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
  buildSettlementInputHash,
} from '../../dist/saga3/domain/discovery-settlement-input.js';
import {
  OVERALL_READINESS_VALUES,
  READINESS_DIMENSIONS,
} from '../../dist/saga3/domain/discovery-readiness-assessment.js';

const policy = new DiscoverySettlementPolicyV1();

// ---- snapshot builders -----------------------------------------------------

/** A dimension assessment that is fully grounded. */
function dim(status) {
  return { status, rationale: 'r', source_refs: ['proposal.problem_statement'] };
}

/** A readiness payload ready to go. Override fields to vary outcomes. */
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

/** A proposal payload. Override recommended_outcome + evidence_refs. */
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

/**
 * Build a snapshot. readinessInput is one of:
 *   { kind: 'accepted', payload }  -> accepted_by_kernel slice
 *   { kind: 'missing' }            -> missing slice
 *   { kind: 'failed' }             -> failed slice
 */
function snapshot({ workerOutcome = 'go', assessment = null, readinessKind = 'accepted', proposalOverrides = {} }) {
  let readiness;
  if (readinessKind === 'accepted' && assessment) {
    readiness = { status: 'accepted_by_kernel', assessment_id: 7, content_hash: 'b'.repeat(64), payload: assessment };
  } else if (readinessKind === 'failed') {
    readiness = { status: 'failed', assessment_id: null, content_hash: null, payload: null };
  } else if (readinessKind === 'paused') {
    readiness = { status: 'paused', assessment_id: null, content_hash: null, payload: null };
  } else {
    readiness = { status: 'missing', assessment_id: null, content_hash: null, payload: null };
  }
  return {
    schema_version: DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
    epic_id: 10,
    proposal: {
      id: 1,
      content_hash: 'a'.repeat(64),
      payload: proposal({ recommended_outcome: workerOutcome, ...proposalOverrides }),
      source_intent_id: 2,
      source_submission_id: 3,
      normalization_proposal_id: null,
    },
    readiness,
    policy: { version: DISCOVERY_SETTLEMENT_POLICY_VERSION, content_hash: POLICY_V1_CONTENT_HASH },
    captured_at: '2026-07-24T00:00:00.000Z',
  };
}

// ---- determinism / hash stability -----------------------------------------

test('D4 policy: POLICY_V1_CONTENT_HASH is a stable 64-char hex', () => {
  assert.match(POLICY_V1_CONTENT_HASH, /^[0-9a-f]{64}$/);
  // Recompute from a second instance -> identical (no per-instance state).
  assert.equal(new DiscoverySettlementPolicyV1().contentHash, POLICY_V1_CONTENT_HASH);
});

test('D4 policy: settle() is deterministic across calls with equal input', () => {
  const s = snapshot({ assessment: readyAssessment() });
  const d1 = policy.settle(s);
  const d2 = policy.settle(s);
  assert.deepEqual(d1, d2);
  // Input snapshot hash is stable.
  assert.equal(buildSettlementInputHash(s), buildSettlementInputHash(s));
});

test('D4 policy: decision binds policy_version + policy_hash', () => {
  const d = policy.settle(snapshot({ assessment: readyAssessment() }));
  assert.equal(d.policy_version, DISCOVERY_SETTLEMENT_POLICY_VERSION);
  assert.equal(d.policy_hash, POLICY_V1_CONTENT_HASH);
});

// ---- GO path (§6.1) --------------------------------------------------------

test('D4 GO: worker go + readiness ready + no gaps + grounded + high confidence -> go', () => {
  const d = policy.settle(snapshot({ assessment: readyAssessment() }));
  assert.equal(d.decision, 'go');
  assert.deepEqual(d.reason_codes, ['GO_READY_AND_GROUNDED']);
});

test('D4 GO requires at least one non-empty Proposal.evidence_ref (P0 correction)', () => {
  // The advisor's evidence_grounding=sufficient is NOT enough: the Proposal
  // itself must carry at least one non-empty evidence_ref. Empty evidence ->
  // clarify / CLARIFY_EVIDENCE_INSUFFICIENT.
  const d = policy.settle(snapshot({
    assessment: readyAssessment(),
    proposalOverrides: { evidence_refs: [] },
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_EVIDENCE_INSUFFICIENT'), JSON.stringify(d.reason_codes));
});

test('D4 GO blocked by whitespace-only evidence_refs (P0 correction)', () => {
  const d = policy.settle(snapshot({
    assessment: readyAssessment(),
    proposalOverrides: { evidence_refs: ['   ', ''] },
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_EVIDENCE_INSUFFICIENT'), JSON.stringify(d.reason_codes));
});

// ---- CLARIFY path (§6.3) ---------------------------------------------------

test('D4 CLARIFY: worker go + readiness missing -> clarify (CLARIFY_READINESS_MISSING)', () => {
  const d = policy.settle(snapshot({ readinessKind: 'missing' }));
  assert.equal(d.decision, 'clarify');
  assert.deepEqual(d.reason_codes, ['CLARIFY_READINESS_MISSING']);
});

test('D4 CLARIFY: worker go + readiness failed -> clarify (CLARIFY_READINESS_FAILED)', () => {
  const d = policy.settle(snapshot({ readinessKind: 'failed' }));
  assert.equal(d.decision, 'clarify');
  assert.deepEqual(d.reason_codes, ['CLARIFY_READINESS_FAILED']);
});

test('D4 CLARIFY: worker go + conditionally_ready -> clarify', () => {
  const d = policy.settle(snapshot({
    assessment: readyAssessment({ overall_readiness: 'conditionally_ready' }),
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_CONDITIONALLY_READY'), JSON.stringify(d.reason_codes));
});

test('D4 CLARIFY: worker go + blocking gaps -> clarify (CLARIFY_BLOCKING_GAPS)', () => {
  const d = policy.settle(snapshot({
    assessment: readyAssessment({
      overall_readiness: 'conditionally_ready',
      blocking_gaps: [{ code: 'G1', description: 'gap', source_refs: ['proposal.problem_statement'] }],
    }),
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_BLOCKING_GAPS'), JSON.stringify(d.reason_codes));
});

test('D4 CLARIFY: worker go + evidence grounding insufficient -> clarify', () => {
  const assessment = readyAssessment({
    overall_readiness: 'conditionally_ready',
  });
  assessment.dimension_assessments.evidence_grounding = dim('insufficient');
  const d = policy.settle(snapshot({ assessment }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_EVIDENCE_INSUFFICIENT'), JSON.stringify(d.reason_codes));
});

test('D4 CLARIFY: worker go + confidence below threshold -> clarify (CLARIFY_LOW_CONFIDENCE)', () => {
  const d = policy.settle(snapshot({
    assessment: readyAssessment({ overall_readiness: 'conditionally_ready', confidence: 0.5 }),
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_LOW_CONFIDENCE'), JSON.stringify(d.reason_codes));
  assert.ok(0.5 < GO_MIN_CONFIDENCE);
});

test('D4 CLARIFY: worker clarify (regardless of readiness) -> clarify (CLARIFY_WORKER_REQUESTED)', () => {
  const d = policy.settle(snapshot({
    workerOutcome: 'clarify',
    assessment: readyAssessment(),
  }));
  assert.equal(d.decision, 'clarify');
  assert.deepEqual(d.reason_codes, ['CLARIFY_WORKER_REQUESTED']);
});

// ---- REJECT path (§6.2) ----------------------------------------------------

test('D4 REJECT: worker reject + not_ready + advisor reject + blocking gaps + confidence -> reject', () => {
  const assessment = readyAssessment({
    overall_readiness: 'not_ready',
    recommended_next_action: 'reject',
    confidence: 0.85,
    blocking_gaps: [{ code: 'G1', description: 'blocking', source_refs: ['proposal.problem_statement'] }],
  });
  const d = policy.settle(snapshot({ workerOutcome: 'reject', assessment }));
  assert.equal(d.decision, 'reject');
  assert.deepEqual(d.reason_codes, ['REJECT_WORKER_AND_ADVISOR_AGREE']);
});

test('D4 REJECT impossible without advisor agreement: worker reject + readiness inconclusive -> clarify', () => {
  const d = policy.settle(snapshot({
    workerOutcome: 'reject',
    assessment: readyAssessment({ overall_readiness: 'inconclusive', recommended_next_action: 'manual_review', confidence: 0.9 }),
  }));
  assert.equal(d.decision, 'clarify');
});

test('D4 REJECT impossible without advisor agreement: worker reject + advisor manual_review -> clarify (CLARIFY_MANUAL_REVIEW_RECOMMENDED)', () => {
  const d = policy.settle(snapshot({
    workerOutcome: 'reject',
    assessment: readyAssessment({
      overall_readiness: 'not_ready', recommended_next_action: 'manual_review', confidence: 0.9,
      blocking_gaps: [{ code: 'G1', description: 'g', source_refs: ['proposal.problem_statement'] }],
    }),
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_MANUAL_REVIEW_RECOMMENDED'), JSON.stringify(d.reason_codes));
});

test('D4 REJECT impossible when worker and advisor conflict: worker reject + advisor ready -> clarify', () => {
  const d = policy.settle(snapshot({
    workerOutcome: 'reject',
    assessment: readyAssessment(), // advisor says ready + proceed
  }));
  assert.equal(d.decision, 'clarify');
  // Worker rejects but advisor ready+proceed is a conflict.
  assert.ok(d.reason_codes.includes('CLARIFY_WORKER_ADVISOR_CONFLICT'), JSON.stringify(d.reason_codes));
});

// ---- additional fail-closed cases -----------------------------------------

test('D4 CLARIFY: worker go + advisor manual_review -> clarify (CLARIFY_MANUAL_REVIEW_RECOMMENDED)', () => {
  const d = policy.settle(snapshot({
    assessment: readyAssessment({ overall_readiness: 'conditionally_ready', recommended_next_action: 'manual_review' }),
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_MANUAL_REVIEW_RECOMMENDED'), JSON.stringify(d.reason_codes));
});

test('D4 CLARIFY: worker go + advisor repeat_discovery -> clarify', () => {
  const d = policy.settle(snapshot({
    assessment: readyAssessment({ overall_readiness: 'conditionally_ready', recommended_next_action: 'repeat_discovery' }),
  }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_REPEAT_DISCOVERY_RECOMMENDED'), JSON.stringify(d.reason_codes));
});

test('D4 CLARIFY: worker defer -> clarify (CLARIFY_POLICY_FALLBACK)', () => {
  const d = policy.settle(snapshot({
    workerOutcome: 'defer',
    assessment: readyAssessment(),
  }));
  assert.equal(d.decision, 'clarify');
  // defer/inconclusive/failed worker outcomes hit the catch-all.
  assert.ok(d.reason_codes.includes('CLARIFY_POLICY_FALLBACK'), JSON.stringify(d.reason_codes));
});

test('D4 policy: REJECT requires confidence >= REJECT_MIN_CONFIDENCE', () => {
  const assessment = readyAssessment({
    overall_readiness: 'not_ready',
    recommended_next_action: 'reject',
    confidence: 0.5, // below threshold
    blocking_gaps: [{ code: 'G1', description: 'g', source_refs: ['proposal.problem_statement'] }],
  });
  const d = policy.settle(snapshot({ workerOutcome: 'reject', assessment }));
  assert.equal(d.decision, 'clarify');
  assert.ok(d.reason_codes.includes('CLARIFY_LOW_CONFIDENCE'), JSON.stringify(d.reason_codes));
  assert.ok(0.5 < REJECT_MIN_CONFIDENCE);
});

test('D4 policy: rationale is non-empty and deterministic for equal reason codes', () => {
  const s = snapshot({ assessment: readyAssessment() });
  const d1 = policy.settle(s);
  const d2 = policy.settle(s);
  assert.ok(typeof d1.rationale === 'string' && d1.rationale.length > 0);
  assert.equal(d1.rationale, d2.rationale);
});

test('D4 policy: all OVERALL_READINESS values are handled without throwing', () => {
  for (const overall of OVERALL_READINESS_VALUES) {
    const assessment = readyAssessment({ overall_readiness: overall });
    const d = policy.settle(snapshot({ assessment }));
    assert.ok(['go', 'clarify', 'reject'].includes(d.decision), `${overall} produced ${d.decision}`);
  }
});

test('D4 policy: readiness paused -> clarify (CLARIFY_READINESS_PAUSED)', () => {
  const d = policy.settle(snapshot({ readinessKind: 'paused' }));
  assert.equal(d.decision, 'clarify');
  assert.deepEqual(d.reason_codes, ['CLARIFY_READINESS_PAUSED']);
});

test('D4 policy: POLICY_V1_MANIFEST is internally consistent with the rules (manifest integrity)', () => {
  // The policy hash is over the FULL manifest (incl. proposal_evidence_min,
  // fallback, reason-code mapping). Assert the manifest fields match the
  // actual rule behaviour so a silent rule change without a manifest change
  // is caught.
  assert.equal(POLICY_V1_MANIFEST.go.proposal_evidence_min, 1);
  assert.equal(POLICY_V1_MANIFEST.go.confidence_min, GO_MIN_CONFIDENCE);
  assert.equal(POLICY_V1_MANIFEST.reject.confidence_min, REJECT_MIN_CONFIDENCE);
  assert.equal(POLICY_V1_MANIFEST.fallback_decision, 'clarify');
  assert.equal(POLICY_V1_MANIFEST.reason_code_mapping_version, 1);
});
