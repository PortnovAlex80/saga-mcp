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
import {
  engineHeartbeatTouch,
  engineLog,
  enginePhaseMark,
  initEngineMarkers,
} from './runtime/engine-file-logger.js';
// Antifreeze layers B2+B3: the wait loop polls durable state through a
// dedicated READONLY connection (never blocked by writers in WAL), and hot
// engine writes get a bounded busy-retry window instead of a 5s main-thread
// busy-spin (TB-2 freeze class).
import { createDurableStateProbe, type DurableStateProbe } from './runtime/durable-state-probe.js';
import { EngineDbBusyError, withBusyRetry } from './runtime/busy-retry.js';
import { reconcileAutomaticPreSpawnRecovery } from './app/automatic-pre-spawn-recovery.js';
import { runFactoryBootRevision } from './app/factory-boot-revision.js';
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
import { journalEvent } from './observability/run-journal.js';
import { settleLaunchFromRunResult } from './app/launch-terminal-settlement.js';
import {
  acquireFactoryLaunchController,
  assertFactoryControllerFence,
  finishFactoryLaunch,
  markFactoryLaunchRunning,
  renewFactoryControllerLease,
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
    engineLog('[orchestrate-cli] fatal: DB_PATH env var is required (path to the saga SQLite database).');
    process.stderr.write(
      'DB_PATH env var is required (path to the saga SQLite database).\n',
    );
    process.exit(2);
  }
  // Antifreeze layer A+B1: engine stdout is a blocked-pipe hazard (the
  // panel drains it from ITS event loop; a stalled panel fills the pipe and
  // blocks this process's main thread forever on the next write). Every
  // engine line below goes to $SAGA_ENGINE_LOG instead. The heartbeat file
  // mtime advances every <=5s while the main thread is alive — a stale
  // mtime with a live PID is the externally observable freeze signal.
  initEngineMarkers();
  enginePhaseMark('boot');
  const engineHeartbeat = setInterval(() => engineHeartbeatTouch(), 5_000);
  engineHeartbeat.unref();
  const claimToken = randomUUID();
  const ticket = acquireFactoryLaunchController(launchRef, claimToken);
  const controllerEpoch = ticket.controllerEpoch!;
  let controllerFenceLost: Error | null = null;
  // STAGE-11 TASK 5 — set by the exit sites, read by the exit hook for the
  // one-shot engine.exit journal line ('boot' until the main flow decides).
  let exitReason: string = 'boot';
  // CC-GAP-2 — the business verdict channels travel WITH the exit code so an
  // `engine.exit {code: 0}` line can never be read as product success on its
  // own: code/reason stay operational, terminal_status/product_outcome carry
  // the lifecycle verdict (null on fatal paths where it is genuinely unknown).
  let exitTerminalStatus: string | null = null;
  let exitProductOutcome: string | null = null;
  const controllerHeartbeat = setInterval(() => {
    try {
      // Antifreeze B3: the lease renewal is a hot engine write on the SHARED
      // main connection — under contention it used to busy-spin the main
      // thread for the full busy_timeout (5s) with all timers frozen. Bounded
      // retry instead; ENGINE_DB_BUSY means the fence state is UNKNOWN (not
      // lost) — defer to the next 10s heartbeat, the 30s lease TTL is the
      // safety net, and the per-cycle assertFactoryControllerFence fails
      // loudly if the lease genuinely expires.
      withBusyRetry(
        () => renewFactoryControllerLease(launchRef, claimToken, controllerEpoch),
        { db: getDb() },
      );
    } catch (error) {
      if (error instanceof EngineDbBusyError) {
        engineLog(
          `[orchestrate-cli] controller lease renew deferred (db busy): ${error.message}`,
        );
        return;
      }
      controllerFenceLost = error instanceof Error ? error : new Error(String(error));
    }
  }, 10_000);
  controllerHeartbeat.unref();
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
    engineLog(`[orchestrate-cli] UNCAUGHT_EXCEPTION: ${err.message}`);
    if (err.stack) engineLog(err.stack);
    process.stderr.write(`[orchestrate-cli] UNCAUGHT_EXCEPTION: ${err.message}\n`);
    if (err.stack) process.stderr.write(err.stack + '\n');
  });
  process.on('unhandledRejection', (reason) => {
    engineLog(`[orchestrate-cli] UNHANDLED_REJECTION: ${String(reason)}`);
    process.stderr.write(`[orchestrate-cli] UNHANDLED_REJECTION: ${String(reason)}\n`);
  });
  process.on('beforeExit', (code) => {
    engineLog(`[orchestrate-cli] BEFORE_EXIT: code=${code}`);
    process.stderr.write(`[orchestrate-cli] BEFORE_EXIT: code=${code}\n`);
  });
  process.on('exit', (code) => {
    engineLog(`[orchestrate-cli] EXIT: code=${code}`);
    process.stderr.write(`[orchestrate-cli] EXIT: code=${code}\n`);
    // STAGE-11 TASK 5 — exactly one terminal line per process: a reader must
    // tell "the run ended" from "the journal stopped". Emitted ONLY here (the
    // exit sites set exitReason; emitting there too would double-log).
    // appendFileSync is synchronous and legal in an exit handler.
    journalEvent('engine.exit', {
      epic_id: epicId ?? undefined,
      run_id: ticket.lifecycleRunId !== null ? String(ticket.lifecycleRunId) : undefined,
    }, {
      code,
      reason: exitReason,
      // CC-GAP-2: separated verdict channels — exit code 0 ("the engine
      // reached a lifecycle terminal state") never implies product success;
      // the verdict is on the same evidence line.
      terminal_status: exitTerminalStatus,
      product_outcome: exitProductOutcome,
    });
  });

  engineLog(
    `[orchestrate-cli] starting project=${projectId} epic=${epicId} concurrency=${concurrency}`,
  );

  let application: SagaApplication | null = null;
  let supervision: { stop(): void } | null = null;
  // Antifreeze B2: one readonly probe connection per engine. The wait loop's
  // frequent reads (per-second worker polls, kernel checks, active counts)
  // run here — a WAL reader never waits for the single writer slot, so the
  // loop cannot busy-spin on the main connection. Closed in the finally below.
  const durableStateProbe: DurableStateProbe = createDurableStateProbe(process.env.DB_PATH!);
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

    // Recovery is a controller-owned mutation. It must complete under the
    // launch fence before supervision or dispatch can claim work; observers
    // such as tracker-view never run this command.
    assertFactoryControllerFence(launchRef, claimToken, controllerEpoch);
    const bootRevision = runFactoryBootRevision(getDb());
    if (
      bootRevision.swept.length > 0 || bootRevision.adoption.adopted > 0
      || bootRevision.burial.buried > 0 || bootRevision.burial.workplacesReleased > 0
    ) {
      engineLog(
        `[orchestrate-cli] boot revision: adoption=${bootRevision.adoption.adopted} `
        + `buried=${bootRevision.burial.buried} `
        + `released=${bootRevision.burial.workplacesReleased} `
        + `swept=${bootRevision.swept.length}`,
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

    if (mode === 'resume' && ticket.lifecycleRunId) {
      assertFactoryControllerFence(launchRef, claimToken, controllerEpoch);
      const recovery = reconcileAutomaticPreSpawnRecovery(getDb(), ticket.lifecycleRunId);
      if (recovery) {
        engineLog(
          `[orchestrate-cli] automatic pre-spawn recovery=${recovery.recoveryRef} `
          + `execution=${recovery.executionId} replayed=${recovery.replayed}`,
        );
      }
    }

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
      if (controllerFenceLost) throw controllerFenceLost;
      assertFactoryControllerFence(launchRef, claimToken, controllerEpoch);
      enginePhaseMark('runEpisode');
      engineLog(`[orchestrate-cli] LOOP: cycle ${isFirstCycle ? '1 (initial)' : 'resume'} — calling runEpisode`);
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
      engineLog(`[orchestrate-cli] cycle: ${JSON.stringify({ reason: result.reason, stage: result.finalStage })}`);
      // Optional online factory checkpoint. It snapshots SQLite through the
      // backup API and content-addresses referenced artifact bytes. A failed
      // capture never publishes COMPLETE and never stops the production run.
      // Antifreeze B4: the capture connection moved to a ONE-SHOT CHILD
      // process (capture-spawn.ts). In-process, that connection and the
      // engine's main connection contended on THIS event loop — under a
      // write-lock collision both spins starve each other forever (TB-2
      // same-process deadlock class; layer B3 only bounded each slice). The
      // child is killed after a hard timeout; a lost capture stays a log
      // line, never a freeze. SAGA_CHECKPOINT_CHILD=0 restores the legacy
      // in-process path for tests/debugging.
      const checkpointStore = process.env.SAGA_FACTORY_CHECKPOINT_STORE?.trim();
      if (checkpointStore) {
        try {
          const { captureCheckpointIsolated } = await import(
            './checkpoints/capture-spawn.js'
          );
          const captured = await captureCheckpointIsolated({
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
          engineLog(
            `[orchestrate-cli] checkpoint: ${captured.checkpointRef} (${captured.mode})`,
          );
          enginePhaseMark('checkpoint');
        } catch (checkpointError) {
          engineLog(
            `[orchestrate-cli] checkpoint not published: `
            + `${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`,
          );
          process.stderr.write(
            `[orchestrate-cli] checkpoint not published: `
            + `${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}\n`,
          );
        }
      }
      // Structured log — every cycle for debugging
      engineLog(`[${new Date().toISOString()}] CYCLE: ${JSON.stringify({ reason: result.reason, stage: result.finalStage })}`);

      // Terminal — lifecycle finished (completed/failed/stopped).
      if (result.reason !== 'paused') break;

      // Paused — the lifecycle is waiting for kanban tasks (impl/verify) to drain.
      // Distribute them to workers through the SAME WorkerExecutorFactory AND
      // the SAME WorkAssignmentPort that composition-root created — one spawn
      // point, one assignment authority, one route resolver. There is no second
      // factory and no second claudePath here.
      enginePhaseMark('dispatch');
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
        // Antifreeze B2: kernel-yield check runs per inner-loop iteration —
        // route it through the readonly probe, not the shared main connection.
        shouldYieldToKernel: () => durableStateProbe.isKernelWorkPending(epicId),
        // Windows pipe-inheritance fail-safe: resolve the per-worker wait from
        // the durable execution state when the runner's run snapshot stalls.
        pollDebug: (message: string) => {
          engineLog(`[wait-poll] ${message}`);
          const task = /^task=\S+/.exec(message)?.[0];
          if (task) enginePhaseMark(`wait-poll ${task}`);
        },
        // Antifreeze B2: this probe is polled every pollMs per worker (the
        // hottest read of the engine). Readonly probe connection — never
        // blocked by writers; errors fail closed to false and the next poll
        // (1s) is the retry.
        isExecutionDurableTerminal: (workerExecutionId: string) => (
          durableStateProbe.isExecutionDurableTerminal(workerExecutionId)
        ),
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
            enginePhaseMark('supervision');
            engineLog(
              `[orchestrate-cli] on-demand supervision reaped ${sweep.reapedCount} execution(s)`,
            );
          }
        } catch (supervisionError) {
          engineLog(
            `[orchestrate-cli] on-demand supervision failed: `
            + `${supervisionError instanceof Error ? supervisionError.message : String(supervisionError)}`,
          );
          process.stderr.write(
            `[orchestrate-cli] on-demand supervision failed: `
            + `${supervisionError instanceof Error ? supervisionError.message : String(supervisionError)}\n`,
          );
        }

        // Antifreeze B2: the paused-with-active-executions wait loop re-checks
        // this count every 2s. Probe read; -1 (unknown) is treated as "still
        // active" so a transient probe error can only extend the wait, never
        // skip it.
        const activeExecutions = durableStateProbe.countActiveExecutions(projectId, epicId);
        if (activeExecutions !== 0) {
          // A resumed host may adopt executions launched by the previous
          // host. They are not in this process's Promise set, so an empty
          // local dispatch queue does not mean the factory is idle.
          emptyDispatchStreak = 0;
          enginePhaseMark('wait-active');
          engineLog(
            `[orchestrate-cli] paused with ${activeExecutions > 0 ? activeExecutions : '?'} `
            + `durable execution(s) still active — waiting`,
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
          enginePhaseMark('stop-human-paused');
          engineLog(
            `[orchestrate-cli] ${workplaceState.humanPausedCount} workplace(s) require explicit resume; `
            + `automatic factory run is stopping in paused state`,
          );
          break;
        }

        if (workplaceState.kernelProgressCount > 0) {
          // repair_wait/verifying/effect_pending are driven synchronously by
          // the ProductionCellNodeExecutor on the NEXT runEpisode call. They do
          // not wait for the 30s worker-supervision timer. Resume the kernel
          // promptly and do not consume the empty-queue streak.
          emptyDispatchStreak = 0;
          enginePhaseMark('resume-kernel');
          engineLog(
            `[orchestrate-cli] kernel-owned workplace progress pending `
            + `${JSON.stringify(workplaceState.states)} — resuming lifecycle`,
          );
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }

        // No active execution and no kernel-owned transition is pending. The
        // queue may simply be between node projections, so re-run the lifecycle
        // a bounded number of times. Persistent queued/dependency state then
        // stops instead of spinning forever.
        emptyDispatchStreak += 1;
        enginePhaseMark(`resume-empty streak=${emptyDispatchStreak}`);
        engineLog(
          `[orchestrate-cli] paused with empty queue — resuming lifecycle (streak ${emptyDispatchStreak}/${MAX_EMPTY_DISPATCH_STREAK})`,
        );
        if (emptyDispatchStreak >= MAX_EMPTY_DISPATCH_STREAK) {
          enginePhaseMark('stop-empty-streak');
          engineLog(
            '[orchestrate-cli] empty-queue streak exhausted — stopping to avoid infinite loop',
          );
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      // Tasks were dispatched and drained — the lifecycle may have
      // advanced, so reset the streak and resume runEpisode.
      emptyDispatchStreak = 0;
      engineLog(`[orchestrate-cli] LOOP: dispatched=${dispatched}, continuing to next runEpisode`);
    }
    const result = lastResult!;
    enginePhaseMark('done');
    engineLog(`[orchestrate-cli] done: ${JSON.stringify(result)}`);
    // Structured log — write pipeline result to engine log for debugging
    engineLog(`[${new Date().toISOString()}] PIPELINE RESULT: ${JSON.stringify(result)}`);
    // ADR-087 — receipt-authoritative terminal drain (CC-GAP-3, CONVEYOR §23
    // edge "OS worker exits → terminalize the exact WorkerExecution"). The
    // loop above can break on a terminal lifecycle result while executions
    // are still durably active (worker_done already settled the Workplace;
    // the runner close callback that would terminalize the row can be lost or
    // lag behind this exit — including the alive-PID form, where a live
    // receipt-backed closer is lawfully kept by the stuck policy but a
    // terminal epic has no future engine sweep). Settle BEFORE the launch is
    // finished: a short bounded natural-drain courtesy, then the ordinary
    // supervision reconcile, then receipt-authoritative settlement of every
    // remaining active execution through the existing fenced atomic release
    // (semantic `exited`, no kill, exit_code null for the late backfill, CAS
    // winner alone emits worker.exit), then a final active recount. Any
    // non-receipt/unverifiable/failed residual raises a typed operational
    // settlement failure so this launch and the engine exit cannot be
    // presented as clean operational success. Not run for `paused` — the
    // engine keeps supervising on its next cycle.
    let terminalSettlementFailure: string | null = null;
    if (result.reason !== 'paused') {
      const settlementModule = await import(
        './infrastructure/work/worker-supervision-service.js'
      );
      try {
        const settlement = await settlementModule.settleWorkerExecutionsAtTerminalRun(
          supervisionHandle,
          { projectId, epicId, log: engineLog },
        );
        engineLog(
          `[orchestrate-cli] terminal settlement (ADR-087): ${JSON.stringify({
            drainMs: settlement.drainMs,
            activeBeforeDrain: settlement.activeBeforeDrain,
            drainedToZero: settlement.drainedToZero,
            settled: settlement.settled.length,
            activeRemaining: settlement.activeRemaining,
          })}`,
        );
      } catch (settlementError) {
        // Fail-closed branch (ADR-087): the launch is settled 'failed' and
        // the engine exits 1 — never a clean success over an unaccounted
        // active execution. This is operational telemetry, not a domain
        // recovery mechanism.
        terminalSettlementFailure = settlementError instanceof Error
          ? `${settlementError.name}: ${settlementError.message}`
          : String(settlementError);
        engineLog(`[orchestrate-cli] terminal settlement FAILED: ${terminalSettlementFailure}`);
        process.stderr.write(
          `[orchestrate-cli] terminal settlement FAILED: ${terminalSettlementFailure}\n`,
        );
        // Run-journal evidence: the typed code and the itemized residual
        // summary must survive as correlated evidence, not only as the
        // generic engine.exit reason string ('terminal-settlement-failed').
        // The residuals are described AS residual active executions — no
        // closed domain outcome is invented for them here (they remain
        // truthfully active in their own authority tables).
        const typed = settlementError instanceof settlementModule.TerminalWorkerSettlementError
          ? settlementError
          : null;
        journalEvent('terminal_settlement.failed', {
          epic_id: epicId ?? undefined,
          run_id: ticket.lifecycleRunId !== null ? String(ticket.lifecycleRunId) : undefined,
        }, {
          error_name: typed?.name ?? (settlementError instanceof Error
            ? settlementError.name
            : typeof settlementError),
          code: typed?.code ?? 'UNTYPED',
          message: settlementError instanceof Error
            ? settlementError.message
            : String(settlementError),
          residual_count: typed?.residuals.length ?? 0,
          residuals: typed
            ? typed.residuals.map(residual => ({
              execution_id: residual.executionId,
              task_id: residual.taskId,
              code: residual.code,
              detail: residual.detail,
            }))
            : [],
          launch_settlement: 'failed',
          engine_exit_code: 1,
        });
      }
    }
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
        // R-E1 — the sweep result is observable: {considered, certified,
        // failed, skipped:{reason:count}}. "0 needed" and "0 of N failed"
        // are different journal lines now.
        const sweepSummary = certifyAcceptedReplayCapsules(getDb(), projectId);
        engineLog(
          `[orchestrate-cli] replay certification sweep: ${JSON.stringify(sweepSummary)}`,
        );
      } catch (certifyError) {
        engineLog(
          `[orchestrate-cli] replay certification sweep failed: `
          + `${certifyError instanceof Error ? certifyError.message : String(certifyError)}`,
        );
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
    //
    // CC-GAP-2: for the TERMINAL branch, launch/order 'completed' and exit 0
    // are OPERATIONAL facts only — "the engine brought the run to a lifecycle
    // terminal state", whatever that terminal's business verdict is
    // (`terminal_status`: released, development-blocked, approval-required,
    // ...). The engine has no workshop-agnostic success classification for
    // terminal statuses and must not invent one, so the verdict is carried
    // alongside (engine.exit journal fields + durable
    // factory_lifecycle_runs.terminal_status) instead of being flattened into
    // the exit code. Exit 0 / 'completed' therefore never implies product
    // success.
    if (result.reason === 'paused') {
      engineLog(
        `[orchestrate-cli] lifecycle paused (not terminal): ${JSON.stringify(result)}`,
      );
      process.stderr.write(
        `[orchestrate-cli] lifecycle paused (not terminal): ${JSON.stringify(result)}\n`,
      );
    }
    const settlement = settleLaunchFromRunResult(result);
    // ADR-087 fail-closed (CC-GAP-3): a typed terminal-settlement failure
    // settles the launch as failed (exit 1) even when the lifecycle itself
    // completed — the run must not be presented as clean operational success.
    // CC-GAP-2 is preserved: only the OPERATIONAL channels (launch/order
    // state, exit code, reason, error payload) are overridden by the drain
    // failure; the verdict channels below stay truthful to the lifecycle
    // machine's own terminal state (never fabricated, never flattened).
    const settlementFailed = settlement.operationalTerminal && terminalSettlementFailure !== null;
    exitTerminalStatus = settlement.lifecycleTerminalStatus;
    exitProductOutcome = settlement.productOutcome;
    engineLog(
      `[orchestrate-cli] launch settlement: ${JSON.stringify({
        launch_state: settlementFailed ? 'failed' : settlement.launchState,
        order_state: settlementFailed ? 'start_failed' : settlement.orderState,
        exit_code: settlementFailed ? 1 : settlement.exitCode,
        lifecycle_status: settlement.lifecycleStatus,
        terminal_status: settlement.lifecycleTerminalStatus,
        stage_outcome: settlement.stageOutcome,
        product_outcome: settlement.productOutcome,
      })}`,
    );
    finishFactoryLaunch(
      launchRef,
      claimToken,
      settlementFailed ? 'failed' : settlement.launchState,
      terminalSettlementFailure ?? settlement.launchError,
      settlementFailed ? 'start_failed' : settlement.orderState,
    );
    exitReason = settlementFailed
      ? 'terminal-settlement-failed'
      : settlement.exitReason;
    process.exit(settlementFailed ? 1 : settlement.exitCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    engineLog(`[orchestrate-cli] fatal: ${msg}`);
    process.stderr.write(`[orchestrate-cli] fatal: ${msg}\n`);
    if (err instanceof Error && err.stack) {
      engineLog(err.stack);
      process.stderr.write(err.stack + '\n');
    }
    try {
      finishFactoryLaunch(launchRef, claimToken, 'failed', msg);
    } catch { /* preserve the original failure */ }
    exitReason = 'fatal';
    process.exit(1);
  } finally {
    clearInterval(controllerHeartbeat);
    clearInterval(engineHeartbeat);
    try { supervision?.stop(); } catch { /* best effort */ }
    try { application?.close(); } catch { /* best effort */ }
    try { durableStateProbe.close(); } catch { /* best effort */ }
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
  const detail = err instanceof Error ? err.stack : String(err);
  engineLog(`[orchestrate-cli] unhandled: ${detail}`);
  process.stderr.write(`[orchestrate-cli] unhandled: ${detail}\n`);
  process.exit(1);
});
