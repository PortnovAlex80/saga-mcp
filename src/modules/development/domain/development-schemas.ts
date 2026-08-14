/**
 * Domain contracts for the Development Process Module.
 *
 * Development composes planning, implementation, review, integration and
 * verification into one locally-settled process. The important ordering
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
} from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import { DEVELOPMENT_CASE_SCHEMA } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
export const DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA =
  'factory.development-task-graph-proposal.v1';
export const DEVELOPMENT_TASK_GRAPH_SCHEMA = 'factory.development-task-graph.v1';
export const DEVELOPMENT_BASELINE_ADOPTION_SCHEMA =
  'factory.development-baseline-adoption.v1';
export const DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA =
  'factory.development-implementation-workset.v1';
export const INTEGRATED_CANDIDATE_SCHEMA =
  'factory.integrated-release-candidate.v1';
export const ACCEPTANCE_VERIFICATION_SCHEMA =
  'factory.acceptance-verification-workset.v1';
export const VERIFIED_INTEGRATION_BUNDLE_SCHEMA =
  'factory.verified-integration-bundle.v1';
export const DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA =
  'factory.development-settlement-input.v1';
export const DEVELOPMENT_CERTIFICATE_SCHEMA =
  'factory.development-certificate.v1';

// ADR-030 — typed schema'd products that Development cell workers publish.
// These payloads carry the exact structured lineage the settlement policy
// consumes (source commit, integrated commit, tree hash,
// acceptanceCriterionId, acceptedCriterionHash, candidateHash, provider).
// The generic CandidateSet seals only {schemaId, ref, digest} ProductRefs;
// Development semantics live in these product bodies, keeping the universal
// Workplace type free of module vocabulary (ADR-029 ratchet).
export const DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA =
  'factory.development-implementation-result.v1';
export const DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA =
  'factory.candidate-verification-evidence-product.v2';
export const DEVELOPMENT_REVIEW_VERDICT_SCHEMA =
  'factory.development-review-verdict.v1';

export interface DevelopmentImplementationResultProduct {
  workItemKey: string;
  terminalStatus: 'complete' | 'blocked' | 'failed';
  source: {
    branch: string;
    commitSha: string;
    workItemKey: string;
  };
  snapshot: {
    commitSha: string;
    treeSha: string;
    files: readonly unknown[];
  };
  repository: {
    projectRepositoryId: number;
    integrationBranch: string;
    baseCommit: string;
    name: string;
  };
  buildProducts: readonly unknown[];
  reasonCodes: readonly string[];
  /**
   * @see ReadinessProfile — the EXPLICIT served|static readiness profile for
   * the integrated product. When present on an accepted implementation result,
   * the candidate freeze propagates it onto the IntegratedReleaseCandidate so
   * the local-runnability provider (LR-04) can prove the exact sealed product
   * runnable. Optional: a result frozen upstream of LR-07 wiring carries none
   * and the freeze falls back to no profile (fail closed at runnability).
   */
  readiness?: ReadinessProfile;
}

export interface DevelopmentVerificationEvidenceProduct {
  schemaVersion: typeof DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA;
  verificationItemKey: string;
  acceptanceCriterionId: number;
  acceptedCriterionHash: string;
  candidateHash: string;
  outcome: VerificationOutcome;
  /** The enclosing immutable ProductRef is the evidence reference. */
  evidence: {
    summary: string;
    observations: readonly string[];
    limitations: readonly string[];
  };
}

export interface ContentAddressedReference {
  schema: string;
  ref: string;
  hash: string;
}

export interface DevelopmentPolicySnapshot {
  id: string;
  version: string;
  contentHash: string;
  /**
   * Repository-local write authorities that every repository graph must assign
   * to at least one implementation item. Product Build uses this for bootstrap
   * material (manifest and tests) that is required independently of AC
   * decomposition.
   */
  requiredChangeScopes?: readonly string[];
}

/**
 * Criticality classification for integration readiness.
 * Controls whether an AC's verification status gates module completion.
 *   blocker      — verification MUST pass before the module can complete.
 *   degradable   — module may complete with this AC in 'unknown' state
 *                   (explicitly accepted risk).
 *   nice_to_have — module may complete without this AC verified at all.
 *
 * Default when the architect does not classify: 'blocker' (conservative).
 * Source of truth: SRS §D2 criticality field → parsed by formalization
 * settlement → frozen into AcceptanceCriterionBinding → carried through
 * DevelopmentTaskGraphItem → stamped on task metadata → read by
 * integration readiness gate.
 */
