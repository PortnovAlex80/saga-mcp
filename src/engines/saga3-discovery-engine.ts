import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';
import type { Saga2HostRuntime } from '../application/ports/saga2-host-runtime.js';
import type { Saga2RuntimePersistence } from '../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import type { SagaRuntimeConfig } from '../runtime/saga-runtime-config.js';
import { getDb } from '../db.js';
import {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
  type CreateWorkIntent,
} from '../saga3/domain/work-intent.js';
import {
  provisionalOutcomeFromProposal,
  validateDiscoveryProposal,
  type DiscoveryOutcome,
  type DiscoveryProposalPayload,
} from '../saga3/domain/discovery-proposal.js';
import { Saga3ProposalRepository } from '../saga3/persistence/saga3-proposal-repository.js';

/**
 * Task kind / skill for the discovery WorkIntent's board projection.
 *
 * The task is NOT the WorkIntent — it is the visible board projection of it
 * (roadmap: WorkIntent → projected_as → task → executed_by → worker execution
 * → produces → Proposal). The worker reads metadata.work_intent_id to know
 * which intent it answers, and submits via proposal_submit.
 */
const DISCOVERY_TASK_KIND = 'discovery.work';
const DISCOVERY_SKILL = 'saga-discovery-worker';

/** Idempotency key: one discovery task per epic (UNIQUE on epic_id+generation_key). */
function discoveryGenerationKey(intentId: number): string {
  return `saga3:discovery:${intentId}`;
}

/**
 * DiscoveryEdition run output (roadmap §5.3 partial-pipeline fields + outcome).
 * outcomeAuthority='worker_proposal' marks this as PROVISIONAL: D4 settlement
 * is what makes a discovery outcome authoritative.
 */
export interface DiscoveryRunOutcome {
  outcome: DiscoveryOutcome | 'discovery_not_implemented';
  outcomeAuthority: 'worker_proposal' | 'none';
  proposalId: number | null;
  proposalHash: string | null;
}

export interface Saga3DiscoveryEngineDependencies {
  config: SagaRuntimeConfig;
  workerExecutorFactory: WorkerExecutorFactory;
  persistence: Saga2RuntimePersistence;
  host: Saga2HostRuntime;
  /** Proposal/intent repository. Defaults to the SQLite implementation. */
  proposalRepository?: Saga3ProposalRepository;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Max wall-clock seconds the engine waits for a proposal before timing out. */
  maxRunSeconds?: number;
  /** Poll interval between executor status checks. */
  pollMs?: number;
}

/**
 * Saga 3 Discovery Edition orchestration engine — D1.
 *
 * Roadmap §8.D1. Unlike the D0 shell, this engine runs REAL product work:
 *
 *   WorkIntent
 *     → projected_as one board task (task_kind=discovery.work)
 *     → executed_by the existing WorkerExecutorFactory / ClaudeBoardRunner
 *       (concurrency=1, the same worker-execution substrate Saga 2 uses — NOT a
 *       second claim/fencing/MCP path)
 *     → the worker submits a typed DiscoveryProposal via proposal_submit
 *     → engine reads the latest proposal, records a PROVISIONAL outcome
 *
 * What this engine does NOT do (deferred): deterministic normalization (D2),
 * readiness advisor (D3), authoritative settlement + certificate (D4), anomaly
 * diagnosis (D5), stage transition. The discovery-only run terminates with a
 * provisional outcome and `scope_completed` set only when a valid proposal was
 * submitted. An absent or invalid proposal yields `inconclusive` / `failed`
 * honestly — never a false 'completed'.
 *
 * The worker-execution substrate is the existing ClaudeBoardRunner reached
 * through WorkerExecutorFactory. This is NOT the Saga 2 product orchestrator:
 * ClaudeBoardRunner only does claim → execution fence → spawn → wait. The
 * product policy (what to create next, whether to advance) stays in this
 * engine, which is much thinner than the Saga 2 pump.
 */
export class Saga3DiscoveryEngine implements OrchestrationEngine {
  private readonly deps: Saga3DiscoveryEngineDependencies;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRunMs: number;
  private readonly pollMs: number;

  constructor(dependencies: Saga3DiscoveryEngineDependencies) {
    this.deps = dependencies;
    this.now = dependencies.now ?? (() => new Date());
    this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maxRunMs = (dependencies.maxRunSeconds ?? 60 * 30) * 1000;
    this.pollMs = dependencies.pollMs ?? 3000;
  }

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const { projectId, epicId } = command;
    const startedAt = this.now().getTime();
    const host = this.deps.host;
    const heartbeat = (event: string, message: string) =>
      host.heartbeat({ projectId, epicId }, event, message);

