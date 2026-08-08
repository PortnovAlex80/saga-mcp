// tests/factory-contract/scenario-scripted-executor.mjs
//
// ScriptedWorkerExecutor that spawns the scenario dispatcher as a child process.
// Implements the same WorkerExecutor port as the production Claude executor.
// The child process communicates with saga via the real MCP protocol.
//
// This executor uses production lifecycle primitives (markExecutionRunning,
// releaseExecutionAtomically) — it does NOT invent its own lifecycle.
// AC-21: fails closed on all lifecycle operations.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Load production lifecycle primitives — same dist the factory uses
const execMod = await import(pathToFileURL(path.resolve('dist/worker-executions.js')).href);
const markExecutionRunning = execMod.markExecutionRunning;

const relMod = await import(pathToFileURL(path.resolve('dist/lifecycle/atomic-release.js')).href);
const releaseExecutionAtomically = relMod.releaseExecutionAtomically;

const dbMod = await import(pathToFileURL(path.resolve('dist/db.js')).href);
const openDb = dbMod.getDb;

// ConveyorRuntime — the Factory's authority for Workplace loop transitions.
// On crash (no worker_done), the scripted executor must advance the Workplace
// loop from 'running' to 'repair_wait' via releaseExecution({outcome:'crashed'}),
// mirroring what the production claude executor does in recoverAssignment.
const conveyorMod = await import(pathToFileURL(path.resolve('dist/application/conveyor-runtime.js')).href);
const ConveyorRuntime = conveyorMod.ConveyorRuntime;

// WorkplaceRef deserialization for ConveyorRuntime calls
const wpRefMod = await import(pathToFileURL(path.resolve('dist/process-modules/domain/workplace/workplace-ref.js')).href);
const deserializeWorkplaceRef = wpRefMod.deserializeWorkplaceRef;

const wpRepoMod = await import(pathToFileURL(path.resolve('dist/infrastructure/workplace/sqlite-workplace-repository.js')).href);
const SqliteWorkplaceRepository = wpRepoMod.SqliteWorkplaceRepository;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} opts
 * @param {string} opts.dispatcherPath - path to scenario-dispatcher.mjs
 * @param {string} [opts.scenariosPath] - path to scenario module (SAGA_SCENARIOS)
 * @param {string} [opts.invocationLogPath] - path to write invocation log
 */
