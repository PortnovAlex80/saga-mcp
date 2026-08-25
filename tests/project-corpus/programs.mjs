/**
 * tests/project-corpus/programs.mjs - the shared authored-program builders
 * of the WP-13D project corpus (pure data over the WP-13B actor library).
 *
 * Every builder returns AUTHORING DATA only: authored WP-13B ActorStep
 * lists plus expectation DERIVATIONS that read the frozen universe
 * descriptors (dist/workflow-kernel/domain/universe.js) and the authored
 * program structure - never production output (the WP-13A authoring law).
 *
 * The builders assemble, from the WP-13B library pieces:
 *   - verticalPrefixSteps  (the factory vertical prefix);
 *   - attemptLoopSteps     (author/reviewer attempt loops);
 *   - the settlement ladders as authored steps (public commands, exact
 *     revisions computed later by compileActorProgram's dry walk);
 *   - the D5/D12 operator chain (human wait + effect uncertainty).
 */

import { COMMANDS } from '../../dist/workflow-kernel/domain/universe.js';

/* ------------------------------------------------------------------ */
/* Instance ids shared by the durable-session projects                  */
/* ------------------------------------------------------------------ */

export const IDS = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
  transport: 'cognition:transport',
};

/* ------------------------------------------------------------------ */
/* Expectation derivations (authored from the universe + the program)   */
/* ------------------------------------------------------------------ */

const DESCRIPTOR_BY_COMMAND = new Map(COMMANDS.map((descriptor) => [descriptor.name, descriptor]));

/** The primary event kind a command emits (every command emits exactly one). */
export const eventOf = (command) => DESCRIPTOR_BY_COMMAND.get(command)?.emitsEvents[0];

/** The authored event sequence of an authored step list (universe descriptors). */
export function authoredEvents(steps) {
  return steps.map((step) => eventOf(step.command)).filter((kind) => kind !== undefined);
}

/**
 * The obligations each authored loop MUST have completed when the program
 * settles: authored from the command descriptors of the loop steps (each
 * loop application creates its lane rows; a settled loop leaves every
 * created row completed). Returns [{kind, state:'completed'}].
 */
export function completedObligationsOf(steps, kinds) {
  const out = [];
  for (const step of steps) {
    const descriptor = DESCRIPTOR_BY_COMMAND.get(step.command);
    if (descriptor === undefined) continue;
    for (const kind of descriptor.createsObligations) {
      if (kinds.includes(kind)) out.push({ kind, state: 'completed' });
    }
  }
  return out;
}

/** The distinct obligation kinds an authored step list creates. */
export function createdObligationKinds(steps) {
  const kinds = new Set();
  for (const step of steps) {
    const descriptor = DESCRIPTOR_BY_COMMAND.get(step.command);
    if (descriptor === undefined) continue;
    for (const kind of descriptor.createsObligations) kinds.add(kind);
  }
  return [...kinds].sort();
}

/** Map a declared outcome to its proof-family suffix (universe proof ids). */
const proofSuffixOf = (outcome) => (outcome === 'truthful-failure' ? 'truthful-failure' : outcome);

/**
 * The terminal proofs an authored step list issues (universe proof tables):
 * a proof command with an explicit terminalOutcome issues that exact proof;
 * a single-proof command issues its one proof.
 */
/**
 * The outcome selector a command input yields (the frozen selectedOutcome
 * table of the explorer): an explicit terminalOutcome wins; the named
 * commands default; everything else selects nothing.
 */
function selectedOutcomeOf(step) {
  if (step.terminalOutcome !== undefined) return step.terminalOutcome;
  switch (step.command) {
    case 'lifecycleRun.cancel': return 'cancellation';
    case 'nodeRun.recordCellAcceptance':
    case 'workplace.recordFinalAcceptance': return 'success';
    case 'nodeRun.settleUnreachable': return 'unreachable';
    case 'nodeRun.fail':
    case 'processRun.settleFailure': return 'truthful-failure';
    default: return step.gateVerdict === 'terminal-reject' || step.effectOutcome === 'policy-terminal' ? 'truthful-failure' : 'none';
  }
}

