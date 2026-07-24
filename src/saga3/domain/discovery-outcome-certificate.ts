/**
 * DiscoveryOutcomeCertificate — the immutable proof that the kernel settled a
 * discovery authoritatively.
 *
 * Roadmap D4 §10. The certificate is the durable artifact: it records the
 * decision, the reason codes, the proposal and readiness lineage hashes, and
 * the policy version/hash that produced it. Its hash is the integrity check —
 * any mutation of the inputs changes the hash and therefore is a different
 * certificate.
 *
 * Authority of the certificate is `kernel_policy`, NOT LM provenance: the
 * worker and the advisor never author a certificate. The settlement service
 * builds it after the deterministic policy has decided.
 */

import { createHash } from 'node:crypto';

import type { DiscoverySettlementDecision } from './discovery-settlement-policy.js';
import { canonicalJson } from '../persistence/saga3-normalization-repository.js';

/**
 * Schema version for the outcome certificate payload.
 */
export const DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA = 'saga3.discovery-outcome-certificate.v1';

/**
 * The authority that issued the certificate. Always kernel_policy for D4 — the
 * certificate is the kernel's authoritative artifact, never an LM's.
 */
export const CERTIFICATE_AUTHORITY = 'kernel_policy';

/**
 * The proposal slice recorded in the certificate. Only id + content_hash — the
 * full payload lives in the immutable settlement input snapshot, referenced by
 * `settlement_input_hash`.
 */
export interface CertificateProposalRef {
  id: number;
  content_hash: string;
}

/**
 * The readiness slice recorded in the certificate. `status` mirrors the
 * snapshot readiness status; `assessment_id` / `content_hash` are present only
 * when an accepted assessment exists.
 */
export interface CertificateReadinessRef {
  assessment_id: number | null;
  content_hash: string | null;
  status: 'accepted_by_kernel' | 'missing' | 'failed';
}

/**
 * The policy slice recorded in the certificate.
 */
export interface CertificatePolicyRef {
  version: string;
  content_hash: string;
}

/**
 * The immutable outcome certificate payload. This is exactly what gets hashed
 * to produce `certificate_hash` and persisted verbatim.
 */
export interface DiscoveryOutcomeCertificatePayload {
  schema_version: typeof DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA;
  epic_id: number;
  decision: 'go' | 'clarify' | 'reject';
  reason_codes: string[];
  proposal: CertificateProposalRef;
  readiness: CertificateReadinessRef;
  policy: CertificatePolicyRef;
  settlement_input_hash: string;
  issued_at: string; // ISO 8601
  authority: typeof CERTIFICATE_AUTHORITY;
}

/**
 * Inputs to `buildOutcomeCertificatePayload`. The settlement service supplies
 * the immutable snapshot hashes plus the policy decision.
 */
export interface BuildOutcomeCertificateInput {
  epic_id: number;
  proposalId: number;
  proposalContentHash: string;
  readinessStatus: 'accepted_by_kernel' | 'missing' | 'failed';
  readinessAssessmentId: number | null;
  readinessContentHash: string | null;
  decision: DiscoverySettlementDecision;
  settlementInputHash: string;
  issuedAt: string; // ISO 8601
}

/**
 * Assemble the immutable certificate payload from the settled inputs. This is a
 * pure projection — no I/O, no randomness. `issued_at` is supplied by the
 * caller (captured at snapshot time) so two rebuilds of the same settlement
 * produce the byte-identical certificate (idempotent recovery).
 */
export function buildOutcomeCertificatePayload(
  input: BuildOutcomeCertificateInput,
): DiscoveryOutcomeCertificatePayload {
  return {
    schema_version: DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
    epic_id: input.epic_id,
    decision: input.decision.decision,
    reason_codes: [...input.decision.reason_codes],
    proposal: {
      id: input.proposalId,
      content_hash: input.proposalContentHash,
    },
    readiness: {
      assessment_id: input.readinessAssessmentId,
      content_hash: input.readinessContentHash,
      status: input.readinessStatus,
    },
    policy: {
      version: input.decision.policy_version,
      content_hash: input.decision.policy_hash,
    },
    settlement_input_hash: input.settlementInputHash,
    issued_at: input.issuedAt,
    authority: CERTIFICATE_AUTHORITY,
  };
}

/**
 * Deterministic SHA-256 over the canonical JSON of the certificate payload.
 * Uses the shared canonicalJson helper so the certificate hash is byte-stable
 * across rebuilds (critical for the idempotency / replay guarantee).
 */
export function hashOutcomeCertificate(payload: DiscoveryOutcomeCertificatePayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
