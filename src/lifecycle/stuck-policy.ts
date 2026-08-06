/**
 * ════════════════════════════════════════════════════════════════════════════
 * Uncle Bob Wave 2 / FU-D — PURE stuck-state policy for the worker reaper.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Source: FU-D investigation. `src/worker-executions.ts::reconcileWorkerExecutions`
 * historically mixed POLICY (silence thresholds, grace windows, lease-expiry
 * logic, stuck-state transitions) with MECHANISM (probe.isAlive,
 * probe.killVerified, releaseExecutionAtomically, SQL UPDATEs). This module
 * extracts the POLICY into a pure `decideStuckAction(input) => Action` function
 * that holds ZERO IO: no SQLite, no probe, no DB write, no fs, no node:*.
 *
 * It mirrors the `resume-compatibility-policy.ts` pattern (Wave 8): the caller
 * (the reaper mechanism) precomputes every IO-dependent boolean (isAlive,
 * birthTokenMatches, ownsActiveTask, ...) from the row + the OS probe, builds a
 * {@link StuckPolicyInput}, calls {@link decideStuckAction}, and then dispatches
 * on the returned {@link StuckAction} to perform the IO. The long reason
 * literals live here as data on the Action, not as inline strings in the
 * mechanism.
 *
 * BYTE-IDENTITY CONTRACT: this function MUST produce the same decision the
 * procedural code in worker-executions.ts produced for every input combination,
 * except for explicitly documented incident repairs such as the durable
 * worker_done finishing exception below. The DB-backed tests in
 * tests/architecture/worker-supervision-reaper.test.mjs are the golden
 * characterization. The pure table-driven tests in
 * tests/lifecycle/stuck-policy.test.mjs cover the corners the DB harness cannot
 * reach cheaply.
 *
 * ADR-022 retired the global ClockPort; this module reintroduces a NARROW LOCAL
 * {@link SupervisionClock} for the reaper only — never registered globally,
 * never injected across the architecture. The mechanism accepts an optional
 * instance (default real wall-clock); tests inject a fixed clock.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Narrow local clock for the reaper policy. ADR-022 retired the global
 * ClockPort; this is the narrow replacement promised there — local to worker
 * supervision, NOT registered in any global port registry. The mechanism
 * constructs a default `{ now: () => new Date() }`; tests inject a fixed clock
 * for determinism. The clock returns a Date (not a number) to match the shape
 * of the retired port and to keep epoch arithmetic out of the interface.
 */
export interface SupervisionClock {
  now(): Date;
}

