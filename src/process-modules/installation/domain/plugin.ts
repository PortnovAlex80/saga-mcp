/**
 * W2-A6 — ProcessModulePlugin: the composition-root-facing binding contract.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
 *       §1 row 11, §2 ports-vs-adapters table.
 * Plan: §14.4.3 (plugin binding), §5.1.3 (InstalledProcessModule value object).
 * Task: docs/refactor-management/05-subagent-tasks/W02-A6-registries-plugin-binding.md
 *
 * A `ProcessModulePlugin` is the runtime binding contract the composition root
 * receives from a module author at startup. It links the immutable
 * `ModuleInstallationRecord` (W2-A2 — the persisted identity of WHAT is
 * installed) to the live, runtime CALLABLES the module ships (handler
 * factories, adapter factories, capability providers). The plugin object
 * itself is a runtime binding — it is never persisted (its fields are
 * functions), but its shape is stable so the composition root can hand it to
 * `bindInstallation(record, plugin, registries)` (installation-binding.ts).
 *
 * ── Anti-scope reminder ────────────────────────────────────────────────────
 *
 * This file defines the SHAPE only. It does NOT implement any concrete plugin
 * (production plugins ship with their modules, registered by the composition
 * root at startup) and it does NOT wire anything into the live execution path
 * (composition-root cutover is Wave 11, plan §16.9).
 *
 * ── Dependency direction (Rule 5 ratchet) ──────────────────────────────────
 *
 * This file lives under `installation/domain/`. It imports ONLY from a sibling
 * `installation/domain/*.ts` file (registries.ts) and the Wave 1 SPI barrel
 * (`domain/spi/index.js`). No imports from `application/`, `persistence/`,
 * `composition/`, `modules/`, or `infrastructure/`. Rule 5 clean.
 */

import type { CapabilityRequirement } from '../../domain/spi/index.js';
import type {
  HandlerFactory,
  HandlerActivationContext,
} from './registries.js';

// Re-export so consumers can import the binding-relevant runtime types from a
// single surface (plugin.ts) without reaching back into registries.ts.
export type { HandlerFactory, HandlerActivationContext };

// ---------------------------------------------------------------------------
// Adapter factory shape (opaque).
// ---------------------------------------------------------------------------

/**
 * Factory that produces a runtime adapter instance for a named adapter slot
 * declared by the module (e.g. a persistence adapter, an external API client,
 * a transport shim). Opaque at this layer: the consuming executor narrows the
 * signature. The plugin carries adapter factories keyed by a stable adapter
 * name the module author chooses; the composition root knows how to wire each
 * named slot.
 *
 * The slot name space is module-local: two modules MAY use the same adapter
 * slot name without colliding because each plugin's `adapterFactories` is
 * scoped to that plugin's installation record.
 */
export type AdapterFactory<Ctx = unknown> = (ctx: Ctx) => unknown;

/**
 * Map of adapter slot name → adapter factory. Readonly: the plugin's
 * `adapterFactories` is frozen by the module author at plugin construction
 * time. The composition root reads it; it never mutates it.
 */
export type AdapterFactoryMap = Readonly<Record<string, AdapterFactory>>;

// ---------------------------------------------------------------------------
// Capability provider binding.
// ---------------------------------------------------------------------------

/**
 * Binds a declared `CapabilityRequirement` to the runtime provider that
 * satisfies it. The provider shape is opaque at this layer (an MCP server
 * client, a saga3 service port, ...); the consuming capability registry
 * stores it verbatim under the requirement's `(ref, version)` key.
 */
export interface CapabilityProviderBinding {
  readonly ref: CapabilityRequirement;
  readonly provider: unknown;
}

// ---------------------------------------------------------------------------
// ProcessModulePlugin.
// ---------------------------------------------------------------------------

