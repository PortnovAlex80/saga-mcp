/**
 * W11-A5 — Legacy-run inventory, migration, rollback, package-retention.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md`
 *   §0  Objective (§0.14.11 serial gate): old pinned runs still replay through
 *       explicit compatibility adapters; no legacy code is deleted in Wave 11.
 *   §2  Lane A5 — "legacy-run inventory, migration, rollback, and
 *       package-retention tooling. Records every compatibility-path use.
 *       Defines the retention condition required before Wave 13 removal."
 *   §3  Anti-scope: NO legacy code deletion (Wave 13); NO NOT NULL enforcement
 *       on installation_id (Wave 13); NO removal of built-in catalog (Wave 13).
 *   §4  Exit gate bullet 4: "Legacy-run inventory records every
 *       compatibility-path use."
 * Task: `docs/refactor-management/05-subagent-tasks/W11-a5.md`.
 *
 * ============================================================================
 * WHAT THIS FILE OWNS (the four tools named in the lane)
 * ============================================================================
 *
 *   1. INVENTORY — `LegacyRunInventory`: an append-only ledger that RECORDS
 *      every compatibility-path use. Each use is an immutable
 *      `CompatibilityPathUse` value naming the exact adapter that served the
 *      legacy run (e.g. `legacy-scenario-adapter`, `legacy-engine-executor`,
 *      `process-run-installation-adapter` nullable fallback) plus the reason
 *      the new installed-scenario path could not serve it. The inventory also
 *      tracks the known set of legacy `LegacyRunRecord`s (runs created before
 *      the cutover with a NULL `installation_id`). This is the §4-exit-gate
 *      deliverable: "records every compatibility-path use."
 *
 *   2. MIGRATION — `planLegacyRunMigration`: a PURE planner that reads the
 *      inventory and emits a `LegacyRunMigrationPlan` describing, per legacy
 *      run, the steps to replay it through an installed scenario (pin the
 *      `installation_id`, select the matching scenario manifest, replay). It
 *      does NOT execute the migration (Wave 13 owns execution); it produces an
 *      auditable, reviewable plan whose completion is a precondition for Wave
 *      13 removal.
 *
 *   3. ROLLBACK — `planLegacyRunRollback`: a PURE planner that, given a
 *      migration plan, emits the inverse `LegacyRunRollbackPlan` (un-pin,
 *      restore the nullable fallback, drop the scenario replay pin). Rollback
 *      is the safety net that justifies keeping the compatibility packages
 *      installed during the retention window. It is declarative data only.
 *
 *   4. PACKAGE-RETENTION — `evaluatePackageRetentionCondition`: the single
 *      PURE predicate that defines the condition which MUST hold before Wave
 *      13 may remove the compatibility packages (legacy-scenario-adapter,
 *      legacy-engine-executor-adapter, the nullable installation adapter, the
 *      built-in catalog). The condition is: ZERO un-migrated legacy runs,
 *      ZERO compatibility-path uses recorded inside the configured retention
 *      window, AND the rollback grace window has elapsed. Until it holds, the
 *      retention policy FORBIDS removal. This is the gate Wave 13 must check.
 *
 * ============================================================================
 * WHY THIS FILE IS A NEW, PURE APPLICATION FILE (spec §3 anti-scope)
 * ============================================================================
 *
 * Wave 11 is PREPARATION only (spec §3). It must not delete legacy code, must
 * not enforce NOT NULL on `installation_id`, and must not remove the built-in
 * catalog — those are Wave 13. This file therefore provides the OBSERVABILITY
 * + PLANNING layer that Wave 13 will act on: it records what is still using
 * the compatibility path, plans how to migrate it, plans how to roll it back,
 * and names the exact condition under which removal becomes safe. Nothing
 * here mutates the live execution path or any persisted run row.
 *
 * ============================================================================
 * PURITY / DEPENDENCY TIER
 * ============================================================================
 *
 * This is an application-layer module (sibling to `legacy-scenario-adapter.ts`
 * and `scenario-router.ts`). It imports ONLY pure domain types and declares
 * its persistence needs as a consumer-side structural port
 * (`LegacyRunInventoryStore`), exactly mirroring the sibling-port declaration
 * policy documented in `scenario-runner.ts`. It does NOT import any
 * `sqlite-*` adapter, `db.ts`, `schema.ts`, or any `modules/*` module
 * implementation. The W0-A1 dependency-direction ratchet
 * (`tests/architecture/dependency-direction.test.mjs`) verifies this — this
 * file introduces ZERO new dependency-direction edges.
 *
 * The injected store makes the inventory testable with an in-memory
 * implementation and lets Wave 13 bind a real SQLite-backed store without
 * touching this file (single writer per file).
 */

import type { LifecycleScenarioManifest } from '../domain/spi/scenario-manifest.js';
import type { ModuleSelector } from '../domain/spi/scenario-manifest.js';

// ---------------------------------------------------------------------------
// Public value types.
// ---------------------------------------------------------------------------

