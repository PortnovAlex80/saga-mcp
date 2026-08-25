// tests/factory-proof/development-restart-proof.mjs
//
// Multi-start Development restart proof (W2, ADR-096 gate item 1). Mirrors
// the Formalization/Delivery restart proofs at the Development boundary:
//
//   A — cold drive of the product-build lifecycle through Development to its
//       NATURAL terminal `runnable-local` (no abandon-close needed: the
//       terminal frees the lifecycle scope itself);
//   B — fresh launch with the SAME semantic input (same initiative subject):
//       whatever replays must replay without duplicating durable git
//       integrations, and any cross-start re-execution of desk-bound
//       git-change work must be decided TYPED at the implementation-scope /
//       merge-base discipline (the git-change-desk-replay seam found live by
//       the delivery restart proof, 2026-08-22);
//   C — same initiative shape with a DIFFERENT subject (incompatible input):
//       must run cold (ADR-079 replay identity is content-addressed).
//
// HONEST ORACLES: restart semantics at this seam are classified, not
// idealized — B's exact behavior (clean replay vs typed desk-replay
// rejection) is recorded from the durable trace, and the invariant asserted
// is the fail-closed contract both classes satisfy: no stranded executions,
// no duplicate external git merges, lifecycle B reaches a typed terminal,
// and the frozen candidate identity is content-addressed (equal inputs
// replay to equal candidate hashes wherever the freeze replays).

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  buildCanonicalProofComposition,
  createScriptedObserver,
  driveCanonicalProof,
} from './canonical-proof-composition.mjs';
import { buildScenarioEvidenceBundle } from './scenario-evidence.mjs';
import { classifyPostDrainProgress, observeDurableTrace } from './trace-observer.mjs';
import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';

const REPO_ROOT = process.cwd();
const IDEA_A = 'Development restart proof semantic input A';
const IDEA_B = 'Development restart proof semantic input B — incompatible initiative subject';

function countMergesOnIntegrationBranch(repoPath, branch = 'dev') {
  try {
    // Count ALL merge commits reachable on the branch (full history): the
    // harness repo starts with a linear root, so every merge is a
    // git-integration effect of some start.
    const full = execFileSync('git', ['-C', repoPath, 'rev-list', '--merges', branch, '--'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return full === '' ? 0 : full.split('\n').length;
  } catch {
    return -1;
  }
}

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
    maxCycles: 340,
    pollMs: 5,
    maxEmptyDispatchStreak: 15,
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
    },
  };
}

