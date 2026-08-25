/**
 * workflow-kernel/workshops/delivery/conveyor.ts - the release scenario
 * composition (WP-11L, plan phase EK-8 workshop conversion).
 *
 * A STATELESS composition over durable facts, in the exact discipline of
 * the WP-07/WP-08/WP-09 drivers: every step checks its own durable
 * postcondition and every key is deterministic, so re-driving a reopened
 * database after ANY crash converges to the identical logical outcome. It
 * reads ONLY kernel surfaces - repository public readers, the hydrated
 * shared ledger, the WP-07 obligation consumer and the WP-09 topology
 * bindings - never a Kanban card, never a task status, never a clock.
 *
 * THE FULL RELEASE RUN (assignment point 9), through public commands only:
 *
 *   verified bundle ingress (bundle.ts)
 *     -> preflight (preflight.ts - declared deterministic providers)
 *     -> factoryRun.start -> lifecycleRun.create
 *     -> stageRun.create (the lifecycle's own first enterStage lane - the
 *        release stage; stage IDENTITY is installed-manifest data, never a
 *        kernel field; obligation:enterStage.delivery-release is the
 *        multi-stage product-lifecycle routing edge and stays declared
 *        vocabulary - a dedicated Delivery run enters through the edge the
 *        engine offers at lifecycle creation)
 *     -> stageRun.activate -> processRun.create / enterNode
 *     -> nodeRun.create/materializeCell -> workplace.materialize (the
 *        release cell)
 *     -> workItem.planGraph (immutable planning facts from the bundle)
 *     -> author desk (admitWorkIntent with the delivery author pin ->
 *        attempt -> cognition through the shared transport ->
 *        contribution -> production revision -> CandidateSet -> author gate)
 *     -> reviewer desk -> reviewer loop -> final gate (accepted ->
 *        AcceptedCandidateAuthority)
 *     -> THE APPROVAL PAUSE (approval.ts): settleEffect("human-wait")
 *        commits TypedWait:human-input whose declared wake sources are the
 *        D12 operator disposition commands; the flow pauses while the
 *        request is open - exactly the legacy inbox pause, typed;
 *     -> OPERATOR DISPOSITION through the public command path:
 *        recordApprovalDecision (immutable inbox) -> workplace.
 *        resolveHumanResponse (evidence: the decision ref) -> the wait
 *        discharges atomically (WakeDischarge:human-response-command, D5);
 *     -> PACKAGING RESUME: runLocalPackaging (exactly-once per candidate)
 *        -> settleEffect("success" | "already-applied") over the VERIFIED
 *        package;
 *     -> CellFinalAcceptance -> closePresentation -> workplace terminal
 *        proof -> node/process/stage settlement -> verifyTerminalClaims ->
 *        lifecycle + run terminal proofs;
 *     -> the immutable release record (packaging.ts, write-once).
 *
 * REDUCER-GAP NOTE (same family WP-08 reported): a denied disposition
 * settles the effect policy-terminal (no implicit rollback, D12) and the
 * lane stops fail-closed - the release stage holds NO success path without
 * an approved, immutable decision. The frozen alternative wake command
 * nodeRun.recordHumanDecision (the release-provider node shape, whose
 * publishRelease/observeRelease obligations the universe declares) has no
 * lawful node-terminal successor edge in the frozen reducers; it stays
 * declared vocabulary of the SAME wait kind, not a second pause path.
 */