export function authoredProofs(steps) {
  const proofs = [];
  for (const step of steps) {
    const descriptor = DESCRIPTOR_BY_COMMAND.get(step.command);
    if (descriptor === undefined || descriptor.proofs.length === 0) continue;
    const selector = selectedOutcomeOf(step);
    if (selector === 'none') continue; // e.g. the retry arm of the repair rollover issues no failure proof
    const family = descriptor.proofs[0];
    const prefix = family.slice(0, family.lastIndexOf('.'));
    proofs.push(`${prefix}.${proofSuffixOf(selector)}`);
  }
  return [...new Set(proofs)].sort();
}

/* ------------------------------------------------------------------ */
/* The settlement ladders as authored public-command steps              */
/* ------------------------------------------------------------------ */

const step = (stepId, command, instance, extra = {}) => ({
  stepId,
  semanticProfile: 'certifier',
  behavior: 'compliant',
  command,
  instance,
  tools: [],
  ...extra,
});

/**
 * The node/process/stage/lifecycle/run settlement ladder AFTER a workplace
 * terminal proof (the successSpine order of the frozen universe):
 * cell materialization -> kernel result -> cell acceptance -> flow terminal
 * -> process settle -> stage outcome -> lifecycle route/verify/proof ->
 * run proof. `includeCellMaterialization: false` skips the materializeCell
 * step when the program already materialized the node cell earlier.
 */
export function successLadderSteps(prefix, { includeCellMaterialization = true, includeKernelResult = true } = {}) {
  return [
    ...(includeCellMaterialization ? [step(`${prefix}-cell-materialize`, 'nodeRun.materializeCell', IDS.node)] : []),
    ...(includeKernelResult ? [step(`${prefix}-kernel-result`, 'nodeRun.recordKernelResult', IDS.node)] : []),
    step(`${prefix}-cell-acceptance`, 'nodeRun.recordCellAcceptance', IDS.node),
    step(`${prefix}-flow-terminal`, 'processRun.recordNodeTerminal', IDS.process),
    step(`${prefix}-process-settle`, 'processRun.settle', IDS.process, { terminalOutcome: 'success' }),
    step(`${prefix}-stage-outcome`, 'stageRun.recordLocalOutcome', IDS.stage, { terminalOutcome: 'success' }),
    step(`${prefix}-lifecycle-route`, 'lifecycleRun.routeOutcome', IDS.lifecycle, { stageRoute: 'verify-terminal-claims' }),
    step(`${prefix}-lifecycle-verify`, 'lifecycleRun.verifyTerminalClaims', IDS.lifecycle),
    step(`${prefix}-lifecycle-proof`, 'lifecycleRun.issueTerminalProof', IDS.lifecycle, { terminalOutcome: 'success' }),
    step(`${prefix}-run-proof`, 'factoryRun.recordRunTerminalProof', IDS.factory, { terminalOutcome: 'success' }),
  ];
}

/** The truthful-failure ladder (the honest failure settlement, D6+D7). */
export function failureLadderSteps(prefix, { includeCellMaterialization = true } = {}) {
  return [
    step(`${prefix}-workplace-proof`, 'workplace.issueWorkplaceTerminalProof', IDS.workplace, { terminalOutcome: 'truthful-failure' }),
    ...(includeCellMaterialization ? [step(`${prefix}-cell-materialize`, 'nodeRun.materializeCell', IDS.node)] : []),
    step(`${prefix}-node-fail`, 'nodeRun.fail', IDS.node),
    step(`${prefix}-flow-terminal`, 'processRun.recordNodeTerminal', IDS.process),
    step(`${prefix}-process-settle-failure`, 'processRun.settleFailure', IDS.process),
    step(`${prefix}-stage-outcome`, 'stageRun.recordLocalOutcome', IDS.stage, { terminalOutcome: 'truthful-failure' }),
    step(`${prefix}-lifecycle-route`, 'lifecycleRun.routeOutcome', IDS.lifecycle, { stageRoute: 'verify-terminal-claims' }),
    step(`${prefix}-lifecycle-verify`, 'lifecycleRun.verifyTerminalClaims', IDS.lifecycle),
    step(`${prefix}-lifecycle-proof`, 'lifecycleRun.issueTerminalProof', IDS.lifecycle, { terminalOutcome: 'truthful-failure' }),
    step(`${prefix}-run-proof`, 'factoryRun.recordRunTerminalProof', IDS.factory, { terminalOutcome: 'truthful-failure' }),
  ];
}

