import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { canonicalJson } from '../../shared/canonical-json.js';

export type LifecycleDefinitionCompatibility =
  | { classification: 'exact'; reasons: readonly string[] }
  | { classification: 'metadata_only'; reasons: readonly string[] }
  | { classification: 'incompatible'; reasons: readonly string[] };

/**
 * Conservative replay classifier. Only human-readable labels/notes may change.
 * Routing, mappings, module refs, transition budget and identities remain
 * pinned. Handler/package/gate compatibility is checked independently by the
 * ProcessRun installation pins; this function never rewrites the old snapshot.
 */
export function classifyLifecycleDefinitionCompatibility(
  previousSnapshot: string,
  candidateSnapshot: string,
): LifecycleDefinitionCompatibility {
  if (previousSnapshot === candidateSnapshot) return { classification: 'exact', reasons: [] };
  let previous: LifecycleDefinition;
  let candidate: LifecycleDefinition;
  try {
    previous = JSON.parse(previousSnapshot) as LifecycleDefinition;
    candidate = JSON.parse(candidateSnapshot) as LifecycleDefinition;
  } catch {
    return { classification: 'incompatible', reasons: ['definition JSON is invalid'] };
  }
  let previousExecutable: unknown;
  let candidateExecutable: unknown;
  try {
    previousExecutable = executableProjection(previous);
    candidateExecutable = executableProjection(candidate);
  } catch {
    return {
      classification: 'incompatible',
      reasons: ['definition does not have the executable LifecycleDefinition shape'],
    };
  }
  if (canonicalJson(previousExecutable) !== canonicalJson(candidateExecutable)) {
    return {
      classification: 'incompatible',
      reasons: ['entry, routing, mappings, module refs, identity, or transition budget changed'],
    };
  }
  return {
    classification: 'metadata_only',
    reasons: ['only displayName, description, entryConditions, or exitConditions changed'],
  };
}

function executableProjection(definition: LifecycleDefinition): unknown {
  return {
    identity: { name: definition.identity.name, version: definition.identity.version },
    entryStageId: definition.entryStageId,
    maxTransitions: definition.maxTransitions ?? 100,
    stages: definition.stages.map(stage => ({
      id: stage.id,
      moduleRef: stage.moduleRef,
      inputMapping: stage.inputMapping,
      outputMapping: stage.outputMapping ?? null,
      outcomeRoutes: stage.outcomeRoutes,
    })),
  };
}
