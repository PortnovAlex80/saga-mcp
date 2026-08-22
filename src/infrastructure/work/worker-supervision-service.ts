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
import { releaseExecutionAtomically, type ReleaseOutcome } from '../../lifecycle/atomic-release.js';
import { REAL_PROCESS_PROBE, type ProcessProbe } from '../../worker-executions.js';

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
          // CC-GAP-3 — CONVEYOR §23 synchronization edge "OS worker exits →
          // terminalize the exact WorkerExecution". When THIS sweep (not the
          // runner's close callback) converges a receipt-backed row to the
          // terminal `exited`, the runner-side worker.exit observation will
          // never arrive — its callback died with the engine, was lost in
          // stdio teardown, or lost the durable write race. Emit it here.
          // Exactly-once: this projection is produced only for rows THIS
          // sweep terminalized, and the runner gates its own emission on
          // winning the terminal write — the two writers cannot double-emit.
          // ADR-087: `exited` is SEMANTIC protocol completion, never proof of
          // physical process death, so the observation states whether the PID
          // was still alive and that the physical exit tail (exit code) is
          // left to the late-close backfill.
          if (p.action === 'exited') {
            journalEvent('worker.exit', {
              execution_id: p.executionId,
            }, {
              task_id: p.taskId,
              exit_code: null,
              worker_done_received: true,
              pid_alive: p.pidAlive ?? null,
              physical_exit_observed: false,
              exit_code_source: 'late_backfill_pending',
              outcome: 'sweep_converged_exited',
              observer: 'worker-supervision',
              released: p.released,
              reason: p.reason,
            });
          }
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

// ---------------------------------------------------------------------------
// ADR-087 — receipt-authoritative terminal drain (CC-GAP-3).
// ---------------------------------------------------------------------------

/** Bounded natural-drain courtesy window: total wall-clock budget (env-tunable). */
const DEFAULT_TERMINAL_DRAIN_MS = 5_000;
/**
 * ADR-087 hard ceiling on the natural-drain courtesy: "The engine first gives
 * existing in-process callbacks at most five seconds to terminalize
 * naturally." The window is a COURTESY — correctness never depends on it — so
 * an explicit/env value above the cap is rejected as an invalid configuration
 * rather than silently honored (a longer wait would needlessly delay every
 * terminal engine exit) or silently clamped (the operator asked for something
 * they did not get).
 */
export const MAX_TERMINAL_DRAIN_MS = 5_000;
/** Env knob for the terminal natural-drain window (non-negative integer ms). */
const TERMINAL_DRAIN_ENV = 'SAGA_TERMINAL_DRAIN_MS';
/** Poll cadence of the natural-drain loop (fixed; only the total is tunable). */
const TERMINAL_DRAIN_POLL_MS = 100;

/** One residual active execution the terminal settlement could not converge. */
export interface TerminalSettlementResidual {
  readonly executionId: string;
  readonly taskId: number | null;
  readonly code: 'NO_ACCEPTED_RECEIPT' | 'SETTLE_WRITE_FAILED' | 'STILL_ACTIVE';
  readonly detail: string;
}

export type TerminalSettlementErrorCode =
  | 'INVALID_DRAIN_WINDOW'
  | 'RECONCILE_FAILED'
  | 'UNVERIFIABLE_ACTIVE_EXECUTIONS'
  | 'RESIDUAL_ACTIVE_EXECUTIONS';

/**
 * ADR-087 fail-closed branch: a terminal-run boundary that cannot truthfully
 * account for every active execution in the launch scope raises this typed
 * OPERATIONAL failure instead of exiting silently. It is telemetry for the
 * launch/engine settlement (the launch is marked failed, exit code 1) — it is
 * deliberately NOT a new domain recovery mechanism.
 */
export class TerminalWorkerSettlementError extends Error {
  constructor(
    readonly code: TerminalSettlementErrorCode,
    readonly residuals: readonly TerminalSettlementResidual[],
    message: string,
  ) {
    super(message);
    this.name = 'TerminalWorkerSettlementError';
  }
}

