/**
 * Managed task state — discriminated union (typestate).
 *
 * Source: blueprint §6.2 (docs/architecture/passive-worker-kernel-blueprint.md:250-285).
 *
 * The persisted enum columns (`tasks.status`, `tasks.integration_state`,
 * `tasks.current_execution_id`, `tasks.assigned_to`) carry many impossible
 * combinations. This union represents ONLY the valid composite states.
 * `decodeManagedState` (decode.ts) is the single path from flat rows to one
 * of these variants or an `InvariantViolation`.
 *
 * Invariants (blueprint §6.2:217-223):
 *   - A task is never owned by an OS process; a work item is.
 *   - `done` is derived only when all required work items are terminal-successful.
 *   - Losing an integration attempt requeues the integration item; it never
 *     erases an approved review item.
 *
 * Pure TS. No imports from SQLite, Node, tools, or tracker-view.
 */

import type { ExecutionId, IntegrationId, HumanRequestId } from './ids.js';

/**
 * Phases a task can be queued/active in. Matches the fixed workflow templates
 * (blueprint §6.1:227-231):
 *   tracker_only/read_only_evidence: implementation -> review -> complete
 *   git_change:                     implementation -> review -> integration -> complete
 *   verification.ac:                verification -> adjudication -> optional integration
 */
export type WorkPhase = 'implementation' | 'review' | 'verification' | 'integration';

/**
 * The compatibility typestate. Each variant is a valid composite; impossible
 * combinations are not representable. Field names mirror blueprint §6.2 verbatim.
 */
export type ManagedTaskState =
  | {
      readonly kind: 'queued';
      readonly phase: 'implementation' | 'review';
    }
  | {
      readonly kind: 'active';
      readonly phase: 'implementation' | 'review';
      readonly workerId: string;
      readonly executionId: ExecutionId;
    }
  | {
      readonly kind: 'finishing';
      readonly completedPhase: 'implementation' | 'review';
      readonly executionId: ExecutionId;
    }
  | {
      readonly kind: 'waiting_human';
      readonly resumePhase: 'implementation' | 'review' | 'integration';
      readonly requestId: HumanRequestId;
    }
  | {
      readonly kind: 'awaiting_integration';
      readonly integrationId: IntegrationId;
    }
  | {
      readonly kind: 'integrating';
      readonly integrationId: IntegrationId;
      readonly executorExecutionId: ExecutionId;
    }
  | {
      readonly kind: 'integration_conflict';
      readonly integrationId: IntegrationId;
    }
  | { readonly kind: 'blocked_dependencies' }
  | { readonly kind: 'completed' };

/**
 * Stable invariant violation codes. Source: blueprint §6.2:292-303.
 *
 * These names are FROZEN. `decodeManagedState` returns one of them when a row
 * does not decode to a valid `ManagedTaskState`. Slice 1+ must not rename them
 * without an ADR update — they are observable via the invariant scanner and
 * test fixtures.
 */
export type InvariantCode =
  | 'ACTIVE_WITHOUT_OWNER'
  | 'ACTIVE_WITHOUT_EXECUTION'
  | 'BUFFER_WITH_OWNER'
  | 'TASK_FENCE_WITHOUT_ACTIVE_EXECUTION'
  | 'EXECUTION_DOES_NOT_OWN_TASK'
  | 'TERMINAL_EXECUTION_OWNS_TASK'
  | 'DONE_PENDING_WITHOUT_INTEGRATION_INTENT'
  | 'WAITING_HUMAN_WITH_ACTIVE_EXECUTION'
  | 'COMPLETED_WITH_UNFINISHED_INTEGRATION'
  | 'MULTIPLE_ACTIVE_INTEGRATIONS_FOR_REPOSITORY';

/**
 * A decoding failure. `code` is a frozen `InvariantCode`; `detail` carries
 * the offending row identity for diagnostics. `decodeManagedState` returns
 * this rather than silently normalizing invalid managed rows (blueprint
 * §6.2:288-290).
 */
export interface InvariantViolation {
  readonly kind: 'violation';
  readonly code: InvariantCode;
  readonly taskId: number;
  readonly detail: string;
}

/**
 * Result of decoding a flat row into either a valid state or a violation.
 * Callers must handle both branches; the decoder never throws for bad data.
 */
export type DecodedState =
  | { readonly kind: 'valid'; readonly state: ManagedTaskState }
  | InvariantViolation;

/**
 * Exhaustive helper for switch-statements over `ManagedTaskState.kind`.
 * Using this in every switch enforces compile-time exhaustiveness (blueprint
 * §18:1122 — "all unions use exhaustive assertNever").
 */
export function assertNever(value: never): never {
  throw new Error(`assertNever: unhandled discriminant ${JSON.stringify(value)}`);
}
