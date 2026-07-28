/**
 * W2-A6 — Generic registries (ports + in-memory adapters) for the installation layer.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
 *       §1 rows 10, 11, 12; §2 ports-vs-adapters table.
 * Plan: §14.4.2 (registries), §14.4.3 (plugin binding), §11.5 (namespace
 *       collision rejection), §5.1.3 (InstalledProcessModule value object).
 * Task: docs/refactor-management/05-subagent-tasks/W02-A6-registries-plugin-binding.md
 *
 * This module defines the generic PORTs the composition root talks to when it
 * activates an installed Process Module, plus the in-memory adapters a single
 * process uses at startup. Every PORT here is a runtime object: it carries
 * functions (handler factories, capability providers, guard implementations,
 * agent driver factories) and is NEVER persisted. The persisted identity is
 * carried by the immutable `ModuleInstallationRecord` (W2-A2); the plugin
 * (W2-A6 plugin.ts) is the runtime binding contract that links a record to the
 * concrete factories; `InstalledProcessModule` (W2-A6 installation-binding.ts)
 * is the resulting value object.
 *
 * ── What this file owns ────────────────────────────────────────────────────
 *
 *   - `HandlerRegistry` PORT + `InMemoryHandlerRegistry` adapter.
 *     Maps a `HandlerRef` (logical handler identity declared on the manifest)
 *     to a `HandlerFactory` (runtime function that produces a callable when
 *     given an activation context).
 *
 *   - `CapabilityRegistry` PORT + `InMemoryCapabilityRegistry` adapter.
 *     Maps a `CapabilityRequirement` to its runtime provider.
 *
 *   - `ModuleToolRegistry` PORT + `InMemoryModuleToolRegistry` adapter.
 *     Maps a `ModuleToolContribution.logicalId` to the contribution plus its
 *     bound handler. REJECTS namespace collision at register time (plan §11.5):
 *     two contributions sharing the same `logicalId` is an authoring error.
 *
 *   - `SchemaRegistry` — RE-EXPORT of the Wave 1 `ContractSchemaRegistry`
 *     port + `InMemoryContractSchemaRegistry` adapter (spec §2 row "SchemaRegistry
 *     (= the Wave 1 ContractSchemaRegistry — re-export, don't redefine)"). An
 *     `InMemorySchemaRegistry` alias is also provided so consumers can import
 *     the schema-registry concern from this layer's surface.
 *
 *   - `GuardRegistry` PORT + `InMemoryGuardRegistry` adapter.
 *     Maps a `GuardBinding` to its runtime guard implementation.
 *
 *   - `AgentDriverRegistry` PORT + `InMemoryAgentDriverRegistry` adapter.
 *     Maps a driver name to its factory. The SagaBoardClaudeDriver adapter is
 *     Wave 3 (W2-A6 only defines the port).
 *
 * ── Idempotency / collision rules ──────────────────────────────────────────
 *
 * Each registry that binds a runtime object (Handler/Capability/Guard/Driver)
 * follows the Wave 1 `InMemoryContractSchemaRegistry` convention: re-register
 * under the same logical key OVERWRITES (idempotent Map semantics; document
 * the choice, do not error). The exception is `ModuleToolRegistry`, which
 * REJECTS a second contribution under the same `logicalId` because tool names
 * are part of the surfaced MCP namespace and silent shadowing would be a
 * user-visible behavior change (plan §11.5).
 *
 * ── Dependency direction (Rule 5 ratchet) ──────────────────────────────────
 *
 * This file lives under `installation/domain/`. It imports ONLY from the Wave
 * 1 SPI barrel (`domain/spi/index.js`) — a sibling `domain/` path. No imports
 * from `application/`, `persistence/`, `composition/`, `modules/`, or
 * `infrastructure/`. Keeps Rule 5 of the W0-A1 ratchet clean.
 */

// Wave 1 SPI barrel — see plan §3.5 / WAVE1-PURE-SPI-SPEC.
import type {
  HandlerRef,
  ModuleToolContribution,
  CapabilityRequirement,
  GuardBinding,
  ContractSchemaRegistry,
} from '../../domain/spi/index.js';
import { InMemoryContractSchemaRegistry } from '../../domain/spi/index.js';

