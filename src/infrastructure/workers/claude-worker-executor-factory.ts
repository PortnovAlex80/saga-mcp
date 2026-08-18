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
import { releaseExecutionAtomically } from '../../lifecycle/atomic-release.js';
import { readLatestSubmissionRejectionForExecution } from '../../lifecycle/submission-validation-rejections.js';
import { ConveyorRuntime } from '../../application/conveyor-runtime.js';
import { SqliteWorkplaceRepository } from '../workplace/sqlite-workplace-repository.js';
import { deserializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import {
  ClaudeBoardWorkerExecutor,
  type ClaudeBoardRunner,
  type InProcessReplayFn,
} from './claude-board-worker-executor.js';
import * as productHandlers from '../../tools/products.js';
import * as artifactHandlers from '../../tools/artifacts.js';

import * as dispatcherHandlers from '../../tools/dispatcher.js';
import {
  executeCapsuleReplay,
  type CapsuleReplayHandlers,
} from '../replay/capsule-replay-executor.js';
import { resolveExecutionProfile } from '../../process-modules/application/execution-profile-resolver.js';
import type { ResolvedExecutionProfile } from '../../process-modules/application/execution-profile-resolver.js';
import { buildWorkspaceProjection } from '../../process-modules/application/workspace-projection.js';
import type { WorkspacePackageRegistry } from '../../process-modules/application/workspace-projection.js';
import { materializePinnedWorkspace, type WorkplaceDesk } from '../../process-modules/application/pinned-workspace-materializer.js';
import type { RepositoryDesk } from '../../process-modules/application/repository-desk.js';
import { RepositoryDeskProvisioner } from './repository-desk-provisioner.js';
import { resolveEffectiveDeskBase } from './effective-desk-base.js';
import { isRetryableFactoryProvisioningFailure } from './pre-spawn-failure-policy.js';
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
    outcome: 'completed' | 'changes_requested' | 'failed';
  }) => void;
};

interface AcceptedWorkerDone {
  readonly commandId: string;
  readonly completedNewStatus: 'review' | 'done' | 'todo' | 'blocked';
}

function isWorkerDoneStatus(
  value: unknown,
): value is AcceptedWorkerDone['completedNewStatus'] {
  return value === 'review'
    || value === 'done'
    || value === 'todo'
    || value === 'blocked';
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
          AND command_kind IN ('worker_done','presentation_close')
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
    if (!isWorkerDoneStatus(status)) return null;
    return {
      commandId: row.command_id,
      completedNewStatus: status,
    };
  } catch {
    return null;
  }
}

