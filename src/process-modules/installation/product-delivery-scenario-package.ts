/**
 * W11-A1 — Installed Product Delivery Lifecycle Scenario package.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md`
 *   §2 Lane W11-A1. Plan: §0.14 / Phase 13 preparation (§0.14.11 serial gate).
 * Task: `docs/refactor-management/05-subagent-tasks/W11-a1.md`.
 *
 * ## What this file owns
 *
 * This is the INSTALLED Product Delivery Lifecycle Scenario package: the single
 * artifact that turns Wave 7's scenario runtime + Wave 7's legacy Product
 * Delivery compatibility manifest (W7-A8) into a scenario the Wave 11 cutover
 * can switch NEW runs onto. It is the installable counterpart to the
 * third-party `scenarios-ext/campaign` package (W10-A4): where the campaign
 * package proves arbitrary extensibility with EXTERNAL modules, this package
 * proves the built-in lifecycle is installable through the SAME Wave 7
 * `ScenarioInstaller` surface using the four PRODUCTION modules
 * (discovery + formalization + development + delivery).
 *
 * The package composes three existing Wave 7 lanes — NO new runtime, NO new
 * persistence, NO legacy code deletion (spec §5 anti-scope):
 *
 *   - W7-A8 `application/legacy-scenario-adapter.ts` — produces the frozen
 *     `LifecycleScenarioManifest` view of the legacy `productDeliveryLifecycle`
 *     (two gate modes: permissive = legacy default, strict = regulated). This
 *     package selects the PRODUCTION manifest (permissive, the legacy default)
 *     and re-exposes both for operators that need the strict gate.
 *   - W7-A6 `application/scenario-runner.ts` — the `ScenarioInstaller`
 *     (compile → resolve lock → bind installations → persist lock → return
 *     `InstalledScenario`). This package's `installProductDeliveryScenario`
 *     entry point drives that installer with the Product Delivery manifest.
 *   - W7-A2 `application/scenario-module-lock.ts` + W7-A1
 *     `installation/scenario-store.ts` — the per-stage exact-pin the installer
 *     writes. This package depends on those only through the injected
 *     `ScenarioInstallerDeps` ports (compiler, lockResolver, lockStore,
 *     installationRegistry); it owns NO storage and imports no sqlite.
 *
 * "Installs the 4 production modules + scenario lock" (task brief) is exactly
 * what `ScenarioInstaller.install` does: it resolves the manifest's
 * `requiredModuleSelectors` (the four `~<version>` selectors W7-A8 derived
 * from the legacy stage `moduleRef`s) to four exact installed module
 * identities, persists the resulting `ScenarioModuleLock` (one pin per stage),
 * and binds each stage to its `ProcessModuleInstallation`. The four production
 * modules are exposed here as `PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS` so
 * the Wave 11 composition loader (W11-A2) and the integration tests (W11-A6)
 * can pre-install exactly the modules this scenario needs.
 *
 * ## Dependency direction (ratchet, W0-A1)
 *
 * This file lives at `installation/product-delivery-scenario-package.ts` — a
 * sibling of `installation/index.ts`, NOT under `domain/`, `modules/`,
 * `application/`, `persistence/`, `composition/`, or `lifecycles/`. The six
 * dependency-direction rules classify files by those prefixes; this file
 * matches none of them, so it adds zero new rule-1..6 edges. Its imports are:
 *   - `../domain/spi/*` — pure manifest + contract-ref types (Rule 5 source is
 *     `domain/`, not this file; reading domain from here is permitted).
 *   - `../application/legacy-scenario-adapter.js` (W7-A8) — the manifest
 *     producer. Importing `application/` from `installation/` is permitted
 *     (Rule 5 forbids the reverse — `domain/` → application — only).
 *   - `../application/scenario-runner.js` (W7-A6) — the `ScenarioInstaller`
 *     type + the `InstalledScenario` / `ScenarioInstallerDeps` ports.
 *
 * It imports NO sqlite adapter, NO `db.ts`/`schema.ts`, NO `modules/*`
 * implementation, NO composition root. The four production module selectors
 * are pure data carried verbatim off the W7-A8 manifest; no module-name
 * switching (Rule 4) is introduced.
 *
 * ## Purity / serializability
 *
 * The exported manifest is plain JSON-serializable data (it is the W7-A8
 * manifest, which is already canonically serializable and eager-validated at
 * its own module load). The `installProductDeliveryScenario` function is a
 * thin orchestrator over the injected `ScenarioInstaller` — it holds no
 * mutable state and performs no I/O of its own.
 */

