#!/usr/bin/env node
// tests/factory-e2e/w9-05-disobedience-drive.mjs
//
// Standalone single-drive runner for W9-05 (stage-6 G2). Runs ONE worker-
// disobedience scenario in an isolated process and prints a JSON evidence
// bundle on stdout. The companion test (w9-05-disobedience.test.mjs) invokes
// this script per scenario.
//
// Scenario selection: W9_SCENARIO env var = 'silent-worker' |
// 'exit-without-done' | 'fake-done-file' — or W9_PERTURBATION_SEED=<n>
// selecting an in-lane tape from the frozen table (perturbation-tapes.mjs);
// a conflicting explicit W9_SCENARIO is a typed error, and the evidence
// always records the resolved tape name.
//
// What every scenario proves: the factory's liveness and completion
// guarantees are MECHANICAL. A worker that never signals liveness, or that
// exits without the worker_done tool, or that forges worker-done-call.json,
// is classified lost, its card is repaired/requeued, and no downstream work
// is created from the fake completion.

import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const { resolveDriveTapeSelection } = await import('./perturbation-tapes.mjs');
const tapeSelection = resolveDriveTapeSelection({ env: process.env, driveFile: 'w9-05-disobedience-drive.mjs' });
const SCENARIO = tapeSelection.scenario || '';
const label = process.env.W9_DRIVE_LABEL || SCENARIO;

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness } = harness;
const manifestMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);
const { HARNESS_CONCURRENCY_CEILING } = manifestMod;
const { createScriptedObserver } = await import('./scripted-inference.mjs');
const { buildHarnessComposition } = await import('./harness-composition.mjs');
const { W9_HAPPY_HANDLERS } = await import('./w9-happy-handlers.mjs');
const {
  buildExitWithoutDoneHandlers,
  buildFakeDoneFileHandlers,
  FAKE_DONE_FILE,
} = await import('./w9-05-disobedience-handlers.mjs');
const { defaultW9RunManifest, parseRunManifest } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);

const SCENARIO_MAP = {
  'silent-worker': {
    manifestId: 'w9-05-silent-worker',
    handlers: () => ({ ...W9_HAPPY_HANDLERS }),
    idea: `W9-05 silent worker (${label}): no liveness, expired lease — the reaper classifies mechanically`,
    maxCycles: 120,
    maxEmptyDispatchStreak: 10,
    pollMs: 5,
  },
  'exit-without-done': {
    manifestId: 'w9-05-exit-without-done',
    handlers: () => buildExitWithoutDoneHandlers(),
    idea: `W9-05 exit without worker_done (${label}): real work + exit 0 — lost, repaired, converged by second execution`,
    maxCycles: 150,
    maxEmptyDispatchStreak: 10,
    pollMs: 5,
  },
  'fake-done-file': {
    manifestId: 'w9-05-fake-done-file',
    handlers: () => buildFakeDoneFileHandlers(),
    idea: `W9-05 faked worker-done-call.json (${label}): a file is not a tool call — lost, repaired, converged`,
    maxCycles: 150,
    maxEmptyDispatchStreak: 10,
    pollMs: 5,
  },
};

const config = SCENARIO_MAP[SCENARIO];
if (!config) {
  throw new Error(`W9_SCENARIO must be one of: ${Object.keys(SCENARIO_MAP).join(', ')}`);
}

const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: 'de00aa7' }));
const scenario = manifest.scenarios.find(s => s.scenarioId === config.manifestId);
if (!scenario) throw new Error(`${config.manifestId} scenario not declared in manifest`);

const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: SCENARIO_CAP,
  idea: config.idea,
});

