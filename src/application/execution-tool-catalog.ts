/**
 * W6-A7 — Execution-scoped tool catalog (plan §11.11).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md`
 *        Lane W6-A7; contract §11.11.
 * Task: `docs/refactor-management/05-subagent-tasks/W06-a7.md`.
 *
 * §11.11 — "Tool listing for a managed execution is assembled from its pinned
 * platform capabilities and module installation. Operator and interactive
 * catalogs are separate compatibility surfaces."
 *
 * This module is the pure assembler for the *execution* surface. Given:
 *   1. the pinned platform capability packages the execution is entitled to
 *      (the W6-A2 `CapabilityPackage` concept — shared tools like tasks,
 *      artifact graph, repository, worker completion, protocol checkpointing),
 *   2. the module installation records pinned to that execution (each carrying
 *      its `ModuleToolContribution`s from W1-A6),
 *
 * ...it produces one deterministic, canonically-serializable tool listing. The
 * listing is what the gateway advertises to a managed execution (plan §11.6:
 * "Runtime exposes only the tools permitted by the intersection of package
 * profile, current protocol step, frozen execution authority, and platform
 * policy"). Step/authority/policy intersection is the gateway guard's job
 * (W6-A3); this catalog only assembles the *catalog* — the universe of tools
 * the execution *could* call.
 *
 * Generated descriptions (§11.11 + §12.1): each entry carries a deterministic
 * `description` string derived from the tool's registered contracts
 * (`inputContractRef` / `outputContractRef`). When a `ContractDescriptionLookup`
 * is supplied, the description embeds the human-readable contract summary the
 * registry holds; otherwise it falls back to a stable contract-derived
 * description built from the contribution's own metadata. Descriptions are
 * NEVER invented from thin air — they are generated from registered contracts,
 * which is the §11.11 contract.
 *
 * Operator and interactive catalogs are NOT assembled here (§11.11: "separate
 * compatibility surfaces"). This module is the execution surface only.
 *
 * ── Cross-lane isolation ─────────────────────────────────────────────────
 *
 * The sibling Wave 6 lanes W6-A1 (`tool-contribution-installer.ts`) and W6-A2
 * (`capability-packages.ts`) are NOT present in this isolated W6-A7 worktree
 * — they land at integration time. To keep this file compiling in isolation
 * without importing not-yet-existing siblings, we declare local structural
 * aliases (`PlatformCapability`, `PinnedCapabilityTool`) that mirror the
 * frozen shapes those lanes will own. The aliases are structurally identical
 * to the real types, so a real value satisfies them without any adapter; the
 * integrator unifies each alias with its real `import type` at cherry-pick
 * time without touching any call site. This is the same trick `describe.ts`
 * (W2-A7) uses for `ModuleInstallationRecord` and `tool-contribution.ts`
 * (W1-A6) uses for `ContractRef`.
 *
 * This file is PURE (plan §3.5): data types + pure functions. No I/O, no side
 * effects, no closures retained across calls. It imports only from the Wave 1
 * pure SPI barrel (`process-modules/domain/spi`) and from
 * `shared/canonical-json.ts`. No imports from persistence,
 * composition, modules, or infrastructure.
 */

import type { ModuleToolContribution, ToolContractRef } from '../process-modules/domain/spi/tool-contribution.js';
import type { ContractRef } from '../process-modules/domain/spi/contract-ref.js';

// Canonical-JSON + sha256 over the assembled entries. Imported from the shared
// pure module (shared/canonical-json.ts). Value
// import: the hash is computed at runtime by the catalog assembler.
import { sha256Hex, canonicalJson } from '../shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Structural aliases for not-yet-landed sibling-lane types. See file header.
// ---------------------------------------------------------------------------