// W7-A8 — the frozen legacy Product Delivery compatibility manifests. This
// package's job is to INSTALL one of them; W7-A8 owns the manifest shape and
// the eager `validateLifecycleScenarioManifest` check at module load.
import {
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  LEGACY_PRODUCT_DELIVERY_SCENARIOS,
  legacyProductDeliveryScenarioFor,
  LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION,
} from '../application/legacy-scenario-adapter.js';

// W7-A6 — the Wave 7 ScenarioInstaller + the InstalledScenario / deps ports
// it produces. This package drives the installer with the Product Delivery
// manifest; the installer owns compile → resolve → bind → persist.
import { ScenarioInstaller } from '../application/scenario-runner.js';
import type {
  InstalledScenario,
  ScenarioInstallerDeps,
} from '../application/scenario-runner.js';

// Wave 1 SPI — the manifest + selector + contract-ref types, re-exported so
// consumers of the package (the Wave 11 composition loader, integration tests)
// import the scenario surface from one place.
import type {
  LifecycleScenarioManifest,
  ModuleSelector,
} from '../domain/spi/scenario-manifest.js';

// ---------------------------------------------------------------------------
// Discovery gate selection.
//
// The W7-A8 adapter emits TWO manifests (permissive = legacy default, strict =
// regulated) because the manifest surface is structurally incapable of carrying
// the legacy per-run `routeResolver` (plan §6.4). The operator/installer picks
// one at scenario-install time. The package's default is PERMISSIVE — the
// legacy default — which is what production Product Delivery runs used before
// the cutover. A caller that needs the regulated strict gate passes
// `{ discoveryGate: 'strict' }`.
// ---------------------------------------------------------------------------

/**
 * The two values the legacy `discoveryGate` flag can take, mirrored from W7-A8.
 * Used to select which legacy compatibility manifest this package installs.
 */
export type ProductDeliveryDiscoveryGate = 'permissive' | 'strict';

/**
 * Options for {@link installProductDeliveryScenario}.
 *
 * @property discoveryGate Which legacy compatibility manifest to install.
 *                         `'permissive'` (default) installs the manifest where
 *                         every Discovery outcome forwards to Formalization
 *                         (the legacy default). `'strict'` installs the
 *                         manifest where non-go Discovery outcomes terminate
 *                         (the regulated-environment legacy variant). This is
 *                         the explicit, declarative equivalent of the legacy
 *                         per-run `discoveryGate` flag (spec §6.4 — the
 *                         manifest surface carries no executable resolver).
 */
export interface InstallProductDeliveryScenarioOptions {
  readonly discoveryGate?: ProductDeliveryDiscoveryGate;
}

// ---------------------------------------------------------------------------
// Production manifest + module selectors.
//
// `PRODUCT_DELIVERY_SCENARIO_MANIFEST` is the manifest NEW Product Delivery
// runs switch onto at the Wave 11 cutover (spec §3). It is the W7-A8
// permissive manifest — the legacy default — re-exported under the package's
// own name so consumers depend on the installable package, not the W7-A8
// compatibility bridge directly.
//
// `PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS` is the four-module dependency
// closure the installer resolves + pins (one pin per stage). Exposed so the
// Wave 11 composition loader can pre-install exactly these four production
// modules before installing the scenario, and so integration tests can assert
// the cutover depends on no other module contract.
// ---------------------------------------------------------------------------

