import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { appendEventInTx } from '../events.js';
import { putMaterial } from '../materials.js';
import type { Item } from './node-types.js';

// Kernel-side activity contract (Temporal ideas, minimal). The kernel owns
// every transition; a worker may only heartbeat and settle ITS OWN execution,
// and only with the lease it was handed at claim time.

export interface ActivityTimeouts {
  /** Max wait in the queue before a worker even starts. */
  schedule_to_start_s: number;
  /** Max time from claim to settle enforced via heartbeat freshness. */
  heartbeat_s: number;
}

export interface ActivityRetry {
  max_attempts: number;
}

export const DEFAULT_TIMEOUTS: ActivityTimeouts = {
  schedule_to_start_s: 30,
  heartbeat_s: 15,
};

export const DEFAULT_RETRY: ActivityRetry = { max_attempts: 2 };

export interface ExecutionRow {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  status: 'new' | 'running' | 'waiting' | 'success' | 'error' | 'canceled' | 'crashed';
  worker_kind: string | null;
  timeouts_json: string;
  retry_json: string;
  lease: string | null;
  heartbeat_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function getExecution(db: Database.Database, executionId: string): ExecutionRow {
  const row = db
    .prepare('SELECT * FROM executions WHERE id = ?')
    .get(executionId) as ExecutionRow | undefined;
  if (!row) {
    throw new Error(`EXECUTION_NOT_FOUND: ${executionId}`);
  }
  return row;
}

/** Kernel: creates one activity attempt — event + row in one transaction.
 *  Both carry attempt/timeouts/retry, so the log alone can rebuild the row.
 *  `opts.supersedes` marks a sweep retry decision atomically with the new
 *  attempt (execution.retry_scheduled). */
export function scheduleExecution(
  db: Database.Database,
  runId: string,
  nodeId: string,
  attempt: number,
  policy: { workerKind: string; timeouts: ActivityTimeouts; retry: ActivityRetry },
  now = new Date(),
  opts: { supersedes?: string } = {}
): string {
  const executionId = randomUUID();
  return db.transaction(() => {
    appendEventInTx(db, runId, 'node.scheduled', { node_id: nodeId });
    appendEventInTx(db, runId, 'execution.scheduled', {
      execution_id: executionId,
      node_id: nodeId,
      attempt,
      worker_kind: policy.workerKind,
      timeouts: policy.timeouts,
      retry: policy.retry,
      supersedes: opts.supersedes ?? null,
    });
    if (opts.supersedes) {
      appendEventInTx(db, runId, 'execution.retry_scheduled', {
        supersedes: opts.supersedes,
        new_execution_id: executionId,
        node_id: nodeId,
        attempt,
      });
    }
    db.prepare(
      `INSERT INTO executions (id, run_id, node_id, attempt, status, worker_kind, timeouts_json, retry_json, created_at)
       VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?)`
    ).run(
      executionId,
      runId,
      nodeId,
      attempt,
      policy.workerKind,
      JSON.stringify(policy.timeouts),
      JSON.stringify(policy.retry),
      now.toISOString()
    );
    return executionId;
  }).immediate();
}

/** Bridge/claim path: hands a lease to exactly one worker. CAS on status. */
export function claimExecution(
  db: Database.Database,
  executionId: string,
  now = new Date()
): { lease: string } | null {
  const lease = randomUUID();
  const result = db
    .prepare(
      `UPDATE executions SET status = 'running', lease = ?, started_at = ?, heartbeat_at = ?
       WHERE id = ? AND status = 'new'`
    )
    .run(lease, now.toISOString(), now.toISOString(), executionId);
  if (result.changes !== 1) return null;
  const row = getExecution(db, executionId);
  db.transaction(() => {
    appendEventInTx(db, row.run_id, 'execution.started', {
      execution_id: executionId,
      node_id: row.node_id,
      attempt: row.attempt,
      lease,
    });
  }).immediate();
  return { lease };
}

/** Worker: proves liveness. Operational only — sweeps read heartbeat_at. */
export function heartbeatExecution(
  db: Database.Database,
  executionId: string,
  lease: string,
  now = new Date()
): void {
  db.transaction(() => {
    const row = getExecution(db, executionId);
    if (row.status !== 'running' || row.lease !== lease) {
      throw new Error(`EXECUTION_LEASE_INVALID: ${executionId}`);
    }
    appendEventInTx(db, row.run_id, 'execution.heartbeat', { execution_id: executionId });
    db.prepare('UPDATE executions SET heartbeat_at = ? WHERE id = ?').run(now.toISOString(), executionId);
  }).immediate();
}

/** Worker success: settle the execution AND complete the node — atomically,
 *  exactly like the M1 scripted path, so the fold sees one grammar. */
export function completeActivity(
  db: Database.Database,
  executionId: string,
  lease: string,
  items: Item[],
  now = new Date()
): { digest: string } {
  return db.transaction(() => {
    const row = getExecution(db, executionId);
    if (row.status !== 'running' || row.lease !== lease) {
      throw new Error(`EXECUTION_LEASE_INVALID: ${executionId}`);
    }
    appendEventInTx(db, row.run_id, 'execution.completed', { execution_id: executionId });
    const { digest } = putMaterial(db, 'node_output', JSON.stringify(items));
    appendEventInTx(db, row.run_id, 'material.submitted', {
      node_id: row.node_id,
      digest,
      schema_ref: 'node_output',
      items_count: items.length,
    });
    appendEventInTx(db, row.run_id, 'node.completed', {
      node_id: row.node_id,
      output_digest: digest,
      items_count: items.length,
    });
    db.prepare("UPDATE executions SET status = 'success', finished_at = ? WHERE id = ?")
      .run(now.toISOString(), executionId);
    return { digest };
  }).immediate();
}

/** Worker failure: record the failed attempt. Whether to retry belongs to the
 *  kernel (sweep), never to the worker. */
export function failActivity(
  db: Database.Database,
  executionId: string,
  lease: string,
  errorType: string,
  message: string,
  now = new Date()
): void {
  db.transaction(() => {
    const row = getExecution(db, executionId);
    if (row.status !== 'running' || row.lease !== lease) {
      throw new Error(`EXECUTION_LEASE_INVALID: ${executionId}`);
    }
    appendEventInTx(db, row.run_id, 'execution.failed', {
      execution_id: executionId,
      node_id: row.node_id,
      attempt: row.attempt,
      error_type: errorType,
      message,
    });
    db.prepare("UPDATE executions SET status = 'error', finished_at = ? WHERE id = ?")
      .run(now.toISOString(), executionId);
  }).immediate();
}
