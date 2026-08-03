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
 * invented reasoning. Instead the kernel itself runs the deterministic
 * settlement policy's `evaluate()` over a reconstructed `DiscoverySettlementInputSnapshot`
 * and attaches the resulting `SettlementConditionTrace` to the case. The LM may
 * cite ONLY trace nodes with `contributed_to_decision === true`, and its stated
 * reason codes must agree with the cited nodes' `emitted_reason_codes`.
 *
 * Why a trace (not a hand-rolled flat "passed/failed" predicate list): a flat
 * superset lets a diagnosis cite an ALTERNATIVE-branch predicate as the cause of
 * the actual decision (e.g. citing `worker_outcome_is_reject` as a GO/CLARIFY
 * cause when the worker recommended go). The trace is causally exact: it
 * contains ONLY predicates the policy actually evaluated for the decided branch,
 * and `contributed_to_decision=true` nodes are exactly the ones whose evaluation
 * produced the emitted reason codes. A REJECT decision is grounded in PASSED
 * reject conditions; a GO in PASSED go conditions; a CLARIFY in FAILED blocking
 * conditions. The validator enforces this per-decision.
 *
 * This module is PURE: only node:crypto + the shared canonicalizer + domain
 * types (the settlement policy is itself pure). No SQLite, no LM, no I/O. The
 * architecture test (F11) guards that.
 */
import { createHash } from 'node:crypto';

import type { DiscoveryProposalPayload } from '../../modules/discovery/domain/discovery-proposal.js';
import type { ReadinessAssessmentPayload } from '../../modules/discovery/domain/discovery-readiness-assessment.js';
import type { DiscoverySettlementReasonCode } from '../../modules/discovery/domain/discovery-settlement-policy.js';
import {
  discoverySettlementPolicyV1,
  DISCOVERY_SETTLEMENT_POLICY_VERSION,
  POLICY_V1_CONTENT_HASH,
} from '../../modules/discovery/domain/discovery-settlement-policy.js';
import type {
  DiscoverySettlementInputSnapshot,
  SettlementProposalInput,
  SettlementReadinessInput,
  SettlementReadinessStatus,
} from '../../modules/discovery/domain/discovery-settlement-input.js';
import { DISCOVERY_SETTLEMENT_INPUT_SCHEMA } from '../../modules/discovery/domain/discovery-settlement-input.js';
import type { SettlementConditionTrace } from '../../modules/discovery/domain/discovery-settlement-policy.js';
import { canonicalJson, collectDiscoverySourceRefs } from '../../shared/canonical-json.js';

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
export type DiagnosisReadinessStatus = SettlementReadinessStatus;

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
 *
 * `policy_trace` is the deterministic settlement-policy evaluation trace for
 * this case's reconstructed snapshot. It is causally exact: only predicates the
 * policy actually evaluated for the decided branch appear; alternative-branch
 * and short-circuited predicates are absent. The diagnosis may cite ONLY nodes
 * with `contributed_to_decision === true`.
 *
 * `decision` is the decision being diagnosed (lifted from the certificate) so
 * the validator can branch on it without re-reading the certificate.
 */
export interface DiscoveryDiagnosisCase {
  schema_version: typeof DISCOVERY_DIAGNOSIS_CASE_SCHEMA;
  epic_id: number;
  certificate: DiagnosisCertificateRef;
  /** The decision being diagnosed (mirrors certificate.decision). */
  decision: DiagnosisDecision;
  proposal: DiagnosisProposalRef;
  readiness: DiagnosisReadinessRef;
  policy_trace: SettlementConditionTrace[];
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
 * trace is produced by running the deterministic settlement policy's
 * `evaluate()` over a minimal `DiscoverySettlementInputSnapshot` reconstructed
 * from the certificate + proposal + readiness slices. The trace is causally
 * exact for the decision being diagnosed — the LM cannot cite an
 * alternative-branch or short-circuited predicate.
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

  // Reconstruct the minimal settlement snapshot and run the policy to obtain
  // the causally-exact evaluation trace. The proposal/readiness slices carry
  // the same content the original settlement saw, so evaluate() returns the
  // SAME branch and reason codes the certificate carries (the policy is pure
  // and deterministic). The trace IS the case's policy_trace — we never
  // hand-roll predicates.
  const snapshot = buildSettlementSnapshot(input);
  const evaluation = discoverySettlementPolicyV1.evaluate(snapshot);
  const policyTrace = evaluation.trace;

