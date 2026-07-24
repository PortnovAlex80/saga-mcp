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
import type { DiscoveryNormalizationService } from '../saga3/application/discovery-normalization-service.js';

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
  outcomeAuthority: 'worker_proposal' | 'normalized_worker_proposal' | 'none';
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
  normalizationService: DiscoveryNormalizationService;
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
          // D1.1: runtime-enforced. The MCP gateway (authorizeSagaToolCall)
          // checks the frozen execution_context snapshot against every Saga
          // tool call and denies anything outside allowed_tools with
          // AUTHORITY_DENIED. The worker cannot expand its own authority; only
          // a new WorkIntent issued by the kernel can.
          enforcement: 'runtime',
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

    const preparation = rt.prepareIntentForExecution(intent.id, taskId);
    if (preparation.state === 'active') {
      return this.runResult(projectId, epicId, 'stopped', 0, preparation.detail,
        { outcome: 'inconclusive', outcomeAuthority: 'none', proposalId: null, proposalHash: null });
    }
    if (preparation.state === 'blocked') {
      return this.runResult(projectId, epicId, 'failed', 0, preparation.detail,
        { outcome: 'failed', outcomeAuthority: 'none', proposalId: null, proposalHash: null });
    }
    if (preparation.state === 'done') {
      const existingProposal = rt.readLatestProposal(intent.id);
      const valid = existingProposal !== null && validateDiscoveryProposal(existingProposal.payload).valid;
      if (intent.status === 'executing') rt.setIntentStatus(intent.id, 'executing', 'concluded');
      if (intent.status === 'paused') rt.setIntentStatus(intent.id, 'paused', 'concluded');
      const existingOutcome = valid
        ? provisionalOutcomeFromProposal(existingProposal!.payload as DiscoveryProposalPayload)
        : { outcome: 'failed' as const, authority: 'none' as const };
      return this.runResult(projectId, epicId, valid ? 'completed' : 'failed', 0,
        valid ? null : 'discovery task is done without a valid proposal',
        { outcome: existingOutcome.outcome, outcomeAuthority: existingOutcome.authority,
          proposalId: existingProposal?.id ?? null, proposalHash: existingProposal?.content_hash ?? null },
        persistence.episodes.currentStage(epicId) ?? 'discovery', valid);
    }

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
      // Start the substrate. An "already has an active board run" is NOT a
      // recoverable case for the Saga 3 engine: the factory builds a fresh
      // runner per executor, so this error signals a stray run from another
      // intent/process with unknown claimScope. Treat it as a conflict and
      // fail rather than poll an unknown runner (review P1).
      executor.start({ projectId, epicId, concurrency: 1, claimScope: { taskIds: [taskId] } });
      // open/paused → executing once the substrate has accepted the run.
      rt.setIntentStatus(intent.id, preparation.intentStatus, 'executing');
      heartbeat('EXECUTOR_STARTED', `task=${taskId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.runResult(projectId, epicId, 'failed', 0, msg,
        { outcome: 'failed', outcomeAuthority: 'none', proposalId: null, proposalHash: null });
    }

    // 4. Poll for execution closure, not just task terminality. Three
    //    independent signals combine into a terminal verdict:
    //      - task status (done/blocked): the worker called worker_done
    //      - run.active: whether THIS task's claude process is still spawning/
    //        closing (worker_done flips task.status before the claude process
    //        exits and the runner's close handler runs)
    //      - run.status: terminal runner states (completed/failed/stopped)
    //        with a non-terminal task mean the substrate gave up without the
    //        worker reaching worker_done (e.g. spawn failure, empty claim) —
    //        the engine must not wait 30min for a timeout that already happened.
    //    Observing a Proposal is NOT terminal: the worker must still call
    //    worker_done and its claude process must exit.
    let cycles = 0;
    let seenProposal = false;
    let terminal:
      | 'clean'              // task DONE AND worker process gone AND run healthy
      | 'task_blocked'       // task blocked (non-clean stop) AND worker gone
      | 'executor_failed'    // run.status=failed (checked BEFORE clean — masks nothing)
      | 'executor_dead'      // status() returned null (run vanished)
      | 'stopped'            // explicit external stop; preserve intent for resume
      | 'timeout'
      | 'task_unclaimed' = 'timeout'; // run reached terminal healthy without task done
    while (true) {
      cycles += 1;
      heartbeat('CYCLE', `cycle=${cycles}${seenProposal ? ' (proposal seen, waiting worker_done)' : ''}`);
      const proposal = rt.readLatestProposal(intent.id);
      if (proposal) seenProposal = true;
      const taskStatus = rt.readTaskState(taskId);
      // worker_done ends a task in 'done' (happy path) or cycles it to 'review'
      // / back to 'todo'. It NEVER ends in 'blocked' — blocked means the work
      // did NOT complete cleanly (a blocker / human request / failure). Only
      // 'done' counts as clean worker closure.
      const taskDone = taskStatus === 'done';
      const taskBlocked = taskStatus === 'blocked';
      const run = executor.status(projectId);
      const runIsNull = run === null;
      const runStatus = run?.status ?? null;
      const runCompleted = runStatus === 'completed';
      const runStopped = runStatus === 'stopped';
      const runFailed = runStatus === 'failed';
      const taskStillActive = run?.active?.some(w => w.task_id === taskId) ?? false;

      if (runIsNull) {
        terminal = 'executor_dead';
        break;
      }
      // Substrate failed (e.g. claim threw, spawn failed). Checked BEFORE clean
      // so a run.status=failed with task=done is reported honestly as a
      // substrate failure, not masked as a clean closure.
      if (runFailed) {
        terminal = 'executor_failed';
        break;
      }
      if (runStopped) {
        terminal = 'stopped';
        break;
      }
      // Clean closure: task reached worker_done ('done' only) AND its claude
      // process has left run.active (close handler ran).
      if (taskDone && !taskStillActive) {
        terminal = 'clean';
        break;
      }
      // task blocked: the work did NOT complete cleanly (blocker / human
      // request / failure). The worker has exited (not in run.active). This is
      // NOT a clean closure — scopeCompleted stays false, reason='failed'.
      if (taskBlocked && !taskStillActive) {
        terminal = 'task_blocked';
        break;
      }
      // Substrate finished its loop (completed/stopped) but the task never
      // reached done — the worker either never claimed it or bailed. Do not
      // wait for a timeout that will never come.
      if (runCompleted && !taskDone) {
        terminal = 'task_unclaimed';
        break;
      }
      if (this.now().getTime() - startedAt > this.maxRunMs) {
        terminal = 'timeout';
        break;
      }
      await this.sleep(this.pollMs);
    }

    // Only stop the substrate on a HARD exit. On a clean closure the worker
    // already exited on its own; stop() is reserved for timeout/dead/failed.
    if (terminal !== 'clean') {
      try { executor.stop(projectId); } catch { /* best effort */ }
    }

    // Only a clean closure concludes the intent. Every interruption is paused
    // so restart reuses the same intent and projected task.
    if (terminal === 'clean') rt.setIntentStatus(intent.id, 'executing', 'concluded');
    else rt.setIntentStatus(intent.id, 'executing', 'paused');

    // D2: deterministic normalization happens inside proposal_submit. Only a
    // semantic ambiguity creates a bounded cognitive-control worker. The raw
    // response is immutable and the normalizer can only propose a transform.
    let proposal = rt.readLatestProposal(intent.id);
    let normalizationError: string | null = null;
    if (terminal === 'clean' && !proposal) {
      const raw = rt.readLatestRawSubmission(intent.id);
      if (raw?.status === 'normalization_required') {
        const normalized = await this.deps.normalizationService.normalize({
          projectId,
          epicId,
          sourceSubmissionId: raw.id,
          objective: intent.objective,
          workspaceRoot: workspace.workspaceRoot,
          heartbeat,
        });
        cycles += normalized.cycles;
        normalizationError = normalized.error;
        proposal = rt.readLatestProposal(intent.id);
      } else if (raw?.status === 'rejected_syntax') {
        normalizationError = 'worker response was not strict JSON after deterministic fence removal';
      } else if (raw && !proposal) {
        normalizationError = `raw submission ${raw.id} status='${raw.status}' produced no canonical proposal`;
      }
    }

    // 5. Provisional outcome. A normalized proposal is still non-authoritative;
    // D4 settlement owns the eventual committed outcome.
    let outcome: DiscoveryRunOutcome;
    if (proposal) {
      const validation = validateDiscoveryProposal(proposal.payload);
      if (validation.valid) {
        const payload = proposal.payload as DiscoveryProposalPayload;
        const provisional = provisionalOutcomeFromProposal(payload);
        const normalizedAuthority = proposal.provenance?.normalization_mode === 'lm_transformation'
          ? 'normalized_worker_proposal' as const
          : provisional.authority;
        outcome = {
          outcome: provisional.outcome, outcomeAuthority: normalizedAuthority,
          proposalId: proposal.id, proposalHash: proposal.content_hash,
        };
        heartbeat('PROPOSAL_VALID', `id=${proposal.id} outcome=${provisional.outcome} terminal=${terminal}`);
      } else {
        // Malformed proposal → honest non-success (roadmap D1 exit gate).
        outcome = {
          outcome: 'inconclusive', outcomeAuthority: 'none',
          proposalId: proposal.id, proposalHash: proposal.content_hash,
        };
        heartbeat('PROPOSAL_INVALID', `errors=${validation.errors.join(';')}`);
      }
    } else {
      // No proposal submitted. Map terminal condition to an honest outcome.
      outcome = {
        outcome: terminal === 'timeout' ? 'inconclusive' : 'failed',
        outcomeAuthority: 'none', proposalId: null, proposalHash: null,
      };
      heartbeat('NO_PROPOSAL', `terminal=${terminal}`);
    }

    // Discovery Edition never advances the stage and never marks the product
    // completed (roadmap §5.3). scopeCompleted is decoupled from the BUSINESS
    // outcome but tightly coupled to the CLEAN terminal verdict: true iff the
    // slice ran to a clean worker closure ('done', process gone) AND a
    // structurally valid proposal exists. A valid 'clarify'/'reject'/'failed'
    // proposal on a clean closure still completes the discovery scope. A
    // blocked task, a failed substrate, a timeout, or an absent/invalid
    // proposal leaves the scope incomplete regardless of business outcome.
    const validProposal = proposal !== null && validateDiscoveryProposal(proposal.payload).valid;
    const scopeCompleted = terminal === 'clean' && validProposal;
    const finalStage = persistence.episodes.currentStage(epicId) ?? 'discovery';

    // reason must reflect the actual terminal condition, not always 'completed'.
    //   clean            → completed
    //   timeout          → paused_timeout (bounded execution honour; not 'completed')
    //   task_blocked     → failed (blocked is NOT a clean worker_done)
    //   executor_failed  → failed
    //   executor_dead    → failed
    //   task_unclaimed   → failed (substrate gave up without worker_done)
    const reason: OrchestrationRunResult['reason'] =
      terminal === 'clean' ? (validProposal ? 'completed' : 'failed')
      : terminal === 'timeout' ? 'paused_timeout'
      : terminal === 'stopped' ? 'stopped'
      : 'failed';
    const lastError: string | null =
      terminal === 'clean' ? (validProposal ? null : normalizationError ?? 'clean worker closure without a valid proposal')
      : terminal === 'stopped' ? 'discovery execution was stopped; intent paused for resume'
      : terminal === 'timeout' ? `discovery run timed out after ${Math.round(this.maxRunMs / 1000)}s`
      : terminal === 'task_blocked' ? `discovery task ended blocked (terminal=${terminal}); not a clean worker closure`
      : `discovery substrate ended without clean worker closure (terminal=${terminal})`;
    return this.runResult(projectId, epicId, reason, cycles, lastError, outcome, finalStage, scopeCompleted);
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
