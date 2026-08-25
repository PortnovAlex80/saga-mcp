/**
 * workflow-kernel/planning/settlement.ts - bounded aggregate settlement over
 * the existing obligation/wait machinery (WP-09, plan phase EK-6).
 *
 * Plan law (EK-6): "Implement bounded aggregate commands for Node, Process,
 * Stage and Lifecycle" and "Implement success, truthful failure,
 * cancellation and unreachable settlement proofs" - all through the frozen
 * command universe (no new command ids) and the WP-07 consumer protocol.
 *
 * This module is the evidence supply WP-07's handoff asked for: every
 * cross-aggregate obligation the consumer leaves typed-unresolvable by
 * design (obligation:completeCellNode, obligation:propagateCellFailure,
 * obligation:markDependantsUnreachable, obligation:propagateNodeFailure,
 * obligation:recordStageOutcome*, obligation:routeLifecycle,
 * obligation:routeUpstreamRepair, obligation:runSettlement) is consumed
 * here with a target instance resolved from DURABLE TOPOLOGY BINDINGS
 * (./bindings.ts) - never from chronology, recency or a board.
 *
 * Frontier discipline is preserved exactly: the claim constructed here is
 * always the LOWEST-id open obligation of its kind (the row the pure engine
 * would complete), the idempotency key is the consumer's `consume:<key>`,
 * and the owning repository's single transaction performs the command +
 * obligation completion + any proof/wait/evidence delta. A refusal returns
 * typed; nothing is retried in a spin.
 *
 * PURITY over the session: only repository public surfaces + the consumer;
 * no direct SQL, no projection reads, no clock.
 */

import type {
  CommandInput,
  CommandOutcome,
  EvidenceFact,
  InstanceId,
  ObligationRecord,
  StageRoute,
  TerminalOutcome,
  TypedRefusal,
} from '../domain/types.js';
import { COMMANDS, type CommandName, type ObligationKind } from '../domain/universe.js';
import type { ConsumeInvocation, ConsumeResult, ObligationClaim } from '../application/obligation-consumer.js';
import { consumeClaim, repositoryOf } from '../application/obligation-consumer.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import type { FaultScheduler } from '../application/faults.js';
import { commandFaultPoints } from '../application/faults.js';
import { topologyBindings, type TopologyBindings } from './bindings.js';

/** Call-scoped settlement configuration (external Input evidence + faults). */
export interface SettlementConfig {
  readonly externalEvidence: readonly EvidenceFact[];
  readonly faults?: FaultScheduler;
}

/** One bounded settlement step's typed outcome. */
export type SettlementStep =
  | { readonly status: 'committed'; readonly command: CommandName; readonly instanceId: InstanceId; readonly outcome: Extract<CommandOutcome, { committed: true }> }
  | { readonly status: 'replayed'; readonly command: CommandName; readonly instanceId: InstanceId }
  | { readonly status: 'refused'; readonly command: CommandName; readonly refusal: TypedRefusal }
  | { readonly status: 'unresolved'; readonly kind: ObligationKind; readonly detail: string };

/* ------------------------------------------------------------------ */
/* The binding-aware claim (the WP-09 evidence supply)                 */
/* ------------------------------------------------------------------ */

export interface TopologyClaimSpec {
  readonly kind: ObligationKind;
  /** The exact target command the obligation row must name (universe check). */
  readonly expectedTarget: CommandName;
  /**
   * Resolve the target instance from durable topology bindings. Returning
   * undefined is a typed unresolved outcome - NEVER a guess.
   */
  readonly resolveTargetInstanceId: (bindings: TopologyBindings) => InstanceId | undefined;
  readonly invocation?: ConsumeInvocation;
}

export type TopologyClaimResult = { readonly status: 'none' } | { readonly status: 'unresolved'; readonly kind: ObligationKind; readonly detail: string } | ConsumeResult;

