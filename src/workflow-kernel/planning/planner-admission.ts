/**
 * workflow-kernel/planning/planner-admission.ts - the profile-blind attempt
 * admission port (WP-09, plan phase EK-6).
 *
 * Plan law (EK-6): "Give planner attempts the exact same positive finite
 * context-budget and role-contract admission rules as every other semantic
 * profile." This module is that law made executable: ONE admission path for
 * planner, implementer, reviewer and certifier attempts alike. The semantic
 * profile is a RECEIPT FIELD, never a branch - there is no `profile ===`
 * conditional anywhere in this file (the structural test scans for one),
 * no planner budget table, and no relaxed retry.
 *
 * The exact same rules means exactly these three reused functions, nothing
 * else, in this order:
 *   1. validateLimits       (application/admission.ts - positive finite,
 *                            fail-closed; zero/missing/infinite never passes)
 *   2. evaluateEnvelope     (application/admission.ts - deterministic
 *                            per-request/ordinal/cumulative budget oracle)
 *   3. resolveRoleContract  (roles/resolver.ts - the ONE closed-set pin
 *                            resolver; unknown ref/digest fails closed)
 *
 * PURITY: no I/O, no clock, no SQL, no profile-keyed branch.
 */

import type { CanonicalRoleContractReference, SemanticProfile, TypedRefusal } from '../domain/types.js';
import { evaluateEnvelope, validateLimits, type PromptBudgetLimits, type ProviderRequestEnvelope } from '../application/admission.js';
import { resolveRoleContract, type InstalledRoleContracts } from '../roles/resolver.js';

/* ------------------------------------------------------------------ */
/* The one admission input/output                                      */
/* ------------------------------------------------------------------ */

/** The CAS-fenced attempt counters the budget oracle reads. */
export interface AttemptCountersSnapshot {
  readonly nextRequestOrdinal: number;
  readonly cumulativeInputTokens: number;
}

/** One attempt admission request: profile is a receipt field only. */
export interface AttemptAdmissionInput {
  readonly profile: SemanticProfile;
  readonly limits: PromptBudgetLimits;
  readonly counters: AttemptCountersSnapshot;
  readonly envelope: ProviderRequestEnvelope;
  readonly rolePin: CanonicalRoleContractReference;
}

/** The refusal stage: exactly which of the three shared rules refused. */
export type AttemptAdmissionRefusal = {
  readonly refused: true;
  readonly profile: SemanticProfile;
  readonly stage: 'limits' | 'envelope' | 'role-contract';
  readonly refusal: TypedRefusal;
};

export type AttemptAdmissionOutcome =
  | {
      readonly admitted: true;
      readonly profile: SemanticProfile;
      readonly requestOrdinal: number;
      /** The ONE shared admission path identifier (identical for every profile). */
      readonly admissionPath: 'application/admission.evaluateEnvelope+roles/resolver.resolveRoleContract';
      readonly roleContractRef: string;
    }
  | AttemptAdmissionRefusal;

/* ------------------------------------------------------------------ */
/* The profile-blind admission path                                    */
/* ------------------------------------------------------------------ */

/**
 * Admit one attempt for ANY semantic profile through the exact same
 * positive-finite context budget and role-contract admission rules. The
 * profile never selects a rule: swapping it cannot change the outcome for
 * identical limits, counters, envelope and pin.
 */
export function admitAttempt(set: InstalledRoleContracts, input: AttemptAdmissionInput): AttemptAdmissionOutcome {
  const limitsRefusal = validateLimits(input.limits);
  if (limitsRefusal !== undefined) {
    return { refused: true, profile: input.profile, stage: 'limits', refusal: limitsRefusal };
  }
  const evaluation = evaluateEnvelope(input.counters, input.limits, input.envelope);
  if (!evaluation.admitted) {
    return {
      refused: true,
      profile: input.profile,
      stage: 'envelope',
      refusal: { refused: true, reason: 'UNIVERSE_VIOLATION', detail: `${evaluation.reason}: ${evaluation.detail}` },
    };
  }
  const resolution = resolveRoleContract(set, input.rolePin);
  if (!('resolved' in resolution)) {
    return { refused: true, profile: input.profile, stage: 'role-contract', refusal: resolution };
  }
  return {
    admitted: true,
    profile: input.profile,
    requestOrdinal: input.counters.nextRequestOrdinal + 1,
    admissionPath: 'application/admission.evaluateEnvelope+roles/resolver.resolveRoleContract',
    roleContractRef: resolution.contract.roleContractRef,
  };
}
