/**
 * Installed Product Delivery Lifecycle Scenario package.
 *
 * # What this file owns
 *
 * This is the INSTALLED Product Delivery Lifecycle Scenario package: the
 * single artifact that turns the scenario runtime into a scenario the cutover
 * can switch NEW runs onto. It is the installable counterpart to the
 * third-party `scenarios-ext/campaign` package: where the campaign package
 * proves arbitrary extensibility with EXTERNAL modules, this package proves
 * the built-in lifecycle is installable through the SAME `ScenarioInstaller`
 * surface using the four PRODUCTION modules (discovery + formalization +
 * development + delivery).
 *
 * See `docs/architecture/WAVE-LOG.md` (Wave 11) for the cutover history.
 *
 * # Canonical manifest producer (cutover ratchet rule 1)
 *
 * This package is the CANONICAL home of the Product Delivery scenario
 * `LifecycleScenarioManifest`. It builds the manifest directly from the frozen
 * `productDeliveryLifecycle` definition (pure data construction — no
 * duplicate the construction.
 *
 * This ownership direction is mandated by the cutover ratchet (see
 * `tests/architecture/cutover-architecture-checks.test.mjs` rule 1 + the "no
 * new-core file imports a compatibility entry point" rule): NEW runs route
 * through INSTALLED scenarios, so the installed package must own the manifest
 * identity. A new-core file reaching back into the compatibility bridge for
 * the manifest would be a hidden fallback — the cutover silently routing new
 * the manifest here, from the pure lifecycle definition, keeps the new
 * execution lane self-contained.
 *
 * The package composes two existing scenario lanes — NO new runtime, NO new
 *
 *   - `application/scenario-runner.ts` — the `ScenarioInstaller`
 *     (compile → resolve lock → bind installations → persist lock → return
 *     `InstalledScenario`). This package's `installProductDeliveryScenario`
 *     entry point drives that installer with the Product Delivery manifest.
 *   - `application/scenario-module-lock.ts` + `installation/scenario-store.ts`
 *     — the per-stage exact-pin the installer writes. This package depends on
 *     those only through the injected `ScenarioInstallerDeps` ports (compiler,
 *     lockResolver, lockStore, installationRegistry); it owns NO storage and
 *     imports no sqlite.
 *
 * "Installs the 4 production modules + scenario lock" is exactly what
 * `ScenarioInstaller.install` does: it resolves the manifest's
 * `requiredModuleSelectors` (the four `~<version>` selectors derived from the
 * persists the resulting `ScenarioModuleLock` (one pin per stage), and binds
 * each stage to its `ProcessModuleInstallation`. The four production module
 * selectors are exposed here as `PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS`
 * so the composition loader and the integration tests can pre-install exactly
 * the modules this scenario needs.
 *
 * # Dependency direction (ratchet)
 *
 * This file lives at `installation/product-delivery-scenario-package.ts` — a
 * sibling of `installation/index.ts`, NOT under `domain/`, `modules/`,
 * `application/`, `persistence/`, `composition/`, or `infrastructure/`. The
 * six dependency-direction rules classify files by those prefixes; this file
 * matches none of them, so it adds zero new rule-1..6 edges. Its imports are:
 *   - `../domain/spi/*` — pure manifest + contract-ref types (Rule 5 source
 *     is `domain/`, not this file; reading domain from here is permitted).
 *   - `../lifecycles/product-delivery-lifecycle.js` — the frozen lifecycle
 *     definition this manifest is derived from. `lifecycles/` is not a
 *     forbidden import for new-core (the cutover ratchet forbids `modules/`,
 *     `composition/`, `db.ts`, `schema.ts` only); reading the pure lifecycle
 *     data is the canonical source of the manifest, not a hidden fallback.
 *   - `../application/scenario-runner.js` — the `ScenarioInstaller` type +
 *     the `InstalledScenario` / `ScenarioInstallerDeps` ports.
 *
 * It imports NO sqlite adapter, NO `db.ts`/`schema.ts`, NO `modules/*`
 * implementation, NO composition root, NO compatibility entry point. The four
 * production module selectors are pure data derived from the lifecycle's
 * stage `moduleRef`s; no module-name switching (Rule 4) is introduced.
 *
 * # Purity / serializability
 *
 * The exported manifest is plain JSON-serializable data (it is derived from
 * the frozen `productDeliveryLifecycle`, which is already canonically
 * serializable). The manifest is eager-validated at module load by
 * `validateLifecycleScenarioManifest`. The `installProductDeliveryScenario`
 * function is a thin orchestrator over the injected `ScenarioInstaller` — it
 * holds no mutable state and performs no I/O of its own.
 */