/** Per-execution record of one receipt-authoritative terminal settlement. */
export interface TerminalSettlementEntry {
  readonly executionId: string;
  readonly taskId: number;
  /** PID liveness at settlement: true/false (probed local), null (remote/unprobed). */
  readonly pidAlive: boolean | null;
  readonly taskReleased: boolean;
  /** True when THIS call won the durable terminal CAS and emitted worker.exit. */
  readonly emittedWorkerExit: boolean;
}

export interface TerminalSettlementSummary {
  readonly drainMs: number;
  readonly activeBeforeDrain: number;
  /** True when every active execution terminalized naturally during the drain. */
  readonly drainedToZero: boolean;
  readonly settled: readonly TerminalSettlementEntry[];
  readonly reconciled: SupervisionReconcileResult;
  /** Final active recount after settlement (0 on success, by construction). */
  readonly activeRemaining: number;
}

interface ActiveExecutionRow {
  execution_id: string;
  task_id: number;
  machine_id: string;
  pid: number | null;
  accepted_receipt: number;
}

/**
 * Resolve the natural-drain window. An explicit option wins; otherwise the
 * SAGA_TERMINAL_DRAIN_MS env; otherwise the default. An INVALID value — not a
 * non-negative integer, or above the ADR-087 five-second courtesy cap — is a
 * typed fail-closed configuration error: silently substituting a default
 * would let a terminal launch exit "clean" on an operator typo.
 */
function resolveTerminalDrainMs(explicitMs?: number): number {
  const validate = (value: number, source: string): number => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new TerminalWorkerSettlementError(
        'INVALID_DRAIN_WINDOW',
        [],
        `${source} must be a non-negative integer number of milliseconds (got ${value})`,
      );
    }
    if (value > MAX_TERMINAL_DRAIN_MS) {
      throw new TerminalWorkerSettlementError(
        'INVALID_DRAIN_WINDOW',
        [],
        `${source} must not exceed the ADR-087 natural-drain courtesy cap of `
          + `${MAX_TERMINAL_DRAIN_MS}ms (got ${value})`,
      );
    }
    return value;
  };
  if (explicitMs !== undefined) return validate(explicitMs, 'terminal drain window option');
  const raw = process.env[TERMINAL_DRAIN_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TERMINAL_DRAIN_MS;
  return validate(Number(raw), `${TERMINAL_DRAIN_ENV}=${raw}`);
}

/** List the launch scope's active executions with their receipt authority. */
function listActiveExecutions(
  db: Database.Database,
  projectId: number,
  epicId: number,
): ActiveExecutionRow[] {
  return db.prepare(
    `SELECT we.execution_id, we.task_id, we.machine_id, we.pid,
            EXISTS(
              SELECT 1 FROM command_receipts cr
               WHERE cr.execution_id=we.execution_id
                 AND cr.command_kind IN ('worker_done','presentation_close')
                 AND cr.accepted=1
            ) AS accepted_receipt
       FROM worker_executions we
      WHERE we.project_id=? AND we.epic_id=?
        AND we.state IN ('reserved','running','cancel_requested')
      ORDER BY we.reserved_at`,
  ).all(projectId, epicId) as ActiveExecutionRow[];
}

