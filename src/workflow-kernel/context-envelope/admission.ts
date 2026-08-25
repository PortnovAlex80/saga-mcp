/**
 * workflow-kernel/context-envelope/admission.ts - the CAS-fenced admission
 * policy over the ActivityAttempt context counters (WP-18).
 *
 * Authority: docs/refactoring/event-kernel/specs/context-envelope-semantics.md
 * section 4 (admission command semantics) + section 8 (crash windows) and
 * the unified transition universe names pinned there:
 *   activityAttempt.admitProviderRequest, obligation:providerSend,
 *   PromptAssemblyReceipt:admitted | :refused.
 *
 * Laws implemented here:
 *   - ActivityAttempt is the SOLE mutable owner of context admission: it
 *     stores CAS-fenced contextRevision, nextRequestOrdinal and
 *     cumulativeInputTokens. Receipts are evidence; no counter is ever
 *     derived by selecting a latest receipt or summing receipt rows.
 *   - admitProviderRequest(expectedContextRevision, envelope):
 *       1. CAS on expectedContextRevision == contextRevision; a mismatch
 *          fails the command (stale assembler snapshot) consuming nothing.
 *       2. Count the envelope with the pinned token counter (the accountant).
 *       3. Atomically validate EVERY limit + mandatory-layer digest presence.
 *       4. On admission: advance ordinal + cumulative + revision, append an
 *          immutable PromptAssemblyReceipt:admitted, create exactly one
 *          idempotent obligation:providerSend naming the receipt digest and
 *          ordinal.
 *       5. On refusal: append an immutable PromptAssemblyReceipt:refused
 *          persisting the rejected-envelope digest and the typed violation;
 *          counters do not advance; NO context, NO worker-retry budget and
 *          NO provider-send obligation is consumed; the transport never
 *          serializes or sends.
 *   - Two concurrent admissions at the same revision: exactly one CAS
 *     success (the store commit is conditional on the revision).
 *
 * PURITY: node builtins only; no network, no clock, no randomness.
 */

import { accountEnvelope, rejectedEnvelopeDigestOf } from './accountant.js';
import type { PromptBudgetProfile, ProviderModelLimitTableArtifact } from './accountant.js';
import { sealReceipt } from './receipt.js';
import type { ContextEnvelope, ContextViolation, PromptAssemblyReceipt, ProviderRoutePin } from './receipt.js';

/* ------------------------------------------------------------------ */
/* CAS-fenced attempt counters (ActivityAttempt-owned state)           */
/* ------------------------------------------------------------------ */

/**
 * The mutable context-admission counters of one ActivityAttempt. Initial
 * state at activityAttempt.create: contextRevision 0, nextRequestOrdinal 1,
 * cumulativeInputTokens 0. This is the ONLY counter authority; the
 * accountant reads it, never the receipt log.
 */
export interface ActivityAttemptContextCounters {
  readonly attemptRef: string;
  readonly contextRevision: number;
  readonly nextRequestOrdinal: number;
  readonly cumulativeInputTokens: number;
  readonly providerRoutePin: ProviderRoutePin;
  readonly promptBudgetProfileRef: string;
  readonly promptBudgetProfileDigest: string;
}

/** Initial counters for a freshly created attempt. */
export function initialAttemptCounters(input: {
  readonly attemptRef: string;
  readonly providerRoutePin: ProviderRoutePin;
  readonly promptBudgetProfileRef: string;
  readonly promptBudgetProfileDigest: string;
}): ActivityAttemptContextCounters {
  return {
    attemptRef: input.attemptRef,
    contextRevision: 0,
    nextRequestOrdinal: 1,
    cumulativeInputTokens: 0,
    providerRoutePin: input.providerRoutePin,
    promptBudgetProfileRef: input.promptBudgetProfileRef,
    promptBudgetProfileDigest: input.promptBudgetProfileDigest,
  };
}

/* ------------------------------------------------------------------ */
/* The provider-send obligation created on admission (and only then)   */
/* ------------------------------------------------------------------ */

/**
 * obligation:providerSend - created exactly once per admitted receipt,
 * naming the receipt digest and the request ordinal. Crash before send
 * redrives the SAME obligation and the SAME ordinal; a refused envelope
 * never has one.
 */
