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
export const INTEGRATED_SOURCE_CANDIDATE_SCHEMA =
  'factory.integrated-source-candidate.v1';
export const DEVELOPMENT_READINESS_MANIFEST_SCHEMA =
  'factory.development-readiness-manifest.v1';
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
  /**
   * ATOMIC criterion identity — `${artifactId}:${code}`. Provenance stays on
   * acceptedCriterionHash (the artifact's accepted content). Never a bare
   * artifactId: several criteria share one artifact and each carries its own
   * verification obligation.
   */
  acceptanceCriterionKey: string;
  acceptedCriterionHash: string;
  candidateHash: string;
  /**
   * AC-drift relay: the constraint IDs pinned by the verification card.
   * When the card (cell_input_item) carries coveredConstraintIds, the
   * evidence must echo the exact same set — lineage pins them together
   * with the criterion key. Absent when the card pins none (retro-compat).
   */
  coveredConstraintIds?: readonly string[];
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
  /**
   * AC-drift relay: constraint-register IDs this criterion covers (from the
   * SRS §D2 stanza). Absent when no register exists — cards then relay
   * nothing and every legacy shape stays valid (retro-compat).
   */
  coveredConstraintIds?: readonly string[];
}

/**
 * The canonical identity of an ATOMIC acceptance criterion for cross-stage
 * handoff: `${artifactId}:${code}`.
 *
 * Two identities, deliberately separated (2026-08-22 Elite-4 incident):
 *   — ATOMIC criterion identity: this key. One per criterion, stable across
 *     packaging. 16 criteria in one lawful artifact stay SIXTEEN identities.
 *   — PROVENANCE artifact identity: `artifactId` — the DB row that holds the
 *     accepted content. Several criteria may share it; it is used ONLY where
 *     a real artifact row is read (content, acceptedHash).
 *
 * The old equality `identity === artifactId` collapsed multi-criterion
 * artifacts into one semantic id downstream (verification coverage,
 * constraint relay, settlement worksets) — the exact defect the operator
 * review ordered removed. A criterion with a null code keys on the bare
 * artifact id (legacy single-criterion documents with no code).
 */
export function acceptanceCriterionIdentity(
  criterion: AcceptanceCriterionBinding,
): string {
  return criterionKey(criterion.artifactId, criterion.code);
}

/** `${artifactId}:${code}` — the atomic criterion key constructor. */
export function criterionKey(artifactId: number, code: string | null): string {
  return `${artifactId}:${code ?? ''}`;
}

export interface DevelopmentRepositoryBinding {
  projectRepositoryId: number;
  integrationBranch: string;
  expectedBaseCommit: string;
}

/**
 * ADR-088 (CC-GAP-6): the constraint-coverage requirement Development
 * inherits from Formalization. Structural mirror of the solution contract's
 * `constraintRegisterCoverage` block — re-declared here (never imported
 * across workshop trees; same discipline as VerificationWarrantRef) and
 * resolved lazily from the case's frozen `solutionContractPayload` by
 * {@link resolveDevelopmentConstraintRegisterCoverage}.
 */
export interface DevelopmentConstraintRegisterCoverage {
  /** Content-addressed register ref: constraint-register:<digest>. */
  readonly constraintRegisterRef: string;
  readonly constraintRegisterDigest: string;
  readonly entries: readonly {
    readonly id: string;
    readonly class: 'execution' | 'material' | 'human';
    /** Execution-class only — the product entrypoint files this constraint owns. */
    readonly entrypointFiles?: readonly string[];
  }[];
  /** Typed waivers (disposition='waived' with a non-empty reason). */
  readonly waivedIds: readonly string[];
}

/**
 * Resolve the constraint-coverage requirement from the case's frozen
 * solution-contract payload. Returns null when the corpus carries no
 * register (the SOLE grandfather condition — empty diffs, typed legacy
 * skips, green gates) or when the frozen payload predates the relay
 * (legacy case; frozen evidence is never rewritten). Throws on a present
 * but malformed block — a claimed register the gate cannot evaluate is a
 * fail-closed contract violation, never a silent return to grandfathering.
 */
