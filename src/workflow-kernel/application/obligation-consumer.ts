/**
 * workflow-kernel/application/obligation-consumer.ts - the stateless, replaceable
 * obligation consumer (WP-07, plan phase EK-4; the one implementation the
 * EK-1 complexity budget's composition.obligationConsumerImplementations
 * dimension counts, target exact:1).
 *
 * Plan law "Durable handoff", the consumer protocol:
 *
 *   claim ONE exact obligation (CAS lease discipline + fence)
 *     -> revalidate the exact target aggregate revision
 *     -> invoke the target aggregate command with exact evidence references
 *     -> the OWNING repository's single transaction commits:
 *          target fact/evidence
 *          + obligation completion receipt (open -> completed)
 *          + next obligations | typed wait | terminal proof
 *
 * Ownership and fences (all inside the sole-writer transaction, so a stale
 * or duplicate consumer can never complete twice):
 *   - FRONTIER CLAIM ORDER: the pure engine completes the FIRST open
 *     obligation whose target equals the invoked command, so the consumer
 *     only ever claims, for each distinct target command, the LOWEST-id open
 *     obligation of that target (the claimable frontier). The completed row
 *     is then exactly the claimed row - the consumer never completes
 *     another lane's obligation out of order, and lower-id obligations of
 *     OTHER targets never interfere;
 *   - CAS LEASE: the obligation's open->completed transition is guarded by
 *     `WHERE state = 'open'` plus the UNIQUE completed_by_key index; there
 *     is deliberately NO separate lease authority - the consumer owns no
 *     run-wide truth, and a lease table would be one;
 *   - FENCE: the command's expectedRevision revalidates the exact target
 *     aggregate revision inside the transaction; after a rival commit moved
 *     the head, the stale consumer's command is refused
 *     STALE_EXPECTED_REVISION and the completion rolls back with it;
 *   - IDEMPOTENCE: the consume key is `consume:<obligation idempotency key>`
 *     - deterministic per obligation row - so any retry (same or another
 *     consumer process, before or after a crash) replays or is refused
 *     against the already-completed state instead of committing a second
 *     fact.
 *
 * Empty queue: an empty frontier is IDLE - never progress, never a terminal
 * proof (the engine's law: empty work is not a proof). No busy-spin: every
 * frontier obligation gets at most one consume attempt per round, a round
 * without progress ends the run blocked with the exact typed refusals, and
 * there are no timers, no heartbeats and no board reads in this module.
 *
 * No workshop-specific transition branch: instance resolution uses only the
 * frozen vocabulary - the obligation row, aggregate ownership, creation
 * command detection, the well-known transport singleton, admitted WorkIntent
 * evidence, and the failed attempt's pinned WorkIntent for retries.
 */

import type {
  AggregateHead,
  CanonicalRoleContractReference,
  CommandInput,
  CommandOutcome,
  EffectOutcome,
  EvidenceFact,
  GateVerdict,
  InstanceId,
  ObligationRecord,
  ProtocolRole,
  StageRoute,
  TerminalOutcome,
  TypedRefusal,
  WorkIntent,
} from '../domain/types.js';
import type { AggregateName, CommandName, ObligationKind } from '../domain/universe.js';
import { reducerForCommand } from '../domain/reducers/index.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import { COGNITION_TRANSPORT_INSTANCE_ID } from '../persistence/kernel-ledger.js';
import { admitProviderRequest, type PromptBudgetLimits, type ProviderRequestEnvelope } from './admission.js';
import { commandFaultPoints, type FaultScheduler } from './faults.js';

/* ------------------------------------------------------------------ */
/* Repository routing (sole-writer law: the owning repository applies)   */
/* ------------------------------------------------------------------ */

/** The sole-writer repository of one aggregate (never a foreign writer). */
export function repositoryOf(session: KernelPersistenceSession, aggregate: string) {
  switch (aggregate as AggregateName) {
    case 'FactoryRun':
      return session.factoryRun;
    case 'LifecycleRun':
      return session.lifecycleRun;
    case 'StageRun':
      return session.stageRun;
    case 'ProcessRun':
      return session.processRun;
    case 'NodeRun':
      return session.nodeRun;
    case 'Workplace':
      return session.workplace;
    case 'ActivityAttempt':
      return session.activityAttempt;
    case 'WorkItem':
      return session.workItem;
    case 'CognitionTransport':
      return session.cognitionTransport;
    default:
      throw new Error(`EK_CONSUMER: unknown target aggregate ${aggregate}`);
  }
}

