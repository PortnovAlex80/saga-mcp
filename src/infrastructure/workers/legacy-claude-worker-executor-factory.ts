import { spawn as nodeSpawn } from 'node:child_process';
import { createClaudeBoardRunner } from '../../../tracker-view/claude-runner.mjs';
import type {
  ClaudeBoardRunnerOptions,
  RunnerAssignment,
} from '../../../tracker-view/claude-runner.mjs';
import type {
  WorkerExecutorFactory,
  WorkerModelRouteReader,
} from '../../application/ports/worker-executor.js';
import { getDb } from '../../db.js';
import { logActivity } from '../../helpers/activity-logger.js';
import { releaseExecutionAtomically } from '../../lifecycle/atomic-release.js';
import { handlers as dispatcherHandlers } from '../../tools/dispatcher.js';
import {
  ClaudeBoardWorkerExecutor,
  type LegacyClaudeBoardRunner,
} from './claude-board-worker-executor.js';

export interface LegacyClaudeWorkerExecutorFactoryOptions {
  spawn?: typeof nodeSpawn;
  modelRouteReader?: WorkerModelRouteReader;
}

function readLegacyModelRoute(epicId: number | null) {
  if (!epicId) return { model: null, provider: 'zai', effort: null };
  const row = getDb().prepare(
    `SELECT json_extract(metadata, '$.active_model') AS m,
            json_extract(metadata, '$.active_provider') AS p,
            json_extract(metadata, '$.active_model_effort') AS e
       FROM episode_workflows WHERE epic_id=?`,
  ).get(epicId) as {
    m: string | null;
    p: string | null;
    e: string | null;
  } | undefined;
  return {
    model: row?.m ?? null,
    provider: row?.p ?? 'zai',
    effort: row?.e ?? null,
  };
}

/**
 * Concrete Saga 2 worker-runtime factory.
 *
 * All ClaudeBoardRunner callbacks, DB recovery details, MCP paths and provider
 * selection live here. The orchestration pump receives only WorkerExecutor.
 */
export function createLegacyClaudeWorkerExecutorFactory(
  options: LegacyClaudeWorkerExecutorFactoryOptions = {},
): WorkerExecutorFactory {
  const modelRouteReader = options.modelRouteReader ?? readLegacyModelRoute;
  return context => {
    const runnerOptions: ClaudeBoardRunnerOptions = {
      claimTask: args =>
        dispatcherHandlers.worker_next(args) as RunnerAssignment | null,
      getProject: id =>
        getDb().prepare('SELECT * FROM projects WHERE id=?').get(id),
      getTaskState: taskId =>
        getDb().prepare(
          'SELECT id, status, assigned_to, tags, integration_state FROM tasks WHERE id=?',
        ).get(taskId),
      recoverAssignment: ({
        taskId,
        workerId,
        originalStatus,
        executionId,
        reason,
      }) => {
        const db = getDb();
        const task = db.prepare(
          `SELECT id, title, status, assigned_to, tags, current_execution_id
             FROM tasks WHERE id=?`,
        ).get(taskId) as {
          id: number;
          title: string;
          status: string;
          assigned_to: string;
          tags: string;
          current_execution_id: string | null;
        } | undefined;

        if (!task || task.assigned_to !== workerId) return false;
        let tags: string[] = [];
        try { tags = JSON.parse(task.tags || '[]') as string[]; } catch { tags = []; }
        if (tags.includes('needs-human')) return false;

        if (executionId && task.current_execution_id === executionId) {
          const outcome = releaseExecutionAtomically(db, {
            executionId,
            terminalState: 'lost',
            reason: `engine recovery: ${reason ?? 'process exited before terminal worker_done'}`,
          });
          if (outcome.taskReleased) {
            logActivity(
              db,
              'task',
              taskId,
              'status_changed',
              'status',
              task.status,
              outcome.restoredStatus,
              `Engine recovered task '${task.title}' (atomic): ${reason ?? ''}`,
            );
          }
          return outcome.taskReleased;
        }

        const restoredStatus =
          originalStatus === 'review' && task.status !== 'in_progress'
            ? 'review'
            : 'todo';
        const info = db.prepare(
          `UPDATE tasks
              SET status=?, assigned_to=NULL, current_execution_id=NULL,
                  updated_at=datetime('now')
            WHERE id=? AND assigned_to=?
              AND (current_execution_id IS NULL OR current_execution_id=?)`,
        ).run(restoredStatus, taskId, workerId, executionId ?? null);
        return info.changes === 1;
      },
      resolveWorkspace: () => context.workspaceRoot,
      dbPath: context.dbPath,
      sagaEntry: context.sagaEntry,
      sagaSkillRoot: context.sagaSkillRoot,
      claudePath: context.claudePath,
      spawn: options.spawn ?? nodeSpawn,
      logRoot: context.logRoot,
      heartbeatLog: context.heartbeatLog,
      lmstudioBaseUrl: context.lmStudioUrl,
      getActiveModel: modelRouteReader,
    };

    const runner = createClaudeBoardRunner(runnerOptions);
    return new ClaudeBoardWorkerExecutor(
      runner as unknown as LegacyClaudeBoardRunner,
    );
  };
}
