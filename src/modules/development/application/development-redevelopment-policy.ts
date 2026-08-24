import { DEVELOPMENT_PROCESS_MODULE_REF } from '../../../process-modules/modules/development/development-process-module.js';
import { DEVELOPMENT_CASE_SCHEMA } from '../domain/development-schemas.js';

export interface DevelopmentRedevelopmentParent {
  readonly status: string;
  readonly currentStageId: string | null;
  readonly terminalStatus: string | null;
}

export interface DevelopmentRedevelopmentLastStage {
  readonly stageId: string;
  readonly localOutcome: string | null;
}

/**
 * Development-owned continuation policy. The universal lifecycle/runtime sees
 * only declared stage/outcome data and never branches on this workshop name or
 * on the development-specific `development-blocked` settlement vocabulary.
 */
export const developmentRedevelopmentPolicy = {
  stageId: 'solution-development',
  moduleRef: DEVELOPMENT_PROCESS_MODULE_REF,
  capsuleSchema: DEVELOPMENT_CASE_SCHEMA,
  acceptsParent(
    parent: DevelopmentRedevelopmentParent,
    lastStage: DevelopmentRedevelopmentLastStage | undefined,
  ): boolean {
    const currentMatches = parent.currentStageId === this.stageId;
    const lastMatches = lastStage?.stageId === this.stageId;
    if (parent.status === 'failed') return currentMatches || lastMatches;
    if (parent.status !== 'completed' || !lastMatches) return false;
    if (parent.terminalStatus === 'failed') {
      return lastStage.localOutcome === 'failed';
    }
    return parent.terminalStatus === 'development-blocked'
      && lastStage.localOutcome === 'blocked';
  },
} as const;
