/**
 * DiscoveryCertificateBundle — the SINGLE source of truth for "is this
 * DiscoveryOutcomeCertificate authoritative, and what are its verified inputs?"
 *
 * Roadmap D5 correction (P0-3). D5's diagnosis target-verifier previously kept a
 * WEAK, INDEPENDENT copy of D4's certificate verification: it compared the
 * stored hash, checked a few settlement columns, parsed the snapshot, but did
 * NOT recompute the certificate_hash from the certificate_payload, did NOT
 * rebuild the expected certificate, did NOT verify settlement.status ===
 * 'certificate_issued', and did NOT do a full snapshot/policy replay. That made
 * D5's view of the certificate weaker than D4's, so a tamper D4 would reject
 * could pass D5's target gate and let the diagnosis worker reason over a
 * corrupted target.
 *
 * This module consolidates the FULL D4 verification discipline into one
 * read-only verifier that BOTH D4 (settlement service) and D5 (diagnosis
 * service) call. It performs:
 *
 *   1. Load the certificate by exact id; compare certificate_hash to expected.
 *   2. Load the settlement; require status === 'certificate_issued'; verify the
 *      settlement/certificate relation (settlement_id, input_hash, decision,
 *      reason codes, policy version/hash).
 *   3. Parse + fully verify the stored input_snapshot (schema_version, epic_id,
 *      proposal id/hash, nested proposal payload integrity, lineage ids, policy
 *      version/hash, readiness target/id/hash/payload consistency, recompute
 *      input_hash, policy replay).
 *   4. Rebuild the expected certificate payload from settlement + snapshot,
 *      recompute its hash, and verify the stored payload is byte-identical
 *      (canonical) to the rebuild, the stored hash === rebuilt hash, and EVERY
 *      certificate row lineage column matches.
 *   5. For accepted readiness: re-load + verify the exact assessment (status,
 *      exact proposal binding, full ControlIntent/authority/task lineage, strict
 *      payload re-validation with the shared source-ref collector, recompute
 *      content hash).
 *
 * The function takes the runtime persistence PORT (never getDb, never inline
 * SQL). It throws CertificateBundleError on ANY mismatch with a precise message.
 * D4 wraps the shared sub-verifiers to keep its SettlementValidationError name
 * (preserving observable behaviour); D5 calls verifyDiscoveryCertificateBundle
 * directly and maps the failure to status='failed'.
 */
import { createHash } from 'node:crypto';

import type {
  Saga3DiscoveryRuntimePersistence,
  SettlementInputKey,
  SettlementProposalRecord,
} from '../persistence/saga3-discovery-runtime-port.js';
import type {
  OutcomeCertificateRecord,
  SettlementRecord,
} from '../domain/discovery-settlement-records.js';
import type { ReadinessAssessmentRecord } from '../domain/discovery-readiness-records.js';
import type { WorkIntent } from '../domain/work-intent.js';
import { DISCOVERY_READINESS_INTENT_KIND } from '../domain/work-intent.js';
import type { DiscoveryProposalPayload } from '../domain/discovery-proposal.js';
import { DISCOVERY_PROPOSAL_SCHEMA, validateDiscoveryProposal } from '../domain/discovery-proposal.js';
import {
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  validateReadinessAssessment,
} from '../domain/discovery-readiness-assessment.js';
import {
  DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
  buildSettlementInputHash,
  type DiscoverySettlementInputSnapshot,
  type SettlementReadinessStatus,
} from '../domain/discovery-settlement-input.js';
import {
  type DiscoverySettlementDecision,
  type DiscoverySettlementPolicy,
} from '../domain/discovery-settlement-policy.js';
import {
  buildOutcomeCertificatePayload,
  hashOutcomeCertificate,
} from '../domain/discovery-outcome-certificate.js';
import { canonicalJson, collectDiscoverySourceRefs, sha256Hex } from '../shared/discovery-canonical.js';

/**
 * The verified bundle returned by verifyDiscoveryCertificateBundle. Every field
 * has passed the FULL D4 verification discipline. Callers (D4 recovery, D5
 * diagnosis) build downstream artifacts EXCLUSIVELY from this bundle.
 */