// Re-export the SchemaRegistry concern. Per spec §1 row 31 / §2 we MUST NOT
// redefine `ContractSchemaRegistry`; we surface it from this layer so callers
// can import the full registry surface from `installation/domain/registries`.
// Value exports (class + constants) + type exports are both surfaced verbatim
// from the Wave 1 barrel — this file does NOT re-implement any of them.
export {
  type ContractSchemaRegistry,
  type ContractSchemaCodec,
  type ContractRef,
  InMemoryContractSchemaRegistry,
} from '../../domain/spi/index.js';
export {
  CONTRACT_SCHEMA_UNKNOWN,
  contractSchemaRegistryKey,
} from '../../domain/spi/index.js';

/**
 * Convenience alias: `SchemaRegistry` IS the Wave 1 `ContractSchemaRegistry`.
 * Spec §1 row 31 names it "SchemaRegistry (= the Wave 1 ContractSchemaRegistry
 * — re-export, don't redefine)". Both names refer to the same shape; consumers
 * that want a parity-named adapter may use `InMemorySchemaRegistry`.
 */
export type SchemaRegistry = ContractSchemaRegistry;
export const InMemorySchemaRegistry = InMemoryContractSchemaRegistry satisfies {
  new (): ContractSchemaRegistry;
};

// ---------------------------------------------------------------------------
// Error-code tokens. Each registry's unknown-lookup path raises an Error whose
// `message` begins with one of these literal tokens, mirroring the
// CONTRACT_SCHEMA_UNKNOWN convention from Wave 1.
// ---------------------------------------------------------------------------

export const HANDLER_NOT_REGISTERED = 'HANDLER_NOT_REGISTERED';
export const CAPABILITY_NOT_REGISTERED = 'CAPABILITY_NOT_REGISTERED';
export const MODULE_TOOL_NOT_REGISTERED = 'MODULE_TOOL_NOT_REGISTERED';
export const MODULE_TOOL_NAMESPACE_COLLISION = 'MODULE_TOOL_NAMESPACE_COLLISION';
export const GUARD_NOT_REGISTERED = 'GUARD_NOT_REGISTERED';
export const AGENT_DRIVER_NOT_REGISTERED = 'AGENT_DRIVER_NOT_REGISTERED';

// ---------------------------------------------------------------------------
// Handler runtime types.
// ---------------------------------------------------------------------------

/**
 * A live, callable handler instance — produced by a `HandlerFactory` once an
 * installed module is activated by the composition root. The concrete shape of
 * `ctx` and the call arguments is narrowed by the consuming executor (kernel
 * node executor, MCP tool dispatcher, ...); at THIS layer we keep both opaque
 * so the generic registry has zero knowledge of any specific handler kind.
 *
 * This is a RUNTIME object (it IS a function): it is never persisted.
 */
export type HandlerInstance = (
  ...args: readonly unknown[]
) => unknown | Promise<unknown>;

/**
 * Factory that produces a `HandlerInstance` given an activation context
 * (runtime services, registries, the bound installation record, ...). Bound
 * into the `HandlerRegistry` at composition time by the plugin (plugin.ts).
 *
 * A factory (not the instance) is what the registry stores: this lets the
 * composition root defer construction until the handler is actually needed,
 * and lets the same factory be activated under different contexts (e.g. a
 * test fixture vs. the live runtime).
 */
export type HandlerFactory<Ctx = unknown> = (ctx: Ctx) => HandlerInstance;

/**
 * The activation context handed to a `HandlerFactory`. The concrete shape is
 * owned by the composition root (Wave 11 cutover); at this layer it is an
 * opaque marker so consumers can name it without depending on a concrete type.
 */
export interface HandlerActivationContext {
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// HandlerRegistry PORT + in-memory adapter.
// ---------------------------------------------------------------------------

/**
 * PORT — binds a declared `HandlerRef` to the live `HandlerFactory` that
 * produces its callable.
 *
 * Lookup key is the handler's `logicalId` (the same identifier that appears on
 * `ProcessModuleManifest.handlerRefs[].logicalId` and on
 * `ProcessModulePlugin.handlerFactories` keys). The registry indexes by
 * logical identity, NOT by `(logicalId, version, digest)`: two registrations
 * under the same logical id with different versions/digests would be a
 * module-authoring error and is the caller's responsibility.
 *
 * Idempotency: re-registering under the same logical id OVERWRITES the
 * previously bound factory (Map semantics, matching Wave 1's
 * `InMemoryContractSchemaRegistry`). This is the documented behavior — do not
 * treat it as an error.
 */
export interface HandlerRegistry {
  /** Bind `factory` under `ref.logicalId`. Overwrite-on-repeat (idempotent). */
  register(ref: HandlerRef, factory: HandlerFactory): void;
  /** True iff a factory is bound under `ref.logicalId`. */
  has(ref: HandlerRef): boolean;
  /** Resolve the factory bound under `ref.logicalId`. Throws on unknown. */
  resolve(ref: HandlerRef): HandlerFactory;
}

/**
 * Wave-2 in-memory adapter. `Map<string, HandlerFactory>` keyed by
 * `ref.logicalId`. Suitable for a single-process bootstrap.
 */
export class InMemoryHandlerRegistry implements HandlerRegistry {
  private readonly factories = new Map<string, HandlerFactory>();

