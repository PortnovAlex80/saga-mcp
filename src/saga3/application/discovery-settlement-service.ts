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

import type { Saga3DiscoveryRuntimePersistence, SettlementInputKey } from '../persistence/saga3-discovery-runtime-port.js';
import type { SettlementRecord, OutcomeCertificateRecord } from '../domain/discovery-settlement-records.js';
import type { ReadinessShadowResult } from '../domain/discovery-readiness-assessment.js';
import type { DiscoveryProposalPayload } from '../domain/discovery-proposal.js';
import { DISCOVERY_PROPOSAL_SCHEMA, validateDiscoveryProposal } from '../domain/discovery-proposal.js';
import type { ReadinessAssessmentPayload } from '../domain/discovery-readiness-assessment.js';
import { validateReadinessAssessment } from '../domain/discovery-readiness-assessment.js';
import {
  DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
  buildSettlementInputHash,
  type DiscoverySettlementInputSnapshot,
  type SettlementReadinessStatus,
} from '../domain/discovery-settlement-input.js';
import {
  DISCOVERY_SETTLEMENT_POLICY_VERSION,
  POLICY_V1_CONTENT_HASH,
  type DiscoverySettlementDecision,
  type DiscoverySettlementPolicy,
  type DiscoverySettlementReasonCode,
} from '../domain/discovery-settlement-policy.js';
import { discoverySettlementPolicyV1 } from '../domain/discovery-settlement-policy.js';
import {
  buildOutcomeCertificatePayload,
  hashOutcomeCertificate,
} from '../domain/discovery-outcome-certificate.js';
import { canonicalJson, collectDiscoverySourceRefs } from '../shared/discovery-canonical.js';

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
 * The authoritative result the service returns. A DISCRIMINATED UNION on
 * `status`: when 'issued', decision/certificateId/certificateHash are NON-NULL
 * (the engine grants authority only on 'issued'); when 'failed', error is
 * non-null and the identity fields are null. Mirrors the `settlement` section
 * the engine surfaces in OrchestrationRunResult.
 */
