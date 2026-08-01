import type {
  LifecycleDefinition,
  LifecycleMappingExpression,
  LifecycleRouteResult,
  StageBinding,
  TransitionTarget,
} from '../domain/lifecycle.js';
import type { ProcessModuleRegistry } from './process-module-registry.js';

export interface LifecycleValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Resolve the transition target for a stage outcome from the declarative static
 * `outcomeRoutes` table. Routing is purely declarative (plan §13.8 / §6.4): the
 * table is the single source of truth and there is no per-run override. The
 * deleted `routeResolver` function field (Wave 13) let a single lifecycle
 * definition vary routing on per-run input; that is now expressed by distinct
 * declarative Lifecycle Scenario Packages instead.
 */
export function routeProcessOutcome(
  stage: StageBinding,
  outcome: string,
): LifecycleRouteResult {
  const target = stage.outcomeRoutes[outcome];
  if (!target) {
    throw new Error(`stage '${stage.id}' has no route for process outcome '${outcome}'`);
  }
  return { stageId: stage.id, outcome, target };
}

/**
 * F1: builds the directed stage→stage graph from the declarative outcomeRoutes
 * (where target.type === 'stage') and returns the set of stages reachable from
 * the entry stage via breadth-first traversal. A stage that no route ever
 * reaches is dead configuration — it can never run, so its existence almost
 * always indicates a broken or stale routing table.
 */
function reachableStageIds(lifecycle: LifecycleDefinition): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const stage of lifecycle.stages) {
    adjacency.set(stage.id, []);
    for (const target of Object.values(stage.outcomeRoutes)) {
      if (target.type === 'stage') {
        adjacency.get(stage.id)!.push(target.stageId);
      }
    }
  }
  const reached = new Set<string>();
  const pending = [lifecycle.entryStageId];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || reached.has(current)) continue;
    reached.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!reached.has(next)) pending.push(next);
    }
  }
  return reached;
}

/**
 * F2: validates that every `$.stages.<id>.<path>` reference in a stage's
 * inputMapping points at a stage that actually exists in the lifecycle. A
 * reference into a non-existent stage's output is always a typo or a stale
 * mapping; it would otherwise fail at runtime with an opaque
 * LIFECYCLE_MAPPING_SOURCE_MISSING error deep inside the first transition.
 */
function validateInputMappingReferences(
  stage: StageBinding,
  stageIds: ReadonlySet<string>,
  errors: string[],
): void {
  const STAGE_REF_PREFIX = '$.stages.';
  for (const expression of Object.values(stage.inputMapping)) {
    const path = stageReferencePath(expression);
    if (path === undefined || !path.startsWith(STAGE_REF_PREFIX)) continue;
    const referencedId = path.slice(STAGE_REF_PREFIX.length).split('.')[0];
    if (!stageIds.has(referencedId)) {
      errors.push(`inputMapping references unknown stage '${referencedId}'`);
    }
  }
}

function stageReferencePath(expression: LifecycleMappingExpression): string | undefined {
  // A literal reference uses the object form { literal: ... } and never reads
  // the frame; a runtime reference is { runtime: 'projectId' } etc. and never
  // touches stages. Only a plain string is a JSON-path read into the frame.
  if (typeof expression === 'string') return expression;
  return undefined;
}

function validateTarget(
  stage: StageBinding,
  outcome: string,
  target: TransitionTarget,
  stageIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (target.type === 'stage' && !stageIds.has(target.stageId)) {
    errors.push(
      `stage '${stage.id}' outcome '${outcome}' targets missing stage '${target.stageId}'`,
    );
  }
  if (target.type === 'terminal' && !target.status.trim()) {
    errors.push(`stage '${stage.id}' outcome '${outcome}' has an empty terminal status`);
  }
}

export function validateLifecycleDefinition(
  lifecycle: LifecycleDefinition,
  registry: ProcessModuleRegistry,
): LifecycleValidationResult {
  const errors: string[] = [];
  const stageIds = lifecycle.stages.map(stage => stage.id);
  const uniqueStageIds = new Set(stageIds);

  if (uniqueStageIds.size !== stageIds.length) errors.push('lifecycle contains duplicate stage ids');
  if (!uniqueStageIds.has(lifecycle.entryStageId)) {
    errors.push(`entry stage '${lifecycle.entryStageId}' does not exist`);
  }

  for (const stage of lifecycle.stages) {
    const module = registry.get(stage.moduleRef);
    if (!module) {
      errors.push(`stage '${stage.id}' references an unregistered process module`);
      continue;
    }

    const declaredOutcomes = new Set(module.outcomes.map(outcome => outcome.code));
    for (const outcome of declaredOutcomes) {
      if (!(outcome in stage.outcomeRoutes)) {
        errors.push(`stage '${stage.id}' has no route for module outcome '${outcome}'`);
      }
    }
    for (const [outcome, target] of Object.entries(stage.outcomeRoutes)) {
      if (!declaredOutcomes.has(outcome)) {
        errors.push(`stage '${stage.id}' routes undeclared module outcome '${outcome}'`);
      }
      validateTarget(stage, outcome, target, uniqueStageIds, errors);
    }
    // F2: a cross-stage inputMapping path must reference a stage that exists.
    validateInputMappingReferences(stage, uniqueStageIds, errors);
  }

  // F1: every stage (except the entry) must be reachable from entry via the
  // declarative outcomeRoutes graph. Only run the reachability check once the
  // entry stage itself is known to exist, otherwise it reports noise.
  if (uniqueStageIds.has(lifecycle.entryStageId)) {
    const reachable = reachableStageIds(lifecycle);
    for (const stage of lifecycle.stages) {
      if (stage.id === lifecycle.entryStageId) continue;
      if (!reachable.has(stage.id)) {
        errors.push(`stage '${stage.id}' is unreachable from entry stage`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
