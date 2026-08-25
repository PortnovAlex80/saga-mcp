/**
 * workflow-kernel/planning/bindings.ts - durable topology bindings derived
 * from committed ledger facts (WP-09, plan phase EK-6).
 *
 * WP-07 froze the rule: the obligation consumer resolves cross-aggregate
 * targets ONLY from durable facts and leaves cross-aggregate obligations
 * (obligation:completeCellNode, obligation:propagateCellFailure,
 * obligation:markDependantsUnreachable, obligation:propagateNodeFailure,
 * obligation:recordStageOutcome*) typed-unresolvable until the planning
 * topology supplies bindings AS EVIDENCE. This module is that supply.
 *
 * Every binding below is a pure function of COMMITTED rows - workflow
 * events, transition obligations, terminal proofs and WorkIntents. There is
 * no chronology guess (no "most recent"), no board/task projection read and
 * no convention: each edge is either
 *   - an obligation-completion join: an obligation row (source instance,
 *     target command) completed at the sequence of the target command's own
 *     event - the completion sequence IS the target event (WP-07 proved it),
 *     so (source instance -> target event instance) is durable; or
 *   - a planning-token join: the conveyor stamps cell materializations and
 *     work-item intents with the authored graph's content-addressed tokens
 *     (plan:<ref>#item:<item>), so shared tokens bind work item <-> node <->
 *     workplace from event evidence refs alone; or
 *   - a WorkIntent row (workplace_work_intent.work_item_ref, read through
 *     the owning repository's public reader surface via the hydrated world).
 *
 * PURITY: pure functions of the passed snapshot. No I/O, no clock, no SQL.
 */

import type {
  AggregateHead,
  EvidenceFact,
  EvidenceRef,
  InstanceId,
  ObligationRecord,
  ProofRecord,
  WorkIntent,
  WorkflowEventRecord,
} from '../domain/types.js';

/** The committed shared-ledger snapshot every binding derives from. */
export interface LedgerSnapshot {
  readonly events: readonly WorkflowEventRecord[];
  readonly obligations: readonly ObligationRecord[];
  readonly proofs: readonly ProofRecord[];
  readonly evidence: readonly EvidenceFact[];
  readonly heads: ReadonlyMap<InstanceId, AggregateHead>;
  readonly workIntents: ReadonlyMap<EvidenceRef, WorkIntent>;
}

/** A binding that could not be derived from durable facts (typed, never guessed). */
export interface BindingUnresolved {
  readonly resolved: false;
  readonly unresolved: true;
  readonly detail: string;
}

export type Binding<T> = { readonly resolved: true; readonly value: T } | BindingUnresolved;

const unresolved = <T>(detail: string): Binding<T> => ({ resolved: false as const, unresolved: true, detail });

/* ------------------------------------------------------------------ */
/* The durable join tables                                             */
/* ------------------------------------------------------------------ */

interface JoinTables {
  /** completion sequence -> the obligation completed at that sequence. */
  readonly completionAt: ReadonlyMap<number, ObligationRecord>;
  /** sequence -> event. */
  readonly eventAt: ReadonlyMap<number, WorkflowEventRecord>;
  /** obligation source instance -> target event instance (materialization joins). */
  readonly materializationSourceOf: ReadonlyMap<InstanceId, InstanceId>;
  readonly instanceOfMaterializationSource: ReadonlyMap<InstanceId, InstanceId>;
  /** evidence refs of each event (for token joins). */
  readonly refsOfEvent: ReadonlyMap<number, readonly EvidenceRef[]>;
  /** aggregate of an instance (from heads). */
  readonly aggregateOf: (instanceId: InstanceId) => string | undefined;
}

function buildTables(snapshot: LedgerSnapshot): JoinTables {
  const eventAt = new Map<number, WorkflowEventRecord>(snapshot.events.map((event) => [event.sequence, event]));
  const completionAt = new Map<number, ObligationRecord>();
  for (const obligation of snapshot.obligations) {
    const ref = obligation.completionEvidenceRef;
    if (obligation.state !== 'completed' || ref === undefined) continue;
    const sequence = Number.parseInt(ref.split('#')[1] ?? '', 10);
    if (Number.isInteger(sequence)) completionAt.set(sequence, obligation);
  }
  const materializationSourceOf = new Map<InstanceId, InstanceId>();
  const instanceOfMaterializationSource = new Map<InstanceId, InstanceId>();
  for (const [sequence, obligation] of completionAt) {
    if (obligation.target !== 'workplace.materialize') continue;
    const event = eventAt.get(sequence);
    if (event === undefined || event.transition !== 'workplace.materialize') continue;
    materializationSourceOf.set(event.sourceInstanceId, obligation.sourceInstanceId);
    instanceOfMaterializationSource.set(obligation.sourceInstanceId, event.sourceInstanceId);
  }
  const refsOfEvent = new Map<number, readonly EvidenceRef[]>(snapshot.events.map((event) => [event.sequence, event.evidenceRefs]));
  return {
    completionAt,
    eventAt,
    materializationSourceOf,
    instanceOfMaterializationSource,
    refsOfEvent,
    aggregateOf: (instanceId) => snapshot.heads.get(instanceId)?.aggregate,
  };
}

