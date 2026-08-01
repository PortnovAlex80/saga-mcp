import type { ProcessModuleReference } from './process-module.js';

export interface LifecycleIdentity {
  name: string;
  version: string;
  displayName: string;
  description: string;
}

export type TransitionTarget =
  | { type: 'stage'; stageId: string }
  | { type: 'terminal'; status: string };

/**
 * Lifecycle mappings intentionally support only a small deterministic subset:
 * JSON-path reads from the durable lifecycle frame, immutable runtime fields,
 * and literals declared in the Lifecycle Definition. There is no executable
 * expression language and therefore no place for an LM to invent hand-off
 * identifiers.
 */
export type LifecycleMappingExpression =
  | string
  | { readonly literal: unknown }
  | {
      readonly runtime:
        | 'projectId'
        | 'epicId'
        | 'lifecycleRunId'
        | 'stageId'
        | 'initiatedBy';
    };

export interface StageBinding {
  id: string;
  displayName: string;
  moduleRef: ProcessModuleReference;
  inputMapping: Readonly<Record<string, LifecycleMappingExpression>>;
  outputMapping?: Readonly<Record<string, LifecycleMappingExpression>>;
  outcomeRoutes: Readonly<Record<string, TransitionTarget>>;
  /**
   * Human-readable contract notes in v1. Executable admission/exit decisions
   * must be represented by mapped immutable inputs and module outcomes until a
   * typed lifecycle-guard registry is introduced.
   */
  entryConditions: readonly string[];
  exitConditions: readonly string[];
}

export interface LifecycleDefinition {
  identity: LifecycleIdentity;
  entryStageId: string;
  stages: readonly StageBinding[];
  /**
   * F3: maximum number of stage transitions a single lifecycle run may make
   * before the orchestrator declares the run failed. Guards against a cycle in
   * the declarative routing table (or a self-looping recovery policy) spinning
   * forever. Defaults to {@link DEFAULT_MAX_TRANSITIONS} when omitted. The
   * orchestrator counts one transition per loop iteration of its run.
   */
  maxTransitions?: number;
}

/**
 * Default transition budget for a lifecycle run when the definition omits
 * {@link LifecycleDefinition.maxTransitions}. Chosen generously above the
 * realistic longest DAG (product-delivery has 4 stages) so legitimate lifecycles
 * never hit it, while an accidental cycle is bounded.
 */
export const DEFAULT_MAX_TRANSITIONS = 100;

export interface LifecycleRouteResult {
  stageId: string;
  outcome: string;
  target: TransitionTarget;
}
