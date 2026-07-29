/**
 * W7-A8 — Legacy Product Delivery scenario adapter (compatibility bridge).
 *
 * Spec: docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md lane A8.
 * Plan: §0.10 / Phase 8. Frozen input: `174a757`.
 *
 * This file is the explicit, route-resolver-free `LifecycleScenarioManifest`
 * view of the existing legacy `productDeliveryLifecycle` definition (the
 * `LifecycleDefinition` aggregate owned by
 * `../lifecycles/product-delivery-lifecycle.ts`). Wave 7's new scenario
 * runtime consumes manifests; this adapter lets every legacy Product Delivery
 * run keep working — through the manifest surface — without rewriting the
 * orchestrator (Wave 11 cutover) or removing `routeResolver` (Wave 13).
 *
 * What the adapter does:
 *   1. Wraps every legacy `StageBinding` into a `ScenarioStageBinding` by
 *      deriving a `ModuleSelector { name, versionRange }` from the stage's
 *      existing `moduleRef { name, version }`. The selector pins the exact
 *      contract version the legacy definition validated against; the patch
 *      range `~version` allows patch upgrades only (no minor/major drift),
 *      matching the freeze guarantee the legacy lifecycle already gives.
 *   2. Flattens every `outcomeRoutes` terminal status into the manifest's
 *      `terminalStatuses` set (declared once, statically).
 *   3. Encodes the legacy per-run `discoveryGate` flag statically. The legacy
 *      lifecycle uses a NON-enumerable `routeResolver` to vary Discovery
 *      routing per run (permissive default vs strict). The manifest surface is
 *      structurally incapable of carrying a resolver (plan §6.4), so the
 *      adapter emits TWO manifests — PERMISSIVE (legacy default) and STRICT —
 *      and the operator/installer picks one at scenario-install time. This is
 *      the explicit, declarative equivalent of the legacy resolver: no hidden
 *      executable routing, every route in a static table.
 *   4. Provides scenario-level defaults the legacy definition did not need to
 *      name: transition/reentry budgets, policy declarations (Wave 7 stubs),
 *      input/output ContractRefs (Wave 1 placeholders — no production schemas
 *      are registered until Wave 2/3, so we use CONTRACT_REF_PENDING_DIGEST,
 *      exactly as the manifest type doc prescribes).
 *
 * What the adapter does NOT do:
 *   - It does NOT import any module implementation. It reads only the pure
 *     `productDeliveryLifecycle` data and the shared manifest domain types.
 *     Rule 3 of the dependency-direction ratchet (lifecycle scenario files
 *     must not import module implementations) is therefore preserved: the
 *     adapter lives in `application/`, the legacy lifecycle's own module
 *     imports remain the only Rule 3 edges and stay allowlisted against Phase
 *     8/9.
 *   - It does NOT mutate the legacy definition. The legacy lifecycle keeps its
 *     `routeResolver`; this adapter is read-only and pure.
 *   - It does NOT execute anything. Producing a manifest is pure data
 *     construction; the Wave 7 ScenarioRunner (W7-A6) consumes it.
 *
 * Purity: the adapter output is plain JSON-serializable data. The legacy
 * definition carries a non-enumerable `routeResolver` function; this adapter
 * ignores it entirely (the two static manifests encode the resolver's two
 * observable behaviors), so the produced manifests are canonical-serializable
 * and pass `validateLifecycleScenarioManifest`.
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

// ---------------------------------------------------------------------------
// Manifest envelope identity.
// ---------------------------------------------------------------------------

/**
 * Schema version of the manifest ENVELOPE itself (independent of any module or
 * lifecycle version). Bumped only when the `LifecycleScenarioManifest` shape
 * changes. Wave 1 froze the shape; this is `1`.
 */
export const LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION = '1';