export function createScriptedWorkerExecutorFactory(opts = {}) {
  const dispatcherPath = opts.dispatcherPath || path.join(__dirname, 'scenario-dispatcher.mjs');
  return (context) => {
    const runId = `scenario-${randomUUID().slice(0, 8)}`;
    let activeChild = null;
    let disposed = false;
    let completed = 0;
    let failed = 0;
    let claimed = 0;
    let startedAt = null;
    let finishedAt = null;

    const sagaEntry = path.resolve('dist/index.js');

    return {
      start(command) {
        const { assignment } = command;
        if (disposed) throw new Error('ScriptedWorkerExecutor: disposed');
        if (activeChild) throw new Error('ScriptedWorkerExecutor: already running');

        claimed++;
        startedAt = new Date().toISOString();

        // Write per-execution MCP config (same shape as production writeExecutionMcpConfig)
        const mcpConfigPath = path.join(os.tmpdir(), `saga-scenario-mcp-${randomUUID().slice(0, 8)}.json`);
        writeFileSync(mcpConfigPath, JSON.stringify({
          mcpServers: {
            saga: {
              type: 'stdio',
              command: 'node',
              args: [sagaEntry],
              env: {
                DB_PATH: context.dbPath,
                TRACKER_AUTOSTART: '0',
                SAGA_MANAGED_EXECUTION: '1',
                SAGA_EXECUTION_ID: assignment.workerExecutionId,
                SAGA_TASK_ID: String(assignment.taskId),
                SAGA_WORKER_ID: assignment.workerId,
              },
            },
          },
        }, null, 2));

        // Build prompt — same key=value format as buildPrompt
        const task = assignment;
        const prompt = [
          `project_id=${task.projectId}`,
          `task_id=${task.taskId}`,
          `worker_id=${task.workerId}`,
          `execution_id=${task.workerExecutionId}`,
          `role=author`,
          '',
          'You are a single-use Saga CLI worker.',
        ].join('\n');

        // Spawn the scenario dispatcher
        activeChild = spawn('node', [
          dispatcherPath,
          '-p', '--bare',
          '--mcp-config', mcpConfigPath,
          '--strict-mcp-config',
        ], {
          cwd: context.workspaceRoot || process.cwd(),
          env: {
            ...process.env,
            SAGA_EXECUTION_ID: assignment.workerExecutionId,
            SAGA_TASK_ID: String(assignment.taskId),
            SAGA_WORKER_ID: assignment.workerId,
            SAGA_RUN_ID: runId,
            SAGA_PROJECT_ID: String(assignment.projectId),
            ...(opts.scenariosPath ? { SAGA_SCENARIOS: opts.scenariosPath } : {}),
            ...(opts.invocationLogPath ? { SAGA_INVOCATION_LOG: opts.invocationLogPath } : {}),
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        activeChild.stdin.write(prompt);
        activeChild.stdin.end();

        // AC-21: fail closed — markExecutionRunning must succeed
        if (!markExecutionRunning) {
          throw new Error('SCRIPTED_EXECUTOR_LIFECYCLE_MISSING: markExecutionRunning unavailable');
        }
        markExecutionRunning(
          context.dbPath, assignment.workerExecutionId, null, null,
          `scenario-${runId}`, new Date().toISOString(),
        );

        activeChild.stderr?.setEncoding('utf8');
        activeChild.stderr?.on('data', c => process.stderr.write(c));

        activeChild.once('close', (code) => {
          process.stderr.write(`[scenario-executor] child closed: code=${code}\n`);
          try { if (existsSync(mcpConfigPath)) unlinkSync(mcpConfigPath); } catch {}

          // AC-21: fail closed — terminalization must succeed.
          // AC-28: if the worker exited WITHOUT calling worker_done (no accepted
          // receipt), the execution is treated as a crash/loss — NOT a normal
          // exit. releaseExecutionAtomically checks hasAcceptedWorkerDoneReceipt:
          //   - receipt exists → preserveTaskStatus=true (worker_done already set status)
          //   - no receipt → preserveTaskStatus=false → task restored to todo/blocked
          //     for requeue (the Factory's repair/recovery path).
          // We do NOT force preserveTaskStatus=true unconditionally — that would
          // mask crash scenarios and prevent the Factory from exercising repair.
          if (!releaseExecutionAtomically || !openDb) {
            throw new Error('SCRIPTED_EXECUTOR_LIFECYCLE_MISSING: releaseExecutionAtomically unavailable');
          }
          try {
            process.env.DB_PATH = context.dbPath;
            const db = openDb();
            // Check if worker_done was accepted for this execution
            const hasReceipt = db.prepare(
              `SELECT 1 FROM command_receipts WHERE execution_id=? AND command_kind='worker_done' AND accepted=1 LIMIT 1`,
            ).get(assignment.workerExecutionId);

            // CRASH PATH: if no worker_done receipt, the worker crashed.
            // The production claude executor does TWO things on crash:
            //   1. ConveyorRuntime.releaseExecution({outcome:'crashed'}) — advances
            //      Workplace running → repair_wait
            //   2. releaseExecutionAtomically({terminalState:'lost'}) — terminalizes
            //      the execution row and restores the task to todo for requeue
            // We mirror both steps so the Factory's repair/recovery path works.
            if (!hasReceipt) {
              // Step 1: advance the Workplace loop to repair_wait (if the
              // workplace is in leased/running and we hold the reservation).
              const taskRow = db.prepare(
                'SELECT workplace_ref FROM tasks WHERE id=?',
              ).get(assignment.taskId);
              if (taskRow?.workplace_ref) {
                try {
                  const wpRef = deserializeWorkplaceRef(taskRow.workplace_ref);
                  const wpRepo = new SqliteWorkplaceRepository(db);
                  const wpState = wpRepo.read(wpRef);
                  const actors = wpRepo.readActiveActors(wpRef);
                  if (
                    wpState
                    && (wpState.loopState === 'leased' || wpState.loopState === 'running')
                    && actors?.activeReservationRef === assignment.workerExecutionId
                  ) {
                    new ConveyorRuntime(db).releaseExecution({
                      workplaceRef: wpRef,
                      reservationRef: assignment.workerExecutionId,
                      taskId: assignment.taskId,
                      outcome: 'crashed',
                    });
                    process.stderr.write(`[scenario-executor] workplace advanced to repair_wait (crash)\n`);
                  }
                } catch (e) {
                  process.stderr.write(`[scenario-executor] workplace crash-release skipped: ${e.message}\n`);
                }
              }
            }

            // Step 2: terminalize the execution row.
            const outcome = releaseExecutionAtomically(db, {
              executionId: assignment.workerExecutionId,
              terminalState: hasReceipt ? 'exited' : 'lost',
              exitCode: code ?? 0,
              reason: hasReceipt
                ? 'scenario worker completed with worker_done'
                : (code === 0
                  ? 'scenario worker exited without worker_done (crash simulation)'
                  : 'scenario worker exited non-zero (failure simulation)'),
              preserveTaskStatus: Boolean(hasReceipt),
            });
            process.stderr.write(
              `[scenario-executor] release: terminalized=${outcome.terminalized} ` +
              `taskReleased=${outcome.taskReleased} status=${outcome.restoredStatus} ` +
              `blocked=${outcome.blockedReason || '(none)'} ` +
              `hasReceipt=${Boolean(hasReceipt)}\n`,
            );
          } catch (e) {
            process.stderr.write(`[scenario-executor] FATAL release failure: ${e.message}\n`);
            throw e;
          }

          activeChild = null;
          finishedAt = new Date().toISOString();
          if (code === 0) completed++; else failed++;
        });

        return {
          id: runId,
          project_id: task.projectId,
          concurrency: 1,
          status: 'running',
          started_at: startedAt,
          finished_at: null,
          active: [{
            task_id: task.taskId,
            worker_id: task.workerId,
            pid: activeChild.pid,
            started_at: startedAt,
          }],
          completed, failed, claimed, last_error: null,
        };
      },

      stop() {
        if (activeChild) { try { activeChild.kill('SIGTERM'); } catch {} }
        return null;
      },

      status(projectId) {
        if (!activeChild && !startedAt) return null;
        return {
          id: runId,
          project_id: projectId,
          concurrency: 1,
          status: activeChild ? 'running' : (failed > 0 ? 'failed' : 'completed'),
          started_at: startedAt,
          finished_at: finishedAt,
          active: activeChild ? [{ task_id: null, worker_id: null, pid: activeChild.pid }] : [],
          completed, failed, claimed, last_error: null,
        };
      },

      setConcurrency() {},
      dispose() {
        disposed = true;
        if (activeChild) { try { activeChild.kill('SIGTERM'); } catch {} activeChild = null; }
      },
    };
  };
}
