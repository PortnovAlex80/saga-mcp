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
import { resolveExecutionProfile } from '../../process-modules/application/execution-profile-resolver.js';

/**
 * ClaudeBoardRunnerOptions is exported from the .mjs runner without a formal
 * type; we re-declare the shape here (as a superset) so the factory can add
 * the P5b resolveProfile callback without the .mjs file needing TypeScript
 * annotations.
 */
type RunnerOptions = ClaudeBoardRunnerOptions & {
  resolveProfile?: (taskKind: string | null | undefined) => {
    protocolSkill: string;
    semanticSkill: string;
  } | null;
};

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
    const runnerOptions: RunnerOptions = {
      claimTask: (args: Parameters<typeof dispatcherHandlers.worker_next>[0]) =>
        dispatcherHandlers.worker_next(args) as RunnerAssignment | null,
      getProject: (id: number) =>
        getDb().prepare('SELECT * FROM projects WHERE id=?').get(id),
      getTaskState: (taskId: number) =>
        getDb().prepare(
          'SELECT id, status, assigned_to, tags, integration_state FROM tasks WHERE id=?',
        ).get(taskId),
      recoverAssignment: (command: Parameters<typeof recoverLegacyAssignment>[1]) =>
        recoverLegacyAssignment(getDb(), command),
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
      // P5b: resolve the Process Module execution profile for each task's
      // task_kind. The prompt builder uses this to inline BOTH the protocol
      // skill (saga-process-module-worker-protocol) and the semantic role
      // skill. When the task_kind does not match any module profile, the
      // resolver returns null and the prompt builder falls back to the legacy
      // single-skill path.
      resolveProfile: (taskKind: string | null | undefined) => {
        const resolved = resolveExecutionProfile(taskKind);
        if (!resolved) return null;
        return {
          protocolSkill: resolved.profile.protocolSkill,
          semanticSkill: resolved.profile.semanticSkill,
        };
      },
    };

    const runner = createClaudeBoardRunner(runnerOptions);
    return new ClaudeBoardWorkerExecutor(
      runner as unknown as LegacyClaudeBoardRunner,
    );
  };
}
