/**
 * DiscoveryDiagnosisCase — the IMMUTABLE, deterministic input bundle the kernel
 * builds BEFORE invoking the D5 diagnosis LM worker.
 *
 * Roadmap D5, §5. Core principle:
 *
 *   LM proposes. Advisor assesses. Kernel settles. Certificate proves.
 *   Diagnosis explains.
 *
 * The diagnosis worker is ADVISORY ONLY (invariant I2). It may never change the
 * outcome, the certificate, or the stage. To keep it grounded, the kernel does
 * not hand the LM the raw inputs and ask "why did this happen?" — that invites
 * invented reasoning. Instead the kernel itself decomposes the settled decision
 * into a list of `DiagnosisPolicyCondition` predicates, each marked
 * passed/failed/not_applicable with the exact observed value and the reason
 * code it maps to. The LM then writes a diagnosis report that MUST cite these
 * conditions (via `failed_condition_ids`) and the allowlisted source refs.
 *
 * This module is PURE: only node:crypto + the shared canonicalizer + domain
 * types. No SQLite, no LM, no I/O. The architecture test (F11) guards that.
 */
import { createHash } from 'node:crypto';

import type { DiscoveryProposalPayload } from './discovery-proposal.js';
import type { ReadinessAssessmentPayload } from './discovery-readiness-assessment.js';
import type { DiscoverySettlementReasonCode } from './discovery-settlement-policy.js';
import {
  GO_MIN_CONFIDENCE,
  REJECT_MIN_CONFIDENCE,
} from './discovery-settlement-policy.js';
import { canonicalJson, collectDiscoverySourceRefs } from '../shared/discovery-canonical.js';

/** Schema version for the diagnosis case. */
export const DISCOVERY_DIAGNOSIS_CASE_SCHEMA = 'saga3.discovery-diagnosis-case.v1';

/**
 * Contract version for the diagnosis worker's output. Bumping it is a new
 * diagnosis target (new ControlIntent, new report); old reports stay immutable.
 * Recorded on the ControlIntent and on every report row.
 */
export const DISCOVERY_DIAGNOSIS_CONTRACT_VERSION = 'saga3.discovery-diagnosis.v1';

/** The settled decision being diagnosed (lifted verbatim from the certificate). */
export type DiagnosisDecision = 'go' | 'clarify' | 'reject';

/**
 * Readiness state as captured into the case. Mirrors the settlement snapshot's
 * readiness slice (D4): the kernel-relevant states, not the D3 shadow statuses.
 * When no accepted assessment exists, status is missing/failed/paused and the
 * payload/assessment_id/hash are null.
 */
export type DiagnosisReadinessStatus =
  | 'accepted_by_kernel'
  | 'missing'
  | 'failed'
  | 'paused';

/**
 * A single deterministic predicate the kernel derived from the settled inputs.
 * The LM does NOT compute these — it receives them and may only reference them.
 *
 *   - 'passed':           the observed value satisfied the policy requirement.
 *   - 'failed':           it did not; this condition contributed to a non-GO
 *                          decision (or would have, for a reject precondition).
 *   - 'not_applicable':   the condition could not be evaluated (e.g. an
 *                          assessment-based predicate when no assessment exists).
 *
 * `reason_code` is the settlement reason code this condition maps to when it
 * FAILS (null when the condition is a reject/GO precondition that does not
 * itself emit a clarify code). `source_refs` point to where the observed value
 * came from, drawn from the case's allowlist.
 */
export interface DiagnosisPolicyCondition {
  condition_id: string;
  required_value: unknown;
  observed_value: unknown;
  result: 'passed' | 'failed' | 'not_applicable';
  reason_code: DiscoverySettlementReasonCode | null;
  source_refs: string[];
}

/** The certificate slice lifted into the case (verbatim from D4). */
export interface DiagnosisCertificateRef {
  id: number;
  hash: string;
  decision: DiagnosisDecision;
  reason_codes: DiscoverySettlementReasonCode[];
  policy_version: string;
  policy_hash: string;
  settlement_id: number;
  settlement_input_hash: string;
}

/** The proposal slice carried into the case. */
export interface DiagnosisProposalRef {
  id: number;
  hash: string;
  payload: DiscoveryProposalPayload;
}

/** The readiness slice carried into the case (payload null when not accepted). */
export interface DiagnosisReadinessRef {
  status: DiagnosisReadinessStatus;
  assessment_id: number | null;
  hash: string | null;
  payload: ReadinessAssessmentPayload | null;
}

