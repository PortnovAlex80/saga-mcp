/**
 * workflow-kernel/development/material-chain.ts - the Development material
 * chain vertical (WP-08, plan phase EK-5): the first hard vertical.
 *
 * The chain, through the NEW commands/events/obligations ONLY:
 *
 *   capsule ingress (capsule.ts)
 *     -> factoryRun.start -> lifecycleRun.create -> stageRun.create/activate
 *     -> processRun.create/enterNode -> nodeRun.create/materializeCell
 *     -> workplace.materialize (the production cell)
 *     -> workItem.planGraph (immutable planning facts from the capsule)
 *     -> WorkIntent (workplace.admitWorkIntent; role contract resolved ONCE)
 *     -> ActivityAttempt (activityAttempt.create; SAME pin copied)
 *     -> cognition (the actors: admitProviderRequest at the exact pre-send
 *        boundary -> cognition.sendProviderRequest -> recordOutcome)
 *     -> contribution (workplace.recordContribution)
 *     -> PRODUCTION REVISION (workplace.sealProductionRevision - the
 *        accepted-material authority, ADR-053; the attempt is provenance)
 *     -> CandidateSet (workplace.presentCandidateSet)
 *     -> author gate (workplace.runAuthorGate)
 *     -> reviewer desk -> reviewer loop -> final gate (workplace.runFinalGate)
 *     -> effect (workplace.settleEffect - product build/start/smoke verified)
 *     -> CellFinalAcceptance (workplace.recordFinalAcceptance)
 *     -> closePresentation -> workplace terminal proof
 *     -> node/process/stage/lifecycle/run settlement.
 *
 * IDENTITY LAW (ADR-053 + FWD:F007): the author, reviewer and repair
 * WorkIntents each pin the exact CanonicalRoleContract reference/digest from
 * the ONE runtime resolution; repair re-admission reuses the AUTHOR identity
 * (same pin); the accepted material authority is the workplace production
 * revision bound to the Workplace - gates and acceptance bind revision
 * material, never the attempt.
 *
 * REPAIR ROUTING LAW: out-of-scope / upstream-material defects surface as
 * GateDecision:upstream-repair and are routed through the typed
 * obligation:routeUpstreamRepair; Development is NEVER silently widened
 * (workplace.widenAuthorityScope is an explicit operator command only).
 *
 * Every step is idempotent over durable facts (re-drive after any crash
 * converges). The driver writes ONLY through sole-writer repositories and
 * the WP-07 obligation consumer - the public command path.
 */

import type { CommandInput, CommandOutcome, EvidenceFact, TypedRefusal } from '../domain/types.js';
import { COMMANDS } from '../domain/universe.js';
import type { CommandName, ObligationKind } from '../domain/universe.js';
import { reducerForCommand } from '../domain/reducers/index.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import * as consumer from '../application/obligation-consumer.js';
import type { ObligationClaim, ConsumeInvocation } from '../application/obligation-consumer.js';
import type { CognitionTransportContract } from '../context-envelope/transport.js';
import type { ActorRunResult, ActorScript } from './actors.js';
import { ScriptedActor } from './actors.js';
import type { RoleContractRuntime, ResolvedRoleSlot } from './role-contract-runtime.js';
import type { RequiredTaskInfo } from './envelope-assembly.js';

/* ------------------------------------------------------------------ */
/* Instance identity (deterministic, durable-postcondition checked)     */
/* ------------------------------------------------------------------ */

export const INSTANCES = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
  workItemImplement: 'work-item:1',
  workItemVerify: 'work-item:2',
} as const;

