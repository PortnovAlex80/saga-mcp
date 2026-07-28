/**
 * Wave 2 installation layer barrel (W2-A8, plan §0.5.12, §1 barrel row).
 *
 * Single import surface for the immutable-package + registry layer introduced
 * by Wave 2 (WAVE2-IMMUTABLE-INSTALLATION-SPEC.md §1, §2). Every Wave 2 lane
 * adds code under a sibling file in `installation/domain/`,
 * `installation/persistence/`, or `installation/adapters/`; this file
 * re-exports the public surface so downstream code (the composition root at
 * the Wave 2 checkpoint, the Wave 2 exit-gate conformance test, and later
 * waves) imports from a single path:
 *
 *   import {
 *     FilesystemModulePackageStore,
 *     SqliteModuleInstallationRepository,
 *     installPackage,
 *     computeDependencyLock,
 *     describeInstallation,
 *     ...
 *   } from '../installation/index.js';
 *
 * Ownership: W2-A8 OWNS this `index.ts` file exclusively. The sibling files
 * are owned by lanes A1..A7. If a sibling file's export name differs from the
 * spec, STOP and escalate (do NOT add a divergent alias here — the integrator
 * reconciles after cherry-picking all lanes).
 *
 * W1-A8 LESSON APPLIED: sibling lanes independently define type names that
 * would collide under a bare `export *` (TS2308 "Module has already exported
 * a member named 'X'"). The Wave 1 barrel hit this for `ValidationResult`/
 * `ValidationError`. For Wave 2 the analogous collision risk is on error
 * classes/codes and small shared value types (e.g. a `PackageStoreError` and
 * an installation error could both surface an `InstallationError` name; the
 * `PackageRegistry` and `ProcessRunInstallationAdapter` could both define
 * pinning helpers). To stay collision-free regardless of how siblings name
 * their internals, we use EXPLICIT NAMED RE-EXPORTS for every public symbol
 * rather than `export *` from sibling files. This makes the export surface a
 * single auditable list (the integrator verifies each symbol landed in the
 * cherry-pick order A2→A1→A3→A5→A6→A4→A7→A8).
 *
 * Dependency-direction ratchet (W0-A1): this barrel is at
 * `installation/index.ts` — it is NOT under `domain/`, `modules/`,
 * `application/`, `persistence/`, or `composition/`. It is a pure aggregation
 * of sibling `installation/*` files, all of which live under
 * `src/process-modules/installation/`. It imports NO `modules/*`, NO
 * `composition/*`, NO Runtime-core `domain/*` or `application/*`, NO
 * `db.ts`/`schema.ts`. Rule 5 (domain purity) does not apply (this is not
 * `domain/`); Rule 2 (modules) does not apply (this is not `modules/`); Rule 6
 * (composition root) does not apply (this is not `composition/`). The barrel
 * therefore adds zero new edges to the ratchet.
 */

// ---------------------------------------------------------------------------
// W2-A1 — ModulePackageStore PORT + pure value types + FilesystemModulePackageStore adapter
// (installation/domain/package-store.ts + installation/adapters/filesystem-package-store.ts)
// ---------------------------------------------------------------------------
export {
  // Port
  type ModulePackageStore,
  // Pure value types
  type StoredModulePackage,
  type ResourceBlob,
  type PackageStoreError,
  // Error code constants
  PACKAGE_STORE_PATH_TRAVERSAL,
  PACKAGE_STORE_DIGEST_MISMATCH,
  PACKAGE_STORE_NOT_FOUND,
  PACKAGE_STORE_CORRUPT,
} from './domain/package-store.js';

export {
  // Concrete content-addressed filesystem adapter (lives in adapters/, may use node:fs)
  FilesystemModulePackageStore,
} from './adapters/filesystem-package-store.js';

// ---------------------------------------------------------------------------
// W2-A2 — ModuleInstallationRecord pure value types + ModuleInstallationRepository
// PORT + SqliteModuleInstallationRepository adapter + schema bootstrap.
// (installation/domain/installation.ts + installation/persistence/installation-repository.ts)
// ---------------------------------------------------------------------------
export {
  // Branded id + status union
  type ModuleInstallationId,
  type ModuleInstallationStatus,
  // The persisted aggregate — single source of truth for "what is installed"
  type ModuleInstallationRecord,
  // Error code constants
  MODULE_INSTALLATION_VERSION_COLLISION,
  MODULE_INSTALLATION_NOT_FOUND,
  MODULE_INSTALLATION_CORRUPT,
} from './domain/installation.js';

