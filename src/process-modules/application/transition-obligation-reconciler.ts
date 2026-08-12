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
// registers the five production handoff handlers and drives the reconciler
// from the lifecycle loop.

import type { SqliteTransitionObligationLedger } from '../persistence/sqlite-transition-obligation-ledger.js';
import type {
  TransitionHandoffKind,
  TransitionObligation,
} from '../persistence/sqlite-transition-obligation-ledger.js';
import type { LeaseFence } from '../domain/transition-obligation.js';

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
  ): Promise<TransitionObligationCompletion> | TransitionObligationCompletion;
}

export interface TransitionObligationCompletion {
  readonly completionReceipt: string;
  readonly resultDigest: string;
}

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
  readonly skipped: number;
}

export class TransitionObligationReconciler {
  private readonly handlers = new Map<TransitionHandoffKind, TransitionObligationHandler>();

  constructor(private readonly ledger: SqliteTransitionObligationLedger) {}

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
    let skipped = 0;

    for (const obligation of ready) {
      const handler = this.handlers.get(obligation.handoffKind);
      if (!handler) {
        // No handler registered for this handoff kind yet (Phase 2 substrate;
        // Phase 8 registers production handlers). Skip without failing.
        skipped += 1;
        continue;
      }

      // Obtain the lease fence: when the caller did not supply one, ALLOCATE
      // it from the ledger (ADR-053 C7-03 — the fence is store-minted and
      // monotonic, never chosen or lowered by the caller). When supplied, use
      // it as-is (the legacy / externally-minted-fence path).
      const fence = options.fence
        ?? this.ledger.allocateLeaseFence(obligation.obligationKey);

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
        // ADR-053 C7-05 — failure is fenced by the lease token this sweep just
        // acquired: the owner that holds the lease and the SAME fence the lease
        // was taken under (symmetric with the complete() call above). If the
        // fail is rejected because a NEWER fence took the obligation over
        // between lease and fail, this holder is now stale — it can neither
        // complete nor fail the obligation. Count the failed attempt as skipped
        // (the newer owner will re-dispatch) rather than letting the rejection
        // crash the sweep.
        try {
          this.ledger.fail({
            obligationKey: obligation.obligationKey,
            owner: options.leaseOwner,
            fence,
            error: message,
          });
          failed += 1;
        } catch {
          skipped += 1;
        }
      }
    }

    return { dispatched, completed, failed, skipped };
  }
}
