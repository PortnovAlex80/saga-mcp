/**
 * W9-A5 — Delivery package manifest.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a5.md`.
 * Plan: §0.12 (remaining production module migrations), §0.11 (Formalization
 *       pilot pattern this mirrors).
 *
 * This is the CENTRAL manifest for the Delivery/Release Process Module
 * package. Wave 9 migrates Delivery to run through PINNED PACKAGE RESOURCES
 * with no fallback context, no global skill/template lookup, and no direct
 * infrastructure dependency (WAVE9-PRODUCTION-MIGRATION-SPEC §2 exit gate —
 * the same kit Formalization passed in Wave 8).
 *
 * A5 OWNS this file exclusively (the manifest + central exports + flow-node
 * protocols). Other W9 delivery lanes (A6) submit individual entries (external
 * effects / human approval / idempotency / ports / receipts / contributions)
 * to A5, which reconciles them into this single manifest. Do not edit this
 * file from another lane.
 *
 * What this manifest declares (plan §0.11.11, mirrored from W8-A1):
 *   - `definition`               — the existing pure ProcessModuleDefinition
 *                                  (`delivery-process-module.ts`). Wraps it;
 *                                  does not duplicate it.
 *   - `resourceIndex`            — every skill, template, call-template and
 *                                  checklist the delivery execution profiles
 *                                  reference. Pinned by `logicalId` +
 *                                  module-relative `path` so the runtime never
 *                                  does global resource lookup.
 *   - `handlerRefs`              — stable, content-addressed references to the
 *                                  kernel handlers and external/human adapters
 *                                  declared in `delivery-kernel-ports.ts` /
 *                                  `delivery-installation.ts`.
 *   - `inputContractRef` /
 *     `outputContractRef`        — the DeliveryReleaseCase input contract and
 *                                  the ReleaseRecord output contract.
 *   - `runtimeCompatibilityRange`— the saga runtime API range this package
 *                                  requires.
 *
 * Purity (plan §3.5): the manifest is PURE DATA — no functions, no factories,
 * no class instances. Every field is canonically serializable so the Wave 2
 * content-addressed installer can persist + content-hash it verbatim. The
 * manifest is validated by `validateProcessModuleManifest` (W1-A2) at module
 * load; a structural regression throws synchronously and fails the build.
 *
 * Digest placeholder: every resource + handler digest uses the documented
 * `'pending@wave-2'` sentinel. The content-addressed package store (Wave 2)
 * replaces each placeholder with `sha256Hex` of the resource's real bytes at
 * install time. Until then the manifest is structurally complete and
 * serializable, but not yet content-addressed — exactly the Wave 9 contract.
 *
 * Anti-scope (WAVE9-PRODUCTION-MIGRATION-SPEC §3): this lane does NOT modify
 * Runtime, global registries, runner, gateway, lifecycle composition, or
 * another module. It does NOT cut over the composition root (Wave 11) or
 * remove legacy code (Wave 13). Additive only.
 */

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
import { deliveryProcessModule } from '../delivery-process-module.js';
import {
  DELIVERY_HUMAN_ADAPTER_IDS,
  DELIVERY_KERNEL_HANDLER_IDS,
} from '../../../../modules/delivery/domain/delivery-kernel-ports.js';
import {
  DELIVERY_RELEASE_CASE_SCHEMA,
  RELEASE_RECORD_SCHEMA,
} from '../../../../modules/delivery/domain/delivery-schemas.js';

// ---------------------------------------------------------------------------
// Manifest format + runtime identity.
// ---------------------------------------------------------------------------

/**
 * Format version of THIS manifest envelope. `'1'` signals the envelope wraps a
 * migrated ProcessModuleDefinition that populates `resourceIndex` /
 * `handlerRefs` (as opposed to `'legacy-0'`, which wraps a bare definition
 * with empty arrays). Delivery uses the current manifest format.
 * legacy-0 to '1', mirroring the Wave 8 formalization bump.
 */
export const DELIVERY_MANIFEST_FORMAT_VERSION = '1';

/**
 * Runtime API compatibility range this package requires. Delivery was migrated
 * against the saga 3.x process-module SPI; the package is valid for any 3.x
 * runtime. The `<4.0.0` upper bound reserves room for the 4.x cutover.
 */
export const DELIVERY_RUNTIME_COMPATIBILITY_RANGE = '^3.0.0';

/**
 * Canonical `name@version` identity for the wrapped delivery definition.
 * Convenience re-export so manifest consumers import the identity from the
 * same surface as the manifest itself.
 */
export const DELIVERY_MODULE_KEY = `${deliveryProcessModule.identity.name}@${deliveryProcessModule.identity.version}`;

