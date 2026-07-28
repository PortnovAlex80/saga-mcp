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
   * Optional per-lifecycle route resolver. When present, the orchestrator asks
   * it for the transition target instead of doing a static `outcomeRoutes`
   * lookup. This lets a single lifecycle definition vary its routing based on
   * per-run input (e.g. a gate flag the operator sets) without producing a new
   * definition hash per flag value.
   *
   * The resolver MUST fall back to `stage.outcomeRoutes[outcome]` for any case
   * it does not explicitly override — it augments the static table, it does not
   * replace it. Returning `undefined` is treated the same as a missing static
   * route and throws.
   *
   * Note: this field is a function and serializes to `undefined` under
   * canonicalJson, so it contributes a stable, run-time-independent key to the
   * definition hash (present vs absent) without leaking closure state.
   */
  routeResolver?: RouteResolver;
}

/**
 * Resolves the transition target for a stage outcome, with access to the
 * per-run root input. Augments — does not replace — the static `outcomeRoutes`
 * table; a resolver returns `undefined` to defer to the static lookup.
 */
export type RouteResolver = (params: {
  stage: StageBinding;
  outcome: string;
  rootInput: unknown;
}) => TransitionTarget | undefined;

export interface LifecycleRouteResult {
  stageId: string;
  outcome: string;
  target: TransitionTarget;
}
