// src/process-modules/application/transition-obligation-integrator.ts
//
// ADR-053 Phase 8 / ADR-072 — wire the six conveyor handoffs onto the durable
// transition-obligation substrate (Phase 2).
//
// Each source fact (CandidateSet seal, Gate acceptance, Effects settlement,
// FinalAcceptance recording, Process settlement) appends a durable obligation
// in the SAME logical step. The reconciler (Phase 2) then redrives any
// obligation that was not completed (e.g. after a crash between seal and gate).
//
// The six handoffs:
//   final-presentation-committed → close-presentation
//   candidate-set-sealed       → run-gate
//   gate-accepted              → run-effects
//   effects-settled            → record-final-acceptance
//   final-acceptance-recorded  → settle-process
//   process-settled            → route-lifecycle
//
// Phase 8 creates the integrator and obligation-creation utilities. The
// handlers are registered with production transition logic. Each handler is
// idempotent: if the transition already happened (e.g. the gate already ran
// before the crash), the handler discovers this and completes the obligation
// with the existing receipt.

import type { SqliteTransitionObligationLedger } from '../persistence/sqlite-transition-obligation-ledger.js';
import type {
  AppendFencedObligationInput,
  TransitionObligation,
  TransitionSourceKind,
  TransitionHandoffKind,
} from '../persistence/sqlite-transition-obligation-ledger.js';

// ---------------------------------------------------------------------------
// Obligation-creation utilities — one per source fact kind.
//
// Each is called in the SAME transaction (or logical step) as the source fact.
// The obligation key is deterministic: a replay of the source fact finds the
// existing obligation (INSERT OR IGNORE).
//
// ADR-053 C7-06 — the causal source revision (provenance) is NO LONGER supplied
// by the caller as a fabricated `fence: 1` stub. It is ALLOCATED by the store
// inside {@link SqliteTransitionObligationLedger.appendFenced}: the creation-
// generation fence IS the provenance revision. The obligation's `lease_fence` is
// pre-reserved to the same value, so the reconciler's first lease runs under a
// REAL monotonic fence. A replay (same source fact after crash recovery) is a
// no-op: the existing causal revision and lease fence are preserved.
// ---------------------------------------------------------------------------

export interface ObligationIntegratorDeps {
  readonly ledger: SqliteTransitionObligationLedger;
}

export class TransitionObligationIntegrator {
  constructor(private readonly deps: ObligationIntegratorDeps) {}

  /** Final typed presentation committed -> kernel must close its producer. */
  onFinalPresentationCommitted(input: {
    commitmentRef: string;
    commitmentDigest: string;
    workplaceRef: string;
  }): TransitionObligation {
    return this.appendFenced({
      sourceKind: 'final-presentation-committed',
      sourceRef: input.commitmentRef,
      sourceDigest: input.commitmentDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'close-presentation',
      ownerCapability: 'presentation-closure',
    });
  }

  /** CandidateSet sealed → the Gate must run. */
  onCandidateSetSealed(input: {
    candidateSetRef: string;
    candidateSetDigest: string;
    workplaceRef: string;
  }): TransitionObligation {
    return this.appendFenced({
      sourceKind: 'candidate-set-sealed',
      sourceRef: input.candidateSetRef,
      sourceDigest: input.candidateSetDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'run-gate',
      ownerCapability: 'gate-run-driver',
    });
  }

  /** Gate accepted → post-acceptance effects must run. */
  onGateAccepted(input: {
    gateDecisionKey: string;
    gateDecisionDigest: string;
    workplaceRef: string;
  }): TransitionObligation {
    return this.appendFenced({
      sourceKind: 'gate-accepted',
      sourceRef: input.gateDecisionKey,
      sourceDigest: input.gateDecisionDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'run-effects',
      ownerCapability: 'production-cell-node-executor',
    });
  }

  /** Effects settled → final acceptance must be recorded. */
  onEffectsSettled(input: {
    workplaceRef: string;
    effectReceiptDigest: string;
  }): TransitionObligation {
    return this.appendFenced({
      sourceKind: 'effects-settled',
      sourceRef: input.workplaceRef,
      sourceDigest: input.effectReceiptDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'record-final-acceptance',
      ownerCapability: 'production-cell-node-executor',
    });
  }

  /** Final acceptance recorded → process must settle. */
  onFinalAcceptanceRecorded(input: {
    finalAcceptanceRef: string;
    acceptanceDigest: string;
    workplaceRef: string;
  }): TransitionObligation {
    return this.appendFenced({
      sourceKind: 'final-acceptance-recorded',
      sourceRef: input.finalAcceptanceRef,
      sourceDigest: input.acceptanceDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'settle-process',
      ownerCapability: 'process-settlement',
    });
  }

  /** Process settled → lifecycle must route. */
  onProcessSettled(input: {
    processRunId: number;
    settlementDigest: string;
    subjectRef: string;
  }): TransitionObligation {
    return this.appendFenced({
      sourceKind: 'process-settled',
      sourceRef: `process-run:${input.processRunId}`,
      sourceDigest: input.settlementDigest,
      subjectRef: input.subjectRef,
      handoffKind: 'route-lifecycle',
      ownerCapability: 'lifecycle-router',
    });
  }

  private appendFenced(input: AppendFencedObligationInput): TransitionObligation {
    // ADR-053 B-8 — obligations are MANDATORY crash-recovery facts, NOT
    // best-effort. A failure to append MUST propagate. When this is called
    // inside the source transition's transaction (e.g. the CandidateSet seal
    // txn), the propagation rolls the source fact back — so the obligation is
    // recorded iff the source commits (atomic, all-or-nothing). Swallowing
    // here would leave a sealed CandidateSet with no redrive target after a
    // crash between seal and gate.
    //
    // ADR-053 C7-06 — the causal source revision is ALLOCATED by the store
    // (appendFenced), not supplied by the caller. No fabricated `fence` token
    // crosses this seam.
    return this.deps.ledger.appendFenced(input);
  }
}

// ---------------------------------------------------------------------------
// Handler registration helpers — bind production transition logic to the
// reconciler. Each handler is idempotent: it either performs the transition
// or discovers it was already performed and completes with the existing receipt.
// ---------------------------------------------------------------------------

export const HANDOFF_OWNERS: Readonly<Record<TransitionHandoffKind, string>> = Object.freeze({
  'close-presentation': 'presentation-closure',
  'run-gate': 'gate-run-driver',
  'run-effects': 'production-cell-node-executor',
  'record-final-acceptance': 'production-cell-node-executor',
  'settle-process': 'process-settlement',
  'route-lifecycle': 'lifecycle-router',
});

export const SOURCE_TO_HANDOFF: Readonly<Record<TransitionSourceKind, TransitionHandoffKind>> = Object.freeze({
  'final-presentation-committed': 'close-presentation',
  'candidate-set-sealed': 'run-gate',
  'gate-accepted': 'run-effects',
  'effects-settled': 'record-final-acceptance',
  'final-acceptance-recorded': 'settle-process',
  'process-settled': 'route-lifecycle',
});
