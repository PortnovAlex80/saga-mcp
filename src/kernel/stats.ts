import type Database from 'better-sqlite3';
import type { ExecutionRow } from './executions.js';
import { getRun, tailEvents } from '../events.js';

// The kernel's READ API. Aggregations and scans over kernel tables live here
// so that tools/bridge/operator never write SQL against kernel persistence —
// the only direction is: they call the kernel, the kernel owns its tables.

export interface KernelStats {
  runs_by_status: Array<{ status: string; count: number }>;
  executions_by_status: Array<{ status: string; count: number }>;
  recent_runs: Array<Record<string, unknown>>;
  timers_due: number;
  materials_stored: number;
}

export function kernelStats(db: Database.Database): KernelStats {
  const runsByStatus = db
    .prepare('SELECT status, COUNT(*) AS count FROM runs GROUP BY status ORDER BY count DESC')
    .all() as Array<{ status: string; count: number }>;
  const executionsByStatus = db
    .prepare('SELECT status, COUNT(*) AS count FROM executions GROUP BY status ORDER BY count DESC')
    .all() as Array<{ status: string; count: number }>;
  const recentRuns = db
    .prepare(`SELECT id, workflow_id, root_run_id, status, wait_till, next_seq, created_at, updated_at
                FROM runs ORDER BY updated_at DESC LIMIT 20`)
    .all() as Array<Record<string, unknown>>;
  const pendingTimers = (
    db.prepare("SELECT COUNT(*) AS count FROM timers WHERE fired_at IS NULL AND due_at <= datetime('now')")
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
}

/** Claim-queue read for the bridge: oldest unclaimed executions. */
export function queuedExecutionIds(db: Database.Database, limit: number): string[] {
  return (
    db
      .prepare("SELECT id FROM executions WHERE status = 'new' ORDER BY created_at LIMIT ?")
      .all(limit) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** Human-gate projection read: every human_required decision (newest wins per
 *  run+node in the caller). The board projection is idempotent, so
 *  over-inclusion is harmless; settlement happens via operator.resolved. */
export interface HumanGateDecision {
  run_id: string;
  node_id: string;
  revision_digest?: string;
}

export function humanGateDecisions(db: Database.Database): HumanGateDecision[] {
  const rows = db
    .prepare(
      "SELECT run_id, payload_json FROM events WHERE type = 'gate.decided' AND payload_json LIKE '%\"verdict\":\"human_required\"%'"
    )
    .all() as Array<{ run_id: string; payload_json: string }>;
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as { node_id: string; revision_digest?: string };
    return {
      run_id: row.run_id,
      node_id: payload.node_id,
      revision_digest: payload.revision_digest,
    };
  });
}

/** Exposed for the read API surface completeness (tools use events directly). */
export { getRun, tailEvents };
export type { ExecutionRow };