export interface ProviderSendObligation {
  readonly kind: 'obligation:providerSend';
  readonly attemptRef: string;
  readonly requestOrdinal: number;
  readonly receiptDigest: string;
  readonly envelopeDigest: string;
  readonly idempotencyKey: string;
  readonly state: 'open';
}

/* ------------------------------------------------------------------ */
/* Store contract + the in-memory sole-writer implementation          */
/* ------------------------------------------------------------------ */

/** A committed admission decision (the idempotency record). */
export interface AdmissionRecord {
  readonly idempotencyKey: string;
  readonly attemptRef: string;
  readonly outcomeKind: 'admitted' | 'refused';
  readonly receipt: PromptAssemblyReceipt;
  readonly obligation?: ProviderSendObligation;
}

/** One atomic admission commit (admission advances the counters; refusal appends evidence only). */
export type AdmissionCommit =
  | {
    readonly kind: 'admitted';
    readonly receipt: PromptAssemblyReceipt;
    readonly obligation: ProviderSendObligation;
    readonly nextCounters: ActivityAttemptContextCounters;
  }
  | {
    readonly kind: 'refused';
    readonly receipt: PromptAssemblyReceipt;
    readonly idempotencyKey: string;
    readonly nextCounters: ActivityAttemptContextCounters;
  };

/**
 * The durable admission surface. commitAdmission is the compare-and-set:
 * it applies the commit iff the stored contextRevision still equals
 * expectedContextRevision, atomically (single writer per attempt). This is
 * what makes two concurrent admissions at one revision produce exactly one
 * success.
 */
export interface AttemptAdmissionStore {
  loadCounters(attemptRef: string): Promise<ActivityAttemptContextCounters>;
  commitAdmission(
    attemptRef: string,
    expectedContextRevision: number,
    commit: AdmissionCommit,
  ): Promise<{ readonly committed: true } | { readonly committed: false; readonly currentContextRevision: number }>;
  findAdmissionByIdempotencyKey(idempotencyKey: string): Promise<AdmissionRecord | undefined>;
}

/** The in-memory sole-writer store (test/reference; WP-08 binds a durable one). */
export class InMemoryAttemptAdmissionStore implements AttemptAdmissionStore {
  private readonly countersByAttempt = new Map<string, ActivityAttemptContextCounters>();
  private readonly receiptsByAttempt = new Map<string, PromptAssemblyReceipt[]>();
  private readonly recordsByKey = new Map<string, AdmissionRecord>();

  constructor(initial: readonly ActivityAttemptContextCounters[]) {
    for (const counters of initial) {
      this.countersByAttempt.set(counters.attemptRef, counters);
      this.receiptsByAttempt.set(counters.attemptRef, []);
    }
  }

  async loadCounters(attemptRef: string): Promise<ActivityAttemptContextCounters> {
    const counters = this.countersByAttempt.get(attemptRef);
    if (!counters) throw new Error(`unknown ActivityAttempt ${attemptRef} (the attempt must exist before admission)`);
    return counters;
  }

  /**
   * The compare-and-set critical section: read-check-write in ONE
   * synchronous block (no await between read and write - an awaited read
   * opens exactly the double-commit race the CAS exists to close). A
   * durable store implements the same atomicity with a transaction.
   */
  async commitAdmission(
    attemptRef: string,
    expectedContextRevision: number,
    commit: AdmissionCommit,
  ): Promise<{ readonly committed: true } | { readonly committed: false; readonly currentContextRevision: number }> {
    const current = this.countersByAttempt.get(attemptRef);
    if (!current) throw new Error(`unknown ActivityAttempt ${attemptRef} (the attempt must exist before admission)`);
    if (current.contextRevision !== expectedContextRevision) {
      return { committed: false, currentContextRevision: current.contextRevision };
    }
    this.countersByAttempt.set(attemptRef, commit.nextCounters);
    const log = this.receiptsByAttempt.get(attemptRef) ?? [];
    log.push(commit.receipt);
    this.receiptsByAttempt.set(attemptRef, log);
    const idempotencyKey = commit.kind === 'admitted' ? commit.obligation.idempotencyKey : commit.idempotencyKey;
    this.recordsByKey.set(idempotencyKey, {
      idempotencyKey,
      attemptRef,
      outcomeKind: commit.kind,
      receipt: commit.receipt,
      obligation: commit.kind === 'admitted' ? commit.obligation : undefined,
    });
    return { committed: true };
  }

