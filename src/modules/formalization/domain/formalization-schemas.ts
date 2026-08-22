/** Formalization boundary schemas. */

export {
  FORMALIZATION_CASE_SCHEMA,
} from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import {
  buildOrderConstraintRegister,
  orderConstraintRegisterRef,
  verifyOrderConstraintRegister,
  type OrderConstraintClass,
  type OrderConstraintRegister,
} from '../../../shared/constraint-register.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
export const SOLUTION_CONTRACT_CERTIFICATE_SCHEMA = 'factory.solution-contract-certificate.v1';
export const FORMALIZATION_SETTLEMENT_INPUT_SCHEMA = 'factory.formalization-settlement-input.v1';
export const FORMALIZATION_PRODUCT_BUNDLE_SCHEMA = 'factory.formalization-product-bundle.v1';
export const FORMALIZATION_USE_CASE_BUNDLE_SCHEMA = 'factory.formalization-use-case-bundle.v1';
export const FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA = 'factory.formalization-acceptance-bundle.v1';
export const FORMALIZATION_RECONCILIATION_SCHEMA = 'factory.formalization-reconciliation-report.v1';
export const FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA = 'factory.formalization-architecture-bundle.v1';
export const ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA = 'factory.acceptance-baseline-snapshot.v1';
export const FORMALIZATION_SRS_SCHEMA = 'factory.srs.v1';
export const FORMALIZATION_CERTIFICATE_SCHEMA_VERSION =
  'factory.solution-contract-certificate.generic.v1';

/**
 * AC-drift remedy: the constraint register binding carried on the
 * FormalizationCase. The register itself is owned by discovery settlement
 * (digest-pinned into its certificate); this binding is the SAME register
 * resolved through the case's sealed discoveryProposalPayload — one source,
 * deterministic rebuild, never a second authority (ADR-053).
 */
export interface FormalizationConstraintRegisterBinding {
  /** Content-addressed register ref: constraint-register:<digest>. */
  readonly constraintRegisterRef: string;
  readonly constraintRegisterDigest: string;
  readonly constraintRegister: OrderConstraintRegister;
}

export interface FormalizationCase {
  schemaVersion: typeof FORMALIZATION_CASE_SCHEMA;
  discoveryEpicId: number;
  formalizationEpicId: number;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  discoveryOutcome: string;
  /** Accepted semantic WHAT from Discovery; certificate alone is insufficient. */
  discoveryProposalRef: string;
  discoveryProposalHash: string;
  discoveryProposalPayload: Readonly<Record<string, unknown>>;
  /** Original request retained as an independent information-conservation anchor. */
  initiativeSubject: string;
  initiatedBy: string;
  /**
   * Optional because the register is DERIVED, not handoff-authored: the
   * lifecycle mapping already carries the full discoveryProposalPayload, and
   * the strict JSON-path resolver cannot map optional source paths. Resolve
   * via resolveFormalizationCaseConstraintRegister — the identical pure
   * builder discovery settlement used.
   */
  constraintRegister?: FormalizationConstraintRegisterBinding;
}

/**
 * Deterministically resolve the constraint register binding from a
 * FormalizationCase's sealed discoveryProposalPayload. Same input → same
 * binding (positional IDs + content digest), so every consumer (the A1
 * disposition gate, the A2 coverage diffs, the A3 warrantRef) sees exactly
 * one register. Returns null when the proposal carried no constraints
 * (retro-compat: empty downstream diffs, existing gates stay green).
 */
export function resolveFormalizationCaseConstraintRegister(
  formalizationCase: FormalizationCase,
): FormalizationConstraintRegisterBinding | null {
  if (formalizationCase.constraintRegister) {
    return formalizationCase.constraintRegister;
  }
  const payload = formalizationCase.discoveryProposalPayload as {
    order_constraints?: unknown;
  };
  const register = buildOrderConstraintRegister(payload?.order_constraints);
  if (!register) return null;
  return {
    constraintRegisterRef: orderConstraintRegisterRef(register),
    constraintRegisterDigest: register.registerDigest,
    constraintRegister: register,
  };
}

/**
 * ADR-090 (CC-IC-1): the typed no-obligations attestation a NEW v2 Factory
 * Start carries when its discovery certificate counted nothing. A v2 case
 * with NEITHER a certificate binding NOR this attestation is a typed red at
 * case admission — never a silent null/rebuild.
 */
export interface FormalizationNoObligationsAttestation {
  readonly schemaVersion: string;
  readonly attestationDigest: string;
}

/** The resolved register authority of a FormalizationCase (one or the other, never both). */
export interface FormalizationCaseRegisterAuthority {
  readonly binding: FormalizationConstraintRegisterBinding | null;
  readonly attestation: FormalizationNoObligationsAttestation | null;
}

