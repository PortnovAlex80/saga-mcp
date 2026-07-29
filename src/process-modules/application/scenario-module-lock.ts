/**
 * W7-A2 — ScenarioModuleLock: resolve a scenario's ModuleSelectors to exact
 * installed module identities at install time, and pin those identities on
 * StageRun + LifecycleRun.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md`
 *       §0 (key findings), §1 row W7-A2.
 * Plan: §6.6-6.7 (scenario installation resolves module selectors to exact
 *       InstalledProcessModule + writes scenario module lock; LifecycleRun pins
 *       both at start).
 * Task: `docs/refactor-management/05-subagent-tasks/W07-a2.md`.
 *
 * ## What this module owns
 *
 * A `LifecycleScenarioManifest` carries, per `ScenarioStageBinding`, a
 * `ModuleSelector { name; versionRange }` — a CONTRACT reference (name + semver
 * range), NOT a concrete installed package. This is deliberate (plan §6.3.2):
 * the manifest is stable across patch upgrades, and a single scenario may reuse
 * the same module package in two stages with different mappings.
 *
 * Resolution to an exact installed identity happens ONCE, at scenario INSTALL
 * time (Wave 7), against the Wave 2 `PackageRegistry`. The result is a
 * `ScenarioModuleLock`: an immutable, content-addressed document that pins every
 * stage of the scenario to a concrete `PinnedScenarioModule` (installation id +
 * exact version + package digest + manifest digest). The lock is what the
 * LifecycleRun reads at start (plan §6.7) so that every StageRun the run spawns
 * pins the SAME installed identity — there is no per-stage re-resolution and no
 * opportunity for the active installation to drift mid-run.
 *
 * ## Purity + dependency direction (Rule 5 / Rule 2)
 *
 * This file lives under `process-modules/application/`. The dependency-direction
 * ratchet (W0-A1) permits `application/` to import:
 *   - `domain/*` (pure types) — `domain/spi/` (scenario manifest, ModuleSelector),
 *     `domain/lifecycle.js` (StageBinding), `domain/process-module.js`.
 *   - `installation/domain/*` (pure ports + value types) — the `PackageRegistry`
 *     port and the `ModuleInstallationRecord` / `ModuleInstallationId` value
 *     types (Rule 5 keeps `domain/` pure; `installation/domain/` is itself pure
 *     and is the layer the ratchet classifies the same as `domain/` for the
 *     purpose of application imports).
 *   - `shared/canonical-json.js` — the frozen `canonicalJson` + `sha256Hex`
 *     primitives (node:crypto only).
 *
 * It does NOT import `persistence/` (no sqlite, no db.ts), `composition/`,
 * `modules/`, or `infrastructure/`. The `PackageRegistry` is injected (port ←
 * adapter), so the sqlite-backed `InstallationBasedPackageRegistry` never
 * appears in this file's import graph. This is what lets the file live under
 * `application/` without tripping Rule 2 or Rule 6 of the ratchet.
 *
 * ## Cross-lane isolation (INTEGRATION NOTE)
 *
 * `PackageRegistry`, `ModuleInstallationRecord`, `ModuleInstallationId`, and the
 * `ScenarioInstallationStore` port are owned by sibling lanes (W2-A5, W2-A2,
 * W7-A1). In this isolated W7-A2 worktree the owning files are present for the
 * installation layer (Wave 2 has landed) but W7-A1's scenario-installation store
 * has not. To keep this file type-checking in isolation, the
 * `ScenarioInstallationStore` write/read port is declared here as a minimal
 * structural surface that mirrors exactly what `writeScenarioModuleLock` reads
 * and writes. See the INTEGRATION NOTE on the port below: at cherry-pick time
 * the integrator replaces the local port declaration with a type-only import
 * from W7-A1's `installation/scenario-store.js` and deletes the local block.
 */

