/**
 * Durable record types for D4 authoritative discovery settlement.
 *
 * These mirror the D2/D3 record shape (roadmap D4 persistence): a settlement
 * row binds the immutable settlement INPUT snapshot (proposal hash +
 * readiness hash + policy version/hash) to a deterministic decision; an
 * outcome certificate row is the immutable proof of that decision. The
 * settlement is kernel-only — there is no LM WorkIntent and no worker task for
 * settlement. Provisional Proposal provenance is SEPARATE from the settlement
 * lineage; nothing here mutates the original Proposal or readiness assessment.
 */
import type {
  DiscoverySettlementReasonCode,
} from './discovery-settlement-policy.js';

/**
 * Lifecycle of a settlement row.
 *   - 'computed':           the policy decided, but no certificate has been
 *                            issued yet (transient during the settle flow).
 *   - 'certificate_issued': an immutable certificate exists for this
 *                            settlement. Terminal success state.
 *   - 'failed':             the settlement infrastructure errored before a
 *                            certificate could be issued. A failed settlement
 *                            means Discovery Edition did NOT complete
 *                            authoritatively (unlike D3 shadow).
 */
export type SettlementStatus = 'computed' | 'certificate_issued' | 'failed';

/**
 * The authoritative decision recorded in a settlement / certificate. This is
 * the subset of DiscoveryOutcome the policy may emit (defer/inconclusive/failed
 * worker outcomes all collapse to clarify).
 */
export type SettlementDecision = 'go' | 'clarify' | 'reject';

/** Durable settlement row. */
export interface SettlementRecord {
  id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  readiness_assessment_id: number | null;
  /** Sentinel 'none' when no accepted assessment exists (see NO_READINESS_HASH). */
  readiness_assessment_hash: string;
  policy_version: string;
  policy_hash: string;
  /** Canonical-JSON text of the immutable input snapshot. */
  input_snapshot: string;
  input_hash: string;
  decision: SettlementDecision;
  reason_codes: DiscoverySettlementReasonCode[];
  rationale: string;
  status: SettlementStatus;
  created_at: string;
}

/** Durable, immutable outcome certificate row. */
export interface OutcomeCertificateRecord {
  id: number;
  settlement_id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  readiness_assessment_id: number | null;
  readiness_assessment_hash: string;
  policy_version: string;
  policy_hash: string;
  decision: SettlementDecision;
  reason_codes: DiscoverySettlementReasonCode[];
  input_hash: string;
  /** Canonical-JSON text of the immutable certificate payload. */
  certificate_payload: string;
  certificate_hash: string;
  issued_at: string;
}
