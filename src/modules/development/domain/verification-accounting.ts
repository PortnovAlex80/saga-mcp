/**
 * CC-GAP-8 — verification reachability/accounting (criterion-key ledger).
 *
 * Elite-6 defect (CC-00C F5/I3): the planner proposed 22 `verificationItems`,
 * but the process flow materializes the verification cell only after
 * readiness; readiness failed first (`LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`),
 * so none ran — and none surfaced as pending. Deferred verification
 * obligations vanished from accounting.
 *
 * This module is the PURE accounting core of the fix: an append-only,
 * criterion-key ledger projected into a deterministic stage/ordered view.
 * Every required verification obligation stays a first-class entry —
 * proposed -> pending -> executed (or waived) — and an entry is discharged
 * ONLY by an exact passed receipt bound to the exact candidate, or by an
 * operator-attributed waiver with provenance. Executed-FAILED is a recorded
 * fact, never a discharge. Graphs materialized before the ledger existed are
 * typed `legacy-unaccounted` — their frozen evidence is never rewritten.
 *
 * Module-local by design: this is Development-owned accounting. It does NOT
 * reuse or extend `factory_transition_obligations` (the conveyor transition
 * ledger), does not touch routing (CC-GAP-9), warrant execution (CC-GAP-7)
 * or role chips (CC-GAP-10).
 */

import type { AcceptanceCriticality } from './development-schemas.js';

export const VERIFICATION_ACCOUNTING_SCHEMA =
  'factory.development-verification-accounting.v1';

/** Append-only ledger event states (lifecycle: proposed -> pending -> executed | waived). */
export type VerificationLedgerEventState =
  | 'proposed'
  | 'pending'
  | 'executed'
  | 'waived';

/** Rendered entry states. `legacy-unaccounted` types pre-ledger graphs. */
export type VerificationAccountingEntryState =
  | VerificationLedgerEventState
  | 'legacy-unaccounted';

/** The Development flow stage that owns execution of every obligation. */
export const VERIFICATION_EXECUTION_STAGE = 'verify-acceptance' as const;

/**
 * The flow stage that defers execution: the verification cell fans out only
 * after `bind-runnable-candidate` binds the exact frozen candidate, so a
 * readiness failure (or any pre-bind termination) leaves every obligation
 * pending at this gate. This is the CC-GAP-8 deferral seam — pending entries
 * survive it and must execute after recovery.
 */
export const VERIFICATION_DEFERRAL_GATE = 'certify-product-readiness' as const;

/** The production cell that owns execution of the obligation. */
export const VERIFICATION_OBLIGATION_OWNER = 'development-verification' as const;

/**
 * Human-readable unblock condition stamped on pending entries (plan CC-00C:
 * pending entries carry "owner and unblock condition").
 */
export const VERIFICATION_UNBLOCK_CONDITION =
  'readiness-recovery: bind-runnable-candidate must bind the exact frozen '
  + 'candidate before verify-acceptance executes';

/** Exact-receipt discharge provenance (the ONLY receipt-based discharge). */
export interface VerificationReceiptDischarge {
  readonly kind: 'passed-receipt';
  readonly receiptRef: string;
  readonly receiptDigest: string;
  readonly candidateHash: string;
}

/** Operator-attributed waiver discharge provenance (the ONLY waiver discharge). */
export interface VerificationWaiverDischarge {
  readonly kind: 'operator-waiver';
  readonly operator: string;
  readonly reason: string;
  readonly provenanceRef: string;
}

export type VerificationDischarge =
  | VerificationReceiptDischarge
  | VerificationWaiverDischarge;

/** One append-only ledger event row (immutable fact). */
export interface VerificationLedgerEvent {
  /** Ledger row id — the authoritative append order. */
  readonly sequence: number;
  readonly processRunId: number;
  readonly graphHash: string;
  readonly criterionKey: string;
  readonly verificationItemKey: string;
  readonly required: boolean;
  readonly criticality: AcceptanceCriticality | null;
  readonly entryState: VerificationLedgerEventState;
  /** Executed events only: the trusted-receipt outcome. */
  readonly outcome: 'passed' | 'failed' | null;
  /** Executed events only: the exact candidate the receipt executed against. */
  readonly candidateHash: string | null;
  readonly receiptRef: string | null;
  readonly receiptDigest: string | null;
  /** Waived events only: operator attribution. */
  readonly waiverOperator: string | null;
  readonly waiverReason: string | null;
  readonly waiverProvenanceRef: string | null;
  /** Proposed events only: the planner submission the obligation came from. */
  readonly proposedFromRef: string | null;
  readonly recordedAt: string;
}

