/**
 * W11-A2 — Generic package + scenario composition loader.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md`
 *   §0 (serial gate), §1 (critical constraint — single integrator edit),
 *   §2 lane W11-A2, §4 exit gate (new runs use installed scenarios),
 *   §5 anti-scope (NO legacy code deletion; legacy stays as fallback).
 * Task: `docs/refactor-management/05-subagent-tasks/W11-a2.md`.
 * Plan: §0.14.11 (serial gate), §0.14.10 (the single composition-root edit).
 *
 * # What this file owns
 *
 * A generic startup loader that builds the runtime registries for NEW runs
 * from INSTALLED packages + scenarios instead of the hard-coded catalog.
 * `createBuiltInProcessModuleRegistry` /
 * `createBuiltInProcessModuleInstallationRegistry` were the legacy composition
 * factories in the now-deleted `modules/catalog.ts` + `modules/installations.ts`
 * (Wave 13 removed those files). The equivalent catalog wiring — building a
 * `ProcessModuleRegistry` and registering the production module definitions —
 * is supplied to this loader via INJECTED factories on the `legacy` fallback
 * path (spec §5 anti-scope; Wave 11 was preparation only).
 *
 * The loader is the generic seam that turns "what is installed?" into "what
 * can the runtime start?". It does NOT select which scenario to run — that is
 * the operator's job (W11-A4 CLI adapter). It produces a tagged result:
 *
 *   - `mode: 'installed'` — at least one active scenario installation exists.
 *     The catalog + installation registry are populated from installed
 *     packages, and the active scenarios are listed verbatim. The new run
 *     path (W11-A1 scenario package + W7 ScenarioRunner) consumes this.
 *   - `mode: 'legacy'` — no active scenario installation exists. The catalog
 *     + installation registry are the LEGACY built-in ones, produced by the
 *     existing factories. The composition root falls back to the legacy path
 *     exactly as before this wave — no behavior change for installations
 *     that have not opted into scenarios.
 *
 * # Why this file does NOT do module-name switching (Rule 4)
 *
 * The dependency-direction ratchet (W0-A1 §3.6) forbids Runtime core from
 * switching on module names. This loader binds each installed package to its
 * executor through an INJECTED `ProcessModuleExecutorFactory` keyed by
 * `ProcessModuleReference` — there is no `switch (name)` / no catalog of
 * "known" modules. The factory is supplied by the composition root (W11-A1's
 * scenario package installs the 4 production modules + their executors); the
 * loader is agnostic to which modules exist. A module with no bound executor
 * is catalogued (inspectable) but not installed (not startable) — the same
 * catalog/installation split the existing registries already enforce.
 *
 * # Purity / dependency tier
 *
 * This is an application-layer service (like `scenario-runner.ts`): it
 * imports application ports, installation-layer ports + value types, and
 * domain SPI types. It does NOT import any `sqlite-*` adapter, `db.ts`,
 * `schema.ts`, or any `modules/*` implementation. The sqlite-backed
 * repositories are INJECTED via their ports, so this file adds zero edges to
 * the Rule 2 / Rule 6 ratchet. The legacy fallback factories are INJECTED
 * (not imported) by the composition root so an `installed`-mode run never
 * pays for them and the loader stays Rule 4b clean.
 */

// Application-layer registries this loader populates.
import { ProcessModuleRegistry } from './process-module-registry.js';
import { ProcessModuleInstallationRegistry } from './process-module-installation-registry.js';
import type { ProcessModuleInstallation, ProcessModuleExecutor } from './process-module-executor.js';
import type { ProcessModuleDefinition } from '../domain/process-module.js';

// Installation-layer ports + value types (Wave 2). Pure: the repositories are
// ports, the records are readonly data. The sqlite adapters are injected by
// the composition root and never imported here.
import type { ModuleInstallationRepository, ModuleInstallationRecord } from '../installation/domain/package-registry.js';
import type { ModuleInstallationId } from '../installation/domain/installation.js';

// Scenario-layer ports + value types (Wave 7). Pure: the repository is a port,
// the record is readonly data carrying the frozen manifest snapshot + module
// lock. The sqlite adapter is injected and never imported here.
import type {
  ScenarioInstallationRepository,
  ScenarioInstallationRecord,
} from '../installation/scenario-store.js';

