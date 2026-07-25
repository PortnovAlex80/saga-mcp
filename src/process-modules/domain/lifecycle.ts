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

export interface StageBinding {
  id: string;
  displayName: string;
  moduleRef: ProcessModuleReference;
  inputMapping: Readonly<Record<string, string>>;
  outputMapping?: Readonly<Record<string, string>>;
  outcomeRoutes: Readonly<Record<string, TransitionTarget>>;
  entryConditions: readonly string[];
  exitConditions: readonly string[];
}

export interface LifecycleDefinition {
  identity: LifecycleIdentity;
  entryStageId: string;
  stages: readonly StageBinding[];
}

export interface LifecycleRouteResult {
  stageId: string;
  outcome: string;
  target: TransitionTarget;
}