export interface VerifiedCertificateBundle {
  /** The verified certificate row (hash matches expected; payload canonical). */
  certificate: OutcomeCertificateRecord;
  /** The verified settlement row (status === 'certificate_issued'). */
  settlement: SettlementRecord;
  /** The parsed + fully verified input snapshot. */
  snapshot: DiscoverySettlementInputSnapshot;
  /** input_hash recomputed from the snapshot; === settlement.input_hash. */
  inputHash: string;
  /** The verified canonical proposal row the certificate was issued against. */
  proposal: SettlementProposalRecord;
  /** Recomputed canonical proposal content hash; === proposal.content_hash. */
  proposalHash: string;
  /**
   * The verified accepted readiness assessment, or null when the snapshot
   * readiness is missing/failed/paused. When non-null, full lineage + payload
   * + hash have been re-verified.
   */
  readinessAssessment: ReadinessAssessmentRecord | null;
  /** The deterministic policy replay over the snapshot (decision + rationale). */
  policyDecision: DiscoverySettlementDecision;
}

/**
 * Named error thrown by verifyDiscoveryCertificateBundle (and the shared
 * sub-verifiers when called directly). D5 catches this and maps it to
 * status='failed'; the D4 settlement service wraps the shared sub-verifiers so
 * its observable SettlementValidationError name is preserved.
 */
export class CertificateBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateBundleError';
  }
}

/**
 * Encode a settlement readiness status + (optional) content hash into the
 * semantic readiness-target string used in the idempotency key, settlement row,
 * and certificate row. Extracted as the SINGLE source of truth so D4 and the
 * bundle verifier never disagree on the encoding.
 *
 *   accepted_by_kernel -> 'accepted:<hash>' (or 'accepted:none' if hash absent)
 *   missing | failed | paused -> the status literal
 */
export function encodeReadinessTarget(
  status: SettlementReadinessStatus,
  contentHash: string | null,
): string {
  if (status === 'accepted_by_kernel') {
    return contentHash ? `accepted:${contentHash}` : 'accepted:none';
  }
  return status; // 'missing' | 'failed' | 'paused'
}

/**
 * Read the certificate by exact id; throw if missing. Used by both D4 (which
 * reads by settlement id via a different port method) and the bundle verifier
 * (which reads by certificate id). Exported so D4 can re-use it if needed.
 */
export function readCertificateOrFail(
  rt: Saga3DiscoveryRuntimePersistence,
  certificateId: number,
): OutcomeCertificateRecord {
  const cert = rt.readOutcomeCertificate(certificateId);
  if (!cert) {
    throw new CertificateBundleError(
      `certificate ${certificateId} not found`,
    );
  }
  return cert;
}

/**
 * Parse + fully verify a stored settlement input_snapshot against the settlement
 * row and the canonical Proposal. Consolidates D4's parseAndVerifyStoredSnapshot
 * so the bundle verifier and D4 perform byte-identical verification.
 *
 * `error` is a factory that wraps a precise message in the caller's preferred
 * error class (CertificateBundleError for the bundle path,
 * SettlementValidationError for D4). This lets the two paths share the FULL
 * verification logic while preserving their observable error identity.
 *
 * Returns the parsed snapshot + recomputed input hash.
 */