function readRunnerTaskState(taskId: number, executionId?: string | null): unknown {
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

  const completion = readAcceptedWorkerDone(executionId);
  if (!completion) return task;

  return {
    ...task,
    status: completion.completedNewStatus,
    assigned_to: null,
    worker_done_accepted: true,
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
  /** Routing cutover: explicit real-claude CLI path (executor_kind=claude-cli). */
  realClaudePath?: string;
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
      const taskMetadata = parseTaskMetadata(assignment.task.metadata);
      const executionProfileId = typeof taskMetadata.process_execution_profile_id === 'string'
        ? taskMetadata.process_execution_profile_id
        : undefined;
      const projection = buildWorkspaceProjection(
        installationId,
        nodeId,
        packageRegistry,
        executionProfileId,
      );
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
      getTaskState: (taskId: number, executionId?: string | null) =>
        readRunnerTaskState(taskId, executionId),
      getTask: (taskId: number) =>
        getDb().prepare('SELECT * FROM tasks WHERE id=?').get(taskId),
      recoverAssignment: (command: {
        taskId: number;
        workerId: string;
        originalStatus: string;
        executionId?: string | null;
        reason: string;
        spawnFailure?: boolean;
      }) => {
        if (!command.executionId) {
          throw new Error('EXECUTION_FENCE_REQUIRED: cannot recover an unfenced assignment');
        }
        const executionId = command.executionId;
        // Defense in depth. getTaskState normally routes this close through the
        // runner's completed/changes_requested branch. If a stale in-memory
        // snapshot still reaches recovery, the durable receipt wins and the
        // accepted execution is never marked lost.
        if (readAcceptedWorkerDone(executionId)) return false;
        const db = getDb();
        return db.transaction(() => {
          const task = db.prepare(
            `SELECT workplace_ref FROM tasks WHERE id=?`,
          ).get(command.taskId) as { workplace_ref: string | null } | undefined;
          if (task?.workplace_ref) {
            const workplaceRef = deserializeWorkplaceRef(task.workplace_ref);
            const workplaceRepo = new SqliteWorkplaceRepository(db);
            const state = workplaceRepo.read(workplaceRef);
            const actors = workplaceRepo.readActiveActors(workplaceRef);
            if (
              state
              && (state.loopState === 'leased' || state.loopState === 'running')
              && actors?.activeReservationRef === executionId
            ) {
              // running → repair_wait (REG-28-AC-02). The Production Cell's own
              // recovery policy (gated by cell.recovery.maxAttempts / onExhausted)
              // owns the retry decision when the flow node is next reconciled.
              new ConveyorRuntime(db).releaseExecution({
                workplaceRef,
                reservationRef: executionId,
                taskId: command.taskId,
                outcome: 'crashed',
              });
            }
          }
          const validationRejection = readLatestSubmissionRejectionForExecution(db, executionId);
          const reason = validationRejection
            ? `submission validation rejected (${validationRejection.rejectionCode}); `
              + `durable feedback ${validationRejection.rejectionRef}`
            : command.reason ?? 'worker execution ended without terminal worker_done';
          const isSpawnFailure = command.spawnFailure === true;
          if (isSpawnFailure) {
            const retryableProvisioningFailure =
              isRetryableFactoryProvisioningFailure(reason);
            // Genuine spawn failure: the Claude process could not be created
            // (binary missing, CreateProcess failed, bad config). This IS an
            // infrastructure fault — label it 'spawn_failed' and pause for a
            // human, because retrying the same spawn will fail identically.
            const released = releaseExecutionAtomically(db, {
              executionId,
              terminalState: 'spawn_failed',
              reason,
              lastError: reason,
              preserveTaskStatus: retryableProvisioningFailure,
            }).taskReleased;
            if (released && task?.workplace_ref && !retryableProvisioningFailure) {
              new ConveyorRuntime(db).pauseForHuman({
                workplaceRef: deserializeWorkplaceRef(task.workplace_ref),
                taskId: command.taskId,
                // Fix-1 — the spawn-failure reason is already in scope here;
                // park it with the workplace instead of losing it.
                reason: {
                  code: 'WORKER_SPAWN_FAILED',
                  message: `Worker process could not be spawned; retrying the same spawn `
                    + `would fail identically. ${reason}`,
                  evidenceRefs: [executionId],
                },
              });
            }
            return released;
          }
          // The Claude process was spawned and ran (possibly to exit code 0)
          // but never emitted a durable worker_done. This is a protocol
          // completion failure, NOT an infrastructure spawn failure. Label it
          // 'lost' (process started, ended abnormally) — never 'spawn_failed',
          // which is reserved for cases where the process could not be created.
          // Do NOT call pauseForHuman here: the Workplace is already in
          // repair_wait from the releaseExecution({outcome:'crashed'}) above,
          // and ProductionCellNodeExecutor.reconcile() will requeue it (subject
          // to cell.recovery.maxAttempts) when the flow node is next driven.
          // pauseForHuman would bypass the retry budget and immediately escalate
          // to blocked/paused, defeating the repair machine.
          const released = releaseExecutionAtomically(db, {
            executionId,
            terminalState: 'lost',
            reason,
            lastError: reason,
            // Preserve the Workplace-derived task status: the repair_wait state
            // owns the retry/escalation decision, not physicalRetryExhausted.
            preserveTaskStatus: true,
          }).taskReleased;
          return released;
        })();
      },
      resolveWorkspace: () => context.workspaceRoot,
      dbPath: context.dbPath,
      sagaEntry: context.sagaEntry,
      sagaSkillRoot: context.sagaSkillRoot,
      claudePath: context.claudePath,
      realClaudePath: options.realClaudePath,
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
        };
        getDb().prepare(
          `UPDATE tasks
              SET metadata=?, updated_at=datetime('now')
            WHERE id=?`,
        ).run(JSON.stringify(metadata), task.id);
        task.metadata = metadata;

        // Repository Desk provisioning: for git_change tasks, the factory (not
        // the LM) creates the worktree, selects the branch, and freezes the
        // base commit BEFORE the worker is spawned. The runner then starts the
        // worker with cwd = desk.executionPath, and the prompt shows the exact
        // machine-provisioned bindings. This eliminates the class of errors
        // where the model committed to the wrong branch or invented a worktree.
        if (task.execution_mode === 'git_change' || task.execution_mode === 'artifact_change') {
          const executionRef = input.assignment.execution_id;
          if (typeof executionRef !== 'string' || !executionRef) {
            throw new Error(`EFFECTIVE_DESK_BASE_EXECUTION_REQUIRED: task ${task.id}`);
          }
          const repositoryDesk = provisionRepositoryDesk(task, executionRef);
          if (repositoryDesk) {
            resolvedWorkspace = { ...resolvedWorkspace, repositoryDesk };
            // Persist the desk binding into task metadata so settlement and the
            // runner can verify the worker operated within the prepared desk.
            metadata.process_workspace = {
              ...(metadata.process_workspace as Record<string, unknown>),
              repository_desk: {
                role: repositoryDesk.role,
                execution_path: repositoryDesk.executionPath,
                repository_root: repositoryDesk.repositoryRoot,
                project_repository_id: repositoryDesk.projectRepositoryId,
                git: repositoryDesk.git,
              },
            };
            getDb().prepare(
              `UPDATE tasks SET metadata=?, updated_at=datetime('now') WHERE id=?`,
            ).run(JSON.stringify(metadata), task.id);
            getDb().prepare(
              `UPDATE worker_executions
                  SET metadata=json_set(metadata, '$.repository_desk', json(?))
                WHERE execution_id=? AND task_id=?`,
            ).run(JSON.stringify(repositoryDesk), executionRef, task.id);
            task.metadata = metadata;
          } else if (task.execution_mode === 'artifact_change') {
            const base = getDb().prepare(
              `SELECT r.receipt_ref AS receipt_ref, r.receipt_digest AS receipt_digest,
                      r.effective_base_commit AS effective_base_commit,
                      r.observed_integration_head AS observed_integration_head,
                      base.id AS project_repository_id,
                      base.integration_branch AS integration_branch,
                      base.local_path AS repository_local_path
                 FROM factory_effective_desk_base_receipts r
                 JOIN tasks t ON t.id=r.task_id
                 JOIN project_repositories base ON base.id=t.project_repository_id
                WHERE r.execution_ref=?`,
            ).get(executionRef) as Record<string, unknown> | undefined;
            if (base) {
              // The managed author's tracker promises a read-only source
              // snapshot "supplied by the Factory". Carry the repository path
              // alongside the base receipt so the runner can materialize the
              // exact tree into the execution workspace — without it the
              // author is blind (observed live: five submissions editing one
              // file from model memory, unable to see the code under repair).
              metadata.process_workspace = {
                ...(metadata.process_workspace as Record<string, unknown>),
                source_snapshot: base,
              };
              getDb().prepare(
                `UPDATE tasks SET metadata=?,updated_at=datetime('now') WHERE id=?`,
              ).run(JSON.stringify(metadata), task.id);
              task.metadata = metadata;
            }
          }
        }
        return resolvedWorkspace;
      },
      captureWorkspace: () => {
        // Retired test-warm-start sidecar; the hook stays for the runner contract.
      },
    };

    const runner = createClaudeBoardRunner(runnerOptions);
    // CONVEYOR v4.3 PART 1-2: in-process replay production source. When a
    // frozen capsule_ref is present on the assignment, the executor runs this
    // instead of spawning the CLI. The replay adapter publishes through the
    // SAME MCP handler surface (product_submit, artifact_create, trace_add,
    // worker_done) and the normal GateRun decides acceptance. This is the ONE
    // replay path; there is no simulator route.
    const replayRunner = createInProcessReplayRunner();
    return new ClaudeBoardWorkerExecutor(
      runner as unknown as ClaudeBoardRunner,
      replayRunner,
    );
  };
}

