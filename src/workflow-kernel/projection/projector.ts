/**
 * workflow-kernel/projection/projector.ts - the Kanban projector and the
 * full rebuild from canonical facts (WP-10, plan phase EK-7).
 *
 * PROJECTS: WorkItems, current aggregate evidence (the ADR-053 material
 * chain), obligations, waits and terminal proofs into Kanban cards.
 *
 * READS ONLY AUTHORITATIVE SURFACES: the hydrated shared ledger
 * (session.hydrateWorld), the owning repositories' public readers
 * (workItem.loadDependencies, activityAttempt.loadRoleContractPin,
 * activityAttempt.loadContextCounters) and the pure WP-09 topology
 * bindings / readiness predicates computed from the committed snapshot. It
 * NEVER reads the kanban_card table (the store is written only through the
 * projected image) and never reads any task status, assigned worker or
 * projection-derived dependency state.
 *
 * FULL REBUILD: every card is a pure function of the committed facts, so
 * `rebuildProjection` = delete-all + re-derive + replace-all reconstructs
 * the complete board at any time - after row deletion mid-run, after
 * false/stale rows were written, or after the projector was stopped for
 * the whole run. The three mandatory EK-7 mutations assert exactly this.
 */

import type { InstanceId } from '../domain/types.js';
import type { KernelWorld } from '../domain/explorer.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import { topologyBindings, type TopologyBindings } from '../planning/bindings.js';
import { evaluateReadiness, type DependencyEdgeRow } from '../planning/readiness.js';
import { projectCard, pinnedViewOf, type CardEvidenceView, type KanbanCard, type PinnedRoleContractView, type WorkItemProjectionFacts } from './cards.js';
import { brandedImage, KanbanCardStore, type ProjectedImage } from './store.js';

/* ------------------------------------------------------------------ */
/* Evidence classification (display grouping of committed facts)        */
/* ------------------------------------------------------------------ */

/**
 * Register-like constant table: evidence-kind prefixes -> the display group
 * of the card's current aggregate evidence. Pure display classification of
 * ALREADY-COMMITTED facts; no kernel decision anywhere reads these groups.
 */
const EVIDENCE_GROUPS: Readonly<Record<string, keyof CardEvidenceView>> = Object.freeze({
  WorkplaceProductionRevision: 'productionRevisionRefs',
  'CandidateSet:': 'candidateSetRefs',
  'GateDecision:': 'gateDecisionRefs',
  'EffectReceipt:': 'effectReceiptRefs',
  CellFinalAcceptance: 'cellFinalAcceptanceRefs',
});

/**
 * The card's current aggregate evidence, attributed through the frozen
 * evidence-ref scheme: every recorded fact's ref is `evidence:<kind>#<commit
 * sequence>` and the commit sequence names the producing event, whose
 * source instance owns the fact. Pure display grouping of COMMITTED facts.
 */
function evidenceViewOfWorkplace(world: KernelWorld, workplaceId: InstanceId): CardEvidenceView {
  const view: Record<keyof CardEvidenceView, string[]> = {
    productionRevisionRefs: [],
    candidateSetRefs: [],
    gateDecisionRefs: [],
    effectReceiptRefs: [],
    cellFinalAcceptanceRefs: [],
  };
  const eventOfSequence = new Map(world.events.map((event) => [event.sequence, event]));
  for (const fact of world.evidence) {
    for (const [prefix, group] of Object.entries(EVIDENCE_GROUPS)) {
      if (fact.kind !== prefix && !fact.kind.startsWith(prefix)) continue;
      const sequence = Number.parseInt(fact.ref.slice(fact.ref.lastIndexOf('#') + 1), 10);
      const event = eventOfSequence.get(sequence);
      if (event === undefined || event.sourceOwner !== 'Workplace' || event.sourceInstanceId !== workplaceId) continue;
      view[group] = [...view[group], fact.ref];
      break;
    }
  }
  return view;
}

/* ------------------------------------------------------------------ */
/* Per-snapshot join tables (built once per projection pass)            */
/* ------------------------------------------------------------------ */

interface IntentBinding {
  readonly intentRef: string;
  readonly protocolRole: 'author' | 'reviewer';
  readonly pin: PinnedRoleContractView;
  readonly attemptInstanceId: InstanceId | null;
}

interface ProjectionJoins {
  readonly bindings: TopologyBindings;
  readonly edges: readonly DependencyEdgeRow[];
  /** Workplace -> the WorkIntents admitted on it (with bound attempts). */
  readonly intentsOfWorkplace: ReadonlyMap<InstanceId, readonly IntentBinding[]>;
}

function joinsOf(session: KernelPersistenceSession, world: KernelWorld): ProjectionJoins {
  const bindings = topologyBindings(world);
  const edges: readonly DependencyEdgeRow[] = session.workItem.loadDependencies().map((row) => ({
    workItemRef: row.workItemRef,
    dependsOnRef: row.dependsOnRef,
  }));

  // The durable attempt -> WorkIntent join, read through the OWNING
  // repository's public pin reader (never guessed from id strings).
  const attemptIntents = new Map<InstanceId, string>();
  for (const head of world.heads.values()) {
    if (head.aggregate !== 'ActivityAttempt') continue;
    const pin = session.activityAttempt.loadRoleContractPin(head.instanceId);
    if (pin !== undefined) attemptIntents.set(head.instanceId, pin.workIntentRef);
  }

  const intentsOfWorkplace = new Map<InstanceId, IntentBinding[]>();
  for (const intent of world.workIntents.values()) {
    let attemptInstanceId: InstanceId | null = null;
    for (const [attempt, intentRef] of attemptIntents) {
      if (intentRef === intent.intentRef) attemptInstanceId = attempt;
    }
    const list = intentsOfWorkplace.get(intent.workplaceInstanceId) ?? [];
    list.push({ intentRef: intent.intentRef, protocolRole: intent.protocolRole, pin: pinnedViewOf(intent), attemptInstanceId });
    intentsOfWorkplace.set(intent.workplaceInstanceId, list);
  }

  return { bindings, edges, intentsOfWorkplace };
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Derive the complete projected image from canonical facts. PURE over the
 * session's committed state: two calls at the same ledger sequence return
 * deeply equal images.
 */
export function projectKanban(session: KernelPersistenceSession): ProjectedImage {
  const world = session.hydrateWorld().world;
  const joins = joinsOf(session, world);
  const receiptsOf = (attemptInstanceId: InstanceId): { receiptRef: string; attemptInstanceId: InstanceId; requestOrdinal: number }[] => {
    // Receipt references derive from the attempt's CAS-fenced counters (the
    // public owning-repository reader): the counters advance exactly when a
    // receipt commits, so ordinals 1..N are exactly the committed receipts.
    const counters = session.activityAttempt.loadContextCounters(attemptInstanceId);
    if (counters === undefined) return [];
    const refs: { receiptRef: string; attemptInstanceId: InstanceId; requestOrdinal: number }[] = [];
    for (let ordinal = 1; ordinal <= counters.nextRequestOrdinal; ordinal += 1) {
      refs.push({ receiptRef: `prompt-receipt:${attemptInstanceId}:${ordinal}`, attemptInstanceId, requestOrdinal: ordinal });
    }
    return refs;
  };
  const cards: KanbanCard[] = [...world.heads.values()]
    .filter((head) => head.aggregate === 'WorkItem')
    .map((itemHead) => projectCard(factsOfItem(world, joins, receiptsOf, itemHead)));
  return brandedImage(cards, world.sequence);
}

function factsOfItem(
  world: KernelWorld,
  joins: ProjectionJoins,
  receiptsOf: (attemptInstanceId: InstanceId) => readonly { receiptRef: string; attemptInstanceId: InstanceId; requestOrdinal: number }[],
  itemHead: import('../domain/types.js').AggregateHead,
): WorkItemProjectionFacts {
  const workplaces = joins.bindings.workplacesOfWorkItem(itemHead.instanceId);
  // The ACTIVE workplace is the latest one bound to the item (fan-out may
  // bind more; a terminal workplace stays displayed through its proof).
  const activeWorkplace = workplaces.length > 0 ? workplaces[workplaces.length - 1] : undefined;
  const workplaceHead = activeWorkplace === undefined ? null : world.heads.get(activeWorkplace) ?? null;
  const nodeBinding = activeWorkplace === undefined ? undefined : joins.bindings.nodeOfWorkplace(activeWorkplace);
  const nodeInstanceId = nodeBinding !== undefined && nodeBinding.resolved ? nodeBinding.value : null;

  const relevant = new Set<InstanceId>(workplaces);
  const openObligations = world.obligations.filter(
    (obligation) =>
      obligation.state === 'open' &&
      (relevant.has(obligation.sourceInstanceId) || (obligation.targetInstanceId !== null && relevant.has(obligation.targetInstanceId))),
  );
  const pendingWaits = world.waits.filter((wait) => wait.state === 'pending' && relevant.has(wait.ownerInstanceId));
  const terminalProofs = world.proofs.filter((proof) => relevant.has(proof.ownerInstanceId));

  const intents = activeWorkplace === undefined ? [] : (joins.intentsOfWorkplace.get(activeWorkplace) ?? []);
  const promptReceiptRefs = intents.flatMap((entry) => (entry.attemptInstanceId === null ? [] : receiptsOf(entry.attemptInstanceId)));

  return {
    workItemRef: itemRefOf(itemHead.instanceId),
    workItemInstanceId: itemHead.instanceId,
    workItemHead: itemHead,
    workplaces,
    nodeInstanceId,
    workplaceHead,
    openObligations,
    pendingWaits,
    terminalProofs,
    evidence: activeWorkplace === undefined ? emptyEvidence() : evidenceViewOfWorkplace(world, activeWorkplace),
    pinnedRoleContracts: intents.map((entry) => entry.pin),
    promptReceiptRefs,
    readiness: evaluateReadiness(joins.edges, joins.bindings, itemHead.instanceId),
    sequence: world.sequence,
  };
}

/** The human work-item ref of an instance id ("work-item:a" -> "a"; verbatim otherwise). */
function itemRefOf(instanceId: InstanceId): string {
  return instanceId.startsWith('work-item:') ? instanceId.slice('work-item:'.length) : instanceId;
}

function emptyEvidence(): CardEvidenceView {
  return { productionRevisionRefs: [], candidateSetRefs: [], gateDecisionRefs: [], effectReceiptRefs: [], cellFinalAcceptanceRefs: [] };
}

/* ------------------------------------------------------------------ */
/* The projector (live refresh) and the full rebuild                    */
/* ------------------------------------------------------------------ */

/**
 * The live projector: re-derive the image from canonical facts and replace
 * every store row with it (the ONLY store write). Call after any command
 * batch; idempotent at a fixed ledger sequence.
 */
export function refreshProjection(session: KernelPersistenceSession, store: KanbanCardStore): number {
  return store.replaceAll(projectKanban(session));
}

/**
 * FULL PROJECTION REBUILD from canonical facts: dispose of every stored row
 * (whatever it holds - absent, stale or forged), re-derive the complete
 * image through the repositories' read surfaces and write it back. The
 * canonical facts are untouched: the board is reconstructed, never trusted.
 */
export function rebuildProjection(session: KernelPersistenceSession, store: KanbanCardStore): number {
  store.deleteAll();
  return refreshProjection(session, store);
}
