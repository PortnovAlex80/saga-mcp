/**
 * Domain contracts for the Development Process Module.
 *
 * Development absorbs the legacy planning -> development -> integration ->
 * verification stages into one locally-settled process. The important ordering
 * is deliberate:
 *
 *   plan -> implement/review -> integrate + freeze candidate
 *        -> verify the exact frozen candidate -> settle
 *
 * Verification evidence is therefore bound to both the accepted AC revision
 * and the immutable candidate snapshot. A changed commit/tree/build digest is
 * a different candidate and requires a new verification snapshot.
 */

// CONVEYOR Wave 7: this schema-id string is a lifecycle-referenced contract
// whose canonical home is the lifecycle contracts module (Rule 3). Re-exported
// here so the module's own consumers keep a single import surface.
export {
  DEVELOPMENT_CASE_SCHEMA,
} from '../../lifecycles/product-delivery-module-contracts.js';
import { DEVELOPMENT_CASE_SCHEMA } from '../../lifecycles/product-delivery-module-contracts.js';
export const DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA =
  'saga3.development-task-graph-proposal.v1';
export const DEVELOPMENT_TASK_GRAPH_SCHEMA = 'saga3.development-task-graph.v1';
export const DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA =
  'saga3.development-implementation-workset.v1';
export const INTEGRATED_CANDIDATE_SCHEMA =
  'saga3.integrated-release-candidate.v1';
export const ACCEPTANCE_VERIFICATION_SCHEMA =
  'saga3.acceptance-verification-workset.v1';
export const VERIFIED_INTEGRATION_BUNDLE_SCHEMA =
  'saga3.verified-integration-bundle.v1';
export const DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA =
  'saga3.development-settlement-input.v1';
export const DEVELOPMENT_CERTIFICATE_SCHEMA =
  'saga3.development-certificate.v1';

export interface ContentAddressedReference {
  schema: string;
  ref: string;
  hash: string;
}

export interface DevelopmentPolicySnapshot {
  id: string;
  version: string;
  contentHash: string;
}

export interface AcceptanceCriterionBinding {
  artifactId: number;
  code: string | null;
  acceptedHash: string;
  /**
   * False is reserved for criteria that constrain an already-existing product
   * without requiring an implementation work item. Verification is mandatory
   * for every criterion regardless of this flag.
   */
  implementationRequired: boolean;
}

export interface DevelopmentRepositoryBinding {
  projectRepositoryId: number;
  integrationBranch: string;
  expectedBaseCommit: string;
}

export interface DevelopmentCase {
  schemaVersion: typeof DEVELOPMENT_CASE_SCHEMA;
  projectId: number;
  epicId: number;
  formalizationCertificate: ContentAddressedReference & {
    decision: 'formalized';
  };
  solutionContract: ContentAddressedReference;
  acceptanceBaselineHash: string;
  srs: ContentAddressedReference;
  acceptanceCriteria: readonly AcceptanceCriterionBinding[];
  repositories: readonly DevelopmentRepositoryBinding[];
  policy: DevelopmentPolicySnapshot;
  initiatedBy: string;
}

export type DevelopmentWorkItemKind =
  | 'implementation'
  | 'verification';

export interface DevelopmentTaskGraphItem {
  key: string;
  kind: DevelopmentWorkItemKind;
  taskKind: string;
  executionSkill: string;
  executionMode: string;
  projectRepositoryId: number | null;
  acceptanceCriterionIds: readonly number[];
  dependsOnKeys: readonly string[];
  required: boolean;
}

export interface CandidateIntegrationTarget {
  projectRepositoryId: number;
  sourceWorkItemKeys: readonly string[];
  targetBranch: string;
  expectedBaseCommit: string;
}

/**
 * An LM may propose this shape. It is advisory until the resolver kernel
 * validates all ids, dependencies, repository bindings and coverage, fills the
 * immutable lineage fields, computes graphHash, and persists TaskGraphSnapshot.
 */
export interface DevelopmentTaskGraphProposal {
  schemaVersion: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
  implementationItems: readonly DevelopmentTaskGraphItem[];
  verificationItems: readonly DevelopmentTaskGraphItem[];
  integrationTargets: readonly CandidateIntegrationTarget[];
}

export interface DevelopmentTaskGraphSnapshot {
  schemaVersion: typeof DEVELOPMENT_TASK_GRAPH_SCHEMA;
  epicId: number;
  formalizationCertificateHash: string;
  solutionContractHash: string;
  acceptanceBaselineHash: string;
  srsHash: string;
  plannerSubmission: ContentAddressedReference;
  implementationItems: readonly DevelopmentTaskGraphItem[];
  verificationItems: readonly DevelopmentTaskGraphItem[];
  integrationTargets: readonly CandidateIntegrationTarget[];
  graphHash: string;
}

export type WorkItemTerminalStatus =
  | 'succeeded'
  | 'failed'
  | 'blocked';

export interface ImplementationWorkItemResult {
  key: string;
  status: WorkItemTerminalStatus;
  taskId: number;
  implementationExecutionId: string | null;
  reviewExecutionId: string | null;
  reviewedSourceCommit: string | null;
  result: ContentAddressedReference | null;
  reasonCodes: readonly string[];
}