/* ------------------------------------------------------------------ */
/* Claims and the claimable frontier                                   */
/* ------------------------------------------------------------------ */

/** The exact typed fields a consumer may attach to the target command (closed shape). */
export interface ConsumeInvocation {
  readonly evidenceRefs?: readonly string[];
  readonly gateVerdict?: GateVerdict;
  readonly effectOutcome?: EffectOutcome;
  readonly terminalOutcome?: TerminalOutcome;
  readonly stageRoute?: StageRoute;
  readonly protocolRole?: ProtocolRole;
  readonly rolePin?: CanonicalRoleContractReference;
  readonly workIntentRef?: string;
  /** The admission envelope when the claimed obligation targets admitProviderRequest. */
  readonly admission?: { readonly envelope: ProviderRequestEnvelope; readonly limits: PromptBudgetLimits };
}

export interface ObligationClaim {
  /** Index into the hydrated world's id-ordered obligations. */
  readonly index: number;
  readonly kind: ObligationKind;
  readonly target: CommandName;
  readonly targetAggregate: AggregateName;
  /** The failed attempt a retry obligation names (evidence-based pin re-use). */
  readonly sourceInstanceId: InstanceId;
  readonly targetInstanceId: InstanceId;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly evidenceRefs: readonly string[];
}

/** One frontier row: the lowest-id open obligation of one distinct target command. */
export interface FrontierEntry {
  readonly index: number;
  readonly kind: ObligationKind;
  readonly target: CommandName;
  /** Present when the target instance resolved from durable facts. */
  readonly claim?: ObligationClaim;
  /** Present when no durable target-instance binding exists (never guessed). */
  readonly refusal?: TypedRefusal;
}

export type ClaimSelection =
  | { readonly claimed: true; readonly claim: ObligationClaim }
  | { readonly idle: true; readonly openCount: 0 }
  | { readonly unresolvable: true; readonly kind: ObligationKind; readonly target: CommandName; readonly refusal: TypedRefusal };

/** Deterministic fresh instance id (mirrors the pure engine's counter rule). */
function freshInstanceId(aggregate: string, instanceCount: number): InstanceId {
  const kebab = aggregate.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return `${kebab}:${instanceCount + 1}`;
}

/** Creation commands instantiate their aggregate (no from-status required). */
function isCreationCommand(command: CommandName): boolean {
  const resolved = reducerForCommand(command);
  return resolved === undefined ? false : resolved.reducer.transitions.some((rule) => rule.command === command && rule.fromStatuses.length === 0);
}

/**
 * Resolve the target instance ONLY from durable facts, in order:
 *   1. the obligation's own targetInstanceId;
 *   2. a creation command -> a deterministic fresh instance id (a creation
 *      always instantiates a NEW aggregate, never the source instance);
 *   3. the source aggregate equals the target aggregate -> the source instance;
 *   4. the well-known stateless transport singleton;
 *   5. a Workplace target bound by admitted WorkIntent evidence refs.
 * Anything else is UNRESOLVABLE by design: the consumer never selects an
 * instance by recency, chronology or a projection - cross-aggregate conveyor
 * topology binding is WP-08/WP-09 composition work supplied as evidence.
 */