export function resolveDevelopmentConstraintRegisterCoverage(
  developmentCase: DevelopmentCase,
): DevelopmentConstraintRegisterCoverage | null {
  const payload = developmentCase.solutionContractPayload;
  if (!payload || typeof payload !== 'object') return null;
  if (!Object.hasOwn(payload, 'constraintRegisterCoverage')) return null;
  const raw = payload['constraintRegisterCoverage'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'DEVELOPMENT_CONSTRAINT_COVERAGE_INVALID: constraintRegisterCoverage must be an object',
    );
  }
  const block = raw as Record<string, unknown>;
  const constraintRegisterRef = block['constraintRegisterRef'];
  const constraintRegisterDigest = block['constraintRegisterDigest'];
  const entries = block['entries'];
  const waivedIds = block['waivedIds'];
  if (typeof constraintRegisterRef !== 'string' || constraintRegisterRef.trim() === ''
    || typeof constraintRegisterDigest !== 'string' || constraintRegisterDigest.trim() === ''
    || !Array.isArray(entries) || entries.length === 0
    || !Array.isArray(waivedIds)
    || waivedIds.some(id => typeof id !== 'string')) {
    throw new Error(
      'DEVELOPMENT_CONSTRAINT_COVERAGE_INVALID: constraintRegisterCoverage requires constraintRegisterRef, constraintRegisterDigest, a non-empty entries array and a string waivedIds array',
    );
  }
  const parsedEntries = entries.map(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        'DEVELOPMENT_CONSTRAINT_COVERAGE_INVALID: constraintRegisterCoverage entries must be objects',
      );
    }
    const row = entry as Record<string, unknown>;
    const id = row['id'];
    const entryClass = row['class'];
    const classOk = entryClass === 'execution'
      || entryClass === 'material' || entryClass === 'human';
    if (typeof id !== 'string' || id.trim() === '' || !classOk) {
      throw new Error(
        'DEVELOPMENT_CONSTRAINT_COVERAGE_INVALID: constraintRegisterCoverage entries require id and class execution|material|human',
      );
    }
    const constraintClass = entryClass as 'execution' | 'material' | 'human';
    const entrypointFiles = row['entrypointFiles'];
    if (entrypointFiles === undefined || entrypointFiles === null) {
      return { id, class: constraintClass };
    }
    if (!Array.isArray(entrypointFiles)
      || entrypointFiles.some(file => typeof file !== 'string' || file.trim() === '')
      || constraintClass !== 'execution') {
      throw new Error(
        'DEVELOPMENT_CONSTRAINT_COVERAGE_INVALID: entrypointFiles must be a non-empty-string array declared by execution-class entries only',
      );
    }
    return { id, class: constraintClass, entrypointFiles: entrypointFiles as readonly string[] };
  });
  return {
    constraintRegisterRef,
    constraintRegisterDigest,
    entries: parsedEntries,
    waivedIds: waivedIds as readonly string[],
  };
}

