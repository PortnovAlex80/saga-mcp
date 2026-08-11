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
 * procedural code in worker-executions.ts produced for every input combination.
 * The DB-backed tests in tests/architecture/worker-supervision-reaper.test.mjs
 * are the golden characterization: if any of them breaks, this policy diverged
 * and must be fixed. The pure table-driven tests in
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
   * derives the post-worker_done fence-free finishing grace from phase and
   * progress timestamps, because the task fence may already be released while
   * the OS process is still closing.
   */
  readonly legitimateFinishing: boolean;
  /** Exact accepted worker_done receipt exists for this execution. */
  readonly semanticCompletionAccepted?: boolean;
}

/**
 * Decide the reaper action for one execution. PURE: same input ⇒ same action,
 * every time. No IO, no DB, no probe, no clock read (nowMs is an input).
 *
 * The decision tree mirrors worker-executions.ts::reconcileWorkerExecutions
 * lines 361-576 BYTE-FOR-BYTE, including the subtle fall-through after a
 * MARK_SUSPECTED (when the cancel grace is not yet met, the row falls through
 * to the legitimacy / final-kill path) and the lease-first remote branch.
 *
 * Order of decisions (load-bearing — do not reorder):
 *   1. Remote row           → leaseExpired ? RELEASE(lost) : KEEP.
 *   2. Dead/reserved-expired/reserved-lease-expired local → RELEASE.
 *      (Wave 8 HIGH 5A: an ALIVE local row with an expired lease is NOT
 *      released here — it falls through to step 6's TERMINATE so the still-
 *      running process is killed before its card is released.)
 *   2a. Fresh finishing activity after durable worker_done → KEEP even after
 *       the task fence has been released.
 *   3. Stuck stage 1+2      → MARK_SUSPECTED, or REQUEST_CANCEL (which
 *                             short-circuits). MARK_SUSPECTED falls through.
 *   4. Stuck stage 3        → cancel grace met: TERMINATE_BUT_PID_REUSE (no
 *                             birth-token match) which escalates to
 *                             RELEASE(lost) once PID_REUSE_GRACE_MS elapses
 *                             (Wave 8 HIGH 5B), or TERMINATE (match).
 *   5. Legitimate phase     → KEEP (only when the lease is still alive; an
 *                             expired lease skips this gate — HIGH 5A).
 *   6. Alive but illegit    → TERMINATE (kill+release); the mechanism handles
 *                             killVerified failure by pushing KEEP. Also
 *                             reached by alive + lease-expired rows (HIGH 5A).
 */