try {
  bootstrap.assertNoAuthorityWritesYet();

  const observer = createScriptedObserver();
  const composition = buildHarnessComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: config.handlers(),
  });

  const result = await driveFreshHarness({
    bootstrap,
    composition,
    scenarioConcurrencyCap: SCENARIO_CAP,
    maxCycles: config.maxCycles,
    pollMs: config.pollMs,
    maxEmptyDispatchStreak: config.maxEmptyDispatchStreak,
    scriptedObserver: observer,
  });

  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();

  // Common convergence evidence: the disobedience never blocks the cohort.
  const devRun = db.prepare(
    `SELECT id, module_name, status, local_outcome
       FROM factory_process_runs
      WHERE module_name LIKE '%development%' ORDER BY id DESC LIMIT 1`,
  ).get();

  // Scenario-specific evidence.
  let scenarioEvidence;
  if (SCENARIO === 'silent-worker') {
    scenarioEvidence = await collectSilentWorkerEvidence(db);
  } else if (SCENARIO === 'exit-without-done') {
    scenarioEvidence = collectExitWithoutDoneEvidence(db);
  } else {
    scenarioEvidence = collectFakeDoneFileEvidence(db);
  }

  const evidence = {
    label,
    scenario: SCENARIO,
    perturbationSeed: tapeSelection.seed,
    perturbationTape: tapeSelection.tapeName,
    perturbationTapeApplied: tapeSelection.applied,
    cycles: result.cycles,
    terminalReason: result.terminalReason,
    reachedTerminal: result.reachedTerminal,
    strandedActiveExecutions: result.strandedActiveExecutions,
    effectiveConcurrency: result.effectiveConcurrency,
    devOutcome: devRun?.local_outcome ?? null,
    devStatus: devRun?.status ?? null,
    ...scenarioEvidence,
  };

  // Assertions (throw → non-zero exit → test failure).
  const A = (await import('node:assert')).default;
  A.equal(result.strandedActiveExecutions, 0, `${label}: no stranded executions`);
  A.equal(devRun?.status, 'completed', `${label}: development status=completed (disobedience did not block convergence)`);
  A.equal(devRun?.local_outcome, 'verified', `${label}: development outcome=verified`);

  if (SCENARIO === 'silent-worker') {
    A.equal(evidence.reapedLost, true, `${label}: the reaper classified the silent execution lost`);
    A.ok(evidence.reapReason, `${label}: the reap carries the policy reason string`);
    A.equal(evidence.cardReleased, true, `${label}: the card was released (fence cleared)`);
    A.equal(evidence.headsUnchanged, true, `${label}: accepted-authority heads did NOT advance through the silent execution`);
  } else {
    A.ok(evidence.disobedientLostCount >= 1, `${label}: at least one lost execution from disobedience`);
    A.ok(evidence.disobedientExitCodeZero, `${label}: the disobedient execution exited code 0 yet was NOT completed`);
    A.equal(evidence.disobedientAcceptedReceipts, 0, `${label}: no accepted worker_done receipt for the disobedient execution`);
    A.equal(evidence.disobedientDownstreamProducts, 0, `${label}: no downstream product/candidate was created from the disobedient execution`);
    A.ok(evidence.taskCompletedByLaterExecution, `${label}: the same task was completed by a later, obedient execution`);
    if (SCENARIO === 'fake-done-file') {
      A.equal(evidence.fakeFileExists, true, `${label}: the forged worker-done-call.json exists on disk`);
      A.equal(evidence.disobedientAcceptedReceipts, 0, `${label}: and the factory ignored it — a file is not a tool call`);
    }
  }

  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  bootstrap.cleanup();
}

// ---------------------------------------------------------------------------
// Evidence collectors
// ---------------------------------------------------------------------------

