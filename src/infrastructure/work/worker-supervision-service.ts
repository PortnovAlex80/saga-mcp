/**
 * WorkerSupervisionService — the watchman of the conveyor.
 *
 * CONVEYOR-MENTAL-MODEL §"Foreman, watchman and escaped/tired workers":
 * The watchman runs independently at startup and periodically while the
 * conveyor is alive. It scans durable active executions and reconciles crashed
 * foremen, dead workers, expired reservations and cancellation timeouts.
 * Reconciliation is idempotent and uses the same atomic release primitive as
 * the child close callback; a close/reaper race has one effective winner.
 *
 * Baseline gap this closes (CONVEYOR-MENTAL-MODEL baseline 2026-08-01):
 * `reconcileWorkerExecutions()` existed but had no production scheduling call,
 * so a crashed parent runner could leave cards fenced by zombie executions.
 * This service calls ExecutionRuntimeRepository.reconcile() on start and at a
 * bounded interval, returning fenced cards to their queues without operator
 * intervention.
 *
 * TWO LAYERS of single-flight protection (Wave 5 re-check 2026-08-02):
 *
 *   1. IN-PROCESS fast path — a module-scoped Set of `${projectId}:${epicId}`
 *      keys so two startWorkerSupervision handles — or a periodic sweep racing
 *      an on-demand reconcileOnce() — cannot overlap on the same scope WITHIN
 *      ONE Node process. This is the cheap check; no DB round-trip.
 *
 *   2. CROSS-PROCESS advisory lease — a `supervision_locks` table row keyed by
 *      `scope_key=${projectId}:${epicId}`, acquired by compare-and-swap so two
 *      SEPARATE orchestrate-cli processes on the same DB cannot both reconcile
 *      the same scope at once. SQLite has no native advisory lock; the pattern
 *      is a row with (scope_key, holder_id, expires_at):
 *        - Acquire: write a row for my scope only if no UNEXPIRED row exists,
 *          or the unexpired row is already mine (holder_id = me). On CAS miss
 *          (another holder has an unexpired row) the sweep is skipped.
 *        - Release: delete my row on sweep exit (finally), so a crashed
 *          process leaves only an expired row the next holder can claim.
 *      The lease TTL (DEFAULT_SWEEP_LEASE_MS, 30s) is longer than a single
 *      sweep; the holder re-acquires (CAS) on every sweep, refreshing
 *      expires_at. A holder that dies mid-sweep leaves an expired row the next
 *      process claims.
 *
 * The cross-process lease is a PERFORMANCE and double-bookkeeping guard. The
 * ULTIMATE convergence guarantee remains the fenced-CAS idempotency of
 * releaseExecutionAtomically (atomic-release.ts — the release UPDATE is gated
 * by `WHERE id=? AND current_execution_id=?`), so even if two processes slipped
 * past the lease they would converge to one effective winner per fenced card.
 *
 * The watchman emits an audit log line per reaped execution. It does NOT kill
 * processes itself — reconcile uses process.kill(pid,0) liveness + PID
 * birth-token verification (inside reconcileWorkerExecutions) and the atomic
 * release primitive. Human override (AdminOverrideLifecycle) remains a
 * separate, non-automated path.
 */

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ExecutionRuntimeRepository } from '../../application/ports/saga2-runtime-persistence.js';
import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';

export interface WorkerSupervisionOptions {
  executionRuntime: ExecutionRuntimeRepository;
  projectId: number;
  epicId: number;
  /** Reconcile interval. Default 30s. */
  intervalMs?: number;
  /** Lease TTL advanced by renewLeases on each sweep. Default 5min. */
  leaseTtlMs?: number;
  /** Logger; defaults to stdout. */
  log?: (message: string) => void;
  /** now() for testability. */
  now?: () => number;
  /**
   * Cross-process advisory-lease TTL. Default 30s (DEFAULT_SWEEP_LEASE_MS).
   * The lease holder re-acquires on every sweep, refreshing expires_at. A
   * holder that dies mid-sweep leaves an expired row the next process claims.
   */
  sweepLeaseMs?: number;
  /**
   * Optional DB handle (testability). Production resolves the global DB lazily
   * via getDb() on first lock attempt.
   */
  db?: Database.Database;
  /**
   * Optional holder id for the cross-process lease (testability). Production
   * derives a per-handle id: `hostname:pid:random`.
   */
  holderId?: string;
}

