/**
 * W2-A6 — InstalledProcessModule value object + bindInstallation.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
 *       §1 row 12, §2 ports-vs-adapters table, §5 (anti-scope: no live execution
 *       cutover — the value object carries resolved data only).
 * Plan: §5.1.3 (InstalledProcessModule value object), §5.5.2 (fail-fast on
 *       missing handler coverage), §14.4.3 (plugin binding).
 * Task: docs/refactor-management/05-subagent-tasks/W02-A6-registries-plugin-binding.md
 *
 * `bindInstallation(record, plugin, registries)` is the single pure function
 * the composition root calls at startup to convert an immutable
 * `ModuleInstallationRecord` + a `ProcessModulePlugin` + a `ModuleRegistries`
 * bundle into an `InstalledProcessModule` value object — the resolved
 * projection that downstream executors consume read-only. The function is PURE
 * (no I/O, no side effects): it reads the record and the plugin, resolves
 * against the registries (which themselves are runtime objects, but their read
 * surface is pure), and returns a frozen snapshot.
 *
 * Fail-fast policy (plan §5.5.2): if any manifest-declared handler has no
 * factory in the plugin, OR any plugin factory key has no matching manifest
 * handler, the bind throws `INSTALLATION_BINDING_INCOMPLETE` — partial binds
 * are NOT permitted, because a half-installed module is a runtime hazard the
 * composition root cannot safely activate.
 *
 * ── Cross-lane import: ModuleInstallationRecord (W2-A2) ────────────────────
 *
 * `ModuleInstallationRecord` is owned by W2-A2 (`installation/domain/installation.ts`).
 * Per the task brief, W2-A2 "may be absent locally" in this isolated worktree.
 * To keep this file type-checking in isolation AND satisfy the integrator's
 * single-import expectation at cherry-pick time, we declare a minimal local
 * structural type below that mirrors the shape `bindInstallation` actually
 * reads. The fields we read are exactly:
 *
 *   - `id: ModuleInstallationId`                — bound against `plugin.installationId`.
 *   - `name: string` + `version: string`        — carried through for diagnostics.
 *   - `manifestSnapshot: ProcessModuleManifest` — the canonical manifest.
 *   - `handlerRefs: readonly HandlerRef[]`      — declared handlers; matched
 *                                                 against `plugin.handlerFactories`.
 *   - `packageDigest: string`                   — carried through for diagnostics.
 *
 * The local alias is byte-structurally identical to W2-A2's record type for
 * these fields; the other W2-A2 fields (`status`, `installedAt`, `activatedAt`,
 * `retiredAt`, `storeLocation`, `resourceIndex`, `dependencyLock`) are not read
 * here and so are intentionally omitted from the local alias — they ARE present
 * on W2-A2's real type. When the integrator cherry-picks this lane into the
 * integration worktree, they MUST replace the local `ModuleInstallationRecord`
 * alias below with a type-only import from `./installation.js` (W2-A2). The
 * rest of this file is unchanged.
 *
 * NOTE (integrator): delete the `ModuleInstallationRecord` and
 * `ModuleInstallationId` aliases below and uncomment the import:
 *
 *   import type {
 *     ModuleInstallationRecord,
 *     ModuleInstallationId,
 *   } from './installation.js';
 */

// Wave 1 SPI barrel — pure types this file reads off the manifest.
import type {
  ProcessModuleManifest,
  HandlerRef,
  ModuleToolContribution,
  ContractRef,
  ResourceIndexEntry,
} from '../../domain/spi/index.js';

// Sibling lane: plugin shape + the runtime types it carries.
import type { ProcessModulePlugin } from './plugin.js';
import type { ModuleRegistries, HandlerFactory } from './registries.js';

// ---------------------------------------------------------------------------
// Local isolation aliases for W2-A2's `ModuleInstallationRecord` and
// `ModuleInstallationId`. See file header NOTE. REMOVED at integration time.
// ---------------------------------------------------------------------------

/** Local isolation alias — see file header. */
export type ModuleInstallationId = number & { readonly __brand: 'ModuleInstallationId' };

