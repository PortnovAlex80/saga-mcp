// tests/factory-temporal/lib/temporal-driver.mjs
//
// Temporal driver — the host the temporal probe drives through its `cycle()`
// callback. It runs the canonical production lifecycle (runEpisode) and, when
// the lifecycle pauses for kanban tasks to drain, distributes them through
// the SAME production dispatch loop (distributeQueuedTasks) with the SAME
// WorkerExecutorFactory and WorkAssignmentPort that composition-root built.
//
// This driver does NOT replace any production machinery. It is a thin
// orchestration loop identical to orchestrate-cli.ts but without the process
// boundary — it runs IN-PROCESS so the temporal probe can drive cycles on
// demand without spawning a child node.exe per cycle.
//
// The driver is created AFTER createFactoryApplication() — it reaches into
// the module-scoped handles (getLastFactory*) to reuse the single shared
// assignment/spawn authorities.

import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = process.cwd();

/**
 * Create a temporal driver that cycles the production lifecycle + dispatch
 * loop in-process. The driver is bound to ONE launchRef.
 *
 * The driver claims the launch capability (single-use) on construction and
 * releases the claim on terminate(). Each cycle() mirrors ONE iteration of
 * orchestrate-cli's main loop: runEpisode (resume on cycles 2+), and if the
 * lifecycle paused, distribute queued tasks through production dispatch.
 *
 * @param {object} opts
 * @param {string} opts.dbPath - SQLite database path
 * @param {string} opts.launchRef - factory launch capability
 * @param {number} opts.projectId
 * @param {number} opts.epicId
 * @param {object} opts.application - SagaApplication (from createFactoryApplication)
 * @param {number} [opts.concurrency=1]
 * @param {object} [opts.lifecycleInput] - the lifecycle input object (mode='new')
 * @param {string} [opts.lifecycleInputSchema]
 * @param {string} [opts.idempotencyKey] - LIFECYCLE run idempotency key
 * @param {string} [opts.initiatedBy='temporal-driver']
 * @param {'new'|'resume'} [opts.mode='new']
 * @returns {Promise<{ cycle: () => Promise<{ reason: string, advanced: boolean, dispatched: number }>, terminate: () => Promise<void>, readState: () => object }>}
 */