/**
 * ADR-090 (CC-IC-1), mutation m6b: resolve the case's ONE register authority
 * from the DISCOVERY CERTIFICATE payload — the v2 source of truth — never a
 * rebuild from proposal text/payload.
 *
 * Resolution order:
 *   1. the certificate carries a built register (v1 or v2): verify it through
 *      the repaired read-back verifier and use exactly that binding. A case
 *      whose explicit `constraintRegister` binding DIVERGES from the
 *      certificate register (e.g. a proposal-payload rebuild) is a typed red
 *      — the fallback must never be the supplying path for a v2 case;
 *   2. the certificate carries the typed no-obligations attestation: the
 *      lawful null (binding null, attestation pinned);
 *   3. neither (frozen legacy v1 certificates): the deterministic
 *      `resolveFormalizationCaseConstraintRegister` rebuild fallback —
 *      frozen-legacy-v1-only, bit-identical for v1 data.
 */
export function resolveFormalizationCaseRegisterAuthority(
  formalizationCase: FormalizationCase,
  discoveryCertificatePayload: unknown,
): FormalizationCaseRegisterAuthority {
  if (
    !discoveryCertificatePayload
    || typeof discoveryCertificatePayload !== 'object'
    || Array.isArray(discoveryCertificatePayload)
  ) {
    throw new Error(
      'FORMALIZATION_DISCOVERY_CERTIFICATE_PAYLOAD_INVALID: the discovery certificate payload must be an object',
    );
  }
  const certificate = discoveryCertificatePayload as Record<string, unknown>;
  const certificateRegister = certificate['constraintRegister'] === undefined
    || certificate['constraintRegister'] === null
    ? null
    : verifyOrderConstraintRegister(certificate['constraintRegister']);
  if (certificateRegister !== null) {
    if (
      formalizationCase.constraintRegister
      && formalizationCase.constraintRegister.constraintRegisterDigest
        !== certificateRegister.registerDigest
    ) {
      throw new Error(
        'FORMALIZATION_REGISTER_BINDING_BYPASSED: the case register binding diverges from '
        + 'the discovery certificate register — the certificate binding is the v2 source of '
        + 'truth, never a proposal-payload rebuild',
      );
    }
    return {
      binding: {
        constraintRegisterRef: orderConstraintRegisterRef(certificateRegister),
        constraintRegisterDigest: certificateRegister.registerDigest,
        constraintRegister: certificateRegister,
      },
      attestation: null,
    };
  }
  const rawAttestation = certificate['noObligationsAttestation'];
  if (rawAttestation !== undefined && rawAttestation !== null) {
    if (
      !rawAttestation
      || typeof rawAttestation !== 'object'
      || Array.isArray(rawAttestation)
      || (rawAttestation as Record<string, unknown>)['schemaVersion']
        !== 'factory.discovery-no-obligations.v1'
      || typeof (rawAttestation as Record<string, unknown>)['attestationDigest'] !== 'string'
      || !/^[a-f0-9]{64}$/.test(
        (rawAttestation as Record<string, unknown>)['attestationDigest'] as string,
      )
    ) {
      throw new Error(
        'FORMALIZATION_NO_OBLIGATIONS_ATTESTATION_INVALID: malformed typed no-obligations attestation',
      );
    }
    return {
      binding: null,
      attestation: {
        schemaVersion: 'factory.discovery-no-obligations.v1',
        attestationDigest: (rawAttestation as Record<string, unknown>)['attestationDigest'] as string,
      },
    };
  }
  // Frozen legacy v1 certificate (no register, no attestation): the
  // deterministic rebuild fallback stays the supplier — bit-identical for
  // v1 data. A kind-carrying (v2-shaped) proposal payload is rejected by the
  // v1 builder rather than silently dropped.
  return { binding: resolveFormalizationCaseConstraintRegister(formalizationCase), attestation: null };
}

/**
 * ADR-090 (CC-IC-1), mutation m7: the case identity a verification warrant is
 * cross-bound to. Register+dispositions self-consistency alone is not
 * identity — the warrant names the exact certificate/case digests it was
 * issued against, so a silently re-targeted warrant is a typed red.
 */
export function formalizationCaseIdentityDigest(formalizationCase: FormalizationCase): string {
  return sha256Hex({
    discoveryEpicId: formalizationCase.discoveryEpicId,
    formalizationEpicId: formalizationCase.formalizationEpicId,
    discoveryCertificateRef: formalizationCase.discoveryCertificateRef,
    discoveryCertificateHash: formalizationCase.discoveryCertificateHash,
    discoveryProposalRef: formalizationCase.discoveryProposalRef,
    discoveryProposalHash: formalizationCase.discoveryProposalHash,
    initiativeSubject: formalizationCase.initiativeSubject,
  });
}

