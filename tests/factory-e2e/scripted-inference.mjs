// tests/factory-e2e/scripted-inference.mjs
//
// The W9 fresh-harness SCRIPTED INFERENCE double — a WorkerExecutorFactory
// that runs scripted worker scenarios ENTIRELY IN-PROCESS. This is the
// deterministic-friendly replacement for the spawn-based scenario executor in
// tests/factory-contract/scenario-scripted-executor.mjs.
//
// Why in-process (no spawn):
//   The golden-path harness is flaky because it spawns orchestrate-cli AND a
//   scenario-dispatcher child per worker, then relies on replay-capsule base
//   matching. This double removes every child-process boundary: it calls the
//   SAME production MCP tool handlers (product_submit / artifact_create /
//   trace_add / worker_done) the capsule-replay executor calls, then the SAME
//   production finalizer (finalizeManagedWorkerProcess). Semantic completion is
//   still determined by the durable accepted worker_done receipt — never
//   fabricated by the double.
//
// What stays production (the double touches NONE of these):
//   - WorkAssignmentPort (atomic card assignment + fence)
//   - desk / workspace provisioning
//   - MCP authority + command receipts
//   - finalizeManagedWorkerProcess (the one authoritative termination read)
//   - gates, CandidateSets, effects, lifecycle routing
//
// Authority discipline:
//   The double only READS the task row (module/role) to pick a scripted
//   handler. It never writes to authority tables, never binds submission.task_id,
//   never uses recency. Task identity emerges from the accepted-authority head.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const execMod = await import(pathToFileURL(path.resolve('dist/worker-executions.js')).href);
const markExecutionRunning = execMod.markExecutionRunning;

const terminationMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/workers/worker-process-termination.js')).href
);
const finalizeManagedWorkerProcess = terminationMod.finalizeManagedWorkerProcess;

const deskBaseMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/workers/effective-desk-base.js')).href
);
const resolveEffectiveDeskBase = deskBaseMod.resolveEffectiveDeskBase;

const dbMod = await import(pathToFileURL(path.resolve('dist/db.js')).href);

const productHandlersMod = await import(pathToFileURL(path.resolve('dist/tools/products.js')).href);
const artifactHandlersMod = await import(pathToFileURL(path.resolve('dist/tools/artifacts.js')).href);
const dispatcherHandlersMod = await import(pathToFileURL(path.resolve('dist/tools/dispatcher.js')).href);
const replayExecMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/replay/capsule-replay-executor.js')).href
);
const executeCapsuleReplay = replayExecMod.executeCapsuleReplay;

// W1-2 (CONVEYOR §16): replay-first is a property of every normal factory
// assignment — when the production claim path binds a frozen capsule_ref to
// this execution, the canonical fast lane replays the capsule through the
// PRODUCTION executor + MCP handler surface instead of running a scripted
// worker. Zero scripted inference calls on compatible hits, exactly like the
// spawn-based executor.
function hasFrozenCapsule(assignment) {
  const ctx = assignment?.executionContext;
  if (!ctx || typeof ctx !== 'object') return false;
  const replay = ctx.replay;
  return !!replay && typeof replay.capsule_ref === 'string' && replay.capsule_ref.length > 0;
}

