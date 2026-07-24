/**
 * DiscoverySettlementInputSnapshot — the IMMUTABLE bundle of every input the
 * settlement policy consumes to reach its authoritative decision.
 *
 * Roadmap D4. The kernel (settlement service) assembles this snapshot from the
 * canonical Proposal, the accepted readiness assessment (or an explicit
 * readiness failure/missing state), and the frozen policy version/hash. The
 * snapshot is then hashed; that hash is the idempotency key for the resulting
 * settlement + certificate. Inputs are NEVER re-read after the snapshot is
 * built — the decision is settled against the snapshot, not against live state.
 *
 * D4 is the authoritative boundary: the snapshot is the only thing the policy
 * may see, and the policy is the only thing that may choose go / clarify /
 * reject. Neither the worker nor the advisor can settle.
 */

import { createHash } from 'node:crypto';

import type { DiscoveryProposalPayload } from './discovery-proposal.js';
import type { ReadinessAssessmentPayload } from './discovery-readiness-assessment.js';
import { canonicalJson } from '../shared/discovery-canonical.js';

/**
 * Schema version for the settlement input snapshot. The hash computed over a
 * snapshot whose schema_version differs is a different idempotency target.
 */
export const DISCOVERY_SETTLEMENT_INPUT_SCHEMA = 'saga3.discovery-settlement-input.v1';

/**
 * Readiness state as captured into the snapshot. These are NOT the shadow
 * statuses from ReadinessShadowResult — they are the kernel-relevant states:
 *   - 'accepted_by_kernel': an accepted assessment is present and re-validated.
 *   - 'missing': no assessment exists (advisor never produced one we can use).
 *   - 'failed': the readiness phase errored or produced no accepted assessment.
 *
 * Missing, failed, and paused all fail-closed to CLARIFY in the policy; the
 * distinction is preserved for the idempotency key, reason codes, and audit.
 * The semantic readiness-target key (accepted:<hash> | missing | failed |
 * paused) keeps these states in SEPARATE idempotency buckets, so a run that
 * saw readiness=missing never reuses a certificate produced when readiness
 * later became=failed (different authoritative inputs must not collapse).
 */
export type SettlementReadinessStatus = 'accepted_by_kernel' | 'missing' | 'failed' | 'paused';

/**
 * The proposal slice captured into the snapshot. Includes the full typed
 * payload (so the policy can inspect recommended_outcome, evidence_refs, etc.),
 * the immutable content hash, and the lineage identifiers needed to prove
 * provenance without re-reading live state.
 */
export interface SettlementProposalInput {
  id: number;
  content_hash: string;
  payload: DiscoveryProposalPayload;
  source_intent_id: number;
  source_submission_id: number | null;
  normalization_proposal_id: number | null;
}

/**
 * The readiness slice captured into the snapshot. When no accepted assessment
 * exists, `status` is 'missing' or 'failed' and `assessment_id` /
 * `content_hash` / `payload` are null.
 */
export interface SettlementReadinessInput {
  status: SettlementReadinessStatus;
  assessment_id: number | null;
  content_hash: string | null;
  payload: ReadinessAssessmentPayload | null;
}

/**
 * The policy slice captured into the snapshot. Both version and content_hash
 * are frozen at snapshot time; a policy-version bump is a new snapshot (and
 * therefore a new settlement + certificate) without rewriting history.
 */
export interface SettlementPolicyInput {
  version: string;
  content_hash: string;
}

/**
 * The immutable settlement input snapshot. Captured once by the settlement
 * service; never mutated; hashed for idempotency.
 */
export interface DiscoverySettlementInputSnapshot {
  schema_version: typeof DISCOVERY_SETTLEMENT_INPUT_SCHEMA;
  epic_id: number;
  proposal: SettlementProposalInput;
  readiness: SettlementReadinessInput;
  policy: SettlementPolicyInput;
  captured_at: string; // ISO 8601
}

/**
 * Deterministic SHA-256 over the canonical (key-sorted, whitespace-free) JSON
 * of the snapshot. Uses the SAME canonicalJson helper as the Proposal and
 * readiness-assessment hashes so all D2/D3/D4 lineage hashes are produced by
 * one canonicalization. Stable across runs for equal inputs.
 */
export function buildSettlementInputHash(snapshot: DiscoverySettlementInputSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/**
 * Sentinel hash for the readiness slice when no assessment is present. Stored
 * in the idempotency key (and the settlement row) so that a proposal settled
 * with NO assessment is a distinct idempotency target from one settled WITH an
 * assessment — but two "no assessment" settlements for the same proposal +
 * policy collapse to the same row. This mirrors the mandate's
 * `readiness_assessment_hash = 'none'` guidance.
 */
export const NO_READINESS_HASH = 'none';