/**
 * Claim and consume the LOWEST-id open obligation of one kind whose target
 * instance is resolved from durable topology bindings. This is the ONLY
 * place WP-09 supplies cross-aggregate bindings, and it always goes through
 * the WP-07 consumer (one transaction, one completion, one fence).
 */
export function consumeWithTopologyBinding(session: KernelPersistenceSession, spec: TopologyClaimSpec, config: SettlementConfig): TopologyClaimResult {
  const ledger = session.hydrateWorld();
  const world = ledger.world;
  let row: ObligationRecord | undefined;
  let index = -1;
  for (let i = 0; i < world.obligations.length; i += 1) {
    const obligation = world.obligations[i];
    if (obligation.state === 'open' && obligation.kind === spec.kind) {
      row = obligation;
      index = i;
      break;
    }
  }
  if (row === undefined) return { status: 'none' };
  if (row.target !== spec.expectedTarget) {
    return {
      status: 'unresolved',
      kind: spec.kind,
      detail: `open obligation ${spec.kind} targets ${row.target}, not ${spec.expectedTarget} (universe mismatch)`,
    };
  }
  const bindings = topologyBindings(world);
  const targetInstanceId = spec.resolveTargetInstanceId(bindings);
  if (targetInstanceId === undefined) {
    return {
      status: 'unresolved',
      kind: spec.kind,
      detail: `no durable topology binding resolves the target instance of ${spec.kind} (source ${row.sourceInstanceId}); never guessed`,
    };
  }
  const head = world.heads.get(targetInstanceId);
  const expectedRevision = head === undefined ? 0 : head.revision;
  const claim: ObligationClaim = {
    index,
    kind: row.kind,
    target: row.target as CommandName,
    targetAggregate: row.targetAggregate,
    sourceInstanceId: row.sourceInstanceId,
    targetInstanceId,
    expectedRevision,
    // The engine completes the lane's FIFO head row (not necessarily THIS
    // row), so the row's own consume key may already be burned by an earlier
    // application on another instance; the key is therefore derived from the
    // exact command application (instance + fence revision) - deterministic
    // for re-drives, unique per application.
    idempotencyKey: `consume:${row.kind}:${targetInstanceId}:${expectedRevision}`,
    evidenceRefs: [...row.evidenceRefs],
  };
  for (const point of commandFaultPoints(claim.target)) {
    if (point.startsWith('before-')) config.faults?.fire(point);
  }
  const result = consumeClaim(session, claim, spec.invocation ?? {}, { externalEvidence: config.externalEvidence, faults: config.faults });
  for (const point of commandFaultPoints(claim.target)) {
    if (point.startsWith('after-')) config.faults?.fire(point);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Bounded direct command application (exempt commands only)            */
/* ------------------------------------------------------------------ */

/**
 * Apply one bounded aggregate command directly through its sole-writer
 * repository (operator/ingress/kernel-autonomy commands that own no
 * obligation lane). The aggregate resolves from the frozen universe; an
 * unknown command fails closed. Idempotent keys are deterministic.
 */
export function applyBounded(session: KernelPersistenceSession, input: CommandInput, config: SettlementConfig): SettlementStep {
  const descriptor = COMMANDS.find((entry) => entry.name === input.command);
  if (descriptor === undefined) {
    return { status: 'refused', command: input.command, refusal: { refused: true, reason: 'UNKNOWN_COMMAND', detail: `${input.command} is not in the frozen universe` } };
  }
  for (const point of commandFaultPoints(input.command)) {
    if (point.startsWith('before-')) config.faults?.fire(point);
  }
  config.faults?.fire('before-durable-write');
  const outcome = repositoryOf(session, descriptor.aggregate).applyCommand(
    input,
    config.externalEvidence === undefined ? undefined : { externalEvidence: config.externalEvidence },
  );
  config.faults?.fire('after-durable-write');
  for (const point of commandFaultPoints(input.command)) {
    if (point.startsWith('after-')) config.faults?.fire(point);
  }
  if ('refused' in outcome) return { status: 'refused', command: input.command, refusal: outcome };
  if ('replayed' in outcome) return { status: 'replayed', command: input.command, instanceId: input.instanceId };
  return { status: 'committed', command: input.command, instanceId: input.instanceId, outcome };
}

const settleStepOf = (command: CommandName, instanceId: InstanceId, result: TopologyClaimResult): SettlementStep | TopologyClaimResult => {
  if (result.status === 'committed') return { status: 'committed', command, instanceId, outcome: result.outcome };
  if (result.status === 'replayed') return { status: 'replayed', command, instanceId };
  if (result.status === 'refused') return { status: 'refused', command, refusal: result.refusal };
  return result;
};

/* ------------------------------------------------------------------ */
/* The settlement ladder (Node -> Process -> Stage -> Lifecycle -> Run)  */
/* ------------------------------------------------------------------ */

/**
 * Advance the module flow: processRun.recordNodeTerminal for one cell. The
 * optional dedupeEvidenceRef (the cell's planning token) makes re-drives
 * idempotent: an already-recorded terminal for that cell is a replay.
 */
export function recordNodeTerminal(session: KernelPersistenceSession, processId: InstanceId, evidenceRefs: readonly string[], config: SettlementConfig, dedupeEvidenceRef?: string): SettlementStep {
  if (
    dedupeEvidenceRef !== undefined &&
    session.hydrateWorld().world.events.some((event) => event.transition === 'processRun.recordNodeTerminal' && event.sourceInstanceId === processId && event.evidenceRefs.includes(dedupeEvidenceRef))
  ) {
    return { status: 'replayed', command: 'processRun.recordNodeTerminal', instanceId: processId };
  }
  const head = session.hydrateWorld().world.heads.get(processId);
  return applyBounded(
    session,
    {
      command: 'processRun.recordNodeTerminal',
      instanceId: processId,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey: `settle:record-node-terminal:${processId}:${head === undefined ? 0 : head.revision}`,
      evidenceRefs: [...evidenceRefs],
    },
    config,
  );
}

/** Fan-in kernel result: obligation:freezeCandidate -> nodeRun.recordKernelResult. */
export function recordKernelResultForCell(session: KernelPersistenceSession, workplaceId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const result = consumeWithTopologyBinding(session, {
    kind: 'obligation:freezeCandidate',
    expectedTarget: 'nodeRun.recordKernelResult',
    resolveTargetInstanceId: (b) => {
      const node = b.nodeOfWorkplace(workplaceId);
      return node.resolved ? node.value : undefined;
    },
  }, config);
  return settleStepOf('nodeRun.recordKernelResult', workplaceId, result);
}

/** obligation:completeCellNode -> nodeRun.recordCellAcceptance (TerminalProof:node.success). */
export function completeCellNode(session: KernelPersistenceSession, workplaceId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const result = consumeWithTopologyBinding(session, {
    kind: 'obligation:completeCellNode',
    expectedTarget: 'nodeRun.recordCellAcceptance',
    resolveTargetInstanceId: (b) => {
      const node = b.nodeOfWorkplace(workplaceId);
      return node.resolved ? node.value : undefined;
    },
  }, config);
  return settleStepOf('nodeRun.recordCellAcceptance', workplaceId, result);
}

/** obligation:propagateCellFailure -> nodeRun.fail (TerminalProof:node.truthful-failure). */
export function propagateCellFailure(session: KernelPersistenceSession, workplaceId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const result = consumeWithTopologyBinding(session, {
    kind: 'obligation:propagateCellFailure',
    expectedTarget: 'nodeRun.fail',
    resolveTargetInstanceId: (b) => {
      const node = b.nodeOfWorkplace(workplaceId);
      return node.resolved ? node.value : undefined;
    },
  }, config);
  return settleStepOf('nodeRun.fail', workplaceId, result);
}

/** obligation:markDependantsUnreachable -> nodeRun.settleUnreachable (TerminalProof:node.unreachable). */
export function settleDependantNodeUnreachable(session: KernelPersistenceSession, dependantWorkplaceId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const result = consumeWithTopologyBinding(session, {
    kind: 'obligation:markDependantsUnreachable',
    expectedTarget: 'nodeRun.settleUnreachable',
    resolveTargetInstanceId: (b) => {
      const node = b.nodeOfWorkplace(dependantWorkplaceId);
      return node.resolved ? node.value : undefined;
    },
  }, config);
  return settleStepOf('nodeRun.settleUnreachable', dependantWorkplaceId, result);
}

/** obligation:advanceProcessFlow.settle -> processRun.settle (TerminalProof:process.success). */
export function settleProcessSuccess(session: KernelPersistenceSession, processId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const preexisting = session.hydrateWorld().world.heads.get(processId);
  if (preexisting !== undefined && preexisting.terminal !== undefined) {
    return { status: 'none' }; // the process already settled (re-drive)
  }
  const ledger = session.hydrateWorld();
  let row: ObligationRecord | undefined;
  let index = -1;
  for (let i = 0; i < ledger.world.obligations.length; i += 1) {
    const obligation = ledger.world.obligations[i];
    if (obligation.state === 'open' && obligation.kind === 'obligation:advanceProcessFlow.settle') {
      row = obligation;
      index = i;
      break;
    }
  }
  if (row === undefined) return { status: 'none' };
  const head = ledger.world.heads.get(processId);
  const claim: ObligationClaim = {
    index,
    kind: row.kind,
    target: 'processRun.settle',
    targetAggregate: 'ProcessRun',
    sourceInstanceId: row.sourceInstanceId,
    targetInstanceId: processId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `consume:${row.kind}:${processId}:${head === undefined ? 0 : head.revision}`,
    evidenceRefs: [...row.evidenceRefs],
  };
  const result = consumeClaim(session, claim, { terminalOutcome: 'success' }, { externalEvidence: config.externalEvidence, faults: config.faults });
  return settleStepOf('processRun.settle', processId, result);
}

/** obligation:propagateNodeFailure -> processRun.settleFailure (TerminalProof:process.truthful-failure). */
export function settleProcessFailure(session: KernelPersistenceSession, failedNodeId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const result = consumeWithTopologyBinding(session, {
    kind: 'obligation:propagateNodeFailure',
    expectedTarget: 'processRun.settleFailure',
    resolveTargetInstanceId: (b) => {
      const process = b.processOfNode(failedNodeId);
      return process.resolved ? process.value : undefined;
    },
  }, config);
  return settleStepOf('processRun.settleFailure', failedNodeId, result);
}

/**
 * obligation:routeUpstreamRepair -> processRun.settle of the upstream
 * predecessor's process (R1: out-of-scope defect routed as typed repair to
 * the OWNING upstream aggregate, never silently widened).
 */
export function routeUpstreamRepair(session: KernelPersistenceSession, upstreamWorkplaceId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const result = consumeWithTopologyBinding(session, {
    kind: 'obligation:routeUpstreamRepair',
    expectedTarget: 'processRun.settle',
    resolveTargetInstanceId: (b) => {
      const node = b.nodeOfWorkplace(upstreamWorkplaceId);
      if (!node.resolved) return undefined;
      const process = b.processOfNode(node.value);
      return process.resolved ? process.value : undefined;
    },
    invocation: { terminalOutcome: 'truthful-failure' },
  }, config);
  return settleStepOf('processRun.settle', upstreamWorkplaceId, result);
}

/** obligation:recordStageOutcome(.failed) -> stageRun.recordLocalOutcome. */
export function settleStageOutcome(
  session: KernelPersistenceSession,
  processId: InstanceId,
  outcome: 'success' | 'truthful-failure',
  config: SettlementConfig,
): SettlementStep | TopologyClaimResult {
  const kind = outcome === 'success' ? 'obligation:recordStageOutcome' : 'obligation:recordStageOutcome.failed';
  const result = consumeWithTopologyBinding(session, {
    kind,
    expectedTarget: 'stageRun.recordLocalOutcome',
    resolveTargetInstanceId: (b) => {
      const stage = b.stageOfProcess(processId);
      return stage.resolved ? stage.value : undefined;
    },
    invocation: { terminalOutcome: outcome },
  }, config);
  return settleStepOf('stageRun.recordLocalOutcome', processId, result);
}

/** obligation:routeLifecycle -> lifecycleRun.routeOutcome (exact declared route only). */
export function routeLifecycleOutcome(session: KernelPersistenceSession, stageId: InstanceId, route: StageRoute, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const result = consumeWithTopologyBinding(session, {
    kind: 'obligation:routeLifecycle',
    expectedTarget: 'lifecycleRun.routeOutcome',
    resolveTargetInstanceId: (b) => {
      const lifecycle = b.lifecycleOfStage(stageId);
      return lifecycle.resolved ? lifecycle.value : undefined;
    },
    invocation: { stageRoute: route },
  }, config);
  return settleStepOf('lifecycleRun.routeOutcome', stageId, result);
}

/** obligation:verifyTerminalClaims -> lifecycleRun.verifyTerminalClaims (D4). */
export function verifyTerminalClaims(session: KernelPersistenceSession, lifecycleId: InstanceId, config: SettlementConfig): SettlementStep | TopologyClaimResult {
  const ledger = session.hydrateWorld();
  let row: ObligationRecord | undefined;
  let index = -1;
  for (let i = 0; i < ledger.world.obligations.length; i += 1) {
    const obligation = ledger.world.obligations[i];
    if (obligation.state === 'open' && obligation.kind === 'obligation:verifyTerminalClaims') {
      row = obligation;
      index = i;
      break;
    }
  }
  if (row === undefined) return { status: 'none' };
  const head = ledger.world.heads.get(lifecycleId);
  const claim: ObligationClaim = {
    index,
    kind: row.kind,
    target: 'lifecycleRun.verifyTerminalClaims',
    targetAggregate: 'LifecycleRun',
    sourceInstanceId: row.sourceInstanceId,
    targetInstanceId: lifecycleId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `consume:${row.kind}:${lifecycleId}:${head === undefined ? 0 : head.revision}`,
    evidenceRefs: [...row.evidenceRefs],
  };
  const result = consumeClaim(session, claim, {}, { externalEvidence: config.externalEvidence, faults: config.faults });
  return settleStepOf('lifecycleRun.verifyTerminalClaims', lifecycleId, result);
}

/** lifecycleRun.issueTerminalProof (bounded; exempt operator/kernel command). */
export function issueLifecycleTerminal(session: KernelPersistenceSession, lifecycleId: InstanceId, outcome: TerminalOutcome, config: SettlementConfig): SettlementStep {
  const existing = session.hydrateWorld().world.heads.get(lifecycleId);
  if (existing !== undefined && existing.terminal !== undefined) {
    return { status: 'replayed', command: 'lifecycleRun.issueTerminalProof', instanceId: lifecycleId };
  }
  const head = existing;
  return applyBounded(
    session,
    {
      command: 'lifecycleRun.issueTerminalProof',
      instanceId: lifecycleId,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey: `settle:lifecycle-terminal:${lifecycleId}:${outcome}`,
      terminalOutcome: outcome,
    },
    config,
  );
}

/** factoryRun.recordRunTerminalProof (bounded; exempt; the run settlement). */
export function recordRunTerminal(session: KernelPersistenceSession, factoryId: InstanceId, outcome: TerminalOutcome, config: SettlementConfig): SettlementStep {
  const existing = session.hydrateWorld().world.heads.get(factoryId);
  if (existing !== undefined && existing.terminal !== undefined) {
    return { status: 'replayed', command: 'factoryRun.recordRunTerminalProof', instanceId: factoryId };
  }
  const head = existing;
  return applyBounded(
    session,
    {
      command: 'factoryRun.recordRunTerminalProof',
      instanceId: factoryId,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey: `settle:run-terminal:${factoryId}:${outcome}`,
      terminalOutcome: outcome,
    },
    config,
  );
}
