import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  ProcessOutcomeMetadata,
  RunEpisodeCommand,
} from '../../application/ports/orchestration-engine.js';
import {
  processModuleKey,
  type ProcessModuleDefinition,
  type ProcessModuleReference,
} from '../domain/process-module.js';
import type { ProcessModuleRegistry } from './process-module-registry.js';

export interface ProcessModuleExecutionAdapter {
  readonly moduleRef: ProcessModuleReference;
  run(
    module: ProcessModuleDefinition,
    command: RunEpisodeCommand,
  ): Promise<OrchestrationRunResult>;
  projectOutcome(
    module: ProcessModuleDefinition,
    result: OrchestrationRunResult,
  ): ProcessOutcomeMetadata;
}

export type ProcessOutcomeProjector = (
  module: ProcessModuleDefinition,
  result: OrchestrationRunResult,
) => ProcessOutcomeMetadata;

/**
 * Compatibility adapter for an existing stage-specific orchestration engine.
 *
 * It lets Saga migrate one process at a time: the module definition and
 * lifecycle boundary become generic first, while the proven stage engine keeps
 * executing the internal flow until its nodes are moved onto the generic node
 * runtime. Stage-specific result fields are interpreted only by the adapter's
 * projector, never by the process-agnostic Runtime.
 */
export class ExistingOrchestrationEngineAdapter implements ProcessModuleExecutionAdapter {
  private readonly projector: ProcessOutcomeProjector;

  constructor(
    readonly moduleRef: ProcessModuleReference,
    private readonly engine: OrchestrationEngine,
    projector?: ProcessOutcomeProjector,
  ) {
    this.projector = projector ?? ((_module, result) => ({
      code: result.outcome ?? result.reason,
      authority: null,
      outputRef: null,
    }));
  }

  run(
    _module: ProcessModuleDefinition,
    command: RunEpisodeCommand,
  ): Promise<OrchestrationRunResult> {
    return this.engine.run(command);
  }

  projectOutcome(
    module: ProcessModuleDefinition,
    result: OrchestrationRunResult,
  ): ProcessOutcomeMetadata {
    return this.projector(module, result);
  }
}

/**
 * Generic application-facing engine for one selected Process Module.
 *
 * The wrapper validates registration, binds the selected module to an execution
 * adapter, and projects a generic local process outcome. It deliberately does
 * not interpret domain-specific result fields or select the next module:
 * adapter owns compatibility projection, Lifecycle/StageBinding owns routing.
 */
export class ProcessModuleRuntimeEngine implements OrchestrationEngine {
  constructor(
    private readonly registry: ProcessModuleRegistry,
    private readonly moduleRef: ProcessModuleReference,
    private readonly adapter: ProcessModuleExecutionAdapter,
  ) {
    const selected = processModuleKey(moduleRef);
    const adapted = processModuleKey(adapter.moduleRef);
    if (selected !== adapted) {
      throw new Error(`process module adapter mismatch: selected ${selected}, adapter ${adapted}`);
    }
    registry.require(moduleRef);
  }

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const module = this.registry.require(this.moduleRef);
    const result = await this.adapter.run(module, command);

    return {
      ...result,
      processModule: {
        name: module.identity.name,
        version: module.identity.version,
        kind: module.identity.kind,
        ref: processModuleKey(module.identity),
      },
      processOutcome: this.adapter.projectOutcome(module, result),
    };
  }
}
