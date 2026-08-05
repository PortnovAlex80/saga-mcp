/**
 * ProductionCellTransitionReducer — the pure state-machine at the heart of the
 * ProductionCellCoordinator (Conveyor v4, step 2.2).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-04 (Production Cell),
 * REG-05 (Workplace), REG-13 (ОТК) + Conveyor Mental Model v4 §«Transition
 * authority» and §«Two-channel state».
 *
 * # What this is
 *
 * The coordinator drives a Workplace through its bounded control loop:
 *
 *   queued → leased → running → verifying → (repair_wait | terminal)
 *
 * ...and mirrors the Kanban phase alongside it. This module is the PURE core
 * of that logic: given the current WorkplaceState and a typed
 * ProductionCellEvent, it computes the NEXT WorkplaceState. No I/O, no DB, no
 * clock — the coordinator (step 2.2 infrastructure) calls this reducer inside
 * its CAS transaction.
 *
 * # Why a pure reducer
 *
 * The transition table is load-bearing (REG-28-AC-02: "crash, lease expiry
 * and technical repair change loop, but do NOT roll Kanban back to todo").
 * A bug in the transition logic is a silent invariant violation. Keeping the
 * logic PURE means it is fully covered by property tests without spawning
 * processes or touching SQLite — the same pattern as `lifecycle/domain/evolve.ts`.
 *
 * # The transition table (v4 §«Transition authority»)
 *
 *   Work admitted               todo/idle          → in_progress/queued, author
 *   Worker assigned/started     (loop only)        → leased → running
 *   Worker completed candidate  (loop only)        → verifying
 *   Worker crashed/expired      (loop only)        → repair_wait
 *   Gate requests repair        (loop only)        → repair_wait, repairTargetRole
 *   Author gate accepts +review in_progress        → review/queued, reviewer
 *   Author gate accepts final   in_progress        → done/terminal(accepted)
 *   Reviewer assigned           review             → review_in_progress/leased→running
 *   Reviewer invalid            review_in_progress → repair_wait, reviewer
 *   Reviewer proves defect      review_in_progress → in_progress/repair_wait, author
 *   Final gate accepts          review_in_progress → done/terminal(accepted)
 *   Human required              *                  → blocked/paused
 *   Gate/recovery failed        *                  → failed/terminal(failed)
 *   Authorized cancel           *                  → cancelled/terminal(cancelled)
 *
 * Kanban advancement is gated (v4 §«Transition authority»):
 *   > An LM Production Cell cannot advance forward or release output until
 *   > its declared final gate accepts exact products. A reviewer-proven defect
 *   > may move the same card back to author work; failed technical attempts
 *   > otherwise repeat inside the current stage on the same Workplace and desk.
 *
 * # Pure domain
 *
 * Imports only sibling pure types. No SQLite, MCP, db.ts, clock.
 */

import type {
  KanbanPhase,
  LoopState,
  NextRole,
  TerminalReason,
  WorkplaceState,
} from './workplace-state.js';
import {
  assertAllowedPhaseLoopPair,
  assertValidWorkplaceState,
  isRoleCompatibleWithPhase,
  phaseForTerminalReason,
} from './workplace-state.js';

// ---------------------------------------------------------------------------
// Events — typed inputs to the reducer.
// ---------------------------------------------------------------------------

/**
 * One typed event the coordinator emits/consumes to drive the Workplace loop.
 *
 * Each event corresponds to a row in the v4 §«Transition authority» table.
 * The reducer is exhaustive over this union (a new event requires a new case
 * AND a registry update).
 */
export type ProductionCellEvent =
  // Admission.
  | { readonly kind: 'work-admitted' }
  // Worker lifecycle (loop only — Kanban unchanged).
  | { readonly kind: 'worker-leased'; readonly reservationRef: string }
  | { readonly kind: 'worker-started' }
  | { readonly kind: 'candidate-sealed' }
  | { readonly kind: 'worker-crashed' }
  | { readonly kind: 'worker-lost' }
  // Gate outcomes.
  | { readonly kind: 'gate-repair-required'; readonly repairTargetRole: NextRole }
  | { readonly kind: 'gate-author-accepted-with-review' }
  | { readonly kind: 'gate-author-accepted-final' }
  | {
      readonly kind: 'reviewer-verdict';
      readonly verdict: 'accepted' | 'defect-proven' | 'invalid-output';
    }
  // Terminal / human.
  | { readonly kind: 'human-required' }
  | { readonly kind: 'gate-failed' }
  | { readonly kind: 'authorized-cancel' }
  // Repair re-queue (after repair_wait, a new worker is hired).
  | { readonly kind: 'repair-requeued'; readonly role: NextRole };

