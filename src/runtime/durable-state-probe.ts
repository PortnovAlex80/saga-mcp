/**
 * Antifreeze layer B2 — readonly durable-state probe for the engine wait loop.
 *
 * TB-2 freeze class (docs/testing/WORKSHOP-BUGS.md): when the engine's MAIN
 * connection (getDb(), busy_timeout=5000) hits write-lock contention, the
 * better-sqlite3 busy handler spins ON THE MAIN THREAD — the event loop is
 * frozen (timers dead), and if the lock holder is freed by a timer/callback of
 * the SAME process the spin is eternal. The point fix 9a41748f bounded the
 * worker-executions module; this layer removes the WAIT LOOP's reads from the
 * shared writer connection entirely.
 *
 * A readonly WAL connection never takes a write lock and is not blocked by
 * writers: SQLite readers in WAL mode read the latest committed snapshot
 * without contending the single writer slot. This probe is one such dedicated
 * readonly connection per engine process, used EXCLUSIVELY by the hot wait
 * loop (per-second worker polls, per-iteration kernel checks, the paused
 * active-execution count). Writers stay on the main connection.
 *
 * Failure policy is fail-closed and never throws: any error (locked schema,
 * busy, closed handle, missing table mid-migration) reports "unknown" —
 * false / -1 — and drops the connection so the next poll (1s later) reopens
 * against the current file state. The probe must never be used for writes.
 */

import Database from 'better-sqlite3';

/** Per-attempt busy budget for the readonly probe. Errors become `false`. */
const PROBE_TIMEOUT_MS = 250;

export interface DurableStateProbe {
  /**
   * True when the worker execution is in a durable terminal state
   * (exited/lost/terminated/spawn_failed). Same SQL the loop previously ran
   * on the main connection; unknown → false.
   */
  isExecutionDurableTerminal(executionId: string): boolean;
  /**
   * True when the kernel (ProductionCell) owns rightward work for the epic —
   * workplaces in repair_wait/verifying/effect_pending under a live process
   * run. Same SQL the loop previously ran on the main connection;
   * unknown → false.
   */
  isKernelWorkPending(epicId: number): boolean;
  /**
   * Count of durable executions in reserved/running/cancel_requested for the
   * (project, epic) scope. Unknown → -1: callers must treat any non-zero
   * (including -1) as "still active — keep waiting".
   */
  countActiveExecutions(projectId: number, epicId: number): number;
  /** Close the probe connection (engine finally). Idempotent. */
  close(): void;
}

export function createDurableStateProbe(dbPath: string): DurableStateProbe {
  let db: Database.Database | null = null;

  const open = (): Database.Database => {
    if (!db) {
      // readonly: never a writer, immune to write-lock contention.
      // timeout: a bound on the (rare) blocked-read case — a frozen probe
      // would be a new freeze vector, so 250ms then error → false.
      db = new Database(dbPath, { readonly: true, timeout: PROBE_TIMEOUT_MS });
    }
    return db;
  };

  // Fail closed AND self-heal: drop the connection so the next poll reopens.
  // This survives schema migrations (readonly open on the fresh shape),
  // WAL recovery, and any transient file-level error.
  const failClosed = (): void => {
    try {
      db?.close();
    } catch {
      // already closed / broken — reopen lazily on the next poll
    }
    db = null;
  };

  return {
    isExecutionDurableTerminal(executionId: string): boolean {
      try {
        const row = open().prepare(
          `SELECT 1 FROM worker_executions
            WHERE execution_id=?
              AND state IN ('exited','lost','terminated','spawn_failed')
            LIMIT 1`,
        ).get(executionId);
        return row !== undefined;
      } catch {
        failClosed();
        return false;
      }
    },

    isKernelWorkPending(epicId: number): boolean {
      try {
        const row = open().prepare(
          `SELECT 1
             FROM factory_workplaces w
             JOIN factory_process_runs pr ON pr.id=w.process_run_id
            WHERE pr.epic_id=?
              AND pr.status IN ('running','paused')
              AND w.loop_state IN ('repair_wait','verifying','effect_pending')
            LIMIT 1`,
        ).get(epicId);
        return row !== undefined;
      } catch {
        failClosed();
        return false;
      }
    },

    countActiveExecutions(projectId: number, epicId: number): number {
      try {
        const row = open().prepare(
          `SELECT COUNT(*) AS n
             FROM worker_executions
            WHERE project_id=? AND epic_id=?
              AND state IN ('reserved','running','cancel_requested')`,
        ).get(projectId, epicId) as { n: number };
        return row.n;
      } catch {
        failClosed();
        return -1;
      }
    },

    close(): void {
      failClosed();
    },
  };
}
