// tests/factory-contract/scenario-scripted-executor.mjs
//
// Test-only physical worker substitution behind the real WorkerExecutorFactory
// port. Process termination is interpreted by the SAME production finalizer as
// in-process replay: OS exit alone never fabricates semantic completion.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const execMod = await import(pathToFileURL(path.resolve('dist/worker-executions.js')).href);
const markExecutionRunning = execMod.markExecutionRunning;

const terminationMod = await import(
  pathToFileURL(path.resolve('dist/infrastructure/workers/worker-process-termination.js')).href
);
const finalizeManagedWorkerProcess = terminationMod.finalizeManagedWorkerProcess;

const dbMod = await import(pathToFileURL(path.resolve('dist/db.js')).href);
const openDb = dbMod.getDb;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    let lastError = null;

    const sagaEntry = path.resolve('dist/index.js');

    return {
      start(command) {
        const { assignment } = command;
        if (disposed) throw new Error('ScriptedWorkerExecutor: disposed');
        if (activeChild) throw new Error('ScriptedWorkerExecutor: already running');

        claimed++;
        startedAt = new Date().toISOString();
        lastError = null;
        let terminationHandled = false;

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

        if (!markExecutionRunning || !finalizeManagedWorkerProcess || !openDb) {
          throw new Error('SCRIPTED_EXECUTOR_LIFECYCLE_MISSING: production lifecycle primitive unavailable');
        }
        markExecutionRunning(
          context.dbPath, assignment.workerExecutionId, null, null,
          `scenario-${runId}`, new Date().toISOString(),
        );

        activeChild.stderr?.setEncoding('utf8');
        activeChild.stderr?.on('data', c => process.stderr.write(c));

        const finalize = ({ code = null, spawnFailure = false, reason }) => {
          if (terminationHandled) return;
          terminationHandled = true;
          try { if (existsSync(mcpConfigPath)) unlinkSync(mcpConfigPath); } catch {}
          process.env.DB_PATH = context.dbPath;
          try {
            const outcome = finalizeManagedWorkerProcess(openDb(), {
              taskId: Number(assignment.taskId),
              executionId: String(assignment.workerExecutionId),
              exitCode: code,
              reason,
              spawnFailure,
            });
            process.stderr.write(
              `[scenario-executor] finalizer: state=${outcome.executionState} ` +
              `semantic=${outcome.semanticCompletion} repair=${outcome.workplaceRepairRequested} ` +
              `released=${outcome.taskReleased} blocked=${outcome.blockedReason || '(none)'}\n`,
            );
            if (outcome.semanticCompletion) completed++;
            else failed++;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            failed++;
            process.stderr.write(`[scenario-executor] FATAL finalizer failure: ${lastError}\n`);
          }
          activeChild = null;
          finishedAt = new Date().toISOString();
        };

        activeChild.once('close', code => {
          process.stderr.write(`[scenario-executor] child closed: code=${code}\n`);
          finalize({
            code: code ?? 0,
            reason: code === 0
              ? 'scenario worker process exited'
              : `scenario worker process exited non-zero (${code})`,
          });
        });

        activeChild.once('error', error => {
          finalize({
            spawnFailure: true,
            reason: `scenario worker spawn failed: ${error.message}`,
          });
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
          completed, failed, claimed, last_error: lastError,
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
          completed, failed, claimed, last_error: lastError,
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