// ---------------------------------------------------------------------------
// Reducer.
// ---------------------------------------------------------------------------

/**
 * Apply one event to a WorkplaceState, producing the next state.
 *
 * PURE: same (state, event) ⇒ same next state. Throws on:
 *   - a NO_TRANSITION (the event does not apply to the current state — e.g.
 *     `candidate-sealed` on a `queued` workplace that has no running worker);
 *   - a resulting state that violates REG-28 (closed pairs / role / terminal).
 *
 * Bumps `revision` by 1 on every accepted transition. The coordinator's
 * repository CAS-matches the pre-event revision (REG-05-AC-06).
 *
 * Kanban discipline (REG-28-AC-02): crash/lease-expiry/repair events change
 * ONLY loopState — they NEVER roll Kanban back to `todo`. The only Kanban
 * regression is the explicit `reviewer-verdict(defect-proven)`, which is a
 * SEMANTIC backward transition (REG-28-AC-04), not a technical crash.
 */
export function reduceWorkplaceEvent(
  state: WorkplaceState,
  event: ProductionCellEvent,
): WorkplaceState {
  const next = computeNextState(state, event);
  // Defence in depth: the computed state MUST satisfy the closed-pair and
  // role invariants before we hand it back. A bug in computeNextState that
  // produced an invalid pair would throw here instead of persisting.
  assertValidWorkplaceState(next);
  return next;
}