// ---------------------------------------------------------------------------
// Resource index.
//
// Every checklist, error-hint, instruction and template the delivery flow
// nodes reference is declared here. Paths are repository-root-relative POSIX
// paths (mirrors the Wave 8 formalization manifest, which pins
// `skills/<name>/SKILL.md` from the repo root) — the Wave 2 installer resolves
// each under the package root and rejects absolute / traversal paths.
// `logicalId` is the stable, module-namespaced identifier the runtime pins
// against so it never falls back to global resource lookup (WAVE9 exit gate
// §2.2).
//
// Delivery has no LM authoring nodes (its nodes are kernel / human / external),
// so it pins no execution skills — only the deterministic guidance the kernel
// preflight, the human approval interaction, the external publish/observe
// adapters and the settlement handler load. This is the contract surface A6
// (external effects / human approval / idempotency / ports / receipts /
// contributions) submits against.
// ---------------------------------------------------------------------------

/**
 * Repository-root-relative POSIX paths to the resources delivery pins. The
 * resources physically live under the delivery package directory
 * (`src/process-modules/modules/delivery/package/resources/`); the manifest
 * pins them from the repo root so the installer + tests resolve them without
 * module-private path knowledge.
 */
const RESOURCE_ROOT =
  'src/process-modules/modules/delivery/package/resources';
const RESOURCE_PATHS = {
  // Preflight: deterministic release-guard evidence assembly instructions.
  preflightInstructions: `${RESOURCE_ROOT}/preflight-release-instructions.md`,
  // Preflight checklist: the guard-set the kernel demands before approval.
  preflightChecklist: `${RESOURCE_ROOT}/preflight-release-checklist.md`,
  // Human approval: the authorized-decision interaction contract guidance.
  approvalInstructions: `${RESOURCE_ROOT}/approve-release-instructions.md`,
  // External publish/deploy: desired-state action + idempotency-key guidance.
  publicationInstructions: `${RESOURCE_ROOT}/publish-deploy-instructions.md`,
  // External observe: authoritative target-state observation guidance.
  observationInstructions: `${RESOURCE_ROOT}/observe-release-instructions.md`,
  // Settlement: exact-product + candidate-immutability settlement guidance.
  settlementInstructions: `${RESOURCE_ROOT}/settle-delivery-instructions.md`,
  // Shared error hint catalog the non-terminal nodes surface on guard failure.
  errorHints: `${RESOURCE_ROOT}/delivery-error-hints.md`,
} as const;

/**
 * The full resource index for the delivery package. Pinned by `logicalId`
 * (module-namespaced, unique within this manifest) so the runtime resolves
 * every resource through the package and never through global lookup.
 *
 * `digest` is the documented `'pending@wave-2'` placeholder: Wave 2's
 * content-addressed installer replaces it with `sha256Hex` of each resource's
 * real bytes at install time.
 */