export function parseAndVerifyStoredSnapshotShared(
  settlement: SettlementRecord,
  key: SettlementInputKey,
  policy: DiscoverySettlementPolicy,
  currentProposal: SettlementProposalRecord,
  error: (message: string) => Error,
): { snapshot: DiscoverySettlementInputSnapshot; inputHash: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settlement.input_snapshot);
  } catch {
    throw error(
      `settlement ${settlement.id}: stored input_snapshot is not valid JSON`,
    );
  }
  const snap = parsed as DiscoverySettlementInputSnapshot;
  // Schema version.
  if (snap.schema_version !== DISCOVERY_SETTLEMENT_INPUT_SCHEMA) {
    throw error(
      `settlement ${settlement.id}: snapshot schema_version '${snap.schema_version}' is not ${DISCOVERY_SETTLEMENT_INPUT_SCHEMA}`,
    );
  }
  // Epic binding.
  if (snap.epic_id !== settlement.epic_id) {
    throw error(
      `settlement ${settlement.id}: snapshot epic_id ${snap.epic_id} != settlement epic_id ${settlement.epic_id}`,
    );
  }
  // Proposal id + hash binding.
  if (snap.proposal.id !== settlement.proposal_id
      || snap.proposal.content_hash !== settlement.proposal_content_hash
      || snap.proposal.id !== key.proposalId
      || snap.proposal.content_hash !== key.proposalContentHash) {
    throw error(
      `settlement ${settlement.id}: snapshot proposal id/hash does not match the settlement/key`,
    );
  }
  // NESTED Proposal payload integrity: validate structurally + recompute content
  // hash. input_hash alone is NOT an independent anchor (it lives in the same
  // mutable row); the Proposal hash is. A coherent tamper that edits the
  // payload, leaves content_hash, and rewrites input_hash would otherwise pass.
  const proposalValidation = validateDiscoveryProposal(snap.proposal.payload);
  if (!proposalValidation.valid) {
    throw error(
      `settlement ${settlement.id}: snapshot proposal payload failed re-validation: ${proposalValidation.errors.join('; ')}`,
    );
  }
  const proposalPayloadHash = sha256Hex(snap.proposal.payload);
  if (proposalPayloadHash !== snap.proposal.content_hash) {
    throw error(
      `settlement ${settlement.id}: snapshot proposal payload hash does not match snapshot.proposal.content_hash`,
    );
  }
  // The stored snapshot Proposal payload must be byte-identical (canonically) to
  // the canonical Proposal loaded at the start of settle(), and the lineage ids
  // must agree. This binds the stored snapshot to the live canonical row.
  if (canonicalJson(snap.proposal.payload) !== canonicalJson(currentProposal.payload)) {
    throw error(
      `settlement ${settlement.id}: snapshot proposal payload does not match the canonical Proposal payload`,
    );
  }
  if (snap.proposal.source_intent_id !== currentProposal.intent_id
      || snap.proposal.source_submission_id !== currentProposal.source_submission_id
      || snap.proposal.normalization_proposal_id !== currentProposal.normalization_proposal_id) {
    throw error(
      `settlement ${settlement.id}: snapshot proposal lineage ids do not match the canonical Proposal`,
    );
  }
  // Policy version + hash binding.
  if (snap.policy.version !== settlement.policy_version
      || snap.policy.content_hash !== settlement.policy_hash
      || snap.policy.version !== key.policyVersion
      || snap.policy.content_hash !== key.policyHash) {
    throw error(
      `settlement ${settlement.id}: snapshot policy version/hash does not match the settlement/key`,
    );
  }
  // Readiness target/id/hash/payload consistency. The encoded readiness target
  // in the settlement row must match the snapshot's readiness status + hash.
  const expectedTarget = encodeReadinessTarget(snap.readiness.status, snap.readiness.content_hash);
  if (expectedTarget !== settlement.readiness_assessment_hash
      || expectedTarget !== key.readinessTarget) {
    throw error(
      `settlement ${settlement.id}: snapshot readiness target '${expectedTarget}' does not match the settlement/key`,
    );
  }
  if (snap.readiness.assessment_id !== settlement.readiness_assessment_id) {
    throw error(
      `settlement ${settlement.id}: snapshot readiness.assessment_id ${snap.readiness.assessment_id} != settlement ${settlement.readiness_assessment_id}`,
    );
  }
  // Accepted readiness MUST carry non-null payload/id/hash; non-accepted MUST
  // carry null payload/id/hash (ALL three — a non-null assessment_id alone on a
  // failed snapshot is an internal contradiction). Independent anchor check.
  if (snap.readiness.status === 'accepted_by_kernel') {
    if (snap.readiness.payload === null
        || snap.readiness.assessment_id === null
        || snap.readiness.content_hash === null) {
      throw error(
        `settlement ${settlement.id}: snapshot readiness accepted_by_kernel must carry non-null payload/id/hash`,
      );
    }
    // NESTED readiness payload integrity: validate + recompute content hash.
    const allowedRefs = collectDiscoverySourceRefs(
      {
        proposalId: snap.proposal.id,
        sourceSubmissionId: snap.proposal.source_submission_id,
        normalizationProposalId: snap.proposal.normalization_proposal_id,
      },
      snap.proposal.payload as DiscoveryProposalPayload,
    );
    const readinessValidation = validateReadinessAssessment(
      snap.readiness.payload,
      snap.proposal.id,
      snap.proposal.content_hash,
      allowedRefs,
    );
    if (!readinessValidation.valid) {
      throw error(
        `settlement ${settlement.id}: snapshot readiness payload failed re-validation: ${readinessValidation.errors.join('; ')}`,
      );
    }
    const readinessPayloadHash = sha256Hex(snap.readiness.payload);
    if (readinessPayloadHash !== snap.readiness.content_hash) {
      throw error(
        `settlement ${settlement.id}: snapshot readiness payload hash does not match snapshot.readiness.content_hash`,
      );
    }
  } else {
    // missing | failed | paused: assessment_id, content_hash, AND payload must
    // all be null.
    if (snap.readiness.payload !== null
        || snap.readiness.content_hash !== null
        || snap.readiness.assessment_id !== null) {
      throw error(
        `settlement ${settlement.id}: snapshot readiness ${snap.readiness.status} must carry null payload/content_hash/assessment_id`,
      );
    }
  }
  // Verify the snapshot's own hash matches the row's recorded input_hash.
  const recomputed = buildSettlementInputHash(snap);
  if (recomputed !== settlement.input_hash) {
    throw error(
      `settlement ${settlement.id}: stored input_hash does not match recomputed snapshot hash`,
    );
  }
  // Re-run the policy against the STORED snapshot and confirm the decision +
  // reason codes AND rationale are unchanged.
  const replay = policy.settle(snap);
  if (replay.decision !== settlement.decision
      || !arrayEquals(replay.reason_codes, settlement.reason_codes)
      || replay.rationale !== settlement.rationale) {
    throw error(
      `settlement ${settlement.id}: stored decision/reason_codes/rationale do not match a policy replay of the stored snapshot`,
    );
  }
  return { snapshot: snap, inputHash: recomputed };
}

