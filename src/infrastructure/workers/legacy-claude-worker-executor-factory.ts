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
  AssignedWork,
  WorkerExecutorFactory,
  WorkerModelRouteReader,
  WorkAssignmentPort,
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
import { buildWorkspaceProjection } from '../../process-modules/application/workspace-projection.js';
import type { WorkspacePackageRegistry } from '../../process-modules/application/workspace-projection.js';
import { materializePinnedWorkspace, type WorkplaceDesk } from '../../process-modules/application/pinned-workspace-materializer.js';
import {
  applyTestWarmStart,
  captureTestWarmStart,
  type TestWarmStartCaptureOutcome,
} from '../testing/test-warm-start.js';
import type { ModuleInstallationId } from '../../process-modules/installation/index.js';
import type { StoredModulePackage } from '../../process-modules/installation/index.js';
import type { WorkspaceProjection } from '../../process-modules/application/workspace-projection.js';
import type {
  ProcessWorkspaceTemplatePreparerRegistry,
} from '../../process-modules/application/process-workspace-preparation.js';
import {
  SqliteManagedNodeSubmissionRepository,
} from '../../process-modules/persistence/sqlite-managed-node-submission-repository.js';

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
  }) => WorkplaceDesk | null;
  resolveLaunchSpec?: (input: {
    assignment: RunnerAssignment;
    resolvedProfile: ResolvedExecutionProfile | null;
  }) => RunnerLaunchSpec | null;
  captureWorkspace?: (input: {
    workspaceRoot: string;
    processWorkspace: WorkplaceDesk | null;
    outcome: TestWarmStartCaptureOutcome;
  }) => void;
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
  /**
   * Module-owned semantic template preparers, selected by immutable module
   * reference. The host owns IO and persistence; preparers only transform
   * declared template contents from the frozen node input.
   */
  workspaceTemplatePreparers?: ProcessWorkspaceTemplatePreparerRegistry;
  /**
   * CONVEYOR Wave 9 — the atomic card-assignment port is now REQUIRED. The
   * card is assigned + fenced in one transaction by the infrastructure before
   * the worker is launched; the legacy worker_next fallback (worker-driven
   * claim) has been removed. Every caller (dispatch-loop + LM-node lifecycle)
   * wires this port via the composition root.
   */
  workAssignment: WorkAssignmentPort;
}

