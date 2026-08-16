/**
 * Antifreeze layer B3 — global bounded busy-retry for engine DB writes.
 *
 * TB-2 freeze class (docs/testing/WORKSHOP-BUGS.md), generalized from the
 * point fix 9a41748f (src/worker-executions.ts): a better-sqlite3 write that
 * collides with the write lock busy-spins ON THE MAIN THREAD for the full
 * busy_timeout (getDb() keeps 5000ms for compatibility). If the lock holder
 * is released by a timer/callback of the SAME process, the spin is eternal —
 * the event loop never gets to run the release. This helper is the rule the
 * point fix was the exception to:
 *
 *   - each attempt gets a SHORT busy window (default 250ms) so the spin can
 *     never exceed a bounded slice;
 *   - SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT are retried a bounded number of
 *     times with small synchronous backoff (the event loop is blocked inside
 *     a sync write anyway, so the backoff uses Atomics.wait — the exact
 *     pattern proven in 9a41748f);
 *   - after the budget is exhausted the caller receives the TYPED
 *     EngineDbBusyError (code ENGINE_DB_BUSY) instead of a raw SqliteError —
 *     the engine's existing per-path error handling takes over (skip this
 *     sweep, poison this card, defer this heartbeat) instead of hanging.
 *
 * When a shared connection (getDb(), busy_timeout=5000) is passed as
 * `options.db`, the helper lowers busy_timeout for the duration of the retry
 * window and restores the previous value afterwards — non-wrapped callers of
 * the same connection keep the old 5s wait semantics.
 */

import type Database from 'better-sqlite3';

export const ENGINE_DB_BUSY = 'ENGINE_DB_BUSY';

/** Typed exhaustion of the bounded busy-retry budget — catchable by code. */
export class EngineDbBusyError extends Error {
  readonly code: string = ENGINE_DB_BUSY;
  /** Attempts actually made before giving up. */
  readonly attempts: number;
  /** The last underlying SqliteError (SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT). */
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(
      `ENGINE_DB_BUSY: database stayed busy after ${attempts} bounded attempt(s)`,
    );
    this.name = 'EngineDbBusyError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** True for the busy-family SqliteError codes better-sqlite3 can surface. */
export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY'));
}

/**
 * Synchronous sleep for the bounded backoff. The caller is synchronous
 * better-sqlite3 code — the event loop is blocked anyway — so Atomics.wait is
 * the correct primitive (same pattern as 9a41748f / worker-executions.ts).
 */
export function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

export interface BusyRetryOptions {
  /** Max attempts (default 3 — the budget proven by 9a41748f). */
  attempts?: number;
  /**
   * Total wall-clock budget for the whole retry window, sleeps included
   * (default 2000ms). The window is abandoned early once exceeded.
   */
  maxWaitMs?: number;
  /**
   * Per-attempt busy_timeout applied to `options.db` (default 250ms). Bounds
   * each spin slice; the previous value is restored on exit.
   */
  busyTimeoutMs?: number;
  /**
   * Shared connection the callback writes through (e.g. getDb()). Optional —
   * connections that already carry their own short busy_timeout (the
   * worker-executions cache) can retry without the pragma dance.
   */
  db?: Database.Database;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_WAIT_MS = 2_000;
const DEFAULT_BUSY_TIMEOUT_MS = 250;
const FIRST_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 100;

export function withBusyRetry<T>(fn: () => T, options: BusyRetryOptions = {}): T {
  const maxAttempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const db = options.db;

  const startedAt = Date.now();
  let previousTimeout: number | null = null;
  if (db) {
    try {
      previousTimeout = db.pragma('busy_timeout', { simple: true }) as number;
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    } catch {
      // Pragmas unavailable on this handle (closed/exotic) — retry without
      // the per-attempt bound; attempts budget still applies.
      previousTimeout = null;
    }
  }

  try {
    let lastError: unknown;
    let madeAttempts = 0;
    // Loop with attempt budget AND wall-clock budget; either may end it.
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      madeAttempts = attempt;
      try {
        return fn();
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        lastError = error;
        if (attempt === maxAttempts) break;
        const elapsed = Date.now() - startedAt;
        const backoff = Math.min(FIRST_BACKOFF_MS * attempt, MAX_BACKOFF_MS);
        if (elapsed + backoff >= maxWaitMs) break;
        sleepSync(backoff);
      }
    }
    throw new EngineDbBusyError(madeAttempts, lastError);
  } finally {
    if (db && previousTimeout !== null) {
      try {
        db.pragma(`busy_timeout = ${previousTimeout}`);
      } catch {
        // restore best-effort; the connection keeps the short timeout
      }
    }
  }
}
