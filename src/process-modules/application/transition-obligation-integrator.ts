// src/process-modules/application/transition-obligation-integrator.ts
//
// ADR-053 Phase 8 — wire the five conveyor handoffs onto the durable
// transition-obligation substrate (Phase 2).
//
// Each source fact (CandidateSet seal, Gate acceptance, Effects settlement,
// FinalAcceptance recording, Process settlement) appends a durable obligation
// in the SAME logical step. The reconciler (Phase 2) then redrives any
// obligation that was not completed (e.g. after a crash between seal and gate).
//
// The five handoffs:
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
  AppendObligationInput,
  TransitionSourceKind,
  TransitionHandoffKind,
} from '../persistence/sqlite-transition-obligation-ledger.js';

// ---------------------------------------------------------------------------
// Obligation-creation utilities — one per source fact kind.
//
// Each is called in the SAME transaction (or logical step) as the source fact.
// The obligation key is deterministic: a replay of the source fact finds the
// existing obligation (INSERT OR IGNORE).
// ---------------------------------------------------------------------------

export interface ObligationIntegratorDeps {
  readonly ledger: SqliteTransitionObligationLedger;
}

export class TransitionObligationIntegrator {
  constructor(private readonly deps: ObligationIntegratorDeps) {}

  /** CandidateSet sealed → the Gate must run. */
  onCandidateSetSealed(input: {
    candidateSetRef: string;
    candidateSetDigest: string;
    workplaceRef: string;
    fence: number;
  }): void {
    this.append({
      sourceKind: 'candidate-set-sealed',
      sourceRef: input.candidateSetRef,
      sourceDigest: input.candidateSetDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'run-gate',
      ownerCapability: 'gate-run-driver',
      fence: input.fence,
    });
  }

  /** Gate accepted → post-acceptance effects must run. */
  onGateAccepted(input: {
    gateDecisionKey: string;
    gateDecisionDigest: string;
    workplaceRef: string;
    fence: number;
  }): void {
    this.append({
      sourceKind: 'gate-accepted',
      sourceRef: input.gateDecisionKey,
      sourceDigest: input.gateDecisionDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'run-effects',
      ownerCapability: 'production-cell-node-executor',
      fence: input.fence,
    });
  }

  /** Effects settled → final acceptance must be recorded. */
  onEffectsSettled(input: {
    workplaceRef: string;
    effectReceiptDigest: string;
    fence: number;
  }): void {
    this.append({
      sourceKind: 'effects-settled',
      sourceRef: input.workplaceRef,
      sourceDigest: input.effectReceiptDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'record-final-acceptance',
      ownerCapability: 'production-cell-node-executor',
      fence: input.fence,
    });
  }

  /** Final acceptance recorded → process must settle. */
  onFinalAcceptanceRecorded(input: {
    finalAcceptanceRef: string;
    acceptanceDigest: string;
    workplaceRef: string;
    fence: number;
  }): void {
    this.append({
      sourceKind: 'final-acceptance-recorded',
      sourceRef: input.finalAcceptanceRef,
      sourceDigest: input.acceptanceDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'settle-process',
      ownerCapability: 'process-settlement',
      fence: input.fence,
    });
  }

  /** Process settled → lifecycle must route. */
  onProcessSettled(input: {
    processRunId: number;
    settlementDigest: string;
    workplaceRef: string;
    fence: number;
  }): void {
    this.append({
      sourceKind: 'process-settled',
      sourceRef: `process-run:${input.processRunId}`,
      sourceDigest: input.settlementDigest,
      subjectRef: input.workplaceRef,
      handoffKind: 'route-lifecycle',
      ownerCapability: 'lifecycle-router',
      fence: input.fence,
    });
  }

  private append(input: Omit<AppendObligationInput, never>): void {
    // ADR-053 B-8 — obligations are MANDATORY crash-recovery facts, NOT
    // best-effort. A failure to append MUST propagate. When this is called
    // inside the source transition's transaction (e.g. the CandidateSet seal
    // txn), the propagation rolls the source fact back — so the obligation is
    // recorded iff the source commits (atomic, all-or-nothing). Swallowing
    // here would leave a sealed CandidateSet with no redrive target after a
    // crash between seal and gate.
    this.deps.ledger.append(input as AppendObligationInput);
  }
}

// ---------------------------------------------------------------------------
// Handler registration helpers — bind production transition logic to the
// reconciler. Each handler is idempotent: it either performs the transition
// or discovers it was already performed and completes with the existing receipt.
// ---------------------------------------------------------------------------

export const HANDOFF_OWNERS: Readonly<Record<TransitionHandoffKind, string>> = Object.freeze({
  'run-gate': 'gate-run-driver',
  'run-effects': 'production-cell-node-executor',
  'record-final-acceptance': 'production-cell-node-executor',
  'settle-process': 'process-settlement',
  'route-lifecycle': 'lifecycle-router',
});

export const SOURCE_TO_HANDOFF: Readonly<Record<TransitionSourceKind, TransitionHandoffKind>> = Object.freeze({
  'candidate-set-sealed': 'run-gate',
  'gate-accepted': 'run-effects',
  'effects-settled': 'record-final-acceptance',
  'final-acceptance-recorded': 'settle-process',
  'process-settled': 'route-lifecycle',
});
