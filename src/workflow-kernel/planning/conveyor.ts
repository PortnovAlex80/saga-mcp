/**
 * workflow-kernel/planning/conveyor.ts - the planning-and-settlement scenario
 * composition (WP-09, plan phase EK-6).
 *
 * A STATELESS composition over durable facts, in the exact discipline of the
 * WP-07 driver: every step checks its own durable postcondition and every
 * key is deterministic, so re-driving a reopened database after ANY crash
 * converges to the identical logical outcome. It reads ONLY kernel surfaces
 * - repository public readers, the hydrated shared ledger and the WP-07
 * consumer - never a Kanban card, never a task status, never a clock.
 *
 * The composition proves the EK-6 topologies end to end:
 *
 *   planGraph (the complete authored graph) -> factory vertical -> per-cell
 *   node/workplace entry (planning tokens stamped as event evidence refs)
 *   -> readiness-gated WorkIntent admission -> author/reviewer desks ->
 *   settlement ladder (Node -> Process -> Stage -> Lifecycle -> Run) with
 *   success, truthful-failure, upstream-repair and unreachable outcomes.
 *
 * PURITY over the session: no direct SQL, no projection reads, no timers.
 */

import { createHash } from 'node:crypto';
import type { EvidenceFact, InstanceId, TypedRefusal } from '../domain/types.js';
import type { CommandName } from '../domain/universe.js';
import type { ConsumeInvocation, ConsumeResult, ObligationClaim } from '../application/obligation-consumer.js';
import { consumeClaim, openFrontier } from '../application/obligation-consumer.js';
import { commandFaultPoints } from '../application/faults.js';
import type { FaultScheduler } from '../application/faults.js';
import type { PromptBudgetLimits, ProviderRequestEnvelope } from '../application/admission.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import type { CanonicalRoleContractReference } from '../domain/types.js';
import { topologyBindings } from './bindings.js';
import { evaluateReadiness, type DependencyEdgeRow } from './readiness.js';
import { authorPlanGraph, type AuthoredPlanGraph } from './plan-graph.js';
import type { PlanningFactsInput, PlanningRefusal } from './facts.js';
import {
  applyBounded,
  consumeWithTopologyBinding,
  completeCellNode,
  propagateCellFailure,
  recordKernelResultForCell,
  recordNodeTerminal,
  recordRunTerminal,
  routeLifecycleOutcome,
  routeUpstreamRepair,
  settleDependantNodeUnreachable,
  settleProcessFailure,
  settleProcessSuccess,
  settleStageOutcome,
  verifyTerminalClaims,
  issueLifecycleTerminal,
  type SettlementConfig,
  type SettlementStep,
} from './settlement.js';

/* ------------------------------------------------------------------ */
/* Composition configuration                                           */
/* ------------------------------------------------------------------ */

export interface ConveyorOptions {
  /** The external Input-authority evidence (CheckPlan + verifier results). */
  readonly externalEvidence: readonly EvidenceFact[];
  /** Positive finite limits every attempt admission uses (profile-blind). */
  readonly limits: PromptBudgetLimits;
  readonly authorPin: CanonicalRoleContractReference;
  readonly reviewerPin: CanonicalRoleContractReference;
  readonly faults?: FaultScheduler;
}