/** The completion join of one obligation kind: source instance -> target event instance. */
function completionJoin(tables: JoinTables, kind: string, targetTransition: string): ReadonlyMap<InstanceId, InstanceId> {
  const joined = new Map<InstanceId, InstanceId>();
  for (const [sequence, obligation] of tables.completionAt) {
    if (obligation.kind !== kind) continue;
    const event = tables.eventAt.get(sequence);
    if (event === undefined || event.transition !== targetTransition) continue;
    joined.set(event.sourceInstanceId, obligation.sourceInstanceId);
  }
  return joined;
}

const isPlanningToken = (ref: string): boolean => ref.startsWith('plan:') && ref.includes('#item:');

const NODE_TERMINAL_TRANSITIONS: readonly string[] = [
  'nodeRun.recordCellAcceptance',
  'nodeRun.recordKernelResult',
  'nodeRun.fail',
  'nodeRun.settleUnreachable',
];

/** The set-equality-free subset test for the recordNodeTerminal evidence join. */
const refsCoveredBy = (inner: readonly EvidenceRef[], outer: readonly EvidenceRef[]): boolean =>
  inner.length > 0 && inner.every((ref) => outer.includes(ref));

/* ------------------------------------------------------------------ */
/* The bindings                                                        */
/* ------------------------------------------------------------------ */

/** Durable aggregate-containment and cell bindings of one committed world. */
export interface TopologyBindings {
  /** LifecycleRun -> owning FactoryRun (bootstrap join). */
  readonly factoryOfLifecycle: (lifecycleId: InstanceId) => Binding<InstanceId>;
  /** StageRun -> owning LifecycleRun (enterStage join). */
  readonly lifecycleOfStage: (stageId: InstanceId) => Binding<InstanceId>;
  /** ProcessRun -> owning StageRun (bindProcessModule join). */
  readonly stageOfProcess: (processId: InstanceId) => Binding<InstanceId>;
  /** NodeRun -> owning ProcessRun (recordNodeTerminal evidence-ref join). */
  readonly processOfNode: (nodeId: InstanceId) => Binding<InstanceId>;
  /** Workplace -> its production-cell NodeRun (planning-token join, materialize join fallback). */
  readonly nodeOfWorkplace: (workplaceId: InstanceId) => Binding<InstanceId>;
  /** NodeRun -> its cell Workplace. */
  readonly workplaceOfNode: (nodeId: InstanceId) => Binding<InstanceId>;
  /** WorkItem instance -> the workplaces its WorkIntents were admitted on. */
  readonly workplacesOfWorkItem: (workItemId: InstanceId) => readonly InstanceId[];
  /** Workplace -> committed CellFinalAcceptance fact refs (authoritative predecessor evidence). */
  readonly acceptanceRefsOfWorkplace: (workplaceId: InstanceId) => readonly EvidenceRef[];
  /** Workplace -> its success-shaped EffectReceipt fact refs (success | already-applied). */
  readonly effectSuccessRefsOfWorkplace: (workplaceId: InstanceId) => readonly EvidenceRef[];
  /** Workplace -> EVERY EffectReceipt fact ref it committed (any outcome - the declared-effects signal). */
  readonly effectReceiptRefsOfWorkplace: (workplaceId: InstanceId) => readonly EvidenceRef[];
  /** Workplaces with a committed truthful-failure or unreachable terminal proof. */
  readonly terminallyFailedWorkplaces: () => ReadonlySet<InstanceId>;
  /** Instances an authored planning token names (token -> {node?, workplace?}). */
  readonly tokenHolders: (token: string) => { readonly nodes: readonly InstanceId[]; readonly workplaces: readonly InstanceId[] };
}

/**
 * Derive every topology binding from the committed snapshot. Pure: the same
 * snapshot always yields the same bindings.
 */
