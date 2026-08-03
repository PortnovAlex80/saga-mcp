/**
 * Versioned platform Capability Packages for shared MCP tools.
 *
 * This module defines the versioned platform Capability Packages: the shared
 * MCP tool bundles the Runtime contributes on its own behalf (NOT module-
 * owned). They declare, as `ModuleToolContribution`s, the legacy shared tools
 * the platform has always surfaced — `task_*`, `artifact_*`, `trace_*`,
 * `repository_*`, `worker_*` — plus the protocol checkpoint tool. Packaging
 * them as Capability Packages lets the `tool-contribution-installer` install
 * them through the SAME namespace/collision/validation pipeline as module-
 * contributed tools, so the gateway no longer needs a hand-maintained
 * `ALL_TOOLS` array.
 *
 * See `docs/architecture/WAVE-LOG.md` (Wave 6) for the contributable-surface
 * history.
 *
 * # What a Capability Package is
 *
 * A `CapabilityPackage` is a pure, serializable description of ONE versioned
 * bundle of runtime-owned tools. It carries:
 *   - `capabilityId`  — logical capability identity (`'platform.tasks'`).
 *   - `version`       — the package's own semantic version.
 *   - `runtimeCompatibilityRange` — semver range of the Runtime API the
 *                       package requires (mirrors `ProcessModuleManifest`).
 *   - `tools`         — the `ModuleToolContribution`s the package surfaces.
 *
 * The package is pure data: it declares tools but binds no handler (handlers
 * are bound by the composition root, exactly as for module contributions).
 *
 * # Why these five packages
 *
 * The five shared-tool surfaces map onto the legacy tool families in
 * `src/tools/*.ts` plus the protocol tool:
 *   - `platform.tasks`               → task_create/list/get/update
 *   - `platform.artifact-graph`      → artifact_create/get/list/update,
 *                                       trace_add/list/delete, artifact_coverage
 *   - `platform.repository`          → repository_register/list/get/update,
 *                                       repository_checkout_*
 *   - `platform.worker-completion`   → worker_done/ask_need/ask_done,
 *                                       worker_merge_acquire/release, worker_health
 *                                       (worker_next EXCLUDED: one launch = one
 *                                       card)
 *   - `platform.protocol-checkpoint` → runtime.protocol.step_complete
 *
 * Each tool's `idempotency` / `sideEffect` classification is derived from the
 * tool's READ vs WRITE vs IDEMPOTENT semantics (the same classification the
 * SPI `ToolIdempotency` / `ToolSideEffect` enums express). These are the ONLY
 * fields the gateway guard and the contribution installer switch on — so
 * declaring them here moves the classification off the hardcoded gateway path
 * and onto the contributed, versioned surface.
 *
 * # Dependency direction (Rule 4b ratchet)
 *
 * This file lives under `src/process-modules/application/`, which the
 * dependency-direction ratchet treats as Runtime core (Rule 4b: application/
 * must not import the built-in module catalog). It imports ONLY from:
 *   - the pure SPI barrel (`../domain/spi/index.js`) — pure types + the
 *     `CONTRACT_REF_PENDING_DIGEST` placeholder + the tool-contribution
 *     validator;
 *   - the protocol-checkpoint service (`./protocol-checkpoint-service.js`)
 *     — a sibling application file, to re-use its already-declared
 *     `protocol_step_complete` contribution rather than re-declaring it.
 *
 * It does NOT import from `modules/`, `composition/`, `persistence/` adapters,
 * `infrastructure/`, `src/db.ts`, or the module catalog. It switches on NO
 * module names. Pure data + pure helpers only.
 */

import type {
  ModuleToolContribution,
  ToolContractRef,
  ToolIdempotency,
  ToolSideEffect,
} from '../domain/spi/tool-contribution.js';
import { CONTRACT_REF_PENDING_DIGEST } from '../domain/spi/contract-ref.js';
import { buildProtocolStepCompleteToolContribution } from './protocol-checkpoint-service.js';

// ---------------------------------------------------------------------------
// Package format version + schema-id conventions.
// ---------------------------------------------------------------------------

/**
 * Format version of the `CapabilityPackage` envelope (independent of any
 * package's own `version`). Uses `'0.1.0'`, mirroring the manifest envelope
 * convention.
 */
