#!/usr/bin/env node
/**
 * Saga orchestration CLI host.
 *
 * Internal usage:
 *   node dist/orchestrate-cli.js --launch-ref=<opaque capability>
 *
 * The CLI now depends on the engine-neutral SagaApplication boundary. After the
 * saga4 cutover the composition root always returns the Product Lifecycle
 * runtime.
 *
 * Env:
 *   DB_PATH             — saga SQLite database (required; same as saga server)
 *   SAGA_CLAUDE_PATH    — path to the claude CLI binary (default: 'claude')
 *   SAGA_ORCHESTRATION_LOG — existing runtime log setting
 *   SAGA_PRODUCT_LIFECYCLE_COMPOSITION — ESM module supplying Delivery providers
 *                         (required; the lifecycle runtime is the only engine)
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createFactoryApplication,
  getLastFactoryEpisodeRuntimeRepository,
  type ProductLifecycleCompositionOverrides,
  type FactoryCompositionOverrides,
} from './app/composition-root.js';
import type { SagaApplication } from './application/saga-application.js';
import { getDb } from './db.js';
import { uuidIdGenerator } from './infrastructure/conveyor/conveyor-adapters.js';
import {
  installProductionModules,
} from './process-modules/installation/production-install.js';
import { discoveryPackageManifest } from './process-modules/modules/discovery/package/manifest.js';
import { formalizationPackageManifest } from './process-modules/modules/formalization/package/manifest.js';
import { developmentPackageManifest } from './process-modules/modules/development/package/manifest.js';
import { developmentContinuationPackageManifest } from './process-modules/modules/development/package/continuation-manifest.js';
import { developmentVerificationContinuationPackageManifest } from './process-modules/modules/development/package/verification-continuation-manifest.js';
import { deliveryPackageManifest } from './process-modules/modules/delivery/package/manifest.js';
import {
  claimFactoryLaunch,
  finishFactoryLaunch,
  markFactoryLaunchRunning,
} from './infrastructure/factory/sqlite-factory-launch-repository.js';

function parseArgs(argv: string[]): { launchRef: string } {
  let launchRef: string | null = null;
  for (const arg of argv.slice(2)) {
    const capability = /^--launch-ref=([^\s]+)$/.exec(arg);
    if (capability && launchRef === null) {
      launchRef = capability[1]!;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Internal factory runtime host.\n'
        + 'Usage: orchestrate-cli.js --launch-ref=<opaque capability>\n',
      );
      process.exit(0);
    }
    throw new Error(`unsupported runtime-host argument '${arg}'`);
  }
  if (launchRef === null) throw new Error('FACTORY_LAUNCH_CAPABILITY_REQUIRED');
  return { launchRef };
}


function writeLifecycleStartReceipt(run: {
  id: number;
  status: string;
  createdAt: string;
}): void {
  const configured = process.env.SAGA_LIFECYCLE_START_RECEIPT?.trim();
  if (!configured) return;
  const receiptPath = path.resolve(configured);
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      lifecycleRunId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      acknowledgedAt: new Date().toISOString(),
    }),
    { encoding: 'utf8', flag: 'wx' },
  );
  renameSync(temporaryPath, receiptPath);
}

async function main() {
  const { launchRef } = parseArgs(process.argv);
  if (!process.env.DB_PATH) {
    process.stderr.write(
      'DB_PATH env var is required (path to the saga SQLite database).\n',
    );
    process.exit(2);
  }
  const claimToken = randomUUID();
  const ticket = claimFactoryLaunch(launchRef, claimToken);
  const {
    projectId,
    epicId,
    concurrency,
    lifecycleInput,
    lifecycleInputSchema,
    initiatedBy,
    mode,
  } = ticket;

  // The idempotency key AND initiated_by for runEpisode MUST match the
  // LifecycleRun's values, NOT the launch's. A resume launch has its own
  // idempotency key (distinct from the original 'new' launch), but the
  // lifecycle runtime resolves existing runs by the LIFECYCLE run's key AND
  // verifies initiated_by for replay context matching. For mode='resume',
  // look up both from the durable lifecycle run; for mode='new', use the
  // launch ticket's values (which created the lifecycle run).
  const { idempotencyKey, runInitiatedBy } = (() => {
    if (mode !== 'resume' || !ticket.lifecycleRunId) {
      return {
        idempotencyKey: ticket.idempotencyKey,
        runInitiatedBy: initiatedBy,
      };
    }
    const runRow = getDb().prepare(
      'SELECT idempotency_key, initiated_by FROM factory_lifecycle_runs WHERE id=?',
    ).get(ticket.lifecycleRunId) as
      | { idempotency_key: string; initiated_by: string }
      | undefined;
    if (!runRow?.idempotency_key) {
      throw new Error(
        `FACTORY_RESOLVE_LIFECYCLE_KEY_FAILED: lifecycle run ${ticket.lifecycleRunId} has no idempotency_key`,
      );
    }
    return {
      idempotencyKey: runRow.idempotency_key,
      runInitiatedBy: runRow.initiated_by ?? initiatedBy,
    };
  })();

  // DIAGNOSTIC: catch silent exits. The engine dies after "drain complete"
  // without a "cycle:" or "done:" line — process disappears quietly. These
  // handlers surface the cause (unhandled rejection, uncaught exception, or
  // explicit exit) so we can see WHY the dispatch loop doesn't resume.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[orchestrate-cli] UNCAUGHT_EXCEPTION: ${err.message}\n`);
    if (err.stack) process.stderr.write(err.stack + '\n');
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[orchestrate-cli] UNHANDLED_REJECTION: ${String(reason)}\n`);
  });
  process.on('beforeExit', (code) => {
    process.stderr.write(`[orchestrate-cli] BEFORE_EXIT: code=${code}\n`);
  });
  process.on('exit', (code) => {
    process.stderr.write(`[orchestrate-cli] EXIT: code=${code}\n`);
  });

  process.stdout.write(
    `[orchestrate-cli] starting project=${projectId} epic=${epicId} concurrency=${concurrency}\n`,
  );

  let application: SagaApplication | null = null;
  let supervision: { stop(): void } | null = null;
  try {
    const overrides = await loadCompositionOverrides(projectId, epicId);
    // The lifecycle input may be supplied three ways. The preferred in-process
    // path is SAGA_PRODUCT_LIFECYCLE_INPUT_JSON: the parent (e.g. the tracker-
    // view "start from idea" route) assembles and validates the
    // ProductDeliveryLifecycleInput in its own memory and hands the JSON inline
    // to this child via env — no JSON file is written to disk and no
    // --lifecycle-input path is passed. The runtime's resolveInput re-validates
    // it (assertProductDeliveryLifecycleInput) before Discovery runs.
    application = createFactoryApplication(process.env, overrides);
    const episodeRuntime = getLastFactoryEpisodeRuntimeRepository();
    if (!episodeRuntime) {
      throw new Error(
        'FACTORY_CONCURRENCY_POLICY_UNAVAILABLE: composition-root did not publish '
        + 'the durable episode runtime repository',
      );
    }

    // CONVEYOR Wave 5 — start the watchman. The supervision service reconciles
    // durable worker executions on startup (catching orphans from a prior
    // runtime crash) and periodically while the conveyor is alive, returning
    // fenced cards from dead/zombie workers to their queues without operator
    // intervention. reconcileWorkerExecutions already existed but had no
    // production scheduling call — this is that call.
    const { startWorkerSupervision } = await import('./infrastructure/work/worker-supervision-service.js');
    const { SqliteExecutionRuntimeRepository } = await import('./infrastructure/persistence/sqlite-factory-runtime-repositories.js');
    const supervisionHandle = startWorkerSupervision({
      executionRuntime: new SqliteExecutionRuntimeRepository(),
      projectId,
      epicId,
    });
    supervision = supervisionHandle;

    // CGAD P18 — Conveyor dispatch loop. The CLI is the factory operator: it
    // runs the lifecycle (which pauses when a module waits for kanban tasks to
    // drain), then distributes queued tasks to workers, then resumes. Repeat
    // until the lifecycle reaches a terminal state (completed/failed) or no
    // more tasks remain to dispatch.
    let lastResult: Awaited<ReturnType<SagaApplication['runEpisode']>> | null = null;
    let isFirstCycle = true;
    // Empty-dispatch streak guard: when distributeQueuedTasks returns 0 we
    // re-run runEpisode (the lifecycle may be waiting to project the next
    // node after a worker just completed). But if this happens repeatedly
    // without the lifecycle advancing, the run is genuinely stuck
    // (needs-human, unresolved dependency) and we must stop rather than spin.
    const MAX_EMPTY_DISPATCH_STREAK = 3;
    let emptyDispatchStreak = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      process.stderr.write(`[orchestrate-cli] LOOP: cycle ${isFirstCycle ? '1 (initial)' : 'resume'} — calling runEpisode\n`);
      const admission = episodeRuntime.readConcurrencyAdmission(epicId);
      const result = await application.runEpisode({
        projectId,
        epicId,
        concurrency: admission.effectiveConcurrency,
        lifecycleInput: isFirstCycle ? lifecycleInput : undefined,
        lifecycleInputSchema: isFirstCycle && lifecycleInput !== undefined
          ? lifecycleInputSchema ?? undefined
          : undefined,
        idempotencyKey,
        resumePaused: !isFirstCycle || mode === 'resume',
        // On resume, initiated_by comes from the durable lifecycle run (resolved
        // above as runInitiatedBy) to avoid LIFECYCLE_REPLAY_CONTEXT_MISMATCH.
        initiatedBy: runInitiatedBy,
      });
      if (isFirstCycle && result.lifecycleRun?.id) {
        markFactoryLaunchRunning(
          launchRef,
          claimToken,
          result.lifecycleRun.id,
        );
      }
      lastResult = result;
      isFirstCycle = false;
      // The route is resolved per-execution at claim time from the task's
      // (module, cell, role, executionProfile) key — no per-stage tracking is
      // needed anymore (the model==mock / currentStageRef machinery is gone).
      process.stdout.write(`[orchestrate-cli] cycle: ${JSON.stringify({ reason: result.reason, stage: result.finalStage })}\n`);
      // Optional online factory checkpoint. It snapshots SQLite through the
      // backup API and content-addresses referenced artifact bytes. A failed
      // capture never publishes COMPLETE and never stops the production run.
      const checkpointStore = process.env.SAGA_FACTORY_CHECKPOINT_STORE?.trim();
      if (checkpointStore) {
        try {
          const { FactoryCheckpointService } = await import(
            './checkpoints/factory-checkpoint-service.js'
          );
          const checkpoint = await new FactoryCheckpointService().capture({
            dbPath: process.env.DB_PATH!,
            storageRoot: checkpointStore,
            projectId,
            epicId,
            createdBy: 'orchestrate-cli',
            includeLogs: process.env.SAGA_FACTORY_CHECKPOINT_LOGS === '1',
            ...(process.env.SAGA_FACTORY_CHECKPOINT_HMAC_KEY
              ? {
                  hmacKey: process.env.SAGA_FACTORY_CHECKPOINT_HMAC_KEY,
                  signatureKeyId: 'env:SAGA_FACTORY_CHECKPOINT_HMAC_KEY',
                }
              : {}),
          });
          process.stdout.write(
            `[orchestrate-cli] checkpoint: ${checkpoint.payload.checkpointRef}\n`,
          );
        } catch (checkpointError) {
          process.stderr.write(
            `[orchestrate-cli] checkpoint not published: `
              + `${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}\n`,
          );
        }
      }
      // Structured log — every cycle for debugging
      try {
        const { appendFileSync: apf } = await import('node:fs');
        const { tmpdir: tmp } = await import('node:os');
        const lp = process.env.SAGA_ENGINE_LOG ?? `${tmp()}/saga-engine-manual.log`;
        const ts2 = new Date().toISOString();
        apf(lp, `[${ts2}] CYCLE: ${JSON.stringify({ reason: result.reason, stage: result.finalStage })}\n`);
      } catch { /* logging is best-effort */ }

      // Terminal — lifecycle finished (completed/failed/stopped).
      if (result.reason !== 'paused') break;

      // Paused — the lifecycle is waiting for kanban tasks (impl/verify) to drain.
      // Distribute them to workers through the SAME WorkerExecutorFactory AND
      // the SAME WorkAssignmentPort that composition-root created — one spawn
      // point, one assignment authority, one route resolver. There is no second
      // factory and no second claudePath here.
      const { distributeQueuedTasks } = await import('./app/dispatch-loop.js');
      const { loadSagaRuntimeConfig } = await import('./runtime/saga-runtime-config.js');
      const { getLastFactoryWorkAssignment, getLastFactoryWorkerExecutorFactory } = await import('./app/composition-root.js');
      const dispatchConfig = loadSagaRuntimeConfig(process.env);
      const sagaEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
      const workspaceRoot = (() => {
        const row = getDb().prepare(
          'SELECT pr.local_path FROM project_repositories pr WHERE pr.project_id=? AND pr.status=? ORDER BY pr.id LIMIT 1',
        ).get(projectId, 'active') as { local_path: string } | undefined;
        return row?.local_path ?? process.cwd();
      })();
      // The single WorkAssignmentPort created by composition-root (carrying the
      // route resolver). Fallback to a fresh adapter is intentionally absent: a
      // missing port means composition-root was not wired, which is a fatal
      // configuration error, not a degraded mode.
      const factoryWorkAssignment = getLastFactoryWorkAssignment();
      if (!factoryWorkAssignment) {
        throw new Error(
          'FACTORY_WORK_ASSIGNMENT_UNAVAILABLE: composition-root did not publish '
          + 'a WorkAssignmentPort. The dispatch loop requires the single shared '
          + 'assignment authority (routing cutover invariant).',
        );
      }
      const factoryExecutor = getLastFactoryWorkerExecutorFactory();
      if (!factoryExecutor) {
        throw new Error(
          'FACTORY_WORKER_EXECUTOR_FACTORY_UNAVAILABLE: composition-root did not publish '
          + 'a WorkerExecutorFactory. The dispatch loop requires the single shared '
          + 'spawn point (routing cutover invariant).',
        );
      }
      const dispatched = await distributeQueuedTasks({
        projectId,
        epicId,
        readConcurrencyAdmission: () => episodeRuntime.readConcurrencyAdmission(epicId),
        shouldYieldToKernel: () => Boolean(getDb().prepare(
          `SELECT 1
             FROM factory_workplaces w
             JOIN factory_process_runs pr ON pr.id=w.process_run_id
            WHERE pr.epic_id=?
              AND pr.status IN ('running','paused')
              AND w.loop_state IN ('verifying','effect_pending')
            LIMIT 1`,
        ).get(epicId)),
        // Conveyor model: this application service owns dispatch and the
        // global concurrency budget. It atomically assigns each exact card
        // before constructing the worker process; the runner only hosts the
        // already-assigned worker and never searches the queue.
        workAssignment: factoryWorkAssignment,
        idGenerator: uuidIdGenerator,
        machineId: os.hostname(),
        // The workerExecutorFactory is the SAME instance composition-root built.
        // One factory, one spawn path — no second claudePath, no second adapter.
        workerExecutorFactory: factoryExecutor,
        factoryContext: {
          projectId,
          epicId,
          workspaceRoot,
          dbPath: process.env.DB_PATH!,
          sagaEntry,
          sagaSkillRoot: process.cwd(),
          // claudePath is the legacy fallback binary. The executor backend is
          // selected by the runner from the FROZEN executor_kind in each
          // assignment's execution_context — this string is only used when no
          // frozen executor_kind is present (pre-v2 executions).
          claudePath: process.env.SAGA_CLAUDE_PATH,
          logRoot: dispatchConfig.orchestrationLogRoot,
          heartbeatLog: dispatchConfig.orchestrationLogRoot
            ? path.join(dispatchConfig.orchestrationLogRoot, 'worker-heartbeat.log')
            : undefined,
          lmStudioUrl: dispatchConfig.lmStudioUrl,
        },
      });
      if (dispatched === 0) {
        // Do one supervision pass NOW. The periodic 30s watchman is a safety
        // net; an empty queue is itself a high-value reconciliation boundary
        // and must not race a 6s empty-streak timeout.
        try {
          const sweep = supervisionHandle.reconcileOnce();
          if (sweep.reapedCount > 0) {
            process.stdout.write(
              `[orchestrate-cli] on-demand supervision reaped ${sweep.reapedCount} execution(s)\n`,
            );
          }
        } catch (supervisionError) {
          process.stderr.write(
            `[orchestrate-cli] on-demand supervision failed: `
              + `${supervisionError instanceof Error ? supervisionError.message : String(supervisionError)}\n`,
          );
        }

        const activeExecutions = getDb().prepare(
          `SELECT COUNT(*) AS n
             FROM worker_executions
            WHERE project_id=? AND epic_id=?
              AND state IN ('reserved','running','cancel_requested')`,
        ).get(projectId, epicId) as { n: number };
        if (activeExecutions.n > 0) {
          // A resumed host may adopt executions launched by the previous
          // host. They are not in this process's Promise set, so an empty
          // local dispatch queue does not mean the factory is idle.
          emptyDispatchStreak = 0;
          process.stdout.write(
            `[orchestrate-cli] paused with ${activeExecutions.n} durable execution(s) still active — waiting\n`,
          );
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        // The lifecycle pause reason and the Workplace loop state are different
        // channels. Read ONLY the exact current StageRun -> ProcessRun scope;
        // LifecycleRun.current_stage_run_id is not a ProcessRun id.
        const { readCurrentStageWorkplaceState } = await import(
          './app/orchestration-idle-state.js'
        );
        const workplaceState = readCurrentStageWorkplaceState(
          getDb(),
          lastResult?.lifecycleRun?.id ?? 0,
        );

        if (workplaceState.humanPausedCount > 0) {
          // `paused` is the explicit onExhausted/human-required boundary. It is
          // intentionally invisible to normal dispatch and supervision. Do not
          // wait forever pretending this is automatic recovery.
          process.stdout.write(
            `[orchestrate-cli] ${workplaceState.humanPausedCount} workplace(s) require explicit resume; `
              + `automatic factory run is stopping in paused state\n`,
          );
          break;
        }

        if (workplaceState.kernelProgressCount > 0) {
          // repair_wait/verifying/effect_pending are driven synchronously by
          // the ProductionCellNodeExecutor on the NEXT runEpisode call. They do
          // not wait for the 30s worker-supervision timer. Resume the kernel
          // promptly and do not consume the empty-queue streak.
          emptyDispatchStreak = 0;
          process.stdout.write(
            `[orchestrate-cli] kernel-owned workplace progress pending `
              + `${JSON.stringify(workplaceState.states)} — resuming lifecycle\n`,
          );
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }

        // No active execution and no kernel-owned transition is pending. The
        // queue may simply be between node projections, so re-run the lifecycle
        // a bounded number of times. Persistent queued/dependency state then
        // stops instead of spinning forever.
        emptyDispatchStreak += 1;
        process.stdout.write(
          `[orchestrate-cli] paused with empty queue — resuming lifecycle (streak ${emptyDispatchStreak}/${MAX_EMPTY_DISPATCH_STREAK})\n`,
        );
        if (emptyDispatchStreak >= MAX_EMPTY_DISPATCH_STREAK) {
          process.stdout.write(
            '[orchestrate-cli] empty-queue streak exhausted — stopping to avoid infinite loop\n',
          );
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      // Tasks were dispatched and drained — the lifecycle may have
      // advanced, so reset the streak and resume runEpisode.
      emptyDispatchStreak = 0;
      process.stderr.write(`[orchestrate-cli] LOOP: dispatched=${dispatched}, continuing to next runEpisode\n`);
    }
    const result = lastResult!;
    process.stdout.write(`[orchestrate-cli] done: ${JSON.stringify(result)}\n`);
    // Structured log — write pipeline result to engine log for debugging
    const { appendFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const logPath = process.env.SAGA_ENGINE_LOG ?? `${tmpdir()}/saga-engine-manual.log`;
    const ts = new Date().toISOString();
    appendFileSync(logPath, `[${ts}] PIPELINE RESULT: ${JSON.stringify(result)}\n`);
    // Crash/reconciliation fallback: the direct post-terminal capture effect
    // (replay-capture) is the normal certification path, but if it was skipped
    // (process crash between transition and capture, or an effect error that
    // left a terminal-accepted workplace uncertified), run the project-wide
    // sweep before exit so the next replay run can find these capsules. This
    // sweep is idempotent and only backfills missing capsules. Not run for
    // `paused` (lifecycle suspended, not finished).
    if (result.reason !== 'paused') {
      try {
        const { certifyAcceptedReplayCapsules } = await import(
          './infrastructure/replay/replay-claim-binder.js'
        );
        certifyAcceptedReplayCapsules(getDb(), projectId);
      } catch (certifyError) {
        process.stderr.write(
          `[orchestrate-cli] replay certification sweep failed: `
          + `${certifyError instanceof Error ? certifyError.message : String(certifyError)}\n`,
        );
      }
    }
    // paused is NOT terminal — the lifecycle suspended without converging.
    // This happens when: (a) a workplace requires human input (paused), (b) the
    // empty-dispatch streak exhausted (kernel not advancing), or (c) the queue
    // is empty but the lifecycle did not complete. In all three cases the
    // factory did NOT reach a terminal state.
    //
    // The launch request itself IS settled (terminal-for-this-launch): the host
    // process is exiting, completed_at is stamped, and the one-active-launch
    // slot is freed so a later resume can create a fresh launch. But neither
    // the launch nor the order is marked 'completed' — both record 'paused' so
    // status readers cannot mistake this for convergence. The exit code is 2
    // (distinct from 0=success and 1=failure).
    const isTerminal = result.reason !== 'paused';
    if (!isTerminal) {
      process.stderr.write(
        `[orchestrate-cli] lifecycle paused (not terminal): ${JSON.stringify(result)}\n`,
      );
    }
    finishFactoryLaunch(
      launchRef,
      claimToken,
      isTerminal
        ? (result.reason === 'failed' ? 'failed' : 'completed')
        : 'paused',
      result.reason === 'failed' ? JSON.stringify(result) : null,
      isTerminal
        ? (result.reason === 'failed' ? 'start_failed' : 'completed')
        : 'paused',
    );
    process.exit(isTerminal ? (result.reason === 'failed' ? 1 : 0) : 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[orchestrate-cli] fatal: ${msg}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    try {
      finishFactoryLaunch(launchRef, claimToken, 'failed', msg);
    } catch { /* preserve the original failure */ }
    process.exit(1);
  } finally {
    try { supervision?.stop(); } catch { /* best effort */ }
    try { application?.close(); } catch { /* best effort */ }
  }
}

interface ProductLifecycleCompositionModule {
  createProductLifecycleComposition?: (context: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    projectId: number;
    epicId: number;
  }) =>
    | ProductLifecycleCompositionOverrides
    | Promise<ProductLifecycleCompositionOverrides>;
  default?:
    | ProductLifecycleCompositionOverrides
    | ((context: {
      env: NodeJS.ProcessEnv;
      cwd: string;
      projectId: number;
      epicId: number;
    }) =>
      | ProductLifecycleCompositionOverrides
      | Promise<ProductLifecycleCompositionOverrides>);
}

async function loadCompositionOverrides(
  projectId: number,
  epicId: number,
): Promise<FactoryCompositionOverrides> {
  // saga4 cutover: the CLI always runs the Product Lifecycle runtime.
  // SAGA_PRODUCT_LIFECYCLE_COMPOSITION is mandatory.
  const repoRoot = path.resolve(process.env.SAGA_REPO_ROOT ?? process.cwd());
  const configuredPath = process.env.SAGA_PRODUCT_LIFECYCLE_COMPOSITION;
  if (!configuredPath) {
    throw new Error(
      'SAGA_PRODUCT_LIFECYCLE_COMPOSITION_REQUIRED: the lifecycle runtime is '
      + 'the only engine; an explicit ESM module supplying real Delivery '
      + 'preflight, publication and observation providers is mandatory',
    );
  }
  const absolutePath = path.resolve(configuredPath);
  const loaded = await import(pathToFileURL(absolutePath).href) as
    ProductLifecycleCompositionModule;
  const exported =
    loaded.createProductLifecycleComposition ?? loaded.default;
  if (!exported) {
    throw new Error(
      `PRODUCT_LIFECYCLE_COMPOSITION_EXPORT_MISSING: ${absolutePath}`,
    );
  }
  const context = {
    env: process.env,
    cwd: process.cwd(),
    projectId,
    epicId,
  };
  const productLifecycle = typeof exported === 'function'
    ? await exported(context)
    : exported;
  if (!productLifecycle?.delivery) {
    throw new Error(
      `PRODUCT_LIFECYCLE_DELIVERY_COMPOSITION_MISSING: ${absolutePath}`,
    );
  }

  // W13-AUDIT §18.5/§18.9: install the production modules into the durable
  // content-addressed package store ONCE before the runtime is constructed
  // (install is async I/O; createProductLifecycleRuntime stays synchronous).
  // The resulting ProductionInstallation is threaded through overrides so every
  // ProcessRun is pinned to an immutable packageDigest and the workspace
  // materializer resolves resources from pinned bytes. Idempotent across CLI
  // restarts (same DB + unchanged bytes → reuse active records).
  // CONVEYOR Wave 9 cutover: the installation layer is generic machinery and
  // must NOT import module implementations (cutover ratchet "no hidden
  // fallbacks"). The composition layer (this file) owns the decision about
  // WHICH modules exist and supplies the manifest set explicitly.
  const packageInstallation = await installProductionModules(
    getDb(),
    repoRoot,
    [
      discoveryPackageManifest,
      formalizationPackageManifest,
      developmentPackageManifest,
      developmentContinuationPackageManifest,
      developmentVerificationContinuationPackageManifest,
      deliveryPackageManifest,
    ],
    process.env.SAGA_PACKAGE_STORE_DIR,
  );

  return {
    modulePackages: packageInstallation,
    productLifecycle: {
      ...productLifecycle,
      packageInstallation,
      onLifecycleStarted: writeLifecycleStartReceipt,
    },
    // ScriptedWorkerExecutor DI override (Factory Contract Harness §8.9).
    // When the composition module exports a workerExecutorFactory, it replaces
    // the production Claude worker factory. Production code does not know.
    ...(productLifecycle.workerExecutorFactory
      ? { workerExecutorFactory: productLifecycle.workerExecutorFactory }
      : {}),
    ...(productLifecycle.resolveWorkerContext
      ? { resolveWorkerContext: productLifecycle.resolveWorkerContext }
      : {}),
    // Routing cutover: the route resolver is constructed ONCE by the
    // composition root from factory-execution-routes.json (or the
    // SAGA_EXECUTION_ROUTES_JSON env). It is the SINGLE spawn-side authority —
    // there is no second factory and no second claudePath. The composition root
    // wires the resolver into the WorkAssignmentPort (freezes the route at
    // claim), the MCP worker_next path, and the worker executor (binary
    // selection from the frozen executor_kind).
    executionRouteResolverOptions: {},
  };
}

main().catch(err => {
  process.stderr.write(`[orchestrate-cli] unhandled: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