function runFrozenCapsuleReplay(context, assignment) {
  const db = dbMod.getDb();
  process.env.DB_PATH = context.dbPath;
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = assignment.workerExecutionId;
  process.env.SAGA_TASK_ID = String(assignment.taskId);
  process.env.SAGA_WORKER_ID = assignment.workerId;
  try {
    db.prepare(
      `UPDATE worker_executions SET state='running', started_at=datetime('now'), phase_updated_at=datetime('now') WHERE execution_id=? AND state='reserved'`,
    ).run(assignment.workerExecutionId);
    const handlers = {
      product_submit: input => productHandlersMod.handlers.product_submit(input),
      artifact_create: input => artifactHandlersMod.handlers.artifact_create(input),
      trace_add: input => artifactHandlersMod.handlers.trace_add(input),
      worker_done: input => dispatcherHandlersMod.handlers.worker_done(input),
    };
    try {
      executeCapsuleReplay(db, handlers, {
        taskId: Number(assignment.taskId),
        workerId: assignment.workerId,
        executionId: assignment.workerExecutionId,
        cwd: context.workspaceRoot,
      });
      // The reference executor (scenario-scripted-executor.mjs) completes the
      // semantic lifecycle AFTER the replay: worker_done under the execution
      // fence, then the process state flips to exited. Without this the task
      // stays in_progress forever and the lifecycle never settles (the W1-2
      // run-B stall).
      handlers.worker_done({
        task_id: Number(assignment.taskId),
        worker_id: assignment.workerId,
        result: 'capsule replay: reconstructed accepted worker production',
        execution_id: assignment.workerExecutionId,
      });
      db.prepare(
        `UPDATE worker_executions SET state='exited', exit_code=0, finished_at=datetime('now'), phase_updated_at=datetime('now') WHERE execution_id=? AND state IN ('running','finishing')`,
      ).run(assignment.workerExecutionId);
    } catch (replayError) {
      // A failed replay MUST terminalize the execution ('lost'), exactly like
      // a crashed spawned worker: the capsule is already marked ineligible by
      // the production binder, so the NEXT execution resolves as an ordinary
      // miss and runs its selected route. Leaving the row 'running' would
      // stall the whole lifecycle (observed in the W1-2 drive).
      db.prepare(
        `UPDATE worker_executions SET state='lost', exit_code=1, finished_at=datetime('now'), phase_updated_at=datetime('now') WHERE execution_id=? AND state IN ('running','finishing')`,
      ).run(assignment.workerExecutionId);
      throw replayError;
    }
  } finally {
    delete process.env.SAGA_MANAGED_EXECUTION;
    delete process.env.SAGA_EXECUTION_ID;
    delete process.env.SAGA_TASK_ID;
    delete process.env.SAGA_WORKER_ID;
  }
}

/**
 * A concurrency + invocation tracker the harness reads to PROVE the cap held.
 * The scripted executor bumps active on start and decrements on finalize; the
 * high-water mark is the observable concurrency the self-test asserts against.
 */
export function createScriptedObserver() {
  let active = 0;
  let maxConcurrency = 0;
  let invocations = 0;
  let replays = 0;
  const outcomes = [];
  return {
    onStart() {
      active += 1;
      invocations += 1;
      if (active > maxConcurrency) maxConcurrency = active;
    },
    onEnd(outcome) {
      active -= 1;
      outcomes.push(outcome);
    },
    // W1-2: a capsule replay is NOT a scripted inference — the observer
    // counts it separately so zero-call replay authority is provable.
    onReplay() {
      replays += 1;
    },
    getMaxConcurrency: () => maxConcurrency,
    getInvocationCount: () => invocations,
    getReplayCount: () => replays,
    getActive: () => active,
    getOutcomes: () => outcomes.slice(),
  };
}

function readTaskMetadata(db, taskId) {
  const row = db.prepare(
    'SELECT id,workplace_ref,task_kind,metadata FROM tasks WHERE id=?',
  ).get(Number(taskId));
  if (!row) return { module: 'unknown', node: 'unknown', cell: 'unknown', role: 'author', workKey: 'singleton', taskKind: '', workplaceRef: null };
  let meta = {};
  try {
    meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {});
  } catch { meta = {}; }
  return {
    ...meta,
    module: meta.process_module_ref || 'unknown',
    node: meta.process_node_id || 'unknown',
    cell: meta.production_cell_id || 'unknown',
    role: meta.role || 'author',
    workKey: meta.work_key || meta.cell_input_item?.key || 'singleton',
    taskKind: row.task_kind || '',
    workplaceRef: row.workplace_ref || null,
  };
}

