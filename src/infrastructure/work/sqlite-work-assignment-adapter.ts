/**
 * SQLite adapter for WorkAssignmentPort — the conveyor-physics seam.
 *
 * Claim/fence creation stays in the existing immediate transaction. Before the
 * worker process is returned to the host, the adapter freezes one additional
 * immutable fact: the exact replay key and, on a hit, the exact certified
 * capsule. No worker exists yet, so the resulting execution context is the
 * only context ever observed by spawn/MCP/provenance.
 */

import type Database from 'better-sqlite3';
import type {
  AssignTaskInput,
  AssignedWork,
  WorkAssignmentPort,
} from '../../application/ports/worker-executor.js';
import type { WorkerExecutionRoute } from '../../application/routing/worker-execution-route.js';
import { reserveTaskExecution } from '../../tools/conveyor-runtime-helper.js';
import {
  buildAssignedWorkFromClaim,
  findNextClaimable,
  withImmediateTransaction,
} from '../../lifecycle/work-assignment-core.js';
import { releaseExecutionAtomically } from '../../lifecycle/atomic-release.js';
import { bindReplayToClaim } from '../replay/replay-claim-binder.js';
import { withBusyRetry } from '../../runtime/busy-retry.js';
import { SqliteScopeWideningLedger } from '../workplace/sqlite-scope-widening-ledger.js';

export type RouteResolverFn = (key: {
  module: string | null;
  cell: string | null;
  role: 'author' | 'reviewer' | null;
  executionProfile: string | null;
}) => WorkerExecutionRoute;

export class SqliteWorkAssignmentAdapter implements WorkAssignmentPort {
  constructor(
    private readonly db: Database.Database,
    private readonly routeResolver?: RouteResolverFn,
  ) {}

  assignTask(input: AssignTaskInput): AssignedWork | null {
    const reservation = {
      executionId: input.workerExecutionId,
      runId: input.runId,
      machineId: input.machineId,
    };
    // Antifreeze B3: the claim is a BEGIN IMMEDIATE on the shared main
    // connection and runs per card in the dispatch drain — the hottest engine
    // write. Bounded busy-retry; a final ENGINE_DB_BUSY is classified
    // recoverable by the dispatch loop (card_error valve) instead of
    // busy-spinning the main thread for the full busy_timeout (TB-2 class).
    const task = withBusyRetry(
      () => withImmediateTransaction(this.db, () => {
        const claimed = findNextClaimable(
          this.db,
          input.workerId,
          input.projectId,
          undefined,
          0,
          input.role,
          input.epicId,
          reservation,
          input.taskIds,
          this.routeResolver,
          input.excludeTaskIds,
          // STAGE-18 R1: resolve the task's effective write authority inside
          // the claim transaction and attach it to the claimed card — the
          // same ledger read every scope fence consults, so a worker staffed
          // after a grant sees the widened set, not the stale carve.
          (taskId, originalScopes) => new SqliteScopeWideningLedger(this.db)
            .readEffectiveChangeScopes(taskId, originalScopes),
        );
        if (claimed) {
          reserveTaskExecution(this.db, {
            taskId: claimed.id,
            epicId: claimed.epic_id,
            projectId: input.projectId,
            taskKind: claimed.task_kind,
            metadata: claimed.metadata,
            executionId: input.workerExecutionId,
            preClaimStatus: claimed.status === 'in_progress' ? 'todo' : 'review',
          });
        }
        return claimed;
      }),
      { db: this.db },
    );
    if (!task) return null;

    try {
      // Replay-first is a property of every normal factory assignment, not a
      // test mode. Missing capsule = ordinary selected-model execution.
      // Antifreeze B3: the capsule schema-ensure + certification are writes on
      // the same shared connection — same bounded busy-retry window.
      withBusyRetry(() => bindReplayToClaim(this.db, {
        task,
        executionId: input.workerExecutionId,
        role: task.status === 'review_in_progress' ? 'reviewer' : 'author',
      }), { db: this.db });

      return buildAssignedWorkFromClaim({
        db: this.db,
        task,
        projectId: input.projectId,
        workerExecutionId: input.workerExecutionId,
        runId: input.runId,
        workerId: input.workerId,
        machineId: input.machineId,
      });
    } catch (buildError) {
      try {
        this.releaseAssignment({
          taskId: task.id,
          workerExecutionId: input.workerExecutionId,
          reason: `AssignedWork build failed: ${buildError instanceof Error ? buildError.message : String(buildError)}`,
        });
      } catch {
        // Best effort. The original error remains the actionable one.
      }
      // Attach the card identity so the dispatch loop can poison exactly this
      // card for the rest of the drain (typed dispatch outcomes, plan item
      // 19). Best effort — non-annotatable throwables simply carry no taskId
      // and fall back to the drain-level unresolved-error valve.
      if (typeof buildError === 'object' && buildError !== null) {
        try {
          (buildError as { taskId?: number }).taskId = task.id;
        } catch { /* frozen/read-only throwable */ }
      }
      throw buildError;
    }
  }

  countClaimable(projectId: number): number {
    const row = this.db.prepare(
      `SELECT count(*) as n
         FROM tasks t JOIN epics e ON e.id = t.epic_id
        WHERE e.project_id = ? AND t.status IN ('todo','review')
          AND (t.assigned_to IS NULL OR t.assigned_to = '')`,
    ).get(projectId) as { n: number };
    return row.n;
  }

  releaseAssignment(input: {
    taskId: number;
    workerExecutionId: string;
    reason: string;
  }): void {
    releaseExecutionAtomically(this.db, {
      executionId: input.workerExecutionId,
      terminalState: 'spawn_failed',
      reason: input.reason,
    });
  }
}

export function createSqliteWorkAssignmentAdapter(
  getDb: () => Database.Database,
  routeResolver?: RouteResolverFn,
): WorkAssignmentPort {
  return {
    assignTask: input => new SqliteWorkAssignmentAdapter(getDb(), routeResolver).assignTask(input),
    countClaimable: projectId => new SqliteWorkAssignmentAdapter(getDb(), routeResolver).countClaimable(projectId),
    releaseAssignment: input =>
      new SqliteWorkAssignmentAdapter(getDb(), routeResolver).releaseAssignment(input),
  };
}
