import type { RateLimitTaskProjection } from './saga2-runtime-persistence.js';

export interface Saga2HostContext {
  projectId: number;
  epicId: number;
}

export interface Saga2WorkerRuntimePaths {
  sagaEntry: string;
  sagaSkillRoot: string;
  logRoot?: string;
  heartbeatLog?: string;
}

export type EngineLockAcquisition =
  | { status: 'acquired'; ownerPid: number }
  | { status: 'duplicate'; ownerPid: number | null }
  | { status: 'unavailable'; ownerPid: null; error: string };

/**
 * Host boundary for the stable Saga 2 pump.
 *
 * Filesystem layout, PID ownership, wall clock, sleeping, heartbeat output and
 * JSONL telemetry are infrastructure concerns. The orchestration engine only
 * consumes their outcomes and keeps stage/recovery/concurrency policy.
 */
export interface Saga2HostRuntime {
  readonly processId: number;
  readonly workerPaths: Saga2WorkerRuntimePaths;

  now(): number;
  sleep(ms: number): Promise<void>;
  heartbeat(context: Saga2HostContext, event: string, message: string): void;

  acquireEngineLock(context: Saga2HostContext): EngineLockAcquisition;
  releaseEngineLock(context: Saga2HostContext): void;

  scanRateLimitSignals(
    context: Saga2HostContext,
    tasks: readonly RateLimitTaskProjection[],
  ): number;
}
