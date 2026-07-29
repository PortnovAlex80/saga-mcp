/**
 * W5-A1 — `WorkspaceProjection`: resolve skills/templates/checklists from a
 * PINNED immutable installation, NOT from a global skill root.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md`
 *       §1 (W5-A1 lane), §3 exit gate item 1, §0 key findings.
 * Task: `docs/refactor-management/05-subagent-tasks/W05-a1.md`.
 * Plan: §0.8.3 (W5-A1 owns pinned package resource resolution +
 *       WorkspaceProjection), §4.3.13 (WorkspaceProjectionPort),
 *       §5.3 (package resources are module-relative + co-located).
 *
 * ── What this replaces ────────────────────────────────────────────────────
 *
 * Pre-Wave-5, `process-execution-workspace.ts` materialized tracker/template
 * assets from `workspaceRoot` (the project tree) and resolved skills from the
 * GLOBAL skill root (the agent's `~/.<agent>/skills` dir or the runner's
 * built-in catalog). That made a node's effective skill/template/checklist
 * content depend on whatever happened to be installed on the executing machine
 * — two machines pinning the same `(module, version)` could surface different
 * prompt content. Wave 2 made module packages immutable + content-addressed;
 * Wave 5 closes the loop by resolving every node resource from the PINNED
 * installation record (W2-A2 `ModuleInstallationRecord`), via the Wave 2
 * `PackageRegistry` / `describeInstallation` surface. The pinned record's
 * `resourceIndex` + `storeLocation` are the single source of truth for "what
 * skill/template/checklist bytes does this node see" — no global skill root,
 * no machine-local lookup, no first-match.
 *
 * ── Purity / layering ─────────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/application/` (Runtime core
 * application layer). It is a PURE PROJECTION: no I/O, no filesystem, no
 * closures retained. It reads the pinned record's `resourceIndex` + the
 * manifest's flow + the execution profile, and returns deterministic,
 * canonically-serializable path strings. The actual byte materialization
 * (copying skill/template files into a per-execution workspace) is owned by
 * `process-execution-workspace.ts` + the W5-A6 claude-runner integration; this
 * module only tells them WHERE the pinned bytes live (`storeLocation` joined
 * with each resource's module-relative `path`).
 *
 * ── Dependency-direction ratchet (W0-A1) ──────────────────────────────────
 *
 * `application/` is Runtime core. Rule 4b forbids it from importing the
 * built-in module catalog (`modules/catalog.ts`, `modules/installations.ts`).
 * This file imports NONE of those. It imports only:
 *   - the Wave 2 installation barrel (`../installation/index.js`) — the
 *     `PackageRegistry` port, `InstallationBasedPackageRegistry` adapter,
 *     `describeInstallation`, `InstallationDescription`, and the
 *     `ModuleInstallationRecord` / `ModuleInstallationId` value types. The
 *     installation barrel is under `src/process-modules/installation/`, NOT
 *     `modules/`; Rule 4b does not flag it (the ratchet's catalog check is
 *     strictly `modules/catalog.ts` / `modules/installations.ts`).
 *   - the Wave 1 pure-SPI barrel (`../domain/spi/index.js`) — type-only: the
 *     `ResourceIndexEntry` / `ResourceKind` shapes the projection reads.
 *   - `../domain/process-module.js` — type-only: `ProcessModuleDefinition`,
 *     `FlowNodeDefinition`, `ExecutionProfileDefinition` (the flow + profile
 *     shapes already consumed by sibling `application/` files).
 *   - `node:path` — a node builtin (POSIX join for resource paths; same purity
 *     tier as `shared/canonical-json.ts`'s `node:crypto` use).
 *
 * It adds ZERO new ratchet edges: every target is either a node builtin, the
 * installation barrel (already an allowed application-layer dependency), the
 * pure-SPI barrel, or the existing pure `domain/process-module.js`.
 */

import path from 'node:path';

import type {
  PackageRegistry,
  ModuleInstallationRecord,
  ModuleInstallationId,
} from '../installation/index.js';
import type {
  InstallationDescription,
} from '../installation/index.js';
import { describeInstallation } from '../installation/index.js';
import type {
  ResourceIndexEntry,
  ResourceKind,
} from '../domain/spi/index.js';
import type {
  ProcessModuleDefinition,
  FlowNodeDefinition,
  ExecutionProfileDefinition,
} from '../domain/process-module.js';

// ---------------------------------------------------------------------------
// Error codes.
// ---------------------------------------------------------------------------

