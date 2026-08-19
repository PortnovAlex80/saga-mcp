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
 *
 * FIX 1 (2026-08-16 incident): the sweep additionally guards every execution
 * it would KEEP/RENEW with a dead-or-foreign-PID check (read-only: existence
 * probe + birth-token/command-line identity). Such rows lose their lease
 * renewal first (heartbeat ages), then — once the heartbeat is stale past
 * PID_GUARD_HEARTBEAT_STALE_MS — are released through the EXISTING lost-worker
 * path. Uncertainty (tooling error) keeps the OLD keep+renew behavior.
 */

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ExecutionRuntimeRepository } from '../../application/ports/factory-runtime-persistence.js';
import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import { EngineDbBusyError, withBusyRetry } from '../../runtime/busy-retry.js';
import { journalEvent } from '../../observability/run-journal.js';

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
  /**
   * FIX 1 (2026-08-16 incident): executions this sweep classified 'lost'
   * because their PID was dead or reused by a foreign process. Surfaces as
   * lost_dead_pid=N on the sweep result line.
   */
  lostDeadPidCount: number;
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
  lostDeadPidCount: 0,
};

/** Build the single-flight scope key for a (projectId, epicId) supervision run. */
function supervisionScopeKey(projectId: number, epicId: number): string {
  return `${projectId}:${epicId}`;
}

// ---------------------------------------------------------------------------
// CROSS-PROCESS advisory lease (LAYER 2). SQLite has no native advisory lock;
// this is a compare-and-swap over the `supervision_locks` table.
// ---------------------------------------------------------------------------

/** Build a unique-per-process holder id for the cross-process lease. */
function newHolderId(): string {
  return `${os.hostname()}:${process.pid}:${randomBytes(8).toString('hex')}`;
}

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
    db.prepare(
      `INSERT OR IGNORE INTO supervision_locks (scope_key, holder_id, expires_at)
       VALUES (?, ?, ?)`,
    ).run(scopeKey, holderId, expiresAt);
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

function releaseSupervisionLease(
  db: Database.Database,
  scopeKey: string,
  holderId: string,
): void {
  try {
    // Antifreeze B3: bounded busy-retry on the DELETE (hot supervision write
    // on the shared main connection); final failure is swallowed by the
    // existing best-effort catch — expires_at is the reclaim safety net.
    withBusyRetry(
      () => db.prepare(
        `DELETE FROM supervision_locks WHERE scope_key=? AND holder_id=?`,
      ).run(scopeKey, holderId),
      { db },
    );
  } catch {
    // Best-effort; expires_at is the reclaim safety net.
  }
}

/**
 * Start the watchman. Runs one reconciliation immediately (startup sweep —
 * catches executions orphaned by an earlier process crash), then repeats every
 * intervalMs until stop() is called.
 */