export async function createTemporalDriver(opts) {
  const {
    dbPath,
    launchRef,
    projectId,
    epicId,
    application,
    concurrency = 1,
    lifecycleInput,
    lifecycleInputSchema,
    idempotencyKey,
    initiatedBy = 'temporal-driver',
    mode = 'new',
  } = opts;

  // Load the dispatch-loop, composition-root, runtime-config, db, and launch
  // repository modules ONCE. These are the same modules orchestrate-cli
  // imports lazily inside its loop; importing them here avoids repeated
  // dynamic-import overhead per cycle.
  const dispatchMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'app', 'dispatch-loop.js')).href);
  const compositionRootMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'app', 'composition-root.js')).href);
  const configMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'runtime', 'saga-runtime-config.js')).href);
  const dbMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const launchRepoMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);
  const conveyorAdaptersMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'conveyor', 'conveyor-adapters.js')).href);

  // Claim the launch capability exactly once. markFactoryLaunchRunning and
  // finishFactoryLaunch both require state IN ('claimed','running') and a
  // matching claim_token; without this claim their UPDATEs hit zero rows and
  // throw FACTORY_LAUNCH_FENCE_LOST. orchestrate-cli does the same via
  // claimFactoryLaunch(launchRef, claimToken).
  const claimToken = randomUUID();
  process.env.DB_PATH = dbPath;
  const ticket = launchRepoMod.claimFactoryLaunch(launchRef, claimToken);

  // The episode runtime repository is published by composition-root AFTER
  // createFactoryApplication() ran (the caller did that before constructing
  // the driver). Resolve it once; it backs readConcurrencyAdmission().
  const episodeRuntime = compositionRootMod.getLastFactoryEpisodeRuntimeRepository();
  if (!episodeRuntime) {
    throw new Error(
      'FACTORY_CONCURRENCY_POLICY_UNAVAILABLE: composition-root did not publish '
      + 'the durable episode runtime repository',
    );
  }

  let cycleCount = 0;
  let terminal = false;
  let lastReason = null;
  let lastError = null;

  /**
   * Drive one orchestrator cycle: runEpisode, and if the lifecycle paused,
   * distribute queued tasks through the production dispatch loop.
   *
   * @returns {Promise<{ reason: string, advanced: boolean, dispatched: number }>}
   */
  async function cycle() {
    if (terminal) return { reason: lastReason ?? 'terminal', advanced: false, dispatched: 0 };

    cycleCount++;
    const isFirst = cycleCount === 1;

    try {
      process.env.DB_PATH = dbPath;
      // Mirror orchestrate-cli's runEpisode call. On the first cycle for a
      // new launch, pass the lifecycle input + schema and resumePaused=false
      // (matching `!isFirstCycle || mode === 'resume'`). On subsequent
      // cycles the lifecycle is resumed with no input.
      const result = await application.runEpisode({
        projectId,
        epicId,
        concurrency,
        lifecycleInput: isFirst && mode === 'new' ? lifecycleInput : undefined,
        lifecycleInputSchema: isFirst && mode === 'new' && lifecycleInput !== undefined
          ? lifecycleInputSchema ?? undefined
          : undefined,
        idempotencyKey,
        resumePaused: !isFirst || mode === 'resume',
        initiatedBy,
      });
      lastReason = result.reason;

      if (isFirst && result.lifecycleRun?.id) {
        try {
          launchRepoMod.markFactoryLaunchRunning(launchRef, claimToken, result.lifecycleRun.id);
        } catch { /* already marked running (idempotent retry) */ }
      }

      // Terminal — lifecycle finished. The driver loops on 'paused' (driving
      // the dispatch loop itself), so only 'completed'/'failed' reach here.
      // finishFactoryLaunch accepts 'paused' too, but the driver never feeds
      // it: a paused launch in production is settled by orchestrate-cli with
      // exit code 2, while here we keep cycling.
      if (result.reason !== 'paused') {
        terminal = true;
        try {
          launchRepoMod.finishFactoryLaunch(
            launchRef,
            claimToken,
            result.reason === 'failed' ? 'failed' : 'completed',
            result.reason === 'failed' ? JSON.stringify(result) : null,
          );
        } catch { /* best-effort; the lifecycle already converged */ }
        return { reason: result.reason, advanced: true, dispatched: 0 };
      }

      // Paused — distribute queued tasks through production dispatch.
      const factoryWorkAssignment = compositionRootMod.getLastFactoryWorkAssignment();
      const factoryExecutor = compositionRootMod.getLastFactoryWorkerExecutorFactory();
      if (!factoryWorkAssignment || !factoryExecutor) {
        // No dispatch infrastructure — lifecycle is still running nodes.
        return { reason: 'paused', advanced: false, dispatched: 0 };
      }

      // Check if kernel should be yielded to (same logic as orchestrate-cli).
      // Re-evaluate each cycle (the original driver computed this once and
      // passed a stale closure; the CLI re-runs the query each iteration).
      const db = dbMod.getDb();
      const shouldYield = Boolean(db.prepare(
        `SELECT 1
           FROM factory_workplaces w
           JOIN factory_process_runs pr ON pr.id=w.process_run_id
          WHERE pr.epic_id=?
            AND pr.status IN ('running','paused')
            AND w.loop_state IN ('verifying','effect_pending')
          LIMIT 1`,
      ).get(epicId));

      if (shouldYield) {
        // Kernel owns progress right now — let it run on next cycle.
        return { reason: 'paused', advanced: false, dispatched: 0 };
      }

      const admission = episodeRuntime.readConcurrencyAdmission(epicId);
      const dispatchConfig = configMod.loadSagaRuntimeConfig(process.env);
      const sagaEntry = path.resolve(REPO_ROOT, 'dist', 'index.js');
      const workspaceRow = db.prepare(
        'SELECT pr.local_path FROM project_repositories pr WHERE pr.project_id=? AND pr.status=? ORDER BY pr.id LIMIT 1',
      ).get(projectId, 'active');
      const workspaceRoot = workspaceRow?.local_path ?? process.cwd();

      const dispatched = await dispatchMod.distributeQueuedTasks({
        projectId,
        epicId,
        readConcurrencyAdmission: () => episodeRuntime.readConcurrencyAdmission(epicId),
        shouldYieldToKernel: () => Boolean(db.prepare(
          `SELECT 1
             FROM factory_workplaces w
             JOIN factory_process_runs pr ON pr.id=w.process_run_id
            WHERE pr.epic_id=?
              AND pr.status IN ('running','paused')
              AND w.loop_state IN ('verifying','effect_pending')
            LIMIT 1`,
        ).get(epicId)),
        workAssignment: factoryWorkAssignment,
        idGenerator: conveyorAdaptersMod.uuidIdGenerator,
        machineId: os.hostname(),
        workerExecutorFactory: factoryExecutor,
        factoryContext: {
          projectId,
          epicId,
          workspaceRoot,
          dbPath,
          sagaEntry,
          sagaSkillRoot: REPO_ROOT,
          claudePath: process.env.SAGA_CLAUDE_PATH,
          logRoot: dispatchConfig.orchestrationLogRoot,
          heartbeatLog: dispatchConfig.orchestrationLogRoot
            ? path.join(dispatchConfig.orchestrationLogRoot, 'worker-heartbeat.log')
            : undefined,
          lmStudioUrl: dispatchConfig.lmStudioUrl,
        },
      });

      return { reason: 'paused', advanced: dispatched > 0, dispatched };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastReason = 'error';
      throw error;
    }
  }

  function readState() {
    return {
      cycleCount,
      terminal,
      lastReason,
      lastError,
      projectId,
      epicId,
      dbPath,
    };
  }

  async function terminate() {
    terminal = true;
    try { application.close(); } catch {}
  }

  return { cycle, terminate, readState };
}

/**
 * Spawn an orchestrate-cli child process that runs the full factory to
 * terminal state. This is the CHILD-PROCESS variant for scenarios that need
 * to test process-level crash/recovery (the in-process driver cannot crash
 * its own process without taking the test with it).
 *
 * Returns { child, exitCode (promise) }.
 */
export function spawnOrchestrateCli(opts) {
  const {
    dbPath,
    launchRef,
    repoPath,
    scenariosPath,
    invocationLogPath,
    compositionPath,
    timeoutMs = 300000,
    env: extraEnv = {},
  } = opts;

  const child = spawn('node', [
    path.join(REPO_ROOT, 'dist', 'orchestrate-cli.js'),
    `--launch-ref=${launchRef}`,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      SAGA_REPO_ROOT: REPO_ROOT,
      SAGA_BUTTON_REPO_PATH: repoPath,
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: compositionPath,
      SAGA_SCENARIOS: scenariosPath,
      SAGA_INVOCATION_LOG: invocationLogPath,
      SAGA_CONCURRENCY: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => stdout += c);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => stderr += c);

  const exitPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`TIMEOUT after ${timeoutMs}ms\n${stderr.slice(-3000)}`));
    }, timeoutMs);
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { child, exitPromise };
}
