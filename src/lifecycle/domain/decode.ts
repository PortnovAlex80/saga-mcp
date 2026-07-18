/**
 * decodeManagedState — single path from flat rows to ManagedTaskState.
 *
 * Source: blueprint §6.2 (docs/architecture/passive-worker-kernel-blueprint.md:288-308)
 *         and §16 Slice 2 backfill map (line 851-859).
 *
 * Contract (blueprint §6.2:288-290):
 *   `decodeManagedState(task, execution, integration, humanRequest)` returns
 *   either a valid state or a stable `InvariantViolation`. It must NOT silently
 *   normalize invalid managed rows.
 *
 * Critical guardrail (blueprint §6.2:307-308):
 *   "Do not make the managed decoder fail open when `current_execution_id` is null."
 * I.e. a managed task with `current_execution_id=null` while `status='in_progress'`
 * is a violation (`ACTIVE_WITHOUT_EXECUTION`), not a fallback to legacy.
 *
 * The decoder is PURE: no DB, no clock, no I/O. It receives plain data objects.
 *
 * Pure TS. No imports from SQLite, Node, tools, or tracker-view.
 */

import { asExecutionId, asIntegrationId } from './ids.js';
import type {
  DecodedState,
  InvariantCode,
  InvariantViolation,
} from './state.js';

// ---------------------------------------------------------------------------
// Input rows — plain data, no DB coupling.
// ---------------------------------------------------------------------------

/** Active execution states per worker-executions.ts:6 (ACTIVE_EXECUTION_STATES). */
const ACTIVE_EXECUTION_STATES = new Set(['reserved', 'running', 'cancel_requested']);

/** Terminal execution states — fence MUST be cleared. */
const TERMINAL_EXECUTION_STATES = new Set(['exited', 'terminated', 'lost', 'spawn_failed']);

/** Tag that marks a task parked for human input. */
const NEEDS_HUMAN_TAG = 'needs-human';

export interface TaskRow {
  readonly id: number;
  readonly status: string;
  readonly assigned_to: string | null;
  readonly current_execution_id: string | null;
  readonly integration_state: string | null;
  /** JSON-decoded tags array. */
  readonly tags: readonly string[];
  /** e.g. 'development.code', 'verification.ac', 'review.code'. */
  readonly task_kind: string | null;
  /** 'git_change' | 'tracker_only' | 'read_only_evidence' | 'interactive'. */
  readonly execution_mode: string | null;
}

export interface ExecutionRow {
  readonly execution_id: string;
  readonly task_id: number;
  readonly state: string;
  readonly phase: string | null;
  readonly worker_id: string;
}

export interface IntegrationRow {
  readonly integration_id: string;
  readonly task_id: number;
  /** 'ready' | 'active' | 'merged' | 'conflict' | 'abandoned'. */
  readonly state: string;
  readonly executor_execution_id: string | null;
}

export interface HumanRequestRow {
  readonly request_id: string;
  readonly task_id: number;
  readonly resume_phase: 'implementation' | 'review' | 'integration';
  /** 'open' | 'answered' | 'cancelled'. */
  readonly state: string;
}

export interface TaskSnapshot {
  readonly task: TaskRow;
  readonly execution: ExecutionRow | null;
  readonly integration: IntegrationRow | null;
  readonly humanRequest: HumanRequestRow | null;
}

// ---------------------------------------------------------------------------
// Violation constructor — keeps the violation shape consistent.
// ---------------------------------------------------------------------------

function violation(
  taskId: number,
  code: InvariantCode,
  detail: string,
): InvariantViolation {
  return { kind: 'violation', code, taskId, detail };
}

// ---------------------------------------------------------------------------
// Decoder.
// ---------------------------------------------------------------------------

/**
 * Decode a task snapshot into a valid `ManagedTaskState` or an `InvariantViolation`.
 *
 * Strategy: check the high-priority invariant violations first (fence/owner
 * mismatches that make the row structurally invalid regardless of status),
 * then map the (status, integration_state, fence) tuple to a state variant.
 *
 * The decoder never throws on bad data — it reports a violation. Internal
 * precondition failures (e.g. unknown status string) are also violations,
 * not exceptions.
 */
