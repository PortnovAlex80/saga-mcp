import type {
  OrchestrationEngine,
  OrchestrationRunResult,
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
}

/**
 * Compatibility adapter for an existing stage-specific orchestration engine.
 *
 * It lets Saga migrate one process at a time: the module definition and
 * lifecycle boundary become generic first, while the proven stage engine keeps
 * executing the internal flow until its nodes are moved onto the generic node
 * runtime.
 */
export class ExistingOrchestrationEngineAdapter implements ProcessModuleExecutionAdapter {
  constructor(
    readonly moduleRef: ProcessModuleReference,
    private readonly engine: OrchestrationEngine,
  ) {}

  run(
    _module: ProcessModuleDefinition,
    command: RunEpisodeCommand,
  ): Promise<OrchestrationRunResult> {
    return this.engine.run(command);
  }
}

/**
 * Generic application-facing engine for one selected Process Module.
 *
 * The wrapper validates registration, binds the selected module to an execution
 * adapter, and projects a generic local process outcome. It deliberately does
 * not select the next module: Lifecycle/StageBinding owns that decision.
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
    const code = result.outcome ?? result.reason;

    return {
      ...result,
      processModule: {
        name: module.identity.name,
        version: module.identity.version,
        kind: module.identity.kind,
        ref: processModuleKey(module.identity),
      },
      processOutcome: {
        code,
        authority: result.outcomeAuthority ?? null,
        outputRef: this.outputRef(result),
      },
    };
  }

  private outputRef(result: OrchestrationRunResult): string | null {
    const certificateId = result.settlement?.certificateId;
    if (certificateId !== undefined && certificateId !== null) {
      return `certificate:${certificateId}`;
    }
    if (result.proposalId !== undefined && result.proposalId !== null) {
      return `proposal:${result.proposalId}`;
    }
    return null;
  }
}
