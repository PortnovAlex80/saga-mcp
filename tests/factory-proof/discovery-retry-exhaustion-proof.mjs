// tests/factory-proof/discovery-retry-exhaustion-proof.mjs
//
// Slow-but-production-faithful proof of onExhausted=requeue terminal behavior.
// No test clock and no authority/timestamp mutation: phase A burns the local
// 2-attempt budget and records recovery epoch 1; the proof crosses the real
// one-minute domain backoff; phase B resumes the same launch and the repeated
// diagnosis terminates the Production Cell honestly as failed.

import {
  buildCanonicalProofComposition,
  createScriptedObserver,
  driveCanonicalProof,
} from './canonical-proof-composition.mjs';
import { buildScenarioEvidenceBundle } from './scenario-evidence.mjs';
import { classifyPostDrainProgress, observeDurableTrace } from './trace-observer.mjs';

// production-cell-definition.ts defines epoch 1 as a one-minute backoff. The
// extra margin is scheduling tolerance only; it is not an oracle threshold.
export const DISCOVERY_RECOVERY_BACKOFF_WAIT_MS = 61_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function targetFacts(trace, workplaceFragment) {
  const workplaces = (trace.workplaces ?? []).filter(row =>
    String(row.workplace_ref).includes(workplaceFragment));
  const epochs = (trace.recoveryEpochs ?? []).filter(row =>
    String(row.workplace_ref).includes(workplaceFragment));
  const gates = (trace.gateDecisions ?? []).filter(row =>
    String(row.workplace_ref).includes(workplaceFragment));
  return { workplaces, epochs, gates };
}

function runPhase({ bootstrap, handlers, concurrencyCap, observer, maxCycles, stopOnStageOutcome }) {
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers,
  });
  return driveCanonicalProof({
    bootstrap,
    composition,
    launchRef: bootstrap.launchRef,
    scenarioConcurrencyCap: concurrencyCap,
    maxCycles,
    pollMs: 5,
    maxEmptyDispatchStreak: 12,
    ...(stopOnStageOutcome ? { stopOnStageOutcome } : {}),
    scriptedObserver: observer,
  });
}

