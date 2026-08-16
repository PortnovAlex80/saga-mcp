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
import type { ConcurrencyAdmissionSnapshot } from '../application/ports/factory-runtime-persistence.js';
import { asExecutionId } from '../lifecycle/domain/ids.js';

/**
 * Typed outcome of ONE dispatch attempt (plan item 19, after
 * CONVEYOR-MENTAL-MODEL §22: a downshift suppresses replacement workers and
 * lets existing workers drain — likewise a recoverable per-card failure
 * suppresses only THAT card and lets the remaining queue drain).
 *
 * Before item 19 any throw from assignTask/executor.start killed the whole
 * engine (W2: "13 recovery mechanisms, and all of them treat executor death,
 * none — owner death"). Now a recoverable error is a VALUE, not an exception:
 * the card is logged, released and poisoned for the rest of this drain, and
 * the loop moves to the next card. Only provably engine-wide failures
 * (DB corruption, policy/authority binding) still throw.
 */
export type DispatchOutcome =
  | { kind: 'assigned'; assignment: AssignedWork; completion: Promise<number> }
  /** Recoverable per-card failure. `taskId` is null when the error carries no
   *  card identity (thrown before the card was known). */
  | { kind: 'card_error'; taskId: number | null; reason: string; retryable: boolean }
  | { kind: 'queue_empty' }
  | { kind: 'capacity_blocked' };

/**
 * Plan item 19 fatality policy. The default is FAIL-CLOSED: an unrecognized
 * error still throws and kills the engine (the pre-item-19 behavior), because
 * dispatch cannot prove it is card-local. Only error families that are
 * provably per-card are demoted to `card_error`:
 *
 *   - `REPLAY_*` / `FINAL_PRESENTATION_FENCE_MISMATCH` — replay capsule
 *     binding family (the binder itself is newest-wins; anything that still
 *     escapes is a per-card binding defect);
 *   - `FROZEN_*` / `MODEL_ROUTE_INVALID` / `MODEL_PROVIDER_REQUIRED` —
 *     per-card frozen execution-context validation at spawn;
 *   - Node OS errno codes — worker process spawn failures
 *     (ENOENT binary, EAGAIN, timed out connect…);
 *   - per-card repository projection defects.
 *
 * Authority/policy (`AUTHORITY_BINDING_INVALID`, `EXECUTION_ROUTES_INVALID`,
 * `POLICY_*`) and database (`SQLITE_*`) failures stay FATAL: they are
 * engine-wide, not card-local, and the engine must die loudly for them.
 */
const RECOVERABLE_OS_ERROR_CODES = new Set([
  'EAGAIN', 'ENOENT', 'EACCES', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
  'ECONNABORTED', 'EPIPE', 'EMFILE', 'ENFILE', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH',
]);

const RECOVERABLE_ERROR_PATTERNS: readonly RegExp[] = [
  /^REPLAY_/,
  /^FINAL_PRESENTATION_FENCE_MISMATCH\b/,
  /^FROZEN_/,
  /^MODEL_ROUTE_INVALID\b/,
  /^MODEL_PROVIDER_REQUIRED\b/,
  /^Task \d+ targets missing or foreign project_repository_id\b/,
];

function isRecoverableDispatchError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && RECOVERABLE_OS_ERROR_CODES.has(code)) {
      return true;
    }
  }
  const message = errorMessage(error);
  return RECOVERABLE_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/** Card identity attached by the assignment adapter when it rethrows a
 *  per-card build/bind failure after releasing the reservation. */
function cardErrorTaskId(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const taskId = (error as { taskId?: unknown }).taskId;
    if (typeof taskId === 'number' && Number.isInteger(taskId)) return taskId;
  }
  return null;
}

/**
 * Safety valve for recoverable errors that carry NO card identity: the claim
 * SQL has a deterministic priority order, so without an exclusion the same
 * unknown card would be re-selected forever. After this many unresolved
 * card errors the drain stops (queue-exhausted semantics) and the
 * orchestrate-cli emptyDispatchStreak owns the graceful exit.
 */
const MAX_UNRESOLVED_CARD_ERRORS = 10;