export const CAPABILITY_PACKAGE_FORMAT_VERSION = '0.1.0' as const;

/**
 * Version of every platform capability package. Bumped when a package's tool
 * set, classification, or contract refs change. The gateway guard keys
 * authority off `(capabilityId, version)` pairs; bumping the version is how a
 * breaking change to a shared tool is surfaced as a collision the installer
 * catches rather than a silent behavior shift.
 */
export const PLATFORM_CAPABILITY_PACKAGE_VERSION = '1.0.0' as const;

/**
 * Stable, content-neutral contract-ref version carried on every platform tool
 * contribution. Real per-schema digests are pinned by the ContractSchemaRegistry
 * at install time; until then contributions carry the platform placeholder
 * digest (`CONTRACT_REF_PENDING_DIGEST`), exactly as
 * `buildProtocolStepCompleteToolContribution` does. This keeps contributions
 * canonical-serializable without inventing fake hashes.
 */
const PLATFORM_CONTRACT_VERSION = PLATFORM_CAPABILITY_PACKAGE_VERSION;

/**
 * Build a provisional `ToolContractRef` for a platform tool. Mirrors the
 * protocol-checkpoint service's `provisionalContractRef` helper, but lives
 * here so the five platform packages declare their contract refs uniformly.
 * The placeholder digest is the documented pending token; the gateway treats
 * contract refs as opaque identity (authority keys off logicalId, not digest).
 */
function platformContractRef(schemaId: string): ToolContractRef {
  return Object.freeze({
    schemaId,
    version: PLATFORM_CONTRACT_VERSION,
    digest: CONTRACT_REF_PENDING_DIGEST,
  });
}

// ---------------------------------------------------------------------------
// CapabilityPackage — the versioned platform bundle envelope.
// ---------------------------------------------------------------------------

/**
 * One versioned platform Capability Package: a named, semver-stamped bundle of
 * runtime-owned MCP tool contributions.
 *
 * Pure, canonically-serializable data. The package declares tools but binds no
 * handler — the composition root binds handlers (the existing
 * `src/tools/*.ts` handlers, or `applyCheckpoint` for the protocol tool) when
 * it installs the package via the contribution installer.
 *
 * @property formatVersion             Envelope format version
 *                                     ({@link CAPABILITY_PACKAGE_FORMAT_VERSION}).
 * @property capabilityId              Logical capability identity, namespaced
 *                                     under `platform.*` (Runtime-owned, never
 *                                     module-owned).
 * @property version                   Package semantic version.
 * @property runtimeCompatibilityRange Semver range of the Runtime API the
 *                                     package requires.
 * @property tools                     The {@link ModuleToolContribution}s the
 *                                     package surfaces. Each has a unique
 *                                     `logicalId`.
 * @property description               Human-readable summary (prose; not parsed
 *                                     by the runtime).
 */
