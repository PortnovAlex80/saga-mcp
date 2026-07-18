/**
 * Invariant scanner — read-only DB classifier.
 *
 * Source: blueprint §16 Slice 0 (docs/architecture/passive-worker-kernel-blueprint.md:815-827).
 *
 * Acceptance (blueprint §16:825-827):
 *   - current databases can be classified as valid managed, valid legacy,
 *     or a named invariant violation;
 *   - every current lifecycle transition has a characterization test (oracle).
 *
 * Architecture: this is the *shell* side of functional-core/imperative-shell.
 * It reads SQLite rows, builds a `TaskSnapshot`, and delegates to the pure
 * `decodeManagedState`. SQL exists only here and in projectors (blueprint
 * §20:1145 — "SQL exists only in infrastructure stores/projectors and migrations").
 *
 * The scanner performs only SELECTs. It never mutates.
 */

import type { Database } from 'better-sqlite3';
import {
  decodeManagedState,
  type TaskSnapshot,
  type TaskRow,
  type ExecutionRow,
  type IntegrationRow,
  type HumanRequestRow,
} from './domain/decode.js';
import type { InvariantCode } from './domain/state.js';

// ---------------------------------------------------------------------------
// Public result types.
// ---------------------------------------------------------------------------

export type TaskClassification =
  | { readonly kind: 'valid_managed'; readonly taskId: number }
  | { readonly kind: 'valid_legacy'; readonly taskId: number; readonly reason: string }
  | {
      readonly kind: 'named_violation';
      readonly taskId: number;
      readonly code: InvariantCode;
      readonly detail: string;
    };

export interface ScanReport {
  readonly projectId: number;
  readonly epicId?: number;
  readonly scannedAt: string;
  readonly totalTasks: number;
  readonly validManaged: number;
  readonly validLegacy: number;
  readonly violations: number;
  readonly results: readonly TaskClassification[];
}

// ---------------------------------------------------------------------------
// Active-execution state set (mirrors worker-executions.ts:6).
// ---------------------------------------------------------------------------

const ACTIVE_EXECUTION_STATES_SQL = "'reserved','running','cancel_requested'";

// ---------------------------------------------------------------------------
// Scanner.
// ---------------------------------------------------------------------------

/**
 * Scan all tasks in a project (optionally narrowed to one epic) and classify
 * each. Read-only.
 *
 * @param db opened by the caller; never closed here.
 * @param projectId scope.
 * @param epicId optional epic narrowing.
 */
export function scanProject(
  db: Database,
  projectId: number,
  epicId?: number,
): ScanReport {
  const epicClause = epicId === undefined ? '' : 'AND t.epic_id = ?';
  const params: Array<unknown> = epicId === undefined ? [projectId] : [projectId, epicId];

  const taskRows = db
    .prepare(
      `SELECT
         t.id, t.status, t.assigned_to, t.current_execution_id,
         t.integration_state, t.tags, t.task_kind, t.execution_mode
       FROM tasks t
       JOIN epics e ON e.id = t.epic_id
       WHERE e.project_id = ? ${epicClause}
       ORDER BY t.id`,
    )
    .all(...params) as Array<Omit<TaskRow, 'tags'> & { tags: string | null }>;

  const results: TaskClassification[] = [];
  let validManaged = 0;
  let validLegacy = 0;
  let violations = 0;

  for (const row of taskRows) {
    const taskRow: TaskRow = {
      id: row.id,
      status: row.status,
      assigned_to: row.assigned_to,
      current_execution_id: row.current_execution_id,
      integration_state: row.integration_state,
      tags: parseTags(row.tags),
      task_kind: row.task_kind,
      execution_mode: row.execution_mode,
    };

    // Legacy tasks: pre-ADR-009, no current_execution_id fence even when
    // active. The decoder treats these as violations (ACTIVE_WITHOUT_EXECUTION);
    // the scanner reclassifies them as `valid_legacy` because they predate
    // the managed lifecycle.
    const isLegacyActive =
      (taskRow.status === 'in_progress' || taskRow.status === 'review_in_progress') &&
      taskRow.current_execution_id === null;

    const execution = loadExecution(db, taskRow);
    const integration = loadIntegration(db, taskRow);
    const humanRequest = loadHumanRequest(db, taskRow);

    const snapshot: TaskSnapshot = { task: taskRow, execution, integration, humanRequest };
    const decoded = decodeManagedState(snapshot);

    if (decoded.kind === 'valid') {
      results.push({ kind: 'valid_managed', taskId: taskRow.id });
      validManaged += 1;
      continue;
    }

    // Violation. If it is the legacy-active signature, reclassify.
    if (isLegacyActive && decoded.code === 'ACTIVE_WITHOUT_EXECUTION') {
      results.push({
        kind: 'valid_legacy',
        taskId: taskRow.id,
        reason: 'pre-ADR-009 assignment without execution fence',
      });
      validLegacy += 1;
      continue;
    }

    results.push({
      kind: 'named_violation',
      taskId: taskRow.id,
      code: decoded.code,
      detail: decoded.detail,
    });
    violations += 1;
  }

  return {
    projectId,
    epicId,
    scannedAt: new Date().toISOString(),
    totalTasks: taskRows.length,
    validManaged,
    validLegacy,
    violations,
    results,
  };
}