/**
 * Distinct identity for the permissive legacy scenario (legacy default). The
 * `version` carries the legacy lifecycle version so a future legacy lifecycle
 * bump produces a different manifest identity.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY = {
  name: 'legacy-product-delivery',
  version: `${productDeliveryLifecycle.identity.version}+permissive`,
  displayName: 'Legacy Product Delivery (permissive Discovery gate)',
  description:
    'Compatibility scenario wrapping the legacy productDeliveryLifecycle ' +
    'definition. Every Discovery outcome forwards to Formalization; the ' +
    'strength of the idea is carried by the discovery certificate, not by a ' +
    'routing gate. Equivalent to the legacy lifecycle with discoveryGate ' +
    "omitted or set to 'permissive'.",
} as const;

/**
 * Distinct identity for the strict legacy scenario. Same stages and mappings
 * as permissive; only the Discovery stage's outcomeRoutes differ (non-go
 * outcomes terminate).
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY = {
  name: 'legacy-product-delivery',
  version: `${productDeliveryLifecycle.identity.version}+strict`,
  displayName: 'Legacy Product Delivery (strict Discovery gate)',
  description:
    'Compatibility scenario wrapping the legacy productDeliveryLifecycle ' +
    'definition with the strict Discovery gate: non-go Discovery outcomes ' +
    'terminate the lifecycle. Equivalent to the legacy lifecycle with ' +
    "discoveryGate: 'strict'. Use this for regulated / contractual " +
    'environments where Discovery is a real go/no-go gate.',
} as const;

// ---------------------------------------------------------------------------
// Discovery gate routing (legacy `resolveProductDeliveryRoute` translated to
// static outcomeRoutes tables).
//
// The legacy resolver only overrides non-go Discovery outcomes when the
// operator set discoveryGate: 'strict'. Permissive mode falls through to the
// static outcomeRoutes (every outcome forwards to Formalization). Strict mode
// terminates non-go outcomes. We encode both statically here.
// ---------------------------------------------------------------------------

/**
 * Discovery outcomes the legacy lifecycle knows how to forward (the union of
 * `outcomeRoutes` keys on the Discovery stage).
 */
const DISCOVERY_OUTCOMES = [
  'go',
  'clarify',
  'reject',
  'defer',
  'inconclusive',
  'failed',
] as const;

/**
 * Terminal status the strict gate assigns to each non-go Discovery outcome.
 * Mirrors `DISCOVERY_GATE_TERMINAL_STATUSES` in
 * `product-delivery-lifecycle.ts` verbatim. Duplicated here as plain data so
 * the adapter does not reach into the legacy lifecycle's private constant and
 * so the manifest is self-describing.
 */
const STRICT_DISCOVERY_GATE_TERMINALS: Readonly<Record<string, string>> = {
  clarify: 'clarification-required',
  reject: 'rejected',
  defer: 'deferred',
  inconclusive: 'inconclusive',
  failed: 'failed',
};

/**
 * The Discovery stage id in the legacy lifecycle. Captured once so the
 * adapter is robust to a future stage-id rename (the rename would also have
 * to update the legacy definition's own `outcomeRoutes` targets).
 */
const DISCOVERY_STAGE_ID = 'initial-discovery';
const FORMALIZATION_STAGE_ID = 'solution-formalization';

/**
 * Build the Discovery stage's permissive outcomeRoutes: every outcome
 * forwards to Formalization. Identical to the legacy static table.
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
 * status. Equivalent to the legacy resolver's strict-mode branch.
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
      // Unknown outcome: legacy resolver falls through to the static table,
      // which forwards to Formalization. Preserve that behavior.
      routes[outcome] = { type: 'stage', stageId: FORMALIZATION_STAGE_ID };
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Terminal status set.
//
// Every terminal status any stage in the legacy lifecycle can reach, plus the
// strict-gate terminals (which only the strict scenario can actually route
// to, but they are declared here once so both manifests share a complete
// terminal set — declaring a terminal that no route reaches is harmless;
// missing one would be a validation error).
// ---------------------------------------------------------------------------

/**
 * Complete terminal status set across both gate modes. Computed once from the
 * legacy definition so the adapter tracks any future terminal additions
 * automatically.
 */
