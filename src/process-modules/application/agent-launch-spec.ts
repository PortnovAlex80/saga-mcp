/**
 * W3-A3 — `AgentLaunchSpec` + `resolveAgentLaunchSpec` (spec §6).
 *
 * Task: `docs/refactor-management/05-subagent-tasks/W03-A3-agent-launch-spec.md`.
 * Spec: `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md`
 *        §6 (W3-A3 — AgentLaunchSpec activation, after A2).
 *
 * Wave 3 closes the Wave 2 unfinished thread: `ProcessRunRecord` now carries
 * the nullable `installationId` + `packageDigest` pin (see
 * `persistence/process-run.ts`). This file is the EXECUTOR-FACING consumer of
 * that pin — it turns a `(ProcessRunRecord, FlowNodeDefinition)` pair into a
 * fully-resolved, package-pinned launch spec that the generic-flow executor
 * hands to the agent driver.
 *
 * Resolution rule (spec §6):
 *   - If `processRun.installationId` is NON-NULL → the run is pinned to an
 *     immutable module installation. Resolve the pinned package resources via
 *     the Wave 2 `PackageRegistry` (InstallationBasedPackageRegistry) — NOT the
 *     built-in catalog. The pinned `packageDigest` is verified against the
 *     resolved installation's digest; a mismatch is a corrupt-pin error.
 *     §14.3.7). Fall back to resolving the installation by the run's
 *     `moduleRef` (name + exact version) through the SAME `PackageRegistry`
 *     every run is pinned at start time.
 *
 * Why a single `PackageRegistry` port for both paths (not a catalog import):
 *   The dependency-direction ratchet (Rule 4, plan §3.6) treats a Runtime-core
 *   import of `modules/catalog.ts` as module-name switching in disguise. The
 *   existing `execution-profile-resolver.ts` catalog import is an ALLOWLISTED
 *   known violation pending the Phase 3 PackageRegistry cutover. Adding a
 *   SECOND catalog import here would be a NEW ratchet violation. Routing the
 *   wires over the `ModuleInstallationRepository`) keeps this file
 *   ratchet-clean: it depends only on the Wave 1 pure-SPI types + the Wave 2
 *   `PackageRegistry` port + the Wave 3 `ProcessRunRecord`. No `modules/`,
 *   no `persistence/` adapters, no `db.ts`.
 *
 * This file is PURE RESOLUTION (no I/O, no side effects beyond the injected
 * registry read). `resolveAgentLaunchSpec` is synchronous because the Wave 2
 * `PackageRegistry.select` is synchronous (sqlite UNIQUE-indexed lookup). It
 * throws `PACKAGE_NOT_INSTALLED` (re-raised by the registry) when no active
 * installation matches; the caller decides retry vs fail.
 *
 * Wave 3 scope: this file DEFINES the launch spec and resolver. It does NOT
 * wire the resolver into the generic-flow executor's hot path (that is the
 * Wave 11 cutover / Wave 5 CallInstance adoption). The resolver is exercised
 * by `tests/installation/agent-launch-spec.test.mjs`.
 */

import type { WorkspacePackageRegistry } from './workspace-projection.js';
import {
  asModuleInstallationId,
  type ModuleInstallationRecord,
} from '../installation/domain/installation.js';
import type {
  CapabilityRequirement,
} from '../domain/spi/tool-contribution.js';
import type {
  ResourceIndexEntry,
} from '../domain/spi/resource-index.js';
import type {
  FlowNodeDefinition,
} from '../domain/process-module.js';
import type { ProcessRunRecord } from '../persistence/process-run.js';

// ---------------------------------------------------------------------------
// AgentLaunchSpec — the fully-resolved, package-pinned launch descriptor.
// ---------------------------------------------------------------------------

/**
 * A single module-resource digest resolved against the pinned installation's
 * `resourceIndex`. The generic runtime surfaces these to the executing node so
 * it loads skills/templates/schemas by content hash (immutable) rather than by
 * a mutable module-relative path.
 */
export interface ResolvedResourceDigest {
  /** Stable, module-namespaced resource logicalId (from ResourceIndexEntry). */
  readonly logicalId: string;
  /** Resource kind (skill | template | schema | ...). Drives runtime dispatch. */
  readonly kind: string;
  /** `sha256Hex` of the resource bytes from the pinned installation's index. */
  readonly digest: string;
}

