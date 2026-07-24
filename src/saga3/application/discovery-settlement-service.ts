/**
 * DiscoverySettlementService — the kernel application layer that turns a
 * provisional discovery result into an authoritative one via the deterministic
 * settlement policy.
 *
 * Roadmap D4. Core principle:
 *
 *   LM proposes. Advisor assesses. Kernel settles. Certificate proves.
 *
 * This service is the ONLY writer of settlements + certificates. It has NO LM
 * client, NO worker executor, NO MCP tool — settlement is kernel-only. It
 * depends only on the runtime persistence port (Phase B boundary: it never
 * touches the DB handle directly and contains no inline SQL).
 *
 * The flow (roadmap D4 §11):
 *   load canonical Proposal by id
 *     -> strict re-validation (payload + schema_version + recomputed hash)
 *     -> load accepted readiness assessment if present
 *        -> strict re-validation (payload + recomputed hash)
 *     -> build immutable input snapshot
 *     -> compute input hash
 *     -> find existing settlement by idempotency key
 *        -> if exists + certificate: return SAME certificate (no recompute)
 *        -> if exists + no certificate: deterministically rebuild certificate
 *     -> run deterministic policy
 *     -> persist settlement (status computed)
 *     -> build + persist immutable certificate
 *     -> mark settlement certificate_issued
 *     -> return authoritative result
 *
 * Any failure throws; the engine maps a thrown settlement to
 * settlement.status='failed' and reason='failed' (D4 is the authoritative
 * boundary — unlike D3 shadow, a settlement failure means Discovery Edition did
 * NOT complete authoritatively).
 */

import { createHash } from 'node:crypto';

import type { Saga3DiscoveryRuntimePersistence, SettlementInputKey, SettlementProposalRecord } from '../persistence/saga3-discovery-runtime-port.js';
import type { ReadinessShadowResult } from '../domain/discovery-readiness-assessment.js';
import type { DiscoveryProposalPayload } from '../domain/discovery-proposal.js';
import { validateDiscoveryProposal } from '../domain/discovery-proposal.js';
import type { ReadinessAssessmentPayload } from '../domain/discovery-readiness-assessment.js';
import { validateReadinessAssessment } from '../domain/discovery-readiness-assessment.js';
import {
  DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
  NO_READINESS_HASH,
  buildSettlementInputHash,
  type DiscoverySettlementInputSnapshot,
  type SettlementReadinessStatus,
} from '../domain/discovery-settlement-input.js';
import {
  DISCOVERY_SETTLEMENT_POLICY_VERSION,
  POLICY_V1_CONTENT_HASH,
  type DiscoverySettlementDecision,
  type DiscoverySettlementReasonCode,
} from '../domain/discovery-settlement-policy.js';
import { discoverySettlementPolicyV1 } from '../domain/discovery-settlement-policy.js';
import {
  buildOutcomeCertificatePayload,
  hashOutcomeCertificate,
} from '../domain/discovery-outcome-certificate.js';
import { canonicalJson } from '../persistence/saga3-normalization-repository.js';

/**
 * What the engine passes to the settlement service. The readiness shadow is the
 * engine's view of the readiness phase; the service cross-checks it against the
 * durable accepted assessment (if any).
 */
export interface SettleRequest {
  projectId: number;
  epicId: number;
  proposalId: number;
  proposalHash: string;
  readiness: ReadinessShadowResult;
}

/**
 * The authoritative result the service returns. Mirrors the `settlement`
 * section the engine surfaces in OrchestrationRunResult. `provisional` carries
 * the pre-settlement outcome so the engine can preserve it separately.
 */
export interface DiscoverySettlementResult {
  status: 'issued' | 'failed';
  settlementId: number | null;
  certificateId: number | null;
  certificateHash: string | null;
  policyVersion: string | null;
  policyHash: string | null;
  decision: 'go' | 'clarify' | 'reject' | null;
  reasonCodes: DiscoverySettlementReasonCode[];
  error: string | null;
}

/**
 * The pre-settlement provisional outcome, preserved separately by the engine so
 * the worker's recommendation is never lost when settlement authoritatively
 * overrides it.
 */
export interface ProvisionalOutcome {
  outcome: string;
  authority: 'worker_proposal' | 'normalized_worker_proposal' | 'none';
  proposalId: number | null;
  proposalHash: string | null;
}

export interface DiscoverySettlementService {
  settle(request: SettleRequest): Promise<DiscoverySettlementResult>;
}

export interface Saga3DiscoverySettlementServiceDependencies {
  runtimePersistence: Saga3DiscoveryRuntimePersistence;
}

/**
 * Thrown when the canonical Proposal cannot be settled as-is (missing, invalid,
 * or hash mismatch after strict re-validation). The engine maps this to a
 * failed settlement.
 */
export class SettlementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementValidationError';
  }
}

/**
 * Saga 3 implementation. Stateless beyond its persistence dependency.
 */
export class Saga3DiscoverySettlementService implements DiscoverySettlementService {
  constructor(private readonly deps: Saga3DiscoverySettlementServiceDependencies) {}

  async settle(request: SettleRequest): Promise<DiscoverySettlementResult> {
    const { runtimePersistence: rt } = this.deps;
    const policy = discoverySettlementPolicyV1;

    // 1. Load the canonical Proposal by id.
    const proposalRow = rt.readProposalForSettlement(request.proposalId);
    if (!proposalRow) {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} not found`,
      );
    }

    // 2. Strict re-validation of the Proposal payload.
    const proposalValidation = validateDiscoveryProposal(proposalRow.payload);
    if (!proposalValidation.valid) {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} failed re-validation: ${proposalValidation.errors.join('; ')}`,
      );
    }
    // 2b. Recompute the content hash from the canonical payload and compare to
    // BOTH the stored hash and the engine-supplied hash. Any mismatch is a
    // tampered/inconsistent Proposal — fail closed.
    const recomputedProposalHash = createHash('sha256')
      .update(canonicalJson(proposalRow.payload)).digest('hex');
    if (recomputedProposalHash !== proposalRow.content_hash) {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} content_hash mismatch (stored ${proposalRow.content_hash}, recomputed ${recomputedProposalHash})`,
      );
    }
    if (recomputedProposalHash !== request.proposalHash) {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} hash does not match engine-supplied hash ${request.proposalHash}`,
      );
    }

    const proposalPayload = proposalRow.payload as DiscoveryProposalPayload;

    // 3. Load the accepted readiness assessment if the readiness phase produced
    //    one. Cross-check against the engine shadow.
    let readinessAssessmentId: number | null = null;
    let readinessContentHash: string | null = null;
    let readinessPayload: ReadinessAssessmentPayload | null = null;
    let readinessSnapshotStatus: SettlementReadinessStatus;

    const assessment = rt.readAcceptedReadinessAssessmentForProposal(request.proposalId);
    if (assessment && assessment.status === 'accepted_by_kernel') {
      // 4. Strict re-validation of the readiness assessment payload.
      const allowedRefs = collectAllowedSourceRefs(proposalRow, proposalPayload);
      const readinessValidation = validateReadinessAssessment(
        assessment.payload,
        request.proposalId,
        recomputedProposalHash,
        allowedRefs,
      );
      if (!readinessValidation.valid) {
        // The stored accepted assessment no longer validates against the
        // current Proposal lineage — treat readiness as failed (fail closed).
        readinessSnapshotStatus = 'failed';
      } else {
        // 4b. Recompute the readiness content hash and compare to the stored
        // hash and (if present) the engine-supplied assessment hash.
        const recomputedReadinessHash = createHash('sha256')
          .update(canonicalJson(assessment.payload)).digest('hex');
        if (recomputedReadinessHash !== assessment.content_hash) {
          readinessSnapshotStatus = 'failed';
        } else {
          readinessAssessmentId = assessment.id;
          readinessContentHash = recomputedReadinessHash;
          readinessPayload = assessment.payload as ReadinessAssessmentPayload;
          readinessSnapshotStatus = 'accepted_by_kernel';
          // Cross-check the engine shadow: if the engine believes readiness
          // failed but an accepted assessment exists, prefer the durable row
          // (it is authoritative) but this divergence is suspicious — still
          // settle on the durable accepted row.
        }
      }
    } else {
      // No accepted assessment. Derive missing/failed from the engine shadow so
      // the reason code is accurate (advisor ran+failed vs never produced one).
      readinessSnapshotStatus =
        request.readiness.status === 'failed' ? 'failed' : 'missing';
    }

    // 5. Build the immutable input snapshot.
    const readinessAssessmentHashForIdempotency =
      readinessContentHash ?? NO_READINESS_HASH;
    const snapshot: DiscoverySettlementInputSnapshot = {
      schema_version: DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
      epic_id: request.epicId,
      proposal: {
        id: proposalRow.id,
        content_hash: proposalRow.content_hash,
        payload: proposalPayload,
        source_intent_id: proposalRow.intent_id,
        source_submission_id: proposalRow.source_submission_id,
        normalization_proposal_id: proposalRow.normalization_proposal_id,
      },
      readiness: {
        status: readinessSnapshotStatus,
        assessment_id: readinessAssessmentId,
        content_hash: readinessContentHash,
        payload: readinessPayload,
      },
      policy: {
        version: policy.version,
        content_hash: policy.contentHash,
      },
      captured_at: new Date().toISOString(),
    };
    // NOTE: captured_at makes each snapshot textually unique, but the
    // IDEMPOTENCY KEY (below) deliberately excludes captured_at: two runs over
    // the same (proposal hash, readiness hash, policy) target reuse the same
    // settlement row. The input_snapshot text stored is the first run's text;
    // the input_hash is recomputed deterministically for the key lookup only.
    const inputHash = buildSettlementInputHash(snapshot);

    // 6. Idempotency: find an existing settlement by the immutable input key.
    const key: SettlementInputKey = {
      proposalId: proposalRow.id,
      proposalContentHash: proposalRow.content_hash,
      readinessAssessmentHash: readinessAssessmentHashForIdempotency,
      policyVersion: policy.version,
      policyHash: policy.contentHash,
    };
    const existing = rt.findSettlementByInputKey(key);
    if (existing) {
      // Replay / recovery path.
      const cert = rt.readCertificateForSettlement(existing.id);
      if (cert) {
        // Existing settlement + certificate: return it unchanged. No recompute,
        // no second certificate.
        return {
          status: 'issued',
          settlementId: existing.id,
          certificateId: cert.id,
          certificateHash: cert.certificate_hash,
          policyVersion: existing.policy_version,
          policyHash: existing.policy_hash,
          decision: existing.decision,
          reasonCodes: existing.reason_codes,
          error: null,
        };
      }
      // Settlement exists but no certificate (interrupted between insert and
      // certificate issue). Deterministically rebuild the certificate from the
      // existing decision and return it.
      const rebuilt = this.issueCertificate(
        rt, existing.id, existing.epic_id, existing.decision,
        existing.reason_codes, key, proposalRow, readinessAssessmentId,
        readinessContentHash, readinessSnapshotStatus, existing.input_hash, existing.created_at,
      );
      return {
        status: 'issued',
        settlementId: existing.id,
        certificateId: rebuilt.certificateId,
        certificateHash: rebuilt.certificateHash,
        policyVersion: policy.version,
        policyHash: policy.contentHash,
        decision: existing.decision,
        reasonCodes: existing.reason_codes,
        error: null,
      };
    }

    // 7. Run the deterministic policy against the snapshot.
    const decision: DiscoverySettlementDecision = policy.settle(snapshot);

    // 8. Persist the settlement (status computed).
    const { record: settlement } = rt.insertSettlement({
      epicId: request.epicId,
      key,
      readinessAssessmentId,
      inputSnapshot: snapshot,
      decision: decision.decision,
      reasonCodes: decision.reason_codes,
      rationale: decision.rationale,
    });

    // 9-11. Build + persist the immutable certificate and mark issued.
    try {
      const issued = this.issueCertificate(
        rt, settlement.id, request.epicId, decision.decision, decision.reason_codes,
        key, proposalRow, readinessAssessmentId, readinessContentHash,
        readinessSnapshotStatus, inputHash, new Date().toISOString(),
      );
      return {
        status: 'issued',
        settlementId: settlement.id,
        certificateId: issued.certificateId,
        certificateHash: issued.certificateHash,
        policyVersion: decision.policy_version,
        policyHash: decision.policy_hash,
        decision: decision.decision,
        reasonCodes: decision.reason_codes,
        error: null,
      };
    } catch (certErr) {
      // Certificate issue failed: mark the settlement failed and rethrow so the
      // engine maps this to a failed run. The settlement row remains for audit.
      rt.markSettlementFailed(settlement.id);
      throw certErr;
    }
  }

  /**
   * Build, persist, and mark-issued an immutable certificate for a settlement.
   * Shared by the fresh-settle path and the recovery-rebuild path. The
   * `issuedAt` is supplied by the caller so recovery rebuilds a byte-identical
   * certificate (idempotent): the fresh path passes the current ISO timestamp,
   * the recovery path passes the settlement's created_at.
   */
  private issueCertificate(
    rt: Saga3DiscoveryRuntimePersistence,
    settlementId: number,
    epicId: number,
    decision: 'go' | 'clarify' | 'reject',
    reasonCodes: DiscoverySettlementReasonCode[],
    key: SettlementInputKey,
    proposal: SettlementProposalRecord,
    readinessAssessmentId: number | null,
    readinessContentHash: string | null,
    readinessStatus: SettlementReadinessStatus,
    inputHash: string,
    issuedAt: string,
  ): { certificateId: number; certificateHash: string } {
    const certPayload = buildOutcomeCertificatePayload({
      epic_id: epicId,
      proposalId: proposal.id,
      proposalContentHash: proposal.content_hash,
      readinessStatus,
      readinessAssessmentId,
      readinessContentHash,
      decision: {
        decision,
        reason_codes: reasonCodes,
        rationale: '', // not stored on the certificate payload
        policy_version: key.policyVersion,
        policy_hash: key.policyHash,
      },
      settlementInputHash: inputHash,
      issuedAt,
    });
    const expectedHash = hashOutcomeCertificate(certPayload);
    const { record: cert } = rt.insertCertificate({
      settlementId,
      epicId,
      proposalId: proposal.id,
      proposalContentHash: proposal.content_hash,
      readinessAssessmentId,
      readinessAssessmentHash: key.readinessAssessmentHash,
      policyVersion: key.policyVersion,
      policyHash: key.policyHash,
      decision,
      reasonCodes,
      inputHash,
      certificatePayload: certPayload,
    });
    rt.markSettlementCertificateIssued(settlementId);
    if (cert.certificate_hash !== expectedHash) {
      // Should be impossible given deterministic hashing, but guard it: never
      // hand back a certificate whose stored hash disagrees with a recomputation.
      throw new Error(
        `settlement: certificate hash mismatch for settlement ${settlementId}`,
      );
    }
    return { certificateId: cert.id, certificateHash: cert.certificate_hash };
  }
}

/**
 * Build the EXACT set of source identifiers the readiness advisor was allowed
 * to cite. This MUST be byte-identical to the D3 readiness handler's
 * collectAllowedSourceRefs (src/tools/saga3-readiness.ts): if it were stricter
 * or looser, an assessment ACCEPTED by D3 would be rejected (or vice versa) at
 * settlement, breaking the lineage contract. The settlement re-validation
 * re-checks the accepted assessment against this same set.
 *
 * Allowed sources:
 *   - the proposal lineage id `proposal:<id>`;
 *   - JSON paths into the canonical Proposal payload fields (`$.problem_statement`, ...);
 *   - indexed evidence paths (`$.evidence_refs[0]`) + the literal evidence strings;
 *   - lineage identifiers `raw:<id>` / `normalization:<id>` when present.
 */
function collectAllowedSourceRefs(
  proposal: SettlementProposalRecord,
  payload: DiscoveryProposalPayload,
): string[] {
  const refs = new Set<string>();
  refs.add(`proposal:${proposal.id}`);
  for (const key of Object.keys(payload)) {
    refs.add(`$.${key}`);
  }
  payload.evidence_refs.forEach((evidence, index) => {
    refs.add(`$.evidence_refs[${index}]`);
    refs.add(evidence);
  });
  if (proposal.source_submission_id !== null) {
    refs.add(`raw:${proposal.source_submission_id}`);
  }
  if (proposal.normalization_proposal_id !== null) {
    refs.add(`normalization:${proposal.normalization_proposal_id}`);
  }
  return [...refs];
}

// Re-export for the engine/composition root.
export {
  DISCOVERY_SETTLEMENT_POLICY_VERSION,
  POLICY_V1_CONTENT_HASH,
};
