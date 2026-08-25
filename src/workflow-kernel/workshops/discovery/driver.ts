/**
 * workflow-kernel/workshops/discovery/driver.ts - the Discovery workshop
 * vertical on the new kernel (WP-11D, plan phase EK-8; test-only
 * reachability - WP-12 performs the production cutover).
 *
 * The chain, through the NEW commands/events/obligations ONLY (the
 * 53-command universe is closed - this driver composes, never invents):
 *
 *   idea intake (idea-intake.ts: factoryRun.bootstrap + factoryRun.importCapsule)
 *     -> factoryRun.start -> lifecycleRun.create -> stageRun.create/activate
 *     -> processRun.create/enterNode -> nodeRun.create/materializeCell
 *     -> workplace.materialize (the production cell)
 *     -> workItem.planGraph (D10: the idea unknowns open their obligations)
 *     -> WorkIntent (workplace.admitWorkIntent; role contract resolved ONCE)
 *     -> ActivityAttempt (activityAttempt.create; SAME pin copied)
 *     -> cognition (the shared transport: admit at the exact pre-send
 *        boundary -> cognition.sendProviderRequest -> recordOutcome)
 *     -> contribution (workplace.recordContribution; the PURE mapping from
 *        contributions.ts validates products + lineage)
 *     -> PRODUCTION REVISION (workplace.sealProductionRevision - the
 *        accepted-material authority, ADR-053; the attempt is provenance)
 *     -> CandidateSet (workplace.presentCandidateSet)
 *     -> author gate (workplace.runAuthorGate over the AUTHOR-BRIEF
 *        CheckPlan: declared providers, deterministic, fail-closed)
 *     -> reviewer desk -> reviewer loop -> final gate (workplace.runFinalGate
 *        over the FINAL-INTENT CheckPlan; the decision fork routes to the
 *        typed human wait)
 *     -> effect (workplace.settleEffect over the VERIFIED products;
 *        uncertainty settles as TypedWait:effect-uncertainty, D12)
 *     -> CellFinalAcceptance -> closePresentation -> workplace terminal proof
 *     -> node/process settlement -> stage outcome
 *     -> lifecycleRun.routeOutcome -> solution-formalization
 *        (obligation:enterStage.solution-formalization stays OPEN - the
 *        durable handoff to the Formalization workshop).
 *
 * Every step is idempotent over durable facts (re-drive after any crash
 * converges). The driver writes ONLY through sole-writer repositories and
 * the WP-07 obligation consumer - the public command path.
 */

import type { CommandInput, CommandOutcome, EvidenceFact, GateVerdict, TypedRefusal } from '../../domain/types.js';
import { COMMANDS } from '../../domain/universe.js';
import type { CommandName, ObligationKind } from '../../domain/universe.js';
import { reducerForCommand } from '../../domain/reducers/index.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';
import * as consumer from '../../application/obligation-consumer.js';
import type { ConsumeInvocation, ObligationClaim } from '../../application/obligation-consumer.js';
import type { CognitionTransportContract } from '../../context-envelope/transport.js';
import type { InstalledWorkshopManifest } from './installed-manifest.js';
import { checkPlanEvidence } from './installed-manifest.js';
import { AUTHOR_BRIEF_CHECK_PLAN, FINAL_INTENT_CHECK_PLAN, gateVerdictOf, runCheckPlan } from './checkplans.js';
import type { CheckPlanProducts } from './checkplans.js';
import { mapAuthorContribution, mapReviewerContribution } from './contributions.js';
import type { SealedProduct } from './products.js';
import type { ActorRunResult, ActorScript, RequiredIdeaInfo } from './cognition.js';
import { ScriptedWorkshopActor } from './cognition.js';
import type { DiscoveryRoleRuntime, ResolvedDiscoveryRoleSlot } from './role-bindings.js';

/* ------------------------------------------------------------------ */
/* Instance identity (deterministic)                                   */
/* ------------------------------------------------------------------ */

export const INSTANCES = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
  workItem: 'work-item:1',
} as const;

/* ------------------------------------------------------------------ */
/* Configuration + step results                                        */
/* ------------------------------------------------------------------ */