function readLegacyModelRoute(epicId: number | null) {
  if (!epicId) return { model: null, provider: 'zai', effort: null };
  const row = getDb().prepare(
    `SELECT model_name AS m, model_provider AS p, model_effort AS e
       FROM lifecycle_execution_controls WHERE epic_id=?`,
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
  options: LegacyClaudeWorkerExecutorFactoryOptions,
): WorkerExecutorFactory {
  const modelRouteReader = options.modelRouteReader ?? readLegacyModelRoute;
  const packageRegistry = options.packageRegistry;
  const packageSnapshots = options.packageSnapshots;
  const resolveInstallationIdFn = options.resolveInstallationId;
  const resolvePackageDigestFn = options.resolvePackageDigest;
  const resolveNodeIdFn = options.resolveNodeId;
  const workspaceTemplatePreparers = options.workspaceTemplatePreparers;
  const workAssignment = options.workAssignment;
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
      claimTask: (args: Parameters<typeof dispatcherHandlers.worker_next>[0]) => {
        // CONVEYOR PATH (work-assignment port wired): assign the card through
        // the atomic WorkAssignmentPort — status flip + fence creation in one
        // IMMEDIATE transaction, BEFORE the worker process is spawned. This is
        // the target production path. The legacy worker_next path below is kept
        // only for callers that did not wire a port.
        const projectId = args.project_id as number;
        const workerId = args.worker_id as string;
        const executionId = args.execution_id as string | undefined;
        const epicId = args.epic_id as number | undefined;
        const runId = args.run_id as string | undefined;
        const machineId = args.machine_id as string | undefined;
        const rawTaskIds = args.task_ids;
        const taskIds = Array.isArray(rawTaskIds)
          ? rawTaskIds.filter((id): id is number => Number.isInteger(id))
          : undefined;
        // CONVEYOR Wave 9: the legacy worker_next fallback is removed. Every
        // claim goes through the atomic WorkAssignmentPort — the card is
        // assigned + fenced in one transaction BEFORE the worker is launched.
        if (!executionId) {
          throw new Error(
            'EXECUTION_ID_REQUIRED: the conveyor model requires a fence token '
            + 'for every card assignment. The legacy worker_next path (no '
            + 'execution id) was removed in Wave 9.',
          );
        }
        const work: AssignedWork | null = workAssignment.assignTask({
          projectId,
          epicId,
          workerId,
          workerExecutionId: executionId,
          runId: runId ?? executionId,
          machineId: machineId ?? 'unknown',
          taskIds,
        });
        if (!work) return null;
        // Rebuild the RunnerAssignment shape the runner expects from the typed
        // AssignedWork. The task row is read fresh so launch() sees the
        // post-claim status and the full row (task_kind, skills, …).
        const task = getDb().prepare('SELECT * FROM tasks WHERE id=?').get(work.taskId) as RunnerAssignment['task'];
        return {
          task,
          skill: work.skill,
          execution_id: work.workerExecutionId,
          repository: work.repository
            ? {
                id: work.repository.id,
                name: work.repository.name,
                local_path: work.repository.local_path,
                integration_branch: work.repository.integration_branch,
                default_branch: work.repository.default_branch,
              }
            : null,
        } as RunnerAssignment;
      },
      getProject: (id: number) =>
        getDb().prepare('SELECT * FROM projects WHERE id=?').get(id),
      getTaskState: (taskId: number) =>
        getDb().prepare(
          'SELECT id, status, assigned_to, tags, integration_state FROM tasks WHERE id=?',
        ).get(taskId),
      // Pre-assigned-card path (WORK-ASSIGNMENT-REFACTOR-SPEC §4 Wave B):
      // full task row for rebuilding the launch()-shaped assignment from an
      // AssignedWork without an in-process claim.
      getTask: (taskId: number) =>
        getDb().prepare('SELECT * FROM tasks WHERE id=?').get(taskId),
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

        // saga4 cutover (LEGO-CONTRACTS.md §"Слой 1: СТОЛ"): a non-null
        // installation pin is a STRICT integrity boundary. The legacy fallback
        // path (materialize from the workspace tree) is GONE — every Process
        // Module execution MUST resolve from an immutable pinned package
        // snapshot, enforced by the WorkplaceDesk contract. A task with no
        // pinned package is a configuration error, not a silent fallback.
        const pinned = resolvePinnedPackage(input.assignment);
        if (!pinned) {
          throw new Error(
            'WORKPLACE_DESK_PINNED_PACKAGE_REQUIRED: task ' + task.id
            + ' has no pinned module installation. After the saga4 cutover '
            + 'every Process Module execution must resolve from an immutable '
            + 'package snapshot.',
          );
        }
        const module = pinned.storedPackage.manifest.definition;
        const moduleRef = `${module.identity.name}@${module.identity.version}`;
        const templatePreparer = workspaceTemplatePreparers?.get(moduleRef);

        const taskMetadata = parseTaskMetadata(task.metadata);
        const processRunId = positiveInteger(taskMetadata.process_run_id);
        const nodeId = typeof taskMetadata.process_node_id === 'string'
          ? taskMetadata.process_node_id
          : null;
        const workIntentId = positiveInteger(
          taskMetadata.work_intent_id
          ?? taskMetadata.pre_projected_intent_id
          ?? taskMetadata.authority_intent_id,
        );
        let additionalBindings: Readonly<Record<string, unknown>> | undefined;
        if (processRunId !== null && nodeId && workIntentId !== null) {
          const submission = new SqliteManagedNodeSubmissionRepository(getDb())
            .readLatestForTask({
              processRunId,
              moduleRef,
              nodeId,
              taskId: task.id,
            });
          additionalBindings = {
            SUBMISSION_STATE: submission ? 'submitted' : 'not-submitted',
            SUBMISSION_REF: submission?.artifactRef ?? '',
            SUBMISSION_HASH: submission?.contentHash ?? '',
          };
        }

        let resolvedWorkspace: WorkplaceDesk;
        const pinnedModule = module;
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
          additionalBindings,
          templatePreparer,
        });

        const metadata: Record<string, unknown> = { ...taskMetadata };
        const processNodeId = typeof metadata.process_node_id === 'string'
          ? metadata.process_node_id
          : null;
        if (processNodeId) {
          resolvedWorkspace = applyTestWarmStart({
            env: process.env,
            workspaceRoot: input.workspaceRoot,
            epicId,
            moduleRef: resolvedWorkspace.moduleRef,
            nodeId: processNodeId,
            packageDigest: pinned?.projection.packageDigest ?? null,
            inputHash: typeof metadata.process_node_input_hash === 'string'
              ? metadata.process_node_input_hash
              : typeof metadata.process_input_hash === 'string'
                ? metadata.process_input_hash
                : null,
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
      captureWorkspace: input => {
        captureTestWarmStart(
          input.workspaceRoot,
          input.processWorkspace,
          input.outcome,
        );
      },
    };

    const runner = createClaudeBoardRunner(runnerOptions);
    return new ClaudeBoardWorkerExecutor(
      runner as unknown as LegacyClaudeBoardRunner,
    );
  };
}

function parseTaskMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown): number | null {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}
