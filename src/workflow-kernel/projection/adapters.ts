/**
 * workflow-kernel/projection/adapters.ts - the COMMAND-ONLY UI action
 * adapters (WP-10, plan phase EK-7; test-only reachability until WP-12
 * performs the production cutover).
 *
 * THE LAW (plan EK-7): "Translate claim, review, stop, resume, retry and
 * human-response actions into typed commands against the kernel; command-
 * only adapters replace direct card-status mutation - a card write never
 * reaches storage except through a command."
 *
 * Enforcement, all structural:
 *   - This module imports NEITHER the card store NOR the projector: it has
 *     no card write capability at all. Every action returns the kernel's
 *     raw CommandOutcome; refreshing the board is the projector's separate
 *     job over the new canonical facts.
 *   - Every action is a thin translation into ONE OR MORE typed commands of
 *     the FROZEN 53-command universe (src/workflow-kernel/domain/universe.ts
 *     - closed; this module invents no command and no lane write).
 *   - The action payload shapes are closed: an action may carry a work-item
 *     reference, a gate verdict (the human's typed decision), a factory
 *     instance and an idempotency suffix. There is NO field for selecting a
 *     role, skill, tool set, completion command or prompt budget - the pinned
 *     role contract comes from the ONE WP-17 runtime resolution (or, on
 *     retry, is re-read from the durable WorkIntent - the identity law), and
 *     the adapter displays it in its result for diagnosis.
 *   - Target instances resolve ONLY from durable facts (topology bindings,
 *     admitted intents, aggregate heads) - never from a card row, never by
 *     recency.
 */

import type {
  CanonicalRoleContractReference,
  CommandInput,
  CommandOutcome,
  EvidenceFact,
  GateVerdict,
  InstanceId,
  TypedRefusal,
} from '../domain/types.js';
import { COMMANDS } from '../domain/universe.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import { repositoryOf, openFrontier, consumeClaim } from '../application/obligation-consumer.js';
import type { ConsumeInvocation, ConsumeResult, ObligationClaim } from '../application/obligation-consumer.js';
import { topologyBindings } from '../planning/bindings.js';
import { evaluateReadiness } from '../planning/readiness.js';
import type { RoleContractRuntime } from '../development/role-contract-runtime.js';

/**
 * Register-like constant table: command -> owning aggregate, derived from
 * the frozen universe at module load (data table, not name-literal
 * branching; the universe itself is the frozen register).
 */
const COMMAND_AGGREGATES: ReadonlyMap<string, string> = new Map(COMMANDS.map((descriptor) => [descriptor.name, descriptor.aggregate]));

/* ------------------------------------------------------------------ */
/* Closed action vocabulary                                            */
/* ------------------------------------------------------------------ */

export type UiAction =
  | { readonly action: 'claim'; readonly workItemRef: string; readonly launchKind: string }
  | { readonly action: 'review'; readonly workItemRef: string; readonly verdict: GateVerdict }
  | { readonly action: 'stop'; readonly factoryInstanceId: InstanceId }
  | { readonly action: 'resume'; readonly factoryInstanceId: InstanceId }
  | { readonly action: 'retry'; readonly workItemRef: string }
  | { readonly action: 'human-response'; readonly workItemRef: string };

/** The closed set of action names (display + fence data; a register-like table). */
export const UI_ACTION_NAMES: readonly string[] = Object.freeze(['claim', 'review', 'stop', 'resume', 'retry', 'human-response']);

/** Adapter dependencies: the session, the ONE role-contract runtime, the installed Input-authority evidence. */
export interface UiAdapterDeps {
  readonly session: KernelPersistenceSession;
  /**
   * The WP-17 role-contract runtime (one resolution per launch kind). The
   * tracker RECEIVES the pinned contract from it; it never selects one.
   */
  readonly roles: RoleContractRuntime;
  /**
   * The external Input-authority evidence (closed kind set: CheckPlan,
   * ProductVerificationEvidence/Failure) - the installed manifest facts,
   * identical for every caller; not a UI selection.
   */
  readonly externalEvidence: readonly EvidenceFact[];
}

