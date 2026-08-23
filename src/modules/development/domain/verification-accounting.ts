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
 * CC-GAP-8 terminal repair (ADR-089 alignment): a settlement that terminates
 * the run WITHOUT executing an obligation may not leave it as a bare
 * `pending` row — that masquerades as "still deferred" forever. The terminal
 * route is recorded as an explicit append-only fact with provenance, in three
 * honestly distinct classes that never conflate environment uncertainty with
 * product failure:
 *
 *   terminal-unknown        — environment/readiness uncertainty: the check
 *                             never produced a product verdict (substrate
 *                             precondition missing, or no receipt at all).
 *                             NOT a product failure.
 *   terminal-blocked        — the run terminated on a non-verified route
 *                             without executing this obligation (any other
 *                             blocked/failed settlement reason, or a
 *                             non-required leftover on a verified run).
 *   terminal-human-required — the run terminated waiting on an explicit
 *                             human decision; `attributedTo` names the exact
 *                             open human gate ids.
 *
 * Terminal facts are NEVER a discharge, never block a later executed fact
 * (latest event wins — the no-poison rule), and never survive as history
 * poisoning: after substrate recovery the same criterion may still execute
 * and discharge in this run, and a continuation always re-opens its own
 * obligations.
 *
 * Module-local by design: this is Development-owned accounting. It does NOT
 * reuse or extend `factory_transition_obligations` (the conveyor transition
 * ledger), does not touch routing (CC-GAP-9), warrant execution (CC-GAP-7)
 * or role chips (CC-GAP-10).
 */

import type { AcceptanceCriticality } from './development-schemas.js';

export const VERIFICATION_ACCOUNTING_SCHEMA =
  'factory.development-verification-accounting.v1';

/**
 * Append-only ledger event states. Lifecycle:
 * proposed -> pending -> executed | waived | terminal-unknown
 *                        | terminal-blocked | terminal-human-required.
 * A terminal fact closes the entry for THIS run without executing it; a
 * later append (executed/waived/terminal) still supersedes it by sequence.
 */
export type VerificationLedgerEventState =
  | 'proposed'
  | 'pending'
  | 'executed'
  | 'waived'
  | 'terminal-unknown'
  | 'terminal-blocked'
  | 'terminal-human-required';

/** Rendered entry states. `legacy-unaccounted` types pre-ledger graphs. */
export type VerificationAccountingEntryState =
  | VerificationLedgerEventState
  | 'legacy-unaccounted';

/** The three honestly distinct terminal route classes (never a discharge). */
export type VerificationTerminalRouteKind =
  | 'unknown'
  | 'blocked'
  | 'human-required';

/** Map a terminal route kind to its append-only event state. */
export function terminalRouteEventState(
  route: VerificationTerminalRouteKind,
): 'terminal-unknown' | 'terminal-blocked' | 'terminal-human-required' {
  switch (route) {
    case 'unknown': return 'terminal-unknown';
    case 'blocked': return 'terminal-blocked';
    case 'human-required': return 'terminal-human-required';
  }
}

/** Map a terminal event state back to its route kind (fail closed). */
export function terminalEventStateRoute(
  state: VerificationAccountingEntryState,
): VerificationTerminalRouteKind | null {
  switch (state) {
    case 'terminal-unknown': return 'unknown';
    case 'terminal-blocked': return 'blocked';
    case 'terminal-human-required': return 'human-required';
    default: return null;
  }
}

/**
 * The ADR-089 substrate-precondition vocabulary, mirrored from
 * `src/infrastructure/verification/substrate-retry.ts` (domain code must not
 * import infrastructure). Exact string stability is frozen by the ADR-089
 * blocking proofs; changing the vocabulary there is a deliberate contract
 * change that must update this mirror in the same commit.
 */
