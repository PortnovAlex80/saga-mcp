/**
 * Saga 3 — Injected ports.
 *
 * Every external dependency is behind an interface. Production and test
 * adapters pass through the same proposal parser, policy authorization,
 * incident authority, evidence recorder, and effect state machine.
 *
 * No LM output may directly mutate authoritative state.
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  deadline(afterMs: number): Deadline;
}

export interface Deadline {
  readonly at: number;
  expired(atNow?: number): boolean;
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

export interface IdSource {
  next(prefix: string): string;
}

export interface RandomSource {
  pick<T>(items: readonly T[]): T;
  jitter(baseMs: number, factor: number): number;
  unit(): number;
}

// ---------------------------------------------------------------------------
// Model (LM) — proposes only, never writes Saga state
// ---------------------------------------------------------------------------

export interface ModelPort {
  propose(req: ModelRequest, deadline: Deadline): Promise<ModelResult>;
}

export interface ModelRequest {
  readonly role: string;
  readonly proposalKind: string;
  readonly generation: number;
  readonly inputFingerprint: string;
  readonly prompt: string;
}

export type ModelResult =
  | { readonly kind: 'proposal'; readonly proposal: { readonly proposalKind: string; readonly payload: unknown } }
  | { readonly kind: 'malformed'; readonly raw: string; readonly reason: string }
  | { readonly kind: 'refusal'; readonly message: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'provider_error'; readonly status?: number; readonly message: string };

// ---------------------------------------------------------------------------
// Oracle — external evidence
// ---------------------------------------------------------------------------

export interface OraclePort {
  observe(req: OracleRequest, deadline: Deadline): Promise<OracleResult>;
}

export interface OracleRequest {
  readonly oracleId: string;
  readonly oracleVersion: string;
  readonly generation: number;
  readonly command: string;
}

export interface OracleResult {
  readonly verdict: string;
  readonly rawDigest: string;
  readonly executed: boolean;
  readonly artifacts?: readonly string[];
}

// ---------------------------------------------------------------------------
// Effect — execute + observe authorized external effects
// ---------------------------------------------------------------------------

export interface EffectPort {
  execute(intent: EffectPortIntent, deadline: Deadline): Promise<EffectPortObservation>;
}

export interface EffectPortIntent {
  readonly effectKind: string;
  readonly targetIdentity: string;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly payloadDigest: string;
}

export interface EffectPortObservation {
  readonly outcome: 'succeeded' | 'failed' | 'ambiguous' | 'already_applied';
  readonly resultDigest: string;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Repository — observe source state
// ---------------------------------------------------------------------------

export interface RepositoryPort {
  observeHead(repo: string, branch: string): Promise<{ readonly head: string; readonly clean: boolean }>;
  sourceFingerprint(repo: string): Promise<{ readonly fingerprint: string; readonly head: string; readonly dirty: boolean }>;
}

// ---------------------------------------------------------------------------
// Process — start, observe, stop workers
// ---------------------------------------------------------------------------

export interface ProcessPort {
  start(spec: ProcessSpec, deadline: Deadline): Promise<ProcessHandle>;
  observe(handle: ProcessHandle): Promise<ProcessStatus>;
  stop(handle: ProcessHandle): Promise<void>;
}

export interface ProcessSpec {
  readonly repo: string;
  readonly role: string;
  readonly generation: number;
  readonly args: readonly string[];
}

export interface ProcessHandle {
  readonly id: string;
  readonly repo: string;
}

export type ProcessStatus =
  | { readonly state: 'running' }
  | { readonly state: 'exited'; readonly code: number }
  | { readonly state: 'lost' };

// ---------------------------------------------------------------------------
// Durable store
// ---------------------------------------------------------------------------

export interface DurableStore {
  transact<T>(fn: (tx: Tx) => T, opts?: { readonly fault?: string }): T;
}

export interface Tx {
  get<T>(sql: string, ...params: readonly unknown[]): T | undefined;
  all<T>(sql: string, ...params: readonly unknown[]): readonly T[];
  run(sql: string, ...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SchedulerPort {
  admit(req: SchedulerAdmitRequest): SchedulerAdmitDecision;
}

export interface SchedulerAdmitRequest {
  readonly workIntentId: string;
  readonly capacityPool: string;
  readonly conflictKeys: readonly string[];
}

export type SchedulerAdmitDecision =
  | { readonly admitted: true; readonly launchOrder: number }
  | { readonly admitted: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Fault injector (test only)
// ---------------------------------------------------------------------------

export interface FaultInjector {
  arm(point: string): void;
  shouldFail(point: string): boolean;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface Ports {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly random: RandomSource;
  readonly model: ModelPort;
  readonly oracle: OraclePort;
  readonly effects: EffectPort;
  readonly repository: RepositoryPort;
  readonly processes: ProcessPort;
  readonly store: DurableStore;
  readonly scheduler: SchedulerPort;
  readonly faults: FaultInjector;
}