const LEGACY_TERMINAL_STATUSES: readonly string[] = collectTerminalStatuses(
  productDeliveryLifecycle,
  Object.values(STRICT_DISCOVERY_GATE_TERMINALS),
);

// ---------------------------------------------------------------------------
// Module selectors required by the scenario.
//
// The manifest must declare every distinct module contract it depends on
// (plan §6.10). We derive these from the legacy stages' `moduleRef` fields —
// each `ProcessModuleReference { name, version }` becomes a `ModuleSelector`.
// ---------------------------------------------------------------------------

/**
 * Build the canonical `ModuleSelector` for a legacy stage. The version range
 * is `~${version}`: patch upgrades only, no minor/major drift. This matches
 * the freeze guarantee the legacy lifecycle already gives (every stage pins a
 * concrete module identity; the scenario permits only patch-level upgrades
 * against the contract the author validated).
 */
function moduleSelectorFor(stage: StageBinding): ModuleSelector {
  return {
    name: stage.moduleRef.name,
    versionRange: `~${stage.moduleRef.version}`,
  };
}

/**
 * Every distinct module contract the legacy lifecycle depends on. Order
 * matches the stage declaration order in the legacy definition (discovery,
 * formalization, development, delivery); duplicates (if any) are de-duped by
 * `name@versionRange`.
 */
