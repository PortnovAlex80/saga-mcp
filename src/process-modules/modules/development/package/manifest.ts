/**
 * Development package manifest — mirrors the Wave 8 formalization / Wave 9
 * discovery manifest pattern for the Solution Development Process Module.
 *
 * This is the CENTRAL manifest for the Solution Development Process Module
 * package. It wraps the existing pure {@link developmentProcessModule}
 * definition and declares the pinned resources, handlers and contracts the
 * module depends on, so the content-addressed installer (Wave 2) can persist
 * + content-hash it verbatim and the workspace materializer (W5-A1
 * buildWorkspaceProjection) can resolve every resource through the pinned
 * installation instead of a global workspace-root lookup.
 *
 * Purity (plan §3.5): the manifest is PURE DATA — no functions, no factories,
 * no class instances. Every field is canonically serializable so the Wave 2
 * content-addressed installer can persist + content-hash it verbatim. The
 * manifest is validated by `validateProcessModuleManifest` at module load; a
 * structural regression throws synchronously and fails the build.
 *
 * Resource ownership (W13-A2-complete): development-owned resources
 * (process-module-stage-tracker, task-graph-planner-checklist,
 * task-graph-submit-call-template, saga-planner + saga-worker skills) live
 * under `src/process-modules/modules/development/package/resources/`. Shared
 * PLATFORM skills (saga-process-module-worker-protocol, saga-planning-reviewer,
 * saga-verifier) stay as single canonical copies under the repo-root `skills/`
 * dir — they are referenced by multiple modules / are platform-level concerns,
 * so duplicating them into each package would violate single-ownership. The
 * manifest pins them by repo-root-relative path; cross-package / cross-root
 * references are valid (the manifest validator checks only that `path` is a
 * non-empty string; the workspace materializer resolves each from the pinned
 * `storeLocation` after the installer content-addresses the package-owned
 * subset).
 *
 * `digest` placeholders: every resource + handler digest uses the documented
 * `PENDING_DIGEST` sentinel (`'pending@wave-2'`). The content-addressed
 * package store (Wave 2) replaces each placeholder with `sha256Hex` of the
 * resource's real bytes at install time.
 */

import type {
  ProcessModuleManifest,
  ResourceIndexEntry,
  HandlerRef,
} from '../../../domain/spi/module-manifest.js';
import {
  PENDING_DIGEST,
  validateProcessModuleManifest,
} from '../../../domain/spi/module-manifest.js';
import type { ContractRef } from '../../../domain/spi/contract-ref.js';
import { CONTRACT_REF_PENDING_DIGEST } from '../../../domain/spi/contract-ref.js';
import { developmentProcessModule } from '../development-process-module.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../development-kernel-ports.js';
import {
  DEVELOPMENT_CASE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
} from '../development-schemas.js';

// ---------------------------------------------------------------------------
// Manifest format + runtime identity.
// ---------------------------------------------------------------------------

/**
 * Format version of THIS manifest envelope. `'1'` signals the envelope wraps a
 * migrated ProcessModuleDefinition that populates `resourceIndex` /
 * `handlerRefs` (as opposed to `'legacy-0'`, which wraps a bare definition
 * with empty arrays).
 */
export const DEVELOPMENT_MANIFEST_FORMAT_VERSION = '1';

/**
 * Runtime API compatibility range this package requires. Development was
 * migrated against the saga 3.x process-module SPI; the package is valid for
 * any 3.x runtime.
 */
export const DEVELOPMENT_RUNTIME_COMPATIBILITY_RANGE = '^3.0.0';

/**
 * Canonical `name@version` identity for the development module. Re-exported so
 * manifest consumers have the module key on the same surface.
 */
export const DEVELOPMENT_MODULE_KEY = `${developmentProcessModule.identity.name}@${developmentProcessModule.identity.version}`;

