/**
 * workflow-kernel/projection/cards.ts - the pure Kanban card model of the
 * projection layer (WP-10, plan phase EK-7).
 *
 * THE LAW THIS MODULE EMBODIES (plan EK-7): Kanban columns - TODO,
 * in-progress, review, repair, waiting, terminal - are HUMAN VIEWS derived
 * from authoritative facts. They are never workflow inputs: no kernel
 * command, guard, obligation, wait or proof reads a lane, and a lane is a
 * pure function of the committed event/evidence ledger (via the
 * repositories' read surfaces), never of the kanban_card table.
 *
 * Every field of a card is a read-only view of an authoritative fact:
 *   - the WorkItem planning head (immutable, created by workItem.planGraph);
 *   - the Workplace aggregate head + its material-chain evidence (ADR-053:
 *     production revisions, candidate sets, gate decisions, effect
 *     receipts, cell final acceptances);
 *   - the shared ledger (open obligations, pending typed waits with their
 *     exact wake sources, terminal proofs with evidence closures);
 *   - the pinned role-contract references of admitted WorkIntents (WP-17
 *     pins - DISPLAY ONLY, the UI never selects them);
 *   - the prompt-receipt references of the attempts bound to those intents
 *     (WP-18 receipts - DISPLAY ONLY for diagnosis);
 *   - readiness over authoritative predecessor evidence (WP-09), never a
 *     projection-derived dependency state.
 *
 * PURITY: this module imports only pure kernel types/data. No SQLite, no
 * session, no store, no I/O anywhere in the derivation.
 */

import type { AggregateHead, EvidenceRef, InstanceId, ObligationRecord, ProofRecord, WaitRecord, WorkIntent } from '../domain/types.js';
import type { ObligationKind, WaitKind } from '../domain/universe.js';
import type { DependencyEdgeRow, ReadinessState } from '../planning/readiness.js';

/* ------------------------------------------------------------------ */
/* The closed lane vocabulary (a human view, not a kernel vocabulary)   */
/* ------------------------------------------------------------------ */

/**
 * The six human lanes. This is a PROJECTION vocabulary: it lives here, in
 * the projection package, and never in the frozen kernel universe. Nothing
 * in src/workflow-kernel outside projection/** may branch on these values.
 */
export const KANBAN_LANES = ['todo', 'in-progress', 'review', 'repair', 'waiting', 'terminal'] as const;
export type KanbanLane = (typeof KANBAN_LANES)[number];

/* ------------------------------------------------------------------ */
/* Status families (aggregated authoritative statuses -> human lanes)   */
/* ------------------------------------------------------------------ */

/**
 * Register-like constant table mapping authoritative Workplace statuses to
 * the repair lane (repair family: repair waits, repair-epoch rollovers,
 * operator scope widening after a repair verdict, retryable effects).
 */
const REPAIR_STATUSES: readonly string[] = [
  'repair-wait-entered',
  'repair-epoch-rolled-over',
  'authority-scope-widened',
  'effect-retryable',
];

/**
 * Register-like constant table mapping authoritative Workplace statuses to
 * the review lane (the desk between an accepted author gate and the final
 * gate verdict: the reviewer owns the card while any reviewer-* status or
 * the open reviewer desk status holds).
 */
const REVIEW_STATUSES: readonly string[] = [
  'author-gate-decided',
  'reviewer-intent-admitted',
  'reviewer-contribution-recorded',
  'reviewer-revision-sealed',
  'reviewer-candidates-presented',
];

/* ------------------------------------------------------------------ */
/* Card shape (every field a read-only view of authoritative facts)     */
/* ------------------------------------------------------------------ */

/** The pinned role contract of one admitted WorkIntent (DISPLAY ONLY). */
export interface PinnedRoleContractView {
  readonly protocolRole: 'author' | 'reviewer';
  readonly roleContractRef: string;
  readonly roleContractDigest: string;
  /** The WorkIntent evidence ref that pinned this contract. */
  readonly pinnedByIntentRef: string;
}

/** One prompt-receipt reference of an attempt (DISPLAY ONLY, diagnosis). */
export interface PromptReceiptRefView {
  readonly receiptRef: string;
  readonly attemptInstanceId: InstanceId;
  readonly requestOrdinal: number;
}