/**
 * The effective set of capabilities the resolved module REQUIRES from the
 * runtime for this node's execution profile. A structural projection of the
 * manifest's `capabilityRequirements` plus the profile's `allowedTools` — both
 * read from the pinned installation so a re-install cannot silently widen the
 * capability surface between two runs of the same idempotency key.
 */
export interface EffectiveCapabilitySet {
  /** Capability refs the module declares it needs (`optional` excluded). */
  readonly requiredCapabilityRefs: readonly string[];
  /** MCP tool ids the execution profile whitelists for the launching node. */
  readonly allowedToolIds: readonly string[];
}

/**
 * Which worker role the launching node plays. Read straight from the resolved
 * execution profile: `executionSkill` for the producing worker,
 * `reviewSkill` (when present) for the independent reviewer the dispatcher
 * generic-reviewer fallback.
 */
export interface AuthorOrReviewerRole {
  /** Composed/compatibility skill for the producing worker (never null). */
  readonly executionSkill: string;
  /**
   * Independent reviewer skill, or null when the module does not declare one
   * ExecutionProfileDefinition.reviewSkill.
   */
  readonly reviewSkill: string | null;
  /** Domain-specific semantic role skill for the node. */
  readonly semanticSkill: string;
  /** Reusable physical execution protocol skill (tracker/hooks/MCP/recovery). */
  readonly protocolSkill: string;
}

/**
 * Driver configuration the executor passes to the `AgentDriverRegistry` to
 * instantiate the right agent driver for this node. `driverName` is the lookup
 * key under which a factory was registered (e.g. 'saga-board-claude'); the
 * remaining fields are the inputs the driver needs to launch one node attempt.
 */
export interface AgentDriverConfig {
  /** Registered driver factory name (AgentDriverRegistry.resolve key). */
  readonly driverName: string;
  /** Execution mode from the profile (git_change | tracker_only | ...). */
  readonly executionMode: string;
  /** Tracker template id (null = no tracker task scaffolded). */
  readonly trackerTemplate: string | null;
}

/**
 * The fully-resolved, package-pinned launch descriptor for ONE node of ONE
 * ProcessRun. Every field is derived deterministically from the pinned module
 * installation). Two resolutions of the same `(processRun, node)` MUST yield
 * structurally-equal specs — the test asserts this determinism.
 *
 * @property installationId          The ProcessRun's installation pin (nullable
 *                                   the record so the executor can tell pinned
 * @property packageDigest           The pinned package digest (nullable for
 *                                   installation's digest on the pinned path.
 * @property nodeId                  The flow node id being launched.
 * @property executionProfileId      The profile id this node executes under
 *                                   (LmFlowNodeDefinition.executionProfile).
 *                                   Null for non-lm nodes (kernel/human/
 *                                   external/composite have no profile).
 * @property nodeProtocolId          Stable protocol identity for the node,
 *                                   derived from (module, node). The concrete
 *                                   ProtocolRun state machine is Wave 4.
 * @property resolvedResourceDigests Module resources from the pinned
 *                                   installation's resourceIndex, projected to
 *                                   {logicalId, kind, digest}. Empty for
 *                                   installations with no resources.
 * @property effectiveCapabilitySet  Required capability refs + the profile's
 *                                   allowed tool ids, both from the pinned
 *                                   manifest.
 * @property authorOrReviewerRole    The execution/review/semantic/protocol
 *                                   skills the dispatcher and prompt builder
 *                                   consume.
 * @property driverConfig            Driver name + execution mode + tracker
 *                                   template for the AgentDriverRegistry.
 */