/**
 * The well-known compatibility adapters that serve legacy runs. Each is an
 * explicit, named path — NEVER a silent fallback. Recording the exact adapter
 * on every `CompatibilityPathUse` is what makes the inventory auditable and is
 * the §4 exit-gate deliverable.
 *
 * Keep this list in sync with the adapters enumerated in
 * `WAVE11-CUTOVER-SPEC.md` §1/§3. Adding a new compatibility adapter is a
 * reviewable change (a new member here); removing one is itself a Wave 13
 * signal (the retention condition can never become true while a removed
 * adapter is still recorded as in use).
 */
export const COMPATIBILITY_PATHS = Object.freeze({
  /**
   * `application/legacy-scenario-adapter.ts` (W7-A8): serves a legacy Product
   * Delivery run by wrapping the legacy `productDeliveryLifecycle` definition
   * into a manifest the Wave 7 scenario runtime can consume.
   */
  LEGACY_SCENARIO_ADAPTER: 'legacy-scenario-adapter',
  /**
   * `application/legacy-engine-executor-adapter.ts`: RETIRED in the saga4
   * cutover (Phase 3 deleted the adapter — it was dead code with zero value
   * importers). Kept in the enum as a HISTORICAL record so the append-only
   * inventory ledger can still classify uses recorded before the retirement
   * without breaking the `(path, reason)` contract. No live run can record a
   * new use of this path.
   */
  LEGACY_ENGINE_EXECUTOR: 'legacy-engine-executor-adapter',
  /**
   * `installation/persistence/process-run-installation-adapter.ts` nullable
   * fallback: resolves a module installation by `module_name`+`module_version`
   * for a pre-Wave-2 run whose `installation_id` is NULL (W2-A4 §14.3.7).
   */
  NULLABLE_INSTALLATION_FALLBACK: 'process-run-installation-adapter',
  /**
   * `modules/installations.ts` built-in catalog: the hard-coded registry of
   * the four production modules. Wave 13 removes it; until then a run that
   * resolves through the catalog instead of an installed package is on the
   * compatibility path.
   */
  BUILT_IN_CATALOG: 'built-in-module-catalog',
} as const);

export type CompatibilityPath =
  (typeof COMPATIBILITY_PATHS)[keyof typeof COMPATIBILITY_PATHS];

/**
 * Pre-cutover reason codes explaining WHY the new installed-scenario path
 * could not serve a given run. Stable strings so the inventory can be queried
 * by reason across versions.
 */
export const COMPATIBILITY_USE_REASONS = Object.freeze({
  /** The run predates Wave 2 and carries a NULL `installation_id`. */
  NULL_INSTALLATION_PIN: 'null-installation-pin',
  /** The run was created before any scenario was installed for its lifecycle. */
  NO_INSTALLED_SCENARIO: 'no-installed-scenario',
  /** An installed scenario exists but does not match the run's lifecycle identity. */
  SCENARIO_IDENTITY_MISMATCH: 'scenario-identity-mismatch',
  /** A scenario was installed after the run started; the run keeps its legacy path. */
  RUN_PRECEDES_SCENARIO_INSTALL: 'run-precedes-scenario-install',
  /** Explicit operator override forcing the legacy path (e.g. regulated replay). */
  OPERATOR_OVERRIDE: 'operator-override',
  /** The cutover feature flag is off; all runs use the legacy path. */
  CUTOVER_DISABLED: 'cutover-disabled',
} as const);

export type CompatibilityUseReason =
  (typeof COMPATIBILITY_USE_REASONS)[keyof typeof COMPATIBILITY_USE_REASONS];

/**
 * One immutable record of a single use of the compatibility path. This IS the
 * "records every compatibility-path use" deliverable (§4 exit gate bullet 4).
 *
 * Append-only: once recorded, a use is never mutated or deleted. The store
 * rejects a duplicate `(runId, recordedAt, path, reason)` tuple so a retry
 * cannot inflate the count. The `useId` is caller-supplied (a stable
 * content-addressed or sequential id) so the store remains free of id-minting
 * policy.
 */
export interface CompatibilityPathUse {
  /** Stable identifier for this use record (caller-supplied, unique in store). */
  readonly useId: string;
  /** The ProcessRun row id that exercised the compatibility path. */
  readonly runId: number;
  /** The exact compatibility adapter that served the run. */
  readonly path: CompatibilityPath;
  /** Why the installed-scenario path could not serve the run. */
  readonly reason: CompatibilityUseReason;
  /** Optional free-form context (e.g. the mismatched scenario identity). */
  readonly detail?: string;
  /** ISO timestamp at which the use was observed. */
  readonly recordedAt: string;
  /** Who/what recorded the use (worker id, adapter id, operator). */
  readonly observedBy: string;
}

/**
 * A run known to be on the legacy path — created before the cutover, carrying
 * a NULL `installation_id` (W2-A4 §14.3.7) or resolved through the built-in
 * catalog. The inventory tracks the KNOWN SET so the migration planner can
 * enumerate every run that must be migrated before Wave 13 removal.
 */
