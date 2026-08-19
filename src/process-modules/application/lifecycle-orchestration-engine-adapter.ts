import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../../application/ports/orchestration-engine.js';
import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { lifecycleRefKey } from '../persistence/lifecycle-run.js';
import { journalEvent } from '../../observability/run-journal.js';
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
  /** Resolve a run-pinned suffix definition for append-only continuations. */
  resolveDefinition?: (
    command: RunEpisodeCommand,
    input: LifecycleEpisodeInput,
  ) => Promise<LifecycleDefinition> | LifecycleDefinition;
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
    const definition = this.options.resolveDefinition
      ? await this.options.resolveDefinition(command, input)
      : this.options.definition;
    const result = await this.options.orchestrator.run(
      definition,
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
    // STAGE-11 TASK 5 — the terminal boundary: a reader must be able to tell
    // "the run ended" from "the journal stopped". Emitted only for terminal
    // results (paused resume cycles re-run this adapter; the guard keeps it
    // exactly-once). After the orchestrator's commits — never inside a
    // transaction a rollback could falsify. Observation only.
    if (result.status !== 'paused' && result.status !== 'running') {
      journalEvent('run.terminal', {
        run_id: String(result.lifecycleRun.id),
        epic_id: command.epicId,
      }, {
        outcome: reason,
        status: result.status,
        final_stage: result.lifecycleRun.currentStageId
          ?? lastStage?.stageId
          ?? definition.entryStageId,
        error: result.lifecycleRun.error ?? null,
        cycles: result.stageRuns.length,
      });
    }
    return {
      projectId: command.projectId,
      epicId: command.epicId,
      finalStage:
        result.lifecycleRun.currentStageId
        ?? lastStage?.stageId
        ?? definition.entryStageId,
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
      pipelineScope: lifecycleRefKey(definition.identity),
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
