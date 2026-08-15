/**
 * ScriptedWorkerExecutor — реализует WorkerExecutor порт.
 *
 * Не трогает production код. Внедряется через overrides.workerExecutorFactory
 * в createFactoryApplication. Ядро и оркестр не знают о подмене.
 *
 * Spawn'ит dispatcher.mjs вместо claude CLI. Тот же argv (--mcp-config),
 * тот же stdin (prompt), тот же spawn/close lifecycle.
 *
 * Документ §8: "No new executor_kind literal. No SAGA_SIM_* / mock / hybrid
 * environment switches." — этот код живёт в tests/, production не импортирует.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Pre-import production lifecycle primitives (same dist the factory uses).
let markExecutionRunning = null;
let releaseExecutionAtomically = null;
let openDb = null;
try {
  const execMod = await import(pathToFileURL(path.resolve('dist/worker-executions.js')).href);
  markExecutionRunning = execMod.markExecutionRunning;
} catch { /* not available */ }
try {
  const relMod = await import(pathToFileURL(path.resolve('dist/lifecycle/atomic-release.js')).href);
  releaseExecutionAtomically = relMod.releaseExecutionAtomically;
} catch { /* not available */ }
try {
  const dbMod = await import(pathToFileURL(path.resolve('dist/db.js')).href);
  openDb = dbMod.getDb;
} catch { /* not available */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {import('../../dist/application/ports/worker-executor.js').WorkerExecutorFactoryContext} context
 * @returns {import('../../dist/application/ports/worker-executor.js').WorkerExecutor}
 */
export function createScriptedWorkerExecutorFactory() {
  return (context) => {
    const runId = `scripted-${randomUUID().slice(0, 8)}`;
    let activeChild = null;
    let activeWorkerId = null;
    let disposed = false;
    let completed = 0;
    let failed = 0;
    let claimed = 0;
    let startedAt = null;
    let finishedAt = null;

    const sagaEntry = path.resolve('dist/index.js');
    const dispatcherPath = path.join(__dirname, 'dispatcher.mjs');

    return {
      start(command) {
        const { assignment } = command;
        if (disposed) throw new Error('ScriptedWorkerExecutor: disposed');
        if (activeChild) throw new Error('ScriptedWorkerExecutor: already running');

        claimed++;
        startedAt = new Date().toISOString();
        activeWorkerId = assignment.workerId;

        // Write per-execution MCP config (same shape as claude-runner writeExecutionMcpConfig)
        const mcpConfigPath = path.join(os.tmpdir(), `saga-scripted-mcp-${randomUUID().slice(0, 8)}.json`);
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

        // Spawn dispatcher — same lifecycle as claude spawn
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
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Feed prompt through stdin
        activeChild.stdin.write(prompt);
        activeChild.stdin.end();

        // Mark execution as running (same as markExecutionRunning in production).
        // Without this, product_submit fence-check sees state='reserved' and rejects.
        // AC-21: fail closed — infrastructure lifecycle failures must not be swallowed.
        if (!markExecutionRunning) {
          throw new Error('SCRIPTED_EXECUTOR_LIFECYCLE_MISSING: markExecutionRunning unavailable');
        }
        markExecutionRunning(
          context.dbPath, assignment.workerExecutionId, null, null,
          `scripted-${runId}`, new Date().toISOString(),
        );

        // Log stdout/stderr (diagnostic)
        const logDir = context.logRoot || path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
        const logFile = path.join(logDir, runId, `task-${assignment.taskId}-${assignment.workerId}.jsonl`);
        try {
          mkdirSync(path.dirname(logFile), { recursive: true });
          const logStream = createWriteStream(logFile, { flags: 'a' });
          activeChild.stdout?.pipe(logStream, { end: false });
          activeChild.stderr?.pipe(logStream, { end: false });
        } catch { /* best effort */ }

        activeChild.once('close', (code) => {
          process.stderr.write(`[scripted-executor] child closed: code=${code}\n`);
          try { if (existsSync(mcpConfigPath)) unlinkSync(mcpConfigPath); } catch {}

          // Terminalize the durable execution row. Mirrors what production
          // claude-runner does in its close callback (markExecutionExited) and
          // what in-process replay does (finalizeReplaySuccess). Without this,
          // orchestrate-cli's outer loop sees worker_executions.state still in
          // ('reserved','running','cancel_requested') and waits forever, while
          // the supervision reaper eventually marks it 'lost'. We preserve the
          // task status because worker_done already set the Workplace-derived
          // projection (two-channel model — Kanban reflects gate outcome).
          // AC-21: fail closed — lifecycle terminalization failures must surface.
          if (!releaseExecutionAtomically || !openDb) {
            throw new Error('SCRIPTED_EXECUTOR_LIFECYCLE_MISSING: releaseExecutionAtomically unavailable');
          }
          try {
            process.env.DB_PATH = context.dbPath;
            const db = openDb();
            const outcome = releaseExecutionAtomically(db, {
              executionId: assignment.workerExecutionId,
              terminalState: 'exited',
              exitCode: code ?? 0,
              reason: code === 0
                ? 'scripted worker exited normally'
                : 'scripted worker exited non-zero',
              preserveTaskStatus: true,
            });
            process.stderr.write(
              `[scripted-executor] release: terminalized=${outcome.terminalized} ` +
              `taskReleased=${outcome.taskReleased} status=${outcome.restoredStatus} ` +
              `blocked=${outcome.blockedReason || '(none)'}\n`,
            );
          } catch (e) {
            // The execution terminalization failed — this is an infrastructure
            // contract violation. Surface it loudly; the test must fail.
            process.stderr.write(`[scripted-executor] FATAL release failure: ${e.message}\n`);
            throw e;
          }

          activeChild = null;
          finishedAt = new Date().toISOString();
          if (code === 0) {
            completed++;
          } else {
            failed++;
          }
        });

        activeChild.once('error', (err) => {
          process.stderr.write(`[scripted-executor] child error: ${err.message}\n`);
          activeChild = null;
          failed++;
        });

        // Capture stderr for diagnostics
        activeChild.stderr?.setEncoding('utf8');
        activeChild.stderr?.on('data', c => process.stderr.write(c));

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
          completed,
          failed,
          claimed,
          last_error: null,
        };
      },

      stop(projectId) {
        if (activeChild) {
          try { activeChild.kill('SIGTERM'); } catch {}
        }
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
          active: activeChild ? [{
            task_id: null,
            worker_id: activeWorkerId,
            pid: activeChild.pid,
          }] : [],
          completed,
          failed,
          claimed,
          last_error: null,
        };
      },

      setConcurrency(projectId, concurrency) {
        // Always 1 — one card at a time, same as dispatch-loop expects
      },

      dispose() {
        disposed = true;
        if (activeChild) {
          try { activeChild.kill('SIGTERM'); } catch {}
          activeChild = null;
        }
      },
    };
  };
}