/**
 * Local isolation alias mirroring only the fields `bindInstallation` reads.
 * See file header NOTE: at integration time, replace with a type-only import
 * from `./installation.js` (W2-A2's authoritative type).
 */
export interface ModuleInstallationRecord {
  readonly id: ModuleInstallationId;
  readonly name: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly manifestSnapshot: ProcessModuleManifest;
  readonly handlerRefs: readonly HandlerRef[];
}

// ---------------------------------------------------------------------------
// Error tokens.
// ---------------------------------------------------------------------------

/**
 * Thrown when `bindInstallation` detects that the plugin and the record do not
 * cover each other exactly. The `message` lists the missing/extra handler ids
 * so the operator can fix the bind.
 */
export const INSTALLATION_BINDING_INCOMPLETE = 'INSTALLATION_BINDING_INCOMPLETE';

/**
 * Thrown when `bindInstallation` is asked to bind a plugin whose
 * `installationId` does not match the record's `id`. This is a programmer
 * error (the composition root pairs a record with its plugin); it surfaces
 * with a clear message rather than a confusing missing-handler report.
 */
export const INSTALLATION_IDENTITY_MISMATCH = 'INSTALLATION_IDENTITY_MISMATCH';

// ---------------------------------------------------------------------------
// InstalledProcessModule value object.
// ---------------------------------------------------------------------------

/**
 * Pure value object: the resolved projection of an installed module, ready for
 * the composition root to activate (plan §5.1.3). Carries:
 *
 *   - the immutable `record` (identity + persisted manifest);
 *   - resolved handler factories keyed by handler logicalId (live callables —
 *     the ONLY runtime objects on this value; everything else is pure data);
 *   - resolved tool contributions (the surfaced MCP tools — pure data, copied
 *     off the manifest snapshot);
 *   - resolved schema contract refs (pure data, copied off the manifest);
 *   - resolved resource index entries (pure data, copied off the manifest).
 *
 * The value does NOT carry a live executor (composition-root concern) and does
 * NOT mutate the source registries — it snapshots them.
 */
export interface InstalledProcessModule {
  readonly record: ModuleInstallationRecord;
  readonly resolvedHandlers: Readonly<Record<string, HandlerFactory>>;
  readonly resolvedTools: readonly ModuleToolContribution[];
  readonly resolvedSchemas: readonly ContractRef[];
  readonly resolvedResources: readonly ResourceIndexEntry[];
}

// ---------------------------------------------------------------------------
// bindInstallation — pure function.
// ---------------------------------------------------------------------------

/**
 * Bind an immutable `ModuleInstallationRecord` to a `ProcessModulePlugin`'s
 * runtime factories against a `ModuleRegistries` bundle, producing the
 * `InstalledProcessModule` value object the composition root activates.
 *
 * Pure: no I/O, no side effects on the registries (the function READS the
 * registries only to resolve handler factories; it does not mutate them —
 * registering the plugin's factories into the registries is the composition
 * root's responsibility, performed once before this call).
 *
 * Fail-fast (plan §5.5.2): throws `INSTALLATION_BINDING_INCOMPLETE` if:
 *   - any `record.handlerRefs[].logicalId` has no matching key in
 *     `plugin.handlerFactories` (manifest-declared handler with no factory);
 *   - any `plugin.handlerFactories` key has no matching
 *     `record.handlerRefs[].logicalId` (factory with no manifest declaration).
 *
 * Throws `INSTALLATION_IDENTITY_MISMATCH` if
 * `plugin.installationId !== record.id`.
 *
 * @param record     The immutable installation record (W2-A2).
 * @param plugin     The composition-root-facing binding contract (W2-A6 plugin.ts).
 * @param registries Bundle of generic registries (W2-A6 registries.ts). Read
 *                   for handler-factory resolution; the registries themselves
 *                   are expected to have the plugin's factories already
 *                   registered by the composition root.
 */