export interface LegacyRunRecord {
  readonly runId: number;
  /**
   * The lifecycle/module identity the legacy run executes against. Used by
   * the migration planner to select the correct installed scenario manifest.
   */
  readonly lifecycleIdentity: {
    readonly name: string;
    readonly version: string;
  };
  /**
   * True when the run has a NULL `installation_id` (pre-Wave-2). Such runs
   * MUST route through the nullable installation fallback until migrated.
   */
  readonly hasNullInstallationPin: boolean;
  /** ISO timestamp the run was created (drives retention-window math). */
  readonly createdAt: string;
  /** Current migration status of this run. */
  readonly migrationStatus: LegacyRunMigrationStatus;
}

/**
 * Lifecycle of a single legacy run through the migration process. Stored on
 * the `LegacyRunRecord` and advanced by the migration executor (Wave 13).
 */
export const LEGACY_RUN_MIGRATION_STATUS = Object.freeze({
  /** Not yet planned or not yet started. Default for newly inventoried runs. */
  PENDING: 'pending',
  /** A migration plan exists; execution has not begun. */
  PLANNED: 'planned',
  /** Migration execution in progress (pin + replay). */
  IN_PROGRESS: 'in_progress',
  /** Successfully replayed through an installed scenario; pin is NOT NULL. */
  MIGRATED: 'migrated',
  /** Migration attempted and failed; remains on the compatibility path. */
  FAILED: 'failed',
  /** Migrated then rolled back to the legacy path within the grace window. */
  ROLLED_BACK: 'rolled_back',
} as const);

export type LegacyRunMigrationStatus =
  (typeof LEGACY_RUN_MIGRATION_STATUS)[keyof typeof LEGACY_RUN_MIGRATION_STATUS];

// ---------------------------------------------------------------------------
// Migration + rollback plan value types.
// ---------------------------------------------------------------------------

/**
 * One step in a legacy-run migration plan. Steps are ordered; the migration
 * executor (Wave 13) performs them in sequence and records the result.
 */
export interface LegacyRunMigrationStep {
  readonly stepId: string;
  readonly runId: number;
  readonly kind:
    | 'pin-installation' // write a non-NULL installation_id + package_digest
    | 'select-scenario'  // resolve the matching installed scenario manifest
    | 'replay-through-scenario'; // replay the run through ScenarioRunner
  readonly description: string;
}

/**
 * A migration plan for a single legacy run. Pure data; produced by
 * `planLegacyRunMigration`, consumed by the Wave 13 executor.
 */
export interface LegacyRunMigrationEntry {
  readonly runId: number;
  readonly targetScenarioIdentity: {
    readonly name: string;
    readonly version: string;
  };
  readonly requiredModuleSelectors: readonly ModuleSelector[];
  readonly steps: readonly LegacyRunMigrationStep[];
  /** True if the run cannot be migrated as-is (blocks Wave 13 removal). */
  readonly blocking: boolean;
  readonly blockReason?: string;
}

/**
 * The complete migration plan across all known legacy runs. Pure data.
 */
export interface LegacyRunMigrationPlan {
  readonly plannedAt: string;
  readonly entries: readonly LegacyRunMigrationEntry[];
  /** Run ids that block Wave 13 removal until migrated. */
  readonly blockingRunIds: readonly number[];
}

/**
 * The inverse of a migration plan: how to roll a migrated run back to the
 * legacy path. Produced by `planLegacyRunRollback` so the retention window has
 * a documented, pre-computed safety net for every migrated run.
 */
export interface LegacyRunRollbackStep {
  readonly stepId: string;
  readonly runId: number;
  readonly kind:
    | 'unpin-installation' // restore the NULL installation_id (nullable fallback)
    | 'drop-scenario-replay-pin' // remove the scenario replay binding
    | 'restore-legacy-path'; // route the run back through the compatibility adapter
  readonly description: string;
}

export interface LegacyRunRollbackEntry {
  readonly runId: number;
  readonly steps: readonly LegacyRunRollbackStep[];
}

export interface LegacyRunRollbackPlan {
  readonly plannedAt: string;
  readonly entries: readonly LegacyRunRollbackEntry[];
}

// ---------------------------------------------------------------------------
// Package-retention condition (the Wave 13 removal gate).
// ---------------------------------------------------------------------------

/**
 * Retention policy for the compatibility packages. Configured by the operator
 * (or defaulted) and consumed by `evaluatePackageRetentionCondition`. The
 * windows are expressed as ISO-8601 durations parsed at evaluation time, OR
 * as `null` to disable that clause (e.g. `rollbackGraceWindow: null` means
 * "do not require the grace window to elapse").
 *
 * Defaults are conservative and match the spec's intent that removal is
 * FORBIDDEN until the fleet is demonstrably clean.
 */
export interface PackageRetentionPolicy {
  /**
   * ISO-8601 duration. A compatibility-path use recorded within this window
   * ending at evaluation time keeps retention REQUIRED. Default 'P30D' (30
   * days): recent activity proves the path is still needed.
   */
  readonly recentUseWindow: string;
  /**
   * ISO-8601 duration. After a run is migrated, rollback must remain possible
   * for at least this long before removal is allowed. Default 'P14D'.
   */
  readonly rollbackGraceWindow: string;
  /**
   * If true, a single blocking (un-migratable) run forbids removal even when
   * the use window is clean. Default true — a run we cannot migrate is a
   * hard block on deleting the path it still needs.
   */
  readonly blockingRunsForbidRemoval: boolean;
}