/**
 * The pinned `installationId` does not resolve to a known installation record
 * through the supplied registry. The pin is stale (the installation was
 * retired/removed) or the registry was wired against the wrong store.
 */
export const WORKSPACE_INSTALLATION_NOT_FOUND = 'WORKSPACE_INSTALLATION_NOT_FOUND';

/**
 * The pinned installation record exists but its `status` is not `'active'`.
 * Only active installations are selectable for new executions (W2-A5 §4); a
 * retired/corrupt/staged record must not silently produce a workspace.
 */
export const WORKSPACE_INSTALLATION_NOT_ACTIVE = 'WORKSPACE_INSTALLATION_NOT_ACTIVE';

/**
 * The node id does not name any node in the pinned installation's manifest
 * flow. The node may belong to a different module version than the one pinned.
 */
export const WORKSPACE_NODE_NOT_FOUND = 'WORKSPACE_NODE_NOT_FOUND';

/**
 * The named node is not an LM-operated node (`kind !== 'lm'`), so it has no
 * execution profile and no node-scoped skill/reviewer-skill to resolve.
 * Kernel/human/external/composite nodes do not carry an `executionProfile`.
 */
export const WORKSPACE_NODE_NOT_LM = 'WORKSPACE_NODE_NOT_LM';

/**
 * The LM node's `executionProfile` id does not match any profile declared on
 * the pinned module definition. The manifest is internally inconsistent.
 */
export const WORKSPACE_PROFILE_NOT_FOUND = 'WORKSPACE_PROFILE_NOT_FOUND';

/**
 * Thrown by `buildWorkspaceProjection` for any of the error codes above.
 * Callers SHOULD discriminate on {@link WorkspaceProjectionError.code}.
 */
