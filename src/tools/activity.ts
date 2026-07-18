import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'activity_log',
    description:
      'View the activity log showing what changed and when. Useful for understanding recent progress or reviewing what happened since the last session.',
    annotations: { title: 'Activity Log', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: ['project', 'epic', 'task', 'subtask', 'note'],
          description: 'Filter by entity type',
        },
        entity_id: { type: 'integer', description: 'Filter by specific entity' },
        action: {
          type: 'string',
          enum: ['created', 'updated', 'deleted', 'status_changed'],
          description: 'Filter by action type',
        },
        since: { type: 'string', description: 'ISO 8601 datetime - show only activity after this time' },
        limit: { type: 'integer', default: 50 },
      },
    },
  },
  {
    name: 'tracker_session_diff',
    description:
      'Show what changed since a given timestamp. Returns aggregated summary with counts by action and entity type, plus highlights of key changes. Call this at the start of a session to understand what happened since the last one.',
    annotations: { title: 'Session Diff', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO 8601 datetime — show changes after this time (e.g. "2026-02-21T15:00:00")',
        },
      },
      required: ['since'],
    },
  },
  {
    name: 'task_batch_update',
    description:
      'Update the PRIORITY of multiple tasks at once. This is a bulk convenience for triage/reprioritization. As of Slice 3 (ADR-011 audit fix), this tool NO LONGER accepts `status` or `assigned_to` — those fields bypass the dispatcher fence, review-verdict flow, verification gates, and integration_state projection, which produced structurally invalid rows (TERMINAL_EXECUTION_OWNS_TASK, BUFFER_WITH_OWNER, etc.). To change lifecycle state, route through the regulated tools: worker_next (claim), worker_done (advance/review), worker_ask_need (park for human), or worker_merge_release (integration). To reassign, use task_update only on unfenced tasks or admin_override_lifecycle for audited recovery.',
    annotations: { title: 'Batch Update Task Priority', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Task IDs to update',
        },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
      required: ['ids', 'priority'],
    },
  },
];

function handleActivityLog(args: Record<string, unknown>) {
  const db = getDb();
  const entityType = args.entity_type as string | undefined;
  const entityId = args.entity_id as number | undefined;
  const action = args.action as string | undefined;
  const since = args.since as string | undefined;
  const limit = (args.limit as number) ?? 50;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (entityType) {
    whereClauses.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId !== undefined) {
    whereClauses.push('entity_id = ?');
    params.push(entityId);
  }
  if (action) {
    whereClauses.push('action = ?');
    params.push(action);
  }
  if (since) {
    whereClauses.push('created_at > ?');
    params.push(since);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM activity_log ${whereStr} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function handleSessionDiff(args: Record<string, unknown>) {
  const db = getDb();
  const since = args.since as string;

  const rows = db
    .prepare('SELECT * FROM activity_log WHERE created_at >= ? ORDER BY created_at ASC')
    .all(since) as Array<Record<string, unknown>>;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Aggregate by action
  const summary: Record<string, number> = { created: 0, updated: 0, status_changed: 0, deleted: 0 };
  // Aggregate by entity_type -> action
  const byEntity: Record<string, Record<string, number>> = {};

  const highlights: string[] = [];

  for (const row of rows) {
    const action = row.action as string;
    const entityType = row.entity_type as string;

    summary[action] = (summary[action] ?? 0) + 1;

    if (!byEntity[entityType]) {
      byEntity[entityType] = { created: 0, updated: 0, status_changed: 0, deleted: 0 };
    }
    byEntity[entityType][action] = (byEntity[entityType][action] ?? 0) + 1;

    // Pick out highlights: status changes, creates, and deletes
    if (action === 'status_changed' || action === 'created' || action === 'deleted') {
      if (row.summary) highlights.push(row.summary as string);
    }
  }

  return {
    since,
    until: now,
    total_changes: rows.length,
    summary,
    by_entity_type: byEntity,
    highlights,
    activity: rows,
  };
}

function handleTaskBatchUpdate(args: Record<string, unknown>) {
  // Slice 3 audit fix (ADR-011): this tool previously accepted status and
  // assigned_to, which let any caller bypass the dispatcher fence, the
  // review-verdict flow, the verification gates, and the integration_state
  // projection. That produced structurally invalid rows
  // (TERMINAL_EXECUTION_OWNS_TASK, BUFFER_WITH_OWNER, etc.) — the exact
  // invariant violations the Slice 0 scanner detects. Lifecycle state now
  // flows only through the regulated tools (worker_next, worker_done,
  // worker_ask_need, worker_merge_release, admin_override_lifecycle).
  //
  // This handler is restricted to PRIORITY only.
  const db = getDb();
  const ids = args.ids as number[];
  const priority = args.priority as string | undefined;

  if (!priority) {
    throw new Error(
      'task_batch_update now accepts only `priority`. Status and assigned_to were removed in Slice 3 ' +
      '(they bypassed the dispatcher fence and verification gates — use worker_next/worker_done/worker_ask_need/admin_override_lifecycle instead).',
    );
  }

  const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');

  const results = db.transaction(() => {
    return ids.map((id) => {
      const oldRow = getStmt.get(id) as Record<string, unknown> | undefined;
      if (!oldRow) throw new Error(`Task ${id} not found`);

      const newRow = db
        .prepare(
          `UPDATE tasks SET priority = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`,
        )
        .get(priority, id) as Record<string, unknown>;

      if (oldRow.priority !== priority) {
        logActivity(
          db, 'task', id, 'updated', 'priority',
          oldRow.priority as string, priority,
          `Task '${newRow.title}' priority: ${oldRow.priority} -> ${priority}`,
        );
      }

      return newRow;
    });
  })();

  return { updated: results.length, tasks: results };
}

export const handlers: Record<string, ToolHandler> = {
  activity_log: handleActivityLog,
  tracker_session_diff: handleSessionDiff,
  task_batch_update: handleTaskBatchUpdate,
};
