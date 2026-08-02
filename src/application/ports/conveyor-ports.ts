/**
 * CONVEYOR-MENTAL-MODEL.md §"Required outbound ports" (lines 592–639) — formal
 * port surface for the conveyor architecture.
 *
 * The doc names 5 mandatory ports and 9 additional ports. This file declares
 * the interfaces that were MISSING (4 of the 5 mandatory + 5 of the 9
 * additional). `WorkAssignmentPort` is already declared in `./worker-executor.ts`
 * and is re-exported here as the canonical home reference.
 *
 * "Names may follow repository conventions, but responsibilities must remain
 * separate." — the doc explicitly allows naming variance. We declare interfaces
 * that mirror the EXACT responsibility of the existing concrete adapters so
 * they can `implements` without behavioral change. Async/`Promise` is the
 * doc's spelling; the concrete SQLite adapters are synchronous today (immediate
 * transactions) — they satisfy these interfaces structurally because a value
 * is assignable to `Promise<T>` at the type level when consumed via async/await
 * at the call site. Where a port method is purely a domain contract (no I/O
 * variance), we keep it sync to match the proven adapters.
 *
 * Additional ports (`ProcessRunRepository`, `NodeRunRepository`,
 * `RecoveryCaseRepository`, `InstallationRepository`) are ALREADY formalized
 * in their respective persistence files — this file only declares the ones
 * that had NO interface before.
 */

import type { AssignedWork } from './worker-executor.js';
// Wave 1 re-check 2026-08-02: the value objects below now carry branded
// CardId / ExecutionId / FenceToken where they refer to a card identity, a
// worker-attempt identity, or the fence capability. These brands are erased at
// runtime; they exist so a plain number/string cannot flow into a mutating
// boundary by accident. Construct via asCardId / asExecutionId / asFenceToken
// at the boundary (lifecycle/domain/ids.ts).
import type { CardId, ExecutionId, FenceToken } from '../../lifecycle/domain/ids.js';

// ===========================================================================
// Value objects — the "ubiquitous language" identity types (Wave 1 §706-720).
// Durable workplace identity, NOT transient execution identity.
// ===========================================================================

/** Durable reference to a workplace: (processRunId, moduleRef, nodeId). */
export interface WorkplaceRef {
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
}

/** Durable reference to a card (projected task). The card identity is a
 *  branded `CardId` so it cannot be confused with epicId / processRunId /
 *  repositoryId at any call site. */
export interface CardRef {
  readonly taskId: CardId;
}

/** Durable reference to a desk (node-scoped workspace directory). */
export interface DeskRef {
  readonly workspacePath: string;
  readonly nodeId: string;
}

/** Durable reference to a product (immutable: schema + ref + hash). */
export interface ProductRef {
  readonly schema: string;
  readonly artifactRef: string;
  readonly contentHash: string;
}

/** A product record as read from the production store. */
export interface Product {
  readonly reference: ProductRef;
  readonly processRunId: number;
  readonly nodeId: string;
  readonly payload: unknown;
  readonly bindings: Record<string, unknown>;
}

/** A fenced execution reference — identifies one live worker execution + fence.
 *  All three identities are branded so a stale or foreign value cannot be
 *  smuggled in as a plain string/number. */
export interface FencedExecutionRef {
  readonly executionId: ExecutionId;
  readonly taskId: CardId;
  readonly fenceToken: FenceToken;
}

/** A fenced progress observation — execution + observed activity timestamp. */
export interface FencedProgress extends FencedExecutionRef {
  readonly observedAt: string;
}

/** A fenced completion request — execution + verdict + result. */
export interface FencedCompletion extends FencedExecutionRef {
  readonly result: string;
  readonly verdict?: 'approved' | 'changes_requested';
}

/** A lease granted/renewed for an execution. */
export interface Lease {
  readonly executionId: ExecutionId;
  readonly leaseExpiresAt: string;
}

/** Result of completing work — what the assignment port returns on completion. */
export interface CompletionResult {
  readonly taskId: CardId;
  readonly finalStatus: string;
  readonly accepted: boolean;
}

