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
 * The service is project+epic scoped (one watchman per active episode). Within
 * a single process it uses a module-scoped single-flight guard (a Set of
 * `${projectId}:${epicId}` keys) so two startWorkerSupervision handles — or a
 * periodic sweep racing an on-demand reconcileOnce() — cannot overlap on the
 * same scope. CROSS-PROCESS protection (two separate orchestrate-cli instances
 * on the same DB) is NOT provided by a lock: it relies on the fenced-CAS
 * idempotency of releaseExecutionAtomically (atomic-release.ts:228-231 — the
 * release UPDATE is gated by `WHERE id=? AND current_execution_id=?`), so two
 * concurrent sweeps converge to one effective winner per fenced card.
 *
 * The watchman emits an audit log line per reaped execution. It does NOT kill
 * processes itself — reconcile uses process.kill(pid,0) liveness + PID
 * birth-token verification (inside reconcileWorkerExecutions) and the atomic
 * release primitive. Human override (AdminOverrideLifecycle) remains a
 * separate, non-automated path.
 */

import type { ExecutionRuntimeRepository } from '../../application/ports/saga2-runtime-persistence.js';

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

/**
 * IN-PROCESS single-flight guard. Tracks `${projectId}:${epicId}` scope keys
 * whose run() is currently mid-sweep, so two startWorkerSupervision handles on
 * the same scope (or a periodic sweep overlapping an on-demand reconcileOnce())
 * cannot both execute reconcile() at once within ONE process.
 *
 * This does NOT prevent two SEPARATE processes (two orchestrate-cli instances)
 * from racing on the same DB — that cross-process case converges via the
 * fenced-CAS idempotency of releaseExecutionAtomically, NOT via this lock.
 * SQLite has no native advisory-lock primitive; no DB-level lock is attempted.
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
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = (): SupervisionReconcileResult => {
    // IN-PROCESS single-flight: if another sweep is already in flight for this
    // exact (projectId, epicId) scope within this process, skip this one. The
    // existing in-flight sweep will observe whatever state it needs to observe;
    // a redundant concurrent sweep would double-renew leases / double-log and
    // cannot produce a different outcome (release is fenced-CAS idempotent).
    const scopeKey = supervisionScopeKey(options.projectId, options.epicId);
    if (inflightSupervisionScopes.has(scopeKey)) {
      log(
        `[supervision] sweep skipped: supervision already running for scope=${scopeKey}`,
      );
      return EMPTY_RESULT;
    }
    inflightSupervisionScopes.add(scopeKey);
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
