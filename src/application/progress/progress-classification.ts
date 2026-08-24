// src/application/progress/progress-classification.ts
//
// CONVEYOR §23 — the progress-obligation invariant, made executable.
//
// The model states the invariant that turns a pile of correct state machines
// into a conveyor:
//
//   For one consistent durable snapshot, every nonterminal Factory scope must
//   have at least one and only truthfully classified progress explanation:
//
//     live owner       = a valid unexpired lease/fence owns the next mutation
//     runnable command = a durable precondition enables an idempotent command
//     typed wait       = dependency/provider/backoff/human wait with a wake source
//     transition due   = a committed child result/outbox obligation awaits routing
//
//   If none applies, the scope is `stalled`. If several contradict one
//   another, the scope is `inconsistent_state`.
//
// Until now this existed only as prose. Nothing computed it, so a scope that
// lost its owner produced silence rather than an incident: observed live, one
// implement-work-items node re-entered 9004 times as runtime.paused while its
// Workplace sat in effect_pending with zero pending obligations — the textbook
// `inconsistent_state`, invisible because no classifier existed.
//
// This module is pure: it takes durable facts and returns the classification
// with the exact evidence that justifies it. Reading those facts is the
// adapter's job (sqlite-progress-reader.ts), so the invariant can be evaluated
// against a live engine, a checkpoint, or a historical run database alike.

export type ProgressClass =
  | 'live_owner'
  | 'runnable_command'
  | 'typed_wait'
  | 'transition_due'
  | 'stalled'
  | 'inconsistent_state';

/** Classes that prove a nonterminal scope will still move. */
export const HEALTHY_PROGRESS_CLASSES: readonly ProgressClass[] = [
  'live_owner',
  'runnable_command',
  'typed_wait',
  'transition_due',
];

export function isHealthyProgress(classification: ProgressClass): boolean {
  return HEALTHY_PROGRESS_CLASSES.includes(classification);
}

export type WorkplaceLoopState =
  | 'idle' | 'queued' | 'leased' | 'running' | 'verifying'
  | 'effect_pending' | 'repair_wait' | 'paused' | 'terminal';

/**
 * Durable facts about one Workplace, gathered from the exact authorities the
 * model names — never from projections (tasks/board/logs are not authority).
 */
export interface WorkplaceProgressFacts {
  readonly workplaceRef: string;
  readonly loopState: WorkplaceLoopState;
  readonly terminalReason: string | null;
  /** The Workplace claims an actor owns its next mutation. */
  readonly activeReservationRef: string | null;
  /**
   * The exact durable WorkerExecution behind that reservation, when one exists.
   * `leaseExpired` distinguishes a live owner from a reclaimable one.
   */
  readonly execution: { readonly executionId: string; readonly leaseExpired: boolean } | null;
  /** Transition obligations for this Workplace that are not yet completed. */
  readonly openObligations: readonly { readonly handoffKind: string; readonly state: string }[];
  /** EffectAttempts for the current accepted desired state, oldest first. */
  readonly effectAttempts: readonly { readonly attemptNo: number; readonly outcome: string }[];
  /** Dependencies that have not reached final acceptance + integration yet. */
  readonly unsatisfiedDependencies: number;
  /** Unsatisfied predecessors that are already terminal and non-accepted. */
  readonly terminalFailedDependencies?: number;
  /** Recovery attempts consumed against the declared total cap, when in repair. */
  readonly repairAttempts: number | null;
  readonly repairCap: number | null;
  /** Declared ceiling on unsettled attempts for one desired state. */
  readonly effectAttemptCap: number;
}

export interface ProgressExplanation {
  readonly scopeKind: 'workplace';
  readonly scopeRef: string;
  readonly classification: ProgressClass;
  /** Why this class — a sentence an operator can act on. */
  readonly reason: string;
  /** Exact durable refs that justify the classification. */
  readonly evidence: readonly string[];
}

const DEFAULT_EFFECT_ATTEMPT_CAP = 30;

export function defaultEffectAttemptCap(): number {
  return DEFAULT_EFFECT_ATTEMPT_CAP;
}

/**
 * Classify one nonterminal Workplace.
 *
 * Terminal Workplaces are not classified: the invariant constrains nonterminal
 * scopes only. Callers filter them out; passing one returns `live_owner`-free
 * `transition_due`-free honesty via an explicit throw would be noisier than
 * simply reporting it as terminal-safe, so we require the caller to exclude it.
 */
