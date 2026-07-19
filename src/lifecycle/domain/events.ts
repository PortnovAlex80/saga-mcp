/**
 * Domain events — audit facts and projection inputs.
 *
 * Source: blueprint §8 (docs/architecture/passive-worker-kernel-blueprint.md:376-403).
 *
 * Events are NOT the source of truth (blueprint §8:374 and §1 non-goals).
 * They are: (a) an audit trail, (b) inputs the projector consumes to derive
 * `tasks`/`work_items` snapshots. The reducer's `Decision.events` are appended
 * atomically with the snapshot write (blueprint §10:486-488).
 *
 * Names are FROZEN. Renaming requires a vocabulary update + ADR.
 *
 * Pure TS. No imports from SQLite, Node, tools, or tracker-view.
 */

import type {
  ExecutionId,
  HumanRequestId,
  IntegrationId,
} from './ids.js';

export interface WorkItemCreated {
  readonly kind: 'WorkItemCreated';
  readonly taskId: number;
  readonly workItemId: string;
  readonly phase: 'implementation' | 'review' | 'integration' | 'verification';
}

export interface WorkAttemptReserved {
  readonly kind: 'WorkAttemptReserved';
  readonly taskId: number;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly executionId: ExecutionId;
}

export interface WorkAttemptStarted {
  readonly kind: 'WorkAttemptStarted';
  readonly taskId: number;
  readonly attemptId: string;
  readonly executionId: ExecutionId;
}

export interface WorkAttemptSucceeded {
  readonly kind: 'WorkAttemptSucceeded';
  readonly taskId: number;
  readonly attemptId: string;
}

export interface WorkAttemptLost {
  readonly kind: 'WorkAttemptLost';
  readonly taskId: number;
  readonly attemptId: string;
}

export interface ExecutionReserved {
  readonly kind: 'ExecutionReserved';
  readonly taskId: number;
  readonly executionId: ExecutionId;
  readonly workerId: string;
}

export interface ExecutionStarted {
  readonly kind: 'ExecutionStarted';
  readonly taskId: number;
  readonly executionId: ExecutionId;
  readonly pid: number | null;
}

export interface ImplementationCompleted {
  readonly kind: 'ImplementationCompleted';
  readonly taskId: number;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly sourceSha: string;
}

export interface ReviewItemCreated {
  readonly kind: 'ReviewItemCreated';
  readonly taskId: number;
  readonly workItemId: string;
}

export interface ReviewApproved {
  readonly kind: 'ReviewApproved';
  readonly taskId: number;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly reviewedSourceSha?: string;
}

export interface ReviewChangesRequested {
  readonly kind: 'ReviewChangesRequested';
  readonly taskId: number;
  readonly workItemId: string;
  readonly attemptId: string;
}

export interface ImplementationItemCreated {
  readonly kind: 'ImplementationItemCreated';
  readonly taskId: number;
  readonly workItemId: string;
}

export interface HumanInputRequested {
  readonly kind: 'HumanInputRequested';
  readonly taskId: number;
  readonly requestId: HumanRequestId;
  readonly resumePhase: 'implementation' | 'review' | 'integration';
  readonly question: string;
}

export interface HumanInputProvided {
  readonly kind: 'HumanInputProvided';
  readonly taskId: number;
  readonly requestId: HumanRequestId;
}

export interface IntegrationRequested {
  readonly kind: 'IntegrationRequested';
  readonly taskId: number;
  readonly integrationId: IntegrationId;
}

export interface IntegrationStarted {
  readonly kind: 'IntegrationStarted';
  readonly taskId: number;
  readonly integrationId: IntegrationId;
  readonly executorExecutionId: ExecutionId;
}

export interface IntegrationObservedMerged {
  readonly kind: 'IntegrationObservedMerged';
  readonly taskId: number;
  readonly integrationId: IntegrationId;
  readonly mergeCommitSha: string;
}

export interface IntegrationObservedConflict {
  readonly kind: 'IntegrationObservedConflict';
  readonly taskId: number;
  readonly integrationId: IntegrationId;
  readonly conflictManifest: string;
}

export interface ExecutionStopRequested {
  readonly kind: 'ExecutionStopRequested';
  readonly taskId: number;
  readonly executionId: ExecutionId;
}

export interface ExecutionExited {
  readonly kind: 'ExecutionExited';
  readonly taskId: number;
  readonly executionId: ExecutionId;
  readonly exitCode: number | null;
}

export interface ExecutionLost {
  readonly kind: 'ExecutionLost';
  readonly taskId: number;
  readonly executionId: ExecutionId;
}

export interface TaskReleased {
  readonly kind: 'TaskReleased';
  readonly taskId: number;
  readonly resumePhase: 'implementation' | 'review' | 'integration';
}

export interface DependencyBlocked {
  readonly kind: 'DependencyBlocked';
  readonly taskId: number;
}

export interface DependencyUnblocked {
  readonly kind: 'DependencyUnblocked';
  readonly taskId: number;
}

export interface AdminOverrideApplied {
  readonly kind: 'AdminOverrideApplied';
  readonly taskId: number;
  readonly target: 'queued_implementation' | 'completed' | 'blocked';
  readonly reason: string;
}

/**
 * Closed union. Adding an event requires: (a) appending to this union,
 * (b) handling it in `evolve`, (c) a vocabulary entry.
 */
export type DomainEvent =
  | WorkItemCreated
  | WorkAttemptReserved
  | WorkAttemptStarted
  | WorkAttemptSucceeded
  | WorkAttemptLost
  | ExecutionReserved
  | ExecutionStarted
  | ImplementationCompleted
  | ReviewItemCreated
  | ReviewApproved
  | ReviewChangesRequested
  | ImplementationItemCreated
  | HumanInputRequested
  | HumanInputProvided
  | IntegrationRequested
  | IntegrationStarted
  | IntegrationObservedMerged
  | IntegrationObservedConflict
  | ExecutionStopRequested
  | ExecutionExited
  | ExecutionLost
  | TaskReleased
  | DependencyBlocked
  | DependencyUnblocked
  | AdminOverrideApplied;