/** The external Input-authority evidence (CheckPlan + the verifier actor result). */
export function externalInputEvidence(productEvidenceDigest: string, verificationOk: boolean): readonly EvidenceFact[] {
  return [
    { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input', payloadDigest: productEvidenceDigest },
    verificationOk
      ? { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: productEvidenceDigest }
      : { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: productEvidenceDigest },
  ];
}

export interface DevelopmentVerticalConfig {
  readonly session: KernelPersistenceSession;
  readonly roles: RoleContractRuntime;
  readonly authorLaunchKind: string;
  readonly reviewerLaunchKind: string;
  readonly transport: CognitionTransportContract;
  readonly taskSummary: string;
  readonly requiredInfo: RequiredTaskInfo;
  /** Runs the real product acceptance check; the effect settles on its verdict. */
  readonly verifyProduct: () => Promise<{ readonly ok: boolean; readonly detail: string; readonly digest: string }>;
  /** Extra assembly inputs carried into every actor envelope (recovery memory etc.). */
  readonly assemblyExtras?: Record<string, readonly string[]>;
  readonly externalEvidence: readonly EvidenceFact[];
}

export type StepResult =
  | { readonly status: 'committed' | 'replayed' | 'skipped' }
  | { readonly status: 'refused'; readonly refusal: TypedRefusal }
  | { readonly status: 'actor-refused'; readonly detail: string }
  | { readonly status: 'acceptance-refused'; readonly reason: string; readonly detail: string };

/* ------------------------------------------------------------------ */
/* Driver internals                                                    */
/* ------------------------------------------------------------------ */

function worldOf(session: KernelPersistenceSession) {
  return session.hydrateWorld().world;
}

function eventExists(session: KernelPersistenceSession, transition: CommandName, instanceId: string): boolean {
  return worldOf(session).events.some((event) => event.transition === transition && event.sourceInstanceId === instanceId);
}

function headOf(session: KernelPersistenceSession, instanceId: string) {
  return worldOf(session).heads.get(instanceId);
}

function intentOf(session: KernelPersistenceSession, workplaceId: string, role: 'author' | 'reviewer') {
  const intents = [...worldOf(session).workIntents.values()].filter((intent) => intent.workplaceInstanceId === workplaceId && intent.protocolRole === role);
  return intents[intents.length - 1];
}

function openObligationOf(session: KernelPersistenceSession, kind: ObligationKind) {
  return worldOf(session).obligations.find((obligation) => obligation.kind === kind && obligation.state === 'open');
}

function aggregateOf(command: CommandName) {
  const descriptor = COMMANDS.find((entry) => entry.name === command);
  if (!descriptor) {
    throw new Error(`EK_VERTICAL: unknown command ${command}`);
  }
  return descriptor.aggregate;
}

function repoFor(session: KernelPersistenceSession, command: CommandName) {
  return consumer.repositoryOf(session, aggregateOf(command));
}

/** Apply one driver-direct command idempotently through the owning repository. */
function ensureCommand(
  session: KernelPersistenceSession,
  spec: { readonly command: CommandName; readonly instanceId: string; readonly key: string; readonly done: (session: KernelPersistenceSession) => boolean },
  fields: Partial<CommandInput>,
  config: DevelopmentVerticalConfig,
): StepResult {
  if (spec.done(session)) {
    return { status: 'skipped' };
  }
  const head = headOf(session, spec.instanceId);
  const input: CommandInput = {
    command: spec.command,
    instanceId: spec.instanceId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: spec.key,
    ...fields,
  };
  const outcome: CommandOutcome = repoFor(session, spec.command).applyCommand(input, { externalEvidence: config.externalEvidence });
  if ('refused' in outcome) {
    return { status: 'refused', refusal: outcome };
  }
  return { status: 'replayed' in outcome ? 'replayed' : 'committed' };
}

/** Consume the open obligation of one kind with an EXPLICIT target instance (cross-aggregate edges). */
function consumeKindOn(
  session: KernelPersistenceSession,
  kind: ObligationKind,
  targetInstance: string,
  invocation: ConsumeInvocation,
  config: DevelopmentVerticalConfig,
): StepResult {
  const obligation = openObligationOf(session, kind);
  if (obligation === undefined) {
    return { status: 'skipped' };
  }
  const target = obligation.target as CommandName;
  const head = headOf(session, targetInstance);
  if (!transitionLegalFrom(target, head)) {
    // The target aggregate already moved past this command's legal statuses
    // (idempotent re-drive): the leftover obligation row stays durable.
    return { status: 'skipped' };
  }
  const claim: ObligationClaim = {
    index: worldOf(session).obligations.indexOf(obligation),
    kind: obligation.kind,
    target,
    targetAggregate: aggregateOf(target),
    sourceInstanceId: obligation.sourceInstanceId,
    targetInstanceId: targetInstance,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `consume:${obligation.idempotencyKey}`,
    evidenceRefs: [...obligation.evidenceRefs],
  };
  return consumeClaim(session, claim, invocation, config);
}

function consumeClaim(
  session: KernelPersistenceSession,
  claim: ObligationClaim,
  invocation: ConsumeInvocation,
  config: DevelopmentVerticalConfig,
): StepResult {
  const result = consumer.consumeClaim(session, claim, invocation, { externalEvidence: config.externalEvidence });
  if (result.status === 'refused') {
    return { status: 'refused', refusal: result.refusal };
  }
  return { status: result.status };
}

/** True when some rule of the command is legal from the head's status (idempotent re-drive skip oracle). */
function transitionLegalFrom(command: CommandName, head: { readonly status: string } | undefined): boolean {
  if (head === undefined) return true; // creation commands
  const resolved = reducerForCommand(command);
  if (!resolved) return false;
  return resolved.reducer.transitions.some((rule) => rule.command === command && rule.fromStatuses.includes(head.status));
}

/** Consume the open obligation of one kind whose target resolves durably.
 *
 * Frontier discipline (WP-07): the engine completes the LOWEST-id open
 * obligation of the target command, so only the frontier's chosen row of a
 * target may be claimed; a kind shadowed by an earlier same-target
 * obligation (e.g. openReviewerDesk behind planGraph's openUnknownObligation)
 * is NOT consumed here - its command is driver-direct (the obligation stays
 * as durable routing evidence). A target whose aggregate already moved past
 * the command's legal statuses skips (idempotent re-drive).
 */
function consumeKind(
  session: KernelPersistenceSession,
  kind: ObligationKind,
  invocation: ConsumeInvocation,
  config: DevelopmentVerticalConfig,
): StepResult {
  const frontier = consumer.openFrontier(session).find((entry) => entry.kind === kind);
  if (frontier === undefined) {
    return { status: 'skipped' };
  }
  if (frontier.refusal !== undefined || frontier.claim === undefined) {
    return { status: 'skipped' };
  }
  const head = headOf(session, frontier.claim.targetInstanceId);
  if (!transitionLegalFrom(frontier.claim.target, head)) {
    return { status: 'skipped' };
  }
  return consumeClaim(session, frontier.claim, invocation, config);
}

/** The pinned role-contract reference of a resolved launch kind. */
function pinOf(config: DevelopmentVerticalConfig, launchKind: string) {
  const slot = config.roles.slotOf(launchKind);
  if (slot === undefined) {
    throw new Error(`EK_VERTICAL: launch kind ${launchKind} was never resolved at WorkIntent creation`);
  }
  return slot.pin;
}

/** Planning evidence refs: the capsule facts recorded by factoryRun.importCapsule. */
function planningRefs(session: KernelPersistenceSession): readonly string[] {
  return worldOf(session)
    .evidence.filter((fact) => fact.kind === 'TerminalLifecycleClaim' || fact.kind === 'ConstructionSurface' || fact.kind === 'TerminalClaimCoverage')
    .map((fact) => fact.ref);
}

/* ------------------------------------------------------------------ */
/* The actor step (admission + send + outcome through the shared port)  */
/* ------------------------------------------------------------------ */

/** Run one actor over an attempt: admission through the SAME port, then the kernel send/outcome commands. */
async function runActorAttempt(
  config: DevelopmentVerticalConfig,
  options: {
    readonly attemptInstanceId: string;
    readonly launchKind: string;
    readonly script: ActorScript;
  },
): Promise<{ readonly result: StepResult; readonly actor?: ActorRunResult }> {
  const session = config.session;
  const slot: ResolvedRoleSlot | undefined = config.roles.slotOf(options.launchKind);
  if (slot === undefined) {
    return { result: { status: 'actor-refused', detail: `launch kind ${options.launchKind} was never resolved at WorkIntent creation` } };
  }
  const attemptHead = headOf(session, options.attemptInstanceId);
  if (attemptHead?.status === 'outcome-recorded' || attemptHead?.status === 'provider-refusal-recorded' || attemptHead?.status === 'cancelled') {
    // Idempotent re-drive: the attempt already reached its terminal outcome;
    // re-running the actor would re-admit a dead attempt (fail-closed skip).
    return { result: { status: 'skipped' } };
  }
  const intent = intentOf(session, INSTANCES.workplace, slot.protocolRole);
  if (intent === undefined) {
    return { result: { status: 'actor-refused', detail: `no ${slot.protocolRole} WorkIntent admitted for ${INSTANCES.workplace}` } };
  }
  const launch = openObligationOf(session, 'obligation:launchAdmission');
  const actor = new ScriptedActor(config.transport, options.script);
  const run = await actor.run({
    attemptRef: options.attemptInstanceId,
    roleContract: slot.contract,
    taskSummary: config.taskSummary,
    requiredInfo: config.requiredInfo,
    idempotencyKeyPrefix: `consume:${launch === undefined ? `attempt:${options.attemptInstanceId}` : launch.idempotencyKey}`,
    expectedContextRevision: 0,
    ...(config.assemblyExtras === undefined ? {} : { assembly: config.assemblyExtras }),
  });
  if ('refused' in run) {
    return { result: { status: 'actor-refused', detail: `${run.reason}: ${run.detail}` } };
  }
  // The kernel provider-send obligation completes behind the admitted receipt.
  const send = consumeKind(session, 'obligation:providerSend', {}, config);
  if (send.status === 'refused') {
    return { result: send };
  }
  // The WorkIntent completion command records the ordinary outcome.
  const outcome = ensureCommand(
    session,
    {
      command: 'activityAttempt.recordOutcome',
      instanceId: options.attemptInstanceId,
      key: `vertical:outcome:${options.attemptInstanceId}`,
      done: (s) => headOf(s, options.attemptInstanceId)?.status === 'outcome-recorded',
    },
    { evidenceRefs: [intent.intentRef, run.result.outcomeDigest] },
    config,
  );
  if (outcome.status === 'refused') {
    return { result: outcome };
  }
  return { result: { status: 'committed' }, actor: run.result };
}

/** Create an attempt from the exact WorkIntent with the SAME pin object. */
function createAttempt(config: DevelopmentVerticalConfig, key: string, attemptInstanceId: string, launchKind: string): StepResult {
  const session = config.session;
  const slot = config.roles.slotOf(launchKind);
  if (slot === undefined) {
    return { status: 'actor-refused', detail: `launch kind ${launchKind} was never resolved` };
  }
  const intent = intentOf(session, INSTANCES.workplace, slot.protocolRole);
  if (intent === undefined) {
    return { status: 'refused', refusal: { refused: true, reason: 'MISSING_EVIDENCE', detail: `no ${slot.protocolRole} WorkIntent` } };
  }
  return ensureCommand(
    session,
    { command: 'activityAttempt.create', instanceId: attemptInstanceId, key, done: (s) => headOf(s, attemptInstanceId) !== undefined },
    { workIntentRef: intent.intentRef, rolePin: intent.roleContract },
    config,
  );
}

/** The effect settles ONLY over the verified product (real acceptance check). */
async function settleEffectOverProduct(config: DevelopmentVerticalConfig): Promise<StepResult> {
  const verification = await config.verifyProduct();
  if (!verification.ok) {
    // Typed repair loop: a product verification failure routes as repair -
    // never a silent pass, never an invented success receipt.
    return { status: 'acceptance-refused', reason: 'PRODUCT_VERIFICATION', detail: verification.detail };
  }
  return consumeKind(config.session, 'obligation:runEffects', { effectOutcome: 'success' }, config);
}

/* ------------------------------------------------------------------ */
/* The vertical                                                        */
/* ------------------------------------------------------------------ */

export interface VerticalRunResult {
  readonly steps: readonly { readonly step: string; readonly result: StepResult }[];
  readonly blockedAt: string | undefined;
}

/**
 * Drive the Development vertical to the run terminal proof. Stateless over
 * durable facts: call after any crash on a reopened session to converge.
 */
export async function driveDevelopmentVertical(
  config: DevelopmentVerticalConfig,
  options: {
    readonly authorScript: ActorScript;
    readonly reviewerScript: ActorScript;
    readonly finalGateVerdict?: 'accepted' | 'upstream-repair' | 'human-wait';
    /** Stop after this step committed (scenario staging); later steps are skipped. */
    readonly stopAfter?: string;
  },
): Promise<VerticalRunResult> {
  const session = config.session;
  const steps: { step: string; result: StepResult }[] = [];
  let stopped = false;
  const done = (step: string, result: StepResult): void => {
    if (stopped) return;
    steps.push({ step, result });
    // A refused step BLOCKS the lane: the vertical stops (fail-closed); the
    // remaining steps are reported as skipped by their absence, and the
    // durable obligations/waits stay exactly as the refusal left them.
    if (options.stopAfter === step || result.status === 'refused' || result.status === 'actor-refused' || result.status === 'acceptance-refused') {
      stopped = true;
    }
  };
  /** Thunked step: the step body never executes once the vertical stopped. */
  const run = (step: string, body: () => StepResult): void => {
    if (stopped) return;
    done(step, body());
  };

  // --- conveyor spine to the production cell ---
  run('factory-start', () => consumeKind(session, 'obligation:ingestCapsuleFacts', {}, config));
  run('lifecycle-create', () => consumeKind(session, 'obligation:bootstrapLifecycleRun', {}, config));
  run('stage-create', () => consumeKind(session, 'obligation:enterStage.initial-discovery', {}, config));
  run('stage-activate', () => ensureCommand(session, { command: 'stageRun.activate', instanceId: INSTANCES.stage, key: 'vertical:activate-stage', done: (s) => eventExists(s, 'stageRun.activate', INSTANCES.stage) }, {}, config));
  run('process-create', () => consumeKind(session, 'obligation:bindProcessModule', {}, config));
  run('enter-node', () => consumeKindOn(session, 'obligation:enterFirstNode', INSTANCES.process, {}, config));
  run('node-create', () => ensureCommand(session, { command: 'nodeRun.create', instanceId: INSTANCES.node, key: 'vertical:create-node', done: (s) => eventExists(s, 'nodeRun.create', INSTANCES.node) }, {}, config));
  run('node-materialize-cell', () => ensureCommand(session, { command: 'nodeRun.materializeCell', instanceId: INSTANCES.node, key: 'vertical:materialize-cell', done: (s) => eventExists(s, 'nodeRun.materializeCell', INSTANCES.node) }, {}, config));
  run('workplace-materialize', () => consumeKind(session, 'obligation:materializeWorkplace.production-cell', {}, config));
  run('plan-graph-implement', () => ensureCommand(session, { command: 'workItem.planGraph', instanceId: INSTANCES.workItemImplement, key: 'vertical:plan-implement', done: (s) => eventExists(s, 'workItem.planGraph', INSTANCES.workItemImplement) }, { evidenceRefs: [...planningRefs(session)] }, config));
  run('plan-graph-verify', () => ensureCommand(session, { command: 'workItem.planGraph', instanceId: INSTANCES.workItemVerify, key: 'vertical:plan-verify', done: (s) => eventExists(s, 'workItem.planGraph', INSTANCES.workItemVerify) }, { evidenceRefs: [...planningRefs(session)] }, config));

  // --- author loop ---
  run('admit-author-intent', () => ensureCommand(
    session,
    { command: 'workplace.admitWorkIntent', instanceId: INSTANCES.workplace, key: 'vertical:admit-author', done: (s) => intentOf(s, INSTANCES.workplace, 'author') !== undefined },
    { protocolRole: 'author', rolePin: pinOf(config, config.authorLaunchKind), evidenceRefs: [INSTANCES.workItemImplement, ...config.requiredInfo.scope.map((ref) => ref.ref)] },
    config,
  ));
  run('author-attempt', () => createAttempt(config, 'vertical:attempt-author', 'activity-attempt:1', config.authorLaunchKind));
  if (!stopped) {
    const author = await runActorAttempt(config, { attemptInstanceId: 'activity-attempt:1', launchKind: config.authorLaunchKind, script: options.authorScript });
    done('author-cognition', author.result);
  }
  run('author-contribution', () => consumeKind(session, 'obligation:submitContribution', {}, config));
  run('author-seal-revision', () => consumeKind(session, 'obligation:sealRevision', {}, config));
  run('author-present-candidates', () => consumeKind(session, 'obligation:presentCandidates', {}, config));
  run('author-gate', () => consumeKind(session, 'obligation:runGate.author', { gateVerdict: 'accepted' }, config));
  // The reviewer desk: the accepted author gate's openReviewerDesk obligation
  // is the guard evidence for the reviewer intent admission. It is NOT
  // consumed as a claim: the engine's frontier completes the lowest-id open
  // obligation per target (planGraph's openUnknownObligation shadows every
  // later admitWorkIntent edge), so the desk step verifies the obligation
  // exists and the intent admission runs driver-direct (exempt command).
  run('reviewer-desk', () => deskOpen(config));

  // --- reviewer loop ---
  run('admit-reviewer-intent', () => ensureCommand(
    session,
    { command: 'workplace.admitWorkIntent', instanceId: INSTANCES.workplace, key: 'vertical:admit-reviewer', done: (s) => intentOf(s, INSTANCES.workplace, 'reviewer') !== undefined },
    { protocolRole: 'reviewer', rolePin: pinOf(config, config.reviewerLaunchKind), evidenceRefs: [INSTANCES.workItemVerify, ...config.requiredInfo.terminalClaims.map((ref) => ref.ref)] },
    config,
  ));
  run('reviewer-attempt', () => createAttempt(config, 'vertical:attempt-reviewer', 'activity-attempt:2', config.reviewerLaunchKind));
  if (!stopped) {
    const reviewer = await runActorAttempt(config, { attemptInstanceId: 'activity-attempt:2', launchKind: config.reviewerLaunchKind, script: options.reviewerScript });
    done('reviewer-cognition', reviewer.result);
  }
  run('reviewer-contribution', () => consumeKind(session, 'obligation:submitContribution', {}, config));
  run('reviewer-seal-revision', () => consumeKind(session, 'obligation:sealRevision', {}, config));
  run('reviewer-present-candidates', () => consumeKind(session, 'obligation:presentCandidates', {}, config));
  run('final-gate', () => consumeKind(session, 'obligation:runGate.final', { gateVerdict: options.finalGateVerdict ?? 'accepted' }, config));

  // --- effect settlement over the VERIFIED product ---
  if (!stopped) {
    done('settle-effect', await settleEffectOverProduct(config));
  }

  // --- acceptance + closure + settlement ---
  run('final-acceptance', () => ensureCommand(session, { command: 'workplace.recordFinalAcceptance', instanceId: INSTANCES.workplace, key: 'vertical:final-acceptance', done: (s) => eventExists(s, 'workplace.recordFinalAcceptance', INSTANCES.workplace) }, {}, config));
  run('close-presentation', () => consumeKind(session, 'obligation:closePresentation', {}, config));
  run('workplace-terminal-proof', () => ensureCommand(session, { command: 'workplace.issueWorkplaceTerminalProof', instanceId: INSTANCES.workplace, key: 'vertical:workplace-proof', done: (s) => headOf(s, INSTANCES.workplace)?.terminal !== undefined }, { terminalOutcome: 'success' }, config));
  run('node-kernel-result', () => ensureCommand(session, { command: 'nodeRun.recordKernelResult', instanceId: INSTANCES.node, key: 'vertical:node-kernel-result', done: (s) => eventExists(s, 'nodeRun.recordKernelResult', INSTANCES.node) }, {}, config));
  run('node-cell-acceptance', () => consumeKindOn(session, 'obligation:completeCellNode', INSTANCES.node, {}, config));
  run('node-terminal', () => ensureCommand(session, { command: 'processRun.recordNodeTerminal', instanceId: INSTANCES.process, key: 'vertical:node-terminal', done: (s) => eventExists(s, 'processRun.recordNodeTerminal', INSTANCES.process) }, {}, config));
  run('process-settle', () => consumeKindOn(session, 'obligation:advanceProcessFlow.settle', INSTANCES.process, { terminalOutcome: 'success' }, config));
  run('stage-outcome', () => consumeKindOn(session, 'obligation:recordStageOutcome', INSTANCES.stage, { terminalOutcome: 'success' }, config));
  run('route-lifecycle', () => consumeKindOn(session, 'obligation:routeLifecycle', INSTANCES.lifecycle, { stageRoute: 'verify-terminal-claims' }, config));
  run('verify-terminal-claims', () => consumeKind(session, 'obligation:verifyTerminalClaims', {}, config));
  run('lifecycle-terminal-proof', () => ensureCommand(session, { command: 'lifecycleRun.issueTerminalProof', instanceId: INSTANCES.lifecycle, key: 'vertical:lifecycle-proof', done: (s) => headOf(s, INSTANCES.lifecycle)?.terminal !== undefined }, { terminalOutcome: 'success' }, config));
  run('run-terminal-proof', () => consumeKindOn(session, 'obligation:runSettlement', INSTANCES.factory, { terminalOutcome: 'success' }, config));

  const blocked = steps.find((entry) => entry.result.status === 'refused' || entry.result.status === 'actor-refused' || entry.result.status === 'acceptance-refused');
  return { steps, blockedAt: blocked?.step };
}

/* ------------------------------------------------------------------ */
/* Repair loop + upstream routing + human wait (public command path)    */
/* ------------------------------------------------------------------ */

/** Enter the repair wait after a repair verdict (RecoveryIssue + requeue). */
export function enterRepairWait(config: DevelopmentVerticalConfig): StepResult {
  return ensureCommand(
    config.session,
    { command: 'workplace.enterRepairWait', instanceId: INSTANCES.workplace, key: 'vertical:repair-wait', done: (s) => headOf(s, INSTANCES.workplace)?.status === 'repair-wait-entered' },
    {},
    config,
  );
}

/** Requeue after repair: re-admit the AUTHOR identity driver-direct (same pin - repair identity preserved). */
export function requeueRepairAsAuthor(config: DevelopmentVerticalConfig): StepResult {
  return ensureCommand(
    config.session,
    { command: 'workplace.admitWorkIntent', instanceId: INSTANCES.workplace, key: `vertical:repair-requeue`, done: (s) => headOf(s, INSTANCES.workplace)?.status === 'author-intent-admitted' },
    { protocolRole: 'author', rolePin: pinOf(config, config.authorLaunchKind), evidenceRefs: [INSTANCES.workItemImplement] },
    config,
  );
}

/** True when the accepted author gate's reviewer-desk obligation is open (the guard evidence). */
function deskOpen(config: DevelopmentVerticalConfig): StepResult {
  return openObligationOf(config.session, 'obligation:openReviewerDesk') !== undefined
    ? { status: 'committed' }
    : { status: 'skipped' };
}

/** The runtime human-wait scenario through the PUBLIC command path (typed waits, D12). */
export function humanWaitScenario(config: DevelopmentVerticalConfig): { readonly enter: StepResult; readonly resolve: StepResult } {
  const session = config.session;
  const enter = ensureCommand(
    session,
    { command: 'workplace.enterHumanWait', instanceId: INSTANCES.workplace, key: 'vertical:human-wait', done: (s) => headOf(s, INSTANCES.workplace)?.status === 'human-wait-entered' },
    {},
    config,
  );
  const resolve = ensureCommand(
    session,
    { command: 'workplace.resolveHumanResponse', instanceId: INSTANCES.workplace, key: 'vertical:human-response', done: (s) => headOf(s, INSTANCES.workplace)?.status === 'human-response-resolved' },
    {},
    config,
  );
  return { enter, resolve };
}

/**
 * D12 effect-uncertainty settlement, part 1: settle the effect UNKNOWN. The
 * TypedWait:effect-uncertainty commits with its operator wake source; an
 * automatic duplicate send is structurally blocked (the transport enforces
 * it; this command path never retries the send).
 *
 * REDUCER GAP (reported to the coordinator, not fixable in WP-08): the
 * frozen Workplace reducer has NO outgoing edge from
 * 'effect-uncertainty-waited', so workplace.resolveHumanResponse cannot
 * lawfully resume an uncertainty-waited Workplace. The resolvable
 * operator-disposition loop below therefore exercises the lawful
 * 'effect-human-waited' edge. EK-8 must either add the missing edge (an
 * approved complexity delta) or pin the wait as terminal-pending operator
 * action.
 */
export function effectUncertaintyScenario(config: DevelopmentVerticalConfig): { readonly uncertain: StepResult } {
  return { uncertain: consumeKind(config.session, 'obligation:runEffects', { effectOutcome: 'unknown' }, config) };
}

/** D12 operator disposition over the lawful human-waited effect edge: settle human-wait, operator-resolve, resume. */
export function operatorDispositionScenario(config: DevelopmentVerticalConfig): { readonly humanWait: StepResult; readonly resolve: StepResult; readonly resume: StepResult } {
  const session = config.session;
  const humanWait = consumeKind(session, 'obligation:runEffects', { effectOutcome: 'human-wait' }, config);
  const resolve = ensureCommand(
    session,
    { command: 'workplace.resolveHumanResponse', instanceId: INSTANCES.workplace, key: 'vertical:effect-human-resolution', done: (s) => headOf(s, INSTANCES.workplace)?.status === 'human-response-resolved' },
    {},
    config,
  );
  // Resume: every settleEffect-targeting obligation (effectRedrive, resumeEffect,
  // replayCaptureSweep) shares ONE target command; the frontier's chosen row is
  // the lawful claim regardless of its kind.
  const frontier = consumer.openFrontier(session).find((entry) => entry.target === 'workplace.settleEffect' && entry.claim !== undefined);
  const resume: StepResult = frontier === undefined || frontier.claim === undefined
    ? { status: 'skipped' }
    : consumeClaim(session, frontier.claim, { effectOutcome: 'success' }, config);
  return { humanWait, resolve, resume };
}

/** Assert the upstream-repair obligation routed typed (never a silent widen). */
export function upstreamRepairRouting(config: DevelopmentVerticalConfig): { readonly routed: boolean; readonly open: boolean; readonly widened: boolean; readonly detail: string } {
  const world = worldOf(config.session);
  const obligation = world.obligations.find((entry) => entry.kind === 'obligation:routeUpstreamRepair');
  const widened = world.events.some((event) => event.transition === 'workplace.widenAuthorityScope');
  const decision = world.evidence.some((fact) => fact.kind === 'GateDecision:upstream-repair');
  return {
    routed: obligation !== undefined,
    open: obligation?.state === 'open',
    widened,
    detail: obligation !== undefined
      ? `upstream-material defect routed as obligation:routeUpstreamRepair -> ${obligation.target} (${obligation.state}); the owning upstream aggregate settles it`
      : decision
        ? 'GateDecision:upstream-repair committed but its obligation is missing'
        : 'no upstream-repair verdict committed',
  };
}