export type AcceptanceCriticality = 'blocker' | 'degradable' | 'nice_to_have';

export interface AcceptanceCriterionBinding {
  /** Stable identity of the atomic criterion, independent of document container. */
  criterionId?: number;
  /** Provenance artifact/document container; several criteria may share it. */
  artifactId: number;
  code: string | null;
  /** Accepted hash of the authoritative artifact/document container. */
  acceptedHash: string;
  /** Optional content hash of the atomic criterion section. */
  criterionHash?: string;
  /**
   * False is reserved for criteria that constrain an already-existing product
   * without requiring an implementation work item. Verification is mandatory
   * for every criterion regardless of this flag.
   */
  implementationRequired: boolean;
  /**
   * Integration readiness classification. Defaults to 'blocker' when the
   * SRS did not carry a criticality value (conservative: treat as mandatory).
   */
  criticality: AcceptanceCriticality;
}

/**
 * The canonical identity of an acceptance criterion for cross-stage handoff.
 *
 * ADR-053: this MUST be the DB artifact ID — the same ID the acceptance
 * verification query uses to check `SELECT ... FROM artifacts WHERE id = ?`.
 * The previous criterionId experiment (48-bit truncated hash) produced IDs
 * that did not match the artifacts table, causing
 * PRODUCTION_CELL_SOURCE_ARTIFACT_INVALID under scripted E2E.
 */