/** What one adapter call reports back: the command outcome + displayed pin. */
export type UiActionResult =
  | { readonly status: 'committed' | 'replayed'; readonly command: string; readonly instanceId: InstanceId; readonly displayedRoleContract?: CanonicalRoleContractReference }
  | { readonly status: 'refused'; readonly command: string; readonly refusal: TypedRefusal; readonly displayedRoleContract?: CanonicalRoleContractReference };

/* ------------------------------------------------------------------ */
/* Durable target resolution (never a board read)                      */
/* ------------------------------------------------------------------ */

function workplaceOfItem(deps: UiAdapterDeps, workItemRef: string): InstanceId | undefined {
  const world = deps.session.hydrateWorld().world;
  const bindings = topologyBindings(world);
  const instanceId = workItemRef.startsWith('work-item:') ? workItemRef : `work-item:${workItemRef}`;
  const workplaces = bindings.workplacesOfWorkItem(instanceId);
  return workplaces.length > 0 ? workplaces[workplaces.length - 1] : undefined;
}

function headOf(deps: UiAdapterDeps, instanceId: InstanceId) {
  return deps.session.hydrateWorld().world.heads.get(instanceId);
}

function refusal(command: string, reason: TypedRefusal['reason'], detail: string): UiActionResult {
  return { status: 'refused', command, refusal: { refused: true, reason, detail } };
}

/* ------------------------------------------------------------------ */
/* The frontier lane consume (pinned to a durable instance)            */
/* ------------------------------------------------------------------ */

/**
 * Consume the frontier obligation of one exact target command, pinned to
 * the given instance (the WP-07 FIFO-lane discipline: the engine completes
 * the lane's head row inside the command's own transaction).
 */
function consumeTargetPinned(
  deps: UiAdapterDeps,
  target: string,
  invocation: ConsumeInvocation,
  pinnedInstanceId: InstanceId | undefined,
): { readonly idle: true } | { readonly unresolvable: true; readonly detail: string } | ConsumeResult {
  const entry = openFrontier(deps.session).find((candidate) => candidate.target === target);
  if (entry === undefined) return { idle: true };
  if (entry.claim === undefined) return { unresolvable: true, detail: (entry.refusal as TypedRefusal).detail };
  let claim: ObligationClaim = entry.claim;
  if (pinnedInstanceId !== undefined && claim.targetInstanceId !== pinnedInstanceId) {
    const head = headOf(deps, pinnedInstanceId);
    claim = {
      ...claim,
      targetInstanceId: pinnedInstanceId,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey: `${claim.idempotencyKey}@${pinnedInstanceId}@${head === undefined ? 0 : head.revision}`,
    };
  }
  return consumeClaim(deps.session, claim, invocation, { externalEvidence: deps.externalEvidence });
}

/** Direct bounded application of an exempt command through its OWNING repository. */
function applyDirect(deps: UiAdapterDeps, input: CommandInput): CommandOutcome {
  const owner = COMMAND_AGGREGATES.get(input.command);
  if (owner === undefined) {
    throw new Error(`EK_UI_ADAPTER: ${input.command} is not declared in the frozen command universe`);
  }
  const repository = repositoryOf(deps.session, owner);
  return repository.applyCommand(input, { externalEvidence: deps.externalEvidence });
}

/* ------------------------------------------------------------------ */
/* The adapters                                                        */
/* ------------------------------------------------------------------ */

/**
 * CLAIM: admit the author WorkIntent of one work item - the human takes
 * the card. Translates to workplace.admitWorkIntent with:
 *   - the pinned role contract of the launch kind's ONE runtime resolution
 *     (displayed in the result; never selected here);
 *   - the exact predecessor evidence refs the WP-09 readiness predicate
 *     derives from authoritative facts;
 * and refuses (typed) when the item is not ready or has no workplace.
 */