/**
 * Build the scenario key string (stable + cross-run, like scenarioKey()).
 * W9-02/W9-03 resolve concrete handlers by this key.
 */
export function scriptedScenarioKey(meta) {
  return `${meta.module}/${meta.node}/${meta.role}/${meta.workKey}`;
}

/**
 * The DEFAULT minimal scripted handler for the harness SELF-TEST.
 *
 * It calls worker_done through the production handler. Whether production
 * accepts the receipt (semantic completion) or rejects it (the cell may
 * require a prior product) is determined by PRODUCTION — the double never
 * fabricates completion. The self-test asserts MACHINERY (invocation, cap,
 * no stranded executions), not lifecycle convergence (that is W9-02's job).
 *
 * Handlers MUST be synchronous: the production MCP handlers are synchronous
 * (better-sqlite3), and the in-process executor completes the whole worker
 * lifecycle inside start() so the dispatch loop observes a terminal snapshot
 * on its first status() poll.
 *
 * W9-02/W9-03 supply richer handlers via the `handlers` map keyed by
 * scriptedScenarioKey(); this default is the fall-through.
 */
function defaultHandler({ handlers, assignment }) {
  const taskId = Number(assignment.taskId);
  const workerId = assignment.workerId;
  const executionId = assignment.workerExecutionId;
  try {
    handlers.worker_done({
      task_id: taskId,
      worker_id: workerId,
      execution_id: executionId,
      result: 'fresh-harness scripted worker_done (default self-test handler)',
    });
    return { kind: 'worker-done-accepted' };
  } catch (error) {
    // Production rejected worker_done (e.g. PRODUCTION_CELL_PRODUCT_REQUIRED).
    // This is EXPECTED for the minimal self-test handler — the production
    // finalizer will classify the execution as lost and enter crash repair.
    // The double records the rejection; it does NOT fabricate completion.
    return { kind: 'worker-done-rejected', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Create an IN-PROCESS scripted WorkerExecutorFactory.
 *
 * @param {object} opts
 * @param {ReturnType<typeof createScriptedObserver>} opts.observer
 *   Concurrency/invocation tracker the harness reads.
 * @param {Record<string, (ctx: object) => Promise<object>>} [opts.handlers]
 *   Map of scriptedScenarioKey() → async handler. The handler receives
 *   { handlers, assignment, meta, db, scenarioKey } and may call the production
 *   MCP handlers (product_submit / artifact_create / trace_add / worker_done).
 *   A '*' wildcard is the global fallback.
 * @param {object} [opts.crashPoint]
 *   Optional deterministic crash point for W9-03: { scenarioKeyPrefix, atInvocation, effect }.
 *   When the matching invocation is reached, the worker exits without worker_done
 *   (exit-without-done) or throws (exit-nonzero) — never fabricating completion.
 */
export function createInProcessScriptedExecutorFactory(opts = {}) {
  const observer = opts.observer ?? createScriptedObserver();
  const userHandlers = opts.handlers ?? {};
  const crashPoint = opts.crashPoint ?? null;

  return function scriptedExecutorFactory(context) {
    const runId = `fresh-scripted-${Math.random().toString(36).slice(2, 10)}`;
    let disposed = false;
    let current = null;

    function runScriptedWorker(assignment) {
      observer.onStart();
      const db = dbMod.getDb();
      const meta = readTaskMetadata(db, assignment.taskId);
      const scenarioKey = scriptedScenarioKey(meta);

      const handlerSet = {
        product_submit: input => productHandlersMod.handlers.product_submit(input),
        product_read: input => productHandlersMod.handlers.product_read(input),
        candidate_read: input => productHandlersMod.handlers.candidate_read(input),
        artifact_create: input => artifactHandlersMod.handlers.artifact_create(input),
        trace_add: input => artifactHandlersMod.handlers.trace_add(input),
        worker_done: input => dispatcherHandlersMod.handlers.worker_done(input),
      };

      const saved = {
        SAGA_MANAGED_EXECUTION: process.env.SAGA_MANAGED_EXECUTION,
        SAGA_EXECUTION_ID: process.env.SAGA_EXECUTION_ID,
        SAGA_TASK_ID: process.env.SAGA_TASK_ID,
        SAGA_WORKER_ID: process.env.SAGA_WORKER_ID,
        DB_PATH: process.env.DB_PATH,
      };
      process.env.DB_PATH = context.dbPath;
      process.env.SAGA_MANAGED_EXECUTION = '1';
      process.env.SAGA_EXECUTION_ID = assignment.workerExecutionId;
      process.env.SAGA_TASK_ID = String(assignment.taskId);
      process.env.SAGA_WORKER_ID = assignment.workerId;

      // markExecutionRunning through the production primitive (same call the
      // spawn-based executor makes). pid=null + token=null is legal for an
      // in-process worker (the primitive only requires a birth token when a
      // real pid is supplied).
      markExecutionRunning(
        context.dbPath,
        assignment.workerExecutionId,
        null,
        null,
        `fresh-scripted:${runId}`,
        new Date().toISOString(),
      );

      // For git_change tasks, resolve the effective desk base (same as the
      // spawn-based executor). This creates the factory_effective_desk_base_receipts
      // row the implementation scope check requires. Without it, the check fails
      // with submission-binding-invalid. The in-process worker commits directly
      // in the repo (no worktree), but the desk base receipt is still needed.
      try {
        const taskRow = db.prepare(
          'SELECT id,workplace_ref,execution_mode,project_repository_id,status,metadata FROM tasks WHERE id=?',
        ).get(Number(assignment.taskId));
        if (taskRow && taskRow.execution_mode === 'git_change' && taskRow.project_repository_id) {
          const repoRow = db.prepare(
            `SELECT pr.id, pr.local_path, pr.integration_branch
               FROM project_repositories pr WHERE pr.id=? AND pr.status='active'`,
          ).get(taskRow.project_repository_id);
          if (repoRow && repoRow.local_path) {
            resolveEffectiveDeskBase(db, {
              executionRef: assignment.workerExecutionId,
              task: taskRow,
              repository: {
                id: repoRow.id,
                integrationBranch: repoRow.integration_branch || 'dev',
                repositoryRoot: repoRow.local_path,
              },
            });
          }
        }
      } catch (deskErr) {
        // Non-fatal: if the desk base can't be resolved (e.g. dependency not yet
        // integrated), let the handler proceed; the gate will report the issue.
      }

      let outcome;
      try {
        // Deterministic crash point (W9-03). Fire BEFORE the handler runs so the
        // production finalizer sees no accepted worker_done receipt → lost exec.
        if (
          crashPoint
          && scenarioKey.startsWith(crashPoint.scenarioKeyPrefix)
          && observer.getInvocationCount() === crashPoint.atInvocation
        ) {
          if (crashPoint.effect === 'exit-nonzero') {
            throw new Error(`FRESH_HARNESS_DETERMINISTIC_CRASH: ${crashPoint.name}`);
          }
          // exit-without-done: return without calling worker_done.
          outcome = { kind: 'exit-without-done', crashPoint: crashPoint.name };
        } else {
          const handler =
            userHandlers[scenarioKey]
            || userHandlers[`${meta.module}/${meta.node}/${meta.role}/*`]
            || userHandlers['*']
            || defaultHandler;
          outcome = handler({ handlers: handlerSet, assignment, meta, db, scenarioKey, context });
          if (outcome && typeof outcome.then === 'function') {
            throw new Error(
              'FRESH_HARNESS_ASYNC_HANDLER_UNSUPPORTED: in-process scripted handlers must be '
              + 'synchronous (the production MCP handlers are synchronous).',
            );
          }
        }
      } catch (error) {
        outcome = {
          kind: 'exit-nonzero',
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        // Restore env so the executor does not leak worker-scoped env into the
        // next dispatch round or the harness process.
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }

      // The production finalizer is the SINGLE authoritative termination read.
      // It determines semantic completion from the durable accepted worker_done
      // receipt — the double never overrides it.
      let finalizeOutcome;
      try {
        process.env.DB_PATH = context.dbPath;
        const liveDb = dbMod.getDb();
        finalizeOutcome = finalizeManagedWorkerProcess(liveDb, {
          taskId: Number(assignment.taskId),
          executionId: String(assignment.workerExecutionId),
          exitCode: outcome?.kind === 'exit-nonzero' ? 1 : 0,
          reason: outcome?.kind === 'exit-without-done'
            ? 'scripted worker exited without worker_done (deterministic crash point)'
            : outcome?.kind === 'exit-nonzero'
              ? `scripted worker failure: ${outcome.reason}`
              : 'scripted worker process exited',
          spawnFailure: false,
        });
      } catch (error) {
        finalizeOutcome = {
          semanticCompletion: false,
          executionState: 'lost',
          workplaceRepairRequested: false,
          taskReleased: false,
          blockedReason: error instanceof Error ? error.message : String(error),
        };
      }
      observer.onEnd({ scenarioKey, outcome, finalizeOutcome });
      return finalizeOutcome;
    }

    return {
      start(command) {
        if (disposed) throw new Error('FreshScriptedExecutor: disposed');
        if (current) throw new Error('FreshScriptedExecutor: already running');
        const { assignment } = command;
        // W1-2 replay-first: a frozen capsule on the assignment replays
        // through the PRODUCTION capsule executor (no scripted inference).
        if (hasFrozenCapsule(assignment)) {
          observer.onReplay();
          let replayBlockedReason = null;
          try {
            runFrozenCapsuleReplay(context, assignment);
          } catch (error) {
            replayBlockedReason = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[fresh-scripted] capsule replay FAILED: ${replayBlockedReason}
`);
          }
          const ok = replayBlockedReason === null;
          current = {
            assignment,
            finalizeOutcome: {
              semanticCompletion: ok,
              executionState: ok ? 'completed' : 'lost',
              workplaceRepairRequested: !ok,
              taskReleased: !ok,
              blockedReason: replayBlockedReason,
            },
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
          return {
            id: runId,
            project_id: assignment.projectId,
            concurrency: 1,
            status: 'completed',
            started_at: current.startedAt,
            finished_at: current.finishedAt,
            active: [],
            completed: ok ? 1 : 0,
            failed: ok ? 0 : 1,
            claimed: 1,
            last_error: replayBlockedReason,
          };
        }
        // The scripted worker runs SYNCHRONOUSLY here. The production handlers
        // are synchronous (SQLite), so the entire worker lifecycle — markRunning,
        // scenario handler, finalize — completes before start() returns. The
        // dispatch loop then observes a terminal snapshot on its first poll.
        const finalizeOutcome = runScriptedWorker(assignment);
        current = {
          assignment,
          finalizeOutcome,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        return {
          id: runId,
          project_id: assignment.projectId,
          concurrency: 1,
          status: 'completed',
          started_at: current.startedAt,
          finished_at: current.finishedAt,
          active: [],
          completed: finalizeOutcome.semanticCompletion ? 1 : 0,
          failed: finalizeOutcome.semanticCompletion ? 0 : 1,
          claimed: 1,
          last_error: finalizeOutcome.blockedReason || null,
        };
      },
      stop() {
        current = null;
        return null;
      },
      status() {
        if (!current) return null;
        const f = current.finalizeOutcome;
        return {
          id: runId,
          project_id: current.assignment.projectId,
          concurrency: 1,
          status: 'completed',
          started_at: current.startedAt,
          finished_at: current.finishedAt,
          active: [],
          completed: f.semanticCompletion ? 1 : 0,
          failed: f.semanticCompletion ? 0 : 1,
          claimed: 1,
          last_error: f.blockedReason || null,
        };
      },
      setConcurrency() {},
      dispose() {
        disposed = true;
        current = null;
      },
    };
  };
}