/** Structural cross-bind view of a VerificationWarrantRef (no cross-module domain import). */
export interface WarrantCrossBindView {
  readonly constraintRegisterRef: string;
  readonly constraintRegisterDigest: string;
  readonly dispositionsDigest: string;
  readonly dispositions: Readonly<Record<string, unknown>>;
  readonly discoveryCertificateHash?: string;
  readonly formalizationCaseDigest?: string;
}

export interface WarrantCrossBindExpectation {
  readonly discoveryCertificateHash: string;
  readonly formalizationCaseDigest: string;
}

/**
 * ADR-090 (CC-IC-1), mutation m7: verify a warrant's certificate/case
 * cross-bind. A warrant re-targeted at a different certificate or case digest
 * than the one it was issued against is a typed red — never a silent
 * re-issue. The issuing settlement verifies at construction; consumers of the
 * warrant (the readiness manifest contract and future warrant phases) verify
 * the same fields.
 */
export function verifyWarrantCrossBind(
  warrant: WarrantCrossBindView,
  expected: WarrantCrossBindExpectation,
): void {
  if (
    warrant.discoveryCertificateHash !== expected.discoveryCertificateHash
    || warrant.formalizationCaseDigest !== expected.formalizationCaseDigest
  ) {
    throw new Error(
      'WARRANT_CROSS_BIND_MISMATCH: the warrantRef cross-bind does not match the '
      + 'certificate/case it was presented against '
      + `(warrant certificate ${String(warrant.discoveryCertificateHash)} / case `
      + `${String(warrant.formalizationCaseDigest)})`,
    );
  }
}

export interface SolutionContractBundle {
  schemaVersion: typeof SOLUTION_CONTRACT_CERTIFICATE_SCHEMA;
  formalizationEpicId: number;
  prdArtifactId: number | null;
  frArtifactIds: readonly number[];
  nfrArtifactIds: readonly number[];
  ruleArtifactIds: readonly number[];
  ucArtifactIds: readonly number[];
  acArtifactIds: readonly number[];
  acceptanceBaselineHash: string;
  srsArtifactId: number | null;
  bundleHash: string;
}

export interface AcceptanceBaselineSnapshotPayload {
  schemaVersion: typeof ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA;
  processRunId: number;
  formalizationEpicId: number;
  sourceReconciliationRef: string;
  sourceReconciliationHash: string;
  acArtifactIds: readonly number[];
  acArtifactHashes: Readonly<Record<string, string>>;
  /** Atomic criteria parsed from the accepted AC artifact containers. */
  acceptanceCriteria?: readonly {
    artifactId: number;
    code: string;
    title: string;
    contentHash: string;
  }[];
  baselineHash: string;
}

export type AcceptanceCriticality = 'blocker' | 'degradable' | 'nice_to_have';

/**
 * ADR-088 (CC-GAP-6): the frozen constraint-coverage requirement relayed to
 * Development inside the solution contract. Formalization owns the
 * classification; the planner and the task-graph gate only inherit and
 * enforce it. Carries exactly what the Development-side reverse diff and
 * entrypoint-ownership conjunction need — register ids, classes,
 * execution-class entrypoint files, and the TYPED waivers (brief
 * dispositions with disposition='waived' and a non-empty reason).
 *
 * Present if and only if the case carries a (non-empty) constraint register;
 * a registerless corpus freezes no block and stays grandfathered.
 */
export interface SolutionContractConstraintCoverage {
  /** Content-addressed register ref: constraint-register:<digest>. */
  readonly constraintRegisterRef: string;
  readonly constraintRegisterDigest: string;
  readonly entries: readonly {
    readonly id: string;
    readonly class: OrderConstraintClass;
    /** Execution-class only (see OrderConstraintEntry.entrypointFiles). */
    readonly entrypointFiles?: readonly string[];
  }[];
  /** Typed waivers — the only lawful escape hatch from the reverse diff. */
  readonly waivedIds: readonly string[];
}

/**
 * The A1 waiver rule shared by every consumer of the brief's constraint
 * dispositions: a waiver counts ONLY with disposition='waived' AND a
 * non-empty reason. Anything else is a reaction defect the A1 gate owns —
 * never a coverage free pass.
 */
export function waivedConstraintIdsFromDispositions(
  dispositions: Readonly<Record<string, unknown>> | undefined | null,
): string[] {
  if (!dispositions) return [];
  const waivedIds: string[] = [];
  for (const [id, value] of Object.entries(dispositions)) {
    if (
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).disposition === 'waived'
      && typeof (value as Record<string, unknown>).reason === 'string'
      && ((value as Record<string, unknown>).reason as string).trim().length > 0
    ) {
      waivedIds.push(id);
    }
  }
  return waivedIds;
}