export function classifyWorkplaceProgress(
  facts: WorkplaceProgressFacts,
): ProgressExplanation {
  const explain = (
    classification: ProgressClass,
    reason: string,
    evidence: readonly string[] = [],
  ): ProgressExplanation => ({
    scopeKind: 'workplace',
    scopeRef: facts.workplaceRef,
    classification,
    reason,
    evidence,
  });

  const openObligationRefs = facts.openObligations.map(
    obligation => `obligation:${obligation.handoffKind}:${obligation.state}`,
  );

  // ---------------------------------------------------------------------
  // Contradiction first: a state that must have no owner while an owner is
  // durably live is `inconsistent_state`, not a healthy class.
  // ---------------------------------------------------------------------
  const liveOwner = facts.execution && !facts.execution.leaseExpired;
  const ownerlessStates: readonly WorkplaceLoopState[] = ['idle', 'queued'];
  if (liveOwner && ownerlessStates.includes(facts.loopState)) {
    return explain(
      'inconsistent_state',
      `loop state '${facts.loopState}' must have no mutation owner, but execution `
        + `${facts.execution!.executionId} still holds a live lease`,
      [facts.execution!.executionId, ...openObligationRefs],
    );
  }

  switch (facts.loopState) {
    case 'leased':
    case 'running': {
      if (!facts.execution) {
        return explain(
          'stalled',
          `loop state '${facts.loopState}' claims a mutation owner but no durable `
            + 'WorkerExecution exists for its reservation',
          facts.activeReservationRef ? [facts.activeReservationRef] : [],
        );
      }
      if (facts.execution.leaseExpired) {
        // Supervision may reap and the Workplace returns to the queue — a
        // durable precondition enables an idempotent command.
        return explain(
          'runnable_command',
          `lease of execution ${facts.execution.executionId} expired; supervision `
            + 'can reap it and requeue the Workplace',
          [facts.execution.executionId],
        );
      }
      return explain(
        'live_owner',
        `execution ${facts.execution.executionId} holds a valid unexpired lease`,
        [facts.execution.executionId],
      );
    }

    case 'idle':
    case 'queued': {
      if ((facts.terminalFailedDependencies ?? 0) > 0) {
        return explain(
          'stalled',
          `${facts.terminalFailedDependencies ?? 0} dependency edge(s) end at terminal `
            + 'non-accepted predecessors; predecessor settlement is a dead wake source',
        );
      }
      if (facts.unsatisfiedDependencies > 0) {
        return explain(
          'typed_wait',
          `${facts.unsatisfiedDependencies} dependency edge(s) have not reached final `
            + 'acceptance; wake source is predecessor settlement',
        );
      }
      return explain(
        'runnable_command',
        'Workplace is admissible; the dispatcher may reserve it on the next cycle',
      );
    }

    case 'verifying': {
      if (facts.openObligations.length > 0) {
        return explain(
          'transition_due',
          'sealed production awaits its committed handoff (presentation closure / gate run)',
          openObligationRefs,
        );
      }
      return explain(
        'stalled',
        'Workplace is verifying but no open transition obligation drives it to a '
          + 'CandidateSet or GateRun',
      );
    }

    case 'effect_pending': {
      if (facts.openObligations.length > 0) {
        return explain(
          'transition_due',
          'accepted material awaits its declared post-acceptance effect handoff',
          openObligationRefs,
        );
      }
      const attempts = facts.effectAttempts;
      if (attempts.length === 0) {
        return explain(
          'stalled',
          'Workplace is effect_pending but no EffectAttempt was ever recorded and no '
            + 'obligation is open — nothing owns the next mutation',
        );
      }
      const last = attempts[attempts.length - 1]!;
      const unsettled = last.outcome === 'pending';
      if (unsettled && attempts.length < facts.effectAttemptCap) {
        return explain(
          'typed_wait',
          `effect returned 'pending' on attempt ${last.attemptNo}/${facts.effectAttemptCap}; `
            + 'wake source is the next obligation-reconciler sweep',
          [`effect-attempt:${last.attemptNo}`],
        );
      }
      if (unsettled) {
        return explain(
          'stalled',
          `effect never settled within its declared budget `
            + `(${attempts.length}/${facts.effectAttemptCap} attempts all 'pending')`,
          [`effect-attempt:${last.attemptNo}`],
        );
      }
      // A settled non-successful outcome with no open obligation means the
      // routing that should have consumed it never happened.
      return explain(
        'inconsistent_state',
        `last EffectAttempt settled as '${last.outcome}' but the Workplace is still `
          + 'effect_pending with no open obligation to route it',
        [`effect-attempt:${last.attemptNo}`],
      );
    }

    case 'repair_wait': {
      const used = facts.repairAttempts ?? 0;
      const cap = facts.repairCap;
      if (cap !== null && used >= cap) {
        return explain(
          'stalled',
          `repair budget exhausted (${used}/${cap}) and the Workplace was not terminalized`,
        );
      }
      return explain(
        'runnable_command',
        `repair is due; the Workplace can be requeued (${used}${cap !== null ? `/${cap}` : ''} attempts used)`,
      );
    }

    case 'paused': {
      return explain(
        'typed_wait',
        'explicit human-required park; wake source is an operator decision',
        openObligationRefs,
      );
    }

    case 'terminal': {
      return explain(
        facts.terminalReason ? 'transition_due' : 'inconsistent_state',
        facts.terminalReason
          ? `terminal(${facts.terminalReason}) — excluded from the invariant`
          : 'terminal Workplace without a terminal reason',
      );
    }
  }
}
