export interface EngineStartCommand {
  epicId: number;
  concurrency?: number;
  /** JSON input consumed by the product Lifecycle execution plane. */
  lifecycleInputPath?: string;
  /** Stable key used to replay/resume the same durable LifecycleRun. */
  idempotencyKey?: string;
  /** Explicit controller authority to continue a durable human pause. */
  resumePaused?: boolean;
}

export interface EngineStateSnapshot {
  projectId: number;
  epicId: number;
  running: boolean;
  alive: boolean;
  pid: number | null;
  concurrency: number | null;
  startedAt: string | null;
}

export type EngineAdministrationErrorCode =
  | 'invalid_epic'
  | 'invalid_concurrency'
  | 'epic_not_found'
  | 'ambiguous_active_run'
  | 'active_run_mismatch'
  | 'spawn_failed';

export class EngineAdministrationError extends Error {
  constructor(
    readonly code: EngineAdministrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineAdministrationError';
  }
}

export interface EngineAdministration {
  start(command: EngineStartCommand): EngineStateSnapshot;
  stop(epicId: number): EngineStateSnapshot;
  restart(command: EngineStartCommand): EngineStateSnapshot;
  setConcurrency(epicId: number, concurrency: number): EngineStateSnapshot;
  status(epicId: number): EngineStateSnapshot;
  dispose(): void;
}