  register(ref: HandlerRef, factory: HandlerFactory): void {
    this.factories.set(ref.logicalId, factory);
  }

  has(ref: HandlerRef): boolean {
    return this.factories.has(ref.logicalId);
  }

  resolve(ref: HandlerRef): HandlerFactory {
    const factory = this.factories.get(ref.logicalId);
    if (!factory) {
      throw new Error(
        `${HANDLER_NOT_REGISTERED}: no handler factory registered for logicalId '${ref.logicalId}' (version=${ref.version}, digest=${ref.digest})`,
      );
    }
    return factory;
  }
}

// ---------------------------------------------------------------------------
// CapabilityRegistry PORT + in-memory adapter.
// ---------------------------------------------------------------------------

/**
 * PORT — binds a declared `CapabilityRequirement` to its runtime provider.
 *
 * Lookup key is `(ref, version)` from `CapabilityRequirement`; the same pair
 * a manifest's `capabilityRequirements[]` carries.
 *
 * Idempotency: re-registering OVERWRITES (Map semantics).
 */
export interface CapabilityRegistry {
  /** Bind `provider` under the requirement's `(ref, version)` key. Idempotent. */
  register(requirement: CapabilityRequirement, provider: unknown): void;
  /** True iff a provider is bound under `requirement`'s key. */
  has(requirement: CapabilityRequirement): boolean;
  /** Resolve the provider bound under `requirement`'s key. Throws on unknown. */
  resolve(requirement: CapabilityRequirement): unknown;
}

/**
 * Build the Map key for a `CapabilityRequirement`. Includes `version`: two
 * capabilities with the same `ref` but different `version` are distinct.
 */
export function capabilityRegistryKey(requirement: CapabilityRequirement): string {
  return `${requirement.ref}@${requirement.version}`;
}

/**
 * Wave-2 in-memory adapter.
 */
export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly providers = new Map<string, unknown>();

  register(requirement: CapabilityRequirement, provider: unknown): void {
    this.providers.set(capabilityRegistryKey(requirement), provider);
  }

  has(requirement: CapabilityRequirement): boolean {
    return this.providers.has(capabilityRegistryKey(requirement));
  }

  resolve(requirement: CapabilityRequirement): unknown {
    const key = capabilityRegistryKey(requirement);
    const provider = this.providers.get(key);
    if (provider === undefined) {
      throw new Error(
        `${CAPABILITY_NOT_REGISTERED}: no provider registered for capability '${key}' (optional=${requirement.optional ?? false})`,
      );
    }
    return provider;
  }
}

// ---------------------------------------------------------------------------
// ModuleToolRegistry PORT + in-memory adapter (NAMESPACE COLLISION REJECTED).
// ---------------------------------------------------------------------------

/**
 * A bound tool entry: the static `ModuleToolContribution` (pure data — also
 * carried on the manifest) paired with the live handler that dispatches calls
 * to the tool. The handler is the runtime object; the contribution is the
 * surfaced MCP metadata.
 */
export interface ModuleToolEntry {
  readonly contribution: ModuleToolContribution;
  readonly handler: HandlerInstance;
}

/**
 * PORT — registers the MCP/tool contributions a module surfaces, each bound to
 * its live dispatch handler.
 *
 * Lookup key is the contribution's `logicalId` (the namespaced tool id, e.g.
 * `'discovery.proposal_submit'`). Two contributions with the same `logicalId`
 * would collide in the surfaced namespace; the registry REJECTS such a
 * re-registration with the `MODULE_TOOL_NAMESPACE_COLLISION` token (plan §11.5)
 * rather than silently shadowing.
 *
 * Re-registering the EXACT SAME contribution under the same `logicalId` is
 * permitted only when the contribution is byte-equal (same version + same
 * contract refs + same handler identity); otherwise the second register is a
 * collision. This catches accidental cross-module namespace squatting.
 */
