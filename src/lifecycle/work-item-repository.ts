/**
 * Work-item repository — CRUD over task_work_items + work_attempts.
 *
 * Source: blueprint §17 WP-4 (docs/architecture/passive-worker-kernel-blueprint.md:993-1006),
 *         §14 schema (line 685-726), §16 Slice 2 (line 847-869).
 *
 * Role: low-level storage adapter for the work-item shadow model. Reads and
 * writes the two shadow tables; performs NO business logic. The compatibility
 * projector (compatibility-projector.ts) and the backfill migration use this
 * repository. The command bus (Slice 3+) will write through it too.
 *
 * In Slice 2 these tables are SHADOW — old task columns remain authoritative.
 * This repository is used to populate the shadow and to run the equivalence
 * comparison; it is not yet on the write path of any lifecycle command.
 *
 * SQL lives here (and in migrations/projectors). Pure domain code in
 * src/lifecycle/domain/ never imports from this file.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Row types.
// ---------------------------------------------------------------------------

export type WorkItemKind =
  | 'implementation'
  | 'review'
  | 'verification'
  | 'integration'
  | 'human_decision'
  | 'cleanup';

export type WorkItemState =
  | 'pending'
  | 'ready'
  | 'active'
  | 'waiting'
  | 'completed'
  | 'cancelled';

export type WorkAttemptState =
  | 'reserved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'lost'
  | 'cancelled';

export interface WorkItemRow {
  readonly work_item_id: string;
  readonly task_id: number;
  readonly kind: WorkItemKind;
  readonly cycle_no: number;
  readonly item_no: number;
  readonly state: WorkItemState;
  readonly outcome: string | null;
  readonly predecessor_item_id: string | null;
  readonly required: number;
  readonly input_snapshot_json: string;
  readonly result_json: string | null;
  readonly version: number;
  readonly history_complete: number; // 0 or 1
  readonly created_at: string;
  readonly completed_at: string | null;
}

export interface WorkAttemptRow {
  readonly attempt_id: string;
  readonly work_item_id: string;
  readonly ordinal: number;
  readonly state: WorkAttemptState;
  readonly worker_id: string | null;
  readonly execution_id: string | null;
  readonly command_id: string | null;
  readonly outcome: string | null;
  readonly result_json: string | null;
  readonly reserved_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly last_error: string | null;
}

// ---------------------------------------------------------------------------
// Insert shapes.
// ---------------------------------------------------------------------------

export interface NewWorkItem {
  readonly work_item_id: string;
  readonly task_id: number;
  readonly kind: WorkItemKind;
  readonly cycle_no: number;
  readonly item_no?: number;
  readonly state: WorkItemState;
  readonly outcome?: string | null;
  readonly predecessor_item_id?: string | null;
  readonly required?: number;
  readonly input_snapshot_json?: string;
  readonly result_json?: string | null;
  readonly history_complete?: boolean;
}

export interface NewWorkAttempt {
  readonly attempt_id: string;
  readonly work_item_id: string;
  readonly ordinal: number;
  readonly state: WorkAttemptState;
  readonly worker_id?: string | null;
  readonly execution_id?: string | null;
  readonly command_id?: string | null;
  readonly outcome?: string | null;
  readonly result_json?: string | null;
  readonly started_at?: string | null;
  readonly finished_at?: string | null;
  readonly last_error?: string | null;
}

// ---------------------------------------------------------------------------
// Repository.
// ---------------------------------------------------------------------------

export class WorkItemRepository {
  constructor(private readonly db: Database) {}

  // --- Work items ----------------------------------------------------------

  insertWorkItem(item: NewWorkItem): WorkItemRow {
    this.db
      .prepare(
        `INSERT INTO task_work_items
           (work_item_id, task_id, kind, cycle_no, item_no, state, outcome,
            predecessor_item_id, required, input_snapshot_json, result_json,
            version, history_complete)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        item.work_item_id,
        item.task_id,
        item.kind,
        item.cycle_no,
        item.item_no ?? 1,
        item.state,
        item.outcome ?? null,
        item.predecessor_item_id ?? null,
        item.required ?? 1,
        item.input_snapshot_json ?? '{}',
        item.result_json ?? null,
        item.history_complete === false ? 0 : 1,
      );
    return this.getWorkItem(item.work_item_id)!;
  }

  getWorkItem(workItemId: string): WorkItemRow | null {
    return (this.db
      .prepare('SELECT * FROM task_work_items WHERE work_item_id = ?')
      .get(workItemId) as WorkItemRow | undefined) ?? null;
  }

  listWorkItemsForTask(taskId: number): WorkItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_work_items
          WHERE task_id = ?
          ORDER BY cycle_no, item_no, created_at`,
      )
      .all(taskId) as WorkItemRow[];
  }

  /** The single work item currently driving the task board state. */
  getCurrentWorkItem(taskId: number): WorkItemRow | null {
    // Active item wins; otherwise the most recent ready/waiting; otherwise
    // the most recent item overall.
    const rows = this.listWorkItemsForTask(taskId);
    if (rows.length === 0) return null;
    const active = rows.find((r) => r.state === 'active');
    if (active) return active;
    const ready = rows
      .filter((r) => r.state === 'ready' || r.state === 'waiting')
      .slice(-1)[0];
    if (ready) return ready;
    return rows[rows.length - 1]!;
  }

  updateWorkItemState(
    workItemId: string,
    newState: WorkItemState,
    outcome?: string | null,
    resultJson?: string | null,
  ): void {
    const sets: string[] = ['state = ?', 'version = version + 1'];
    const params: Array<unknown> = [newState];
    if (outcome !== undefined) {
      sets.push('outcome = ?');
      params.push(outcome);
    }
    if (resultJson !== undefined) {
      sets.push('result_json = ?');
      params.push(resultJson);
    }
    if (newState === 'completed' || newState === 'cancelled') {
      sets.push("completed_at = datetime('now')");
    }
    params.push(workItemId);
    this.db
      .prepare(`UPDATE task_work_items SET ${sets.join(', ')} WHERE work_item_id = ?`)
      .run(...params);
  }

  /**
   * Delete all shadow rows for a task. Used by tests for cleanup; not used
   * in production (cascade on tasks.id handles it).
   */
  clearTaskShadow(taskId: number): void {
    this.db.prepare('DELETE FROM task_work_items WHERE task_id = ?').run(taskId);
  }

  // --- Work attempts -------------------------------------------------------

  insertWorkAttempt(attempt: NewWorkAttempt): WorkAttemptRow {
    this.db
      .prepare(
        `INSERT INTO work_attempts
           (attempt_id, work_item_id, ordinal, state, worker_id, execution_id,
            command_id, outcome, result_json, started_at, finished_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.attempt_id,
        attempt.work_item_id,
        attempt.ordinal,
        attempt.state,
        attempt.worker_id ?? null,
        attempt.execution_id ?? null,
        attempt.command_id ?? null,
        attempt.outcome ?? null,
        attempt.result_json ?? null,
        attempt.started_at ?? null,
        attempt.finished_at ?? null,
        attempt.last_error ?? null,
      );
    return this.getWorkAttempt(attempt.attempt_id)!;
  }

  getWorkAttempt(attemptId: string): WorkAttemptRow | null {
    return (this.db
      .prepare('SELECT * FROM work_attempts WHERE attempt_id = ?')
      .get(attemptId) as WorkAttemptRow | undefined) ?? null;
  }

  listAttemptsForItem(workItemId: string): WorkAttemptRow[] {
    return this.db
      .prepare(
        'SELECT * FROM work_attempts WHERE work_item_id = ? ORDER BY ordinal',
      )
      .all(workItemId) as WorkAttemptRow[];
  }

  listAttemptsForTask(taskId: number): Array<WorkAttemptRow & { kind: WorkItemKind }> {
    return this.db
      .prepare(
        `SELECT a.*, wi.kind AS kind
           FROM work_attempts a
           JOIN task_work_items wi ON wi.work_item_id = a.work_item_id
          WHERE wi.task_id = ?
          ORDER BY wi.cycle_no, wi.item_no, a.ordinal`,
      )
      .all(taskId) as Array<WorkAttemptRow & { kind: WorkItemKind }>;
  }

  updateAttemptState(
    attemptId: string,
    newState: WorkAttemptState,
    patch?: { outcome?: string | null; resultJson?: string | null; lastError?: string | null; finishedAt?: string | null },
  ): void {
    const sets: string[] = ['state = ?'];
    const params: Array<unknown> = [newState];
    if (patch?.outcome !== undefined) {
      sets.push('outcome = ?');
      params.push(patch.outcome);
    }
    if (patch?.resultJson !== undefined) {
      sets.push('result_json = ?');
      params.push(patch.resultJson);
    }
    if (patch?.lastError !== undefined) {
      sets.push('last_error = ?');
      params.push(patch.lastError);
    }
    if (patch?.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      params.push(patch.finishedAt);
    } else if (newState === 'succeeded' || newState === 'failed' || newState === 'lost' || newState === 'cancelled') {
      sets.push("finished_at = datetime('now')");
    }
    params.push(attemptId);
    this.db
      .prepare(`UPDATE work_attempts SET ${sets.join(', ')} WHERE attempt_id = ?`)
      .run(...params);
  }

  // --- Bulk stats ----------------------------------------------------------

  /**
   * Count tasks in a project that have shadow rows. Used by the migration
   * to know how many tasks still need backfill.
   */
  countShadowedTasks(projectId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT wi.task_id) AS c
           FROM task_work_items wi
           JOIN tasks t ON t.id = wi.task_id
           JOIN epics e ON e.id = t.epic_id
          WHERE e.project_id = ?`,
      )
      .get(projectId) as { c: number } | undefined;
    return row?.c ?? 0;
  }
}