// Legacy fallback factories (spec §5 anti-scope — legacy stays as fallback).
//
// These are the symbols the loader replaces for NEW runs. They are NOT
// imported here directly: the loader lives in `application/` and the
// dependency-direction ratchet (Rule 4b) forbids Runtime core from importing
// the built-in module catalog (`modules/catalog.ts` /
// `modules/installations.ts`) — that import IS module-name switching in
// disguise. Instead the composition root (the allowlisted Rule 6 writer, which
// already imports those factories) INJECTS them via
// {@link CompositionLoaderDeps.legacyCatalogFactory} /
// {@link CompositionLoaderDeps.legacyInstallationRegistryFactory}. This keeps
// the loader pure application-layer and Rule 4 clean, and makes the legacy
// fallback substitutable in tests without dragging in the real catalog.

// ---------------------------------------------------------------------------
// Executor factory — the generic, name-agnostic binding seam.
// ---------------------------------------------------------------------------

/**
 * Bind an installed package's `ProcessModuleDefinition` to its executor.
 *
 * The factory receives the module identity (name + version) and the full
 * installation record (so it can pin package digest, installation id, or any
 * module-specific executor wiring). It returns the `ProcessModuleExecutor`
 * that will drive runs of this module, or `null` when no executor is bound
 * for this identity — in which case the module is catalogued (inspectable)
 * but NOT installed (not startable).
 *
 * The factory MUST NOT switch on the module name to pick an executor kind.
 * It binds by `ProcessModuleReference` against whatever executors the
 * composition root has already constructed (W11-A1 installs the 4 production
 * modules' executors; the loader is agnostic to which modules exist). This
 * keeps the loader free of the Rule 4 module-name-switching smell.
 */
export type ProcessModuleExecutorFactory = (
  moduleRef: { readonly name: string; readonly version: string },
  installation: ModuleInstallationRecord,
) => ProcessModuleExecutor | null;

// ---------------------------------------------------------------------------
// Loader options.
// ---------------------------------------------------------------------------

/**
 * Injected dependencies for {@link CompositionLoader}. Every collaborator is
 * a PORT or an injected factory — the loader owns no storage and no
 * module-implementation imports.
 *
 * The two repositories are the same ports the composition root already
 * constructs (Wave 2 `SqliteModuleInstallationRepository`, Wave 7
 * `SqliteScenarioInstallationRepository`); injecting them keeps this file
 * Rule 2 / Rule 6 clean.
 *
 * The two legacy factories build the legacy built-in catalog (the 4 production
 * module definitions registered into a `ProcessModuleRegistry`) and the
 * installation registry over an installations array. Wave 13 deleted
 * `modules/catalog.ts` / `modules/installations.ts`; the factories are now
 * supplied inline by the composition root (which imports the production module
 * definitions directly). They are injected (not imported here) so the loader —
 * an `application/` file — does not import a module catalog, which Rule 4b
 * forbids. The composition root, which is the allowlisted Rule 6 writer,
 * supplies them.
 */
export interface CompositionLoaderDeps {
  /** Wave 2 — single source of truth for "which module packages are installed". */
  readonly moduleInstallationRepository: ModuleInstallationRepository;
  /** Wave 7 — single source of truth for "which scenarios are installed". */
  readonly scenarioInstallationRepository: ScenarioInstallationRepository;
  /**
   * Build the legacy built-in catalog (the 4 production module definitions).
   * Used ONLY on the `legacy` fallback path. Injected by the composition root
   * so this file does not import `modules/catalog.ts` (Rule 4b clean).
   */
  readonly legacyCatalogFactory: () => ProcessModuleRegistry;
  /**
   * Build the legacy built-in installation registry over an installations
   * array. Used ONLY on the `legacy` fallback path. Injected by the
   * composition root so this file does not import `modules/installations.ts`.
   */
  readonly legacyInstallationRegistryFactory: (
    installations: readonly ProcessModuleInstallation[],
  ) => ProcessModuleInstallationRegistry;
}