/** Stage/order projection facts for one obligation entry. */
export interface VerificationAccountingStage {
  /** Where the obligation executes (flow node id). */
  readonly executionStage: typeof VERIFICATION_EXECUTION_STAGE;
  /** The deferral gate while the entry is not yet executed/waived, else null. */
  readonly gatedBy: typeof VERIFICATION_DEFERRAL_GATE | null;
}

export interface VerificationAccountingEntry {
  /** ATOMIC criterion identity `${artifactId}:${code}` — the ledger key. */
  readonly criterionKey: string;
  readonly verificationItemKey: string;
  readonly required: boolean;
  readonly criticality: AcceptanceCriticality | null;
  readonly state: VerificationAccountingEntryState;
  /** Executed entries: the receipt outcome. Others: null. */
  readonly outcome: 'passed' | 'failed' | null;
  /** Deterministic projection order (entries are sorted by criterionKey). */
  readonly ordinal: number;
  readonly stage: VerificationAccountingStage;
  readonly owner: typeof VERIFICATION_OBLIGATION_OWNER;
  readonly unblockCondition: string | null;
  /**
   * Discharged ONLY by an exact passed receipt or an operator-attributed
   * waiver. Pending, proposed, legacy-unaccounted and executed-FAILED entries
   * are NEVER discharged.
   */
  readonly discharged: boolean;
  readonly discharge: VerificationDischarge | null;
  readonly lastEventAt: string | null;
}

export interface VerificationAccountingSummary {
  readonly proposed: number;
  readonly pending: number;
  readonly executedPassed: number;
  readonly executedFailed: number;
  readonly waived: number;
  readonly legacyUnaccounted: number;
  readonly open: number;
  readonly discharged: number;
  readonly total: number;
}

export interface VerificationAccountingProjection {
  readonly schemaVersion: typeof VERIFICATION_ACCOUNTING_SCHEMA;
  readonly processRunId: number;
  readonly graphHash: string | null;
  /**
   * `criterion-key-ledger` — opened at graph materialization;
   * `legacy-unaccounted` — pre-ledger graph, never back-filled.
   */
  readonly accountingType: 'criterion-key-ledger' | 'legacy-unaccounted';
  readonly orderedBy: 'criterion-key';
  readonly entries: readonly VerificationAccountingEntry[];
  readonly summary: VerificationAccountingSummary;
}

/** Minimal verification-item shape the legacy projector needs. */
export interface LegacyVerificationItemShape {
  readonly key: string;
  readonly required: boolean;
  readonly criticality: AcceptanceCriticality | null;
  readonly acceptanceCriterionKeys: readonly string[];
}

/**
 * Project the append-only event log into the current stage/ordered
 * accounting view. Current entry state per criterion key = the LATEST event
 * by append sequence; entry metadata (item key, required, criticality) comes
 * from the opening proposed/pending fact. Events must belong to one run.
 */
export function projectCriterionLedgerAccounting(input: {
  processRunId: number;
  graphHash: string | null;
  events: readonly VerificationLedgerEvent[];
}): VerificationAccountingProjection {
  const runs = new Set(input.events.map(event => event.processRunId));
  if (runs.size > 1) {
    throw new Error('DEVELOPMENT_VERIFICATION_LEDGER_RUN_MIXUP');
  }
  const byCriterion = new Map<string, VerificationLedgerEvent[]>();
  for (const event of input.events) {
    const list = byCriterion.get(event.criterionKey) ?? [];
    list.push(event);
    byCriterion.set(event.criterionKey, list);
  }
  const criterionKeys = [...byCriterion.keys()]
    .sort((left, right) => left.localeCompare(right));
  const entries = criterionKeys.map((criterionKey, ordinal) => {
    const events = byCriterion.get(criterionKey)!
      .slice()
      .sort((left, right) => left.sequence - right.sequence);
    const opened = events.find(event =>
      event.entryState === 'proposed' || event.entryState === 'pending') ?? events[0]!;
    const latest = events[events.length - 1]!;
    const state: VerificationAccountingEntryState = latest.entryState;
    const notYetExecuted = state === 'proposed' || state === 'pending';
    let discharge: VerificationDischarge | null = null;
    if (state === 'executed' && latest.outcome === 'passed') {
      discharge = {
        kind: 'passed-receipt',
        receiptRef: latest.receiptRef ?? '',
        receiptDigest: latest.receiptDigest ?? '',
        candidateHash: latest.candidateHash ?? '',
      };
    } else if (state === 'waived') {
      discharge = {
        kind: 'operator-waiver',
        operator: latest.waiverOperator ?? '',
        reason: latest.waiverReason ?? '',
        provenanceRef: latest.waiverProvenanceRef ?? '',
      };
    }
    const entry: VerificationAccountingEntry = {
      criterionKey,
      verificationItemKey: opened.verificationItemKey,
      required: opened.required,
      criticality: opened.criticality,
      state,
      outcome: state === 'executed' ? latest.outcome : null,
      ordinal,
      stage: {
        executionStage: VERIFICATION_EXECUTION_STAGE,
        gatedBy: notYetExecuted ? VERIFICATION_DEFERRAL_GATE : null,
      },
      owner: VERIFICATION_OBLIGATION_OWNER,
      unblockCondition: notYetExecuted ? VERIFICATION_UNBLOCK_CONDITION : null,
      discharged: discharge !== null,
      discharge,
      lastEventAt: latest.recordedAt,
    };
    return entry;
  });
  return {
    schemaVersion: VERIFICATION_ACCOUNTING_SCHEMA,
    processRunId: input.processRunId,
    graphHash: input.graphHash,
    accountingType: 'criterion-key-ledger',
    orderedBy: 'criterion-key',
    entries,
    summary: summarize(entries),
  };
}

