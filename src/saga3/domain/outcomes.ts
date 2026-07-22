/**
 * Saga 3 — Terminal truth table and outcome certification.
 *
 * Cause-based terminal predicates with frozen precedence.
 * Success is evaluated ONLY when no negative predicate is active.
 */

import {
  TERMINAL_PRECEDENCE,
  SUCCESS_OUTCOMES,
  type TerminalOutcome,
  type OutcomeCertificate,
  type ConditionStatus,
} from './types.js';

export interface CertificationInputs {
  readonly generation: number;
  readonly mandatoryConditions: ReadonlyArray<{
    readonly obligationId: string;
    readonly status: ConditionStatus;
  }>;
  readonly activeNegativeCauses: ReadonlyArray<{
    readonly outcome: TerminalOutcome;
    readonly reason: string;
  }>;
  readonly hasUnresolvedAmbiguity: boolean;
  readonly degradationActive: boolean;
  readonly degradedLostObligations: readonly string[];
  readonly sourceFingerprint: string | null;
}

export type CertificationDecision =
  | { readonly certified: true; readonly outcome: TerminalOutcome; readonly reason: string }
  | { readonly certified: false; readonly reason: string };

/**
 * Evaluate terminal predicates in frozen precedence order.
 */
export function evaluateTerminal(inputs: CertificationInputs): CertificationDecision {
  // 1. Unresolved ambiguity takes precedence over everything.
  if (inputs.hasUnresolvedAmbiguity) {
    return { certified: true, outcome: 'EXTERNAL_STATE_UNKNOWN', reason: 'irreducible material external ambiguity' };
  }

  // 2. Proven negative causes in precedence order.
  for (const outcome of TERMINAL_PRECEDENCE) {
    if (outcome === 'EXTERNAL_STATE_UNKNOWN') continue; // handled above
    const cause = inputs.activeNegativeCauses.find((c) => c.outcome === outcome);
    if (cause) {
      return { certified: true, outcome: cause.outcome, reason: cause.reason };
    }
  }

  // 3. Success: only if no negative predicate active AND all mandatory True.
  if (inputs.activeNegativeCauses.length === 0) {
    const allMandatoryTrue = inputs.mandatoryConditions.every((c) => c.status === 'True');
    if (allMandatoryTrue && inputs.mandatoryConditions.length > 0) {
      const outcome: TerminalOutcome = inputs.degradationActive
        ? 'SUCCEEDED_DEGRADED'
        : 'SUCCEEDED';
      return {
        certified: true,
        outcome,
        reason: inputs.degradationActive
          ? `all profile-mandatory True (degraded; lost: ${inputs.degradedLostObligations.join(', ')})`
          : 'all mandatory conditions True under current evidence',
      };
    }

    // Not all mandatory True and no negative cause → not terminal yet.
    const blockers = inputs.mandatoryConditions
      .filter((c) => c.status !== 'True')
      .map((c) => c.obligationId);
    return { certified: false, reason: `mandatory not yet True: ${blockers.join(', ')}` };
  }

  return { certified: false, reason: 'conditions pending' };
}

/**
 * Issue the immutable outcome certificate. Called once when
 * evaluateTerminal returns certified. After this the outcome is absorbing.
 */
export function issueCertificate(
  inputs: CertificationInputs,
  decision: { readonly outcome: TerminalOutcome; readonly reason: string },
): OutcomeCertificate {
  if (!SUCCESS_OUTCOMES.includes(decision.outcome)) {
    // Negative outcomes still need a certificate — but no mandatory check.
  } else {
    // Double-check: success requires all mandatory True.
    const nonTrue = inputs.mandatoryConditions.filter((c) => c.status !== 'True');
    if (nonTrue.length > 0) {
      throw new Error(
        `issueCertificate: cannot issue ${decision.outcome} with non-True mandatory: ${nonTrue.map((c) => c.obligationId).join(', ')}`,
      );
    }
  }

  return {
    episodeSpecId: '', // filled by caller
    outcome: decision.outcome,
    causalReason: decision.reason,
    generation: inputs.generation,
    sourceFingerprint: inputs.sourceFingerprint,
    satisfiedConditions: inputs.mandatoryConditions
      .filter((c) => c.status === 'True')
      .map((c) => c.obligationId),
    unresolvedConditions: inputs.mandatoryConditions
      .filter((c) => c.status !== 'True')
      .map((c) => c.obligationId),
    certifiedAt: Date.now(),
  };
}

/**
 * Readiness vector — display only. Never authorizes transitions.
 * Blocker deficits are always surfaced regardless of the scalar.
 */
export interface ReadinessVector {
  readonly mandatoryTrue: number;
  readonly mandatoryTotal: number;
  readonly blockerDeficits: readonly string[];
  readonly readinessScalar: number;
  readonly explanation: string;
}

export function computeReadinessVector(inputs: {
  readonly mandatoryConditions: ReadonlyArray<{
    readonly obligationId: string;
    readonly status: ConditionStatus;
  }>;
}): ReadinessVector {
  const total = inputs.mandatoryConditions.length;
  const trueCount = inputs.mandatoryConditions.filter((c) => c.status === 'True').length;
  const deficits = inputs.mandatoryConditions
    .filter((c) => c.status !== 'True')
    .map((c) => c.obligationId);
  return {
    mandatoryTrue: trueCount,
    mandatoryTotal: total,
    blockerDeficits: deficits,
    readinessScalar: total > 0 ? Math.round((trueCount / total) * 100) : 0,
    explanation: `${trueCount}/${total} mandatory True; ${deficits.length} deficit(s)`,
  };
}
