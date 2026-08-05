#!/usr/bin/env node
/**
 * Saga orchestration CLI host.
 *
 * Usage:
 *   node dist/orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]
 *
 * The CLI now depends on the engine-neutral SagaApplication boundary. After the
 * saga4 cutover the composition root always returns the Product Lifecycle
 * runtime; the legacy Saga2Engine is no longer reachable from here.
 *
 * Env:
 *   DB_PATH             — saga SQLite database (required; same as saga server)
 *   SAGA_CLAUDE_PATH    — path to the claude CLI binary (default: 'claude')
 *   SAGA_ORCHESTRATION_LOG — existing runtime log setting
 *   SAGA_PRODUCT_LIFECYCLE_COMPOSITION — ESM module supplying Delivery providers
 *                         (required; the lifecycle runtime is the only engine)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSaga2Application,
  type ProductLifecycleCompositionOverrides,
  type Saga2CompositionOverrides,
} from './app/composition-root.js';
import type { SagaApplication } from './application/saga-application.js';
import type { WorkerExecutorFactory } from './application/ports/worker-executor.js';
import { createLegacyClaudeWorkerExecutorFactory } from './infrastructure/workers/claude-worker-executor-factory.js';
import { SqliteWorkAssignmentAdapter } from './infrastructure/work/sqlite-work-assignment-adapter.js';
import { asModuleInstallationId } from './process-modules/installation/domain/installation.js';
import type { ProductionInstallation } from './process-modules/installation/production-install.js';
import { getDb } from './db.js';
import { uuidIdGenerator } from './infrastructure/conveyor/conveyor-adapters.js';
import {
  installProductionModules,
} from './process-modules/installation/production-install.js';
import { discoveryPackageManifest } from './process-modules/modules/discovery/package/manifest.js';
import { formalizationPackageManifest } from './process-modules/modules/formalization/package/manifest.js';
import { developmentPackageManifest } from './process-modules/modules/development/package/manifest.js';
import { deliveryPackageManifest } from './process-modules/modules/delivery/package/manifest.js';

function parseArgs(argv: string[]): {
  projectId: number;
  epicId: number;
  concurrency: number;
  lifecycleInputPath: string | null;
  idempotencyKey: string | null;
  resumePaused: boolean;
} {
  const positional: string[] = [];
  let concurrency = 4;
  let lifecycleInputPath: string | null = null;
  let idempotencyKey: string | null = null;
  let resumePaused = false;
  for (const arg of argv.slice(2)) {
    const m = /^--concurrency=(\d+)$/.exec(arg);
    if (m) {
      concurrency = Number(m[1]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
        throw new Error(`--concurrency must be an integer 1..10, got '${m[1]}'`);
      }
      continue;
    }
    const lifecycleInput = /^--lifecycle-input=(.+)$/.exec(arg);
    if (lifecycleInput) {
      lifecycleInputPath = lifecycleInput[1];
      continue;
    }
    const idempotency = /^--idempotency-key=(.+)$/.exec(arg);
    if (idempotency) {
      idempotencyKey = idempotency[1];
      continue;
    }
    if (arg === '--resume') {
      resumePaused = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: orchestrate-cli.js <project_id> <epic_id> [options]\n'
        + '  --concurrency=4\n'
        + '  --lifecycle-input=path/to/input.json\n'
        + '  --idempotency-key=stable-key\n'
        + '  --resume\n'
        + '\n'
        + 'SAGA_PRODUCT_LIFECYCLE_COMPOSITION is required (lifecycle is the only '
        + 'engine). Pass --lifecycle-input, set SAGA_PRODUCT_LIFECYCLE_INPUT '
        + '(path), or set SAGA_PRODUCT_LIFECYCLE_INPUT_JSON (inline JSON).\n',
      );
      process.exit(0);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    process.stderr.write(
      'Usage: orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]\n',
    );
    process.exit(2);
  }
  const projectId = Number(positional[0]);
  const epicId = Number(positional[1]);
  if (!Number.isInteger(projectId) || projectId < 1) {
    process.stderr.write(`project_id must be a positive integer, got '${positional[0]}'\n`);
    process.exit(2);
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    process.stderr.write(`epic_id must be a positive integer, got '${positional[1]}'\n`);
    process.exit(2);
  }
  return {
    projectId,
    epicId,
    concurrency,
    lifecycleInputPath,
    idempotencyKey,
    resumePaused,
  };
}


/**
 * Create a pinned WorkerExecutorFactory for the dispatch loop — identical to
 * what composition-root creates for LM-node workers. This ensures impl-task
 * workers get the SAME desk (materializer, hooks, fence, authority) as
 * Flow-node workers. One spawn path, one mechanic.
 */