// Wave 1 pure-SPI barrel — `ScenarioStageBinding`, `ModuleSelector`, plus the
// re-exported `StageBinding` base type. Type-only imports: this module never
// constructs a manifest; it reads selectors off the stage bindings it is given.
import type {
  ScenarioStageBinding,
  ModuleSelector,
} from '../domain/spi/scenario-manifest.js';
import type { StageBinding } from '../domain/lifecycle.js';

// Wave 2 installation layer — the package registry port + the installation
// record value type + the branded id. These are pure: the registry is a port,
// the record is readonly data, the id is a branded number. The sqlite adapter
// that backs `InstallationBasedPackageRegistry` is injected at the composition
// root and never imported here (keeps Rule 2 clean).
import type { PackageRegistry } from '../installation/domain/package-registry.js';
import type {
  ModuleInstallationRecord,
  ModuleInstallationId,
} from '../installation/domain/installation.js';

// Frozen canonical primitives — `canonicalJson` (deterministic JSON) and
// `sha256Hex` (sha256 of a string). node:crypto only, no module state.
import { canonicalJson, sha256Hex } from '../shared/canonical-json.js';

// ---------------------------------------------------------------------------
// INTEGRATION NOTE (integrator, Wave 7 cherry-pick): ScenarioInstallationStore.
//
// The scenario-installation persistence port is OWNED by W7-A1
// (`installation/scenario-store.ts` + the SQL repository). In this isolated
// W7-A2 worktree W7-A1 has not landed, so the write/read surface
// `writeScenarioModuleLock` needs is re-declared here for type-safety and so
// the file compiles + tests run. At integration time the integrator deletes
// the `ScenarioInstallationStore` interface and the `ScenarioModuleLockRecord`
// type below (search for "W7-A1-OWNED") and imports them from
// `../installation/scenario-store.js`. The shapes are frozen by
// WAVE7-SCENARIO-SPEC §1 row W7-A1 (the `saga3_scenario_module_locks` table) —
// they MUST stay byte-compatible with W7-A1's.
// ---------------------------------------------------------------------------

/**
 * Stable identifier for a scenario installation row. Branded so a bare number
 * cannot be confused with a module installation id or a process run id.
 * Persisted as the `saga3_scenario_installations.id` (or
 * `saga3_scenario_module_locks.scenario_installation_id`) INTEGER PRIMARY KEY.
 */
export type ScenarioInstallationId = number & {
  readonly __brand: 'ScenarioInstallationId';
};

/**
 * Minimal write/read port over the `saga3_scenario_module_locks` table (W7-A1
 * owner). `writeScenarioModuleLock` resolves the lock document here, then hands
 * it to this port to persist; `readScenarioModuleLock` (the LifecycleRun start
 * path) reads it back. The concrete sqlite adapter is injected at the
 * composition root — this file depends only on the port (Rule 5 / Rule 2 clean).
 */
export interface ScenarioInstallationStore {
  /**
   * Persist the resolved module lock for `scenarioInstallationId`. Idempotent on
   * `(scenarioInstallationId, lockDigest)`: a second write with the same digest
   * returns the existing row (replay safety). A second write with a DIFFERENT
   * digest for the same scenario installation is rejected by the store (a
   * scenario installation's lock is immutable once written — plan §6.6).
   *
   * The store is responsible for canonical-JSON serialization of `lockDocument`
   * and for computing/verifying `lockDigest`. This file passes the already-hashed
   * document so the store can assert byte-equality without re-deriving the
   * resolution.
   */
  writeModuleLock(params: {
    scenarioInstallationId: ScenarioInstallationId;
    lockDocument: ScenarioModuleLock;
    lockDigest: string;
    pinnedAt: string;
  }): ScenarioModuleLockRecord;

  /**
   * Read the module lock pinned for `scenarioInstallationId`, or null if the
   * scenario was installed without a resolved lock (legacy / pre-Wave-7).
   * Returns the deserialized `lockDocument` plus the persisted `lockDigest` so
   * the caller can re-verify integrity.
   */
  readModuleLock(
    scenarioInstallationId: ScenarioInstallationId,
  ): ScenarioModuleLockRecord | null;
}

