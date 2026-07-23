import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';
import type { Saga2HostRuntime } from '../application/ports/saga2-host-runtime.js';
import type { Saga2RuntimePersistence } from '../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import type { SagaRuntimeConfig } from '../runtime/saga-runtime-config.js';
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
import type { Saga3DiscoveryRuntimePersistence } from '../saga3/persistence/saga3-discovery-runtime-port.js';

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
 * Tools the discovery skill is permitted to call. MUST stay in sync with
 * skills/saga-discovery-worker/SKILL.md. Listed here (not invented per call)
 * so the WorkIntent contract and the skill document one allowlist.
 */
const DISCOVERY_ALLOWED_TOOLS = [
  'task_get',
  'repository_checkout_list',
  'artifact_list',
  'note_list',
  'proposal_submit',
  'worker_done',
];

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
  /** Saga 3 runtime persistence port (the only data access the engine uses). */
  runtimePersistence: Saga3DiscoveryRuntimePersistence;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Max wall-clock seconds the engine waits for the worker to finish. */
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
 *       second claim/fencing/MCP path), claim-scoped to exactly that task
 *     → the worker submits a typed DiscoveryProposal via proposal_submit
 *     → engine waits for the worker to reach worker_done (NOT for the proposal
 *       alone — observing a proposal is not a terminal condition), then
 *       records a PROVISIONAL outcome
 *
 * What this engine does NOT do (deferred): deterministic normalization (D2),
 * readiness advisor (D3), authoritative settlement + certificate (D4), anomaly
 * diagnosis (D5), stage transition, authority runtime-enforcement (D1.1).
 *
 * The engine consumes a persistence PORT only — no direct database handle, no
 * inline SQL, no concrete repository class. Phase B's pure-engine boundary is
 * preserved; the static architecture test guards against regression.
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
    const { workerExecutorFactory, persistence, host, runtimePersistence: rt } = this.deps;

    heartbeat('ENGINE_START', 'saga3-discovery D1');

    // Resolve workspace — the executor needs a registered checkout.
    const workspace = persistence.workspaces.resolve(projectId);
    if (!workspace.workspaceRoot) {
      throw new Error(`saga3-discovery: no workspace for project ${projectId}; register a repository first`);
    }

    // 1. Idempotent WorkIntent — re-use the open one if a previous run created it.
    let intent = rt.readOpenIntent(epicId, DISCOVERY_INTENT_KIND);
    if (!intent) {
      const epic = rt.readEpicObjective(epicId);
      const objective = epic?.description || epic?.name || `discovery for epic ${epicId}`;
      const create: CreateWorkIntent = {
        epic_id: epicId,
        kind: DISCOVERY_INTENT_KIND,
        objective,
        authority_scope: {
          snapshot_ref: `episode:${epicId}`,
          scope: 'read-only discovery context',
          allowed_tools: DISCOVERY_ALLOWED_TOOLS,
          // D1: advisory only — runtime enforcement is the D1.1 slice.
          enforcement: 'advisory',
        },
        output_schema: DISCOVERY_WORK_INTENT_SCHEMA,
        token_budget: 0,
        retry_budget: 0,
      };
      intent = rt.createIntent(create);
      heartbeat('INTENT_CREATED', `id=${intent.id}`);
    }

    // 2. Idempotent board-task projection (generation_key UNIQUE per epic).
    const taskId = rt.ensureProjectedTask({
      epicId,
      projectId,
      intentId: intent.id,
      objective: intent.objective,
      taskKind: DISCOVERY_TASK_KIND,
      executionSkill: DISCOVERY_SKILL,
      generationKey: discoveryGenerationKey(intent.id),
    });
    if (!intent.projected_task_id) rt.setProjectedTask(intent.id, taskId);

    // 3. Start the worker-execution substrate ONCE. concurrency=1 AND
    //    claim-scoped to exactly this task — the runner will not pick up any
    //    other task in the episode (e.g. a legacy discovery.kickstart).
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
        executor.start({ projectId, epicId, concurrency: 1, claimScope: { taskIds: [taskId] } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already has an active board run/.test(msg)) throw err;
      }
      // open → executing once the substrate has accepted the run.
      rt.setIntentStatus(intent.id, 'open', 'executing');
      heartbeat('EXECUTOR_STARTED', `task=${taskId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rt.setIntentStatus(intent.id, 'executing', 'concluded');
      return this.runResult(projectId, epicId, 'failed', 0, msg,
        { outcome: 'failed', outcomeAuthority: 'none', proposalId: null, proposalHash: null });
    }

    // 4. Poll until the worker reaches a terminal task state, OR a hard
    //    abort condition (executor died / timeout). Observing a Proposal is
    //    NOT a terminal condition: the worker must still call worker_done to
    //    close its execution fence, and killing the substrate between
    //    proposal_submit and worker_done triggers recovery ("exited before
    //    terminal worker_done"). We keep looping after a proposal appears,
    //    waiting for task done.
    let cycles = 0;
    let seenProposal = false;
    let terminal: 'task_terminal' | 'executor_dead' | 'timeout' = 'timeout';
    while (true) {
      cycles += 1;
      heartbeat('CYCLE', `cycle=${cycles}${seenProposal ? ' (proposal seen, waiting worker_done)' : ''}`);
      const proposal = rt.readLatestProposal(intent.id);
      if (proposal) seenProposal = true;
      const taskStatus = rt.readTaskState(taskId);
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

    // Only stop the substrate on a HARD exit. When the task reached a terminal
    // state the worker already exited on its own (it called worker_done); a
    // stop() here would be a redundant kill of an already-dead run and could
    // race the close handler. On timeout / executor_dead we DO stop to reclaim
    // any lingering worker process.
    if (terminal !== 'task_terminal') {
      try { executor.stop(projectId); } catch { /* best effort */ }
    }

    // executing → concluded (CAS; a restarted engine cannot clobber a different state).
    rt.setIntentStatus(intent.id, 'executing', 'concluded');

    // 5. Provisional outcome (roadmap §8.D1). NOT authoritative — D4 settles.
    const proposal = rt.readLatestProposal(intent.id);
    const taskStatus = rt.readTaskState(taskId);
    const workerReachedTerminal = taskStatus === 'done' || taskStatus === 'blocked';
    let outcome: DiscoveryRunOutcome;
    if (proposal) {
      const validation = validateDiscoveryProposal(proposal.payload);
      if (validation.valid) {
        const payload = proposal.payload as DiscoveryProposalPayload;
        const provisional = provisionalOutcomeFromProposal(payload);
        outcome = {
          outcome: provisional.outcome, outcomeAuthority: provisional.authority,
          proposalId: proposal.id, proposalHash: proposal.content_hash,
        };
        heartbeat('PROPOSAL_VALID', `id=${proposal.id} outcome=${provisional.outcome} taskDone=${workerReachedTerminal}`);
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
      outcome = {
        outcome: terminal === 'timeout' ? 'inconclusive' : 'failed',
        outcomeAuthority: 'none', proposalId: null, proposalHash: null,
      };
      heartbeat('NO_PROPOSAL', `terminal=${terminal}`);
    }

    // Discovery Edition never advances the stage and never marks the product
    // completed (roadmap §5.3). scopeCompleted is decoupled from the BUSINESS
    // outcome: it is true iff the discovery slice actually ran to completion —
    // i.e. a structurally valid proposal was submitted AND the worker reached a
    // terminal execution. A valid 'clarify'/'reject'/'failed' proposal with a
    // terminal worker still completes the discovery scope; the business verdict
    // is simply negative or non-go. An absent/invalid proposal, or a proposal
    // without a terminal worker, leaves the scope incomplete.
    const validProposal = proposal !== null && validateDiscoveryProposal(proposal.payload).valid;
    const scopeCompleted = validProposal && workerReachedTerminal;
    const finalStage = persistence.episodes.currentStage(epicId) ?? 'discovery';

    const reason: OrchestrationRunResult['reason'] = 'completed';
    return this.runResult(projectId, epicId, reason, cycles, null, outcome, finalStage, scopeCompleted);
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
      outcomeAuthority: outcome.outcomeAuthority,
      proposalId: outcome.proposalId,
      proposalHash: outcome.proposalHash,
    };
  }
}