/**
 * The immutable diagnosis case. Everything the worker may reason over is here;
 * nothing else is available. `captured_at` is informational only — it is
 * EXCLUDED from `diagnosisCaseHash` so two cases over identical inputs produce
 * the same hash (invariant I7: restart idempotency).
 */
export interface DiscoveryDiagnosisCase {
  schema_version: typeof DISCOVERY_DIAGNOSIS_CASE_SCHEMA;
  epic_id: number;
  certificate: DiagnosisCertificateRef;
  proposal: DiagnosisProposalRef;
  readiness: DiagnosisReadinessRef;
  policy_conditions: DiagnosisPolicyCondition[];
  allowed_source_refs: string[];
  captured_at: string; // ISO 8601 — informational, not in the semantic hash
}

/** Inputs to `buildDiagnosisCase`. The caller (diagnosis service) supplies the
 * verified certificate + settlement snapshot slices. */
export interface BuildDiagnosisCaseInput {
  epic_id: number;
  certificate: DiagnosisCertificateRef;
  proposal: DiagnosisProposalRef;
  readiness: DiagnosisReadinessRef;
  /** Lineage identifiers needed to build the proposal source-ref allowlist. */
  proposal_source_submission_id: number | null;
  proposal_normalization_proposal_id: number | null;
  captured_at?: string;
}

/**
 * Build the immutable diagnosis case. PURE: no I/O, no randomness. The policy
 * conditions are derived deterministically from the settled inputs — the LM
 * never guesses which condition failed.
 */
export function buildDiagnosisCase(input: BuildDiagnosisCaseInput): DiscoveryDiagnosisCase {
  const proposalId = input.proposal.id;
  const proposalPayload = input.proposal.payload;

  const proposalRefs = collectDiscoverySourceRefs(
    {
      proposalId,
      sourceSubmissionId: input.proposal_source_submission_id,
      normalizationProposalId: input.proposal_normalization_proposal_id,
    },
    proposalPayload,
  );

  const certificateAnchors = buildCertificateAnchors(input.certificate);
  const assessmentAnchors = buildAssessmentAnchors(input.readiness);

  const allowedSourceRefs = dedupeSorted([
    ...certificateAnchors,
    ...proposalRefs,
    ...assessmentAnchors,
    ...input.certificate.reason_codes.map(code => `reason_code:${code}`),
    // policy_condition anchors are added after conditions are built (below).
  ]);

  const policyConditions = buildPolicyConditions(
    input.certificate,
    input.proposal,
    input.readiness,
  );
  // Each condition id is itself a citable source ref.
  for (const cond of policyConditions) {
    allowedSourceRefs.add(`policy_condition:${cond.condition_id}`);
  }

  return {
    schema_version: DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
    epic_id: input.epic_id,
    certificate: input.certificate,
    proposal: input.proposal,
    readiness: input.readiness,
    policy_conditions: policyConditions,
    allowed_source_refs: [...allowedSourceRefs].sort(),
    captured_at: input.captured_at ?? new Date().toISOString(),
  };
}

/**
 * Deterministic SHA-256 over the canonical JSON of the case, EXCLUDING
 * `captured_at`. Two cases over identical certificate+proposal+readiness+policy
 * produce the same hash regardless of when they were captured (invariant I7).
 * A changed certificate hash (or any other input) changes this hash (A6).
 */
export function diagnosisCaseHash(caseData: DiscoveryDiagnosisCase): string {
  const semantic: Omit<DiscoveryDiagnosisCase, 'captured_at'> = {
    schema_version: caseData.schema_version,
    epic_id: caseData.epic_id,
    certificate: caseData.certificate,
    proposal: caseData.proposal,
    readiness: caseData.readiness,
    policy_conditions: caseData.policy_conditions,
    allowed_source_refs: caseData.allowed_source_refs,
  };
  return createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}

// ---------------------------------------------------------------------------
// Source-ref allowlist helpers
// ---------------------------------------------------------------------------

/** Certificate-level source anchors. */
function buildCertificateAnchors(cert: DiagnosisCertificateRef): string[] {
  return [
    `certificate:${cert.id}`,
    `settlement:${cert.settlement_id}`,
  ];
}

/**
 * Readiness-assessment source anchors. Only emitted when an accepted assessment
 * is present — a missing/failed/paused readiness contributes no assessment refs
 * (the worker may not cite fields of an assessment that does not exist).
 */