const LEGACY_REQUIRED_MODULE_SELECTORS: readonly ModuleSelector[] = (() => {
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
// Contract refs (Wave 1 placeholders).
//
// The manifest type requires `inputContractRef` and `outputContractRef`. Wave
// 1 deliberately registers NO production schemas (Wave 2/3 do that); the
// `ContractRef` doc prescribes `CONTRACT_REF_PENDING_DIGEST` for exactly this
// case. The `schemaId`/`version` still carry the logical identity of the
// legacy lifecycle input contract, so Wave 2/3 can replace the placeholder
// digest with the real computed digest without touching the identity.
// ---------------------------------------------------------------------------

const LEGACY_INPUT_CONTRACT_REF: ContractRef = {
  schemaId: PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  version: productDeliveryLifecycle.identity.version,
  digest: CONTRACT_REF_PENDING_DIGEST,
};

/**
 * The legacy lifecycle has no distinct terminal-output contract (terminals
 * carry status strings only, no payload schema). We name the slot explicitly
 * with a placeholder so the manifest type is satisfied and Wave 2/3 can fill
 * in a real contract if/when terminals gain payload schemas.
 */
const LEGACY_OUTPUT_CONTRACT_REF: ContractRef = {
  schemaId: `${PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA}.terminal`,
  version: productDeliveryLifecycle.identity.version,
  digest: CONTRACT_REF_PENDING_DIGEST,
};

// ---------------------------------------------------------------------------
// Budgets and policies.
//
// The legacy lifecycle has no explicit transition/reentry budgets (the
// orchestrator imposes its own loop guard). The manifest surface requires
// them, so we declare conservative defaults that match the legacy behavior:
//   - maxTransitions: a single pass through 4 stages is 3 transitions
//       (discovery -> formalization -> development -> delivery). We allow
//       generous headroom (32) to absorb any future loop-aware stage without
//       artificially terminating a legitimate run; the legacy orchestrator
//       loop guard already protects against infinite ping-pong.
//   - maxReentries: 0 - the legacy lifecycle never re-enters a stage (every
//       outcome is forward-or-terminal; there are no back-edges). Declaring 0
//       makes that contract explicit on the manifest surface.
// ---------------------------------------------------------------------------

const LEGACY_TRANSITION_BUDGETS = {
  maxTransitions: 32,
} as const;

const LEGACY_REENTRY_BUDGETS = {
  maxReentries: 0,
} as const;

/**
 * Scenario-level policy declarations. Wave 1 declares the SHAPES only; Wave 7
 * binds `kind` to a registered strategy. The legacy lifecycle had no
 * scenario-level retry/pause/cancellation/escalation policy (the orchestrator
 * handled retries at the node level); we declare the slots with the default
 * `kind: 'legacy'` so the manifest names them explicitly and Wave 7 can swap
 * in a typed strategy without changing the manifest shape.
 */
const LEGACY_SCENARIO_POLICIES = {
  retry: { kind: 'legacy', params: { maxAttempts: 1 } },
  pause: { kind: 'legacy' },
  cancellation: { kind: 'legacy' },
  escalation: { kind: 'legacy' },
} as const;

// ---------------------------------------------------------------------------
// Scenario-level outcomeRoutes.
//
// The legacy lifecycle routes every outcome from WITHIN a stage; there is no
// scenario-level handoff (the scenario's terminal productions ARE the
// terminal statuses reached from a stage). The manifest surface requires the
// `outcomeRoutes` slot, so we declare it empty: every terminal is reached via
// a stage outcomeRoute, and there is no scenario-root outcome that needs its
// own route. The manifest validator accepts an empty `outcomeRoutes` object.
// ---------------------------------------------------------------------------

const LEGACY_SCENARIO_OUTCOME_ROUTES: Readonly<Record<string, TransitionTarget>> = {};

// ---------------------------------------------------------------------------
// Stage binding wrapping.
// ---------------------------------------------------------------------------

/**
 * Wrap a legacy `StageBinding` into a `ScenarioStageBinding` for the
 * permissive scenario. The base fields are inherited verbatim; only the
 * Discovery stage's `outcomeRoutes` are replaced (with the permissive table
 * that is functionally identical to the legacy static table, but produced
 * here so the manifest is self-describing and does not depend on the legacy
 * definition's mutable internal order).
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
 * Wrap a legacy `StageBinding` into a `ScenarioStageBinding` for the strict
 * scenario. Identical to the permissive wrap except the Discovery stage's
 * `outcomeRoutes` are replaced with the strict table (non-go outcomes
 * terminate).
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
 * Collect every terminal status reachable from any stage in the lifecycle,
 * plus the extra terminals supplied by the caller (the strict-gate set). The
 * result is the manifest's declared `terminalStatuses` array. Order is
 * stable: stage-declaration order first, then caller-supplied extras in their
 * original order, with duplicates removed.
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

// ---------------------------------------------------------------------------
// Public manifest exports.
// ---------------------------------------------------------------------------

/**
 * Legacy Product Delivery scenario manifest, PERMISSIVE Discovery gate.
 *
 * This is the static, route-resolver-free equivalent of the legacy
 * `productDeliveryLifecycle` with `discoveryGate: 'permissive'` (the legacy
 * default). Every Discovery outcome forwards to Formalization; the strength
 * of the idea is carried by the discovery certificate, not by a routing gate.
 *
 * Use this manifest when you want the legacy default behavior through the new
 * Wave 7 scenario runtime.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE: LifecycleScenarioManifest = {
  manifestFormatVersion: LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION,
  identity: LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY,
  inputContractRef: LEGACY_INPUT_CONTRACT_REF,
  outputContractRef: LEGACY_OUTPUT_CONTRACT_REF,
  entryStageId: productDeliveryLifecycle.entryStageId,
  stageBindings: buildStageBindings(productDeliveryLifecycle, 'permissive'),
  outcomeRoutes: LEGACY_SCENARIO_OUTCOME_ROUTES,
  inputMappings: {},
  outputMappings: {},
  terminalStatuses: LEGACY_TERMINAL_STATUSES,
  scenarioPolicies: LEGACY_SCENARIO_POLICIES,
  requiredModuleSelectors: LEGACY_REQUIRED_MODULE_SELECTORS,
  transitionBudgets: LEGACY_TRANSITION_BUDGETS,
  reentryBudgets: LEGACY_REENTRY_BUDGETS,
};

/**
 * Legacy Product Delivery scenario manifest, STRICT Discovery gate.
 *
 * This is the static, route-resolver-free equivalent of the legacy
 * `productDeliveryLifecycle` with `discoveryGate: 'strict'`. Non-go Discovery
 * outcomes terminate the lifecycle (legacy regulated-environment behavior).
 *
 * Use this manifest when you want the legacy strict-gate behavior through the
 * new Wave 7 scenario runtime.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT: LifecycleScenarioManifest = {
  manifestFormatVersion: LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION,
  identity: LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY,
  inputContractRef: LEGACY_INPUT_CONTRACT_REF,
  outputContractRef: LEGACY_OUTPUT_CONTRACT_REF,
  entryStageId: productDeliveryLifecycle.entryStageId,
  stageBindings: buildStageBindings(productDeliveryLifecycle, 'strict'),
  outcomeRoutes: LEGACY_SCENARIO_OUTCOME_ROUTES,
  inputMappings: {},
  outputMappings: {},
  terminalStatuses: LEGACY_TERMINAL_STATUSES,
  scenarioPolicies: LEGACY_SCENARIO_POLICIES,
  requiredModuleSelectors: LEGACY_REQUIRED_MODULE_SELECTORS,
  transitionBudgets: LEGACY_TRANSITION_BUDGETS,
  reentryBudgets: LEGACY_REENTRY_BUDGETS,
};

// ---------------------------------------------------------------------------
// Adapter function (the explicit "wrap" API).
// ---------------------------------------------------------------------------

/**
 * The two legacy compatibility manifests, keyed by the legacy `discoveryGate`
 * flag value. `LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE` is the default
 * (legacy `discoveryGate` omitted or `'permissive'`);
 * `LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT` is the regulated-environment
 * variant (legacy `discoveryGate: 'strict'`).
 *
 * Provided as a lookup so the Wave 7 installer can resolve a legacy run's
 * `discoveryGate` flag to the correct manifest in one step, without switching
 * on names/strings at the call site.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIOS: Readonly<
  Record<'permissive' | 'strict', LifecycleScenarioManifest>
> = {
  permissive: LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  strict: LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
};

/**
 * Resolve the legacy compatibility manifest for a given Discovery gate mode.
 *
 * `gate` accepts `'permissive' | 'strict'` (the two values the legacy
 * `discoveryGate` field can take). Passing `undefined` returns the permissive
 * manifest, matching the legacy default.
 *
 * Pure: returns one of the two frozen manifest constants; allocates nothing.
 */
export function legacyProductDeliveryScenarioFor(
  gate: 'permissive' | 'strict' | undefined,
): LifecycleScenarioManifest {
  return gate === 'strict'
    ? LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT
    : LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE;
}

// ---------------------------------------------------------------------------
// Self-validation (eager).
//
// Both manifests are constructed from a frozen legacy definition using a pure
// function. We validate them once at module load so a future legacy lifecycle
// change that produces an invalid manifest fails LOUD at the first import,
// not silently at scenario-install time. The validation result is also
// exposed for tests and for callers that prefer to re-validate defensively.
// ---------------------------------------------------------------------------

/**
 * Validate that a legacy compatibility manifest is well-formed. Returns the
 * raw `ValidationResult` from `validateLifecycleScenarioManifest`. Pure.
 *
 * Exposed so the Wave 7 installer can re-validate a manifest defensively
 * before persisting it (the manifest is plain data; a corrupted copy should
 * never be installed even if this module's eager check passed).
 */
export function validateLegacyProductDeliveryScenario(
  manifest: LifecycleScenarioManifest,
): { ok: boolean; errors: readonly { readonly code: string; readonly path: string; readonly message: string }[] } {
  return validateLifecycleScenarioManifest(manifest);
}

const PERMISSIVE_VALIDATION = validateLegacyProductDeliveryScenario(
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
);
const STRICT_VALIDATION = validateLegacyProductDeliveryScenario(
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
);

if (!PERMISSIVE_VALIDATION.ok) {
  throw new Error(
    'LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE failed manifest validation at module load: ' +
      PERMISSIVE_VALIDATION.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}
if (!STRICT_VALIDATION.ok) {
  throw new Error(
    'LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT failed manifest validation at module load: ' +
      STRICT_VALIDATION.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
  );
}