/* ------------------------------------------------------------------ */
/* The corpus vertical prefix                                          */
/* ------------------------------------------------------------------ */

/**
 * The corpus vertical prefix: the WP-13B factory prefix PLUS the planning
 * graph commit (workItem.planGraph with its two required external-planning
 * refs, in the successSpine position between importCapsule and start).
 * The planning graph is what later makes node cell acceptance lawful
 * (WorkItemDependency evidence) and it stands in for the dependency
 * topology fact base of the single-workplace projects.
 */
export function corpusVerticalPrefix(profile = 'implementer') {
  const { verticalPrefixSteps } = corpusVerticalPrefix.libs;
  const prefix = verticalPrefixSteps(IDS, profile);
  const planGraph = {
    stepId: 'prefix-plan-graph',
    semanticProfile: 'planner',
    behavior: 'compliant',
    command: 'workItem.planGraph',
    instance: 'work-item:1',
    evidenceRefs: ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'],
    tools: [],
  };
  return [...prefix.slice(0, 2), planGraph, ...prefix.slice(2)];
}

/* ------------------------------------------------------------------ */
/* Project program recipes                                             */
/* ------------------------------------------------------------------ */

/**
 * The served-product desk program: vertical prefix, one author loop and
 * one reviewer loop (both accepted), the effect settles over the verified
 * product, final acceptance, close, workplace terminal, full success
 * ladder. `repairRounds` inserts D6 repair epochs before the accepted
 * re-submission (the served repair family).
 */
export function servedDeskProgram({ loopId = 'desk', repairRounds = 0, attemptBase = 1 } = {}) {
  const { attemptLoopSteps, verticalPrefixSteps } = servedDeskProgram.libs;
  const gateVerdict = repairRounds > 0 ? 'repair' : 'accepted';
  const loops = [
    ...attemptLoopSteps({
      loopId: `${loopId}-author-1`, role: 'author', profile: 'implementer',
      workplace: IDS.workplace, attempt: `activity-attempt:${attemptBase}`, gate: 'author', gateVerdict,
    }),
  ];
  for (let round = 1; round <= repairRounds; round += 1) {
    loops.push(
      step(`${loopId}-repair-wait-${round}`, 'workplace.enterRepairWait', IDS.workplace, { semanticProfile: 'implementer', behavior: 'repairing' }),
      step(`${loopId}-repair-rollover-${round}`, 'workplace.rolloverRepairEpoch', IDS.workplace, { semanticProfile: 'implementer', behavior: 'repairing' }),
      ...attemptLoopSteps({
        loopId: `${loopId}-author-${round + 1}`, role: 'author', profile: 'implementer',
        workplace: IDS.workplace, attempt: `activity-attempt:${attemptBase + round}`, gate: 'author',
        gateVerdict: round === repairRounds ? 'accepted' : 'repair',
      }),
    );
  }
  loops.push(
    ...attemptLoopSteps({
      loopId: `${loopId}-reviewer-1`, role: 'reviewer', profile: 'reviewer',
      workplace: IDS.workplace, attempt: `activity-attempt:${attemptBase + repairRounds + 1}`, gate: 'final', gateVerdict: 'accepted',
    }),
    step(`${loopId}-settle-success`, 'workplace.settleEffect', IDS.workplace, { semanticProfile: 'implementer', effectOutcome: 'success' }),
    step(`${loopId}-final-acceptance`, 'workplace.recordFinalAcceptance', IDS.workplace),
    step(`${loopId}-close-presentation`, 'workplace.closePresentation', IDS.workplace),
    step(`${loopId}-workplace-terminal`, 'workplace.issueWorkplaceTerminalProof', IDS.workplace, { terminalOutcome: 'success' }),
    ...successLadderSteps(loopId),
  );
  return [...corpusVerticalPrefix(), ...loops];
}