/**
 * Type a pre-ledger (legacy) materialized graph: every proposed verification
 * obligation is rendered `legacy-unaccounted` — visible, never discharged,
 * and the frozen historical evidence is NOT rewritten or re-inferred.
 */
export function projectLegacyUnaccountedVerification(input: {
  processRunId: number;
  graphHash: string | null;
  verificationItems: readonly LegacyVerificationItemShape[];
}): VerificationAccountingProjection {
  const unique = new Map<string, LegacyVerificationItemShape>();
  for (const item of input.verificationItems) {
    for (const criterionKey of item.acceptanceCriterionKeys) {
      if (!unique.has(criterionKey)) unique.set(criterionKey, item);
    }
  }
  const criterionKeys = [...unique.keys()]
    .sort((left, right) => left.localeCompare(right));
  const entries: VerificationAccountingEntry[] = criterionKeys.map(
    (criterionKey, ordinal) => {
      const item = unique.get(criterionKey)!;
      return {
        criterionKey,
        verificationItemKey: item.key,
        required: item.required,
        criticality: item.criticality,
        state: 'legacy-unaccounted',
        outcome: null,
        ordinal,
        stage: {
          executionStage: VERIFICATION_EXECUTION_STAGE,
          gatedBy: VERIFICATION_DEFERRAL_GATE,
        },
        owner: VERIFICATION_OBLIGATION_OWNER,
        unblockCondition: null,
        discharged: false,
        discharge: null,
        lastEventAt: null,
      };
    },
  );
  return {
    schemaVersion: VERIFICATION_ACCOUNTING_SCHEMA,
    processRunId: input.processRunId,
    graphHash: input.graphHash,
    accountingType: 'legacy-unaccounted',
    orderedBy: 'criterion-key',
    entries,
    summary: summarize(entries),
  };
}

/**
 * Mechanical integrity check over ONE projection. Fails closed on any
 * silent-discharge shape: discharged without provenance, pending/executed-
 * failed/legacy rendered discharged, or a discharge whose kind contradicts
 * the entry state. Also fails closed on HIDDEN stage/order coordinates
 * (CC-00C blocking mutation e): every entry must display its execution
 * stage, its deferral gate while unexecuted, its deterministic ordinal, and
 * — for ledger-accounted unexecuted entries — its unblock condition.
 */
