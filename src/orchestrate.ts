/**
 * saga-mcp 3.0 — Autonomous Orchestration Engine (ADR-008, plan §1).
 *
 * The v2 model: a main-context agent (saga-orchestrator skill) drives the
 * flow by calling saga tools. It CAN bypass saga (AutoCad3D proved).
 *
 * The v3 model: a dumb pump loop. It cannot bypass saga. It only:
 *   1. Spawns workers for current claimable tasks (via ClaudeBoardRunner).
 *   2. When the queue is empty, asks workflow_generate_next to seed more.
 *   3. When no more tasks can be generated, attempts episode_transition.
 *   4. If a hard gate fails, flags needs-human and pauses until resumed.
 *
 * The engine runs as a background process (see orchestrate-cli.ts). It shares
 * the saga SQLite DB with tracker-view's HTTP server but does NOT depend on
 * it — both processes can run concurrently against the same DB file (SQLite
 * serialises writers via BEGIN IMMEDIATE, dispatcher.ts:37).
 *
 * This module is ADDITIVE (plan §Feature flag): under SAGA_ORCHESTRATION_MODE=v2
 * nothing here is imported or executed. v2 behaviour is unchanged.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeBoardRunner } from '../tracker-view/claude-runner.mjs';
import { getDb, closeDb } from './db.js';
import { generateNextForCompletedTask } from './tools/workflow.js';
import { handlers as lifecycleHandlers } from './tools/lifecycle.js';
import { handlers as dispatcherHandlers } from './tools/dispatcher.js';
import { handlers as projectHandlers } from './tools/projects.js';
import { logActivity } from './helpers/activity-logger.js';

/**
 * Episode stage → next stage (mirror of lifecycle.ts NEXT, kept local to avoid
 * importing a non-exported const). If lifecycle.STAGES changes, update this.
 */
const NEXT_STAGE: Record<string, string | undefined> = {
  discovery: 'formalization',
  formalization: 'planning',
  planning: 'development',
  development: 'verification',
  verification: 'integration',
  integration: 'completed',
};

/** Pause cap: if the engine sits in needs-human for longer than this, exit. */
const MAX_PAUSE_MIN = 24 * 60; // 24h — engine exits, user can restart it.
/** Polling interval for needs-human resume signal. */
const RESUME_POLL_MS = 10_000;
/** Max consecutive empty pump cycles before the engine declares the run done. */
const MAX_EMPTY_CYCLES = 3;
/** Wait between pump cycles when workers are still active. */
const PUMP_TICK_MS = 5_000;

// ESM does not define __dirname; derive it once from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface OrchestrateOptions {
  projectId: number;
  epicId: number;
  concurrency?: number;
  claudePath?: string;
  sagaEntry?: string;
  sagaSkillRoot?: string;
  logRoot?: string;
  heartbeatLog?: string;
  /** Injectable for tests; defaults to node child_process.spawn. */
  spawn?: typeof nodeSpawn;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface OrchestrateResult {
  projectId: number;
  epicId: number;
  finalStage: string;
  endedAt: string;
  reason: 'completed' | 'failed' | 'paused_timeout' | 'stopped';
  cycles: number;
  lastError: string | null;
}

/**
 * Heartbeat line written to the engine log on every cycle boundary. Format
 * matches claude-runner.mjs heartbeat (line ~100): one line per event, plain
 * text, parseable by `tail -f`.
 */