/**
 * Build the in-process replay function. Resolves the saga handler containers
 * (the SAME handlers exposed over MCP to a spawned worker), locates the
 * RepositoryDesk cwd from the frozen execution context, and runs the capsule
 * replay executor. Invoked only when the assignment carries a frozen
 * execution_context.replay.capsule_ref.
 */
function createInProcessReplayRunner(): InProcessReplayFn {
  const handlers: CapsuleReplayHandlers = {
    product_submit: input =>
      (productHandlers.handlers['product_submit'] as (input: unknown) => unknown)(input),
    artifact_create: input =>
      (artifactHandlers.handlers['artifact_create'] as (input: unknown) => {
        artifact?: { id?: number };
      })(input),
    trace_add: input =>
      // trace_add is exported by the artifacts tool container, not lifecycle.
      (artifactHandlers.handlers['trace_add'] as (input: unknown) => unknown)(input),
    worker_done: input =>
      (dispatcherHandlers.handlers['worker_done'] as (input: unknown) => unknown)(input),
  };
  return ({ assignment }) => {
    const cwd = readRepositoryDeskCwd(assignment);
    const db = getDb();
    // The in-process replay calls the SAME MCP handlers a spawned worker uses.
    // Those handlers resolve managed-execution provenance from process.env
    // (SAGA_MANAGED_EXECUTION / SAGA_EXECUTION_ID / SAGA_TASK_ID /
    // SAGA_WORKER_ID). A spawned MCP worker gets these from the runner's spawn
    // env; the in-process replay must set them itself so product_submit /
    // artifact_create / worker_done bind to the frozen execution authority.
    process.env.SAGA_MANAGED_EXECUTION = '1';
    process.env.SAGA_EXECUTION_ID = assignment.workerExecutionId;
    process.env.SAGA_TASK_ID = String(assignment.taskId);
    process.env.SAGA_WORKER_ID = assignment.workerId;
    // Mark the execution as running so product_submit / worker_done accept it.
    // A spawned worker is marked running by the runner after spawn; the
    // in-process replay must transition the execution from reserved → running
    // itself. No PID/birthToken needed (no OS process).
    db.prepare(
      `UPDATE worker_executions
          SET state='running', started_at=datetime('now'), phase_updated_at=datetime('now')
        WHERE execution_id=? AND state='reserved'`,
    ).run(assignment.workerExecutionId);
    try {
      executeCapsuleReplay(db, handlers, {
        taskId: Number(assignment.taskId),
        workerId: assignment.workerId,
        executionId: assignment.workerExecutionId,
        cwd,
      });
      // The capsule replay submits products/artifacts/traces and the recorded
      // git commit, then completes via worker_done so the normal lifecycle
      // advancement and GateRun run exactly as after a real inference execution.
      handlers.worker_done({
        task_id: Number(assignment.taskId),
        worker_id: assignment.workerId,
        result: 'capsule replay: reconstructed accepted worker production',
        execution_id: assignment.workerExecutionId,
      });
      // The in-process replay has no OS process; mark the execution exited so
      // the supervisor does not reap it as lost (no PID to probe). This runs
      // AFTER worker_done so the lifecycle sees a proper finishing → exited
      // transition.
      db.prepare(
        `UPDATE worker_executions
            SET state='exited', exit_code=0, finished_at=datetime('now'),
                phase_updated_at=datetime('now')
          WHERE execution_id=? AND state IN ('running','finishing')`,
      ).run(assignment.workerExecutionId);
    } finally {
      // Clean up the env vars so they don't leak to the next non-replay
      // execution (which resolves provenance from the spawned worker's env).
      delete process.env.SAGA_MANAGED_EXECUTION;
      delete process.env.SAGA_EXECUTION_ID;
      delete process.env.SAGA_TASK_ID;
      delete process.env.SAGA_WORKER_ID;
    }
  };
}