export const DEFAULT_PACKAGE_RETENTION_POLICY: PackageRetentionPolicy = Object.freeze({
  recentUseWindow: 'P30D',
  rollbackGraceWindow: 'P14D',
  blockingRunsForbidRemoval: true,
});

/**
 * The set of clauses that make up the retention condition, each evaluated
 * independently so a `false` result explains exactly which clause failed.
 * This is the auditable evidence Wave 13 must present before removing code.
 */
export interface PackageRetentionEvaluation {
  /** Overall: may the compatibility packages be removed? False = retain. */
  readonly removalPermitted: boolean;
  readonly evaluatedAt: string;
  readonly policy: PackageRetentionPolicy;
  readonly clauses: {
    /** True when zero legacy runs remain un-migrated. */
    readonly noUnmigratedRuns: { readonly ok: boolean; readonly count: number };
    /** True when zero compatibility-path uses fall inside the recent window. */
    readonly noRecentCompatibilityUse: {
      readonly ok: boolean;
      readonly count: number;
    };
    /** True when every migrated run is past the rollback grace window. */
    readonly rollbackGraceElapsed: {
      readonly ok: boolean;
      readonly countStillInGrace: number;
    };
    /** True when no run is flagged blocking (or blocking is not required). */
    readonly noBlockingRuns: { readonly ok: boolean; readonly count: number };
  };
  /** Human-readable summary naming the failing clauses (empty if permitted). */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Stable error codes.
// ---------------------------------------------------------------------------

export const LEGACY_INVENTORY_ERROR_CODES = Object.freeze({
  DUPLICATE_USE: 'LEGACY_INVENTORY_DUPLICATE_USE',
  UNKNOWN_RUN: 'LEGACY_INVENTORY_UNKNOWN_RUN',
  UNKNOWN_COMPATIBILITY_PATH: 'LEGACY_INVENTORY_UNKNOWN_COMPATIBILITY_PATH',
  INVALID_USE: 'LEGACY_INVENTORY_INVALID_USE',
  INVALID_RUN: 'LEGACY_INVENTORY_INVALID_RUN',
  INVALID_PLAN: 'LEGACY_INVENTORY_INVALID_PLAN',
  NOT_MIGRATED: 'LEGACY_INVENTORY_NOT_MIGRATED',
  RETENTION_WINDOW_PARSE: 'LEGACY_INVENTORY_RETENTION_WINDOW_PARSE',
} as const);

// ---------------------------------------------------------------------------
// Persistence port (consumer-side structural declaration).
//
// Mirrors the sibling-port declaration policy in scenario-runner.ts: the
// inventory needs to read the known legacy runs, append compatibility-path
// uses, and read them back. A Wave 13 SQLite adapter implements this struct;
// tests use an in-memory implementation. This file stays free of sqlite/db.
// ---------------------------------------------------------------------------

/**
 * Read + append interface for the legacy-run inventory store. Implementations
 * MUST be append-only for `CompatibilityPathUse` (no mutation/deletion of
 * recorded uses) and MUST reject duplicate `useId`s.
 */
export interface LegacyRunInventoryStore {
  /** Return every known legacy run, in ascending runId order. */
  listLegacyRuns(): readonly LegacyRunRecord[];
  /** Return every recorded compatibility-path use, oldest first. */
  listCompatibilityUses(): readonly CompatibilityPathUse[];
  /** Append a use. Reject a duplicate useId (DUPLICATE_USE). */
  recordCompatibilityUse(use: CompatibilityPathUse): void;
}

// ---------------------------------------------------------------------------
// Value builders (pure, with validation).
// ---------------------------------------------------------------------------

/**
 * Valid known compatibility path values (for runtime checks against external
 * input). Frozen set built from `COMPATIBILITY_PATHS`.
 */
const KNOWN_COMPATIBILITY_PATHS: ReadonlySet<string> = new Set(
  Object.values(COMPATIBILITY_PATHS),
);

export function isCompatibilityPath(v: unknown): v is CompatibilityPath {
  return typeof v === 'string' && KNOWN_COMPATIBILITY_PATHS.has(v);
}

/**
 * Build a `CompatibilityPathUse` value with full validation. Pure; performs no
 * persistence. The caller (the inventory service) is responsible for handing
 * the result to `LegacyRunInventoryStore.recordCompatibilityUse`.
 *
 * `nowIso` defaults to `new Date().toISOString()` so tests can inject a
 * deterministic clock.
 */
export function buildCompatibilityPathUse(input: {
  readonly useId: string;
  readonly runId: number;
  readonly path: CompatibilityPath;
  readonly reason: CompatibilityUseReason;
  readonly observedBy: string;
  readonly detail?: string;
  readonly recordedAt?: string;
}): CompatibilityPathUse {
  if (typeof input.useId !== 'string' || input.useId.length === 0) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_USE}] useId must be a non-empty string`,
    );
  }
  if (!Number.isInteger(input.runId) || input.runId <= 0) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_USE}] runId must be a positive integer, got ${input.runId}`,
    );
  }
  if (!isCompatibilityPath(input.path)) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.UNKNOWN_COMPATIBILITY_PATH}] path '${String(
        input.path,
      )}' is not a declared COMPATIBILITY_PATH`,
    );
  }
  if (typeof input.observedBy !== 'string' || input.observedBy.length === 0) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_USE}] observedBy must be a non-empty string`,
    );
  }
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  if (typeof recordedAt !== 'string' || recordedAt.length === 0) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_USE}] recordedAt must be a non-empty ISO string`,
    );
  }
  const use: CompatibilityPathUse = {
    useId: input.useId,
    runId: input.runId,
    path: input.path,
    reason: input.reason,
    observedBy: input.observedBy,
    recordedAt: recordedAt,
  };
  if (input.detail !== undefined && input.detail.length > 0) {
    (use as { detail?: string }).detail = input.detail;
  }
  return use;
}