/**
 * Classify a single task. Useful for one-off diagnostics.
 */
export function classifyTask(db: Database, taskId: number): TaskClassification {
  const row = db
    .prepare(
      `SELECT t.id, t.status, t.assigned_to, t.current_execution_id,
              t.integration_state, t.tags, t.task_kind, t.execution_mode
       FROM tasks t WHERE t.id = ?`,
    )
    .get(taskId) as (Omit<TaskRow, 'tags'> & { tags: string | null }) | undefined;

  if (!row) {
    return {
      kind: 'named_violation',
      taskId,
      code: 'ACTIVE_WITHOUT_OWNER',
      detail: `task ${taskId} not found`,
    };
  }

  const taskRow: TaskRow = {
    id: row.id,
    status: row.status,
    assigned_to: row.assigned_to,
    current_execution_id: row.current_execution_id,
    integration_state: row.integration_state,
    tags: parseTags(row.tags),
    task_kind: row.task_kind,
    execution_mode: row.execution_mode,
  };

  const isLegacyActive =
    (taskRow.status === 'in_progress' || taskRow.status === 'review_in_progress') &&
    taskRow.current_execution_id === null;

  const execution = loadExecution(db, taskRow);
  const integration = loadIntegration(db, taskRow);
  const humanRequest = loadHumanRequest(db, taskRow);

  const decoded = decodeManagedState({ task: taskRow, execution, integration, humanRequest });

  if (decoded.kind === 'valid') {
    return { kind: 'valid_managed', taskId };
  }
  if (isLegacyActive && decoded.code === 'ACTIVE_WITHOUT_EXECUTION') {
    return { kind: 'valid_legacy', taskId, reason: 'pre-ADR-009 assignment without execution fence' };
  }
  return { kind: 'named_violation', taskId, code: decoded.code, detail: decoded.detail };
}

// ---------------------------------------------------------------------------
// Helpers — narrow read queries.
// ---------------------------------------------------------------------------

function parseTags(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function loadExecution(db: Database, task: TaskRow): ExecutionRow | null {
  if (!task.current_execution_id) return null;
  const row = db
    .prepare(
      `SELECT execution_id, task_id, state, phase, worker_id
       FROM worker_executions
       WHERE execution_id = ? OR (task_id = ? AND state IN (${ACTIVE_EXECUTION_STATES_SQL}))
       ORDER BY CASE WHEN execution_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(task.current_execution_id, task.id, task.current_execution_id) as
    | { execution_id: string; task_id: number; state: string; phase: string | null; worker_id: string }
    | undefined;
  return row ?? null;
}

function loadIntegration(db: Database, _task: TaskRow): IntegrationRow | null {
  // Slice 0: integration_rows table does not yet exist (Slice 5 adds it).
  // We surface an integration row ONLY when there is explicit intent metadata
  // ($.integration.id). A bare `done + pending` column combination without
  // intent is reported as DONE_PENDING_WITHOUT_INTEGRATION_INTENT (the audit
  // seam), not silently synthesized into a valid awaiting_integration state.
  // This keeps the scanner faithful to the audit's central finding.
  const meta = db
    .prepare(
      `SELECT json_extract(metadata, '$.integration.id') AS integration_id,
              json_extract(metadata, '$.worktree.merged_into') AS merged_into,
              json_extract(metadata, '$.worktree.branch') AS worktree_branch
       FROM tasks WHERE id = ?`,
    )
    .get(_task.id) as
    | { integration_id: string | null; merged_into: string | null; worktree_branch: string | null }
    | undefined;

  if (!meta) return null;

  // Only synthesize when there is concrete intent metadata. Without it, the
  // decoder will report the violation.
  if (!meta.integration_id && !meta.worktree_branch) return null;

  if (_task.integration_state === 'pending' || _task.integration_state === 'conflict') {
    const integrationId = meta.integration_id ?? `synthetic-${_task.id}`;
    const state =
      _task.integration_state === 'conflict'
        ? 'conflict'
        : 'ready';
    return { integration_id: integrationId, task_id: _task.id, state, executor_execution_id: null };
  }
  return null;
}

function loadHumanRequest(db: Database, task: TaskRow): HumanRequestRow | null {
  // Slice 0: human_requests table does not yet exist (Slice 3 adds it).
  // The decoder detects waiting_human via the task needs-human tag, not via
  // this row, so returning null here is correct for Slice 0. The slot exists
  // so Slice 3 can replace this with a real SELECT without touching callers.
  void db;
  void task;
  return null;
}
