import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../../application/ports/orchestration-engine.js';
import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { lifecycleRefKey } from '../persistence/lifecycle-run.js';
import type { LifecycleOrchestrator } from './lifecycle-orchestrator.js';

export interface LifecycleEpisodeInput {
  schema: string;
  payload: unknown;
  initiatedBy: string;
  idempotencyKey: string;
  resumePaused?: boolean;
}

export interface LifecycleOrchestrationEngineAdapterOptions {
  definition: LifecycleDefinition;
  orchestrator: LifecycleOrchestrator;
  resolveInput: (
    command: RunEpisodeCommand,
  ) => Promise<LifecycleEpisodeInput> | LifecycleEpisodeInput;
}

/**
 * Application-facing bridge for a complete Lifecycle. It projects the durable
 * lifecycle result without pretending that one stage's local outcome means
 * the whole product has shipped.
 */
export class LifecycleOrchestrationEngineAdapter implements OrchestrationEngine {
  constructor(
    private readonly options: LifecycleOrchestrationEngineAdapterOptions,
  ) {}

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const input = await this.options.resolveInput(command);
    const result = await this.options.orchestrator.run(
      this.options.definition,
      {
        projectId: command.projectId,
        epicId: command.epicId,
        inputSchema: input.schema,
        inputPayload: input.payload,
        initiatedBy: input.initiatedBy,
        idempotencyKey: input.idempotencyKey,
        resumePaused: input.resumePaused,
      },
    );
    const lastStage = result.stageRuns[result.stageRuns.length - 1] ?? null;
    const reason: OrchestrationRunResult['reason'] =
      result.status === 'completed'
        ? 'completed'
        : result.status === 'paused'
          ? 'paused'
          : result.status === 'cancelled'
            ? 'stopped'
            : 'failed';
    return {
      projectId: command.projectId,
      epicId: command.epicId,
      finalStage:
        result.lifecycleRun.currentStageId
        ?? lastStage?.stageId
        ?? this.options.definition.entryStageId,
      endedAt:
        result.lifecycleRun.completedAt
        ?? result.lifecycleRun.updatedAt,
      reason,
      cycles: result.stageRuns.length,
      lastError: result.lifecycleRun.error,
      processOutcome: lastStage?.localOutcome
        ? {
            code: lastStage.localOutcome,
            authority: lastStage.authority,
            outputRef:
              lastStage.output?.artifactRef
              ?? lastStage.certificate?.certificateRef
              ?? null,
          }
        : undefined,
      pipelineScope: lifecycleRefKey(this.options.definition.identity),
      scopeCompleted: result.status === 'completed',
      outcome: result.terminalStatus ?? lastStage?.localOutcome ?? undefined,
      outcomeAuthority: lastStage?.authority ?? undefined,
      lifecycleRun: {
        id: result.lifecycleRun.id,
        ref: lifecycleRefKey(result.lifecycleRun.lifecycle),
        status: result.status,
        currentStageId: result.lifecycleRun.currentStageId,
        terminalStatus: result.terminalStatus,
      },
    };
  }
}