export function startWorkerSupervision(
  options: WorkerSupervisionOptions,
): SupervisionHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const now = options.now ?? (() => Date.now());
  const sweepLeaseMs = options.sweepLeaseMs ?? DEFAULT_SWEEP_LEASE_MS;
  const holderId = options.holderId ?? newHolderId();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = (): SupervisionReconcileResult => {
    const scopeKey = supervisionScopeKey(options.projectId, options.epicId);

    if (inflightSupervisionScopes.has(scopeKey)) {
      log(`[supervision] sweep skipped: supervision already running for scope=${scopeKey}`);
      return EMPTY_RESULT;
    }
    inflightSupervisionScopes.add(scopeKey);

    let dbHandle: Database.Database | null = null;
    try {
      dbHandle = options.db ?? getDb();
    } catch {
      dbHandle = null;
    }
    let leaseHeld = false;
    if (dbHandle !== null) {
      try {
        // Antifreeze B3: the CAS lease acquisition is a BEGIN IMMEDIATE
        // transaction on the shared main connection — bounded busy-retry so
        // contention with a checkpoint/worker write cannot busy-spin the main
        // thread for the full busy_timeout. Final ENGINE_DB_BUSY degrades to
        // the existing in-process-guard path (sweep skipped, next interval
        // retries); reconcile idempotency remains the convergence guarantee.
        leaseHeld = withBusyRetry(
          () => acquireSupervisionLease(
            dbHandle!, scopeKey, holderId, sweepLeaseMs, now(),
          ),
          { db: dbHandle },
        );
      } catch (err) {
        log(
          `[supervision] cross-process lease unavailable for scope=${scopeKey}: `
          + `${err instanceof Error ? err.message : String(err)} (degraded to in-process guard)`,
        );
        leaseHeld = false;
      }
    }
    if (dbHandle !== null && !leaseHeld) {
      log(`[supervision] sweep skipped: another process holds the lease for scope=${scopeKey}`);
      inflightSupervisionScopes.delete(scopeKey);
      return EMPTY_RESULT;
    }

    try {
      // ORDER IS AUTHORITY-SENSITIVE.
      //
      // Reconcile FIRST, renew SECOND. A newly started orchestrate-cli must not
      // renew a same-host execution left behind by a previous host process before
      // the reaper has evaluated its existing durable lease + PID birth identity.
      // Renewing first "adopts" an orphan by extending lease_expires_at and can
      // make decideStuckAction KEEP it indefinitely. Reconcile therefore sees
      // the PRE-SWEEP lease. Dead rows and alive rows whose foreman lease expired
      // are released/terminated before any heartbeat is extended.
      //
      // Antifreeze B3: both repository writes run through bounded busy-retry
      // (see SqliteExecutionRuntimeRepository). ENGINE_DB_BUSY means the sweep
      // could not run in its budget — skip it; reconcile is idempotent, the
      // lease/expire safety nets hold, and the next interval retries. A frozen
      // sweep (the old behavior: a 5s+ main-thread busy-spin) is strictly worse.
      let projections: ReturnType<ExecutionRuntimeRepository['reconcile']>;
      let renewed: number;
      try {
        projections = options.executionRuntime.reconcile(
          options.projectId,
          options.epicId,
        );

        // Only executions that survived reconciliation remain active and eligible
        // for liveness renewal. renewLeases touches lease_expires_at + heartbeat_at
        // only; it must never touch progress/stuck clocks.
        //
        // FIX 1 (2026-08-16 incident): executions whose reconcile projection
        // carries withholdRenewal (PID alive-but-foreign — reuse suspected) are
        // EXCLUDED from renewal. Their heartbeat_at must age toward the stale
        // gate; refreshing it forever is exactly how one dead worker froze the
        // engine for ~3 hours (kept=1 leases_renewed=1 every sweep).
        const renewalExclusions = projections
          .filter(p => p.withholdRenewal === true)
          .map(p => p.executionId);

        renewed = options.executionRuntime.renewLeases(
          options.projectId,
          options.epicId,
          options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
          renewalExclusions,
        );
      } catch (busyError) {
        if (busyError instanceof EngineDbBusyError) {
          log(
            `[supervision] sweep deferred (db busy) scope=${scopeKey}: `
            + `${busyError.message} — retrying on the next interval`,
          );
          return EMPTY_RESULT;
        }
        throw busyError;
      }

      let reapedCount = 0;
      let releasedCount = 0;
      let keptCount = 0;
      let remoteCount = 0;
      let lostDeadPidCount = 0;
      for (const p of projections) {
        if (p.action === 'lost' || p.action === 'terminated' || p.action === 'exited') {
          reapedCount++;
          if (p.released) releasedCount++;
          if (p.lostViaDeadPid === true) lostDeadPidCount++;
          // STAGE-11 TASK 5 — a reap is a worker-level fatal fact; it was
          // visible only in the engine stdout. Per reaped projection, never
          // per sweep. Observation only.
          journalEvent('supervision.reaped', {
            execution_id: p.executionId,
          }, {
            task_id: p.taskId,
            action: p.action,
            released: p.released,
            reason: p.reason,
          });
          log(
            `[supervision] REAPED execution=${p.executionId} task=${p.taskId} `
            + `action=${p.action} released=${p.released} reason=${p.reason} at=${new Date(now()).toISOString()}`,
          );
        } else if (p.action === 'remote_unknown') {
          remoteCount++;
        } else {
          keptCount++;
          if (p.withholdRenewal === true) {
            log(
              `[supervision] renewal withheld execution=${p.executionId} task=${p.taskId} `
              + '— PID alive but foreign (reuse suspected); heartbeat aging toward lost classification',
            );
          }
          if (p.pidIdentityUnverifiable === true) {
            log(
              `[supervision] pid identity unverifiable execution=${p.executionId} task=${p.taskId} `
              + '— kept and renewed per conservative fallback (tooling error; NOT classified lost)',
            );
          }
        }
      }
      if (reapedCount > 0 || renewed > 0 || lostDeadPidCount > 0) {
        log(
          `[supervision] sweep at=${new Date(now()).toISOString()} reaped=${reapedCount} `
          + `released=${releasedCount} kept=${keptCount} remote=${remoteCount} `
          + `leases_renewed=${renewed} lost_dead_pid=${lostDeadPidCount}`,
        );
      }
      return {
        reapedCount, releasedCount, keptCount, remoteCount,
        leasesRenewed: renewed, lostDeadPidCount,
      };
    } finally {
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
        log(`[supervision] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      schedule();
    }, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
  };
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (dbHandleForStop(options.db)) {
        // The per-sweep lease is normally released in run(). This branch is
        // intentionally empty: stop() cannot safely delete a lease that might
        // belong to an in-flight sweep without holding the in-process guard.
      }
    },
    reconcileOnce() {
      return run();
    },
  };
}

function dbHandleForStop(db: Database.Database | undefined): boolean {
  return db !== undefined;
}