export const SUBSTRATE_PRECONDITION_DIAGNOSTIC_CODES: readonly string[] = [
  'warrant-blocked-environment',
  'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE',
  'LOCAL_RUNNABILITY_DOCKER_NOT_LINUX',
];

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
  /** Terminal events only: which of the three terminal route classes. */
  readonly terminalRoute: VerificationTerminalRouteKind | null;
  /** Terminal events only: the settlement reason codes (non-empty). */
  readonly terminalReasonCodes: readonly string[];
  /** Terminal events only: the settlement certificate provenance ref. */
  readonly terminalProvenanceRef: string | null;
  /** terminal-human-required events only: the open human gate ids. */
  readonly terminalAttributedTo: readonly string[];
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
   * waiver. Pending, proposed, legacy-unaccounted, executed-FAILED and every
   * terminal-* entry are NEVER discharged.
   */
  readonly discharged: boolean;
  readonly discharge: VerificationDischarge | null;
  /** Terminal entries only: which of the three terminal route classes. */
  readonly terminalRoute: VerificationTerminalRouteKind | null;
  /** Terminal entries only: the settlement reason codes (non-empty). */
  readonly terminalReasonCodes: readonly string[];
  /** Terminal entries only: the settlement certificate provenance ref. */
  readonly terminalProvenanceRef: string | null;
  /** terminal-human-required entries only: the open human gate ids. */
  readonly terminalAttributedTo: readonly string[];
  readonly lastEventAt: string | null;
}

export interface VerificationAccountingSummary {
  readonly proposed: number;
  readonly pending: number;
  readonly executedPassed: number;
  readonly executedFailed: number;
  readonly waived: number;
  readonly legacyUnaccounted: number;
  readonly terminalUnknown: number;
  readonly terminalBlocked: number;
  readonly terminalHumanRequired: number;
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
  /**
   * True when the ledger holds at least one terminal-route event for this
   * run — i.e. a settlement already recorded a terminal route. Once true,
   * the terminal invariant forbids any entry still sitting in
   * proposed/pending: no unexplained pending row may masquerade as
   * executed-or-deferred on a terminal route.
   */
  readonly terminalRouteRecorded: boolean;
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
  const terminalRouteRecorded = input.events.some(event =>
    terminalEventStateRoute(event.entryState) !== null);
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
    const terminalRoute = terminalEventStateRoute(state);
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
        // A terminal entry is no longer deferred: the deferral gate is CLOSED
        // by the terminal route (this run will not execute it; recovery is a
        // continuation or a later append, never the old unblock condition).
        gatedBy: notYetExecuted ? VERIFICATION_DEFERRAL_GATE : null,
      },
      owner: VERIFICATION_OBLIGATION_OWNER,
      unblockCondition: notYetExecuted ? VERIFICATION_UNBLOCK_CONDITION : null,
      discharged: discharge !== null,
      discharge,
      terminalRoute,
      terminalReasonCodes: terminalRoute !== null
        ? [...latest.terminalReasonCodes]
        : [],
      terminalProvenanceRef: terminalRoute !== null
        ? latest.terminalProvenanceRef
        : null,
      terminalAttributedTo: terminalRoute === 'human-required'
        ? [...latest.terminalAttributedTo]
        : [],
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
    terminalRouteRecorded,
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
        terminalRoute: null,
        terminalReasonCodes: [],
        terminalProvenanceRef: null,
        terminalAttributedTo: [],
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
    terminalRouteRecorded: false,
    entries,
    summary: summarize(entries),
  };
}