export interface ModuleToolRegistry {
  /**
   * Bind `contribution` under its `logicalId`, dispatching calls to `handler`.
   * Throws `MODULE_TOOL_NAMESPACE_COLLISION` if a different contribution is
   * already bound under the same `logicalId`.
   */
  register(contribution: ModuleToolContribution, handler: HandlerInstance): void;
  /** True iff a tool is registered under `logicalId`. */
  has(logicalId: string): boolean;
  /** Resolve the entry bound under `logicalId`. Throws on unknown. */
  resolve(logicalId: string): ModuleToolEntry;
  /** Snapshot of every registered entry, keyed by `logicalId`. */
  list(): readonly ModuleToolEntry[];
}

/**
 * Structural equality check between two `ModuleToolContribution` objects. Used
 * by `register` to distinguish an idempotent re-register (same contribution
 * under the same logicalId) from a namespace collision (different contribution
 * under the same logicalId). Compares the persisted-identity fields: logicalId,
 * version, contract refs, handlerRef. Resource refs and guard bindings are NOT
 * compared because they are advisory, not identity.
 */
function contributionIdEqual(
  a: ModuleToolContribution,
  b: ModuleToolContribution,
): boolean {
  return (
    a.logicalId === b.logicalId
    && a.version === b.version
    && a.handlerRef === b.handlerRef
    && a.inputContractRef.schemaId === b.inputContractRef.schemaId
    && a.inputContractRef.version === b.inputContractRef.version
    && a.inputContractRef.digest === b.inputContractRef.digest
    && a.outputContractRef.schemaId === b.outputContractRef.schemaId
    && a.outputContractRef.version === b.outputContractRef.version
    && a.outputContractRef.digest === b.outputContractRef.digest
  );
}

/**
 * Wave-2 in-memory adapter. Rejects namespace collisions per plan §11.5.
 */
export class InMemoryModuleToolRegistry implements ModuleToolRegistry {
  private readonly entries = new Map<string, ModuleToolEntry>();

  register(contribution: ModuleToolContribution, handler: HandlerInstance): void {
    const existing = this.entries.get(contribution.logicalId);
    if (existing !== undefined) {
      if (
        !contributionIdEqual(existing.contribution, contribution)
        || existing.handler !== handler
      ) {
        throw new Error(
          `${MODULE_TOOL_NAMESPACE_COLLISION}: logicalId '${contribution.logicalId}' is already registered by a different contribution/handler (existing version=${existing.contribution.version}, incoming version=${contribution.version})`,
        );
      }
      // Idempotent re-register of the exact same contribution+handler: no-op.
      return;
    }
    this.entries.set(contribution.logicalId, { contribution, handler });
  }

  has(logicalId: string): boolean {
    return this.entries.has(logicalId);
  }

  resolve(logicalId: string): ModuleToolEntry {
    const entry = this.entries.get(logicalId);
    if (entry === undefined) {
      throw new Error(
        `${MODULE_TOOL_NOT_REGISTERED}: no tool registered under logicalId '${logicalId}'`,
      );
    }
    return entry;
  }

  list(): readonly ModuleToolEntry[] {
    return [...this.entries.values()];
  }
}

// ---------------------------------------------------------------------------
// GuardRegistry PORT + in-memory adapter.
// ---------------------------------------------------------------------------

/**
 * A live guard implementation — runtime predicate/policy function bound under
 * a `GuardBinding`. Opaque at this layer; the consuming policy executor
 * narrows the signature.
 */
export type GuardImplementation = (
  ...args: readonly unknown[]
) => unknown | Promise<unknown>;

/**
 * PORT — binds a declared `GuardBinding` to its runtime `GuardImplementation`.
 *
 * Lookup key is `(ref, scope)` from `GuardBinding`. Idempotent on overwrite.
 */
export interface GuardRegistry {
  /** Bind `guard` under `(ref, scope)`. Overwrite-on-repeat (idempotent). */
  register(binding: GuardBinding, guard: GuardImplementation): void;
  /** True iff a guard is bound under `(binding.ref, binding.scope)`. */
  has(binding: GuardBinding): boolean;
  /** Resolve the guard bound under `(binding.ref, binding.scope)`. Throws on unknown. */
  resolve(binding: GuardBinding): GuardImplementation;
}