export function uiClaim(deps: UiAdapterDeps, action: Extract<UiAction, { action: 'claim' }>): UiActionResult {
  const slot = deps.roles.slotOf(action.launchKind);
  if (slot === undefined) {
    return refusal('workplace.admitWorkIntent', 'ROLE_CONTRACT_REF_MISMATCH', `launch kind ${action.launchKind} was never resolved at WorkIntent creation (the UI never resolves it)`);
  }
  const workplace = workplaceOfItem(deps, action.workItemRef);
  if (workplace === undefined) {
    return refusal('workplace.admitWorkIntent', 'MISSING_EVIDENCE', `no workplace is materialized for work item ${action.workItemRef} (nothing to claim; the card is TODO by facts, not by lane)`);
  }
  const world = deps.session.hydrateWorld().world;
  const bindings = topologyBindings(world);
  const edges = deps.session.workItem.loadDependencies().map((row) => ({ workItemRef: row.workItemRef, dependsOnRef: row.dependsOnRef }));
  const instanceId = action.workItemRef.startsWith('work-item:') ? action.workItemRef : `work-item:${action.workItemRef}`;
  const readiness = evaluateReadiness(edges, bindings, instanceId);
  if (readiness.state !== 'ready') {
    return refusal(
      'workplace.admitWorkIntent',
      'MISSING_EVIDENCE',
      readiness.state === 'unreachable'
        ? `work item ${action.workItemRef} is unreachable (failed predecessors: ${readiness.failedPredecessors.join(', ')})`
        : `work item ${action.workItemRef} is not ready (gaps: ${readiness.gaps.map((gap) => `${gap.itemRef}:${gap.reason}`).join('; ')})`,
    );
  }
  const invocation: ConsumeInvocation = {
    protocolRole: slot.protocolRole,
    rolePin: slot.pin,
    evidenceRefs: [instanceId, ...readiness.inputEvidenceRefs],
  };
  const consumed = consumeTargetPinned(deps, 'workplace.admitWorkIntent', invocation, workplace);
  if ('idle' in consumed || 'unresolvable' in consumed) {
    // No resolvable admit lane row (none open, or its target instance has no
    // durable binding): the exempt direct path - the SAME typed command
    // through the owning repository (the lane row, if any, stays as durable
    // routing evidence; the conveyor follows the same discipline).
    const head = headOf(deps, workplace);
    const outcome = applyDirect(deps, {
      command: 'workplace.admitWorkIntent',
      instanceId: workplace,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey: `ui:claim:${action.workItemRef}`,
      protocolRole: slot.protocolRole,
      rolePin: slot.pin,
      evidenceRefs: [instanceId, ...readiness.inputEvidenceRefs],
    });
    return outcomeOf('workplace.admitWorkIntent', workplace, outcome, slot.pin);
  }
  if (consumed.status === 'refused') {
    return { status: 'refused', command: 'workplace.admitWorkIntent', refusal: consumed.refusal, displayedRoleContract: slot.pin };
  }
  return { status: consumed.status, command: 'workplace.admitWorkIntent', instanceId: workplace, displayedRoleContract: slot.pin };
}

/**
 * REVIEW: record the human reviewer's typed verdict. Translates to
 * workplace.runFinalGate carrying the exact GateVerdict (the verdict is the
 * reviewer's typed decision - the only field the UI contributes).
 */
