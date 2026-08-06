import type { Database } from 'better-sqlite3';
import { readAcceptedWorkerDoneReceipt } from '../../../lifecycle/worker-done-receipt.js';
import type { LmNodeExecutionPersistence } from './lm-node-executor.js';

/**
 * Decorate the board persistence projection with exact execution completion.
 *
 * The LM poll-loop remains unchanged. For a task whose exact execution has an
 * accepted worker_done receipt, this adapter exposes a poll-terminal status
 * instead of a later Workplace reverse projection such as
 * in_progress/verifying. It also suppresses the PID-dead guard for that exact
 * completed execution while the runner close callback catches up.
 */
export function receiptAwareLmPersistence(
  base: LmNodeExecutionPersistence,
  db: Database,
): LmNodeExecutionPersistence {
  return {
    ...base,

    readTaskState(taskId) {
      const executionId = base.readCurrentExecutionId(taskId)
        ?? base.readLatestExecutionId(taskId);
      const completion = readAcceptedWorkerDoneReceipt(db, executionId);
      if (!completion) return base.readTaskState(taskId);

      // The poll-loop understands done, review and blocked as terminal signals.
      // An accepted changes_requested reply stores task.status=todo; expose it
      // as review only to the poll-loop so the node returns runtime.paused
      // rather than the false task_unclaimed/runtime.failed branch. The durable
      // task row remains todo.
      return completion.completedNewStatus === 'todo'
        ? 'review'
        : completion.completedNewStatus;
    },

    readExecutionLiveness(executionId) {
      // worker_done is stronger than the lagging OS/runner observation. The
      // process may have exited a few milliseconds before Node delivers its
      // close callback; reporting a terminal execution here prevents that tiny
      // window from being misclassified as executor_dead.
      if (readAcceptedWorkerDoneReceipt(db, executionId)) {
        return { pid: null, state: 'exited' };
      }
      return base.readExecutionLiveness?.(executionId) ?? null;
    },
  };
}
