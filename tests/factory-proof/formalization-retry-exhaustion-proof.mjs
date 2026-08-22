// tests/factory-proof/formalization-retry-exhaustion-proof.mjs
//
// Production-faithful proof of reviewed-cell onExhausted=requeue terminal
// behavior. Each selected Formalization Cell burns its real 5-attempt epoch,
// crosses the real one-minute backoff, then resumes the SAME launch. A repeated
// stable reviewer diagnosis must terminate the Cell as failed; no test clock,
// timestamp rewrite or authority-table mutation is used.

import {
  buildCanonicalProofComposition,
  createScriptedObserver,
  driveCanonicalProof,
} from './canonical-proof-composition.mjs';
import { buildScenarioEvidenceBundle } from './scenario-evidence.mjs';
import { classifyPostDrainProgress, observeDurableTrace } from './trace-observer.mjs';
import { FORMALIZATION_RESILIENCE_TARGETS } from './formalization-resilience-pack.mjs';

export const FORMALIZATION_RECOVERY_BACKOFF_WAIT_MS = 61_000;
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

function runPhase({ bootstrap, handlers, concurrencyCap, observer, maxCycles, stopOnStageOutcome, launchRef }) {
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers,
  });
  return driveCanonicalProof({
    bootstrap,
    composition,
    launchRef: launchRef ?? bootstrap.launchRef,
    scenarioConcurrencyCap: concurrencyCap,
    maxCycles,
    pollMs: 5,
    maxEmptyDispatchStreak: 12,
    ...(stopOnStageOutcome ? { stopOnStageOutcome } : {}),
    scriptedObserver: observer,
  });
}

/**
 * Phase-B resume seam (production pattern from engine-administration):
 * every finished drive settles its launch ('paused' is terminal for the
 * LaunchRequest), so a second drive on the SAME launchRef is not claimable.
 * A lawful resume creates a FRESH launch under the same order with
 * mode='resume' bound to the phase-A lifecycle run; the harness then
 * continues the paused run without re-submitting the lifecycle input.
 */
async function requestResumeLaunch(bootstrap, lifecycleRunId) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const { requestFactoryLaunch } = await import(
    '../../dist/infrastructure/factory/sqlite-factory-launch-repository.js'
  );
  const db = new Database(bootstrap.dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const launch = db.prepare(
      'SELECT order_ref AS orderRef, initiated_by AS initiatedBy, concurrency FROM factory_launch_requests WHERE launch_ref=?',
    ).get(bootstrap.launchRef);
    if (!launch) throw new Error(`PROOF_RESUME_LAUNCH_SOURCE_MISSING: ${bootstrap.launchRef}`);
    return requestFactoryLaunch({
      orderRef: launch.orderRef,
      mode: 'resume',
      projectId: bootstrap.projectId,
      epicId: bootstrap.epicId,
      lifecycleRunId,
      initiatedBy: launch.initiatedBy,
      concurrency: launch.concurrency,
      idempotencyKey: `${bootstrap.launchRef}:proof-resume-b`,
    }, db);
  } finally {
    db.close();
  }
}

export async function runFormalizationRetryExhaustionProof({
  scenario,
  bootstrap,
  handlers,
  concurrencyCap,
  targetName,
}) {
  const target = FORMALIZATION_RESILIENCE_TARGETS[targetName];
  if (!target) throw new Error(`FORMALIZATION_RETRY_TARGET_UNKNOWN: ${targetName}`);

  const observerA = createScriptedObserver();
  const phaseA = await runPhase({
    bootstrap,
    handlers,
    concurrencyCap,
    observer: observerA,
    maxCycles: 180,
  });
  const traceA = observeDurableTrace(bootstrap.dbPath);
  const factsA = targetFacts(traceA, target.cell);
  const epochRecorded = factsA.epochs.some(row => Number(row.epoch) >= 1);
  const repairObserved = factsA.gates.some(row =>
    row.gate_phase === 'final' && row.verdict === 'repair_required');
  const backoffState = factsA.workplaces.some(row => row.loop_state === 'repair_wait');

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
        kind: 'formalization-retry-exhaustion-phase-a',
        targetName,
        invocations: observerA.getInvocationCount(),
        replays: observerA.getReplayCount(),
      }],
      faultJournal: [{ class: 'retry-exhaustion', targetName, phase: 'local-budget' }],
      externalWorldJournal: [],
      oracleResults: [{
        id: `${targetName}.retry-exhaustion.local-budget`,
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

  await sleep(FORMALIZATION_RECOVERY_BACKOFF_WAIT_MS);

  const resumeLaunchRef = await requestResumeLaunch(
    bootstrap,
    phaseA.result.lifecycleRunId ?? null,
  );
  const observerB = createScriptedObserver();
  const phaseB = await runPhase({
    bootstrap,
    handlers,
    concurrencyCap,
    observer: observerB,
    maxCycles: 180,
    stopOnStageOutcome: 'failed',
    launchRef: resumeLaunchRef,
  });
  const trace = observeDurableTrace(bootstrap.dbPath);
  const progress = classifyPostDrainProgress(trace);
  const facts = targetFacts(trace, target.cell);
  const failedStage = (trace.stageRuns ?? []).some(row =>
    row.stage_id === 'solution-formalization' && row.local_outcome === 'failed');
  const terminalWorkplace = facts.workplaces.some(row =>
    row.loop_state === 'terminal' && String(row.terminal_reason ?? '').includes('failed'));
  const noFinalAcceptance = !facts.gates.some(row =>
    row.gate_phase === 'final' && row.verdict === 'accepted');
  const noStranded = phaseB.result.strandedActiveExecutions === 0;

  const oracleResults = [
    {
      id: `${targetName}.retry-exhaustion.epoch-recorded`,
      passed: epochRecorded,
      evidenceRefs: factsA.epochs.map(row => `recovery-epoch:${row.workplace_ref}:${row.epoch}`),
      details: { epochs: factsA.epochs.map(row => row.epoch) },
    },
    {
      id: `${targetName}.retry-exhaustion.terminal-failed`,
      passed: failedStage && terminalWorkplace,
      evidenceRefs: [],
      details: { failedStage, terminalWorkplace },
    },
    {
      id: `${targetName}.retry-exhaustion.never-final-accepted`,
      passed: noFinalAcceptance,
      evidenceRefs: [],
      details: { finalAccepted: facts.gates.filter(row =>
        row.gate_phase === 'final' && row.verdict === 'accepted').length },
    },
    {
      id: `${targetName}.retry-exhaustion.no-stranded-execution`,
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
        kind: 'formalization-retry-exhaustion-phase-a',
        targetName,
        invocations: observerA.getInvocationCount(),
        replays: observerA.getReplayCount(),
      },
      {
        kind: 'formalization-retry-exhaustion-phase-b',
        targetName,
        invocations: observerB.getInvocationCount(),
        replays: observerB.getReplayCount(),
      },
    ],
    faultJournal: [{
      class: 'retry-exhaustion',
      targetName,
      boundary: target.cell,
      crossedRealBackoffMs: FORMALIZATION_RECOVERY_BACKOFF_WAIT_MS,
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
      scriptedInvocationCount: observerA.getInvocationCount() + observerB.getInvocationCount(),
    },
  });
}
