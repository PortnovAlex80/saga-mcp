import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';
import type {
  ManagedArtifactProductionRecord,
  ManagedTraceProductionRecord,
} from '../shared/managed-production.js';

/**
 * Canonical live read of the durable managed-production desk.
 *
 * The Workplace — not WorkerExecution, task, or Flow node — is the ownership
 * boundary. The resolver returns the canonical latest state of every artifact
 * and trace physically contributed by any execution belonging to that exact
 * Workplace.
 */
export interface WorkplaceProductionResolver {
  read(workplaceRef: WorkplaceRef): {
    readonly artifacts: readonly ManagedArtifactProductionRecord[];
    readonly traces: readonly ManagedTraceProductionRecord[];
  };
}
