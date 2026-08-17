/**
 * W9-A1 — Discovery package manifest.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a1.md`.
 *
 * This is the CENTRAL manifest for the Product Discovery Process Module
 * package. Wave 9 applies the Wave 8 Formalization migration pattern to
 * Discovery (WAVE9-PRODUCTION-MIGRATION-SPEC §1): Discovery runs through
 * PINNED PACKAGE RESOURCES with no fallback context, no global
 * skill/template lookup, and no direct infrastructure dependency
 * (WAVE9-PRODUCTION-MIGRATION-SPEC §2 exit gate).
 *
 * A1 OWNS this file exclusively. The other W9 Discovery lanes (A2 submits
 * entries to A1, which reconciles them into this single manifest. Do not
 * edit this file from another lane.
 *
 * What this manifest declares (mirrors Wave 8 W8-A1):
 *   - `definition`               — the existing pure ProcessModuleDefinition
 *                                  (`discovery-process-module.ts`). Wraps it;
 *                                  does not duplicate it.
 *   - `resourceIndex`            — every skill, template, call-template,
 *                                  checklist and tracker the four discovery
 *                                  execution profiles reference. Pinned by
 *                                  `logicalId` + module-relative `path` so the
 *                                  runtime never does global resource lookup.
 *   - `handlerRefs`              — stable, content-addressed references to the
 *                                  six discovery kernel handlers declared in
 *                                  `discovery-installation.ts`
 *                                  (`createDiscoveryKernelHandlers`).
 *   - `inputContractRef` /
 *     `outputContractRef`        — the DiscoveryCase input contract and the
 *                                  DiscoveryOutcomeCertificate output contract.
 *   - `runtimeCompatibilityRange`— the saga runtime API range this package
 *                                  requires.
 *
 * Purity (plan §3.5): the manifest is PURE DATA — no functions, no factories,
 * no class instances. Every field is canonically serializable so the Wave 2
 * content-addressed installer can persist + content-hash it verbatim. The
 * manifest is validated by `validateProcessModuleManifest` (W1-A2) at module
 * load; a structural regression throws synchronously and fails the build.
 *
 * Digests: resource entries keep the documented `'pending@wave-2'` sentinel —
 * the content-addressed package store (Wave 2) stamps each with `sha256Hex`
 * of the resource's real bytes at install time. Handler refs are
 * content-addressed at module load (ADR-066 item 3 / plan item 15): each
 * `digest` is the real sha256 of the compiled handler installation module,
 * so editing handler code changes the manifest identity and a run can prove
 * which handler bytes it executed.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handlerImplementationDigest } from '../../../installation/domain/handler-implementation-digest.js';

import type {
  HandlerRef,
  ProcessModuleManifest,
  ResourceIndexEntry,
} from '../../../domain/spi/module-manifest.js';
import {
  PENDING_DIGEST,
  validateProcessModuleManifest,
} from '../../../domain/spi/module-manifest.js';
import type { ContractRef } from '../../../domain/spi/contract-ref.js';
import { CONTRACT_REF_PENDING_DIGEST } from '../../../domain/spi/contract-ref.js';
import { discoveryProcessModule, DISCOVERY_PROCESS_MODULE_REF } from '../discovery-process-module.js';
import { DISCOVERY_AGENT_ASSISTANCE } from './assistance.js';

// ---------------------------------------------------------------------------
// Module key + discovery handler identities.
//
// Discovery's kernel handlers are registered in
// `discovery-installation.ts` (`createDiscoveryKernelHandlers`). That file
// inlines the handler id strings; this manifest pins them as a frozen
// constant so the handlerRefs below stay in lockstep with the registration.
// Mirrors `FORMALIZATION_HANDLER_IDS` / `FORMALIZATION_MODULE_KEY` from
// `formalization-installation.ts`.
// ---------------------------------------------------------------------------

/**
 * The canonical `name@version` identity of the Product Discovery module.
 * Matches {@link DISCOVERY_PROCESS_MODULE_REF}.
 */