/** Default real wall-clock supervision clock. */
export const REAL_SUPERVISION_CLOCK: SupervisionClock = {
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Thresholds. Moved verbatim from worker-executions.ts (lines 9-21). These are
// the policy knobs; changing them here changes the reaper's behavior.
// ---------------------------------------------------------------------------

/** Reserved execution boot timeout: 60s to acquire a PID before spawn_failed. */
export const RESERVED_BOOT_TIMEOUT_MS = 60_000;
/** Finishing grace: keep while phase/progress activity is less than 30s old. */
export const FINISH_GRACE_MS = 30_000;
/** 10 min with no progress_at advance → suspected_stuck. */
export const STUCK_SILENCE_MS = 10 * 60 * 1000;
/** 5 min after suspected_stuck → cancel_requested. */
export const STUCK_CANCEL_GRACE_MS = 5 * 60 * 1000;
/** 1 min after cancel_requested → terminate (only if PID birth verified). */
export const CANCEL_GRACE_MS = 60_000;
/**
 * Wave 8 HIGH 5B — PID-reuse escalation grace. When a row is in
 * cancel_requested past the kill grace AND the PID birth token no longer
 * matches (scenario 16: the OS recycled the PID), the reaper refuses to kill
 * an unrelated process. Without an escalation path the card would stay locked
 * forever waiting for a human. After this grace elapses (measured from the
 * cancel_requested_at stamp), the policy escalates to RELEASE: the process is
 * either dead or stolen, but the card MUST return to the queue. This is a
 * human-notification event, not a permanent block. 10 min keeps it well above
 * the per-sweep jitter while bounding the worst-case stall.
 */
export const PID_REUSE_GRACE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// The policy decision surface.
// ---------------------------------------------------------------------------

/**
 * The action the reaper MECHANISM must perform for one execution. The kind is
 * the dispatch key; the `reason` is an audit string carried as data (it becomes
 * the `reason` field on the {@link ReconcileResult} and/or the
 * `last_error`/audit event on the execution row).
 *
 *   - KEEP                       → push a `kept` result; do not touch the row.
 *   - MARK_SUSPECTED             → stamp suspected_stuck + suspected_stuck_at,
 *                                  then push a `kept` result. (No release.)
 *   - REQUEST_CANCEL             → stamp cancel_requested + cancel_requested_at,
 *                                  then push a `kept` result. (No release.)
 *   - TERMINATE                  → verified PID identity: the mechanism MUST
 *                                  call probe.killVerified(pid, token) and, on
 *                                  success, releaseExecutionAtomically(
 *                                  terminal='terminated'). If killVerified
 *                                  fails the mechanism pushes a `kept` result.
 *                                  Also returned for alive + lease-expired
 *                                  (Wave 8 HIGH 5A): the supervisor authority
 *                                  is gone, so the still-running process MUST
 *                                  be killed (after birth-token verification)
 *                                  before its card is released — releasing
 *                                  without killing would let a second worker
 *                                  claim the same card while the first is
 *                                  still spinning.
 *   - TERMINATE_BUT_PID_REUSE    → KEEP for a human on THIS sweep. PID is alive
 *                                  but its birth token changed (scenario 16):
 *                                  NEVER kill on this sweep. The row is left
 *                                  fenced. The policy escalates this state to
 *                                  RELEASE once PID_REUSE_GRACE_MS has elapsed
 *                                  since cancel_requested_at (Wave 8 HIGH 5B),
 *                                  so a reused-PID card cannot lock the queue
 *                                  forever.
 *   - RELEASE                    → releaseExecutionAtomically with the named
 *                                  terminal state ('lost' | 'spawn_failed' |
 *                                  'terminated'). No kill (the process is
 *                                  either already gone, never spawned, was
 *                                  verified-dead by an upstream TERMINATE, OR
 *                                  the PID-reuse grace was exhausted and the
 *                                  card is being returned to prevent a
 *                                  permanent stall).
 */
export type StuckAction =
  | { readonly kind: 'KEEP'; readonly reason: string }
  | { readonly kind: 'MARK_SUSPECTED'; readonly reason: string }
  | { readonly kind: 'REQUEST_CANCEL'; readonly reason: string }
  | { readonly kind: 'TERMINATE'; readonly reason: string }
  | { readonly kind: 'TERMINATE_BUT_PID_REUSE'; readonly reason: string }
  | {
      readonly kind: 'RELEASE';
      readonly terminal: 'lost' | 'spawn_failed' | 'terminated';
      readonly reason: string;
    };

/**
 * Pure input to {@link decideStuckAction}. The mechanism precomputes EVERY
 * IO-dependent field from the joined worker_executions+tasks row and the OS
 * probe, then hands the snapshot to the policy. Timestamps are epoch ms (0 when
 * the DB column is NULL); the policy never parses a string.
 *
 * `isAlive` is the probe verdict for THIS host (false for reserved rows, which
 * have no PID). `birthTokenMatches` is `pid != null && expectedToken != null &&
 * probe.readBirthToken(pid) === expectedToken` — precomputed once so the policy
 * is pure. The legitimacy booleans mirror the procedural code's three
 * "execution still owns an allowed lifecycle phase" conditions.
 */
export interface StuckPolicyInput {
  /** True iff `row.machine_id === thisHost`. Remote rows skip PID logic. */
  readonly isLocal: boolean;
  /** Sweep wall-clock, epoch ms. */
  readonly nowMs: number;
  /** Epoch ms of `reserved_at`. Always non-null (schema requires it). */
  readonly reservedAtMs: number;
  /** Epoch ms of `lease_expires_at`; 0 when NULL. */
  readonly leaseExpiresAtMs: number;
  /** Epoch ms of `progress_at`; 0 when NULL. */
  readonly progressAtMs: number;
  /** Epoch ms of `suspected_stuck_at`; 0 when NULL. */
  readonly suspectedStuckAtMs: number;
  /** Epoch ms of `cancel_requested_at`; 0 when NULL. */
  readonly cancelRequestedAtMs: number;
  /** Epoch ms of `phase_updated_at`. */
  readonly phaseUpdatedAtMs: number;
  /** Execution row `state`. */
  readonly state: 'reserved' | 'running' | 'cancel_requested';
  /** Execution row `stuck_state`; NULL on a fresh row (treated as 'active'). */
  readonly stuckState: 'active' | 'suspected_stuck' | 'cancel_requested' | null;
  /** Execution row `phase` (e.g. 'running' | 'finishing' | 'integrating'). */
  readonly phase: string;
  /** Precomputed: probe.isAlive(pid), forced false for `reserved` rows. */
  readonly isAlive: boolean;
  /**
   * Precomputed: `pid != null && expectedToken != null &&
   * probe.readBirthToken(pid) === expectedToken`. False when either side is
   * missing OR when the live token differs (PID reuse — scenario 16).
   */
  readonly birthTokenMatches: boolean;
  /**
   * Precomputed legitimacy #1: the execution fence matches AND the task is
   * `in_progress`/`review_in_progress` and assigned to this worker.
   */
  readonly ownsActiveTask: boolean;
  /** Precomputed legitimacy #2: phase='integrating', task='done', integration='pending', fence ours. */
  readonly legitimateIntegration: boolean;
  /**
   * Legacy precomputed legitimacy #3: fenced phase='finishing' inside the
   * original phase-age grace. The policy also derives the post-worker_done
   * fence-free finishing case directly from phase/progress timestamps.
   */
  readonly legitimateFinishing: boolean;
}

/**
 * Decide the reaper action for one execution. PURE: same input ⇒ same action,
 * every time. No IO, no DB, no probe, no clock read (nowMs is an input).
 *
 * The decision tree mirrors worker-executions.ts::reconcileWorkerExecutions
 * except for incident fixes explicitly documented in this policy.
 *
 * Order of decisions (load-bearing — do not reorder):
 *   1. Remote row           → leaseExpired ? RELEASE(lost) : KEEP.
 *   2. Dead/reserved-expired/reserved-lease-expired local → RELEASE.
 *   2a. Fresh durable finishing process → KEEP, even after its task fence was
 *       released; worker_done already revoked mutation authority.
 *   3. Alive local lease expired → TERMINATE, unless step 2a matched.
 *   4. Stuck stage 1+2      → MARK_SUSPECTED, or REQUEST_CANCEL.
 *   5. Stuck stage 3        → verified termination / PID-reuse handling.
 *   6. Legitimate phase     → KEEP.
 *   7. Alive but illegit    → TERMINATE.
 */
export function decideStuckAction(input: StuckPolicyInput): StuckAction {
  // -------------------------------------------------------------------------
  // (1) REMOTE execution: decide from the durable lease, NEVER from a PID guess.
  // A remote PID belongs to another host — we cannot verify or kill it. We DO
  // release once its LEASE has expired (the durable signal the remote foreman
  // is gone). A live lease is left untouched.
  // -------------------------------------------------------------------------
  if (!input.isLocal) {
    const leaseExpired = input.leaseExpiresAtMs !== 0 && input.nowMs >= input.leaseExpiresAtMs;
    if (leaseExpired) {
      return {
        kind: 'RELEASE',
        terminal: 'lost',
        reason: 'remote lease expired and no trusted supervisor owns it (foreman/host gone)',
      };
    }
    return {
      kind: 'KEEP',
      reason: 'remote execution; lease still alive, decision deferred to durable lease',
    };
  }

  // -------------------------------------------------------------------------
  // (2) LOCAL execution release gate — DEAD / reserved-expired rows only.
  // -------------------------------------------------------------------------
  const notAlive = input.state !== 'reserved' && !input.isAlive;
  const reservedExpired = input.state === 'reserved'
    && input.nowMs - input.reservedAtMs >= RESERVED_BOOT_TIMEOUT_MS;
  const leaseExpired = input.leaseExpiresAtMs !== 0 && input.nowMs >= input.leaseExpiresAtMs;
  const reservedLeaseExpired = input.state === 'reserved' && leaseExpired;

  if (notAlive || reservedExpired || reservedLeaseExpired) {
    const terminal = input.state === 'reserved' ? 'spawn_failed' : 'lost';
    const reason = reservedExpired
      ? 'spawn reservation timed out'
      : reservedLeaseExpired
        ? 'lease expired (foreman/supervisor gone) during spawn reservation'
        : !input.isAlive
          ? 'OS process is not alive'
          : 'lease expired (foreman/supervisor gone) while local process could not be confirmed alive';
    return { kind: 'RELEASE', terminal, reason };
  }

  // -------------------------------------------------------------------------
  // (2a) Durable worker_done finishing grace.
  //
  // `phase='finishing'` is written by worker_done inside the same IMMEDIATE
  // transaction that stores the accepted command receipt. Once committed, the
  // task/Workplace may legitimately clear assigned_to and current_execution_id
  // before Node delivers the OS close callback. Therefore task fence ownership
  // is no longer required for this bounded process-cleanup phase.
  //
  // Use the latest of phase_updated_at and progress_at. A model stream/log
  // event after worker_done proves the process is still making shutdown
  // progress and refreshes the 30-second grace. Once output goes silent beyond
  // FINISH_GRACE_MS, ordinary termination policy applies.
  // -------------------------------------------------------------------------
  const finishingActivityAtMs = Math.max(
    input.phaseUpdatedAtMs,
    input.progressAtMs,
  );
  const freshDurableFinishing = input.phase === 'finishing'
    && finishingActivityAtMs !== 0
    && input.nowMs - finishingActivityAtMs < FINISH_GRACE_MS;
  if (
    input.isAlive
    && (input.legitimateFinishing || freshDurableFinishing)
  ) {
    return {
      kind: 'KEEP',
      reason: 'accepted worker_done; finishing process still within activity grace',
    };
  }

  // -------------------------------------------------------------------------
  // (3) Alive local lease expired. A still-authoritative worker must be killed
  // before its card can be reassigned. The completed finishing exception above
  // is safe because worker_done already revoked mutation authority.
  // -------------------------------------------------------------------------
  const aliveLeaseExpired = input.isAlive && leaseExpired;
  if (aliveLeaseExpired) {
    return {
      kind: 'TERMINATE',
      reason: 'lease expired (foreman/supervisor gone) — alive process killed after verified PID identity to prevent double-assignment',
    };
  }

  // -------------------------------------------------------------------------
  // (4) Stuck policy — stages 1 & 2.
  // -------------------------------------------------------------------------
  if (input.isAlive && input.stuckState !== 'cancel_requested') {
    const progressSilent = input.progressAtMs !== 0
      && input.nowMs - input.progressAtMs >= STUCK_SILENCE_MS;
    if (progressSilent) {
      const freshlyEnteringSuspected = input.stuckState !== 'suspected_stuck';
      const since = freshlyEnteringSuspected
        ? input.nowMs
        : (input.suspectedStuckAtMs || input.progressAtMs || 0);
      const cancelGraceMet = input.nowMs - since >= STUCK_CANCEL_GRACE_MS;

      if (!freshlyEnteringSuspected && cancelGraceMet) {
        return {
          kind: 'REQUEST_CANCEL',
          reason: 'progress silent past grace — cancellation requested',
        };
      }

      if (input.ownsActiveTask || input.legitimateIntegration || input.legitimateFinishing) {
        return { kind: 'MARK_SUSPECTED', reason: 'progress silent past grace — suspected stuck' };
      }
      // Fall through to final alive-illegitimate termination.
    }
  }

  // -------------------------------------------------------------------------
  // (5) Stuck stage 3 — cancel_requested past the kill grace.
  // -------------------------------------------------------------------------
  if (input.isAlive && input.stuckState === 'cancel_requested') {
    const since = input.cancelRequestedAtMs || input.nowMs;
    if (input.nowMs - since >= CANCEL_GRACE_MS) {
      if (!input.birthTokenMatches) {
        const reuseAge = input.nowMs - since;
        if (reuseAge >= PID_REUSE_GRACE_MS) {
          return {
            kind: 'RELEASE',
            terminal: 'lost',
            reason: 'PID reuse grace exhausted — card released to prevent permanent stall (scenario 16; notify human)',
          };
        }
        return {
          kind: 'TERMINATE_BUT_PID_REUSE',
          reason: 'cancel grace expired but PID birth token changed — left for human (PID reuse suspected, scenario 16)',
        };
      }
      return {
        kind: 'TERMINATE',
        reason: 'stuck past cancel grace — terminated after verified PID identity',
      };
    }
  }

  // -------------------------------------------------------------------------
  // (6) Legitimate phase — alive execution that still owns an allowed task
  // phase is left alone. Fresh finishing was handled earlier because it no
  // longer requires ownership of the released task fence.
  // -------------------------------------------------------------------------
  if (input.isAlive && (input.ownsActiveTask || input.legitimateIntegration || input.legitimateFinishing)) {
    return {
      kind: 'KEEP',
      reason: 'execution still owns an allowed lifecycle phase',
    };
  }

  // -------------------------------------------------------------------------
  // (7) Alive but illegitimate — terminate (kill + release).
  // -------------------------------------------------------------------------
  if (input.isAlive) {
    return {
      kind: 'TERMINATE',
      reason: 'execution no longer owns an allowed task phase',
    };
  }

  return { kind: 'KEEP', reason: 'no action — local row not alive and not released' };
}
