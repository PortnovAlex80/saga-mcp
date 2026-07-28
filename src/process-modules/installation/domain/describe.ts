/**
 * W2-A7 — `describeInstallation` — pure read-only projection of a
 * {@link ModuleInstallationRecord} (plan §12.1).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 *        §1 row 14.
 * Task: `docs/refactor-management/05-subagent-tasks/W02-A7-3rd-synthetic-describe.md`.
 *
 * `describeInstallation(record)` is a PURE function: no I/O, no side effects,
 * no closures retained. It reads the persisted fields of an installation
 * record and produces an `InstallationDescription` — a small, deterministic,
 * serializable summary that operators, dashboards, and conformance tests can
 * consume without re-reading the package bytes or the manifest envelope.
 *
 * ── ModuleInstallationRecord — type-only sibling import ────────────────────
 *
 * `ModuleInstallationRecord` is owned by W2-A2 (`installation/domain/
 * installation.ts`). It is NOT present in this isolated W2-A7 worktree (W2-A2
 * lands at integration time). To keep this file PURELY type-only over the
 * sibling symbol AND still compile in isolation, we declare a local
 * structural alias — `InstallationRecordView` — that mirrors the frozen shape
 * from the W2-A2 task spec verbatim:
 *
 *   ModuleInstallationRecord {
 *     id; name; version; packageDigest;
 *     manifestSnapshot: ProcessModuleManifest;
 *     storeLocation;
 *     resourceIndex: readonly ResourceIndexEntry[];
 *     handlerRefs:    readonly HandlerRef[];
 *     dependencyLock: unknown;
 *     status; installedAt; activatedAt?; retiredAt?;
 *   }
 *
 * The alias is structurally identical to the real `ModuleInstallationRecord`,
 * so a real record value satisfies `InstallationRecordView` without any
 * adapter. The integrator unifies the alias with the real `import type` from
 * W2-A2 at cherry-pick time without touching any call site (same trick W1-A6's
 * `tool-contribution.ts` uses for `ToolContractRef` vs W1-A5's `ContractRef`).
 *
 * `describeInstallation` only reads `manifestSnapshot`, `resourceIndex`,
 * `handlerRefs`, `name`, `version`, `packageDigest`, and
 * `manifestSnapshot.toolContributions`. It never touches `status`, timestamps,
 * `storeLocation`, or `dependencyLock` — those are surfaced by other
 * projections.
 *
 * This file is PURE (plan §3.16): it imports only from sibling
 * `installation/domain/*` types (via the local alias above), from the Wave 1
 * pure SPI barrel (`domain/spi/index.js`), and from `domain/process-module.js`
 * (existing pure domain). No imports from application/, persistence/,
 * composition/, modules/, or infrastructure/ — Rule 5 of the
 * dependency-direction ratchet.
 */

// Wave 1 pure SPI barrel — type-only: the manifest + resource-index + handler
// ref shapes the description projects from. Type-only imports impose zero
// runtime dependency; they only constrain the projection's typing.
import type {
  ProcessModuleManifest,
  ResourceIndexEntry,
  HandlerRef,
  ContractRef,
  ModuleToolContribution,
  CapabilityRequirement,
} from '../../domain/spi/index.js';

// ---------------------------------------------------------------------------
// InstallationRecordView — local structural alias of W2-A2's
// ModuleInstallationRecord. See file header.
// ---------------------------------------------------------------------------

/**
 * Read-only view over a {@link ModuleInstallationRecord} (W2-A2) sufficient
 * for `describeInstallation`. Structurally identical to the real record, so a
 * real `ModuleInstallationRecord` value satisfies this view without any
 * adapter. The integrator replaces this alias with a real `import type` from
 * W2-A2 at cherry-pick time.
 *
 * Field semantics mirror the frozen W2-A2 contract verbatim:
 *
 * @property id              installation primary key (branded id type erased
 *                           to `string | number` here — describe does not care
 *                           about its brand).
 * @property name            module name (also on manifestSnapshot.definition
 *                           .identity.name — denormalized for queryability).
 * @property version         module version.
 * @property packageDigest   `sha256Hex` of canonical manifest+resources.
 * @property manifestSnapshot the persisted {@link ProcessModuleManifest}.
 * @property storeLocation   content-addressed filesystem path.
 * @property resourceIndex   resolved resources (post-install, with real
 *                           digests — NOT the manifest's possibly-placeholder
 *                           index).
 * @property handlerRefs     resolved handler references.
 * @property dependencyLock  opaque immutable lock document (W2-A3).
 * @property status          'staged' | 'validated' | 'active' | 'retired' | 'corrupt'.
 * @property installedAt     ISO timestamp.
 * @property activatedAt     optional ISO timestamp.
 * @property retiredAt       optional ISO timestamp.
 */
export interface InstallationRecordView {
  readonly id: string | number;
  readonly name: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly manifestSnapshot: ProcessModuleManifest;
  readonly storeLocation: string;
  readonly resourceIndex: readonly ResourceIndexEntry[];
  readonly handlerRefs: readonly HandlerRef[];
  readonly dependencyLock: unknown;
  readonly status: 'staged' | 'validated' | 'active' | 'retired' | 'corrupt';
  readonly installedAt: string;
  readonly activatedAt?: string;
  readonly retiredAt?: string;
}