/**
 * Full readiness lineage binding. Verify the accepted assessment is owned by a
 * ControlIntent that targets THIS exact Proposal, that the ControlIntent's
 * authority WorkIntent is well-formed (correct kind + output schema + epic), and
 * that the assessment's task_id matches the ControlIntent's projected advisor
 * task. Consolidates D4's verifyReadinessLineage.
 */
export function verifyReadinessLineageShared(
  rt: Saga3DiscoveryRuntimePersistence,
  assessment: ReadinessAssessmentRecord,
  proposal: SettlementProposalRecord,
  error: (message: string) => Error,
): void {
  const control = rt.readReadinessControlForProposal(proposal.id, proposal.content_hash);
  if (!control) {
    throw error(
      `settlement: no readiness ControlIntent for proposal ${proposal.id}`,
    );
  }
  // ControlIntent must own this assessment.
  if (assessment.control_intent_id !== control.id) {
    throw error(
      `settlement: readiness assessment ${assessment.id} belongs to control ${assessment.control_intent_id}, not the proposal's control ${control.id}`,
    );
  }
  // ControlIntent target + epic + kind + source intent.
  if (control.proposal_id !== proposal.id
      || control.proposal_content_hash !== proposal.content_hash) {
    throw error(
      `settlement: readiness ControlIntent ${control.id} targets a different proposal version`,
    );
  }
  if (control.epic_id !== proposal.epic_id) {
    throw error(
      `settlement: readiness ControlIntent ${control.id} epic ${control.epic_id} != proposal epic ${proposal.epic_id}`,
    );
  }
  if (control.kind !== 'AssessDiscoveryReadiness') {
    throw error(
      `settlement: readiness ControlIntent ${control.id} kind '${control.kind}' is not 'AssessDiscoveryReadiness'`,
    );
  }
  if (control.source_intent_id !== proposal.intent_id) {
    throw error(
      `settlement: readiness ControlIntent ${control.id} source_intent_id ${control.source_intent_id} != proposal intent ${proposal.intent_id}`,
    );
  }
  // Authority WorkIntent well-formedness.
  const authority: WorkIntent | null = rt.readWorkIntent(control.authority_intent_id);
  if (!authority) {
    throw error(
      `settlement: readiness ControlIntent ${control.id} authority WorkIntent ${control.authority_intent_id} not found`,
    );
  }
  if (authority.kind !== DISCOVERY_READINESS_INTENT_KIND) {
    throw error(
      `settlement: authority WorkIntent ${authority.id} kind '${authority.kind}' is not '${DISCOVERY_READINESS_INTENT_KIND}'`,
    );
  }
  if (authority.output_schema !== DISCOVERY_READINESS_ASSESSMENT_SCHEMA) {
    throw error(
      `settlement: authority WorkIntent ${authority.id} output_schema '${authority.output_schema}' is not '${DISCOVERY_READINESS_ASSESSMENT_SCHEMA}'`,
    );
  }
  if (authority.epic_id !== proposal.epic_id) {
    throw error(
      `settlement: authority WorkIntent ${authority.id} epic ${authority.epic_id} != proposal epic ${proposal.epic_id}`,
    );
  }
  // Projected-task + lifecycle completeness. An accepted assessment implies the
  // advisor actually ran to completion.
  if (control.projected_task_id === null) {
    throw error(
      `settlement: readiness ControlIntent ${control.id} has no projected_task_id (accepted assessment requires a projected task)`,
    );
  }
  if (authority.projected_task_id === null
      || authority.projected_task_id !== control.projected_task_id) {
    throw error(
      `settlement: authority WorkIntent ${authority.id} projected_task_id ${authority.projected_task_id} != control ${control.id} projected_task_id ${control.projected_task_id}`,
    );
  }
  if (assessment.task_id !== control.projected_task_id) {
    throw error(
      `settlement: readiness assessment ${assessment.id} task_id ${assessment.task_id} != control ${control.id} projected_task_id ${control.projected_task_id}`,
    );
  }
  // Lifecycle: an accepted assessment means the advisor closed cleanly.
  if (control.status !== 'concluded') {
    throw error(
      `settlement: readiness ControlIntent ${control.id} status '${control.status}' is not 'concluded' (accepted assessment requires a concluded control)`,
    );
  }
  if (authority.status !== 'concluded') {
    throw error(
      `settlement: authority WorkIntent ${authority.id} status '${authority.status}' is not 'concluded' (accepted assessment requires a concluded authority)`,
    );
  }
}

