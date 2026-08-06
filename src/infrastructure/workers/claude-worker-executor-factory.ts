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
  WorkAssignmentPort,
} from '../../application/ports/worker-executor.js';
import { getDb } from '../../db.js';
import { releaseExecutionAtomically } from '../../lifecycle/atomic-release.js';
import {
  ClaudeBoardWorkerExecutor,
  type ClaudeBoardRunner,
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

const WORKER_DONE_STATUSES = new Set(['review', 'done', 'todo', 'blocked']);

interface AcceptedWorkerDone {
  readonly commandId: string;
  readonly completedNewStatus: 'review' | 'done' | 'todo' | 'blocked';
}

/**
 * Exact durable completion evidence for one managed execution.
 *
 * The card projection is deliberately not used as the completion oracle: a
 * successful worker_done can move the authoritative Workplace to verifying,
 * which reverse-projects the task back to in_progress while the OS process is
 * still closing.
 */
function readAcceptedWorkerDone(
  executionId: string | null | undefined,
): AcceptedWorkerDone | null {
  if (!executionId) return null;
  const db = getDb();
  let row:
    | { command_id: string; reply_json: string }
    | undefined;
  try {
    row = db.prepare(
      `SELECT command_id, reply_json
         FROM command_receipts
        WHERE execution_id=?
          AND command_kind='worker_done'
          AND accepted=1
        ORDER BY accepted_at DESC, rowid DESC
        LIMIT 1`,
    ).get(executionId) as
      | { command_id: string; reply_json: string }
      | undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return null;
    throw error;
  }
  if (!row) return null;
  try {
    const reply = JSON.parse(row.reply_json) as { completed_new_status?: unknown };
    const status = reply.completed_new_status;
    if (!WORKER_DONE_STATUSES.has(status)) return null;
    return {
      commandId: row.command_id,
      completedNewStatus: status as AcceptedWorkerDone['completedNewStatus'],
    };
  } catch {
    return null;
  }
}

function readRunnerTaskState(taskId: number): unknown {
  const task = getDb().prepare(
    `SELECT id, status, assigned_to, tags, integration_state,
            current_execution_id
       FROM tasks WHERE id=?`,
  ).get(taskId) as
    | {
        id: number;
        status: string;
        assigned_to: string | null;
        tags: string;
        integration_state: string | null;
        current_execution_id: string | null;
      }
    | undefined;
  if (!task) return task;

  const completion = readAcceptedWorkerDone(task.current_execution_id);
  if (!completion) return task;

  return {
    ...task,
    status: completion.completedNewStatus,
    assigned_to: null,
    worker_done_command_id: completion.commandId,
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

export interface PinnedClaudeWorkerExecutorFactoryOptions {
  spawn?: typeof nodeSpawn;
  modelRouteReader: WorkerModelRouteReader;
  packageRegistry: WorkspacePackageRegistry;
  packageSnapshots: ReadonlyMap<string, StoredModulePackage>;
  resolveInstallationId: (assignment: RunnerAssignment) => ModuleInstallationId | null;
  resolvePackageDigest: (assignment: RunnerAssignment) => string | null;
  resolveNodeId: (assignment: RunnerAssignment) => string | null;
  workspaceTemplatePreparers?: ProcessWorkspaceTemplatePreparerRegistry;
  workAssignment: WorkAssignmentPort;
}

export function createPinnedClaudeWorkerExecutorFactory(
  options: PinnedClaudeWorkerExecutorFactoryOptions,
): WorkerExecutorFactory {
  const modelRouteReader = options.modelRouteReader;
  const packageRegistry = options.packageRegistry;
  const packageSnapshots = options.packageSnapshots;
  const resolveInstallationIdFn = options.resolveInstallationId;
  const resolvePackageDigestFn = options.resolvePackageDigest;
  const resolveNodeIdFn = options.resolveNodeId;
  const workspaceTemplatePreparers = options.workspaceTemplatePreparers;

  return context => {
    const resolvePinnedPackage = (
      assignment: RunnerAssignment,
    ): {
      installationId: ModuleInstallationId;
      projection: WorkspaceProjection;
      storedPackage: StoredModulePackage;
    } => {
      const installationId = resolveInstallationIdFn(assignment);
      if (installationId === null) {
        throw new Error('PROCESS_RUN_PIN_REQUIRED: assignment has no installation pin');
      }
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
      getProject: (id: number) =>
        getDb().prepare('SELECT * FROM projects WHERE id=?').get(id),
      getTaskState: (taskId: number) => readRunnerTaskState(taskId),
      getTask: (taskId: number) =>
        getDb().prepare('SELECT * FROM tasks WHERE id=?').get(taskId),
      recoverAssignment: (command: {
        taskId: number;
        workerId: string;
        originalStatus: string;
        executionId?: string | null;
        reason: string;
      }) => {
        if (!command.executionId) {
          throw new Error('EXECUTION_FENCE_REQUIRED: cannot recover an unfenced assignment');
        }
        // Defense in depth. getTaskState normally routes this close through the
        // runner's completed/changes_requested branch. If a stale in-memory
        // snapshot still reaches recovery, the durable receipt wins and the
        // accepted execution is never marked lost.
        if (readAcceptedWorkerDone(command.executionId)) return false;
        return releaseExecutionAtomically(getDb(), {
          executionId: command.executionId,
          terminalState: 'lost',
          reason: command.reason ?? 'worker execution failed before completion',
        }).taskReleased;
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
      resolveProfile: (taskKind: string | null | undefined) =>
        resolveExecutionProfile(taskKind),
      resolveLaunchSpec: input => {
        const pinned = resolvePinnedPackage(input.assignment);
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
      prepareWorkspace: input => {
        const task = input.assignment.task;
        const epicId = Number(task.epic_id ?? context.epicId ?? 0);
        if (!Number.isSafeInteger(epicId) || epicId < 1) {
          throw new Error(
            `PROCESS_WORKSPACE_EPIC_REQUIRED: task ${task.id} has no epic scope`,
          );
        }

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

        const pinnedModule = module;
        const pinnedProfile = pinnedModule.executionProfiles.find(
          profile => profile.id === pinned.projection.executionProfileId,
        );
        if (!pinnedProfile) {
          throw new Error(
            `PINNED_EXECUTION_PROFILE_MISSING: ${pinned.projection.executionProfileId}`,
          );
        }
        let resolvedWorkspace = materializePinnedWorkspace({
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
            packageDigest: pinned.projection.packageDigest,
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
      runner as unknown as ClaudeBoardRunner,
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