export interface DiscoveryWorkshopConfig {
  readonly session: KernelPersistenceSession;
  readonly roles: DiscoveryRoleRuntime;
  readonly authorLaunchKind: string;
  readonly reviewerLaunchKind: string;
  readonly transport: CognitionTransportContract;
  readonly manifest: InstalledWorkshopManifest;
  readonly taskSummary: string;
  readonly requiredInfo: RequiredIdeaInfo;
  /** The admitted idea product (the input of every contribution mapping). */
  readonly idea: SealedProduct;
  /** The sealed brief the author produced (the reviewer contribution binds it). */
  readonly brief: SealedProduct;
  /** The sealed intent the reviewer produced (the decision product). */
  readonly intent: SealedProduct;
  /**
   * Runs the real product verification (the check providers over the sealed
   * products); the effect settles ONLY on its verdict.
   */
  readonly verifyProducts: () => Promise<{ readonly ok: boolean; readonly detail: string; readonly digest: string }>;
  /** Call-scoped external Input evidence (CheckPlan + verification results). */
  readonly externalEvidence: readonly EvidenceFact[];
}

export type StepResult =
  | { readonly status: 'committed' | 'replayed' | 'skipped' }
  | { readonly status: 'refused'; readonly refusal: TypedRefusal }
  | { readonly status: 'actor-refused'; readonly detail: string }
  | { readonly status: 'acceptance-refused'; readonly reason: string; readonly detail: string };

/* ------------------------------------------------------------------ */
/* Driver internals (mirrors the WP-08 machinery, workshop-scoped)     */
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
    throw new Error(`DISCOVERY_DRIVER: unknown command ${command}`);
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
  config: DiscoveryWorkshopConfig,
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