import type { EvidenceFact, TypedRefusal } from '../../domain/types.js';
import type { CommandName, ObligationKind } from '../../domain/universe.js';
import { COMMANDS } from '../../domain/universe.js';
import { reducerForCommand } from '../../domain/reducers/index.js';
import * as consumer from '../../application/obligation-consumer.js';
import type { ObligationClaim, ConsumeInvocation } from '../../application/obligation-consumer.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';
import type { CognitionTransportContract } from '../../context-envelope/transport.js';
import { ScriptedActor } from '../../development/actors.js';
import type { ActorScript, ActorRunResult } from '../../development/actors.js';
import type { RoleContractRuntime, ResolvedRoleSlot } from '../../development/role-contract-runtime.js';
import type { RequiredTaskInfo } from '../../development/envelope-assembly.js';
import { topologyBindings } from '../../planning/bindings.js';
import type { VerifiedDevelopmentBundle } from './bundle.js';
import type { PreflightSnapshot } from './preflight.js';
import { preflightEvidenceOf } from './preflight.js';
import {
  assembleReleaseRecord,
  runLocalPackaging,
  verifyPackagedRelease,
  type PackagingInputDeclaration,
  type ReleaseRecord,
  type ReleaseRecordOutcome,
} from './packaging.js';
import {
  ensureApprovalRequest,
  operatorDispositionOf,
  recordApprovalDecision,
  type ApprovalBindingTriple,
  type ReleaseApprovalDecision,
  type RecordDecisionInput,
} from './approval.js';
import type { DeclaredReleasePolicy } from './manifest.js';

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
  workItemPackage: 'work-item:1',
  workItemReview: 'work-item:2',
} as const;

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface ReleaseConveyorConfig {
  readonly session: KernelPersistenceSession;
  readonly roles: RoleContractRuntime;
  readonly authorLaunchKind: string;
  readonly reviewerLaunchKind: string;
  readonly transport: CognitionTransportContract;
  readonly taskSummary: string;
  readonly requiredInfo: RequiredTaskInfo;
  /** The verified bundle (the input product; ingress already committed). */
  readonly bundle: VerifiedDevelopmentBundle;
  /** The completed preflight (the gates ran before the conveyor drives). */
  readonly preflight: PreflightSnapshot;
  /** The declared release policy (its digest binds the approval request). */
  readonly policy: DeclaredReleasePolicy;
  /** The release store root (packages + records; operator-provisioned). */
  readonly storeRoot: string;
  /** The approval inbox root (requests + decisions; operator-provisioned). */
  readonly inboxRoot: string;
  /** The declared product-tree packaging input. */
  readonly packaging: PackagingInputDeclaration;
  /** The operator identity that opened the approval request. */
  readonly requestedBy: string;
}

export type StepResult =
  | { readonly status: 'committed' | 'replayed' | 'skipped' }
  | { readonly status: 'refused'; readonly refusal: TypedRefusal }
  | { readonly status: 'actor-refused'; readonly detail: string }
  | { readonly status: 'approval-refused'; readonly reason: string; readonly detail: string }
  | { readonly status: 'packaging-refused'; readonly reason: string; readonly detail: string };

/* ------------------------------------------------------------------ */
/* Driver internals (the WP-07/WP-09 discipline)                       */
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
    throw new Error(`DELIVERY_CONVEYOR: unknown command ${command}`);
  }
  return descriptor.aggregate;
}

function externalEvidenceOf(config: ReleaseConveyorConfig): readonly EvidenceFact[] {
  return preflightEvidenceOf(config.preflight);
}

/** Apply one driver-direct command idempotently through the owning repository. */
function ensureCommand(
  config: ReleaseConveyorConfig,
  spec: { readonly command: CommandName; readonly instanceId: string; readonly key: string; readonly done: (session: KernelPersistenceSession) => boolean },
  fields: Partial<import('../../domain/types.js').CommandInput>,
): StepResult {
  const session = config.session;
  if (spec.done(session)) {
    return { status: 'skipped' };
  }
  const head = headOf(session, spec.instanceId);
  const outcome = consumer
    .repositoryOf(session, aggregateOf(spec.command))
    .applyCommand(
      {
        command: spec.command,
        instanceId: spec.instanceId,
        expectedRevision: head === undefined ? 0 : head.revision,
        idempotencyKey: spec.key,
        ...fields,
      },
      { externalEvidence: externalEvidenceOf(config) },
    );
  if ('refused' in outcome) {
    return { status: 'refused', refusal: outcome };
  }
  return { status: 'replayed' in outcome ? 'replayed' : 'committed' };
}