export function decodeManagedState(snapshot: TaskSnapshot): DecodedState {
  const { task, execution, integration } = snapshot;
  // humanRequest is reserved for Slice 2 shadow-model decoding (blueprint
  // §6.2:288 — `decodeManagedState(task, execution, integration, humanRequest)`).
  // For Slice 0 the waiting_human variant is detected from the task's needs-human
  // tag; the structured human_requests table is wired in Slice 3.

  // -------------------------------------------------------------------------
  // 1. WAITING_HUMAN_WITH_ACTIVE_EXECUTION
  //    Blueprint §12.3: ParkForHuman clears ownership/fence. A row with the
  //    needs-human tag AND an active execution fence is the dead-assignment
  //    trap the audit identified — the worker called ParkForHuman but died
  //    before clearing current_execution_id, or the tag was set manually.
  // -------------------------------------------------------------------------
  if (task.tags.includes(NEEDS_HUMAN_TAG) && task.current_execution_id !== null) {
    if (execution && ACTIVE_EXECUTION_STATES.has(execution.state)) {
      return violation(
        task.id,
        'WAITING_HUMAN_WITH_ACTIVE_EXECUTION',
        `task ${task.id} has needs-human tag but execution ${task.current_execution_id} is still active`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. TASK_FENCE_WITHOUT_ACTIVE_EXECUTION
  //    current_execution_id is set on the task, but no matching active
  //    worker_executions row exists. The task is fenced by a ghost.
  // -------------------------------------------------------------------------
  if (task.current_execution_id !== null) {
    if (!execution) {
      return violation(
        task.id,
        'TASK_FENCE_WITHOUT_ACTIVE_EXECUTION',
        `task ${task.id} fenced by execution ${task.current_execution_id} but no worker_executions row exists`,
      );
    }
    if (TERMINAL_EXECUTION_STATES.has(execution.state)) {
      // TERMINAL_EXECUTION_OWNS_TASK — fence not cleared after terminalization.
      return violation(
        task.id,
        'TERMINAL_EXECUTION_OWNS_TASK',
        `task ${task.id} still fenced by execution ${execution.execution_id} in terminal state ${execution.state}`,
      );
    }
    if (!ACTIVE_EXECUTION_STATES.has(execution.state)) {
      return violation(
        task.id,
        'TASK_FENCE_WITHOUT_ACTIVE_EXECUTION',
        `task ${task.id} fenced by execution ${execution.execution_id} in non-active state ${execution.state}`,
      );
    }
    if (execution.execution_id !== task.current_execution_id) {
      return violation(
        task.id,
        'EXECUTION_DOES_NOT_OWN_TASK',
        `task ${task.id} fenced by ${task.current_execution_id} but execution row is ${execution.execution_id}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. ACTIVE_WITHOUT_OWNER / ACTIVE_WITHOUT_EXECUTION
  //    A task in an active status MUST have both an owner and a fence.
  //    Blueprint §6.2:307-308 — do NOT fail open when current_execution_id is null.
  // -------------------------------------------------------------------------
  const isActiveStatus =
    task.status === 'in_progress' || task.status === 'review_in_progress';
  if (isActiveStatus) {
    if (task.assigned_to === null || task.assigned_to === '') {
      return violation(
        task.id,
        'ACTIVE_WITHOUT_OWNER',
        `task ${task.id} status=${task.status} but assigned_to is null`,
      );
    }
    if (task.current_execution_id === null) {
      return violation(
        task.id,
        'ACTIVE_WITHOUT_EXECUTION',
        `task ${task.id} status=${task.status} but current_execution_id is null`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. BUFFER_WITH_OWNER
  //    Buffer statuses (todo/review/done/blocked) must NOT carry an owner.
  //    Ownership lives on the execution, not on a queued task.
  // -------------------------------------------------------------------------
  const isBufferStatus =
    task.status === 'todo' ||
    task.status === 'review' ||
    task.status === 'done' ||
    task.status === 'blocked';
  if (
    isBufferStatus &&
    task.assigned_to !== null &&
    task.assigned_to !== ''
  ) {
    return violation(
      task.id,
      'BUFFER_WITH_OWNER',
      `task ${task.id} buffer status=${task.status} but assigned_to=${task.assigned_to}`,
    );
  }

  // -------------------------------------------------------------------------
  // 5. Map (status, integration_state, fence) -> ManagedTaskState.
  //    All structural checks above passed; now pick the variant.
  // -------------------------------------------------------------------------

  switch (task.status) {
    case 'todo':
      return { kind: 'valid', state: { kind: 'queued', phase: 'implementation' } };

    case 'in_progress':
      // Active implementation. Fence + owner guaranteed by check #3.
      return {
        kind: 'valid',
        state: {
          kind: 'active',
          phase: 'implementation',
          workerId: task.assigned_to!,
          executionId: asExecutionId(task.current_execution_id!),
        },
      };

    case 'review':
      return { kind: 'valid', state: { kind: 'queued', phase: 'review' } };

    case 'review_in_progress':
      return {
        kind: 'valid',
        state: {
          kind: 'active',
          phase: 'review',
          workerId: task.assigned_to!,
          executionId: asExecutionId(task.current_execution_id!),
        },
      };

    case 'blocked':
      return { kind: 'valid', state: { kind: 'blocked_dependencies' } };

    case 'done': {
      // DONE_PENDING_WITHOUT_INTEGRATION_INTENT
      // status=done AND integration_state='pending' but no integration row —
      // the post-approval seam the audit identified.
      if (task.integration_state === 'pending') {
        if (!integration) {
          return violation(
            task.id,
            'DONE_PENDING_WITHOUT_INTEGRATION_INTENT',
            `task ${task.id} done+pending but no integration row exists`,
          );
        }
        if (integration.state === 'active' && integration.executor_execution_id) {
          return {
            kind: 'valid',
            state: {
              kind: 'integrating',
              integrationId: asIntegrationId(integration.integration_id),
              executorExecutionId: asExecutionId(integration.executor_execution_id),
            },
          };
        }
        if (integration.state === 'conflict') {
          return {
            kind: 'valid',
            state: {
              kind: 'integration_conflict',
              integrationId: asIntegrationId(integration.integration_id),
            },
          };
        }
        // ready or other — awaiting integration.
        return {
          kind: 'valid',
          state: {
            kind: 'awaiting_integration',
            integrationId: asIntegrationId(integration.integration_id),
          },
        };
      }

      if (task.integration_state === 'conflict') {
        if (!integration) {
          return violation(
            task.id,
            'DONE_PENDING_WITHOUT_INTEGRATION_INTENT',
            `task ${task.id} done+conflict but no integration row exists`,
          );
        }
        return {
          kind: 'valid',
          state: {
            kind: 'integration_conflict',
            integrationId: asIntegrationId(integration.integration_id),
          },
        };
      }

      if (
        task.integration_state === 'merged' ||
        task.integration_state === 'not_required'
      ) {
        return { kind: 'valid', state: { kind: 'completed' } };
      }

      // done with no integration_state on a git_change task — unfinished.
      // For tracker_only/read_only_evidence, integration_state may legitimately
      // be null and the task is still terminal.
      if (
        task.execution_mode === 'git_change' &&
        (task.integration_state === null || task.integration_state === '')
      ) {
        return violation(
          task.id,
          'COMPLETED_WITH_UNFINISHED_INTEGRATION',
          `task ${task.id} git_change done but integration_state is null`,
        );
      }
      // Non-git done with null integration_state — terminal.
      return { kind: 'valid', state: { kind: 'completed' } };
    }

    default:
      return violation(
        task.id,
        'ACTIVE_WITHOUT_OWNER', // closest stable code for "structurally unknown"
        `task ${task.id} has unrecognized status ${JSON.stringify(task.status)}`,
      );
  }
}

// Re-export identity-branding helpers for callers that build snapshots.
export { asExecutionId, asIntegrationId };