    // Engine lock — only one engine per (project, epic) at a time. Same PID
    // ownership used by Saga 2, so the two engines cannot run simultaneously.
    const lock = host.acquireEngineLock({ projectId, epicId });
    if (lock.status === 'duplicate') {
      heartbeat('DUPLICATE_EXIT', `ownerPid=${lock.ownerPid}`);
      return this.runResult(projectId, epicId, 'failed', 0,
        `another engine owns episode (PID ${lock.ownerPid})`,
        { outcome: 'discovery_not_implemented', outcomeAuthority: 'none', proposalId: null, proposalHash: null });
    }

    try {
      return await this.runDiscovery(projectId, epicId, heartbeat, startedAt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      heartbeat('ABORT', msg);
      return this.runResult(projectId, epicId, 'failed', 0, msg,
        { outcome: 'failed', outcomeAuthority: 'none', proposalId: null, proposalHash: null });
    } finally {
      try { host.releaseEngineLock({ projectId, epicId }); } catch { /* best effort */ }
    }
  }

  private async runDiscovery(
    projectId: number,
    epicId: number,
    heartbeat: (event: string, message: string) => void,
    startedAt: number,
  ): Promise<OrchestrationRunResult> {
    const { workerExecutorFactory, persistence, host } = this.deps;
    const repo = this.deps.proposalRepository ?? new Saga3ProposalRepository();

    heartbeat('ENGINE_START', 'saga3-discovery D1');

    // Resolve workspace — the executor needs a registered checkout.
    const workspace = persistence.workspaces.resolve(projectId);
    if (!workspace.workspaceRoot) {
      throw new Error(`saga3-discovery: no workspace for project ${projectId}; register a repository first`);
    }

    // 1. Idempotent WorkIntent — re-use the open one if a previous run created it.
    let intent = repo.readOpenIntentByEpic(epicId, DISCOVERY_INTENT_KIND);
    if (!intent) {
      const objective = this.readObjective(epicId);
      const create: CreateWorkIntent = {
        epic_id: epicId,
        kind: DISCOVERY_INTENT_KIND,
        objective,
        authority_scope: {
          snapshot_ref: `episode:${epicId}`,
          scope: 'read-only discovery context',
          allowed_tools: ['proposal_submit', 'worker_done'],
        },
        output_schema: DISCOVERY_WORK_INTENT_SCHEMA,
        token_budget: 0,
        retry_budget: 0,
      };
      intent = repo.createWorkIntent(create);
      heartbeat('INTENT_CREATED', `id=${intent.id}`);
    }

    // 2. Idempotent board-task projection (generation_key UNIQUE per epic).
    const taskId = this.ensureDiscoveryTask(projectId, epicId, intent.id, intent.objective);
    if (!intent.projected_task_id) repo.setProjectedTask(intent.id, taskId);

    // 3. Start the worker-execution substrate ONCE. concurrency=1 — D1 runs a
    //    single discovery worker. The substrate claims the task, spawns the
    //    worker, fences the execution, and waits. We poll the proposal table.
    const executor = workerExecutorFactory({
      projectId,
      epicId,
      workspaceRoot: workspace.workspaceRoot,
      dbPath: this.deps.config.dbPath,
      sagaEntry: host.workerPaths.sagaEntry,
      sagaSkillRoot: host.workerPaths.sagaSkillRoot,
      claudePath: this.deps.config.claudePath,
      logRoot: host.workerPaths.logRoot,
      heartbeatLog: host.workerPaths.heartbeatLog,
      lmStudioUrl: this.deps.config.lmStudioUrl,
    });

    try {
      try {
        executor.start({ projectId, epicId, concurrency: 1 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already has an active board run/.test(msg)) throw err;
      }
      heartbeat('EXECUTOR_STARTED', `task=${taskId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      repo.setIntentStatus(intent.id, 'concluded');
      return this.runResult(projectId, epicId, 'failed', 0, msg,
        { outcome: 'failed', outcomeAuthority: 'none', proposalId: null, proposalHash: null });
    }

    // 4. Poll until: proposal submitted, task terminal, executor dead, or timeout.
    let cycles = 0;
    let terminal: 'proposal' | 'task_terminal' | 'executor_dead' | 'timeout' = 'timeout';
    while (true) {
      cycles += 1;
      heartbeat('CYCLE', `cycle=${cycles}`);
      const proposal = repo.readLatestProposalForIntent(intent.id);
      if (proposal) {
        terminal = 'proposal';
        break;
      }
      const taskStatus = this.taskStatus(taskId);
      if (taskStatus === 'done' || taskStatus === 'blocked') {
        terminal = 'task_terminal';
        break;
      }
      const run = executor.status(projectId);
      if (run === null) {
        terminal = 'executor_dead';
        break;
      }
      if (this.now().getTime() - startedAt > this.maxRunMs) {
        terminal = 'timeout';
        break;
      }
      await this.sleep(this.pollMs);
    }

    // Best-effort stop of the substrate (one discovery task only).
    try { executor.stop(projectId); } catch { /* best effort */ }

    // 5. Provisional outcome (roadmap §8.D1). NOT authoritative — D4 settles.
    repo.setIntentStatus(intent.id, 'concluded');
    const proposal = repo.readLatestProposalForIntent(intent.id);
    let outcome: DiscoveryRunOutcome;
    let finalStage = persistence.episodes.currentStage(epicId) ?? 'discovery';
    if (proposal) {
      const validation = validateDiscoveryProposal(proposal.payload);
      if (validation.valid) {
        const payload = proposal.payload as DiscoveryProposalPayload;
        const provisional = provisionalOutcomeFromProposal(payload);
        outcome = {
          outcome: provisional.outcome, outcomeAuthority: provisional.authority,
          proposalId: proposal.id, proposalHash: proposal.content_hash,
        };
        heartbeat('PROPOSAL_VALID', `id=${proposal.id} outcome=${provisional.outcome}`);
      } else {
        // Malformed proposal → honest non-success (roadmap D1 exit gate).
        outcome = {
          outcome: 'inconclusive', outcomeAuthority: 'none',
          proposalId: proposal.id, proposalHash: proposal.content_hash,
        };
        heartbeat('PROPOSAL_INVALID', `errors=${validation.errors.join(';')}`);
      }
    } else {
      // No proposal submitted (timeout / task terminal without submission).
      outcome = { outcome: terminal === 'timeout' ? 'inconclusive' : 'failed',
        outcomeAuthority: 'none', proposalId: null, proposalHash: null };
      heartbeat('NO_PROPOSAL', `terminal=${terminal}`);
    }

    // Discovery Edition never advances the stage and never marks the product
    // completed (roadmap §5.3). scope_completed reflects only whether the
    // discovery-only slice reached a valid proposal.
    const reason: OrchestrationRunResult['reason'] =
      outcome.outcome === 'discovery_not_implemented' ? 'discovery_not_implemented' : 'completed';
    const scopeCompleted = outcome.outcome !== 'inconclusive'
      && outcome.outcome !== 'failed'
      && outcome.outcome !== 'discovery_not_implemented'
      && proposal !== null;

    return this.runResult(projectId, epicId, reason, cycles, null, outcome, finalStage, scopeCompleted);
  }

  // --- helpers ---------------------------------------------------------------

  private readObjective(epicId: number): string {
    const db = getDb();
    const row = db.prepare(
      `SELECT e.name, e.description FROM epics e WHERE e.id=?`,
    ).get(epicId) as { name: string; description: string | null } | undefined;
    return row?.description || row?.name || `discovery for epic ${epicId}`;
  }

  /**
   * Create the discovery board task if absent (idempotent via generation_key
   * UNIQUE index). Returns the task id (existing or newly created).
   */
  private ensureDiscoveryTask(projectId: number, epicId: number, intentId: number, objective: string): number {
    const db = getDb();
    const key = discoveryGenerationKey(intentId);
    const existing = db.prepare(
      `SELECT id FROM tasks WHERE epic_id=? AND generation_key=?`,
    ).get(epicId, key) as { id: number } | undefined;
    if (existing) return existing.id;

    const repoId = this.repoForProject(projectId);
    const info = db.prepare(
      `INSERT INTO tasks
         (epic_id, title, description, status, priority, task_kind, workflow_stage,
          execution_skill, execution_mode, project_repository_id, generation_key, tags, metadata)
       VALUES (?, ?, ?, 'todo', 'high', ?, 'discovery', ?, 'tracker_only', ?, ?, '[]', ?)`,
    ).run(
      epicId,
      `Discovery: ${objective.slice(0, 80)}`,
      JSON.stringify({ work_intent_id: intentId, objective }),
      DISCOVERY_TASK_KIND,
      DISCOVERY_SKILL,
      repoId,
      key,
      JSON.stringify({ work_intent_id: intentId }),
    );
    return Number(info.lastInsertRowid);
  }

  private repoForProject(projectId: number): number | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT id FROM project_repositories WHERE project_id=? ORDER BY id LIMIT 1`,
    ).get(projectId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private taskStatus(taskId: number): string | null {
    const db = getDb();
    const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string } | undefined;
    return row?.status ?? null;
  }

  private runResult(
    projectId: number,
    epicId: number,
    reason: OrchestrationRunResult['reason'],
    cycles: number,
    lastError: string | null,
    outcome: DiscoveryRunOutcome,
    finalStage = 'discovery',
    scopeCompleted = false,
  ): OrchestrationRunResult {
    return {
      projectId,
      epicId,
      finalStage,
      endedAt: this.now().toISOString(),
      reason,
      cycles,
      lastError,
      pipelineScope: 'discovery_only',
      scopeCompleted,
      outcome: outcome.outcome,
    };
  }
}