/**
 * Build the frozen coverage block for the solution contract from the case's
 * constraint-register binding and the accepted brief's dispositions (both
 * already resolved by the settlement kernel — no new authority, no re-read
 * of the order prose).
 */
export function buildSolutionContractConstraintCoverage(
  binding: FormalizationConstraintRegisterBinding,
  briefDispositions: Readonly<Record<string, unknown>> | undefined | null,
): SolutionContractConstraintCoverage {
  return {
    constraintRegisterRef: binding.constraintRegisterRef,
    constraintRegisterDigest: binding.constraintRegisterDigest,
    entries: binding.constraintRegister.constraints.map(entry => ({
      id: entry.id,
      class: entry.class,
      ...(entry.entrypointFiles && entry.entrypointFiles.length > 0
        ? { entrypointFiles: [...entry.entrypointFiles] }
        : {}),
    })),
    waivedIds: waivedConstraintIdsFromDispositions(briefDispositions),
  };
}

export interface FormalizationSolutionContractPayload {
  schemaVersion: typeof SOLUTION_CONTRACT_CERTIFICATE_SCHEMA;
  processRunId: number;
  formalizationEpicId: number;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundle: SolutionContractBundle;
  artifactHashes: Readonly<Record<string, string>>;
  traceIds: readonly number[];
  traceDigest: string;
  baselineSnapshotRef: string;
  baselineSnapshotHash: string;
  /**
   * ADR-090 (CC-IC-1 focused repair, m7 consumer boundary): the FormalizationCase
   * identity digest the settlement-issued warrantRef is cross-bound to
   * (formalizationCaseIdentityDigest of the case this contract froze). Frozen
   * here — beside the discoveryCertificateHash already carried — so the
   * Development warrant consumer has BOTH authoritative expected identities on
   * the case it inherits. Optional: payloads frozen before this repair carry
   * none, and a warrant-bearing manifest against such a case fails closed at
   * the consumer (never a silent unverifiable accept).
   */
  formalizationCaseDigest?: string;
  srs: {
    schema: typeof FORMALIZATION_SRS_SCHEMA;
    ref: string;
    hash: string;
  };
  /**
   * ADR-088 (CC-GAP-6): the frozen constraint-coverage requirement
   * Development inherits and enforces (reverse diff + entrypoint
   * ownership). Absent when the corpus carries no constraint register —
   * the sole grandfather condition. @see SolutionContractConstraintCoverage.
   */
  constraintRegisterCoverage?: SolutionContractConstraintCoverage;
  /** Exact immutable hand-off to Development. */
  acceptanceCriteria: readonly {
    /** Stable atomic criterion identity; distinct from its document container. */
    criterionId: number;
    artifactId: number;
    code: string | null;
    /** Accepted hash of the provenance artifact/document container. */
    acceptedHash: string;
    /** Content hash of this atomic criterion section within the container. */
    criterionHash?: string;
    implementationRequired: boolean;
    criticality: AcceptanceCriticality;
    /**
     * AC-drift relay: the constraint-register IDs this criterion covers,
     * carried from the SRS §D2 stanza (covered_constraint_ids). Absent when
     * no register exists — Development then relays nothing (retro-compat).
     */
    coveredConstraintIds?: readonly string[];
  }[];
}

export interface FormalizationSettlementInput {
  schemaVersion: typeof FORMALIZATION_SETTLEMENT_INPUT_SCHEMA;
  formalizationEpicId: number;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundle: SolutionContractBundle;
}

/**
 * The closed decision union IS the mechanical unreachability proof: a value
 * absent from this union cannot occur. 'clarification-required' and
 * 'infeasible' were deleted with their routes (declared but never produced —
 * see docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md).
 */
export type FormalizationDecision =
  | 'formalized'
  | 'inconsistent'
  | 'failed';

export type FormalizationReasonCode =
  | 'baseline-missing'
  | 'traceability-gap'
  | 'srs-missing'
  | 'prd-missing'
  | 'acceptance-empty'
  | 'tasks-not-ready'
  | 'invariant-violation'
  | 'infrastructure-error';

export interface FormalizationCertificatePayload {
  schemaVersion: typeof FORMALIZATION_CERTIFICATE_SCHEMA_VERSION;
  decision: FormalizationDecision;
  reasonCodes: readonly FormalizationReasonCode[];
  rationale: string;
  inputHash: string;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundleHash: string;
  acceptanceBaselineHash: string;
}

export { FORMALIZATION_PROCESS_MODULE_REF } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