export interface CapabilityPackage {
  readonly formatVersion: typeof CAPABILITY_PACKAGE_FORMAT_VERSION;
  readonly capabilityId: string;
  readonly version: string;
  readonly runtimeCompatibilityRange: string;
  readonly tools: readonly ModuleToolContribution[];
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Internal tool-contribution builder.
// ---------------------------------------------------------------------------

/**
 * Classification of one platform tool: its idempotency and side-effect
 * semantics. These map 1:1 onto the SPI enums and are the ONLY classification
 * fields the gateway guard switches on, so centralizing them here removes
 * hardcoded gateway branching.
 */
interface PlatformToolClass {
  readonly idempotency: ToolIdempotency;
  readonly sideEffect: ToolSideEffect;
}

/**
 * Build one platform `ModuleToolContribution`. The handler reference is opaque
 * to the SPI validator; the composition root resolves it to the matching
 * `src/tools/*.ts` handler (or `applyCheckpoint` for the protocol tool).
 *
 * `logicalId` is namespaced under `platform.<surface>.<verb>` so platform
 * tools never collide with module-contributed tools (namespaced under their
 * module identity, e.g. `discovery.proposal_submit`).
 *
 * Contract refs use the platform placeholder digest (see
 * {@link platformContractRef}); guard bindings are empty — the gateway guard
 * attaches authority to the `'call'` scope when wired.
 */
function platformTool(
  logicalId: string,
  schemaId: string,
  classification: PlatformToolClass,
): ModuleToolContribution {
  return {
    logicalId,
    version: PLATFORM_CAPABILITY_PACKAGE_VERSION,
    inputContractRef: platformContractRef(`${schemaId}.input`),
    outputContractRef: platformContractRef(`${schemaId}.output`),
    handlerRef: `platform:${logicalId}`,
    guardBindings: [],
    idempotency: classification.idempotency,
    sideEffect: classification.sideEffect,
  };
}

// Read-only tools: idempotent reads, no side effects.
const READ: PlatformToolClass = Object.freeze({
  idempotency: 'idempotent',
  sideEffect: 'read',
});

// Write tools: non-idempotent writes (each call mutates state distinctly).
const WRITE: PlatformToolClass = Object.freeze({
  idempotency: 'none',
  sideEffect: 'write',
});

// Idempotent writes: re-calling with the same args is a safe replay.
const IDEMPOTENT_WRITE: PlatformToolClass = Object.freeze({
  idempotency: 'idempotent',
  sideEffect: 'write',
});

// ---------------------------------------------------------------------------
// Package: platform.tasks
// ---------------------------------------------------------------------------

/**
 * Stable logical id for the tasks capability package. Namespace `platform.*`
 * marks it Runtime-owned; the contribution installer reserves this namespace
 * for the platform so a module cannot squat it.
 */
export const PLATFORM_TASKS_CAPABILITY_ID = 'platform.tasks' as const;

/**
 * Schema-id stem for the tasks tools. Each tool contributes two contract refs
 * (`<stem>.input` / `<stem>.output`); the full ids are per-tool
 * (`platform.tasks.task_create`, etc.).
 */
const TASKS_SCHEMA_STEM = 'saga3.platform.tasks';

function buildTasksPackage(): CapabilityPackage {
  const tools: readonly ModuleToolContribution[] = [
    platformTool('platform.tasks.task_create', `${TASKS_SCHEMA_STEM}.task_create`, WRITE),
    platformTool('platform.tasks.task_list', `${TASKS_SCHEMA_STEM}.task_list`, READ),
    platformTool('platform.tasks.task_get', `${TASKS_SCHEMA_STEM}.task_get`, READ),
    platformTool('platform.tasks.task_update', `${TASKS_SCHEMA_STEM}.task_update`, WRITE),
  ];
  return Object.freeze({
    formatVersion: CAPABILITY_PACKAGE_FORMAT_VERSION,
    capabilityId: PLATFORM_TASKS_CAPABILITY_ID,
    version: PLATFORM_CAPABILITY_PACKAGE_VERSION,
    runtimeCompatibilityRange: '^3.0.0',
    tools: Object.freeze([...tools]),
    description:
      'Platform tasks capability: task_create / task_list / task_get / task_update '
      + '(the shared tracker task surface every managed worker operates on).',
  });
}

// ---------------------------------------------------------------------------
// Package: platform.artifact-graph
// ---------------------------------------------------------------------------

export const PLATFORM_ARTIFACT_GRAPH_CAPABILITY_ID =
  'platform.artifact-graph' as const;

const ARTIFACT_GRAPH_SCHEMA_STEM = 'saga3.platform.artifact-graph';

function buildArtifactGraphPackage(): CapabilityPackage {
  const tools: readonly ModuleToolContribution[] = [
    platformTool(
      'platform.artifact-graph.artifact_create',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.artifact_create`,
      IDEMPOTENT_WRITE, // idempotent on (epic_id, code, path)
    ),
    platformTool(
      'platform.artifact-graph.artifact_get',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.artifact_get`,
      READ,
    ),
    platformTool(
      'platform.artifact-graph.artifact_list',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.artifact_list`,
      READ,
    ),
    platformTool(
      'platform.artifact-graph.artifact_update',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.artifact_update`,
      WRITE,
    ),
    platformTool(
      'platform.artifact-graph.trace_add',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.trace_add`,
      WRITE,
    ),
    platformTool(
      'platform.artifact-graph.trace_list',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.trace_list`,
      READ,
    ),
    platformTool(
      'platform.artifact-graph.trace_delete',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.trace_delete`,
      WRITE,
    ),
    platformTool(
      'platform.artifact-graph.artifact_coverage',
      `${ARTIFACT_GRAPH_SCHEMA_STEM}.artifact_coverage`,
      READ,
    ),
  ];
  return Object.freeze({
    formatVersion: CAPABILITY_PACKAGE_FORMAT_VERSION,
    capabilityId: PLATFORM_ARTIFACT_GRAPH_CAPABILITY_ID,
    version: PLATFORM_CAPABILITY_PACKAGE_VERSION,
    runtimeCompatibilityRange: '^3.0.0',
    tools: Object.freeze([...tools]),
    description:
      'Platform artifact-graph capability: artifact_create/get/list/update, '
      + 'trace_add/list/delete, artifact_coverage — the requirements traceability '
      + 'graph shared across every formalization/verification episode.',
  });
}

// ---------------------------------------------------------------------------
// Package: platform.repository
// ---------------------------------------------------------------------------

export const PLATFORM_REPOSITORY_CAPABILITY_ID = 'platform.repository' as const;

const REPOSITORY_SCHEMA_STEM = 'saga3.platform.repository';

function buildRepositoryPackage(): CapabilityPackage {
  const tools: readonly ModuleToolContribution[] = [
    // register is idempotent by (project_id, name).
    platformTool(
      'platform.repository.repository_register',
      `${REPOSITORY_SCHEMA_STEM}.repository_register`,
      IDEMPOTENT_WRITE,
    ),
    platformTool(
      'platform.repository.repository_list',
      `${REPOSITORY_SCHEMA_STEM}.repository_list`,
      READ,
    ),
    platformTool(
      'platform.repository.repository_get',
      `${REPOSITORY_SCHEMA_STEM}.repository_get`,
      READ,
    ),
    platformTool(
      'platform.repository.repository_update',
      `${REPOSITORY_SCHEMA_STEM}.repository_update`,
      WRITE,
    ),
    platformTool(
      'platform.repository.repository_checkout_register',
      `${REPOSITORY_SCHEMA_STEM}.repository_checkout_register`,
      IDEMPOTENT_WRITE,
    ),
    platformTool(
      'platform.repository.repository_checkout_list',
      `${REPOSITORY_SCHEMA_STEM}.repository_checkout_list`,
      READ,
    ),
    // bootstrap performs a git clone — an external side effect.
    platformTool(
      'platform.repository.repository_checkout_bootstrap',
      `${REPOSITORY_SCHEMA_STEM}.repository_checkout_bootstrap`,
      { idempotency: 'none', sideEffect: 'external' },
    ),
  ];
  return Object.freeze({
    formatVersion: CAPABILITY_PACKAGE_FORMAT_VERSION,
    capabilityId: PLATFORM_REPOSITORY_CAPABILITY_ID,
    version: PLATFORM_CAPABILITY_PACKAGE_VERSION,
    runtimeCompatibilityRange: '^3.0.0',
    tools: Object.freeze([...tools]),
    description:
      'Platform repository capability: repository_register/list/get/update and '
      + 'the checkout_register/list/bootstrap surface binding logical product '
      + 'projects to physical git repositories and machine worktrees.',
  });
}

// ---------------------------------------------------------------------------
// Package: platform.worker-completion
// ---------------------------------------------------------------------------

export const PLATFORM_WORKER_COMPLETION_CAPABILITY_ID =
  'platform.worker-completion' as const;

const WORKER_SCHEMA_STEM = 'saga3.platform.worker-completion';

function buildWorkerCompletionPackage(): CapabilityPackage {
  // `worker_next` is intentionally REMOVED from the assigned-worker capability
  // package. "One launch = one card": a worker that already holds an assigned
  // execution must NOT be granted the self-claim tool. The dispatcher
  // (`saga-dispatch`, the board runner) does not pull `worker_next` from THIS
  // package — it invokes the raw MCP tool directly — so dropping it here
  // breaks no dispatcher surface. The remaining six tools are the completion
  // / ask / merge / health surface an assigned worker legitimately needs to
  // finish the ONE card it was launched with.
  //
  // The server-side fence rejection in handleWorkerNext (src/tools/dispatcher.ts)
  // is the hard guarantee: even if a client reacquires worker_next through some
  // other path, an execution that already holds a card is rejected before the
  // queue is read. This package change removes the platform-level GRANT so the
  // tool is not advertised to assigned workers in the first place.
  const tools: readonly ModuleToolContribution[] = [
    platformTool(
      'platform.worker-completion.worker_done',
      `${WORKER_SCHEMA_STEM}.worker_done`,
      IDEMPOTENT_WRITE, // terminal advance: replay-safe per execution_id fence
    ),
    platformTool(
      'platform.worker-completion.worker_ask_need',
      `${WORKER_SCHEMA_STEM}.worker_ask_need`,
      IDEMPOTENT_WRITE, // terminal park: fenced by execution_id
    ),
    platformTool(
      'platform.worker-completion.worker_ask_done',
      `${WORKER_SCHEMA_STEM}.worker_ask_done`,
      IDEMPOTENT_WRITE, // answer records + reopens; fenced
    ),
    platformTool(
      'platform.worker-completion.worker_merge_acquire',
      `${WORKER_SCHEMA_STEM}.worker_merge_acquire`,
      IDEMPOTENT_WRITE, // merge-lock acquire: idempotent per lock holder
    ),
    platformTool(
      'platform.worker-completion.worker_merge_release',
      `${WORKER_SCHEMA_STEM}.worker_merge_release`,
      WRITE, // release records outcome; distinct outcomes are distinct calls
    ),
    platformTool(
      'platform.worker-completion.worker_health',
      `${WORKER_SCHEMA_STEM}.worker_health`,
      READ,
    ),
  ];
  return Object.freeze({
    formatVersion: CAPABILITY_PACKAGE_FORMAT_VERSION,
    capabilityId: PLATFORM_WORKER_COMPLETION_CAPABILITY_ID,
    version: PLATFORM_CAPABILITY_PACKAGE_VERSION,
    runtimeCompatibilityRange: '^3.0.0',
    tools: Object.freeze([...tools]),
    description:
      'Platform worker-completion capability: the assigned-worker completion '
      + 'fence (worker_done/ask_need/ask_done) plus the merge-lock protocol '
      + '(worker_merge_acquire/release) and worker_health. worker_next is '
      + 'intentionally EXCLUDED — one launch = one card; an assigned worker '
      + 'must not re-enter the dispatch queue. The dispatcher surface '
      + 'invokes worker_next as a raw MCP tool, not through this package.',
  });
}

// ---------------------------------------------------------------------------
// Package: platform.protocol-checkpoint
// ---------------------------------------------------------------------------

export const PLATFORM_PROTOCOL_CHECKPOINT_CAPABILITY_ID =
  'platform.protocol-checkpoint' as const;

function buildProtocolCheckpointPackage(): CapabilityPackage {
  // Re-use the protocol-checkpoint contribution verbatim rather than
  // re-declaring the protocol step-complete tool. The contribution's
  // logicalId is already namespaced under `runtime.protocol.*`; the package
  // surfaces it unchanged so there is exactly ONE declaration of the protocol
  // checkpoint tool in the platform (single source of truth — avoids the
  // collision the installer would otherwise flag if this package re-declared
  // it under `platform.*`).
  const protocolTool = buildProtocolStepCompleteToolContribution();
  const tools: readonly ModuleToolContribution[] = [protocolTool];
  return Object.freeze({
    formatVersion: CAPABILITY_PACKAGE_FORMAT_VERSION,
    capabilityId: PLATFORM_PROTOCOL_CHECKPOINT_CAPABILITY_ID,
    version: PLATFORM_CAPABILITY_PACKAGE_VERSION,
    runtimeCompatibilityRange: '^3.0.0',
    tools: Object.freeze([...tools]),
    description:
      'Platform protocol-checkpoint capability: the runtime.protocol.step_complete '
      + 'tool every managed NodeProtocol worker calls once per completed step '
      + 'with its durable evidence. Idempotent replay-safe checkpointing.',
  });
}

// ---------------------------------------------------------------------------
// The five platform capability packages (frozen, singletons).
// ---------------------------------------------------------------------------

/**
 * The `platform.tasks` capability package. Surfaced tools: task_create,
 * task_list, task_get, task_update.
 */
export const PLATFORM_TASKS_PACKAGE: CapabilityPackage = buildTasksPackage();

/**
 * The `platform.artifact-graph` capability package. Surfaced tools:
 * artifact_create/get/list/update, trace_add/list/delete, artifact_coverage.
 */
export const PLATFORM_ARTIFACT_GRAPH_PACKAGE: CapabilityPackage =
  buildArtifactGraphPackage();

/**
 * The `platform.repository` capability package. Surfaced tools:
 * repository_register/list/get/update, repository_checkout_register/list/
 * bootstrap.
 */
export const PLATFORM_REPOSITORY_PACKAGE: CapabilityPackage =
  buildRepositoryPackage();

/**
 * The `platform.worker-completion` capability package. Surfaced tools:
 * worker_done/ask_need/ask_done, worker_merge_acquire/release, worker_health.
 * `worker_next` is intentionally EXCLUDED: an assigned worker that already
 * holds a card must not re-enter the dispatch queue — one launch = one card.
 * The dispatcher invokes worker_next as a raw MCP tool, not via this package.
 */
export const PLATFORM_WORKER_COMPLETION_PACKAGE: CapabilityPackage =
  buildWorkerCompletionPackage();

/**
 * The `platform.protocol-checkpoint` capability package. Surfaced tool:
 * runtime.protocol.step_complete (the protocol checkpoint tool).
 */
export const PLATFORM_PROTOCOL_CHECKPOINT_PACKAGE: CapabilityPackage =
  buildProtocolCheckpointPackage();

// ---------------------------------------------------------------------------
// Aggregate catalog + lookup.
// ---------------------------------------------------------------------------

/**
 * All five platform capability packages, in stable declaration order. The
 * contribution installer installs every package in this list through the same
 * namespace/collision pipeline as module contributions, so the gateway can
 * read the full platform tool surface from the registry instead of a
 * hand-maintained `ALL_TOOLS` array.
 *
 * Order is significant only for deterministic test snapshots; the installer
 * does not depend on it.
 */
export const PLATFORM_CAPABILITY_PACKAGES: readonly CapabilityPackage[] =
  Object.freeze([
    PLATFORM_TASKS_PACKAGE,
    PLATFORM_ARTIFACT_GRAPH_PACKAGE,
    PLATFORM_REPOSITORY_PACKAGE,
    PLATFORM_WORKER_COMPLETION_PACKAGE,
    PLATFORM_PROTOCOL_CHECKPOINT_PACKAGE,
  ]);

/**
 * Lookup a platform package by its `capabilityId`. Returns `undefined` when no
 * platform package carries that id (modules own their own capability ids;
 * this helper only resolves Runtime-owned `platform.*` ids). Pure.
 */
export function getPlatformCapabilityPackage(
  capabilityId: string,
): CapabilityPackage | undefined {
  for (const pkg of PLATFORM_CAPABILITY_PACKAGES) {
    if (pkg.capabilityId === capabilityId) return pkg;
  }
  return undefined;
}

/**
 * Flatten every platform package's tools into one deterministic list. The
 * composition root feeds this list to the `ModuleToolRegistry` so the
 * surfaced MCP namespace resolves platform tools alongside module tools
 * uniformly. Order is platform-package order, then declaration order within
 * each package.
 */
export function listPlatformToolContributions(): readonly ModuleToolContribution[] {
  const out: ModuleToolContribution[] = [];
  for (const pkg of PLATFORM_CAPABILITY_PACKAGES) {
    for (const tool of pkg.tools) {
      out.push(tool);
    }
  }
  return out;
}

/**
 * Resolve a single platform tool contribution by its `logicalId`. Returns
 * `undefined` when no platform tool carries that id. Used by the gateway guard
 * to classify an incoming tool call (idempotency / sideEffect) without a
 * hardcoded switch. Pure.
 */
export function getPlatformToolContribution(
  logicalId: string,
): ModuleToolContribution | undefined {
  for (const tool of listPlatformToolContributions()) {
    if (tool.logicalId === logicalId) return tool;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

/**
 * One validation failure for a capability package. Mirrors the
 * `ValidationError` shape so callers can aggregate platform-package errors
 * with module-contribution errors uniformly.
 */
export interface CapabilityPackageError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * Result of validating a capability package. `ok` is true iff `errors` is empty.
 */
export interface CapabilityPackageValidationResult {
  readonly ok: boolean;
  readonly errors: readonly CapabilityPackageError[];
}

function pkgErr(
  code: string,
  path: string,
  message: string,
): CapabilityPackageError {
  return { code, path, message };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a `CapabilityPackage` for installation readiness. Pure.
 *
 * Checks (each failure produces one error; collection is non-short-circuit so
 * callers see every defect at once):
 *   - `formatVersion` equals {@link CAPABILITY_PACKAGE_FORMAT_VERSION}.
 *   - `capabilityId` is a non-empty `platform.*`-namespaced string.
 *   - `version` is a non-empty string.
 *   - `runtimeCompatibilityRange` is a non-empty string.
 *   - `description` is a non-empty string.
 *   - `tools` is a non-empty array of {@link ModuleToolContribution}s with
 *     unique `logicalId`s (no namespace squatting inside one package).
 *
 * Does NOT re-validate each `ModuleToolContribution` structurally — that is the
 * SPI validator's job (`validateModuleToolContribution`). Here we only enforce
 * the package-envelope invariants and the within-package logicalId uniqueness
 * that the SPI validator cannot see (it validates one contribution at a time,
 * not a bundle).
 */
export function validateCapabilityPackage(
  pkg: unknown,
): CapabilityPackageValidationResult {
  const errors: CapabilityPackageError[] = [];

  if (
    typeof pkg !== 'object'
    || pkg === null
    || Array.isArray(pkg)
  ) {
    return {
      ok: false,
      errors: [
        pkgErr(
          'PACKAGE_NOT_OBJECT',
          '$',
          'capability package must be a plain object',
        ),
      ],
    };
  }

  const p = pkg as Record<string, unknown>;

  if (p.formatVersion !== CAPABILITY_PACKAGE_FORMAT_VERSION) {
    errors.push(
      pkgErr(
        'PACKAGE_FORMAT_VERSION_MISMATCH',
        '$.formatVersion',
        `formatVersion must be '${CAPABILITY_PACKAGE_FORMAT_VERSION}' (got ${JSON.stringify(p.formatVersion)})`,
      ),
    );
  }

  if (!isNonEmptyString(p.capabilityId)) {
    errors.push(
      pkgErr(
        'PACKAGE_CAPABILITY_ID_EMPTY',
        '$.capabilityId',
        'capabilityId must be a non-empty string',
      ),
    );
  } else if (!p.capabilityId.startsWith('platform.')) {
    errors.push(
      pkgErr(
        'PACKAGE_CAPABILITY_ID_NAMESPACE',
        '$.capabilityId',
        `capabilityId must be namespaced under 'platform.' (got '${p.capabilityId}')`,
      ),
    );
  }

  if (!isNonEmptyString(p.version)) {
    errors.push(
      pkgErr(
        'PACKAGE_VERSION_EMPTY',
        '$.version',
        'version must be a non-empty string',
      ),
    );
  }

  if (!isNonEmptyString(p.runtimeCompatibilityRange)) {
    errors.push(
      pkgErr(
        'PACKAGE_COMPAT_RANGE_EMPTY',
        '$.runtimeCompatibilityRange',
        'runtimeCompatibilityRange must be a non-empty string',
      ),
    );
  }

  if (!isNonEmptyString(p.description)) {
    errors.push(
      pkgErr(
        'PACKAGE_DESCRIPTION_EMPTY',
        '$.description',
        'description must be a non-empty string',
      ),
    );
  }

  if (!Array.isArray(p.tools)) {
    errors.push(
      pkgErr(
        'PACKAGE_TOOLS_NOT_ARRAY',
        '$.tools',
        'tools must be an array',
      ),
    );
  } else if (p.tools.length === 0) {
    errors.push(
      pkgErr(
        'PACKAGE_TOOLS_EMPTY',
        '$.tools',
        'tools must contain at least one tool contribution',
      ),
    );
  } else {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    p.tools.forEach((tool, i) => {
      const t = tool as { logicalId?: unknown };
      if (
        typeof t !== 'object'
        || t === null
        || !isNonEmptyString(t.logicalId)
      ) {
        errors.push(
          pkgErr(
            'PACKAGE_TOOL_INVALID',
            `$.tools[${i}]`,
            `tools[${i}] must be a ModuleToolContribution with a non-empty logicalId`,
          ),
        );
        return;
      }
      if (seen.has(t.logicalId)) dupes.add(t.logicalId);
      seen.add(t.logicalId);
    });
    for (const dup of dupes) {
      errors.push(
        pkgErr(
          'PACKAGE_TOOL_LOGICAL_ID_DUPLICATE',
          '$.tools',
          `duplicate tool logicalId '${dup}' within package`,
        ),
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate an ARRAY of capability packages AND cross-check that no two
 * packages (a) share a `capabilityId`, or (b) surface a tool with the same
 * `logicalId`. The latter is the platform-wide collision guard: even though
 * each package's internal uniqueness is checked by
 * {@link validateCapabilityPackage}, a tool `logicalId` collision ACROSS
 * packages would still collide in the surfaced MCP namespace. The
 * contribution installer relies on this property — every platform tool
 * `logicalId` is globally unique so the `ModuleToolRegistry` namespace never
 * sees a platform-vs-platform collision.
 *
 * Returns the union of per-package errors plus cross-package collisions. Pure.
 */
export function validatePlatformCapabilityPackages(
  packages: readonly CapabilityPackage[],
): CapabilityPackageValidationResult {
  const errors: CapabilityPackageError[] = [];

  const packageIds = new Set<string>();
  const dupPackageIds = new Set<string>();
  const toolIds = new Map<string, string>(); // logicalId -> owning capabilityId
  const collidingTools = new Set<string>();

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const perPkg = validateCapabilityPackage(pkg);
    for (const e of perPkg.errors) {
      errors.push(pkgErr(e.code, `$[${i}].${e.path}`, e.message));
    }
    // Even if the package had structural errors, attempt the cross-checks on
    // whatever well-formed identity we can read.
    if (typeof pkg?.capabilityId === 'string') {
      if (packageIds.has(pkg.capabilityId)) dupPackageIds.add(pkg.capabilityId);
      packageIds.add(pkg.capabilityId);
    }
    if (Array.isArray(pkg?.tools)) {
      for (const tool of pkg.tools) {
        const lid = (tool as { logicalId?: unknown })?.logicalId;
        if (typeof lid !== 'string') continue;
        const prev = toolIds.get(lid);
        if (prev !== undefined) {
          collidingTools.add(lid);
        } else {
          toolIds.set(lid, pkg.capabilityId);
        }
      }
    }
  }

  for (const dup of dupPackageIds) {
    errors.push(
      pkgErr(
        'PLATFORM_PACKAGE_ID_DUPLICATE',
        '$',
        `duplicate platform capabilityId '${dup}'`,
      ),
    );
  }
  for (const collide of collidingTools) {
    errors.push(
      pkgErr(
        'PLATFORM_TOOL_LOGICAL_ID_COLLISION',
        '$',
        `tool logicalId '${collide}' is surfaced by more than one platform package`,
      ),
    );
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// The platform-wide collision guarantee: asserted once at module load so a
// future edit that introduces a duplicate tool logicalId or package id fails
// loudly at startup rather than silently shadowing in the registry.
// ---------------------------------------------------------------------------

const _platformSelfCheck = validatePlatformCapabilityPackages(
  PLATFORM_CAPABILITY_PACKAGES,
);
if (!_platformSelfCheck.ok) {
  // A platform package is malformed — this is a programmer error, not a data
  // error. Throw synchronously at module load so the defect is impossible to
  // miss (mirrors the assertCanonicalSerializable throw-on-impurity
  // discipline).
  throw new Error(
    `PLATFORM_CAPABILITY_PACKAGES_SELF_CHECK_FAILED: ${JSON.stringify(_platformSelfCheck.errors)}`,
  );
}

// Re-export the protocol tool's logical id constant so consumers of the
// platform surface can reference it without importing the protocol-checkpoint
// service directly (keeps the platform tool surface addressable from one
// module).
export {
  PROTOCOL_STEP_COMPLETE_TOOL_LOGICAL_ID,
} from './protocol-checkpoint-service.js';
