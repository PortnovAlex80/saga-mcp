import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';

/**
 * Read-only access to the current episode stage.
 *
 * D0 reports the stage truthfully in the run result; it never mutates it.
 * Kept as a narrow function port (not the full EpisodeRuntimeRepository) so
 * the Discovery Edition shell carries the smallest possible surface.
 */
export type ReadEpisodeStage = (epicId: number) => string | null;

export interface Saga3DiscoveryEngineDependencies {
  /**
   * Optional read-only stage reader. When omitted the engine reports the
   * discovery entry stage ('discovery') as finalStage — it never invents a
   * later stage. Wired by the composition root to the shared persistence.
   */
  readStage?: ReadEpisodeStage;
  now?: () => Date;
}

/**
 * Saga 3 Discovery Edition orchestration engine — D0 shell.
 *
 * Roadmap D0 (docs/architecture/SAGA-3-DISCOVERY-FIRST-ROADMAP.md §8.D0) proves
 * that the Phase B infrastructure isolation can host a second engine behind the
 * existing OrchestrationEngine port WITHOUT duplicating tracker, repositories,
 * worker runtime or engine administration.
 *
 * In D0 the engine is intentionally inert:
 *   - it does NOT spawn a product worker;
 *   - it does NOT transition the episode stage;
 *   - it does NOT create tasks or artifacts;
 *   - it does NOT mark the product completed.
 *
 * It accepts the same RunEpisodeCommand shape, confirms selection, and returns
 * an honest typed terminal result whose outcome is 'discovery_not_implemented'.
 * This must never be masked as 'completed' or a plain 'failed': a discovery-only
 * run that has not executed discovery work is neither.
 *
 * Real discovery work (WorkIntent, product worker, DiscoveryProposal, advisor,
 * settlement) lands in D1–D6. Do not add it here.
 */
export class Saga3DiscoveryEngine implements OrchestrationEngine {
  private readonly readStage: ReadEpisodeStage | undefined;
  private readonly now: () => Date;

  constructor(dependencies: Saga3DiscoveryEngineDependencies = {}) {
    this.readStage = dependencies.readStage;
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    // Read-only: report the stage truthfully. Never mutate. If the episode has
    // no workflow row yet (or no reader was wired), fall back to the discovery
    // entry stage rather than fabricating a later one.
    const stage = this.readStage ? this.readStage(command.epicId) : null;
    const finalStage = stage ?? 'discovery';

    return {
      projectId: command.projectId,
      epicId: command.epicId,
      finalStage,
      endedAt: this.now().toISOString(),
      // Honest partial-pipeline reason: discovery work is not implemented yet.
      reason: 'discovery_not_implemented',
      cycles: 0,
      lastError: null,
      // Partial-pipeline scope (roadmap §5.3). scopeCompleted=false: the
      // discovery-only slice did not execute, so the configured scope is not
      // complete. This is distinct from full-product completion in every case.
      pipelineScope: 'discovery_only',
      scopeCompleted: false,
      outcome: 'discovery_not_implemented',
    };
  }
}
