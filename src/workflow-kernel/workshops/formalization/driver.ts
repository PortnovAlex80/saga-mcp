/**
 * workflow-kernel/workshops/formalization/driver.ts - the Formalization
 * scenario conveyor (WP-11F, plan phase EK-8 workshop conversion).
 *
 * A STATELESS composition over durable facts, in the exact discipline of
 * the WP-07 obligation driver with WP-09-style durable bindings:
 *
 *   capsule ingress of the accepted Discovery output (ingress.ts:
 *   factoryRun.bootstrap + factoryRun.importCapsule)
 *     -> factoryRun.start -> lifecycleRun.create
 *     -> stage-run:1 (the imported-Discovery shell stage; the capsule IS
 *        its accepted material) -> full desk -> node/process/stage settle
 *     -> lifecycleRun.routeOutcome('solution-formalization')
 *     -> stage-run:2 (the Formalization stage)
 *     -> processRun over the installed module flow (manifest.ts): one
 *        node + Workplace desk per flow desk (six Production Cells + two
 *        operator-staffed kernel nodes), each through the FULL public
 *        command path:
 *          workItem.planGraph -> nodeRun.create/materializeCell ->
 *          workplace.materialize (planning-token stamped) ->
 *          admitWorkIntent (the ONE resolved role pin) ->
 *          activityAttempt.create (SAME pin copied) ->
 *          cognition (the shared transport port at the exact pre-send
 *          boundary) -> recordOutcome -> recordContribution ->
 *          sealProductionRevision (the accepted-material authority,
 *          ADR-053) -> presentCandidateSet -> runAuthorGate (CheckPlan +
 *          the desk's declared semantic provider) -> reviewer desk ->
 *          runFinalGate -> settleEffect (idempotent, R13 sole writer) ->
 *          recordFinalAcceptance -> closePresentation ->
 *          issueWorkplaceTerminalProof -> node settlement ->
 *          advanceProcessFlow
 *     -> processRun.settle -> stageRun.recordLocalOutcome ->
 *        routeOutcome('verify-terminal-claims') -> verifyTerminalClaims ->
 *        lifecycleRun.issueTerminalProof -> runSettlement ->
 *        factoryRun.recordRunTerminalProof.
 *
 * IDENTITY LAW (ADR-053): gates and acceptance bind REVISION material -
 * the Workplace production revision is the accepted-material authority;
 * the ActivityAttempt is provenance. The accepted-material chain
 * (contribution.ts folds) is what every downstream desk validates
 * against, never the attempt.
 *
 * ROUTING LAW: every cross-aggregate edge goes through the WP-07
 * obligation consumer (one transaction, one completion, one fence); the
 * target instance is pinned from durable facts or authored tokens
 * (WP-09-style) - never chronology, never recency, never a board.
 *
 * Every step is idempotent over durable facts: instance ids are
 * deterministic per desk, each step checks its own durable postcondition,
 * and re-driving a reopened database after any crash converges.
 */

import type {
  CanonicalRoleContractReference,
  CommandInput,
  CommandOutcome,
  EvidenceFact,
  EvidenceRef,
  InstanceId,
  ProtocolRole,
  TypedRefusal,
} from '../../domain/types.js';
import { COMMANDS } from '../../domain/universe.js';
import type { CommandName, ObligationKind } from '../../domain/universe.js';
import { reducerForCommand } from '../../domain/reducers/index.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';
import * as consumer from '../../application/obligation-consumer.js';
import type { ConsumeInvocation, ConsumeResult, ObligationClaim } from '../../application/obligation-consumer.js';
import { topologyBindings } from '../../planning/bindings.js';
import type { CognitionTransportContract } from '../../context-envelope/transport.js';
import type { ExternalReference } from '../../context-envelope/receipt.js';
import type { FormalizationRoleRuntime, ResolvedFormalizationSlot } from './roles.js';
import { FORMALIZATION_AUTHOR_LAUNCH_KIND, FORMALIZATION_REVIEWER_LAUNCH_KIND } from './roles.js';
import type { FormalizationActorScript, FormalizationActorRunResult } from './actors.js';
import { FormalizationScriptedActor } from './actors.js';
import type { FormalizationEffectExecutor } from './effects.js';
import type { GateCandidate, SemanticGateOutcome } from './gates.js';
import { evaluateProductGate } from './gates.js';
import type { CheckProviderDeclaration } from './manifest.js';
import { checkProviderOfDesk, deskNodeIds, nodeOf } from './manifest.js';
import type { AcceptedMaterial, BaselineFreezeInputs } from './products.js';
import { acceptedBaselineAfter, acceptedMaterialAfter, acceptedMaterialOfHandoff, acceptedScenarioRequiredAfter, contributionOf } from './contribution.js';

/* ------------------------------------------------------------------ */
/* Step results                                                        */
/* ------------------------------------------------------------------ */

export type DeskStepResult =
  | { readonly status: 'committed' | 'replayed' | 'skipped' }
  | { readonly status: 'refused'; readonly refusal: TypedRefusal }
  | { readonly status: 'actor-refused'; readonly detail: string }
  | { readonly status: 'acceptance-refused'; readonly reason: string; readonly detail: string };

