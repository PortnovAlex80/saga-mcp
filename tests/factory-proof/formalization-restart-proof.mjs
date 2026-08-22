// tests/factory-proof/formalization-restart-proof.mjs
//
// Multi-start Formalization proof. It deliberately stops at the Formalization
// stage boundary so replay/idempotency evidence does not depend on Development.
// Discovery remains upstream because the lifecycle owns the real handoff.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildCanonicalProofComposition,
  createScriptedObserver,
  driveCanonicalProof,
} from './canonical-proof-composition.mjs';
import { buildScenarioEvidenceBundle } from './scenario-evidence.mjs';
import { classifyPostDrainProgress, observeDurableTrace } from './trace-observer.mjs';

const REPO_ROOT = process.cwd();
const IDEA_A = 'Formalization restart proof semantic input A';
const IDEA_B = 'Formalization restart proof semantic input B — incompatible contract subject';

async function runStart({ bootstrap, launchRef, handlers, label, concurrencyCap }) {
  const observer = createScriptedObserver();
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers,
  });
  const driven = await driveCanonicalProof({
    bootstrap,
    composition,
    ...(launchRef ? { launchRef } : {}),
    scenarioConcurrencyCap: concurrencyCap,
    maxCycles: 220,
    pollMs: 5,
    maxEmptyDispatchStreak: 12,
    // Stage-boundary proof (harness contract): stop the DRIVE at the
    // formalization 'formalized' outcome. The lifecycle would continue into
    // solution-development, which this proof has no actors for — each run is
    // closed between starts via the PRODUCTION abandon API (in the caller),
    // freeing the lifecycle scope for the next launch. A "natural terminal"
    // is unreachable here: the drive would drain into a development dead-end
    // whose non-terminal scope fails launches B/C with
    // LIFECYCLE_SCOPE_ALREADY_ACTIVE.
    stopOnStageOutcome: 'formalized',
    scriptedObserver: observer,
  });
  return {
    label,
    observer,
    driven,
    summary: {
      terminalReason: driven.result.terminalReason,
      cycles: driven.result.cycles,
      invocations: observer.getInvocationCount(),
      replays: observer.getReplayCount(),
      stranded: driven.result.strandedActiveExecutions,
      stoppedByStageOutcome: driven.result.stoppedByStageOutcome,
    },
  };
}

export async function runFormalizationRestartProof({
  scenario,
  bootstrap,
  handlers,
  concurrencyCap,
}) {
  const harness = await import(
    pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
  );
  const { requestFreshHarnessLaunch } = harness;
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const { abandonLifecycleRun } = await import(
    pathToFileURL(path.resolve(REPO_ROOT, 'dist/app/factory-start.js')).href
  );
  // Production typed close (scripts/factory.mjs abandon path): frees the
  // lifecycle scope between starts; durable stage runs — the oracles'
  // evidence — are preserved.
  const closeActiveRun = label =>
    abandonLifecycleRun(getDb(), {
      projectId: bootstrap.projectId,
      actorId: 'formalization-restart-proof',
      reason: `stage-boundary close after ${label}`,
    });

  const runA = await runStart({
    bootstrap,
    launchRef: null,
    handlers,
    label: 'A-cold',
    concurrencyCap,
  });
  closeActiveRun('A-cold');
  const launchB = requestFreshHarnessLaunch(bootstrap, { idea: IDEA_A });
  const runB = await runStart({
    bootstrap,
    launchRef: launchB,
    handlers,
    label: 'B-same-semantic-input',
    concurrencyCap,
  });
  closeActiveRun('B-same-semantic-input');
  const launchC = requestFreshHarnessLaunch(bootstrap, { idea: IDEA_B });
  const runC = await runStart({
    bootstrap,
    launchRef: launchC,
    handlers,
    label: 'C-incompatible-input',
    concurrencyCap,
  });

  const durableTrace = observeDurableTrace(bootstrap.dbPath);
  // Boundary honesty: the LAST start stops at 'formalized', so the
  // handoff-created development cells are BOUNDARY-UNDRIVEN facts, not
  // stalls (earlier starts' cells are buried typed by the abandon close).
  const progress = classifyPostDrainProgress(durableTrace, {
    stoppedByStageOutcome: runC.driven.result.stoppedByStageOutcome === true,
    stageOutcome: 'formalized',
  });
  const stages = (durableTrace.stageRuns ?? [])
    .filter(row => row.stage_id === 'solution-formalization' && row.local_outcome === 'formalized');
  const lifecycleIds = [...new Set(stages.map(row => row.lifecycle_run_id))];

  const oracleResults = [
    {
      id: 'formalization.restart.three-distinct-starts',
      passed: lifecycleIds.length === 3,
      evidenceRefs: stages.map(row => `stage-run:${row.id}`),
      details: { lifecycleIds },
    },
    {
      id: 'formalization.restart.same-input-replays-without-inference',
      passed: runB.summary.invocations === 0 && runB.summary.replays > 0,
      evidenceRefs: [],
      details: runB.summary,
    },
    {
      id: 'formalization.restart.incompatible-input-runs-cold',
      passed: runC.summary.replays === 0 && runC.summary.invocations > 0,
      evidenceRefs: [],
      details: runC.summary,
    },
    {
      id: 'formalization.restart.no-stranded-executions',
      passed: [runA, runB, runC].every(run => run.summary.stranded === 0),
      evidenceRefs: [],
      details: { A: runA.summary.stranded, B: runB.summary.stranded, C: runC.summary.stranded },
    },
  ];

  return buildScenarioEvidenceBundle({
    scenario,
    proofModes: ['Durable', 'CanonicalFast'],
    fingerprint: runA.driven.fingerprint,
    identity: runA.driven.identity,
    durableTrace,
    progress,
    actorEvidence: [
      { kind: 'factory-start', ...runA.summary },
      { kind: 'factory-start', ...runB.summary },
      { kind: 'factory-start', ...runC.summary },
    ],
    faultJournal: [],
    externalWorldJournal: [],
    oracleResults,
    terminal: {
      reachedTerminal: false,
      terminalReason: 'formalization-stage-proof-boundary',
      cycles: runA.summary.cycles + runB.summary.cycles + runC.summary.cycles,
      stoppedByCycleBound: false,
      strandedActiveExecutions: runA.summary.stranded + runB.summary.stranded + runC.summary.stranded,
      effectiveConcurrency: concurrencyCap,
      scriptedInvocationCount: runA.summary.invocations + runB.summary.invocations + runC.summary.invocations,
    },
  });
}

export { IDEA_A as FORMALIZATION_RESTART_IDEA };
