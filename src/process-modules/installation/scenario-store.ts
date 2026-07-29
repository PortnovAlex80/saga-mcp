/**
 * W7-A1 — Pure value types + PORT for a Lifecycle Scenario installation.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md`
 * (Lanes row W7-A1; §0.10.3 / §0.10.12). Plan: §4.2.2 (install and validate a
 * Lifecycle Scenario package), §4.3.3 (ScenarioInstallationRepository port),
 * §0.6.6-6.7 (scenario installation resolves module selectors to exact
 * InstalledProcessModule + writes scenario module lock; LifecycleRun pins
 * both at start). Task:
 * `docs/refactor-management/05-subagent-tasks/W07-a1.md`.
 *
 * This is the SINGLE SQL owner of the `saga3_scenario_installations` and
 * `saga3_scenario_module_locks` tables (plan §0.5.2, C083). The SQLite adapter
 * (`persistence/sqlite-scenario-installation-repository.ts`) implements the
 * port declared here; `db.ts` calls `ensureSaga3ScenarioInstallationSchema`
 * from the adapter (dual-placement, see that file).
 *
 * ## Boundary vs W7-A2
 *
 * W7-A1 OWNS the persistence surface (tables, rows, port, adapter) and the
 * pure record shapes. W7-A2 OWNS the module-lock RESOLUTION logic
 * (`application/scenario-module-lock.ts`): given a manifest's
 * `ModuleSelector[]` and a package registry, resolve each to an exact
 * `InstalledProcessModule` identity and call this port's `installScenario`
 * with the resulting `ScenarioModuleLockEntry[]`. The split keeps SQL in one
 * lane and resolution semantics in another (plan §0.10.3 vs §0.10.4).
 *
 * ## What the SQL enforces
 *
 * `saga3_scenario_installations` carries the frozen manifest snapshot + its
 * content-addressed digest; a partial UNIQUE index guarantees at most one
 * ACTIVE installation per scenario identity `(scenario_name, scenario_version)`.
 * `saga3_scenario_module_locks` is the per-stage exact-pin: one row per
 * `(scenario_installation_id, stage_id)` referencing the exact module
 * installation id + digest the lock was resolved against. A UNIQUE index on
 * that pair makes the lock a single, durable pin (plan §6.6-6.7). Both rows
 * are written atomically by `installScenario` in the adapter.
 *
 * Installations are deletion-restricted (mirrors plan §5.5.9): the port
 * exposes NO delete method — only `retire` (status `active` → `retired`),
 * which releases the unique-active slot but preserves the rows for replay
 * verification.
 *
 * This module is PURE DATA + an INTERFACE ONLY (plan §3.5). The only imports
 * are the Wave 1 SPI barrel (domain → domain, Rule 5 clean) for the manifest
 * snapshot type and the sibling `installation.ts` branded id. No `better-sqlite3`
 * import here (that lives in the adapter).
 */

// Wave 1 SPI barrel — pure manifest type the snapshot carries.
// Rule 5 clean: domain → domain (sibling subtree under domain/spi/).
import type { LifecycleScenarioManifest } from '../domain/spi/index.js';
// Sibling installation id (W2-A2) — referenced by the module-lock FK target.
import type { ModuleInstallationId } from './domain/installation.js';

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------

/**
 * Database-assigned primary key of a `saga3_scenario_installations` row.
 *
 * Branded so a bare `number` cannot be silently passed where a scenario
 * installation id is expected (mirrors `ModuleInstallationId` in W2-A2). The
 * brand is erased at the runtime boundary (SQLite returns a plain number);
 * the persistence adapter casts via {@link asScenarioInstallationId}.
 *
 * Branded number (not string) because the column is `INTEGER PRIMARY KEY`.
 */
export type ScenarioInstallationId = number & {
  readonly __brand: 'ScenarioInstallationId';
};

/** Brand a plain (SQLite-returned) number as a `ScenarioInstallationId`. */
export function asScenarioInstallationId(id: number): ScenarioInstallationId {
  return id as ScenarioInstallationId;
}