export interface AgentLaunchSpec {
  readonly installationId: number | null;
  readonly packageDigest: string | null;
  readonly nodeId: string;
  readonly executionProfileId: string | null;
  readonly nodeProtocolId: string;
  readonly resolvedResourceDigests: readonly ResolvedResourceDigest[];
  readonly effectiveCapabilitySet: EffectiveCapabilitySet;
  readonly authorOrReviewerRole: AuthorOrReviewerRole;
  readonly driverConfig: AgentDriverConfig;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Raised on the PINNED path when the ProcessRun's persisted `packageDigest`
 * does not match the digest of the installation resolved by `installationId`.
 * This means the pin is corrupt (the installation row was mutated, or the run
 * row's denormalized digest drifted). The caller MUST surface this loudly — a
 * silent mismatch would let a re-install change the executed code under a
 * stable idempotency key.
 */
export const PROCESS_RUN_PIN_DIGEST_MISMATCH = 'PROCESS_RUN_PIN_DIGEST_MISMATCH';

// ---------------------------------------------------------------------------
// Resolver.
// ---------------------------------------------------------------------------

/**
 * Resolve a fully package-pinned {@link AgentLaunchSpec} for one node of one
 * ProcessRun (spec §6).
 *
 * Resolution path:
 *   1. Read `processRun.installationId`.
 *   2. If NON-NULL (pinned run): select the installation by EXACT version via
 *      `registry.select({ name, versionRange: moduleRef.version })`, then
 *      VERIFY the resolved record's `id` matches the pinned `installationId`
 *      AND its `packageDigest` matches the pinned digest. A mismatch throws
 *      {@link PROCESS_RUN_PIN_DIGEST_MISMATCH}.
 *      `moduleRef` (name + exact version) through the SAME registry. This is
 *   4. Project the resolved installation's manifest + resourceIndex +
 *      capabilityRequirements into the {@link AgentLaunchSpec}.
 *
 * The resolver is synchronous: `PackageRegistry.select` is a synchronous
 * sqlite UNIQUE-indexed lookup. It throws `PACKAGE_NOT_INSTALLED` (from the
 * registry) when no active installation matches the selector.
 *
 * @param processRun The ProcessRun carrying the installation pin.
 * @param node       The flow node being launched (its `executionProfile` names
 *                   the profile for lm nodes; non-lm nodes yield a null
 *                   `executionProfileId`).
 * @param registry   Wave 2 PackageRegistry — the single resolution surface for
 * @returns the fully-resolved, package-pinned launch spec.
 */
export function resolveAgentLaunchSpec(
  processRun: ProcessRunRecord,
  node: FlowNodeDefinition,
  registry: WorkspacePackageRegistry,
): AgentLaunchSpec {
  const installation = resolveInstallation(processRun, registry);
  const manifest = installation.manifestSnapshot;
  const definition = manifest.definition;

  // The execution profile id is meaningful only for lm nodes; non-lm nodes
  // (kernel/human/external/composite) have no profile and no agent skill.
  const executionProfileId = node.kind === 'lm' ? node.executionProfile : null;
  const profile = executionProfileId === null
    ? null
    : definition.executionProfiles.find((p) => p.id === executionProfileId) ?? null;

  // Resource digests come straight from the pinned installation's resourceIndex
  // (post-install, with REAL content digests — never the manifest's possible
  // 'pending@wave-2' placeholders, which the installer replaced at install).
  const resolvedResourceDigests: ResolvedResourceDigest[] = installation.resourceIndex.map(
    (entry: ResourceIndexEntry) => ({
      logicalId: entry.logicalId,
      kind: entry.kind,
      digest: entry.digest,
    }),
  );

  // Effective capability set: required capability refs (optional excluded) +
  // the profile's allowed tool ids. When the node has no profile (non-lm), the
  // allowed-tool surface is empty and only module-level capabilities apply.
  const capabilityRequirements: readonly CapabilityRequirement[] =
    manifest.capabilityRequirements ?? [];
  const requiredCapabilityRefs = capabilityRequirements
    .filter((c) => !c.optional)
    .map((c) => c.ref);
  const allowedToolIds = profile === null ? [] : [...profile.allowedTools];

  // Author/reviewer role + driver config come from the resolved profile. For
  // non-lm nodes (no profile) we surface empty skill strings and a null
  // tracker template — the executor does not launch an agent for those.
  const authorOrReviewerRole: AuthorOrReviewerRole = profile === null
    ? {
        executionSkill: '',
        reviewSkill: null,
        semanticSkill: '',
        protocolSkill: '',
      }
    : {
        executionSkill: profile.executionSkill,
        reviewSkill: profile.reviewSkill ?? null,
        semanticSkill: profile.semanticSkill,
        protocolSkill: profile.protocolSkill,
      };
  const driverConfig: AgentDriverConfig = profile === null
    ? { driverName: '', executionMode: '', trackerTemplate: null }
    : {
        driverName: resolveDriverName(node),
        executionMode: profile.executionMode,
        trackerTemplate: profile.trackerTemplate,
      };

  return Object.freeze({
    installationId: processRun.installationId,
    packageDigest: processRun.packageDigest,
    nodeId: node.id,
    executionProfileId,
    nodeProtocolId: resolveNodeProtocolId(processRun, node),
    resolvedResourceDigests: Object.freeze(resolvedResourceDigests),
    effectiveCapabilitySet: Object.freeze({
      requiredCapabilityRefs: Object.freeze([...requiredCapabilityRefs]),
      allowedToolIds: Object.freeze(allowedToolIds),
    }),
    authorOrReviewerRole,
    driverConfig,
  });
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Resolve the {@link ModuleInstallationRecord} for a ProcessRun, following the
 * spec §6 dual path. Extracted so the digest-verification guard on the pinned
 * path is auditable in one place.
 *
 * PINNED path (installationId !== null):
 *   Select by EXACT version, then verify both the id AND the packageDigest
 *   match the pin. A digest mismatch is a corrupt pin — the run row's
 *   denormalized digest drifted from the installation's real digest.
 *
 *   Select by `moduleRef` (name + exact version) through the same registry.
 *   The resolved installation's digest becomes the de-facto pin for this
 *   resolution; the launch spec surfaces the run's null pin unchanged.
 */
function resolveInstallation(
  processRun: ProcessRunRecord,
  registry: WorkspacePackageRegistry,
): ModuleInstallationRecord {
  if (processRun.installationId === null || processRun.packageDigest === null) {
    throw new Error(
      'PROCESS_RUN_PIN_REQUIRED: worker launch is forbidden for an unpinned ProcessRun',
    );
  }
  const resolved = registry.getById(asModuleInstallationId(processRun.installationId));
  if (resolved === null) {
    throw new Error(
      `${PROCESS_RUN_PIN_DIGEST_MISMATCH}: process_run ${processRun.id} is pinned to `
      + `missing installation_id=${processRun.installationId}.`,
    );
  }
  if (resolved.status !== 'active' && resolved.status !== 'retired') {
    throw new Error(
      `${PROCESS_RUN_PIN_DIGEST_MISMATCH}: process_run ${processRun.id} is pinned to `
      + `installation_id=${processRun.installationId} with unusable status=${resolved.status}.`,
    );
  }
  if (resolved.name !== processRun.moduleRef.name
      || resolved.version !== processRun.moduleRef.version
      || resolved.packageDigest !== processRun.packageDigest) {
    throw new Error(
      `${PROCESS_RUN_PIN_DIGEST_MISMATCH}: process_run ${processRun.id} is pinned to `
      + `installation_id=${processRun.installationId} `
      + `package_digest=<${processRun.packageDigest.slice(0, 12)}…> `
      + `but exact installation_id=${resolved.id} has `
      + `module=${resolved.name}@${resolved.version} `
      + `package_digest=<${resolved.packageDigest.slice(0, 12)}…>. The pin is corrupt.`,
    );
  }
  return resolved;
}

/**
 * Derive a stable protocol identity for a node. The concrete ProtocolRun state
 * machine is Wave 4; Wave 3 only needs a deterministic, content-stable id so
 * two resolutions of the same (run, node) yield the same string.
 *
 * Shape: `<moduleKey>#<nodeId>` — namespaced by the module so the same node id
 * in two different modules never collides.
 */
function resolveNodeProtocolId(
  processRun: ProcessRunRecord,
  node: FlowNodeDefinition,
): string {
  return `${processRun.moduleRefKey}#${node.id}`;
}

/**
 * Resolve the agent driver name for a node. Wave 2 defines the
 * `AgentDriverRegistry` port; the composition root binds concrete factories
 * (e.g. 'saga-board-claude'). Wave 3 ships a single driver name for lm nodes;
 * non-lm nodes get an empty string (the executor does not launch an agent).
 *
 * This is the one place the resolver picks a driver identity. Keeping it in a
 * named function makes a future Wave-7 policy-driven driver selection a
 * single-call-site change.
 */
function resolveDriverName(node: FlowNodeDefinition): string {
  // Only lm nodes launch an agent driver today. Kernel/human/external nodes
  // are handled by their own executor paths (kernel handler, human
  // interaction registry, external adapter) and do not consume an
  // AgentDriverConfig.
  return node.kind === 'lm' ? 'saga-board-claude' : '';
}
