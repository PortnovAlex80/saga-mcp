/**
 * ReadinessAssessment — the typed payload a D3 shadow readiness-advisor worker
 * emits against an AssessDiscoveryReadiness ControlIntent.
 *
 * Roadmap D3. This is the SEMANTIC payload only: provenance is added by the
 * kernel, never by the advisor. A valid assessment classifies every required
 * dimension, cites a precise source reference for every claim, and provides a
 * bounded confidence in [0, 1].
 *
 * D3 is advisory and shadow-only: the assessment CANNOT change the discovery
 * outcome, replace the provisional authority, advance the stage, or settle.
 * The product Proposal remains provisional (worker_proposal or
 * normalized_worker_proposal). Only D4 settlement may make it authoritative.
 *
 * The advisor must NOT invent evidence. Every source_ref must resolve to an
 * explicitly allowed path or identifier from the canonical Proposal, the
 * immutable raw submission, the normalization lineage, or a supplied
 * read-only discovery context snapshot. Vague references like "the proposal"
 * or "context" are rejected.
 */

/**
 * Schema version for the readiness assessment payload. readiness_submit
 * rejects a submission whose schema_version does not match this exactly — the
 * kernel, not the advisor, owns the contract version.
 */
export const DISCOVERY_READINESS_ASSESSMENT_SCHEMA = 'saga3.discovery-readiness-assessment.v1';

/**
 * Top-level readiness classification of the whole Proposal. These are
 * BUSINESS verdicts about whether the Proposal is sufficiently grounded for
 * later settlement — they do NOT settle anything (D4 owns that).
 */
export type OverallReadiness =
  | 'ready'
  | 'conditionally_ready'
  | 'not_ready'
  | 'inconclusive';

export const OVERALL_READINESS_VALUES: readonly OverallReadiness[] = [
  'ready', 'conditionally_ready', 'not_ready', 'inconclusive',
];

/**
 * Per-dimension status. The advisor must classify every required dimension;
 * 'unknown' is an honest "I could not assess this" rather than a free pass.
 */
export type DimensionStatus = 'sufficient' | 'partial' | 'insufficient' | 'unknown';

export const DIMENSION_STATUS_VALUES: readonly DimensionStatus[] = [
  'sufficient', 'partial', 'insufficient', 'unknown',
];

/**
 * The seven required readiness dimensions (roadmap D3 domain model). Every
 * assessment MUST classify all seven. Missing any dimension is a validation
 * error — the kernel rejects it without producing an accepted assessment.
 */
export const READINESS_DIMENSIONS = [
  'problem_clarity',
  'scope_boundedness',
  'stakeholder_coverage',
  'assumption_visibility',
  'unknowns_manageability',
  'risk_visibility',
  'evidence_grounding',
] as const;

export type ReadinessDimension = typeof READINESS_DIMENSIONS[number];

export interface DimensionAssessment {
  status: DimensionStatus;
  rationale: string;
  source_refs: string[];
}

/**
 * A gap the advisor identified. `blocking_gaps` argue against proceeding to
 * settlement; `non_blocking_gaps` are concerns that do not block. Both must
 * carry a stable `code` (advisor-chosen, non-empty, unique within its list)
 * so a human/D4 can reference them deterministically.
 */
export interface ReadinessGap {
  code: string;
  description: string;
  source_refs: string[];
}

/**
 * Recommended next action. The advisor PROPOSES this; the kernel records it
 * in the shadow section of OrchestrationRunResult but never acts on it. It
 * does not trigger stage transition, repeat discovery, or settlement.
 */
export type RecommendedNextAction =
  | 'proceed_to_settlement'
  | 'request_clarification'
  | 'repeat_discovery'
  | 'defer'
  | 'reject'
  | 'manual_review';

export const RECOMMENDED_NEXT_ACTION_VALUES: readonly RecommendedNextAction[] = [
  'proceed_to_settlement', 'request_clarification', 'repeat_discovery',
  'defer', 'reject', 'manual_review',
];

/** Typed readiness assessment payload (roadmap D3). */
export interface ReadinessAssessmentPayload {
  proposal_id: number;
  proposal_content_hash: string;
  overall_readiness: OverallReadiness;
  dimension_assessments: Record<ReadinessDimension, DimensionAssessment>;
  blocking_gaps: ReadinessGap[];
  non_blocking_gaps: ReadinessGap[];
  recommended_next_action: RecommendedNextAction;
  confidence: number;
  rationale: string;
}

