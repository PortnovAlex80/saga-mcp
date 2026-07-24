/**
 * Bounded executor for the AssessDiscoveryReadiness control intent (roadmap D3).
 *
 * Mirrors the D2 normalization service lifecycle exactly: ensure control,
 * prepare for execution, restart-resume early-exits, single claim-scoped
 * worker, terminal-detection loop, CAS-conclude on clean / CAS-pause on
 * interruption. The service owns ONLY orchestration. The advisor proposes an
 * assessment; readiness_submit performs deterministic validation and
 * acceptance. The discovery outcome is never touched by this service.
 */
import type { Saga2HostRuntime } from '../../application/ports/saga2-host-runtime.js';
import type { WorkerExecutorFactory } from '../../application/ports/worker-executor.js';
import type { SagaRuntimeConfig } from '../../runtime/saga-runtime-config.js';
import type { Saga3DiscoveryRuntimePersistence } from '../persistence/saga3-discovery-runtime-port.js';
import type { ReadinessShadowResult } from '../domain/discovery-readiness-assessment.js';

export interface ReadinessAssessRequest {
  projectId: number;
  epicId: number;
  proposalId: number;
  proposalContentHash: string;
  sourceIntentId: number;
  objective: string;
  workspaceRoot: string;
  heartbeat: (event: string, message: string) => void;
}

export interface ReadinessAssessResult {
  success: boolean;
  cycles: number;
  error: string | null;
  /** Shadow verdict projected for OrchestrationRunResult. Never feeds back into the outcome. */
  shadow: ReadinessShadowResult;
}

export interface DiscoveryReadinessService {
  assess(request: ReadinessAssessRequest): Promise<ReadinessAssessResult>;
}

export interface Saga3DiscoveryReadinessServiceDependencies {
  config: SagaRuntimeConfig;
  workerExecutorFactory: WorkerExecutorFactory;
  host: Saga2HostRuntime;
  runtimePersistence: Saga3DiscoveryRuntimePersistence;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxRunSeconds?: number;
  pollMs?: number;
}