export const DISCOVERY_MODULE_KEY =
  `${DISCOVERY_PROCESS_MODULE_REF.name}@${DISCOVERY_PROCESS_MODULE_REF.version}`;

/**
 * The six discovery-owned kernel handler ids. Each matches a key returned by
 * `createDiscoveryKernelHandlers` (discovery-installation.ts) AND the
 * `handler:` field on the corresponding kernel node in
 * `discovery-process-module.ts`. The generic `process-outcome-emitter` is
 * runtime-owned (not module-owned) and is intentionally excluded — same
 * boundary Formalization draws.
 */
export const DISCOVERY_HANDLER_IDS = Object.freeze({
  resolveProposalSubmission: 'discovery-resolve-proposal-submission',
  prepareNormalization: 'discovery-prepare-normalization',
  resolveNormalizedProposal: 'discovery-resolve-normalized-proposal',
  prepareReadiness: 'discovery-prepare-readiness',
  resolveReadiness: 'discovery-resolve-readiness',
  settlementPolicy: 'discovery-settlement-policy',
});

// ---------------------------------------------------------------------------
// Schema identifiers the manifest references as contracts.
//
// DiscoveryCase is the module input; DiscoveryOutcomeCertificate is the
// module output. Both schema ids match the wrapped definition's
// inputContract / outputContract (which declare them as inline literals).
//
// These are opaque string identifiers only — defining them locally keeps the
// package SELF-CONTAINED (WAVE9-PRODUCTION-MIGRATION-SPEC §2: no direct
// infrastructure dependency; the dependency-direction ratchet rule 2 forbids
// a module file from importing `src/saga3/`). The matching canonical schema
// documents are registered behind these ids by the Wave 2/3 codec registry;
// the literal strings are the load-bearing contract.
// ---------------------------------------------------------------------------

/** Input contract schema: one DiscoveryCase bound to an idea/context. */
export const DISCOVERY_CASE_SCHEMA = 'factory.discovery-case.v1';

/** Output contract schema: the authoritative DiscoveryOutcomeCertificate. */
export const DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA = 'factory.discovery-outcome-certificate.v1';

// ---------------------------------------------------------------------------
// Manifest format + runtime identity.
// ---------------------------------------------------------------------------

/**
 * Format version of THIS manifest envelope. `'1'` signals the envelope wraps a
 * migrated ProcessModuleDefinition that populates `resourceIndex` /
 * the Wave 8 formalization bump.
 */
export const DISCOVERY_MANIFEST_FORMAT_VERSION = '1';

/**
 * Runtime API compatibility range this package requires. Discovery was
 * migrated against the saga 3.x process-module SPI; the package is valid for
 * any 3.x runtime. The `<4.0.0` upper bound reserves room for the 4.x
 * cutover.
 */
export const DISCOVERY_RUNTIME_COMPATIBILITY_RANGE = '^3.0.0';

// ---------------------------------------------------------------------------
// Resource index.
//
// Every skill, tracker template, workspace template, call-template and
// checklist the four discovery execution profiles
// (discovery-proposal-worker / discovery-normalizer / discovery-readiness-
// advisor / discovery-diagnosis-advisor) reference is declared here. Paths are
// module-RELATIVE POSIX paths rooted at the repository root — the Wave 2
// installer resolves each under the package root and rejects absolute /
// traversal paths. `logicalId` is the stable, module-namespaced identifier the
// runtime pins against so it never falls back to global resource lookup
// (WAVE9-PRODUCTION-MIGRATION-SPEC §2).
// ---------------------------------------------------------------------------