export function topologyBindings(snapshot: LedgerSnapshot): TopologyBindings {
  const tables = buildTables(snapshot);

  const lifecycleToFactory = completionJoin(tables, 'obligation:bootstrapLifecycleRun', 'lifecycleRun.create');
  const stageToLifecycle = new Map<InstanceId, InstanceId>();
  for (const kind of [
    'obligation:enterStage.initial-discovery',
    'obligation:enterStage.solution-formalization',
    'obligation:enterStage.solution-development',
    'obligation:enterStage.delivery-release',
    'obligation:enterStage.continuation',
  ]) {
    for (const [stage, lifecycle] of completionJoin(tables, kind, 'stageRun.create')) stageToLifecycle.set(stage, lifecycle);
  }
  const processToStage = completionJoin(tables, 'obligation:bindProcessModule', 'processRun.create');

  // Token holders: cell materializations and node cell creations stamped with
  // the authored graph's item tokens.
  const tokenNodes = new Map<string, InstanceId[]>();
  const tokenWorkplaces = new Map<string, InstanceId[]>();
  for (const event of snapshot.events) {
    for (const ref of event.evidenceRefs) {
      if (!isPlanningToken(ref)) continue;
      if (event.transition === 'nodeRun.materializeCell') {
        tokenNodes.set(ref, [...(tokenNodes.get(ref) ?? []), event.sourceInstanceId]);
      } else if (event.transition === 'workplace.materialize') {
        tokenWorkplaces.set(ref, [...(tokenWorkplaces.get(ref) ?? []), event.sourceInstanceId]);
      }
    }
  }

  // Node -> Process: primary join is the planning token (the conveyor stamps
  // recordNodeTerminal with the cell's authored token, which also stamped the
  // node's cell creation); fallback is the node's own terminal event refs
  // being carried by the recordNodeTerminal evidence. No chronology, no recency.
  const nodeToProcess = new Map<InstanceId, InstanceId>();
  const nodeTerminalRefs = new Map<InstanceId, readonly EvidenceRef[]>();
  for (const event of snapshot.events) {
    if (NODE_TERMINAL_TRANSITIONS.includes(event.transition)) {
      nodeTerminalRefs.set(event.sourceInstanceId, event.evidenceRefs);
    }
  }
  for (const event of snapshot.events) {
    if (event.transition !== 'processRun.recordNodeTerminal') continue;
    for (const ref of event.evidenceRefs) {
      if (!isPlanningToken(ref)) continue;
      for (const node of tokenNodes.get(ref) ?? []) {
        if (!nodeToProcess.has(node)) nodeToProcess.set(node, event.sourceInstanceId);
      }
    }
    for (const [node, refs] of nodeTerminalRefs) {
      if (!nodeToProcess.has(node) && refsCoveredBy(refs, event.evidenceRefs)) {
        nodeToProcess.set(node, event.sourceInstanceId);
      }
    }
  }

  // Workplace <-> Node (planning-token join primary; materialize obligation
  // join fallback).
  const workplaceToNode = new Map<InstanceId, InstanceId>();
  const nodeToWorkplace = new Map<InstanceId, InstanceId>();
  // Primary: shared planning token between a cell creation and a materialization.
  for (const [token, workplaces] of tokenWorkplaces) {
    const nodes = tokenNodes.get(token) ?? [];
    if (nodes.length === 1 && workplaces.length === 1) {
      workplaceToNode.set(workplaces[0], nodes[0]);
      nodeToWorkplace.set(nodes[0], workplaces[0]);
    }
  }
  // Fallback: the materialize obligation join when its source row was the
  // node's own production-cell obligation.
  for (const [workplace, source] of tables.materializationSourceOf) {
    if (workplaceToNode.has(workplace)) continue;
    if (tables.aggregateOf(source) === 'NodeRun') {
      workplaceToNode.set(workplace, source);
      nodeToWorkplace.set(source, workplace);
    }
  }

  // WorkItem -> workplaces: WorkIntent rows (durable FK surface) plus the
  // planGraph instantiation join (source = the work item instance).
  const workplacesByItem = new Map<InstanceId, InstanceId[]>();
  const addItemWorkplace = (item: InstanceId, workplace: InstanceId): void => {
    const current = workplacesByItem.get(item) ?? [];
    if (!current.includes(workplace)) current.push(workplace);
    workplacesByItem.set(item, current);
  };
  for (const intent of snapshot.workIntents.values()) {
    addItemWorkplace(intent.workItemRef, intent.workplaceInstanceId);
  }
  for (const [source, workplace] of tables.instanceOfMaterializationSource) {
    if (tables.aggregateOf(source) === 'WorkItem') addItemWorkplace(source, workplace);
  }

  // Per-workplace authoritative predecessor evidence: acceptance facts commit
  // with the recordFinalAcceptance event (`evidence:CellFinalAcceptance#seq`).
  const evidenceRefs = new Set(snapshot.evidence.map((fact) => fact.ref));
  const acceptanceOf = new Map<InstanceId, EvidenceRef[]>();
  const effectSuccessOf = new Map<InstanceId, EvidenceRef[]>();
  const effectAnyOf = new Map<InstanceId, EvidenceRef[]>();
  const EFFECT_OUTCOMES: readonly string[] = ['success', 'already-applied', 'retryable', 'unknown', 'human-wait', 'policy-terminal', 'repair'];
  for (const event of snapshot.events) {
    if (event.transition === 'workplace.recordFinalAcceptance') {
      const ref = `evidence:CellFinalAcceptance#${event.sequence}`;
      if (evidenceRefs.has(ref)) {
        acceptanceOf.set(event.sourceInstanceId, [...(acceptanceOf.get(event.sourceInstanceId) ?? []), ref]);
      }
    }
    if (event.transition === 'workplace.settleEffect') {
      for (const outcome of EFFECT_OUTCOMES) {
        const ref = `evidence:EffectReceipt:${outcome}#${event.sequence}`;
        if (!evidenceRefs.has(ref)) continue;
        effectAnyOf.set(event.sourceInstanceId, [...(effectAnyOf.get(event.sourceInstanceId) ?? []), ref]);
        if (outcome === 'success' || outcome === 'already-applied') {
          effectSuccessOf.set(event.sourceInstanceId, [...(effectSuccessOf.get(event.sourceInstanceId) ?? []), ref]);
        }
      }
    }
  }

  const failed = new Set<InstanceId>();
  for (const proof of snapshot.proofs) {
    if (proof.id === 'TerminalProof:workplace.truthful-failure' || proof.id === 'TerminalProof:workplace.unreachable') {
      failed.add(proof.ownerInstanceId);
    }
  }

  return {
    factoryOfLifecycle: (lifecycleId) => {
      const factory = lifecycleToFactory.get(lifecycleId);
      return factory === undefined ? unresolved<InstanceId>(`no durable bootstrap join for lifecycle ${lifecycleId}`) : { resolved: true as const, value: factory };
    },
    lifecycleOfStage: (stageId) => {
      const lifecycle = stageToLifecycle.get(stageId);
      return lifecycle === undefined ? unresolved<InstanceId>(`no durable enterStage join for stage ${stageId}`) : { resolved: true, value: lifecycle };
    },
    stageOfProcess: (processId) => {
      const stage = processToStage.get(processId);
      return stage === undefined ? unresolved<InstanceId>(`no durable bindProcessModule join for process ${processId}`) : { resolved: true, value: stage };
    },
    processOfNode: (nodeId) => {
      const process = nodeToProcess.get(nodeId);
      return process === undefined ? unresolved<InstanceId>(`no durable recordNodeTerminal evidence join for node ${nodeId}`) : { resolved: true, value: process };
    },
    nodeOfWorkplace: (workplaceId) => {
      const node = workplaceToNode.get(workplaceId);
      return node === undefined ? unresolved<InstanceId>(`no durable cell binding for workplace ${workplaceId}`) : { resolved: true, value: node };
    },
    workplaceOfNode: (nodeId) => {
      const workplace = nodeToWorkplace.get(nodeId);
      return workplace === undefined ? unresolved<InstanceId>(`no durable cell binding for node ${nodeId}`) : { resolved: true, value: workplace };
    },
    workplacesOfWorkItem: (workItemId) => workplacesByItem.get(workItemId) ?? [],
    acceptanceRefsOfWorkplace: (workplaceId) => acceptanceOf.get(workplaceId) ?? [],
    effectSuccessRefsOfWorkplace: (workplaceId) => effectSuccessOf.get(workplaceId) ?? [],
    effectReceiptRefsOfWorkplace: (workplaceId) => effectAnyOf.get(workplaceId) ?? [],
    terminallyFailedWorkplaces: () => failed,
    tokenHolders: (token) => ({ nodes: tokenNodes.get(token) ?? [], workplaces: tokenWorkplaces.get(token) ?? [] }),
  };
}