function computeNextState(
  state: WorkplaceState,
  event: ProductionCellEvent,
): WorkplaceState {
  const rev = state.revision + 1;
  switch (event.kind) {
    // --- Admission --------------------------------------------------------
    case 'work-admitted': {
      // todo/idle → in_progress/queued, author.
      assertFrom(state, 'todo', 'idle');
      return { ...state, kanbanPhase: 'in_progress', loopState: 'queued', nextRole: 'author', revision: rev };
    }

    // --- Worker lifecycle (Kanban unchanged) ------------------------------
    case 'worker-leased': {
      // queued → leased. When the Kanban phase is `review` (the reviewer
      // buffer), leasing a reviewer ALSO advances Kanban to
      // `review_in_progress` (the active reviewer loop). v4 §Allowed channel
      // combinations: `review` allows ONLY `queued` (the buffer); the moment
      // a reviewer is leased, the card is actively under review.
      assertLoop(state, 'queued');
      if (state.kanbanPhase === 'review') {
        return {
          ...state,
          kanbanPhase: 'review_in_progress',
          loopState: 'leased',
          revision: rev,
        };
      }
      return { ...state, loopState: 'leased', revision: rev };
    }
    case 'worker-started': {
      // leased → running (Kanban unchanged).
      assertLoop(state, 'leased');
      return { ...state, loopState: 'running', revision: rev };
    }
    case 'candidate-sealed': {
      // running → verifying (Kanban unchanged).
      assertLoop(state, 'running');
      return { ...state, loopState: 'verifying', revision: rev };
    }
    case 'worker-crashed':
    case 'worker-lost': {
      // running → repair_wait (Kanban UNCHANGED — REG-28-AC-02).
      // The recovery policy will re-queue a replacement worker of the same role.
      assertLoop(state, 'running');
      return { ...state, loopState: 'repair_wait', revision: rev };
    }

    // --- Gate outcomes ----------------------------------------------------
    case 'gate-repair-required': {
      // verifying → repair_wait with the gate's declared repairTargetRole.
      // Kanban UNCHANGED (REG-28-AC-02: technical repair does not roll back).
      assertLoop(state, 'verifying');
      // The role must be valid for the current Kanban phase (author for
      // in_progress, reviewer for review_in_progress).
      if (!isRoleCompatibleWithPhase(state.kanbanPhase, event.repairTargetRole)) {
        throw new Error(
          `gate-repair-required: repairTargetRole '${event.repairTargetRole}' `
            + `is not compatible with kanbanPhase '${state.kanbanPhase}'`,
        );
      }
      return { ...state, loopState: 'repair_wait', nextRole: event.repairTargetRole, revision: rev };
    }
    case 'gate-author-accepted-with-review': {
      // in_progress/verifying → review/queued, reviewer.
      assertFrom(state, 'in_progress', 'verifying');
      return {
        ...state,
        kanbanPhase: 'review',
        loopState: 'queued',
        nextRole: 'reviewer',
        revision: rev,
      };
    }
    case 'gate-author-accepted-final': {
      // in_progress/verifying → done/terminal(accepted). Cell complete.
      assertFrom(state, 'in_progress', 'verifying');
      return terminal(state, 'accepted', rev);
    }

    // --- Reviewer ---------------------------------------------------------
    case 'reviewer-verdict': {
      // review_in_progress/verifying.
      assertFrom(state, 'review_in_progress', 'verifying');
      if (event.verdict === 'accepted') {
        // Final gate accepts → done/terminal(accepted).
        return terminal(state, 'accepted', rev);
      }
      if (event.verdict === 'defect-proven') {
        // SEMANTIC backward transition (REG-28-AC-04): the card returns to
        // author work. This is NOT a technical crash — it is a proven product
        // defect, so Kanban explicitly moves review_in_progress → in_progress.
        return {
          ...state,
          kanbanPhase: 'in_progress',
          loopState: 'repair_wait',
          nextRole: 'author',
          revision: rev,
        };
      }
      // invalid-output: retry the reviewer role. Kanban stays review_in_progress.
      return { ...state, loopState: 'repair_wait', nextRole: 'reviewer', revision: rev };
    }

    // --- Terminal / human -------------------------------------------------
    case 'human-required': {
      // * → blocked/paused. Resume target preserved by the HumanInteractionRun.
      return {
        ...state,
        kanbanPhase: 'blocked',
        loopState: 'paused',
        revision: rev,
      };
    }
    case 'gate-failed': {
      return terminal(state, 'failed', rev);
    }
    case 'authorized-cancel': {
      return terminal(state, 'cancelled', rev);
    }

    // --- Repair re-queue --------------------------------------------------
    case 'repair-requeued': {
      // repair_wait → queued (after a gate-rejected repair), OR
      // paused → queued (after a human-required block is resumed). Both are
      // valid resume points — the repair/blocked states block the line until
      // the issue is resolved or the human answers.
      if (state.loopState !== 'repair_wait' && state.loopState !== 'paused') {
        throw new Error(
          `NO_TRANSITION: repair-requeued requires loopState='repair_wait' or 'paused', got '${state.loopState}'`,
        );
      }
      if (!isRoleCompatibleWithPhase(state.kanbanPhase, event.role)) {
        throw new Error(
          `repair-requeued: role '${event.role}' is not compatible with `
            + `kanbanPhase '${state.kanbanPhase}'`,
        );
      }
      // When resuming from blocked/paused, also clear the Kanban phase back to
      // the active work phase for the role.
      const targetPhase = event.role === 'reviewer' ? 'review_in_progress' : 'in_progress';
      if (state.kanbanPhase === 'blocked') {
        return { ...state, kanbanPhase: targetPhase, loopState: 'queued', nextRole: event.role, revision: rev };
      }
      return { ...state, loopState: 'queued', nextRole: event.role, revision: rev };
    }

    default: {
      // Exhaustiveness guard — a new event requires a new case here.
      const _exhaustive: never = event;
      void _exhaustive;
      throw new Error(`unhandled ProductionCellEvent`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function terminal(
  state: WorkplaceState,
  reason: TerminalReason,
  revision: number,
): WorkplaceState {
  const phase = phaseForTerminalReason(reason);
  // The terminal pair (phase, terminal) is always in the allowed table, but
  // assert anyway for defence in depth.
  assertAllowedPhaseLoopPair(phase, 'terminal');
  return {
    kanbanPhase: phase,
    loopState: 'terminal',
    nextRole: state.nextRole, // ignored by dispatcher in terminal
    revision,
    terminalReason: reason,
  };
}

/** Assert the current state is (kanbanPhase, loopState). */
function assertFrom(
  state: WorkplaceState,
  kanbanPhase: KanbanPhase,
  loopState: LoopState,
): void {
  if (state.kanbanPhase !== kanbanPhase || state.loopState !== loopState) {
    throw new Error(
      `NO_TRANSITION: event does not apply to ${state.kanbanPhase}/${state.loopState} `
        + `(expected ${kanbanPhase}/${loopState})`,
    );
  }
}

/** Assert only the loop state (Kanban-phase-agnostic loop transition). */
function assertLoop(state: WorkplaceState, loopState: LoopState): void {
  if (state.loopState !== loopState) {
    throw new Error(
      `NO_TRANSITION: event requires loopState='${loopState}', got '${state.loopState}'`,
    );
  }
}
