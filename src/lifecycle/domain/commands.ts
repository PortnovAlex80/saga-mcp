/**
 * Lifecycle commands — discriminated union + typed envelope.
 *
 * Source: blueprint §7 (docs/architecture/passive-worker-kernel-blueprint.md:310-370)
 *         and §11 transition table (line 506-528).
 *
 * One typed envelope wraps every command (blueprint §7:314-328). The command
 * union is closed: adding a command requires extending `LifecycleCommand` AND
 * a transition rule in `decide` (evolve.ts) AND a vocabulary entry. This is
 * enforced by exhaustive `assertNever` in switches (blueprint §18:1122).
 *
 * Stable command IDs (blueprint §7.1:355-370):
 *   - Semantic single-use worker commands derive IDs from execution-id + suffix:
 *       <execution-id>:implementation-completed
 *       <execution-id>:review-verdict
 *       <execution-id>:human-question
 *       <execution-id>:verification:<artifact-id>:<content-hash>
 *   - Controller/admin commands use generated UUIDs.
 *   - A retry MUST reuse the original ID. Reusing one ID with a different
 *     canonical payload hash is `IDEMPOTENCY_KEY_REUSED`.
 *
 * Worker commands identify `workItemId` and `attemptId` — never `targetStatus`
 * (blueprint §7:351-353). Only the reducer selects the next work item; only
 * the board projector derives task status.
 *
 * Pure TS. No imports from SQLite, Node, tools, or tracker-view.
 */

import type {
  CommandId,
  ExecutionId,
  HumanRequestId,
  IntegrationId,
} from './ids.js';

// ---------------------------------------------------------------------------
// Actor model (blueprint §7:317-326)
// ---------------------------------------------------------------------------

export type CommandActor =
  | { readonly kind: 'controller'; readonly id: string }
  | {
      readonly kind: 'managed_execution';
      readonly workerId: string;
      readonly executionId: ExecutionId;
    }
  | { readonly kind: 'integration_executor'; readonly id: string }
  | { readonly kind: 'human'; readonly id: string }
  | { readonly kind: 'admin'; readonly id: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Typed envelope (blueprint §7:315-328)
// ---------------------------------------------------------------------------

export interface CommandEnvelope<C extends LifecycleCommand> {
  readonly commandId: CommandId;
  readonly actor: CommandActor;
  readonly command: C;
}

// ---------------------------------------------------------------------------
// Commands — one type per line of the §11 transition table.
// ---------------------------------------------------------------------------

export interface ReserveWorkItem {
  readonly kind: 'ReserveWorkItem';
  readonly taskId: number;
  readonly phase: 'implementation' | 'review';
  readonly workItemId: string;
  readonly attemptId: string;
  readonly executionId: ExecutionId;
  readonly workerId: string;
}

export interface RegisterWorkerProcess {
  readonly kind: 'RegisterWorkerProcess';
  readonly taskId: number;
  readonly executionId: ExecutionId;
  readonly pid: number | null;
  readonly processBirthToken: string | null;
}

/**
 * Worker reports implementation done. `sourceSha` is frozen at this point;
 * review must inspect that exact commit (blueprint §12.1:546-548).
 */
export interface ReportImplementationCompleted {
  readonly kind: 'ReportImplementationCompleted';
  readonly taskId: number;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly sourceSha: string;
  readonly summary: string;
}

export interface SubmitReviewVerdict {
  readonly kind: 'SubmitReviewVerdict';
  readonly taskId: number;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly verdict: 'approved' | 'changes_requested';
  /** Frozen on approval; reviewed source commit the integration must replay. */
  readonly reviewedSourceSha?: string;
  readonly summary: string;
}

export interface ParkForHuman {
  readonly kind: 'ParkForHuman';
  readonly taskId: number;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly resumePhase: 'implementation' | 'review' | 'integration';
  readonly question: string;
}

export interface RecordHumanAnswer {
  readonly kind: 'RecordHumanAnswer';
  readonly taskId: number;
  readonly requestId: HumanRequestId;
  readonly answer: string;
}

export interface RequestExecutionStop {
  readonly kind: 'RequestExecutionStop';
  readonly taskId: number;
  readonly executionId: ExecutionId;
}

export interface ObserveProcessExited {
  readonly kind: 'ObserveProcessExited';
  readonly taskId: number;
  readonly executionId: ExecutionId;
  readonly exitCode: number | null;
}

export interface ObserveProcessLost {
  readonly kind: 'ObserveProcessLost';
  readonly taskId: number;
  readonly executionId: ExecutionId;
}

export interface ReserveIntegrationAttempt {
  readonly kind: 'ReserveIntegrationAttempt';
  readonly taskId: number;
  readonly integrationId: IntegrationId;
  readonly executorExecutionId: ExecutionId;
}

export interface ObserveIntegrationMerged {
  readonly kind: 'ObserveIntegrationMerged';
  readonly taskId: number;
  readonly integrationId: IntegrationId;
  readonly mergeCommitSha: string;
}

export interface ObserveIntegrationConflict {
  readonly kind: 'ObserveIntegrationConflict';
  readonly taskId: number;
  readonly integrationId: IntegrationId;
  readonly conflictManifest: string;
}

export interface ReconcileDependencies {
  readonly kind: 'ReconcileDependencies';
  readonly taskId: number;
  readonly blocked: boolean;
}

export interface AdminOverrideLifecycle {
  readonly kind: 'AdminOverrideLifecycle';
  readonly taskId: number;
  /** Caller-declared expected pre-state fence (blueprint §11:528). */
  readonly expectedStateFence: string;
  readonly target: 'queued_implementation' | 'completed' | 'blocked';
}

// ---------------------------------------------------------------------------
// Closed union (blueprint §7:334-348)
// ---------------------------------------------------------------------------

export type LifecycleCommand =
  | ReserveWorkItem
  | RegisterWorkerProcess
  | ReportImplementationCompleted
  | SubmitReviewVerdict
  | ParkForHuman
  | RecordHumanAnswer
  | RequestExecutionStop
  | ObserveProcessExited
  | ObserveProcessLost
  | ReserveIntegrationAttempt
  | ObserveIntegrationMerged
  | ObserveIntegrationConflict
  | ReconcileDependencies
  | AdminOverrideLifecycle;

/**
 * Discriminant extractor — keeps switches exhaustive without forcing callers
 * to spell out the `command.kind` literal.
 */
export type CommandKind = LifecycleCommand['kind'];

/**
 * Maps a command type to the result value the bus returns on acceptance.
 * For most commands this is a small ack; `SubmitReviewVerdict(approved, git)`
 * returns the new integration id; `ParkForHuman` returns the request id.
 *
 * `decide` (evolve.ts) produces a `Decision<ResultFor<C>>`. Slice 0 declares
 * the mapping; Slice 1+ populates it.
 */
export interface ResultFor<C extends LifecycleCommand> {
  // Placeholder — Slice 1 returns concrete ack shapes per command.
  readonly __commandKind: C['kind'];
}