function buildAssessmentAnchors(readiness: DiagnosisReadinessRef): string[] {
  if (readiness.status !== 'accepted_by_kernel' || !readiness.payload || readiness.assessment_id === null) {
    return [];
  }
  const id = readiness.assessment_id;
  const p = readiness.payload;
  const refs = new Set<string>([
    `assessment:${id}`,
    `assessment.overall_readiness`,
    `assessment.recommended_next_action`,
    `assessment.confidence`,
    `assessment.rationale`,
  ]);
  for (const dim of Object.keys(p.dimension_assessments)) {
    refs.add(`assessment.dimension_assessments.${dim}`);
  }
  p.blocking_gaps.forEach((_, i) => refs.add(`assessment.blocking_gaps[${i}]`));
  p.non_blocking_gaps.forEach((_, i) => refs.add(`assessment.non_blocking_gaps[${i}]`));
  return [...refs];
}

function dedupeSorted(items: string[]): Set<string> {
  return new Set(items);
}

// ---------------------------------------------------------------------------
// Policy-condition decomposition
// ---------------------------------------------------------------------------

/**
 * The fixed condition set. Each entry knows how to evaluate itself against the
 * settled inputs and which reason code (if any) it maps to on failure.
 *
 * The condition list is a SUPERSET: for any given decision some conditions are
 * `not_applicable` (e.g. an assessment-based predicate when no assessment
 * exists, or a reject precondition under a GO certificate). The LM sees the
 * full picture and cites the failed ones.
 */
interface ConditionSpec {
  condition_id: string;
  reason_code: DiscoverySettlementReasonCode | null;
  build(
    ctx: ConditionContext,
  ): { required_value: unknown; observed_value: unknown; result: DiagnosisPolicyCondition['result']; source_refs: string[] };
}

interface ConditionContext {
  cert: DiagnosisCertificateRef;
  proposal: DiagnosisProposalRef;
  readiness: DiagnosisReadinessRef;
}

const HAS_ASSESSMENT = (r: DiagnosisReadinessRef): boolean =>
  r.status === 'accepted_by_kernel' && r.payload !== null && r.assessment_id !== null;

const GO_CONDITIONS: ConditionSpec[] = [
  {
    condition_id: 'worker_outcome_is_go',
    reason_code: 'CLARIFY_WORKER_REQUESTED',
    build(ctx) {
      const observed = ctx.proposal.payload.recommended_outcome;
      return {
        required_value: 'go',
        observed_value: observed,
        result: observed === 'go' ? 'passed' : 'failed',
        source_refs: [`proposal:${ctx.proposal.id}`, '$.recommended_outcome'],
      };
    },
  },
  {
    condition_id: 'proposal_evidence_present',
    reason_code: 'CLARIFY_EVIDENCE_INSUFFICIENT',
    build(ctx) {
      const refs = ctx.proposal.payload.evidence_refs;
      const has = Array.isArray(refs) && refs.some(r => typeof r === 'string' && r.trim().length > 0);
      return {
        required_value: true,
        observed_value: has,
        result: has ? 'passed' : 'failed',
        source_refs: [`proposal:${ctx.proposal.id}`, '$.evidence_refs'],
      };
    },
  },
  {
    condition_id: 'readiness_accepted',
    reason_code: 'CLARIFY_READINESS_MISSING',
    build(ctx) {
      const status = ctx.readiness.status;
      // The exact reason code (failed/paused/missing) is refined by
      // buildPolicyConditions via READINESS_ACCEPTED_CODE; the spec's static
      // reason_code is the canonical 'missing' default.
      return {
        required_value: 'accepted_by_kernel',
        observed_value: status,
        result: status === 'accepted_by_kernel' ? 'passed' : 'failed',
        source_refs: [`settlement:${ctx.cert.settlement_id}`],
      };
    },
  },
  {
    condition_id: 'overall_readiness_ready',
    reason_code: 'CLARIFY_CONDITIONALLY_READY',
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: 'ready', observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const observed = ctx.readiness.payload!.overall_readiness;
      return {
        required_value: 'ready',
        observed_value: observed,
        result: observed === 'ready' ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.overall_readiness'],
      };
    },
  },
  {
    condition_id: 'no_blocking_gaps',
    reason_code: 'CLARIFY_BLOCKING_GAPS',
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: true, observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const gaps = ctx.readiness.payload!.blocking_gaps;
      const none = gaps.length === 0;
      return {
        required_value: true,
        observed_value: none,
        result: none ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.blocking_gaps'],
      };
    },
  },
  {
    condition_id: 'evidence_grounding_sufficient',
    reason_code: 'CLARIFY_EVIDENCE_INSUFFICIENT',
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: 'sufficient', observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const observed = ctx.readiness.payload!.dimension_assessments.evidence_grounding.status;
      return {
        required_value: 'sufficient',
        observed_value: observed,
        result: observed === 'sufficient' ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.dimension_assessments.evidence_grounding'],
      };
    },
  },
  {
    condition_id: 'recommended_action_proceed',
    reason_code: 'CLARIFY_MANUAL_REVIEW_RECOMMENDED',
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: 'proceed_to_settlement', observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const observed = ctx.readiness.payload!.recommended_next_action;
      return {
        required_value: 'proceed_to_settlement',
        observed_value: observed,
        result: observed === 'proceed_to_settlement' ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.recommended_next_action'],
      };
    },
  },
  {
    condition_id: 'confidence_above_go_threshold',
    reason_code: 'CLARIFY_LOW_CONFIDENCE',
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: GO_MIN_CONFIDENCE, observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const observed = ctx.readiness.payload!.confidence;
      return {
        required_value: GO_MIN_CONFIDENCE,
        observed_value: observed,
        result: observed >= GO_MIN_CONFIDENCE ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.confidence'],
      };
    },
  },
];

