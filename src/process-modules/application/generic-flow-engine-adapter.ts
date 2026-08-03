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
import { sha256Hex } from '../../shared/canonical-json.js';

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
  /** Exact immutable package selected before this adapter is constructed. */
  installation?: {
    readonly id: number;
    readonly packageDigest: string;
  };
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
  private readonly installation: GenericFlowEngineAdapterOptions['installation'];

  constructor(options: GenericFlowEngineAdapterOptions) {
    this.moduleRef = options.moduleRef;
    this.executor = options.executor;
    this.processRunRepo = options.processRunRepo;
    this.resolveInputPayload = options.resolveInputPayload;
    this.resolveIdempotencyKey = options.resolveIdempotencyKey;
    this.finalStage = options.finalStage ?? '';
    this.projector = options.projectOutcome ?? defaultProjector;
    this.initiatedBy = options.initiatedBy ?? 'generic-flow';
    this.installation = options.installation;
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
      // Legacy pre-Wave-2 path: not pinned to an installation (W3-A3, spec §6).
      // Wave 11 cutover sets these from the active installation.
      installationId: this.installation?.id ?? null,
      packageDigest: this.installation?.packageDigest ?? null,
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
      // Д9: authority comes from the RunResult (set by the settlement kernel
      // handler via production.bindings.authority), NOT a discovery literal.
      // Fallback to module.identity.kind when the module did not set one.
      outcomeAuthority: result.authority ?? module.identity.kind,
    };
  }

  private projectTerminalRun(
    module: ProcessModuleDefinition,
    command: RunEpisodeCommand,
    run: {
      id: number;
      status: string;
      localOutcome: string | null;
      authority: string | null;
      outputRef: string | null;
      certificateRef: string | null;
      error: string | null;
      completedAt: string | null;
    },
    cycles: number,
  ): OrchestrationRunResult {
    return {
      projectId: command.projectId,
      epicId: command.epicId,
      finalStage: this.finalStage || module.identity.kind,
      endedAt: run.completedAt ?? new Date().toISOString(),
      reason: run.status === 'completed' ? 'completed' : 'failed',
      cycles,
      lastError: run.error,
      processModule: {
        name: module.identity.name,
        version: module.identity.version,
        kind: module.identity.kind,
        ref: processModuleKey(module.identity),
      },
      processOutcome: {
        code: run.localOutcome ?? '',
        authority: run.authority,
        outputRef: run.outputRef ?? run.certificateRef ?? null,
      },
      pipelineScope: module.identity.kind,
      scopeCompleted: run.status === 'completed',
      outcome: run.localOutcome ?? undefined,
      // Д9: replay path has no RunResult authority; fall back to module kind.
      outcomeAuthority: run.authority ?? module.identity.kind,
    };
  }
}

const defaultProjector: ProcessOutcomeProjector = (_module, result) => ({
  code: result.processOutcome?.code ?? result.outcome ?? result.reason,
  authority: result.processOutcome?.authority ?? null,
  outputRef: result.processOutcome?.outputRef ?? null,
});
