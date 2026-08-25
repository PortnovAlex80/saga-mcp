/**
 * workflow-kernel/workshops/discovery/admission-store.ts - the DURABLE
 * AttemptAdmissionStore binding of the Discovery workshop (WP-11D).
 *
 * Same discipline as the kernel store contract (WP-18): every write goes
 * through the OWNING repository's admission command in its single
 * transaction (receipt + counters + obligation completion together); the
 * CAS is the command's dual fence; ZERO direct SQL (sole-writer locality).
 * A refused commit is fail-closed (the frozen receipt table reserves each
 * ordinal for an admitted request; deterministic refusals stay pre-commit).
 */

import { canonicalJson } from '../../domain/digest.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';
import type {
  ActivityAttemptContextCounters,
  AdmissionCommit,
  AdmissionRecord,
  AttemptAdmissionStore,
} from '../../context-envelope/admission.js';
import type { ProviderRoutePin } from '../../context-envelope/receipt.js';

/* ------------------------------------------------------------------ */
/* The durable admission-store binding                                 */
/* ------------------------------------------------------------------ */

/** The per-attempt launch pins bound at store construction. */
export interface AttemptLaunchPins {
  readonly providerRoutePin: ProviderRoutePin;
  readonly promptBudgetProfileRef: string;
  readonly promptBudgetProfileDigest: string;
}

/**
 * The WP-18 AttemptAdmissionStore bound to the fresh kernel database.
 * Every write goes through the OWNING repository's admission command in
 * its single transaction (receipt + counters + obligation completion
 * together); the CAS is the command's dual fence; zero direct SQL. A
 * refused commit is fail-closed (the frozen receipt table reserves each
 * ordinal for an admitted request - same divergence note as the WP-08
 * store; deterministic refusals stay pre-commit).
 */
export class DurableWorkshopAdmissionStore implements AttemptAdmissionStore {
  private readonly pinsByAttempt = new Map<string, AttemptLaunchPins>();
  private readonly recordsByKey = new Map<string, AdmissionRecord>();

  constructor(private readonly session: KernelPersistenceSession) {}

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

  async commitAdmission(
    attemptRef: string,
    expectedContextRevision: number,
    commit: AdmissionCommit,
  ): Promise<{ readonly committed: true } | { readonly committed: false; readonly currentContextRevision: number }> {
    if (commit.kind === 'refused') {
      throw new Error(`EK_DURABLE_REFUSED_RECEIPT_UNSUPPORTED: refusing to durably commit a refused receipt for ${attemptRef} (deterministic refusals stay pre-commit)`);
    }
    const durable = this.session.activityAttempt.loadContextCounters(attemptRef);
    if (durable === undefined) {
      throw new Error(`unknown ActivityAttempt ${attemptRef}`);
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
    const record: AdmissionRecord = {
      idempotencyKey: commit.obligation.idempotencyKey,
      attemptRef,
      outcomeKind: 'admitted',
      receipt: commit.receipt,
    };
    this.recordsByKey.set(record.idempotencyKey, record);
    return { committed: true };
  }

  async findAdmissionByIdempotencyKey(idempotencyKey: string): Promise<AdmissionRecord | undefined> {
    return this.recordsByKey.get(idempotencyKey);
  }
}