export class WorkspaceProjectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkspaceProjectionError';
    this.code = code;
    // Restore prototype chain across the ES5/ES6 boundary (TS target ES2022
    // extends Error; keeps `instanceof` correct when re-thrown across module
    // boundaries).
    Object.setPrototypeOf(this, WorkspaceProjectionError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Id-based installation lookup.
// ---------------------------------------------------------------------------

/**
 * Narrow structural port for resolving an installation record by its pinned
 * primary key. The Wave 2 `PackageRegistry` port (W2-A5) resolves by
 * `ModuleSelector` (name + semver range); it does NOT expose `getById`. But a
 * pinned ProcessRun carries an `installation_id` (W2-A4), and a workspace
 * projection MUST resolve that exact pinned row — not re-resolve by name
 * (which could pick a different version after a retire/replace).
 *
 * The concrete `InstallationBasedPackageRegistry` (W2-A5) wraps a
 * `ModuleInstallationRepository` (W2-A2) whose `getById(id)` does exactly
 * this. Rather than widen the shared `PackageRegistry` port (owned by W2-A5)
 * or re-declare the repository port here, we declare this minimal structural
 * capability and type the projection's registry parameter as the intersection
 * `PackageRegistry & InstallationRecordById`. The composition root (Wave 11)
 * and the W5-A6 runner pass an `InstallationBasedPackageRegistry` bound to a
 * `SqliteModuleInstallationRepository`, which satisfies the intersection.
 *
 * Structural (not nominal): tests pass a plain object implementing both
 * `select`/`has`/`listSelectors` and `getById`; production passes the concrete
 * adapter. Either satisfies the intersection without adapter code.
 */
export interface InstallationRecordById {
  /**
   * Resolve the installation record by its pinned primary key, or `null` if no
   * row exists. MUST NOT perform module-name switching (plan §14.4.1) — the id
   * is exact.
   */
  getById(id: ModuleInstallationId): ModuleInstallationRecord | null;
}

/**
 * The registry capability `buildWorkspaceProjection` requires: everything the
 * Wave 2 `PackageRegistry` port offers (so callers can still use the registry
 * for selector-based work) PLUS id-based lookup of the pinned row.
 */
export type WorkspacePackageRegistry = PackageRegistry & InstallationRecordById;

// ---------------------------------------------------------------------------
// Resolved resource shapes.
// ---------------------------------------------------------------------------

/**
 * One resource identity resolved from the pinned installation. It deliberately
 * exposes no filesystem path: consumers fetch verified bytes through the
 * package-store port using the installation package digest and logical id.
 */
export interface ResolvedWorkspaceResource {
  /** Stable, module-namespaced logical id from the resource index. */
  readonly logicalId: string;
  /** Resource kind from the manifest (skill, template, checklist, ...). */
  readonly kind: ResourceKind;
  /** Verbatim module-relative POSIX path from the resource index. */
  readonly relativePath: string;
  /** Content digest (`sha256Hex`) of the resource bytes, from the index. */
  readonly digest: string;
}

/**
 * The skills an LM node needs, resolved from the pinned installation.
 *
 * `executionSkill` is the semantic role skill the agent runs AS while executing
 * the node (e.g. `saga-product`). `reviewerSkill` is the INDEPENDENT reviewer
 * skill selected when the projected task enters review (plan §13.18 — resolved
 * SEPARATELY from the execution skill, not as an alias). Either may be
 * `undefined` when the node's execution profile does not declare one; the
 * caller (W5-A6 runner) then applies its documented legacy fallback.
 *
 * Each skill is resolved by matching the profile's `executionSkill` /
 * `reviewerSkill` string against a `kind:'skill'` / `kind:'reviewer-skill'`
 * resource in the pinned `resourceIndex`. A profile may name a skill that is
 * NOT in the package (a built-in/global skill) — in that case the resource is
 * absent and only the skill NAME is surfaced (`*SkillName`), with the
 * `*SkillResource` left `undefined`. This preserves the pre-Wave-5 behavior
 * for global built-in skills while pinning every PACKAGE-DECLARED skill to the
 * installation.
 */
export interface ResolvedNodeSkills {
  /** The execution (author) skill name from the profile, if declared. */
  readonly executionSkillName?: string;
  /** The pinned package resource for the execution skill, if declared in-package. */
  readonly executionSkillResource?: ResolvedWorkspaceResource;
  /** The independent reviewer skill name from the profile, if declared. */
  readonly reviewerSkillName?: string;
  /** The pinned package resource for the reviewer skill, if declared in-package. */
  readonly reviewerSkillResource?: ResolvedWorkspaceResource;
}

/**
 * The projection result: every resource the node's workspace needs, resolved
 * from the pinned immutable installation. Pure data — canonically serializable
 * (no functions, no Maps/Sets, no class instances; plan §3.5).
 *
 * @property installationId    The pinned installation primary key resolved.
 * @property moduleRef         `name@version` of the pinned installation.
 * @property packageDigest     Content address of the pinned package bytes.
 * @property storeLocation     The immutable content-addressed package root.
 * @property nodeId            The flow node this projection was built for.
 * @property executionProfileId The profile id selected for the node.
 * @property skills            Execution + reviewer skills (names + in-package resources).
 * @property templates         Workspace/call templates (`kind:'template'`/`'mcp-call-template'`).
 * @property checklists        Checklist resources (`kind:'checklist'`).
 * @property instructions      Node instruction fragments (`kind:'instruction'`).
 * @property allResources      Every resource in the pinned index (incl. schemas,
 *                             error-hints, tests, descriptions) for diagnostics.
 * @property description       The W2-A7 `InstallationDescription` summary.
 */
export interface WorkspaceProjection {
  readonly installationId: ModuleInstallationId;
  readonly moduleRef: string;
  readonly packageDigest: string;
  readonly storeLocation: string;
  readonly nodeId: string;
  readonly executionProfileId: string;
  readonly skills: ResolvedNodeSkills;
  readonly templates: readonly ResolvedWorkspaceResource[];
  readonly checklists: readonly ResolvedWorkspaceResource[];
  readonly instructions: readonly ResolvedWorkspaceResource[];
  readonly allResources: readonly ResolvedWorkspaceResource[];
  readonly description: InstallationDescription;
}

// ---------------------------------------------------------------------------
// Helpers (module-local; not exported).
// ---------------------------------------------------------------------------

/**
 * Join the installation's `storeLocation` with a module-relative resource
 * path using POSIX forward slashes, defensively rejecting traversal/absolute
 * resource paths. The package store (W2-A1) already rejects these at install
 * time; this is belt-and-braces so a corrupt/edited manifest can never yield a
 * path that escapes the package root.
 *
 * Resource paths remain package-relative identities; adapter-private storage
 * layout never crosses this application boundary.
 */
/**
 * Build a resource identity from the immutable index. Consumers read bytes
 * through ModulePackageStore by package digest; store filesystem layout is an
 * adapter-private detail and is deliberately not projected as a path.
 */
function resolveResource(
  entry: ResourceIndexEntry,
): ResolvedWorkspaceResource {
  const normalized = entry.path.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(normalized)
    || normalized.split('/').includes('..')
  ) {
    throw new WorkspaceProjectionError(
      'WORKSPACE_RESOURCE_PATH_TRAVERSAL',
      `resource path '${entry.path}' is not package-relative`,
    );
  }
  return Object.freeze({
    logicalId: entry.logicalId,
    kind: entry.kind,
    relativePath: entry.path,
    digest: entry.digest,
  });
}

