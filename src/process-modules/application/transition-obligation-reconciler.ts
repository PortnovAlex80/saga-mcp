// src/process-modules/application/transition-obligation-reconciler.ts
//
// ADR-053 Phase 2 — fenced transition-obligation reconciler.
//
// The reconciler is the crash-recovery driver. It finds obligations that are
// ready (pending, or in_progress with an expired lease), leases each under a
// monotonic fence, dispatches to the registered handler for the handoff kind,
// and records the completion receipt or returns the obligation to pending on
// failure.
//
// Properties:
// - IDEMPOTENT: safe to call repeatedly. A completed obligation is never
//   re-dispatched. A leased obligation is only re-dispatched after its lease
//   expires.
// - FENCED: each lease carries a monotonic fence token. A stale lease holder
//   cannot complete an obligation that a newer fence has already taken.
// - CONVERGENT: after crash + recovery, every non-terminal obligation is
//   eventually dispatched exactly once and converges to one completion receipt.
//
// Phase 2 creates the reconciler skeleton with a handler registry. Phase 8
// registers the production handoff handlers and drives the reconciler
// from the lifecycle loop.

import type { SqliteTransitionObligationLedger } from '../persistence/sqlite-transition-obligation-ledger.js';
import type {
  TransitionHandoffKind,
  TransitionObligation,
} from '../persistence/sqlite-transition-obligation-ledger.js';
import {
  LEASE_LOSS_RECLAIM_MARKER,
  OBLIGATION_HUMAN_PARK_MARKER,
  OBLIGATION_VALVE_MARKER,
} from '../persistence/sqlite-transition-obligation-ledger.js';
import type { LeaseFence } from '../domain/transition-obligation.js';

export { OBLIGATION_HUMAN_PARK_MARKER };

// ---------------------------------------------------------------------------
// B-004/O-D6 — the reason-identity valve (CONVEYOR §15 "Budget must count
// spin, not work").
//
// defer/fail have no cap and `attempt` was never compared (observed >1500 on a
// permanently-deferring obligation; the only exits — complete and abandon —
// were unreachable for a paused lifecycle). The valve gives the loop an HONEST
// end:
//   - the SAME typed reason key repeating REPEAT_THRESHOLD times
//     CONSECUTIVELY is spin — abandon with a typed terminal marker;
//   - a NEW reason key resets the repetition counter (a converging chain is
//     work: another link of the defect chain removed — never taxed);
//   - the absolute ATTEMPT_CEILING stays the hard cap regardless of reason
//     novelty (§15 rule 4: even converging chains terminate). 30 matches
//     ADR-075 DEFAULT_RECOVERY_TOTAL_ATTEMPTS.
// ---------------------------------------------------------------------------
export const OBLIGATION_VALVE_REPEAT_THRESHOLD = 3;
export const OBLIGATION_VALVE_ATTEMPT_CEILING = 30;

// ---------------------------------------------------------------------------
// BLINDSIGHT Lifecycle F3 — redrive must READ the persisted typed reason.
//
// The valve only ends SAME-KEY repetition (N=3) and the absolute ceiling
// (30). BETWEEN those thresholds every sweep re-leased and re-dispatched the
// obligation immediately, whatever the persisted reason said: last_reason_key
// and last_error were written by defer/fail and never read at the redrive
// decision point ("данные записаны, но не доставляются к точке решения").
//
// The redrive now branches on the typed reason (CONVEYOR §15):
//   - 'deterministic-retryable' (transient: SQLITE_BUSY, lease loss, network)
//     → retry WITH BACKOFF — the retry is honest work, but an unbacked
//     per-second retry storm is spin the system creates itself;
//   - 'human-judgment' (the fail-closed park vocabulary:
//     RECOVERY_BUDGET_EXHAUSTED, GATE_HUMAN_REQUIRED, REPLAN_*) → park
//     human_required — a terminal fail-closed abandon with the typed
//     OBLIGATION_HUMAN_PARK marker, NOT another lease and NOT an infinite
//     loop waiting for a person inside the reconciler;
//   - 'uncategorized' → the pre-existing immediate-retry behavior (reason
//     identity stays the valve's job; over-classification would weaken the
//     converging-chain contract).
// ---------------------------------------------------------------------------
export type ObligationRedriveClass =
  | 'human-judgment'
  | 'deterministic-retryable'
  | 'uncategorized';

