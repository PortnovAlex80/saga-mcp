/**
 * Atomic bridge between Saga 3 control state and the existing runtime/tracker
 * projections.
 *
 * The control tables remain authoritative for intent/assignment/condition.
 * worker_executions records OS process truth. tasks is a compatibility read
 * model for tracker-view. All three are advanced together at the two runtime
 * boundaries (process started, process exited), so the UI cannot observe a
 * worker without its assignment or a fenced task without its execution.
 */

import os from 'node:os';
import type Database from 'better-sqlite3';
import type { ConditionStatus } from '../../domain/types.js';

export interface RuntimeAttemptStart {
  readonly executionId: string;
  readonly runId: string;
  readonly projectId: number;
  readonly epicId: number;
  readonly taskId: number;
  readonly workerId: string;
  readonly pid: number | null;
  readonly logFile: string;
  readonly assignmentId: string;
  readonly workIntentId: string;
  readonly conditionType: string;
  readonly obligationId: string;
}

export interface RuntimeAttemptFinish {
  readonly executionId: string;
  readonly taskId: number;
  readonly assignmentId: string;
  readonly workIntentId: string;
  readonly processExitCode: number;
  readonly conditionStatus: ConditionStatus | null;
}

export class SqliteRuntimeCoordinator {
  constructor(private readonly db: Database.Database) {}

  startAttempt(input: RuntimeAttemptStart): void {
    this.db.transaction(() => {
      // A process left active by a crashed engine is historical truth, not a
      // current owner. Retire it before acquiring the task fence.
      this.db.prepare(
        `UPDATE worker_executions
            SET state='lost',
                finished_at=datetime('now'),
                last_error='superseded by a new Saga 3 attempt'
          WHERE task_id=?
            AND state IN ('reserved','running','cancel_requested')`,
      ).run(input.taskId);

      this.db.prepare(
        `UPDATE tasks
            SET assigned_to=NULL,
                current_execution_id=NULL,
                updated_at=datetime('now')
          WHERE id=?
            AND current_execution_id IS NOT NULL`,
      ).run(input.taskId);

      this.db.prepare(
        `INSERT INTO worker_executions
           (execution_id, run_id, project_id, epic_id, task_id, worker_id,
            machine_id, launcher, state, phase, pid, log_path, reserved_at,
            started_at, metadata)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),?)`,
      ).run(
        input.executionId,
        input.runId,
        input.projectId,
        input.epicId,
        input.taskId,
        input.workerId,
        os.hostname(),
        'saga3-cli',
        'running',
        'executing',
        input.pid,
        input.logFile,
        JSON.stringify({
          condition_type: input.conditionType,
          obligation_id: input.obligationId,
        }),
      );

      const taskWrite = this.db.prepare(
        `UPDATE tasks
            SET status='in_progress',
                assigned_to=?,
                current_execution_id=?,
                updated_at=datetime('now')
          WHERE id=?
            AND current_execution_id IS NULL`,
      ).run(input.workerId, input.executionId, input.taskId);
      if (taskWrite.changes !== 1) {
        throw new Error(`Task ${input.taskId} could not acquire execution fence.`);
      }

      this.db.prepare(
        `UPDATE saga3_worker_assignments
            SET state='lost', updated_at=datetime('now')
          WHERE work_intent_id=?
            AND id<>?
            AND state IN ('pending','running','submitted')`,
      ).run(input.workIntentId, input.assignmentId);

      const assignmentWrite = this.db.prepare(
        `UPDATE saga3_worker_assignments
            SET worker_id=?,
                execution_id=?,
                state='running',
                updated_at=datetime('now')
          WHERE id=?
            AND state='pending'`,
      ).run(input.workerId, input.executionId, input.assignmentId);
      if (assignmentWrite.changes !== 1) {
        throw new Error(`Assignment ${input.assignmentId} is no longer pending.`);
      }

      this.db.prepare(
        `UPDATE saga3_work_intents
            SET status='assigned', updated_at=datetime('now')
          WHERE id=?
            AND status IN ('materialized','admitted')`,
      ).run(input.workIntentId);
    })();
  }

  finishAttempt(input: RuntimeAttemptFinish): void {
    const accepted = input.conditionStatus === 'True';
    const taskStatus = accepted ? 'done' : 'blocked';
    const diagnostic = input.conditionStatus === null
      ? 'worker exited without a committed condition observation'
      : input.conditionStatus === 'Unknown'
        ? 'oracle did not produce conclusive evidence'
        : input.conditionStatus === 'False'
          ? 'oracle rejected the proposed result'
          : null;

    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE worker_executions
            SET state='exited',
                phase='finishing',
                finished_at=datetime('now'),
                exit_code=?,
                last_error=?
          WHERE execution_id=?
            AND state IN ('reserved','running','cancel_requested')`,
      ).run(input.processExitCode, diagnostic, input.executionId);

      // Fence the projection update: a late process cannot release or rewrite
      // a task already owned by a newer execution.
      this.db.prepare(
        `UPDATE tasks
            SET status=?,
                assigned_to=NULL,
                current_execution_id=NULL,
                updated_at=datetime('now')
          WHERE id=?
            AND current_execution_id=?`,
      ).run(taskStatus, input.taskId, input.executionId);

      this.db.prepare(
        `UPDATE saga3_worker_assignments
            SET state=?, updated_at=datetime('now')
          WHERE id=?
            AND state IN ('pending','running','submitted')`,
      ).run(accepted ? 'verified' : 'failed', input.assignmentId);

      this.db.prepare(
        `UPDATE saga3_work_intents
            SET status=?, updated_at=datetime('now')
          WHERE id=?
            AND status IN ('materialized','admitted','assigned')`,
      ).run(accepted ? 'completed' : 'failed', input.workIntentId);
    })();
  }

  abandonAuthorizedAttempt(input: {
    readonly assignmentId: string;
    readonly workIntentId: string;
  }): void {
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE saga3_worker_assignments
            SET state='failed', updated_at=datetime('now')
          WHERE id=?
            AND state='pending'`,
      ).run(input.assignmentId);
      this.db.prepare(
        `UPDATE saga3_work_intents
            SET status='failed', updated_at=datetime('now')
          WHERE id=?
            AND status IN ('materialized','admitted')`,
      ).run(input.workIntentId);
    })();
  }
}