export interface DevelopmentCase {
  schemaVersion: typeof DEVELOPMENT_CASE_SCHEMA;
  projectId: number;
  epicId: number;
  formalizationCertificate: ContentAddressedReference & {
    decision: 'formalized';
  };
  solutionContract: ContentAddressedReference;
  /**
   * ADR-088 (CC-GAP-6): the frozen formalization solution-contract payload,
   * mapped whole (optional source paths cannot be mapped by the strict
   * resolver). Development resolves the optional `constraintRegisterCoverage`
   * block from it — the planner inherits the frozen classification; it never
   * reads the register itself. Optional: legacy cases predate the relay and
   * stay grandfathered (registerless semantics).
   */
  solutionContractPayload?: Readonly<Record<string, unknown>>;
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
  /** ATOMIC criterion identities this item serves — criterionKeys, NOT artifact ids. */
  acceptanceCriterionKeys: readonly string[];
  /**
   * PROVENANCE artifact ids — KERNEL-inherited from the frozen case (unique
   * artifactIds of the referenced criteria), never proposed by the planner.
   * Task materialization and adoption read this for DB artifact rows.
   */
  sourceArtifactIds: readonly number[];
  dependsOnKeys: readonly string[];
  /** Repository-local ownership units used to prevent unsafe parallel edits. */
  changeScopes: readonly string[];
  required: boolean;
  /**
   * Criticality carried from the AC binding. Stamped onto task metadata
   * so the integration readiness gate can classify verification outcomes.
   */
  criticality: AcceptanceCriticality;
  /**
   * AC-drift relay: the KERNEL-computed union of coveredConstraintIds over
   * the frozen criteria this item references (see canonicalItems). The
   * planner cannot forge or drop it — it is inherited, not proposed.
   */
  coveredConstraintIds?: readonly string[];
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
/**
 * The planner-PROPOSED item shape: criterion keys only. The kernel stamps
 * provenance (sourceArtifactIds) and the constraint relay
 * (coveredConstraintIds) at canonicalization — the planner can neither
 * propose nor forge either field (ADR-088 CC-GAP-6: the proposal shape MUST
 * NOT re-admit `coveredConstraintIds`; decode trims and canonicalization
 * derives it unconditionally from the frozen criteria).
 */
export type DevelopmentTaskGraphProposalItem = Omit<
  DevelopmentTaskGraphItem, 'sourceArtifactIds' | 'coveredConstraintIds'
>;

export interface DevelopmentTaskGraphProposal {
  schemaVersion: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
  implementationItems: readonly DevelopmentTaskGraphProposalItem[];
  verificationItems: readonly DevelopmentTaskGraphProposalItem[];
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
  * image is a different candidate. When the docker environment precondition is
  * missing but an image is declared, the provider retries the precondition
  * inside the check up to the frozen bound and on exhaustion emits the typed
  * unknown `warrant-blocked-environment` outcome (CC-GAP-9 / ADR-089) rather
  * than silently falling back to host or recording a product 'failed'.
  */
export type ReadinessProfile = ServedReadinessProfile | StaticReadinessProfile;

/**
 * Optional Docker image substrate declaration. When present on a readiness
 * profile, the local-runnability provider executes the product's install/test/serve
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

/**
 * SEAM-ARCHITECT Layer 2 (a) — optional docker compose declaration. When the
 * readiness profile declares a compose file, the local-runnability provider
 * verifies the ASSEMBLED WHOLE as a composition: config validation always;
 * a bounded `up --wait` + `down` in the full mode. This is a TYPED
 * declaration from the frozen profile/manifest — never an inference from
 * incidental compose files found in the tree (LR-04 discipline).
 */
export interface ReadinessCompose {
  /**
   * Compose file path RELATIVE to the candidate root. Non-empty; absolute
   * paths and `..` traversal are invalid (the file must live inside the
   * sealed tree).
   */
  file: string;
  /** Optional `docker compose -p` project name. */
  projectName?: string;
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
  /** @see ReadinessCompose — optional compose verification of the assembled whole. */
  compose?: ReadinessCompose;
}

export interface StaticReadinessProfile {
  kind: 'static';
  /** @see RunnabilityCommands — deterministic install + test commands. */
  commands: RunnabilityCommands;
  /** @see ReadinessEnvironment — optional Docker image for containerized execution. */
  environment?: ReadinessEnvironment;
  /** @see ReadinessCompose — optional compose verification of the assembled whole. */
  compose?: ReadinessCompose;
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
  /** Exact post-integration source material certified by the readiness Cell. */
  sourceCandidate?: ContentAddressedReference;
  /** Exact accepted manifest and deterministic Gate receipt. */
  readinessCertification?: {
    manifest: ContentAddressedReference;
    candidateSetRef: string;
    checkReceipt: ContentAddressedReference;
  };
}

/** Exact integrated material before candidate-wide run authority is certified. */
export interface IntegratedSourceCandidate {
  schemaVersion: typeof INTEGRATED_SOURCE_CANDIDATE_SCHEMA;
  taskGraphHash: string;
  implementationWorksetHash: string;
  repositories: readonly CandidateRepositorySnapshot[];
  buildProducts: readonly CandidateBuildProduct[];
  integrationIntentRefs: readonly string[];
  frozen: true;
  sourceHash: string;
}

/**
 * AC-drift network 3 seam: the verification warrant reference cited by the
 * Formalization settlement certificate. The future warrant-coverage phases in
 * the readiness provider consume exactly this shape (register + dispositions,
 * both digest-pinned) — no new oracle, no re-reading of the order prose.
 *
 * ADR-090 (CC-IC-1), mutation m7: the warrant CROSS-BINDS the certificate/case
 * it was issued against — `discoveryCertificateHash` and
 * `formalizationCaseDigest` name the exact identities, so a warrant silently
 * re-targeted at a different certificate/case is a typed red
 * (verifyWarrantCrossBind at the issuing boundary; the readiness manifest
 * contract carries the same fields). Register+dispositions self-consistency
 * alone is not identity.
 */
export interface VerificationWarrantRef {
  /** Content-addressed register ref: constraint-register:<digest>. */
  constraintRegisterRef: string;
  constraintRegisterDigest: string;
  dispositionsDigest: string;
  dispositions: Readonly<Record<string, unknown>>;
  /** @see ADR-090 (CC-IC-1) — the certificate cross-bind. */
  discoveryCertificateHash?: string;
  /** @see ADR-090 (CC-IC-1) — the FormalizationCase identity cross-bind. */
  formalizationCaseDigest?: string;
}

export interface DevelopmentReadinessManifest {
  schemaVersion: typeof DEVELOPMENT_READINESS_MANIFEST_SCHEMA;
  sourceCandidate: ContentAddressedReference;
  targets: readonly [{ key: 'primary'; readiness: ReadinessProfile }];
  /** @see VerificationWarrantRef — optional until warrant phases land. */
  warrantRef?: VerificationWarrantRef;
  /**
   * CC-GAP-7 — the package/workshop-declared verification-warrant ORACLE
   * ADAPTERS. Present only with a present `warrantRef`: each entry declares
   * one adapter that claims to prove named register constraints by running a
   * deterministic evidence command in the prepared environment. The
   * readiness provider consumes this READ-ONLY (no product-type switch, no
   * re-reading of order prose): warrant execution diffs the register's
   * non-waived execution-class entries against the declared adapter
   * coverage; an uncovered claim yields the typed oracle-insufficient
   * outcome — never a pass and never a product-failed verdict. Deliverable
   * specifics (browser/canvas/…) arrive ONLY through this declared data,
   * never through engine branches.
   */
  warrantOracles?: readonly WarrantOracleAdapterDeclaration[];
}

/**
 * CC-GAP-7 — one package/workshop-declared verification-warrant oracle
 * adapter (the LEGO principle — Conveyor Mental Model §3; no-workshop-branch
 * rule — master plan §4). The adapter is DATA on the readiness manifest, not
 * engine vocabulary: the provider never switches on product type, workshop
 * name, `moduleRef`, or role profession. It executes exactly the declared
 * evidence command and binds the adapter identity/version into the receipt.
 */
export interface WarrantOracleAdapterDeclaration {
  /** Stable adapter identity, unique within the manifest (e.g. 'browser-smoke'). */
  readonly adapterId: string;
  /** Semver adapter identity — binds the receipt (a swapped adapter is a different receipt). */
  readonly adapterVersion: string;
  /** Register constraint ids (ord-c-NNN) this adapter claims to prove. */
  readonly coversConstraintIds: readonly string[];
  /**
   * The deterministic command whose successful execution in the prepared
   * environment is the adapter's evidence for its covered claims. Same
   * command authority as the profile's testCommand (never inferred).
   */
  readonly evidenceCommand: string;
}

const WARRANT_ORACLE_ADAPTER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WARRANT_ORACLE_CONSTRAINT_ID_RE = /^ord-c-\d{3,}$/u;

/**
 * CC-GAP-7 — fail-closed structural validation of the declared oracle
 * adapter set (the submission-boundary shape check; the readiness provider
 * re-validates independently before execution — defense in depth). Returns
 * the typed error strings; empty means structurally valid.
 *
 * Lawful-declaration rules:
 *  - `warrantOracles` requires a PRESENT `warrantRef` (an adapter set with
 *    no warrant to execute is a typed submission defect, never silently
 *    ignored);
 *  - adapter ids are unique, non-empty, closed-charset;
 *  - `coversConstraintIds` names existing register id shapes (ord-c-NNN),
 *    unique per adapter, non-empty — an adapter proving nothing is not an
 *    adapter;
 *  - `evidenceCommand` is a non-empty string (same command authority
 *    discipline as readiness.commands).
 */
export function validateWarrantOracleDeclarations(
  warrantPresent: boolean,
  raw: unknown,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!warrantPresent) {
    return ['warrantOracles requires a present warrantRef — an oracle adapter set without a warrant to execute is a typed submission defect'];
  }
  if (!Array.isArray(raw)) {
    return ['warrantOracles must be an array of oracle adapter declarations'];
  }
  const errors: string[] = [];
  const seenAdapterIds = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`warrantOracles[${index}] must be an object`);
      continue;
    }
    const declaration = entry as Record<string, unknown>;
    const adapterId = declaration['adapterId'];
    if (typeof adapterId !== 'string' || !WARRANT_ORACLE_ADAPTER_ID_RE.test(adapterId)) {
      errors.push(`warrantOracles[${index}].adapterId must be a non-empty lowercase identifier ([a-z0-9][a-z0-9._-]{0,63})`);
    } else if (seenAdapterIds.has(adapterId)) {
      errors.push(`warrantOracles[${index}].adapterId '${adapterId}' is declared twice — adapter identity is unique within the manifest`);
    } else {
      seenAdapterIds.add(adapterId);
    }
    const adapterVersion = declaration['adapterVersion'];
    if (typeof adapterVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(adapterVersion)) {
      errors.push(`warrantOracles[${index}].adapterVersion must be semver (X.Y.Z)`);
    }
    const covers = declaration['coversConstraintIds'];
    if (!Array.isArray(covers) || covers.length === 0) {
      errors.push(`warrantOracles[${index}].coversConstraintIds must be a non-empty array of register constraint ids`);
    } else {
      const seenIds = new Set<string>();
      for (const id of covers) {
        if (typeof id !== 'string' || !WARRANT_ORACLE_CONSTRAINT_ID_RE.test(id)) {
          errors.push(`warrantOracles[${index}].coversConstraintIds entries must be register constraint ids (ord-c-NNN)`);
          break;
        }
        if (seenIds.has(id)) {
          errors.push(`warrantOracles[${index}].coversConstraintIds declares '${id}' twice`);
          break;
        }
        seenIds.add(id);
      }
    }
    const evidenceCommand = declaration['evidenceCommand'];
    if (typeof evidenceCommand !== 'string' || evidenceCommand.trim().length === 0) {
      errors.push(`warrantOracles[${index}].evidenceCommand must be a non-empty string (the adapter's deterministic evidence command)`);
    }
    for (const field of Object.keys(declaration)) {
      if (!['adapterId', 'adapterVersion', 'coversConstraintIds', 'evidenceCommand'].includes(field)) {
        errors.push(`warrantOracles[${index}] carries unknown field '${field}' — the adapter declaration vocabulary is closed`);
      }
    }
  }
  return errors;
}