  async findAdmissionByIdempotencyKey(idempotencyKey: string): Promise<AdmissionRecord | undefined> {
    for (const record of this.recordsByKey.values()) {
      if (record.idempotencyKey === idempotencyKey) return record;
    }
    return undefined;
  }

  /** Test/inspection surface: the append-only receipt evidence log. */
  receiptsOf(attemptRef: string): readonly PromptAssemblyReceipt[] {
    return this.receiptsByAttempt.get(attemptRef) ?? [];
  }

  countersOf(attemptRef: string): ActivityAttemptContextCounters | undefined {
    return this.countersByAttempt.get(attemptRef);
  }
}

/* ------------------------------------------------------------------ */
/* The admission command                                               */
/* ------------------------------------------------------------------ */

/** The pins admission runs against (installed profile + limit table). */
export interface AdmissionPins {
  readonly profile: PromptBudgetProfile;
  readonly limitTable: ProviderModelLimitTableArtifact;
}

/** One admission command application. */
export interface AdmissionCommandInput {
  readonly attemptRef: string;
  readonly expectedContextRevision: number;
  readonly envelope: ContextEnvelope;
  readonly idempotencyKey: string;
}

export type AdmissionOutcome =
  | {
    readonly kind: 'admitted';
    readonly receipt: PromptAssemblyReceipt;
    readonly obligation: ProviderSendObligation;
    readonly nextCounters: ActivityAttemptContextCounters;
  }
  | {
    readonly kind: 'refused';
    readonly receipt: PromptAssemblyReceipt;
    readonly violation: ContextViolation;
    readonly violationDetail: string;
    readonly nextCounters: ActivityAttemptContextCounters;
  }
  | {
    readonly kind: 'stale-revision';
    readonly reason: 'STALE_EXPECTED_REVISION';
    readonly expectedContextRevision: number;
    readonly currentContextRevision?: number;
    readonly detail: string;
  }
  | {
    readonly kind: 'replayed';
    readonly receipt: PromptAssemblyReceipt;
    readonly obligation?: ProviderSendObligation;
  };

/**
 * activityAttempt.admitProviderRequest(expectedContextRevision, envelope):
 * the sole admission linearization point. Every cognition transport must
 * call exactly this, after all assembly and before serialization/network
 * send. Idempotent per idempotencyKey (a crash before the commit re-runs
 * from scratch; a re-submission of a committed key replays the recorded
 * outcome without double charging).
 */