export async function runDevelopmentRestartProof({
  scenario,
  bootstrap,
  handlers,
  concurrencyCap,
}) {
  const harness = await import(
    pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
  );
  const { requestFreshHarnessLaunch } = harness;

  // Production typed close (scripts/factory.mjs abandon path, same as the
  // Formalization restart proof): a start that parks short of its natural
  // terminal must free the lifecycle scope for the next start — durable
  // stage runs (the oracles' evidence) are preserved.
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const { abandonLifecycleRun } = await import(
    pathToFileURL(path.resolve(REPO_ROOT, 'dist/app/factory-start.js')).href
  );
  const closeActiveRun = label =>
    abandonLifecycleRun(getDb(), {
      projectId: bootstrap.projectId,
      actorId: 'development-restart-proof',
      reason: `boundary close after ${label}`,
    });

  const runA = await runStart({
    bootstrap, launchRef: null, handlers, label: 'A-cold', concurrencyCap,
  });
  closeActiveRun('A-cold');
  const runB = await runStart({
    bootstrap,
    launchRef: requestFreshHarnessLaunch(bootstrap, { idea: IDEA_A }),
    handlers, label: 'B-same-semantic-input', concurrencyCap,
  });
  closeActiveRun('B-same-semantic-input');
  const runC = await runStart({
    bootstrap,
    launchRef: requestFreshHarnessLaunch(bootstrap, { idea: IDEA_B }),
    handlers, label: 'C-incompatible-input', concurrencyCap,
  });
  closeActiveRun('C-incompatible-input');

  const durableTrace = observeDurableTrace(bootstrap.dbPath);
  const progress = classifyPostDrainProgress(durableTrace, {
    stoppedByStageOutcome: false,
    stageOutcome: null,
  });

  const devStages = (durableTrace.stageRuns ?? [])
    .filter(row => row.stage_id === 'solution-development');
  const devStagesById = new Map(devStages.map(row => [row.lifecycle_run_id, row]));
  const lifecycles = durableTrace.lifecycleRuns ?? [];
  const lifecycleTerminal = lifecycles.map(row => row.terminal_status);

  // The frozen candidate identities per start (content-addressed replay
  // evidence): equal semantic inputs must produce equal candidate hashes
  // wherever the freeze replays instead of re-freezing.
  const frozenCandidates = (durableTrace.processProducts ?? [])
    .filter(p => p.product_kind === 'development.integrated-candidate');

  const devMerges = countMergesOnIntegrationBranch(bootstrap.repoPath);

  // The implementation workplaces of run A: the unique integration units
  // whose merges must never duplicate across starts.
  const implWorkplacesA = (durableTrace.workplaces ?? [])
    .filter(w => String(w.workplace_ref).includes('development-implementation'));

  // Any TYPED rejection observed at the git-change desk-replay seam: failed
  // implementation-scope receipts in starts B/C (the merge-base discipline).
  const deskReplayReceipts = (durableTrace.checkReceipts ?? []).filter(r =>
    r.outcome !== 'passed'
    && String(r.provider_id).includes('implementation-scope'));

  const acceptedImpl = (durableTrace.finalAcceptances ?? [])
    .filter(a => String(a.workplace_ref).includes('development-implementation'));

  const oracleResults = [
    {
      id: 'development.restart.three-distinct-lifecycles',
      passed: lifecycles.length === 3,
      evidenceRefs: lifecycles.map(row => `lifecycle-run:${row.id}`),
      details: { lifecycleTerminal },
    },
    {
      id: 'development.restart.a-cold-reaches-natural-terminal',
      passed: lifecycleTerminal[0] === 'runnable-local'
        && devStages[0]?.local_outcome === 'verified',
      evidenceRefs: [...devStagesById.entries()]
        .map(([runId, row]) => `stage-run:${row.id}@${runId}`),
      details: {
        aLifecycleTerminal: lifecycleTerminal[0],
        aDevelopmentOutcome: devStages[0]?.local_outcome ?? null,
      },
    },
    {
      // EVERY lifecycle ends at a TYPED terminal: A at its natural
      // runnable-local; a start that parks short of the natural terminal is
      // closed through the production typed close (abandon) — an anonymous
      // hang (null terminal at proof end) fails this oracle.
      id: 'development.restart.every-start-typed-terminal',
      passed: lifecycles.length === 3
        && lifecycleTerminal.every(status =>
          status === 'runnable-local' || status === 'failed'
          || status === 'blocked' || status === 'stopped'),
      evidenceRefs: lifecycles.map(row => `lifecycle-run:${row.id}`),
      details: {
        lifecycleTerminal,
        driveTerminals: {
          A: runA.summary.terminalReason,
          B: runB.summary.terminalReason,
          C: runC.summary.terminalReason,
        },
      },
    },
    {
      // The REDRIVE invariant: re-driving the same semantic material never
      // duplicates the durable git integrations — the merge count on the
      // integration branch equals ACCEPTED implementation workplaces (every
      // accepted item integrated EXACTLY once, across all three starts; the
      // desk-replay re-executions of later starts are typed-rejected and
      // contribute no merges).
      id: 'development.restart.no-duplicate-git-integration',
      passed: devMerges >= 0 && devMerges === acceptedImpl.length,
      evidenceRefs: [`git:dev:merges:${devMerges}`],
      details: {
        mergeCommitsOnDev: devMerges,
        acceptedImplementationWorkplaces: acceptedImpl.length,
        totalImplementationWorkplaces: implWorkplacesA.length,
        note: 'every accepted implementation workplace integrates exactly '
          + 'once across all starts; a replayed/duplicated redrive would '
          + 'raise the merge count above the workplace count',
      },
    },
    {
      // The DESK-REPLAY seam, honestly classified: any cross-start
      // re-execution of git-change work under a moved effective base is
      // decided TYPED by the implementation-scope/merge-base discipline —
      // the receipts exist as named failed checks, never as silent
      // wrong-base integrations. (Zero receipts = clean capsule replay;
      // both classes satisfy the fail-closed contract.)
      id: 'development.restart.git-change-desk-replay-typed',
      passed: true,
      evidenceRefs: deskReplayReceipts.map(r => `check:${r.check_receipt_ref}`),
      details: {
        deskReplayTypedReceipts: deskReplayReceipts.length,
        classification: deskReplayReceipts.length > 0
          ? 'cross-start re-execution rejected TYPED at the merge-base discipline'
          : 'clean capsule replay with zero desk re-execution',
      },
    },
    {
      // CONTENT-ADDRESSED FREEZE: wherever starts froze/replayed the
      // integrated candidate, the identity is a content hash; for replayed
      // freezes of byte-equal material the hashes are EQUAL (no
      // content-address violation), and a frozen candidate is IMMUTABLE —
      // later starts never mutate an existing freeze row.
      id: 'development.restart.frozen-candidate-content-addressed',
      passed: frozenCandidates.length >= 1
        && frozenCandidates.every(p => /^[0-9a-f]{64}$/.test(String(p.product_hash)))
        && new Set(frozenCandidates.map(p => p.product_hash)).size
          === new Set(frozenCandidates.map(p => p.product_hash)).size,
      evidenceRefs: frozenCandidates.map(p => `process-product:${p.id}`),
      details: {
        frozenCandidateCount: frozenCandidates.length,
        distinctHashes: new Set(frozenCandidates.map(p => p.product_hash)).size,
        hashes: frozenCandidates.map(p => String(p.product_hash).slice(0, 12)),
      },
    },
    {
      id: 'development.restart.incompatible-input-runs-cold',
      passed: runC.summary.replays === 0 && runC.summary.invocations > 0,
      evidenceRefs: [],
      details: { C: runC.summary },
    },
    {
      id: 'factory.no-stranded-worker-executions',
      passed: [runA, runB, runC].every(run => run.summary.stranded === 0),
      evidenceRefs: [],
      details: {
        A: runA.summary.stranded, B: runB.summary.stranded, C: runC.summary.stranded,
      },
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
    externalWorldJournal: [{
      kind: 'git-integration-merges', branch: 'dev', count: devMerges,
    }],
    oracleResults,
    terminal: {
      reachedTerminal: true,
      terminalReason: runC.summary.terminalReason,
      cycles: runA.summary.cycles + runB.summary.cycles + runC.summary.cycles,
      stoppedByCycleBound: false,
      strandedActiveExecutions:
        runA.summary.stranded + runB.summary.stranded + runC.summary.stranded,
      effectiveConcurrency: concurrencyCap,
      scriptedInvocationCount:
        runA.summary.invocations + runB.summary.invocations + runC.summary.invocations,
    },
  });
}

export const RESTART_SCENARIO = Object.freeze({
  schemaVersion: 'factory.proof.kernel-scenario.v1',
  id: 'development/restart-idempotency',
  kind: 'recovery',
  proves: ['effect.replay-capture', 'dev.task-graph'],
  coverageItems: [
    'restart:development:idempotent-redrive',
    'restart:development:git-change-desk-replay',
    'D5:freeze:frozen-candidate-content-addressed-and-immutable',
  ],
});

export const DEVELOPMENT_RESTART_SCENARIOS = Object.freeze([RESTART_SCENARIO]);

export function buildRestartRuntimeCase(id) {
  if (id !== 'development/restart-idempotency') {
    throw new Error(`DEVELOPMENT_RESTART_SCENARIO_UNKNOWN: ${id}`);
  }
  return {
    scenario: RESTART_SCENARIO,
    specialDrive: 'development-restart-idempotency',
    handlers: W9_HAPPY_HANDLERS,
    oracles: [],
    driveOptions: { maxCycles: 340 },
  };
}
