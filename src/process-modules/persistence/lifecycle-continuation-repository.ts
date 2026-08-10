import type { LifecycleDefinition } from '../domain/lifecycle.js';
import type { LifecycleMappingExpression } from '../domain/lifecycle.js';
import type { ProcessModuleReference } from '../domain/process-module.js';
import type { InheritedLifecycleStageFrame } from '../domain/lifecycle-continuation.js';

export interface AuthorizeLifecycleContinuationCommand {
  readonly orderRef: string;
  readonly parentLifecycleRunId: number;
  readonly resumeStageId: string;
  readonly expectedParentError: string;
  readonly actorId: string;
  readonly reason: string;
  readonly externalBaselineSnapshot?: Readonly<Record<string, unknown>>;
  /** Explicit, hash-pinned compatibility upgrade for a suffix stage. */
  readonly stageOverrides?: readonly {
    readonly stageId: string;
    readonly moduleRef: ProcessModuleReference;
    readonly additiveInputMapping?: Readonly<Record<string, LifecycleMappingExpression>>;
  }[];
}

export interface LifecycleContinuationAuthorization {
  readonly authorizationRef: string;
  readonly orderRef: string;
  readonly parentLifecycleRunId: number;
  readonly childLifecycleRunId: number | null;
  readonly resumeStageId: string;
  readonly prefixHash: string;
  readonly childDefinition: LifecycleDefinition;
  readonly childDefinitionHash: string;
  readonly childIdempotencyKey: string;
  readonly state: 'authorized' | 'consumed';
  readonly replayed: boolean;
}

export interface ConsumeLifecycleContinuationResult
  extends LifecycleContinuationAuthorization {
  readonly childLifecycleRunId: number;
}

export interface LifecycleContinuationRepository {
  authorize(
    command: AuthorizeLifecycleContinuationCommand,
  ): LifecycleContinuationAuthorization;
  consume(authorizationRef: string): ConsumeLifecycleContinuationResult;
  readInheritedStageFrame(
    childLifecycleRunId: number,
  ): Readonly<Record<string, unknown>>;
  listInheritedStages(
    childLifecycleRunId: number,
  ): readonly InheritedLifecycleStageFrame[];
}
