/**
 * Conveyor dispatch loop — distributes queued kanban tasks to workers.
 *
 * Called by orchestrate-cli between lifecycle resume cycles. When a ProcessRun
 * pauses (e.g. development settle-development waiting for impl tasks to drain),
 * the CLI invokes this to spawn workers through the SAME WorkerExecutorFactory
 * that LM-node workers use. This gives impl workers the same desk, hooks, fence
 * and authority as Flow-node workers — one spawn path, one mechanic.
 *
 * Phase 2 (LEGO-CONTRACTS.md): unified worker spawn. Replaces the previous
 * direct `spawn(claudePath, ...)` reimplementation with the real factory.
 */

import type { WorkerExecutor, WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import { getDb } from '../db.js';

export interface DispatchLoopInput {
  projectId: number;
  epicId: number;
  concurrency: number;
  /** The factory that creates WorkerExecutor — same one used by LM nodes. */
  workerExecutorFactory: WorkerExecutorFactory;
  /** Context for the factory (workspace, dbPath, etc). */
  factoryContext: {
    projectId: number;
    epicId: number;
    workspaceRoot: string;
    dbPath: string;
    sagaEntry: string;
    sagaSkillRoot: string;
    claudePath?: string;
    logRoot?: string;
    heartbeatLog?: string;
    lmStudioUrl: string;
  };
}

interface QueuedCounts {
  todo: number;
  review: number;
}

function countQueuedTasks(projectId: number): QueuedCounts {
  const db = getDb();
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN t.status='todo' THEN 1 ELSE 0 END) AS todo,
       SUM(CASE WHEN t.status='review' THEN 1 ELSE 0 END) AS review
     FROM tasks t
     JOIN epics e ON e.id = t.epic_id
     WHERE e.project_id = ?
       AND t.status IN ('todo','review')`,
  ).get(projectId) as { todo: number; review: number } | undefined;
  return {
    todo: row?.todo ?? 0,
    review: row?.review ?? 0,
  };
}

/**
 * Distribute queued tasks to workers using the SAME WorkerExecutorFactory that
 * LM-node workers use. Each call to `executor.start()` spawns `concurrency`
 * workers (each claims one task via worker_next from the shared queue, gets a
 * pinned workplace desk with tracker/assistance/hooks, executes, and exits).
 * Blocks until all workers in the batch finish. Repeats until queue is empty.
 */
export async function distributeQueuedTasks(
  input: DispatchLoopInput,
): Promise<number> {
  const executor: WorkerExecutor = input.workerExecutorFactory(input.factoryContext);
  let totalDispatched = 0;
  let round = 0;

  try {
    while (true) {
      round++;
      const counts = countQueuedTasks(input.projectId);
      const queued = counts.todo + counts.review;
      if (queued === 0) {
        process.stdout.write(`[dispatch] round ${round}: queue empty\n`);
        break;
      }

      const workerCount = Math.min(input.concurrency, queued);
      process.stdout.write(
        `[dispatch] round ${round}: ${queued} queued (${counts.todo} todo, ${counts.review} review). `
        + `Spawning ${workerCount} workers via WorkerExecutorFactory...\n`,
      );

      // start() blocks until all workers finish. claimScope=undefined means
      // workers pick ANY task from the shared queue (review-first, then todo).
      executor.start({
        projectId: input.projectId,
        epicId: input.epicId,
        concurrency: workerCount,
        // No claimScope — queue-mode: workers take whatever is available.
      });

      // Count progress
      const after = countQueuedTasks(input.projectId);
      const remaining = after.todo + after.review;
      const dispatched = queued - remaining;
      totalDispatched += Math.max(0, dispatched);

      process.stdout.write(
        `[dispatch] round ${round}: ${dispatched} tasks drained, ${remaining} remaining\n`,
      );

      if (remaining === 0) {
        break;
      }
      if (dispatched === 0) {
        process.stdout.write('[dispatch] no progress — stopping\n');
        break;
      }
    }
  } finally {
    executor.dispose();
  }

  return totalDispatched;
}