/** One pending wait shown on a card, with its EXACT durable wake sources. */
export interface PendingWaitView {
  readonly kind: WaitKind;
  readonly wakeCommands: readonly CommandNameView[];
  readonly wakeObligationKinds: readonly ObligationKind[];
}

type CommandNameView = string;

/** The terminal proof shown on a card (exact id + evidence closure). */
export interface TerminalProofView {
  readonly id: string;
  readonly scope: string;
  readonly evidenceClosure: readonly EvidenceRef[];
}

/** Readiness of the item over authoritative predecessor evidence (WP-09). */
export type CardReadiness =
  | { readonly state: 'ready' }
  | { readonly state: 'waiting'; readonly gaps: readonly { readonly itemRef: string; readonly reason: string }[] }
  | { readonly state: 'unreachable'; readonly failedPredecessors: readonly string[] };

/** The current aggregate evidence a human needs to judge the card (ADR-053 chain). */
export interface CardEvidenceView {
  /** Sealed production revisions (the accepted-material authority). */
  readonly productionRevisionRefs: readonly EvidenceRef[];
  readonly candidateSetRefs: readonly EvidenceRef[];
  readonly gateDecisionRefs: readonly EvidenceRef[];
  readonly effectReceiptRefs: readonly EvidenceRef[];
  readonly cellFinalAcceptanceRefs: readonly EvidenceRef[];
}

/** One projected Kanban card. Immutable, derived, disposable. */
export interface KanbanCard {
  readonly cardId: string;
  readonly workItemRef: string;
  readonly workItemInstanceId: InstanceId;
  readonly workplaceInstanceId: InstanceId | null;
  readonly nodeInstanceId: InstanceId | null;
  readonly lane: KanbanLane;
  readonly workItemStatus: string;
  readonly workplaceStatus: string | null;
  /** Open obligations whose target command acts on this workplace. */
  readonly openObligationKinds: readonly ObligationKind[];
  readonly pendingWaits: readonly PendingWaitView[];
  readonly terminalProof: TerminalProofView | null;
  readonly evidence: CardEvidenceView;
  /** Pinned role-contract references (WP-17) - display, never selection. */
  readonly pinnedRoleContracts: readonly PinnedRoleContractView[];
  /** Prompt-receipt references (WP-18) - display, never selection. */
  readonly promptReceiptRefs: readonly PromptReceiptRefView[];
  readonly readiness: CardReadiness | null;
  /** The ledger sequence this card was projected at (staleness check). */
  readonly projectedSequence: number;
}

/* ------------------------------------------------------------------ */
/* The inputs the derivation reads (all authoritative, all read-only)   */
/* ------------------------------------------------------------------ */

/** The authoritative facts of one work item the projector assembles. */
export interface WorkItemProjectionFacts {
  readonly workItemRef: string;
  readonly workItemInstanceId: InstanceId;
  readonly workItemHead: AggregateHead;
  /** The workplaces materialized for this item (fan-out may hold more; the active one is the latest non-terminal). */
  readonly workplaces: readonly InstanceId[];
  readonly nodeInstanceId: InstanceId | null;
  readonly workplaceHead: AggregateHead | null;
  /** Open obligations acting on this item's workplace(s). */
  readonly openObligations: readonly ObligationRecord[];
  /** Pending waits owned by this item's workplace(s). */
  readonly pendingWaits: readonly WaitRecord[];
  /** Terminal proofs owned by this item's workplace(s). */
  readonly terminalProofs: readonly ProofRecord[];
  readonly evidence: CardEvidenceView;
  readonly pinnedRoleContracts: readonly PinnedRoleContractView[];
  readonly promptReceiptRefs: readonly PromptReceiptRefView[];
  readonly readiness: ReadinessState | null;
  /** The ledger sequence of this projection pass. */
  readonly sequence: number;
}

/**
 * Derive the lane of one card. THE ONLY place a lane is computed - a pure
 * function of authoritative facts, in precedence order:
 *
 *   terminal  : a terminal proof (or terminal head) committed - the exact
 *               proof is the authority, an empty queue never is;
 *   waiting   : a pending typed wait with a live wake source holds the card
 *               (readiness, human input, effect uncertainty, policy quota);
 *   repair    : the workplace is in a repair-family status;
 *   review    : the reviewer desk owns the card (reviewer-* statuses);
 *   in-progress: a workplace is materialized and working the author chain
 *               or the effect/acceptance chain;
 *   todo      : planned item, no workplace materialized yet.
 */