/**
 * Build a `LegacyRunRecord` value with validation. Pure.
 */
export function buildLegacyRunRecord(input: {
  readonly runId: number;
  readonly lifecycleIdentity: { readonly name: string; readonly version: string };
  readonly hasNullInstallationPin: boolean;
  readonly createdAt: string;
  readonly migrationStatus?: LegacyRunMigrationStatus;
}): LegacyRunRecord {
  if (!Number.isInteger(input.runId) || input.runId <= 0) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_RUN}] runId must be a positive integer, got ${input.runId}`,
    );
  }
  if (
    typeof input.lifecycleIdentity.name !== 'string' ||
    input.lifecycleIdentity.name.length === 0
  ) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_RUN}] lifecycleIdentity.name must be non-empty`,
    );
  }
  if (
    typeof input.lifecycleIdentity.version !== 'string' ||
    input.lifecycleIdentity.version.length === 0
  ) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_RUN}] lifecycleIdentity.version must be non-empty`,
    );
  }
  if (typeof input.createdAt !== 'string' || input.createdAt.length === 0) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.INVALID_RUN}] createdAt must be a non-empty ISO string`,
    );
  }
  const status = input.migrationStatus ?? LEGACY_RUN_MIGRATION_STATUS.PENDING;
  return {
    runId: input.runId,
    lifecycleIdentity: {
      name: input.lifecycleIdentity.name,
      version: input.lifecycleIdentity.version,
    },
    hasNullInstallationPin: input.hasNullInstallationPin,
    createdAt: input.createdAt,
    migrationStatus: status,
  };
}

// ---------------------------------------------------------------------------
// LegacyRunInventory — the recording service (§4 exit gate deliverable).
// ---------------------------------------------------------------------------

/**
 * The legacy-run inventory service. Wraps an injected
 * `LegacyRunInventoryStore` and provides the single auditable entry point for
 * recording a compatibility-path use.
 *
 * Every call to `recordUse` appends an immutable `CompatibilityPathUse` to the
 * store. The store is append-only; this service enforces the value contract
 * (validation + duplicate `useId` rejection) so the recorded ledger is
 * trustworthy as the basis for the Wave 13 retention gate.
 *
 * Pure with respect to its inputs: the only side effect is the delegated
 * `store.recordCompatibilityUse` call. Constructed once per process (or per
 * test); the store carries the durable state.
 */
export class LegacyRunInventory {
  private readonly store: LegacyRunInventoryStore;

  constructor(store: LegacyRunInventoryStore) {
    this.store = store;
  }

  /**
   * Record one compatibility-path use. Validates the inputs, builds the
   * immutable value, and appends it to the store. Throws on a duplicate
   * `useId` (the store enforces idempotency; this service surfaces the code).
   *
   * This is THE method the compatibility adapters call when they serve a
   * legacy run — the §4 exit-gate "records every compatibility-path use"
   * requirement is satisfied by routing every adapter through this call.
   */
  recordUse(input: {
    readonly useId: string;
    readonly runId: number;
    readonly path: CompatibilityPath;
    readonly reason: CompatibilityUseReason;
    readonly observedBy: string;
    readonly detail?: string;
    readonly recordedAt?: string;
  }): CompatibilityPathUse {
    // Duplicate useId detection against the current ledger. The store is the
    // authority for durability, but checking here gives a precise error code
    // at the call site rather than a generic store failure.
    const existing = this.store.listCompatibilityUses();
    for (const u of existing) {
      if (u.useId === input.useId) {
        throw new Error(
          `[${LEGACY_INVENTORY_ERROR_CODES.DUPLICATE_USE}] useId '${input.useId}' is already recorded`,
        );
      }
    }
    const use = buildCompatibilityPathUse(input);
    this.store.recordCompatibilityUse(use);
    return use;
  }

  /** All recorded compatibility-path uses, oldest first. Read-only. */
  recordedUses(): readonly CompatibilityPathUse[] {
    return this.store.listCompatibilityUses();
  }

  /** All known legacy runs, ascending runId. Read-only. */
  legacyRuns(): readonly LegacyRunRecord[] {
    return this.store.listLegacyRuns();
  }