export function uiReview(deps: UiAdapterDeps, action: Extract<UiAction, { action: 'review' }>): UiActionResult {
  const workplace = workplaceOfItem(deps, action.workItemRef);
  if (workplace === undefined) {
    return refusal('workplace.runFinalGate', 'MISSING_EVIDENCE', `no workplace is materialized for work item ${action.workItemRef}`);
  }
  const consumed = consumeTargetPinned(deps, 'workplace.runFinalGate', { gateVerdict: action.verdict }, workplace);
  if ('idle' in consumed) {
    return refusal('workplace.runFinalGate', 'ILLEGAL_TRANSITION', `no open final-gate obligation for ${workplace} (the card's lane is a view; the obligation is the authority)`);
  }
  if ('unresolvable' in consumed) {
    return refusal('workplace.runFinalGate', 'MISSING_EVIDENCE', consumed.detail);
  }
  if (consumed.status === 'refused') {
    return { status: 'refused', command: 'workplace.runFinalGate', refusal: consumed.refusal };
  }
  return { status: consumed.status, command: 'workplace.runFinalGate', instanceId: workplace };
}

/** STOP: translate to factoryRun.requestStop (commits TypedWait:policy-quota). */
export function uiStop(deps: UiAdapterDeps, action: Extract<UiAction, { action: 'stop' }>): UiActionResult {
  const head = headOf(deps, action.factoryInstanceId);
  const outcome = applyDirect(deps, {
    command: 'factoryRun.requestStop',
    instanceId: action.factoryInstanceId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `ui:stop:${action.factoryInstanceId}`,
  });
  return outcomeOf('factoryRun.requestStop', action.factoryInstanceId, outcome);
}

/** RESUME: translate to factoryRun.resume (the stop wait's durable wake command). */
export function uiResume(deps: UiAdapterDeps, action: Extract<UiAction, { action: 'resume' }>): UiActionResult {
  const head = headOf(deps, action.factoryInstanceId);
  const outcome = applyDirect(deps, {
    command: 'factoryRun.resume',
    instanceId: action.factoryInstanceId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `ui:resume:${action.factoryInstanceId}`,
  });
  return outcomeOf('factoryRun.resume', action.factoryInstanceId, outcome);
}

/**
 * RETRY: state-derived, identity-preserving. Exactly two lawful retry
 * shapes exist in the frozen universe, selected by the DURABLE workplace
 * status (never by the card lane):
 *   - repair-wait-entered -> workplace.rolloverRepairEpoch, then re-admit
 *     the AUTHOR WorkIntent re-using the SAME pinned contract read from the
 *     durable prior intent (ADR-053/FWD:F007: repair reuses the identity,
 *     the UI never re-resolves);
 *   - any other nonterminal status with an open settleEffect lane ->
 *     workplace.settleEffect redrive (a retryable effect outcome's lane).
 */
