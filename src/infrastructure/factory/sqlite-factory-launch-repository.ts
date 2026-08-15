import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
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
  readonly controllerEpoch?: number;
}

export interface FactoryControllerOptions {
  readonly holderId?: string;
  readonly machineId?: string;
  readonly processId?: number;
  readonly leaseTtlMs?: number;
  readonly now?: Date;
}

const DEFAULT_CONTROLLER_LEASE_TTL_MS = 30_000;

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readLaunchTicket(
  db: Database.Database,
  launchRef: string,
  controllerEpoch?: number,
): FactoryLaunchTicket {
  const row = db.prepare(
    `SELECT launch_ref, order_ref, mode, project_id, epic_id,
            lifecycle_run_id, lifecycle_input_json,
            lifecycle_input_schema, initiated_by, idempotency_key,
            concurrency, claim_token
       FROM factory_launch_requests WHERE launch_ref=?`,
  ).get(launchRef) as {
    launch_ref: string; order_ref: string; mode: 'new' | 'resume';
    project_id: number; epic_id: number; lifecycle_run_id: number | null;
    lifecycle_input_json: string | null; lifecycle_input_schema: string | null;
    initiated_by: string; idempotency_key: string; concurrency: number;
    claim_token: string;
  } | undefined;
  if (!row) throw new Error(`FACTORY_LAUNCH_NOT_FOUND: ${launchRef}`);
  return {
    launchRef: row.launch_ref,
    orderRef: row.order_ref,
    mode: row.mode,
    projectId: row.project_id,
    epicId: row.epic_id,
    lifecycleRunId: row.lifecycle_run_id,
    lifecycleInput: row.lifecycle_input_json === null
      ? undefined : JSON.parse(row.lifecycle_input_json),
    lifecycleInputSchema: row.lifecycle_input_schema,
    initiatedBy: row.initiated_by,
    idempotencyKey: row.idempotency_key,
    concurrency: row.concurrency,
    claimToken: row.claim_token,
    ...(controllerEpoch === undefined ? {} : { controllerEpoch }),
  };
}

/**
 * Acquire the first controller term or adopt an active legacy/expired launch.
 * Worker liveness is deliberately not inferred here; startup supervision owns
 * reconciliation for the complete durable worker cohort.
 */
export function acquireFactoryLaunchController(
  launchRef: string,
  claimToken: string,
  options: FactoryControllerOptions = {},
  db: Database.Database = getDb(),
): FactoryLaunchTicket {
  if (!launchRef.trim() || !claimToken.trim()) {
    throw new Error('FACTORY_LAUNCH_CAPABILITY_REQUIRED');
  }
  return db.transaction(() => {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + (options.leaseTtlMs ?? DEFAULT_CONTROLLER_LEASE_TTL_MS),
    ).toISOString();
    const launch = db.prepare(
      'SELECT state,claim_token FROM factory_launch_requests WHERE launch_ref=?',
    ).get(launchRef) as { state: string; claim_token: string | null } | undefined;
    if (!launch || !['requested', 'claimed', 'running'].includes(launch.state)) {
      throw new Error(`FACTORY_LAUNCH_NOT_CLAIMABLE: ${launchRef}`);
    }
    const lease = db.prepare(
      `SELECT current_term_ref,epoch,token_digest,expires_at
         FROM factory_launch_controller_leases WHERE launch_ref=?`,
    ).get(launchRef) as {
      current_term_ref: string; epoch: number; token_digest: string; expires_at: string;
    } | undefined;
    if (lease && lease.expires_at >= nowIso) {
      throw new Error(`FACTORY_LAUNCH_ALREADY_CONTROLLED: ${launchRef}`);
    }
    const epoch = (lease?.epoch ?? 0) + 1;
    const digest = tokenDigest(claimToken);
    const termRef = `factory-controller-term:${launchRef}:${epoch}`;
    const update = db.prepare(
      `UPDATE factory_launch_requests
          SET state=CASE WHEN state='requested' THEN 'claimed' ELSE state END,
              claim_token=?,claimed_at=CASE WHEN state='requested' THEN ? ELSE claimed_at END
        WHERE launch_ref=? AND state IN ('requested','claimed','running')
          AND (claim_token IS ? OR claim_token=?)`,
    ).run(claimToken, nowIso, launchRef, launch.claim_token, launch.claim_token);
    if (update.changes !== 1) throw new Error('FACTORY_LAUNCH_FENCE_LOST');
    db.prepare(
      `INSERT INTO factory_launch_controller_terms
         (term_ref,launch_ref,epoch,predecessor_term_ref,holder_id,machine_id,
          process_id,token_digest,takeover_reason,acquired_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      termRef, launchRef, epoch, lease?.current_term_ref ?? null,
      options.holderId ?? `${os.hostname()}:${process.pid}`,
      options.machineId ?? os.hostname(), options.processId ?? process.pid,
      digest, lease ? 'expired-controller-lease' : 'initial-or-legacy-claim', nowIso,
    );
    db.prepare(
      `INSERT INTO factory_launch_controller_leases
         (launch_ref,current_term_ref,epoch,token_digest,heartbeat_at,expires_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(launch_ref) DO UPDATE SET
         current_term_ref=excluded.current_term_ref,epoch=excluded.epoch,
         token_digest=excluded.token_digest,heartbeat_at=excluded.heartbeat_at,
         expires_at=excluded.expires_at`,
    ).run(launchRef, termRef, epoch, digest, nowIso, expiresAt);
    return readLaunchTicket(db, launchRef, epoch);
  }).immediate();
}

export function renewFactoryControllerLease(
  launchRef: string,
  claimToken: string,
  epoch: number,
  leaseTtlMs = DEFAULT_CONTROLLER_LEASE_TTL_MS,
  db: Database.Database = getDb(),
  now = new Date(),
): void {
  const result = db.prepare(
    `UPDATE factory_launch_controller_leases
        SET heartbeat_at=?,expires_at=?
      WHERE launch_ref=? AND epoch=? AND token_digest=?`,
  ).run(
    now.toISOString(), new Date(now.getTime() + leaseTtlMs).toISOString(),
    launchRef, epoch, tokenDigest(claimToken),
  );
  if (result.changes !== 1) throw new Error('FACTORY_CONTROLLER_FENCE_LOST');
}

export function assertFactoryControllerFence(
  launchRef: string,
  claimToken: string,
  epoch: number,
  db: Database.Database = getDb(),
): void {
  const row = db.prepare(
    `SELECT 1 AS valid FROM factory_launch_controller_leases
      WHERE launch_ref=? AND epoch=? AND token_digest=?`,
  ).get(launchRef, epoch, tokenDigest(claimToken));
  if (!row) throw new Error('FACTORY_CONTROLLER_FENCE_LOST');
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
    return readLaunchTicket(db, launchRef);
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
      WHERE launch_ref=? AND claim_token=?
        AND (state='claimed' OR (state='running' AND lifecycle_run_id=?))`,
  ).run(lifecycleRunId, launchRef, claimToken, lifecycleRunId);
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
  state: 'completed' | 'failed' | 'paused',
  error: string | null,
  orderState: 'paused' | 'completed' | 'start_failed' =
    state === 'completed' ? 'completed'
      : state === 'failed' ? 'start_failed'
      : 'paused',
  db: Database.Database = getDb(),
): void {
  // CAS fence: only a launch we currently own (claimed/running) with the
  // matching capability token may settle. `paused` is terminal for THIS
  // LaunchRequest — completed_at is set and the one-active-launch slot is
  // freed, so a later resume can create a fresh launch under the same order.
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
