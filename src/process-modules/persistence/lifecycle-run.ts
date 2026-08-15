import type {
  LifecycleIdentity,
  TransitionTarget,
} from '../domain/lifecycle.js';
import type { ProcessModuleReference } from '../domain/process-module.js';
import type {
  ProcessModuleCertificateRef,
  ProcessModuleOutput,
} from './process-run.js';

export const LIFECYCLE_RUN_STATUSES = [
  'created',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type LifecycleRunStatus = typeof LIFECYCLE_RUN_STATUSES[number];

export const LIFECYCLE_STAGE_RUN_STATUSES = [
  'created',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type LifecycleStageRunStatus = typeof LIFECYCLE_STAGE_RUN_STATUSES[number];

export interface LifecycleInput {
  schema: string;
  payload: unknown;
  contentHash: string;
}

export interface StartLifecycleCommand {
  lifecycle: LifecycleIdentity;
  /** Canonical immutable LifecycleDefinition snapshot pinned for this run. */
  definitionSnapshot: string;
  definitionHash: string;
  entryStageId: string;
  input: LifecycleInput;
  invocationContext: {
    projectId: number;
    epicId: number | null;
    initiatedBy: string;
    idempotencyKey: string;
  };
}

export interface LifecycleRunRecord {
  id: number;
  lifecycle: LifecycleIdentity;
  lifecycleRefKey: string;
  definitionSnapshot: string;
  definitionHash: string;
  projectId: number;
  epicId: number | null;
  initiatedBy: string;
  idempotencyKey: string;
  inputSchema: string;
  inputSnapshot: string;
  inputHash: string;
  status: LifecycleRunStatus;
  entryStageId: string;
  currentStageId: string | null;
  currentStageRunId: number | null;
  terminalStatus: string | null;
  version: number;
  leaseFence: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LifecycleStageRunRecord {
  id: number;
  lifecycleRunId: number;
  ordinal: number;
  stageId: string;
  attempt: number;
  moduleRef: ProcessModuleReference;
  bindingSnapshot: string;
  bindingHash: string;
  inputSchema: string;
  inputSnapshot: string;
  inputHash: string;
  status: LifecycleStageRunStatus;
  processRunId: number | null;
  localOutcome: string | null;
  authority: string | null;
  output: ProcessModuleOutput | null;
  certificate: ProcessModuleCertificateRef | null;
  /**
   * Output mapped by the StageBinding. This is the only payload exposed to
   * downstream stage mappings; raw module internals never leak into lifecycle
   * composition.
   */
  mappedOutput: Record<string, unknown> | null;
  resultSnapshot: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LifecycleTransitionRecord {
  id: number;
  lifecycleRunId: number;
  fromStageRunId: number;
  transitionKey: string;
  outcome: string;
  target: TransitionTarget;
  toStageRunId: number | null;
  handoffSnapshot: Record<string, unknown>;
  handoffHash: string;
  decisionHash: string;
  createdAt: string;
}

export interface EnsureLifecycleStageRunCommand {
  lifecycleRunId: number;
  stageId: string;
  moduleRef: ProcessModuleReference;
  bindingSnapshot: string;
  bindingHash: string;
  inputSchema: string;
  inputPayload: unknown;
  inputHash: string;
}

export interface CompleteLifecycleStageCommand {
  lifecycleRunId: number;
  stageRunId: number;
  expectedStageId: string;
  transitionKey: string;
  outcome: string;
  authority: string | null;
  output: ProcessModuleOutput | null;
  certificate: ProcessModuleCertificateRef | null;
  resultSnapshot: Record<string, unknown>;
  mappedOutput: Record<string, unknown>;
  target: TransitionTarget;
  handoffSnapshot: Record<string, unknown>;
  handoffHash: string;
  decisionHash: string;
  /** Precomputed next stage. Repository inserts it in the same transaction. */
  nextStage: Omit<EnsureLifecycleStageRunCommand, 'lifecycleRunId'> | null;
}

export function lifecycleRefKey(identity: Pick<LifecycleIdentity, 'name' | 'version'>): string {
  return `${identity.name}@${identity.version}`;
}

export interface LifecycleExecutionLease {
  owner: string;
  fence: number;
}
