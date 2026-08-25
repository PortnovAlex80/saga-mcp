/**
 * reference-scenario.mjs - the WP-13B REFERENCE SCENARIO program (shared
 * fixture, no tests): a runtime human wait exercised end-to-end through
 * PUBLIC COMMANDS with scripted actors resolving it (the autonomy rule).
 *
 * The chain (one world, all public commands, authored data):
 *   1. factory vertical prefix (bootstrap .. workplace.materialize);
 *   2. author loop #1 ends in a GateDecision:human-wait verdict ->
 *      TypedWait:human-input #A pending;
 *   3. workplace.enterHumanWait (wait #B); the scripted operator actor
 *      resolves via workplace.resolveHumanResponse -> #A discharged
 *      (WakeDischarge:human-response-command);
 *   4. author loop #2 accepted -> reviewer desk + AcceptedCandidateAuthority;
 *   5. reviewer loop -> final gate accepted;
 *   6. NodeRun provider chain: recordHumanDecision (lawful through the
 *      pending human-input wake), then recordProviderOutcome(unknown) ->
 *      TypedWait:effect-uncertainty (D12: the non-idempotent send's outcome
 *      is unknown; ONLY the operator resolution command may dispose of it);
 *   7. settleEffect(success) exactly once -> final acceptance -> close ->
 *      workplace terminal proof.
 */

import {
  attemptLoopSteps,
  verticalPrefixSteps,
} from '../../../dist/workflow-kernel/testing/actors.js';

export const REFERENCE_IDS = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
};

/** The scripted operator actor step (deterministic, never a live user). */
const operatorStep = (stepId, command) => ({
  stepId,
  semanticProfile: 'certifier',
  behavior: 'compliant',
  command,
  instance: REFERENCE_IDS.workplace,
  tools: [],
});

/** The full reference program (pure data). */
export function humanWaitProgram() {
  const IDS = REFERENCE_IDS;
  return [
    ...verticalPrefixSteps(IDS, 'implementer'),
    // Author loop #1: the gate sends the cell into a human wait.
    ...attemptLoopSteps({ loopId: 'author-1', role: 'author', profile: 'implementer', workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'human-wait' }),
    { ...operatorStep('enter-human-wait', 'workplace.enterHumanWait') },
    { ...operatorStep('resolve-human-1', 'workplace.resolveHumanResponse') },
    // Author loop #2: accepted -> the reviewer desk opens.
    ...attemptLoopSteps({ loopId: 'author-2', role: 'author', profile: 'implementer', workplace: IDS.workplace, attempt: 'activity-attempt:2', gate: 'author', gateVerdict: 'accepted' }),
    // Reviewer loop: final gate accepted.
    ...attemptLoopSteps({ loopId: 'reviewer-1', role: 'reviewer', profile: 'reviewer', workplace: IDS.workplace, attempt: 'activity-attempt:3', gate: 'final', gateVerdict: 'accepted' }),
    // NodeRun provider chain: the uncertain non-idempotent send (D12).
    { stepId: 'node-materialize', semanticProfile: 'certifier', behavior: 'compliant', command: 'nodeRun.materializeCell', instance: IDS.node, tools: [] },
    { stepId: 'node-kernel-result', semanticProfile: 'certifier', behavior: 'compliant', command: 'nodeRun.recordKernelResult', instance: IDS.node, tools: [] },
    { stepId: 'node-human-decision', semanticProfile: 'certifier', behavior: 'compliant', command: 'nodeRun.recordHumanDecision', instance: IDS.node, tools: [] },
    { stepId: 'node-provider-unknown', semanticProfile: 'certifier', behavior: 'compliant', command: 'nodeRun.recordProviderOutcome', instance: IDS.node, effectOutcome: 'unknown', tools: [] },
    // The effect settles exactly once (success); the D12 wait stays pending
    // for the operator disposition - its ONLY wake is the operator command.
    { stepId: 'settle-success', semanticProfile: 'implementer', behavior: 'compliant', command: 'workplace.settleEffect', instance: IDS.workplace, effectOutcome: 'success', tools: [] },
    { stepId: 'final-acceptance', semanticProfile: 'certifier', behavior: 'compliant', command: 'workplace.recordFinalAcceptance', instance: IDS.workplace, tools: [] },
    { stepId: 'close-presentation', semanticProfile: 'certifier', behavior: 'compliant', command: 'workplace.closePresentation', instance: IDS.workplace, tools: [] },
    { stepId: 'workplace-terminal', semanticProfile: 'certifier', behavior: 'compliant', command: 'workplace.issueWorkplaceTerminalProof', instance: IDS.workplace, terminalOutcome: 'success', tools: [] },
  ];
}
