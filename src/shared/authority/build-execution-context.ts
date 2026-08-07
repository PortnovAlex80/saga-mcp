/**
 * buildExecutionContext — freezes the immutable per-execution snapshot at claim
 * time (D1.1). This is the SINGLE place the model route is read for a Saga 3
 * managed execution; spawn-side and proposal-provenance-side both consume the
 * frozen value from `worker_executions.metadata.execution_context`, eliminating
 * the D1 claim↔spawn model-route race.
 *
 * Authority is frozen from the WorkIntent bound to the task
 * (`task.metadata.work_intent_id`). A WorkIntent mutated AFTER claim does not
 * change this snapshot — the gateway reads the frozen `execution_context`, not
 * the live WorkIntent row, so the worker cannot expand its own authority
 * mid-run.
 *
 * Pure function: takes the WorkIntent (or null) and the model route as inputs;
 * the caller (dispatcher) is responsible for reading them. No `getDb` here.
 */
import {
  authorityHash,
  EXECUTION_CONTEXT_POLICY_VERSION,
  type ExecutionContextExecutorKind,
  type ExecutionContextSnapshot,
  type ExecutionModelRoute,
  type ExecutionRoutePolicyRef,
} from './execution-context.js';
import type { WorkIntent } from '../work-intent.js';

export interface BuildExecutionContextInput {
  /** Model route read ONCE by the caller (dispatcher) inside its claim transaction. */
  modelRoute: ExecutionModelRoute;
  /**
   * v2: executor kind (orthogonal to model). Selects which binary spawn runs.
   * Defaults to `claude-cli` when omitted (legacy callers).
   */
  executorKind?: ExecutionContextExecutorKind;
  /**
   * v2: routing policy citation (ref + digest). Frozen so the journal can
   * explain the routing decision. Null/omitted only on legacy v1 snapshots.
   */
  routePolicy?: ExecutionRoutePolicyRef | null;
  /**
   * `work_intent_id`. Null authority → gateway compatibility-allow.
   */
  workIntent: WorkIntent | null;
  /** ISO timestamp captured at claim (caller-supplied so tests are deterministic). */
  capturedAt: string;
}

/**
 * Build the immutable snapshot. For a Saga 3 task (workIntent != null) the
 * authority is frozen with an `authority_hash` over the granted tool surface.
 * gateway treats the execution as compatibility-allow.
 */
export function buildExecutionContext(input: BuildExecutionContextInput): ExecutionContextSnapshot {
  const {
    modelRoute,
    executorKind = 'claude-cli',
    routePolicy = null,
    workIntent,
    capturedAt,
  } = input;

  const authority = workIntent
    ? {
        enforcement: workIntent.authority_scope.enforcement,
        allowed_saga_tools: [...workIntent.authority_scope.allowed_tools],
        scope: workIntent.authority_scope.scope,
        snapshot_ref: workIntent.authority_scope.snapshot_ref,
        work_intent_id: workIntent.id,
        authority_hash: authorityHash({
          enforcement: workIntent.authority_scope.enforcement,
          allowed_saga_tools: workIntent.authority_scope.allowed_tools,
          scope: workIntent.authority_scope.scope,
          snapshot_ref: workIntent.authority_scope.snapshot_ref,
          work_intent_id: workIntent.id,
        }),
      }
    : null;

  return {
    policy_version: EXECUTION_CONTEXT_POLICY_VERSION,
    work_intent_id: workIntent?.id ?? null,
    authority,
    model_route: { ...modelRoute },
    executor_kind: executorKind,
    route_policy: routePolicy,
    captured_at: capturedAt,
  };
}