export function bindInstallation(
  record: ModuleInstallationRecord,
  plugin: ProcessModulePlugin,
  registries: ModuleRegistries,
): InstalledProcessModule {
  // Identity check — programmer error if mismatched.
  if (plugin.installationId !== record.id) {
    throw new Error(
      `${INSTALLATION_IDENTITY_MISMATCH}: plugin.installationId=${plugin.installationId} does not match record.id=${record.id} (module ${record.name}@${record.version})`,
    );
  }

  // Build the manifest-declared handler logicalId set.
  const declaredHandlerIds = new Set<string>();
  for (const ref of record.handlerRefs) {
    declaredHandlerIds.add(ref.logicalId);
  }

  // Build the plugin-provided handler factory key set.
  const pluginFactoryKeys = new Set<string>(
    Object.keys(plugin.handlerFactories),
  );

  // Missing coverage: declared handlers with no factory.
  const missing: string[] = [];
  for (const id of declaredHandlerIds) {
    if (!pluginFactoryKeys.has(id)) {
      missing.push(id);
    }
  }

  // Extra coverage: factory keys with no manifest declaration.
  const extra: string[] = [];
  for (const key of pluginFactoryKeys) {
    if (!declaredHandlerIds.has(key)) {
      extra.push(key);
    }
  }

  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `missing handler factories for declared handlers: [${missing.sort().join(', ')}]`,
      );
    }
    if (extra.length > 0) {
      parts.push(
        `extra handler factories not declared on manifest: [${extra.sort().join(', ')}]`,
      );
    }
    throw new Error(
      `${INSTALLATION_BINDING_INCOMPLETE}: module ${record.name}@${record.version} (digest=${record.packageDigest}) — ${parts.join('; ')}`,
    );
  }

  // Resolve handler factories from the registry (defensive: the composition
  // root is expected to have registered them, but we read via the registry so
  // the value object carries the canonical resolution rather than a possibly
  // stale plugin reference). Build a HandlerRef lookup so we can resolve by
  // logicalId without allocating a new ref object on every iteration.
  const resolvedHandlers: Record<string, HandlerFactory> = {};
  for (const ref of record.handlerRefs) {
    resolvedHandlers[ref.logicalId] = registries.handlerRegistry.resolve(ref);
  }

  // Resolve the surfaced tool contributions off the manifest snapshot (pure
  // data copy — the registry holds live handler bindings; here we just project
  // the static declarations the manifest carries).
  const manifest = record.manifestSnapshot;
  const resolvedTools: readonly ModuleToolContribution[] = manifest.toolContributions
    ? [...manifest.toolContributions]
    : [];

  // Resolve schema contract refs: the module's input + output contract refs
  // plus every tool contribution's input + output contract ref. De-duplicated
  // by `${schemaId}@${version}` (the canonical registry key) so the value
  // object carries a clean set, not a list with duplicates.
  const schemaKeys = new Set<string>();
  const resolvedSchemas: ContractRef[] = [];
  const pushSchema = (ref: ContractRef): void => {
    const key = `${ref.schemaId}@${ref.version}`;
    if (schemaKeys.has(key)) return;
    schemaKeys.add(key);
    resolvedSchemas.push(ref);
  };
  pushSchema(manifest.inputContractRef);
  pushSchema(manifest.outputContractRef);
  for (const tool of resolvedTools) {
    pushSchema(tool.inputContractRef);
    pushSchema(tool.outputContractRef);
  }

  // Resolve resource index entries (pure data copy off the manifest snapshot).
  const resolvedResources: readonly ResourceIndexEntry[] = manifest.resourceIndex
    ? [...manifest.resourceIndex]
    : [];

  return Object.freeze({
    record,
    resolvedHandlers: Object.freeze(resolvedHandlers),
    resolvedTools: Object.freeze(resolvedTools) as readonly ModuleToolContribution[],
    resolvedSchemas: Object.freeze(resolvedSchemas) as readonly ContractRef[],
    resolvedResources: Object.freeze(resolvedResources) as readonly ResourceIndexEntry[],
  });
}
