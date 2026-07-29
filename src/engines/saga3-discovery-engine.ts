import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
import { ensureDiscoveryWorkspace } from '../saga3/application/ensure-discovery-workspace.js';
import type { DiscoveryReadinessService } from '../saga3/application/discovery-readiness-service.js';
import type { DiscoverySettlementService, DiscoverySettlementResult, ProvisionalOutcome } from '../saga3/application/discovery-settlement-service.js';
import type {
  DiscoveryDiagnosisResult,
  DiscoveryDiagnosisService,
} from '../saga3/application/discovery-diagnosis-service.js';
import type { ReadinessShadowResult } from '../saga3/domain/discovery-readiness-assessment.js';
import type { ReadinessAssessmentRecord, ReadinessControlIntentRecord } from '../saga3/domain/discovery-readiness-records.js';

/**
 * The settlement view the engine threads through runResult. Extends the
 * service's result with the 'not_run' status for runs that did not invoke
 * settlement (no valid Proposal, or settlement not wired in tests).
 */
type EngineSettlementResult = Omit<DiscoverySettlementResult, 'status'> & {
  status: 'issued' | 'failed' | 'not_run';
};

/**
 * The diagnosis view the engine threads through runResult. A mirror of the
 * service's discriminated union (`DiscoveryDiagnosisResult`) plus a synthetic
 * 'not_run' status for runs that did not invoke diagnosis (no certificate, or
 * diagnosis not wired in tests). Like settlement, the engine constructs this
 * locally so the result object stays shaped even when the service is absent.
 *
 * ADVISORY ONLY (invariants I1/I2): this section never feeds back into the
 * top-level outcome/authority/scope/reason/finalStage fields. It is surfaced
 * separately in `OrchestrationRunResult.diagnosis` for observability.
 */
type EngineDiagnosisResult = {
  status: 'completed' | 'failed' | 'paused' | 'not_run';
  authority: 'advisory_diagnosis' | 'none';
  reportId: number | null;
  reportHash: string | null;
  target: { certificateId: number | null; certificateHash: string | null };
  summary: string | null;
  primaryCauses: string[];
  blockingGaps: string[];
  recommendedActions: string[];
  error: string | null;
};

/** Build the default not_run diagnosis (mirrors the settlement not_run default). */
function notRunDiagnosis(): EngineDiagnosisResult {
  return {
    status: 'not_run',
    authority: 'none',
    reportId: null,
    reportHash: null,
    target: { certificateId: null, certificateHash: null },
    summary: null,
    primaryCauses: [],
    blockingGaps: [],
    recommendedActions: [],
    error: null,
  };
}

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
 * skills/saga-discovery-worker/SKILL.md (now under
 * src/process-modules/modules/discovery/package/resources/skills/).
 * Listed here (not invented per call)
 * so the WorkIntent contract and the skill document one allowlist.
 */
const DISCOVERY_ALLOWED_TOOLS = [
  'task_get',
  'repository_checkout_list',
  'artifact_list',
  'note_list',
  'proposal_submit',
  'worker_done',
  // File tools for writing the mandatory discovery .md document.
  // The authority gateway only checks mcp__saga__* tools; these are listed
  // here for documentation and skill sync, not for gateway enforcement.
  'Write',
  'Read',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
];

/**
 * DiscoveryEdition run output (roadmap §5.3 partial-pipeline fields + outcome).
 * outcomeAuthority='worker_proposal' marks this as PROVISIONAL: D4 settlement
 * is what makes a discovery outcome authoritative.
 */
