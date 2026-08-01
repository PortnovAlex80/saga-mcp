/**
 * Formalization schemas — the input/output/certificate contracts for the
 * Solution Formalization Process Module.
 *
 * These are TYPE + SCHEMA-ID declarations. The actual data lives in the
 * artifact store (PRD/UC/AC/SRS rows in the saga tracker) — these schemas are
 * the BOUNDARIES: what the module receives as input, what it must produce as
 * output, and what the settlement policy validates before issuing a certificate.
 *
 *   FormalizationCase          — input. Binds one discovery certificate to
 *                                one formalization episode. The case carries
 *                                the discovery certificate ref + hash so
 *                                formalization's lineage is provable.
 *   SolutionContractBundle     — output. The set of accepted artifacts that
 *                                constitutes the frozen solution contract
 *                                (PRD/FR/NFR/RULE/UC/AC/baseline/SRS). Refs
 *                                only — the artifacts themselves live in the
 *                                tracker.
 *   FormalizationCertificatePayload — certificate. Carries the settlement
 *                                decision + reason codes + the bundle hash +
 *                                the discovery certificate ref for traceability.
 *
 * The settlement policy (formalization-settlement-policy.ts) consumes a
 * FormalizationSettlementInput and produces a FormalizationCertificatePayload.
 * It reuses the saga2 lifecycle tools (acceptedBaseline, assertTraceability,
 * assertTasksReady) for the WHAT/HOW graph checks — it does NOT invent new
 * validation logic.
 */

// CONVEYOR Wave 7: FORMALIZATION_CASE_SCHEMA is a lifecycle-referenced contract
// whose canonical home is the lifecycle contracts module (Rule 3). Re-exported
// here so the module's own consumers keep a single import surface. The
// `ProcessModuleReference` type import below is retained for the duplicate
// FORMALIZATION_PROCESS_MODULE_REF removal (now canonical in contracts).
export {
  FORMALIZATION_CASE_SCHEMA,
} from '../../lifecycles/product-delivery-module-contracts.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../lifecycles/product-delivery-module-contracts.js';
export const SOLUTION_CONTRACT_CERTIFICATE_SCHEMA = 'saga3.solution-contract-certificate.v1';
export const FORMALIZATION_SETTLEMENT_INPUT_SCHEMA = 'saga3.formalization-settlement-input.v1';
export const FORMALIZATION_PRODUCT_BUNDLE_SCHEMA = 'saga3.formalization-product-bundle.v1';
export const FORMALIZATION_USE_CASE_BUNDLE_SCHEMA = 'saga3.formalization-use-case-bundle.v1';
export const FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA = 'saga3.formalization-acceptance-bundle.v1';
export const FORMALIZATION_RECONCILIATION_SCHEMA = 'saga3.formalization-reconciliation-report.v1';
export const FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA = 'saga3.formalization-architecture-bundle.v1';
export const ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA = 'saga3.acceptance-baseline-snapshot.v1';
export const FORMALIZATION_SRS_SCHEMA = 'saga3.srs.v1';
export const FORMALIZATION_CERTIFICATE_SCHEMA_VERSION =
  'saga3.solution-contract-certificate.generic.v1';

/** One formalization run = one discovery certificate being converted to a contract. */
export interface FormalizationCase {
  schemaVersion: typeof FORMALIZATION_CASE_SCHEMA;
  /** The discovery episode this formalization continues. */
  discoveryEpicId: number;
  /** The formalization episode (where PRD/UC/AC/SRS artifacts land). */
  formalizationEpicId: number;
  /** Discovery certificate that authorizes this formalization. */
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  discoveryOutcome: string;
  /** Operator/orchestrator that started this formalization. */
  initiatedBy: string;
}

/**
 * Snapshot of the accepted artifacts that constitute the solution contract.
 * Refs only — no content. The settlement policy reads these from the tracker
 * (artifact_list + trace_list + acceptedBaseline) and validates the graph
 * before emitting the bundle.
 */
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
  /** SHA-256 over the canonical JSON of the bundle (excluding this field). */
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
  baselineHash: string;
}

/**
 * Durable module output. The generic ProcessOutcomeCertificate remains a
 * separate proof object; this payload is the exact solution-contract snapshot
 * addressed by ProcessModuleRunResult.output.
 */
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
  /** Exact accepted SRS that authorizes downstream implementation planning. */
  srs: {
    schema: typeof FORMALIZATION_SRS_SCHEMA;
    ref: string;
    hash: string;
  };
  /**
   * Machine-built DevelopmentCase bindings. These come from the frozen,
   * canonical AC rows rather than worker-provided output metadata.
   */
  acceptanceCriteria: readonly {
    artifactId: number;
    code: string | null;
    acceptedHash: string;
    implementationRequired: boolean;
  }[];
}

/**
 * What the settlement policy consumes. Computed by the formalization pump
 * (P5 LegacyFormalizationProcessAdapter) when it reaches the settle node — it
 * gathers the accepted artifacts + baseline + traces and passes them here.
 */
export interface FormalizationSettlementInput {
  schemaVersion: typeof FORMALIZATION_SETTLEMENT_INPUT_SCHEMA;
  formalizationEpicId: number;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundle: SolutionContractBundle;
}

export type FormalizationDecision =
  | 'formalized'
  | 'clarification-required'
  | 'inconsistent'
  | 'infeasible'
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

/**
 * The authoritative certificate payload. Settlement policy produces this; the
 * generic ProcessOutcomeCertificate layer wraps it (schemaVersion, decision,
 * reasonCodes, rationale, inputHash, payload).
 */
export interface FormalizationCertificatePayload {
  schemaVersion: typeof FORMALIZATION_CERTIFICATE_SCHEMA_VERSION;
  decision: FormalizationDecision;
  reasonCodes: readonly FormalizationReasonCode[];
  rationale: string;
  /** SHA-256 over the canonical JSON of FormalizationSettlementInput. */
  inputHash: string;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundleHash: string;
  acceptanceBaselineHash: string;
}

// CONVEYOR Wave 7: FORMALIZATION_PROCESS_MODULE_REF was duplicated here. It now
// has one canonical home in the lifecycle contracts module; this file re-exports
// it so existing SPI consumers keep a single import surface.
export { FORMALIZATION_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
