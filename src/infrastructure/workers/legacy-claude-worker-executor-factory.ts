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
import type { ResolvedExecutionProfile } from '../../process-modules/application/execution-profile-resolver.js';
import {
  prepareProcessExecutionWorkspace,
  type ProcessExecutionWorkspace,
} from '../../process-modules/application/process-execution-workspace.js';
import { buildWorkspaceProjection } from '../../process-modules/application/workspace-projection.js';
import type { WorkspacePackageRegistry } from '../../process-modules/application/workspace-projection.js';
import { materializePinnedWorkspace } from '../../process-modules/application/pinned-workspace-materializer.js';
import type { ModuleInstallationId } from '../../process-modules/installation/index.js';

/**
 * ClaudeBoardRunnerOptions is exported from the .mjs runner without a formal
 * type; we re-declare the shape here (as a superset) so the factory can add
 * the P5b resolveProfile callback without the .mjs file needing TypeScript
 * annotations.
 */
type RunnerOptions = ClaudeBoardRunnerOptions & {
  resolveProfile?: (
    taskKind: string | null | undefined,
  ) => ResolvedExecutionProfile | null;
  prepareWorkspace?: (input: {
    assignment: RunnerAssignment;
    project: { id: number; name: string };
    workerId: string;
    workspaceRoot: string;
    resolvedProfile: ResolvedExecutionProfile;
  }) => ProcessExecutionWorkspace;
};

export interface LegacyClaudeWorkerExecutorFactoryOptions {
  spawn?: typeof nodeSpawn;
  modelRouteReader?: WorkerModelRouteReader;
  /**
   * Pinned-package workspace resolution (W13-AUDIT §18.9 / bug #4). When BOTH
   * this registry and {@link resolveInstallationId} are provided and a task
   * resolves to a non-null installation pin, the workspace is materialized
   * from the pinned package store (immutable bytes) instead of the legacy
   * workspaceRoot tree lookup. Absent or null pin → legacy fallback.
   */
  packageRegistry?: WorkspacePackageRegistry;
  /**
   * Resolves the pinned module installation id for a claimed assignment.
   * Typically reads task.metadata.process_run_id → saga3_process_runs.installation_id.
   * Returns null when the run is unpinned (legacy path).
   */
  resolveInstallationId?: (assignment: RunnerAssignment) => ModuleInstallationId | null;
  /**
   * Resolves the flow node id for a claimed assignment (needed by
   * buildWorkspaceProjection to locate the LM node's execution profile).
   * Typically reads task.metadata.process_node_id.
   */
  resolveNodeId?: (assignment: RunnerAssignment) => string | null;
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
  const packageRegistry = options.packageRegistry;
  const resolveInstallationIdFn = options.resolveInstallationId;
  const resolveNodeIdFn = options.resolveNodeId;
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
      resolveProfile: (taskKind: string | null | undefined) =>
        resolveExecutionProfile(taskKind),
      // Materialize the descriptor-owned tracker/templates only after the
      // exact task has been claimed, when execution_id and worker_id are known.
      prepareWorkspace: input => {
        const task = input.assignment.task;
        const epicId = Number(task.epic_id ?? context.epicId ?? 0);
        if (!Number.isSafeInteger(epicId) || epicId < 1) {
          throw new Error(
            `PROCESS_WORKSPACE_EPIC_REQUIRED: task ${task.id} has no epic scope`,
          );
        }

        // W13-AUDIT §18.9 / bug #4: when a pinned package registry + installation
        // resolver are wired AND the task resolves to a non-null installation,
        // materialize the workspace from the immutable package store instead of
        // the legacy workspaceRoot tree (which broke when workspaceRoot ≠ the
        // saga-mcp repo root). Feature-detected: absent registry / null pin /
        // resolver failure → legacy fallback (byte-for-byte pre-Seam-D path).
        let workspace: ProcessExecutionWorkspace | undefined;
        let usedPinned = false;
        if (
          packageRegistry
          && typeof resolveInstallationIdFn === 'function'
          && typeof resolveNodeIdFn === 'function'
        ) {
          try {
            const installationId = resolveInstallationIdFn(input.assignment);
            const nodeId = resolveNodeIdFn(input.assignment);
            if (installationId !== null && nodeId) {
              const projection = buildWorkspaceProjection(installationId, nodeId, packageRegistry);
              workspace = materializePinnedWorkspace({
                projection,
                workspaceRoot: input.workspaceRoot,
                module: input.resolvedProfile.module,
                profile: input.resolvedProfile.profile,
                projectId: input.project.id,
                epicId,
                task,
                executionId: input.assignment.execution_id ?? null,
                workerId: input.workerId,
              });
              usedPinned = true;
            }
          } catch {
            // Pinned resolution failure → fall back to legacy so a corrupt
            // store / missing pin never hard-blocks a worker spawn.
          }
        }
        if (!usedPinned) {
          workspace = prepareProcessExecutionWorkspace({
            workspaceRoot: input.workspaceRoot,
            module: input.resolvedProfile.module,
            profile: input.resolvedProfile.profile,
            projectId: input.project.id,
            epicId,
            task,
            executionId: input.assignment.execution_id ?? null,
            workerId: input.workerId,
          });
        }
        // By here exactly one of the pinned or legacy branches assigned workspace.
        const resolvedWorkspace = workspace!;

        const rawMetadata = task.metadata;
        let metadata: Record<string, unknown> = {};
        if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
          metadata = { ...rawMetadata };
        } else if (typeof rawMetadata === 'string') {
          try {
            const parsed = JSON.parse(rawMetadata);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              metadata = parsed as Record<string, unknown>;
            }
          } catch {
            metadata = {};
          }
        }
        metadata.process_workspace = {
          profile_id: resolvedWorkspace.profileId,
          module_ref: resolvedWorkspace.moduleRef,
          tracker_path: resolvedWorkspace.trackerPath,
          execution_directory: resolvedWorkspace.executionDirectory,
          workspace_files: [...resolvedWorkspace.workspaceFiles],
          call_files: [...resolvedWorkspace.callFiles],
          checklists: [...resolvedWorkspace.checklists],
        };
        getDb().prepare(
          `UPDATE tasks
              SET metadata=?, updated_at=datetime('now')
            WHERE id=?`,
        ).run(JSON.stringify(metadata), task.id);
        task.metadata = metadata;
        return resolvedWorkspace;
      },
    };

    const runner = createClaudeBoardRunner(runnerOptions);
    return new ClaudeBoardWorkerExecutor(
      runner as unknown as LegacyClaudeBoardRunner,
    );
  };
}