export async function runDiscoveryRetryExhaustionProof({
  scenario,
  bootstrap,
  handlers,
  concurrencyCap,
  target,
}) {
  const observerA = createScriptedObserver();
  const phaseA = await runPhase({
    bootstrap,
    handlers,
    concurrencyCap,
    observer: observerA,
    maxCycles: 80,
  });
  const traceA = observeDurableTrace(bootstrap.dbPath);
  const factsA = targetFacts(traceA, target.workplaceFragment);
  const epochRecorded = factsA.epochs.some(row => Number(row.epoch) >= 1);
  const repairObserved = factsA.gates.some(row => row.verdict === 'repair_required');
  const backoffState = factsA.workplaces.some(row => row.loop_state === 'repair_wait');

  // Fail early if the local budget did not reach the expected durable epoch;
  // sleeping cannot repair a malformed setup and would only hide the cause.
  if (!epochRecorded || !repairObserved || !backoffState) {
    const progressA = classifyPostDrainProgress(traceA);
    return buildScenarioEvidenceBundle({
      scenario,
      proofModes: ['Durable', 'CanonicalFast'],
      fingerprint: phaseA.fingerprint,
      identity: phaseA.identity,
      durableTrace: traceA,
      progress: progressA,
      actorEvidence: [{
        kind: 'retry-exhaustion-phase-a',
        invocations: observerA.getInvocationCount(),
        replays: observerA.getReplayCount(),
      }],
      faultJournal: [{ class: 'retry-exhaustion', phase: 'local-budget' }],
      externalWorldJournal: [],
      oracleResults: [{
        id: `${target.name}.retry-exhaustion.local-budget`,
        passed: false,
        evidenceRefs: [],
        details: { epochRecorded, repairObserved, backoffState },
      }],
      terminal: {
        reachedTerminal: phaseA.result.reachedTerminal,
        terminalReason: phaseA.result.terminalReason,
        cycles: phaseA.result.cycles,
        stoppedByCycleBound: phaseA.result.stoppedByCycleBound,
        strandedActiveExecutions: phaseA.result.strandedActiveExecutions,
        effectiveConcurrency: phaseA.result.effectiveConcurrency,
        scriptedInvocationCount: observerA.getInvocationCount(),
      },
    });
  }

  await sleep(DISCOVERY_RECOVERY_BACKOFF_WAIT_MS);

  const observerB = createScriptedObserver();
  const phaseB = await runPhase({
    bootstrap,
    handlers,
    concurrencyCap,
    observer: observerB,
    maxCycles: 120,
    stopOnStageOutcome: 'failed',
  });
  const trace = observeDurableTrace(bootstrap.dbPath);
  const progress = classifyPostDrainProgress(trace);
  const facts = targetFacts(trace, target.workplaceFragment);
  const failedStage = (trace.stageRuns ?? []).some(row =>
    row.stage_id === 'initial-discovery' && row.local_outcome === 'failed');
  const terminalWorkplace = facts.workplaces.some(row =>
    row.loop_state === 'terminal' && String(row.terminal_reason ?? '').includes('failed'));
  const noAcceptedGate = !facts.gates.some(row => row.verdict === 'accepted');
  const noStranded = phaseB.result.strandedActiveExecutions === 0;

  const oracleResults = [
    {
      id: `${target.name}.retry-exhaustion.epoch-recorded`,
      passed: epochRecorded,
      evidenceRefs: factsA.epochs.map(row => `recovery-epoch:${row.workplace_ref}:${row.epoch}`),
      details: { epochs: factsA.epochs.map(row => row.epoch) },
    },
    {
      id: `${target.name}.retry-exhaustion.terminal-failed`,
      passed: failedStage && terminalWorkplace,
      evidenceRefs: [],
      details: { failedStage, terminalWorkplace },
    },
    {
      id: `${target.name}.retry-exhaustion.never-accepted`,
      passed: noAcceptedGate,
      evidenceRefs: [],
      details: { accepted: facts.gates.filter(row => row.verdict === 'accepted').length },
    },
    {
      id: `${target.name}.retry-exhaustion.no-stranded-execution`,
      passed: noStranded,
      evidenceRefs: [],
      details: { stranded: phaseB.result.strandedActiveExecutions },
    },
  ];

  return buildScenarioEvidenceBundle({
    scenario,
    proofModes: ['Durable', 'CanonicalFast'],
    fingerprint: phaseB.fingerprint,
    identity: phaseB.identity,
    durableTrace: trace,
    progress,
    actorEvidence: [
      {
        kind: 'retry-exhaustion-phase-a',
        invocations: observerA.getInvocationCount(),
        replays: observerA.getReplayCount(),
      },
      {
        kind: 'retry-exhaustion-phase-b',
        invocations: observerB.getInvocationCount(),
        replays: observerB.getReplayCount(),
      },
    ],
    faultJournal: [{
      class: 'retry-exhaustion',
      boundary: target.workplaceFragment,
      crossedRealBackoffMs: DISCOVERY_RECOVERY_BACKOFF_WAIT_MS,
    }],
    externalWorldJournal: [],
    oracleResults,
    terminal: {
      reachedTerminal: phaseB.result.reachedTerminal,
      terminalReason: phaseB.result.terminalReason,
      cycles: phaseA.result.cycles + phaseB.result.cycles,
      stoppedByCycleBound: phaseB.result.stoppedByCycleBound,
      strandedActiveExecutions: phaseB.result.strandedActiveExecutions,
      effectiveConcurrency: phaseB.result.effectiveConcurrency,
      scriptedInvocationCount:
        observerA.getInvocationCount() + observerB.getInvocationCount(),
    },
  });
}
