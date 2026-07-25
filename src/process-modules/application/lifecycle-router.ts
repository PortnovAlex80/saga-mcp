import type {
  LifecycleDefinition,
  LifecycleRouteResult,
  StageBinding,
  TransitionTarget,
} from '../domain/lifecycle.js';
import type { ProcessModuleRegistry } from './process-module-registry.js';

export interface LifecycleValidationResult {
  valid: boolean;
  errors: string[];
}

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
  }

  return { valid: errors.length === 0, errors };
}
