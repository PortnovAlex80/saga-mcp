/**
 * SQLite adapter for WorkAssignmentPort — the conveyor-physics seam.
 *
 * assignTask() atomically selects a claimable card, flips its status, sets the
 * fence (current_execution_id), and inserts the worker_executions row with the
 * frozen execution context — all in ONE IMMEDIATE transaction, BEFORE the worker
 * process is spawned. This closes the race window that existed when the dispatch
 * loop only *suggested* a candidate (claimScope.taskIds) and the real claim
 * happened later inside the runner's pump() → worker_next.
 *
 * The SELECT/UPDATE/INSERT logic is the EXACT same code path as the worker_next
 * MCP tool (src/tools/dispatcher.ts findNextClaimable). We delegate to that
 * proven-correct function rather than duplicating the SQL, so the dispatcher-race
 * test suite (tests/dispatcher-race/*) covers both paths. The two paths diverge
 * only in how they surface the result: worker_next returns an MCP-shaped object,
 * assignTask returns a typed AssignedWork for the runner to consume directly.
 *
 * See docs/architecture/WORK-ASSIGNMENT-REFACTOR-SPEC.md §2 (target contracts).
 */

import type Database from 'better-sqlite3';
import type {
  AssignTaskInput,
  AssignedWork,
  WorkAssignmentPort,
} from '../../application/ports/worker-executor.js';
import { reserveTaskExecution } from '../../tools/conveyor-runtime-helper.js';
// CONVEYOR #7: the adapter imports the atomic assignment core from the
// lifecycle layer (infrastructure-side), NOT from the MCP/tool layer. This
// keeps the dependency direction inward: outbound adapter → lifecycle core.
import {
  buildAssignedWorkFromClaim,
  findNextClaimable,
  withImmediateTransaction,
} from '../../lifecycle/work-assignment-core.js';
import { releaseExecutionAtomically } from '../../lifecycle/atomic-release.js';

export class SqliteWorkAssignmentAdapter implements WorkAssignmentPort {
  constructor(private readonly db: Database.Database) {}

  assignTask(input: AssignTaskInput): AssignedWork | null {
    const reservation = {
      executionId: input.workerExecutionId,
      runId: input.runId,
      machineId: input.machineId,
    };
    // One IMMEDIATE transaction: SELECT (with all gates) + conditional UPDATE
    // (status flip + assigned_to + current_execution_id) + INSERT
    // worker_executions (frozen execution_context). This is the same atomic
    // boundary findNextClaimable uses under worker_next — proven by
    // tests/dispatcher-race/run.mjs (N concurrent workers, no double-claim).
    const task = withImmediateTransaction(this.db, () =>
      findNextClaimable(
        this.db,
        input.workerId,
        input.projectId,
        undefined,
        0,
        input.role,
        input.epicId,
        reservation,
        input.taskIds,
      ),
    );
    if (!task) return null;
    // Conveyor v4: bind the task to its workplace + lease the loop channel.
    // This is the engine-path equivalent of reserveTaskExecution in the MCP
    // dispatcher. The workplace becomes authoritative for the loop state.
    try {
      reserveTaskExecution(this.db, {
        taskId: task.id,
        epicId: task.epic_id,
        projectId: input.projectId,
        taskKind: task.task_kind,
        metadata: task.metadata,
        executionId: input.workerExecutionId,
        preClaimStatus: task.status === 'in_progress' ? 'todo' : task.status,
      });
    } catch { /* best-effort v4 binding */ }
    // The claim is committed (card assigned + execution reserved). The snapshot
    // build below reads repository bindings + execution context AFTER the
    // transaction. If it throws (e.g. a dangling project_repository_id, a
    // malformed execution_context), we MUST release the assignment so the card
    // is not left fenced by a zombie reservation that no worker will ever own.
    // This is the #3 review fix: build failure → fenced release, not a leak.
    try {
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
        // Best-effort release; the original build error is the actionable one.
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
    // releaseExecutionAtomically is idempotent and terminalizes the execution
    // + returns the card to the queue (todo/review) when this execution still
    // owns the fence. If a newer execution already took over, it terminalizes
    // only — safe. Used when a worker spawn fails after assignment.
    releaseExecutionAtomically(this.db, {
      executionId: input.workerExecutionId,
      terminalState: 'spawn_failed',
      reason: input.reason,
    });
  }
}

/**
 * Factory: builds an adapter over the global saga DB. Convenience for the
 * composition root; tests inject a db directly via the constructor.
 */
export function createSqliteWorkAssignmentAdapter(
  getDb: () => Database.Database,
): WorkAssignmentPort {
  return {
    assignTask: (input) => new SqliteWorkAssignmentAdapter(getDb()).assignTask(input),
    countClaimable: (projectId) => new SqliteWorkAssignmentAdapter(getDb()).countClaimable(projectId),
    releaseAssignment: (input) =>
      new SqliteWorkAssignmentAdapter(getDb()).releaseAssignment(input),
  };
}