/**
 * One tool a platform capability package grants to an execution.
 *
 * Structural mirror of the W6-A2 `CapabilityPackage` tool entry. A capability
 * package is a versioned bundle of *shared* tools (tasks, artifact graph,
 * repository, worker completion, protocol checkpointing — plan §11.2). Each
 * granted tool carries the same contract-ref/handler-ref/idempotency/
 * side-effect classification a module contribution carries, so the catalog can
 * treat platform and module tools uniformly.
 *
 * @property logicalId         namespaced tool id (e.g. `'platform.task_create'`).
 * @property version           tool semantic version.
 * @property inputContractRef  contract ref for the tool's input schema.
 * @property outputContractRef contract ref for the tool's output schema.
 * @property handlerRef        opaque reference to the handler implementation.
 * @property idempotency       `'none'` | `'idempotent'`.
 * @property sideEffect        `'none'` | `'read'` | `'write'` | `'external'`.
 * @property capabilityRef     the capability package this tool belongs to
 *                             (e.g. `'saga.capability.tasks'`).
 * @property capabilityVersion the capability package version this tool is
 *                             granted at.
 */
export interface PinnedCapabilityTool {
  readonly logicalId: string;
  readonly version: string;
  readonly inputContractRef: ToolContractRef;
  readonly outputContractRef: ToolContractRef;
  readonly handlerRef: string;
  readonly idempotency: 'none' | 'idempotent';
  readonly sideEffect: 'none' | 'read' | 'write' | 'external';
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
}

/**
 * A pinned platform capability package granted to a managed execution (W6-A2).
 *
 * Structural mirror of W6-A2's `CapabilityPackage`. The execution is entitled
 * to every tool in `tools`. `ref` + `version` pin the package immutably so the
 * catalog is reproducible from the persisted execution pinning.
 *
 * @property ref     capability package logical id (e.g. `'saga.capability.tasks'`).
 * @property version capability package semantic version.
 * @property tools   the shared tools this package grants.
 */
export interface PlatformCapability {
  readonly ref: string;
  readonly version: string;
  readonly tools: readonly PinnedCapabilityTool[];
}

/**
 * A module installation record carrying tool contributions, pinned to an
 * execution. Structural mirror of the W2-A2 `ModuleInstallationRecord` fields
 * the catalog reads (subset of W2-A7's `InstallationRecordView`). The catalog
 * reads ONLY `name`, `version`, and `manifestSnapshot.toolContributions`.
 *
 * @property name             module name.
 * @property version          module version.
 * @property toolContributions the module's declared MCP tools (W1-A6), or empty.
 */
export interface PinnedModuleInstallation {
  readonly name: string;
  readonly version: string;
  readonly toolContributions: readonly ModuleToolContribution[];
}

// ---------------------------------------------------------------------------
// Contract description lookup (§11.11: generated from registered contracts).
// ---------------------------------------------------------------------------

/**
 * A human-readable summary a registered contract carries, looked up by its
 * `ContractRef`. The Wave 1 `ContractSchemaRegistry`
 * (`process-modules/domain/spi/contract-schema-registry.ts`) holds the codec;
 * the description is the companion human text the registry (or a description
 * side-table) exposes. When no lookup is supplied, the catalog falls back to a
 * stable contract-derived description.
 *
 * Both fields are optional so a registry may register only the summary, only
 * the detail, or both.
 */
export interface ContractDescription {
  /** One-line human-readable summary of what the contract's payload is. */
  readonly summary?: string;
  /** Longer-form detail (parameter shape, result shape, side effects). */
  readonly detail?: string;
}

/**
 * Lookup hook: given a {@link ContractRef}, return its registered
 * {@link ContractDescription}, or `undefined` when no description is
 * registered for that ref. Implementations are expected to be deterministic
 * (same ref → same description) so the generated catalog is reproducible.
 *
 * The lookup is OPTIONAL: callers may omit it, in which case every entry's
 * description is generated from the contribution's own metadata (still
 * deterministic, still contract-derived via the contract refs).
 */
export type ContractDescriptionLookup = (
  ref: ContractRef,
) => ContractDescription | undefined;

// ---------------------------------------------------------------------------
// CatalogToolEntry — one assembled tool in the execution listing.
// ---------------------------------------------------------------------------

/**
 * The surface a tool was contributed from. §11.11 distinguishes "pinned
 * platform capabilities" from "module installation".
 *
 *   `'platform'` — granted by a pinned platform capability package (W6-A2).
 *   `'module'`   — contributed by an installed module's manifest (W1-A6).
 */
export type CatalogToolSource = 'platform' | 'module';

