/**
 * Conveyor dispatch loop — distributes queued kanban tasks to workers.
 *
 * The infrastructure (this loop) is the factory operator: it picks tasks from
 * the queue (review first, then todo), and for EACH task hires ONE worker
 * through the WorkerExecutorFactory with claimScope.taskIds=[taskId]. The
 * worker receives the exact card (task), gets a pinned desk, does the work,
 * calls worker_done, and leaves. One card per worker — the worker never
 * searches for work itself.
 *
 * CONVEYOR-MENTAL-MODEL.md: "Worker arrives, reads the card/desk, does the
 * work, calls worker_done, leaves. Infrastructure hires workers, decides
 * how many to run, provides the desk."
 *
 * Phase 2 (LEGO-CONTRACTS): one spawn path, one mechanic. Impl-task workers
 * get the SAME desk, hooks, fence and authority as Flow-node LM workers.
 */

import type { WorkerExecutor, WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import { getDb } from '../db.js';

export interface DispatchLoopInput {
  projectId: number;
  epicId: number;
  concurrency: number;
  workerExecutorFactory: WorkerExecutorFactory;
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

interface TaskSummary {
  id: number;
  status: string;
}

/**
 * Read up to `limit` claimable tasks (review first, then todo) for a project.
 * Mirrors findNextClaimable ordering.
 */
function readClaimableTasks(projectId: number, limit: number): TaskSummary[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT t.id, t.status
     FROM tasks t
     JOIN epics e ON e.id = t.epic_id
     WHERE e.project_id = ?
       AND t.status IN ('todo','review')
       AND (t.assigned_to IS NULL OR t.assigned_to = '')
     ORDER BY CASE WHEN t.status = 'review' THEN 0 ELSE 1 END,
              t.priority DESC, t.sort_order ASC
     LIMIT ?`,
  ).all(projectId, limit) as TaskSummary[];
  return rows;
}

function countClaimable(projectId: number): number {
  const db = getDb();
  const row = db.prepare(
    `SELECT count(*) as n
     FROM tasks t JOIN epics e ON e.id = t.epic_id
     WHERE e.project_id = ? AND t.status IN ('todo','review')
       AND (t.assigned_to IS NULL OR t.assigned_to = '')`,
  ).get(projectId) as { n: number };
  return row.n;
}

/**
 * Hire workers for claimable tasks. For EACH task, spawn one worker via
 * WorkerExecutorFactory with claimScope.taskIds=[taskId] — the worker receives
 * the exact card, not a queue to browse. Workers run in parallel up to
 * `concurrency` at a time.
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
      const claimable = countClaimable(input.projectId);
      if (claimable === 0) {
        process.stdout.write(`[dispatch] round ${round}: queue empty\n`);
        break;
      }

      // Pick up to `concurrency` tasks for this round (review-first).
      const batch = readClaimableTasks(input.projectId, input.concurrency);
      process.stdout.write(
        `[dispatch] round ${round}: ${claimable} claimable, hiring ${batch.length} workers `
        + `(review-first, claimScope per task)\n`,
      );

      // Spawn one worker per task. Each worker gets claimScope.taskIds=[taskId]
      // — infrastructure assigns the card, worker does NOT call worker_next.
      // start() blocks until the worker finishes.
      let roundDispatched = 0;
      for (const task of batch) {
        try {
          executor.start({
            projectId: input.projectId,
            epicId: input.epicId,
            concurrency: 1,
            claimScope: { taskIds: [task.id] },
          });
          roundDispatched++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `[dispatch] worker for task ${task.id} failed: ${msg}\n`,
          );
        }
      }

      const remaining = countClaimable(input.projectId);
      totalDispatched += roundDispatched;
      process.stdout.write(
        `[dispatch] round ${round}: ${roundDispatched} workers done, ${remaining} remaining\n`,
      );

      if (roundDispatched === 0) {
        process.stdout.write('[dispatch] no progress — stopping\n');
        break;
      }
      if (remaining === 0) {
        break;
      }
    }
  } finally {
    executor.dispose();
  }

  return totalDispatched;
}