// ---------------------------------------------------------------------------
// Resource index.
//
// Every skill, template, call-template and checklist the development execution
// profiles (planning) reference is declared here. Paths are module-RELATIVE
// POSIX paths rooted at the repository root — the Wave 2 installer resolves
// each under the package root and rejects absolute / traversal paths.
// `logicalId` is the stable, module-namespaced identifier the runtime pins
// against so it never falls back to global resource lookup.
// ---------------------------------------------------------------------------

/**
 * Repository-root-relative POSIX paths to the resources development pins.
 * Development-owned resources live under
 * `src/process-modules/modules/development/package/resources/` (W13-A2-complete
 * migrated them out of the legacy `tool-templates/development/` + `skills/`
 * global root). Shared platform skills (saga-process-module-worker-protocol,
 * saga-planning-reviewer, saga-verifier) stay at the repo-root `skills/` dir.
 */
const DEVELOPMENT_PACKAGE_RESOURCE_ROOT =
  'src/process-modules/modules/development/package/resources';
const RESOURCE_PATHS = {
  // Execution-profile skills (development-owned, migrated into the package).
  plannerExecutionSkill: `${DEVELOPMENT_PACKAGE_RESOURCE_ROOT}/skills/saga-planner/SKILL.md`,
  workerExecutionSkill: `${DEVELOPMENT_PACKAGE_RESOURCE_ROOT}/skills/saga-worker/SKILL.md`,
  // Shared protocol skill pinned by every development execution profile.
  // PLATFORM resource: stays at the repo-root skills/ dir (shared by all
  // process modules); not duplicated into the package.
  processProtocolSkill: 'skills/saga-process-module-worker-protocol/SKILL.md',
  // Reviewer skills: saga-verifier is a real platform skill (exists at
  // skills/saga-verifier/SKILL.md) — pinned by path. saga-planning-reviewer
  // is NOT pinned by the package: it does not exist as a shipped skill, so the
  // planning profile's `reviewSkill: 'saga-planning-reviewer'` resolves via the
  // agent's skills directory (by name), not via package bytes. Adding a ghost
  // resourceIndex entry for it would fail install (every declared resource must
  // exist on disk). If a real planning-reviewer skill ships later, add it here.
  verifierReviewerSkill: 'skills/saga-verifier/SKILL.md',
  // Call template materialized by the planning LM node.
  taskGraphSubmitCallTemplate: `${DEVELOPMENT_PACKAGE_RESOURCE_ROOT}/task-graph-submit-call-template.json`,
  // Per-node checklist + stage tracker pinned by the planning execution profile.
  taskGraphPlannerChecklist: `${DEVELOPMENT_PACKAGE_RESOURCE_ROOT}/task-graph-planner-checklist.md`,
  stageTracker: `${DEVELOPMENT_PACKAGE_RESOURCE_ROOT}/process-module-stage-tracker.md`,
} as const;

/**
 * The full resource index for the development package. Pinned by `logicalId`
 * (module-namespaced, unique within this manifest) so the runtime resolves
 * every resource through the package and never through global lookup.
 */