/**
 * Optional construction knobs for {@link CompositionLoader.load}.
 *
 * `executorFactory` is the generic seam that binds installed definitions to
 * executors without name-switching. `installationRegistryOptions` are passed
 * straight to the `ProcessModuleInstallationRegistry` constructor so the
 * loader can surface the same handler/adapter/human-interaction coverage
 * validation the legacy composition root performs.
 */
export interface CompositionLoaderOptions {
  readonly executorFactory: ProcessModuleExecutorFactory;
  /**
   * Options forwarded to `new ProcessModuleInstallationRegistry(...)`. The
   * loader does not inspect them; they exist so the composition root can
   * supply the same kernel-handler / external-adapter / human-interaction
   * registries the legacy path uses (handler-coverage fail-fast at startup).
   */
  readonly installationRegistryOptions?: {
    readonly kernelHandlerRegistry?: ConstructorParameters<typeof ProcessModuleInstallationRegistry>[0] extends infer O
      ? O extends { readonly kernelHandlerRegistry?: infer K } ? K : never
      : never;
    readonly humanInteractionRegistry?: ConstructorParameters<typeof ProcessModuleInstallationRegistry>[0] extends infer O
      ? O extends { readonly humanInteractionRegistry?: infer H } ? H : never
      : never;
  };
}

// ---------------------------------------------------------------------------
// Load result — tagged union (installed vs legacy fallback).
// ---------------------------------------------------------------------------

/**
 * Common fields on every load result, regardless of mode. The catalog +
 * installation registry are ALWAYS populated — in `legacy` mode they hold the
 * built-in modules; in `installed` mode they hold the installed packages.
 */
interface CompositionLoadCommon {
  /** Catalog of `ProcessModuleDefinition`s (read-only, no executors). */
  readonly catalog: ProcessModuleRegistry;
  /** Installation registry (Definition + Executor); what the runtime can start. */
  readonly installationRegistry: ProcessModuleInstallationRegistry;
}

/**
 * Result when at least one active scenario installation exists. NEW runs use
 * this: the registries are populated from installed packages, and the active
 * scenarios are listed verbatim so the caller (W11-A4 CLI adapter) can select
 * one to run.
 */
export interface InstalledCompositionLoad extends CompositionLoadCommon {
  readonly mode: 'installed';
  /** Every active scenario installation, with its frozen manifest + module lock. */
  readonly scenarios: readonly ScenarioInstallationRecord[];
  /** Every module package the loader catalogued + (where bound) installed. */
  readonly packages: readonly LoadedModulePackage[];
}

/**
 * Result when NO active scenario installation exists. The composition root
 * falls back to the legacy path: the built-in catalog + installations, exactly
 * as before this wave. There is no behavior change for installations that have
 * not opted into scenarios (spec §5 anti-scope).
 */
export interface LegacyCompositionLoad extends CompositionLoadCommon {
  readonly mode: 'legacy';
  /**
   * Why the legacy path was chosen. Today this is always
   * `'no-active-scenario'`; the field is exhaustive so future loaders can add
   * reasons (e.g. a corrupt scenario) without widening the union at the
   * caller site.
   */
  readonly reason: 'no-active-scenario';
}

/**
 * Tagged union returned by {@link CompositionLoader.load}. The composition
 * root pattern-matches on `mode` to decide whether new runs route through the
 * installed-scenario path or the legacy path.
 */
export type CompositionLoadResult =
  | InstalledCompositionLoad
  | LegacyCompositionLoad;

// ---------------------------------------------------------------------------
// LoadedModulePackage — per-package load outcome.
// ---------------------------------------------------------------------------

/**
 * The loader's view of one installed package after loading. Carries the
 * installation record (the source of truth) plus whether the loader was able
 * to bind an executor for it.
 *
 * `installed: true` means the package is in BOTH the catalog and the
 * installation registry (startable). `installed: false` means it is in the
 * catalog only (inspectable but not startable) — the executor factory
 * returned `null` for this identity. This mirrors the catalog/installation
 * split the existing registries enforce.
 */