/** Result of a release/reconcile — whether the card was returned to the queue. */
export interface ReleaseResult {
  readonly executionId: ExecutionId;
  readonly taskId: CardId;
  readonly action: 'released' | 'kept' | 'lost' | 'remote_unknown';
  readonly reason: string;
}

/** Observation of a process exit — what the close callback / reaper produces. */
export interface ProcessExitObservation {
  readonly executionId: ExecutionId;
  readonly taskId: CardId;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** A structured recovery issue (defect sheet) — verifier output. */
export interface RecoveryIssue {
  readonly nodeId: string;
  readonly findings: readonly string[];
  readonly subjectRefs: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

/** Per-execution reconcile result row. */
export interface ReconcileResult {
  readonly executionId: ExecutionId;
  readonly taskId: CardId;
  readonly action: string;
  readonly released: boolean;
  readonly reason: string;
}

// ===========================================================================
// 1. WorkerLauncherPort (mandatory, doc line 611)
// ===========================================================================

/** Context for launching a worker process (workspace, package, profile). */
export interface WorkerLaunchContext {
  readonly workspacePath: string;
  readonly packageDigest: string | null;
  readonly profile: string | null;
  readonly workerId: string;
}

/** Handle to a launched worker process — used to stop it later. */
export interface LaunchRef {
  readonly workerId: string;
  readonly pid: number;
}

/**
 * Launches and stops one worker process for one assigned card. The LM/Claude
 * runner implements this port only (adapter rule, doc line 644). The launcher
 * does NOT select cards — it receives an `AssignedWork` and materializes one
 * process for it.
 *
 * Concrete adapter: `ClaudeBoardRunner` (tracker-view/claude-runner.mjs) via
 * the `WorkerExecutor` surface — the runner's board-run model is the live
 * implementation; this port formalizes the per-work launch/stop contract the
 * doc requires. The existing `WorkerExecutor` interface (worker-executor.ts)
 * remains the broader run-lifecycle surface; this port is the narrowed
 * launch/stop responsibility.
 */
export interface WorkerLauncherPort {
  start(work: AssignedWork, context: WorkerLaunchContext): LaunchRef;
  stop(launch: LaunchRef): void;
}

// ===========================================================================
// 2. WorkerSupervisionPort (mandatory, doc line 616)
// ===========================================================================

/**
 * The watchman port: renews leases (liveness), records progress observations,
 * handles process-exit events, and periodically reconciles active executions.
 * The domain receives observations and never calls `process.kill` directly —
 * termination goes through `ProcessLivenessPort` (below).
 *
 * Concrete adapter surface: `startWorkerSupervision` service +
 * `SqliteExecutionRuntimeRepository` (renewLeases / reconcile) +
 * `reconcileWorkerExecutions` (stuck-policy + release).
 */
export interface WorkerSupervisionPort {
  renewLease(input: FencedExecutionRef): Lease;
  recordProgress(input: FencedProgress): void;
  observeProcessExit(input: ProcessExitObservation): ReleaseResult;
  reconcile(now: string): readonly ReconcileResult[];
}

// ===========================================================================
// 3. WorkspacePort (mandatory, doc line 623)
// ===========================================================================

/**
 * Materializes the desk (node-scoped workspace directory) for a workplace and
 * writes structured recovery feedback onto it. Filesystem code implements this
 * port only (adapter rule, doc line 645).
 *
 * Concrete adapter: `materializePinnedWorkspace` (pinned-workspace-materializer.ts).
 */
export interface WorkspacePort {
  materialize(workplace: WorkplaceRef): DeskRef;
  writeRecoveryFeedback(desk: DeskRef, issue: RecoveryIssue): void;
}

// ===========================================================================
// 4. ProductRepositoryPort (mandatory, doc line 628)
// ===========================================================================

/**
 * Reads and appends immutable products by exact reference or durable workplace
 * scope. Acceptance receipts and provenance live here. Consumers read by exact
 * ref/hash or durable node scope, never by "latest worker" heuristics.
 *
 * Concrete adapter: `SqliteProcessProductRepository` /
 * `SqliteProcessProductRepositoryV2`.
 */
export interface ProductRepositoryPort {
  getExact(ref: ProductRef): Product | null;
  listAcceptedByWorkplace(ref: WorkplaceRef): readonly Product[];
  append(product: Product): void;
}

// ===========================================================================
// 5. ModuleCatalogPort (additional, doc line 635)
// ===========================================================================

/** A selector identifying one module by name (+ optional version range). */
export interface ModuleSelector {
  readonly name: string;
  readonly versionRange?: string;
}

/** A resolved catalog entry — the installed module identity + manifest. */
export interface CatalogEntry {
  readonly name: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly installationId: number;
}

/**
 * Resolves module selectors to installed catalog entries. The lifecycle
 * composition references installed identities via this port, never concrete
 * module implementations (doc line 520).
 *
 * Concrete adapter: `InstallationBasedPackageRegistry` (package-registry.ts)
 * implementing `PackageRegistry`; this port narrows to the catalog-lookup
 * responsibility.
 */
export interface ModuleCatalogPort {
  select(selector: ModuleSelector): CatalogEntry | null;
  listSelectors(): readonly ModuleSelector[];
  has(selector: ModuleSelector): boolean;
}

// ===========================================================================
// 6. ExecutionJournalPort (additional, doc line 637)
// ===========================================================================

/** One immutable journal record — a command receipt / event / trace. */
export interface JournalRecord {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly recordedAt: string;
  readonly result: unknown;
}

/**
 * Append-only journal of events, traces, receipts and provenance. The journal
 * records `created`, `assigned`, `started`, `heartbeat`, `done`, `failed`,
 * `expired` and `superseded` transitions (doc line 334-335). Today this is the
 * `command_receipts` table accessed via raw SQL; this port formalizes it.
 *
 * Concrete adapter surface: `checkReceipt` / `storeReceipt`
 * (lifecycle/idempotency.ts) over the `command_receipts` table.
 */
export interface ExecutionJournalPort {
  record(input: { commandId: string; payloadHash: string; result: unknown }): void;
  read(commandId: string, payloadHash: string): JournalRecord | null;
}

// ===========================================================================
// 7. ProcessLivenessPort (additional, doc line 638)
// ===========================================================================

/**
 * Inspects local OS process identity. The domain receives observations and
 * NEVER calls `process.kill` itself (doc line 638-639) — termination authority
 * stays in infrastructure. This port may read PID + birth token.
 *
 * Concrete adapter: `REAL_PROCESS_PROBE` (worker-executions.ts:41) which wraps
 * `isProcessAlive`, `readProcessBirthToken`, `terminateVerifiedProcess`. The
 * existing `ProcessProbe` interface (worker-executions.ts:34) is the live
 * contract; this port is the doc-named alias.
 */
export interface ProcessLivenessPort {
  isAlive(pid: number): boolean;
  readBirthToken(pid: number): string | null;
}

// ===========================================================================
// 8. ClockPort (additional, doc line 638)
// ===========================================================================

/**
 * Time abstraction. Tests inject a fixed clock; production reads wall time.
 * Replaces inline `new Date()` / `Date.now()` / SQLite `datetime('now')` so
 * temporal logic is deterministic and injectable.
 */
export interface ClockPort {
  now(): Date;
  nowIso(): string;
  nowMs(): number;
}

// ===========================================================================
// 9. IdGeneratorPort (additional, doc line 639)
// ===========================================================================

/**
 * ID generation abstraction. Replaces inline `randomUUID()` /
 * `${prefix}:${Date.now()}` / DB autoincrement so identity creation is
 * injectable and deterministic under test.
 */
export interface IdGeneratorPort {
  /** Generate a fresh opaque unique id (UUID-shaped). */
  newId(): string;
  /** Generate a branded/prefixed id for a known kind. */
  newTypedId(prefix: string): string;
}

// ===========================================================================
// Canonical re-export — WorkAssignmentPort lives in worker-executor.ts (the
// proven seam); it is the 5th mandatory port. Re-exported here so consumers
// can import all 5 mandatory ports from one module if desired.
// ===========================================================================
export type { WorkAssignmentPort } from './worker-executor.js';