export interface ConveyorDefaults {
  readonly externalEvidence: readonly EvidenceFact[];
  readonly limits: PromptBudgetLimits;
  readonly authorPin: CanonicalRoleContractReference;
  readonly reviewerPin: CanonicalRoleContractReference;
}

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Deterministic default pins/limits (same discipline as the WP-07 driver). */
export function conveyorDefaults(): ConveyorDefaults {
  return {
    externalEvidence: [
      { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input', payloadDigest: sha('checkplan') },
      { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: sha('pve') },
      { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: sha('pvf') },
    ],
    limits: {
      providerContextLimitTokens: 200000,
      reservedOutputTokens: 16000,
      providerOverheadReserveTokens: 2000,
      safetyMarginTokens: 2000,
      maxTotalInputTokens: 120000,
      maxCumulativeSessionInputTokens: 400000,
      maxProviderRequests: 20,
    },
    authorPin: { roleContractRef: `sha256:${sha('contract:author')}`, roleContractDigest: sha('contract:author:body') },
    reviewerPin: { roleContractRef: `sha256:${sha('contract:reviewer')}`, roleContractDigest: sha('contract:reviewer:body') },
  };
}

const configOf = (options: ConveyorOptions): SettlementConfig => ({ externalEvidence: options.externalEvidence, faults: options.faults });

/* ------------------------------------------------------------------ */
/* World helpers (durable reads only)                                  */
/* ------------------------------------------------------------------ */

const worldOf = (session: KernelPersistenceSession) => session.hydrateWorld().world;

function headOfAggregate(session: KernelPersistenceSession, aggregate: string): InstanceId | undefined {
  let latest: InstanceId | undefined;
  for (const head of worldOf(session).heads.values()) {
    if (head.aggregate === aggregate) latest = head.instanceId;
  }
  return latest;
}

const freshId = (session: KernelPersistenceSession, aggregate: string, prefix: string): string => `${prefix}:${(worldOf(session).instanceCounters[aggregate] ?? 0) + 1}`;

/** The frontier entry of one exact target command (the claimable lane head). */
export function frontierEntryOf(session: KernelPersistenceSession, target: CommandName) {
  return openFrontier(session).find((entry) => entry.target === target);
}

/**
 * Consume the frontier obligation of one exact target command. The engine
 * completes the lane's FIFO head row inside the command's transaction (a
 * lane may hold stray rows of other cycles - e.g. the reviewer-cycle author
 * gate row); `pinnedInstanceId` therefore names the instance the COMMAND
 * applies to, which is not always the FIFO head row's own source instance.
 */
export function consumeTarget(session: KernelPersistenceSession, target: CommandName, invocation: ConsumeInvocation, options: ConveyorOptions, pinnedInstanceId?: InstanceId): ConsumeResult | { readonly unresolvable: true; readonly detail: string } | { readonly idle: true } {
  const entry = frontierEntryOf(session, target);
  if (entry === undefined) return { idle: true };
  if (entry.claim === undefined) return { unresolvable: true, detail: (entry.refusal as TypedRefusal).detail };
  const claim = pinnedInstanceId === undefined ? entry.claim : pinClaim(session, entry.claim, pinnedInstanceId);
  for (const point of commandFaultPoints(target)) {
    if (point.startsWith('before-')) options.faults?.fire(point);
  }
  const result = consumeClaim(session, claim, invocation, { externalEvidence: options.externalEvidence, faults: options.faults });
  for (const point of commandFaultPoints(target)) {
    if (point.startsWith('after-')) options.faults?.fire(point);
  }
  return result;
}

/** Re-pin a claim's command target (the completed row stays the FIFO head). */
function pinClaim(session: KernelPersistenceSession, claim: ObligationClaim, instanceId: InstanceId): ObligationClaim {
  const head = worldOf(session).heads.get(instanceId);
  const expectedRevision = head === undefined ? 0 : head.revision;
  return {
    ...claim,
    targetInstanceId: instanceId,
    expectedRevision,
    idempotencyKey: claim.idempotencyKey + '@' + instanceId + '@' + String(expectedRevision),
  };
}

/** True when the transition's event already committed for this instance. */
export function eventExists(session: KernelPersistenceSession, command: CommandName, instanceId: InstanceId, withEvidenceRef?: string): boolean {
  return worldOf(session).events.some(
    (event) => event.transition === command && event.sourceInstanceId === instanceId && (withEvidenceRef === undefined || event.evidenceRefs.includes(withEvidenceRef)),
  );
}

/** True when the instance's head reached (or passed) the given status. */
export function statusReached(session: KernelPersistenceSession, instanceId: InstanceId, status: string): boolean {
  const head = worldOf(session).heads.get(instanceId);
  return head !== undefined && (head.status === status || head.terminal !== undefined);
}

/** Direct bounded application of an exempt/kernel command through its owner. */
export function ensureCommand(
  session: KernelPersistenceSession,
  command: CommandName,
  instanceId: InstanceId,
  idempotencyKey: string,
  fields: { evidenceRefs?: readonly string[]; protocolRole?: 'author' | 'reviewer'; rolePin?: CanonicalRoleContractReference; workIntentRef?: string; terminalOutcome?: 'success' | 'truthful-failure' | 'cancellation' | 'unreachable' },
  options: ConveyorOptions,
  done?: (session: KernelPersistenceSession) => boolean,
): SettlementStep {
  // Stateless discipline: a step whose durable postcondition already holds
  // is skipped, never re-applied (re-drive after any crash converges).
  if (done !== undefined && done(session)) {
    return { status: 'replayed', command, instanceId };
  }
  const head = worldOf(session).heads.get(instanceId);
  return applyBounded(
    session,
    {
      command,
      instanceId,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey,
      ...(fields.evidenceRefs !== undefined ? { evidenceRefs: [...fields.evidenceRefs] } : {}),
      ...(fields.protocolRole !== undefined ? { protocolRole: fields.protocolRole } : {}),
      ...(fields.rolePin !== undefined ? { rolePin: fields.rolePin } : {}),
      ...(fields.workIntentRef !== undefined ? { workIntentRef: fields.workIntentRef } : {}),
      ...(fields.terminalOutcome !== undefined ? { terminalOutcome: fields.terminalOutcome } : {}),
    },
    configOf(options),
  );
}

/** Default postcondition: the command's event committed for the instance. */
export const eventDone =
  (command: CommandName, instanceId: InstanceId, withEvidenceRef?: string) =>
  (session: KernelPersistenceSession): boolean =>
    eventExists(session, command, instanceId, withEvidenceRef);

/* ------------------------------------------------------------------ */
/* Stage 1: the immutable planning graph                               */
/* ------------------------------------------------------------------ */

export interface PlannedCommit {
  readonly authored: AuthoredPlanGraph;
  readonly committedItemIds: readonly string[];
}

/** Commit the authored plan graph: one workItem.planGraph per item (immutable). */
export function commitPlanGraph(session: KernelPersistenceSession, facts: PlanningFactsInput): PlannedCommit | PlanningRefusal {
  const authored = authorPlanGraph(facts);
  if ('refused' in authored) return authored;
  const committed: string[] = [];
  for (const item of authored.workItems) {
    if (session.workItem.loadHead(item.instanceId) !== undefined) {
      committed.push(item.instanceId); // immutable fact already committed (re-drive)
      continue;
    }
    const outcome = session.workItem.applyCommand(item.command, { dependencyEdges: item.dependencyEdges });
    if ('refused' in outcome) {
      throw new Error(`conveyor: workItem.planGraph refused for ${item.itemRef}: ${outcome.reason}: ${outcome.detail}`);
    }
    committed.push(item.instanceId);
  }
  return { authored, committedItemIds: committed };
}

/* ------------------------------------------------------------------ */
/* Stage 2: the factory vertical                                       */
/* ------------------------------------------------------------------ */

export interface VerticalIds {
  readonly factory: InstanceId;
  readonly lifecycle: InstanceId;
  readonly stage: InstanceId;
  readonly process: InstanceId;
}

/** Drive bootstrap -> capsule -> planning -> start -> lifecycle -> stage -> process. */
export function bootstrapVertical(session: KernelPersistenceSession, facts: PlanningFactsInput, options: ConveyorOptions): VerticalIds | PlanningRefusal {
  const factory = 'factory-run:1';
  const step = ensureCommand(session, 'factoryRun.bootstrap', factory, 'conveyor:bootstrap', {}, options, eventDone('factoryRun.bootstrap', factory));
  if (step.status === 'refused') throw new Error(`conveyor: bootstrap refused: ${step.refusal.detail}`);
  ensureCommand(session, 'factoryRun.importCapsule', factory, 'conveyor:import-capsule', {}, options, eventDone('factoryRun.importCapsule', factory));
  // The capsule carries the planning inputs (idea/claims/unknowns/surfaces);
  // the planning graph commits from them before the run starts.
  const planned = commitPlanGraph(session, facts);
  if ('refused' in planned) return planned;
  consumeTarget(session, 'factoryRun.start', {}, options);
  consumeTarget(session, 'lifecycleRun.create', {}, options);
  consumeTarget(session, 'stageRun.create', {}, options);
  const lifecycle = headOfAggregate(session, 'LifecycleRun') ?? 'lifecycle-run:1';
  const stage = headOfAggregate(session, 'StageRun') ?? 'stage-run:1';
  ensureCommand(session, 'stageRun.activate', stage, 'conveyor:activate-stage', {}, options, eventDone('stageRun.activate', stage));
  consumeTarget(session, 'processRun.create', {}, options);
  const process = headOfAggregate(session, 'ProcessRun') ?? 'process-run:1';
  return { factory, lifecycle, stage, process };
}

/* ------------------------------------------------------------------ */
/* Stage 3: cells (node + workplace entry with planning tokens)         */
/* ------------------------------------------------------------------ */

export interface CellRuntime {
  readonly itemRef: string;
  readonly itemInstanceId: string;
  readonly token: string;
  node?: InstanceId;
  workplace?: InstanceId;
  outcome?: 'success' | 'truthful-failure' | 'upstream-repair';
}

/** Enter one cell: flow advance + nodeRun.create + materializeCell + workplace. */
export function enterCell(session: KernelPersistenceSession, cell: CellRuntime, options: ConveyorOptions): CellRuntime {
  // Stateless: a cell whose token already holds a node and a workplace is
  // entered (re-drive after any crash re-derives the same binding).
  const holders = topologyBindings(worldOf(session)).tokenHolders(cell.token);
  if (holders.nodes.length > 0 && holders.workplaces.length > 0) {
    return { ...cell, node: holders.nodes[0], workplace: holders.workplaces[0] };
  }
  // Both enterNode lanes (obligation:enterFirstNode and
  // obligation:advanceProcessFlow) target processRun.enterNode; the frontier
  // discipline picks the one open row of that target.
  const entry = consumeTarget(session, 'processRun.enterNode', {}, options);
  if ('unresolvable' in entry) throw new Error(`conveyor: enterNode unresolvable: ${entry.detail}`);
  if ('idle' in entry) throw new Error('conveyor: no open enterNode obligation (flow exhausted)');
  const node = freshId(session, 'NodeRun', 'node-run');
  ensureCommand(session, 'nodeRun.create', node, `conveyor:create-node:${cell.itemRef}`, { evidenceRefs: [cell.token] }, options);
  ensureCommand(session, 'nodeRun.materializeCell', node, `conveyor:materialize-cell:${cell.itemRef}`, { evidenceRefs: [cell.token] }, options);
  const materialize = consumeTarget(session, 'workplace.materialize', {}, options);
  if ('unresolvable' in materialize) throw new Error(`conveyor: workplace materialization unresolvable: ${materialize.detail}`);
  if ('idle' in materialize) throw new Error('conveyor: no open workplace.materialize obligation');
  const workplace = topologyBindings(worldOf(session)).tokenHolders(cell.token).workplaces[0];
  if (workplace === undefined) throw new Error(`conveyor: no workplace materialized for token ${cell.token}`);
  return { ...cell, node, workplace };
}

/* ------------------------------------------------------------------ */
/* Stage 4: readiness-gated intent admission + the author/reviewer desk  */
/* ------------------------------------------------------------------ */

export type DeskOutcome = 'success' | 'truthful-failure' | 'upstream-repair';

/** Admit the author WorkIntent of one cell (readiness-gated, refs as evidence). */
export function admitCellIntent(
  session: KernelPersistenceSession,
  cell: CellRuntime,
  edges: readonly DependencyEdgeRow[],
  options: ConveyorOptions,
  force?: { readonly waitForReadiness: true },
): { readonly readiness: 'ready' | 'waiting' | 'unreachable'; readonly refs: readonly string[] } {
  if (cell.workplace === undefined) throw new Error('conveyor: cell has no workplace');
  const alreadyAdmitted = [...worldOf(session).workIntents.values()].some(
    (intent) => intent.workplaceInstanceId === cell.workplace && intent.protocolRole === 'author',
  );
  if (alreadyAdmitted) {
    return { readiness: force?.waitForReadiness ? 'waiting' : 'ready', refs: [] };
  }
  const bindings = topologyBindings(worldOf(session));
  const readiness = evaluateReadiness(edges, bindings, cell.itemInstanceId);
  const refs =
    force?.waitForReadiness || readiness.state !== 'ready'
      ? []
      : [cell.itemInstanceId, ...readiness.inputEvidenceRefs];
  const invocation: ConsumeInvocation = { protocolRole: 'author', rolePin: options.authorPin, evidenceRefs: refs };
  // D10: the item's own author admission discharges its openUnknownObligation
  // row (the unknown cannot disappear; its owner admits work for it). When no
  // unknown row is open (re-drive, already discharged), the exempt direct
  // path applies. The lane is admitWorkIntent; the engine completes its
  // FIFO head inside the same transaction either way.
  const admitted = consumeWithTopologyBinding(
    session,
    {
      kind: 'obligation:openUnknownObligation',
      expectedTarget: 'workplace.admitWorkIntent',
      resolveTargetInstanceId: () => cell.workplace,
      invocation,
    },
    configOf(options),
  );
  if (admitted.status === 'none' || admitted.status === 'unresolved') {
    ensureCommand(session, 'workplace.admitWorkIntent', cell.workplace, `conveyor:admit-author:${cell.itemRef}`, invocation, options);
  }
  return { readiness: readiness.state, refs };
}

const envelopeOf = (attempt: InstanceId): ProviderRequestEnvelope => ({
  providerModel: 'zai/opencode-pin',
  requestInputTokens: 5000,
  envelopeDigest: `sha256:${sha(`envelope:${attempt}`)}`,
});

/**
 * One cognition attempt round: create -> admission -> send -> outcome. The
 * attempt id is derived from the WorkIntent (deterministic across re-drives);
 * each step is skipped when its durable postcondition already holds.
 */
export function runAttempt(session: KernelPersistenceSession, workplaceId: InstanceId, role: 'author' | 'reviewer', pin: CanonicalRoleContractReference, options: ConveyorOptions): InstanceId {
  const world = worldOf(session);
  const intent = [...world.workIntents.values()].find((entry) => entry.workplaceInstanceId === workplaceId && entry.protocolRole === role);
  if (intent === undefined) throw new Error(`conveyor: no ${role} intent on ${workplaceId}`);
  const attempt = `activity-attempt:${intent.intentRef.replace(/^evidence:WorkIntent#/, 'wi-')}`;
  const status = worldOf(session).heads.get(attempt)?.status;
  if (status === undefined) {
    ensureCommand(session, 'activityAttempt.create', attempt, `conveyor:attempt:${attempt}`, { workIntentRef: intent.intentRef, rolePin: pin }, options);
  }
  if (status !== 'provider-request-admitted' && status !== 'outcome-recorded') {
    const admission = consumeTarget(session, 'activityAttempt.admitProviderRequest', { admission: { envelope: envelopeOf(attempt), limits: options.limits } }, options, attempt);
    if ('unresolvable' in admission) throw new Error(`conveyor: admission unresolvable: ${admission.detail}`);
    consumeTarget(session, 'cognition.sendProviderRequest', {}, options);
  }
  if (status !== 'outcome-recorded') {
    ensureCommand(session, 'activityAttempt.recordOutcome', attempt, `conveyor:outcome:${attempt}`, { evidenceRefs: [intent.intentRef] }, options, eventDone('activityAttempt.recordOutcome', attempt));
  }
  return attempt;
}

/**
 * The desk status ladder (drives step skipping on re-drives; each entry is
 * the head status AT WHICH the named step still has to run).
 */
interface DeskStep {
  readonly atStatus: readonly string[];
  /** The desk outcomes this step serves (default: every outcome). */
  readonly for?: readonly DeskOutcome[];
  readonly run: (session: KernelPersistenceSession, workplace: InstanceId, cell: CellRuntime, outcome: DeskOutcome, options: ConveyorOptions) => void;
}

const DESK_LADDER: readonly DeskStep[] = [
  {
    atStatus: ['author-intent-admitted'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.recordContribution', {}, options, workplace);
    },
  },
  {
    atStatus: ['author-contribution-recorded'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.sealProductionRevision', {}, options, workplace);
    },
  },
  {
    atStatus: ['author-revision-sealed'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.presentCandidateSet', {}, options, workplace);
    },
  },
  {
    atStatus: ['author-candidates-presented'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.runAuthorGate', { gateVerdict: 'accepted' }, options, workplace);
    },
  },
  {
    atStatus: ['author-gate-decided'],
    run: (session, workplace, cell, _outcome, options) => {
      // The reviewer desk opens through its own kind-targeted claim on the
      // openReviewerDesk edge (the admitWorkIntent lane may still hold later
      // items' openUnknownObligation rows at its FIFO head - the engine
      // completes the lane head inside this same transaction either way).
      const desk = consumeWithTopologyBinding(
        session,
        {
          kind: 'obligation:openReviewerDesk',
          expectedTarget: 'workplace.admitWorkIntent',
          resolveTargetInstanceId: () => workplace,
          invocation: { protocolRole: 'reviewer', rolePin: options.reviewerPin, evidenceRefs: [cell.itemInstanceId] },
        },
        configOf(options),
      );
      if (desk.status === 'none' || desk.status === 'unresolved') {
        ensureCommand(session, 'workplace.admitWorkIntent', workplace, `conveyor:admit-reviewer:${cell.itemRef}`, { protocolRole: 'reviewer', rolePin: options.reviewerPin, evidenceRefs: [cell.itemInstanceId] }, options);
      }
    },
  },
  {
    atStatus: ['reviewer-intent-admitted'],
    run: (session, workplace, _cell, _outcome, options) => {
      runAttempt(session, workplace, 'reviewer', options.reviewerPin, options);
      consumeTarget(session, 'workplace.recordContribution', {}, options, workplace);
    },
  },
  {
    atStatus: ['reviewer-contribution-recorded'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.sealProductionRevision', {}, options, workplace);
    },
  },
  {
    atStatus: ['reviewer-revision-sealed'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.presentCandidateSet', {}, options, workplace);
    },
  },
  {
    atStatus: ['reviewer-candidates-presented'],
    run: (session, workplace, _cell, outcome, options) => {
      const finalVerdict = outcome === 'success' ? 'accepted' : outcome === 'truthful-failure' ? 'repair' : 'upstream-repair';
      consumeTarget(session, 'workplace.runFinalGate', { gateVerdict: finalVerdict }, options, workplace);
    },
  },
  {
    atStatus: ['final-gate-decided'],
    for: ['success'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.settleEffect', { effectOutcome: 'success' }, options, workplace);
    },
  },
  {
    atStatus: ['effect-settled', 'final-gate-decided'],
    for: ['success'],
    run: (session, workplace, cell, _outcome, options) => {
      ensureCommand(session, 'workplace.recordFinalAcceptance', workplace, `conveyor:final-acceptance:${cell.itemRef}`, {}, options, eventDone('workplace.recordFinalAcceptance', workplace));
    },
  },
  {
    atStatus: ['final-acceptance-recorded'],
    run: (session, workplace, _cell, _outcome, options) => {
      consumeTarget(session, 'workplace.closePresentation', {}, options, workplace);
    },
  },
  {
    atStatus: ['presentation-closed'],
    for: ['success'],
    run: (session, workplace, cell, _outcome, options) => {
      ensureCommand(session, 'workplace.issueWorkplaceTerminalProof', workplace, `conveyor:workplace-terminal:${cell.itemRef}`, { terminalOutcome: 'success' }, options, eventDone('workplace.issueWorkplaceTerminalProof', workplace));
    },
  },
  {
    atStatus: ['final-gate-decided'],
    for: ['truthful-failure'],
    run: (session, workplace, cell, _outcome, options) => {
      // D6 repair-epoch terminality -> workplace truthful-failure proof.
      ensureCommand(session, 'workplace.enterRepairWait', workplace, `conveyor:repair-wait:${cell.itemRef}`, {}, options, eventDone('workplace.enterRepairWait', workplace));
    },
  },
  {
    atStatus: ['repair-wait-entered'],
    for: ['truthful-failure', 'upstream-repair'],
    run: (session, workplace, cell, _outcome, options) => {
      ensureCommand(session, 'workplace.rolloverRepairEpoch', workplace, `conveyor:rollover:${cell.itemRef}`, { terminalOutcome: 'truthful-failure' }, options, eventDone('workplace.rolloverRepairEpoch', workplace));
    },
  },
  {
    atStatus: ['repair-epoch-rolled-over'],
    for: ['truthful-failure', 'upstream-repair'],
    run: (session, workplace, cell, _outcome, options) => {
      ensureCommand(session, 'workplace.issueWorkplaceTerminalProof', workplace, `conveyor:workplace-terminal:${cell.itemRef}`, { terminalOutcome: 'truthful-failure' }, options, eventDone('workplace.issueWorkplaceTerminalProof', workplace));
    },
  },
];

/** Drive one full author -> reviewer desk on a cell workplace (stateless). */
export function runDesk(session: KernelPersistenceSession, cell: CellRuntime, outcome: DeskOutcome, options: ConveyorOptions): void {
  if (cell.workplace === undefined) throw new Error('conveyor: cell has no workplace');
  const workplace = cell.workplace;
  runAttempt(session, workplace, 'author', options.authorPin, options);
  for (let round = 0; round < DESK_LADDER.length + 2; round += 1) {
    const status = worldOf(session).heads.get(workplace)?.status;
    if (status === undefined || status === 'terminal') return;
    const step = DESK_LADDER.find((entry) => entry.atStatus.includes(status) && (entry.for === undefined || entry.for.includes(outcome)));
    if (step === undefined) return;
    step.run(session, workplace, cell, outcome, options);
  }
  throw new Error(`conveyor: desk on ${workplace} did not converge (status ${worldOf(session).heads.get(workplace)?.status})`);
}

/* ------------------------------------------------------------------ */
/* Stage 5: the settlement ladder                                      */
/* ------------------------------------------------------------------ */

/** Settle one SUCCESS cell's node: flow terminal -> kernel result -> acceptance. */
export function settleCellNode(session: KernelPersistenceSession, ids: VerticalIds, cell: CellRuntime, options: ConveyorOptions): void {
  if (cell.workplace === undefined || cell.node === undefined) throw new Error('conveyor: cell not entered');
  const bindings = topologyBindings(worldOf(session));
  const refs = [cell.token, ...bindings.acceptanceRefsOfWorkplace(cell.workplace)];
  const terminal = recordNodeTerminal(session, ids.process, refs, configOf(options), cell.token);
  if (terminal.status === 'refused') throw new Error(`conveyor: recordNodeTerminal refused: ${terminal.refusal.detail}`);
  const kernel = recordKernelResultForCell(session, cell.workplace, configOf(options));
  if ('status' in kernel && kernel.status === 'refused') throw new Error(`conveyor: recordKernelResult refused: ${kernel.refusal.detail}`);
  if ('status' in kernel && kernel.status === 'unresolved') throw new Error(`conveyor: recordKernelResult unresolved: ${kernel.detail}`);
  const acceptance = completeCellNode(session, cell.workplace, configOf(options));
  if ('status' in acceptance && acceptance.status === 'refused') throw new Error(`conveyor: recordCellAcceptance refused: ${acceptance.refusal.detail}`);
  if ('status' in acceptance && acceptance.status === 'unresolved') throw new Error(`conveyor: recordCellAcceptance unresolved: ${acceptance.detail}`);
}

/** The full success ladder for the last cell: process -> stage -> lifecycle -> run. */
export function settleSuccessLadder(session: KernelPersistenceSession, ids: VerticalIds, options: ConveyorOptions): void {
  const settle = settleProcessSuccess(session, ids.process, configOf(options));
  if ('status' in settle && settle.status === 'refused') throw new Error(`conveyor: process settle refused: ${settle.refusal.detail}`);
  if ('status' in settle && settle.status === 'unresolved') throw new Error(`conveyor: process settle unresolved: ${settle.detail}`);
  const stage = settleStageOutcome(session, ids.process, 'success', configOf(options));
  if ('status' in stage && stage.status === 'refused') throw new Error(`conveyor: stage outcome refused: ${stage.refusal.detail}`);
  const route = routeLifecycleOutcome(session, ids.stage, 'verify-terminal-claims', configOf(options));
  if ('status' in route && route.status === 'refused') throw new Error(`conveyor: lifecycle route refused: ${route.refusal.detail}`);
  const verify = verifyTerminalClaims(session, ids.lifecycle, configOf(options));
  if ('status' in verify && verify.status === 'refused') throw new Error(`conveyor: verifyTerminalClaims refused: ${verify.refusal.detail}`);
  const lifecycle = issueLifecycleTerminal(session, ids.lifecycle, 'success', configOf(options));
  if (lifecycle.status === 'refused') throw new Error(`conveyor: lifecycle terminal refused: ${lifecycle.refusal.detail}`);
  const run = recordRunTerminal(session, ids.factory, 'success', configOf(options));
  if (run.status === 'refused') throw new Error(`conveyor: run terminal refused: ${run.refusal.detail}`);
}

/**
 * The truthful-failure ladder: node fail -> process -> stage -> lifecycle ->
 * run. `flowAlreadyAdvanced` skips the recordNodeTerminal step when the flow
 * cursor already advanced past this node (e.g. a dependant cell entered
 * before the failure settled).
 */
export function settleFailureLadder(session: KernelPersistenceSession, ids: VerticalIds, failedCell: CellRuntime, options: ConveyorOptions, flowAlreadyAdvanced = false): void {
  if (failedCell.workplace === undefined) throw new Error('conveyor: failed cell not entered');
  const failure = propagateCellFailure(session, failedCell.workplace, configOf(options));
  if ('status' in failure && failure.status === 'refused') throw new Error(`conveyor: nodeRun.fail refused: ${failure.refusal.detail}`);
  if ('status' in failure && failure.status === 'unresolved') throw new Error(`conveyor: nodeRun.fail unresolved: ${failure.detail}`);
  const node = failedCell.node;
  if (node === undefined) throw new Error('conveyor: failed cell has no node');
  const nodeRefs = [...(worldOf(session).events.find((event) => event.transition === 'nodeRun.fail' && event.sourceInstanceId === node)?.evidenceRefs ?? [])];
  if (!flowAlreadyAdvanced) {
    const terminal = recordNodeTerminal(session, ids.process, [failedCell.token, ...nodeRefs], configOf(options));
    if (terminal.status === 'refused') throw new Error(`conveyor: recordNodeTerminal refused: ${terminal.refusal.detail}`);
  }
  const process = settleProcessFailure(session, node, configOf(options));
  if ('status' in process && process.status === 'refused') throw new Error(`conveyor: settleFailure refused: ${process.refusal.detail}`);
  if ('status' in process && process.status === 'unresolved') throw new Error(`conveyor: settleFailure unresolved: ${process.detail}`);
  const stage = settleStageOutcome(session, ids.process, 'truthful-failure', configOf(options));
  if ('status' in stage && stage.status === 'refused') throw new Error(`conveyor: stage failure refused: ${stage.refusal.detail}`);
  const route = routeLifecycleOutcome(session, ids.stage, 'verify-terminal-claims', configOf(options));
  if ('status' in route && route.status === 'refused') throw new Error(`conveyor: lifecycle route refused: ${route.refusal.detail}`);
  const lifecycle = issueLifecycleTerminal(session, ids.lifecycle, 'truthful-failure', configOf(options));
  if (lifecycle.status === 'refused') throw new Error(`conveyor: lifecycle terminal refused: ${lifecycle.refusal.detail}`);
  const run = recordRunTerminal(session, ids.factory, 'truthful-failure', configOf(options));
  if (run.status === 'refused') throw new Error(`conveyor: run terminal refused: ${run.refusal.detail}`);
}

/** Settle a dependant cell unreachable after a terminally failed predecessor (D7). */
export function settleDependantUnreachable(session: KernelPersistenceSession, dependant: CellRuntime, options: ConveyorOptions): void {
  if (dependant.workplace === undefined) throw new Error('conveyor: dependant cell not entered');
  ensureCommand(
    session,
    'workplace.issueWorkplaceTerminalProof',
    dependant.workplace,
    `conveyor:workplace-unreachable:${dependant.itemRef}`,
    { terminalOutcome: 'unreachable' },
    options,
  );
  const node = settleDependantNodeUnreachable(session, dependant.workplace, configOf(options));
  if ('status' in node && node.status === 'refused') throw new Error(`conveyor: settleUnreachable refused: ${node.refusal.detail}`);
  if ('status' in node && node.status === 'unresolved') throw new Error(`conveyor: settleUnreachable unresolved: ${node.detail}`);
}

/** Route an upstream-repair verdict to the owning upstream cell's process (R1). */
export function settleUpstreamRepair(session: KernelPersistenceSession, upstream: CellRuntime, options: ConveyorOptions): void {
  if (upstream.workplace === undefined) throw new Error('conveyor: upstream cell not entered');
  const routed = routeUpstreamRepair(session, upstream.workplace, configOf(options));
  if ('status' in routed && routed.status === 'refused') throw new Error(`conveyor: upstream repair refused: ${routed.refusal.detail}`);
  if ('status' in routed && routed.status === 'unresolved') throw new Error(`conveyor: upstream repair unresolved: ${routed.detail}`);
}

/** Commit the dependency edges the authored graph declared (edge rows are per-item commits in planGraph). */
export function dependencyRowsOf(session: KernelPersistenceSession): readonly DependencyEdgeRow[] {
  return session.workItem.loadDependencies().map((row) => ({ workItemRef: row.workItemRef, dependsOnRef: row.dependsOnRef }));
}


/* ------------------------------------------------------------------ */
/* Topology fixtures (deterministic complete planning facts)            */
/* ------------------------------------------------------------------ */

export type TopologyId = 'chain' | 'diamond' | 'fan-out' | 'fan-in' | 'independent' | 'failed-predecessor' | 'upstream-repair';

/** The declared dependency shape of one EK-6 topology (item -> dependsOn). */
export function topologyShape(topology: TopologyId): readonly { readonly itemRef: string; readonly dependsOn: readonly string[] }[] {
  switch (topology) {
    case 'chain':
      return [
        { itemRef: 'a', dependsOn: [] },
        { itemRef: 'b', dependsOn: ['a'] },
        { itemRef: 'c', dependsOn: ['b'] },
      ];
    case 'diamond':
      return [
        { itemRef: 'a', dependsOn: [] },
        { itemRef: 'b', dependsOn: ['a'] },
        { itemRef: 'c', dependsOn: ['a'] },
        { itemRef: 'd', dependsOn: ['b', 'c'] },
      ];
    case 'fan-out':
      return [
        { itemRef: 'a', dependsOn: [] },
        { itemRef: 'b', dependsOn: ['a'] },
        { itemRef: 'c', dependsOn: ['a'] },
      ];
    case 'fan-in':
      return [
        { itemRef: 'a', dependsOn: [] },
        { itemRef: 'b', dependsOn: [] },
        { itemRef: 'c', dependsOn: ['a', 'b'] },
      ];
    case 'independent':
      return [
        { itemRef: 'a', dependsOn: [] },
        { itemRef: 'b', dependsOn: [] },
      ];
    case 'failed-predecessor':
      return [
        { itemRef: 'a', dependsOn: [] },
        { itemRef: 'b', dependsOn: ['a'] },
      ];
    case 'upstream-repair':
      return [
        { itemRef: 'a', dependsOn: [] },
        { itemRef: 'b', dependsOn: [] },
      ];
  }
}

/**
 * Build the COMPLETE planning facts of one topology: scope items, one
 * explicit deferral, open unknowns, terminal claims, construction surfaces
 * (module + test), cross-module seams and one acceptance criterion per item
 * - the full idea/claim/unknown/integration graph, never ACs alone.
 */
export function factsForTopology(topology: TopologyId): PlanningFactsInput {
  const shape = topologyShape(topology);
  const planningRef = `ek-wp09-${topology}`;
  return {
    planningRef,
    idea: { ideaRef: `idea:${planningRef}`, statement: `The ${topology} product idea.` },
    scopeItems: [
      ...shape.map((item, index) => ({ scopeRef: `scope:${item.itemRef}`, statement: `Declared scope ${index + 1} of the ${topology} idea.` })),
      { scopeRef: 'scope:deferred', statement: 'A declared scope item the epic explicitly defers.' },
    ],
    unknowns: shape.map((item) => ({ unknownRef: `unknown:${item.itemRef}`, question: `Which ${topology} shape satisfies item ${item.itemRef}?` })),
    terminalClaims: shape.map((item) => ({ claimRef: `claim:${item.itemRef}`, statement: `Terminal claim of item ${item.itemRef}.` })),
    constructionSurfaces: shape.flatMap((item) => [
      { surfaceRef: `surface:${item.itemRef}.module`, kind: 'module-surface' as const, description: `Module surface of item ${item.itemRef}.` },
      { surfaceRef: `surface:${item.itemRef}.test`, kind: 'test-surface' as const, description: `Test surface of item ${item.itemRef}.` },
    ]),
    integrationSeams: shape
      .filter((item) => item.dependsOn.length > 0)
      .map((item) => ({
        seamRef: `seam:${item.itemRef}`,
        leftScopeRef: `scope:${item.dependsOn[0]}`,
        rightScopeRef: `scope:${item.itemRef}`,
        description: `Cross-module seam between ${item.dependsOn[0]} and ${item.itemRef}.`,
      })),
    acceptanceCriteria: shape.map((item) => ({ criterionRef: `ac:${item.itemRef}`, statement: `Acceptance criterion of item ${item.itemRef}.` })),
    deferredScope: [{ scopeRef: 'scope:deferred', owner: 'operator', reason: 'explicitly deferred at planning (owner + reason recorded)' }],
    workItems: shape.map((item) => ({
      itemRef: item.itemRef,
      title: `Work item ${item.itemRef}`,
      coversScope: [`scope:${item.itemRef}`],
      ownsUnknowns: [`unknown:${item.itemRef}`],
      ownsSurfaces: [`surface:${item.itemRef}.module`, `surface:${item.itemRef}.test`],
      ownsSeams: item.dependsOn.length > 0 ? [`seam:${item.itemRef}`] : [],
      ownsClaims: [`claim:${item.itemRef}`],
      verifiesClaims: [`claim:${item.itemRef}`],
      verificationSurfaces: [`surface:${item.itemRef}.test`],
      obligations: ['implement', 'verify'],
      dependsOn: [...item.dependsOn],
    })),
  };
}

/** Cell runtime descriptors of one topology in authored (topological) order. */
export function cellsForTopology(topology: TopologyId, facts?: PlanningFactsInput): CellRuntime[] {
  const resolved = facts ?? factsForTopology(topology);
  return resolved.workItems.map((item) => ({
    itemRef: item.itemRef,
    itemInstanceId: `work-item:${item.itemRef}`,
    token: `plan:${resolved.planningRef}#item:${item.itemRef}`,
  }));
}

export { authorPlanGraph };