/**
 * Persisted row shape for a scenario module lock. Local isolation copy of the
 * W7-A1 row type — see INTEGRATION NOTE above. The fields mirror the
 * `saga3_scenario_module_locks` table columns W7-A1 creates.
 */
export interface ScenarioModuleLockRecord {
  readonly scenarioInstallationId: ScenarioInstallationId;
  readonly lockDocument: ScenarioModuleLock;
  readonly lockDigest: string;
  readonly pinnedAt: string;
}

// ---------------------------------------------------------------------------
// PinnedScenarioModule (the per-stage pin).
// ---------------------------------------------------------------------------

/**
 * The immutable pin binding one scenario stage to one concrete installed module
 * identity, resolved at scenario install time against the `PackageRegistry`.
 *
 * This is the scenario analogue of `PinnedInstallation` (W2-A4), lifted from a
 * single ProcessRun to a single stage of a scenario: every StageRun the
 * LifecycleRun spawns for `stageId` MUST pin exactly these fields, so the run
 * is reproducible even if the active installation for `selector` is later
 * upgraded or retired (plan §6.6-6.7, §4 identity rules).
 *
 * @property stageId          The `ScenarioStageBinding.id` this pin resolves.
 * @property selector         The original `ModuleSelector` (name + range) the
 *                            stage declared. Carried verbatim so the lock
 *                            documents WHAT was resolved, not just the answer.
 * @property installationId   The resolved `ModuleInstallationRecord.id`
 *                            (Wave 2). NOT NULL on a resolved lock.
 * @property moduleName       Denormalized `record.name` (== `selector.name` for
 *                            a valid resolution; carried for diagnostics without
 *                            a join).
 * @property resolvedVersion  The EXACT semver the registry selected. This may
 *                            differ from `selector.versionRange` (a range
 *                            resolves to one concrete version) — pinning the
 *                            exact version is the whole point of the lock.
 * @property packageDigest    Denormalized `record.packageDigest` — the sha256 of
 *                            the canonical manifest+resources. Replay
 *                            verification re-hashes stored bytes and compares.
 * @property manifestDigest   sha256 of the canonical `manifestSnapshot`. Lets the
 *                            lock detect manifest drift independently of the
 *                            package bytes (a re-pack under the same identity
 *                            would change the manifest digest even if the
 *                            resource digests were somehow held constant).
 */
export interface PinnedScenarioModule {
  readonly stageId: string;
  readonly selector: ModuleSelector;
  readonly installationId: ModuleInstallationId;
  readonly moduleName: string;
  readonly resolvedVersion: string;
  readonly packageDigest: string;
  readonly manifestDigest: string;
}

/**
 * The complete module lock for one scenario installation: every stage pinned to
 * its resolved installed identity, plus a content-addressed `lockDigest` over
 * the whole document.
 *
 * `lockDigest = sha256Hex(canonicalJson(pins))` where `pins` is the
 * deterministically-sorted pin list (see {@link writeScenarioModuleLock}). Any
 * drift in any pin — a different installation id, a different resolved version,
 * a different package or manifest digest — changes `lockDigest`, making
 * tampering or accidental drift detectable at LifecycleRun start (plan §6.7).
 *
 * The lock is the single artifact the LifecycleRun reads at start to pin every
 * StageRun; it is NOT re-resolved per stage.
 */
export interface ScenarioModuleLock {
  /** Per-stage pins, sorted deterministically by `stageId` (see below). */
  readonly pins: readonly PinnedScenarioModule[];
  /**
   * sha256Hex of canonicalJson(pins). Stable across runs and Node versions
   * because the pin list is sorted and each pin is canonically serializable.
   */
  readonly lockDigest: string;
}

// ---------------------------------------------------------------------------
// Error codes.
// ---------------------------------------------------------------------------

