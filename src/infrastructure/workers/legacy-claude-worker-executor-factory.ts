import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { applyTestWarmStart } from '../testing/test-warm-start.js';
import type { ModuleInstallationId } from '../../process-modules/installation/index.js';
import type { StoredModulePackage } from '../../process-modules/installation/index.js';
import type { WorkspaceProjection } from '../../process-modules/application/workspace-projection.js';

interface RunnerLaunchSpec {
  readonly installationId: number;
  readonly strictResources: boolean;
  readonly role: {
    readonly executionSkill: string;
    readonly reviewSkill: string | null;
    readonly semanticSkill: string;
    readonly protocolSkill: string;
  };
  readonly allowedToolIds: readonly string[];
  readonly resolveSkill: (skillName: string) => string | null;
}

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
    resolvedProfile: ResolvedExecutionProfile | null;
  }) => ProcessExecutionWorkspace | null;
  resolveLaunchSpec?: (input: {
    assignment: RunnerAssignment;
    resolvedProfile: ResolvedExecutionProfile | null;
  }) => RunnerLaunchSpec | null;
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
  /** Verified immutable package snapshots keyed by package digest. */
  packageSnapshots?: ReadonlyMap<string, StoredModulePackage>;
  /**
   * Resolves the pinned module installation id for a claimed assignment.
   * Typically reads task.metadata.process_run_id → saga3_process_runs.installation_id.
   * Returns null when the run is unpinned (legacy path).
   */
  resolveInstallationId?: (assignment: RunnerAssignment) => ModuleInstallationId | null;
  /** Reads the denormalized package digest frozen on the same ProcessRun. */
  resolvePackageDigest?: (assignment: RunnerAssignment) => string | null;
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pinnedSkillResource(
  projection: WorkspaceProjection,
  skillName: string,
) {
  const slots = [
    [projection.skills.executionSkillName, projection.skills.executionSkillResource],
    [projection.skills.reviewerSkillName, projection.skills.reviewerSkillResource],
    [projection.skills.protocolSkillName, projection.skills.protocolSkillResource],
  ] as const;
  return slots.find(([name]) => name === skillName)?.[1];
}

/**
 * Materialize one already-verified package skill into a digest-scoped runtime
 * cache. The runner needs a filesystem path because it inlines SKILL.md into
 * the Claude prompt; it never reads mutable repository skill paths here.
 */
