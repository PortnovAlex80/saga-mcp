/**
 * Conveyor dispatch loop — distributes queued kanban tasks to workers.
 *
 * The infrastructure (this loop) is the factory operator: it hires workers
 * through the WorkerExecutorFactory, ONE run with concurrency=N, and the runner's
 * pump atomically assigns each card (status flip + fence creation in ONE
 * transaction) before launching each worker. The worker receives the exact,
 * already-assigned card — it never searches for work, never calls worker_next.
 *
 * CONVEYOR-MENTAL-MODEL.md: "Worker arrives, reads the card/desk, does the
 * work, calls worker_done, leaves. Infrastructure hires workers, decides
 * how many to run, provides the desk."
 *
 * WORK-ASSIGNMENT-REFACTOR-SPEC §4: the runner's claimTask callback is wired
 * (via the factory) to WorkAssignmentPort.assignTask — the same atomic
 * findNextClaimable SQL proven by tests/dispatcher-race/run.mjs. This closes
 * the loose-preselector divergence: there is no separate readClaimableTasks
 * authority; the atomic claim is the only selector. Two dispatcher processes
 * calling assignTask for overlapping scopes never get the same card.
 */

import type {
  WorkerExecutor,
  WorkerExecutorFactory,
  WorkAssignmentPort,
} from '../application/ports/worker-executor.js';
// Fallback only: used when a caller did not wire a WorkAssignmentPort. The
// production path (orchestrate-cli) always wires the port, so this import is
// not exercised in production; tests inject a port or accept the fallback.
import { getDb } from '../db.js';

export interface DispatchLoopInput {
  projectId: number;
  epicId: number;
  concurrency: number;
  workerExecutorFactory: WorkerExecutorFactory;
  /**
   * Atomic card-assignment port (CONVEYOR-MENTAL-MODEL §"Required outbound
   * ports": the application must not read the global DB directly). Used for the
   * batch-planning count; the authoritative claim happens inside the runner via
   * the factory's claimTask callback (wired to the same port). When omitted,
   * the loop falls back to direct DB access — kept only for tests/legacy.
   */
  workAssignment?: WorkAssignmentPort;
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

/**
 * Count claimable cards via the port when wired, else fall back to a direct
 * query (legacy/tests). The application layer must not read the global DB
 * directly in production — the port is the conveyor seam.
 */
function countClaimable(projectId: number, port?: WorkAssignmentPort): number {
  if (port) return port.countClaimable(projectId);
  // Fallback for callers that did not wire a port (kept for tests/legacy).
  const row = getDb().prepare(
    `SELECT count(*) as n
     FROM tasks t JOIN epics e ON e.id = t.epic_id
     WHERE e.project_id = ? AND t.status IN ('todo','review')
       AND (t.assigned_to IS NULL OR t.assigned_to = '')`,
  ).get(projectId) as { n: number };
  return row.n;
}

/**
 * Hire workers for claimable tasks. Starts ONE run with concurrency=N; the
 * runner's pump assigns each card atomically (via the factory's claimTask
 * callback, wired to WorkAssignmentPort.assignTask) and launches a worker per
 * slot. Workers run in parallel up to `concurrency` at a time.
 *
 * This function is BLOCKING with respect to the run: it polls `status()` until
 * the run reaches a terminal state (completed/stopped/failed) before returning.
 * The orchestrate-cli lifecycle loop depends on this — it resumes the lifecycle
 * only after the dispatched workers have actually finished, otherwise it would
 * re-pause immediately on an empty-but-inflight queue and exit. The original
 * implementation relied on `start()` blocking; under the conveyor model
 * `start()` returns immediately (it schedules `queueMicrotask(pump)`), so the
 * poll loop here is the awaitable contract the caller needs.
 *
 * Race safety does not depend on this loop: the atomic claim inside the runner
 * (findNextClaimable under BEGIN IMMEDIATE) is the single source of truth —
 * two dispatcher processes cannot obtain the same card even if both reach the
 * claim simultaneously. This loop only decides how many workers to hire and
 * waits for them to drain.
 */
export async function distributeQueuedTasks(
  input: DispatchLoopInput,
): Promise<number> {
  const executor: WorkerExecutor = input.workerExecutorFactory(input.factoryContext);
  try {
    const claimable = countClaimable(input.projectId, input.workAssignment);
    if (claimable === 0) {
      process.stdout.write(`[dispatch] queue empty — nothing to hire\n`);
      return 0;
    }
    process.stdout.write(
      `[dispatch] ${claimable} claimable, hiring run with concurrency=${input.concurrency} `
      + `(runner assigns cards atomically via assignTask)\n`,
    );

    // One run, concurrency=N. The runner pump hires up to N workers in
    // parallel, each atomically claiming one card through the factory's
    // claimTask callback (WorkAssignmentPort.assignTask). start() returns a
    // snapshot immediately (non-blocking) and pump runs on a microtask.
    executor.start({
      projectId: input.projectId,
      epicId: input.epicId,
      concurrency: input.concurrency,
    });

    // Awaitable contract: poll status() until the run terminates. The caller
    // (lifecycle resume loop) needs all dispatched workers to finish before it
    // resumes the lifecycle; without this wait it would see an empty queue
    // (workers still inflight) and exit prematurely.
    const terminalStates = new Set(['completed', 'stopped', 'failed']);
    const pollIntervalMs = 1000;
    let totalCompleted = 0;
    while (true) {
      await sleep(pollIntervalMs);
      const snapshot = executor.status(input.projectId);
      if (!snapshot) break; // run gone
      if (terminalStates.has(snapshot.status)) {
        totalCompleted = snapshot.completed + snapshot.failed;
        process.stdout.write(
          `[dispatch] run ${snapshot.status}: ${snapshot.completed} completed, `
          + `${snapshot.failed} failed, ${snapshot.claimed} claimed\n`,
        );
        break;
      }
    }
    return totalCompleted;
  } finally {
    executor.dispose();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
