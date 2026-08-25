/**
 * workflow-kernel/application/admission.ts - the ActivityAttempt context
 * admission command surface (WP-07, plan phase EK-4).
 *
 * Plan law (EK-4 + the EK-1 prompt/context envelope):
 *   - `admitProviderRequest` is an ActivityAttempt CAS command; its receipt
 *     and the exact provider-send obligation commit with the counter update
 *     in ONE transaction (the WP-06 repository owns that transaction);
 *   - two concurrent admissions at one context revision: exactly one passes;
 *   - a crash after admission / before send redrives the SAME
 *     obligation:providerSend and ordinal - never a new admission;
 *   - a deterministic budget rejection refuses the request without consuming
 *     context or worker-retry budget, and the IDENTICAL request is refused
 *     again on re-submission;
 *   - every limit is positive and finite; zero, missing or non-finite is
 *     fail-closed (never "unlimited").
 *
 * Boundary note (WP-18 seam): the full cumulative context accountant and the
 * persisted refused-receipt evidence protocol are WP-18's owned surface
 * (src/workflow-kernel/context-envelope/**). WP-07 enforces here the
 * deterministic per-request/ordinal/cumulative limits over the CAS-fenced
 * attempt counters read through the OWNING repository, and returns typed
 * refusals that consume nothing.
 */

import type { CommandOutcome, TypedRefusal } from '../domain/types.js';
import type { FaultScheduler } from './faults.js';
import type { KernelPersistenceSession } from '../persistence/session.js';

/* ------------------------------------------------------------------ */
/* The prompt budget limits (EK-1 shape; positive finite, fail-closed)  */
/* ------------------------------------------------------------------ */

export interface PromptBudgetLimits {
  readonly providerContextLimitTokens: number;
  readonly reservedOutputTokens: number;
  readonly providerOverheadReserveTokens: number;
  readonly safetyMarginTokens: number;
  readonly maxTotalInputTokens: number;
  readonly maxCumulativeSessionInputTokens: number;
  readonly maxProviderRequests: number;
}

/** The per-request ceiling: provider context minus every reserve (EK-1). */
export function effectiveInputLimit(limits: PromptBudgetLimits): number {
  return (
    limits.providerContextLimitTokens -
    limits.reservedOutputTokens -
    limits.providerOverheadReserveTokens -
    limits.safetyMarginTokens
  );
}