const REJECT_CONDITIONS: ConditionSpec[] = [
  {
    condition_id: 'worker_outcome_is_reject',
    reason_code: null,
    build(ctx) {
      const observed = ctx.proposal.payload.recommended_outcome;
      return {
        required_value: 'reject',
        observed_value: observed,
        result: observed === 'reject' ? 'passed' : 'failed',
        source_refs: [`proposal:${ctx.proposal.id}`, '$.recommended_outcome'],
      };
    },
  },
  {
    condition_id: 'overall_readiness_not_ready',
    reason_code: null,
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: 'not_ready', observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const observed = ctx.readiness.payload!.overall_readiness;
      return {
        required_value: 'not_ready',
        observed_value: observed,
        result: observed === 'not_ready' ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.overall_readiness'],
      };
    },
  },
  {
    condition_id: 'recommended_action_reject',
    reason_code: null,
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: 'reject', observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const observed = ctx.readiness.payload!.recommended_next_action;
      return {
        required_value: 'reject',
        observed_value: observed,
        result: observed === 'reject' ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.recommended_next_action'],
      };
    },
  },
  {
    condition_id: 'blocking_gaps_present',
    reason_code: null,
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: 1, observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const count = ctx.readiness.payload!.blocking_gaps.length;
      return {
        required_value: 1,
        observed_value: count,
        result: count >= 1 ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.blocking_gaps'],
      };
    },
  },
  {
    condition_id: 'each_blocking_gap_has_source_refs',
    reason_code: null,
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: true, observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const gaps = ctx.readiness.payload!.blocking_gaps;
      const all = gaps.length > 0 && gaps.every(g => Array.isArray(g.source_refs) && g.source_refs.length > 0);
      return {
        required_value: true,
        observed_value: all,
        result: gaps.length === 0 ? 'not_applicable' : all ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.blocking_gaps'],
      };
    },
  },
  {
    condition_id: 'confidence_above_reject_threshold',
    reason_code: null,
    build(ctx) {
      if (!HAS_ASSESSMENT(ctx.readiness)) {
        return { required_value: REJECT_MIN_CONFIDENCE, observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
      }
      const observed = ctx.readiness.payload!.confidence;
      return {
        required_value: REJECT_MIN_CONFIDENCE,
        observed_value: observed,
        result: observed >= REJECT_MIN_CONFIDENCE ? 'passed' : 'failed',
        source_refs: [`assessment:${ctx.readiness.assessment_id}`, 'assessment.confidence'],
      };
    },
  },
];

/**
 * Worker/advisor directional agreement. Passed when the worker outcome and the
 * advisor's recommended_next_action point the same way (both go, both reject,
 * or the worker asks clarify and the advisor does not flatly reject). Failed
 * (→ CLARIFY_WORKER_ADVISOR_CONFLICT) when they disagree materially.
 */