export interface DispatchLoopInput {
  projectId: number;
  epicId: number;
  /** Fresh durable capacity view. Called immediately before every assignment. */
  readConcurrencyAdmission: () => ConcurrencyAdmissionSnapshot;
  /**
   * True when the kernel has rightward Kanban work (for example GateRuns) to
   * reconcile. Dispatch yields instead of filling a newly free worker slot.
   */
  shouldYieldToKernel?: () => boolean;
  /**
   * Durable terminal-state probe for one worker execution. The per-worker
   * completion wait polls the executor's run snapshot; on Windows the runner's
   * close event can be delayed indefinitely by inherited pipe handles, leaving
   * the run non-terminal AFTER the execution itself already reached a terminal
   * durable state (exited/lost/terminated). This probe is the fail-safe: when
   * the durable execution is terminal, the wait resolves from authority
   * instead of hanging the whole dispatch loop.
   */
  isExecutionDurableTerminal?: (workerExecutionId: string) => boolean;
  workerExecutorFactory: WorkerExecutorFactory;
  /** Single authority for selecting and fencing cards. */
  workAssignment: WorkAssignmentPort;
  /** Infrastructure identity source; keeps Date/random/process details outside the use case. */
  idGenerator: IdGeneratorPort;
  /** Stable identity of the host that owns the worker execution. */
  machineId: string;
  /** Polling interval for one assigned worker. Default 1000ms. */
  pollMs?: number;
  /** Diagnostics sink for the per-worker wait (throttled). */
  pollDebug?: (message: string) => void;
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

const TERMINAL_RUN_STATES = new Set(['completed', 'stopped', 'failed']);

/**
 * Drain all currently assignable cards with one application-owned concurrency
 * budget. A slot is acquired only after assignTask succeeds. When one worker
 * completes, assignment is retried because its completion may have unblocked a
 * dependent card.
 *
 * Plan item 19: recoverable per-card failures are typed outcomes, not throws.
 * One broken card never kills the engine — it is logged, released, poisoned
 * for the rest of this drain, and the loop continues with the next card. If
 * every card in the queue fails, the drain returns 0 and the caller's
 * emptyDispatchStreak logic exits the engine gracefully (exit 2, paused).
 */
export async function distributeQueuedTasks(
  input: DispatchLoopInput,
): Promise<number> {
  const pollMs = input.pollMs ?? 1000;
  const dispatchRunId = input.idGenerator.newTypedId('dispatch-run');
  const active = new Set<Promise<number>>();
  let terminalWorkers = 0;

  // Cards that already failed with a recoverable error in THIS drain. They are
  // excluded from every subsequent assignTask call: the deterministic priority
  // order would otherwise re-serve the same card and livelock the drain.
  const poisonedTasks = new Set<number>();
  let unresolvedCardErrors = 0;

  const startOne = (): DispatchOutcome => {
    // Admission is part of the typed outcome — a full budget is a normal
    // drain condition, not an error.
    const admission = input.readConcurrencyAdmission();
    assertAdmission(admission);
    if (admission.activeExecutions >= admission.effectiveConcurrency) {
      return { kind: 'capacity_blocked' };
    }

    const workerExecutionId = input.idGenerator.newTypedId('worker-execution');
    const workerId = input.idGenerator.newTypedId('worker');

    let assignment: AssignedWork | null = null;
    try {
      assignment = input.workAssignment.assignTask({
        projectId: input.projectId,
        epicId: input.epicId,
        workerId,
        workerExecutionId: asExecutionId(workerExecutionId),
        runId: dispatchRunId,
        machineId: input.machineId,
        ...(poisonedTasks.size > 0
          ? { excludeTaskIds: [...poisonedTasks] }
          : {}),
      });
    } catch (error) {
      // The adapter releases the reservation before rethrowing and annotates
      // the error with the card identity (taskId) when the card is known.
      if (!isRecoverableDispatchError(error)) throw error;
      return {
        kind: 'card_error',
        taskId: cardErrorTaskId(error),
        reason: errorMessage(error),
        retryable: true,
      };
    }
    if (!assignment) return { kind: 'queue_empty' };

    let executor: WorkerExecutor | null = null;
    try {
      executor = input.workerExecutorFactory(input.factoryContext);
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
        executor?.dispose();
      }
      if (!isRecoverableDispatchError(error)) throw error;
      return {
        kind: 'card_error',
        taskId: assignment.taskId,
        reason: errorMessage(error),
        retryable: true,
      };
    }

    const completion = waitForAssignedWorker({
      executor,
      projectId: input.projectId,
      assignment,
      pollMs,
      isExecutionDurableTerminal: input.isExecutionDurableTerminal,
      pollDebug: input.pollDebug,
    });
    return { kind: 'assigned', assignment, completion };
  };