/** Typed terminal marker written by the redrive's human-judgment park. */
export const REDRIVE_HUMAN_PARK_MARKER = OBLIGATION_HUMAN_PARK_MARKER;

/**
 * The fail-closed park vocabulary: typed reason identities whose semantics are
 * "a human must decide" (drawn from the actual park sites: gate human_required
 * verdicts, recovery-budget exhaustion, re-plan mandates, worker retry
 * budgets). A generic HUMAN_REQUIRED/HUMAN_PARK substring catches future
 * members of the family.
 */
const HUMAN_JUDGMENT_REASON_CODES = [
  'RECOVERY_BUDGET_EXHAUSTED',
  'GATE_HUMAN_REQUIRED',
  'REPLAN_MANDATED',
  'REPLAN_CYCLE_CAP',
  'REPLAN_CYCLE_RATCHET',
  'WORKER_RETRY_BUDGET_EXHAUSTED',
];

/**
 * The transient vocabulary: typed reason identities that are deterministic
 * AND retryable (the next attempt can legitimately succeed). Prose variants
 * ("database is locked") are matched case-insensitively as a fallback for
 * drivers that surface raw SQLite messages without a typed code.
 */
const DETERMINISTIC_RETRYABLE_REASON_CODES = [
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'ETIMEDOUT',
  'TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'PROCESS_RUN_BUSY',
];

function matchesVocabulary(haystack: string, code: string): boolean {
  return haystack.toUpperCase().includes(code);
}

/**
 * Classify a persisted defer/fail reason into the redrive branch. Inputs are
 * the obligation's typed reason identity (`lastReasonKey`) and the durable
 * prose (`lastError`); either may carry the typed code (deferred reasons keep
 * prose in both, failed reasons keep the CODE prefix in the key).
 *
 * A reclaimed row (lastError === LEASE_LOSS_RECLAIM) is ALWAYS
 * deterministic-retryable regardless of the stale reason key the reclaim did
 * not clear: the previous holder crashed, the obligation itself is healthy.
 */
export function classifyObligationRedrive(
  lastReasonKey: string | null,
  lastError: string | null,
): ObligationRedriveClass {
  if (lastError === LEASE_LOSS_RECLAIM_MARKER) return 'deterministic-retryable';
  const haystacks = [lastReasonKey, lastError]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.toUpperCase());
  if (haystacks.length === 0) return 'uncategorized';
  for (const code of HUMAN_JUDGMENT_REASON_CODES) {
    if (haystacks.some((haystack) => matchesVocabulary(haystack, code))) {
      return 'human-judgment';
    }
  }
  if (haystacks.some((haystack) =>
    /HUMAN_REQUIRED|HUMAN_PARK/.test(haystack))) {
    return 'human-judgment';
  }
  for (const code of DETERMINISTIC_RETRYABLE_REASON_CODES) {
    if (haystacks.some((haystack) => matchesVocabulary(haystack, code))) {
      return 'deterministic-retryable';
    }
  }
  if (haystacks.some((haystack) => haystack.includes('DATABASE IS LOCKED'))) {
    return 'deterministic-retryable';
  }
  return 'uncategorized';
}

/** Base backoff window for the first repetition of a retryable reason. */
export const OBLIGATION_BACKOFF_BASE_MS = 2_000;
/** Backoff ceiling — a retryable reason never waits longer than this. */
export const OBLIGATION_BACKOFF_CAP_MS = 300_000;