// ---------------------------------------------------------------------------
// InstallationDescription — the pure projection result.
// ---------------------------------------------------------------------------

/**
 * Summary of the installed module's Flow: how many nodes, what distinct kinds,
 * and the outcome codes the module may emit.
 *
 * `nodeKinds` is the deduplicated, sorted set of `node.kind` values across
 * every node in the manifest's flow. Dedup + sort guarantee the summary is
 * deterministic regardless of node order in the source manifest.
 *
 * `outcomes` is the sorted list of `outcome.code` values declared on the
 * wrapped definition. Sorted for determinism.
 */
export interface FlowSummary {
  readonly nodeCount: number;
  readonly nodeKinds: readonly string[];
  readonly outcomes: readonly string[];
}

/**
 * Read-only description of an installed module (plan §12.1).
 *
 * Every field is derived deterministically from the persisted
 * {@link ModuleInstallationRecord}; the same record always yields the same
 * description. The description is canonically serializable (no functions, no
 * Maps/Sets, no class instances — plan §3.5) so it round-trips through
 * canonical JSON for storage or transport.
 *
 * @property name              module name.
 * @property version           module version.
 * @property packageDigest     `sha256Hex` of canonical manifest+resources.
 * @property flowSummary       node count, distinct node kinds, outcome codes.
 * @property resourceCount     number of resolved resources in `resourceIndex`.
 * @property handlerCount      number of resolved handler references.
 * @property toolCount         number of declared MCP tool contributions
 *                             (`manifestSnapshot.toolContributions`), or 0.
 * @property capabilityCount   number of declared capability requirements
 *                             (`manifestSnapshot.capabilityRequirements`), or 0.
 * @property inputContractRef  input contract ref (schemaId/version/digest).
 * @property outputContractRef output contract ref.
 */
export interface InstallationDescription {
  readonly name: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly flowSummary: FlowSummary;
  readonly resourceCount: number;
  readonly handlerCount: number;
  readonly toolCount: number;
  readonly capabilityCount: number;
  readonly inputContractRef: ContractRef;
  readonly outputContractRef: ContractRef;
}

// ---------------------------------------------------------------------------
// Helpers (module-local; not exported).
// ---------------------------------------------------------------------------

/**
 * Deduplicate + sort an array of strings into a frozen readonly tuple.
 * Returns the canonical deterministic ordering used by every `nodeKinds` /
 * `outcomes` projection.
 */
function dedupeSortedStrings(values: readonly string[]): readonly string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) {
      set.add(v);
    }
  }
  return Object.freeze([...set].sort());
}

// ---------------------------------------------------------------------------
// describeInstallation.
// ---------------------------------------------------------------------------

/**
 * Project a persisted {@link ModuleInstallationRecord} into a small,
 * deterministic, serializable {@link InstallationDescription}.
 *
 * Pure function (plan §12.1): no I/O, no side effects, no closures retained.
 * Calling it twice on the same record yields structurally-equal descriptions
 * (the determinism contract W2-A7's test asserts).
 *
 * Counts are read from the persisted record's resolved arrays:
 *   - `resourceCount`   ← `record.resourceIndex.length`
 *   - `handlerCount`    ← `record.handlerRefs.length`
 *   - `toolCount`       ← `record.manifestSnapshot.toolContributions?.length ?? 0`
 *   - `capabilityCount` ← `record.manifestSnapshot.capabilityRequirements?.length ?? 0`
 *
 * The flow summary reads `record.manifestSnapshot.definition.flow`:
 *   - `nodeCount`  ← `flow.nodes.length`
 *   - `nodeKinds`  ← deduped + sorted `node.kind` values
 *   - `outcomes`   ← sorted `outcome.code` values from `definition.outcomes`
 *
 * Contract refs are forwarded verbatim from the manifest snapshot.
 *
 * @param record the persisted installation record to project.
 * @returns the deterministic {@link InstallationDescription}.
 */
export function describeInstallation(
  record: InstallationRecordView,
): InstallationDescription {
  const manifest = record.manifestSnapshot;
  const definition = manifest.definition;
  const flow = definition.flow;

  const nodeKinds = dedupeSortedStrings(
    flow.nodes.map((node) => node.kind),
  );
  const outcomes = dedupeSortedStrings(
    definition.outcomes.map((outcome) => outcome.code),
  );

  const toolContributions: readonly ModuleToolContribution[] =
    manifest.toolContributions ?? [];
  const capabilityRequirements: readonly CapabilityRequirement[] =
    manifest.capabilityRequirements ?? [];

  return Object.freeze({
    name: record.name,
    version: record.version,
    packageDigest: record.packageDigest,
    flowSummary: Object.freeze({
      nodeCount: flow.nodes.length,
      nodeKinds,
      outcomes,
    }),
    resourceCount: record.resourceIndex.length,
    handlerCount: record.handlerRefs.length,
    toolCount: toolContributions.length,
    capabilityCount: capabilityRequirements.length,
    inputContractRef: manifest.inputContractRef,
    outputContractRef: manifest.outputContractRef,
  });
}