import type { LifecycleDefinition } from '../domain/lifecycle.js';
import type { StageBinding } from '../domain/lifecycle.js';
import type { TransitionTarget } from '../domain/lifecycle.js';
import type { LifecycleScenarioManifest } from '../domain/spi/scenario-manifest.js';
import type { ScenarioStageBinding } from '../domain/spi/scenario-manifest.js';
import type { ModuleSelector } from '../domain/spi/scenario-manifest.js';
import { validateLifecycleScenarioManifest } from '../domain/spi/scenario-manifest.js';
import { CONTRACT_REF_PENDING_DIGEST, type ContractRef } from '../domain/spi/contract-ref.js';
import { productDeliveryLifecycle } from '../lifecycles/product-delivery-lifecycle.js';
import { PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA } from '../lifecycles/product-delivery-lifecycle.js';

// The ScenarioInstaller + the InstalledScenario / deps ports it produces.
// This package drives the installer with the Product Delivery manifest; the
// installer owns compile → resolve → bind → persist.
import { ScenarioInstaller } from '../application/scenario-runner.js';
import type {
  InstalledScenario,
  ScenarioInstallerDeps,
} from '../application/scenario-runner.js';

// ---------------------------------------------------------------------------
// Manifest envelope identity.
//
// The scenario carries its OWN identity (it is the installed package), but the
// `version` is derived from the frozen lifecycle version so a future lifecycle
// bump produces a different manifest identity. The `+permissive` / `+strict`
// suffix encodes the Discovery gate mode (the manifest surface carries no
// executable resolver, so the two gate modes are two distinct manifests).
// ---------------------------------------------------------------------------

/**
 * Schema version of the manifest ENVELOPE itself (independent of any module or
 * lifecycle version). Bumped only when the `LifecycleScenarioManifest` shape
 * changes. The shape is frozen; this is `1`.
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION = '1';

/**
 * carries the lifecycle version so a future lifecycle bump produces a different
 * manifest identity.
 */
const PERMISSIVE_IDENTITY = {
  name: 'product-delivery',
  version: `${productDeliveryLifecycle.identity.version}+permissive`,
  displayName: 'Product Delivery (permissive Discovery gate)',
  description:
    'Product Delivery scenario where every Discovery outcome forwards to Formalization; ' +
    'definition. Every Discovery outcome forwards to Formalization; the ' +
    'strength of the idea is carried by the discovery certificate, not by a ' +
    'routing policy is permissive when discoveryGate is ' +
    "omitted or set to 'permissive'.",
} as const;

/**
 * Distinct identity for the strict scenario. Same stages and mappings as
 * permissive; only the Discovery stage's outcomeRoutes differ (non-go outcomes
 * terminate).
 */
const STRICT_IDENTITY = {
  name: 'product-delivery',
  version: `${productDeliveryLifecycle.identity.version}+strict`,
  displayName: 'Product Delivery (strict Discovery gate)',
  description:
    'Product Delivery scenario with the strict Discovery gate: ' +
    'definition with the strict Discovery gate: non-go Discovery outcomes ' +
    'non-go outcomes terminate the lifecycle with ' +
    "discoveryGate: 'strict'. Use this for regulated / contractual " +
    'environments where Discovery is a real go/no-go gate.',
} as const;

// ---------------------------------------------------------------------------
// static outcomeRoutes tables).
//
// operator set discoveryGate: 'strict'. Permissive mode falls through to the
// static outcomeRoutes (every outcome forwards to Formalization). Strict mode
// terminates non-go outcomes. We encode both statically here.
// ---------------------------------------------------------------------------

/**
 * `outcomeRoutes` keys on the Discovery stage).
 */