function createPinnedWorkerFactoryForDispatch(
  installation: ProductionInstallation | undefined,
): WorkerExecutorFactory {
  if (!installation) {
    throw new Error(
      'PACKAGE_INSTALLATION_REQUIRED: dispatch loop needs a ProductionInstallation '
      + 'to create pinned worker desks.',
    );
  }
  return createLegacyClaudeWorkerExecutorFactory({
    packageRegistry: installation.registry,
    packageSnapshots: installation.packages,
    resolveInstallationId: assignment => {
      const md = typeof assignment.task?.metadata === 'string'
        ? JSON.parse(assignment.task.metadata) as Record<string, unknown>
        : (assignment.task?.metadata as Record<string, unknown>) ?? {};
      const runId = typeof md.process_run_id === 'number' ? md.process_run_id : null;
      if (runId === null) return null;
      const row = getDb().prepare(
        'SELECT installation_id FROM saga3_process_runs WHERE id=?',
      ).get(runId) as { installation_id?: number | null } | undefined;
      const id = row?.installation_id ?? null;
      return id === null ? null : asModuleInstallationId(id);
    },
    resolvePackageDigest: assignment => {
      const md = typeof assignment.task?.metadata === 'string'
        ? JSON.parse(assignment.task.metadata) as Record<string, unknown>
        : (assignment.task?.metadata as Record<string, unknown>) ?? {};
      const runId = typeof md.process_run_id === 'number' ? md.process_run_id : null;
      if (runId === null) return null;
      const row = getDb().prepare(
        'SELECT package_digest FROM saga3_process_runs WHERE id=?',
      ).get(runId) as { package_digest?: string | null } | undefined;
      return row?.package_digest ?? null;
    },
    resolveNodeId: assignment => {
      const md = typeof assignment.task?.metadata === 'string'
        ? JSON.parse(assignment.task.metadata) as Record<string, unknown>
        : (assignment.task?.metadata as Record<string, unknown>) ?? {};
      const nodeId = md.process_node_id;
      return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : null;
    },
    // CONVEYOR: atomic card assignment before spawn. Same port wired in
    // composition-root; the dispatch loop and LM-node workers share one
    // assignment path.
    workAssignment: new SqliteWorkAssignmentAdapter(getDb()),
  });
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
  const {
    projectId,
    epicId,
    concurrency,
    lifecycleInputPath,
    idempotencyKey,
    resumePaused,
  } = parseArgs(process.argv);
  if (!process.env.DB_PATH) {
    process.stderr.write(
      'DB_PATH env var is required (path to the saga SQLite database).\n',
    );
    process.exit(2);
  }

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
    const inlineLifecycleInputJson =
      process.env.SAGA_PRODUCT_LIFECYCLE_INPUT_JSON?.trim()
        ? process.env.SAGA_PRODUCT_LIFECYCLE_INPUT_JSON
        : null;
    const resolvedLifecycleInputPath = lifecycleInputPath
      ?? process.env.SAGA_PRODUCT_LIFECYCLE_INPUT
      ?? null;
    const lifecycleInput = inlineLifecycleInputJson !== null
      ? JSON.parse(inlineLifecycleInputJson) as unknown
      : resolvedLifecycleInputPath
        ? JSON.parse(
          readFileSync(path.resolve(resolvedLifecycleInputPath), 'utf8'),
        ) as unknown
        : undefined;
    application = createSaga2Application(process.env, overrides);

    // CONVEYOR Wave 5 — start the watchman. The supervision service reconciles
    // durable worker executions on startup (catching orphans from a prior
    // runtime crash) and periodically while the conveyor is alive, returning
    // fenced cards from dead/zombie workers to their queues without operator
    // intervention. reconcileWorkerExecutions already existed but had no
    // production scheduling call — this is that call.
    const { startWorkerSupervision } = await import('./infrastructure/work/worker-supervision-service.js');
    const { SqliteExecutionRuntimeRepository } = await import('./infrastructure/persistence/sqlite-saga2-runtime-repositories.js');
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
      const result = await application.runEpisode({
        projectId,
        epicId,
        concurrency,
        lifecycleInput: isFirstCycle ? lifecycleInput : undefined,
        lifecycleInputSchema: isFirstCycle && lifecycleInput !== undefined
          ? 'saga3.product-delivery-lifecycle-input.v2'
          : undefined,
        idempotencyKey: idempotencyKey ?? undefined,
        resumePaused: !isFirstCycle || resumePaused,
        // On resume, read the original initiated_by from the lifecycle run
        // to avoid REPLAY_CONTEXT_MISMATCH.
        initiatedBy: (() => {
          if (process.env.SAGA_INITIATED_BY) return process.env.SAGA_INITIATED_BY;
          if (!isFirstCycle || resumePaused) {
            try {
              const row = getDb().prepare(
                'SELECT initiated_by FROM saga3_lifecycle_runs WHERE project_id=? AND epic_id=? ORDER BY id DESC LIMIT 1',
              ).get(projectId, epicId) as { initiated_by: string } | undefined;
              if (row?.initiated_by) return row.initiated_by;
            } catch { /* best effort */ }
          }
          return 'orchestrate-cli';
        })(),
      });
      lastResult = result;
      isFirstCycle = false;
      process.stdout.write(`[orchestrate-cli] cycle: ${JSON.stringify({ reason: result.reason, stage: result.finalStage })}\n`);
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
      // Distribute them to workers through the SAME WorkerExecutorFactory that
      // LM-node workers use — one spawn path, one desk, one mechanic.
      const { distributeQueuedTasks } = await import('./app/dispatch-loop.js');
      const { loadSagaRuntimeConfig } = await import('./runtime/saga-runtime-config.js');
      const dispatchConfig = loadSagaRuntimeConfig(process.env);
      const sagaEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
      const workspaceRoot = (() => {
        const row = getDb().prepare(
          'SELECT pr.local_path FROM project_repositories pr WHERE pr.project_id=? AND pr.status=? ORDER BY pr.id LIMIT 1',
        ).get(projectId, 'active') as { local_path: string } | undefined;
        return row?.local_path ?? process.cwd();
      })();
      // overrides.modulePackages IS the ProductionInstallation — use it to
      // create the same pinned factory that composition-root uses for LM nodes.
      const dispatched = await distributeQueuedTasks({
        projectId,
        epicId,
        concurrency,
        // Conveyor model: this application service owns dispatch and the
        // global concurrency budget. It atomically assigns each exact card
        // before constructing the worker process; the runner only hosts the
        // already-assigned worker and never searches the queue.
        workAssignment: new SqliteWorkAssignmentAdapter(getDb()),
        idGenerator: uuidIdGenerator,
        machineId: os.hostname(),
        workerExecutorFactory: overrides.workerExecutorFactory
          ?? createPinnedWorkerFactoryForDispatch(overrides.modulePackages),
        factoryContext: {
          projectId,
          epicId,
          workspaceRoot,
          dbPath: process.env.DB_PATH!,
          sagaEntry,
          sagaSkillRoot: process.cwd(),
          claudePath: process.env.SAGA_CLAUDE_PATH,
          logRoot: dispatchConfig.orchestrationLogRoot,
          heartbeatLog: dispatchConfig.orchestrationLogRoot
            ? path.join(dispatchConfig.orchestrationLogRoot, 'worker-heartbeat.log')
            : undefined,
          lmStudioUrl: dispatchConfig.lmStudioUrl,
        },
      });
            if (dispatched === 0) {
              // The queue drained to empty while the lifecycle is still paused.
              // This is NOT necessarily a stuck state: a worker may have just
              // completed a task (e.g. formalization's PRD node) whose
              // completion is what unblocks the NEXT lifecycle node (e.g. UC),
              // but that next task has not been projected into the kanban yet.
              // Calling runEpisode({resumePaused:true}) again advances the
              // lifecycle — either it projects the next task (loop continues)
              // or it returns non-paused (terminal) and we stop.
              //
              // Guard against a genuine stuck state (needs-human, unresolved
              // dependency, routing cycle): if the lifecycle has not progressed
              // for several consecutive empty-dispatch cycles, stop so the
              // operator can intervene instead of burning tokens forever.
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
              // Short backoff before re-checking, so we don't tight-loop the DB
              // when the lifecycle is genuinely idle.
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
    process.exit(result.reason === 'failed' ? 1 : 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[orchestrate-cli] fatal: ${msg}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
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
): Promise<Saga2CompositionOverrides> {
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

  // W13-AUDIT §18.5/§18.9: install the 4 production modules into the durable
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
  };
}

main().catch(err => {
  process.stderr.write(`[orchestrate-cli] unhandled: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