function materializePinnedSkill(
  projection: WorkspaceProjection,
  storedPackage: StoredModulePackage,
  skillName: string,
): string | null {
  const resource = pinnedSkillResource(projection, skillName);
  if (!resource) return null;
  const blob = storedPackage.resources.find(item => item.logicalId === resource.logicalId);
  if (!blob || blob.digest !== resource.digest || sha256(blob.bytes) !== resource.digest) {
    throw new Error(
      `PINNED_SKILL_DIGEST_MISMATCH: ${skillName} in ${projection.packageDigest}`,
    );
  }
  const safeSkillName = skillName.replace(/[^A-Za-z0-9._-]/g, '_');
  const target = path.join(
    os.tmpdir(),
    'saga-pinned-skills',
    projection.packageDigest,
    safeSkillName,
    'SKILL.md',
  );
  mkdirSync(path.dirname(target), { recursive: true });
  if (
    !existsSync(target)
    || sha256(new Uint8Array(readFileSync(target))) !== resource.digest
  ) {
    writeFileSync(target, blob.bytes);
  }
  return target;
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
  const packageSnapshots = options.packageSnapshots;
  const resolveInstallationIdFn = options.resolveInstallationId;
  const resolvePackageDigestFn = options.resolvePackageDigest;
  const resolveNodeIdFn = options.resolveNodeId;
  return context => {
    const resolvePinnedPackage = (
      assignment: RunnerAssignment,
    ): {
      installationId: ModuleInstallationId;
      projection: WorkspaceProjection;
      storedPackage: StoredModulePackage;
    } | null => {
      const installationId = typeof resolveInstallationIdFn === 'function'
        ? resolveInstallationIdFn(assignment)
        : null;
      if (installationId === null) return null;
      if (
        !packageRegistry
        || !packageSnapshots
        || typeof resolveNodeIdFn !== 'function'
        || typeof resolvePackageDigestFn !== 'function'
      ) {
        throw new Error(
          `PINNED_WORKSPACE_RUNTIME_NOT_CONFIGURED: installation ${installationId} `
          + 'requires packageRegistry, packageSnapshots, resolveNodeId and resolvePackageDigest',
        );
      }
      const nodeId = resolveNodeIdFn(assignment);
      if (!nodeId) {
        throw new Error(
          `PINNED_WORKSPACE_NODE_REQUIRED: task ${assignment.task.id} has installation `
          + `${installationId} but no process_node_id`,
        );
      }
      const projection = buildWorkspaceProjection(installationId, nodeId, packageRegistry);
      const expectedPackageDigest = resolvePackageDigestFn(assignment);
      if (
        !expectedPackageDigest
        || expectedPackageDigest !== projection.packageDigest
      ) {
        throw new Error(
          `PROCESS_RUN_PIN_DIGEST_MISMATCH: process run expects `
          + `${expectedPackageDigest ?? '(missing)'} but installation ${installationId} `
          + `resolves to ${projection.packageDigest}`,
        );
      }
      const storedPackage = packageSnapshots.get(projection.packageDigest);
      if (!storedPackage) {
        throw new Error(
          `PINNED_PACKAGE_SNAPSHOT_MISSING: no verified package snapshot for `
          + projection.packageDigest,
        );
      }
      return { installationId, projection, storedPackage };
    };

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
      resolveLaunchSpec: input => {
        const pinned = resolvePinnedPackage(input.assignment);
        if (!pinned) return null;
        const profile = pinned.storedPackage.manifest.definition.executionProfiles
          .find(candidate => candidate.id === pinned.projection.executionProfileId);
        if (!profile) {
          throw new Error(
            `PINNED_EXECUTION_PROFILE_MISSING: ${pinned.projection.executionProfileId}`,
          );
        }
        return {
          installationId: pinned.installationId,
          strictResources: true,
          role: {
            executionSkill: profile.executionSkill,
            reviewSkill: profile.reviewSkill ?? null,
            semanticSkill: profile.semanticSkill,
            protocolSkill: profile.protocolSkill,
          },
          allowedToolIds: [...profile.allowedTools],
          resolveSkill: skillName => materializePinnedSkill(
            pinned.projection,
            pinned.storedPackage,
            skillName,
          ),
        };
      },
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

        // A non-null installation pin is an integrity boundary: materialize
        // from verified immutable bytes or fail the worker launch. Genuinely
        // unpinned historical runs retain the legacy workspace path.
        const pinned = resolvePinnedPackage(input.assignment);
        if (!pinned && !input.resolvedProfile) return null;
        let resolvedWorkspace: ProcessExecutionWorkspace;
        if (pinned) {
          const pinnedModule = pinned.storedPackage.manifest.definition;
          const pinnedProfile = pinnedModule.executionProfiles.find(
            profile => profile.id === pinned.projection.executionProfileId,
          );
          if (!pinnedProfile) {
            throw new Error(
              `PINNED_EXECUTION_PROFILE_MISSING: ${pinned.projection.executionProfileId}`,
            );
          }
          resolvedWorkspace = materializePinnedWorkspace({
            projection: pinned.projection,
            storedPackage: pinned.storedPackage,
            workspaceRoot: input.workspaceRoot,
            module: pinnedModule,
            profile: pinnedProfile,
            projectId: input.project.id,
            epicId,
            task,
            executionId: input.assignment.execution_id ?? null,
            workerId: input.workerId,
          });
        } else {
          const legacyProfile = input.resolvedProfile;
          if (!legacyProfile) return null;
          resolvedWorkspace = prepareProcessExecutionWorkspace({
            workspaceRoot: input.workspaceRoot,
            module: legacyProfile.module,
            profile: legacyProfile.profile,
            projectId: input.project.id,
            epicId,
            task,
            executionId: input.assignment.execution_id ?? null,
            workerId: input.workerId,
          });
        }

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
        const processNodeId = typeof metadata.process_node_id === 'string'
          ? metadata.process_node_id
          : null;
        if (processNodeId) {
          resolvedWorkspace = applyTestWarmStart({
            env: process.env,
            workspaceRoot: input.workspaceRoot,
            moduleRef: resolvedWorkspace.moduleRef,
            nodeId: processNodeId,
            processWorkspace: resolvedWorkspace,
          });
        }
        metadata.process_workspace = {
          profile_id: resolvedWorkspace.profileId,
          module_ref: resolvedWorkspace.moduleRef,
          tracker_path: resolvedWorkspace.trackerPath,
          agent_assistance_path: resolvedWorkspace.agentAssistanceAbsolutePath ?? null,
          agent_assistance_hook_state_path: resolvedWorkspace.agentAssistanceAbsolutePath
            ? `${resolvedWorkspace.agentAssistanceAbsolutePath}.hook-state.json`
            : null,
          execution_directory: resolvedWorkspace.executionDirectory,
          workspace_files: [...resolvedWorkspace.workspaceFiles],
          call_files: [...resolvedWorkspace.callFiles],
          checklists: [...resolvedWorkspace.checklists],
          test_warm_start: resolvedWorkspace.testWarmStart ?? null,
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