/**
 * ADR-090 (CC-IC-1 focused repair, m7 consumer boundary): the authoritative
 * expected warrant cross-bind of a DevelopmentCase — resolved from the FROZEN
 * formalization solution-contract payload the case carries (never re-derived,
 * never worker-supplied). Structural mirror of the formalization-side
 * expectation (same discipline as VerificationWarrantRef — no cross-module
 * domain import).
 */
export interface DevelopmentWarrantCrossBindExpectation {
  readonly discoveryCertificateHash: string;
  readonly formalizationCaseDigest: string;
}

/**
 * Resolve the expected warrant cross-bind identities from the case's frozen
 * solution-contract payload. Returns null when the frozen payload carries no
 * verifiable expectation (legacy payloads frozen before the seam, or a case
 * with no payload at all) — a PRESENT manifest warrantRef against such a case
 * is then a typed red at the consumer, never a silent unverifiable accept.
 */
export function resolveExpectedWarrantCrossBind(
  developmentCase: DevelopmentCase,
): DevelopmentWarrantCrossBindExpectation | null {
  const payload = developmentCase.solutionContractPayload;
  if (!payload || typeof payload !== 'object') return null;
  const discoveryCertificateHash = payload['discoveryCertificateHash'];
  const formalizationCaseDigest = payload['formalizationCaseDigest'];
  if (typeof discoveryCertificateHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(discoveryCertificateHash)) {
    return null;
  }
  if (typeof formalizationCaseDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(formalizationCaseDigest)) {
    return null;
  }
  return { discoveryCertificateHash, formalizationCaseDigest };
}