// ---------------------------------------------------------------------------
// Status.
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a scenario installation record.
 *
 * - `'staged'`     — row inserted; manifest stored; NOT yet activated.
 * - `'active'`     — the unique-active slot for
 *                    `(scenario_name, scenario_version)` is held. The partial
 *                    UNIQUE index `idx_saga3_scenario_installations_active`
 *                    enforces at most ONE row per identity carries this status
 *                    — scenario version immutability (mirrors W2-A2 §4).
 * - `'retired'`    — withdrawn from the active slot. Row preserved for replay
 *                    verification (deletion-restricted, plan §5.5.9).
 *
 * Scenario installations do NOT carry the `'validated'`/`'corrupt'` states
 * module installations do: the scenario compiler (W7-A3) validates the
 * manifest BEFORE calling `installScenario`, so a row only exists once the
 * manifest is already valid; replay verification re-hashes the stored
 * manifest and compares (handled by the installer, W7-A6, not a status
 * transition here).
 */
export type ScenarioInstallationStatus = 'staged' | 'active' | 'retired';

/** Frozen set of accepted statuses (mirrors the SQL CHECK intent). */
export const SCENARIO_INSTALLATION_STATUSES: readonly ScenarioInstallationStatus[] =
  Object.freeze(['staged', 'active', 'retired']);

// ---------------------------------------------------------------------------
// Module lock entry (one per scenario stage).
// ---------------------------------------------------------------------------

/**
 * One row of the scenario module lock: the exact installed module identity a
 * single scenario stage is pinned to. Resolved by W7-A2
 * (`application/scenario-module-lock.ts`) from the manifest's
 * `ScenarioStageBinding.moduleSelector` against the package registry and
 * passed into `installScenario`.
 *
 * Pure readonly data — round-trips byte-identically through canonical
 * re-serialization (the property the scenario content digest depends on).
 *
 * @property stageId              The stage id within the scenario manifest
 *                                (`ScenarioStageBinding.id`). Unique within a
 *                                scenario installation.
 * @property moduleInstallationId The exact `saga3_module_installations.id`
 *                                (W2-A2) this stage is pinned to.
 * @property moduleName           Module identity name (denormalized for
 *                                diagnostics + lookup without a JOIN).
 * @property moduleVersion        Module identity version (denormalized).
 * @property modulePackageDigest  The pinned module's `package_digest`
 *                                (W2-A2). This is what makes the pin EXACT:
 *                                the same `(name, version)` reinstalled with a
 *                                different digest is a different pin.
 * @property selectorVersionRange The semver RANGE the manifest's
 *                                `ModuleSelector.versionRange` declared, so a
 *                                reader can see what range was satisfied.
 */
export interface ScenarioModuleLockEntry {
  readonly stageId: string;
  readonly moduleInstallationId: ModuleInstallationId;
  readonly moduleName: string;
  readonly moduleVersion: string;
  readonly modulePackageDigest: string;
  readonly selectorVersionRange: string;
}

/**
 * Read-back shape of one persisted module-lock row. Adds the database-assigned
 * `id` and the owning `scenarioInstallationId` to the entry payload.
 */
export interface ScenarioModuleLockRecord extends ScenarioModuleLockEntry {
  readonly id: number;
  readonly scenarioInstallationId: ScenarioInstallationId;
}

// ---------------------------------------------------------------------------
// Installation record.
// ---------------------------------------------------------------------------