  while (true) {
    let queueExhaustedForNow = false;
    let capacityBlockedForNow = false;
    let kernelWorkPending = false;

    while (true) {
      if (input.shouldYieldToKernel?.()) {
        kernelWorkPending = true;
        break;
      }
      const outcome = startOne();
      if (outcome.kind === 'capacity_blocked') {
        capacityBlockedForNow = true;
        break;
      }
      if (outcome.kind === 'queue_empty') {
        queueExhaustedForNow = true;
        break;
      }
      if (outcome.kind === 'card_error') {
        // Recoverable per-card failure: warn, poison this card for the drain,
        // continue with the next card. The engine keeps dispatching healthy
        // cards (granularity invariant of item 19).
        process.stderr.write(
          `[dispatch] card_error task=${outcome.taskId ?? 'unknown'} `
          + `retryable=${outcome.retryable}: ${outcome.reason}\n`,
        );
        if (outcome.taskId !== null) {
          poisonedTasks.add(outcome.taskId);
        } else {
          unresolvedCardErrors += 1;
          if (unresolvedCardErrors >= MAX_UNRESOLVED_CARD_ERRORS) {
            // The error carries no card identity, so exclusion is impossible
            // and the queue would re-serve the same card forever. Stop this
            // drain; the emptyDispatchStreak cycle owns the graceful exit.
            queueExhaustedForNow = true;
            break;
          }
        }
        continue;
      }
      process.stdout.write(
        `[dispatch] assigned task=${outcome.assignment.taskId} `
        + `execution=${outcome.assignment.workerExecutionId}\n`,
      );
      const tracked: Promise<number> = outcome.completion
        .then((count) => {
          terminalWorkers += count;
          return count;
        })
        .finally(() => active.delete(tracked));
      active.add(tracked);
    }

    if (active.size === 0) {
      if (kernelWorkPending) {
        process.stdout.write('[dispatch] yielding to pending kernel verification\n');
        break;
      }
      if (capacityBlockedForNow) {
        process.stdout.write('[dispatch] durable concurrency capacity reached\n');
        break;
      }
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
  isExecutionDurableTerminal?: (workerExecutionId: string) => boolean;
  pollDebug?: (message: string) => void;
}): Promise<number> {
  try {
    let polls = 0;
    while (true) {
      await sleep(input.pollMs);
      polls += 1;
      if (input.pollDebug && polls % 5 === 0) {
        input.pollDebug(
          `task=${input.assignment.taskId} polls=${polls} `
          + `durable=${(() => {
            try {
              return input.isExecutionDurableTerminal?.(
                String(input.assignment.workerExecutionId),
              ) === true;
            } catch (error) {
              return `probe-error:${error instanceof Error ? error.message : String(error)}`;
            }
          })()}`,
        );
      }
      // Fail-safe (Windows pipe inheritance): the runner's run snapshot may
      // never reach a terminal state even after the durable execution row did
      // (state=exited). Resolve from the durable authority instead of hanging.
      let durableTerminal: boolean;
      try {
        durableTerminal = input.isExecutionDurableTerminal?.(
          String(input.assignment.workerExecutionId),
        ) === true;
      } catch (error) {
        durableTerminal = false;
        input.pollDebug?.(
          `task=${input.assignment.taskId} probe threw: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (durableTerminal) {
        logTerminal(input.assignment, {
          id: 'durable',
          project_id: input.projectId,
          concurrency: 1,
          status: 'completed',
          started_at: '',
          finished_at: new Date().toISOString(),
          active: [],
          completed: 1,
          failed: 0,
          claimed: 1,
          last_error: null,
        });
        return 1;
      }
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
    + `${snapshot.completed} completed, ${snapshot.failed} failed`
    + `${snapshot.last_error ? `; error=${snapshot.last_error}` : ''}\n`,
  );
}

function assertAdmission(value: ConcurrencyAdmissionSnapshot): void {
  for (const [name, candidate] of [
    ['operatorConcurrency', value.operatorConcurrency],
    ['modelConcurrencyLimit', value.modelConcurrencyLimit],
    ['effectiveConcurrency', value.effectiveConcurrency],
  ] as const) {
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 10) {
      throw new Error(`${name} must be an integer 1..10, got '${candidate}'`);
    }
  }
  if (value.effectiveConcurrency !== Math.min(
    value.operatorConcurrency,
    value.modelConcurrencyLimit,
  )) {
    throw new Error('effectiveConcurrency must equal min(operatorConcurrency, modelConcurrencyLimit)');
  }
  if (!Number.isInteger(value.activeExecutions) || value.activeExecutions < 0) {
    throw new Error(`activeExecutions must be a non-negative integer, got '${value.activeExecutions}'`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