/**
 * ADR-090 (CC-IC-1 focused repair, mutation m7 CONSUMER boundary: a
 * Development readiness manifest must not accept a forged or partial
 * `discoveryCertificateHash`/`formalizationCaseDigest` cross-bind.
 *
 * Fail-closed rules, in order:
 *  1. an ABSENT manifest warrantRef is legal (retro-compat — the warrant
 *     phases are not yet mandatory);
 *  2. a PRESENT warrantRef must carry BOTH cross-bind identities as 64-hex
 *     strings — a partial cross-bind (one field stripped) is a typed red;
 *  3. the values must equal the case's AUTHORITATIVE expected identities
 *     resolved from the frozen solution-contract payload — a forged
 *     re-targeted warrant is a typed red;
 *  4. a case whose frozen payload carries no verifiable expectation cannot
 *     verify a present warrantRef at all — a typed red, never a silent
 *     unverifiable accept.
 */
export function verifyReadinessManifestWarrantCrossBind(
  developmentCase: DevelopmentCase,
  manifest: DevelopmentReadinessManifest,
): void {
  const warrant = manifest.warrantRef;
  if (warrant === undefined) return;
  const certificateHash = warrant.discoveryCertificateHash;
  const caseDigest = warrant.formalizationCaseDigest;
  if (
    typeof certificateHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(certificateHash)
    || typeof caseDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(caseDigest)
  ) {
    throw new Error(
      'WARRANT_CROSS_BIND_INCOMPLETE: a present readiness-manifest warrantRef must carry '
      + 'BOTH the discoveryCertificateHash and the formalizationCaseDigest as 64-hex '
      + 'cross-bind identities — a partial cross-bind is a typed red',
    );
  }
  const expected = resolveExpectedWarrantCrossBind(developmentCase);
  if (!expected) {
    throw new Error(
      'WARRANT_CROSS_BIND_EXPECTATION_MISSING: the DevelopmentCase carries no authoritative '
      + 'warrant cross-bind expectation (discoveryCertificateHash/formalizationCaseDigest on '
      + 'the frozen solution-contract payload) to verify a present warrantRef against — '
      + 'never a silent unverifiable accept',
    );
  }
  if (
    certificateHash !== expected.discoveryCertificateHash
    || caseDigest !== expected.formalizationCaseDigest
  ) {
    throw new Error(
      'WARRANT_CROSS_BIND_MISMATCH: the readiness-manifest warrantRef cross-bind does not '
      + 'match the authoritative certificate/case identities of this DevelopmentCase '
      + `(warrant certificate ${certificateHash} / case ${caseDigest})`,
    );
  }
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
  /** ATOMIC criterion identity `${artifactId}:${code}` — never a bare artifactId. */
  acceptanceCriterionKey: string;
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

/**
 * The closed decision union IS the mechanical unreachability proof.
 * 'rework-required' and 'clarification-required' were deleted with their
 * routes (declared, never produced — see
 * docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md).
 */
export type DevelopmentDecision =
  | 'verified'
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
  | 'constraint-register-uncovered'
  | 'constraint-entrypoint-unowned'
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
  | 'local-readiness-failed'
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