/**
 * The D5 human-wait arm: the author desk's gate returns human-wait, the
 * scripted OPERATOR disposes of it through the public command
 * (enterHumanWait -> resolveHumanResponse), then the desk is re-driven to
 * acceptance and the ladder settles.
 */
export function humanWaitProgram({ loopId = 'hw' } = {}) {
  const { attemptLoopSteps, verticalPrefixSteps } = humanWaitProgram.libs;
  return [
    ...corpusVerticalPrefix(),
    // Author loop #1: the author gate sends the cell into a human wait.
    ...attemptLoopSteps({
      loopId: `${loopId}-author-1`, role: 'author', profile: 'implementer',
      workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'human-wait',
    }),
    // The scripted operator disposition (public commands, deterministic).
    step(`${loopId}-enter-human-wait`, 'workplace.enterHumanWait', IDS.workplace, { semanticProfile: 'certifier' }),
    step(`${loopId}-resolve-human-1`, 'workplace.resolveHumanResponse', IDS.workplace, { semanticProfile: 'certifier' }),
    // The desk re-runs and is accepted (author re-submission + reviewer gate).
    ...attemptLoopSteps({
      loopId: `${loopId}-author-2`, role: 'author', profile: 'implementer',
      workplace: IDS.workplace, attempt: 'activity-attempt:2', gate: 'author', gateVerdict: 'accepted',
    }),
    ...attemptLoopSteps({
      loopId: `${loopId}-reviewer-1`, role: 'reviewer', profile: 'reviewer',
      workplace: IDS.workplace, attempt: 'activity-attempt:3', gate: 'final', gateVerdict: 'accepted',
    }),
    // The node human-approval chain: recordHumanDecision is the second lawful
    // wake of a pending human-input wait (the enterHumanWait wait #B is
    // discharged here, exactly as in the WP-13B reference scenario). The
    // honest terminal of this arm is the WORKPLACE terminal proof: the node
    // reducer has NO cell-acceptance edge from the human-decision path, so
    // the run ladder cannot close past a human-decision node (a recorded
    // kernel residual, not worked around here).
    step(`${loopId}-cell-materialize`, 'nodeRun.materializeCell', IDS.node),
    step(`${loopId}-node-kernel-result`, 'nodeRun.recordKernelResult', IDS.node),
    step(`${loopId}-node-human-decision`, 'nodeRun.recordHumanDecision', IDS.node),
    step(`${loopId}-settle-success`, 'workplace.settleEffect', IDS.workplace, { semanticProfile: 'implementer', effectOutcome: 'success' }),
    step(`${loopId}-final-acceptance`, 'workplace.recordFinalAcceptance', IDS.workplace),
    step(`${loopId}-close-presentation`, 'workplace.closePresentation', IDS.workplace),
    step(`${loopId}-workplace-terminal`, 'workplace.issueWorkplaceTerminalProof', IDS.workplace, { terminalOutcome: 'success' }),
  ];
}

/**
 * The D12 effect-uncertainty arm: the node's provider outcome is UNKNOWN
 * (the non-idempotent send happened, its outcome is not), the kernel
 * commits TypedWait:effect-uncertainty whose ONLY wake is the operator
 * disposition command, and the effect then settles success exactly once.
 * The honest terminal of this arm is the WORKPLACE terminal with the node
 * left in provider-uncertainty-waited: the run ladder may not advance past
 * an outstanding operator disposition.
 */
