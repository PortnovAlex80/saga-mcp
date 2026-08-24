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
import { engineLog } from '../runtime/engine-file-logger.js';

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
    // Antifreeze B3: bounded busy-retry exhaustion on the claim (a BEGIN
    // IMMEDIATE on the shared main connection) is TRANSIENT and card-agnostic
    // — not a broken card and not an engine-fatal condition. Typed as a
    // card_error the drain stops gracefully through the unresolved-error
    // valve / emptyDispatchStreak instead of freezing on a busy-spin.
    if (code === 'ENGINE_DB_BUSY') return true;
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
  /**
   * FIX 2 (2026-08-16 incident): hard bound on the per-worker completion wait,
   * in polls. Default DEFAULT_WAIT_POLL_MAX_POLLS (60); env override
   * SAGA_WAIT_POLL_MAX_POLLS. Only consulted when isExecutionDurableTerminal
   * is provided (the bound escalates TO the durable authority — a pure
   * in-memory drain has nothing to defer to).
   */
  waitPollMaxPolls?: number;
  /**
   * FIX 2: hard bound on the per-worker completion wait, in wall-clock ms.
   * Default DEFAULT_WAIT_POLL_MAX_MS (15 minutes); env override
   * SAGA_WAIT_POLL_MAX_MS. Whichever bound (polls / ms) is hit FIRST wins.
   */
  waitPollMaxMs?: number;
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

// ---------------------------------------------------------------------------
// FIX 2 (2026-08-16 incident, project 4) — bounded wait-poll.
//
// A worker died silently; its durable row stayed state='running'; the engine
// spin-waited on the per-worker completion poll ([wait-poll] task=187
// polls=230 durable=false) and ONE stuck task froze the whole engine until an
// operator manually soft-stopped it. The wait is now hard-bounded: after
// maxPolls polls OR maxMs wall time — WHICHEVER COMES FIRST — the wait stops
// and defers to the supervision sweep + the normal engine cycle.
//
// Bounds are configurable via env (fail-closed: an unset/invalid value falls
// back to the defaults — never an unbounded wait):
//   SAGA_WAIT_POLL_MAX_POLLS  (default 60)
//   SAGA_WAIT_POLL_MAX_MS     (default 900000 = 15 minutes)
//
// ESCALATION SEMANTICS — this bound never declares a worker dead. Reaching it
// only means "this host stops hosting the wait". durable=false for the whole
// window on a LIVE worker with a fresh heartbeat is LEGITIMATE (one big LLM
// call), so escalation merely:
//   * returns 0 (no lifecycle failure, no terminal count — the worker keeps
//     running and its in-process runner keeps observing it, so the natural
//     exit receipt still lands when the worker eventually exits);
//   * leaves the executor UNDISPOSED (dispose() would kill runner children);
//   * lets the engine's next cycle re-evaluate via the durable admission view
//     and the supervision sweep (which — FIX 1 — now resolves dead workers by
//     PID liveness, while live-but-slow workers simply keep occupying their
//     durable slot until they finish).
// ---------------------------------------------------------------------------

export const DEFAULT_WAIT_POLL_MAX_POLLS = 60;
export const DEFAULT_WAIT_POLL_MAX_MS = 15 * 60 * 1000;

function resolvePositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  // Fail-closed: an invalid override must never become an unbounded/zero wait.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface WaitPollBounds {
  maxPolls: number;
  maxMs: number;
}

/** Resolve the wait-poll bounds from env, failing closed to the defaults. */
export function resolveWaitPollBounds(env: NodeJS.ProcessEnv = process.env): WaitPollBounds {
  return {
    maxPolls: resolvePositiveIntEnv(env, 'SAGA_WAIT_POLL_MAX_POLLS', DEFAULT_WAIT_POLL_MAX_POLLS),
    maxMs: resolvePositiveIntEnv(env, 'SAGA_WAIT_POLL_MAX_MS', DEFAULT_WAIT_POLL_MAX_MS),
  };
}

export type WaitPollAction = 'wait' | 'escalate';

/** Pure input to {@link decideWaitPollAction}. */
export interface WaitPollDecisionInput {
  /** Polls performed so far for this worker. */
  polls: number;
  /** Wall-clock ms elapsed since the wait started. */
  elapsedMs: number;
  maxPolls: number;
  maxMs: number;
  /**
   * Whether the worker's durable heartbeat is fresh. DELIBERATELY does not
   * gate the decision: escalation is not a death declaration, so a fresh
   * heartbeat must not suppress it (supervision performs the real liveness
   * check). The field exists so tests can pin that anti-spurious contract —
   * a healthy long task escalates safely and keeps running.
   */
  workerHeartbeatFresh?: boolean;
}

/**
 * Pure bound decision for the per-worker wait-poll: 'wait' while under BOTH
 * bounds, 'escalate' once EITHER bound is reached (whichever comes first).
 * Pure on purpose — tested without sleeping real minutes.
 */
