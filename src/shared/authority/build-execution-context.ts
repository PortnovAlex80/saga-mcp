/**
 * buildExecutionContext — freezes the immutable per-execution snapshot at claim
 * time. Model route, replay selection and authority are read once and never
 * re-resolved after the execution fence exists.
 */
import {
  authorityHash,
  EXECUTION_CONTEXT_POLICY_VERSION,
  type ExecutionContextExecutorKind,
  type ExecutionContextSnapshot,
  type ExecutionModelRoute,
  type ExecutionReplayBinding,
  type ExecutionRoutePolicyRef,
} from './execution-context.js';
import type { WorkIntent } from '../work-intent.js';

export interface BuildExecutionContextInput {
  /** Model route read ONCE by the caller inside its claim transaction. */
  modelRoute: ExecutionModelRoute;
  /** Physical executor actually used by this execution. */
  executorKind?: ExecutionContextExecutorKind;
  /** Routing/replay policy citation. */
  routePolicy?: ExecutionRoutePolicyRef | null;
  /** Exact replay lookup frozen at claim. Null for non-Production-Cell work. */
  replay?: ExecutionReplayBinding | null;
  /** `work_intent_id`. */
  workIntent: WorkIntent | null;
  /** ISO timestamp captured at claim. */
  capturedAt: string;
}

export function buildExecutionContext(input: BuildExecutionContextInput): ExecutionContextSnapshot {
  const {
    modelRoute,
    executorKind = 'claude-cli',
    routePolicy = null,
    replay = null,
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
    replay,
    captured_at: capturedAt,
  };
}