/**
 * Repository-root-relative POSIX paths to the resources discovery pins. W13-A2
 * (`tool-templates/discovery/`, `skills/saga-discovery-*`) into the discovery
 * package resources directory. The resources physically live under
 * `src/process-modules/modules/discovery/package/resources/`; the manifest pins
 * them from the repo root so the workspace materializer + content-addressed
 * installer resolve them without module-private path knowledge (mirrors the
 * delivery package pattern). The shared `saga-process-module-worker-protocol`
 * skill stays a PLATFORM resource under `skills/` (pinned by every process
 * module); it is intentionally not duplicated into each package.
 */
const DISCOVERY_PACKAGE_RESOURCE_ROOT =
  'src/process-modules/modules/discovery/package/resources';
const RESOURCE_PATHS = {
  // Execution-profile skills (one per discovery LM node).
  proposalExecutionSkill: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/skills/saga-discovery-worker/SKILL.md`,
  normalizerExecutionSkill: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/skills/saga-discovery-normalizer/SKILL.md`,
  readinessAdvisorExecutionSkill: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/skills/saga-discovery-readiness-advisor/SKILL.md`,
  diagnosisAdvisorExecutionSkill: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/skills/saga-discovery-diagnosis-advisor/SKILL.md`,
  // Shared protocol skill pinned by every discovery execution profile.
  // PLATFORM resource: stays at the repo-root skills/ dir (shared by all
  // process modules); not duplicated into the package.
  processProtocolSkill: 'skills/saga-process-module-worker-protocol/SKILL.md',
  // Proposal worker workspace templates.
  proposalDocTemplate: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/discovery-doc-template.md`,
  proposalCallTemplate: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/proposal-call-template.json`,
  proposalStageTracker: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/proposal-stage-tracker.md`,
  proposalChecklist: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/proposal-checklist.md`,
  // Normalizer worker templates.
  normalizationCallTemplate: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/normalization-call-template.json`,
  normalizationStageTracker: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/normalization-stage-tracker.md`,
  normalizationChecklist: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/normalization-checklist.md`,
  // Readiness advisor templates.
  readinessCallTemplate: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/readiness-call-template.json`,
  readinessStageTracker: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/readiness-stage-tracker.md`,
  readinessChecklist: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/readiness-checklist.md`,
  // Diagnosis advisor templates (advisory-only execution profile).
  diagnosisCallTemplate: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/diagnosis-call-template.json`,
  diagnosisStageTracker: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/diagnosis-stage-tracker.md`,
  diagnosisChecklist: `${DISCOVERY_PACKAGE_RESOURCE_ROOT}/diagnosis-checklist.md`,
} as const;

/**
 * The full resource index for the discovery package. Pinned by `logicalId`
 * (module-namespaced, unique within this manifest) so the runtime resolves
 * every resource through the package and never through global lookup.
 *
 * `digest` is the documented `'pending@wave-2'` placeholder: Wave 2's
 * content-addressed installer replaces it with `sha256Hex` of each resource's
 * real bytes at install time.
 */
