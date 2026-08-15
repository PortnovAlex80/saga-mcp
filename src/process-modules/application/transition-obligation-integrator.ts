// src/process-modules/application/transition-obligation-integrator.ts
//
// ADR-053 Phase 8 / ADR-072 — wire the six conveyor handoffs onto the durable
// transition-obligation substrate (Phase 2).
//
// Each source fact appends a durable obligation in the SAME logical step. The
// reconciler redrives any obligation that was not completed after a crash.

import type { SqliteTransitionObligationLedger } from '../persistence/sqlite-transition-obligation-ledger.js';
import type {
  AppendFencedObligationInput,
  TransitionObligation,
  TransitionSourceKind,
  TransitionHandoffKind,
} from '../persistence/sqlite-transition-obligation-ledger.js';

export interface ObligationIntegratorDeps {
  readonly ledger: SqliteTransitionObligationLedger;
}

const CELL_EFFECT_RECEIPT_PREFIX = 'cell-effect-receipt:';

export class TransitionObligationIntegrator {
  constructor(private readonly deps: ObligationIntegratorDeps) {}

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

  /**
   * Effects settled → final acceptance must be recorded.
   *
   * The existing caller passes the content-addressed
   * `cell-effect-receipt:<digest>` ref through the historically named
   * `effectReceiptDigest` parameter. Normalize it here so the obligation source
   * identifies the exact persisted EffectReceipt instead of the whole Workplace.
   */
  onEffectsSettled(input: {
    workplaceRef: string;
    effectReceiptDigest: string;
  }): TransitionObligation {
    const effect = exactEffectReceiptIdentity(input.effectReceiptDigest);
    return this.appendFenced({
      sourceKind: 'effects-settled',
      sourceRef: effect.ref,
      sourceDigest: effect.digest,
      subjectRef: input.workplaceRef,
      handoffKind: 'record-final-acceptance',
      ownerCapability: 'production-cell-node-executor',
    });
  }

  /**
   * Final acceptance recorded → process must settle.
   *
   * NOTE: the current ProductionCellNodeExecutor still passes a legacy alias
   * (`final-acceptance:<workplace>:<candidate>`) rather than the persisted
   * `cell-final-acceptance:<rowDigest>` ref. Do not fabricate a conversion here:
   * the semantic acceptance digest passed by that caller is intentionally not
   * the row digest used by SqliteCellFinalAcceptance. Exact-ref cutover must be
   * performed at the caller that receives recordFinalAcceptance()'s return.
   */
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
      // Runtime registration executes settlement through the Production Cell
      // node executor. Persist the same owner identity the executable manifest
      // enforces instead of the historical `process-settlement` alias.
      ownerCapability: 'production-cell-node-executor',
    });
  }

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
      ownerCapability: 'lifecycle-orchestrator',
    });
  }

  private appendFenced(input: AppendFencedObligationInput): TransitionObligation {
    return this.deps.ledger.appendFenced(input);
  }
}

function exactEffectReceiptIdentity(value: string): { ref: string; digest: string } {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('TRANSITION_EFFECT_RECEIPT_IDENTITY_REQUIRED');
  }
  const normalized = value.trim();
  if (normalized.startsWith(CELL_EFFECT_RECEIPT_PREFIX)) {
    const digest = normalized.slice(CELL_EFFECT_RECEIPT_PREFIX.length);
    if (!digest) throw new Error('TRANSITION_EFFECT_RECEIPT_DIGEST_REQUIRED');
    return { ref: normalized, digest };
  }
  return {
    ref: `${CELL_EFFECT_RECEIPT_PREFIX}${normalized}`,
    digest: normalized,
  };
}

export const HANDOFF_OWNERS: Readonly<Record<TransitionHandoffKind, string>> = Object.freeze({
  'close-presentation': 'presentation-closure',
  'run-gate': 'gate-run-driver',
  'run-effects': 'production-cell-node-executor',
  'record-final-acceptance': 'production-cell-node-executor',
  'settle-process': 'production-cell-node-executor',
  'route-lifecycle': 'lifecycle-orchestrator',
});

export const SOURCE_TO_HANDOFF: Readonly<Record<TransitionSourceKind, TransitionHandoffKind>> = Object.freeze({
  'final-presentation-committed': 'close-presentation',
  'candidate-set-sealed': 'run-gate',
  'gate-accepted': 'run-effects',
  'effects-settled': 'record-final-acceptance',
  'final-acceptance-recorded': 'settle-process',
  'process-settled': 'route-lifecycle',
});
