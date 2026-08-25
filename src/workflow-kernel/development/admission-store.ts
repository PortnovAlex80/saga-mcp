/**
 * workflow-kernel/development/admission-store.ts - the DURABLE
 * AttemptAdmissionStore binding (WP-08, plan phase EK-5).
 *
 * WP-18 froze the store contract (context-envelope admission): loadCounters /
 * commitAdmission(CAS on contextRevision) / findAdmissionByIdempotencyKey.
 * This module binds it to the fresh kernel database WITHOUT violating the
 * sole-writer law or the EK-3 ratchets:
 *
 *   - every WRITE goes through the OWNING repository's single transaction
 *     (the ActivityAttempt repository's admission command with its
 *     PromptAssemblyReceipt); the CAS is the command's dual fence
 *     (receipt.expectedContextRevision == stored context_revision AND the
 *     head-revision fence), applied atomically with the counter advance;
 *   - counters are read ONLY through the owning repository's public reader
 *     (loadContextCounters) - never by summing receipt rows;
 *   - ZERO direct SQL of any kind: the WP-06 ratchet (sole-writer SQL
 *     locality) forbids aggregate-owned tables from appearing in SQL outside
 *     their owning repository file - reads included. The replay lookup is
 *     therefore served from the in-process commit memo, and cross-restart
 *     re-submissions of a committed key are caught fail-closed by the CAS
 *     precheck (contextRevision moved => stale-revision outcome, nothing
 *     consumed) and by the kernel command's own idempotency record
 *     (a duplicate key replays the recorded outcome inside the owning
 *     transaction, never a second receipt). EK-8 should move a receipt
 *     reader into the owning repository's public surface and bind it here.
 *
 *   - the WP-18 ordinal convention maps onto the kernel columns exactly:
 *     kernel next_request_ordinal = admitted requests so far, therefore the
 *     WP-18 "next ordinal to assign" is next_request_ordinal + 1.
 *
 * DIVERGENCE NOTE (fail-closed, for the EK-8 coordinator): the frozen WP-06
 * receipt table reserves one row per request ordinal and the owning
 * repository advances context_revision/next_request_ordinal on EVERY
 * committed admission command. A WP-18 'refused' commit (receipt persisted,
 * counters unchanged, ordinal NOT consumed) therefore has NO lawful durable
 * representation in this schema. This store refuses refused-commits with a
 * typed error instead of silently diverging; refused-receipt demonstrations
 * in the WP-08 suites run against the WP-18 in-memory store. EK-8 must
 * either pin this composition (refusals stay pre-commit deterministic
 * rejections, WP-07 style) or extend the frozen schema with an approved
 * complexity delta.
 */

import { canonicalJson } from '../domain/digest.js';
import type { ProviderRoutePin } from '../context-envelope/receipt.js';
import type {
  ActivityAttemptContextCounters,
  AdmissionCommit,
  AdmissionRecord,
  AttemptAdmissionStore,
} from '../context-envelope/admission.js';
import type { KernelPersistenceSession } from '../persistence/session.js';

/** Typed fail-closed error for the refused-commit divergence above. */
export class DurableRefusedReceiptUnsupportedError extends Error {
  readonly code = 'EK_DURABLE_REFUSED_RECEIPT_UNSUPPORTED';
  constructor(attemptRef: string) {
    super(
      `EK_DURABLE_REFUSED_RECEIPT_UNSUPPORTED: refusing to durably commit a refused PromptAssemblyReceipt for ${attemptRef}: `
        + 'the frozen kernel receipt table reserves each ordinal for an admitted request and advances counters on the command '
        + '(WP-06 schema); silently diverging from the WP-18 refusal law is forbidden. Deterministic refusals stay pre-commit.',
    );
    this.name = 'DurableRefusedReceiptUnsupportedError';
  }
}

/** The per-attempt launch pins bound at store construction (from the role runtime). */
export interface AttemptLaunchPins {
  readonly providerRoutePin: ProviderRoutePin;
  readonly promptBudgetProfileRef: string;
  readonly promptBudgetProfileDigest: string;
}

export class DurableAttemptAdmissionStore implements AttemptAdmissionStore {
  private readonly pinsByAttempt = new Map<string, AttemptLaunchPins>();
  /** In-process replay memo: the exact AdmissionRecord of each commit this process made. */
  private readonly recordsByKey = new Map<string, AdmissionRecord>();