/** Consume the open obligation of one kind with an EXPLICIT target instance (cross-aggregate edges). */
function consumeKindOn(
  config: ReleaseConveyorConfig,
  kind: ObligationKind,
  targetInstance: string,
  invocation: ConsumeInvocation,
): StepResult {
  const session = config.session;
  const obligation = openObligationOf(session, kind);
  if (obligation === undefined) {
    return { status: 'skipped' };
  }
  const target = obligation.target as CommandName;
  const head = headOf(session, targetInstance);
  if (!transitionLegalFrom(target, head)) {
    return { status: 'skipped' }; // idempotent re-drive: the target already moved past
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
  return consumeClaim(config, claim, invocation);
}

function consumeClaim(config: ReleaseConveyorConfig, claim: ObligationClaim, invocation: ConsumeInvocation): StepResult {
  const result = consumer.consumeClaim(config.session, claim, invocation, { externalEvidence: externalEvidenceOf(config) });
  if (result.status === 'refused') {
    return { status: 'refused', refusal: result.refusal };
  }
  return { status: result.status };
}

/** True when some rule of the command is legal from the head's status (idempotent re-drive skip oracle). */
function transitionLegalFrom(command: CommandName, head: { readonly status: string } | undefined): boolean {
  if (head === undefined) return true;
  const resolved = reducerForCommand(command);
  if (!resolved) return false;
  return resolved.reducer.transitions.some((rule) => rule.command === command && rule.fromStatuses.includes(head.status));
}

/** Consume the frontier obligation of one kind (the engine's FIFO lane head of that kind). */
function consumeKind(config: ReleaseConveyorConfig, kind: ObligationKind, invocation: ConsumeInvocation): StepResult {
  const session = config.session;
  const frontier = consumer.openFrontier(session).find((entry) => entry.kind === kind);
  if (frontier === undefined || frontier.refusal !== undefined || frontier.claim === undefined) {
    return { status: 'skipped' };
  }
  const head = headOf(session, frontier.claim.targetInstanceId);
  if (!transitionLegalFrom(frontier.claim.target, head)) {
    return { status: 'skipped' };
  }
  return consumeClaim(config, frontier.claim, invocation);
}

/**
 * Consume the frontier obligation TARGETING workplace.settleEffect. Every
 * settleEffect-targeting obligation (runEffects, effectRedrive, resumeEffect,
 * replayCaptureSweep) shares ONE target command; the frontier's chosen row
 * is the lawful claim regardless of its kind (the WP-08 convergence). The
 * transition-legality oracle skips idempotent re-drives of a settled
 * workplace.
 */
function consumeSettleEffect(config: ReleaseConveyorConfig, effectOutcome: import('../../domain/types.js').EffectOutcome): StepResult {
  const session = config.session;
  const frontier = consumer.openFrontier(session).find((entry) => entry.target === 'workplace.settleEffect' && entry.claim !== undefined);
  if (frontier === undefined || frontier.claim === undefined) {
    return { status: 'skipped' };
  }
  const head = headOf(session, frontier.claim.targetInstanceId);
  if (!transitionLegalFrom('workplace.settleEffect', head)) {
    return { status: 'skipped' };
  }
  return consumeClaim(config, frontier.claim, { effectOutcome });
}

/** The pinned role-contract reference of a resolved launch kind. */
function pinOf(config: ReleaseConveyorConfig, launchKind: string) {
  const slot = config.roles.slotOf(launchKind);
  if (slot === undefined) {
    throw new Error(`DELIVERY_CONVEYOR: launch kind ${launchKind} was never resolved at WorkIntent creation`);
  }
  return slot.pin;
}

/** Planning evidence refs: the bundle facts recorded by factoryRun.importCapsule. */
function planningRefs(session: KernelPersistenceSession): readonly string[] {
  return worldOf(session)
    .evidence.filter((fact) => fact.kind === 'TerminalLifecycleClaim' || fact.kind === 'ConstructionSurface' || fact.kind === 'TerminalClaimCoverage')
    .map((fact) => fact.ref);
}

/* ------------------------------------------------------------------ */
/* The cognition step (admission + send + outcome through the port)     */
/* ------------------------------------------------------------------ */

async function runActorAttempt(
  config: ReleaseConveyorConfig,
  options: { readonly attemptInstanceId: string; readonly launchKind: string; readonly script: ActorScript },
): Promise<{ readonly result: StepResult; readonly actor?: ActorRunResult }> {
  const session = config.session;
  const slot: ResolvedRoleSlot | undefined = config.roles.slotOf(options.launchKind);
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
  const actor = new ScriptedActor(config.transport, options.script);
  const run = await actor.run({
    attemptRef: options.attemptInstanceId,
    roleContract: slot.contract,
    taskSummary: config.taskSummary,
    requiredInfo: config.requiredInfo,
    idempotencyKeyPrefix: `consume:${launch === undefined ? `attempt:${options.attemptInstanceId}` : launch.idempotencyKey}`,
    expectedContextRevision: 0,
  });
  if ('refused' in run) {
    return { result: { status: 'actor-refused', detail: `${run.reason}: ${run.detail}` } };
  }
  const send = consumeKind(config, 'obligation:providerSend', {});
  if (send.status === 'refused') {
    return { result: send };
  }
  const outcome = ensureCommand(
    config,
    {
      command: 'activityAttempt.recordOutcome',
      instanceId: options.attemptInstanceId,
      key: `delivery:outcome:${options.attemptInstanceId}`,
      done: (s) => headOf(s, options.attemptInstanceId)?.status === 'outcome-recorded',
    },
    { evidenceRefs: [intent.intentRef, run.result.outcomeDigest] },
  );
  if (outcome.status === 'refused') {
    return { result: outcome };
  }
  return { result: { status: 'committed' }, actor: run.result };
}

/** Create an attempt from the exact WorkIntent with the SAME pin object. */
function createAttempt(config: ReleaseConveyorConfig, key: string, attemptInstanceId: string, launchKind: string): StepResult {
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
    config,
    { command: 'activityAttempt.create', instanceId: attemptInstanceId, key, done: (s) => headOf(s, attemptInstanceId) !== undefined },
    { workIntentRef: intent.intentRef, rolePin: intent.roleContract },
  );
}

