/**
 * Durable records for the generic process-module recovery loop.
 *
 * One active case exists per (process run, recovery policy). Each verifier
 * failure is an immutable attempt. A repeated call for the same source
 * NodeRun replays that exact attempt instead of consuming the retry budget.
 */

import type {
  RecoveryFeedback,
  RecoveryIssue,
  RecoverySourceProduction,
} from '../domain/recovery.js';
import type { ProcessModuleReference } from '../domain/process-module.js';

export const RECOVERY_CASE_STATUSES = [
  'active',
  'resolved',
  'exhausted',
] as const;
export type RecoveryCaseStatus = typeof RECOVERY_CASE_STATUSES[number];

export interface RecoveryCaseRecord {
  id: number;
  processRunId: number;
  moduleRef: ProcessModuleReference;
  moduleRefKey: string;
  policyId: string;
  verifyNodeId: string;
  repairNodeId: string | null;
  maxAttempts: number;
  status: RecoveryCaseStatus;
  attemptCount: number;
  openedByNodeRunId: number;
  lastSourceNodeRunId: number;
  lastIssueRef: string;
  lastIssueHash: string;
  lastReasonCode: string;
  resolvedByNodeRunId: number | null;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface RecoveryAttemptRecord {
  id: number;
  caseId: number;
  sourceNodeRunId: number;
  attempt: number;
  issueRef: string;
  issueHash: string;
  issue: RecoveryIssue;
  feedbackHash: string;
  feedback: RecoveryFeedback;
  createdAt: string;
}

export interface RecordRecoveryIssueInput {
  processRunId: number;
  moduleRef: ProcessModuleReference;
  sourceNodeRunId: number;
  verifyNodeId: string;
  repairNodeId: string | null;
  maxAttempts: number;
  issue: RecoveryIssue;
  /** Exact production snapshot that was rejected by the verifier. */
  sourceProduction: RecoverySourceProduction;
}

export interface RecordRecoveryIssueResult {
  caseRecord: RecoveryCaseRecord;
  attemptRecord: RecoveryAttemptRecord;
  feedback: RecoveryFeedback;
  /** True when sourceNodeRunId had already recorded this exact issue. */
  replayed: boolean;
  /**
   * True when all configured repair rounds were already consumed. The final
   * verifier issue is still persisted as an immutable exhausted attempt.
   */
  exhausted: boolean;
}