/**
 * A `ModuleSelector` on a scenario stage could not be resolved against the
 * package registry — no active installation matches `name` + `versionRange`.
 * Carries the `stageId` and the offending `selector` so the caller can build a
 * precise install-time diagnostic. Resolution failure is fatal at install time:
 * a scenario whose modules are not all installed MUST NOT be installed.
 */
export const SCENARIO_MODULE_NOT_INSTALLED = 'SCENARIO_MODULE_NOT_INSTALLED';

/**
 * The scenario has no stages (empty `stageBindings`). A scenario lock with zero
 * pins is meaningless and would produce a `lockDigest` over an empty list; we
 * reject it so the lock document is always non-trivial.
 */
export const SCENARIO_HAS_NO_STAGES = 'SCENARIO_HAS_NO_STAGES';

/**
 * Two stages declared the same `stageId`. Stage ids MUST be unique within a
 * scenario (the manifest validator enforces this for `StageBinding.id`, but the
 * lock resolver defends in depth — a duplicate would make the pin set
 * non-deterministic and break `lockDigest` stability).
 */
export const SCENARIO_DUPLICATE_STAGE_ID = 'SCENARIO_DUPLICATE_STAGE_ID';

/**
 * Thrown by {@link writeScenarioModuleLock} when a stage's selector cannot be
 * resolved. See {@link SCENARIO_MODULE_NOT_INSTALLED}.
 */