export class Saga3DiscoveryReadinessService implements DiscoveryReadinessService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRunMs: number;
  private readonly pollMs: number;

  constructor(private readonly deps: Saga3DiscoveryReadinessServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maxRunMs = (deps.maxRunSeconds ?? 60 * 10) * 1000;
    this.pollMs = deps.pollMs ?? 3000;
  }

  async assess(request: ReadinessAssessRequest): Promise<ReadinessAssessResult> {
    const rt = this.deps.runtimePersistence;
    const control = rt.ensureReadinessControl({
      epicId: request.epicId,
      projectId: request.projectId,
      proposalId: request.proposalId,
      proposalContentHash: request.proposalContentHash,
      sourceIntentId: request.sourceIntentId,
      objective: request.objective,
    });
    const preparation = rt.prepareIntentForExecution(control.authorityIntentId, control.taskId);

    // Restart-resume: if the advisor task is already done, NO new worker
    // spawns. But task=done does NOT imply success — the advisor may have
    // exited without a valid/accepted assessment (rejected, or never
    // submitted). Derive shadow FIRST, then align success/heartbeat to it so
    // the observability contract never claims COMPLETED while shadow is failed.
    if (preparation.state === 'done') {
      const shadow = this.shadowFrom(control.controlIntentId, 'restart');
      if (control.authorityIntentStatus === 'executing') {
        rt.setIntentStatus(control.authorityIntentId, 'executing', 'concluded');
      } else if (control.authorityIntentStatus === 'paused') {
        rt.setIntentStatus(control.authorityIntentId, 'paused', 'concluded');
      }
      if (control.controlStatus === 'executing') {
        rt.setReadinessControlStatus(control.controlIntentId, 'executing', 'concluded');
      } else if (control.controlStatus === 'paused') {
        rt.setReadinessControlStatus(control.controlIntentId, 'paused', 'concluded');
      }
      const success = shadow.status === 'completed';
      request.heartbeat(
        success ? 'READINESS_COMPLETED' : 'READINESS_FAILED',
        success
          ? `control=${control.controlIntentId} proposal=${request.proposalId}`
          : (shadow.error ?? 'readiness completed without an accepted assessment'),
      );
      return { success, cycles: 0, error: shadow.error, shadow };
    }
    if (preparation.state === 'blocked' || preparation.state === 'active') {
      return {
        success: false, cycles: 0, error: preparation.detail,
        shadow: this.shadowFrom(control.controlIntentId, 'failed', preparation.detail),
      };
    }

    let controlStatus = control.controlStatus;
    if (controlStatus === 'executing') {
      rt.setReadinessControlStatus(control.controlIntentId, 'executing', 'paused');
      controlStatus = 'paused';
    }

    const { workerExecutorFactory, host } = this.deps;
    const executor = workerExecutorFactory({
      projectId: request.projectId,
      epicId: request.epicId,
      workspaceRoot: request.workspaceRoot,
      dbPath: this.deps.config.dbPath,
      sagaEntry: host.workerPaths.sagaEntry,
      sagaSkillRoot: host.workerPaths.sagaSkillRoot,
      claudePath: this.deps.config.claudePath,
      logRoot: host.workerPaths.logRoot,
      heartbeatLog: host.workerPaths.heartbeatLog,
      lmStudioUrl: this.deps.config.lmStudioUrl,
    });

    const startedAt = this.now().getTime();
    let cycles = 0;
    let terminal: 'clean' | 'failed' | 'stopped' | 'timeout' | 'blocked' = 'timeout';
    let caughtError: string | null = null;

    try {
      // Exact claim scope: only this advisor task. Not an epic-wide executor.
      executor.start({
        projectId: request.projectId,
        epicId: request.epicId,
        concurrency: 1,
        claimScope: { taskIds: [control.taskId] },
      });
      rt.setIntentStatus(control.authorityIntentId, preparation.intentStatus, 'executing');
      rt.setReadinessControlStatus(control.controlIntentId, controlStatus, 'executing');
      request.heartbeat(
        'READINESS_STARTED',
        `control=${control.controlIntentId} proposal=${request.proposalId} task=${control.taskId}`,
      );

      while (true) {
        cycles += 1;
        const taskStatus = rt.readTaskState(control.taskId);
        const run = executor.status(request.projectId);
        const active = run?.active?.some(worker => worker.task_id === control.taskId) ?? false;
        if (run === null || run.status === 'failed') { terminal = 'failed'; break; }
        if (run.status === 'stopped') { terminal = 'stopped'; break; }
        if (taskStatus === 'done' && !active) { terminal = 'clean'; break; }
        if (taskStatus === 'blocked' && !active) { terminal = 'blocked'; break; }
        if (run.status === 'completed' && taskStatus !== 'done') { terminal = 'failed'; break; }
        if (this.now().getTime() - startedAt > this.maxRunMs) { terminal = 'timeout'; break; }
        await this.sleep(this.pollMs);
      }
    } catch (error) {
      terminal = 'failed';
      caughtError = error instanceof Error ? error.message : String(error);
    } finally {
      // Executor stopped only on hard exit; disposed always.
      if (terminal !== 'clean') {
        try { executor.stop(request.projectId); } catch { /* best effort */ }
      }
      try { executor.dispose(); } catch { /* best effort */ }
    }

    if (terminal === 'clean') {
      rt.setIntentStatus(control.authorityIntentId, 'executing', 'concluded');
      rt.setReadinessControlStatus(control.controlIntentId, 'executing', 'concluded');
      // P1: derive shadow FIRST, then align success + heartbeat to it. A clean
      // task closure with no accepted assessment is NOT a completion — the
      // heartbeat and service.success must reflect that honestly.
      const shadow = this.shadowFrom(control.controlIntentId, 'clean');
      const success = shadow.status === 'completed';
      request.heartbeat(
        success ? 'READINESS_COMPLETED' : 'READINESS_FAILED',
        success
          ? `control=${control.controlIntentId} proposal=${request.proposalId}`
          : (shadow.error ?? 'readiness completed without an accepted assessment'),
      );
      return { success, cycles, error: shadow.error, shadow };
    }

    // Interruption/timeout → paused. Restart reuses the same ControlIntent/task.
    rt.setIntentStatus(control.authorityIntentId, 'executing', 'paused');
    rt.setReadinessControlStatus(control.controlIntentId, 'executing', 'paused');
    const error = caughtError ?? `readiness worker did not close cleanly (terminal=${terminal})`;
    request.heartbeat('READINESS_FAILED', error);
    return {
      success: false, cycles, error,
      shadow: this.shadowFrom(control.controlIntentId, terminal === 'timeout' ? 'paused' : 'failed', error),
    };
  }

  /**
   * Project the latest assessment for a control intent into the shadow result.
   * Reads-only: never mutates outcome/authority/scope.
   *
   * P0-1 matrix:
   *   accepted_by_kernel assessment → completed / shadow_advisor + verdict
   *   rejected_by_kernel assessment → failed / none + rejection reasons
   *   assessment exists but not accepted/rejected (submitted) → failed
   *   NO assessment + advisor ran (clean/restart) → failed (exited without one)
   *   NO assessment + never invoked → not_run
   */
  private shadowFrom(
    controlIntentId: number,
    hint: 'clean' | 'restart' | 'completed' | 'failed' | 'paused',
    error: string | null = null,
  ): ReadinessShadowResult {
    const assessment = this.deps.runtimePersistence.readLatestReadinessAssessment(controlIntentId);
    if (assessment && assessment.status === 'accepted_by_kernel') {
      return {
        status: 'completed',
        authority: 'shadow_advisor',
        assessmentId: assessment.id,
        assessmentHash: assessment.content_hash,
        overallReadiness: assessment.overall_readiness,
        recommendedNextAction: assessment.recommended_next_action,
        error: null,
      };
    }
    if (assessment && assessment.status === 'rejected_by_kernel') {
      // P0-2: rejected assessments are durable and observable.
      const rejectionError = `assessment rejected: ${(assessment.validation_errors ?? []).join('; ')}`;
      return {
        status: 'failed',
        authority: 'none',
        assessmentId: assessment.id,
        assessmentHash: assessment.content_hash,
        overallReadiness: null,
        recommendedNextAction: null,
        error: rejectionError,
      };
    }
    if (assessment) {
      // submitted (no terminal verdict yet) — treat as failed; the advisor
      // proposed but the kernel did not reach a verdict.
      return {
        status: 'failed', authority: 'none',
        assessmentId: assessment.id, assessmentHash: assessment.content_hash,
        overallReadiness: null, recommendedNextAction: null,
        error: error ?? 'advisor assessment was not accepted by the kernel',
      };
    }
    // NO assessment row at all.
    if (hint === 'clean' || hint === 'restart') {
      // The advisor ran (task reached done) or restart observed a done task,
      // but no assessment was ever persisted/accepted → failed.
      return {
        status: 'failed', authority: 'none',
        assessmentId: null, assessmentHash: null,
        overallReadiness: null, recommendedNextAction: null,
        error: error ?? 'advisor completed without submitting an accepted assessment',
      };
    }
    if (hint === 'failed') {
      return {
        status: 'failed', authority: 'none',
        assessmentId: null, assessmentHash: null,
        overallReadiness: null, recommendedNextAction: null, error,
      };
    }
    if (hint === 'paused') {
      return {
        status: 'paused', authority: 'none',
        assessmentId: null, assessmentHash: null,
        overallReadiness: null, recommendedNextAction: null, error,
      };
    }
    // completed hint with no assessment is impossible in practice; default to not_run.
    return {
      status: 'not_run', authority: 'none',
      assessmentId: null, assessmentHash: null,
      overallReadiness: null, recommendedNextAction: null, error,
    };
  }
}