/**
 * Re-export `ModuleInstallationId` here so consumers have a single import
 * surface for the plugin's identity reference. `ModuleInstallationId` is owned
 * by W2-A2 (`installation/domain/installation.ts`); when that file lands at
 * integration time, the type-only re-export below resolves to it. Until then,
 * this isolated worktree defines a minimal local alias (number-brand) so this
 * file type-checks in isolation. The shape is byte-identical to W2-A2's
 * definition per spec §1 row 3 ("branded string/number").
 *
 * NOTE (integrator): when cherry-picking into the integration worktree, delete
 * the local `ModuleInstallationId` alias below and re-export from
 * `./installation.js`. The plugin shape does NOT change.
 */

// Local isolation alias — see NOTE above. Removed at integration time.
export type ModuleInstallationId = number & { readonly __brand: 'ModuleInstallationId' };

/**
 * The composition-root-facing binding contract (plan §14.4.3).
 *
 * A plugin is constructed ONCE per installed module at startup, handed to the
 * composition root, and consumed by `bindInstallation(record, plugin, registries)`
 * to produce an `InstalledProcessModule` value object. The plugin is a pure
 * shape: it carries runtime functions (the factories), but the plugin object
 * itself is just data — it is not a singleton, not a class instance, and not
 * persisted.
 *
 * @property installationId       Identity of the installation record this
 *                                plugin binds. MUST match
 *                                `ModuleInstallationRecord.id` for the record
 *                                the composition root pairs this plugin with.
 *                                `bindInstallation` checks this.
 * @property handlerFactories     Map of handler logicalId → `HandlerFactory`.
 *                                Every key MUST match a
 *                                `record.handlerRefs[].logicalId` declared on
 *                                the manifest; `bindInstallation` rejects
 *                                extra keys (factories the manifest does not
 *                                declare) and missing keys (manifest-declared
 *                                handlers with no factory) with
 *                                `INSTALLATION_BINDING_INCOMPLETE`.
 * @property adapterFactories     Optional map of adapter slot name →
 *                                `AdapterFactory`. Pure metadata at this layer;
 *                                the composition root wires each named slot.
 * @property capabilityProviders  Optional list of `CapabilityProviderBinding`.
 *                                Each binding's `ref` MUST match a
 *                                `record.manifestSnapshot.capabilityRequirements[]`
 *                                entry (the composition root enforces this
 *                                when activating the plugin).
 */
export interface ProcessModulePlugin {
  readonly installationId: ModuleInstallationId;
  readonly handlerFactories: Readonly<Record<string, HandlerFactory>>;
  readonly adapterFactories?: AdapterFactoryMap;
  readonly capabilityProviders?: readonly CapabilityProviderBinding[];
}

/**
 * Type-narrowing guard: returns true iff `value` is structurally a
 * `ProcessModulePlugin`. Used by tests and by the composition root's startup
 * sanity check (so a malformed plugin object surfaces with a clear message
 * rather than a cryptic `bindInstallation` failure downstream).
 *
 * Pure: no side effects, no exceptions.
 */
export function isProcessModulePlugin(value: unknown): value is ProcessModulePlugin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.installationId !== 'number') return false;
  if (
    typeof v.handlerFactories !== 'object'
    || v.handlerFactories === null
    || Array.isArray(v.handlerFactories)
  ) {
    return false;
  }
  for (const factory of Object.values(v.handlerFactories)) {
    if (typeof factory !== 'function') return false;
  }
  if (v.adapterFactories !== undefined) {
    if (
      typeof v.adapterFactories !== 'object'
      || v.adapterFactories === null
      || Array.isArray(v.adapterFactories)
    ) {
      return false;
    }
    for (const af of Object.values(v.adapterFactories)) {
      if (typeof af !== 'function') return false;
    }
  }
  if (v.capabilityProviders !== undefined) {
    if (!Array.isArray(v.capabilityProviders)) return false;
    for (const cp of v.capabilityProviders) {
      if (typeof cp !== 'object' || cp === null || Array.isArray(cp)) return false;
      const cpr = cp as Record<string, unknown>;
      if (
        typeof cpr.ref !== 'object'
        || cpr.ref === null
        || Array.isArray(cpr.ref)
      ) {
        return false;
      }
      const ref = cpr.ref as Record<string, unknown>;
      if (typeof ref.ref !== 'string' || typeof ref.version !== 'string') {
        return false;
      }
    }
  }
  return true;
}