export type DiscoverySettlementResult =
  | {
      status: 'issued';
      settlementId: number;
      certificateId: number;
      certificateHash: string;
      policyVersion: string;
      policyHash: string;
      decision: 'go' | 'clarify' | 'reject';
      reasonCodes: DiscoverySettlementReasonCode[];
      error: null;
    }
  | {
      status: 'failed';
      settlementId: number | null;
      certificateId: null;
      certificateHash: null;
      policyVersion: null;
      policyHash: null;
      decision: null;
      reasonCodes: DiscoverySettlementReasonCode[];
      error: string;
    };

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
    // 2a. EXACT target binding — the Proposal must belong to THIS epic/project,
    // be a discovery Proposal of the canonical schema, and be in 'submitted'
    // status. An internal caller mixing epics/projects must NOT be able to
    // create a cross-boundary certificate.
    if (proposalRow.epic_id !== request.epicId) {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} belongs to epic ${proposalRow.epic_id}, not ${request.epicId}`,
      );
    }
    if (proposalRow.project_id !== request.projectId) {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} belongs to project ${proposalRow.project_id}, not ${request.projectId}`,
      );
    }
    if (proposalRow.kind !== 'discovery') {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} kind '${proposalRow.kind}' is not 'discovery'`,
      );
    }
    if (proposalRow.schema_version !== DISCOVERY_PROPOSAL_SCHEMA) {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} schema_version '${proposalRow.schema_version}' is not ${DISCOVERY_PROPOSAL_SCHEMA}`,
      );
    }
    if (proposalRow.status !== 'submitted') {
      throw new SettlementValidationError(
        `settlement: proposal ${request.proposalId} status '${proposalRow.status}' is not 'submitted'`,
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

    // 3. Build the readiness slice of the snapshot from the EXACT assessment the
    //    engine observed via D3 (request.readiness), NOT the latest accepted row
    //    for the proposal. If a newer accepted assessment appeared after the
    //    engine ran, the engine's view is the authoritative input for THIS run;
    //    silently substituting the newer row would settle a different input than
    //    the one the engine reported.
    let readinessAssessmentId: number | null = null;
    let readinessContentHash: string | null = null;
    let readinessPayload: ReadinessAssessmentPayload | null = null;
    let readinessSnapshotStatus: SettlementReadinessStatus;

    const shadow = request.readiness;
    // The engine reports readiness.status='completed' (assessment accepted) only
    // when the D3 advisor produced an accepted_by_kernel assessment; the exact
    // assessmentId/assessmentHash are in the shadow. Any other shadow status maps
    // to the corresponding snapshot status (missing/failed/paused).
    if (shadow.status === 'completed'
        && shadow.assessmentId !== null
        && shadow.assessmentHash !== null) {
      // 3a. Read the EXACT assessment by id (not the latest for the proposal).
      const assessment = rt.readReadinessAssessment(shadow.assessmentId);
      if (!assessment || assessment.status !== 'accepted_by_kernel') {
        throw new SettlementValidationError(
          `settlement: readiness assessment ${shadow.assessmentId} not found or not accepted_by_kernel`,
        );
      }
      // 3b. EXACT binding: the assessment must target THIS Proposal (id + hash).
      if (assessment.proposal_id !== proposalRow.id
          || assessment.proposal_content_hash !== proposalRow.content_hash) {
        throw new SettlementValidationError(
          `settlement: readiness assessment ${assessment.id} targets proposal ${assessment.proposal_id}/${assessment.proposal_content_hash.slice(0, 12)}, not ${proposalRow.id}/${proposalRow.content_hash.slice(0, 12)}`,
        );
      }
      // 3c. Strict re-validation of the assessment payload.
      const allowedRefs = collectDiscoverySourceRefs(
        {
          proposalId: proposalRow.id,
          sourceSubmissionId: proposalRow.source_submission_id,
          normalizationProposalId: proposalRow.normalization_proposal_id,
        },
        proposalPayload,
      );
      const readinessValidation = validateReadinessAssessment(
        assessment.payload,
        request.proposalId,
        recomputedProposalHash,
        allowedRefs,
      );
      if (!readinessValidation.valid) {
        throw new SettlementValidationError(
          `settlement: readiness assessment ${assessment.id} failed re-validation: ${readinessValidation.errors.join('; ')}`,
        );
      }
      // 3d. Recompute the assessment content hash; it must match BOTH the stored
      // hash and the engine-supplied shadow hash.
      const recomputedReadinessHash = createHash('sha256')
        .update(canonicalJson(assessment.payload)).digest('hex');
      if (recomputedReadinessHash !== assessment.content_hash) {
        throw new SettlementValidationError(
          `settlement: readiness assessment ${assessment.id} content_hash mismatch`,
        );
      }
      if (recomputedReadinessHash !== shadow.assessmentHash) {
        throw new SettlementValidationError(
          `settlement: readiness assessment ${assessment.id} hash does not match engine-supplied hash`,
        );
      }
      readinessAssessmentId = assessment.id;
      readinessContentHash = recomputedReadinessHash;
      readinessPayload = assessment.payload as ReadinessAssessmentPayload;
      readinessSnapshotStatus = 'accepted_by_kernel';
    } else {
      // No accepted assessment in the engine shadow. Map the shadow status to
      // the snapshot status so the semantic idempotency key (and reason code)
      // distinguishes missing / failed / paused.
      readinessSnapshotStatus =
        shadow.status === 'failed' ? 'failed'
        : shadow.status === 'paused' ? 'paused'
        : 'missing';
    }

    // 5. Build the immutable input snapshot.
    const readinessTargetEncoded = encodeReadinessTarget(readinessSnapshotStatus, readinessContentHash);
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
    // the same (proposal hash, readiness TARGET, policy) reuse the same row.
    const inputHash = buildSettlementInputHash(snapshot);

    // 6. Idempotency: find an existing settlement by the immutable input key.
    // The key uses the SEMANTIC readiness target (accepted:<hash> | missing |
    // failed | paused) so distinct readiness states never collapse onto one
    // settlement/certificate.
    const key: SettlementInputKey = {
      proposalId: proposalRow.id,
      proposalContentHash: proposalRow.content_hash,
      readinessTarget: readinessTargetEncoded,
      policyVersion: policy.version,
      policyHash: policy.contentHash,
    };
    const existing = rt.findSettlementByInputKey(key);
    if (existing) {
      // Replay / recovery path. The stored settlement row is the authoritative
      // record; we rebuild from ITS snapshot, never from the current live
      // readiness state (which may have changed since the settlement was
      // computed).
      const storedSnapshot = this.parseAndVerifyStoredSnapshot(existing, key, policy);
      // Existing certificate? Re-hash + validate it before returning.
      const cert = rt.readCertificateForSettlement(existing.id);
      if (cert) {
        this.verifyExistingCertificate(cert, storedSnapshot, existing);
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
      // certificate issue, OR a previously-failed settlement being retried).
      // Deterministically rebuild the certificate from the STORED snapshot +
      // stored decision. A failed settlement becomes certificate_issued here.
      const rebuilt = this.issueCertificate(
        rt, existing.id, existing.epic_id, existing.decision,
        existing.reason_codes, key, storedSnapshot.snapshot,
        storedSnapshot.inputHash, existing.created_at,
      );
      return {
        status: 'issued',
        settlementId: existing.id,
        certificateId: rebuilt.certificateId,
        certificateHash: rebuilt.certificateHash,
        policyVersion: existing.policy_version,
        policyHash: existing.policy_hash,
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

    // 9-11. Build + persist the immutable certificate and mark issued. The
    // deterministic issued_at is the settlement's created_at so a recovery
    // rebuild produces a byte-identical certificate.
    try {
      const issued = this.issueCertificate(
        rt, settlement.id, request.epicId, decision.decision, decision.reason_codes,
        key, snapshot, inputHash, settlement.created_at,
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
   * Build, persist, and mark-issued an immutable certificate for a settlement,
   * EXCLUSIVELY from the stored/fresh snapshot. Shared by the fresh-settle path
   * and the recovery-rebuild path. `issuedAt` is supplied by the caller so a
   * recovery rebuild produces a byte-identical certificate (the fresh path
   * passes the settlement's created_at too — one deterministic issued_at).
   *
   * The certificate insert + the certificate_issued transition happen in one
   * port call sequence; the CAS result of markSettlementCertificateIssued is
   * checked: if the settlement could not be marked issued the certificate is
   * considered not authoritatively issued and we throw.
   */
  private issueCertificate(
    rt: Saga3DiscoveryRuntimePersistence,
    settlementId: number,
    epicId: number,
    decision: 'go' | 'clarify' | 'reject',
    reasonCodes: DiscoverySettlementReasonCode[],
    key: SettlementInputKey,
    snapshot: DiscoverySettlementInputSnapshot,
    inputHash: string,
    issuedAt: string,
  ): { certificateId: number; certificateHash: string } {
    const certPayload = buildOutcomeCertificatePayload({
      epic_id: epicId,
      proposalId: snapshot.proposal.id,
      proposalContentHash: snapshot.proposal.content_hash,
      readinessStatus: snapshot.readiness.status,
      readinessAssessmentId: snapshot.readiness.assessment_id,
      readinessContentHash: snapshot.readiness.content_hash,
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
      proposalId: snapshot.proposal.id,
      proposalContentHash: snapshot.proposal.content_hash,
      readinessAssessmentId: snapshot.readiness.assessment_id,
      readinessAssessmentHash: key.readinessTarget,
      policyVersion: key.policyVersion,
      policyHash: key.policyHash,
      decision,
      reasonCodes,
      inputHash,
      certificatePayload: certPayload,
    });
    // Check the stored hash agrees with the recomputed one (tamper guard).
    if (cert.certificate_hash !== expectedHash) {
      throw new Error(
        `settlement: certificate hash mismatch for settlement ${settlementId}`,
      );
    }
    // Atomically transition the settlement to certificate_issued. The CAS result
    // MUST be checked: if it did not apply, the certificate is not authoritatively
    // bound and we must not report issued. A failed settlement retried here
    // transitions failed -> certificate_issued is NOT allowed by the CAS
    // (computed|certificate_issued only), so this throws on a stuck-failed row.
    const marked = rt.markSettlementCertificateIssued(settlementId);
    if (!marked) {
      throw new Error(
        `settlement: could not mark settlement ${settlementId} certificate_issued (stuck in a non-computed state)`,
      );
    }
    return { certificateId: cert.id, certificateHash: cert.certificate_hash };
  }

  /**
   * Parse the stored settlement input_snapshot, recompute its hash, and verify
   * it against the stored input_hash AND the idempotency key. A tampered
   * snapshot/input_hash/key mismatch is rejected. Also re-runs the stored policy
   * version against the stored snapshot and asserts the decision/reason_codes
   * match — so a row whose stored decision disagrees with the policy is caught.
   * Returns the parsed snapshot + recomputed input hash for certificate rebuild.
   */
  private parseAndVerifyStoredSnapshot(
    settlement: SettlementRecord,
    key: SettlementInputKey,
    policy: DiscoverySettlementPolicy,
  ): { snapshot: DiscoverySettlementInputSnapshot; inputHash: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(settlement.input_snapshot);
    } catch {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: stored input_snapshot is not valid JSON`,
      );
    }
    // Verify the snapshot's own hashes match the row's recorded input_hash.
    const recomputed = buildSettlementInputHash(parsed as DiscoverySettlementInputSnapshot);
    if (recomputed !== settlement.input_hash) {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: stored input_hash does not match recomputed snapshot hash`,
      );
    }
    // Verify the row's key columns match the request key (no drift on the
    // immutable target).
    if (settlement.proposal_id !== key.proposalId
        || settlement.proposal_content_hash !== key.proposalContentHash
        || settlement.policy_version !== key.policyVersion
        || settlement.policy_hash !== key.policyHash) {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: stored key columns do not match the request key`,
      );
    }
    // Re-run the policy against the STORED snapshot and confirm the decision +
    // reason codes are unchanged. This catches a settlement whose stored
    // decision was produced by a different policy than the one recorded.
    const replay = policy.settle(parsed as DiscoverySettlementInputSnapshot);
    if (replay.decision !== settlement.decision
        || !arrayEquals(replay.reason_codes, settlement.reason_codes)) {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: stored decision/reason_codes do not match a policy replay of the stored snapshot`,
      );
    }
    return { snapshot: parsed as DiscoverySettlementInputSnapshot, inputHash: recomputed };
  }

  /**
   * Re-hash and validate an existing certificate against the stored snapshot +
   * settlement row before returning it as authoritative. A tampered payload or
   * lineage mismatch is rejected.
   */
  private verifyExistingCertificate(
    cert: OutcomeCertificateRecord,
    stored: { snapshot: DiscoverySettlementInputSnapshot; inputHash: string },
    settlement: SettlementRecord,
  ): void {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(cert.certificate_payload);
    } catch {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: stored certificate_payload is not valid JSON`,
      );
    }
    const recomputedHash = hashOutcomeCertificate(parsedPayload as ReturnType<typeof buildOutcomeCertificatePayload>);
    if (recomputedHash !== cert.certificate_hash) {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: stored certificate_hash does not match recomputed payload hash`,
      );
    }
    // Lineage: the certificate must agree with the settlement on decision +
    // input_hash + policy, and with the snapshot on proposal/readiness.
    if (cert.decision !== settlement.decision
        || cert.input_hash !== stored.inputHash
        || cert.policy_version !== settlement.policy_version
        || cert.policy_hash !== settlement.policy_hash) {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: certificate lineage does not match the settlement`,
      );
    }
    if (cert.proposal_id !== stored.snapshot.proposal.id
        || cert.proposal_content_hash !== stored.snapshot.proposal.content_hash) {
      throw new SettlementValidationError(
        `settlement ${settlement.id}: certificate proposal lineage does not match the snapshot`,
      );
    }
  }
}

/** Encode a settlement readiness status + (optional) hash into the semantic
 * readiness-target string used in the idempotency key and certificate row. */
function encodeReadinessTarget(
  status: SettlementReadinessStatus,
  contentHash: string | null,
): string {
  if (status === 'accepted_by_kernel') {
    return contentHash ? `accepted:${contentHash}` : 'accepted:none';
  }
  return status; // 'missing' | 'failed' | 'paused'
}

function arrayEquals<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Re-export for the engine/composition root.
export {
  DISCOVERY_SETTLEMENT_POLICY_VERSION,
  POLICY_V1_CONTENT_HASH,
};