/** Result of validating a readiness assessment payload. */
export interface ReadinessAssessmentValidation {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isAllowedSourceRef(ref: string, allowed: ReadonlySet<string>): boolean {
  // Reject empty/whitespace-only references — "the proposal" / "context"
  // cannot be a valid source identifier.
  if (typeof ref !== 'string' || ref.trim() === '') return false;
  return allowed.has(ref);
}

/**
 * Deterministic, schema-level validation of a readiness assessment payload.
 *
 * D3 does structural + semantic validation with no LM call. The kernel must
 * be able to reject a malformed or evidence-inventing assessment without any
 * advisor involvement. `allowedSourceRefs` is the exact set of source
 * identifiers the advisor is permitted to cite (fields of the canonical
 * Proposal, its evidence_refs, raw/normalization submission identifiers, and
 * any explicitly supplied discovery-context snapshot identifiers) — anything
 * outside it is treated as invented evidence and rejected.
 *
 * `expectedProposalId` and `expectedProposalHash` bind the assessment to one
 * immutable Proposal version: a changed content hash is a new assessment
 * target and must not reuse an assessment created for another hash.
 */
export function validateReadinessAssessment(
  payload: unknown,
  expectedProposalId: number,
  expectedProposalHash: string,
  allowedSourceRefs: readonly string[],
): ReadinessAssessmentValidation {
  const errors: string[] = [];
  if (!isRecord(payload)) {
    return { valid: false, errors: ['assessment must be a JSON object'] };
  }

  // Identity binding to the immutable Proposal version.
  if (!Number.isInteger(payload.proposal_id)) {
    errors.push('field \'proposal_id\' must be an integer');
  } else if (payload.proposal_id !== expectedProposalId) {
    errors.push(`field 'proposal_id' must be ${expectedProposalId}, got ${payload.proposal_id}`);
  }
  if (typeof payload.proposal_content_hash !== 'string'
      || !/^[0-9a-f]{64}$/.test(payload.proposal_content_hash)) {
    errors.push('field \'proposal_content_hash\' must be a lowercase SHA-256 hex string');
  } else if (payload.proposal_content_hash !== expectedProposalHash) {
    errors.push('field \'proposal_content_hash\' does not match the stored Proposal');
  }

  // overall_readiness enum.
  if (typeof payload.overall_readiness !== 'string'
      || !OVERALL_READINESS_VALUES.includes(payload.overall_readiness as OverallReadiness)) {
    errors.push(
      `field 'overall_readiness' must be one of [${OVERALL_READINESS_VALUES.join(', ')}]`,
    );
  }

  // recommended_next_action enum.
  if (typeof payload.recommended_next_action !== 'string'
      || !RECOMMENDED_NEXT_ACTION_VALUES.includes(
        payload.recommended_next_action as RecommendedNextAction,
      )) {
    errors.push(
      `field 'recommended_next_action' must be one of [${RECOMMENDED_NEXT_ACTION_VALUES.join(', ')}]`,
    );
  }

  // confidence: finite, in [0, 1].
  if (typeof payload.confidence !== 'number'
      || !Number.isFinite(payload.confidence)
      || payload.confidence < 0
      || payload.confidence > 1) {
    errors.push('field \'confidence\' must be a finite number in [0, 1]');
  }

  // rationale: non-empty string.
  if (typeof payload.rationale !== 'string' || payload.rationale.trim() === '') {
    errors.push('field \'rationale\' must be a non-empty string');
  }

  // dimension_assessments: complete set, each well-formed.
  const dims = payload.dimension_assessments;
  if (!isRecord(dims)) {
    errors.push('field \'dimension_assessments\' must be an object');
  } else {
    for (const dimension of READINESS_DIMENSIONS) {
      const d = dims[dimension];
      if (!isRecord(d)) {
        errors.push(`dimension_assessments.${dimension} must be an object`);
        continue;
      }
      if (typeof d.status !== 'string'
          || !DIMENSION_STATUS_VALUES.includes(d.status as DimensionStatus)) {
        errors.push(
          `dimension_assessments.${dimension}.status must be one of [${DIMENSION_STATUS_VALUES.join(', ')}]`,
        );
      }
      if (typeof d.rationale !== 'string' || d.rationale.trim() === '') {
        errors.push(`dimension_assessments.${dimension}.rationale must be a non-empty string`);
      }
      if (!isStringArray(d.source_refs)) {
        errors.push(`dimension_assessments.${dimension}.source_refs must be an array of strings`);
      } else if (d.source_refs.length === 0) {
        // P1-1: grounding requires at least one cited source per dimension. An
        // empty array passes the type check but asserts nothing — that would
        // accept a fully ungrounded assessment.
        errors.push(`dimension_assessments.${dimension}.source_refs must cite at least one source`);
      }
    }
    // Reject unknown dimensions — the contract is exactly the seven required.
    for (const key of Object.keys(dims)) {
      if (!READINESS_DIMENSIONS.includes(key as ReadinessDimension)) {
        errors.push(`dimension_assessments has unknown dimension '${key}'`);
      }
    }
  }

  // blocking_gaps / non_blocking_gaps: well-formed + unique codes.
  const validateGapList = (value: unknown, field: string): void => {
    if (!Array.isArray(value)) {
      errors.push(`field '${field}' must be an array`);
      return;
    }
    const seenCodes = new Set<string>();
    value.forEach((gap, index) => {
      if (!isRecord(gap)) {
        errors.push(`${field}[${index}] must be an object`);
        return;
      }
      if (typeof gap.code !== 'string' || gap.code.trim() === '') {
        errors.push(`${field}[${index}].code must be a non-empty string`);
      } else if (seenCodes.has(gap.code)) {
        errors.push(`${field}[${index}].code is a duplicate ('${gap.code}')`);
      } else {
        seenCodes.add(gap.code);
      }
      if (typeof gap.description !== 'string' || gap.description.trim() === '') {
        errors.push(`${field}[${index}].description must be a non-empty string`);
      }
      if (!isStringArray(gap.source_refs)) {
        errors.push(`${field}[${index}].source_refs must be an array of strings`);
      } else if (gap.source_refs.length === 0) {
        // P1-1: a gap must be grounded — cite at least one source.
        errors.push(`${field}[${index}].source_refs must cite at least one source`);
      }
    });
  };
  validateGapList(payload.blocking_gaps, 'blocking_gaps');
  validateGapList(payload.non_blocking_gaps, 'non_blocking_gaps');
  // Codes must also be unique ACROSS the two lists — a code cannot be both
  // blocking and non-blocking.
  const blockingCodes = new Set<string>();
  if (Array.isArray(payload.blocking_gaps)) {
    for (const g of payload.blocking_gaps as unknown[]) {
      if (isRecord(g) && typeof g.code === 'string') blockingCodes.add(g.code);
    }
  }
  if (Array.isArray(payload.non_blocking_gaps)) {
    for (const g of payload.non_blocking_gaps as unknown[]) {
      if (isRecord(g) && typeof g.code === 'string' && blockingCodes.has(g.code)) {
        errors.push(`gap code '${g.code}' appears in both blocking_gaps and non_blocking_gaps`);
      }
    }
  }

  // Anti-invent-evidence: every source_ref must resolve to an allowed
  // identifier. This runs last so structural errors are reported first.
  const allowed = new Set(allowedSourceRefs);
  const checkRefs = (value: unknown, field: string): void => {
    if (!isRecord(value)) return;
    const refs = value.source_refs;
    if (!isStringArray(refs)) return;
    for (const ref of refs) {
      if (!isAllowedSourceRef(ref, allowed)) {
        errors.push(`${field} cites an unresolved source reference '${ref}'`);
      }
    }
  };
  if (isRecord(dims)) {
    for (const dimension of READINESS_DIMENSIONS) {
      checkRefs(dims[dimension], `dimension_assessments.${dimension}`);
    }
  }
  if (Array.isArray(payload.blocking_gaps)) {
    payload.blocking_gaps.forEach((g, i) => checkRefs(g, `blocking_gaps[${i}]`));
  }
  if (Array.isArray(payload.non_blocking_gaps)) {
    payload.non_blocking_gaps.forEach((g, i) => checkRefs(g, `non_blocking_gaps[${i}]`));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The readiness verdict projected into the shadow section of
 * OrchestrationRunResult. This is read-only visibility — it never feeds back
 * into outcome/outcomeAuthority/scopeCompleted.
 */
export interface ReadinessShadowResult {
  status: 'completed' | 'not_run' | 'failed' | 'paused';
  authority: 'shadow_advisor' | 'none';
  assessmentId: number | null;
  assessmentHash: string | null;
  overallReadiness: OverallReadiness | null;
  recommendedNextAction: RecommendedNextAction | null;
  error: string | null;
}
