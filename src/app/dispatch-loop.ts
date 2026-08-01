/**
 * Conveyor dispatch loop — distributes queued kanban tasks to workers.
 *
 * Called by orchestrate-cli between lifecycle resume cycles. When a ProcessRun
 * pauses (e.g. development settle-development waiting for impl tasks to drain),
 * the CLI invokes this to spawn workers that claim todo/review tasks through
 * the shared worker_next queue, execute, and merge. Once the queue is empty,
 * control returns to the CLI which resumes the lifecycle.
 *
 * Implementation: spawns `concurrency` Claude CLI child processes in parallel,
 * each as a saga-worker (one task = one launch). Waits for all to finish, then
 * checks the queue again. Repeats until empty.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db.js';

export interface DispatchLoopInput {
  projectId: number;
  epicId: number;
  concurrency: number;
  /** Absolute path to the claude CLI binary. */
  claudePath: string;
  /** Absolute path to the saga MCP server entry (dist/index.js). */
  sagaEntry: string;
  /** DB_PATH for child processes. */
  dbPath: string;
}

interface QueuedCounts {
  todo: number;
  review: number;
}

function countQueuedTasks(projectId: number): QueuedCounts {
  const db = getDb();
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN t.status='todo' THEN 1 ELSE 0 END) AS todo,
       SUM(CASE WHEN t.status='review' THEN 1 ELSE 0 END) AS review
     FROM tasks t
     JOIN epics e ON e.id = t.epic_id
     WHERE e.project_id = ?
       AND t.status IN ('todo','review')`,
  ).get(projectId) as { todo: number; review: number } | undefined;
  // Do NOT close db — getDb() returns a shared singleton managed by the app.
  return {
    todo: row?.todo ?? 0,
    review: row?.review ?? 0,
  };
}

/**
 * Spawn one Claude CLI worker process. The worker loads the saga MCP server,
 * claims one task via worker_next, executes it, and exits.
 */
function spawnWorker(
  input: DispatchLoopInput,
  workerId: string,
): Promise<{ workerId: string; code: number }> {
  return new Promise(resolve => {
    // Write MCP config to a temp file (claude CLI requires --mcp-config <path>).
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'saga-worker-'));
    const mcpConfigPath = path.join(tmpDir, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        saga: {
          command: 'node',
          args: [input.sagaEntry],
          env: { DB_PATH: input.dbPath },
        },
      },
    }, null, 2), 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DB_PATH: input.dbPath,
    };
    const child = spawn(
      input.claudePath,
      [
        '--print',
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
        '--allowedTools', 'mcp__saga__worker_next,mcp__saga__worker_done,mcp__saga__worker_merge_acquire,mcp__saga__worker_merge_release,mcp__saga__worker_ask_need,mcp__saga__task_get,mcp__saga__task_list,mcp__saga__comment_add,mcp__saga__note_save,mcp__saga__artifact_get,mcp__saga__artifact_list,mcp__saga__trace_list,mcp__saga__verification_record,Read,Write,Edit,Bash,Glob,Grep',
      ],
      {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
        windowsHide: true,
      },
    );
    // Send the prompt via stdin (claude --print reads prompt from stdin).
    const prompt = `You are saga-worker ${workerId} for project ${input.projectId} epic ${input.epicId}. Use the saga MCP tools. Call worker_next({ worker_id: '${workerId}', project_id: ${input.projectId} }) to claim one task. Read task_get to understand the assignment. Execute it fully: write code/review/verify as required, then call worker_done with a truthful summary. One task = one session. Exit after worker_done.`;
    child.stdin?.write(prompt);
    child.stdin?.end();
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('close', code => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      if (code !== 0) {
        process.stderr.write(`[dispatch] worker ${workerId} exited code=${code}: ${stderr.slice(-300)}\n`);
      } else if (stdout.length > 0) {
        process.stdout.write(`[dispatch] worker ${workerId} output: ${stdout.slice(-200)}\n`);
      }
      resolve({ workerId, code: code ?? 0 });
    });
    child.on('error', err => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      process.stderr.write(`[dispatch] worker ${workerId} spawn error: ${err.message}\n`);
      resolve({ workerId, code: 1 });
    });
  });
}

/**
 * Distribute queued tasks to workers. Returns the number of tasks dispatched.
 */
export async function distributeQueuedTasks(
  input: DispatchLoopInput,
): Promise<number> {
  let totalDispatched = 0;
  let round = 0;

  while (true) {
    round++;
    const counts = countQueuedTasks(input.projectId);
    const queued = counts.todo + counts.review;
    if (queued === 0) {
      process.stdout.write(
        `[dispatch] round ${round}: queue empty\n`,
      );
      break;
    }

    const workerCount = Math.min(input.concurrency, queued);
    process.stdout.write(
      `[dispatch] round ${round}: ${queued} queued (${counts.todo} todo, ${counts.review} review). Spawning ${workerCount} workers...\n`,
    );

    // Spawn N workers in parallel
    const workers: Promise<{ workerId: string; code: number }>[] = [];
    for (let i = 0; i < workerCount; i++) {
      const workerId = `dev-r${round}-${i + 1}`;
      workers.push(spawnWorker(input, workerId));
    }

    // Wait for all workers in this round
    const results = await Promise.all(workers);
    const succeeded = results.filter(r => r.code === 0).length;
    const failed = results.filter(r => r.code !== 0).length;

    // Count progress — a task moving from todo to review/in_progress is NOT
    // progress (it's still queued). Real progress is todo+review decreasing.
    // But a worker that converts todo→review is making progress (review tasks
    // will be picked up next round). Track completed tasks instead.
    const after = countQueuedTasks(input.projectId);
    const remaining = after.todo + after.review;
    const dispatched = queued - remaining;
    totalDispatched += Math.max(0, dispatched);

    process.stdout.write(
      `[dispatch] round ${round}: ${succeeded} ok, ${failed} failed, ${dispatched} tasks drained, ${after.todo + after.review} remaining\n`,
    );

    if (dispatched === 0 && failed > 0 && succeeded === 0) {
      process.stdout.write('[dispatch] all workers failed — stopping\n');
      break;
    }
    if (remaining === 0) {
      // Queue fully drained (all tasks done).
      break;
    }
    // If workers succeeded but tasks moved todo→review (not done yet), that's
    // fine — review tasks will be picked up next round (review-first queue).
    // Only stop if nothing happened at all.
    if (dispatched === 0 && succeeded === 0) {
      process.stdout.write('[dispatch] no progress — stopping\n');
      break;
    }
  }

  return totalDispatched;
}