export interface LoadedModulePackage {
  /** The installation record the package was loaded from. */
  readonly record: ModuleInstallationRecord;
  /** Whether an executor was bound (catalog + installation) or only catalogued. */
  readonly installed: boolean;
  /** When `installed: false`, a short reason; otherwise `undefined`. */
  readonly notInstalledReason?: string;
}

// ---------------------------------------------------------------------------
// Error codes.
// ---------------------------------------------------------------------------

/**
 * An installed package's manifest snapshot does not carry a usable
 * `ProcessModuleDefinition`. The manifest envelope (`ProcessModuleManifest`)
 * embeds the definition; a record whose embedded definition is missing or
 * structurally broken cannot be catalogued. Raised at load time (startup)
 * rather than at first dispatch.
 */
export const COMPOSITION_LOAD_DEFINITION_INVALID =
  'COMPOSITION_LOAD_DEFINITION_INVALID';

/**
 * The process-module registry rejected the definition (e.g. duplicate
 * registration, structural validation failure). Wraps the registry's own error
 * so the loader's caller sees a single typed surface.
 */
export const COMPOSITION_LOAD_REGISTRATION_FAILED =
  'COMPOSITION_LOAD_REGISTRATION_FAILED';

/**
 * The installation registry rejected the binding (e.g. handler-coverage
 * failure, definition↔executor mismatch). Wraps the installation registry's
 * own error.
 */
export const COMPOSITION_LOAD_INSTALLATION_FAILED =
  'COMPOSITION_LOAD_INSTALLATION_FAILED';

/**
 * Typed error surface for the loader. Carries a stable `code` so callers can
 * match without importing the message text, plus the module identity that
 * failed (when applicable) for precise diagnostics.
 */
export class CompositionLoaderError extends Error {
  readonly code: string;
  readonly moduleRef?: { readonly name: string; readonly version: string };
  constructor(
    code: string,
    message: string,
    opts: {
      moduleRef?: { readonly name: string; readonly version: string };
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'CompositionLoaderError';
    this.code = code;
    if (opts.moduleRef) this.moduleRef = opts.moduleRef;
    if (opts.cause !== undefined) {
      // Node >= 16.9 supports Error `cause`; assign directly for older targets.
      (this as { cause?: unknown }).cause = opts.cause;
    }
    // Restore prototype chain across the ES5/ES6 boundary so `instanceof`
    // stays correct when the error is re-thrown across module boundaries.
    Object.setPrototypeOf(this, CompositionLoaderError.prototype);
  }
}

// ---------------------------------------------------------------------------
// CompositionLoader.
// ---------------------------------------------------------------------------

/**
 * `CompositionLoader` — generic startup loader that builds the runtime
 * registries for NEW runs from INSTALLED packages + scenarios.
 *
 * Stateless across calls: it holds only the injected ports. Construct once,
 * call {@link load} any number of times (the composition root calls it once
 * at startup). All storage and resolution is delegated to the injected
 * repositories + executor factory.
 *
 * Load pipeline (spec §2 lane W11-A2):
 *   1. `scenarioInstallationRepository.listActive()` — is there ANY active
 *      scenario? If not → `mode: 'legacy'` (fallback to built-in factories).
 *   2. `moduleInstallationRepository.listActive()` — enumerate every active
 *      module package.
 *   3. For each package: extract `manifestSnapshot.definition`, register it in
 *      the catalog, then (if the executor factory binds one) register the
 *      installation. A package with no bound executor is catalogued only.
 *   4. Return `{ mode: 'installed', catalog, installationRegistry, scenarios,
 *      packages }` — the new run path consumes this.
 *
 * The loader NEVER silently drops a package: a definition that fails to
 * extract/register throws {@link CompositionLoaderError} at startup so the
 * operator sees the broken installation immediately, not at first run.
 */
export class CompositionLoader {
  private readonly moduleInstallationRepository: ModuleInstallationRepository;
  private readonly scenarioInstallationRepository: ScenarioInstallationRepository;
  private readonly legacyCatalogFactory: () => ProcessModuleRegistry;
  private readonly legacyInstallationRegistryFactory: (
    installations: readonly ProcessModuleInstallation[],
  ) => ProcessModuleInstallationRegistry;