/**
 * The canonical, persisted description of an installed Lifecycle Scenario
 * package. Pure readonly data — the single source of truth for "which scenario
 * is installed" (plan §4.3.3).
 *
 * @property id                Database primary key (branded).
 * @property scenarioName      Scenario identity name
 *                            (`manifest.identity.name`). Stored denormalized for
 *                            the UNIQUE-active index.
 * @property scenarioVersion   Scenario identity version
 *                            (`manifest.identity.version`). Stored denormalized
 *                            for the UNIQUE-active index.
 * @property scenarioDigest    sha256Hex of the canonical
 *                            `{ manifest, moduleLock }` bundle (computed by the
 *                            installer). Identity of the stored bytes; replay
 *                            verification re-hashes and compares.
 * @property manifestSnapshot  Canonical JSON snapshot of the
 *                            {@link LifecycleScenarioManifest} at install time.
 *                            Frozen: the manifest the scenario was installed
 *                            under.
 * @property moduleLock        The complete per-stage exact pin
 *                            (`ScenarioModuleLockEntry[]`), one entry per stage
 *                            in `manifest.stageBindings`. Written atomically
 *                            with the installation row.
 * @property storeLocation     Content-addressed path returned by the scenario
 *                            package store (W7-A3 compiler / W7-A6 installer).
 * @property status            Lifecycle status
 *                            (see {@link ScenarioInstallationStatus}).
 * @property installedAt       ISO timestamp — row insert time.
 * @property activatedAt       ISO timestamp — first transition to `active`,
 *                            or `undefined` while staged.
 * @property retiredAt         ISO timestamp — transition to `retired`, or
 *                            `undefined` while not retired.
 */
export interface ScenarioInstallationRecord {
  readonly id: ScenarioInstallationId;
  readonly scenarioName: string;
  readonly scenarioVersion: string;
  readonly scenarioDigest: string;
  readonly manifestSnapshot: LifecycleScenarioManifest;
  readonly moduleLock: readonly ScenarioModuleLockEntry[];
  readonly storeLocation: string;
  readonly status: ScenarioInstallationStatus;
  readonly installedAt: string;
  readonly activatedAt?: string;
  readonly retiredAt?: string;
}

// ---------------------------------------------------------------------------
// Input shape for installScenario (Omit<record, DB-assigned fields>).
// ---------------------------------------------------------------------------

/**
 * Input to {@link ScenarioInstallationRepository.installScenario}. Carries the
 * identity, the frozen manifest snapshot, the resolved module lock (one entry
 * per stage, produced by W7-A2), the content digest, and the store location.
 *
 * `status` defaults to `'active'` in the adapter (the normal path: a scenario
 * is installed active once its manifest is validated by W7-A3 and its lock
 * resolved by W7-A2). A caller MAY pass `'staged'` to insert without claiming
 * the active slot (e.g. dry-run / pre-activation); `activate` then claims it.
 */
export interface InstallScenarioInput {
  readonly scenarioName: string;
  readonly scenarioVersion: string;
  readonly scenarioDigest: string;
  readonly manifestSnapshot: LifecycleScenarioManifest;
  readonly moduleLock: readonly ScenarioModuleLockEntry[];
  readonly storeLocation: string;
  readonly status?: ScenarioInstallationStatus;
}

// ---------------------------------------------------------------------------
// Error codes (mirrors W2-A2 §4, §5.5.7, §5.5.8).
// ---------------------------------------------------------------------------

/**
 * Attempt to install (or activate) a second `status='active'` scenario
 * installation for the same `(scenarioName, scenarioVersion)` with a DIFFERENT
 * `scenarioDigest`. Released scenario identity is immutable (mirrors plan
 * §5.5.8). Development MUST use a prerelease version. An identical digest is an
 * idempotent replay and returns the existing active row.
 */
export const SCENARIO_INSTALLATION_VERSION_COLLISION =
  'SCENARIO_INSTALLATION_VERSION_COLLISION';

/** No scenario installation row matched the supplied id / identity selector. */
export const SCENARIO_INSTALLATION_NOT_FOUND = 'SCENARIO_INSTALLATION_NOT_FOUND';

/**
 * The supplied module lock is structurally invalid for the manifest: e.g. a
 * stage id in the lock has no matching `ScenarioStageBinding` in the manifest
 * snapshot, or a stage binding has no lock entry. Raised by `installScenario`
 * BEFORE any write so a partial lock never reaches the tables.
 */
export const SCENARIO_MODULE_LOCK_INCOMPLETE = 'SCENARIO_MODULE_LOCK_INCOMPLETE';

// ---------------------------------------------------------------------------
// PORT (interface). Plan §4.3.3.
// ---------------------------------------------------------------------------