/* ------------------------------------------------------------------ */
/* The approval pause + operator disposition (public command path)      */
/* ------------------------------------------------------------------ */

/** The exact approval-request binding triple of one release run. */
export function approvalBindingOf(config: ReleaseConveyorConfig): ApprovalBindingTriple {
  return {
    candidateDigest: config.bundle.integratedCandidate.digest,
    preflightDigest: config.preflight.preflightDigest,
    policyDigest: config.preflight.policyDigest,
  };
}

/** The request id of one release run (one request per candidate). */
export function approvalRequestIdOf(config: ReleaseConveyorConfig): string {
  return `delivery-release-approval:${config.bundle.integratedCandidate.digest}`;
}

export interface ApprovalPauseState {
  /** The pause committed: a pending TypedWait:human-input on the workplace. */
  readonly paused: boolean;
  readonly waitWakeCommands: readonly string[];
}

/** Observe the pause state from durable facts (typed waits only, D5/D12). */
export function approvalPauseOf(config: ReleaseConveyorConfig): ApprovalPauseState {
  const wait = worldOf(config.session).waits.find((entry) => entry.kind === 'TypedWait:human-input' && entry.ownerInstanceId === INSTANCES.workplace && entry.state === 'pending');
  return { paused: wait !== undefined, waitWakeCommands: wait === undefined ? [] : [...wait.wakeCommands] };
}

/**
 * The operator disposition through the public command path: record the
 * immutable decision, then discharge the wait with the D12 operator
 * disposition command carrying the decision evidence. A duplicate script
 * (already-recorded identical decision) replays; a different decision for
 * the same request is the typed IMMUTABLE refusal.
 */