/**
 * Mechanical integrity check over ONE projection. Fails closed on any
 * silent-discharge shape: discharged without provenance, pending/executed-
 * failed/legacy/terminal rendered discharged, or a discharge whose kind
 * contradicts the entry state. Also fails closed on HIDDEN stage/order
 * coordinates (CC-00C blocking mutation e): every entry must display its
 * execution stage, its deferral gate while unexecuted, its deterministic
 * ordinal, and — for ledger-accounted unexecuted entries — its unblock
 * condition.
 *
 * CC-GAP-8 terminal rules: a terminal fact must carry its provenance (reason
 * codes + settlement certificate ref), a human-required fact must name its
 * attributed human gates, a terminal entry may not keep a deferral gate or a
 * stale unblock condition, and — the TERMINAL INVARIANT — once any
 * terminal-route fact exists for the run, no entry may remain
 * proposed/pending: an unexplained pending row must never masquerade as
 * executed (or as forever-deferred) on a terminal route.
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
    const terminalRoute = terminalEventStateRoute(entry.state);
    if (
      (entry.state === 'proposed'
        || entry.state === 'pending'
        || entry.state === 'legacy-unaccounted'
        || (entry.state === 'executed' && entry.outcome === 'failed')
        || terminalRoute !== null)
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
    // Terminal provenance (CC-GAP-8 terminal repair): a terminal fact names
    // its route, its reason codes and its settlement certificate ref.
    if (terminalRoute !== null) {
      if (entry.terminalRoute !== terminalRoute) {
        throw new Error(
          `DEVELOPMENT_VERIFICATION_ACCOUNTING_TERMINAL_ROUTE_INVALID: ${entry.criterionKey} (${entry.state} vs ${entry.terminalRoute})`,
        );
      }
      if (
        entry.terminalReasonCodes.length === 0
        || entry.terminalReasonCodes.some(code => !code.trim())
        || !(entry.terminalProvenanceRef ?? '').trim()
      ) {
        throw new Error(
          `DEVELOPMENT_VERIFICATION_ACCOUNTING_TERMINAL_PROVENANCE_INVALID: ${entry.criterionKey}`,
        );
      }
      if (
        terminalRoute === 'human-required'
        && (entry.terminalAttributedTo.length === 0
          || entry.terminalAttributedTo.some(gate => !gate.trim()))
      ) {
        throw new Error(
          `DEVELOPMENT_VERIFICATION_ACCOUNTING_HUMAN_ATTRIBUTION_MISSING: ${entry.criterionKey}`,
        );
      }
    } else if (
      entry.terminalRoute !== null
      || entry.terminalReasonCodes.length > 0
      || entry.terminalProvenanceRef !== null
      || entry.terminalAttributedTo.length > 0
    ) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_TERMINAL_COORDINATES_ON_NONTERMINAL: ${entry.criterionKey} (${entry.state})`,
      );
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
    // A terminal entry keeps neither the deferral gate (checked above via
    // !unexecuted) nor the readiness-recovery unblock condition: the run is
    // closed; recovery happens through a continuation or a later append.
    if (terminalRoute !== null && (entry.unblockCondition ?? '') !== '') {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_TERMINAL_UNBLOCK_STALE: ${entry.criterionKey} (${entry.state})`,
      );
    }
  });
  // TERMINAL INVARIANT (CC-GAP-8): once a terminal-route fact exists for the
  // run, every entry must be executed | waived | terminal-* | legacy — never
  // an unexplained pending row that could masquerade as executed.
  if (projection.terminalRouteRecorded) {
    for (const entry of projection.entries) {
      if (entry.state === 'proposed' || entry.state === 'pending') {
        throw new Error(
          `DEVELOPMENT_VERIFICATION_ACCOUNTING_UNEXPLAINED_PENDING_AT_TERMINAL: ${entry.criterionKey} (${entry.state}) — the run recorded a terminal route, every obligation needs an explicit terminal fact/disposition`,
        );
      }
    }
  }
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
 * Classify WHY a terminal (non-executing) settlement route closed the run
 * for still-unexecuted verification obligations. Pure; fails closed on
 * inputs that would conflate environment uncertainty with product failure:
 *
 *  - an open human gate routes to `human-required` with the gate ids as the
 *    explicit attribution;
 *  - a substrate-precondition diagnostic (ADR-089 frozen vocabulary) or an
 *    absent readiness receipt (no product verdict was ever produced) routes
 *    to `unknown` — environment uncertainty, NEVER a product failure;
 *  - everything else non-verified routes to `blocked` (the run closed
 *    without executing the obligation, for a product-adjacent or
 *    infrastructure reason already named by the settlement reason codes);
 *  - a `verified` settlement that left a non-required obligation unexecuted
 *    routes to `blocked` with the explicit `verification-item-not-required`
 *    reason (it was never required for settlement — still never discharged).
 */