/**
 * Persistence port for `saga3_scenario_installations` +
 * `saga3_scenario_module_locks`. Implementations:
 * `SqliteScenarioInstallationRepository` (sibling `persistence/` file). Future
 * swaps (Wave 13) implement this interface without touching `domain/`.
 *
 * The port intentionally exposes NO delete method (deletion-restricted, plan
 * §5.5.9). Use `retire` to release the active slot.
 *
 * The four core methods named in the task brief:
 *   - {@link installScenario}            — write installation + module lock atomically.
 *   - {@link getScenarioInstallation}    — read by id (with lock rows attached).
 *   - {@link getModuleLock}              — read the lock rows for one installation.
 *   - {@link listActive}                 — all currently-active installations.
 * Plus the lifecycle helpers `activate` / `retire` and identity lookups
 * (`getActiveByNameVersion`, `getByDigest`) needed by the installer and replay
 * verification (W7-A6).
 */
export interface ScenarioInstallationRepository {
  /**
   * Persist a scenario installation + its complete module lock atomically.
   *
   * Writes one row into `saga3_scenario_installations` and one row per
   * `moduleLock` entry into `saga3_scenario_module_locks`, in a single
   * transaction. The lock is validated against the manifest snapshot FIRST
   * (every `manifestSnapshot.stageBindings[].id` has exactly one lock entry
   * and vice-versa); a mismatch throws `SCENARIO_MODULE_LOCK_INCOMPLETE`
   * before any write.
   *
   * Version immutability (mirrors W2-A2 §4): if `status='active'` (the
   * default) and an active installation already exists for the same
   * `(scenarioName, scenarioVersion)`:
   *   - with the SAME `scenarioDigest` → idempotent replay: return the
   *     existing active record (caller can detect via `result.id`).
   *   - with a DIFFERENT `scenarioDigest` → throw
   *     `SCENARIO_INSTALLATION_VERSION_COLLISION`.
   * For `status='staged'` there is no uniqueness conflict (the UNIQUE index
   * is partial on `status='active'`).
   *
   * Returns the inserted (or replayed) record with its module lock attached.
   */
  installScenario(input: InstallScenarioInput): ScenarioInstallationRecord;

  /**
   * Read a scenario installation by primary key, with its module lock rows
   * attached. Returns null if not found.
   */
  getScenarioInstallation(
    id: ScenarioInstallationId,
  ): ScenarioInstallationRecord | null;

  /**
   * Read the complete module lock for one scenario installation (one record
   * per stage). Returns an empty array if the installation exists but has no
   * lock rows (should not happen for rows written via `installScenario`).
   * Returns null if the installation id does not exist.
   */
  getModuleLock(
    scenarioInstallationId: ScenarioInstallationId,
  ): readonly ScenarioModuleLockRecord[] | null;

  /**
   * Read the active installation for `(scenarioName, scenarioVersion)`, or
   * null. The partial UNIQUE index guarantees at most one match.
   */
  getActiveByNameVersion(
    scenarioName: string,
    scenarioVersion: string,
  ): ScenarioInstallationRecord | null;

  /** Read by `scenario_digest` (replay verification, registry selection). */
  getByDigest(digest: string): ScenarioInstallationRecord | null;

  /**
   * Transition an installation to `status='active'`. Sets `activated_at` (first
   * activation only — `COALESCE` guard). Enforces version immutability: if
   * another active installation already holds `(scenarioName, scenarioVersion)`
   * with a DIFFERENT `scenarioDigest`, throws
   * `SCENARIO_INSTALLATION_VERSION_COLLISION`. Throws
   * `SCENARIO_INSTALLATION_NOT_FOUND` if `id` does not exist.
   */
  activate(id: ScenarioInstallationId): ScenarioInstallationRecord;

  /**
   * Transition an installation to `status='retired'`. Sets `retired_at`.
   * Releases the unique-active slot but PRESERVES the row (deletion-restricted,
   * plan §5.5.9) for replay verification. Throws
   * `SCENARIO_INSTALLATION_NOT_FOUND` if `id` does not exist.
   */
  retire(id: ScenarioInstallationId): ScenarioInstallationRecord;

  /**
   * All installations currently `status='active'`, ordered by
   * `(scenarioName, scenarioVersion)`. Each record carries its module lock.
   */
  listActive(): readonly ScenarioInstallationRecord[];
}