const AGREEMENT_CONDITION: ConditionSpec = {
  condition_id: 'worker_advisor_agreement',
  reason_code: 'CLARIFY_WORKER_ADVISOR_CONFLICT',
  build(ctx) {
    const worker = ctx.proposal.payload.recommended_outcome;
    if (!HAS_ASSESSMENT(ctx.readiness)) {
      return { required_value: true, observed_value: null, result: 'not_applicable', source_refs: [`settlement:${ctx.cert.settlement_id}`] };
    }
    const advisorAction = ctx.readiness.payload!.recommended_next_action;
    const advisorOverall = ctx.readiness.payload!.overall_readiness;
    let agree = true;
    if (worker === 'go' && (advisorOverall === 'not_ready' && advisorAction !== 'manual_review')) agree = false;
    if (worker === 'reject' && !(advisorOverall === 'not_ready' && advisorAction === 'reject')) agree = false;
    return {
      required_value: true,
      observed_value: agree,
      result: agree ? 'passed' : 'failed',
      source_refs: [`proposal:${ctx.proposal.id}`, '$.recommended_outcome', `assessment:${ctx.readiness.assessment_id}`, 'assessment.recommended_next_action'],
    };
  },
};

const ALL_CONDITION_SPECS: ConditionSpec[] = [...GO_CONDITIONS, ...REJECT_CONDITIONS, AGREEMENT_CONDITION];

/**
 * Per readiness-status reason-code override for `readiness_accepted`. The spec's
 * static reason_code is the canonical 'missing' code; the actual non-accepted
 * status selects the precise code (failed/paused/missing) the settlement would
 * emit, so the diagnosis cites the same code the certificate carries.
 */
const READINESS_ACCEPTED_CODE: Record<DiagnosisReadinessStatus, DiscoverySettlementReasonCode> = {
  accepted_by_kernel: 'CLARIFY_READINESS_MISSING',
  failed: 'CLARIFY_READINESS_FAILED',
  paused: 'CLARIFY_READINESS_PAUSED',
  missing: 'CLARIFY_READINESS_MISSING',
};

/** Per overall_readiness override for `overall_readiness_ready`. */
function overallReadinessCode(overall: string): DiscoverySettlementReasonCode {
  if (overall === 'inconclusive') return 'CLARIFY_READINESS_INCONCLUSIVE';
  if (overall === 'conditionally_ready') return 'CLARIFY_CONDITIONALLY_READY';
  return 'CLARIFY_CONDITIONALLY_READY';
}

/** Per recommended_next_action override for `recommended_action_proceed`. */
function recommendedActionCode(action: string): DiscoverySettlementReasonCode {
  if (action === 'manual_review') return 'CLARIFY_MANUAL_REVIEW_RECOMMENDED';
  if (action === 'repeat_discovery') return 'CLARIFY_REPEAT_DISCOVERY_RECOMMENDED';
  return 'CLARIFY_MANUAL_REVIEW_RECOMMENDED';
}

/**
 * Evaluate the full condition set against the settled inputs and produce the
 * deterministic predicate list. The reason_code on each condition is refined to
 * match the EXACT code the settlement policy would emit for that observed value,
 * so the diagnosis's `failed_condition_ids` and the certificate's reason_codes
 * stay consistent.
 */
function buildPolicyConditions(
  cert: DiagnosisCertificateRef,
  proposal: DiagnosisProposalRef,
  readiness: DiagnosisReadinessRef,
): DiagnosisPolicyCondition[] {
  const ctx: ConditionContext = { cert, proposal, readiness };
  const conditions: DiagnosisPolicyCondition[] = [];
  for (const spec of ALL_CONDITION_SPECS) {
    const built = spec.build(ctx);
    let reasonCode = spec.reason_code;
    // Refine the reason code to the exact observed value where the spec is
    // status/value-dependent. Only meaningful when the condition failed.
    if (built.result === 'failed') {
      if (spec.condition_id === 'readiness_accepted' && readiness.status !== 'accepted_by_kernel') {
        reasonCode = READINESS_ACCEPTED_CODE[readiness.status];
      } else if (spec.condition_id === 'overall_readiness_ready' && HAS_ASSESSMENT(readiness)) {
        reasonCode = overallReadinessCode(readiness.payload!.overall_readiness);
      } else if (spec.condition_id === 'recommended_action_proceed' && HAS_ASSESSMENT(readiness)) {
        reasonCode = recommendedActionCode(readiness.payload!.recommended_next_action);
      }
    } else if (built.result === 'passed' || built.result === 'not_applicable') {
      // A passing/NA condition does not carry a reason code into the diagnosis.
      reasonCode = null;
    }
    conditions.push({
      condition_id: spec.condition_id,
      required_value: built.required_value,
      observed_value: built.observed_value,
      result: built.result,
      reason_code: reasonCode,
      source_refs: built.source_refs,
    });
  }
  return conditions;
}
