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
  /** Hard budget for the whole activity body (worker self-kills past it). */
  start_to_close_s?: number;
}

export interface ActivityRetry {
  max_attempts: number;
}

export const DEFAULT_TIMEOUTS: ActivityTimeouts = {
  schedule_to_start_s: 30,
  heartbeat_s: 15,
  start_to_close_s: 180,
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
  /** Live output tail — operational, overwritten each heartbeat. */
  progress: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** How much of a worker's live output the monitor keeps. A window, not a log. */
export const PROGRESS_TAIL_CHARS = 2000;

/** What one attempt spent. Provenance of the attempt, never of the material. */
export interface ModelUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cost?: number;
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

/** Worker: proves liveness, and may show what it is producing right now.
 *
 *  The event carries only the REPLAYABLE fact — how many characters had
 *  arrived by this beat. The text itself goes to the `progress` column, which
 *  is overwritten every beat: it is a window into a non-deterministic process,
 *  not material, and no decision may read it. Material is what the worker
 *  submits at settle time. */
export function heartbeatExecution(
  db: Database.Database,
  executionId: string,
  lease: string,
  opts: { progress?: string } = {},
  now = new Date()
): void {
  const tail = opts.progress === undefined ? undefined : opts.progress.slice(-PROGRESS_TAIL_CHARS);
  db.transaction(() => {
    const row = getExecution(db, executionId);
    if (row.status !== 'running' || row.lease !== lease) {
      throw new Error(`EXECUTION_LEASE_INVALID: ${executionId}`);
    }
    appendEventInTx(db, row.run_id, 'execution.heartbeat', {
      execution_id: executionId,
      ...(opts.progress === undefined ? {} : { progress_chars: opts.progress.length }),
    });
    if (tail === undefined) {
      db.prepare('UPDATE executions SET heartbeat_at = ? WHERE id = ?').run(now.toISOString(), executionId);
    } else {
      db.prepare('UPDATE executions SET heartbeat_at = ?, progress = ? WHERE id = ?')
        .run(now.toISOString(), tail, executionId);
    }
  }).immediate();
}

/** Effect receipt metadata a worker may attach when settling an activity
 *  that changed the external world (M4). The kernel owns the ledger:
 *  effects row + durable event land in the SAME transaction as the settle. */
export interface EffectSettlement {
  key: string;
  desired_digest: string;
  outcome: 'applied' | 'already_applied' | 'conflict' | 'failed';
  receipt: Record<string, unknown>;
}

/** Worker success: settle the execution AND complete the node — atomically,
 *  exactly like the M1 scripted path, so the fold sees one grammar. */
export function completeActivity(
  db: Database.Database,
  executionId: string,
  lease: string,
  items: Item[],
  opts: { effect?: EffectSettlement; usage?: ModelUsage } = {},
  now = new Date()
): { digest: string } {
  return db.transaction(() => {
    const row = getExecution(db, executionId);
    if (row.status !== 'running' || row.lease !== lease) {
      throw new Error(`EXECUTION_LEASE_INVALID: ${executionId}`);
    }
    // Token spend belongs to the ATTEMPT, not to the material: identical
    // answers must stay content-identical, whatever they cost.
    appendEventInTx(db, row.run_id, 'execution.completed', {
      execution_id: executionId,
      ...(opts.usage ? { usage: opts.usage } : {}),
    });
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
    if (opts.effect) writeEffectLedger(db, row, opts.effect, now);
    return { digest };
  }).immediate();
}

/** Worker failure: record the failed attempt. Whether to retry belongs to the
 *  kernel (sweep), never to the worker. Typed effect outcomes (conflict,
 *  failed) land in the ledger atomically with the attempt failure. */
export function failActivity(
  db: Database.Database,
  executionId: string,
  lease: string,
  errorType: string,
  message: string,
  opts: { effect?: EffectSettlement } = {},
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
    if (opts.effect) writeEffectLedger(db, row, opts.effect, now);
  }).immediate();
}

/** The effect ledger: one row per idempotency key (last settlement wins),
 *  one durable event per settlement — atomic with the activity settle. */
function writeEffectLedger(
  db: Database.Database,
  row: ExecutionRow,
  effect: EffectSettlement,
  now: Date
): void {
  const status =
    effect.outcome === 'applied' || effect.outcome === 'already_applied' ? 'applied' : 'failed';
  const receiptJson = JSON.stringify(effect.receipt);
  db.prepare(
    `INSERT INTO effects (id, run_id, idempotency_key, desired_digest, status, receipt_json, created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       status = excluded.status,
       receipt_json = excluded.receipt_json,
       settled_at = excluded.settled_at`
  ).run(
    randomUUID(),
    row.run_id,
    effect.key,
    effect.desired_digest,
    status,
    receiptJson,
    now.toISOString(),
    now.toISOString()
  );
  appendEventInTx(db, row.run_id, 'effect.receipted', {
    node_id: row.node_id,
    key: effect.key,
    outcome: effect.outcome,
    desired_digest: effect.desired_digest,
    receipt_json: receiptJson,
  });
}