export const DISCOVERY_RESOURCE_INDEX: readonly ResourceIndexEntry[] = [
  // --- Execution skills (drive the LM nodes) -----------------------------
  {
    logicalId: 'discovery.skill.proposal-worker',
    path: RESOURCE_PATHS.proposalExecutionSkill,
    kind: 'skill',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.skill.normalizer',
    path: RESOURCE_PATHS.normalizerExecutionSkill,
    kind: 'skill',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.skill.readiness-advisor',
    path: RESOURCE_PATHS.readinessAdvisorExecutionSkill,
    kind: 'skill',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.skill.diagnosis-advisor',
    path: RESOURCE_PATHS.diagnosisAdvisorExecutionSkill,
    kind: 'skill',
    digest: PENDING_DIGEST,
  },
  // --- Shared protocol skill ---------------------------------------------
  {
    logicalId: 'discovery.skill.process-protocol',
    path: RESOURCE_PATHS.processProtocolSkill,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  // --- Proposal worker resources -----------------------------------------
  {
    logicalId: 'discovery.template.proposal-doc',
    path: RESOURCE_PATHS.proposalDocTemplate,
    kind: 'template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.template.proposal-call',
    path: RESOURCE_PATHS.proposalCallTemplate,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.tracker.proposal-stage',
    path: RESOURCE_PATHS.proposalStageTracker,
    kind: 'template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.checklist.proposal',
    path: RESOURCE_PATHS.proposalChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
  // --- Normalizer worker resources ---------------------------------------
  {
    logicalId: 'discovery.template.normalization-call',
    path: RESOURCE_PATHS.normalizationCallTemplate,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.tracker.normalization-stage',
    path: RESOURCE_PATHS.normalizationStageTracker,
    kind: 'template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.checklist.normalization',
    path: RESOURCE_PATHS.normalizationChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
  // --- Readiness advisor resources ---------------------------------------
  {
    logicalId: 'discovery.template.readiness-call',
    path: RESOURCE_PATHS.readinessCallTemplate,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.tracker.readiness-stage',
    path: RESOURCE_PATHS.readinessStageTracker,
    kind: 'template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.checklist.readiness',
    path: RESOURCE_PATHS.readinessChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
  // --- Diagnosis advisor resources (advisory-only profile) ---------------
  {
    logicalId: 'discovery.template.diagnosis-call',
    path: RESOURCE_PATHS.diagnosisCallTemplate,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.tracker.diagnosis-stage',
    path: RESOURCE_PATHS.diagnosisStageTracker,
    kind: 'template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'discovery.checklist.diagnosis',
    path: RESOURCE_PATHS.diagnosisChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
];

// ---------------------------------------------------------------------------
// Handler refs.
//
// Stable, content-addressed references to the six kernel handlers the
// discovery flow wires up in `discovery-installation.ts`
// (`createDiscoveryKernelHandlers`). Handlers are NOT shipped in the manifest
// — only stable references. The adapter registry resolves each `logicalId` to
// the concrete `KernelHandler` by name.
//
// ADR-066 item 3 (plan item 15): every `digest` is the REAL sha256 of the
// handler installation module, computed at manifest load (the same pattern as
// `modules-ext/external-seo/manifest.mjs`). A placeholder here made
// composition unprovable — binding receipts compared a constant, so a handler
// edit during a live run was invisible. Now editing
// `discovery-installation.ts` changes every handlerRef digest → changes the
// packageDigest → forces an explicit resume-compatibility decision instead of
// a trivially-passing placeholder comparison.
// ---------------------------------------------------------------------------

/** Shared handler version (matches the module version's minor). */
const HANDLER_VERSION = '1.0.0';

/** Directory of THIS manifest module (mirrored by tsc into dist/). */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Content address of `createDiscoveryKernelHandlers` — the module the
 * composition root calls to register every handler pinned below. All six
 * handlers are created by this single installation module, so they share its
 * digest; editing ANY of them changes it. Computed by the canonical shared
 * digester (K3): sha256 over the module's raw bytes, resolved from HERE.
 */
const DISCOVERY_HANDLER_IMPLEMENTATION_DIGEST = handlerImplementationDigest(
  HERE,
  '../../../../modules/discovery/application/discovery-installation.js',
  'discovery',
);

function discoveryHandlerRef(logicalId: string): HandlerRef {
  return {
    logicalId,
    version: HANDLER_VERSION,
    digest: DISCOVERY_HANDLER_IMPLEMENTATION_DIGEST,
  };
}

/**
 * The complete set of kernel handler references for the discovery package.
 * Each `logicalId` matches the `handler:` field declared on the corresponding
 * kernel node in `discovery-process-module.ts` and a key registered by
 * `createDiscoveryKernelHandlers` (discovery-installation.ts). The generic
 * `process-outcome-emitter` is runtime-owned and intentionally excluded.
 */
export const DISCOVERY_HANDLER_REFS: readonly HandlerRef[] = [
  discoveryHandlerRef(DISCOVERY_HANDLER_IDS.resolveProposalSubmission),
  discoveryHandlerRef(DISCOVERY_HANDLER_IDS.prepareNormalization),
  discoveryHandlerRef(DISCOVERY_HANDLER_IDS.resolveNormalizedProposal),
  discoveryHandlerRef(DISCOVERY_HANDLER_IDS.prepareReadiness),
  discoveryHandlerRef(DISCOVERY_HANDLER_IDS.resolveReadiness),
  discoveryHandlerRef(DISCOVERY_HANDLER_IDS.settlementPolicy),
];

// ---------------------------------------------------------------------------
// Contract refs.
//
// The input/output contracts of the discovery package. `schemaId` matches the
// `inputContract.id` / `outputContract.id` on the wrapped definition;
// `version`/`digest` are the documented Wave 9 placeholders until the
// ContractSchemaRegistry (W1-A5) ships concrete codecs behind each schema id.
// ---------------------------------------------------------------------------

/**
 * Build a ContractRef for a discovery schema id. Uses the documented
 * `CONTRACT_REF_PENDING_DIGEST` placeholder: Wave 2 replaces it with
 * `computeContractRefDigest(canonicalSchemaDocument)` once codecs land.
 */
function discoveryContractRef(schemaId: string): ContractRef {
  return {
    schemaId,
    version: '1.0.0',
    digest: CONTRACT_REF_PENDING_DIGEST,
  };
}

/** Input contract: one DiscoveryCase bound to an idea / bounded context. */
export const DISCOVERY_INPUT_CONTRACT_REF: ContractRef = discoveryContractRef(
  DISCOVERY_CASE_SCHEMA,
);

/** Output contract: the authoritative DiscoveryOutcomeCertificate. */
export const DISCOVERY_OUTPUT_CONTRACT_REF: ContractRef = discoveryContractRef(
  DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
);

// ---------------------------------------------------------------------------
// Central manifest.
// ---------------------------------------------------------------------------

/**
 * The central, validated ProcessModuleManifest for the Product Discovery
 * package.
 *
 * This is the single object Wave 9 hands to the installer: it wraps the
 * existing pure {@link discoveryProcessModule} definition and declares the
 * pinned resources, handlers and contracts the module depends on. Other W9
 * Discovery lanes submit entries to A1, which reconciles them HERE — never
 * edit this constant from another lane.
 *
 * The manifest is validated at module load by
 * {@link validateProcessModuleManifest} (W1-A2), which enforces both canonical
 * serializability (plan §3.5 — no functions/Map/Set/class instances/undefined-
 * in-arrays/Symbols/non-finite numbers) and structural completeness (required
 * fields present, `logicalId`s unique, `resourceIndex` kinds known). A
 * regression throws synchronously and fails the build — the manifest is the
 * load-bearing seam between the pure definition and the content-addressed
 * package, so it must never load in an invalid state.
 */
export const discoveryPackageManifest: ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    manifestFormatVersion: DISCOVERY_MANIFEST_FORMAT_VERSION,
    definition: discoveryProcessModule,
    resourceIndex: DISCOVERY_RESOURCE_INDEX,
    handlerRefs: DISCOVERY_HANDLER_REFS,
    inputContractRef: DISCOVERY_INPUT_CONTRACT_REF,
    outputContractRef: DISCOVERY_OUTPUT_CONTRACT_REF,
    runtimeCompatibilityRange: DISCOVERY_RUNTIME_COMPATIBILITY_RANGE,
    assistance: DISCOVERY_AGENT_ASSISTANCE,
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    const rendered = validation.errors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    throw new Error(
      `discovery package manifest failed validation:\n${rendered}`,
    );
  }
  return manifest;
})();

/**
 * Re-export the module key so consumers importing the manifest have the
 * canonical `name@version` identity on the same surface.
 */
export { DISCOVERY_PROCESS_MODULE_REF };
