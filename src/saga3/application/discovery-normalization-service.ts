import type { Saga2HostRuntime } from '../../application/ports/saga2-host-runtime.js';
import type { WorkerExecutorFactory } from '../../application/ports/worker-executor.js';
import type { SagaRuntimeConfig } from '../../runtime/saga-runtime-config.js';
import type { Saga3DiscoveryRuntimePersistence } from '../persistence/saga3-discovery-runtime-port.js';

export interface DiscoveryNormalizationRequest {
  projectId: number;
  epicId: number;
  sourceSubmissionId: number;
  objective: string;
  workspaceRoot: string;
  heartbeat: (event: string, message: string) => void;
}

export interface DiscoveryNormalizationResult {
  success: boolean;
  cycles: number;
  error: string | null;
}

export interface DiscoveryNormalizationService {
  normalize(request: DiscoveryNormalizationRequest): Promise<DiscoveryNormalizationResult>;
}

export interface Saga3DiscoveryNormalizationServiceDependencies {
  config: SagaRuntimeConfig;
  workerExecutorFactory: WorkerExecutorFactory;
  host: Saga2HostRuntime;
  runtimePersistence: Saga3DiscoveryRuntimePersistence;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxRunSeconds?: number;
  pollMs?: number;
}

/**
 * Bounded executor for the NormalizeDiscoveryProposal control intent.
 *
 * The service owns only orchestration. The worker proposes a transformation;
 * normalization_submit performs deterministic validation and acceptance.
 */
export class Saga3DiscoveryNormalizationService implements DiscoveryNormalizationService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRunMs: number;
  private readonly pollMs: number;

  constructor(private readonly deps: Saga3DiscoveryNormalizationServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maxRunMs = (deps.maxRunSeconds ?? 60 * 10) * 1000;
    this.pollMs = deps.pollMs ?? 3000;
  }

  async normalize(request: DiscoveryNormalizationRequest): Promise<DiscoveryNormalizationResult> {
    const rt = this.deps.runtimePersistence;
    const control = rt.ensureNormalizationControl({
      epicId: request.epicId,
      projectId: request.projectId,
      sourceSubmissionId: request.sourceSubmissionId,
      objective: request.objective,
    });
    const preparation = rt.prepareIntentForExecution(control.authorityIntentId, control.taskId);

    if (preparation.state === 'done') {
      if (control.authorityIntentStatus === 'executing') {
        rt.setIntentStatus(control.authorityIntentId, 'executing', 'concluded');
      } else if (control.authorityIntentStatus === 'paused') {
        rt.setIntentStatus(control.authorityIntentId, 'paused', 'concluded');
      }
      if (control.controlStatus === 'executing') {
        rt.setControlIntentStatus(control.controlIntentId, 'executing', 'concluded');
      } else if (control.controlStatus === 'paused') {
        rt.setControlIntentStatus(control.controlIntentId, 'paused', 'concluded');
      }
      return { success: true, cycles: 0, error: null };
    }
    if (preparation.state === 'blocked' || preparation.state === 'active') {
      return { success: false, cycles: 0, error: preparation.detail };
    }

    let controlStatus = control.controlStatus;
    if (controlStatus === 'executing') {
      rt.setControlIntentStatus(control.controlIntentId, 'executing', 'paused');
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
      executor.start({
        projectId: request.projectId,
        epicId: request.epicId,
        concurrency: 1,
        claimScope: { taskIds: [control.taskId] },
      });
      rt.setIntentStatus(control.authorityIntentId, preparation.intentStatus, 'executing');
      rt.setControlIntentStatus(control.controlIntentId, controlStatus, 'executing');
      request.heartbeat(
        'NORMALIZATION_STARTED',
        `control=${control.controlIntentId} source=${request.sourceSubmissionId} task=${control.taskId}`,
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
      if (terminal !== 'clean') {
        try { executor.stop(request.projectId); } catch { /* best effort */ }
      }
      try { executor.dispose(); } catch { /* best effort */ }
    }

    if (terminal === 'clean') {
      rt.setIntentStatus(control.authorityIntentId, 'executing', 'concluded');
      rt.setControlIntentStatus(control.controlIntentId, 'executing', 'concluded');
      request.heartbeat(
        'NORMALIZATION_COMPLETED',
        `control=${control.controlIntentId} source=${request.sourceSubmissionId}`,
      );
      return { success: true, cycles, error: null };
    }

    // CAS attempts are safe even when start failed before either intent entered
    // executing; open/paused remains resumable, executing is never stranded.
    rt.setIntentStatus(control.authorityIntentId, 'executing', 'paused');
    rt.setControlIntentStatus(control.controlIntentId, 'executing', 'paused');
    const error = caughtError ?? `normalization worker did not close cleanly (terminal=${terminal})`;
    request.heartbeat('NORMALIZATION_FAILED', error);
    return { success: false, cycles, error };
  }
}