/**
 * The installed Product Delivery scenario manifest — the PERMISSIVE Discovery
 * gate (legacy default). This is the manifest new Product Delivery runs use
 * after the Wave 11 cutover.
 *
 * Pure data: a re-export of `LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE`
 * (W7-A8), which is eager-validated canonically-serializable data wrapping the
 * frozen `productDeliveryLifecycle`. No functions, no `routeResolver`.
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFEST: LifecycleScenarioManifest =
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE;

/**
 * The strict-gate variant (regulated environments). Install this manifest via
 * `installProductDeliveryScenario(deps, { discoveryGate: 'strict' })`. Re-exported
 * for operators and tests that need to assert both gate modes are installable.
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT: LifecycleScenarioManifest =
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT;

/**
 * The four production module contracts the Product Delivery scenario depends
 * on, in stage-declaration order (discovery, formalization, development,
 * delivery). Each is a `ModuleSelector { name; versionRange }` derived by
 * W7-A8 from the legacy stage `moduleRef` (`~<version>` = patch upgrades only).
 *
 * The Wave 7 `ScenarioInstaller` resolves each selector to an exact installed
 * module identity and writes one `ScenarioModuleLockEntry` per stage. This is
 * the "installs the 4 production modules + scenario lock" surface from the
 * task brief: the closure is pure data the installer pins, not a name switch.
 *
 * De-duplicated by `name@versionRange` (a single module reused across stages
 * would appear once); for Product Delivery each stage binds a distinct module,
 * so all four selectors are present.
 */
export const PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS: readonly ModuleSelector[] =
  PRODUCT_DELIVERY_SCENARIO_MANIFEST.requiredModuleSelectors;

/**
 * Manifest envelope format version, re-exported from W7-A8 so consumers do not
 * depend on the compatibility bridge for the package's own version surface.
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION: string =
  LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION;

/**
 * Resolve the Product Delivery scenario manifest for a given Discovery gate
 * mode. Delegates to W7-A8's `legacyProductDeliveryScenarioFor`; exposed under
 * the package's own name so a caller selects the manifest through the
 * installable package rather than the compatibility bridge.
 *
 * Pure: returns one of the two frozen manifest constants; allocates nothing.
 */
export function productDeliveryScenarioManifestFor(
  gate: ProductDeliveryDiscoveryGate | undefined,
): LifecycleScenarioManifest {
  return legacyProductDeliveryScenarioFor(gate);
}

/**
 * The two Product Delivery manifests keyed by gate mode, for callers that need
 * to iterate both (e.g. a cutover audit that installs permissive + strict to
 * prove both gate modes are installable through the Wave 7 surface).
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFESTS: Readonly<
  Record<ProductDeliveryDiscoveryGate, LifecycleScenarioManifest>
> = LEGACY_PRODUCT_DELIVERY_SCENARIOS;

// ---------------------------------------------------------------------------
// Install entry point.
//
// `installProductDeliveryScenario` is the single install-time entry point for
// the Product Delivery scenario package. It selects the manifest for the
// requested gate mode and drives the Wave 7 `ScenarioInstaller` with the
// injected ports. The installer performs the full pipeline:
//   1. compile/validate the manifest (W7-A3 compiler port);
//   2. resolve every ModuleSelector to an exact installed module identity +
//      produce the ScenarioModuleLock (W7-A2 lock-resolver port);
//   3. bind each resolved module ref to its ProcessModuleInstallation
//      (ProcessModuleInstallationRegistry port);
//   4. persist the lock (W7-A2 lock-store port);
//   5. return the InstalledScenario (manifest snapshot + hash + lock + per-stage
//      installation binding).
//
// All four ports are INJECTED: this package owns no storage, no sqlite, no
// module implementation. The composition root (Wave 11 W11-A2 composition
// loader) wires the concrete sqlite-backed ports; tests inject fakes. This
// mirrors exactly how `PackageInstaller` (W2-A3) and `ScenarioInstaller`
// (W7-A6) are consumed — pure orchestration over injected ports.
// ---------------------------------------------------------------------------

/**
 * Injected dependencies for {@link installProductDeliveryScenario}. This is the
 * Wave 7 `ScenarioInstallerDeps` surface unchanged: every collaborator is a
 * port the composition root wires (compiler, lockResolver, lockStore,
 * installationRegistry). Re-exported under the package's own name so consumers
 * import the dep bundle from the installable package.
 */