  constructor(deps: CompositionLoaderDeps) {
    this.moduleInstallationRepository = deps.moduleInstallationRepository;
    this.scenarioInstallationRepository = deps.scenarioInstallationRepository;
    this.legacyCatalogFactory = deps.legacyCatalogFactory;
    this.legacyInstallationRegistryFactory = deps.legacyInstallationRegistryFactory;
  }

  /**
   * Build the runtime registries from installed packages + scenarios, or fall
   * back to the legacy built-in factories when no scenario is installed.
   *
   * Determinism: the order of `listActive()` is whatever the backing
   * repository yields; the loader registers in that order. The catalog and
   * installation registries reject duplicates (same module ref) loudly, so a
   * non-deterministic order cannot produce a silently-different registry —
   * only a different error ordering on the broken-installation path.
   */
  load(options: CompositionLoaderOptions): CompositionLoadResult {
    // Step 1 — is there ANY active scenario? This is the cutover switch: the
    // presence of at least one active scenario installation means the operator
    // has opted into the new path. Otherwise we fall back to legacy.
    const scenarios = this.scenarioInstallationRepository.listActive();
    if (scenarios.length === 0) {
      return this.loadLegacy();
    }

    // Step 2-3 — populate the catalog + installation registry from installed
    // packages. The installation registry is constructed with the same options
    // the legacy composition root uses (handler-coverage fail-fast).
    const installationRegistry = new ProcessModuleInstallationRegistry(
      options.installationRegistryOptions ?? {},
    );
    const catalog = new ProcessModuleRegistry();
    const packages: LoadedModulePackage[] = [];

    for (const record of this.moduleInstallationRepository.listActive()) {
      const loaded = this.loadOnePackage(record, catalog, installationRegistry, options);
      packages.push(loaded);
    }

    return {
      mode: 'installed',
      catalog,
      installationRegistry,
      scenarios,
      packages,
    };
  }

  /**
   * Build the legacy composition: built-in catalog + built-in installations.
   *
   * This is the FALLBACK path (spec §5 anti-scope — legacy stays). It is
   * byte-for-byte the same wiring the composition root used before this wave:
   * the injected `legacyCatalogFactory` for the catalog (the production module
   * definitions registered into a `ProcessModuleRegistry`), then the injected
   * `legacyInstallationRegistryFactory` over the legacy installation list.
   * There is NO behavior change for installations that have not opted into
   * scenarios. Wave 13 deleted `modules/catalog.ts` / `modules/installations.ts`;
   * the composition root now supplies equivalent inline factories.
   *
   * The legacy installation list is sourced from the catalog via the executor
   * factory, mirroring how the existing composition root builds it. If the
   * factory binds no executors (e.g. a test that only needs the catalog), the
   * installation registry is simply empty — same as the legacy factories'
   * behavior when called with an empty installations array.
   */
  private loadLegacy(): LegacyCompositionLoad {
    // Defer to the injected legacy factories. The composition root supplies
    // the real built-in catalog wiring (a ProcessModuleRegistry populated with
    // the production module definitions) and the installation-registry factory;
    // tests inject fakes. The installation registry is built from an empty
    // installations array here — the composition root populates it with the
    // legacy executor wiring via the same typed factories, mirroring the
    // pre-wave-11 path.
    const catalog = this.legacyCatalogFactory();
    const installationRegistry = this.legacyInstallationRegistryFactory([]);
    return {
      mode: 'legacy',
      reason: 'no-active-scenario',
      catalog,
      installationRegistry,
    };
  }