export function operatorDisposition(config: ReleaseConveyorConfig, input: RecordDecisionInput): { readonly decision: StepResult; readonly decisionRecord?: ReleaseApprovalDecision; readonly resolve: StepResult } {
  const recorded = recordApprovalDecision(config.inboxRoot, input);
  if ('refused' in recorded) {
    return { decision: { status: 'approval-refused', reason: recorded.reason, detail: recorded.detail }, resolve: { status: 'skipped' } };
  }
  const decision = recorded.decision;
  const disposition = operatorDispositionOf(decision);
  const resolve = ensureCommand(
    config,
    {
      command: 'workplace.resolveHumanResponse',
      instanceId: INSTANCES.workplace,
      key: `delivery:approval-disposition:${decision.decisionRef}`,
      // Event-based postcondition: the workplace status moves past
      // 'human-response-resolved' as the run settles; the EVENT is the
      // durable fact (a re-drive replays, never re-resolves).
      done: (s) => eventExists(s, 'workplace.resolveHumanResponse', INSTANCES.workplace),
    },
    { evidenceRefs: [...disposition.evidenceRefs] },
  );
  return { decision: { status: 'recorded' in recorded ? 'committed' : 'replayed' }, decisionRecord: decision, resolve };
}

/* ------------------------------------------------------------------ */
/* The release run                                                     */
/* ------------------------------------------------------------------ */

export interface ReleaseRunResult {
  readonly steps: readonly { readonly step: string; readonly result: StepResult }[];
  readonly blockedAt: string | undefined;
  /** The recorded decision when the operator disposition ran. */
  readonly decision: ReleaseApprovalDecision | undefined;
  /** The sealed release record when the run reached it. */
  readonly releaseRecord: ReleaseRecord | undefined;
  readonly releaseRecordOutcome: ReleaseRecordOutcome | undefined;
}

/**
 * Drive the full release run to the run terminal proof + the immutable
 * release record. Stateless over durable facts: call after any crash on a
 * reopened session to converge. The approval pause is driven by
 * `operatorDecision` (a scripted operator) unless options.pauseAtApproval
 * stops the lane exactly at the pause for external disposition.
 */