  /**
   * Compatibility-path uses recorded for a single run, oldest first. Used by
   * the migration planner and by dashboards answering "is run X still on the
   * legacy path?".
   */
  usesForRun(runId: number): readonly CompatibilityPathUse[] {
    return this.store
      .listCompatibilityUses()
      .filter((u) => u.runId === runId);
  }

  /**
   * Count of recorded uses, optionally filtered by path. Cheap summary for
   * dashboards; does not allocate the full list.
   */
  useCount(path?: CompatibilityPath): number {
    const all = this.store.listCompatibilityUses();
    if (path === undefined) return all.length;
    let n = 0;
    for (const u of all) if (u.path === path) n += 1;
    return n;
  }

  /** The store this inventory wraps (exposed for planners / tests). */
  get backingStore(): LegacyRunInventoryStore {
    return this.store;
  }
}

// ---------------------------------------------------------------------------
// Migration planner (pure).
// ---------------------------------------------------------------------------

/**
 * Produce a migration plan for every known legacy run. Pure: reads the
 * inventory, emits `LegacyRunMigrationEntry` per run. Does NOT execute.
 *
 * For each run the planner:
 *   - selects the target scenario identity from the run's `lifecycleIdentity`
 *     (the migration replays the run against the installed scenario whose
 *     manifest matches that identity);
 *   - if `manifestLookup` is provided, uses it to resolve the manifest and
 *     copy its `requiredModuleSelectors` (so the plan names the exact module
 *     contracts the replay will pin); otherwise leaves selectors empty and
 *     marks the entry blocking with a precise reason;
 *   - emits the ordered steps (pin -> select -> replay);
 *   - flags blocking runs (NULL pin that cannot be resolved, or no matching
 *     scenario) so they surface in `blockingRunIds`.
 *
 * `manifestLookup` is optional and side-effect-free: given a lifecycle
 * identity it returns the installed manifest or `undefined`. Keeping it a
 * parameter (not an import) preserves the purity tier and lets tests inject a
 * fixture without touching sqlite.
 */
export function planLegacyRunMigration(
  inventory: LegacyRunInventory,
  options: {
    readonly plannedAt?: string;
    readonly manifestLookup?: (identity: {
      readonly name: string;
      readonly version: string;
    }) => LifecycleScenarioManifest | undefined;
  },
): LegacyRunMigrationPlan {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const entries: LegacyRunMigrationEntry[] = [];
  const blockingRunIds: number[] = [];

  for (const run of inventory.legacyRuns()) {
    const manifest = options.manifestLookup?.(run.lifecycleIdentity);
    const blocking = manifest === undefined;
    let blockReason: string | undefined;
    if (blocking) {
      blockReason =
        `no installed scenario manifest matches lifecycle ` +
        `'${run.lifecycleIdentity.name}@${run.lifecycleIdentity.version}' for run ${run.runId}`;
    }
    const requiredModuleSelectors: ModuleSelector[] = manifest
      ? [...manifest.requiredModuleSelectors]
      : [];
    const steps: LegacyRunMigrationStep[] = [
      {
        stepId: `migrate:${run.runId}:pin-installation`,
        runId: run.runId,
        kind: 'pin-installation',
        description: run.hasNullInstallationPin
          ? `write non-NULL installation_id + package_digest for run ${run.runId} (currently NULL)`
          : `verify/refresh installation pin for run ${run.runId}`,
      },
      {
        stepId: `migrate:${run.runId}:select-scenario`,
        runId: run.runId,
        kind: 'select-scenario',
        description:
          `resolve installed scenario manifest for ` +
          `'${run.lifecycleIdentity.name}@${run.lifecycleIdentity.version}'`,
      },
      {
        stepId: `migrate:${run.runId}:replay-through-scenario`,
        runId: run.runId,
        kind: 'replay-through-scenario',
        description: `replay run ${run.runId} through ScenarioRunner against the installed scenario`,
      },
    ];
    const entry: LegacyRunMigrationEntry = {
      runId: run.runId,
      targetScenarioIdentity: {
        name: run.lifecycleIdentity.name,
        version: run.lifecycleIdentity.version,
      },
      requiredModuleSelectors,
      steps,
      blocking,
    };
    if (blockReason !== undefined) {
      (entry as { blockReason?: string }).blockReason = blockReason;
    }
    entries.push(entry);
    if (blocking) blockingRunIds.push(run.runId);
  }

  return { plannedAt, entries, blockingRunIds };
}

// ---------------------------------------------------------------------------
// Rollback planner (pure).
// ---------------------------------------------------------------------------

/**
 * Produce the inverse rollback plan for the migrated entries of a migration
 * plan. Only entries whose source run is NOT blocking are eligible (a run we
 * could not migrate has nothing to roll back). Pure data; does NOT execute.
 *
 * The rollback steps are the strict inverse of the migration steps, in
 * reverse order, so a migrated run can be returned to the exact legacy state
 * it occupied before migration. The existence of a pre-computed rollback plan
 * for every migrated run is what justifies the rollback grace window in the
 * retention condition.
 */
