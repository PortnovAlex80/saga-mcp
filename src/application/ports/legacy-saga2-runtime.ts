import type { OrchestrationRunResult } from './orchestration-engine.js';

export interface LegacySaga2Invocation {
  projectId: number;
  epicId: number;
  concurrency?: number;
  claudePath?: string;
}

/**
 * Compatibility seam around the proven Saga 2 pump.
 *
 * The engine adapter depends on this narrow invocation contract instead of
 * importing src/orchestrate.ts. Infrastructure owns the concrete bridge.
 */
export type LegacySaga2Runner = (
  invocation: LegacySaga2Invocation,
) => Promise<OrchestrationRunResult>;