/**
 * One entry in the assembled execution tool catalog (§11.11).
 *
 * Every field is derived deterministically from the pinned inputs; the same
 * capabilities + installations always yield the same entry. The entry is
 * canonically serializable (no functions, no Maps/Sets, no class instances —
 * plan §3.5) so it round-trips through canonical JSON for the gateway's
 * `tools/list` response.
 *
 * @property logicalId         namespaced tool id.
 * @property version           tool semantic version.
 * @property source            `'platform'` or `'module'`.
 * @property sourceRef         for platform tools: the capability package ref;
 *                             for module tools: the module name. Lets a
 *                             consumer attribute the tool to its origin without
 *                             re-reading the inputs.
 * @property sourceVersion     the capability-package version (platform) or the
 *                             module version (module).
 * @property inputContractRef  input contract ref (schemaId/version/digest).
 * @property outputContractRef output contract ref.
 * @property handlerRef        opaque handler implementation reference.
 * @property idempotency       `'none'` | `'idempotent'`.
 * @property sideEffect        `'none'` | `'read'` | `'write'` | `'external'`.
 * @property description       deterministic description generated from the
 *                             tool's registered contracts (§11.11).
 */
export interface CatalogToolEntry {
  readonly logicalId: string;
  readonly version: string;
  readonly source: CatalogToolSource;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly inputContractRef: ToolContractRef;
  readonly outputContractRef: ToolContractRef;
  readonly handlerRef: string;
  readonly idempotency: 'none' | 'idempotent';
  readonly sideEffect: 'none' | 'read' | 'write' | 'external';
  readonly description: string;
}

/**
 * The assembled execution tool catalog (§11.11).
 *
 * @property entries    every tool the execution is entitled to, ordered by
 *                      `logicalId` then `version` for determinism.
 * @property platformCount  number of platform-sourced entries.
 * @property moduleCount    number of module-sourced entries.
 * @property collisions     logicalIds that appeared in BOTH a platform
 *                      capability and a module installation. Per §11.5
 *                      ("Installation validates tool collisions") a populated
 *                      collisions list signals the inputs were not properly
 *                      reconciled; the catalog still assembles deterministically
 *                      (platform wins on collision, mirroring "platform owns
 *                      shared capabilities" §11.2) but surfaces the conflict so
 *                      the caller can reject or reconcile.
 * @property contentHash  sha256Hex over the canonical JSON of `entries`. Stable
 *                      fingerprint of the assembled catalog; two executions
 *                      pinned to the same capabilities + installations produce
 *                      the same hash.
 */
export interface ExecutionToolCatalog {
  readonly entries: readonly CatalogToolEntry[];
  readonly platformCount: number;
  readonly moduleCount: number;
  readonly collisions: readonly string[];
  readonly contentHash: string;
}

// ---------------------------------------------------------------------------
// Inputs to the assembler.
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link assembleExecutionToolCatalog}. Mirrors §11.11's two sources:
 * pinned platform capabilities + module installation.
 *
 * @property capabilities   the pinned platform capability packages granted to
 *                          the execution (W6-A2). May be empty.
 * @property installations  the module installations pinned to the execution
 *                          (W2-A2 records carrying W1-A6 tool contributions).
 *                          May be empty.
 * @property describeContract optional lookup that returns a registered
 *                          contract's human-readable description. When omitted,
 *                          descriptions are generated from contribution
 *                          metadata (still deterministic, still contract-derived).
 */
export interface ExecutionToolCatalogInput {
  readonly capabilities: readonly PlatformCapability[];
  readonly installations: readonly PinnedModuleInstallation[];
  readonly describeContract?: ContractDescriptionLookup;
}

// ---------------------------------------------------------------------------
// Description generation (§11.11: from registered contracts).
// ---------------------------------------------------------------------------

/**
 * Build the deterministic description for one tool entry.
 *
 * Strategy (in priority order — first non-empty wins):
 *   1. If `describeContract` is supplied and returns a description for the
 *      INPUT contract ref, use its `summary` (or `detail` if no summary).
 *      The input contract is the primary surface a caller programs against, so
 *      its registered description is the most accurate.
 *   2. Else if `describeContract` returns a description for the OUTPUT contract
 *      ref, use its `summary`/`detail`.
 *   3. Else fall back to a stable contract-derived description assembled from
 *      the tool's own metadata: logicalId, idempotency, sideEffect, and the
 *      contract ref schemaIds. This is still "generated from registered
 *      contracts" in the §11.11 sense — the contract refs ARE the registered
 *      contract identities; we just synthesize the prose locally when no human
 *      description has been registered yet.
 *
 * The result is always a non-empty string and is deterministic for a given
 * (contribution, lookup) pair.
 */