export function uiRetry(deps: UiAdapterDeps, action: Extract<UiAction, { action: 'retry' }>): UiActionResult {
  const workplace = workplaceOfItem(deps, action.workItemRef);
  if (workplace === undefined) {
    return refusal('workplace.rolloverRepairEpoch', 'MISSING_EVIDENCE', `no workplace is materialized for work item ${action.workItemRef}`);
  }
  const status = headOf(deps, workplace)?.status;

  if (status === 'repair-wait-entered') {
    const head = headOf(deps, workplace);
    const rollover = applyDirect(deps, {
      command: 'workplace.rolloverRepairEpoch',
      instanceId: workplace,
      expectedRevision: head === undefined ? 0 : head.revision,
      idempotencyKey: `ui:retry-rollover:${action.workItemRef}`,
    });
    const rolloverResult = outcomeOf('workplace.rolloverRepairEpoch', workplace, rollover);
    if (rolloverResult.status === 'refused') return rolloverResult;

    // Re-admit the AUTHOR identity: the pin is READ from the durable prior
    // author WorkIntent of this workplace (never re-resolved, never chosen).
    const world = deps.session.hydrateWorld().world;
    const priorIntent = [...world.workIntents.values()]
      .filter((intent) => intent.workplaceInstanceId === workplace && intent.protocolRole === 'author')
      .pop();
    if (priorIntent === undefined) {
      return refusal('workplace.admitWorkIntent', 'MISSING_EVIDENCE', `no prior author WorkIntent on ${workplace} to re-use for retry (identity is durable, not selected)`);
    }
    const afterHead = headOf(deps, workplace);
    const reAdmission = applyDirect(deps, {
      command: 'workplace.admitWorkIntent',
      instanceId: workplace,
      expectedRevision: afterHead === undefined ? 0 : afterHead.revision,
      idempotencyKey: `ui:retry-admit:${action.workItemRef}:r${afterHead === undefined ? 0 : afterHead.revision}`,
      protocolRole: 'author',
      rolePin: priorIntent.roleContract,
      evidenceRefs: [priorIntent.workItemRef],
    });
    return outcomeOf('workplace.admitWorkIntent', workplace, reAdmission, priorIntent.roleContract);
  }

  const redrive = consumeTargetPinned(deps, 'workplace.settleEffect', { effectOutcome: 'success' }, workplace);
  if ('idle' in redrive) {
    return refusal('workplace.settleEffect', 'ILLEGAL_TRANSITION', `workplace ${workplace} is in status ${String(status)} with no open effect lane (no lawful retry; the lane is a view, the status is the fact)`);
  }
  if ('unresolvable' in redrive) {
    return refusal('workplace.settleEffect', 'MISSING_EVIDENCE', redrive.detail);
  }
  if (redrive.status === 'refused') {
    return { status: 'refused', command: 'workplace.settleEffect', refusal: redrive.refusal };
  }
  return { status: redrive.status, command: 'workplace.settleEffect', instanceId: workplace };
}

/**
 * HUMAN-RESPONSE: translate to workplace.resolveHumanResponse - the D12
 * operator disposition that legally discharges BOTH TypedWait:human-input
 * and TypedWait:effect-uncertainty (the frozen WAITS registry names this
 * command as the wake source of both).
 */
export function uiHumanResponse(deps: UiAdapterDeps, action: Extract<UiAction, { action: 'human-response' }>): UiActionResult {
  const workplace = workplaceOfItem(deps, action.workItemRef);
  if (workplace === undefined) {
    return refusal('workplace.resolveHumanResponse', 'MISSING_EVIDENCE', `no workplace is materialized for work item ${action.workItemRef}`);
  }
  const head = headOf(deps, workplace);
  const outcome = applyDirect(deps, {
    command: 'workplace.resolveHumanResponse',
    instanceId: workplace,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `ui:human-response:${action.workItemRef}`,
  });
  return outcomeOf('workplace.resolveHumanResponse', workplace, outcome);
}

/* ------------------------------------------------------------------ */
/* Dispatch + result shaping                                           */
/* ------------------------------------------------------------------ */

/** Translate one UI action through its adapter (the single dispatch entry). */
export function dispatchUiAction(deps: UiAdapterDeps, action: UiAction): UiActionResult {
  switch (action.action) {
    case 'claim':
      return uiClaim(deps, action);
    case 'review':
      return uiReview(deps, action);
    case 'stop':
      return uiStop(deps, action);
    case 'resume':
      return uiResume(deps, action);
    case 'retry':
      return uiRetry(deps, action);
    case 'human-response':
      return uiHumanResponse(deps, action);
  }
}

function outcomeOf(command: string, instanceId: InstanceId, outcome: CommandOutcome, displayedRoleContract?: CanonicalRoleContractReference): UiActionResult {
  if ('refused' in outcome) {
    return { status: 'refused', command, refusal: outcome, ...(displayedRoleContract !== undefined ? { displayedRoleContract } : {}) };
  }
  if ('replayed' in outcome) {
    return { status: 'replayed', command, instanceId, ...(displayedRoleContract !== undefined ? { displayedRoleContract } : {}) };
  }
  return { status: 'committed', command, instanceId, ...(displayedRoleContract !== undefined ? { displayedRoleContract } : {}) };
}