  constructor(private readonly session: KernelPersistenceSession) {}

  /** Bind the launch pins of one attempt (before its first admission). */
  bind(attemptRef: string, pins: AttemptLaunchPins): this {
    this.pinsByAttempt.set(attemptRef, pins);
    return this;
  }

  async loadCounters(attemptRef: string): Promise<ActivityAttemptContextCounters> {
    const durable = this.session.activityAttempt.loadContextCounters(attemptRef);
    if (durable === undefined) {
      throw new Error(`unknown ActivityAttempt ${attemptRef} (the attempt must exist before admission)`);
    }
    const pins = this.pinsByAttempt.get(attemptRef);
    if (!pins) {
      throw new Error(`ActivityAttempt ${attemptRef} has no bound launch pins (route pin + prompt budget profile)`);
    }
    return {
      attemptRef,
      contextRevision: durable.contextRevision,
      nextRequestOrdinal: durable.nextRequestOrdinal + 1,
      cumulativeInputTokens: durable.cumulativeInputTokens,
      providerRoutePin: pins.providerRoutePin,
      promptBudgetProfileRef: pins.promptBudgetProfileRef,
      promptBudgetProfileDigest: pins.promptBudgetProfileDigest,
    };
  }

  /**
   * The compare-and-set: applies the OWNING repository's admission command in
   * its single transaction (receipt row + counter advance + obligation
   * completion together). committed=false exactly when the kernel fence
   * refused the expected context revision. A duplicate key (crash-redrive
   * re-submission) replays the kernel's recorded outcome - the durable
   * idempotency record inside the owning transaction.
   */
  async commitAdmission(
    attemptRef: string,
    expectedContextRevision: number,
    commit: AdmissionCommit,
  ): Promise<{ readonly committed: true } | { readonly committed: false; readonly currentContextRevision: number }> {
    if (commit.kind === 'refused') {
      // Fail-closed divergence guard (see the module note).
      throw new DurableRefusedReceiptUnsupportedError(attemptRef);
    }
    const durable = this.session.activityAttempt.loadContextCounters(attemptRef);
    if (durable === undefined) {
      throw new Error(`unknown ActivityAttempt ${attemptRef} (the attempt must exist before admission)`);
    }
    const head = this.session.activityAttempt.loadHead(attemptRef);
    const outcome = this.session.activityAttempt.applyCommand(
      {
        command: 'activityAttempt.admitProviderRequest',
        instanceId: attemptRef,
        expectedRevision: head === undefined ? 0 : head.revision,
        idempotencyKey: commit.obligation.idempotencyKey,
      },
      {
        promptReceipt: {
          receiptRef: commit.receipt.receiptRef,
          admission: 'admitted',
          requestOrdinal: commit.receipt.requestOrdinal,
          expectedContextRevision,
          digest: commit.receipt.digest,
          payloadJson: canonicalJson(commit.receipt),
          cumulativeInputTokens: commit.receipt.requestInputTokens,
        },
      },
    );
    if ('refused' in outcome) {
      const current = this.session.activityAttempt.loadContextCounters(attemptRef);
      return { committed: false, currentContextRevision: current === undefined ? expectedContextRevision : current.contextRevision };
    }
    // committed or replayed: the durable idempotency record exists either way.
    const record: AdmissionRecord = {
      idempotencyKey: commit.obligation.idempotencyKey,
      attemptRef,
      outcomeKind: 'admitted',
      receipt: commit.receipt,
    };
    this.recordsByKey.set(record.idempotencyKey, record);
    return { committed: true };
  }

  /**
   * Replay lookup, ZERO SQL: the exact record of any commit THIS process made
   * (the memo). A durably-committed key from a PRIOR process is intentionally
   * absent here: admitProviderRequest then fails closed at the CAS precheck
   * (the counters moved) with a stale-revision outcome that consumes nothing,
   * and a duplicate command key replays inside the owning transaction -
   * never a second receipt, never a double charge. The proper redrive entry
   * is the transport's redriveProviderSend (same obligation + ordinal).
   */
  async findAdmissionByIdempotencyKey(idempotencyKey: string): Promise<AdmissionRecord | undefined> {
    return this.recordsByKey.get(idempotencyKey);
  }
}