export class ScenarioModuleNotInstalledError extends Error {
  readonly code: typeof SCENARIO_MODULE_NOT_INSTALLED = SCENARIO_MODULE_NOT_INSTALLED;
  readonly stageId: string;
  readonly selector: ModuleSelector;
  constructor(stageId: string, selector: ModuleSelector, cause?: unknown) {
    super(
      `${SCENARIO_MODULE_NOT_INSTALLED}: stage "${stageId}" selects ` +
        `name=${JSON.stringify(selector.name)} ` +
        `versionRange=${JSON.stringify(selector.versionRange)}, but no active ` +
        `installation matches`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ScenarioModuleNotInstalledError';
    this.stageId = stageId;
    this.selector = selector;
    Object.setPrototypeOf(this, ScenarioModuleNotInstalledError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Deterministic pin ordering.
//
// `lockDigest` MUST be stable across runs. Two equal lock documents (same pins)
// MUST produce the same digest. We therefore sort the pin list by `stageId`
// before hashing. `stageId` uniqueness is enforced (see
// SCENARIO_DUPLICATE_STAGE_ID), so the sort is a total order.
// ---------------------------------------------------------------------------

function comparePinsByStageId(a: PinnedScenarioModule, b: PinnedScenarioModule): number {
  if (a.stageId < b.stageId) return -1;
  if (a.stageId > b.stageId) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// resolveScenarioModuleLock — the pure resolution core.
//
// This is the heart of W7-A2: given the scenario's stage bindings and a package
// registry, resolve every ModuleSelector to its exact installed identity and
// produce the immutable ScenarioModuleLock. Pure with respect to the lock
// document (no persistence); the only side effect is reads against the injected
// `PackageRegistry`, which is a port.
// ---------------------------------------------------------------------------

/**
 * Resolve every `ScenarioStageBinding.moduleSelector` against `packageRegistry`
 * and produce the immutable {@link ScenarioModuleLock}.
 *
 * This is the pure core of {@link writeScenarioModuleLock} (which adds the
 * persistence touch). Exposed separately so a caller that only needs the lock
 * document (e.g. the W7-A3 compiler validating that a scenario CAN be resolved,
 * or a test) does not need to inject a `ScenarioInstallationStore`.
 *
 * Determinism: the returned `pins` are sorted by `stageId`, so `lockDigest` is
 * stable across runs and across Node versions.
 *
 * @param stageBindings  The scenario's stage bindings (each carries a
 *                       `moduleSelector`).
 * @param packageRegistry The Wave 2 package registry (port). Resolves
 *                       `ModuleSelector` → `ModuleInstallationRecord`.
 * @returns the immutable lock document.
 * @throws {ScenarioModuleNotInstalledError} (code
 *         {@link SCENARIO_MODULE_NOT_INSTALLED}) if any selector cannot be
 *         resolved.
 * @throws {Error} (code {@link SCENARIO_HAS_NO_STAGES}) if `stageBindings` is
 *         empty.
 * @throws {Error} (code {@link SCENARIO_DUPLICATE_STAGE_ID}) if two stages
 *         share a `stageId`.
 */
export function resolveScenarioModuleLock(
  stageBindings: readonly ScenarioStageBinding[],
  packageRegistry: PackageRegistry,
): ScenarioModuleLock {
  if (stageBindings.length === 0) {
    throw new Error(
      `${SCENARIO_HAS_NO_STAGES}: cannot resolve a module lock for a scenario ` +
        `with zero stageBindings`,
    );
  }

  const pins: PinnedScenarioModule[] = [];
  const seenStageIds = new Set<string>();

  for (const binding of stageBindings) {
    // Defensive: the manifest validator already enforces unique non-empty
    // stage ids, but the lock resolver is the last gate before the lock is
    // hashed — a duplicate here would make the pin set non-deterministic.
    if (seenStageIds.has(binding.id)) {
      throw new Error(
        `${SCENARIO_DUPLICATE_STAGE_ID}: stageId "${binding.id}" appears more ` +
          `than once in stageBindings`,
      );
    }
    seenStageIds.add(binding.id);

    const selector = binding.moduleSelector;
    // PackageRegistry.select throws PackageNotInstalledError on no match; we
    // translate it to the scenario-scoped error so the diagnostic carries the
    // stageId. The registry's own error already names the selector.
    let record: ModuleInstallationRecord;
    try {
      record = packageRegistry.select(selector);
    } catch (err) {
      // Re-throw our own typed error; preserve the registry's message in the
      // cause chain for operators who want the underlying detail.
      throw new ScenarioModuleNotInstalledError(binding.id, selector, err);
    }

    pins.push(buildPin(binding.id, selector, record));
  }

  // Deterministic order so lockDigest is reproducible.
  pins.sort(comparePinsByStageId);

  const lockDigest = sha256Hex(canonicalJson(pins));
  return { pins, lockDigest };
}

/**
 * Build a single {@link PinnedScenarioModule} from a resolved record. Pure.
 *
 * `manifestDigest` is `sha256Hex(canonicalJson(record.manifestSnapshot))` —
 * computed here rather than stored on the record so the lock is self-contained
 * and does not depend on a Wave 2 field that may not exist.
 */
function buildPin(
  stageId: string,
  selector: ModuleSelector,
  record: ModuleInstallationRecord,
): PinnedScenarioModule {
  return {
    stageId,
    selector: { name: selector.name, versionRange: selector.versionRange },
    installationId: record.id,
    moduleName: record.name,
    resolvedVersion: record.version,
    packageDigest: record.packageDigest,
    manifestDigest: sha256Hex(canonicalJson(record.manifestSnapshot)),
  };
}

// ---------------------------------------------------------------------------
// writeScenarioModuleLock — the install-time entry point.
//
// Resolves the lock via {@link resolveScenarioModuleLock} and persists it through
// the injected {@link ScenarioInstallationStore}. This is the function the
// Wave 7 ScenarioInstaller (W7-A6) calls at install time, after the scenario
// manifest has been validated (W7-A3) and the scenario installation row has
// been inserted (W7-A1).
// ---------------------------------------------------------------------------

/**
 * Resolve the scenario's module selectors against `packageRegistry` and persist
 * the resulting lock via `store`.
 *
 * This is the single install-time entry point for scenario module-lock
 * resolution (plan §6.6). It is idempotent with respect to the lock document:
 * replaying the same `(scenarioInstallationId, stageBindings, packageRegistry)`
 * triple produces the same `lockDigest`, and the store treats a same-digest
 * write as a no-op replay.
 *
 * @param scenarioInstallationId The scenario installation row this lock pins
 *                               (W7-A1 `saga3_scenario_installations.id`).
 * @param stageBindings          The scenario's stage bindings.
 * @param packageRegistry        The Wave 2 package registry (port, injected).
 * @param store                  The scenario-installation store (port, injected).
 * @param nowIso                 Optional deterministic clock (tests). Defaults
 *                               to `new Date().toISOString()`.
 * @returns the persisted lock record.
 * @throws {ScenarioModuleNotInstalledError} if any selector cannot be resolved.
 * @throws {Error} on empty stages / duplicate stage ids (see
 *         {@link resolveScenarioModuleLock}).
 */
export function writeScenarioModuleLock(
  scenarioInstallationId: ScenarioInstallationId,
  stageBindings: readonly ScenarioStageBinding[],
  packageRegistry: PackageRegistry,
  store: ScenarioInstallationStore,
  nowIso: string = new Date().toISOString(),
): ScenarioModuleLockRecord {
  if (
    !Number.isInteger(scenarioInstallationId) ||
    scenarioInstallationId <= 0
  ) {
    throw new Error(
      `SCENARIO_MODULE_LOCK_INVALID_ID: scenarioInstallationId must be a ` +
        `positive integer, got ${scenarioInstallationId}`,
    );
  }

  const lock = resolveScenarioModuleLock(stageBindings, packageRegistry);

  return store.writeModuleLock({
    scenarioInstallationId,
    lockDocument: lock,
    lockDigest: lock.lockDigest,
    pinnedAt: nowIso,
  });
}

// ---------------------------------------------------------------------------
// readScenarioModuleLock — the LifecycleRun start path.
//
// The LifecycleRun (W7-A6 ScenarioRunner) reads the lock at start and pins
// every StageRun it spawns from it. Exposed here as a thin delegation to the
// store so the runner depends on this module (the lock's owner) rather than the
// store directly — keeping the lock API in one place.
// ---------------------------------------------------------------------------

/**
 * Read the module lock pinned for `scenarioInstallationId`, or null if the
 * scenario was installed without a resolved lock (legacy / pre-Wave-7).
 *
 * The returned record carries the persisted `lockDigest`; the caller (LifecycleRun
 * start) SHOULD re-derive `sha256Hex(canonicalJson(lockDocument.pins))` and
 * compare, refusing to start the run on mismatch (replay verification, plan
 * §6.7). That verification is the runner's responsibility, not this read's —
 * this function is a pure read.
 */
export function readScenarioModuleLock(
  scenarioInstallationId: ScenarioInstallationId,
  store: ScenarioInstallationStore,
): ScenarioModuleLockRecord | null {
  return store.readModuleLock(scenarioInstallationId);
}

// ---------------------------------------------------------------------------
// verifyScenarioModuleLock — replay verification.
//
// Re-derive the lock digest from a lock document and compare to the pinned
// digest. Used by the LifecycleRun start path (and by tests) to detect drift
// between the persisted lock and the pins it claims to hash. Pure.
// ---------------------------------------------------------------------------

/**
 * Re-derive `sha256Hex(canonicalJson(pins))` from `lock.pins` and compare to
 * `lock.lockDigest`. Returns true iff they match.
 *
 * Pure: no I/O. The LifecycleRun start path calls this on the lock read from the
 * store and refuses to start the run on a mismatch (the persisted lock document
 * has been tampered with or corrupted).
 *
 * Note: `resolveScenarioModuleLock` always produces a self-consistent lock, so
 * this function only ever returns false for a lock that was constructed by hand
 * or corrupted in storage — i.e. exactly the cases the runner must reject.
 */
export function verifyScenarioModuleLock(lock: ScenarioModuleLock): boolean {
  const pins = [...lock.pins].sort(comparePinsByStageId);
  const expected = sha256Hex(canonicalJson(pins));
  return expected === lock.lockDigest;
}

// ---------------------------------------------------------------------------
// StageRun / LifecycleRun pin projections.
//
// These pure helpers project a ScenarioModuleLock into the exact fields a
// StageRun / LifecycleRun must pin at start (plan §6.7). They exist so the pin
// shape is defined ONCE (here, in the lock's owner) rather than re-derived in
// every consumer. The runner reads the lock, then calls these to populate the
// StageRun/LifecycleRun pin columns.
// ---------------------------------------------------------------------------

/**
 * The fields a single StageRun must pin for `stageId`, projected from the lock.
 *
 * This is the scenario-stage analogue of `PinnedInstallation` (W2-A4): every
 * StageRun spawned by the LifecycleRun for `stageId` MUST carry exactly these
 * fields, so the run executes against the identical installed identity the
 * scenario was installed against — even if the active installation is later
 * upgraded or retired.
 */
export interface ScenarioStageRunPin {
  readonly stageId: string;
  readonly installationId: ModuleInstallationId;
  readonly resolvedVersion: string;
  readonly packageDigest: string;
}

/**
 * The fields a LifecycleRun must pin at start, projected from the lock: the
 * whole-lock `lockDigest` plus the per-stage pins. The LifecycleRun pins the
 * lockDigest ONCE (on its root row) and every StageRun it spawns reads its
 * per-stage pin from the lock — so the run is reproducible end-to-end (plan
 * §6.7).
 */
export interface ScenarioLifecycleRunPin {
  readonly lockDigest: string;
  readonly stagePins: readonly ScenarioStageRunPin[];
}

/**
 * Project the StageRun pin for `stageId` from the lock, or null if the lock has
 * no pin for that stage (the scenario was installed before the stage was added
 * — a version skew the runner must reject).
 *
 * Pure: a read off the lock document.
 */
export function projectStageRunPin(
  lock: ScenarioModuleLock,
  stageId: string,
): ScenarioStageRunPin | null {
  const pin = lock.pins.find((p) => p.stageId === stageId);
  if (!pin) return null;
  return {
    stageId: pin.stageId,
    installationId: pin.installationId,
    resolvedVersion: pin.resolvedVersion,
    packageDigest: pin.packageDigest,
  };
}

/**
 * Project the LifecycleRun pin (lockDigest + every stage pin) from the lock.
 * Pure. The LifecycleRun start path calls this once and writes the result onto
 * its root row + uses the stage pins to populate each StageRun it spawns.
 */
export function projectLifecycleRunPin(
  lock: ScenarioModuleLock,
): ScenarioLifecycleRunPin {
  return {
    lockDigest: lock.lockDigest,
    stagePins: lock.pins.map((p) => ({
      stageId: p.stageId,
      installationId: p.installationId,
      resolvedVersion: p.resolvedVersion,
      packageDigest: p.packageDigest,
    })),
  };
}

/**
 * Convenience: look up the {@link PinnedScenarioModule} for `stageId` in the
 * lock. Pure. Used by consumers that need the full pin (e.g. the `selector` the
 * stage declared, for diagnostics) rather than just the StageRun projection.
 */
export function getPinForStage(
  lock: ScenarioModuleLock,
  stageId: string,
): PinnedScenarioModule | undefined {
  return lock.pins.find((p) => p.stageId === stageId);
}

// ---------------------------------------------------------------------------
// Type re-exports for consumers.
//
// Consumers (the W7-A6 runner, the W7-A3 compiler, tests) import the lock types
// from this module — the lock's canonical owner. This keeps the lock API in one
// place even though the persistence row type is jointly owned with W7-A1.
// ---------------------------------------------------------------------------

export type { ScenarioStageBinding, ModuleSelector, StageBinding };
