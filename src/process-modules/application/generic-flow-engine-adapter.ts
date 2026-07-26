/**
 * GenericFlowEngineAdapter — bridge между GenericFlowExecutor (ProcessModuleExecutor
 * SPI) и ProcessModuleRuntimeEngine (OrchestrationEngine-порт через
 * ProcessModuleExecutionAdapter).
 *
 * ProcessModuleRuntimeEngine исторически ожидает adapter с `run(module, command)`
 * + `projectOutcome`. GenericFlowExecutor — это `execute(module, context)`.
 * Этот bridge склеивает их:
 *
 *   run():
 *     1. start ProcessRun (idempotent по epic-derived key);
 *     2. построить ProcessModuleExecutionContext;
 *     3. вызвать GenericFlowExecutor.execute();
 *     4. спроецировать RunResult в OrchestrationRunResult.
 *
 *   projectOutcome():
 *     достаёт code/authority/outputRef из RunResult.
 *
 * Это чистая механика — ни одного знания о слове "discovery". Module content
 * (outcome codes, certificate schema) поставляется через descriptor.
 */

import { processModuleKey, type ProcessModuleDefinition, type ProcessModuleReference } from '../domain/process-module.js';
import type {
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../../application/ports/orchestration-engine.js';
import type { ProcessModuleExecutionContext, ProcessModuleRunResult } from './process-module-executor.js';
import type {
  ProcessModuleExecutionAdapter,
  ProcessOutcomeProjector,
} from './process-module-runtime-engine.js';
import type { ProcessRunRepository } from '../persistence/process-run-repository.js';
import { canonicalJson, sha256Hex } from '../../saga3/shared/discovery-canonical.js';

export interface GenericFlowEngineAdapterOptions {
  moduleRef: ProcessModuleReference;
  executor: { execute(module: ProcessModuleDefinition, context: ProcessModuleExecutionContext): Promise<ProcessModuleRunResult> };
  processRunRepo: ProcessRunRepository;
  /** Build the module input payload from the episode command. */
  resolveInputPayload: (command: RunEpisodeCommand) => unknown;
  /** Build the ProcessRun idempotency key from the episode command. */
  resolveIdempotencyKey: (command: RunEpisodeCommand) => string;
  /** Final stage label projected onto OrchestrationRunResult. Default: module.identity.kind. */
  finalStage?: string;
  /** Outcome projector (optional; default reads RunResult.outcome/authority/output). */
  projectOutcome?: ProcessOutcomeProjector;
  /** initiatedBy audit label. */
  initiatedBy?: string;
}

export class GenericFlowEngineAdapter implements ProcessModuleExecutionAdapter {
  readonly moduleRef: ProcessModuleReference;
  private readonly executor: GenericFlowEngineAdapterOptions['executor'];
  private readonly processRunRepo: ProcessRunRepository;
  private readonly resolveInputPayload: GenericFlowEngineAdapterOptions['resolveInputPayload'];
  private readonly resolveIdempotencyKey: GenericFlowEngineAdapterOptions['resolveIdempotencyKey'];
  private readonly finalStage: string;
  private readonly projector: ProcessOutcomeProjector;
  private readonly initiatedBy: string;

  constructor(options: GenericFlowEngineAdapterOptions) {
    this.moduleRef = options.moduleRef;
    this.executor = options.executor;
    this.processRunRepo = options.processRunRepo;
    this.resolveInputPayload = options.resolveInputPayload;
    this.resolveIdempotencyKey = options.resolveIdempotencyKey;
    this.finalStage = options.finalStage ?? '';
    this.projector = options.projectOutcome ?? defaultProjector;
    this.initiatedBy = options.initiatedBy ?? 'generic-flow';
  }

  async run(module: ProcessModuleDefinition, command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const inputPayload = this.resolveInputPayload(command);
    const inputHash = sha256Hex(inputPayload);
    const idempotencyKey = this.resolveIdempotencyKey(command);

    // Idempotent start: same key + same input hash returns the existing row.
    const { record: run, replayed } = this.processRunRepo.start({
      moduleRef: module.identity,
      input: {
        schema: module.inputContract.id,
        payload: inputPayload,
        contentHash: inputHash,
      },
      executorKind: 'generic-flow',
      projectedStage: this.finalStage || null,
      invocationContext: {
        projectId: command.projectId,
        epicId: command.epicId,
        initiatedBy: this.initiatedBy,
        idempotencyKey,
      },
    });

    // Replay terminal: project persisted result without re-executing.
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return this.projectTerminalRun(module, command, run, replayed ? 0 : 1);
    }

    const context: ProcessModuleExecutionContext = {
      projectId: command.projectId,
      epicId: command.epicId,
      processRunId: run.id,
      inputPayload,
      inputHash,
      initiatedBy: this.initiatedBy,
    };

    const result = await this.executor.execute(module, context);
    return this.projectRunResult(module, command, result);
  }

  projectOutcome(module: ProcessModuleDefinition, result: OrchestrationRunResult): ReturnType<ProcessOutcomeProjector> {
    return this.projector(module, result);
  }

  private projectRunResult(
    module: ProcessModuleDefinition,
    command: RunEpisodeCommand,
    result: ProcessModuleRunResult,
  ): OrchestrationRunResult {
    const endedAt = new Date().toISOString();
    return {
      projectId: command.projectId,
      epicId: command.epicId,
      finalStage: this.finalStage || module.identity.kind,
      endedAt,
      reason: 'completed',
      cycles: 1,
      lastError: null,
      processModule: {
        name: module.identity.name,
        version: module.identity.version,
        kind: module.identity.kind,
        ref: processModuleKey(module.identity),
      },
      processOutcome: {
        code: result.outcome,
        authority: result.authority,
        outputRef: result.output?.artifactRef ?? result.certificate?.certificateRef ?? null,
      },
      pipelineScope: module.identity.kind,
      scopeCompleted: true,
      outcome: result.outcome,
      outcomeAuthority: 'discovery_settlement_policy',
    };
  }

  private projectTerminalRun(
    module: ProcessModuleDefinition,
    command: RunEpisodeCommand,
    run: { id: number; status: string; localOutcome: string | null; outputRef: string | null; certificateRef: string | null },
    cycles: number,
  ): OrchestrationRunResult {
    return {
      projectId: command.projectId,
      epicId: command.epicId,
      finalStage: this.finalStage || module.identity.kind,
      endedAt: new Date().toISOString(),
      reason: run.status === 'completed' ? 'completed' : 'failed',
      cycles,
      lastError: null,
      processModule: {
        name: module.identity.name,
        version: module.identity.version,
        kind: module.identity.kind,
        ref: processModuleKey(module.identity),
      },
      processOutcome: {
        code: run.localOutcome ?? '',
        authority: null,
        outputRef: run.outputRef ?? run.certificateRef ?? null,
      },
      pipelineScope: module.identity.kind,
      scopeCompleted: run.status === 'completed',
      outcome: run.localOutcome ?? undefined,
      outcomeAuthority: 'discovery_settlement_policy',
    };
  }
}

const defaultProjector: ProcessOutcomeProjector = (_module, result) => ({
  code: result.processOutcome?.code ?? result.outcome ?? result.reason,
  authority: result.processOutcome?.authority ?? null,
  outputRef: result.processOutcome?.outputRef ?? null,
});

// Re-export for composition-root convenience (avoids importing canonicalJson there).
export { canonicalJson };