export const DEVELOPMENT_RESOURCE_INDEX: readonly ResourceIndexEntry[] = [
  // --- Execution skills (drive the LM nodes) -----------------------------
  {
    logicalId: 'development.skill.planner-execution',
    path: RESOURCE_PATHS.plannerExecutionSkill,
    kind: 'skill',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'development.skill.worker-execution',
    path: RESOURCE_PATHS.workerExecutionSkill,
    kind: 'skill',
    digest: PENDING_DIGEST,
  },
  // --- Shared protocol skill ---------------------------------------------
  {
    logicalId: 'development.skill.process-protocol',
    path: RESOURCE_PATHS.processProtocolSkill,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  // --- Reviewer skills (PLATFORM — pinned by path, not duplicated) -------
  {
    logicalId: 'development.skill.verifier',
    path: RESOURCE_PATHS.verifierReviewerSkill,
    kind: 'reviewer-skill',
    digest: PENDING_DIGEST,
  },
  // --- Call templates (materialized MCP calls) ---------------------------
  {
    logicalId: 'development.template.task-graph-submit-call',
    path: RESOURCE_PATHS.taskGraphSubmitCallTemplate,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  // --- Checklists + stage tracker ----------------------------------------
  {
    logicalId: 'development.checklist.task-graph-planner',
    path: RESOURCE_PATHS.taskGraphPlannerChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'development.tracker.stage',
    path: RESOURCE_PATHS.stageTracker,
    kind: 'template',
    digest: PENDING_DIGEST,
  },
];

// ---------------------------------------------------------------------------
// Handler refs.
//
// Stable, content-addressed references to the kernel handlers the development
// flow wires up. Handlers are NOT shipped in the manifest — only stable
// references. The adapter registry resolves each `logicalId` to the concrete
// `KernelHandler` by name.
// ---------------------------------------------------------------------------

/** Shared placeholder handler version (matches the module version's minor). */
const HANDLER_VERSION = '1.0.0';

function developmentHandlerRef(logicalId: string): HandlerRef {
  return {
    logicalId,
    version: HANDLER_VERSION,
    digest: PENDING_DIGEST,
  };
}

/**
 * The complete set of kernel handler references for the development package.
 * Each `logicalId` matches the `handler:` field declared on the corresponding
 * kernel node in `development-process-module.ts` and the key registered in
 * `DEVELOPMENT_KERNEL_HANDLER_IDS` (`development-kernel-ports.ts`). The
 * runtime-provided `process-outcome-emitter` is intentionally omitted — it is
 * platform-owned and registered globally, not module-owned.
 */
export const DEVELOPMENT_HANDLER_REFS: readonly HandlerRef[] = [
  developmentHandlerRef(DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph),
  developmentHandlerRef(DEVELOPMENT_KERNEL_HANDLER_IDS.settle),
];

// ---------------------------------------------------------------------------
// Contract refs.
//
// The input/output contracts of the development package. `schemaId` matches
// the `inputContract.id` / `outputContract.id` on the wrapped definition.
// ---------------------------------------------------------------------------

/**
 * Build a ContractRef for a development schema id. Uses the documented
 * `CONTRACT_REF_PENDING_DIGEST` placeholder.
 */
function developmentContractRef(schemaId: string): ContractRef {
  return {
    schemaId,
    version: '1.0.0',
    digest: CONTRACT_REF_PENDING_DIGEST,
  };
}

/** Input contract: one DevelopmentCase bound to a solution contract. */
export const DEVELOPMENT_INPUT_CONTRACT_REF: ContractRef = developmentContractRef(
  DEVELOPMENT_CASE_SCHEMA,
);

/** Output contract: the authoritative VerifiedIntegrationBundle. */
export const DEVELOPMENT_OUTPUT_CONTRACT_REF: ContractRef = developmentContractRef(
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
);

// ---------------------------------------------------------------------------
// Central manifest.
// ---------------------------------------------------------------------------

/**
 * The central, validated ProcessModuleManifest for the Solution Development
 * package.
 *
 * The manifest is validated at module load by
 * {@link validateProcessModuleManifest}, which enforces both canonical
 * serializability and structural completeness (required fields present,
 * `logicalId`s unique, `resourceIndex` kinds known). A regression throws
 * synchronously and fails the build — the manifest is the load-bearing seam
 * between the pure definition and the content-addressed package, so it must
 * never load in an invalid state.
 */
export const developmentPackageManifest: ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    manifestFormatVersion: DEVELOPMENT_MANIFEST_FORMAT_VERSION,
    definition: developmentProcessModule,
    resourceIndex: DEVELOPMENT_RESOURCE_INDEX,
    handlerRefs: DEVELOPMENT_HANDLER_REFS,
    inputContractRef: DEVELOPMENT_INPUT_CONTRACT_REF,
    outputContractRef: DEVELOPMENT_OUTPUT_CONTRACT_REF,
    runtimeCompatibilityRange: DEVELOPMENT_RUNTIME_COMPATIBILITY_RANGE,
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    const rendered = validation.errors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    throw new Error(
      `development package manifest failed validation:\n${rendered}`,
    );
  }
  return manifest;
})();