export {
  // Port
  type ModuleInstallationRepository,
  // Concrete sqlite adapter (single SQL writer owns ensureSaga3ModuleInstallationSchema)
  SqliteModuleInstallationRepository,
  // Schema bootstrap (idempotent — creates saga3_module_installations; called by db.ts)
  ensureSaga3ModuleInstallationSchema,
} from './persistence/installation-repository.js';

// ---------------------------------------------------------------------------
// W2-A3 — DependencyLock pure type + computeDependencyLock, and the
// PackageInstaller service (orchestrates store + repo via dependency injection).
// (installation/domain/dependency-lock.ts + installation/domain/installer.ts)
// ---------------------------------------------------------------------------
export {
  type DependencyLock,
  type DependencyLockEntry,
  computeDependencyLock,
} from './domain/dependency-lock.js';

export {
  // PackageInstaller is a stateless class; `installPackage` is a convenience
  // wrapper that constructs a fresh installer per call. Both are exported so
  // callers can choose instance or functional style.
  PackageInstaller,
  PackageInstallerError,
  installPackage,
  type PackageInstallerDeps,
  type PackageInstallerOptions,
} from './domain/installer.js';

// ---------------------------------------------------------------------------
// W2-A4 — ProcessRun installation pinning (pure value builder) + the legacy
// nullable adapter that reads the new installation_id/package_digest columns
// on saga3_process_runs via raw SQL (does NOT edit sqlite-process-run-repository).
// (installation/domain/process-run-pinning.ts + installation/persistence/process-run-installation-adapter.ts)
// ---------------------------------------------------------------------------
export {
  type PinnedInstallation,
  pinInstallationOnProcessRun,
} from './domain/process-run-pinning.js';

export {
  // Legacy nullable adapter (§14.3.7): resolves NULL → fallback registry
  ProcessRunInstallationAdapter,
} from './persistence/process-run-installation-adapter.js';

// ---------------------------------------------------------------------------
// W2-A5 — PackageRegistry PORT + InstallationBasedPackageRegistry adapter
// (replaces built-in catalog lookups; semver range resolution; no name-switching).
// (installation/domain/package-registry.ts)
// ---------------------------------------------------------------------------
export {
  type PackageRegistry,
  InstallationBasedPackageRegistry,
  // Error code constant
  PACKAGE_NOT_INSTALLED,
} from './domain/package-registry.js';

// ---------------------------------------------------------------------------
// W2-A6 — Generic registries (Handler/Capability/ModuleTool/Schema/Guard/
// AgentDriver) + ProcessModulePlugin + InstalledProcessModule binding.
// (installation/domain/registries.ts + plugin.ts + installation-binding.ts)
//
// NOTE on SchemaRegistry: W2-A6 RE-EXPORTS ContractSchemaRegistry from the
// Wave 1 barrel rather than redefining it. We surface it here as `SchemaRegistry`
// (the Wave 2 generic-registry name) plus the Wave 1 spellings for downstreams
// that already use them. W2-A6's task explicitly says "RE-EXPORT
// ContractSchemaRegistry from Wave 1 (do NOT redefine)". If W2-A6 chose to
// re-export under both names, both appear below; if it only re-exports the
// Wave 1 names, the `SchemaRegistry` alias line is the integrator's call.
// ---------------------------------------------------------------------------
export {
  type HandlerRegistry,
  type HandlerFactory,
  type HandlerInstance,
  InMemoryHandlerRegistry,
  type CapabilityRegistry,
  InMemoryCapabilityRegistry,
  type ModuleToolRegistry,
  InMemoryModuleToolRegistry,
  // SchemaRegistry = Wave 1 ContractSchemaRegistry (re-exported, not redefined)
  type SchemaRegistry,
  InMemorySchemaRegistry,
  type GuardRegistry,
  InMemoryGuardRegistry,
  type AgentDriverRegistry,
  InMemoryAgentDriverRegistry,
} from './domain/registries.js';

export {
  type ProcessModulePlugin,
} from './domain/plugin.js';

export {
  type InstalledProcessModule,
  bindInstallation,
  // Error code constant
  INSTALLATION_BINDING_INCOMPLETE,
} from './domain/installation-binding.js';

// ---------------------------------------------------------------------------
// W2-A7 — describeInstallation (read-only projection from a persisted record)
// + the 3rd synthetic module fixture path is documented in the test, not here.
// (installation/domain/describe.ts)
// ---------------------------------------------------------------------------
export {
  type InstallationDescription,
  describeInstallation,
} from './domain/describe.js';
