/**
 * Persistence port for generic recovery cases.
 *
 * The repository owns only durable identity, idempotency and attempt
 * accounting. It does not decide whether a module issue is repairable and
 * does not execute repair/acceptance actions.
 */

import type {
  RecordRecoveryIssueInput,
  RecordRecoveryIssueResult,
  RecoveryAttemptRecord,
  RecoveryCaseRecord,
} from './recovery-case.js';

export interface RecoveryCaseRepository {
  /**
   * Record one verifier failure atomically.
   *
   * The same source NodeRun + the same immutable issue is an idempotent replay.
   * The same source NodeRun with different data is rejected. A new source
   * NodeRun joins the active case for (processRunId, policyId), or opens a new
   * case when the previous one is terminal. `maxAttempts` counts repair
   * rounds: attempts 1..maxAttempts are returned to a repair worker; the next
   * failed verification is durably recorded as the exhausted final issue.
   */
  recordIssue(input: RecordRecoveryIssueInput): RecordRecoveryIssueResult;

  /**
   * Resolve the active case for one policy after its verifier succeeds.
   * Returns null when there is no active case (idempotent no-op).
   */
  resolveActive(
    processRunId: number,
    policyId: string,
    resolvedByNodeRunId: number,
  ): RecoveryCaseRecord | null;

  /** Read one case by its durable id. */
  readCase(id: number): RecoveryCaseRecord | null;

  /** Read the active case for one stable policy id. */
  readActive(
    processRunId: number,
    policyId: string,
  ): RecoveryCaseRecord | null;

  /**
   * Find the active feedback loop that should be resumed at a verifier node.
   * A flow normally has at most one such case for a verifier; newest wins if
   * independent policies deliberately share the same verifier.
   */
  readActiveForVerifier(
    processRunId: number,
    verifyNodeId: string,
  ): RecoveryCaseRecord | null;

  /** All cases (active and terminal) for diagnostics, newest first. */
  listForProcessRun(processRunId: number): readonly RecoveryCaseRecord[];

  /** Immutable attempts in issue order. */
  listAttempts(caseId: number): readonly RecoveryAttemptRecord[];
}