/**
 * Find the single resource of the given kind whose `logicalId` matches `name`.
 * Returns `undefined` when no in-package resource matches (the named skill may
 * be a global/built-in skill not shipped in the package). Pure.
 */
function findNamedResource(
  resources: readonly ResolvedWorkspaceResource[],
  kind: ResourceKind,
  name: string | undefined | null,
): ResolvedWorkspaceResource | undefined {
  if (!name || name.length === 0) return undefined;
  // Exact logicalId match first. A package may declare the skill under its
  // bare name (e.g. logicalId 'saga-product') or under a namespaced id; we
  // prefer the exact logicalId, then fall back to a basename match on the
  // resource path (skill files are commonly named `<skill>.md`).
  const exact = resources.find(
    (r) => r.kind === kind && r.logicalId === name,
  );
  if (exact) return exact;
  const baseName = name.endsWith('.md') ? name : `${name}.md`;
  const byBaseName = resources.find(
    (r) => r.kind === kind && path.posix.basename(r.relativePath) === baseName,
  );
  if (byBaseName) return byBaseName;
  const skillPathSuffix = `/skills/${name}/SKILL.md`;
  return resources.find(r =>
    r.kind === kind
    && `/${r.relativePath.replace(/\\/g, '/')}`.endsWith(skillPathSuffix),
  );
}

/**
 * Narrow a `FlowNodeDefinition` to its LM variant to read `executionProfile`.
 * Only LM nodes carry an execution profile; the other kinds are rejected by
 * the caller with `WORKSPACE_NODE_NOT_LM`. Pure type guard.
 */
function lmNodeOf(
  node: FlowNodeDefinition,
): { readonly executionProfile: string } | null {
  return node.kind === 'lm' ? node : null;
}

// ---------------------------------------------------------------------------
// buildWorkspaceProjection.
// ---------------------------------------------------------------------------

/**
 * Build a {@link WorkspaceProjection} for one LM node by resolving every
 * skill/template/checklist from the PINNED immutable installation identified by
 * `installationId`, via the supplied `packageRegistry`.
 *
 * Pure projection: no I/O, no side effects, no closures retained. Calling it
 * twice on the same `(installationId, nodeId, registry)` yields a structurally
 * equal projection (modulo the frozen readonly arrays).
 *
 * Resolution steps:
 *   1. `registry.getById(installationId)` → the pinned `ModuleInstallationRecord`.
 *      Throws `WORKSPACE_INSTALLATION_NOT_FOUND` if the id is unknown.
 *   2. Assert the record is `status === 'active'` (only active installations
 *      are selectable; throws `WORKSPACE_INSTALLATION_NOT_ACTIVE` otherwise).
 *   3. Resolve every `resourceIndex` entry to a {@link ResolvedWorkspaceResource}
 *      under the record's `storeLocation`.
 *   4. Find the flow node by `nodeId` in `manifestSnapshot.definition.flow.nodes`
 *      (throws `WORKSPACE_NODE_NOT_FOUND` if absent). Assert it is an LM node
 *      (throws `WORKSPACE_NODE_NOT_LM` for kernel/human/external/composite).
 *   5. Resolve the node's `executionProfile` id against
 *      `definition.executionProfiles` (throws `WORKSPACE_PROFILE_NOT_FOUND`).
 *   6. From the profile's `executionSkill` / `reviewerSkill`, resolve the
 *      `kind:'skill'` / `kind:'reviewer-skill'` resources (names always
 *      surfaced; in-package resources only when the package declares them).
 *   7. Partition the remaining resources into templates / checklists /
 *      instructions for the workspace + runner to materialize.
 *
 * @param installationId  The pinned installation primary key (W2-A4 pin).
 * @param nodeId          The flow node id to project resources for.
 * @param packageRegistry The Wave 2 registry, providing id-based record lookup
 *                        (`getById`) on top of selector-based selection.
 * @returns the deterministic {@link WorkspaceProjection}.
 * @throws {WorkspaceProjectionError} on any of the error codes above.
 */