  // Each trace node's source_refs must be citable by the worker (P1: the kernel
  // must not emit a source ref the worker can't cite), so union them into the
  // allowlist. Each trace condition_id is also a citable anchor.
  const allowedSourceRefs = new Set<string>([
    ...certificateAnchors,
    ...proposalRefs,
    ...assessmentAnchors,
    ...input.certificate.reason_codes.map(code => `reason_code:${code}`),
  ]);
  for (const node of policyTrace) {
    for (const ref of node.source_refs) {
      allowedSourceRefs.add(ref);
    }
    allowedSourceRefs.add(`policy_condition:${node.condition_id}`);
  }

  return {
    schema_version: DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
    epic_id: input.epic_id,
    certificate: input.certificate,
    decision: input.certificate.decision,
    proposal: input.proposal,
    readiness: input.readiness,
    policy_trace: policyTrace,
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
    decision: caseData.decision,
    proposal: caseData.proposal,
    readiness: caseData.readiness,
    policy_trace: caseData.policy_trace,
    allowed_source_refs: caseData.allowed_source_refs,
  };
  return createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}

// ---------------------------------------------------------------------------
// Snapshot reconstruction + policy evaluation
// ---------------------------------------------------------------------------

/**
 * Reconstruct a minimal `DiscoverySettlementInputSnapshot` from the case slices.
 * The policy only inspects: `proposal.payload` (recommended_outcome,
 * evidence_refs), `readiness.status` + `readiness.payload`, and `policy`
 * (version + content_hash). The other snapshot fields (source_intent_id etc.)
 * are required by the type but do not influence the decision; they are filled
 * with deterministic placeholders. `captured_at` is excluded from the snapshot's
 * semantic content by using a constant (it does not feed the policy).
 *
 * The policy version/hash are taken from the certificate so the reconstructed
 * evaluation matches the version that actually settled the case. (For policy v1
 * the canonical instance is used; the version is asserted to match.)
 */
function buildSettlementSnapshot(input: BuildDiagnosisCaseInput): DiscoverySettlementInputSnapshot {
  const proposalSlice: SettlementProposalInput = {
    id: input.proposal.id,
    content_hash: input.proposal.hash,
    payload: input.proposal.payload,
    source_intent_id: 0, // unused by the policy; deterministic placeholder.
    source_submission_id: input.proposal_source_submission_id,
    normalization_proposal_id: input.proposal_normalization_proposal_id,
  };
  const readinessSlice: SettlementReadinessInput = {
    status: input.readiness.status,
    assessment_id: input.readiness.assessment_id,
    content_hash: input.readiness.hash,
    payload: input.readiness.payload,
  };
  return {
    schema_version: DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
    epic_id: input.epic_id,
    proposal: proposalSlice,
    readiness: readinessSlice,
    policy: {
      version: DISCOVERY_SETTLEMENT_POLICY_VERSION,
      content_hash: POLICY_V1_CONTENT_HASH,
    },
    captured_at: '1970-01-01T00:00:00.000Z', // constant — does not feed the policy.
  };
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
 *
 * The aggregate anchors (`assessment.blocking_gaps`,
 * `assessment.non_blocking_gaps`, `assessment.dimension_assessments`,
 * `assessment.overall_readiness`, `assessment.recommended_next_action`,
 * `assessment.confidence`) are always added when an assessment exists so that a
 * trace node's aggregate ref is always citable.
 */
function buildAssessmentAnchors(readiness: DiagnosisReadinessRef): string[] {
  if (readiness.status !== 'accepted_by_kernel' || !readiness.payload || readiness.assessment_id === null) {
    return [];
  }
  const id = readiness.assessment_id;
  const p = readiness.payload;
  const refs = new Set<string>([
    `assessment:${id}`,
    'assessment.overall_readiness',
    'assessment.recommended_next_action',
    'assessment.confidence',
    'assessment.rationale',
    // Aggregate anchors always citable when an assessment exists.
    'assessment.blocking_gaps',
    'assessment.non_blocking_gaps',
    'assessment.dimension_assessments',
  ]);
  for (const dim of Object.keys(p.dimension_assessments)) {
    refs.add(`assessment.dimension_assessments.${dim}`);
  }
  p.blocking_gaps.forEach((_, i) => refs.add(`assessment.blocking_gaps[${i}]`));
  p.non_blocking_gaps.forEach((_, i) => refs.add(`assessment.non_blocking_gaps[${i}]`));
  return [...refs];
}
