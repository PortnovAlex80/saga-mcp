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
import { recoverLegacyAssignment } from '../../lifecycle/legacy-assignment-recovery.js';
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
 * ClaudeBoardRunner callbacks, MCP paths and provider selection live here.
 * Lifecycle mutations are delegated to the lifecycle boundary.
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
      recoverAssignment: command => recoverLegacyAssignment(getDb(), command),
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
