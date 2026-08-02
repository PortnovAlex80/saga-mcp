/**
 * Conveyor dispatch application service.
 *
 * This service owns queue scheduling and the global concurrency budget. It
 * atomically assigns a card through WorkAssignmentPort BEFORE constructing a
 * worker process, then gives one immutable AssignedWork to one executor.
 *
 * The runner is therefore a process host, not a second dispatcher. It never
 * chooses a card for this production path and never owns the global queue.
 */

import type {
  AssignedWork,
  WorkerExecutor,
  WorkerExecutorFactory,
  WorkerRunSnapshot,
  WorkAssignmentPort,
} from '../application/ports/worker-executor.js';
import type { IdGeneratorPort } from '../application/ports/conveyor-ports.js';
import { asExecutionId } from '../lifecycle/domain/ids.js';

export interface DispatchLoopInput {
  projectId: number;
  epicId: number;
  concurrency: number;
  workerExecutorFactory: WorkerExecutorFactory;
  /** Single authority for selecting and fencing cards. */
  workAssignment: WorkAssignmentPort;
  /** Infrastructure identity source; keeps Date/random/process details outside the use case. */
  idGenerator: IdGeneratorPort;
  /** Stable identity of the host that owns the worker execution. */
  machineId: string;
  /** Polling interval for one assigned worker. Default 1000ms. */
  pollMs?: number;
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

interface ActiveAssignedWorker {
  readonly assignment: AssignedWork;
  readonly completion: Promise<number>;
}

const TERMINAL_RUN_STATES = new Set(['completed', 'stopped', 'failed']);

/**
 * Drain all currently assignable cards with one application-owned concurrency
 * budget. A slot is acquired only after assignTask succeeds. When one worker
 * completes, assignment is retried because its completion may have unblocked a
 * dependent card.
 */
export async function distributeQueuedTasks(
  input: DispatchLoopInput,
): Promise<number> {
  assertConcurrency(input.concurrency);
  const pollMs = input.pollMs ?? 1000;
  const dispatchRunId = input.idGenerator.newTypedId('dispatch-run');
  const active = new Set<Promise<number>>();
  let terminalWorkers = 0;

  const startOne = (): ActiveAssignedWorker | null => {
    const workerExecutionId = input.idGenerator.newTypedId('worker-execution');
    const workerId = input.idGenerator.newTypedId('worker');
    const assignment = input.workAssignment.assignTask({
      projectId: input.projectId,
      epicId: input.epicId,
      workerId,
      workerExecutionId: asExecutionId(workerExecutionId),
      runId: dispatchRunId,
      machineId: input.machineId,
    });
    if (!assignment) return null;

    const executor = input.workerExecutorFactory(input.factoryContext);
    try {
      // One assigned card, one worker process. Concurrency belongs to this
      // service; the process host receives a local ceiling of one.
      executor.start({
        projectId: input.projectId,
        epicId: input.epicId,
        concurrency: 1,
        assignment,
      });
    } catch (error) {
      try {
        input.workAssignment.releaseAssignment({
          taskId: assignment.taskId,
          workerExecutionId: assignment.workerExecutionId,
          reason: `Worker start failed before supervision: ${errorMessage(error)}`,
        });
      } finally {
        executor.dispose();
      }
      throw error;
    }

    const completion = waitForAssignedWorker({
      executor,
      projectId: input.projectId,
      assignment,
      pollMs,
    });
    return { assignment, completion };
  };

  while (true) {
    let queueExhaustedForNow = false;

    while (active.size < input.concurrency) {
      const launched = startOne();
      if (!launched) {
        queueExhaustedForNow = true;
        break;
      }
      process.stdout.write(
        `[dispatch] assigned task=${launched.assignment.taskId} `
        + `execution=${launched.assignment.workerExecutionId}\n`,
      );
      let tracked!: Promise<number>;
      tracked = launched.completion
        .then((count) => {
          terminalWorkers += count;
          return count;
        })
        .finally(() => active.delete(tracked));
      active.add(tracked);
    }

    if (active.size === 0) {
      if (queueExhaustedForNow) break;
      continue;
    }

    // A completion may satisfy dependencies and make another card claimable.
    await Promise.race(active);
  }

  process.stdout.write(
    `[dispatch] drain complete: ${terminalWorkers} worker execution(s) terminal\n`,
  );
  return terminalWorkers;
}

async function waitForAssignedWorker(input: {
  executor: WorkerExecutor;
  projectId: number;
  assignment: AssignedWork;
  pollMs: number;
}): Promise<number> {
  try {
    while (true) {
      await sleep(input.pollMs);
      const snapshot = input.executor.status(input.projectId);
      if (snapshot === null) return 1;
      if (TERMINAL_RUN_STATES.has(snapshot.status)) {
        logTerminal(input.assignment, snapshot);
        return snapshot.completed + snapshot.failed > 0
          ? snapshot.completed + snapshot.failed
          : 1;
      }
    }
  } finally {
    input.executor.dispose();
  }
}

function logTerminal(assignment: AssignedWork, snapshot: WorkerRunSnapshot): void {
  process.stdout.write(
    `[dispatch] task=${assignment.taskId} run=${snapshot.status}: `
    + `${snapshot.completed} completed, ${snapshot.failed} failed\n`,
  );
}

function assertConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`concurrency must be an integer 1..10, got '${value}'`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
