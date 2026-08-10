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
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd();

/**
 * Create a temporal driver that cycles the production lifecycle + dispatch
 * loop in-process. The driver is bound to ONE launchRef.
 *
 * @param {object} opts
 * @param {string} opts.dbPath - SQLite database path
 * @param {string} opts.launchRef - factory launch capability
 * @param {number} opts.projectId
 * @param {number} opts.epicId
 * @param {object} opts.application - SagaApplication (from createFactoryApplication)
 * @param {number} [opts.concurrency=1]
 * @param {object} opts.lifecycleInput - the lifecycle input object
 * @param {string} [opts.lifecycleInputSchema]
 * @param {string} [opts.idempotencyKey]
 * @param {string} [opts.initiatedBy='temporal-driver']
 * @param {boolean} [opts.resumePaused=true] - whether cycles 2+ resume
 * @returns {Promise<{ cycle: () => Promise<{ reason: string, advanced: boolean }>, terminate: () => Promise<void>, readState: () => object }>}
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
    resumePaused = true,
  } = opts;

  let cycleCount = 0;
  let terminal = false;
  let lastReason = null;
  let lastError = null;

  // Load the dispatch-loop and runtime-config modules once.
  const dispatchMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'app', 'dispatch-loop.js')).href);
  const compositionRootMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'app', 'composition-root.js')).href);
  const configMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'runtime', 'saga-runtime-config.js')).href);
  const dbMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'db.js')).href);
  const launchRepoMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'factory', 'sqlite-factory-launch-repository.js')).href);

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
      const result = await application.runEpisode({
        projectId,
        epicId,
        concurrency,
        lifecycleInput: isFirst ? lifecycleInput : undefined,
        lifecycleInputSchema: isFirst && lifecycleInput !== undefined
          ? lifecycleInputSchema ?? undefined
          : undefined,
        idempotencyKey,
        resumePaused: !isFirst || resumePaused,
        initiatedBy,
      });
      lastReason = result.reason;

      if (isFirst && result.lifecycleRun?.id) {
        try {
          launchRepoMod.markFactoryLaunchRunning(launchRef, 'temporal-driver-claim', result.lifecycleRun.id);
        } catch { /* already marked */ }
      }

      // Terminal — lifecycle finished.
      if (result.reason !== 'paused') {
        terminal = true;
        try {
          launchRepoMod.finishFactoryLaunch(launchRef, 'temporal-driver-claim',
            result.reason === 'failed' ? 'failed' : 'completed',
            result.reason === 'failed' ? JSON.stringify(result) : null,
            result.reason === 'paused' ? 'paused'
              : result.reason === 'failed' ? 'start_failed' : 'completed');
        } catch { /* best-effort */ }
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

      const episodeRuntime = compositionRootMod.getLastFactoryEpisodeRuntimeRepository();
      const admission = episodeRuntime.readConcurrencyAdmission(epicId);

      const dispatched = await dispatchMod.distributeQueuedTasks({
        projectId,
        epicId,
        readConcurrencyAdmission: () => admission,
        shouldYieldToKernel: () => shouldYield,
        workAssignment: factoryWorkAssignment,
        idGenerator: (await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist', 'infrastructure', 'conveyor', 'conveyor-adapters.js')).href)).uuidIdGenerator,
        machineId: os.hostname(),
        workerExecutorFactory: factoryExecutor,
        factoryContext: {
          projectId,
          epicId,
          workspaceRoot: process.cwd(),
          dbPath,
          sagaEntry: path.resolve(REPO_ROOT, 'dist', 'index.js'),
          sagaSkillRoot: REPO_ROOT,
          claudePath: undefined,
          lmStudioUrl: 'http://localhost:1234/v1',
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
// to test process-level crash/recovery (the in-process driver cannot crash
// its own process without taking the test with it).
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