function collectExitWithoutDoneEvidence(db) {
  const disobedient = db.prepare(
    `SELECT execution_id, task_id, state, exit_code, last_error
       FROM worker_executions
      WHERE last_error LIKE '%exited without worker_done%'`,
  ).all();
  const first = disobedient[0] ?? null;
  const disobedientIds = disobedient.map(r => r.execution_id);
  const placeholders = disobedientIds.length
    ? disobedientIds.map(() => '?').join(',') : "''";
  const acceptedReceipts = disobedientIds.length
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM command_receipts
          WHERE command_kind IN ('worker_done','presentation_close')
            AND accepted=1 AND execution_id IN (${placeholders})`,
      ).get(...disobedientIds).n
    : 0;
  const downstream = disobedientIds.length
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM factory_managed_node_submissions
          WHERE execution_id IN (${placeholders})`,
      ).get(...disobedientIds).n
    : 0;
  const taskCompletedByLaterExecution = first
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM command_receipts cr
           JOIN worker_executions we ON we.execution_id=cr.execution_id
          WHERE we.task_id=? AND cr.command_kind='worker_done' AND cr.accepted=1
            AND we.execution_id NOT IN (${placeholders})`,
        ).get(first.task_id, ...disobedientIds).n > 0
    : false;
  return {
    disobedientLostCount: disobedient.filter(r => r.state === 'lost').length,
    disobedientExitCodeZero: disobedient.length > 0
      && disobedient.every(r => r.exit_code === 0 || r.exit_code === null),
    disobedientAcceptedReceipts: acceptedReceipts,
    disobedientDownstreamProducts: downstream,
    taskCompletedByLaterExecution,
    disobedientSample: first ? { execution_id: first.execution_id, state: first.state } : null,
  };
}

function collectFakeDoneFileEvidence(db) {
  const base = collectExitWithoutDoneEvidence(db);
  return {
    ...base,
    fakeFileExists: existsSync(FAKE_DONE_FILE),
    fakeFileContent: existsSync(FAKE_DONE_FILE)
      ? readFileSync(FAKE_DONE_FILE, 'utf8').slice(0, 400)
      : null,
  };
}

async function collectSilentWorkerEvidence(db) {
  // Post-drive surgery on a REAL claimed execution row (worker_executions
  // and tasks are not authority tables): the worker "went silent" — its row
  // is left running with a dead pid, an expired lease, stale heartbeat and
  // progress, and no accepted completion receipt (a silent worker never
  // completed). The PRODUCTION reaper then classifies it.
  const epic = db.prepare('SELECT id, project_id FROM epics ORDER BY id LIMIT 1').get();
  const victim = db.prepare(
    `SELECT we.execution_id, we.task_id, we.machine_id
       FROM worker_executions we
       JOIN tasks t ON t.id = we.task_id
      WHERE t.workplace_ref LIKE '%product-discovery%'
      ORDER BY we.reserved_at LIMIT 1`,
  ).get();
  if (!epic || !victim) throw new Error('w9-05 silent-worker: no victim execution found');

  const headsBefore = db.prepare(
    `SELECT workplace_ref, accepted_author_task_id, accepted_author_candidate_set_ref
       FROM factory_accepted_authority_head ORDER BY workplace_ref`,
  ).all();

  const now = Date.now();
  const past15 = new Date(now - 15 * 60 * 1000).toISOString();
  const past25 = new Date(now - 25 * 60 * 1000).toISOString();
  db.transaction(() => {
    // The silent worker never completed: drop the receipt its obedient twin
    // earned, restore the active row + the claim fence.
    db.prepare('DELETE FROM command_receipts WHERE execution_id=?').run(victim.execution_id);
    db.prepare(
      `UPDATE worker_executions
          SET state='running', pid=NULL, exit_code=NULL, last_error=NULL,
              lease_expires_at=?, heartbeat_at=?, progress_at=?, stuck_state='active'
        WHERE execution_id=?`,
    ).run(past15, past15, past25, victim.execution_id);
    db.prepare(
      `UPDATE tasks SET status='in_progress', current_execution_id=? WHERE id=?`,
    ).run(victim.execution_id, victim.task_id);
  })();

  // The production reaper with a dead-process probe: pid is NULL, so
  // isAlive=false — exactly what supervision observes for a silent worker.
  const deadProbe = {
    isAlive: () => false,
    readBirthToken: () => null,
    killVerified: () => ({ killed: true }),
    readCommandLine: () => null,
  };
  const { reconcileWorkerExecutions } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/worker-executions.js')).href);
  const results = reconcileWorkerExecutions(
    db, epic.project_id, epic.id, now,
    { processProbe: deadProbe, hostname: victim.machine_id },
  );

  const row = db.prepare(
    `SELECT state, last_error FROM worker_executions WHERE execution_id=?`,
  ).get(victim.execution_id);
  const task = db.prepare(
    `SELECT status, current_execution_id FROM tasks WHERE id=?`,
  ).get(victim.task_id);
  const headsAfter = db.prepare(
    `SELECT workplace_ref, accepted_author_task_id, accepted_author_candidate_set_ref
       FROM factory_accepted_authority_head ORDER BY workplace_ref`,
  ).all();
  const reaped = results.find(r => r.executionId === victim.execution_id) ?? null;

  return {
    victimExecution: victim.execution_id,
    reapedLost: row?.state === 'lost' || row?.state === 'terminated',
    reapReason: row?.last_error ?? reaped?.reason ?? null,
    reapAction: reaped?.action ?? null,
    cardReleased: task ? task.current_execution_id !== victim.execution_id : false,
    taskStatusAfterReap: task?.status ?? null,
    headsUnchanged: JSON.stringify(headsBefore) === JSON.stringify(headsAfter),
  };
}