/**
 * Build the EXPECTED certificate payload from a verified stored settlement +
 * snapshot. Centralised so every path (verify, reconcile, issue, bundle) builds
 * the identical payload.
 */
export function buildExpectedCertificatePayloadShared(
  settlement: SettlementRecord,
  stored: { snapshot: DiscoverySettlementInputSnapshot; inputHash: string },
): ReturnType<typeof buildOutcomeCertificatePayload> {
  return buildOutcomeCertificatePayload({
    epic_id: settlement.epic_id,
    proposalId: stored.snapshot.proposal.id,
    proposalContentHash: stored.snapshot.proposal.content_hash,
    readinessStatus: stored.snapshot.readiness.status,
    readinessAssessmentId: stored.snapshot.readiness.assessment_id,
    readinessContentHash: stored.snapshot.readiness.content_hash,
    decision: {
      decision: settlement.decision,
      reason_codes: settlement.reason_codes,
      rationale: '',
      policy_version: settlement.policy_version,
      policy_hash: settlement.policy_hash,
    },
    settlementInputHash: stored.inputHash,
    issuedAt: settlement.created_at,
  });
}

/**
 * ONE certificate verifier used in every existing-certificate path (normal
 * replay, replayed-insert winner, atomic reuse/reconcile, bundle). Rebuilds the
 * expected payload from the verified stored settlement + snapshot and checks:
 *   - canonicalJson(stored payload) === canonicalJson(expected payload);
 *   - stored certificate_hash === hash(expected payload);
 *   - every certificate ROW lineage column matches the expected values:
 *     epic_id, proposal_id, proposal_content_hash, readiness_assessment_id,
 *     readiness_assessment_hash (encoded target), policy_version, policy_hash,
 *     decision, reason_codes, input_hash, issued_at (== settlement.created_at
 *     AND == payload.issued_at).
 * A co-tamper (payload + hash changed together) is caught because the rebuild
 * ignores the stored payload; a row-only tamper is caught by the row checks.
 */