/** Fail-closed limit validation: zero, negative, non-finite or missing means never "unlimited". */
export function validateLimits(limits: PromptBudgetLimits): TypedRefusal | undefined {
  const entries: readonly [keyof PromptBudgetLimits, number][] = Object.entries(limits).map(
    ([key, value]) => [key as keyof PromptBudgetLimits, value as number],
  );
  const expected: readonly (keyof PromptBudgetLimits)[] = [
    'providerContextLimitTokens',
    'reservedOutputTokens',
    'providerOverheadReserveTokens',
    'safetyMarginTokens',
    'maxTotalInputTokens',
    'maxCumulativeSessionInputTokens',
    'maxProviderRequests',
  ];
  for (const key of expected) {
    if (limits[key] === undefined) {
      return { refused: true, reason: 'MISSING_EVIDENCE', detail: `prompt budget limit ${key} is missing (never unlimited)` };
    }
  }
  for (const [key, value] of entries) {
    if (!Number.isFinite(value) || value <= 0) {
      return { refused: true, reason: 'UNIVERSE_VIOLATION', detail: `prompt budget limit ${key} must be positive and finite (got ${String(value)})` };
    }
  }
  if (effectiveInputLimit(limits) <= 0) {
    return { refused: true, reason: 'UNIVERSE_VIOLATION', detail: 'effective input limit is not positive: the reserves exceed the provider context limit' };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Deterministic envelope evaluation                                   */
/* ------------------------------------------------------------------ */

/** The final pre-send assembled request envelope (the admission oracle input). */
export interface ProviderRequestEnvelope {
  /** The exact provider/model pinned on the attempt (ProviderRoutePin evidence). */
  readonly providerModel: string;
  /** Measured input tokens of the FINAL assembled request (pre-serialization boundary). */
  readonly requestInputTokens: number;
  /** Canonical digest of the assembled request bytes. */
  readonly envelopeDigest: string;
}

/** The closed typed rejection set of a deterministic budget evaluation. */
export type BudgetRejectionReason =
  | 'REQUEST_OVER_TOTAL_LIMIT'
  | 'REQUEST_OVER_EFFECTIVE_LIMIT'
  | 'CUMULATIVE_OVER_LIMIT'
  | 'REQUEST_ORDINAL_EXHAUSTED';

export type AdmissionEvaluation =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: BudgetRejectionReason; readonly detail: string };

/** Pure, deterministic evaluation over the CAS-fenced attempt counters. */
export function evaluateEnvelope(
  counters: { readonly nextRequestOrdinal: number; readonly cumulativeInputTokens: number },
  limits: PromptBudgetLimits,
  envelope: ProviderRequestEnvelope,
): AdmissionEvaluation {
  const requestOrdinal = counters.nextRequestOrdinal + 1;
  if (requestOrdinal > limits.maxProviderRequests) {
    return { admitted: false, reason: 'REQUEST_ORDINAL_EXHAUSTED', detail: `request ordinal ${requestOrdinal} exceeds maxProviderRequests ${limits.maxProviderRequests}` };
  }
  if (envelope.requestInputTokens > limits.maxTotalInputTokens) {
    return { admitted: false, reason: 'REQUEST_OVER_TOTAL_LIMIT', detail: `request ${envelope.requestInputTokens} tokens exceeds maxTotalInputTokens ${limits.maxTotalInputTokens}` };
  }
  const effective = effectiveInputLimit(limits);
  if (envelope.requestInputTokens > effective) {
    return { admitted: false, reason: 'REQUEST_OVER_EFFECTIVE_LIMIT', detail: `request ${envelope.requestInputTokens} tokens exceeds the effective input limit ${effective}` };
  }
  const cumulative = counters.cumulativeInputTokens + envelope.requestInputTokens;
  if (cumulative > limits.maxCumulativeSessionInputTokens) {
    return { admitted: false, reason: 'CUMULATIVE_OVER_LIMIT', detail: `cumulative ${cumulative} tokens would exceed maxCumulativeSessionInputTokens ${limits.maxCumulativeSessionInputTokens}` };
  }
  return { admitted: true };
}

/* ------------------------------------------------------------------ */
/* The admission command                                               */
/* ------------------------------------------------------------------ */

export interface AdmitProviderRequestArgs {
  readonly attemptInstanceId: string;
  readonly envelope: ProviderRequestEnvelope;
  readonly limits: PromptBudgetLimits;
  /**
   * Deterministic command key. The obligation consumer passes its
   * claim key (`consume:<obligation key>`) so obligation completion and
   * the admission share one idempotency dimension.
   */
  readonly idempotencyKey?: string;
  readonly faults?: FaultScheduler;
}

export type AdmitProviderRequestResult =
  | {
      readonly status: 'admitted';
      readonly requestOrdinal: number;
      readonly contextRevisionBefore: number;
      readonly receiptRef: string;
      readonly providerSendObligationKey: string;
      readonly replayed: boolean;
      /** The owning repository's raw command outcome (event, plan, obligations). */
      readonly outcome: Extract<CommandOutcome, { committed: true } | { replayed: true }>;
    }
  | {
      /** Crash-after-admission redrive: the SAME obligation + ordinal, never a new admission. */
      readonly status: 'redrive';
      readonly providerSendObligationKey: string;
      readonly requestOrdinal: number;
    }
  | {
      /** Deterministic budget rejection: nothing committed, no budget consumed. */
      readonly status: 'refused';
      readonly reason: BudgetRejectionReason | 'LIMITS_INVALID' | 'ATTEMPT_ABSENT';
      readonly detail: string;
    }
  | {
      /** Lost the CAS race (a concurrent admission passed at the same context revision). */
      readonly status: 'stale';
      readonly detail: string;
    };

/**
 * The one admission path: crash-redrive check -> deterministic envelope
 * evaluation -> the WP-06 sole-writer CAS transaction (receipt + provider-send
 * obligation + counter update). Never admits a second request for an ordinal
 * that already has an open provider-send obligation.
 */
export function admitProviderRequest(session: KernelPersistenceSession, args: AdmitProviderRequestArgs): AdmitProviderRequestResult {
  const { faults } = args;
  faults?.fire('before-admission');

  // Crash redrive: an open provider-send obligation for this attempt means
  // the admission already committed - redrive the SAME obligation + ordinal.
  const openSend = session
    .hydrateWorld()
    .world.obligations.find(
      (obligation) => obligation.kind === 'obligation:providerSend' && obligation.state === 'open' && obligation.sourceInstanceId === args.attemptInstanceId,
    );
  if (openSend) {
    const ordinal = admittedOrdinalOf(session, args.attemptInstanceId);
    return { status: 'redrive', providerSendObligationKey: openSend.idempotencyKey, requestOrdinal: ordinal };
  }

  const limitsRefusal = validateLimits(args.limits);
  if (limitsRefusal) {
    return { status: 'refused', reason: 'LIMITS_INVALID', detail: limitsRefusal.detail };
  }

  const counters = session.activityAttempt.loadContextCounters(args.attemptInstanceId);
  if (counters === undefined) {
    return { status: 'refused', reason: 'ATTEMPT_ABSENT', detail: `ActivityAttempt ${args.attemptInstanceId} does not exist` };
  }

  const evaluation = evaluateEnvelope(counters, args.limits, args.envelope);
  if (!evaluation.admitted) {
    // Deterministic rejection: identical envelope -> identical verdict; the
    // identical request can never pass while the limits are unchanged.
    return { status: 'refused', reason: evaluation.reason, detail: evaluation.detail };
  }

  const requestOrdinal = counters.nextRequestOrdinal + 1;
  const head = session.activityAttempt.loadHead(args.attemptInstanceId);
  const input = {
    command: 'activityAttempt.admitProviderRequest' as const,
    instanceId: args.attemptInstanceId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: args.idempotencyKey ?? `admit:${args.attemptInstanceId}:${requestOrdinal}`,
  };
  const outcome: CommandOutcome = session.activityAttempt.applyCommand(input, {
    promptReceipt: {
      admission: 'admitted',
      requestOrdinal,
      expectedContextRevision: counters.contextRevision,
      digest: args.envelope.envelopeDigest,
      cumulativeInputTokens: args.envelope.requestInputTokens,
    },
  });

  if ('refused' in outcome) {
    if (outcome.reason === 'STALE_EXPECTED_REVISION') {
      return { status: 'stale', detail: outcome.detail };
    }
    return { status: 'stale', detail: outcome.detail };
  }
  if ('replayed' in outcome) {
    return {
      status: 'admitted',
      requestOrdinal,
      contextRevisionBefore: counters.contextRevision,
      receiptRef: `prompt-receipt:${args.attemptInstanceId}:${requestOrdinal}`,
      providerSendObligationKey: `${input.idempotencyKey}#obligation:providerSend`,
      replayed: true,
      outcome,
    };
  }
  faults?.fire('after-admission');
  return {
    status: 'admitted',
    requestOrdinal,
    contextRevisionBefore: counters.contextRevision,
    receiptRef: `prompt-receipt:${args.attemptInstanceId}:${requestOrdinal}`,
    providerSendObligationKey: `${input.idempotencyKey}#obligation:providerSend`,
    replayed: false,
    outcome,
  };
}

/** The committed ordinal count of an attempt (its admitted receipts), read through the owning repository. */
function admittedOrdinalOf(session: KernelPersistenceSession, attemptInstanceId: string): number {
  const counters = session.activityAttempt.loadContextCounters(attemptInstanceId);
  return counters === undefined ? 0 : counters.nextRequestOrdinal;
}