function engineHeartbeat(opts: OrchestrateOptions, event: string, message: string, now = Date.now): void {
  const line = [
    new Date(now()).toISOString(),
    `engine project=${opts.projectId} epic=${opts.epicId}`,
    event,
    message,
  ].join(' ').replace(/\s+/g, ' ').trim() + '\n';
  const logPath = opts.heartbeatLog
    ?? path.join(os.homedir(), '.zcode', 'cli', 'engine-heartbeat.log');
  try { appendFileSync(logPath, line); } catch { /* log not critical */ }
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Returns the current episode stage, or null if the episode has no workflow row.
 * Mirrors lifecycle.ts:getOrCreate without the INSERT side effect.
 */
function currentStage(epicId: number): string | null {
  const row = getDb().prepare('SELECT stage FROM episode_workflows WHERE epic_id=?').get(epicId) as
    | { stage: string }
    | undefined;
  return row?.stage ?? null;
}

/**
 * Count tasks in a stage by status. Used by the engine to decide whether to
 * pump workers, generate next, or attempt a transition.
 */
function countActiveTasks(epicId: number): {
  claimable: number;
  inFlight: number;
  doneInCurrentStage: number;
} {
  const db = getDb();
  const stage = currentStage(epicId);
  if (!stage) return { claimable: 0, inFlight: 0, doneInCurrentStage: 0 };
  const rows = db.prepare(
    `SELECT status, count(*) AS n FROM tasks
     WHERE epic_id=? AND workflow_stage=?
     GROUP BY status`,
  ).all(epicId, stage) as Array<{ status: string; n: number }>;
  let claimable = 0, inFlight = 0, done = 0;
  for (const r of rows) {
    if (r.status === 'todo' || r.status === 'review') claimable += r.n;
    else if (r.status === 'in_progress' || r.status === 'review_in_progress') inFlight += r.n;
    else if (r.status === 'done') done += r.n;
  }
  return { claimable, inFlight, doneInCurrentStage: done };
}

/**
 * Find completed tasks in the epic whose task_kind is on the
 * generateNextForCompletedTask ladder, and invoke the generator. Returns the
 * number of NEW tasks created (0 if nothing to do).
 *
 * generateNextForCompletedTask already keys on task_kind and is idempotent
 * (insertGeneratedTask dedupes by generation_key), so calling it on every
 * done task is safe — it no-ops on tasks whose downstream already exists.
 */
function generateNextIfReady(epicId: number): { created: number; error: string | null } {
  const db = getDb();
  const candidates = db.prepare(
    `SELECT id FROM tasks
     WHERE epic_id=? AND status='done' AND task_kind IS NOT NULL
     ORDER BY id`,
  ).all(epicId) as Array<{ id: number }>;
  let totalCreated = 0;
  let lastError: string | null = null;
  for (const c of candidates) {
    try {
      const result = generateNextForCompletedTask(c.id);
      if (result && result.created.length > 0) {
        totalCreated += result.created.length;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { created: totalCreated, error: lastError };
}

/**
 * Mark the episode as needs-human (pause). The engine then polls until the
 * flag is cleared (by POST /api/episode/resume in tracker-view) or until
 * MAX_PAUSE_MIN elapses.
 */
async function pauseAndAlert(
  epicId: number,
  reason: string,
  opts: OrchestrateOptions,
): Promise<void> {
  const db = getDb();
  db.prepare(
    `UPDATE episode_workflows
     SET metadata=json_set(COALESCE(metadata,'{}'),
       '$.needs-human', true,
       '$.pause_reason', ?,
       '$.paused_at', datetime('now')),
       updated_at=datetime('now')
     WHERE epic_id=?`,
  ).run(reason, epicId);
  logActivity(db, 'epic', epicId, 'updated', 'needs-human', null, 'true',
    `Engine paused: ${reason}`);
  engineHeartbeat(opts, 'PAUSED', `reason="${reason.slice(0, 200)}"`);
}

function clearNeedsHuman(epicId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE episode_workflows
     SET metadata=json_remove(metadata, '$.needs-human', '$.pause_reason', '$.paused_at'),
       updated_at=datetime('now')
     WHERE epic_id=?`,
  ).run(epicId);
}

async function waitForResume(
  epicId: number,
  opts: OrchestrateOptions,
): Promise<boolean> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  while (true) {
    if (now() - startedAt > MAX_PAUSE_MIN * 60_000) {
      engineHeartbeat(opts, 'PAUSE_TIMEOUT', `${MAX_PAUSE_MIN}min reached — engine exits`);
      return false;
    }
    const row = getDb().prepare(
      `SELECT json_extract(metadata,'$.needs-human') AS nh FROM episode_workflows WHERE epic_id=?`,
    ).get(epicId) as { nh: number | null } | undefined;
    if (!row || row.nh !== 1) {
      // Either the flag was cleared, or the row was deleted. Treat as resumed.
      return true;
    }
    await sleep(RESUME_POLL_MS);
  }
}

/**
 * Attempt to advance the episode by one stage. Returns true if the stage
 * changed, false if a hard gate blocked the transition (the caller then
 * pauses for human attention).
 */
function tryAdvanceStage(epicId: number): { advanced: boolean; error: string | null } {
  const stage = currentStage(epicId);
  if (!stage) return { advanced: false, error: `episode ${epicId} has no workflow row` };
  if (stage === 'completed' || stage === 'cancelled') {
    return { advanced: false, error: null };
  }
  const to = NEXT_STAGE[stage];
  if (!to) return { advanced: false, error: `no NEXT stage for '${stage}'` };
  try {
    const result = lifecycleHandlers.episode_transition({
      epic_id: epicId,
      to_stage: to as never,
    }) as { changed: boolean };
    return { advanced: result.changed, error: null };
  } catch (err) {
    return { advanced: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run the orchestration loop. Resolves when:
 *  - episode reaches 'completed' (success), OR
 *  - needs-human pause exceeds MAX_PAUSE_MIN (timeout exit), OR
 *  - MAX_EMPTY_CYCLES consecutive cycles produce no work and no transition.
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const projectId = opts.projectId;
  const epicId = opts.epicId;
  const concurrency = opts.concurrency ?? 4;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  // Resolve the project's workspace (where `claude -p` will run).
  const projects = projectHandlers.project_list({}) as unknown as Array<{ id: number }>;
  const project = projects.find(p => p.id === projectId);
  if (!project) {
    throw new Error(`orchestrate: project ${projectId} not found`);
  }
  const workspaceRoot = resolveProjectWorkspaceForEngine(projectId);
  if (!workspaceRoot) {
    throw new Error(
      `orchestrate: no workspace resolved for project ${projectId}. ` +
      `Register a repository via repository_register({local_path}) first.`,
    );
  }

  const runner = createClaudeBoardRunner({
    // dispatcherHandlers.worker_next returns `unknown` (ToolHandler signature);
    // claude-runner.mjs consumes assignment.task / assignment.skill but does
    // not type-check them at runtime. Cast through unknown to satisfy tsc.
    claimTask: (args: { worker_id: string; project_id: number; machine_id?: string }) =>
      dispatcherHandlers.worker_next(args) as ReturnType<typeof dispatcherHandlers.worker_next> as never,
    getProject: (id: number) => getDb().prepare('SELECT * FROM projects WHERE id=?').get(id),
    getTaskState: (taskId: number) => {
      const row = getDb().prepare(
        'SELECT id, status, assigned_to, tags, integration_state FROM tasks WHERE id=?',
      ).get(taskId);
      return row as { id: number; status: string; assigned_to: string | null; tags: string; integration_state: string | null } | undefined;
    },
    recoverAssignment: ({ taskId, workerId, originalStatus }: {
      taskId: number; workerId: string; originalStatus: string; reason: string;
    }) => {
      const db = getDb();
      const task = db.prepare(
        'SELECT id, title, status, assigned_to, tags FROM tasks WHERE id=?',
      ).get(taskId) as { id: number; title: string; status: string; assigned_to: string; tags: string } | undefined;
      if (!task || task.assigned_to !== workerId) return false;
      let tags: string[] = [];
      try { tags = JSON.parse(task.tags || '[]'); } catch { tags = []; }
      if (tags.includes('needs-human')) return false;
      const restoredStatus = originalStatus === 'review' ? 'review' : 'todo';
      const info = db.prepare(
        `UPDATE tasks SET status=?, assigned_to=NULL, updated_at=datetime('now')
         WHERE id=? AND assigned_to=?`,
      ).run(restoredStatus, taskId, workerId);
      return info.changes === 1;
    },
    resolveWorkspace: () => workspaceRoot,
    dbPath: process.env.DB_PATH!,
    sagaEntry: opts.sagaEntry ?? path.join(__dirname, '..', 'dist', 'index.js'),
    sagaSkillRoot: opts.sagaSkillRoot ?? path.join(__dirname, '..', 'skills'),
    claudePath: opts.claudePath,
    spawn: opts.spawn ?? nodeSpawn,
    logRoot: opts.logRoot,
    heartbeatLog: opts.heartbeatLog,
  });

  engineHeartbeat(opts, 'ENGINE_START',
    `project=${projectId} epic=${epicId} concurrency=${concurrency} workspace=${workspaceRoot}`);

  // Ensure the episode has a workflow row (lifecycle.getOrCreate-style).
  getDb().prepare('INSERT OR IGNORE INTO episode_workflows (epic_id) VALUES (?)').run(epicId);

  let cycles = 0;
  let emptyCycles = 0;
  let lastError: string | null = null;

  try {
    while (true) {
      cycles += 1;
      const stage = currentStage(epicId);
      if (!stage) {
        lastError = `episode ${epicId} workflow row vanished mid-run`;
        engineHeartbeat(opts, 'ABORT', lastError);
        break;
      }
      if (stage === 'completed' || stage === 'cancelled') {
        engineHeartbeat(opts, 'DONE', `stage=${stage} cycles=${cycles}`);
        return {
          projectId, epicId, finalStage: stage, endedAt: new Date(now()).toISOString(),
          reason: 'completed', cycles, lastError: null,
        };
      }

      // Step 1: pump workers for any claimable tasks in the current stage.
      let run: ReturnType<typeof runner.status>;
      try {
        // Idempotent start: if a run is already active for this project,
        // start() throws — we treat that as "workers are already pumping".
        try {
          runner.start({ projectId, concurrency });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already has an active board run/.test(msg)) throw err;
        }
        run = runner.status(projectId);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        engineHeartbeat(opts, 'PUMP_FAILED', lastError);
        // Don't abort the whole engine on a pump failure — sleep and retry.
        await sleep(PUMP_TICK_MS);
        continue;
      }

      const counts = countActiveTasks(epicId);
      const workersBusy = (run?.active?.length ?? 0) > 0;

      engineHeartbeat(opts, 'CYCLE',
        `stage=${stage} claimable=${counts.claimable} in_flight=${counts.inFlight}` +
        ` workers=${run?.active?.length ?? 0}`);

      // Step 2: if there's nothing to claim AND no workers running, try to
      // generate the next wave of tasks.
      //
      // CRITICAL (discovered during 4D_Las_viewer first run): the gate must
      // also block when counts.inFlight > 0, not just when workersBusy is true.
      // workersBusy reflects only THIS runner's child processes; but a worker
      // spawned by a PREVIOUS engine process (or by tracker-view's board-run)
      // is still in_flight at the DB level (task.status='in_progress'). Without
      // this check, the engine races ahead: kicks off episode_transition while
      // kickstart worker is mid-flight writing its brief — episode jumps to
      // 'formalization' with no artifacts, then crashes the planning gate.
      if (counts.claimable === 0 && !workersBusy && counts.inFlight === 0) {
        const gen = generateNextIfReady(epicId);
        if (gen.error) {
          engineHeartbeat(opts, 'GEN_ERROR', gen.error.slice(0, 200));
          lastError = gen.error;
        }
        if (gen.created > 0) {
          engineHeartbeat(opts, 'GENERATED', `tasks=${gen.created}`);
          emptyCycles = 0;
          continue; // new tasks appeared — pump them next cycle
        }

        // Step 3: nothing left to generate. Try to advance the stage.
        const advance = tryAdvanceStage(epicId);
        if (advance.advanced) {
          engineHeartbeat(opts, 'STAGE_ADVANCED', `${stage} → ${currentStage(epicId)}`);
          emptyCycles = 0;
          continue;
        }
        if (advance.error) {
          // Hard gate failed. If it's a recoverable "tasks not ready" we just
          // wait; if it's a substantive gate failure, pause for human.
          const isTasksReady = /gate failed: tasks not completed/i.test(advance.error)
            || /gate failed: no .* tasks exist/i.test(advance.error);
          if (isTasksReady && counts.inFlight > 0) {
            // Workers still finishing — wait for them.
            await sleep(PUMP_TICK_MS);
            continue;
          }
          // Substantive gate failure → pause for human.
          lastError = advance.error;
          await pauseAndAlert(epicId, advance.error, opts);
          const resumed = await waitForResume(epicId, opts);
          if (!resumed) {
            return {
              projectId, epicId, finalStage: stage, endedAt: new Date(now()).toISOString(),
              reason: 'paused_timeout', cycles, lastError,
            };
          }
          // Resumed — clear flag and continue (the human may have advanced
          // the stage manually; currentStage() will reflect it next loop).
          clearNeedsHuman(epicId);
          emptyCycles = 0;
          continue;
        }

        // No tasks, no generation, no transition, no error → empty cycle.
        emptyCycles += 1;
        engineHeartbeat(opts, 'EMPTY', `empty=${emptyCycles}/${MAX_EMPTY_CYCLES}`);
        if (emptyCycles >= MAX_EMPTY_CYCLES) {
          engineHeartbeat(opts, 'STOP', `${MAX_EMPTY_CYCLES} empty cycles — engine done`);
          break;
        }
        await sleep(PUMP_TICK_MS);
        continue;
      }

      // There are claimable tasks or workers in flight — wait for progress.
      emptyCycles = 0;
      await sleep(PUMP_TICK_MS);
    }
  } finally {
    try { runner.dispose(); } catch { /* best effort */ }
    engineHeartbeat(opts, 'ENGINE_EXIT', `cycles=${cycles} lastError=${lastError ?? 'null'}`);
  }

  const finalStage = currentStage(epicId) ?? 'unknown';
  return {
    projectId, epicId, finalStage, endedAt: new Date(now()).toISOString(),
    reason: finalStage === 'completed' ? 'completed' : 'failed',
    cycles, lastError,
  };
}

/**
 * Resolve the workspace root for spawning workers. Preference order:
 *  1. The first registered repository with a local_path that exists on disk.
 *  2. Null if no usable workspace is found.
 *
 * Mirrors tracker-view.mjs resolveProjectWorkspace but kept self-contained
 * so the engine does not depend on the HTTP server.
 */
function resolveProjectWorkspaceForEngine(projectId: number): string | null {
  const db = getDb();
  const rows = db.prepare(
    `SELECT pr.id, r.name, COALESCE(rc.local_path, pr.local_path) AS local_path
     FROM project_repositories pr
     JOIN repositories r ON r.id=pr.repository_id
     LEFT JOIN repository_checkouts rc
       ON rc.project_repository_id=pr.id AND rc.machine_id=? AND rc.status='active'
     WHERE pr.project_id=? AND pr.status='active'
     ORDER BY pr.id`,
  ).all(os.hostname(), projectId) as Array<{ id: number; name: string; local_path: string | null }>;
  for (const r of rows) {
    if (r.local_path && existsSync(r.local_path)) return r.local_path;
  }
  return null;
}

/** Re-export for tests. */
export { closeDb };