export function decideStuckAction(input: StuckPolicyInput): StuckAction {
  // -------------------------------------------------------------------------
  // (1) REMOTE execution: decide from the durable lease, NEVER from a PID guess.
  // A remote PID belongs to another host — we cannot verify or kill it. We DO
  // release once the lease has expired (the durable signal the remote foreman
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
  //   - reserved rows have no PID; they are released ONLY by
  //     RESERVED_BOOT_TIMEOUT_MS expiry (or lease expiry), NEVER by !alive.
  //   - non-reserved rows are released when the OS process is DEAD (the lease
  //     may or may not have expired; a dead process is always safe to release).
  // Terminal state: reserved → 'spawn_failed'; otherwise 'lost'.
  //
  // Wave 8 HIGH 5A: an ALIVE local process with an EXPIRED lease is NOT
  // released here. Releasing without killing would let a second worker claim
  // the same card while the first is still spinning (two workers at one desk).
  // The supervisor authority is gone (lease expired), so the still-running
  // process must be KILLED after birth-token verification — that path is
  // TERMINATE, handled in step (6) below. We compute `leaseExpired` here only
  // to exclude it from this release gate for alive rows; the downstream
  // TERMINATE branch carries its own reason.
  // -------------------------------------------------------------------------
  const notAlive = input.state !== 'reserved' && !input.isAlive;
  const reservedExpired = input.state === 'reserved'
    && input.nowMs - input.reservedAtMs >= RESERVED_BOOT_TIMEOUT_MS;
  const leaseExpired = input.leaseExpiresAtMs !== 0 && input.nowMs >= input.leaseExpiresAtMs;
  // Reserved rows are always treated as not-alive for release purposes (no
  // PID to probe). A reserved row whose lease expired before the 60s boot
  // timeout is released here as spawn_failed.
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
  // worker_done writes phase='finishing' and its accepted receipt in the same
  // IMMEDIATE transaction. The task/Workplace may then release assigned_to and
  // current_execution_id before Node delivers the OS close callback. Therefore
  // task-fence ownership is no longer required for this bounded cleanup phase.
  // Fresh stream/log progress extends the grace; once both phase and progress
  // are older than FINISH_GRACE_MS, the ordinary termination path applies.
  // -------------------------------------------------------------------------
  const finishingActivityAtMs = Math.max(
    input.phaseUpdatedAtMs,
    input.progressAtMs,
  );
  const freshDurableFinishing = input.semanticCompletionAccepted
    && (input.phase === 'finishing' || input.phase === 'integrating')
    && finishingActivityAtMs !== 0
    && input.nowMs - finishingActivityAtMs < FINISH_GRACE_MS;
  if (
    input.isAlive
    && (input.legitimateFinishing || freshDurableFinishing)
  ) {
    return {
      kind: 'KEEP',
      reason: 'execution still owns an allowed lifecycle phase (worker_done finishing activity grace)',
    };
  }

  // Track whether the supervisor authority is gone for the alive paths below.
  // Wave 8 HIGH 5A: an alive local row with an expired lease MUST be
  // terminated (verified kill), NOT released and NOT kept. The lease is the
  // durable signal that the supervisor/foreman renewed it within the last
  // window; once it is gone, the still-spinning process is an orphan holding
  // a card. Releasing without killing let a second worker claim the same
  // card; keeping it trusts a process whose authority is dead. So lease
  // expiry dominates legitimacy and progress-silence: we fall straight to
  // step (6)'s TERMINATE. (Birth-token verification still happens in the
  // mechanism before the actual kill.)
  const aliveLeaseExpired = input.isAlive && leaseExpired;
  if (aliveLeaseExpired) {
    return {
      kind: 'TERMINATE',
      reason: 'lease expired (foreman/supervisor gone) — alive process killed after verified PID identity to prevent double-assignment',
    };
  }

  // -------------------------------------------------------------------------
  // (3) Stuck policy — stages 1 & 2.
  //   active → (progress silent > STUCK_SILENCE_MS) → suspected_stuck
  //   suspected_stuck → (suspected_stuck_at age > STUCK_CANCEL_GRACE_MS) →
  //   cancel_requested
  // Only consulted when alive AND not already cancel_requested. The progress
  // clock is measured against progress_at (BUG 2: NOT heartbeat_at).
  // -------------------------------------------------------------------------
  if (input.isAlive && input.stuckState !== 'cancel_requested') {
    const progressSilent = input.progressAtMs !== 0
      && input.nowMs - input.progressAtMs >= STUCK_SILENCE_MS;
    if (progressSilent) {
      // BYTE-IDENTITY: the procedural code mutates row.suspected_stuck_at =
      // nowIso IN MEMORY when it freshly stamps suspected_stuck, THEN computes
      // stage 2's `since = parseDbTime(row.suspected_stuck_at)`. So on the
      // sweep that FIRST enters suspected_stuck, `since` is `nowMs` (the
      // just-stamped value) and the cancel grace is NOT met (age 0). Only on
      // LATER sweeps, when stuck_state is already 'suspected_stuck', does
      // `since` use the persisted suspected_stuck_at. We model that here:
      const freshlyEnteringSuspected = input.stuckState !== 'suspected_stuck';
      const since = freshlyEnteringSuspected
        ? input.nowMs
        : (input.suspectedStuckAtMs || input.progressAtMs || 0);
      const cancelGraceMet = input.nowMs - since >= STUCK_CANCEL_GRACE_MS;

      // Already suspected AND the cancel grace has elapsed → enter
      // cancel_requested. (A fresh row can NEVER jump straight to
      // cancel_requested on its first sweep, because the in-memory stamp makes
      // `since = nowMs` and the grace is 0 — see the byte-identity note above.
      // This matches BUG 4's observed two-sweep transition.)
      if (!freshlyEnteringSuspected && cancelGraceMet) {
        return {
          kind: 'REQUEST_CANCEL',
          reason: 'progress silent past grace — cancellation requested',
        };
      }

      // Stage 1: progress silent, cancel grace not yet met (either a fresh
      // entry, or already-suspected but the grace has not elapsed). The
      // procedural code stamps suspected_stuck_at and then FALLS THROUGH (no
      // `continue`): it proceeds to the legitimacy check and, if not legit,
      // the final-alive kill path. To preserve byte-identity we mirror that
      // fall-through here:
      //   - if the row is legitimate (owns an allowed phase) → the downstream
      //     is KEEP, so emitting MARK_SUSPECTED (stamp + push kept) is identical;
      //   - if NOT legitimate → the downstream is the final-alive kill, so we
      //     do NOT short-circuit and instead fall through to step (6), which
      //     emits TERMINATE. (The suspected stamp that the procedural code
      //     would have written first is moot: the row is about to terminate,
      //     and a terminal execution's stuck_state is never observed again.)
      if (input.ownsActiveTask || input.legitimateIntegration || input.legitimateFinishing) {
        return { kind: 'MARK_SUSPECTED', reason: 'progress silent past grace — suspected stuck' };
      }
      // Fall through to step (6): alive + not legitimate → TERMINATE.
    }
  }

  // -------------------------------------------------------------------------
  // (4) Stuck stage 3 — cancel_requested past the kill grace → verified kill.
  // Birth-token verification is the LAST gate before termination (scenario 16):
  // a reused PID with a different token is NEVER killed. Wave 8 HIGH 5B adds
  // the escalation: such a row is normally TERMINATE_BUT_PID_REUSE (left for a
  // human on this sweep), but once PID_REUSE_GRACE_MS has elapsed since
  // cancel_requested_at the policy escalates to RELEASE — the process is
  // either dead or stolen, but the card MUST return to the queue eventually.
  // This bounds the worst-case stall at PID_REUSE_GRACE_MS and is a
  // human-notification event, not a permanent block.
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
  // (5) Legitimate phase — alive execution that still owns an allowed task
  // phase is left alone. (Computed by the mechanism; the policy just gates.)
  //
  // Note: an alive row with an expired lease was already returned as TERMINATE
  // above (Wave 8 HIGH 5A) and never reaches this gate. So this KEEP only
  // applies to alive rows whose lease is still alive — the supervisor is
  // healthy and vouches for the phase ownership.
  // -------------------------------------------------------------------------
  if (input.isAlive && (input.ownsActiveTask || input.legitimateIntegration || input.legitimateFinishing)) {
    return {
      kind: 'KEEP',
      reason: 'execution still owns an allowed lifecycle phase',
    };
  }

  // -------------------------------------------------------------------------
  // (6) Alive but illegitimate — terminate (kill + release). The mechanism
  // calls probe.killVerified(pid, token); on failure it pushes KEEP with
  // reason 'unsafe to terminate without matching process birth identity'. We
  // emit TERMINATE and let the mechanism own the kill-attempt outcome.
  // (The procedural code reaches this branch both for freshly-suspected rows
  // that fell through stage 1 and for plain alive-illegitimate rows.)
  // -------------------------------------------------------------------------
  if (input.isAlive) {
    return {
      kind: 'TERMINATE',
      reason: 'execution no longer owns an allowed task phase',
    };
  }

  // Unreachable in practice: a local row that is not alive was handled by the
  // release gate at step (2). Defensive KEEP so the policy is total.
  return { kind: 'KEEP', reason: 'no action — local row not alive and not released' };
}