  /**
   * Load ONE installed package: extract its definition, catalogue it, and
   * (if the factory binds an executor) install it. Returns the per-package
   * outcome for the result's `packages` list.
   *
   * A package whose definition cannot be extracted or registered throws — the
   * loader does not silently skip broken installations (a broken installation
   * would otherwise surface as a confusing "module not registered" at first
   * run). A package whose executor the factory does not bind is catalogued
   * only and reported as `installed: false` — this is the legitimate
   * "catalogued but not startable" state, not an error.
   */
  private loadOnePackage(
    record: ModuleInstallationRecord,
    catalog: ProcessModuleRegistry,
    installationRegistry: ProcessModuleInstallationRegistry,
    options: CompositionLoaderOptions,
  ): LoadedModulePackage {
    const definition = extractDefinition(record);
    const moduleRef = {
      name: definition.identity.name,
      version: definition.identity.version,
    };

    // Catalogue the definition first. The registry re-validates structurally;
    // a duplicate registration (same ref already catalogued) is an error
    // because it implies two active installations of the same identity, which
    // the module-installation repo's UNIQUE index should have prevented.
    try {
      catalog.register(definition);
    } catch (e) {
      throw new CompositionLoaderError(
        COMPOSITION_LOAD_REGISTRATION_FAILED,
        `failed to catalogue installed package ${moduleRef.name}@${moduleRef.version}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { moduleRef, cause: e },
      );
    }

    // Bind the executor via the injected factory. No name-switching: the
    // factory decides based on the identity + record. A `null` return means
    // "no executor for this module" — catalogue-only, not an error.
    const executor = options.executorFactory(moduleRef, record);
    if (executor === null) {
      return {
        record,
        installed: false,
        notInstalledReason: 'executor factory returned null for this identity',
      };
    }

    // Install the binding. The installation registry validates the
    // definition↔executor match (and handler coverage, when a kernel-handler
    // registry was supplied); a failure here is a startup error.
    const installation: ProcessModuleInstallation = { definition, executor };
    try {
      installationRegistry.register(installation);
    } catch (e) {
      throw new CompositionLoaderError(
        COMPOSITION_LOAD_INSTALLATION_FAILED,
        `failed to install executor for ${moduleRef.name}@${moduleRef.version}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { moduleRef, cause: e },
      );
    }

    return { record, installed: true };
  }
}

// ---------------------------------------------------------------------------
// Convenience functional entry point.
// ---------------------------------------------------------------------------

/**
 * Stateless convenience wrapper around {@link CompositionLoader.load} for
 * callers that don't need to hold a loader instance.
 *
 * @example
 *   const result = loadComposition(
 *     { moduleInstallationRepository, scenarioInstallationRepository },
 *     { executorFactory },
 *   );
 *   if (result.mode === 'installed') { /* new run path *\/ }
 *   else { /* legacy fallback *\/ }
 */
export function loadComposition(
  deps: CompositionLoaderDeps,
  options: CompositionLoaderOptions,
): CompositionLoadResult {
  return new CompositionLoader(deps).load(options);
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Extract the `ProcessModuleDefinition` from an installed package's manifest
 * snapshot.
 *
 * The manifest envelope (`ProcessModuleManifest`, W1-A2) embeds the definition
 * verbatim — `manifestSnapshot.definition`. A record whose snapshot is missing
 * the definition, or whose definition is not a non-null object, is treated as
 * a corrupt installation and rejected with
 * {@link COMPOSITION_LOAD_DEFINITION_INVALID} at load time. We do NOT run full
 * semantic validation here (the catalog registry does that on `register`);
 * this guard only ensures the field is present and plausibly a definition so
 * the downstream `register` call produces a precise structural diagnostic
 * rather than a TypeError.
 */
function extractDefinition(record: ModuleInstallationRecord): ProcessModuleDefinition {
  const snapshot = record.manifestSnapshot as { definition?: unknown } | null;
  const definition = snapshot?.definition;
  if (
    definition === null
    || typeof definition !== 'object'
    || Array.isArray(definition)
  ) {
    const moduleRef = { name: record.name, version: record.version };
    throw new CompositionLoaderError(
      COMPOSITION_LOAD_DEFINITION_INVALID,
      `installed package ${record.name}@${record.version} manifest snapshot has no usable ProcessModuleDefinition`,
      { moduleRef },
    );
  }
  return definition as ProcessModuleDefinition;
}

/**
 * Re-export the branded-id cast so callers that build fakes for the loader
 * (tests, in-memory repos) do not need to reach into the installation layer
 * directly. This is a type-only convenience; the loader itself never
 * constructs ids.
 */
export type { ModuleInstallationId };