export interface FormalizationRunResult {
  readonly steps: readonly { readonly step: string; readonly result: DeskStepResult }[];
  readonly blockedAt: string | undefined;
  /** The accepted-material chain after the last accepted desk (pure fold). */
  readonly accepted: AcceptedMaterial;
  /** Per-desk accepted material summary (the production-revision authority). */
  readonly desks: readonly {
    readonly nodeId: string;
    readonly workplace?: InstanceId;
    readonly productRef?: string;
    readonly gateVerdict?: string;
  }[];
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface FormalizationHandoffRef {
  readonly capsuleRef: string;
  readonly digest: string;
  readonly sourceClaimIds: readonly string[];
  readonly terminalClaimIds: readonly string[];
  readonly sourceClaims: readonly ExternalReference[];
  readonly constraints: readonly ExternalReference[];
  readonly unknowns: readonly ExternalReference[];
  readonly terminalClaims: readonly ExternalReference[];
}

/** One desk's authored product + its atomic member ids (the fold input). */
export interface AuthoredDeskProduct {
  readonly candidate: GateCandidate;
  readonly memberIds: readonly string[];
  /** The scenario_required PRD members (PRD desk only - the UC coverage fence). */
  readonly scenarioRequiredMemberIds?: readonly string[];
}

export interface FormalizationRunConfig {
  readonly session: KernelPersistenceSession;
  readonly roles: FormalizationRoleRuntime;
  readonly transport: CognitionTransportContract;
  readonly effects: FormalizationEffectExecutor;
  readonly externalEvidence: readonly EvidenceFact[];
  readonly handoff: FormalizationHandoffRef;
  /** CheckPlan fact of the imported-Discovery shell desk (external input authority). */
  readonly shellCheckPlan: EvidenceFact;
  /** Authored products per formalization desk node id. */
  readonly authored: Readonly<Record<string, AuthoredDeskProduct>>;
  /** Typed verdict overrides (mutation scenarios inject typed verdicts here). */
  readonly verdictOverrides?: Readonly<Record<string, { readonly authorGate?: SemanticGateVerdictAlias; readonly finalGate?: SemanticGateVerdictAlias }>>;
  /** The shell desk's actor scripts. */
  readonly shellScripts: { readonly author: FormalizationActorScript; readonly reviewer: FormalizationActorScript };
  /** Actor scripts per formalization desk node id. */
  readonly scripts: Readonly<Record<string, { readonly author: FormalizationActorScript; readonly reviewer: FormalizationActorScript }>>;
  /** Effect mutation injector: registers accepted digests / freezes / settles. */
  readonly effectSink?: (effectId: string, contentDigest: string) => string;
  /** Stop after this step name committed (scenario staging). */
  readonly stopAfter?: string;
}

type SemanticGateVerdictAlias = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

/* ------------------------------------------------------------------ */
/* World helpers (durable reads only)                                  */
/* ------------------------------------------------------------------ */

const worldOf = (session: KernelPersistenceSession) => session.hydrateWorld().world;

function headOf(session: KernelPersistenceSession, instanceId: string) {
  return worldOf(session).heads.get(instanceId);
}

function latestInstanceOf(session: KernelPersistenceSession, aggregate: string): InstanceId | undefined {
  let latest: InstanceId | undefined;
  for (const head of worldOf(session).heads.values()) {
    if (head.aggregate === aggregate) latest = head.instanceId;
  }
  return latest;
}

/** The instance of one aggregate whose creation event has the LOWEST sequence (the earliest). */
function earliestInstanceOf(session: KernelPersistenceSession, aggregate: string): InstanceId | undefined {
  const createCommands = new Set<string>();
  for (const descriptor of COMMANDS) {
    if (descriptor.aggregate === aggregate) {
      const resolved = reducerForCommand(descriptor.name);
      if (resolved !== undefined && resolved.reducer.transitions.some((rule) => rule.command === descriptor.name && rule.fromStatuses.length === 0)) {
        createCommands.add(descriptor.name);
      }
    }
  }
  let earliest: InstanceId | undefined;
  let earliestSequence = Number.POSITIVE_INFINITY;
  for (const event of worldOf(session).events) {
    if (!createCommands.has(event.transition)) continue;
    if (event.sequence < earliestSequence) {
      earliestSequence = event.sequence;
      earliest = event.sourceInstanceId;
    }
  }
  return earliest;
}

function eventExists(session: KernelPersistenceSession, transition: CommandName, instanceId: string, withEvidenceRef?: string): boolean {
  return worldOf(session).events.some(
    (event) => event.transition === transition && event.sourceInstanceId === instanceId && (withEvidenceRef === undefined || event.evidenceRefs.includes(withEvidenceRef)),
  );
}

function aggregateOf(command: CommandName): string {
  const descriptor = COMMANDS.find((entry) => entry.name === command);
  if (!descriptor) throw new Error(`FORMALIZATION_DRIVER: unknown command ${command}`);
  return descriptor.aggregate;
}

/** True when some rule of the command is legal from the head's status (re-drive skip oracle). */
export function isTransitionLegal(command: CommandName, instanceId: string, session: KernelPersistenceSession): boolean {
  const head = headOf(session, instanceId);
  if (head === undefined) return true;
  const resolved = reducerForCommand(command);
  if (!resolved) return false;
  return resolved.reducer.transitions.some((rule) => rule.command === command && rule.fromStatuses.includes(head.status));
}

/** The frontier entry of one exact target command (the claimable lane head). */
function frontierEntryOf(session: KernelPersistenceSession, target: CommandName) {
  return consumer.openFrontier(session).find((entry) => entry.target === target);
}

/** Re-pin a claim's command target (the completed row stays the lane's FIFO head). */
function pinClaim(session: KernelPersistenceSession, claim: ObligationClaim, instanceId: InstanceId): ObligationClaim {
  const head = headOf(session, instanceId);
  const expectedRevision = head === undefined ? 0 : head.revision;
  return {
    ...claim,
    targetInstanceId: instanceId,
    expectedRevision,
    idempotencyKey: claim.idempotencyKey + '@' + instanceId + '@' + String(expectedRevision),
  };
}

function asStep(result: ConsumeResult): DeskStepResult {
  if (result.status === 'refused') return { status: 'refused', refusal: result.refusal };
  return { status: result.status };
}

/** Consume the lane-head obligation of one exact target, pinned to an explicit instance (idle -> skipped). */
function consumeTarget(
  session: KernelPersistenceSession,
  target: CommandName,
  invocation: ConsumeInvocation,
  config: FormalizationRunConfig,
  pinnedInstanceId?: InstanceId,
): DeskStepResult {
  const entry = frontierEntryOf(session, target);
  if (entry === undefined) return { status: 'skipped' };
  if (entry.claim === undefined) {
    return { status: 'refused', refusal: entry.refusal as TypedRefusal };
  }
  const head = headOf(session, pinnedInstanceId ?? entry.claim.targetInstanceId);
  if (!isTransitionLegal(target, pinnedInstanceId ?? entry.claim.targetInstanceId, session)) {
    // The target aggregate already moved past this command's legal statuses
    // (idempotent re-drive): the leftover obligation row stays durable.
    void head;
    return { status: 'skipped' };
  }
  const claim = pinnedInstanceId === undefined ? entry.claim : pinClaim(session, entry.claim, pinnedInstanceId);
  return asStep(consumer.consumeClaim(session, claim, invocation, { externalEvidence: config.externalEvidence }));
}

/** Consume the lowest-id open obligation of one KIND, pinned to an explicit instance. */
function consumeKindOn(
  session: KernelPersistenceSession,
  kind: ObligationKind,
  expectedTarget: CommandName,
  instanceId: InstanceId,
  invocation: ConsumeInvocation,
  config: FormalizationRunConfig,
): DeskStepResult {
  const world = worldOf(session);
  let row = undefined;
  let index = -1;
  for (let i = 0; i < world.obligations.length; i += 1) {
    const obligation = world.obligations[i];
    if (obligation.state === 'open' && obligation.kind === kind) {
      row = obligation;
      index = i;
      break;
    }
  }
  if (row === undefined) return { status: 'skipped' };
  if (row.target !== expectedTarget) {
    return { status: 'refused', refusal: { refused: true, reason: 'UNIVERSE_VIOLATION', detail: `open obligation ${kind} targets ${row.target}, not ${expectedTarget}` } };
  }
  if (!isTransitionLegal(expectedTarget, instanceId, session)) {
    return { status: 'skipped' };
  }
  const head = headOf(session, instanceId);
  const claim: ObligationClaim = {
    index,
    kind: row.kind,
    target: row.target as CommandName,
    targetAggregate: row.targetAggregate,
    sourceInstanceId: row.sourceInstanceId,
    targetInstanceId: instanceId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `consume:${row.kind}:${instanceId}:${head === undefined ? 0 : head.revision}`,
    evidenceRefs: [...row.evidenceRefs],
  };
  return asStep(consumer.consumeClaim(session, claim, invocation, { externalEvidence: config.externalEvidence }));
}

/** Apply one exempt/kernel command directly through its sole-writer repository. */
function ensureCommand(
  session: KernelPersistenceSession,
  command: CommandName,
  instanceId: InstanceId,
  idempotencyKey: string,
  fields: Partial<CommandInput>,
  config: FormalizationRunConfig,
  done: (session: KernelPersistenceSession) => boolean,
): DeskStepResult {
  if (done(session)) return { status: 'skipped' };
  const head = headOf(session, instanceId);
  const outcome: CommandOutcome = consumer.repositoryOf(session, aggregateOf(command)).applyCommand(
    {
      command,
      instanceId,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey,
      ...fields,
    },
    { externalEvidence: config.externalEvidence },
  );
  if ('refused' in outcome) return { status: 'refused', refusal: outcome };
  return { status: 'replayed' in outcome ? 'replayed' : 'committed' };
}

/** Planning evidence refs: the capsule facts recorded by factoryRun.importCapsule. */
function planningRefs(session: KernelPersistenceSession): readonly EvidenceRef[] {
  return worldOf(session)
    .evidence.filter((fact) => fact.kind === 'TerminalLifecycleClaim' || fact.kind === 'ConstructionSurface' || fact.kind === 'TerminalClaimCoverage')
    .map((fact) => fact.ref);
}

/* ------------------------------------------------------------------ */
/* The desk step machine                                              */
/* ------------------------------------------------------------------ */

interface DeskDriverState {
  readonly nodeId: string;
  readonly workplace: InstanceId;
  readonly itemInstanceId: InstanceId;
  readonly token: string;
  readonly productKind: string;
  readonly effectId: string;
  readonly authored?: AuthoredDeskProduct;
  readonly scripts: { readonly author: FormalizationActorScript; readonly reviewer: FormalizationActorScript };
  /** Mutated as the desk progresses (the gate outcomes feed the fold + the reviewer envelope). */
  readonly gateOutcomes: { authorGate?: SemanticGateOutcome; finalGate?: SemanticGateOutcome };
}

function intentOf(session: KernelPersistenceSession, workplaceId: string, role: ProtocolRole) {
  const intents = [...worldOf(session).workIntents.values()].filter((intent) => intent.workplaceInstanceId === workplaceId && intent.protocolRole === role);
  return intents[intents.length - 1];
}

/** Admit one WorkIntent (author via the item's openUnknownObligation row; reviewer via openReviewerDesk). */
function admitIntent(
  config: FormalizationRunConfig,
  state: DeskDriverState,
  role: ProtocolRole,
  slot: ResolvedFormalizationSlot,
  evidenceRefs: readonly string[],
): DeskStepResult {
  const session = config.session;
  const workplace = state.workplace;
  if (intentOf(session, workplace, role) !== undefined) return { status: 'skipped' };
  const kind: ObligationKind = role === 'author' ? 'obligation:openUnknownObligation' : 'obligation:openReviewerDesk';
  const invocation: ConsumeInvocation = { protocolRole: role, rolePin: slot.pin as CanonicalRoleContractReference, evidenceRefs: [...evidenceRefs] };
  const consumed = consumeKindOn(session, kind, 'workplace.admitWorkIntent', workplace, invocation, config);
  if (consumed.status !== 'skipped') return consumed;
  // Fallback: no open row of the kind (re-drive / driver-direct lane) - the
  // exempt command applies with the same typed payload.
  return ensureCommand(
    session,
    'workplace.admitWorkIntent',
    workplace,
    `formalization:admit-${role}:${state.nodeId}`,
    invocation as Partial<CommandInput>,
    config,
    (s) => intentOf(s, workplace, role) !== undefined,
  );
}

/** One actor round: create attempt, run the shared-port actor, consume providerSend, record outcome. */
async function runActorRound(
  config: FormalizationRunConfig,
  state: DeskDriverState,
  role: ProtocolRole,
  slot: ResolvedFormalizationSlot,
  script: FormalizationActorScript,
): Promise<{ readonly result: DeskStepResult; readonly actor?: FormalizationActorRunResult }> {
  const session = config.session;
  const intent = intentOf(session, state.workplace, role);
  if (intent === undefined) {
    return { result: { status: 'actor-refused', detail: `no ${role} WorkIntent admitted for ${state.workplace}` } };
  }
  const attempt = `formalization-attempt:${state.nodeId}:${role}`;
  if (headOf(session, attempt) === undefined) {
    const created = ensureCommand(
      session,
      'activityAttempt.create',
      attempt,
      `formalization:attempt:${attempt}`,
      { workIntentRef: intent.intentRef, rolePin: intent.roleContract as CanonicalRoleContractReference },
      config,
      (s) => headOf(s, attempt) !== undefined,
    );
    if (created.status === 'refused') return { result: created };
  }
  const attemptStatus = headOf(session, attempt)?.status;
  if (attemptStatus === 'outcome-recorded' || attemptStatus === 'provider-refusal-recorded' || attemptStatus === 'cancelled') {
    return { result: { status: 'skipped' } };
  }
  const acceptedRef = state.gateOutcomes.authorGate?.productRef;
  const actor = new FormalizationScriptedActor(config.transport, script);
  const run = await actor.run({
    attemptRef: attempt,
    roleContract: slot.contract,
    taskSummary: `${state.nodeId} desk (${role})`,
    requiredInfo: {
      sourceClaims: config.handoff.sourceClaims,
      constraints: config.handoff.constraints,
      unknowns: config.handoff.unknowns,
      terminalClaims: config.handoff.terminalClaims,
      upstreamAccepted: acceptedRef !== undefined
        ? [{ ref: acceptedRef, digest: acceptedRef, summary: `accepted revision of ${state.nodeId}` }]
        : [],
    },
    idempotencyKeyPrefix: `formalization:${state.nodeId}:${role}`,
    expectedContextRevision: 0,
  });
  if ('refused' in run) {
    return { result: { status: 'actor-refused', detail: `${run.reason}: ${run.detail}` } };
  }
  const send = consumeTarget(session, 'cognition.sendProviderRequest', {}, config);
  if (send.status === 'refused') return { result: send };
  const outcome = ensureCommand(
    session,
    'activityAttempt.recordOutcome',
    attempt,
    `formalization:outcome:${attempt}`,
    { evidenceRefs: [intent.intentRef, run.result.outcomeDigest] },
    config,
    (s) => headOf(s, attempt)?.status === 'outcome-recorded',
  );
  if (outcome.status === 'refused') return { result: outcome };
  return { result: { status: 'committed' }, actor: run.result };
}

/** The desk's declared provider (undefined for the shell desk). */
function deskProviderOf(nodeId: string): CheckProviderDeclaration | undefined {
  const resolved = checkProviderOfDesk(nodeId);
  return resolved.ok ? resolved.provider : undefined;
}

/** The actor's authored product of one kind (kernel desks use config.authored instead). */
function actorProductOf(actor: FormalizationActorRunResult | undefined, productKind: string): GateCandidate | undefined {
  if (productKind === 'formalization.what-baseline.v1') return undefined; // the freezer consumes exact accepted inputs
  const product = actor?.products.find((entry) => entry.kind === productKind);
  return product === undefined ? undefined : ({ kind: product.kind, product: product.product } as GateCandidate);
}

/** The exact freeze inputs derived from the accepted chain (never a rescan). */
export function baselineInputsOf(config: FormalizationRunConfig, accepted: AcceptedMaterial): BaselineFreezeInputs {
  return {
    handoffDigest: accepted.handoff?.digest ?? config.handoff.digest,
    prdRevisionDigest: accepted.prd?.revisionDigest ?? '',
    ucRevisionDigest: accepted.useCases?.revisionDigest ?? '',
    requirementsRevisionDigest: accepted.requirements?.revisionDigest ?? '',
    acceptanceRevisionDigest: accepted.acceptance?.revisionDigest ?? '',
    reconciliationRevisionDigest: accepted.reconciliation?.revisionDigest ?? '',
    memberDigests: [
      ...(accepted.prd ? [accepted.prd.revisionDigest] : []),
      ...(accepted.useCases ? [accepted.useCases.revisionDigest] : []),
      ...(accepted.requirements ? [accepted.requirements.revisionDigest] : []),
      ...(accepted.acceptance ? [accepted.acceptance.revisionDigest] : []),
      ...(accepted.reconciliation ? [accepted.reconciliation.revisionDigest] : []),
    ],
    acceptedTraceDigest: config.handoff.capsuleRef,
  };
}

/** Drive one full desk on a workplace through the public command path. */
async function driveDesk(
  config: FormalizationRunConfig,
  state: DeskDriverState,
  accepted: AcceptedMaterial,
  stop: (step: string, result: DeskStepResult) => void,
  isStopped: () => boolean,
): Promise<void> {
  const session = config.session;
  const workplace = state.workplace;
  const authorSlot = config.roles.slotOf(FORMALIZATION_AUTHOR_LAUNCH_KIND);
  const reviewerSlot = config.roles.slotOf(FORMALIZATION_REVIEWER_LAUNCH_KIND);
  if (authorSlot === undefined || reviewerSlot === undefined) {
    stop(`desk-${state.nodeId}-roles-resolved`, { status: 'actor-refused', detail: 'the formalization role runtime must resolve both launch kinds before any desk runs' });
    return;
  }
  // Desk-scoped step names: every driveDesk step is qualified by its desk.
  const stopDesk = (name: string, result: DeskStepResult): void => stop(`desk-${state.nodeId}-${name}`, result);

  // --- author loop ---
  if (!isStopped()) stopDesk('admit-author-intent', admitIntent(config, state, 'author', authorSlot, [state.itemInstanceId, ...config.handoff.terminalClaims.map((ref) => ref.ref)]));
  let authorActor: FormalizationActorRunResult | undefined;
  if (!isStopped()) {
    const round = await runActorRound(config, state, 'author', authorSlot, state.scripts.author);
    authorActor = round.actor;
    stopDesk('author-cognition', round.result);
  }
  if (!isStopped()) stopDesk('author-contribution', consumeTarget(session, 'workplace.recordContribution', {}, config, workplace));
  if (!isStopped()) stopDesk('author-seal-revision', consumeTarget(session, 'workplace.sealProductionRevision', {}, config, workplace));
  if (!isStopped()) stopDesk('author-present-candidates', consumeTarget(session, 'workplace.presentCandidateSet', {}, config, workplace));

  // --- author gate: the desk's DECLARED semantic provider decides ---
  if (!isStopped()) {
    let verdict = config.verdictOverrides?.[state.nodeId]?.authorGate;
    if (verdict === undefined) {
      const provider = deskProviderOf(state.nodeId);
      const candidate = state.authored?.candidate ?? actorProductOf(authorActor, state.productKind);
      if (provider !== undefined && candidate !== undefined) {
        const gateOutcome = evaluateProductGate(provider, candidate, accepted);
        if ('refused' in gateOutcome) {
          stopDesk('author-gate', { status: 'actor-refused', detail: `${gateOutcome.reason}: ${gateOutcome.detail}` });
          return;
        }
        state.gateOutcomes.authorGate = gateOutcome;
        verdict = gateOutcome.verdict;
      } else {
        // The shell desk and provider-less desks accept on external input evidence.
        verdict = 'accepted';
      }
    }
    stopDesk('author-gate', ensureCommand(
      session,
      'workplace.runAuthorGate',
      workplace,
      `formalization:author-gate:${state.nodeId}`,
      { gateVerdict: verdict },
      config,
      (s) => eventExists(s, 'workplace.runAuthorGate', workplace),
    ));
  }

  // --- reviewer loop ---
  if (!isStopped()) stopDesk('admit-reviewer-intent', admitIntent(config, state, 'reviewer', reviewerSlot, [state.itemInstanceId]));
  let reviewerActor: FormalizationActorRunResult | undefined;
  if (!isStopped()) {
    const round = await runActorRound(config, state, 'reviewer', reviewerSlot, state.scripts.reviewer);
    reviewerActor = round.actor;
    stopDesk('reviewer-cognition', round.result);
  }
  if (!isStopped()) stopDesk('reviewer-contribution', consumeTarget(session, 'workplace.recordContribution', {}, config, workplace));
  if (!isStopped()) stopDesk('reviewer-seal-revision', consumeTarget(session, 'workplace.sealProductionRevision', {}, config, workplace));
  if (!isStopped()) stopDesk('reviewer-present-candidates', consumeTarget(session, 'workplace.presentCandidateSet', {}, config, workplace));

  // --- final gate: the reviewer verdict (typed payload) ---
  if (!isStopped()) {
    const verdict = config.verdictOverrides?.[state.nodeId]?.finalGate ?? reviewerActor?.verdict ?? 'accepted';
    state.gateOutcomes.finalGate = { verdict, issues: [], providerId: 'reviewer-verdict-set' };
    stopDesk('final-gate', ensureCommand(
      session,
      'workplace.runFinalGate',
      workplace,
      `formalization:final-gate:${state.nodeId}`,
      { gateVerdict: verdict },
      config,
      (s) => eventExists(s, 'workplace.runFinalGate', workplace),
    ));
  }

  // --- idempotent effect settlement (R13: settleEffect is the sole writer) ---
  if (!isStopped()) {
    const contentDigest = state.gateOutcomes.authorGate?.productRef ?? `desk:${state.nodeId}`;
    const settlement = config.effects.execute(state.effectId as 'formalization.accept-products', contentDigest, () =>
      config.effectSink === undefined ? `effect:${state.effectId}:${contentDigest}` : config.effectSink(state.effectId, contentDigest),
    );
    stopDesk('settle-effect', consumeTarget(
      session,
      'workplace.settleEffect',
      { effectOutcome: settlement.outcome },
      config,
      workplace,
    ));
  }

  // --- acceptance + closure + workplace terminal proof ---
  if (!isStopped()) stopDesk('final-acceptance', ensureCommand(
    session,
    'workplace.recordFinalAcceptance',
    workplace,
    `formalization:final-acceptance:${state.nodeId}`,
    {},
    config,
    (s) => eventExists(s, 'workplace.recordFinalAcceptance', workplace),
  ));
  if (!isStopped()) stopDesk('close-presentation', consumeTarget(session, 'workplace.closePresentation', {}, config, workplace));
  if (!isStopped()) stopDesk('workplace-terminal-proof', ensureCommand(
    session,
    'workplace.issueWorkplaceTerminalProof',
    workplace,
    `formalization:workplace-terminal:${state.nodeId}`,
    { terminalOutcome: 'success' },
    config,
    (s) => headOf(s, workplace)?.terminal !== undefined,
  ));
}

/* ------------------------------------------------------------------ */
/* Node entry + node settlement                                        */
/* ------------------------------------------------------------------ */

interface NodeBinding {
  readonly node: InstanceId;
  readonly workplace: InstanceId;
  readonly token: string;
}

function isDeskStepResult(value: NodeBinding | DeskStepResult): value is DeskStepResult {
  return 'status' in value;
}

/** Enter one flow desk: enterNode lane -> nodeRun.create/materializeCell -> workplace.materialize. */
function enterDeskNode(
  config: FormalizationRunConfig,
  nodeId: string,
  token: string,
  processInstanceId: InstanceId,
): NodeBinding | DeskStepResult {
  const session = config.session;
  const holders = topologyBindings(worldOf(session)).tokenHolders(token);
  if (holders.nodes.length > 0 && holders.workplaces.length > 0) {
    return { node: holders.nodes[0], workplace: holders.workplaces[0], token };
  }
  const entry = frontierEntryOf(session, 'processRun.enterNode');
  if (entry === undefined) return { status: 'actor-refused', detail: `no open enterNode obligation for desk ${nodeId} (flow exhausted or out of order)` };
  if (entry.claim === undefined) return { status: 'refused', refusal: entry.refusal as TypedRefusal };
  // The enterNode lane's FIFO head may be a lingering advance row of an
  // earlier flow: the command applies to THIS stage's process (pinned).
  const entered = consumer.consumeClaim(session, pinClaim(session, entry.claim, processInstanceId), {}, { externalEvidence: config.externalEvidence });
  if (entered.status === 'refused') return { status: 'refused', refusal: entered.refusal };
  const node = `formalization-node:${nodeId}`;
  const nodeCreated = ensureCommand(
    session,
    'nodeRun.create',
    node,
    `formalization:create-node:${nodeId}`,
    { evidenceRefs: [token] },
    config,
    (s) => eventExists(s, 'nodeRun.create', node),
  );
  if (nodeCreated.status === 'refused') return nodeCreated;
  const cellMaterialized = ensureCommand(
    session,
    'nodeRun.materializeCell',
    node,
    `formalization:materialize-cell:${nodeId}`,
    { evidenceRefs: [token] },
    config,
    (s) => eventExists(s, 'nodeRun.materializeCell', node),
  );
  if (cellMaterialized.status === 'refused') return cellMaterialized;
  const workplace = `formalization-workplace:${nodeId}`;
  const materialized = consumeTarget(session, 'workplace.materialize', { evidenceRefs: [token] }, config, workplace);
  if (materialized.status === 'refused') return materialized;
  const bound = topologyBindings(worldOf(session)).tokenHolders(token);
  return {
    node,
    workplace: bound.workplaces[0] ?? workplace,
    token,
  };
}

/** Settle one desk's node: recordNodeTerminal -> kernel result -> cell acceptance. */
function settleDeskNode(
  config: FormalizationRunConfig,
  binding: NodeBinding,
  nodeId: string,
  processInstanceId: InstanceId,
): DeskStepResult {
  const session = config.session;
  const acceptanceRefs = topologyBindings(worldOf(session)).acceptanceRefsOfWorkplace(binding.workplace);
  const terminal = ensureCommand(
    session,
    'processRun.recordNodeTerminal',
    processInstanceId,
    `formalization:node-terminal:${nodeId}`,
    { evidenceRefs: [binding.token, ...acceptanceRefs] },
    config,
    (s) => eventExists(s, 'processRun.recordNodeTerminal', processInstanceId, binding.token),
  );
  if (terminal.status === 'refused') return terminal;
  const kernel = consumeKindOn(session, 'obligation:freezeCandidate', 'nodeRun.recordKernelResult', binding.node, {}, config);
  if (kernel.status === 'refused') return kernel;
  const acceptance = consumeKindOn(session, 'obligation:completeCellNode', 'nodeRun.recordCellAcceptance', binding.node, {}, config);
  if (acceptance.status === 'refused') return acceptance;
  return { status: 'committed' };
}

/* ------------------------------------------------------------------ */
/* The full run                                                        */
/* ------------------------------------------------------------------ */

/** The handoff-sourced accepted-material state (the chain seed). */
export function initialAcceptedOf(config: FormalizationRunConfig): AcceptedMaterial {
  return acceptedMaterialOfHandoff({
    digest: config.handoff.digest,
    sourceClaimIds: config.handoff.sourceClaimIds,
    constraintIds: config.handoff.constraints.map((ref) => ref.ref),
    unknownIds: config.handoff.unknowns.map((ref) => ref.ref),
    terminalClaimIds: config.handoff.terminalClaimIds,
  });
}

/**
 * Drive the complete Formalization run through public commands. Stateless
 * over durable facts: re-drive after any crash converges (each step checks
 * its own durable postcondition).
 */
export async function runFormalizationWorkshop(config: FormalizationRunConfig): Promise<FormalizationRunResult> {
  const session = config.session;
  const steps: { step: string; result: DeskStepResult }[] = [];
  const desks: { nodeId: string; workplace?: InstanceId; productRef?: string; gateVerdict?: string }[] = [];
  let accepted = initialAcceptedOf(config);
  let stopped = false;
  const stop = (step: string, result: DeskStepResult): void => {
    if (stopped) return;
    steps.push({ step, result });
    if (result.status === 'refused' || result.status === 'actor-refused' || result.status === 'acceptance-refused' || config.stopAfter === step) {
      stopped = true;
    }
  };

  /* --- conveyor spine to the imported-Discovery shell stage --- */
  stop('factory-start', consumeTarget(session, 'factoryRun.start', {}, config));
  stop('lifecycle-create', consumeTarget(session, 'lifecycleRun.create', {}, config));
  stop('shell-stage-create', consumeTarget(session, 'stageRun.create', {}, config));
  const shellStage = earliestInstanceOf(session, 'StageRun') ?? latestInstanceOf(session, 'StageRun') ?? 'stage-run:1';
  stop('shell-stage-activate', ensureCommand(session, 'stageRun.activate', shellStage, 'formalization:activate-shell-stage', {}, config, (s) => eventExists(s, 'stageRun.activate', shellStage)));
  stop('shell-process-create', consumeTarget(session, 'processRun.create', {}, config));
  const shellProcess = earliestInstanceOf(session, 'ProcessRun') ?? latestInstanceOf(session, 'ProcessRun') ?? 'process-run:1';

  /* --- the imported-Discovery shell desk (accepted material = the capsule) --- */
  const shellToken = 'plan:discovery-handoff#item:import';
  const shellBinding = enterDeskNode(config, 'import-discovery-handoff', shellToken, shellProcess);
  if (isDeskStepResult(shellBinding)) {
    stop('shell-node-enter', shellBinding);
  } else {
    const shellItem = 'formalization-item:import-discovery-handoff';
    stop('shell-plan-item', ensureCommand(session, 'workItem.planGraph', shellItem, 'formalization:plan:shell', { evidenceRefs: [...planningRefs(session)] }, config, (s) => eventExists(s, 'workItem.planGraph', shellItem)));
    const shellState: DeskDriverState = {
      nodeId: 'import-discovery-handoff',
      workplace: shellBinding.workplace,
      itemInstanceId: shellItem,
      token: shellToken,
      productKind: 'formalization.discovery-import.v1',
      effectId: 'formalization.accept-products',
      scripts: config.shellScripts,
      gateOutcomes: {},
    };
    await driveDesk(config, shellState, accepted, stop, () => stopped);
    if (!stopped) stop('shell-node-settle', settleDeskNode(config, shellBinding, 'import-discovery-handoff', shellProcess));
    stop('shell-process-settle', consumeTarget(session, 'processRun.settle', { terminalOutcome: 'success' }, config, shellProcess));
    stop('shell-stage-outcome', consumeKindOn(session, 'obligation:recordStageOutcome', 'stageRun.recordLocalOutcome', shellStage, { terminalOutcome: 'success' }, config));
  }

  /* --- route into the Formalization stage (the D0 handoff route) --- */
  const lifecycle = latestInstanceOf(session, 'LifecycleRun') ?? 'lifecycle-run:1';
  stop('route-solution-formalization', consumeKindOn(session, 'obligation:routeLifecycle', 'lifecycleRun.routeOutcome', lifecycle, { stageRoute: 'solution-formalization' }, config));
  stop('formalization-stage-create', consumeTarget(session, 'stageRun.create', {}, config));
  const formalizationStage = latestInstanceOf(session, 'StageRun') ?? 'stage-run:2';
  stop('formalization-stage-activate', ensureCommand(session, 'stageRun.activate', formalizationStage, 'formalization:activate-formalization-stage', {}, config, (s) => eventExists(s, 'stageRun.activate', formalizationStage)));
  stop('formalization-process-create', consumeTarget(session, 'processRun.create', {}, config));
  const formalizationProcess = latestInstanceOf(session, 'ProcessRun') ?? 'process-run:2';

  /* --- the eight formalization desks over the installed module flow --- */
  for (const nodeId of deskNodeIds()) {
    if (stopped) break;
    const node = nodeOf(nodeId);
    if (!node.ok || node.node.desk === undefined) continue;
    const token = `plan:solution-formalization#item:${nodeId}`;
    const binding = enterDeskNode(config, nodeId, token, formalizationProcess);
    if (isDeskStepResult(binding)) {
      stop(`desk-${nodeId}-node-enter`, binding);
      break;
    }
    const item = `formalization-item:${nodeId}`;
    stop(`desk-${nodeId}-plan-item`, ensureCommand(session, 'workItem.planGraph', item, `formalization:plan:${nodeId}`, { evidenceRefs: [...planningRefs(session)] }, config, (s) => eventExists(s, 'workItem.planGraph', item)));
    const state: DeskDriverState = {
      nodeId,
      workplace: binding.workplace,
      itemInstanceId: item,
      token,
      productKind: node.node.desk.outputProductKind,
      effectId: node.node.desk.effectId,
      authored: config.authored[nodeId],
      scripts: config.scripts[nodeId] ?? config.shellScripts,
      gateOutcomes: {},
    };
    await driveDesk(config, state, accepted, stop, () => stopped);
    if (!stopped) stop(`desk-${nodeId}-node-settle`, settleDeskNode(config, binding, nodeId, formalizationProcess));

    // Fold the accepted material ONLY on an accepted author gate (the
    // production-revision authority chain moves forward).
    const gate = state.gateOutcomes.authorGate;
    if (gate?.verdict === 'accepted' && gate.productRef !== undefined && state.authored !== undefined) {
      const artifact = { ref: gate.productRef, digest: gate.productRef.replace(/^sha256:/, ''), content: null };
      if (nodeId === 'define-product-intent') {
        accepted = acceptedScenarioRequiredAfter(state.authored.scenarioRequiredMemberIds ?? [], acceptedMaterialAfter(accepted, state.productKind, artifact, state.authored.memberIds));
      } else if (nodeId === 'freeze-what-baseline') {
        accepted = acceptedBaselineAfter(accepted, artifact.digest, (state.authored.candidate.product as { wholeWhatDigest: string }).wholeWhatDigest);
      } else {
        accepted = acceptedMaterialAfter(accepted, state.productKind, artifact, state.authored.memberIds);
      }
    }
    desks.push({
      nodeId,
      workplace: binding.workplace,
      productRef: gate?.productRef,
      gateVerdict: gate?.verdict,
    });
  }

  /* --- settlement ladder: process -> stage -> lifecycle -> run --- */
  stop('formalization-process-settle', consumeTarget(session, 'processRun.settle', { terminalOutcome: 'success' }, config, formalizationProcess));
  stop('formalization-stage-outcome', consumeKindOn(session, 'obligation:recordStageOutcome', 'stageRun.recordLocalOutcome', formalizationStage, { terminalOutcome: 'success' }, config));
  stop('route-verify-terminal-claims', consumeKindOn(session, 'obligation:routeLifecycle', 'lifecycleRun.routeOutcome', lifecycle, { stageRoute: 'verify-terminal-claims' }, config));
  stop('verify-terminal-claims', consumeKindOn(session, 'obligation:verifyTerminalClaims', 'lifecycleRun.verifyTerminalClaims', lifecycle, {}, config));
  stop('lifecycle-terminal-proof', ensureCommand(session, 'lifecycleRun.issueTerminalProof', lifecycle, 'formalization:lifecycle-terminal', { terminalOutcome: 'success' }, config, (s) => headOf(s, lifecycle)?.terminal !== undefined));
  const factory = 'factory-run:1';
  stop('run-settlement', consumeKindOn(session, 'obligation:runSettlement', 'factoryRun.recordRunTerminalProof', factory, { terminalOutcome: 'success' }, config));
  stop('run-terminal-proof', ensureCommand(session, 'factoryRun.recordRunTerminalProof', factory, 'formalization:run-terminal', { terminalOutcome: 'success' }, config, (s) => headOf(s, factory)?.terminal !== undefined));

  const blocked = steps.find((entry) => entry.result.status === 'refused' || entry.result.status === 'actor-refused' || entry.result.status === 'acceptance-refused');
  const stagedAt = config.stopAfter !== undefined && steps.some((entry) => entry.step === config.stopAfter) ? config.stopAfter : undefined;
  return { steps, blockedAt: blocked?.step ?? stagedAt, accepted, desks };
}

/* ------------------------------------------------------------------ */
/* Typed wait scenarios (D5/D12 through the public command path)        */
/* ------------------------------------------------------------------ */

/** A drift verdict at the freeze desk: typed human-input wait (D5). */
export function freezeDriftHumanWait(
  config: FormalizationRunConfig,
  workplace: InstanceId,
): { readonly enter: DeskStepResult; readonly descriptor: { readonly kind: 'TypedWait:human-input'; readonly wakeCommands: readonly string[] }; readonly resolve: DeskStepResult } {
  const session = config.session;
  const enter = ensureCommand(
    session,
    'workplace.enterHumanWait',
    workplace,
    `formalization:drift-human-wait:${workplace}`,
    {},
    config,
    (s) => headOf(s, workplace)?.status === 'human-wait-entered',
  );
  const resolve = ensureCommand(
    session,
    'workplace.resolveHumanResponse',
    workplace,
    `formalization:drift-human-resolution:${workplace}`,
    {},
    config,
    (s) => headOf(s, workplace)?.status === 'human-response-resolved',
  );
  return {
    enter,
    descriptor: { kind: 'TypedWait:human-input', wakeCommands: ['workplace.resolveHumanResponse'] },
    resolve,
  };
}

/**
 * D12 effect-uncertainty loop: the effect settles UNKNOWN; the typed wait
 * requires an OPERATOR disposition (never an automatic duplicate); the
 * operator resolves; the effect resumes and settles idempotently.
 */
export function effectUncertaintyLoop(
  config: FormalizationRunConfig,
  workplace: InstanceId,
): { readonly uncertain: DeskStepResult; readonly resolve: DeskStepResult; readonly resume: DeskStepResult } {
  const session = config.session;
  const uncertain = consumeTarget(session, 'workplace.settleEffect', { effectOutcome: 'unknown' }, config, workplace);
  const resolve = ensureCommand(
    session,
    'workplace.resolveHumanResponse',
    workplace,
    `formalization:uncertainty-resolution:${workplace}`,
    {},
    config,
    (s) => headOf(s, workplace)?.status === 'human-response-resolved',
  );
  const resume = consumeTarget(session, 'workplace.settleEffect', { effectOutcome: 'already-applied' }, config, workplace);
  return { uncertain, resolve, resume };
}

/** The repair loop: a repair verdict enters the typed repair wait and requeues the AUTHOR identity (same pin). */
export function repairLoopScenario(
  config: FormalizationRunConfig,
  workplace: InstanceId,
): { readonly enter: DeskStepResult; readonly requeue: DeskStepResult } {
  const session = config.session;
  const enter = ensureCommand(
    session,
    'workplace.enterRepairWait',
    workplace,
    `formalization:repair-wait:${workplace}`,
    {},
    config,
    (s) => headOf(s, workplace)?.status === 'repair-wait-entered',
  );
  const authorSlot = config.roles.slotOf(FORMALIZATION_AUTHOR_LAUNCH_KIND);
  const requeue = ensureCommand(
    session,
    'workplace.admitWorkIntent',
    workplace,
    `formalization:repair-requeue:${workplace}`,
    {
      protocolRole: 'author',
      ...(authorSlot !== undefined ? { rolePin: authorSlot.pin as CanonicalRoleContractReference } : {}),
      evidenceRefs: [workplace],
    },
    config,
    (s) => headOf(s, workplace)?.status === 'author-intent-admitted',
  );
  return { enter, requeue };
}

/** The contribution mapping of one desk's authored product (pure, for tests). */
export function deskContributionOf(nodeId: string, intentRef: string, productRef: string, productKind: string): ReturnType<typeof contributionOf> {
  void nodeId;
  return contributionOf(intentRef, productKind, { ref: productRef, digest: productRef.replace(/^sha256:/, ''), content: null });
}