export function effectUncertaintyProgram({ loopId = 'd12' } = {}) {
  const { attemptLoopSteps } = effectUncertaintyProgram.libs;
  return [
    ...corpusVerticalPrefix(),
    // The D5 prefix: the author gate sends the cell into a human wait and
    // the scripted operator disposes of it (recordHumanDecision is lawful
    // only through this discharged human-input wake - the frozen registry).
    ...attemptLoopSteps({
      loopId: `${loopId}-author-1`, role: 'author', profile: 'implementer',
      workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'human-wait',
    }),
    step(`${loopId}-enter-human-wait`, 'workplace.enterHumanWait', IDS.workplace, { semanticProfile: 'certifier' }),
    step(`${loopId}-resolve-human-1`, 'workplace.resolveHumanResponse', IDS.workplace, { semanticProfile: 'certifier' }),
    ...attemptLoopSteps({
      loopId: `${loopId}-author-2`, role: 'author', profile: 'implementer',
      workplace: IDS.workplace, attempt: 'activity-attempt:2', gate: 'author', gateVerdict: 'accepted',
    }),
    ...attemptLoopSteps({
      loopId: `${loopId}-reviewer-1`, role: 'reviewer', profile: 'reviewer',
      workplace: IDS.workplace, attempt: 'activity-attempt:3', gate: 'final', gateVerdict: 'accepted',
    }),
    // The node provider chain: materialized cell, kernel result, the human
    // approval node, then the UNKNOWN non-idempotent send.
    step(`${loopId}-cell-materialize`, 'nodeRun.materializeCell', IDS.node),
    step(`${loopId}-node-kernel-result`, 'nodeRun.recordKernelResult', IDS.node),
    step(`${loopId}-node-human-decision`, 'nodeRun.recordHumanDecision', IDS.node),
    step(`${loopId}-node-provider-unknown`, 'nodeRun.recordProviderOutcome', IDS.node, { effectOutcome: 'unknown' }),
    step(`${loopId}-settle-success`, 'workplace.settleEffect', IDS.workplace, { semanticProfile: 'implementer', effectOutcome: 'success' }),
    step(`${loopId}-final-acceptance`, 'workplace.recordFinalAcceptance', IDS.workplace),
    step(`${loopId}-close-presentation`, 'workplace.closePresentation', IDS.workplace),
    step(`${loopId}-workplace-terminal`, 'workplace.issueWorkplaceTerminalProof', IDS.workplace, { terminalOutcome: 'success' }),
  ];
}

/**
 * The worker-loss arm: a timed-out attempt is classified (never
 * product-failed), then retried ON THE SAME WorkIntent to acceptance.
 */
export function workerLossProgram({ loopId = 'wl' } = {}) {
  const { attemptLoopSteps, verticalPrefixSteps } = workerLossProgram.libs;
  return [
    ...corpusVerticalPrefix(),
    ...attemptLoopSteps({
      loopId: `${loopId}-author-1`, role: 'author', profile: 'implementer',
      workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'accepted', behavior: 'timeout',
    }),
    // The retry: a fresh attempt on the SAME admitted intent (the workplace
    // is already author-intent-admitted; no re-admission may occur).
    step(`${loopId}-retry-attempt`, 'activityAttempt.create', 'activity-attempt:2', { semanticProfile: 'implementer', intentOf: `${loopId}-author-1-admit`, pin: 'author' }),
    step(`${loopId}-retry-admission`, 'activityAttempt.admitProviderRequest', 'activity-attempt:2'),
    step(`${loopId}-retry-send`, 'cognition.sendProviderRequest', IDS.transport),
    step(`${loopId}-retry-outcome`, 'activityAttempt.recordOutcome', 'activity-attempt:2', { intentOf: `${loopId}-author-1-admit` }),
    step(`${loopId}-retry-contribution`, 'workplace.recordContribution', IDS.workplace),
    step(`${loopId}-retry-seal`, 'workplace.sealProductionRevision', IDS.workplace),
    step(`${loopId}-retry-present`, 'workplace.presentCandidateSet', IDS.workplace),
    step(`${loopId}-retry-gate`, 'workplace.runAuthorGate', IDS.workplace, { gateVerdict: 'accepted' }),
    ...attemptLoopSteps({
      loopId: `${loopId}-reviewer-1`, role: 'reviewer', profile: 'reviewer',
      workplace: IDS.workplace, attempt: 'activity-attempt:3', gate: 'final', gateVerdict: 'accepted',
    }),
    step(`${loopId}-settle-success`, 'workplace.settleEffect', IDS.workplace, { semanticProfile: 'implementer', effectOutcome: 'success' }),
    step(`${loopId}-final-acceptance`, 'workplace.recordFinalAcceptance', IDS.workplace),
    step(`${loopId}-close-presentation`, 'workplace.closePresentation', IDS.workplace),
    step(`${loopId}-workplace-terminal`, 'workplace.issueWorkplaceTerminalProof', IDS.workplace, { terminalOutcome: 'success' }),
    ...successLadderSteps(loopId),
  ];
}