const DISCOVERY_OUTCOMES = [
  'go',
  'clarify',
  'reject',
  'failed',
] as const;

/**
 * Terminal status the strict gate assigns to each non-go Discovery outcome.
 * Mirrors `DISCOVERY_GATE_TERMINAL_STATUSES` in `product-delivery-lifecycle.ts`
 * verbatim. Duplicated here as plain data so the manifest is self-describing
 * and does not reach into the lifecycle's private constant.
 */
const STRICT_DISCOVERY_GATE_TERMINALS: Readonly<Record<string, string>> = {
  clarify: 'clarification-required',
  reject: 'rejected',
  failed: 'failed',
};

/**
 * The Discovery stage id in the lifecycle. Captured once so the manifest is
 * robust to a future stage-id rename.
 */
const DISCOVERY_STAGE_ID = 'initial-discovery';
const FORMALIZATION_STAGE_ID = 'solution-formalization';

/**
 * Build the Discovery stage's permissive outcomeRoutes: every outcome forwards
 */
function permissiveDiscoveryRoutes(): Record<string, TransitionTarget> {
  const routes: Record<string, TransitionTarget> = {};
  for (const outcome of DISCOVERY_OUTCOMES) {
    routes[outcome] = { type: 'stage', stageId: FORMALIZATION_STAGE_ID };
  }
  return routes;
}

/**
 * Build the Discovery stage's strict outcomeRoutes: `go` forwards to
 * Formalization; every non-go outcome terminates with the gate's terminal
 */
