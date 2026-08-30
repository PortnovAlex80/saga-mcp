import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { getRun, tailEvents } from '../events.js';
import type { ToolHandler } from '../types.js';

// M0 kernel surface: read-only observation of runs and the event log.
// The interpreting kernel (graph execution) arrives in M1; until then these
// tools make the kernel tables visible and testable through MCP.

interface RunSummary {
  id: string;
  workflow_id: string;
  status: string;
  wait_till: string | null;
  next_seq: number;
  created_at: string;
  updated_at: string;
}

export const definitions: Tool[] = [
  {
    name: 'factory_status',
    description: 'Overview of kernel runs: counts by status, recent runs, executions, pending timers.',
    annotations: { title: 'Factory Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'event_tail',
    description: 'Last events of a run, oldest first (the append-only event log is the kernel authority).',
    annotations: { title: 'Event Tail', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run id' },
        limit: { type: 'number', description: 'Max events to return (default 50, max 500)' },
      },
      required: ['run_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  factory_status: () => {
    const db = getDb();
    const runsByStatus = db
      .prepare('SELECT status, COUNT(*) AS count FROM runs GROUP BY status ORDER BY count DESC')
      .all() as Array<{ status: string; count: number }>;
    const executionsByStatus = db
      .prepare('SELECT status, COUNT(*) AS count FROM executions GROUP BY status ORDER BY count DESC')
      .all() as Array<{ status: string; count: number }>;
    const recentRuns = db
      .prepare(`SELECT id, workflow_id, root_run_id, status, wait_till, next_seq, created_at, updated_at
                FROM runs ORDER BY updated_at DESC LIMIT 20`)
      .all() as RunSummary[];
    const pendingTimers = (
      db.prepare('SELECT COUNT(*) AS count FROM timers WHERE fired_at IS NULL AND due_at <= datetime(\'now\')')
        .get() as { count: number }
    ).count;
    const materialCount = (
      db.prepare('SELECT COUNT(*) AS count FROM materials').get() as { count: number }
    ).count;
    return {
      runs_by_status: runsByStatus,
      executions_by_status: executionsByStatus,
      recent_runs: recentRuns,
      timers_due: pendingTimers,
      materials_stored: materialCount,
    };
  },

  event_tail: (args) => {
    const runId = String(args.run_id ?? '');
    const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 500);
    const db = getDb();
    const run = getRun(db, runId);
    return { run, events: tailEvents(db, runId, limit) };
  },
};