export interface SupervisionHandle {
  /** Stop the periodic watchman. Idempotent. */
  stop(): void;
  /** Trigger one immediate reconciliation (used on startup and on demand). */
  reconcileOnce(): SupervisionReconcileResult;
}

export interface SupervisionReconcileResult {
  reapedCount: number;
  releasedCount: number;
  keptCount: number;
  remoteCount: number;
  /** Number of active local leases renewed on this sweep (liveness heartbeat). */
  leasesRenewed: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches WORKER_LEASE_TTL_MS
// Cross-process advisory-lease TTL. Must comfortably exceed a single sweep's
// wall-clock duration so a healthy holder is never evicted mid-sweep; short
// enough that a crashed holder's row is reclaimable within a few intervals.
const DEFAULT_SWEEP_LEASE_MS = 30_000;

/**
 * IN-PROCESS single-flight guard (LAYER 1, fast path). Tracks
 * `${projectId}:${epicId}` scope keys whose run() is currently mid-sweep, so
 * two startWorkerSupervision handles on the same scope (or a periodic sweep
 * overlapping an on-demand reconcileOnce()) cannot both execute reconcile()
 * at once within ONE process. This is the cheap check — no DB round-trip. The
 * CROSS-PROCESS layer (LAYER 2, acquireSupervisionLease) backs it with a DB
 * CAS so two separate processes also cannot overlap.
 */
const inflightSupervisionScopes = new Set<string>();

/** Empty/zero result returned when a sweep is skipped (single-flight miss). */
const EMPTY_RESULT: SupervisionReconcileResult = {
  reapedCount: 0,
  releasedCount: 0,
  keptCount: 0,
  remoteCount: 0,
  leasesRenewed: 0,
};

/** Build the single-flight scope key for a (projectId, epicId) supervision run. */
function supervisionScopeKey(projectId: number, epicId: number): string {
  return `${projectId}:${epicId}`;
}

// ---------------------------------------------------------------------------
// CROSS-PROCESS advisory lease (LAYER 2). SQLite has no native advisory lock;
// this is a compare-and-swap over the `supervision_locks` table.
// ---------------------------------------------------------------------------

/**
 * Build a unique-per-process holder id for the cross-process lease. Combines
 * hostname + pid + crypto-random so two processes on the same host (same pid
 * space race) AND two handles within one process (reconcileOnce overlapping a
 * timer) are both disambiguated. The id is stable for the lifetime of one
 * SupervisionHandle so the holder can re-enter and release its own lease.
 */
function newHolderId(): string {
  return `${os.hostname()}:${process.pid}:${randomBytes(8).toString('hex')}`;
}

/**
 * Attempt to acquire (or refresh) the cross-process advisory lease for a scope.
 *
 * Compare-and-swap: write a row keyed by `scope_key` with `holder_id`=me and
 * `expires_at`=now+ttl ONLY IF no unexpired row exists for that scope, OR the
 * unexpired row is already mine. On a miss (another holder has an unexpired
 * row) the UPDATE touches zero rows and this returns false → the caller skips
 * its sweep (another process owns the scope).
 *
 * The CAS is two stepped statements inside one IMMEDIATE transaction so it is
 * atomic w.r.t. other connections:
 *   1. INSERT the row if absent (claim a fresh scope).
 *   2. UPDATE the row to my holder_id + new expires_at when EITHER the current
 *      row is expired OR it already belongs to me (re-entry / refresh).
 * If both no-op (another live holder owns it), return false.
 *
 * @returns true if this caller now holds the lease; false if another live
 *          holder owns the scope and this sweep must be skipped.
 */
function acquireSupervisionLease(
  db: Database.Database,
  scopeKey: string,
  holderId: string,
  ttlMs: number,
  now: number,
): boolean {
  const expiresAt = new Date(now + ttlMs).toISOString();
  const nowIso = new Date(now).toISOString();
  const acquire = db.transaction(() => {
    // 1. Ensure the row exists (fresh scope). INSERT OR IGNORE so a re-acquire
    //    of an existing scope is a no-op here; the UPDATE below does the work.
    db.prepare(
      `INSERT OR IGNORE INTO supervision_locks (scope_key, holder_id, expires_at)
       VALUES (?, ?, ?)`,
    ).run(scopeKey, holderId, expiresAt);
    // 2. CAS: claim the row when it is expired OR already mine. A row held by a
    //    DIFFERENT live holder (expires_at > now AND holder_id != me) is left
    //    untouched and the UPDATE returns changes=0.
    const info = db.prepare(
      `UPDATE supervision_locks
          SET holder_id=?, expires_at=?, updated_at=?
        WHERE scope_key=?
          AND (expires_at < ? OR holder_id = ?)`,
    ).run(holderId, expiresAt, nowIso, scopeKey, nowIso, holderId);
    return info.changes > 0;
  });
  return acquire.immediate();
}

/**
 * Release the cross-process advisory lease for a scope. Deletes the row ONLY
 * when it belongs to this caller (`holder_id = me`). A row held by a different
 * holder (a CAS race where someone else already took over an expired lease) is
 * left in place — never delete another holder's lease.
 */
function releaseSupervisionLease(
  db: Database.Database,
  scopeKey: string,
  holderId: string,
): void {
  try {
    db.prepare(
      `DELETE FROM supervision_locks WHERE scope_key=? AND holder_id=?`,
    ).run(scopeKey, holderId);
  } catch {
    // Release is best-effort: a failed DELETE (DB closed, schema missing) must
    // never crash the supervisor. The row's expires_at is the reclaim safety
    // net — an unreleased expired row is claimable by the next holder.
  }
}

/**
 * Start the watchman. Runs one reconciliation immediately (startup sweep —
 * catches executions orphaned by a previous runtime crash), then repeats every
 * intervalMs until stop() is called. Each reconcile is independent: a reaped
 * execution is terminal and a subsequent sweep is a no-op for it.
 */
export function startWorkerSupervision(
  options: WorkerSupervisionOptions,
): SupervisionHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const now = options.now ?? (() => Date.now());
  const sweepLeaseMs = options.sweepLeaseMs ?? DEFAULT_SWEEP_LEASE_MS;
  // Per-handle identity for the cross-process lease. Stable for the handle's
  // lifetime so reconcileOnce() can re-enter / refresh its own lease.
  const holderId = options.holderId ?? newHolderId();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = (): SupervisionReconcileResult => {
    const scopeKey = supervisionScopeKey(options.projectId, options.epicId);

    // LAYER 1 — IN-PROCESS single-flight (fast path, no DB round-trip): if
    // another sweep is already in flight for this exact scope within this
    // process, skip this one. The existing in-flight sweep will observe
    // whatever state it needs to observe; a redundant concurrent sweep would
    // double-renew leases / double-log and cannot produce a different outcome
    // (release is fenced-CAS idempotent).
    if (inflightSupervisionScopes.has(scopeKey)) {
      log(
        `[supervision] sweep skipped: supervision already running for scope=${scopeKey}`,
      );
      return EMPTY_RESULT;
    }
    inflightSupervisionScopes.add(scopeKey);

    // LAYER 2 — CROSS-PROCESS advisory lease. Acquired BEFORE any reconcile
    // work so two separate processes cannot both sweep the same scope. The
    // lease is released in the outer finally so a sweep that throws still frees
    // its row. The in-process Set above is released there too.
    let dbHandle: Database.Database | null = null;
    try {
      dbHandle = options.db ?? getDb();
    } catch {
      // No DB available (e.g. test harness without DB_PATH). Degrade to the
      // in-process guard only — fenced-CAS idempotency of release remains the
      // convergence guarantee.
      dbHandle = null;
    }
    let leaseHeld = false;
    if (dbHandle !== null) {
      try {
        leaseHeld = acquireSupervisionLease(
          dbHandle, scopeKey, holderId, sweepLeaseMs, now(),
        );
      } catch (err) {
        // A failed CAS (table missing in an old DB, locked DB) must not crash
        // supervision. Fall through to reconcile under the in-process guard +
        // fenced-CAS convergence. Log so the operator can see the degradation.
        log(
          `[supervision] cross-process lease unavailable for scope=${scopeKey}: `
          + `${err instanceof Error ? err.message : String(err)} (degraded to in-process guard)`,
        );
        leaseHeld = false;
      }
    }
    if (dbHandle !== null && !leaseHeld) {
      // Another live process holds the lease for this scope. Skip — that
      // process is (or just was) sweeping. The in-process Set is cleared below.
      log(
        `[supervision] sweep skipped: another process holds the lease for scope=${scopeKey}`,
      );
      return EMPTY_RESULT;
    }

    try {
      // CONVEYOR Wave 5 (BUG 2, §363-370): renew leases FIRST. The supervisor owns
      // the LIVENESS heartbeat — it advances lease_expires_at + heartbeat_at for
      // every active local execution on every sweep. This is the LIVENESS signal
      // ("supervisor still owns this execution"), independent of model behaviour:
      // a worker that never calls a tool still keeps its lease as long as its
      // process (and this supervisor) is alive.
      //
      // CRITICAL: renewLeases touches ONLY lease_expires_at + heartbeat_at. It
      // MUST NOT touch progress_at, suspected_stuck_at or cancel_requested_at —
      // those are the PROGRESS signal ("worker produced observable activity") and
      // drive stuck detection. If liveness renewal reset the progress clock, a
      // silent-but-alive worker could never reach cancellation grace. The stuck
      // policy inside reconcileWorkerExecutions measures silence against
      // progress_at / suspected_stuck_at / cancel_requested_at, never heartbeat_at.
      const renewed = options.executionRuntime.renewLeases(
        options.projectId,
        options.epicId,
        options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      );
      const projections = options.executionRuntime.reconcile(
        options.projectId,
        options.epicId,
      );
      let reapedCount = 0;
      let releasedCount = 0;
      let keptCount = 0;
      let remoteCount = 0;
      for (const p of projections) {
        if (p.action === 'lost' || p.action === 'terminated') {
          reapedCount++;
          if (p.released) releasedCount++;
          log(
            `[supervision] REAPED execution=${p.executionId} task=${p.taskId} `
            + `action=${p.action} released=${p.released} reason=${p.reason} at=${new Date(now()).toISOString()}`,
          );
        } else if (p.action === 'remote_unknown') {
          remoteCount++;
        } else {
          keptCount++;
        }
      }
      if (reapedCount > 0 || renewed > 0) {
        log(
          `[supervision] sweep at=${new Date(now()).toISOString()} reaped=${reapedCount} `
          + `released=${releasedCount} kept=${keptCount} remote=${remoteCount} leases_renewed=${renewed}`,
        );
      }
      return { reapedCount, releasedCount, keptCount, remoteCount, leasesRenewed: renewed };
    } finally {
      // Release the cross-process lease FIRST (while the in-process Set still
      // guards this scope from a racing reconcileOnce in the same process), then
      // drop the in-process guard. Release is best-effort and idempotent.
      if (dbHandle !== null && leaseHeld) {
        releaseSupervisionLease(dbHandle, scopeKey, holderId);
      }
      inflightSupervisionScopes.delete(scopeKey);
    }
  };

  // Startup sweep — catches orphaned executions from a prior crash immediately,
  // without waiting for the first interval.
  run();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      try {
        run();
      } catch (err) {
        log(
          `[supervision] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      schedule();
    }, intervalMs);
    // Don't keep the event loop alive solely for supervision — the runtime owns
    // the lifecycle. unref lets the process exit cleanly when work is done.
    if (typeof timer?.unref === 'function') timer.unref();
  };
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    reconcileOnce() {
      return run();
    },
  };
}