export interface DiscoveryRunOutcome {
  outcome: DiscoveryOutcome | 'discovery_not_implemented';
  outcomeAuthority:
    | 'worker_proposal'
    | 'normalized_worker_proposal'
    | 'discovery_settlement_policy'
    | 'none';
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
  /**
   * D3 shadow readiness advisor. Optional so D1/D2 engine tests that do not
   * exercise readiness stay green without wiring a fake; production
   * (composition-root) always supplies it. When absent, the engine records
   * readiness.status='not_run' and never spawns an advisor worker.
   */
  readinessService?: DiscoveryReadinessService;
  /**
   * D4 authoritative settlement service. Optional so D1/D2/D3 engine tests
   * that do not exercise settlement stay green without wiring a fake;
   * production (composition-root) always supplies it. When absent, the engine
   * records settlement.status='not_run' and leaves the provisional outcome as
   * the top-level outcome.
   */
  settlementService?: DiscoverySettlementService;
  /**
   * D5 advisory diagnosis service. Optional so D1-D4 engine tests that do not
   * exercise diagnosis stay green without wiring a fake; production
   * (composition-root) always supplies it. When absent (or when no authoritative
   * certificate was issued), the engine records diagnosis.status='not_run' and
   * NEVER mutates the top-level outcome/authority/scope/reason/finalStage set
   * by D4 (invariants I1/I5). Diagnosis runs only after settlement issued a
   * certificate authoritatively (topLevelAuthority='discovery_settlement_policy').
   */
  diagnosisService?: DiscoveryDiagnosisService;
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
      // Recovery check: before creating a NEW intent, check whether a CONCLUDED
      // discovery intent already exists for this episode with a submitted
      // Proposal. If so, reuse it — the recovery branch (preparation.state ===
      // 'done') will reuse the existing proposal, settlement, certificate, and
      // resume readiness/diagnosis. This prevents the duplicate-intent bug where
      // a restart after a clean discovery closure creates a fresh worker instead
      // of recovering the existing authoritative result.
      // Compatibility boundary: the concluded-intent recovery lookup was added
// after several external/fake runtime adapters already implemented the port.
// Production SQLite implements it; older adapters may omit it. Missing support
// means only that this optional recovery optimization is unavailable — normal
// open-intent creation remains valid and must not abort the entire process.
const concluded = typeof rt.readConcludedIntentWithProposal === 'function'
  ? rt.readConcludedIntentWithProposal(epicId, DISCOVERY_INTENT_KIND)
  : null;
      if (concluded) {
        intent = concluded;
        heartbeat('INTENT_REUSED_CONCLUDED', `id=${intent.id} (recovery: proposal already submitted)`);
      }
    }
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

    // 2b. Ensure the discovery workspace exists: copy static templates into
    // docs/discovery/tools/ and seed the epic-specific stage tracker +
    // proposal-call JSON with known IDs (epic_id/task_id/intent_id). Idempotent
    // (restart-safe): skips files that already exist. Regression-protected by
    // tests/saga3/d1-workspace-creation.test.mjs.
    //
    // ⚠️ DO NOT REMOVE THIS CALL. It was deleted once (commit 12952be, "engine
    // no longer touches the filesystem") and the deletion went uncaught because
    // no test covered workspace creation. The consequence surfaced 5 commits
    // later on epic 33: tools/ drifted out of sync, per-epic tracker had to be
    // created by hand, the diagnosis worker kept losing schema_version. See the
    // DO-NOT-DELETE block at the top of ensure-discovery-workspace.ts for the
    // full regression story. If you want to relocate the logic, MOVE it — keep
    // the test green.
    ensureDiscoveryWorkspace({
      workspaceRoot: workspace.workspaceRoot ?? '',
      epicId,
      projectId,
      taskId,
      intentId: intent.id,
    });

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
      // A restart may observe the product task already done while a previous
      // normalization control run was interrupted. Resume/reuse that ControlIntent
      // instead of permanently returning "done without proposal".
      let existingProposal = rt.readLatestProposal(intent.id);
      let recoveryCycles = 0;
      let recoveryError: string | null = null;
      if (!existingProposal || !validateDiscoveryProposal(existingProposal.payload).valid) {
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
          recoveryCycles += normalized.cycles;
          recoveryError = normalized.error;
          existingProposal = rt.readLatestProposal(intent.id);
        } else if (raw?.status === 'rejected_syntax') {
          recoveryError = 'worker response was not strict JSON after deterministic fence removal';
        } else if (raw && !existingProposal) {
          recoveryError = `raw submission ${raw.id} status='${raw.status}' produced no canonical proposal`;
        }
      }

      const valid = existingProposal !== null
        && validateDiscoveryProposal(existingProposal.payload).valid;
      if (intent.status === 'open') rt.setIntentStatus(intent.id, 'open', 'concluded');
      if (intent.status === 'executing') rt.setIntentStatus(intent.id, 'executing', 'concluded');
      if (intent.status === 'paused') rt.setIntentStatus(intent.id, 'paused', 'concluded');

      if (valid) {
        const provisional = provisionalOutcomeFromProposal(
          existingProposal!.payload as DiscoveryProposalPayload,
        );
        const authority = existingProposal!.provenance?.normalization_mode === 'lm_transformation'
          ? 'normalized_worker_proposal' as const
          : provisional.authority;
        const provisionalOutcome: DiscoveryRunOutcome = {
          outcome: provisional.outcome, outcomeAuthority: authority,
          proposalId: existingProposal!.id, proposalHash: existingProposal!.content_hash,
        };
        // D4: recovery reconstructs the durable D3 readiness shadow for the
        // exact Proposal target (ControlIntent -> latest assessment -> shadow),
        // instead of fabricating a not_run shadow. This prevents a restart from
        // replacing a previously-accepted (go) or failed readiness verdict with
        // a CLARIFY_READINESS_MISSING. If the ControlIntent is paused (advisor
        // interrupted), the existing D3 resume runs first via the readiness
        // service on the fresh-run path; on the recovery path we report the
        // durable paused state so settlement fail-closes to clarify.
        let recoverySettlement: EngineSettlementResult;
        let recoveryReadiness: ReadinessShadowResult;
        if (this.deps.settlementService) {
          // P0-3: if the readiness ControlIntent is resumable (open/executing/
          // paused) and has NO accepted assessment, RESUME the advisor through
          // the readiness service instead of immediately issuing
          // CLARIFY_READINESS_PAUSED. A temporary interruption must not become a
          // final business decision. An existing accepted assessment is never
          // re-run; a concluded/cancelled control without an assessment is a
          // durable failure (failed shadow).
          const control = rt.readReadinessControlForProposal(
            existingProposal!.id, existingProposal!.content_hash,
          );
          const assessment = control
            ? rt.readLatestReadinessAssessment(control.id)
            : null;
          const hasAccepted = assessment?.status === 'accepted_by_kernel';
          const resumable = !!control
            && !hasAccepted
            && (control.status === 'open' || control.status === 'executing' || control.status === 'paused')
            && !!this.deps.readinessService;
          if (resumable) {
            // Resume the D3 advisor lifecycle; it performs its own
            // restart/resume and returns the shadow.
            try {
              const assessed = await this.deps.readinessService!.assess({
                projectId, epicId,
                proposalId: existingProposal!.id,
                proposalContentHash: existingProposal!.content_hash,
                sourceIntentId: intent.id,
                objective: intent.objective,
                workspaceRoot: workspace.workspaceRoot,
                heartbeat,
              });
              recoveryCycles += assessed.cycles;
              recoveryReadiness = assessed.shadow;
            } catch (resumeErr) {
              const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
              heartbeat('READINESS_RECOVERY_FAILURE', msg);
              recoveryReadiness = {
                status: 'failed', authority: 'none',
                assessmentId: null, assessmentHash: null,
                overallReadiness: null, recommendedNextAction: null, error: msg,
              };
            }
          } else {
            // No resumable control: reconstruct the durable shadow from the
            // persisted assessment (accepted->completed, failed->failed, etc.).
            recoveryReadiness = this.reconstructReadinessShadow(
              rt, existingProposal!.id, existingProposal!.content_hash,
            );
          }
          try {
            recoverySettlement = await this.deps.settlementService.settle({
              projectId, epicId,
              proposalId: existingProposal!.id,
              proposalHash: existingProposal!.content_hash,
              readiness: recoveryReadiness,
            });
          } catch (settleErr) {
            const msg = settleErr instanceof Error ? settleErr.message : String(settleErr);
            recoverySettlement = {
              status: 'failed',
              settlementId: null, certificateId: null, certificateHash: null,
              policyVersion: null, policyHash: null,
              decision: null, reasonCodes: [], error: msg,
            };
          }
        } else {
          recoveryReadiness = {
            status: 'not_run', authority: 'none',
            assessmentId: null, assessmentHash: null,
            overallReadiness: null, recommendedNextAction: null, error: null,
          };
          recoverySettlement = {
            status: 'not_run',
            settlementId: null, certificateId: null, certificateHash: null,
            policyVersion: null, policyHash: null,
            decision: null, reasonCodes: [], error: null,
          };
        }
        // D5 recovery: mirror the fresh-run diagnosis hook. Diagnosis runs ONLY
        // when the recovery settlement issued a certificate authoritatively
        // (status='issued' + non-null certificate). When the recovery settlement
        // is not_run/failed, diagnosis stays not_run. Invariants I1/I5 hold:
        // the diagnosis is advisory and never mutates top-level fields.
        const recoveryDiagnosis = await this.runDiagnosis(
          projectId, epicId, recoverySettlement, workspace.workspaceRoot, heartbeat,
        );
        return this.runResult(projectId, epicId, 'completed', recoveryCycles, null,
          provisionalOutcome,
          persistence.episodes.currentStage(epicId) ?? 'discovery', true,
          recoveryReadiness, recoverySettlement, recoveryDiagnosis);
      }

      return this.runResult(projectId, epicId, 'failed', recoveryCycles,
        recoveryError ?? 'discovery task is done without a valid proposal',
        { outcome: 'failed', outcomeAuthority: 'none',
          proposalId: existingProposal?.id ?? null,
          proposalHash: existingProposal?.content_hash ?? null },
        persistence.episodes.currentStage(epicId) ?? 'discovery', false);
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

    // D3: shadow readiness advisor. Runs ONLY after a structurally valid
    // canonical Proposal exists. It is ADVISORY: it cannot change outcome,
    // outcomeAuthority, scopeCompleted, finalStage, or reason. If discovery
    // succeeded but the advisor fails, the provisional discovery result is
    // preserved unchanged and readiness.status reports the failure separately.
    // Missing/invalid Proposal → readiness stays not_run, no advisor worker.
    let readiness: ReadinessShadowResult;
    if (validProposal && proposal && this.deps.readinessService) {
      // P0-3: the entire readiness phase is ISOLATED from the product result.
      // ensureReadinessControl / prepareIntentForExecution / executor
      // construction run BEFORE the service's internal try — an exception
      // there must NOT propagate to the engine's outer catch and rewrite a
      // successful discovery as 'failed'. Capture it as a readiness failure.
      try {
        // Create filled readiness-call template so the advisor worker can
        // copy → fill remaining fields → verify → submit, instead of guessing
        // proposal_id/proposal_content_hash/control_intent_id from memory.
        this.ensureStageTemplate(workspace.workspaceRoot, epicId, 'readiness', {
          proposal_id: proposal.id,
          proposal_content_hash: proposal.content_hash,
        });
        const assessed = await this.deps.readinessService.assess({
          projectId,
          epicId,
          proposalId: proposal.id,
          proposalContentHash: proposal.content_hash,
          sourceIntentId: intent.id,
          objective: intent.objective,
          workspaceRoot: workspace.workspaceRoot,
          heartbeat,
        });
        cycles += assessed.cycles;
        readiness = assessed.shadow;
      } catch (readinessErr) {
        const msg = readinessErr instanceof Error ? readinessErr.message : String(readinessErr);
        heartbeat('READINESS_ISOLATED_FAILURE', msg);
        readiness = {
          status: 'failed', authority: 'none',
          assessmentId: null, assessmentHash: null,
          overallReadiness: null, recommendedNextAction: null, error: msg,
        };
      }
    } else {
      readiness = {
        status: 'not_run', authority: 'none',
        assessmentId: null, assessmentHash: null,
        overallReadiness: null, recommendedNextAction: null, error: null,
      };
    }

    // D4: authoritative settlement. Eligibility REQUIRES the product discovery
    // lifecycle to have completed CLEANLY: reason='completed', scopeCompleted,
    // terminal='clean', and a structurally valid canonical Proposal. A Proposal
    // submitted before timeout, blocked, stopped, or executor failure must NOT
    // become an authoritative success — the certificate cannot legalize an
    // incomplete lifecycle. When not eligible, settlement stays not_run and the
    // original failed/paused result is preserved unchanged.
    //
    // Unlike D3, D4 IS the authoritative boundary: a successful settlement makes
    // the outcome authoritative (outcomeAuthority='discovery_settlement_policy');
    // a settlement infrastructure failure means the run FAILED (reason='failed',
    // scopeCompleted=false) — Discovery Edition did NOT complete
    // authoritatively. Settlement runs even when readiness failed/paused; the
    // policy then fail-closes to clarify. The provisional outcome is always
    // preserved separately.
    const eligibleForSettlement =
      reason === 'completed'
      && scopeCompleted
      && terminal === 'clean'
      && validProposal;
    let settlement: EngineSettlementResult;
    if (eligibleForSettlement && proposal && this.deps.settlementService) {
      try {
        settlement = await this.deps.settlementService.settle({
          projectId,
          epicId,
          proposalId: proposal.id,
          proposalHash: proposal.content_hash,
          readiness,
        });
      } catch (settleErr) {
        const msg = settleErr instanceof Error ? settleErr.message : String(settleErr);
        heartbeat('SETTLEMENT_ISOLATED_FAILURE', msg);
        settlement = {
          status: 'failed',
          settlementId: null, certificateId: null, certificateHash: null,
          policyVersion: null, policyHash: null,
          decision: null, reasonCodes: [], error: msg,
        };
      }
    } else {
      settlement = {
        status: 'not_run',
        settlementId: null, certificateId: null, certificateHash: null,
        policyVersion: null, policyHash: null,
        decision: null, reasonCodes: [], error: null,
      };
    }

    // D5: advisory diagnosis. Eligibility (D5-TEST-MATRIX §12) REQUIRES the
    // settlement to have issued a certificate AUTHORITATIVELY: status='issued'
    // with non-null certificateId + certificateHash. This is exactly the
    // condition under which runResult sets topLevelAuthority=
    // 'discovery_settlement_policy'. When not eligible (settlement failed /
    // not_run, or no certificate), diagnosis stays not_run.
    //
    // CRITICAL invariants I1/I5: the diagnosis result is ADVISORY ONLY. It MUST
    // NOT change topLevelOutcome, topLevelAuthority, topLevelReason,
    // topLevelScope, topLevelLastError, or finalStage — those were set
    // authoritatively by the settlement block above and are projected by
    // runResult. A diagnosis failure (worker crash, invalid payload, persistence
    // error) leaves the D4 result COMPLETE and UNCHANGED; only the advisory
    // diagnosis section records the failure. There is NO `if (diagnosis...)`
    // branch that mutates top-level fields.
    const diagnosis = await this.runDiagnosis(
      projectId, epicId, settlement, workspace.workspaceRoot, heartbeat,
    );

    return this.runResult(projectId, epicId, reason, cycles, lastError, outcome, finalStage, scopeCompleted, readiness, settlement, diagnosis);
  }

  /**
   * D5 advisory diagnosis hook. Mirrors the D4 settlement eligibility + try/catch
   * isolation pattern. Returns an `EngineDiagnosisResult` that runResult surfaces
   * in the `diagnosis` section WITHOUT touching any top-level field (I1/I5).
   *
   * Eligibility (§12): settlement.status='issued' AND certificateId != null AND
   * certificateHash != null — i.e. settlement issued authoritatively. This is the
   * exact condition under which runResult sets topLevelAuthority=
   * 'discovery_settlement_policy'. When the diagnosis service is not wired
   * (D1-D4 engine tests) or no certificate was issued, returns notRunDiagnosis().
   *
   * On ANY throw from the service, returns status='failed' with the error — the
   * D4 result stays COMPLETE (I5). The service itself is defensive and returns
   * failed/failed-payload results rather than throwing, but the try/catch is
   * belt-and-braces (mirrors the settlement hook).
   */
  private async runDiagnosis(
    projectId: number,
    epicId: number,
    settlement: EngineSettlementResult,
    workspaceRoot: string,
    heartbeat: (event: string, message: string) => void,
  ): Promise<EngineDiagnosisResult> {
    const eligible =
      settlement.status === 'issued'
      && settlement.certificateId !== null
      && settlement.certificateHash !== null
      && !!this.deps.diagnosisService;
    if (!eligible || !this.deps.diagnosisService
        || settlement.certificateId === null
        || settlement.certificateHash === null) {
      return notRunDiagnosis();
    }
    try {
      // Create filled diagnosis-call template so the diagnosis worker can
      // copy → fill remaining fields → verify → submit. Pre-fills the target
      // tuple (certificate_id/hash/decision) that the model must echo exactly.
      this.ensureStageTemplate(workspaceRoot, epicId, 'diagnosis', {
        certificate_id: settlement.certificateId,
        certificate_hash: settlement.certificateHash,
      });
      const result = await this.deps.diagnosisService.diagnose({
        projectId,
        epicId,
        certificateId: settlement.certificateId,
        certificateHash: settlement.certificateHash,
        workspaceRoot,
        heartbeat,
      });
      return this.projectDiagnosisResult(result);
    } catch (diagErr) {
      const msg = diagErr instanceof Error ? diagErr.message : String(diagErr);
      heartbeat('DIAGNOSIS_ISOLATED_FAILURE', msg);
      return {
        status: 'failed',
        authority: 'none',
        reportId: null,
        reportHash: null,
        target: {
          certificateId: settlement.certificateId,
          certificateHash: settlement.certificateHash,
        },
        summary: null,
        primaryCauses: [],
        blockingGaps: [],
        recommendedActions: [],
        error: msg,
      };
    }
  }

  /**
   * Map the service's `DiscoveryDiagnosisResult` discriminated union into the
   * engine's `EngineDiagnosisResult`. The shapes are identical by construction;
   * this exists so the engine owns its result type (mirrors how
   * `EngineSettlementResult` relates to `DiscoverySettlementResult`). It never
   * mutates anything outside the advisory diagnosis section.
   */
  private projectDiagnosisResult(result: DiscoveryDiagnosisResult): EngineDiagnosisResult {
    return {
      status: result.status,
      authority: result.authority,
      reportId: result.reportId,
      reportHash: result.reportHash,
      target: {
        certificateId: result.target.certificateId,
        certificateHash: result.target.certificateHash,
      },
      summary: result.summary,
      primaryCauses: result.primaryCauses,
      blockingGaps: result.blockingGaps,
      recommendedActions: result.recommendedActions,
      error: result.error,
    };
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
    readiness: ReadinessShadowResult = {
      status: 'not_run', authority: 'none',
      assessmentId: null, assessmentHash: null,
      overallReadiness: null, recommendedNextAction: null, error: null,
    },
    settlement: EngineSettlementResult = {
      status: 'not_run',
      settlementId: null, certificateId: null, certificateHash: null,
      policyVersion: null, policyHash: null,
      decision: null, reasonCodes: [], error: null,
    },
    diagnosis: EngineDiagnosisResult = notRunDiagnosis(),
  ): OrchestrationRunResult {
    // The provisional outcome is what the worker produced (preserved
    // separately so settlement's authoritative override is visible but the
    // worker's recommendation is never lost).
    const provisional: ProvisionalOutcome = {
      outcome: outcome.outcome,
      authority: outcome.outcomeAuthority === 'discovery_settlement_policy'
        ? 'worker_proposal'
        : outcome.outcomeAuthority,
      proposalId: outcome.proposalId,
      proposalHash: outcome.proposalHash,
    };

    // When settlement issued a certificate, the top-level outcome becomes
    // AUTHORITATIVE: the policy's decision replaces the provisional outcome and
    // outcomeAuthority is the settlement policy. When settlement failed, the
    // run is failed (authoritative boundary) — outcome becomes 'failed',
    // outcomeAuthority 'none'. When settlement did not run, the provisional
    // outcome stays as the top-level outcome.
    let topLevelOutcome = outcome.outcome;
    let topLevelAuthority = outcome.outcomeAuthority;
    let topLevelReason = reason;
    let topLevelScope = scopeCompleted;
    // A failed settlement must surface its error in lastError — otherwise a run
    // could return reason='failed' with lastError=null (e.g. after a clean
    // discovery whose settlement then crashed), which hides the cause.
    let topLevelLastError = lastError;

    if (settlement.status === 'issued') {
      topLevelOutcome = settlement.decision ?? outcome.outcome;
      topLevelAuthority = 'discovery_settlement_policy';
      topLevelReason = 'completed';
      topLevelScope = true;
    } else if (settlement.status === 'failed') {
      topLevelOutcome = 'failed';
      topLevelAuthority = 'none';
      topLevelReason = 'failed';
      topLevelScope = false;
      topLevelLastError = settlement.error ?? 'settlement failed';
    }

    return {
      projectId,
      epicId,
      finalStage,
      endedAt: this.now().toISOString(),
      reason: topLevelReason,
      cycles,
      lastError: topLevelLastError,
      pipelineScope: 'discovery_only',
      scopeCompleted: topLevelScope,
      outcome: topLevelOutcome,
      outcomeAuthority: topLevelAuthority,
      proposalId: outcome.proposalId,
      proposalHash: outcome.proposalHash,
      provisional,
      readiness,
      settlement: {
        status: settlement.status,
        settlementId: settlement.settlementId,
        certificateId: settlement.certificateId,
        certificateHash: settlement.certificateHash,
        policyVersion: settlement.policyVersion,
        decision: settlement.decision,
        reasonCodes: settlement.reasonCodes,
        error: settlement.error,
      },
      diagnosis: {
        status: diagnosis.status,
        authority: diagnosis.authority,
        reportId: diagnosis.reportId,
        reportHash: diagnosis.reportHash,
        target: {
          certificateId: diagnosis.target.certificateId,
          certificateHash: diagnosis.target.certificateHash,
        },
        summary: diagnosis.summary,
        primaryCauses: diagnosis.primaryCauses,
        blockingGaps: diagnosis.blockingGaps,
        recommendedActions: diagnosis.recommendedActions,
        error: diagnosis.error,
      },
    };
  }

  /**
   * D4 recovery: reconstruct the durable D3 readiness shadow for an exact
   * immutable Proposal target, instead of fabricating a not_run shadow. This
   * mirrors the D3 `shadowFrom` projection (accepted→completed, rejected/
   * submitted→failed, no-assessment-with-control→failed, paused-control→paused,
   * no-control→not_run) so a restart after an accepted assessment preserves the
   * go/clarify/reject verdict rather than collapsing to CLARIFY_READINESS_MISSING.
   */
  private reconstructReadinessShadow(
    rt: Saga3DiscoveryRuntimePersistence,
    proposalId: number,
    proposalContentHash: string,
  ): ReadinessShadowResult {
    const control: ReadinessControlIntentRecord | null =
      rt.readReadinessControlForProposal(proposalId, proposalContentHash);
    if (!control) {
      // No readiness phase was ever initiated for this Proposal.
      return {
        status: 'not_run', authority: 'none',
        assessmentId: null, assessmentHash: null,
        overallReadiness: null, recommendedNextAction: null, error: null,
      };
    }
    const assessment: ReadinessAssessmentRecord | null =
      rt.readLatestReadinessAssessment(control.id);
    if (!assessment) {
      // Control exists but no assessment row. If paused, report paused; the
      // advisor ran but did not produce a durable verdict — fail closed.
      if (control.status === 'paused' || control.status === 'executing' || control.status === 'open') {
        return {
          status: 'paused', authority: 'none',
          assessmentId: null, assessmentHash: null,
          overallReadiness: null, recommendedNextAction: null,
          error: 'readiness phase was paused/interrupted before producing an accepted assessment',
        };
      }
      // concluded/cancelled with no assessment -> advisor finished without one.
      return {
        status: 'failed', authority: 'none',
        assessmentId: null, assessmentHash: null,
        overallReadiness: null, recommendedNextAction: null,
        error: 'advisor completed without submitting an accepted assessment',
      };
    }
    // Assessment exists — project by status (mirrors shadowFrom).
    if (assessment.status === 'accepted_by_kernel') {
      return {
        status: 'completed', authority: 'shadow_advisor',
        assessmentId: assessment.id, assessmentHash: assessment.content_hash,
        overallReadiness: assessment.overall_readiness,
        recommendedNextAction: assessment.recommended_next_action,
        error: null,
      };
    }
    if (assessment.status === 'rejected_by_kernel') {
      return {
        status: 'failed', authority: 'none',
        assessmentId: assessment.id, assessmentHash: assessment.content_hash,
        overallReadiness: null, recommendedNextAction: null,
        error: `assessment rejected: ${assessment.validation_errors.join('; ')}`,
      };
    }
    // submitted (not yet accepted/rejected by the kernel).
    return {
      status: 'failed', authority: 'none',
      assessmentId: assessment.id, assessmentHash: assessment.content_hash,
      overallReadiness: null, recommendedNextAction: null,
      error: 'advisor assessment was not accepted by the kernel',
    };
  }

  /**
   * Create a filled template for a stage (readiness/diagnosis) by copying the
   * static template from the discovery package resources directory and
   * substituting known IDs. The model reads this file, fills remaining FILL_
   * placeholders, verifies against the checklist, and submits. Idempotent:
   * skips if target exists.
   */
  private ensureStageTemplate(
    workspaceRoot: string | undefined,
    epicId: number,
    stage: 'readiness' | 'diagnosis',
    values: Record<string, unknown>,
  ): void {
    if (!workspaceRoot) return;
    // W13-A2: discovery templates moved from the legacy global root
    // (`tool-templates/discovery/`) into the discovery package resources dir.
    const tmplDir = path.join(
      workspaceRoot,
      'src',
      'process-modules',
      'modules',
      'discovery',
      'package',
      'resources',
    );
    const tmplFile = path.join(tmplDir, `${stage}-call-template.json`);
    if (!existsSync(tmplFile)) return; // templates not installed — skip gracefully

    // Per-epic workspace (see ensureDiscoveryWorkspace for rationale):
    // readiness-call/diagnosis-call live in docs/discovery/projects/<epicId>/
    // so one epic's call-JSON cannot be seen by another epic's worker.
    const epicDir = path.join(workspaceRoot, 'docs', 'discovery', 'projects', String(epicId));
    const destFile = path.join(epicDir, `${stage}-call-${epicId}.json`);
    if (existsSync(destFile)) return; // already created (restart-safe)

    try {
      mkdirSync(epicDir, { recursive: true });
      let content = readFileSync(tmplFile, 'utf8');
      // Substitute known values (proposal_id, certificate_id, etc.)
      for (const [key, val] of Object.entries(values)) {
        // Replace both quoted and unquoted FILL_ placeholders for this key's
        // context. The template uses FILL_ patterns like:
        //   "proposal_id": "FILL_INTEGER_FROM_TASK_GET..."
        // We replace the entire value with the real one.
        const regex = new RegExp(`"FILL_[^"]*${key.toUpperCase()}[^"]*"`, 'gi');
        content = content.replace(regex, JSON.stringify(val));
      }
      writeFileSync(destFile, content);
    } catch { /* best effort — model can still work without the template */ }
  }
}