function unlistableActives(error: unknown): TerminalWorkerSettlementError {
  return new TerminalWorkerSettlementError(
    'UNVERIFIABLE_ACTIVE_EXECUTIONS',
    [],
    'terminal settlement could not verify the launch scope\'s active executions: '
      + `${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * ADR-087 — receipt-authoritative terminal drain (CC-GAP-3).
 *
 * CONVEYOR §23 synchronization edge: "OS worker exits → terminalize the exact
 * WorkerExecution; host status is observation only."
 *
 * The engine loop can break on a TERMINAL lifecycle result while a
 * receipt-backed execution is still durably `running`: worker_done already
 * settled the Workplace (the gate owns the next transition — the OS process
 * is no longer needed), and the row's remaining terminalizer was the runner's
 * in-process close callback, which can be lost or lag behind this exit. A
 * terminal run has no future engine sweep, so exiting without settling strands
 * the execution as a phantom `running` row nobody observes.
 *
 * Algorithm (ADR-087, Option B — one existing authority, one CAS, one
 * event-owner rule; NO executor registry, NO runner stop, NO kill):
 *
 *   1. Bounded natural-drain courtesy: give existing in-process runner close
 *      callbacks a short env-tunable window to terminalize naturally. The
 *      wait is judged purely on DURABLE state (the active-row count); no
 *      process handles are registered or touched.
 *   2. Ordinary supervision reconcile: the same idempotent chain the loop
 *      already uses. Dead-PID receipt-backed rows converge on `exited` —
 *      never `lost` — and the sweep emits their worker.exit.
 *   3. Receipt-authoritative settlement: every execution still active in the
 *      launch scope WITH an accepted worker_done/presentation_close receipt
 *      is settled to semantic `exited` through the EXISTING fenced atomic
 *      release — which re-verifies the receipt at write time — even if the
 *      PID is still alive. The process is never killed; `exit_code` stays
 *      null for the late-close backfill. Only the durable terminal-write
 *      winner emits `worker.exit`, stating whether the PID was alive.
 *   4. Final active recount, fail closed: a remaining execution WITHOUT a
 *      receipt, an unverifiable database result, or a failed fenced write
 *      raises {@link TerminalWorkerSettlementError} so the launch and engine
 *      exit cannot be presented as clean operational success. No completion
 *      is ever fabricated for a non-receipt residual.
 */
export async function settleWorkerExecutionsAtTerminalRun(
  handle: SupervisionHandle,
  options: {
    projectId: number;
    epicId: number;
    db?: Database.Database;
    /** Overrides SAGA_TERMINAL_DRAIN_MS (tests). Must be a non-negative integer. */
    drainMs?: number;
    log?: (message: string) => void;
    processProbe?: ProcessProbe;
    hostname?: string;
  },
): Promise<TerminalSettlementSummary> {
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const db = options.db ?? getDb();
  const probe = options.processProbe ?? REAL_PROCESS_PROBE;
  const hostname = options.hostname ?? os.hostname();
  const drainMs = resolveTerminalDrainMs(options.drainMs);

  const readActives = (): ActiveExecutionRow[] => {
    try {
      return listActiveExecutions(db, options.projectId, options.epicId);
    } catch (error) {
      throw unlistableActives(error);
    }
  };

  // --- Phase 1: bounded natural-drain courtesy (durable authority only). ----
  let actives = readActives();
  const activeBeforeDrain = actives.length;
  const drainDeadline = Date.now() + drainMs;
  while (actives.length > 0 && Date.now() < drainDeadline) {
    await new Promise(resolve => setTimeout(resolve, TERMINAL_DRAIN_POLL_MS));
    actives = readActives();
  }
  const drainedToZero = actives.length === 0;
  if (activeBeforeDrain > 0) {
    log(
      `[supervision] terminal-run natural drain (ADR-087): ${activeBeforeDrain} active -> `
      + `${actives.length} within ${drainMs}ms${drainedToZero ? ' (converged naturally)' : ''}`,
    );
  }

  // --- Phase 2: ordinary supervision reconcile. -----------------------------
  let reconciled: SupervisionReconcileResult;
  try {
    reconciled = handle.reconcileOnce();
    if (reconciled.reapedCount > 0) {
      log(
        `[supervision] terminal-run reconcile reaped ${reconciled.reapedCount} execution(s) `
        + `(released=${reconciled.releasedCount} lost_dead_pid=${reconciled.lostDeadPidCount})`,
      );
    }
  } catch (error) {
    throw new TerminalWorkerSettlementError(
      'RECONCILE_FAILED',
      [],
      'terminal-run ordinary supervision reconcile failed: '
        + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // --- Phase 3: receipt-authoritative settlement of remaining actives. -----
  actives = readActives();
  const settled: TerminalSettlementEntry[] = [];
  const residuals: TerminalSettlementResidual[] = [];
  for (const row of actives) {
    if (row.accepted_receipt !== 1) {
      residuals.push({
        executionId: row.execution_id,
        taskId: row.task_id,
        code: 'NO_ACCEPTED_RECEIPT',
        detail: 'active at the terminal boundary without an accepted '
          + 'worker_done/presentation_close receipt — refusing to fabricate completion',
      });
      continue;
    }
    // ADR-087 truthfulness: record whether the PID was STILL ALIVE at
    // settlement. Local rows are probed read-only; remote rows are not
    // probed (a foreign-host PID is not observable from here).
    const pidAlive = row.machine_id === hostname && row.pid !== null
      ? probe.isAlive(row.pid)
      : null;
    const reason = 'ADR-087 terminal-run receipt-authoritative settlement: accepted '
      + 'worker_done/presentation_close receipt re-verified by the fenced atomic release; '
      + `PID ${row.pid ?? 'n/a'} `
      + (pidAlive === true
        ? 'STILL ALIVE at settlement (semantic exited; process NOT killed; physical tail left to late backfill)'
        : pidAlive === false
          ? 'not alive at settlement'
          : 'liveness not probed (remote machine)')
      + '; exit_code stays null until the late close backfill observes a real code';
    let outcome: ReleaseOutcome;
    try {
      outcome = releaseExecutionAtomically(db, {
        executionId: row.execution_id,
        terminalState: 'exited',
        exitCode: null,
        reason,
      });
    } catch (error) {
      residuals.push({
        executionId: row.execution_id,
        taskId: row.task_id,
        code: 'SETTLE_WRITE_FAILED',
        detail: `fenced atomic release failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }
    // Only the durable terminal-write CAS winner emits worker.exit. A losing
    // writer (row already terminalized by the runner or a sweep) stays silent:
    // the winner emitted, and the late close can only backfill exit evidence.
    const emittedWorkerExit = outcome.terminalized === true
      && outcome.effectiveTerminal === 'exited';
    if (emittedWorkerExit) {
      journalEvent('worker.exit', {
        execution_id: row.execution_id,
      }, {
        task_id: row.task_id,
        exit_code: null,
        worker_done_received: true,
        pid_alive: pidAlive,
        physical_exit_observed: false,
        exit_code_source: 'late_backfill_pending',
        outcome: 'receipt_authoritative_settlement',
        observer: 'worker-supervision',
        settlement: 'adr-087-terminal-drain',
        released: outcome.taskReleased,
        reason,
      });
    }
    settled.push({
      executionId: row.execution_id,
      taskId: row.task_id,
      pidAlive,
      taskReleased: outcome.taskReleased,
      emittedWorkerExit,
    });
  }
  if (settled.length > 0) {
    log(
      `[supervision] terminal-run settlement settled ${settled.length} receipt-backed execution(s): `
      + settled.map(s => `${s.executionId}(pid_alive=${s.pidAlive},exit=${s.emittedWorkerExit ? 'emitted' : 'already-terminal'})`)
        .join(' '),
    );
  }

  // --- Phase 4: final active recount — fail closed. -------------------------
  let remaining: ActiveExecutionRow[];
  try {
    remaining = listActiveExecutions(db, options.projectId, options.epicId);
  } catch (error) {
    throw unlistableActives(error);
  }
  for (const row of remaining) {
    if (residuals.some(r => r.executionId === row.execution_id)) continue;
    residuals.push({
      executionId: row.execution_id,
      taskId: row.task_id,
      code: 'STILL_ACTIVE',
      detail: 'still active after the receipt-authoritative terminal settlement',
    });
  }
  if (residuals.length > 0) {
    throw new TerminalWorkerSettlementError(
      'RESIDUAL_ACTIVE_EXECUTIONS',
      residuals,
      `terminal run leaves ${residuals.length} unaccounted active execution(s): `
        + residuals.map(r => `${r.executionId}[${r.code}]`).join(', '),
    );
  }

  return {
    drainMs,
    activeBeforeDrain,
    drainedToZero,
    settled,
    reconciled,
    activeRemaining: remaining.length,
  };
}