function readRepositoryDeskCwd(assignment: AssignedWork): string {
  const ctx = assignment.executionContext as
    | { repository_desk?: { execution_path?: string } }
    | null
    | undefined;
  const p = ctx?.repository_desk?.execution_path;
  return typeof p === 'string' && p ? p : process.cwd();
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

/**
 * Provision a RepositoryDesk for one git_change task. Determines the role
 * (author/reviewer), resolves the repository binding + base commit, and calls
 * the provisioner. Returns null when the task has no repository binding
 * (non-git modules like planner — execution_mode='tracker_only').
 */
function provisionRepositoryDesk(
  task: {
    id: number;
    status: string;
    execution_mode?: string | null;
    workplace_ref?: string | null;
    project_repository_id?: number | null;
    metadata?: unknown;
  },
  executionRef: string,
): RepositoryDesk | null {
  const db = getDb();
  const taskRepoId = typeof task.project_repository_id === 'number'
    ? task.project_repository_id
    : null;
  if (taskRepoId === null) return null;

  // Resolve the repository binding (consistent with dispatcher COALESCE).
  const repoRow = db.prepare(
    `SELECT pr.id, pr.integration_branch, pr.local_path,
            COALESCE(rc.local_path, pr.local_path) AS resolved_local_path
       FROM project_repositories pr
       LEFT JOIN repository_checkouts rc
         ON rc.project_repository_id=pr.id AND rc.status='active'
      WHERE pr.id=?`,
  ).get(taskRepoId) as {
    id: number;
    integration_branch: string;
    local_path: string;
    resolved_local_path: string;
  } | undefined;
  if (!repoRow || !repoRow.resolved_local_path) return null;

  const provisioner = new RepositoryDeskProvisioner();
  const isReview = task.status === 'review' || task.status === 'review_in_progress';
  const integrationBranch = repoRow.integration_branch || 'dev';

  if (isReview) {
    // Reviewer: read-only detached checkout of the frozen CandidateSet source
    // commit bound to this review task's exact subject.
    const metadata = parseTaskMetadata(task.metadata);
    const subjectCandidateSetRef = typeof metadata.subject_candidate_set_ref === 'string'
      ? metadata.subject_candidate_set_ref
      : null;
    const sourceCommit = readAcceptedSourceCommit(
      db,
      task.workplace_ref ?? null,
      subjectCandidateSetRef,
    );
    if (!sourceCommit) {
      throw new Error(
        `REVIEWER_REPOSITORY_SUBJECT_MISSING: task ${task.id} has no exact `
        + `author source for ${subjectCandidateSetRef ?? '<missing>'}`,
      );
    }
    return provisioner.provisionReviewerDesk({
      repositoryRoot: repoRow.resolved_local_path,
      taskId: task.id,
      sourceCommit,
      projectRepositoryId: taskRepoId,
      integrationBranch,
    });
  }

  // Roots use the frozen stage lineage anchor. Dependents use the actual
  // post-dependency integration head. The Factory freezes that choice in an
  // immutable per-execution receipt before the process is spawned.
  const baseReceipt = resolveEffectiveDeskBase(db, {
    executionRef,
    task,
    repository: {
      id: taskRepoId,
      integrationBranch,
      repositoryRoot: repoRow.resolved_local_path,
    },
  });
  if (task.execution_mode === 'artifact_change') return null;
  return provisioner.provisionAuthorDesk({
    repositoryRoot: repoRow.resolved_local_path,
    taskId: task.id,
    executionRef,
    integrationBranch,
    baseCommit: baseReceipt.effectiveBaseCommit,
    projectRepositoryId: taskRepoId,
    expectedIntegrationHead: baseReceipt.observedIntegrationHead,
    effectiveBaseReceiptRef: baseReceipt.receiptRef,
    effectiveBaseReceiptDigest: baseReceipt.receiptDigest,
  });
}

/**
 * Read the source commit from the exact author CandidateSet frozen into the
 * reviewer WorkIntent. Never query "latest" across repair generations.
 */
function readAcceptedSourceCommit(
  db: ReturnType<typeof getDb>,
  workplaceRef: string | null,
  candidateSetRef: string | null,
): string | null {
  if (!workplaceRef || !candidateSetRef) return null;
  const row = db.prepare(
    `SELECT s.payload_snapshot
       FROM factory_candidate_sets cs
       JOIN factory_candidate_set_members m
         ON m.candidate_set_ref=cs.candidate_set_ref
        AND m.product_ref LIKE 'managed-node-submission:%'
       JOIN factory_managed_node_submissions s
         ON s.id=CAST(substr(m.product_ref,25) AS INTEGER)
        AND s.schema_version=m.product_schema
        AND s.content_hash=m.product_digest
      WHERE cs.workplace_ref=? AND cs.candidate_set_ref=? AND cs.role='author'
      LIMIT 1`,
  ).get(workplaceRef, candidateSetRef) as { payload_snapshot: string } | undefined;
  if (!row?.payload_snapshot) return null;
  try {
    const payload = JSON.parse(row.payload_snapshot) as {
      source?: { commitSha?: unknown };
    };
    const sha = payload.source?.commitSha;
    return typeof sha === 'string' && sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Read the expectedBaseCommit from the frozen DevelopmentCase integration
 * targets, scoped to this task's repository. Falls back to null → provisioner
 * uses the integration branch HEAD.
 */