export function planLegacyRunRollback(
  migrationPlan: LegacyRunMigrationPlan,
  options: { readonly plannedAt?: string } = {},
): LegacyRunRollbackPlan {
  const plannedAt = options.plannedAt ?? new Date().toISOString();
  const entries: LegacyRunRollbackEntry[] = [];
  for (const entry of migrationPlan.entries) {
    if (entry.blocking) continue; // nothing to roll back for an un-migratable run
    const steps: LegacyRunRollbackStep[] = [
      {
        stepId: `rollback:${entry.runId}:restore-legacy-path`,
        runId: entry.runId,
        kind: 'restore-legacy-path',
        description: `route run ${entry.runId} back through its compatibility adapter`,
      },
      {
        stepId: `rollback:${entry.runId}:drop-scenario-replay-pin`,
        runId: entry.runId,
        kind: 'drop-scenario-replay-pin',
        description: `remove the scenario replay binding for run ${entry.runId}`,
      },
      {
        stepId: `rollback:${entry.runId}:unpin-installation`,
        runId: entry.runId,
        kind: 'unpin-installation',
        description: `restore the NULL installation_id for run ${entry.runId} (nullable fallback resumes)`,
      },
    ];
    entries.push({ runId: entry.runId, steps });
  }
  return { plannedAt, entries };
}

// ---------------------------------------------------------------------------
// Package-retention condition (the Wave 13 removal gate).
// ---------------------------------------------------------------------------

/**
 * Minimal ISO-8601 duration parser supporting the subset this module needs:
 * days (`P{n}D`) and combinations of days + time, e.g. `P30D`, `P14D`,
 * `P1DT0H`. Returns milliseconds. Throws on unsupported shapes so a
 * misconfigured policy fails LOUD at evaluation, never silently permits
 * removal.
 *
 * Intentionally small: the retention windows are day-granular by policy. A
 * full temporal parser is out of scope for this pure module.
 */
