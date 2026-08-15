/**
 * Module-agnostic recovery contracts.
 *
 * A module-owned verifier explains WHAT is wrong by emitting RecoveryIssue.
 * The process runtime owns HOW the issue is retried: it opens a durable case,
 * chooses the configured repair node and gives that worker RecoveryFeedback.
 *
 * `reasonCode` and finding codes are deliberately opaque to the runtime. A
 * formalization module may emit `SRS_NOT_ACCEPTED`; another module can use an
 * entirely different vocabulary without adding branches to the engine.
 */

import type { ProcessModuleReference } from './process-module.js';

export const RECOVERY_ISSUE_SCHEMA = 'factory.recovery-issue.v1' as const;
export const RECOVERY_FEEDBACK_SCHEMA = 'factory.recovery-feedback.v1' as const;

/** Module-owned, opaque reason code. The generic runtime never switches on it. */
export type RecoveryReasonCode = string;

/**
 * The requested handling class. Routing and retry limits remain runtime
 * policy; this value only states the verifier's semantic recommendation.
 */
export type RecoveryDisposition = 'repair' | 'retry' | 'human' | 'fatal';

export type RecoveryFindingSeverity = 'info' | 'warning' | 'error' | 'fatal';

/**
 * Durable reference to an artifact, certificate, task or other subject that
 * the repair worker may inspect. `kind` and `schema` are module vocabulary.
 */
export interface RecoverySubjectRef {
  kind: string;
  ref: string;
  schema?: string | null;
  contentHash?: string | null;
}

/**
 * One actionable verifier finding. The runtime persists the values verbatim;
 * it does not interpret module paths, expectations or evidence references.
 */
export interface RecoveryFinding {
  code: string;
  severity: RecoveryFindingSeverity;
  message: string;
  subjectRef?: string | null;
  path?: string | null;
  expected?: unknown;
  actual?: unknown;
  evidenceRefs?: readonly string[];
}

/**
 * Standard issue report emitted by any module-owned validation/gate node.
 *
 * `policyId` is a stable identifier for the gate (for example
 * `formalization.architecture-contract`). It groups repeated failures into one
 * recovery case. It is not the reason: one policy can emit many reason codes.
 */
export interface RecoveryIssue {
  schemaVersion: typeof RECOVERY_ISSUE_SCHEMA;
  policyId: string;
  disposition: RecoveryDisposition;
  reasonCode: RecoveryReasonCode;
  summary: string;
  findings: readonly RecoveryFinding[];
  subjectRefs: readonly RecoverySubjectRef[];
  acceptanceCriteria: readonly string[];
  allowedChanges: readonly string[];
  /**
   * Additional capabilities required only for this repair attempt. The
   * runtime unions these with the producer profile when freezing authority;
   * ordinary executions do not receive them.
   */
  requiredTools?: readonly string[];
  /**
   * Optional module-owned immutable context needed by the repair worker.
   * Generic recovery persists and forwards it without interpreting its keys.
   */
  context?: Readonly<Record<string, unknown>>;
}

/**
 * Structural snapshot of the production that entered the failing verifier.
 *
 * It intentionally mirrors application/NodeProduction without importing the
 * application layer into the domain. The repair worker therefore receives the
 * exact manifest/hash/bindings it must amend, not only a textual complaint.
 */
export interface RecoverySourceProduction {
  schema: string;
  artifactRef: string;
  contentHash: string;
  /** Cross-run-stable semantic digest (CONVEYOR v4.3 §5-6 mirror). */
  semanticDigest?: string;
  bindings: Record<string, unknown>;
}

/**
 * Runtime-owned envelope delivered to the repair worker.
 *
 * It embeds the original issue unchanged and adds durable identity, lineage,
 * route and attempt budget. This is sufficient to reconstruct the repair task
 * after a crash without relying on in-memory frame state.
 */
export interface RecoveryFeedback {
  schemaVersion: typeof RECOVERY_FEEDBACK_SCHEMA;
  caseId: number;
  processRunId: number;
  moduleRef: ProcessModuleReference;
  sourceNodeRunId: number;
  verifyNodeId: string;
  repairNodeId: string | null;
  attempt: number;
  maxAttempts: number;
  issueRef: string;
  issueHash: string;
  issue: RecoveryIssue;
  sourceProduction: RecoverySourceProduction;
}