export function deriveLane(facts: WorkItemProjectionFacts): KanbanLane {
  if (facts.terminalProofs.length > 0 || facts.workplaceHead?.terminal !== undefined || facts.workItemHead.terminal !== undefined) {
    return 'terminal';
  }
  if (facts.pendingWaits.length > 0) {
    return 'waiting';
  }
  const status = facts.workplaceHead?.status;
  if (status !== undefined && REPAIR_STATUSES.includes(status)) {
    return 'repair';
  }
  if (status !== undefined && REVIEW_STATUSES.includes(status)) {
    return 'review';
  }
  if (status !== undefined) {
    return 'in-progress';
  }
  return 'todo';
}

/** Project one card from its assembled authoritative facts. */
export function projectCard(facts: WorkItemProjectionFacts): KanbanCard {
  const lane = deriveLane(facts);
  const proof = facts.terminalProofs.length > 0 ? facts.terminalProofs[facts.terminalProofs.length - 1] : undefined;
  return {
    cardId: `card:${facts.workItemRef}`,
    workItemRef: facts.workItemRef,
    workItemInstanceId: facts.workItemInstanceId,
    workplaceInstanceId: facts.workplaceHead?.instanceId ?? (facts.workplaces.length > 0 ? facts.workplaces[facts.workplaces.length - 1] : null),
    nodeInstanceId: facts.nodeInstanceId,
    lane,
    workItemStatus: facts.workItemHead.status,
    workplaceStatus: facts.workplaceHead?.status ?? null,
    openObligationKinds: [...new Set(facts.openObligations.map((obligation) => obligation.kind))].sort(),
    pendingWaits: facts.pendingWaits.map((wait) => ({
      kind: wait.kind,
      wakeCommands: [...wait.wakeCommands],
      wakeObligationKinds: [...wait.wakeObligationKinds],
    })),
    terminalProof: proof === undefined
      ? null
      : { id: proof.id, scope: proof.scope, evidenceClosure: [...proof.evidenceClosure].sort() },
    evidence: {
      productionRevisionRefs: [...facts.evidence.productionRevisionRefs].sort(),
      candidateSetRefs: [...facts.evidence.candidateSetRefs].sort(),
      gateDecisionRefs: [...facts.evidence.gateDecisionRefs].sort(),
      effectReceiptRefs: [...facts.evidence.effectReceiptRefs].sort(),
      cellFinalAcceptanceRefs: [...facts.evidence.cellFinalAcceptanceRefs].sort(),
    },
    pinnedRoleContracts: facts.pinnedRoleContracts.map((pin) => ({ ...pin })),
    promptReceiptRefs: facts.promptReceiptRefs.map((receipt) => ({ ...receipt })),
    readiness: facts.readiness === null ? null : cardReadinessOf(facts.readiness),
    projectedSequence: facts.sequence,
  };
}

function cardReadinessOf(readiness: ReadinessState): CardReadiness {
  if (readiness.state === 'ready') return { state: 'ready' };
  if (readiness.state === 'unreachable') return { state: 'unreachable', failedPredecessors: [...readiness.failedPredecessors] };
  return { state: 'waiting', gaps: readiness.gaps.map((gap) => ({ itemRef: gap.itemRef, reason: gap.reason })) };
}

/** The dependency edges of one item (authoritative planning facts), for display. */
export function dependencyEdgesOf(edges: readonly DependencyEdgeRow[], itemRef: string): readonly string[] {
  return edges.filter((edge) => edge.workItemRef === itemRef).map((edge) => edge.dependsOnRef).sort();
}

/** Re-exported type narrowing used by the projector when assembling pins. */
export function pinnedViewOf(intent: WorkIntent): PinnedRoleContractView {
  return {
    protocolRole: intent.protocolRole,
    roleContractRef: intent.roleContract.roleContractRef,
    roleContractDigest: intent.roleContract.roleContractDigest,
    pinnedByIntentRef: intent.intentRef,
  };
}