export type ProductDeliveryScenarioInstallerDeps = ScenarioInstallerDeps;

/**
 * Install the Product Delivery scenario as a frozen, lock-pinned
 * {@link InstalledScenario} via the Wave 7 `ScenarioInstaller`.
 *
 * Selects the manifest for `options.discoveryGate` (default `'permissive'` =
 * legacy default) and delegates to `ScenarioInstaller.install`. The installer
 * compiles the manifest, resolves the four production module selectors to
 * exact installed identities, writes the scenario module lock (one pin per
 * stage), binds each stage to its `ProcessModuleInstallation`, and returns the
 * `InstalledScenario` the Wave 11 cutover routes new runs through.
 *
 * Failure modes surface as `ScenarioInstallerError` with a stable code (see
 * W7-A6): `SCENARIO_INSTALL_MANIFEST_INVALID`,
 * `SCENARIO_INSTALL_MODULE_UNRESOLVED`, `SCENARIO_INSTALL_NOT_INSTALLED`,
 * `SCENARIO_INSTALL_LOCK_WRITE_FAILED`. A common cause at cutover time is
 * `SCENARIO_INSTALL_NOT_INSTALLED`: the four production modules are not yet
 * installed in the `ProcessModuleInstallationRegistry` — the composition loader
 * (W11-A2) must pre-install them (use
 * {@link PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS} as the install closure).
 *
 * @param deps   The Wave 7 installer ports (compiler, lockResolver, lockStore,
 *               installationRegistry). Injected by the composition root.
 * @param options Discovery gate selection. Defaults to `'permissive'`.
 * @returns the installed scenario (manifest snapshot + hash + lock + per-stage
 *          installation binding).
 */
export async function installProductDeliveryScenario(
  deps: ProductDeliveryScenarioInstallerDeps,
  options?: InstallProductDeliveryScenarioOptions,
): Promise<InstalledScenario> {
  const gate: ProductDeliveryDiscoveryGate = options?.discoveryGate ?? 'permissive';
  const manifest = productDeliveryScenarioManifestFor(gate);
  // A fresh stateless installer per call — ScenarioInstaller holds no mutable
  // fields, so this is allocation-cheap and keeps the call side-effect-free
  // apart from the injected ports.
  const installer = new ScenarioInstaller();
  return installer.install(manifest, deps);
}

/**
 * Stateless convenience: install the PERMISSIVE (legacy-default) Product
 * Delivery scenario. Identical to
 * `installProductDeliveryScenario(deps, { discoveryGate: 'permissive' })`;
 * provided because the permissive gate is the production default and the
 * overwhelming majority of cutover runs use it.
 */
export async function installProductDeliveryScenarioPermissive(
  deps: ProductDeliveryScenarioInstallerDeps,
): Promise<InstalledScenario> {
  return installProductDeliveryScenario(deps, { discoveryGate: 'permissive' });
}

/**
 * Stateless convenience: install the STRICT (regulated) Product Delivery
 * scenario. Use for contractual environments where Discovery is a real
 * go/no-go gate (non-go outcomes terminate).
 */
export async function installProductDeliveryScenarioStrict(
  deps: ProductDeliveryScenarioInstallerDeps,
): Promise<InstalledScenario> {
  return installProductDeliveryScenario(deps, { discoveryGate: 'strict' });
}