function strictDiscoveryRoutes(): Record<string, TransitionTarget> {
  const routes: Record<string, TransitionTarget> = {};
  routes.go = { type: 'stage', stageId: FORMALIZATION_STAGE_ID };
  for (const outcome of DISCOVERY_OUTCOMES) {
    if (outcome === 'go') continue;
    const terminal = STRICT_DISCOVERY_GATE_TERMINALS[outcome];
    if (terminal) {
      routes[outcome] = { type: 'terminal', status: terminal };
    } else {
      // which forwards to Formalization. Preserve that behavior.
      routes[outcome] = { type: 'stage', stageId: FORMALIZATION_STAGE_ID };
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Terminal status set.
//
// Every terminal status any stage in the lifecycle can reach, plus the
// strict-gate terminals (which only the strict scenario can actually route to,
// but they are declared here once so both manifests share a complete terminal
// set — declaring a terminal that no route reaches is harmless; missing one
// would be a validation error).
// ---------------------------------------------------------------------------

/**
 * Complete terminal status set across both gate modes. Computed once from the
 * lifecycle definition so the manifest tracks any future terminal additions
 * automatically.
 */
const TERMINAL_STATUSES: readonly string[] = collectTerminalStatuses(
  productDeliveryLifecycle,
  Object.values(STRICT_DISCOVERY_GATE_TERMINALS),
);

// ---------------------------------------------------------------------------
// Module selectors required by the scenario.
//
// The manifest must declare every distinct module contract it depends on
// We derive these from the lifecycle stages' `moduleRef` fields — each
// `ProcessModuleReference { name, version }` becomes a `ModuleSelector`.
// ---------------------------------------------------------------------------

/**
 * Build the canonical `ModuleSelector` for a stage. The version range is
 * `~${version}`: patch upgrades only, no minor/major drift. This matches the
 * freeze guarantee the lifecycle already gives (every stage pins a concrete
 * module identity; the scenario permits only patch-level upgrades against the
 * contract the author validated).
 */
function moduleSelectorFor(stage: StageBinding): ModuleSelector {
  return {
    name: stage.moduleRef.name,
    versionRange: `~${stage.moduleRef.version}`,
  };
}

/**
 * Every distinct module contract the lifecycle depends on. Order matches the
 * stage declaration order (discovery, formalization, development, delivery);
 * duplicates (if any) are de-duped by `name@versionRange`.
 */
const REQUIRED_MODULE_SELECTORS: readonly ModuleSelector[] = (() => {
  const seen = new Set<string>();
  const out: ModuleSelector[] = [];
  for (const stage of productDeliveryLifecycle.stages) {
    const selector = moduleSelectorFor(stage);
    const key = `${selector.name}@${selector.versionRange}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(selector);
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Contract refs.
//
// The manifest type requires `inputContractRef` and `outputContractRef`. The
// `ContractRef` doc prescribes `CONTRACT_REF_PENDING_DIGEST` until concrete
// codecs are registered. The `schemaId`/`version` carry the logical identity
// of the lifecycle input contract.
// ---------------------------------------------------------------------------

const INPUT_CONTRACT_REF: ContractRef = {
  schemaId: PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  version: productDeliveryLifecycle.identity.version,
  digest: CONTRACT_REF_PENDING_DIGEST,
};

/**
 * The lifecycle has no distinct terminal-output contract (terminals carry status
 * strings only, no payload schema). We name the slot explicitly with a
 * placeholder so the manifest type is satisfied.
 */
const OUTPUT_CONTRACT_REF: ContractRef = {
  schemaId: `${PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA}.terminal`,
  version: productDeliveryLifecycle.identity.version,
  digest: CONTRACT_REF_PENDING_DIGEST,
};

// ---------------------------------------------------------------------------
// Budgets and policies.
//
// The lifecycle has no explicit transition/reentry budgets (the orchestrator
// imposes its own loop guard). The manifest surface requires them, so we
// ---------------------------------------------------------------------------

const TRANSITION_BUDGETS = {
  maxTransitions: 32,
} as const;

const REENTRY_BUDGETS = {
  maxReentries: 0,
} as const;

/**
 * Scenario-level policy declarations. The manifest declares the SHAPES only;
 * the runtime binds `kind` to a registered strategy.
 */
const SCENARIO_POLICIES = {
  retry: { kind: 'standard', params: { maxAttempts: 1 } },
  pause: { kind: 'standard' },
  cancellation: { kind: 'standard' },
  escalation: { kind: 'standard' },
} as const;

/**
 * Scenario-level outcomeRoutes. The lifecycle routes every outcome from WITHIN a
 * stage; there is no scenario-level handoff. The manifest surface requires the
 * `outcomeRoutes` slot, so we declare it empty.
 */
const SCENARIO_OUTCOME_ROUTES: Readonly<Record<string, TransitionTarget>> = {};

// ---------------------------------------------------------------------------
// Stage binding wrapping.
// ---------------------------------------------------------------------------

/**
 * Wrap a `StageBinding` into a `ScenarioStageBinding` for the permissive
 * scenario. The base fields are inherited verbatim; only the Discovery stage's
 * `outcomeRoutes` are replaced (with the permissive table).
 */
function wrapStagePermissive(stage: StageBinding): ScenarioStageBinding {
  if (stage.id === DISCOVERY_STAGE_ID) {
    return {
      ...stage,
      outcomeRoutes: permissiveDiscoveryRoutes(),
      moduleSelector: moduleSelectorFor(stage),
    };
  }
  return {
    ...stage,
    moduleSelector: moduleSelectorFor(stage),
  };
}

/**
 * Wrap a `StageBinding` into a `ScenarioStageBinding` for the strict scenario.
 * Identical to the permissive wrap except the Discovery stage's `outcomeRoutes`
 * are replaced with the strict table (non-go outcomes terminate).
 */
function wrapStageStrict(stage: StageBinding): ScenarioStageBinding {
  if (stage.id === DISCOVERY_STAGE_ID) {
    return {
      ...stage,
      outcomeRoutes: strictDiscoveryRoutes(),
      moduleSelector: moduleSelectorFor(stage),
    };
  }
  return {
    ...stage,
    moduleSelector: moduleSelectorFor(stage),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Collect every terminal status reachable from any stage in the lifecycle, plus
 * the extra terminals supplied by the caller (the strict-gate set).
 */
function collectTerminalStatuses(
  definition: LifecycleDefinition,
  extras: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const stage of definition.stages) {
    for (const target of Object.values(stage.outcomeRoutes)) {
      if (target.type === 'terminal' && !seen.has(target.status)) {
        seen.add(target.status);
        out.push(target.status);
      }
    }
  }
  for (const status of extras) {
    if (!seen.has(status)) {
      seen.add(status);
      out.push(status);
    }
  }
  return out;
}

/**
 * Build the manifest's stageBindings for a given gate mode. Pure; called once
 * per manifest construction.
 */
function buildStageBindings(
  definition: LifecycleDefinition,
  mode: 'permissive' | 'strict',
): readonly ScenarioStageBinding[] {
  const wrap = mode === 'permissive' ? wrapStagePermissive : wrapStageStrict;
  return definition.stages.map(wrap);
}

/**
 * Build the full manifest for a gate mode. Pure: produces a new manifest object
 * derived entirely from the frozen lifecycle definition.
 */
function buildManifest(mode: 'permissive' | 'strict'): LifecycleScenarioManifest {
  const identity = mode === 'permissive' ? PERMISSIVE_IDENTITY : STRICT_IDENTITY;
  return {
    manifestFormatVersion: PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION,
    identity,
    inputContractRef: INPUT_CONTRACT_REF,
    outputContractRef: OUTPUT_CONTRACT_REF,
    entryStageId: productDeliveryLifecycle.entryStageId,
    stageBindings: buildStageBindings(productDeliveryLifecycle, mode),
    outcomeRoutes: SCENARIO_OUTCOME_ROUTES,
    inputMappings: {},
    outputMappings: {},
    terminalStatuses: TERMINAL_STATUSES,
    scenarioPolicies: SCENARIO_POLICIES,
    requiredModuleSelectors: REQUIRED_MODULE_SELECTORS,
    transitionBudgets: TRANSITION_BUDGETS,
    reentryBudgets: REENTRY_BUDGETS,
  };
}

// ---------------------------------------------------------------------------
// Public manifest exports.
// ---------------------------------------------------------------------------

/**
 * The installed Product Delivery scenario manifest — the PERMISSIVE Discovery
 * after the cutover.
 *
 * Pure data: derived from the frozen `productDeliveryLifecycle`. No functions,
 * no `routeResolver`. Eager-validated at module load (see below).
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFEST: LifecycleScenarioManifest =
  buildManifest('permissive');

/**
 * The strict-gate variant (regulated environments). Install this manifest via
 * `installProductDeliveryScenario(deps, { discoveryGate: 'strict' })`. Re-exported
 * for operators and tests that need to assert both gate modes are installable.
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT: LifecycleScenarioManifest =
  buildManifest('strict');

/**
 * The four production module contracts the Product Delivery scenario depends
 * on, in stage-declaration order (discovery, formalization, development,
 * delivery). Each is a `ModuleSelector { name; versionRange }` derived from the
 * lifecycle stage `moduleRef` (`~<version>` = patch upgrades only).
 *
 * The `ScenarioInstaller` resolves each selector to an exact installed
 * module identity and writes one `ScenarioModuleLockEntry` per stage.
 *
 * De-duplicated by `name@versionRange`; for Product Delivery each stage binds a
 * distinct module, so all four selectors are present.
 */
export const PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS: readonly ModuleSelector[] =
  PRODUCT_DELIVERY_SCENARIO_MANIFEST.requiredModuleSelectors;

/**
 * Resolve the Product Delivery scenario manifest for a given Discovery gate
 * mode.
 *
 * Pure: returns one of the two frozen manifest constants; allocates nothing.
 */
export function productDeliveryScenarioManifestFor(
  gate: ProductDeliveryDiscoveryGate | undefined,
): LifecycleScenarioManifest {
  return gate === 'strict'
    ? PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT
    : PRODUCT_DELIVERY_SCENARIO_MANIFEST;
}

/**
 * The two Product Delivery manifests keyed by gate mode, for callers that need
 * to iterate both (e.g. a cutover audit that installs permissive + strict to
 * prove both gate modes are installable through the scenario surface).
 */
export const PRODUCT_DELIVERY_SCENARIO_MANIFESTS: Readonly<
  Record<ProductDeliveryDiscoveryGate, LifecycleScenarioManifest>
> = {
  permissive: PRODUCT_DELIVERY_SCENARIO_MANIFEST,
  strict: PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT,
};

// ---------------------------------------------------------------------------
// Discovery gate selection.
//
// `routeResolver`, so the two gate modes are two distinct manifests.
// The operator/installer picks one at scenario-install time. The package's
// ---------------------------------------------------------------------------

/**
 * manifest this package installs.
 */
export type ProductDeliveryDiscoveryGate = 'permissive' | 'strict';

/**
 * Options for {@link installProductDeliveryScenario}.
 *
 * @property discoveryGate Which manifest to install. `'permissive'` (default)
 *                         installs the manifest where every Discovery outcome
 *                         `'strict'` installs the manifest where non-go
 *                         Discovery outcomes terminate (the regulated-
 *                         `discoveryGate` flag.
 */
export interface InstallProductDeliveryScenarioOptions {
  readonly discoveryGate?: ProductDeliveryDiscoveryGate;
}

// ---------------------------------------------------------------------------
// Self-validation (eager).
//
// Both manifests are constructed from the frozen lifecycle definition using a
// pure function. We validate them once at module load so a future lifecycle
// change that produces an invalid manifest fails LOUD at the first import, not
// silently at scenario-install time.
// ---------------------------------------------------------------------------
function assertManifestValid(
  manifest: LifecycleScenarioManifest,
  label: string,
): void {
  const result = validateLifecycleScenarioManifest(manifest);
  if (!result.ok) {
    throw new Error(
      `${label} failed manifest validation at module load: ` +
        result.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    );
  }
}

assertManifestValid(PRODUCT_DELIVERY_SCENARIO_MANIFEST, 'PRODUCT_DELIVERY_SCENARIO_MANIFEST');
assertManifestValid(PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT, 'PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT');

// ---------------------------------------------------------------------------
// Install entry point.
//
// `installProductDeliveryScenario` is the single install-time entry point for
// the Product Delivery scenario package. It selects the manifest for the
// requested gate mode and drives the `ScenarioInstaller` with the injected
// ports. The installer performs the full pipeline:
//   1. compile/validate the manifest (compiler port);
//   2. resolve every ModuleSelector to an exact installed module identity +
//      produce the ScenarioModuleLock (lock-resolver port);
//   3. bind each resolved module ref to its ProcessModuleInstallation
//      (ProcessModuleInstallationRegistry port);
//   4. persist the lock (lock-store port);
//   5. return the InstalledScenario (manifest snapshot + hash + lock + per-stage
//      installation binding).
//
// All four ports are INJECTED: this package owns no storage, no sqlite, no
// module implementation. The composition root (composition loader) wires the
// concrete sqlite-backed ports; tests inject fakes.
// ---------------------------------------------------------------------------

/**
 * Injected dependencies for {@link installProductDeliveryScenario}. This is the
 * `ScenarioInstallerDeps` surface unchanged: every collaborator is a
 * port the composition root wires (compiler, lockResolver, lockStore,
 * installationRegistry). Re-exported under the package's own name so consumers
 * import the dep bundle from the installable package.
 */
export type ProductDeliveryScenarioInstallerDeps = ScenarioInstallerDeps;

/**
 * Install the Product Delivery scenario as a frozen, lock-pinned
 * {@link InstalledScenario} via the `ScenarioInstaller`.
 *
 * Selects the manifest for `options.discoveryGate` (default `'permissive'` =
 * compiles the manifest, resolves the four production module selectors to exact
 * installed identities, writes the scenario module lock (one pin per stage),
 * binds each stage to its `ProcessModuleInstallation`, and returns the
 * `InstalledScenario` the cutover routes new runs through.
 *
 * @param deps   The installer ports (compiler, lockResolver, lockStore,
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
 * Delivery scenario.
 */
export async function installProductDeliveryScenarioPermissive(
  deps: ProductDeliveryScenarioInstallerDeps,
): Promise<InstalledScenario> {
  return installProductDeliveryScenario(deps, { discoveryGate: 'permissive' });
}

/**
 * Stateless convenience: install the STRICT (regulated) Product Delivery
 * scenario. Use for contractual environments where Discovery is a real go/no-go
 * gate (non-go outcomes terminate).
 */
export async function installProductDeliveryScenarioStrict(
  deps: ProductDeliveryScenarioInstallerDeps,
): Promise<InstalledScenario> {
  return installProductDeliveryScenario(deps, { discoveryGate: 'strict' });
}