export async function driveReleaseRun(
  config: ReleaseConveyorConfig,
  options: {
    readonly authorScript: ActorScript;
    readonly reviewerScript: ActorScript;
    /** The scripted operator decision (the public disposition input). */
    readonly operatorDecision: RecordDecisionInput;
    /** Stop the lane exactly at the approval pause (external disposition). */
    readonly pauseAtApproval?: boolean;
  },
): Promise<ReleaseRunResult> {
  const session = config.session;
  const steps: { step: string; result: StepResult }[] = [];
  let stopped = false;
  let decision: ReleaseApprovalDecision | undefined;
  let releaseRecord: ReleaseRecord | undefined;
  let releaseRecordOutcome: ReleaseRecordOutcome | undefined;

  const done = (step: string, result: StepResult): void => {
    if (stopped) return;
    steps.push({ step, result });
    if (
      result.status === 'refused'
      || result.status === 'actor-refused'
      || result.status === 'approval-refused'
      || result.status === 'packaging-refused'
      || (options.pauseAtApproval === true && step === 'approval-wait')
    ) {
      stopped = true;
    }
  };
  const run = (step: string, body: () => StepResult): void => {
    if (stopped) return;
    done(step, body());
  };

  // --- conveyor spine to the release cell ---
  run('factory-start', () => consumeKind(config, 'obligation:ingestCapsuleFacts', {}));
  run('lifecycle-create', () => consumeKind(config, 'obligation:bootstrapLifecycleRun', {}));
  // The release stage: the lifecycle's own first enterStage lane (the
  // engine's FIFO head of the stageRun.create target). Stage identity is
  // installed-manifest data; the delivery-release routing obligation
  // (obligation:enterStage.delivery-release, created by
  // lifecycleRun.routeOutcome(stageRoute delivery-release)) belongs to the
  // multi-stage product lifecycle and stays declared vocabulary.
  run('stage-create', () => consumeKind(config, 'obligation:enterStage.initial-discovery', {}));
  run('stage-activate', () => ensureCommand(
    config,
    { command: 'stageRun.activate', instanceId: INSTANCES.stage, key: 'delivery:activate-stage', done: (s) => eventExists(s, 'stageRun.activate', INSTANCES.stage) },
    {},
  ));
  run('process-create', () => consumeKind(config, 'obligation:bindProcessModule', {}));
  run('enter-node', () => consumeKindOn(config, 'obligation:enterFirstNode', INSTANCES.process, {}));
  run('node-create', () => ensureCommand(
    config,
    { command: 'nodeRun.create', instanceId: INSTANCES.node, key: 'delivery:create-node', done: (s) => eventExists(s, 'nodeRun.create', INSTANCES.node) },
    {},
  ));
  run('node-materialize-cell', () => ensureCommand(
    config,
    { command: 'nodeRun.materializeCell', instanceId: INSTANCES.node, key: 'delivery:materialize-cell', done: (s) => eventExists(s, 'nodeRun.materializeCell', INSTANCES.node) },
    {},
  ));
  run('workplace-materialize', () => consumeKind(config, 'obligation:materializeWorkplace.production-cell', {}));
  run('plan-graph-package', () => ensureCommand(
    config,
    { command: 'workItem.planGraph', instanceId: INSTANCES.workItemPackage, key: 'delivery:plan-package', done: (s) => eventExists(s, 'workItem.planGraph', INSTANCES.workItemPackage) },
    { evidenceRefs: [...planningRefs(session)] },
  ));
  run('plan-graph-review', () => ensureCommand(
    config,
    { command: 'workItem.planGraph', instanceId: INSTANCES.workItemReview, key: 'delivery:plan-review', done: (s) => eventExists(s, 'workItem.planGraph', INSTANCES.workItemReview) },
    { evidenceRefs: [...planningRefs(session)] },
  ));

  // --- author desk ---
  run('admit-author-intent', () => ensureCommand(
    config,
    { command: 'workplace.admitWorkIntent', instanceId: INSTANCES.workplace, key: 'delivery:admit-author', done: (s) => intentOf(s, INSTANCES.workplace, 'author') !== undefined },
    { protocolRole: 'author', rolePin: pinOf(config, config.authorLaunchKind), evidenceRefs: [INSTANCES.workItemPackage, ...config.requiredInfo.scope.map((ref) => ref.ref)] },
  ));
  run('author-attempt', () => createAttempt(config, 'delivery:attempt-author', 'activity-attempt:1', config.authorLaunchKind));
  if (!stopped) {
    const author = await runActorAttempt(config, { attemptInstanceId: 'activity-attempt:1', launchKind: config.authorLaunchKind, script: options.authorScript });
    done('author-cognition', author.result);
  }
  run('author-contribution', () => consumeKind(config, 'obligation:submitContribution', {}));
  run('author-seal-revision', () => consumeKind(config, 'obligation:sealRevision', {}));
  run('author-present-candidates', () => consumeKind(config, 'obligation:presentCandidates', {}));
  run('author-gate', () => consumeKind(config, 'obligation:runGate.author', { gateVerdict: 'accepted' }));
  run('reviewer-desk', () => (openObligationOf(session, 'obligation:openReviewerDesk') !== undefined ? { status: 'committed' as const } : { status: 'skipped' as const }));

  // --- reviewer desk ---
  run('admit-reviewer-intent', () => ensureCommand(
    config,
    { command: 'workplace.admitWorkIntent', instanceId: INSTANCES.workplace, key: 'delivery:admit-reviewer', done: (s) => intentOf(s, INSTANCES.workplace, 'reviewer') !== undefined },
    { protocolRole: 'reviewer', rolePin: pinOf(config, config.reviewerLaunchKind), evidenceRefs: [INSTANCES.workItemReview, ...config.requiredInfo.terminalClaims.map((ref) => ref.ref)] },
  ));
  run('reviewer-attempt', () => createAttempt(config, 'delivery:attempt-reviewer', 'activity-attempt:2', config.reviewerLaunchKind));
  if (!stopped) {
    const reviewer = await runActorAttempt(config, { attemptInstanceId: 'activity-attempt:2', launchKind: config.reviewerLaunchKind, script: options.reviewerScript });
    done('reviewer-cognition', reviewer.result);
  }
  run('reviewer-contribution', () => consumeKind(config, 'obligation:submitContribution', {}));
  run('reviewer-seal-revision', () => consumeKind(config, 'obligation:sealRevision', {}));
  run('reviewer-present-candidates', () => consumeKind(config, 'obligation:presentCandidates', {}));
  run('final-gate', () => consumeKind(config, 'obligation:runGate.final', { gateVerdict: 'accepted' }));

  // --- the approval pause (TypedWait:human-input; the legacy inbox, typed) ---
  run('approval-request', () => {
    const ensured = ensureApprovalRequest(config.inboxRoot, approvalRequestIdOf(config), approvalBindingOf(config), config.requestedBy);
    if ('refused' in ensured) {
      return { status: 'approval-refused', reason: ensured.reason, detail: ensured.detail };
    }
    return { status: ensured.created ? 'committed' : 'replayed' };
  });
  // The pause runs exactly once: a re-drive skips when the approval wait
  // already exists (pending or discharged) - never a second pause.
  run('approval-wait', () => (worldOf(session).waits.some((wait) => wait.kind === 'TypedWait:human-input' && wait.ownerInstanceId === INSTANCES.workplace)
    ? { status: 'skipped' as const }
    : consumeSettleEffect(config, 'human-wait')));

  // --- operator disposition (public command path) ---
  if (!stopped) {
    const disposition = operatorDisposition(config, options.operatorDecision);
    decision = disposition.decisionRecord;
    if (disposition.decision.status === 'approval-refused' || disposition.resolve.status === 'refused') {
      done('operator-disposition', disposition.decision.status === 'approval-refused' ? disposition.decision : disposition.resolve);
    } else {
      steps.push({ step: 'operator-disposition', result: disposition.decision });
      steps.push({ step: 'operator-resolve', result: disposition.resolve });
      if (disposition.resolve.status !== 'committed' && disposition.resolve.status !== 'replayed' && disposition.resolve.status !== 'skipped') {
        stopped = true;
      }
    }
  }

  // --- packaging resume (exactly-once) over the approved decision ---
  if (!stopped && decision !== undefined && decision.status === 'approved') {
    const packaging = runLocalPackaging(config.storeRoot, config.bundle, config.packaging);
    if ('refused' in packaging) {
      done('packaging-resume', { status: 'packaging-refused', reason: packaging.reason, detail: packaging.detail });
    } else {
      const verified = verifyPackagedRelease(config.storeRoot, config.bundle.integratedCandidate.digest);
      if (!verified.ok) {
        done('packaging-resume', { status: 'packaging-refused', reason: 'PACKAGE_VERIFY_FAILED', detail: verified.detail });
      } else {
        steps.push({ step: 'packaging-resume', result: { status: packaging.status === 'success' ? 'committed' : 'replayed' } });
        // The effect settles ONLY over the verified package: the first run
        // settles success; a re-drive of an already-packaged candidate
        // settles already-applied (both success-shaped; D2).
        const alreadyPackaged = packaging.status === 'already-applied';
        run('settle-effect', () => consumeSettleEffect(config, alreadyPackaged ? 'already-applied' : 'success'));
      }
    }
  } else if (!stopped && decision !== undefined) {
    // Denied/expired: NO implicit rollback (D12) - the effect settles
    // policy-terminal and the lane stops fail-closed.
    run('settle-effect', () => consumeSettleEffect(config, 'policy-terminal'));
    done('release-denied', { status: 'approval-refused', reason: 'APPROVAL_DENIED', detail: `decision ${decision?.decisionRef ?? ''} is ${decision?.status ?? 'not-approved'}; the release holds no success path without an approved decision` });
  }

  // --- acceptance + closure + settlement (WP-09-style bindings) ---
  run('final-acceptance', () => ensureCommand(
    config,
    { command: 'workplace.recordFinalAcceptance', instanceId: INSTANCES.workplace, key: 'delivery:final-acceptance', done: (s) => eventExists(s, 'workplace.recordFinalAcceptance', INSTANCES.workplace) },
    {},
  ));
  run('close-presentation', () => consumeKind(config, 'obligation:closePresentation', {}));
  run('workplace-terminal-proof', () => ensureCommand(
    config,
    { command: 'workplace.issueWorkplaceTerminalProof', instanceId: INSTANCES.workplace, key: 'delivery:workplace-proof', done: (s) => headOf(s, INSTANCES.workplace)?.terminal !== undefined },
    { terminalOutcome: 'success' },
  ));
  run('node-kernel-result', () => ensureCommand(
    config,
    { command: 'nodeRun.recordKernelResult', instanceId: INSTANCES.node, key: 'delivery:node-kernel-result', done: (s) => eventExists(s, 'nodeRun.recordKernelResult', INSTANCES.node) },
    {},
  ));
  run('node-cell-acceptance', () => {
    // WP-09-style binding: the cell's NodeRun is bound from durable
    // topology facts (the workplace's cell binding), never from chronology.
    const bindings = topologyBindings(worldOf(session));
    const bound = bindings.nodeOfWorkplace(INSTANCES.workplace);
    const target = bound.resolved ? bound.value : INSTANCES.node;
    return consumeKindOn(config, 'obligation:completeCellNode', target, {});
  });
  run('node-terminal', () => ensureCommand(
    config,
    { command: 'processRun.recordNodeTerminal', instanceId: INSTANCES.process, key: 'delivery:node-terminal', done: (s) => eventExists(s, 'processRun.recordNodeTerminal', INSTANCES.process) },
    {},
  ));
  run('process-settle', () => consumeKindOn(config, 'obligation:advanceProcessFlow.settle', INSTANCES.process, { terminalOutcome: 'success' }));
  run('stage-outcome', () => consumeKindOn(config, 'obligation:recordStageOutcome', INSTANCES.stage, { terminalOutcome: 'success' }));
  run('route-lifecycle', () => consumeKindOn(config, 'obligation:routeLifecycle', INSTANCES.lifecycle, { stageRoute: 'verify-terminal-claims' }));
  run('verify-terminal-claims', () => consumeKind(config, 'obligation:verifyTerminalClaims', {}));
  run('lifecycle-terminal-proof', () => ensureCommand(
    config,
    { command: 'lifecycleRun.issueTerminalProof', instanceId: INSTANCES.lifecycle, key: 'delivery:lifecycle-proof', done: (s) => headOf(s, INSTANCES.lifecycle)?.terminal !== undefined },
    { terminalOutcome: 'success' },
  ));
  run('run-terminal-proof', () => consumeKindOn(config, 'obligation:runSettlement', INSTANCES.factory, { terminalOutcome: 'success' }));

  // --- the immutable release record (write-once per candidate) ---
  // Runs even when the kernel ladder stopped at a frozen guard (e.g. the
  // re-release run whose run-level proof demands the FIRST release's
  // EffectReceipt:success): the record is the workshop output over the
  // approved decision + verified package, not a settlement step.
  if (decision !== undefined && decision.status === 'approved') {
    const packaged = verifyPackagedRelease(config.storeRoot, config.bundle.integratedCandidate.digest);
    if (packaged.ok) {
      const outcome = assembleReleaseRecord(config.storeRoot, {
        bundle: config.bundle,
        policyDigest: config.preflight.policyDigest,
        preflightDigest: config.preflight.preflightDigest,
        approvalRef: decision.decisionRef,
        packageDigest: packaged.packageDigest,
      });
      releaseRecordOutcome = outcome;
      if ('refused' in outcome) {
        done('release-record', { status: 'packaging-refused', reason: outcome.reason, detail: outcome.detail });
      } else {
        releaseRecord = outcome.record;
        steps.push({ step: 'release-record', result: { status: 'recorded' in outcome ? 'committed' : 'replayed' } });
      }
    }
  }

  const blocked = steps.find((entry) =>
    entry.result.status === 'refused'
    || entry.result.status === 'actor-refused'
    || entry.result.status === 'approval-refused'
    || entry.result.status === 'packaging-refused');
  return { steps, blockedAt: blocked?.step, decision, releaseRecord, releaseRecordOutcome };
}