/** The honest typed-refusal program: a stale-hash step refuses and STOPS the run. */
export function staleRefusalProgram({ loopId = 'refuse' } = {}) {
  const { attemptLoopSteps, verticalPrefixSteps } = staleRefusalProgram.libs;
  const authorLoop = attemptLoopSteps({
    loopId: `${loopId}-author-1`, role: 'author', profile: 'implementer',
    workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'accepted',
  });
  return [
    ...corpusVerticalPrefix(),
    ...authorLoop.map((entry) => (entry.stepId === `${loopId}-author-1-contribution`
      ? { ...entry, behavior: 'stale-hash' }
      : entry)),
  ];
}

/**
 * The material/gate/effect evidence multiset an authored program produces
 * (authored from the frozen producers table of the universe - the same
 * table the explorer's COMMAND_PRODUCTION encodes):
 *   - sealProductionRevision      -> WorkplaceProductionRevision
 *   - presentCandidateSet         -> CandidateSet:author + CandidateSet:reviewer
 *   - recordContribution          -> ActivityAttemptContribution
 *   - runAuthorGate/runFinalGate  -> GateDecision:<verdict> (+ AcceptedCandidateAuthority on accepted)
 *   - recordFinalAcceptance       -> CellFinalAcceptance
 *   - settleEffect                -> EffectReceipt:<outcome>
 *   - nodeRun.recordProviderOutcome -> EffectReceipt:<outcome>
 */
export function authoredEvidence(steps) {
  const material = [];
  const gate = [];
  const effect = [];
  const push = (list, ...kinds) => list.push(...kinds);
  for (const step of steps) {
    switch (step.command) {
      case 'workplace.recordContribution': push(material, 'ActivityAttemptContribution'); break;
      case 'workplace.sealProductionRevision': push(material, 'WorkplaceProductionRevision'); break;
      case 'workplace.presentCandidateSet': push(material, 'CandidateSet:author', 'CandidateSet:reviewer'); break;
      case 'workplace.runAuthorGate':
      case 'workplace.runFinalGate': {
        const verdict = step.gateVerdict ?? 'accepted';
        push(gate, `GateDecision:${verdict}`);
        if (verdict === 'accepted') push(material, 'AcceptedCandidateAuthority');
        break;
      }
      case 'workplace.recordFinalAcceptance': push(material, 'CellFinalAcceptance'); break;
      case 'workplace.settleEffect': push(effect, `EffectReceipt:${step.effectOutcome ?? 'success'}`); break;
      default: break;
    }
  }
  return { material, gate, effect };
}

/**
 * The typed waits an authored program commits (authored from the frozen
 * WAITS registry: which commands create which waits under which inputs).
 */
export function authoredWaits(steps) {
  const waits = [];
  for (const step of steps) {
    switch (step.command) {
      case 'workplace.runAuthorGate':
      case 'workplace.runFinalGate':
        if (step.gateVerdict === 'human-wait') waits.push('TypedWait:human-input');
        break;
      case 'workplace.enterHumanWait': waits.push('TypedWait:human-input'); break;
      case 'nodeRun.recordProviderOutcome':
        if (step.effectOutcome === 'unknown') waits.push('TypedWait:effect-uncertainty');
        break;
      case 'activityAttempt.classifyWorkerLoss': waits.push('TypedWait:external-availability'); break;
      default: break;
    }
  }
  return waits;
}

/* The WP-13B libraries are injected lazily to keep this module importable
   from tools (the dist build must exist - the driver checks it anyway). */
const libs = await import('../../dist/workflow-kernel/testing/actors.js');
for (const builder of [servedDeskProgram, humanWaitProgram, effectUncertaintyProgram, workerLossProgram, staleRefusalProgram, corpusVerticalPrefix]) {
  builder.libs = { attemptLoopSteps: libs.attemptLoopSteps, verticalPrefixSteps: libs.verticalPrefixSteps };
}