export function buildWorkspaceProjection(
  installationId: ModuleInstallationId,
  nodeId: string,
  packageRegistry: WorkspacePackageRegistry,
): WorkspaceProjection {
  // Step 1 — resolve the pinned record by exact id. NOT by name: a pinned run
  // must see the exact installation it was started under, even if a newer
  // version has since been activated (retire/replace must not retroactively
  // change a running node's skill bytes).
  const record = packageRegistry.getById(installationId);
  if (record === null) {
    throw new WorkspaceProjectionError(
      WORKSPACE_INSTALLATION_NOT_FOUND,
      `${WORKSPACE_INSTALLATION_NOT_FOUND}: installation id=${installationId} is not registered`,
    );
  }

  // Step 2 — only active installations are selectable for new executions.
  if (record.status !== 'active' && record.status !== 'retired') {
    throw new WorkspaceProjectionError(
      WORKSPACE_INSTALLATION_NOT_ACTIVE,
      `${WORKSPACE_INSTALLATION_NOT_ACTIVE}: installation id=${installationId} (${record.name}@${record.version}) has status '${record.status}', expected 'active' or 'retired'`,
    );
  }

  // Step 3 — resolve every resource index entry under the immutable package root.
  const allResources: ResolvedWorkspaceResource[] = record.resourceIndex.map(
    (entry) => resolveResource(entry),
  );

  const manifest = record.manifestSnapshot;
  const definition: ProcessModuleDefinition = manifest.definition;
  const flow = definition.flow;

  // Step 4 — find the node.
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new WorkspaceProjectionError(
      WORKSPACE_NODE_NOT_FOUND,
      `${WORKSPACE_NODE_NOT_FOUND}: node '${nodeId}' is not in the flow of ${record.name}@${record.version} (known: ${flow.nodes.map((n) => n.id).join(', ')})`,
    );
  }

  // Step 5 — LM nodes carry an execution profile; other kinds do not.
  const lmNode = lmNodeOf(node);
  if (!lmNode) {
    throw new WorkspaceProjectionError(
      WORKSPACE_NODE_NOT_LM,
      `${WORKSPACE_NODE_NOT_LM}: node '${nodeId}' has kind '${node.kind}'; only 'lm' nodes carry an execution profile`,
    );
  }
  const profile: ExecutionProfileDefinition | undefined =
    definition.executionProfiles.find((p) => p.id === lmNode.executionProfile);
  if (!profile) {
    throw new WorkspaceProjectionError(
      WORKSPACE_PROFILE_NOT_FOUND,
      `${WORKSPACE_PROFILE_NOT_FOUND}: node '${nodeId}' references profile '${lmNode.executionProfile}' which is not declared by ${record.name}@${record.version}`,
    );
  }

  // Step 6 — resolve execution + reviewer skills from the pinned package.
  // Names are always surfaced (the profile declares them); in-package
  // resources are surfaced only when the package actually ships the skill.
  const executionSkillResource = findNamedResource(
    allResources,
    'skill',
    profile.executionSkill,
  );
  const reviewerSkillResource = findNamedResource(
    allResources,
    'reviewer-skill',
    profile.reviewSkill,
  );
  const skills: ResolvedNodeSkills = Object.freeze({
    executionSkillName: profile.executionSkill,
    executionSkillResource,
    reviewerSkillName:
      profile.reviewSkill === null ? undefined : profile.reviewSkill,
    reviewerSkillResource,
  });

  // Step 7 — partition package-declared templates / checklists / instructions.
  // These are the module-owned workspace assets the runner copies into the
  // per-execution directory. Schemas/error-hints/descriptions/tests stay in
  // `allResources` for diagnostics but are not partitioned into a named slot
  // (no current consumer needs them as a separate group).
  const templates = Object.freeze(
    allResources.filter(
      (r) => r.kind === 'template' || r.kind === 'mcp-call-template',
    ),
  );
  const checklists = Object.freeze(
    allResources.filter((r) => r.kind === 'checklist'),
  );
  const instructions = Object.freeze(
    allResources.filter((r) => r.kind === 'instruction'),
  );

  // The W2-A7 description is a small deterministic summary of the installation
  // (flow node count, outcome codes, resource/handler/tool counts, contract
  // refs). Surfaced for dashboards/diagnostics without re-reading package bytes.
  const description = describeInstallation(record);

  return Object.freeze({
    installationId: record.id,
    moduleRef: `${record.name}@${record.version}`,
    packageDigest: record.packageDigest,
    storeLocation: record.storeLocation,
    nodeId,
    executionProfileId: profile.id,
    skills,
    templates,
    checklists,
    instructions,
    allResources: Object.freeze([...allResources]),
    description,
  });
}
