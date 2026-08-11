/** Formalization boundary schemas. */

export {
  FORMALIZATION_CASE_SCHEMA,
} from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
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
  srs: {
    schema: typeof FORMALIZATION_SRS_SCHEMA;
    ref: string;
    hash: string;
  };
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
  }[];
}

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