/**
 * Build the Map key for a `GuardBinding`. Includes `scope`: the same `ref`
 * under different scopes (e.g. `'call'` vs `'submit'`) is a distinct binding.
 */
export function guardRegistryKey(binding: GuardBinding): string {
  return `${binding.ref}#${binding.scope}`;
}

/**
 * Wave-2 in-memory adapter.
 */
export class InMemoryGuardRegistry implements GuardRegistry {
  private readonly guards = new Map<string, GuardImplementation>();

  register(binding: GuardBinding, guard: GuardImplementation): void {
    this.guards.set(guardRegistryKey(binding), guard);
  }

  has(binding: GuardBinding): boolean {
    return this.guards.has(guardRegistryKey(binding));
  }

  resolve(binding: GuardBinding): GuardImplementation {
    const key = guardRegistryKey(binding);
    const guard = this.guards.get(key);
    if (!guard) {
      throw new Error(
        `${GUARD_NOT_REGISTERED}: no guard registered under '${key}'`,
      );
    }
    return guard;
  }
}

// ---------------------------------------------------------------------------
// AgentDriverRegistry PORT + in-memory adapter.
// ---------------------------------------------------------------------------

/**
 * Factory that produces an agent driver instance given an activation context.
 * The concrete driver shape (the saga-board claude driver, a test stub, ...)
 * is owned by the consuming executor; at this layer it is opaque. Wave 3 ships
 * the `SagaBoardClaudeDriver` adapter; Wave 2 only defines this port.
 */
export type AgentDriverFactory<Ctx = unknown> = (ctx: Ctx) => unknown;

/**
 * PORT — binds a named agent driver factory.
 *
 * Lookup key is the driver `name` (e.g. `'saga-board-claude'`). Idempotent on
 * overwrite. The Wave 3 `SagaBoardClaudeDriver` registers itself under
 * `'saga-board-claude'`; until then the port is exercised by tests with stub
 * factories.
 */
export interface AgentDriverRegistry {
  /** Bind `factory` under `name`. Overwrite-on-repeat (idempotent). */
  register(name: string, factory: AgentDriverFactory): void;
  /** True iff a factory is bound under `name`. */
  has(name: string): boolean;
  /** Resolve the factory bound under `name`. Throws on unknown. */
  resolve(name: string): AgentDriverFactory;
}

/**
 * Wave-2 in-memory adapter.
 */
export class InMemoryAgentDriverRegistry implements AgentDriverRegistry {
  private readonly factories = new Map<string, AgentDriverFactory>();

  register(name: string, factory: AgentDriverFactory): void {
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  resolve(name: string): AgentDriverFactory {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(
        `${AGENT_DRIVER_NOT_REGISTERED}: no agent driver factory registered under name '${name}'`,
      );
    }
    return factory;
  }
}

// ---------------------------------------------------------------------------
// Aggregate bundle — the set of registries the composition root activates
// against a `ProcessModulePlugin` at install-bind time. See plugin.ts and
// installation-binding.ts.
// ---------------------------------------------------------------------------

/**
 * Bundle of the generic registries a single process holds. Every field is a
 * PORT; concrete in-memory adapters are wired by the composition root. This
 * type is imported by `bindInstallation` (installation-binding.ts) so it can
 * resolve handler factories / tools / schemas / resources into the
 * `InstalledProcessModule` value object.
 *
 * `schemaRegistry` is the Wave 1 `ContractSchemaRegistry` (re-exported here as
 * `SchemaRegistry`); see file header.
 */
export interface ModuleRegistries {
  readonly handlerRegistry: HandlerRegistry;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly moduleToolRegistry: ModuleToolRegistry;
  readonly schemaRegistry: SchemaRegistry;
  readonly guardRegistry: GuardRegistry;
  readonly agentDriverRegistry: AgentDriverRegistry;
}

/**
 * Construct a fresh bundle of in-memory registry adapters. Convenience for
 * tests and for the composition-root bootstrap (Wave 11). Each adapter is a
 * new instance — no shared Map state across bundles.
 */
export function createInMemoryModuleRegistries(): ModuleRegistries {
  return {
    handlerRegistry: new InMemoryHandlerRegistry(),
    capabilityRegistry: new InMemoryCapabilityRegistry(),
    moduleToolRegistry: new InMemoryModuleToolRegistry(),
    schemaRegistry: new InMemorySchemaRegistry(),
    guardRegistry: new InMemoryGuardRegistry(),
    agentDriverRegistry: new InMemoryAgentDriverRegistry(),
  };
}
