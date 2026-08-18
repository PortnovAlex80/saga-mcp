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

import type { FactoryDiscoveryRuntimePersistence, SettlementInputKey, SettlementProposalRecord, IssueCertificateAtomicallyInput } from '../infrastructure/discovery-runtime-port.js';
import type { SettlementRecord, OutcomeCertificateRecord } from '../domain/discovery-settlement-records.js';
import type { ReadinessAssessmentRecord } from '../domain/discovery-readiness-records.js';
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
import { canonicalJson, collectDiscoverySourceRefs } from '../../../shared/canonical-json.js';
// P0-3: the certificate/snapshot/readiness verification discipline is now shared
// with the D5 diagnosis service via discovery-certificate-bundle. D4 keeps its
// observable SettlementValidationError identity by wrapping the shared helpers
// (same messages, same decision logic). D5 calls verifyDiscoveryCertificateBundle
// directly so it no longer maintains a weaker independent copy.
import {
  buildExpectedCertificatePayloadShared,
  encodeReadinessTarget,
  parseAndVerifyStoredSnapshotShared,
  verifyCertificateRecordShared,
  verifyReadinessLineageShared,
} from './discovery-certificate-bundle.js';

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

export interface FactoryDiscoverySettlementServiceDependencies {
  runtimePersistence: FactoryDiscoveryRuntimePersistence;
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
export class FactoryDiscoverySettlementService implements DiscoverySettlementService {
  constructor(private readonly deps: FactoryDiscoverySettlementServiceDependencies) {}

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
    // A 'completed' shadow is the engine asserting the D3 advisor produced an
    // accepted assessment. It MUST carry the exact assessmentId + assessmentHash;
    // a 'completed' shadow without them is malformed engine input (it would let
    // the engine claim acceptance without proof) and must fail closed.
    if (shadow.status === 'completed'
        && (shadow.assessmentId === null || shadow.assessmentHash === null)) {
      throw new SettlementValidationError(
        `settlement: readiness shadow status='completed' is missing assessmentId/assessmentHash (malformed engine input)`,
      );
    }
    // The engine reports readiness.status='completed' (assessment accepted) only
    // when the D3 advisor produced an accepted_by_kernel assessment; the exact
    // assessmentId/assessmentHash are in the shadow. Any other shadow status maps
    // to the corresponding snapshot status (missing/failed/paused).
    if (shadow.status === 'completed') {
      // 3a. Read the EXACT assessment by id (not the latest for the proposal).
      const assessment = rt.readReadinessAssessment(shadow.assessmentId!);
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
      // 3b-extras. Full readiness lineage: verify the ControlIntent that owns the
      // assessment, its authority WorkIntent, and the projected task linkage. This
      // closes the exact-binding gap where an assessment could be linked to the
      // wrong ControlIntent/task.
      this.verifyReadinessLineage(rt, assessment, proposalRow);
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
      const storedSnapshot = this.parseAndVerifyStoredSnapshot(existing, key, policy, proposalRow);
      const existingCert = rt.readCertificateForSettlement(existing.id);
      if (existingCert) {
        // ONE verifier: rebuild expected payload, compare canonical payloads +
        // hash + every certificate row lineage column.
        const expectedPayload = this.buildExpectedCertificatePayload(existing, storedSnapshot);
        const expectedHash = hashOutcomeCertificate(expectedPayload);
        this.verifyCertificateRecord(existingCert, existing, storedSnapshot);
        // P0-2d: the certificate is authoritative ONLY when the settlement is
        // certificate_issued. A crash may have left a certificate attached to a
        // computed/failed settlement — reconcile it atomically before returning.
        // The atomic op re-verifies the FULL settlement + certificate lineage
        // inside BEGIN IMMEDIATE (closes the TOCTOU window).
        if (existing.status !== 'certificate_issued') {
          rt.reconcileExistingCertificate(this.buildAtomicInput(existing, key, storedSnapshot.snapshot, storedSnapshot.inputHash, expectedPayload, expectedHash));
        }
        return {
          status: 'issued',
          settlementId: existing.id,
          certificateId: existingCert.id,
          certificateHash: existingCert.certificate_hash,
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
        storedSnapshot.inputHash, existing.created_at, existing.rationale,
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

    // 8. Persist the settlement (status computed). P0-2a: if insertSettlement
    // reports replayed=true we LOST the unique-conflict race against a concurrent
    // caller — discard the locally built snapshot/inputHash and continue
    // EXCLUSIVELY from the stored settlement snapshot (a different captured_at
    // would otherwise produce a certificate built from the losing local input).
    const inserted = rt.insertSettlement({
      epicId: request.epicId,
      key,
      readinessAssessmentId,
      inputSnapshot: snapshot,
      decision: decision.decision,
      reasonCodes: decision.reason_codes,
      rationale: decision.rationale,
    });
    if (inserted.replayed) {
      // Re-fetch the winning row and take the recovery path from the STORED
      // snapshot. This cannot loop: findSettlementByInputKey now returns the row.
      const winner = rt.findSettlementByInputKey(key);
      if (!winner) {
        throw new SettlementValidationError(
          `settlement: replayed insert vanished on re-read (proposal ${proposalRow.id})`,
        );
      }
      const storedSnapshot = this.parseAndVerifyStoredSnapshot(winner, key, policy, proposalRow);
      const winnerCert = rt.readCertificateForSettlement(winner.id);
      if (winnerCert) {
        // ONE verifier (same as existing-certificate path): rebuild expected
        // payload, compare canonical payloads + hash + every row column. Catches
        // a corrupted payload with an unchanged hash that would otherwise pass
        // the replayed-race branch.
        const expectedPayload = this.buildExpectedCertificatePayload(winner, storedSnapshot);
        const expectedHash = hashOutcomeCertificate(expectedPayload);
        this.verifyCertificateRecord(winnerCert, winner, storedSnapshot);
        if (winner.status !== 'certificate_issued') {
          rt.reconcileExistingCertificate(this.buildAtomicInput(winner, key, storedSnapshot.snapshot, storedSnapshot.inputHash, expectedPayload, expectedHash));
        }
        return {
          status: 'issued',
          settlementId: winner.id,
          certificateId: winnerCert.id,
          certificateHash: winnerCert.certificate_hash,
          policyVersion: winner.policy_version,
          policyHash: winner.policy_hash,
          decision: winner.decision,
          reasonCodes: winner.reason_codes,
          error: null,
        };
      }
      const rebuilt = this.issueCertificate(
        rt, winner.id, winner.epic_id, winner.decision, winner.reason_codes,
        key, storedSnapshot.snapshot, storedSnapshot.inputHash, winner.created_at, winner.rationale,
      );
      return {
        status: 'issued',
        settlementId: winner.id,
        certificateId: rebuilt.certificateId,
        certificateHash: rebuilt.certificateHash,
        policyVersion: winner.policy_version,
        policyHash: winner.policy_hash,
        decision: winner.decision,
        reasonCodes: winner.reason_codes,
        error: null,
      };
    }
    const settlement = inserted.record;

    // 9-11. Build + persist the immutable certificate atomically. The
    // deterministic issued_at is the settlement's created_at so a recovery
    // rebuild produces a byte-identical certificate (persisted in BOTH the row
    // and the payload).
    try {
      const issued = this.issueCertificate(
        rt, settlement.id, request.epicId, decision.decision, decision.reason_codes,
        key, snapshot, inputHash, settlement.created_at, decision.rationale,
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
    rt: FactoryDiscoveryRuntimePersistence,
    settlementId: number,
    epicId: number,
    decision: 'go' | 'clarify' | 'reject',
    reasonCodes: DiscoverySettlementReasonCode[],
    key: SettlementInputKey,
    snapshot: DiscoverySettlementInputSnapshot,
    inputHash: string,
    issuedAt: string,
    rationale: string,
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
    // ONE ATOMIC operation: verify settlement state -> insert/reuse certificate
    // (write-once, issued_at persisted) -> transition computed|failed ->
    // certificate_issued -> commit. Never return issued before the tx commits.
    // Co-tamper (payload + hash changed together to agree with each other but
    // not with our recomputation) is rejected inside the tx.
    const { record: cert } = rt.issueCertificateAtomically({
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
      expectedCertificateHash: expectedHash,
      issuedAt,
      inputSnapshotText: canonicalJson(snapshot),
      rationale,
    });
    return { certificateId: cert.id, certificateHash: cert.certificate_hash };
  }

  /**
   * Parse the stored settlement input_snapshot and STRICTLY validate it against
   * EVERY settlement/key field: schema_version, epic_id, proposal id/hash,
   * readiness target/id/hash/payload consistency, policy version/hash, decision,
   * reason codes, AND rationale. A tampered snapshot/input_hash/key mismatch, an
   * internal contradiction (key says readiness=failed, snapshot says missing),
   * or a policy-replay disagreement is rejected. Returns the parsed snapshot +
   * recomputed input hash for certificate rebuild.
   */
  private parseAndVerifyStoredSnapshot(
    settlement: SettlementRecord,
    key: SettlementInputKey,
    policy: DiscoverySettlementPolicy,
    currentProposal: SettlementProposalRecord,
  ): { snapshot: DiscoverySettlementInputSnapshot; inputHash: string } {
    // P0-3: delegates to the shared verifier (single source of truth, also used
    // by D5). Wrapped so D4's observable SettlementValidationError identity +
    // messages are preserved bit-for-bit.
    return parseAndVerifyStoredSnapshotShared(
      settlement,
      key,
      policy,
      currentProposal,
      (message) => new SettlementValidationError(message),
    );
  }

  /**
   * Full readiness lineage binding (P1). Verify the assessment is owned by a
   * ControlIntent that targets THIS exact Proposal, that the ControlIntent's
   * authority WorkIntent is well-formed (correct kind + output schema + epic),
   * and that the assessment's task_id matches the ControlIntent's projected
   * advisor task. This closes the gap where an assessment could be linked to
   * the wrong ControlIntent/task.
   */
  private verifyReadinessLineage(
    rt: FactoryDiscoveryRuntimePersistence,
    assessment: ReadinessAssessmentRecord,
    proposal: SettlementProposalRecord,
  ): void {
    // P0-3: delegates to the shared lineage verifier (single source of truth).
    // Wrapped so D4's observable SettlementValidationError identity + messages
    // are preserved bit-for-bit.
    verifyReadinessLineageShared(
      rt,
      assessment,
      proposal,
      (message) => new SettlementValidationError(message),
    );
  }

  /**
   * ONE certificate verifier used in every existing-certificate path (normal
   * replay, replayed-insert winner, atomic reuse/reconcile). Rebuilds the
   * expected payload from the verified stored settlement + snapshot and checks:
   *   - canonicalJson(stored payload) === canonicalJson(expected payload);
   *   - stored certificate_hash === hash(expected payload);
   *   - every certificate ROW lineage column matches the expected values:
   *     epic_id, proposal_id, proposal_content_hash, readiness_assessment_id,
   *     readiness_assessment_hash (encoded target), policy_version, policy_hash,
   *     decision, reason_codes, input_hash, issued_at (== settlement.created_at
   *     AND == payload.issued_at).
   * A co-tamper (payload + hash changed together) is caught because the rebuild
   * ignores the stored payload; a row-only tamper (column changed without
   * touching payload/hash) is caught by the row-column checks.
   */
  private verifyCertificateRecord(
    cert: OutcomeCertificateRecord,
    settlement: SettlementRecord,
    stored: { snapshot: DiscoverySettlementInputSnapshot; inputHash: string },
  ): void {
    // P0-3: delegates to the shared certificate verifier (single source of
    // truth). Wrapped so D4's observable SettlementValidationError identity +
    // messages are preserved bit-for-bit.
    verifyCertificateRecordShared(
      cert,
      settlement,
      stored,
      (message) => new SettlementValidationError(message),
    );
  }

  /**
   * Build the EXPECTED certificate payload from a verified stored settlement +
   * snapshot. Delegates to the shared builder so every path (verify, reconcile,
   * issue, bundle) builds the identical payload.
   */
  private buildExpectedCertificatePayload(
    settlement: SettlementRecord,
    stored: { snapshot: DiscoverySettlementInputSnapshot; inputHash: string },
  ): ReturnType<typeof buildOutcomeCertificatePayload> {
    return buildExpectedCertificatePayloadShared(settlement, stored);
  }

  /**
   * Build the full IssueCertificateAtomicallyInput for the atomic port ops
   * (issue + reconcile), carrying the expected certificate payload + settlement
   * lineage so the atomic boundary can re-verify them inside BEGIN IMMEDIATE.
   */
  private buildAtomicInput(
    settlement: SettlementRecord,
    key: SettlementInputKey,
    snapshot: DiscoverySettlementInputSnapshot,
    inputHash: string,
    expectedPayload: ReturnType<typeof buildOutcomeCertificatePayload>,
    expectedHash: string,
  ): IssueCertificateAtomicallyInput {
    return {
      settlementId: settlement.id,
      epicId: settlement.epic_id,
      proposalId: snapshot.proposal.id,
      proposalContentHash: snapshot.proposal.content_hash,
      readinessAssessmentId: snapshot.readiness.assessment_id,
      readinessAssessmentHash: key.readinessTarget,
      policyVersion: settlement.policy_version,
      policyHash: settlement.policy_hash,
      decision: settlement.decision,
      reasonCodes: settlement.reason_codes,
      inputHash,
      certificatePayload: expectedPayload,
      expectedCertificateHash: expectedHash,
      issuedAt: settlement.created_at,
      // Bind the atomic tx to the EXACT canonical snapshot text + rationale so a
      // TOCTOU change to input_snapshot/rationale between service validation and
      // BEGIN IMMEDIATE is rejected inside the transaction.
      inputSnapshotText: canonicalJson(snapshot),
      rationale: settlement.rationale,
    };
  }
}

// Re-export for the engine/composition root.
export {
  DISCOVERY_SETTLEMENT_POLICY_VERSION,
  POLICY_V1_CONTENT_HASH,
};