/** Consume the open obligation of one kind with an EXPLICIT target instance. */
function consumeKindOn(
  session: KernelPersistenceSession,
  kind: ObligationKind,
  targetInstance: string,
  invocation: ConsumeInvocation,
  config: DiscoveryWorkshopConfig,
): StepResult {
  const obligation = openObligationOf(session, kind);
  if (obligation === undefined) {
    return { status: 'skipped' };
  }
  const target = obligation.target as CommandName;
  const head = headOf(session, targetInstance);
  if (!transitionLegalFrom(target, head)) {
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

function consumeClaim(session: KernelPersistenceSession, claim: ObligationClaim, invocation: ConsumeInvocation, config: DiscoveryWorkshopConfig): StepResult {
  const result = consumer.consumeClaim(session, claim, invocation, { externalEvidence: config.externalEvidence });
  if (result.status === 'refused') {
    return { status: 'refused', refusal: result.refusal };
  }
  return { status: result.status };
}

/** True when some rule of the command is legal from the head's status. */
function transitionLegalFrom(command: CommandName, head: { readonly status: string } | undefined): boolean {
  if (head === undefined) return true;
  const resolved = reducerForCommand(command);
  if (!resolved) return false;
  return resolved.reducer.transitions.some((rule) => rule.command === command && rule.fromStatuses.includes(head.status));
}

/** Consume the open frontier obligation of one kind (WP-07 frontier discipline). */
function consumeKind(
  session: KernelPersistenceSession,
  kind: ObligationKind,
  invocation: ConsumeInvocation,
  config: DiscoveryWorkshopConfig,
): StepResult {
  const frontier = consumer.openFrontier(session).find((entry) => entry.kind === kind);
  if (frontier === undefined || frontier.refusal !== undefined || frontier.claim === undefined) {
    return { status: 'skipped' };
  }
  const head = headOf(session, frontier.claim.targetInstanceId);
  if (!transitionLegalFrom(frontier.claim.target, head)) {
    return { status: 'skipped' };
  }
  return consumeClaim(session, frontier.claim, invocation, config);
}

/** The pinned role-contract reference of a resolved launch kind. */
function pinOf(config: DiscoveryWorkshopConfig, launchKind: string) {
  const slot = config.roles.slotOf(launchKind);
  if (slot === undefined) {
    throw new Error(`DISCOVERY_DRIVER: launch kind ${launchKind} was never resolved at WorkIntent creation`);
  }
  return slot.pin;
}

/** Planning evidence refs: the idea facts recorded by factoryRun.importCapsule. */
function planningRefs(session: KernelPersistenceSession): readonly string[] {
  return worldOf(session)
    .evidence.filter((fact) => fact.kind === 'TerminalLifecycleClaim' || fact.kind === 'ConstructionSurface' || fact.kind === 'TerminalClaimCoverage')
    .map((fact) => fact.ref);
}

/* ------------------------------------------------------------------ */
/* The semantic gates (declared CheckPlans; deterministic verdicts)     */
/* ------------------------------------------------------------------ */

/** Run one declared CheckPlan over the config's products (pure, typed). */
function runPlan(config: DiscoveryWorkshopConfig, products: CheckPlanProducts): { readonly verdict: GateVerdict } | { readonly refused: true; readonly detail: string } {
  const run = runCheckPlan(
    products.intent === undefined ? AUTHOR_BRIEF_CHECK_PLAN : FINAL_INTENT_CHECK_PLAN,
    config.manifest.checkProviders,
    products,
  );
  if ('refused' in run) {
    return { refused: true, detail: `${run.reason}: ${run.detail}` };
  }
  return { verdict: gateVerdictOf(run, products) };
}

/* ------------------------------------------------------------------ */
/* The actor step                                                      */
/* ------------------------------------------------------------------ */

async function runActorAttempt(
  config: DiscoveryWorkshopConfig,
  options: {
    readonly attemptInstanceId: string;
    readonly launchKind: string;
    readonly script: ActorScript;
  },
): Promise<{ readonly result: StepResult; readonly actor?: ActorRunResult }> {
  const session = config.session;
  const slot: ResolvedDiscoveryRoleSlot | undefined = config.roles.slotOf(options.launchKind);
  if (slot === undefined) {
    return { result: { status: 'actor-refused', detail: `launch kind ${options.launchKind} was never resolved at WorkIntent creation` } };
  }
  const attemptHead = headOf(session, options.attemptInstanceId);
  if (attemptHead?.status === 'outcome-recorded' || attemptHead?.status === 'provider-refusal-recorded' || attemptHead?.status === 'cancelled') {
    return { result: { status: 'skipped' } };
  }
  const intent = intentOf(session, INSTANCES.workplace, slot.protocolRole);
  if (intent === undefined) {
    return { result: { status: 'actor-refused', detail: `no ${slot.protocolRole} WorkIntent admitted for ${INSTANCES.workplace}` } };
  }
  const launch = openObligationOf(session, 'obligation:launchAdmission');
  const actor = new ScriptedWorkshopActor(config.transport, options.script);
  const run = await actor.run({
    attemptRef: options.attemptInstanceId,
    roleContract: slot.contract,
    taskSummary: config.taskSummary,
    requiredInfo: config.requiredInfo,
    manifest: config.manifest,
    hookContext: config.manifest.hooks.filter((hook) => hook.event === 'pre-send').map((hook) => hook.additionalContext),
    idempotencyKeyPrefix: `consume:${launch === undefined ? `attempt:${options.attemptInstanceId}` : launch.idempotencyKey}`,
    expectedContextRevision: 0,
  });
  if ('refused' in run) {
    return { result: { status: 'actor-refused', detail: `${run.reason}: ${run.detail}` } };
  }
  const send = consumeKind(session, 'obligation:providerSend', {}, config);
  if (send.status === 'refused') {
    return { result: send };
  }
  const outcome = ensureCommand(
    session,
    {
      command: 'activityAttempt.recordOutcome',
      instanceId: options.attemptInstanceId,
      key: `discovery:outcome:${options.attemptInstanceId}`,
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
function createAttempt(config: DiscoveryWorkshopConfig, key: string, attemptInstanceId: string, launchKind: string): StepResult {
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

/** The effect settles ONLY over the VERIFIED products (idempotent, typed). */
async function settleEffectOverProducts(config: DiscoveryWorkshopConfig): Promise<StepResult> {
  const verification = await config.verifyProducts();
  if (!verification.ok) {
    return { status: 'acceptance-refused', reason: 'PRODUCT_VERIFICATION', detail: verification.detail };
  }
  return consumeKind(config.session, 'obligation:runEffects', { effectOutcome: 'success' }, config);
}

/* ------------------------------------------------------------------ */
/* The vertical                                                        */
/* ------------------------------------------------------------------ */

export interface WorkshopRunResult {
  readonly steps: readonly { readonly step: string; readonly result: StepResult }[];
  readonly blockedAt: string | undefined;
}

/**
 * Drive the Discovery workshop to the durable handoff (the routed
 * solution-formalization obligation). Stateless over durable facts: call
 * after any crash on a reopened session to converge.
 */
export async function driveDiscoveryWorkshop(
  config: DiscoveryWorkshopConfig,
  options: {
    readonly authorScript: ActorScript;
    readonly reviewerScript: ActorScript;
    /** Overrides the derived final-gate verdict (scenario staging). */
    readonly finalGateVerdict?: GateVerdict;
    readonly stopAfter?: string;
  },
): Promise<WorkshopRunResult> {
  const session = config.session;
  const steps: { step: string; result: StepResult }[] = [];
  let stopped = false;
  const done = (step: string, result: StepResult): void => {
    if (stopped) return;
    steps.push({ step, result });
    if (options.stopAfter === step || result.status === 'refused' || result.status === 'actor-refused' || result.status === 'acceptance-refused') {
      stopped = true;
    }
  };
  const run = (step: string, body: () => StepResult): void => {
    if (stopped) return;
    done(step, body());
  };

  // --- contribution mappings validated BEFORE anything moves (pure fences) ---
  const authorMapping = mapAuthorContribution(config.idea, config.brief);
  if ('refused' in authorMapping) {
    return {
      steps: [{ step: 'author-contribution-mapping', result: { status: 'acceptance-refused', reason: authorMapping.reason, detail: authorMapping.detail } }],
      blockedAt: 'author-contribution-mapping',
    };
  }
  const reviewerMapping = mapReviewerContribution(config.brief, config.intent);
  if ('refused' in reviewerMapping) {
    return {
      steps: [{ step: 'reviewer-contribution-mapping', result: { status: 'acceptance-refused', reason: reviewerMapping.reason, detail: reviewerMapping.detail } }],
      blockedAt: 'reviewer-contribution-mapping',
    };
  }

  // --- conveyor spine to the production cell ---
  run('factory-start', () => consumeKind(session, 'obligation:ingestCapsuleFacts', {}, config));
  run('lifecycle-create', () => consumeKind(session, 'obligation:bootstrapLifecycleRun', {}, config));
  run('stage-create', () => consumeKind(session, 'obligation:enterStage.initial-discovery', {}, config));
  run('stage-activate', () => ensureCommand(session, { command: 'stageRun.activate', instanceId: INSTANCES.stage, key: 'discovery:activate-stage', done: (s) => eventExists(s, 'stageRun.activate', INSTANCES.stage) }, {}, config));
  run('process-create', () => consumeKind(session, 'obligation:bindProcessModule', {}, config));
  run('enter-node', () => consumeKindOn(session, 'obligation:enterFirstNode', INSTANCES.process, {}, config));
  run('node-create', () => ensureCommand(session, { command: 'nodeRun.create', instanceId: INSTANCES.node, key: 'discovery:create-node', done: (s) => eventExists(s, 'nodeRun.create', INSTANCES.node) }, {}, config));
  run('node-materialize-cell', () => ensureCommand(session, { command: 'nodeRun.materializeCell', instanceId: INSTANCES.node, key: 'discovery:materialize-cell', done: (s) => eventExists(s, 'nodeRun.materializeCell', INSTANCES.node) }, {}, config));
  run('workplace-materialize', () => consumeKind(session, 'obligation:materializeWorkplace.production-cell', {}, config));
  run('plan-graph', () => ensureCommand(session, { command: 'workItem.planGraph', instanceId: INSTANCES.workItem, key: 'discovery:plan-graph', done: (s) => eventExists(s, 'workItem.planGraph', INSTANCES.workItem) }, { evidenceRefs: [...planningRefs(session)] }, config));

  // --- author loop (the brief product) ---
  run('admit-author-intent', () => ensureCommand(
    session,
    { command: 'workplace.admitWorkIntent', instanceId: INSTANCES.workplace, key: 'discovery:admit-author', done: (s) => intentOf(s, INSTANCES.workplace, 'author') !== undefined },
    { protocolRole: 'author', rolePin: pinOf(config, config.authorLaunchKind), evidenceRefs: [INSTANCES.workItem, ...config.requiredInfo.idea.map((ref) => ref.ref)] },
    config,
  ));
  run('author-attempt', () => createAttempt(config, 'discovery:attempt-author', 'activity-attempt:1', config.authorLaunchKind));
  if (!stopped) {
    const author = await runActorAttempt(config, { attemptInstanceId: 'activity-attempt:1', launchKind: config.authorLaunchKind, script: options.authorScript });
    done('author-cognition', author.result);
  }
  run('author-contribution', () => consumeKind(session, 'obligation:submitContribution', {}, config));
  run('author-seal-revision', () => consumeKind(session, 'obligation:sealRevision', {}, config));
  run('author-present-candidates', () => consumeKind(session, 'obligation:presentCandidates', {}, config));
  run('author-gate', () => {
    const plan = runPlan(config, { idea: config.idea, brief: config.brief });
    if ('refused' in plan) {
      return { status: 'acceptance-refused', reason: 'CHECK_PLAN_REFUSED', detail: plan.detail };
    }
    return consumeKind(session, 'obligation:runGate.author', { gateVerdict: plan.verdict }, config);
  });
  run('reviewer-desk', () => (openObligationOf(session, 'obligation:openReviewerDesk') !== undefined ? { status: 'committed' } : { status: 'skipped' }));

  // --- reviewer loop (the intent/decision product) ---
  run('admit-reviewer-intent', () => ensureCommand(
    session,
    { command: 'workplace.admitWorkIntent', instanceId: INSTANCES.workplace, key: 'discovery:admit-reviewer', done: (s) => intentOf(s, INSTANCES.workplace, 'reviewer') !== undefined },
    { protocolRole: 'reviewer', rolePin: pinOf(config, config.reviewerLaunchKind), evidenceRefs: [INSTANCES.workItem, ...config.requiredInfo.terminalClaims.map((ref) => ref.ref)] },
    config,
  ));
  run('reviewer-attempt', () => createAttempt(config, 'discovery:attempt-reviewer', 'activity-attempt:2', config.reviewerLaunchKind));
  if (!stopped) {
    const reviewer = await runActorAttempt(config, { attemptInstanceId: 'activity-attempt:2', launchKind: config.reviewerLaunchKind, script: options.reviewerScript });
    done('reviewer-cognition', reviewer.result);
  }
  run('reviewer-contribution', () => consumeKind(session, 'obligation:submitContribution', {}, config));
  run('reviewer-seal-revision', () => consumeKind(session, 'obligation:sealRevision', {}, config));
  run('reviewer-present-candidates', () => consumeKind(session, 'obligation:presentCandidates', {}, config));
  run('final-gate', () => {
    if (options.finalGateVerdict !== undefined) {
      return consumeKind(session, 'obligation:runGate.final', { gateVerdict: options.finalGateVerdict }, config);
    }
    const plan = runPlan(config, { idea: config.idea, brief: config.brief, intent: config.intent });
    if ('refused' in plan) {
      return { status: 'acceptance-refused', reason: 'CHECK_PLAN_REFUSED', detail: plan.detail };
    }
    return consumeKind(session, 'obligation:runGate.final', { gateVerdict: plan.verdict }, config);
  });

  // --- effect settlement over the VERIFIED products ---
  if (!stopped) {
    done('settle-effect', await settleEffectOverProducts(config));
  }

  // --- acceptance + closure + stage settlement + the durable handoff ---
  run('final-acceptance', () => ensureCommand(session, { command: 'workplace.recordFinalAcceptance', instanceId: INSTANCES.workplace, key: 'discovery:final-acceptance', done: (s) => eventExists(s, 'workplace.recordFinalAcceptance', INSTANCES.workplace) }, {}, config));
  run('close-presentation', () => consumeKind(session, 'obligation:closePresentation', {}, config));
  run('workplace-terminal-proof', () => ensureCommand(session, { command: 'workplace.issueWorkplaceTerminalProof', instanceId: INSTANCES.workplace, key: 'discovery:workplace-proof', done: (s) => headOf(s, INSTANCES.workplace)?.terminal !== undefined }, { terminalOutcome: 'success' }, config));
  run('node-kernel-result', () => ensureCommand(session, { command: 'nodeRun.recordKernelResult', instanceId: INSTANCES.node, key: 'discovery:node-kernel-result', done: (s) => eventExists(s, 'nodeRun.recordKernelResult', INSTANCES.node) }, {}, config));
  run('node-cell-acceptance', () => consumeKindOn(session, 'obligation:completeCellNode', INSTANCES.node, {}, config));
  run('node-terminal', () => ensureCommand(session, { command: 'processRun.recordNodeTerminal', instanceId: INSTANCES.process, key: 'discovery:node-terminal', done: (s) => eventExists(s, 'processRun.recordNodeTerminal', INSTANCES.process) }, {}, config));
  run('process-settle', () => consumeKindOn(session, 'obligation:advanceProcessFlow.settle', INSTANCES.process, { terminalOutcome: 'success' }, config));
  run('stage-outcome', () => consumeKindOn(session, 'obligation:recordStageOutcome', INSTANCES.stage, { terminalOutcome: 'success' }, config));
  run('route-lifecycle', () => consumeKindOn(session, 'obligation:routeLifecycle', INSTANCES.lifecycle, { stageRoute: 'solution-formalization' }, config));

  const blocked = steps.find((entry) => entry.result.status === 'refused' || entry.result.status === 'actor-refused' || entry.result.status === 'acceptance-refused');
  return { steps, blockedAt: blocked?.step };
}

/* ------------------------------------------------------------------ */
/* The typed-wait scenarios (public command path, D5/D12)              */
/* ------------------------------------------------------------------ */

/**
 * The decision-fork human wait (D5): a needs-human decision at the final
 * gate enters the typed wait; the operator wake command discharges it.
 * Nothing is invented - the wait kind and wake source come from the frozen
 * universe (waits.ts resolves them).
 */
export function decisionForkWaitScenario(config: DiscoveryWorkshopConfig): { readonly enter: StepResult; readonly resolve: StepResult } {
  const session = config.session;
  const enter = ensureCommand(
    session,
    { command: 'workplace.enterHumanWait', instanceId: INSTANCES.workplace, key: 'discovery:decision-fork-wait', done: (s) => headOf(s, INSTANCES.workplace)?.status === 'human-wait-entered' },
    {},
    config,
  );
  const resolve = ensureCommand(
    session,
    { command: 'workplace.resolveHumanResponse', instanceId: INSTANCES.workplace, key: 'discovery:decision-response', done: (s) => headOf(s, INSTANCES.workplace)?.status === 'human-response-resolved' },
    {},
    config,
  );
  return { enter, resolve };
}

/**
 * D12 effect uncertainty, part 1: settle the registered-decision effect
 * UNKNOWN. The TypedWait:effect-uncertainty commits with the operator wake
 * source; an automatic duplicate send is structurally blocked (this path
 * never retries the effect on its own).
 */
export function settleEffectUncertain(config: DiscoveryWorkshopConfig): StepResult {
  return consumeKind(config.session, 'obligation:runEffects', { effectOutcome: 'unknown' }, config);
}

/**
 * D12 part 2: the operator disposition resolves the lawful waited edge and
 * the effect resumes to success (the operator command is the ONLY wake).
 */
export function operatorDispositionResume(config: DiscoveryWorkshopConfig): {
  readonly operatorDisposition: StepResult;
  readonly resume: StepResult;
} {
  const session = config.session;
  const operatorDisposition = ensureCommand(
    session,
    { command: 'workplace.resolveHumanResponse', instanceId: INSTANCES.workplace, key: 'discovery:effect-disposition', done: (s) => headOf(s, INSTANCES.workplace)?.status === 'human-response-resolved' },
    {},
    config,
  );
  const frontier = consumer.openFrontier(session).find((entry) => entry.target === 'workplace.settleEffect' && entry.claim !== undefined);
  const resume: StepResult = frontier === undefined || frontier.claim === undefined
    ? { status: 'skipped' }
    : consumeClaim(session, frontier.claim, { effectOutcome: 'success' }, config);
  return { operatorDisposition, resume };
}

/** The CheckPlan external-input facts of both gates (from the installed manifest). */
export function discoveryCheckPlanEvidence(manifest: InstalledWorkshopManifest): readonly EvidenceFact[] {
  return [
    checkPlanEvidence(manifest, 'author-brief-gate'),
    checkPlanEvidence(manifest, 'final-intent-gate'),
  ];
}