function resolveClaim(
  obligation: ObligationRecord,
  index: number,
  heads: ReadonlyMap<InstanceId, AggregateHead>,
  instanceCounters: Readonly<Record<string, number>>,
  workIntents: ReadonlyMap<string, WorkIntent>,
): { readonly claim?: ObligationClaim; readonly refusal?: TypedRefusal } {
  const target = obligation.target as CommandName;
  const resolved = reducerForCommand(target);
  if (resolved === undefined) {
    return { refusal: { refused: true, reason: 'UNKNOWN_COMMAND', detail: `obligation target ${target} is not declared in the frozen universe` } };
  }
  const targetAggregate = resolved.descriptor.aggregate;

  let instanceId: string | undefined;
  if (obligation.targetInstanceId !== null) {
    instanceId = obligation.targetInstanceId;
  } else if (isCreationCommand(target)) {
    instanceId = freshInstanceId(targetAggregate, instanceCounters[targetAggregate] ?? 0);
  } else {
    const sourceAggregate = reducerForCommand(obligation.source)?.descriptor.aggregate;
    if (sourceAggregate === targetAggregate) {
      instanceId = obligation.sourceInstanceId;
    } else if (targetAggregate === 'CognitionTransport') {
      instanceId = COGNITION_TRANSPORT_INSTANCE_ID;
    } else if (targetAggregate === 'Workplace') {
      const bindingRef = obligation.evidenceRefs.find((ref) => workIntents.has(ref));
      instanceId = bindingRef === undefined ? undefined : workIntents.get(bindingRef)?.workplaceInstanceId;
    }
  }

  if (instanceId === undefined) {
    return {
      refusal: {
        refused: true,
        reason: 'MISSING_EVIDENCE',
        detail: `obligation ${obligation.kind} -> ${target} has no durable target-instance binding on its row, its aggregate or its evidence (never chronology/projection selection)`,
      },
    };
  }
  const head = heads.get(instanceId);
  return {
    claim: {
      index,
      kind: obligation.kind,
      target,
      targetAggregate,
      sourceInstanceId: obligation.sourceInstanceId,
      targetInstanceId: instanceId,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey: `consume:${obligation.idempotencyKey}`,
      evidenceRefs: [...obligation.evidenceRefs],
    },
  };
}

/**
 * The claimable frontier: for each DISTINCT target command among the open
 * obligations, its lowest-id open obligation (the only row of that target the
 * engine would complete), resolved from durable facts. Sorted by row id.
 */
export function openFrontier(session: KernelPersistenceSession): readonly FrontierEntry[] {
  const ledger = session.hydrateWorld();
  const world = ledger.world;
  const lowestPerTarget = new Map<CommandName, { index: number; obligation: ObligationRecord }>();
  for (let index = 0; index < world.obligations.length; index += 1) {
    const obligation = world.obligations[index];
    if (obligation.state !== 'open') continue;
    const target = obligation.target as CommandName;
    if (!lowestPerTarget.has(target)) {
      lowestPerTarget.set(target, { index, obligation });
    }
  }
  return [...lowestPerTarget.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ index, obligation }) => {
      const resolution = resolveClaim(obligation, index, world.heads, world.instanceCounters, world.workIntents);
      return {
        index,
        kind: obligation.kind,
        target: obligation.target as CommandName,
        ...(resolution.claim !== undefined ? { claim: resolution.claim } : {}),
        ...(resolution.refusal !== undefined ? { refusal: resolution.refusal } : {}),
      };
    });
}

/** Claim the next obligation: the frontier's first resolvable entry (or its first typed unresolvable). */
export function claimNextObligation(session: KernelPersistenceSession): ClaimSelection {
  const frontier = openFrontier(session);
  if (frontier.length === 0) {
    return { idle: true, openCount: 0 };
  }
  const first = frontier[0];
  if (first.refusal !== undefined || first.claim === undefined) {
    return { unresolvable: true, kind: first.kind, target: first.target, refusal: first.refusal as TypedRefusal };
  }
  return { claimed: true, claim: first.claim };
}

/* ------------------------------------------------------------------ */
/* Consume                                                             */
/* ------------------------------------------------------------------ */

export interface ConsumerConfig {
  /** Call-scoped external Input-authority evidence (CheckPlan, verifier results). */
  readonly externalEvidence?: readonly EvidenceFact[];
  readonly faults?: FaultScheduler;
}

export type ConsumeResult =
  | { readonly status: 'committed'; readonly claim: ObligationClaim; readonly outcome: Extract<CommandOutcome, { committed: true }> }
  | { readonly status: 'replayed'; readonly claim: ObligationClaim; readonly originalEventSequence: number }
  | { readonly status: 'refused'; readonly claim: ObligationClaim; readonly refusal: TypedRefusal; readonly fenceLost: boolean };

/**
 * Consume one exact claim in the owning repository's single transaction.
 * The claim's advisory revision is re-fenced by the command itself: a rival
 * commit between claim and consume yields STALE_EXPECTED_REVISION (fence
 * lost) and the obligation stays open for the next claim.
 */