export interface DevelopmentImplementationWorkset {
  schemaVersion: typeof DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA;
  taskGraphHash: string;
  results: readonly ImplementationWorkItemResult[];
  complete: boolean;
  blockingItemKeys: readonly string[];
  worksetHash: string;
}

export interface CandidateRepositorySnapshot {
  projectRepositoryId: number;
  branch: string;
  commitSha: string;
  treeHash: string;
}

export interface CandidateBuildProduct {
  kind: string;
  ref: string;
  digest: string;
}

/**
 * The immutable code/build target that verification executes against.
 * `candidateHash` is over all fields except candidateHash itself.
 */
export interface IntegratedReleaseCandidate {
  schemaVersion: typeof INTEGRATED_CANDIDATE_SCHEMA;
  taskGraphHash: string;
  implementationWorksetHash: string;
  repositories: readonly CandidateRepositorySnapshot[];
  buildProducts: readonly CandidateBuildProduct[];
  integrationIntentRefs: readonly string[];
  frozen: true;
  candidateHash: string;
}

export type VerificationOutcome =
  | 'passed'
  | 'failed'
  | 'unknown'
  | 'error';

export interface VerificationProviderBinding {
  providerId: number;
  name: string;
  version: string | null;
  category: 'deterministic_evidence';
  trusted: boolean;
}

export interface CandidateVerificationEvidence {
  verificationItemKey: string;
  taskId: number;
  executionId: string | null;
  acceptanceCriterionId: number;
  acceptedCriterionHash: string;
  /** Exact frozen target. Evidence for any other value is inadmissible. */
  candidateHash: string;
  outcome: VerificationOutcome;
  evidence: ContentAddressedReference;
  provider: VerificationProviderBinding;
}

export interface AcceptanceVerificationWorkset {
  schemaVersion: typeof ACCEPTANCE_VERIFICATION_SCHEMA;
  acceptanceBaselineHash: string;
  candidateHash: string;
  evidence: readonly CandidateVerificationEvidence[];
  complete: boolean;
  verificationHash: string;
}

export interface VerifiedIntegrationBundle {
  schemaVersion: typeof VERIFIED_INTEGRATION_BUNDLE_SCHEMA;
  formalizationCertificate: ContentAddressedReference;
  solutionContract: ContentAddressedReference;
  acceptanceBaselineHash: string;
  taskGraph: ContentAddressedReference;
  implementationWorkset: ContentAddressedReference;
  integratedCandidate: ContentAddressedReference;
  acceptanceVerification: ContentAddressedReference;
  repositories: readonly CandidateRepositorySnapshot[];
  buildProducts: readonly CandidateBuildProduct[];
  bundleHash: string;
}

export interface DevelopmentSettlementInput {
  schemaVersion: typeof DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA;
  developmentCase: DevelopmentCase;
  taskGraph: DevelopmentTaskGraphSnapshot | null;
  implementationWorkset: DevelopmentImplementationWorkset | null;
  integratedCandidate: IntegratedReleaseCandidate | null;
  /**
   * Hash observed from repositories/build products at settlement time. It must
   * still equal integratedCandidate.candidateHash.
   */
  observedCandidateHash: string | null;
  acceptanceVerification: AcceptanceVerificationWorkset | null;
  productReferences: {
    taskGraph: ContentAddressedReference | null;
    implementationWorkset: ContentAddressedReference | null;
    integratedCandidate: ContentAddressedReference | null;
    acceptanceVerification: ContentAddressedReference | null;
  };
  openHumanGateIds: readonly string[];
}

export type DevelopmentDecision =
  | 'verified'
  | 'rework-required'
  | 'clarification-required'
  | 'blocked'
  | 'failed';

export type DevelopmentReasonCode =
  | 'invalid-input-contract'
  | 'invalid-formalization-lineage'
  | 'task-graph-missing'
  | 'task-graph-hash-invalid'
  | 'task-graph-lineage-mismatch'
  | 'task-graph-dependency-invalid'
  | 'implementation-coverage-gap'
  | 'verification-plan-coverage-gap'
  | 'implementation-workset-missing'
  | 'implementation-workset-hash-invalid'
  | 'implementation-failed'
  | 'implementation-blocked'
  | 'implementation-incomplete'
  | 'candidate-missing'
  | 'candidate-hash-invalid'
  | 'candidate-lineage-mismatch'
  | 'candidate-not-frozen'
  | 'candidate-drifted-after-freeze'
  | 'verification-workset-missing'
  | 'verification-workset-hash-invalid'
  | 'verification-lineage-mismatch'
  | 'verification-evidence-missing'
  | 'verification-failed'
  | 'verification-inconclusive'
  | 'verification-provider-untrusted'
  | 'human-decision-required'
  | 'infrastructure-error';

export interface DevelopmentCertificatePayload {
  schemaVersion: typeof DEVELOPMENT_CERTIFICATE_SCHEMA;
  decision: DevelopmentDecision;
  reasonCodes: readonly DevelopmentReasonCode[];
  rationale: string;
  inputHash: string;
  formalizationCertificateHash: string;
  solutionContractHash: string;
  acceptanceBaselineHash: string;
  taskGraphHash: string | null;
  implementationWorksetHash: string | null;
  candidateHash: string | null;
  verificationHash: string | null;
  bundleHash: string | null;
  policy: DevelopmentPolicySnapshot;
}
