/**
 * W7-A8 — Legacy Product Delivery scenario adapter (compatibility bridge).
 *
 * Spec: docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md lane A8.
 * Plan: §0.10 / Phase 8. Frozen input: `174a757`.
 *
 * ## Role after the W11 cutover ratchet
 *
 * This file is the LEGACY COMPATIBILITY ENTRY POINT for the Product Delivery
 * scenario manifest. It exists so consumers that pre-date the Wave 11 installed
 * scenario package (and the Wave 13 removal target) can keep importing the
 * manifest under its historical `LEGACY_*` names. It is the surface Wave 13
 * removes once the retention policy proves no supported run needs it
 * (WAVE11-CUTOVER-SPEC.md §4 gate 4; plan §14.14.3/§14.16).
 *
 * The CANONICAL manifest producer is now the installed scenario package at
 * `../installation/product-delivery-scenario-package.ts` (W11-A1). That package
 * owns the manifest construction (it builds the manifest directly from the
 * frozen `productDeliveryLifecycle` definition). This adapter DELEGATES to it:
 * it re-exports the manifests under the legacy names and provides the
 * lookup/validation helpers legacy consumers expect. It does NOT duplicate the
 * manifest construction — doing so would risk divergence between the legacy and
 * installed surfaces.
 *
 * ## Why this file still imports the lifecycle (definition-of-done edge)
 *
 * `tests/execution/definition-of-done.test.mjs` (§18.3, Wave-12 checkpoint)
 * pins `legacy-scenario-adapter.ts -> lifecycles/product-delivery-lifecycle.ts`
 * as a DOCUMENTED gap (R3: W13-A3 removes when the legacy adapter retires). The
 * edge is preserved here intentionally: this adapter is the compatibility
 * bridge FROM the legacy lifecycle definition, so it references the lifecycle
 * directly (for the schema constant re-export below) even though the manifest
 * bytes now come from the installed package. When W13-A3 retires this adapter,
 * both the file and this edge disappear together.
 *
 * ## New-core must NOT import this file
 *
 * The cutover ratchet (`tests/architecture/cutover-architecture-checks.test.mjs`
 * rules 1 + "no new-core file imports a compatibility entry point") forbids
 * new-core files from importing this compatibility surface: new runs route
 * through INSTALLED scenarios, not the legacy bridge. New-core consumers
 * (composition loader, CLI scenario adapter, the scenario package itself) import
 * `../installation/product-delivery-scenario-package.ts` instead.
 */

// Re-export the manifest envelope format version + the manifests under the
// legacy names. The identity constants are derived from the manifests so they
// stay in lockstep with the installed package's identities.
import type { LifecycleScenarioManifest } from '../domain/spi/scenario-manifest.js';
import { validateLifecycleScenarioManifest } from '../domain/spi/scenario-manifest.js';

// The canonical installed scenario package (W11-A1) owns construction. This
// adapter re-exports its manifests under the legacy names. Note this is a
// COMPATIBILITY entry point IMPORTING a new-core file — the allowed direction
// (new-core is the canonical inner; compatibility is the outer bridge). The
// reverse (new-core importing this adapter) is the hidden fallback the cutover
// ratchet forbids.
import {
  PRODUCT_DELIVERY_SCENARIO_MANIFEST,
  PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT,
  PRODUCT_DELIVERY_SCENARIO_MANIFESTS,
  productDeliveryScenarioManifestFor,
  PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION,
} from '../installation/product-delivery-scenario-package.js';

// Preserved lifecycle import — see "Why this file still imports the lifecycle"
// above. Keeps the documented Wave-12 definition-of-done edge alive and re-
// exports the schema constant legacy consumers may reference.
import { PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA } from '../lifecycles/product-delivery-lifecycle.js';

// ---------------------------------------------------------------------------
// Legacy manifest format version.
// ---------------------------------------------------------------------------