export function consumeClaim(
  session: KernelPersistenceSession,
  claim: ObligationClaim,
  invocation: ConsumeInvocation = {},
  config: ConsumerConfig = {},
): ConsumeResult {
  const { faults } = config;

  if (claim.target === 'activityAttempt.admitProviderRequest') {
    return consumeAdmission(session, claim, invocation, config);
  }

  const input: CommandInput = {
    command: claim.target,
    instanceId: claim.targetInstanceId,
    expectedRevision: claim.expectedRevision,
    idempotencyKey: claim.idempotencyKey,
    evidenceRefs: invocation.evidenceRefs ?? claim.evidenceRefs,
    ...(invocation.gateVerdict !== undefined ? { gateVerdict: invocation.gateVerdict } : {}),
    ...(invocation.effectOutcome !== undefined ? { effectOutcome: invocation.effectOutcome } : {}),
    ...(invocation.terminalOutcome !== undefined ? { terminalOutcome: invocation.terminalOutcome } : {}),
    ...(invocation.stageRoute !== undefined ? { stageRoute: invocation.stageRoute } : {}),
    ...(invocation.protocolRole !== undefined ? { protocolRole: invocation.protocolRole } : {}),
    ...(invocation.rolePin !== undefined ? { rolePin: invocation.rolePin } : {}),
    ...(invocation.workIntentRef !== undefined ? { workIntentRef: invocation.workIntentRef } : {}),
    ...(claim.target === 'activityAttempt.create' ? retryPins(session, claim, invocation) : {}),
  };

  faults?.fire('before-durable-write');
  faults?.fire('before-obligation-completion');
  fireCommandPoints(faults, claim.target, 'before');
  const options = config.externalEvidence === undefined ? undefined : { externalEvidence: config.externalEvidence };
  const outcome: CommandOutcome = repositoryOf(session, claim.targetAggregate).applyCommand(input, options);
  if ('refused' in outcome) {
    return { status: 'refused', claim, refusal: outcome, fenceLost: outcome.reason === 'STALE_EXPECTED_REVISION' };
  }
  if ('replayed' in outcome) {
    return { status: 'replayed', claim, originalEventSequence: outcome.originalEventSequence };
  }
  faults?.fire('after-durable-write');
  faults?.fire('after-obligation-completion');
  fireCommandPoints(faults, claim.target, 'after');
  return { status: 'committed', claim, outcome };
}

function fireCommandPoints(faults: FaultScheduler | undefined, command: CommandName, phase: 'before' | 'after'): void {
  for (const point of commandFaultPoints(command)) {
    if (point.startsWith(`${phase}-`)) faults?.fire(point);
  }
}

/**
 * The retry path re-uses the WorkIntent pin of the exact FAILED attempt the
 * obligation names (durable public reader of the owning repository) - the
 * new attempt never re-resolves any manifest.
 */
function retryPins(session: KernelPersistenceSession, claim: ObligationClaim, invocation: ConsumeInvocation): { workIntentRef?: string; rolePin?: CanonicalRoleContractReference } {
  if (invocation.workIntentRef !== undefined && invocation.rolePin !== undefined) return {};
  const pin = session.activityAttempt.loadRoleContractPin(claim.sourceInstanceId);
  if (pin === undefined) return {};
  return {
    ...(invocation.workIntentRef === undefined ? { workIntentRef: pin.workIntentRef } : {}),
    ...(invocation.rolePin === undefined ? { rolePin: { roleContractRef: pin.roleContractRef, roleContractDigest: pin.roleContractDigest } } : {}),
  };
}

