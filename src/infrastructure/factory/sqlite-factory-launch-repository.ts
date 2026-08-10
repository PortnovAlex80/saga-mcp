import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db.js';

export interface RequestFactoryLaunchInput {
  readonly orderRef: string;
  readonly mode: 'new' | 'resume';
  readonly projectId: number;
  readonly epicId: number;
  readonly lifecycleRunId?: number | null;
  readonly lifecycleInput?: unknown;
  readonly lifecycleInputSchema?: string | null;
  readonly initiatedBy: string;
  readonly idempotencyKey: string;
  readonly concurrency: number;
}

export function requestFactoryLaunch(
  input: RequestFactoryLaunchInput,
  db: Database.Database = getDb(),
): string {
  return db.transaction(() => {
    const order = db.prepare(
      `SELECT project_id, epic_id, lifecycle_run_id
         FROM factory_orders WHERE order_ref=?`,
    ).get(input.orderRef) as {
      project_id: number;
      epic_id: number;
      lifecycle_run_id: number | null;
    } | undefined;
    const resumeBelongsToOrder = input.mode !== 'resume'
      || order?.lifecycle_run_id === (input.lifecycleRunId ?? null)
      || !!db.prepare(
        `SELECT 1 AS present FROM factory_order_runs
          WHERE order_ref=? AND lifecycle_run_id=?`,
      ).get(input.orderRef, input.lifecycleRunId ?? null);
    if (
      !order
      || order.project_id !== input.projectId
      || order.epic_id !== input.epicId
      || !resumeBelongsToOrder
    ) {
      throw new Error('FACTORY_LAUNCH_ORDER_SCOPE_MISMATCH');
    }
    // CONVEYOR v4.3 PART 8: durable idempotency. The SAME idempotency key
    // always identifies the SAME Start command, including after the launch
    // reaches a terminal state (completed/failed). A retry resolves to the
    // existing launch_ref; a new intentional Start MUST use a different key.
    const existing = db.prepare(
      `SELECT launch_ref, mode, project_id, epic_id, idempotency_key, order_ref
         FROM factory_launch_requests
        WHERE idempotency_key=?`,
    ).get(input.idempotencyKey) as {
      launch_ref: string;
      mode: 'new' | 'resume';
      project_id: number;
      epic_id: number;
      idempotency_key: string;
      order_ref: string;
    } | undefined;
    if (existing) {
      if (
        existing.mode !== input.mode
        || existing.project_id !== input.projectId
        || existing.epic_id !== input.epicId
        || existing.order_ref !== input.orderRef
      ) {
        throw new Error('FACTORY_LAUNCH_IDEMPOTENT_REQUEST_MISMATCH');
      }
      return existing.launch_ref;
    }
    // No existing launch for this key — but there may still be an active launch
    // on the same order with a DIFFERENT key. That is a concurrent start attempt
    // and must be rejected (one active launch per order).
    const pending = db.prepare(
      `SELECT launch_ref, idempotency_key
         FROM factory_launch_requests
        WHERE order_ref=? AND state IN ('requested','claimed','running')`,
    ).get(input.orderRef) as {
      launch_ref: string;
      idempotency_key: string;
    } | undefined;
    if (pending) {
      if (pending.idempotency_key !== input.idempotencyKey) {
        throw new Error('FACTORY_LAUNCH_ACTIVE_REQUEST_MISMATCH');
      }
      return pending.launch_ref;
    }
    const launchRef = `launch-${randomUUID()}`;
    db.prepare(
      `INSERT INTO factory_launch_requests
         (launch_ref, order_ref, mode, project_id, epic_id, lifecycle_run_id,
          lifecycle_input_json, lifecycle_input_schema, initiated_by,
          idempotency_key, concurrency, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested')`,
    ).run(
      launchRef,
      input.orderRef,
      input.mode,
      input.projectId,
      input.epicId,
      input.lifecycleRunId ?? null,
      input.lifecycleInput === undefined
        ? null
        : JSON.stringify(input.lifecycleInput),
      input.lifecycleInputSchema ?? null,
      input.initiatedBy,
      input.idempotencyKey,
      input.concurrency,
    );
    return launchRef;
  })();
}

export interface FactoryLaunchTicket {
  readonly launchRef: string;
  readonly orderRef: string;
  readonly mode: 'new' | 'resume';
  readonly projectId: number;
  readonly epicId: number;
  readonly lifecycleRunId: number | null;
  readonly lifecycleInput: unknown;
  readonly lifecycleInputSchema: string | null;
  readonly initiatedBy: string;
  readonly idempotencyKey: string;
  readonly concurrency: number;
  readonly claimToken: string;
}

/**
 * Single-use capability consumed by the internal runtime host.  Knowing a
 * project/epic is intentionally insufficient to launch the factory.
 */
export function claimFactoryLaunch(
  launchRef: string,
  claimToken: string,
  db: Database.Database = getDb(),
): FactoryLaunchTicket {
  if (!launchRef.trim() || !claimToken.trim()) {
    throw new Error('FACTORY_LAUNCH_CAPABILITY_REQUIRED');
  }
  return db.transaction(() => {
    const claimed = db.prepare(
      `UPDATE factory_launch_requests
          SET state='claimed', claim_token=?, claimed_at=datetime('now')
        WHERE launch_ref=? AND state='requested'`,
    ).run(claimToken, launchRef);
    if (claimed.changes !== 1) {
      throw new Error(`FACTORY_LAUNCH_NOT_CLAIMABLE: ${launchRef}`);
    }
    const row = db.prepare(
      `SELECT launch_ref, order_ref, mode, project_id, epic_id,
              lifecycle_run_id, lifecycle_input_json,
              lifecycle_input_schema, initiated_by, idempotency_key,
              concurrency, claim_token
         FROM factory_launch_requests WHERE launch_ref=?`,
    ).get(launchRef) as {
      launch_ref: string;
      order_ref: string;
      mode: 'new' | 'resume';
      project_id: number;
      epic_id: number;
      lifecycle_run_id: number | null;
      lifecycle_input_json: string | null;
      lifecycle_input_schema: string | null;
      initiated_by: string;
      idempotency_key: string;
      concurrency: number;
      claim_token: string;
    };
    return {
      launchRef: row.launch_ref,
      orderRef: row.order_ref,
      mode: row.mode,
      projectId: row.project_id,
      epicId: row.epic_id,
      lifecycleRunId: row.lifecycle_run_id,
      lifecycleInput: row.lifecycle_input_json === null
        ? undefined
        : JSON.parse(row.lifecycle_input_json),
      lifecycleInputSchema: row.lifecycle_input_schema,
      initiatedBy: row.initiated_by,
      idempotencyKey: row.idempotency_key,
      concurrency: row.concurrency,
      claimToken: row.claim_token,
    };
  })();
}

export function markFactoryLaunchRunning(
  launchRef: string,
  claimToken: string,
  lifecycleRunId: number,
  db: Database.Database = getDb(),
): void {
  const result = db.prepare(
    `UPDATE factory_launch_requests
        SET state='running', lifecycle_run_id=?
      WHERE launch_ref=? AND state='claimed' AND claim_token=?`,
  ).run(lifecycleRunId, launchRef, claimToken);
  if (result.changes !== 1) throw new Error('FACTORY_LAUNCH_FENCE_LOST');
  db.prepare(
    `UPDATE factory_orders
        SET lifecycle_run_id=COALESCE(lifecycle_run_id, ?),
            state='running', updated_at=datetime('now')
      WHERE order_ref=(
        SELECT order_ref FROM factory_launch_requests WHERE launch_ref=?
      )`,
  ).run(lifecycleRunId, launchRef);
}

export function finishFactoryLaunch(
  launchRef: string,
  claimToken: string,
  state: 'completed' | 'failed',
  error: string | null,
  orderState: 'paused' | 'completed' | 'start_failed' =
    state === 'completed' ? 'completed' : 'start_failed',
  db: Database.Database = getDb(),
): void {
  const result = db.prepare(
    `UPDATE factory_launch_requests
        SET state=?, error=?, completed_at=datetime('now')
      WHERE launch_ref=? AND state IN ('claimed','running') AND claim_token=?`,
  ).run(state, error, launchRef, claimToken);
  if (result.changes !== 1) throw new Error('FACTORY_LAUNCH_FENCE_LOST');
  db.prepare(
    `UPDATE factory_orders
        SET state=?, last_error=?, updated_at=datetime('now')
      WHERE order_ref=(
        SELECT order_ref FROM factory_launch_requests WHERE launch_ref=?
      )`,
  ).run(orderState, error, launchRef);
}