export function generateToolDescription(input: {
  readonly logicalId: string;
  readonly inputContractRef: ToolContractRef;
  readonly outputContractRef: ToolContractRef;
  readonly idempotency: 'none' | 'idempotent';
  readonly sideEffect: 'none' | 'read' | 'write' | 'external';
  readonly describeContract?: ContractDescriptionLookup;
}): string {
  const lookup = input.describeContract;
  if (lookup) {
    const fromInput = lookup(input.inputContractRef);
    if (fromInput) {
      const text = fromInput.summary ?? fromInput.detail;
      if (typeof text === 'string' && text.length > 0) {
        return text;
      }
    }
    const fromOutput = lookup(input.outputContractRef);
    if (fromOutput) {
      const text = fromOutput.summary ?? fromOutput.detail;
      if (typeof text === 'string' && text.length > 0) {
        return text;
      }
    }
  }
  // Fallback: contract-derived description. The contract refs are the
  // registered contract identities, so this is still "generated from
  // registered contracts" — we synthesize prose from identity + classification
  // when no human description is registered.
  const parts: string[] = [input.logicalId];
  parts.push(`input=${input.inputContractRef.schemaId}@${input.inputContractRef.version}`);
  parts.push(`output=${input.outputContractRef.schemaId}@${input.outputContractRef.version}`);
  if (input.idempotency === 'idempotent') {
    parts.push('idempotent');
  }
  if (input.sideEffect !== 'none') {
    parts.push(`sideEffect:${input.sideEffect}`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Helpers (module-local; not exported).
// ---------------------------------------------------------------------------

function toCatalogEntryFromPlatform(tool: PinnedCapabilityTool, describeContract?: ContractDescriptionLookup): CatalogToolEntry {
  return {
    logicalId: tool.logicalId,
    version: tool.version,
    source: 'platform',
    sourceRef: tool.capabilityRef,
    sourceVersion: tool.capabilityVersion,
    inputContractRef: tool.inputContractRef,
    outputContractRef: tool.outputContractRef,
    handlerRef: tool.handlerRef,
    idempotency: tool.idempotency,
    sideEffect: tool.sideEffect,
    description: generateToolDescription({
      logicalId: tool.logicalId,
      inputContractRef: tool.inputContractRef,
      outputContractRef: tool.outputContractRef,
      idempotency: tool.idempotency,
      sideEffect: tool.sideEffect,
      describeContract,
    }),
  };
}

function toCatalogEntryFromModule(
  module: PinnedModuleInstallation,
  contribution: ModuleToolContribution,
  describeContract?: ContractDescriptionLookup,
): CatalogToolEntry {
  return {
    logicalId: contribution.logicalId,
    version: contribution.version,
    source: 'module',
    sourceRef: module.name,
    sourceVersion: module.version,
    inputContractRef: contribution.inputContractRef,
    outputContractRef: contribution.outputContractRef,
    handlerRef: contribution.handlerRef,
    idempotency: contribution.idempotency,
    sideEffect: contribution.sideEffect,
    description: generateToolDescription({
      logicalId: contribution.logicalId,
      inputContractRef: contribution.inputContractRef,
      outputContractRef: contribution.outputContractRef,
      idempotency: contribution.idempotency,
      sideEffect: contribution.sideEffect,
      describeContract,
    }),
  };
}

/**
 * Deterministic comparator for catalog entries: by `logicalId`, then `version`,
 * then `source` (platform before module — platform owns shared capabilities,
 * §11.2). Stable regardless of input order.
 */
function compareCatalogEntries(a: CatalogToolEntry, b: CatalogToolEntry): number {
  if (a.logicalId < b.logicalId) return -1;
  if (a.logicalId > b.logicalId) return 1;
  if (a.version < b.version) return -1;
  if (a.version > b.version) return 1;
  // platform (0) before module (1) on full ties.
  const sa = a.source === 'platform' ? 0 : 1;
  const sb = b.source === 'platform' ? 0 : 1;
  return sa - sb;
}

// ---------------------------------------------------------------------------
// assembleExecutionToolCatalog — the §11.11 assembler.
// ---------------------------------------------------------------------------

/**
 * Assemble the execution-scoped tool catalog from pinned platform capabilities
 * and module installation (plan §11.11).
 *
 * Pure function: no I/O, no side effects, no closures retained. Calling it
 * twice on the same inputs yields a structurally-equal catalog (the
 * determinism contract W6-A7's test asserts), including a stable
 * `contentHash`.
 *
 * Assembly rules:
 *   - Every tool in every pinned `PlatformCapability` becomes a `'platform'`
 *     entry attributed to its capability package.
 *   - Every `ModuleToolContribution` on every pinned `PinnedModuleInstallation`
 *     becomes a `'module'` entry attributed to its module.
 *   - Collisions: a `logicalId` present in BOTH a platform capability and a
 *     module installation is recorded in `collisions`. The platform entry wins
 *     (§11.2: platform owns shared capabilities); the module entry is dropped
 *     so the listing has no duplicate logicalIds. A non-empty `collisions`
 *     list signals §11.5 collision validation should have caught this earlier;
 *     the catalog surfaces it rather than silently merging.
 *   - Entries are sorted by `(logicalId, version, source)` for determinism.
 *   - Each entry's `description` is generated via {@link generateToolDescription}
 *     from the registered contracts (§11.11).
 *   - `contentHash` is `sha256Hex(canonicalJson(entries))`: a stable fingerprint
 *     of the assembled catalog.
 *
 * @param input the pinned capabilities + installations (+ optional contract
 *              description lookup).
 * @returns the deterministic {@link ExecutionToolCatalog}.
 */
export function assembleExecutionToolCatalog(
  input: ExecutionToolCatalogInput,
): ExecutionToolCatalog {
  const describeContract = input.describeContract;

  // Pass 1 — platform entries. Track which logicalIds the platform owns so we
  // can detect collisions and let platform win (§11.2).
  const platformOwned = new Set<string>();
  for (const capability of input.capabilities) {
    for (const tool of capability.tools) {
      platformOwned.add(tool.logicalId);
    }
  }

  const platformEntries: CatalogToolEntry[] = [];
  for (const capability of input.capabilities) {
    for (const tool of capability.tools) {
      platformEntries.push(toCatalogEntryFromPlatform(tool, describeContract));
    }
  }

  // Pass 2 — module entries. Drop any whose logicalId the platform already
  // owns (collision: platform wins); record the collision.
  const collisions: string[] = [];
  const moduleEntries: CatalogToolEntry[] = [];
  for (const installation of input.installations) {
    for (const contribution of installation.toolContributions) {
      if (platformOwned.has(contribution.logicalId)) {
        if (!collisions.includes(contribution.logicalId)) {
          collisions.push(contribution.logicalId);
        }
        continue; // platform wins; module duplicate dropped
      }
      moduleEntries.push(
        toCatalogEntryFromModule(installation, contribution, describeContract),
      );
    }
  }

  // Merge + sort deterministically.
  const entries = [...platformEntries, ...moduleEntries].sort(compareCatalogEntries);

  // Deterministic fingerprint. canonicalJson guarantees stable key ordering,
  // so identical catalogs hash identically regardless of input order.
  const contentHash = sha256Hex(canonicalJson(entries));

  return Object.freeze({
    entries: Object.freeze(entries),
    platformCount: platformEntries.length,
    moduleCount: moduleEntries.length,
    collisions: Object.freeze([...collisions].sort()),
    contentHash,
  });
}

// ---------------------------------------------------------------------------
// findCatalogEntry — read-only lookup by logicalId.
// ---------------------------------------------------------------------------

/**
 * Find the first catalog entry whose `logicalId` equals `logicalId`, or
 * `undefined` if none. Pure linear scan over the already-sorted entries.
 *
 * Useful for gateway guard pre-checks (W6-A3) and PreToolUse projection
 * (W6-A4): "is this tool even in this execution's catalog?"
 */
export function findCatalogEntry(
  catalog: ExecutionToolCatalog,
  logicalId: string,
): CatalogToolEntry | undefined {
  for (const entry of catalog.entries) {
    if (entry.logicalId === logicalId) {
      return entry;
    }
  }
  return undefined;
}