export async function admitProviderRequest(
  pins: AdmissionPins,
  store: AttemptAdmissionStore,
  input: AdmissionCommandInput,
): Promise<AdmissionOutcome> {
  // Idempotent replay of an already-committed key returns the recorded outcome.
  const recorded = await store.findAdmissionByIdempotencyKey(input.idempotencyKey);
  if (recorded) {
    return { kind: 'replayed', receipt: recorded.receipt, obligation: recorded.obligation };
  }

  // CAS precheck: a stale assembler snapshot fails the command, consuming nothing.
  const counters = await store.loadCounters(input.attemptRef);
  if (counters.contextRevision !== input.expectedContextRevision) {
    return {
      kind: 'stale-revision',
      reason: 'STALE_EXPECTED_REVISION',
      expectedContextRevision: input.expectedContextRevision,
      currentContextRevision: counters.contextRevision,
      detail: `expected contextRevision ${input.expectedContextRevision} != current ${counters.contextRevision} (stale assembler snapshot); nothing consumed`,
    };
  }

  // The ONE cumulative accountant (pinned counter, every limit, every layer).
  const verdict = accountEnvelope(pins.profile, pins.limitTable, counters, input.envelope);

  const envelopeDigest = rejectedEnvelopeDigestOf(input.envelope);

  if (verdict.ok) {
    const nextCounters: ActivityAttemptContextCounters = {
      ...counters,
      contextRevision: counters.contextRevision + 1,
      nextRequestOrdinal: counters.nextRequestOrdinal + 1,
      cumulativeInputTokens: counters.cumulativeInputTokens + verdict.requestInputTokens,
    };
    const receipt = sealReceipt({
      decision: 'admitted',
      attemptRef: counters.attemptRef,
      requestOrdinal: counters.nextRequestOrdinal,
      contextRevision: counters.contextRevision,
      profileRef: counters.promptBudgetProfileRef,
      profileDigest: counters.promptBudgetProfileDigest,
      counterIdentity: pins.profile.tokenCounterRef,
      limitTableRef: pins.profile.providerModelLimitTableRef.ref,
      limitTableDigest: pins.profile.providerModelLimitTableRef.digest,
      providerRoutePin: counters.providerRoutePin,
      layerNames: verdict.layerNames,
      layerDigests: verdict.layerDigests,
      layerTokenCounts: verdict.layerTokenCounts,
      requestInputTokens: verdict.requestInputTokens,
      serializedRequestBytes: verdict.serializedRequestBytes,
      cumulativeInputTokensAfter: nextCounters.cumulativeInputTokens,
      limitChecks: verdict.limitChecks,
      omissions: verdict.omittedOptionalLayers,
      externalReferences: verdict.externalReferences,
    });
    const obligation: ProviderSendObligation = {
      kind: 'obligation:providerSend',
      attemptRef: counters.attemptRef,
      requestOrdinal: receipt.requestOrdinal,
      receiptDigest: receipt.digest,
      envelopeDigest,
      idempotencyKey: input.idempotencyKey,
      state: 'open',
    };
    const commitResult = await store.commitAdmission(input.attemptRef, input.expectedContextRevision, {
      kind: 'admitted',
      receipt,
      obligation,
      nextCounters,
    });
    if (!commitResult.committed) {
      return {
        kind: 'stale-revision',
        reason: 'STALE_EXPECTED_REVISION',
        expectedContextRevision: input.expectedContextRevision,
        currentContextRevision: commitResult.currentContextRevision,
        detail: 'CAS lost at commit: exactly one concurrent admission at one revision succeeds',
      };
    }
    return { kind: 'admitted', receipt, obligation, nextCounters };
  }

  // Refusal: append the refused receipt; counters do not advance; no
  // obligation; no retry budget; the transport never serializes or sends.
  const refusedReceipt = sealReceipt({
    decision: 'refused',
    attemptRef: counters.attemptRef,
    // The ordinal the rejected envelope targeted; NOT assigned (counters unchanged).
    requestOrdinal: counters.nextRequestOrdinal,
    contextRevision: counters.contextRevision,
    profileRef: counters.promptBudgetProfileRef,
    profileDigest: counters.promptBudgetProfileDigest,
    counterIdentity: pins.profile.tokenCounterRef,
    limitTableRef: pins.profile.providerModelLimitTableRef.ref,
    limitTableDigest: pins.profile.providerModelLimitTableRef.digest,
    providerRoutePin: counters.providerRoutePin,
    layerNames: verdict.layerNames,
    layerDigests: verdict.layerDigests,
    layerTokenCounts: verdict.layerTokenCounts,
    requestInputTokens: verdict.requestInputTokens,
    serializedRequestBytes: verdict.serializedRequestBytes,
    cumulativeInputTokensAfter: counters.cumulativeInputTokens,
    limitChecks: verdict.limitChecks,
    omissions: [],
    externalReferences: verdict.externalReferences,
    violation: verdict.violation,
    violationDetail: verdict.violationDetail,
    rejectedEnvelopeDigest: envelopeDigest,
  });
  const commitResult = await store.commitAdmission(input.attemptRef, input.expectedContextRevision, {
    kind: 'refused',
    receipt: refusedReceipt,
    idempotencyKey: input.idempotencyKey,
    nextCounters: counters,
  });
  if (!commitResult.committed) {
    return {
      kind: 'stale-revision',
      reason: 'STALE_EXPECTED_REVISION',
      expectedContextRevision: input.expectedContextRevision,
      currentContextRevision: commitResult.currentContextRevision,
      detail: 'CAS lost at commit (refusal raced a concurrent admission); nothing consumed',
    };
  }
  return {
    kind: 'refused',
    receipt: refusedReceipt,
    violation: verdict.violation as ContextViolation,
    violationDetail: verdict.violationDetail as string,
    nextCounters: counters,
  };
}