/** The admission target goes through the ONE admission path (never a second admission for one ordinal). */
function consumeAdmission(session: KernelPersistenceSession, claim: ObligationClaim, invocation: ConsumeInvocation, config: ConsumerConfig): ConsumeResult {
  const { faults } = config;
  if (invocation.admission === undefined) {
    return {
      status: 'refused',
      claim,
      refusal: {
        refused: true,
        reason: 'MISSING_EVIDENCE',
        detail: 'obligation:launchAdmission requires the admission envelope (the PromptAssemblyReceipt commits with the command)',
      },
      fenceLost: false,
    };
  }
  faults?.fire('before-durable-write');
  faults?.fire('before-obligation-completion');
  const admission = admitProviderRequest(session, {
    attemptInstanceId: claim.targetInstanceId,
    envelope: invocation.admission.envelope,
    limits: invocation.admission.limits,
    idempotencyKey: claim.idempotencyKey,
    faults,
  });
  if (admission.status === 'refused') {
    return {
      status: 'refused',
      claim,
      refusal: { refused: true, reason: 'MISSING_EVIDENCE', detail: `${admission.reason}: ${admission.detail}` },
      fenceLost: false,
    };
  }
  if (admission.status === 'stale' || admission.status === 'redrive') {
    // Redrive: the launch obligation cannot still be open while its
    // provider-send obligation exists (they complete atomically) - a lost fence.
    return {
      status: 'refused',
      claim,
      refusal: {
        refused: true,
        reason: 'STALE_EXPECTED_REVISION',
        detail:
          admission.status === 'stale'
            ? admission.detail
            : `admission for ${claim.targetInstanceId} already committed (${admission.providerSendObligationKey} is open)`,
      },
      fenceLost: true,
    };
  }
  faults?.fire('after-durable-write');
  faults?.fire('after-obligation-completion');
  const outcome = admission.outcome;
  if ('replayed' in outcome) {
    return { status: 'replayed', claim, originalEventSequence: outcome.originalEventSequence };
  }
  return { status: 'committed', claim, outcome };
}

/** Claim + consume in one call (the driver loop unit). */
export function consumeNext(
  session: KernelPersistenceSession,
  invocation: ConsumeInvocation = {},
  config: ConsumerConfig = {},
): { readonly idle: true } | { readonly unresolvable: true; readonly kind: ObligationKind; readonly target: CommandName; readonly refusal: TypedRefusal } | ConsumeResult {
  const selection = claimNextObligation(session);
  if ('idle' in selection) return { idle: true };
  if ('unresolvable' in selection) return selection;
  return consumeClaim(session, selection.claim, invocation, config);
}

/* ------------------------------------------------------------------ */
/* The idle run (bounded, spin-free)                                   */
/* ------------------------------------------------------------------ */

export interface IdleRunResult {
  readonly status: 'idle' | 'blocked';
  readonly consumed: number;
  /** The blocked lane's exact typed causes (never retried in a spin). */
  readonly refusals: readonly { readonly kind: string; readonly reason: string; readonly detail: string }[];
  /** Frontier obligations with no durable target-instance binding (typed, never guessed). */
  readonly unresolved: readonly { readonly kind: string; readonly target: string; readonly detail: string }[];
}

/**
 * Drive the claimable frontier until it is empty (idle) or no frontier
 * obligation can progress (blocked - a typed outcome, never a busy-spin:
 * one consume attempt per frontier obligation per round, and a round
 * without progress ends the run). An idle result creates NOTHING: an empty
 * queue is not progress and never a terminal proof. Discriminators (gate
 * verdicts, effect outcomes) are the caller's typed payloads; the consumer
 * never invents them.
 */
export function runUntilIdle(session: KernelPersistenceSession, config: ConsumerConfig = {}, maxRounds = 64): IdleRunResult {
  const refusals: { kind: string; reason: string; detail: string }[] = [];
  const unresolved: { kind: string; target: string; detail: string }[] = [];
  let consumed = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const frontier = openFrontier(session);
    if (frontier.length === 0) {
      return { status: 'idle', consumed, refusals, unresolved };
    }
    let progress = false;
    for (const entry of frontier) {
      if (entry.refusal !== undefined || entry.claim === undefined) {
        unresolved.push({ kind: entry.kind, target: entry.target, detail: (entry.refusal as TypedRefusal).detail });
        continue;
      }
      const result = consumeClaim(session, entry.claim, {}, config);
      if (result.status === 'committed') {
        consumed += 1;
        progress = true;
        break; // re-derive the frontier from the committed world
      }
      if (result.status === 'replayed') {
        continue; // consumed elsewhere; the next round re-derives
      }
      refusals.push({ kind: entry.kind, reason: result.refusal.reason, detail: result.refusal.detail });
    }
    if (!progress) {
      return { status: 'blocked', consumed, refusals, unresolved };
    }
  }
  refusals.push({ kind: '<run>', reason: 'ITERATION_CAP', detail: `runUntilIdle exceeded ${maxRounds} rounds without idling` });
  return { status: 'blocked', consumed, refusals, unresolved };
}