/**
 * Exponential backoff for a deterministic-retryable reason, keyed on the
 * CONSECUTIVE repetition count of its typed key (§15: each same-key repeat is
 * one more evidence unit that the retry is not converging). repeat=1 waits
 * the base window; every further repeat doubles it; the cap bounds the wait.
 */
export function obligationRedriveBackoffMs(reasonRepeatCount: number): number {
  const repeat = Number.isFinite(reasonRepeatCount) && reasonRepeatCount >= 1
    ? Math.floor(reasonRepeatCount)
    : 1;
  const exponent = Math.min(repeat - 1, 20);
  const raw = OBLIGATION_BACKOFF_BASE_MS * 2 ** exponent;
  return Math.min(raw, OBLIGATION_BACKOFF_CAP_MS);
}

/**
 * Parse the ledger's SQLite `updated_at` ("YYYY-MM-DD HH:MM:SS", UTC) into a
 * wall-clock ms value. Returns null when the value is missing/unparseable —
 * the caller then treats the backoff as elapsed (an unparseable timestamp
 * must not wedge the obligation forever; dispatch is the pre-existing
 * behavior).
 */
function parseUpdatedAtMs(updatedAt: string | null): number | null {
  if (typeof updatedAt !== 'string' || updatedAt.trim() === '') return null;
  const parsed = Date.parse(`${updatedAt.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Handler interface.
//
// A handler owns one handoff kind. It receives the obligation and performs the
// transition. If the transition succeeds, it returns a completion receipt +
// result digest. If it fails, it throws; the reconciler returns the obligation
// to pending for a retry.
//
// Handlers MUST be idempotent: the reconciler may call them more than once
// (after a crash mid-execution) for the same obligation. A correct handler
// either completes the transition or discovers it was already completed.
// ---------------------------------------------------------------------------
export interface TransitionObligationHandler {
  readonly handoffKind: TransitionHandoffKind;
  execute(
    obligation: TransitionObligation,
  ): Promise<TransitionObligationHandlerResult> | TransitionObligationHandlerResult;
}

export interface TransitionObligationCompletion {
  readonly outcome?: 'completed';
  readonly completionReceipt: string;
  readonly resultDigest: string;
}

export interface TransitionObligationDeferred {
  readonly outcome: 'deferred';
  readonly reason: string;
}

export type TransitionObligationHandlerResult =
  | TransitionObligationCompletion
  | TransitionObligationDeferred;

// ---------------------------------------------------------------------------
// Reconciler.
// ---------------------------------------------------------------------------
export interface ReconcilerOptions {
  readonly leaseOwner: string;
  /**
   * Monotonic lease-fence token carried by every lease this sweep acquires.
   * Each reconciler call should use a fence >= the last. ADR-053 C7-01: this
   * is a LeaseFence (ordering token), a DISTINCT type from the causal source
   * revision that caused each obligation — the two are not interchangeable.
   *
   * ADR-053 C7-03: OPTIONAL. When OMITTED, the reconciler ALLOCATES a fresh
   * monotonic fence for each obligation directly from the ledger
   * ({@link SqliteTransitionObligationLedger.allocateLeaseFence}) — the fence
   * is store-minted and monotonic, so a caller can neither choose nor lower
   * it (allocate, not supply). When SUPPLIED, it is carried into every lease of
   * the sweep as before (the legacy path; lets an externally-minted fence
   * token keep driving a sweep).
   */
  readonly fence?: LeaseFence;
  /** Max obligations to dispatch in one sweep. */
  readonly batchSize?: number;
}

export interface ReconcileResult {
  readonly dispatched: number;
  readonly completed: number;
  readonly failed: number;
  readonly deferred: number;
  readonly skipped: number;
  /** B-004/O-D6 — obligations terminally abandoned by the reason-identity valve. */
  readonly valved: number;
  /**
   * BLINDSIGHT F3 — obligations held back this sweep because their persisted
   * typed reason is deterministic-retryable and the backoff window keyed on
   * the reason-repetition count has not elapsed yet.
   */
  readonly backoff: number;
  /**
   * BLINDSIGHT F3 — obligations terminally parked (fail-closed abandon) by
   * the redrive's human-judgment branch.
   */
  readonly humanParked: number;
}

export class TransitionObligationReconciler {
  private readonly handlers = new Map<TransitionHandoffKind, TransitionObligationHandler>();
  /**
   * Per-obligation log throttle state (keyed by obligation key): the last
   * FAIL/DEFER message emitted and the attempt number it was emitted at. A
   * livelocking obligation MUST stay visible in the engine log — first
   * occurrence, every change of the underlying message, and a periodic
   * heartbeat every LOG_PERIOD attempts — without flooding the log once per
   * second. Observed live: a permanent `no such column` SQL error retried
   * 1300+ times with zero engine log lines because fail/defer reasons were
   * only persisted to the ledger's last_error column.
   */
  private readonly logState = new Map<string, { message: string; attempt: number }>();
  private static readonly LOG_PERIOD = 50;

  constructor(
    private readonly ledger: SqliteTransitionObligationLedger,
    private readonly log?: (line: string) => void,
  ) {}

  private throttledLog(
    obligation: TransitionObligation,
    kind: 'FAIL' | 'DEFER',
    message: string,
  ): void {
    if (!this.log) return;
    const state = this.logState.get(obligation.obligationKey);
    const changed = state === undefined || state.message !== message;
    const periodic = state !== undefined
      && obligation.attempt - state.attempt >= TransitionObligationReconciler.LOG_PERIOD;
    if (!changed && !periodic) return;
    this.logState.set(obligation.obligationKey, {
      message,
      attempt: obligation.attempt,
    });
    this.log(
      `${kind} attempt=${obligation.attempt} handoff=${obligation.handoffKind} `
      + `key=${obligation.obligationKey} :: ${message.slice(0, 240)}`
      + (changed ? '' : ` (unchanged since attempt ${state?.attempt ?? 0} — ${kind === 'FAIL' ? 'permanent error is being retried' : 'postcondition still not durable'})`),
    );
  }

  /**
   * B-004/O-D6 — apply the reason-identity valve to a JUST-deferred/failed
   * obligation (returned to pending by the ledger, which persisted the typed
   * reason key and the consecutive repetition count). Trips:
   *   - reason-repeat: the same key repeated OBLIGATION_VALVE_REPEAT_THRESHOLD
   *     times consecutively (spin);
   *   - attempt-ceiling: attempt >= OBLIGATION_VALVE_ATTEMPT_CEILING (hard
   *     cap regardless of reason novelty).
   * Routes to {@link SqliteTransitionObligationLedger.abandon} with the typed
   * OBLIGATION_VALVE marker so the loop ENDS honestly instead of spinning.
   */
  private applyReasonIdentityValve(obligation: TransitionObligation): boolean {
    if (obligation.state !== 'pending') return false;
    const repeatTrip = obligation.reasonRepeatCount >= OBLIGATION_VALVE_REPEAT_THRESHOLD;
    const ceilingTrip = obligation.attempt >= OBLIGATION_VALVE_ATTEMPT_CEILING;
    if (!repeatTrip && !ceilingTrip) return false;
    const tripKind = repeatTrip ? 'reason-repeat' : 'attempt-ceiling';
    const reason = `${OBLIGATION_VALVE_MARKER}(${tripKind}): `
      + (repeatTrip
        ? `reason-key <${obligation.lastReasonKey ?? 'none'}> repeated `
          + `${obligation.reasonRepeatCount} times consecutively`
        : `absolute attempt ceiling ${OBLIGATION_VALVE_ATTEMPT_CEILING} reached `
          + `(last reason-key <${obligation.lastReasonKey ?? 'none'}>)`)
      + ` at attempt ${obligation.attempt} — CONVEYOR §15 spin valve: the loop ends honestly`;
    const abandoned = this.ledger.abandon(obligation.obligationKey, reason);
    if (abandoned) {
      this.log?.(
        `VALVE ${tripKind} attempt=${obligation.attempt} `
        + `handoff=${obligation.handoffKind} key=${obligation.obligationKey} `
        + `:: ${obligation.lastReasonKey ?? '(no reason key)'}`,
      );
    }
    return abandoned !== null;
  }

  registerHandler(handler: TransitionObligationHandler): void {
    if (this.handlers.has(handler.handoffKind)) {
      throw new Error(
        `TRANSITION_OBLIGATION_HANDLER_DUPLICATE: ${handler.handoffKind}`,
      );
    }
    this.handlers.set(handler.handoffKind, handler);
  }

  /**
   * Drive one sweep of ready obligations. For each ready obligation:
   * 1. Acquire a lease (CAS on state + lease_expires_at).
   * 2. Dispatch to the registered handler.
   * 3. On success: record completion (idempotent).
   * 4. On failure: return to pending with the error.
   *
   * Returns a summary of the sweep. Safe to call repeatedly; each call
   * processes at most `batchSize` obligations.
   */
  async reconcile(options: ReconcilerOptions): Promise<ReconcileResult> {
    const batchSize = options.batchSize ?? 32;
    const ready = this.ledger.findReady(batchSize);
    let dispatched = 0;
    let completed = 0;
    let failed = 0;
    let deferred = 0;
    let skipped = 0;
    let valved = 0;
    let backoff = 0;
    let humanParked = 0;

    for (const obligation of ready) {
      const handler = this.handlers.get(obligation.handoffKind);
      if (!handler) {
        // No handler registered for this handoff kind yet (Phase 2 substrate;
        // Phase 8 registers production handlers). Skip without failing.
        skipped += 1;
        continue;
      }

      // BLINDSIGHT F3 — the redrive READS the persisted typed reason before
      // taking another lease. Between the valve thresholds the reason used to
      // be invisible at this exact decision point.
      if (obligation.lastReasonKey !== null || obligation.lastError !== null) {
        const redriveClass = classifyObligationRedrive(
          obligation.lastReasonKey,
          obligation.lastError,
        );
        if (redriveClass === 'human-judgment') {
          const reason = `${OBLIGATION_HUMAN_PARK_MARKER}: reason-key `
            + `<${obligation.lastReasonKey ?? 'none'}> requires human judgment — `
            + `the redrive parks instead of leasing a human decision forever `
            + `(attempt ${obligation.attempt}, repeated `
            + `${obligation.reasonRepeatCount})`;
          const abandoned = this.ledger.abandon(obligation.obligationKey, reason);
          if (abandoned !== null) {
            humanParked += 1;
            this.log?.(
              `HUMAN-PARK attempt=${obligation.attempt} `
              + `handoff=${obligation.handoffKind} key=${obligation.obligationKey} `
              + `:: ${obligation.lastReasonKey ?? '(no reason key)'} — parked `
              + `human_required (fail-closed; the loop ends, a human decides)`,
            );
          }
          continue;
        }
        if (redriveClass === 'deterministic-retryable') {
          const windowMs = obligationRedriveBackoffMs(
            Math.max(obligation.reasonRepeatCount, 1),
          );
          const lastFailureMs = parseUpdatedAtMs(obligation.updatedAt);
          const nowMs = Date.now();
          if (lastFailureMs !== null && nowMs < lastFailureMs + windowMs) {
            backoff += 1;
            this.throttledLog(
              obligation,
              'DEFER',
              `${obligation.lastReasonKey ?? obligation.lastError} — `
                + `retryable, backing off (window ${windowMs}ms after repeat `
                + `${Math.max(obligation.reasonRepeatCount, 1)})`,
            );
            continue;
          }
        }
      }

      // Obtain the lease fence: when the caller did not supply one, ALLOCATE
      // it from the ledger (ADR-053 C7-03 — the fence is store-minted and
      // monotonic, never chosen or lowered by the caller). When supplied, use
      // it as-is (the legacy / externally-minted-fence path).
      const fence = options.fence
        ?? this.ledger.allocateLeaseFence(obligation.obligationKey);

      // ADR-053 C7-06 — LEASE-LOSS RECLAIM. findReady returns in_progress
      // obligations ONLY when their lease has expired (the previous holder
      // crashed or stalled). Before re-leasing, call the fenced reclaim() to
      // record the LEASE_LOSS_RECLAIM_MARKER sentinel — DISTINCT from a business
      // failure (fail) — so the durable record shows the holder LOST the fence,
      // not that the effect threw. The freshly-allocated fence (current+1) is
      // strictly higher than the stored monotonic lease_fence, so reclaim's
      // staleness guard accepts it; the obligation returns to 'pending' for the
      // lease CAS below. If reclaim is rejected (a concurrent sweep raced the
      // obligation to terminal or a newer fence already took over), skip this
      // obligation — the newer owner will redrive it.
      if (obligation.state === 'in_progress') {
        try {
          this.ledger.reclaim({
            obligationKey: obligation.obligationKey,
            owner: options.leaseOwner,
            fence,
          });
        } catch {
          skipped += 1;
          continue;
        }
      }

      const leased = this.ledger.lease(
        obligation.obligationKey,
        options.leaseOwner,
        fence,
      );
      if (!leased) {
        // Another owner acquired the lease between findReady and lease.
        skipped += 1;
        continue;
      }
      dispatched += 1;

      // Re-read after leasing to get the updated attempt/fence.
      const leasedObligation = this.ledger.get(obligation.obligationKey);
      if (!leasedObligation) {
        skipped += 1;
        continue;
      }

      try {
        const result = await handler.execute(leasedObligation);
        if (result.outcome === 'deferred') {
          this.throttledLog(leasedObligation, 'DEFER', result.reason);
          const afterDefer = this.ledger.defer({
            obligationKey: obligation.obligationKey,
            reason: result.reason,
            owner: options.leaseOwner,
            fence,
          });
          deferred += 1;
          if (this.applyReasonIdentityValve(afterDefer)) {
            // The valve's terminal abandon is a failure outcome for sweep
            // bookkeeping so the engine log line surfaces it (completed>0 ||
            // failed>0 branch), plus its own valved counter.
            failed += 1;
            valved += 1;
          }
          continue;
        }
        // ADR-053 C7-04 — completion is fenced by the lease token this sweep
        // just acquired: the owner that holds the lease and the SAME fence the
        // lease was taken under (allocated from the store when none was
        // supplied, or the caller-supplied token). The ledger rejects a
        // completion whose fence is lower than the obligation's stored monotonic
        // lease_fence, so a lease holder that has since been superseded by a
        // newer fence cannot complete.
        this.ledger.complete({
          obligationKey: obligation.obligationKey,
          completionReceipt: result.completionReceipt,
          resultDigest: result.resultDigest,
          owner: options.leaseOwner,
          fence,
        });
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.throttledLog(leasedObligation, 'FAIL', message);
        // ADR-053 C7-05 — failure is fenced by the lease token this sweep just
        // acquired: the owner that holds the lease and the SAME fence the lease
        // was taken under (symmetric with the complete() call above). If the
        // fail is rejected because a NEWER fence took the obligation over
        // between lease and fail, this holder is now stale — it can neither
        // complete nor fail the obligation. Count the failed attempt as skipped
        // (the newer owner will re-dispatch) rather than letting the rejection
        // crash the sweep.
        try {
          const afterFail = this.ledger.fail({
            obligationKey: obligation.obligationKey,
            owner: options.leaseOwner,
            fence,
            error: message,
          });
          failed += 1;
          if (this.applyReasonIdentityValve(afterFail)) valved += 1;
        } catch {
          skipped += 1;
        }
      }
    }

    return { dispatched, completed, failed, deferred, skipped, valved, backoff, humanParked };
  }
}