export function verifyCertificateRecordShared(
  cert: OutcomeCertificateRecord,
  settlement: SettlementRecord,
  stored: { snapshot: DiscoverySettlementInputSnapshot; inputHash: string },
  error: (message: string) => Error,
): void {
  const expectedPayload = buildExpectedCertificatePayloadShared(settlement, stored);
  const expectedHash = hashOutcomeCertificate(expectedPayload);
  // Stored payload must be byte-identical (canonical) to the rebuild.
  let parsedStoredPayload: unknown;
  try {
    parsedStoredPayload = JSON.parse(cert.certificate_payload);
  } catch {
    throw error(
      `settlement ${settlement.id}: stored certificate_payload is not valid JSON`,
    );
  }
  if (canonicalJson(parsedStoredPayload) !== canonicalJson(expectedPayload)) {
    throw error(
      `settlement ${settlement.id}: stored certificate_payload does not match the rebuilt expected payload`,
    );
  }
  // Stored hash must equal the rebuild hash.
  if (cert.certificate_hash !== expectedHash) {
    throw error(
      `settlement ${settlement.id}: stored certificate_hash does not match the rebuilt expected hash`,
    );
  }
  // Encoded readiness target expected on the certificate row.
  const expectedTarget = encodeReadinessTarget(
    stored.snapshot.readiness.status,
    stored.snapshot.readiness.content_hash,
  );
  // Row lineage columns — every one must match.
  const rowChecks: Array<[string, unknown, unknown]> = [
    ['epic_id', cert.epic_id, settlement.epic_id],
    ['proposal_id', cert.proposal_id, settlement.proposal_id],
    ['proposal_content_hash', cert.proposal_content_hash, settlement.proposal_content_hash],
    ['readiness_assessment_id', cert.readiness_assessment_id, settlement.readiness_assessment_id],
    ['readiness_assessment_hash', cert.readiness_assessment_hash, expectedTarget],
    ['policy_version', cert.policy_version, settlement.policy_version],
    ['policy_hash', cert.policy_hash, settlement.policy_hash],
    ['decision', cert.decision, settlement.decision],
    ['reason_codes', JSON.stringify(cert.reason_codes), JSON.stringify(settlement.reason_codes)],
    ['input_hash', cert.input_hash, settlement.input_hash],
    ['issued_at', cert.issued_at, settlement.created_at],
  ];
  for (const [field, actual, expected] of rowChecks) {
    if (actual !== expected) {
      throw error(
        `settlement ${settlement.id}: certificate row ${field} '${actual}' != expected '${expected}'`,
      );
    }
  }
  // issued_at in the payload must equal the row's issued_at.
  const payloadIssuedAt = (parsedStoredPayload as { issued_at?: unknown }).issued_at;
  if (payloadIssuedAt !== cert.issued_at) {
    throw error(
      `settlement ${settlement.id}: certificate payload issued_at '${payloadIssuedAt}' != row issued_at '${cert.issued_at}'`,
    );
  }
}

/**
 * The SINGLE verifier that consolidates the FULL D4 verification into one
 * read-only pass. Returns a VerifiedCertificateBundle — every field has been
 * re-verified. D4's recovery paths and D5's diagnosis target gate both call
 * this so neither maintains a weaker independent copy.
 *
 * `expectedHash` is the hash the caller holds for the certificate (the engine-
 * supplied hash for D5; the recomputed expected hash for D4). A mismatch throws
 * CertificateBundleError.
 *
 * `policy` is the deterministic settlement policy used to replay the snapshot.
 * `keyOpt`, when supplied, is additionally cross-checked against the stored
 * snapshot/settlement (the D4 recovery path has the key in hand and D4 has
 * always verified it; passing it keeps that cross-check). D5 omits it.
 */
