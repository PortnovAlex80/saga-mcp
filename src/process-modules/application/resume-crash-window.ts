// src/process-modules/application/resume-crash-window.ts
//
// BLINDSIGHT CENSUS, Lifecycle layer F4 + F5 — the crash-window analysis the
// GenericFlowExecutor's resume path must READ before continuing.
//
//   F5 — the resume cursor is `readLastCompletedV2` (the last COMPLETED
//        non-paused NodeRun). Failed NodeRuns written AFTER that cursor and
//        BEFORE the crash are durable in factory_node_runs, but the resume
//        decision never read them: the walk continued as if nothing failed.
//
//   F4 — the walk's malformed-cycle bound (maxSteps) restarts at zero on
//        every resume while the durable attempt rows accumulate — the attempt
//        counter is write-only. A factory restarted 10 times got 10 fresh
//        anti-cycle budgets.
//
// CONVEYOR §15 — "Budget must count spin, not work" (the separation
// mechanism, applied to the crash window):
//   - the budget seed charges FAILED durable attempts only: a failed attempt
//     burned engine budget without producing a completed node; completed rows
//     are work and are never taxed;
//   - the spin guard keys on REASON IDENTITY (the same typed error code
//     repeating CONSECUTIVELY on the same node), never on bare iteration
//     count — a chain of DISTINCT codes is converging work and must pass;
//   - the honest end is the typed RESUME_SPIN_DETECTED error (fail-closed),
//     not a silent re-execution of a node that deterministically fails.
//
// Pure by design: no SQL, no clock, no storage — the caller passes the
// durable rows it already read (listV2) and receives the decision inputs.

/** Same-reason spin threshold — mirrors OBLIGATION_VALVE_REPEAT_THRESHOLD (§15: N=3). */
export const RESUME_SPIN_REPEAT_THRESHOLD = 3;

/** One failed NodeRun between the resume cursor and the crash. */
export interface ResumeCrashWindowDebris {
  readonly nodeId: string;
  readonly attempt: number;
  /** Typed identity of the failure — the CODE prefix before the first colon. */
  readonly errorCode: string;
}

/** A detected same-reason spin on the node the resume is about to re-enter. */
export interface ResumeSpin {
  readonly nodeId: string;
  readonly errorCode: string;
  readonly consecutive: number;
}

export interface ResumeCrashWindowReport {
  /**
   * F5 delivery — the failed NodeRuns in the (cursor, crash) interval, in
   * durable row order. Empty for a clean resume (a hard crash leaves the row
   * status='running', not 'failed' — only executor-detected failures land
   * here).
   */
  readonly failedAfterCursor: readonly ResumeCrashWindowDebris[];
  /**
   * F4 seed — the count of ALL durable failed attempts of the process run
   * (including pre-cursor ones). The walk's anti-cycle budget starts with
   * this many steps already consumed.
   */
  readonly durableFailedAttempts: number;
  /**
   * §15 spin verdict — non-null when the node the resume is about to
   * re-enter failed >= RESUME_SPIN_REPEAT_THRESHOLD times CONSECUTIVELY with
   * the SAME typed error code in the crash window.
   */
  readonly spin: ResumeSpin | null;
}

/** Minimal durable-row shape the analyzer needs (NodeRunRecord subset). */
export interface ResumeCrashWindowRow {
  readonly id: number;
  readonly nodeId: string;
  readonly status: string;
  readonly attempt: number;
  readonly errorMessage: string | null;
}

/**
 * Typed identity of a NodeRun failure: the first line's CODE prefix before
 * the first colon (the fail-closed vocabulary style — same convention as
 * `obligationReasonKey('failed', …)`). Prose after the colon is volatile. A
 * message without a colon is its own identity.
 */
export function nodeRunErrorKeyCode(errorMessage: string | null): string {
  const firstLine = String(errorMessage ?? '').trim().split('\n', 1)[0] ?? '';
  const code = firstLine.split(':', 1)[0] || firstLine;
  return code.slice(0, 200);
}

/**
 * Analyze the crash window of one process run.
 *
 * @param allRuns — every durable NodeRun row of the run (listV2 output), any
 *   order (sorted internally by id).
 * @param lastCompletedId — the resume cursor: the id of the last COMPLETED
 *   non-paused NodeRun, or null when no node ever completed.
 * @param reenterNodeId — the node the resume is about to execute next. When
 *   omitted, the LATEST failed node of the window is the implied re-entry
 *   target (that is exactly where the next attempt lands after a crash).
 */
export function analyzeResumeCrashWindow(
  allRuns: readonly ResumeCrashWindowRow[],
  lastCompletedId: number | null,
  reenterNodeId?: string,
): ResumeCrashWindowReport {
  const ordered = [...allRuns].sort((left, right) => left.id - right.id);
  const isDebris = (row: ResumeCrashWindowRow): boolean =>
    row.status === 'failed'
    && (lastCompletedId === null || row.id > lastCompletedId);
  const failedAfterCursor: ResumeCrashWindowDebris[] = [];
  for (const row of ordered) {
    if (!isDebris(row)) continue;
    failedAfterCursor.push({
      nodeId: row.nodeId,
      attempt: row.attempt,
      errorCode: nodeRunErrorKeyCode(row.errorMessage),
    });
  }
  const durableFailedAttempts = ordered
    .filter((row) => row.status === 'failed').length;

  const debrisRows = ordered.filter(isDebris);
  const targetNodeId = reenterNodeId
    ?? (debrisRows.length > 0 ? debrisRows[debrisRows.length - 1]!.nodeId : undefined);
  let spin: ResumeSpin | null = null;
  if (targetNodeId !== undefined) {
    const windowRows = debrisRows
      .filter((row) => row.nodeId === targetNodeId);
    let consecutive = 0;
    let lastCode: string | null = null;
    for (const row of windowRows) {
      const code = nodeRunErrorKeyCode(row.errorMessage);
      consecutive = code === lastCode ? consecutive + 1 : 1;
      lastCode = code;
    }
    if (lastCode !== null && consecutive >= RESUME_SPIN_REPEAT_THRESHOLD) {
      spin = { nodeId: targetNodeId, errorCode: lastCode, consecutive };
    }
  }

  return { failedAfterCursor, durableFailedAttempts, spin };
}

/**
 * The typed fail-closed error the walk throws when the crash-window analysis
 * detects same-reason spin on the node it is about to re-enter. Ending the
 * run with a typed cause is the honest §15 terminal — the silent alternative
 * is re-executing a deterministically failing node once per factory restart.
 */
export class ResumeSpinDetectedError extends Error {
  constructor(readonly spin: ResumeSpin) {
    super(
      `RESUME_SPIN_DETECTED: node '${spin.nodeId}' failed `
      + `${spin.consecutive} consecutive time(s) with the same typed error `
      + `'${spin.errorCode}' between the resume cursor and the crash — `
      + 'CONVEYOR §15 spin valve at resume: the walk fails closed instead of '
      + 'silently re-executing a deterministic failure',
    );
    this.name = 'ResumeSpinDetectedError';
  }
}