export function acceptanceCriterionIdentity(
  criterion: AcceptanceCriterionBinding,
): number {
  return criterion.artifactId;
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
  projectRepositoryId: number;
  acceptanceCriterionIds: readonly number[];
  dependsOnKeys: readonly string[];
  /** Repository-local ownership units used to prevent unsafe parallel edits. */
  changeScopes: readonly string[];
  required: boolean;
  /**
   * Criticality carried from the AC binding. Stamped onto task metadata
   * so the integration readiness gate can classify verification outcomes.
   */
  criticality: AcceptanceCriticality;
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
 * The deterministic install + test commands that prove a candidate runnable.
 *
 * ADR-053 / LR-03 — the authority for "which commands prove runnability" is the
 * accepted product contract (this frozen candidate), NOT inference from
 * incidental files (package.json / build.gradle presence). The local-
 * runnability provider runs these verbatim and fails closed when the contract
 * cannot state them, rather than guessing. Reused by the LR-04 readiness
 * profile, which embeds these commands as the runnability authority.
 */
export interface RunnabilityCommands {
  /**
   * Shell command that installs the candidate's dependencies, or null when the
   * candidate needs no install step (e.g. a dependency-free static product).
   */
  installCommand: string | null;
  /** Shell command that proves runnability (the test command). Non-empty. */
  testCommand: string;
}

/**
 * The EXPLICIT readiness profile (ADR-053 / LR-04) — the single authority that
 * states how the exact sealed product proves itself runnable. The local-
 * runnability provider does NOT infer product kind/readiness (served vs static)
 * from incidental files (package.json / build.gradle); the profile is the
 * authority, and the provider fails closed when it is absent or invalid.
 *
 * The profile rides on the frozen IntegratedReleaseCandidate, so it names the
 * exact sealed subject (it is part of the frozen content covered by
 * `candidateHash`) and it carries the runnability commands (LR-03
 * RunnabilityCommands). Two kinds:
 *
 *   - served: the product is a long-running service. It states how it serves
 *     (the serve command) plus its runnability commands. The provider starts it
 *     on a deterministic loopback port, probes the endpoint, then shuts it down
 *     — ADDITIVE evidence the exact sealed object can be started, answer on
 *     loopback, and stop.
 *   - static: the product is a fixed artifact (a static site / library). It
 *     states only its runnability commands; runnability is proven by the test
 *     command alone, with no serve/probe phase.
 *
 * Phase-1 dockerization: both kinds may optionally carry an `environment.image`
 * stating the Docker image the product must execute in. When present, the
 * local-runnability provider runs the sealed tree's install/test/serve commands
 * inside that image (via the docker CLI) instead of on the host. The image is
 * part of the frozen profile, so it is covered by `candidateHash` — a changed
 * image is a different candidate. When docker is unavailable but an image is
 * declared, the provider fails closed ('failed', NOT 'error') with
 * LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE rather than silently falling back to host.
 */
export type ReadinessProfile = ServedReadinessProfile | StaticReadinessProfile;

/**
 * Optional Docker substrate declaration. When present on a readiness profile,
 * the local-runnability provider executes the product's install/test/serve
 * commands inside the named Docker image instead of on the host. The image
 * string is opaque to the engine (no language/tool knowledge): it is passed
 * verbatim to `docker run`. A digest-pinned reference (e.g.
 * `alpine@sha256:...`) is encouraged so the image itself is content-addressed,
 * but any valid docker image reference is accepted.
 */
export interface ReadinessEnvironment {
  /** Docker image reference (non-empty). Passed verbatim to `docker run`. */
  image: string;
}

export interface ServedReadinessProfile {
  kind: 'served';
  /** @see RunnabilityCommands — deterministic install + test commands. */
  commands: RunnabilityCommands;
  /** How the product serves itself on loopback. */
  serve: {
    /**
     * Shell command that starts the service (long-running). The provider spawns
     * it on a deterministic loopback port, probes the endpoint, then terminates
     * the process tree. Non-empty.
     */
    startCommand: string;
  };
  /** @see ReadinessEnvironment — optional Docker image for containerized execution. */
  environment?: ReadinessEnvironment;
}

export interface StaticReadinessProfile {
  kind: 'static';
  /** @see RunnabilityCommands — deterministic install + test commands. */
  commands: RunnabilityCommands;
  /** @see ReadinessEnvironment — optional Docker image for containerized execution. */
  environment?: ReadinessEnvironment;
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
  /**
   * @see ReadinessProfile — the EXPLICIT served|static readiness authority. The
   * local-runnability provider requires this and fails closed when it is absent;
   * it does not infer readiness from incidental files. Optional only because a
   * candidate frozen upstream before this wiring is populated (LR-07) is treated
   * as "no explicit profile" → fail closed, never guessed.
   */
  readiness?: ReadinessProfile;
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

/**
 * The durable local-readiness receipt for the EXACT frozen integrated candidate
 * (LR-06 / LR-07 — closes W5). This is the persisted outcome of the local-
 * runnability check provider (`factory_check_receipts`, the Gate-receipt
 * substrate) for the candidate set that seals the integrated candidate.
 *
 * Development settlement's terminal `verified` decision REQUIRES this receipt to
 * be (a) present, (b) outcome `passed`, and (c) bound to the exact frozen
 * integrated candidate — `candidateHash === integratedCandidate.candidateHash`.
 * Without it the product is not proven runnable locally and settlement returns
 * `blocked` / `local-readiness-missing`. Before LR-07 the receipt ran during
 * development verification but was NOT bound to the settlement's terminal
 * decision, so Development could be "verified" without a proven-runnable-local
 * product (W5).
 *
 * `candidateHash` is the SUBJECT IDENTITY of the receipt. The settlement policy
 * enforces the binding; the builder populates it by reading the receipt whose
 * subject candidate set seals THIS candidate (content-addressed member triple),
 * so a different product's receipt can never satisfy the gate.
 */
export interface LocalReadinessReceipt {
  /**
   * The exact frozen candidate this receipt proves runnable. MUST equal the
   * integrated candidate's sealed `candidateHash`.
   */
  candidateHash: string;
  outcome: 'passed' | 'failed';
  /** Sealed evidence refs produced by the local-runnability provider. */
  evidenceRefs: readonly string[];
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
  /**
   * The durable local-readiness receipt for the exact frozen integrated
   * candidate, or null when no passed/failed receipt is persisted for it
   * (LR-06/LR-07). The terminal `verified` decision requires this to be present,
   * `passed`, and bound to `integratedCandidate.candidateHash`. W5.
   */
  localReadinessReceipt: LocalReadinessReceipt | null;
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
  | 'task-graph-required-scope-missing'
  | 'implementation-scope-overlap'
  | 'integration-source-partition-invalid'
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
  | 'local-readiness-missing'
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
