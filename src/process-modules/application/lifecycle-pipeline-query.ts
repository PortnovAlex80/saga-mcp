/**
 * Query service for the lifecycle pipeline projection.
 *
 * Thin application-layer wrapper that fetches a LifecycleRun and its
 * StageRuns through an application-owned read port
 * INTERFACE — never the concrete Sqlite class — and delegates the merge to the
 * pure `projectPipeline`. This is the only place that performs IO; the
 * projection itself stays pure and fully unit-testable.
 *
 * Dependency inversion: callers inject the repository interface. tracker-view
 * wires the concrete `SqliteLifecycleRunRepository` at its own boundary; this
 * module never instantiates it.
 */

import { projectPipeline } from './lifecycle-pipeline-projection.js';
import type {
  LifecyclePipelineRunInput,
  LifecyclePipelineStageRunInput,
  PipelineView,
} from './lifecycle-pipeline-projection.js';

/** Narrow read-only application port required by this query. */
export interface LifecyclePipelineReader {
  list(
    projectId: number,
    epicId?: number,
  ): readonly LifecyclePipelineRunInput[];
  read(id: number): LifecyclePipelineRunInput | null;
  listStageRuns(
    lifecycleRunId: number,
  ): readonly LifecyclePipelineStageRunInput[];
}

/**
 * Build the `PipelineView` for the most recent LifecycleRun of one epic.
 *
 * Returns `null` when no run exists for the epic — that null is the frontend's
 *
 * The repository's `list(projectId, epicId)` is `ORDER BY id DESC`, so the
 * first element is the most recent run. We then read the full run record (for
 * the canonical timestamp fields) plus its StageRuns and Transitions, and
 * delegate to the pure projection.
 */
export function buildPipelineView(
  projectId: number,
  epicId: number,
  repo: LifecyclePipelineReader,
): PipelineView | null {
  const runs = repo.list(projectId, epicId);
  if (runs.length === 0) return null;
  // list() is ORDER BY id DESC — most recent first.
  const summary = runs[0];
  if (!summary) return null;

  const run = repo.read(summary.id);
  if (run === null) return null;
  const stageRuns = repo.listStageRuns(summary.id);
  return projectPipeline(run, stageRuns);
}
