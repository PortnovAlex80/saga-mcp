import type {
  RecoveryDisposition,
  RecoverySubjectRef,
} from '../domain/recovery.js';

/**
 * Universal acceptance port for an exact set of artifacts produced by one
 * managed Process Module node execution.
 *
 * The module owns the semantic decision ("these exact versions passed my
 * gate"). The infrastructure adapter owns the mechanical commit:
 *
 *   expected ids/types/hashes + managed lineage + optional approved review
 *     -> one atomic compare-and-set to status=accepted, accepted_hash=<hash>,
 *        drift_state=clean
 *
 * No artifact kind is special here. SRS, PRD, AC, release manifests and future
 * module-owned artifact types all use the same protocol.
 */

export const EXACT_CANDIDATE_ACCEPTANCE_SCHEMA =
  'factory.exact-candidate-acceptance.v2' as const;
export type ExactCandidateAcceptanceSchema = typeof EXACT_CANDIDATE_ACCEPTANCE_SCHEMA;

export interface ExactArtifactCandidate {
  /** Artifact row selected by the module-owned semantic gate. */
  readonly artifactId: number;
  /** Exact type observed and validated by the gate. */
  readonly artifactType: string;
  /** Exact content version observed and validated by the gate. */
  readonly contentHash: string;
}

export interface ExactCandidateProductionLineage {
  readonly processRunId: number;
  /** Canonical `${moduleName}@${moduleVersion}` reference. */
  readonly moduleRef: string;
  /** The LM/managed node which produced the candidates. */
  readonly nodeId: string;
  readonly intentId: number;
  readonly taskId: number;
  /** Fencing token of the managed execution which produced the candidates. */
  readonly executionId: string;
  readonly projectId: number;
  readonly epicId: number;
}

export interface AcceptExactCandidatesCommand {
  /**
   * Stable key chosen by the recovery/gate coordinator. Equal replay is
   * idempotent; reuse with any different field is rejected.
   */
  readonly idempotencyKey: string;
  readonly lineage: ExactCandidateProductionLineage;
  readonly candidates: readonly ExactArtifactCandidate[];
  /**
   * When true, task=done alone is insufficient: an accepted worker_done
   * receipt whose terminal result is `done` must exist for the task.
   */
  readonly requireApprovedReview: boolean;
  /** Kernel/policy authority which made the semantic gate decision. */
  readonly authority: string;
  /** Stable module-owned reason/policy code, not interpreted by this port. */
  readonly reasonCode: string;
  /**
   * Optional immutable explanatory payload (gate/certificate/recovery refs).
   * It is hashed into idempotency and retained in the decision snapshot.
   */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * A module-owned semantic verifier may request the common kernel executor to
 * commit the exact candidates only after the handler has returned normally.
 *
 * This keeps the roles separate:
 *   - the module handler decides whether the candidate is semantically valid;
 *   - the generic kernel executor applies the mechanical atomic acceptance;
 *   - the generic recovery interpreter routes a rejected commit using the
 *     module-declared policy below.
 */
export interface ExactCandidateAcceptanceDirective {
  readonly command: AcceptExactCandidatesCommand;
  readonly rejection: {
    /** Domain event emitted when the common acceptance port rejects the CAS. */
    readonly event: string;
    /** Must match one FlowRecoveryDefinition declared by the module. */
    readonly policyId: string;
    readonly disposition: RecoveryDisposition;
    readonly summary: string;
    readonly acceptanceCriteria: readonly string[];
    readonly allowedChanges: readonly string[];
    readonly subjectRefs: readonly RecoverySubjectRef[];
    readonly context?: Readonly<Record<string, unknown>>;
  };
}

export type ExactCandidateAcceptanceItemDisposition =
  | 'accepted'
  | 'reaccepted'
  | 'already-accepted';

export interface ExactCandidateAcceptanceItem {
  readonly artifactId: number;
  readonly artifactType: string;
  readonly contentHash: string;
  readonly ledgerId: number;
  readonly disposition: ExactCandidateAcceptanceItemDisposition;
  readonly priorStatus: string;
  readonly priorAcceptedHash: string | null;
  readonly priorDriftState: string;
  readonly finalStatus: 'accepted';
  readonly finalAcceptedHash: string;
  readonly finalDriftState: 'clean';
}

export interface ExactCandidateAcceptanceDecision {
  readonly schemaVersion: ExactCandidateAcceptanceSchema;
  readonly decisionId: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly candidateSetHash: string;
  readonly decisionHash: string;
  readonly lineage: ExactCandidateProductionLineage;
  readonly requireApprovedReview: boolean;
  readonly producerCompletionReceiptCommandId: string | null;
  readonly producerCompletionReceiptHash: string | null;
  readonly approvedReviewReceiptCommandId: string | null;
  readonly approvedReviewReceiptHash: string | null;
  readonly authority: string;
  readonly reasonCode: string;
  readonly items: readonly ExactCandidateAcceptanceItem[];
  readonly decidedAt: string;
  /** True when no write was repeated and the immutable decision was replayed. */
  readonly replayed: boolean;
}

/** Durable audit link persisted on the NodeRun that requested the gate. */
export interface ExactCandidateAcceptanceReceipt {
  readonly schemaVersion: ExactCandidateAcceptanceSchema;
  readonly decisionRef: string;
  readonly decisionHash: string;
  readonly candidateSetHash: string;
  readonly idempotencyKey: string;
  readonly replayed: boolean;
}

export type ExactCandidateAcceptanceRejectionCode =
  | 'EXACT_ACCEPTANCE_INVALID_COMMAND'
  | 'EXACT_ACCEPTANCE_IDEMPOTENCY_KEY_REUSED'
  | 'EXACT_ACCEPTANCE_PROCESS_RUN_NOT_FOUND'
  | 'EXACT_ACCEPTANCE_LINEAGE_MISMATCH'
  | 'EXACT_ACCEPTANCE_CANDIDATE_NOT_PRODUCED'
  | 'EXACT_ACCEPTANCE_ARTIFACT_NOT_FOUND'
  | 'EXACT_ACCEPTANCE_ARTIFACT_SCOPE_DRIFT'
  | 'EXACT_ACCEPTANCE_ARTIFACT_TYPE_DRIFT'
  | 'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT'
  | 'EXACT_ACCEPTANCE_ARTIFACT_STATE_INVALID'
  | 'EXACT_ACCEPTANCE_PREEXISTING_ACCEPTANCE_UNATTESTED'
  | 'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED'
  | 'EXACT_ACCEPTANCE_CAS_FAILED'
  | 'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT';

/**
 * Deterministic, fail-closed rejection. `details` must contain identifiers and
 * hashes only; callers should not put mutable artifact bodies in it.
 */
export class ExactCandidateAcceptanceRejected extends Error {
  readonly name = 'ExactCandidateAcceptanceRejected';

  constructor(
    readonly code: ExactCandidateAcceptanceRejectionCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message}`);
  }
}

export interface ExactCandidateAcceptance {
  accept(
    command: AcceptExactCandidatesCommand,
  ): ExactCandidateAcceptanceDecision;

  findByIdempotencyKey(
    idempotencyKey: string,
  ): ExactCandidateAcceptanceDecision | null;

  /**
   * Replay validator used by module resolvers after the canonical artifact
   * status has legitimately advanced beyond the worker-production snapshot.
   */
  isAcceptedExact(
    lineage: ExactCandidateProductionLineage,
    candidate: ExactArtifactCandidate,
  ): boolean;
}