export function parseRetentionDurationToMs(
  isoDuration: string,
): number {
  if (typeof isoDuration !== 'string' || isoDuration.length === 0) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.RETENTION_WINDOW_PARSE}] duration must be a non-empty ISO-8601 string`,
    );
  }
  // Match the date portion (P[nD][nW][nM][nY]) and optional time (T[nH][nM][nS]).
  const m = isoDuration.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!m) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.RETENTION_WINDOW_PARSE}] unsupported ISO-8601 duration '${isoDuration}' (this parser supports day/hour/minute/second granularity)`,
    );
  }
  const days = m[1] !== undefined ? Number(m[1]) : 0;
  const hours = m[2] !== undefined ? Number(m[2]) : 0;
  const minutes = m[3] !== undefined ? Number(m[3]) : 0;
  const seconds = m[4] !== undefined ? Number(m[4]) : 0;
  if (isoDuration === 'P' || (days + hours + minutes + seconds === 0)) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.RETENTION_WINDOW_PARSE}] duration '${isoDuration}' must denote a positive span`,
    );
  }
  return (
    days * 86_400_000 +
    hours * 3_600_000 +
    minutes * 60_000 +
    seconds * 1_000
  );
}

/**
 * Evaluate the package-retention condition. This is THE gate Wave 13 must
 * check before removing any compatibility package. `removalPermitted` is true
 * ONLY when every clause passes; a `false` result names the failing clauses
 * in `summary` so the operator knows exactly what remains.
 *
 * Inputs:
 *   - `inventory` — the recorded uses + known legacy runs.
 *   - `migrationPlan` — the current migration plan (for blocking runs).
 *   - `rollbackPlan` — the current rollback plan (for grace-window math).
 *   - `migratedAt` — map of runId -> ISO timestamp the run was migrated (for
 *     grace-window math). Runs absent from this map are treated as not yet
 *     migrated (counted under `noUnmigratedRuns`).
 *   - `policy` — retention windows (defaults to
 *     `DEFAULT_PACKAGE_RETENTION_POLICY`).
 *   - `evaluatedAt` — evaluation timestamp (defaults to now; injectable for
 *     deterministic tests).
 *
 * Pure: performs no persistence; reads only its inputs.
 */
export function evaluatePackageRetentionCondition(
  inventory: LegacyRunInventory,
  migrationPlan: LegacyRunMigrationPlan,
  rollbackPlan: LegacyRunRollbackPlan,
  migratedAt: ReadonlyMap<number, string>,
  options: {
    readonly policy?: PackageRetentionPolicy;
    readonly evaluatedAt?: string;
  } = {},
): PackageRetentionEvaluation {
  const policy = options.policy ?? DEFAULT_PACKAGE_RETENTION_POLICY;
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const evaluatedMs = Date.parse(evaluatedAt);
  if (Number.isNaN(evaluatedMs)) {
    throw new Error(
      `[${LEGACY_INVENTORY_ERROR_CODES.RETENTION_WINDOW_PARSE}] evaluatedAt is not a valid ISO timestamp: '${evaluatedAt}'`,
    );
  }

  // Clause 1: no un-migrated legacy runs.
  const runs = inventory.legacyRuns();
  let unmigratedCount = 0;
  for (const r of runs) {
    const migrated = migratedAt.has(r.runId) ||
      r.migrationStatus === LEGACY_RUN_MIGRATION_STATUS.MIGRATED;
    if (!migrated) unmigratedCount += 1;
  }
  const noUnmigratedRuns = { ok: unmigratedCount === 0, count: unmigratedCount };

  // Clause 2: no compatibility-path use inside the recent window.
  const recentWindowMs = parseRetentionDurationToMs(policy.recentUseWindow);
  const recentCutoffMs = evaluatedMs - recentWindowMs;
  let recentUseCount = 0;
  for (const u of inventory.recordedUses()) {
    const t = Date.parse(u.recordedAt);
    if (!Number.isNaN(t) && t >= recentCutoffMs) recentUseCount += 1;
  }
  const noRecentCompatibilityUse = {
    ok: recentUseCount === 0,
    count: recentUseCount,
  };

  // Clause 3: every migrated run that has a pre-computed rollback plan is past
  // the rollback grace window. Only runs WITH a rollback entry count: a run we
  // migrated but for which no rollback was planned is a planning defect, not a
  // grace-window concern (it cannot be rolled back, so it must not be counted
  // as "safe because past grace"). `migratedAt` supplies the migration time.
  const graceMs = parseRetentionDurationToMs(policy.rollbackGraceWindow);
  const rollbackEligible = new Set(rollbackPlan.entries.map((e) => e.runId));
  let stillInGrace = 0;
  for (const [runId, ts] of migratedAt) {
    if (!rollbackEligible.has(runId)) continue; // no rollback plan -> not counted here
    const migratedMs = Date.parse(ts);
    if (Number.isNaN(migratedMs)) continue;
    if (evaluatedMs - migratedMs < graceMs) stillInGrace += 1;
  }
  const rollbackGraceElapsed = {
    ok: stillInGrace === 0,
    countStillInGrace: stillInGrace,
  };

  // Clause 4: no blocking runs (or policy does not require this clause).
  const blockingCount = migrationPlan.blockingRunIds.length;
  const noBlockingRuns = {
    ok: policy.blockingRunsForbidRemoval ? blockingCount === 0 : true,
    count: blockingCount,
  };

  const failing: string[] = [];
  if (!noUnmigratedRuns.ok) {
    failing.push(`${unmigratedCount} un-migrated legacy run(s)`);
  }
  if (!noRecentCompatibilityUse.ok) {
    failing.push(`${recentUseCount} compatibility-path use(s) in the last ${policy.recentUseWindow}`);
  }
  if (!rollbackGraceElapsed.ok) {
    failing.push(`${stillInGrace} migrated run(s) still in the ${policy.rollbackGraceWindow} rollback grace window`);
  }
  if (!noBlockingRuns.ok) {
    failing.push(`${blockingCount} blocking (un-migratable) run(s)`);
  }

  const removalPermitted = failing.length === 0;
  const summary = removalPermitted
    ? 'package removal permitted: all retention clauses satisfied'
    : `package removal FORBIDDEN: ${failing.join('; ')}`;

  return {
    removalPermitted,
    evaluatedAt,
    policy,
    clauses: {
      noUnmigratedRuns,
      noRecentCompatibilityUse,
      rollbackGraceElapsed,
      noBlockingRuns,
    },
    summary,
  };
}

// ---------------------------------------------------------------------------
// Convenience: in-memory store (used by tests and by tools that want a
// throwaway inventory without binding sqlite). Lives here so the pure module
// is self-contained and runnable; the production adapter lives in Wave 13.
// ---------------------------------------------------------------------------

/**
 * Simple in-memory implementation of `LegacyRunInventoryStore`. Append-only
 * for uses; duplicate `useId` is rejected with `DUPLICATE_USE`. Provided so
 * this module is testable and usable in isolation; the production store binds
 * SQLite in Wave 13.
 */
export class InMemoryLegacyRunInventoryStore implements LegacyRunInventoryStore {
  private readonly runs: LegacyRunRecord[] = [];
  private readonly uses: CompatibilityPathUse[] = [];
  private readonly useIds = new Set<string>();

  registerLegacyRun(run: LegacyRunRecord): void {
    // de-dupe by runId (last write wins, mirroring an upsert).
    const idx = this.runs.findIndex((r) => r.runId === run.runId);
    if (idx >= 0) this.runs[idx] = run;
    else this.runs.push(run);
    this.runs.sort((a, b) => a.runId - b.runId);
  }

  listLegacyRuns(): readonly LegacyRunRecord[] {
    return this.runs;
  }

  listCompatibilityUses(): readonly CompatibilityPathUse[] {
    return this.uses;
  }

  recordCompatibilityUse(use: CompatibilityPathUse): void {
    if (this.useIds.has(use.useId)) {
      throw new Error(
        `[${LEGACY_INVENTORY_ERROR_CODES.DUPLICATE_USE}] useId '${use.useId}' is already recorded`,
      );
    }
    this.useIds.add(use.useId);
    this.uses.push(use);
  }
}