export function decideWaitPollAction(input: WaitPollDecisionInput): WaitPollAction {
  if (input.polls >= input.maxPolls) return 'escalate';
  if (input.elapsedMs >= input.maxMs) return 'escalate';
  return 'wait';
}

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
  // FIX 2: resolved once per drain; per-worker waits share the same bounds.
  const defaultBounds = resolveWaitPollBounds();
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
    // C-4: the live epic-wide ceiling alone is not enough — a mid-run
    // /api/model/set rewrites it under in-flight workers. The per-model
    // frozen-limit aggregation must ALSO leave a slot for the model the next
    // claim would freeze.
    if (admission.modelSlotsAvailable === false) {
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
      waitPollBounds: input.isExecutionDurableTerminal
        ? {
            maxPolls: input.waitPollMaxPolls ?? defaultBounds.maxPolls,
            maxMs: input.waitPollMaxMs ?? defaultBounds.maxMs,
          }
        : undefined,
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
        engineLog(
          `[dispatch] card_error task=${outcome.taskId ?? 'unknown'} `
          + `retryable=${outcome.retryable}: ${outcome.reason}`,
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
      engineLog(
        `[dispatch] assigned task=${outcome.assignment.taskId} `
        + `execution=${outcome.assignment.workerExecutionId}`,
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
        engineLog('[dispatch] yielding to pending kernel verification');
        break;
      }
      if (capacityBlockedForNow) {
        engineLog('[dispatch] durable concurrency capacity reached');
        break;
      }
      if (queueExhaustedForNow) break;
      continue;
    }

    // A completion may satisfy dependencies and make another card claimable.
    await Promise.race(active);
  }

  engineLog(
    `[dispatch] drain complete: ${terminalWorkers} worker execution(s) terminal`,
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
  /**
   * FIX 2: hard wait bounds. Undefined when no durable terminal probe was
   * provided — the bound exists to hand a stalled DURABLE wait back to
   * supervision, and an in-memory-only drain has no durable authority to
   * defer to (and no supervision sweep behind it).
   */
  waitPollBounds?: WaitPollBounds;
}): Promise<number> {
  const waitStartedAtMs = Date.now();
  // FIX 2: set when the wait exits via the bound. The finally block then does
  // NOT dispose the executor: dispose() stops the runner and KILLS its child
  // processes, and an escalated worker may well be alive (big LLM call).
  let deferredToSupervision = false;
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
      // FIX 2 — bounded wait-poll (checked LAST so a worker that reaches a
      // terminal state exactly at the bound still resolves normally).
      // Escalation only STOPS this host's wait: it does not fail the
      // lifecycle, does not kill the worker, and does not claim a terminal
      // count. The durable row + supervision sweep re-evaluate on the next
      // engine cycle; a live-but-slow worker keeps running and keeps its
      // durable slot until it finishes.
      if (
        input.waitPollBounds !== undefined
        && decideWaitPollAction({
          polls,
          elapsedMs: Date.now() - waitStartedAtMs,
          maxPolls: input.waitPollBounds.maxPolls,
          maxMs: input.waitPollBounds.maxMs,
        }) === 'escalate'
      ) {
        input.pollDebug?.(
          `EXHAUSTED task=${input.assignment.taskId} polls=${polls} — deferring to supervision`,
        );
        deferredToSupervision = true;
        return 0;
      }
    }
  } finally {
    if (!deferredToSupervision) {
      input.executor.dispose();
    }
    // Escalated: intentionally NOT disposing. dispose() stops the in-process
    // runner and kills its children — an escalated worker is presumed ALIVE
    // (durable=false with a fresh heartbeat is a legitimate long LLM call).
    // The abandoned runner keeps observing the child and still writes the
    // natural exit receipt when the worker eventually exits; supervision
    // (FIX 1) resolves the row sooner if the process is actually dead.
  }
}

function logTerminal(assignment: AssignedWork, snapshot: WorkerRunSnapshot): void {
  engineLog(
    `[dispatch] task=${assignment.taskId} run=${snapshot.status}: `
    + `${snapshot.completed} completed, ${snapshot.failed} failed`
    + `${snapshot.last_error ? `; error=${snapshot.last_error}` : ''}`,
  );
}

function assertAdmission(value: ConcurrencyAdmissionSnapshot): void {
  for (const [name, candidate] of [
    ['operatorConcurrency', value.operatorConcurrency],
    ['effectiveConcurrency', value.effectiveConcurrency],
  ] as const) {
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 10) {
      throw new Error(`${name} must be an integer 1..10, got '${candidate}'`);
    }
  }
  if (value.effectiveConcurrency !== value.operatorConcurrency) {
    throw new Error('effectiveConcurrency must equal operatorConcurrency (one-entry law: the panel concurrency field is the single ceiling)');
  }
  if (!Number.isInteger(value.activeExecutions) || value.activeExecutions < 0) {
    throw new Error(`activeExecutions must be a non-negative integer, got '${value.activeExecutions}'`);
  }
  // C-4: per-model frozen-limit aggregation fields. Legacy in-memory fakes
  // without them still work (undefined is treated as "no per-model rule"),
  // but the durable repository always provides them.
  if (value.requestedModel !== undefined
    && value.requestedModel !== null
    && typeof value.requestedModel !== 'string') {
    throw new Error(`requestedModel must be string|null, got '${String(value.requestedModel)}'`);
  }
  if (value.activeByModel !== undefined) {
    if (!value.activeByModel || typeof value.activeByModel !== 'object'
      || Array.isArray(value.activeByModel)) {
      throw new Error('activeByModel must be an object of model → count');
    }
    for (const [model, count] of Object.entries(value.activeByModel)) {
      if (typeof model !== 'string' || model.length === 0
        || !Number.isInteger(count) || (count as number) < 0) {
        throw new Error(`activeByModel entry '${model}' must be a non-empty model with a non-negative integer count`);
      }
    }
  }
  if (value.requestedModelLimit !== undefined
    && value.requestedModelLimit !== null
    && !Number.isInteger(value.requestedModelLimit)) {
    throw new Error(`requestedModelLimit must be integer|null, got '${String(value.requestedModelLimit)}'`);
  }
  if (value.modelSlotsAvailable !== undefined && typeof value.modelSlotsAvailable !== 'boolean') {
    throw new Error(`modelSlotsAvailable must be boolean, got '${String(value.modelSlotsAvailable)}'`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