/**
 * Schema version of the manifest ENVELOPE itself. Re-exported from the
 * installed package under the legacy name so existing consumers are unaffected.
 */
export const LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION: string =
  PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION;

// ---------------------------------------------------------------------------
// Legacy manifest identities.
//
// Derived from the installed manifests so a future lifecycle version bump
// changes both surfaces in lockstep.
// ---------------------------------------------------------------------------

/**
 * Distinct identity for the permissive legacy scenario (legacy default).
 * Re-exported from the installed package's permissive manifest identity.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY = {
  name: PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.name,
  version: PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.version,
  displayName: PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.displayName,
  description: PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.description,
} as const;

/**
 * Distinct identity for the strict legacy scenario. Re-exported from the
 * installed package's strict manifest identity.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY = {
  name: PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT.identity.name,
  version: PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT.identity.version,
  displayName: PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT.identity.displayName,
  description: PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT.identity.description,
} as const;

// ---------------------------------------------------------------------------
// Legacy manifest constants.
//
// These ARE the installed package's manifests, re-exported under the legacy
// names. Reference equality with the installed constants holds (same object).
// ---------------------------------------------------------------------------

/**
 * Legacy Product Delivery scenario manifest, PERMISSIVE Discovery gate. This is
 * the manifest under its historical `LEGACY_*` name; the canonical producer is
 * `PRODUCT_DELIVERY_SCENARIO_MANIFEST` in the installed scenario package.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE: LifecycleScenarioManifest =
  PRODUCT_DELIVERY_SCENARIO_MANIFEST;

/**
 * Legacy Product Delivery scenario manifest, STRICT Discovery gate. Non-go
 * Discovery outcomes terminate the lifecycle (legacy regulated-environment
 * behavior).
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT: LifecycleScenarioManifest =
  PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT;

/**
 * The two legacy compatibility manifests, keyed by the legacy `discoveryGate`
 * flag value. Provided as a lookup so the installer can resolve a legacy run's
 * `discoveryGate` flag to the correct manifest in one step.
 */
export const LEGACY_PRODUCT_DELIVERY_SCENARIOS: Readonly<
  Record<'permissive' | 'strict', LifecycleScenarioManifest>
> = PRODUCT_DELIVERY_SCENARIO_MANIFESTS as Readonly<
  Record<'permissive' | 'strict', LifecycleScenarioManifest>
>;

// ---------------------------------------------------------------------------
// Adapter function (the explicit "wrap" API).
// ---------------------------------------------------------------------------

/**
 * Resolve the legacy compatibility manifest for a given Discovery gate mode.
 *
 * `gate` accepts `'permissive' | 'strict'` (the two values the legacy
 * `discoveryGate` field can take). Passing `undefined` returns the permissive
 * manifest, matching the legacy default.
 *
 * Delegates to the installed package's `productDeliveryScenarioManifestFor`;
 * kept under the legacy name so legacy callers are unaffected by the cutover.
 *
 * Pure: returns one of the two frozen manifest constants; allocates nothing.
 */
export function legacyProductDeliveryScenarioFor(
  gate: 'permissive' | 'strict' | undefined,
): LifecycleScenarioManifest {
  return productDeliveryScenarioManifestFor(gate);
}

// ---------------------------------------------------------------------------
// Self-validation (eager).
//
// Both manifests come from the installed package (which validates them at its
// own module load). We re-validate defensively here so a corrupted re-export
// (e.g. a future refactor that breaks the aliasing) fails LOUD at the first
// import of this compatibility surface, not silently downstream.
// ---------------------------------------------------------------------------

/**
 * Validate that a legacy compatibility manifest is well-formed. Returns the
 * raw `ValidationResult` from `validateLifecycleScenarioManifest`. Pure.
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

// Re-export the lifecycle input schema constant under the legacy surface for
// any consumer that historically imported it from this adapter. Keeps the
// lifecycle import meaningful (not just a type-only edge) and preserves the
// documented definition-of-done edge.
export { PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA };
