import type { LifecycleDefinition, StageBinding } from './lifecycle.js';

export const LIFECYCLE_CONTINUATION_SCHEMA =
  'factory.lifecycle-continuation-authorization.v1';

export interface InheritedLifecycleStageFrame {
  readonly stageId: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly snapshotHash: string;
}

/**
 * Derive a suffix lifecycle without changing any StageBinding semantics.
 * A continuation may only move within the suffix; a route back into the
 * inherited prefix would make the prefix non-contiguous and is rejected.
 */
export function sliceLifecycleForContinuation(
  parent: LifecycleDefinition,
  resumeStageId: string,
): LifecycleDefinition {
  const resumeIndex = parent.stages.findIndex(stage => stage.id === resumeStageId);
  if (resumeIndex < 0) {
    throw new Error(`CONTINUATION_RESUME_STAGE_UNKNOWN: ${resumeStageId}`);
  }
  const inheritedDescriptors = [
    ...(parent.inheritedStages ?? []).map(stage => ({
      id: stage.id,
      displayName: stage.displayName,
      moduleRef: { ...stage.moduleRef },
    })),
    ...parent.stages.slice(0, resumeIndex).map(stage => ({
      id: stage.id,
      displayName: stage.displayName,
      moduleRef: { ...stage.moduleRef },
    })),
  ];
  const inheritedIds = new Set(inheritedDescriptors.map(stage => stage.id));
  if (inheritedIds.size !== inheritedDescriptors.length) {
    throw new Error('CONTINUATION_INHERITED_STAGE_DUPLICATE');
  }
  const suffix = parent.stages.slice(resumeIndex).map(stage =>
    cloneAndValidateSuffixStage(stage, inheritedIds));
  const rootName = parent.identity.name.replace(/(?:-continuation)+$/u, '');
  const rootDisplayName = parent.identity.displayName.replace(
    /(?:\s+Continuation)+$/u,
    '',
  );
  return {
    identity: {
      name: `${rootName}-continuation`,
      version: '1.0.0',
      displayName: `${rootDisplayName} Continuation`,
      description:
        `Append-only continuation of ${rootName}@${parent.identity.version} `
        + `from stage '${resumeStageId}'.`,
    },
    entryStageId: resumeStageId,
    inheritedStages: inheritedDescriptors,
    stages: suffix,
    ...(parent.maxTransitions === undefined
      ? {}
      : { maxTransitions: parent.maxTransitions }),
  };
}

function cloneAndValidateSuffixStage(
  stage: StageBinding,
  inheritedIds: ReadonlySet<string>,
): StageBinding {
  for (const target of Object.values(stage.outcomeRoutes)) {
    if (target.type === 'stage' && inheritedIds.has(target.stageId)) {
      throw new Error(
        `CONTINUATION_ROUTE_REENTERS_PREFIX: ${stage.id} -> ${target.stageId}`,
      );
    }
  }
  return {
    ...stage,
    inputMapping: { ...stage.inputMapping },
    ...(stage.outputMapping ? { outputMapping: { ...stage.outputMapping } } : {}),
    outcomeRoutes: { ...stage.outcomeRoutes },
    entryConditions: [...stage.entryConditions],
    exitConditions: [...stage.exitConditions],
  };
}