export function verifyDiscoveryCertificateBundle(
  rt: Saga3DiscoveryRuntimePersistence,
  certificateId: number,
  expectedHash: string,
  policy: DiscoverySettlementPolicy,
  keyOpt?: SettlementInputKey,
): VerifiedCertificateBundle {
  const fail = (message: string) => new CertificateBundleError(message);

  // 1. Load the certificate by exact id; compare certificate_hash to expected.
  const certificate = readCertificateOrFail(rt, certificateId);
  if (certificate.certificate_hash !== expectedHash) {
    throw fail(
      `certificate ${certificateId} hash mismatch (stored ${certificate.certificate_hash.slice(0, 12)}, expected ${expectedHash.slice(0, 12)})`,
    );
  }

  // 2. Load the settlement; require status === 'certificate_issued'; verify the
  //    settlement/certificate relation. A certificate on a non-issued settlement
  //    is not authoritative (P0-3): a crash may have left a certificate attached
  //    to a computed/failed settlement.
  const settlement = rt.readSettlement(certificate.settlement_id);
  if (!settlement) {
    throw fail(
      `settlement ${certificate.settlement_id} for certificate ${certificate.id} not found`,
    );
  }
  if (settlement.status !== 'certificate_issued') {
    throw fail(
      `settlement ${settlement.id} status '${settlement.status}' is not 'certificate_issued' (certificate ${certificate.id} is not authoritative)`,
    );
  }
  if (certificate.settlement_id !== settlement.id) {
    throw fail(
      `certificate ${certificate.id} settlement_id ${certificate.settlement_id} != settlement.id ${settlement.id}`,
    );
  }
  if (certificate.input_hash !== settlement.input_hash) {
    throw fail(
      `certificate ${certificate.id} input_hash ${certificate.input_hash.slice(0, 12)} != settlement.input_hash ${settlement.input_hash.slice(0, 12)}`,
    );
  }
  if (certificate.epic_id !== settlement.epic_id) {
    throw fail(
      `certificate ${certificate.id} epic_id ${certificate.epic_id} != settlement epic_id ${settlement.epic_id}`,
    );
  }
  if (certificate.decision !== settlement.decision) {
    throw fail(
      `certificate ${certificate.id} decision ${certificate.decision} != settlement.decision ${settlement.decision}`,
    );
  }
  if (certificate.policy_version !== settlement.policy_version
      || certificate.policy_hash !== settlement.policy_hash) {
    throw fail(
      `certificate ${certificate.id} policy version/hash does not match the settlement`,
    );
  }
  if (JSON.stringify(certificate.reason_codes) !== JSON.stringify(settlement.reason_codes)) {
    throw fail(
      `certificate ${certificate.id} reason_codes do not match the settlement reason_codes`,
    );
  }

  // 3. Load + verify the canonical Proposal the snapshot embeds. The snapshot
  //    binds the certificate to an exact immutable Proposal version; we re-load
  //    the LIVE canonical row and re-validate its payload + hash so a tampered
  //    Proposal row cannot back a corrupted certificate.
  //    We need the Proposal id from the settlement row (the snapshot is parsed
  //    next, but the settlement row already carries proposal_id). The proposal
  //    id/hash on the settlement row are verified against the snapshot inside
  //    parseAndVerifyStoredSnapshotShared.
  const proposal = rt.readProposalForSettlement(settlement.proposal_id);
  if (!proposal) {
    throw fail(
      `proposal ${settlement.proposal_id} (from settlement ${settlement.id}) not found`,
    );
  }
  // EXACT target binding (mirrors D4 step 2a): kind/schema/status + epic.
  if (proposal.epic_id !== settlement.epic_id) {
    throw fail(
      `proposal ${proposal.id} epic_id ${proposal.epic_id} != settlement epic_id ${settlement.epic_id}`,
    );
  }
  if (proposal.kind !== 'discovery') {
    throw fail(
      `proposal ${proposal.id} kind '${proposal.kind}' is not 'discovery'`,
    );
  }
  if (proposal.schema_version !== DISCOVERY_PROPOSAL_SCHEMA) {
    throw fail(
      `proposal ${proposal.id} schema_version '${proposal.schema_version}' is not ${DISCOVERY_PROPOSAL_SCHEMA}`,
    );
  }
  if (proposal.status !== 'submitted') {
    throw fail(
      `proposal ${proposal.id} status '${proposal.status}' is not 'submitted'`,
    );
  }
  // Recompute the canonical Proposal content hash; compare to the stored hash.
  const proposalHash = createHash('sha256')
    .update(canonicalJson(proposal.payload)).digest('hex');
  if (proposalHash !== proposal.content_hash) {
    throw fail(
      `proposal ${proposal.id} content_hash mismatch (stored ${proposal.content_hash.slice(0, 12)}, recomputed ${proposalHash.slice(0, 12)})`,
    );
  }
  // Structural re-validation of the canonical payload (defence in depth).
  const proposalValidation = validateDiscoveryProposal(proposal.payload);
  if (!proposalValidation.valid) {
    throw fail(
      `proposal ${proposal.id} payload failed re-validation: ${proposalValidation.errors.join('; ')}`,
    );
  }

  // 4. Parse + fully verify the stored snapshot. The key is reconstructed from
  //    the settlement row (the bundle verifier does not take a request, so it
  //    has no engine-supplied key); when D4 passes its key we cross-check it.
  const key: SettlementInputKey = {
    proposalId: settlement.proposal_id,
    proposalContentHash: settlement.proposal_content_hash,
    readinessTarget: settlement.readiness_assessment_hash,
    policyVersion: settlement.policy_version,
    policyHash: settlement.policy_hash,
  };
  // If the caller supplied a key (D4 recovery), every field must agree with the
  // settlement row. This preserves D4's existing key/settlement cross-check.
  if (keyOpt) {
    const keyDriftFields: Array<[string, string, string]> = [
      ['proposalId', String(keyOpt.proposalId), String(key.proposalId)],
      ['proposalContentHash', keyOpt.proposalContentHash, key.proposalContentHash],
      ['readinessTarget', keyOpt.readinessTarget, key.readinessTarget],
      ['policyVersion', keyOpt.policyVersion, key.policyVersion],
      ['policyHash', keyOpt.policyHash, key.policyHash],
    ];
    for (const [field, supplied, row] of keyDriftFields) {
      if (supplied !== row) {
        throw fail(
          `settlement ${settlement.id}: supplied key ${field} '${supplied}' != settlement row '${row}'`,
        );
      }
    }
  }
  const { snapshot, inputHash } = parseAndVerifyStoredSnapshotShared(
    settlement, key, policy, proposal, fail,
  );

  // 5. Rebuild the expected certificate payload from settlement + snapshot,
  //    recompute its hash, and verify the stored certificate is byte-identical.
  verifyCertificateRecordShared(certificate, settlement, { snapshot, inputHash }, fail);

  // 6. For accepted readiness: re-load + verify the exact assessment (status,
  //    exact proposal binding, full lineage, strict payload re-validation,
  //    recompute content hash). For non-accepted readiness the snapshot null-
  //    anchor check (inside parseAndVerifyStoredSnapshotShared) already ensured
  //    assessment_id/content_hash/payload are all null.
  let readinessAssessment: ReadinessAssessmentRecord | null = null;
  if (snapshot.readiness.status === 'accepted_by_kernel') {
    const assessmentId = snapshot.readiness.assessment_id;
    // snapshot.readiness.assessment_id is non-null here (verified above), but
    // narrow for TS.
    if (assessmentId === null) {
      throw fail(
        `settlement ${settlement.id}: snapshot readiness accepted_by_kernel but assessment_id is null`,
      );
    }
    const assessment = rt.readReadinessAssessment(assessmentId);
    if (!assessment || assessment.status !== 'accepted_by_kernel') {
      throw fail(
        `readiness assessment ${assessmentId} not found or not accepted_by_kernel`,
      );
    }
    // EXACT proposal binding (id + hash).
    if (assessment.proposal_id !== proposal.id
        || assessment.proposal_content_hash !== proposal.content_hash) {
      throw fail(
        `readiness assessment ${assessment.id} targets proposal ${assessment.proposal_id}/${assessment.proposal_content_hash.slice(0, 12)}, not ${proposal.id}/${proposal.content_hash.slice(0, 12)}`,
      );
    }
    // assessment_id on the assessment row must agree with the snapshot.
    if (snapshot.readiness.assessment_id !== assessment.id) {
      throw fail(
        `readiness assessment ${assessment.id} != snapshot.readiness.assessment_id ${snapshot.readiness.assessment_id}`,
      );
    }
    // Full ControlIntent/authority/task lineage.
    verifyReadinessLineageShared(rt, assessment, proposal, fail);
    // Strict payload re-validation with the shared source-ref collector.
    const allowedRefs = collectDiscoverySourceRefs(
      {
        proposalId: proposal.id,
        sourceSubmissionId: proposal.source_submission_id,
        normalizationProposalId: proposal.normalization_proposal_id,
      },
      proposal.payload as DiscoveryProposalPayload,
    );
    const readinessValidation = validateReadinessAssessment(
      assessment.payload,
      proposal.id,
      proposalHash,
      allowedRefs,
    );
    if (!readinessValidation.valid) {
      throw fail(
        `readiness assessment ${assessment.id} failed re-validation: ${readinessValidation.errors.join('; ')}`,
      );
    }
    // Recompute the assessment content hash; must match the stored hash.
    const readinessHash = sha256Hex(assessment.payload);
    if (readinessHash !== assessment.content_hash) {
      throw fail(
        `readiness assessment ${assessment.id} content_hash mismatch (stored ${assessment.content_hash.slice(0, 12)}, recomputed ${readinessHash.slice(0, 12)})`,
      );
    }
    // The snapshot's embedded readiness content hash must equal the assessment
    // row's content hash (closes a drift between snapshot and live assessment).
    if (snapshot.readiness.content_hash !== assessment.content_hash) {
      throw fail(
        `settlement ${settlement.id}: snapshot readiness content_hash ${snapshot.readiness.content_hash?.slice(0, 12)} != assessment ${assessment.id} content_hash ${assessment.content_hash.slice(0, 12)}`,
      );
    }
    readinessAssessment = assessment;
  }

  // 7. Policy replay (already performed inside parseAndVerifyStoredSnapshotShared,
  //    which asserts decision/reason_codes/rationale agree). Surface the replay
  //    decision in the bundle.
  const policyDecision = policy.settle(snapshot);

  return {
    certificate,
    settlement,
    snapshot,
    inputHash,
    proposal,
    proposalHash,
    readinessAssessment,
    policyDecision,
  };
}

function arrayEquals<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