export function assertVerificationAccountingIntegrity(
  projection: VerificationAccountingProjection,
): void {
  projection.entries.forEach((entry, index) => {
    if (entry.discharged && entry.discharge === null) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_DISCHARGE_WITHOUT_PROVENANCE: ${entry.criterionKey}`,
      );
    }
    if (!entry.discharged && entry.discharge !== null) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_PROVENANCE_WITHOUT_DISCHARGE: ${entry.criterionKey}`,
      );
    }
    if (
      (entry.state === 'proposed'
        || entry.state === 'pending'
        || entry.state === 'legacy-unaccounted'
        || (entry.state === 'executed' && entry.outcome === 'failed'))
      && entry.discharged
    ) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_SILENT_DISCHARGE: ${entry.criterionKey} (${entry.state})`,
      );
    }
    if (entry.state === 'executed' && entry.outcome === 'passed') {
      if (
        entry.discharge?.kind !== 'passed-receipt'
        || !entry.discharge.receiptRef.trim()
        || !entry.discharge.receiptDigest.trim()
        || !entry.discharge.candidateHash.trim()
      ) {
        throw new Error(
          `DEVELOPMENT_VERIFICATION_ACCOUNTING_RECEIPT_DISCHARGE_INVALID: ${entry.criterionKey}`,
        );
      }
    }
    if (entry.state === 'executed' && entry.outcome === null) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_EXECUTED_WITHOUT_OUTCOME: ${entry.criterionKey}`,
      );
    }
    if (entry.state === 'waived') {
      const waiver = entry.discharge;
      if (
        waiver?.kind !== 'operator-waiver'
        || !waiver.operator.trim()
        || !waiver.reason.trim()
        || !waiver.provenanceRef.trim()
      ) {
        throw new Error(
          `DEVELOPMENT_VERIFICATION_ACCOUNTING_WAIVER_PROVENANCE_INVALID: ${entry.criterionKey}`,
        );
      }
    }
    // Stage/order coordinate visibility (CC-00C blocking mutation e):
    // hiding WHERE an obligation executes, WHICH gate defers it, or WHERE it
    // sits in the deterministic accounting order fails accounting.
    if (!entry.stage.executionStage.trim()) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_STAGE_HIDDEN: ${entry.criterionKey}`,
      );
    }
    if (entry.stage.executionStage !== VERIFICATION_EXECUTION_STAGE) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_STAGE_INVALID: ${entry.criterionKey}`,
      );
    }
    if (entry.ordinal !== index) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_ORDINAL_HIDDEN: ${entry.criterionKey}`,
      );
    }
    const unexecuted = entry.state === 'proposed'
      || entry.state === 'pending'
      || entry.state === 'legacy-unaccounted';
    if (unexecuted && entry.stage.gatedBy === null) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_DEFERRAL_GATE_HIDDEN: ${entry.criterionKey} (${entry.state})`,
      );
    }
    if (!unexecuted && entry.stage.gatedBy !== null) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_DEFERRAL_GATE_STALE: ${entry.criterionKey} (${entry.state})`,
      );
    }
    if (
      (entry.state === 'proposed' || entry.state === 'pending')
      && !(entry.unblockCondition ?? '').trim()
    ) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_UNBLOCK_CONDITION_HIDDEN: ${entry.criterionKey}`,
      );
    }
  });
  const summary = summarize(projection.entries);
  const expected = projection.summary;
  for (const key of Object.keys(summary) as Array<keyof VerificationAccountingSummary>) {
    if (summary[key] !== expected[key]) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_SUMMARY_DRIFT: ${key}`,
      );
    }
  }
}

/**
 * A rendered accounting row as a status surface would publish it. The render
 * is UNTRUSTED: truth lives only in the ledger projection.
 */
export interface RenderedVerificationAccountingRow {
  readonly criterionKey: string;
  readonly discharged: boolean;
}

/**
 * CC-GAP-8 blocking-proof seam: compare a RENDERED accounting view against
 * the truthful ledger projection. Rendering any deferred (proposed/pending/
 * legacy-unaccounted) or executed-FAILED obligation as discharged — or
 * publishing a row the ledger never accounted — FAILS accounting. This is
 * the mechanical mutation guard for "render unexecuted deferred
 * verificationItems as discharged".
 */
export function assertRenderedAccountingTruthful(input: {
  rendered: readonly RenderedVerificationAccountingRow[];
  projection: VerificationAccountingProjection;
}): void {
  assertVerificationAccountingIntegrity(input.projection);
  const truth = new Map(input.projection.entries.map(entry =>
    [entry.criterionKey, entry]));
  for (const row of input.rendered) {
    const entry = truth.get(row.criterionKey);
    if (!entry) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_RENDER_UNACCOUNTED: ${row.criterionKey}`,
      );
    }
    if (row.discharged && !entry.discharged) {
      throw new Error(
        'DEVELOPMENT_VERIFICATION_ACCOUNTING_RENDER_DISHONEST: '
        + `${row.criterionKey} is ${entry.state}`
        + (entry.state === 'executed' ? `/${entry.outcome}` : '')
        + ' — no exact passed receipt and no operator waiver can discharge it',
      );
    }
  }
}

function summarize(
  entries: readonly VerificationAccountingEntry[],
): VerificationAccountingSummary {
  let proposed = 0;
  let pending = 0;
  let executedPassed = 0;
  let executedFailed = 0;
  let waived = 0;
  let legacyUnaccounted = 0;
  let discharged = 0;
  for (const entry of entries) {
    switch (entry.state) {
      case 'proposed': proposed += 1; break;
      case 'pending': pending += 1; break;
      case 'executed':
        if (entry.outcome === 'passed') executedPassed += 1;
        else executedFailed += 1;
        break;
      case 'waived': waived += 1; break;
      case 'legacy-unaccounted': legacyUnaccounted += 1; break;
    }
    if (entry.discharged) discharged += 1;
  }
  return {
    proposed,
    pending,
    executedPassed,
    executedFailed,
    waived,
    legacyUnaccounted,
    open: proposed + pending + executedFailed + legacyUnaccounted,
    discharged,
    total: entries.length,
  };
}