export const DELIVERY_RESOURCE_INDEX: readonly ResourceIndexEntry[] = [
  // --- Preflight (kernel) ------------------------------------------------
  {
    logicalId: 'delivery.instruction.preflight-release',
    path: RESOURCE_PATHS.preflightInstructions,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'delivery.checklist.preflight-release',
    path: RESOURCE_PATHS.preflightChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
  // --- Approval (human) --------------------------------------------------
  {
    logicalId: 'delivery.instruction.approve-release',
    path: RESOURCE_PATHS.approvalInstructions,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  // --- Publish/Deploy (external) -----------------------------------------
  {
    logicalId: 'delivery.instruction.publish-deploy',
    path: RESOURCE_PATHS.publicationInstructions,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  // --- Observe (external) ------------------------------------------------
  {
    logicalId: 'delivery.instruction.observe-release',
    path: RESOURCE_PATHS.observationInstructions,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  // --- Settlement (kernel) -----------------------------------------------
  {
    logicalId: 'delivery.instruction.settle-delivery',
    path: RESOURCE_PATHS.settlementInstructions,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  // --- Shared error hints ------------------------------------------------
  {
    logicalId: 'delivery.hint.error-catalog',
    path: RESOURCE_PATHS.errorHints,
    kind: 'error-hint',
    digest: PENDING_DIGEST,
  },
];

// ---------------------------------------------------------------------------
// Handler refs.
//
// Stable, content-addressed references to the kernel handlers and the
// external / human adapters the delivery flow wires up in
// `delivery-process-module.ts` / `delivery-installation.ts`. Handlers are NOT
// shipped in the manifest — only stable references. The Wave 2+ adapter
// registry resolves each `logicalId` to the concrete handler/adapter by name.
// `digest` is the documented placeholder until the handler registry
// content-addresses handler implementations.
// ---------------------------------------------------------------------------

/** Shared placeholder handler version (matches the module version's minor). */
const HANDLER_VERSION = '1.0.0';

function deliveryHandlerRef(logicalId: string): HandlerRef {
  return {
    logicalId,
    version: HANDLER_VERSION,
    digest: PENDING_DIGEST,
  };
}

/**
 * The complete set of kernel handler references for the delivery package. Each
 * `logicalId` matches the `handler:` field declared on the corresponding
 * kernel node in `delivery-process-module.ts` and the key registered in
 * `DELIVERY_KERNEL_HANDLER_IDS` (`delivery-kernel-ports.ts`).
 */
export const DELIVERY_KERNEL_HANDLER_REFS: readonly HandlerRef[] = [
  deliveryHandlerRef(DELIVERY_KERNEL_HANDLER_IDS.preflight),
  deliveryHandlerRef(DELIVERY_KERNEL_HANDLER_IDS.publishDeploy),
  deliveryHandlerRef(DELIVERY_KERNEL_HANDLER_IDS.observeRelease),
  deliveryHandlerRef(DELIVERY_KERNEL_HANDLER_IDS.settle),
];

/**
 * The complete set of human interaction adapter references for the delivery
 * package. Each `logicalId` matches the `interactionContract:` field on the
 * human approval node and the key registered in `DELIVERY_HUMAN_ADAPTER_IDS`.
 *
 * Delivery has no `external` flow nodes anymore (CGAD P18: the `external` node
 * kind was a backdoor that let modules self-hire workers or call external
 * systems through an opaque adapter). publish-deploy and observe-release now
 * run as KERNEL handlers backed by deterministic provider ports
 * (DeliveryPublicationPort / DeliveryObservationPort) injected at composition.
 */
export const DELIVERY_HUMAN_ADAPTER_REFS: readonly HandlerRef[] = [
  deliveryHandlerRef(DELIVERY_HUMAN_ADAPTER_IDS.approval),
];

/**
 * The union of every handler / adapter reference the delivery package pins.
 * The manifest envelope carries this as `handlerRefs` so the runtime resolves
 * all callable identities through the package (no global lookup).
 */
export const DELIVERY_HANDLER_REFS: readonly HandlerRef[] = [
  ...DELIVERY_KERNEL_HANDLER_REFS,
  ...DELIVERY_HUMAN_ADAPTER_REFS,
];

// ---------------------------------------------------------------------------
// Contract refs.
//
// The input/output contracts of the delivery package. `schemaId` matches the
// `inputContract.id` / `outputContract.id` on the wrapped definition;
// `version`/`digest` are the documented Wave 9 placeholders until the
// ContractSchemaRegistry (W1-A5) ships concrete codecs behind each schema id.
// ---------------------------------------------------------------------------

/**
 * Build a ContractRef for a delivery schema id. Uses the documented
 * `CONTRACT_REF_PENDING_DIGEST` placeholder: Wave 2 replaces it with
 * `computeContractRefDigest(canonicalSchemaDocument)` once codecs land.
 */
function deliveryContractRef(schemaId: string): ContractRef {
  return {
    schemaId,
    version: '1.0.0',
    digest: CONTRACT_REF_PENDING_DIGEST,
  };
}

/** Input contract: one DeliveryReleaseCase bound to a verified candidate. */
export const DELIVERY_INPUT_CONTRACT_REF: ContractRef = deliveryContractRef(
  DELIVERY_RELEASE_CASE_SCHEMA,
);

/** Output contract: the canonical ReleaseRecord. */
export const DELIVERY_OUTPUT_CONTRACT_REF: ContractRef = deliveryContractRef(
  RELEASE_RECORD_SCHEMA,
);

// ---------------------------------------------------------------------------
// Central manifest.
// ---------------------------------------------------------------------------

/**
 * The central, validated ProcessModuleManifest for the Delivery/Release
 * package.
 *
 * This is the single object Wave 9 hands to the installer: it wraps the
 * existing pure {@link deliveryProcessModule} definition and declares the
 * pinned resources, handlers and contracts the module depends on. Other W9
 * delivery lanes (A6) submit entries to A5, which reconciles them HERE — never
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
export const deliveryPackageManifest: ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    manifestFormatVersion: DELIVERY_MANIFEST_FORMAT_VERSION,
    definition: deliveryProcessModule,
    resourceIndex: DELIVERY_RESOURCE_INDEX,
    handlerRefs: DELIVERY_HANDLER_REFS,
    inputContractRef: DELIVERY_INPUT_CONTRACT_REF,
    outputContractRef: DELIVERY_OUTPUT_CONTRACT_REF,
    runtimeCompatibilityRange: DELIVERY_RUNTIME_COMPATIBILITY_RANGE,
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    const rendered = validation.errors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    throw new Error(
      `delivery package manifest failed validation:\n${rendered}`,
    );
  }
  return manifest;
})();