export function classifyVerificationTerminalRoute(input: {
  decision: string;
  reasonCodes: readonly string[];
  openHumanGateIds: readonly string[];
  readinessOutcome: 'passed' | 'failed' | null;
  readinessDiagnosticCodes: readonly string[];
}): {
  route: VerificationTerminalRouteKind;
  reasonCodes: readonly string[];
  attributedTo: readonly string[];
} {
  const reasonCodes = [...new Set(input.reasonCodes.map(code => code.trim()))]
    .filter(code => code.length > 0);
  const openHumanGateIds = [...new Set(input.openHumanGateIds.map(g => g.trim()))]
    .filter(g => g.length > 0);
  if (openHumanGateIds.length > 0) {
    return {
      route: 'human-required',
      reasonCodes: ['human-decision-required', ...reasonCodes],
      attributedTo: openHumanGateIds,
    };
  }
  if (input.decision === 'verified') {
    return {
      route: 'blocked',
      reasonCodes: ['verification-item-not-required'],
      attributedTo: [],
    };
  }
  const substrateUncertain = input.readinessDiagnosticCodes.some(code =>
    SUBSTRATE_PRECONDITION_DIAGNOSTIC_CODES.includes(code))
    || (input.readinessOutcome === null
      && reasonCodes.includes('local-readiness-missing'));
  if (substrateUncertain) {
    return {
      route: 'unknown',
      reasonCodes: ['environment-uncertainty-not-product-failure', ...reasonCodes],
      attributedTo: [],
    };
  }
  return {
    route: 'blocked',
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ['development-terminal'],
    attributedTo: [],
  };
}

/**
 * A rendered accounting row as a status surface would publish it. The render
 * is UNTRUSTED: truth lives only in the ledger projection. `renderedState`
 * is optional; when a surface publishes it, it must equal the truthful entry
 * state — fabricating `executed` (or any other state) for a terminal-unknown
 * / terminal-blocked / terminal-human-required / pending entry fails.
 */
export interface RenderedVerificationAccountingRow {
  readonly criterionKey: string;
  readonly discharged: boolean;
  readonly renderedState?: string;
}

/**
 * CC-GAP-8 blocking-proof seam: compare a RENDERED accounting view against
 * the truthful ledger projection. Rendering any deferred (proposed/pending/
 * legacy-unaccounted), executed-FAILED or TERMINAL-ROUTE obligation as
 * discharged — publishing a row the ledger never accounted — or fabricating
 * an entry STATE the ledger does not hold (e.g. rendering a terminal-unknown
 * obligation as `executed`) FAILS accounting. This is the mechanical
 * mutation guard for "render unexecuted deferred verificationItems as
 * discharged" and for "never fabricate executed verification".
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
    if (
      row.renderedState !== undefined
      && row.renderedState !== entry.state
    ) {
      throw new Error(
        `DEVELOPMENT_VERIFICATION_ACCOUNTING_RENDER_STATE_DISHONEST: ${row.criterionKey} rendered as '${row.renderedState}' but the ledger holds '${entry.state}' — executed verification is never fabricated`,
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
  let terminalUnknown = 0;
  let terminalBlocked = 0;
  let terminalHumanRequired = 0;
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
      case 'terminal-unknown': terminalUnknown += 1; break;
      case 'terminal-blocked': terminalBlocked += 1; break;
      case 'terminal-human-required': terminalHumanRequired += 1; break;
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
    terminalUnknown,
    terminalBlocked,
    terminalHumanRequired,
    // Open = outstanding obligation: never executed and never waived. This
    // includes executed-FAILED (a recorded product fact, not a discharge),
    // legacy-unaccounted, and every terminal-route entry (a terminal fact
    // closes the row WITHOUT executing it — the obligation remains owed).
    open: proposed + pending + executedFailed + legacyUnaccounted
      + terminalUnknown + terminalBlocked + terminalHumanRequired,
    discharged,
    total: entries.length,
  };
}
