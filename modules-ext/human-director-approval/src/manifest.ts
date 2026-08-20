/**
 * W10-A3 — Human Director Approval package manifest.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a3.md`.
 *
 * This is the CENTRAL `ProcessModuleManifest` for the Human Director Approval
 * package. It wraps the pure `humanDirectorApprovalModule` definition and
 * declares the pinned resources, the director-console adapter reference, and
 * the versioned input/output contract refs the module depends on. The manifest
 * is validated at module load by `validateProcessModuleManifest` (W1-A2): a
 * structural regression throws synchronously and fails the package test.
 *
 * This is the production upgrade of the W0-A7 fixture's data-only
 * `manifest.json`: the fixture shipped a plain JSON rendering with placeholder
 * adapter references; this manifest is a real, validated
 * `ProcessModuleManifest` object the Wave 2 installer can persist and
 * content-hash verbatim.
 *
 * Purity (plan §3.5): the manifest is PURE DATA — no functions, no factories,
 * no class instances. Every field is canonically serializable. Resource and
 * handler digests use the documented `'pending@wave-2'` placeholder; the Wave 2
 * content-addressed installer replaces each with `sha256Hex` of the real bytes
 * at install time (exactly as the formalization package does).
 *
 * Import-boundary proof (WAVE10-EXTENSIBILITY-SPEC §4): this file imports ONLY
 * from `domain/spi/` (`module-manifest.js`, `resource-index.js`,
 * `contract-ref.js`) — the pure SPI surface. It NEVER imports `src/index.ts`,
 * `modules/catalog.ts`, the composition root, or any existing module. That
 * import list IS the §0.13.10 extensibility proof.
 */

import type { ContractRef } from '../../../dist/process-modules/domain/spi/contract-ref.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRACT_REF_PENDING_DIGEST } from '../../../dist/process-modules/domain/spi/contract-ref.js';
import type {
  HandlerRef,
  ProcessModuleManifest,
  ResourceIndexEntry,
} from '../../../dist/process-modules/domain/spi/module-manifest.js';
import {
  PENDING_DIGEST,
  validateProcessModuleManifest,
} from '../../../dist/process-modules/domain/spi/module-manifest.js';
import {
  DIRECTOR_CONSOLE_ADAPTER_REF,
  HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
  HUMAN_DIRECTOR_APPROVAL_RUNTIME_COMPATIBILITY_RANGE,
  HUMAN_DIRECTOR_INPUT_SCHEMA,
  HUMAN_DIRECTOR_INTERACTION_CONTRACT,
  HUMAN_DIRECTOR_OUTPUT_SCHEMA,
  humanDirectorApprovalModule,
} from './definition.ts';

// ---------------------------------------------------------------------------
// Manifest format version.
//
// `'1'` signals the envelope wraps a real ProcessModuleDefinition with a
// the formalization package's `FORMALIZATION_MANIFEST_FORMAT_VERSION`.
// ---------------------------------------------------------------------------

export const HUMAN_DIRECTOR_MANIFEST_FORMAT_VERSION = '1';

// ---------------------------------------------------------------------------
// Resource index.
//
// Every schema, skill and checklist the Human Director Approval package pins.
// Paths are module-RELATIVE POSIX paths rooted at the PACKAGE root (not the
// repository root): the Wave 2 installer resolves each under the package root
// and rejects absolute / traversal paths. `logicalId` is the stable,
// module-namespaced identifier the runtime pins against so it never falls back
// to global resource lookup (plan §0.11.11).
// ---------------------------------------------------------------------------

/** Package-relative paths to the resources this module pins. */
const RESOURCE_PATHS = {
  // Interaction contract JSON Schema (the Human node's interactionContract).
  interactionSchema: 'schemas/director-signoff.schema.json',
  // Input contract JSON Schema (the scored campaign bundle awaiting decision).
  inputSchema: 'schemas/director-signoff-input.schema.json',
  // Output contract JSON Schema (the director decision envelope).
  outputSchema: 'schemas/director-signoff-output.schema.json',
  // Instruction the director (or a director-console operator) follows to
  // record a decision. Pinned by the director-signoff NodeProtocol.
  directorSignoffInstruction: 'resources/director-signoff-instruction.md',
  // Checklist the director ticks before recording a decision.
  directorSignoffChecklist: 'resources/director-signoff-checklist.md',
} as const;

/**
 * The full resource index for the Human Director Approval package. Pinned by
 * `logicalId` (module-namespaced, unique within this manifest) so the runtime
 * resolves every resource through the package and never through global lookup.
 */
export const HUMAN_DIRECTOR_RESOURCE_INDEX: readonly ResourceIndexEntry[] = [
  {
    logicalId: 'human-director.interaction-schema',
    path: RESOURCE_PATHS.interactionSchema,
    kind: 'schema',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'human-director.input-schema',
    path: RESOURCE_PATHS.inputSchema,
    kind: 'schema',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'human-director.output-schema',
    path: RESOURCE_PATHS.outputSchema,
    kind: 'schema',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'human-director.signoff-instruction',
    path: RESOURCE_PATHS.directorSignoffInstruction,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'human-director.signoff-checklist',
    path: RESOURCE_PATHS.directorSignoffChecklist,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
];

// ---------------------------------------------------------------------------
// Handler / adapter refs.
//
// Stable, content-addressed references to the director-console adapter the
// Human node pauses on. Adapters are NOT shipped in the manifest — only stable
// references. The Wave 2+ human-interaction registry resolves the
// `logicalId` to the concrete `HumanInteractionAdapter` by contract id.
// ---------------------------------------------------------------------------

/**
 * The adapter reference for the director-signoff Human node. The `logicalId`
 * matches the `interactionContract.id` the node declares; `adapterRef` carries
 * the exact versioned adapter string (plan §5.5.10).
 */
export interface HumanDirectorAdapterRef {
  readonly nodeId: string;
  readonly interactionContractId: string;
  readonly adapterRef: string;
}

export const HUMAN_DIRECTOR_ADAPTER_REFS: readonly HumanDirectorAdapterRef[] =
  Object.freeze([
    {
      nodeId: 'director-signoff',
      interactionContractId: HUMAN_DIRECTOR_INTERACTION_CONTRACT,
      adapterRef: DIRECTOR_CONSOLE_ADAPTER_REF,
    },
  ]);

/**
 * The manifest's `handlerRefs` array. The ProcessModuleManifest carries
 * `HandlerRef` entries (logicalId / version / digest); for a Human module these
 * reference the interaction-adapter contract the node pauses on. The
 * `logicalId` is the interaction-contract id so the installer can bind it to
 * the human-interaction registry.
 */
export const HUMAN_DIRECTOR_HANDLER_REFS: readonly HandlerRef[] = Object.freeze([
  {
    logicalId: HUMAN_DIRECTOR_INTERACTION_CONTRACT,
    version: DIRECTOR_CONSOLE_ADAPTER_REF.split('@')[1] ?? '1.0.0',
    // K3 (de9b2f88): a handlerRef must pin a REAL implementation digest —
    // the 'pending@wave-2' placeholder is legal on resources only. The
    // digest covers this package's definition.ts raw bytes (the executable
    // implementation the manifest ships), per handlerImplementationDigest.
    digest: createHash('sha256')
      .update(readFileSync(new URL('./definition.ts', import.meta.url)))
      .digest('hex'),
  },
]);

// ---------------------------------------------------------------------------
// Contract refs.
//
// The input/output contracts of the package. `schemaId` matches the
// `inputContract.id` / `outputContract.id` on the wrapped definition;
// `version` / `digest` are the documented placeholders until the
// ContractSchemaRegistry (W1-A5) ships concrete codecs behind each schema id.
// ---------------------------------------------------------------------------

function humanDirectorContractRef(schemaId: string): ContractRef {
  return {
    schemaId,
    version: '1.0.0',
    digest: CONTRACT_REF_PENDING_DIGEST,
  };
}

/** Input contract: a scored campaign bundle awaiting a director decision. */
export const HUMAN_DIRECTOR_INPUT_CONTRACT_REF: ContractRef =
  humanDirectorContractRef(HUMAN_DIRECTOR_INPUT_SCHEMA);

/** Output contract: the director's signed decision envelope. */
export const HUMAN_DIRECTOR_OUTPUT_CONTRACT_REF: ContractRef =
  humanDirectorContractRef(HUMAN_DIRECTOR_OUTPUT_SCHEMA);

// ---------------------------------------------------------------------------
// Central manifest (validated at module load).
// ---------------------------------------------------------------------------

/**
 * The central, validated `ProcessModuleManifest` for the Human Director
 * Approval package.
 *
 * This is the single object the Wave 2 installer receives: it wraps the pure
 * {@link humanDirectorApprovalModule} definition and declares the pinned
 * resources, adapter reference and contracts the module depends on. The
 * manifest is validated at module load by
 * {@link validateProcessModuleManifest}, which enforces both canonical
 * serializability (plan §3.5) and structural completeness (required fields
 * present, `logicalId`s unique, `resourceIndex` kinds known). A regression
 * throws synchronously and fails the package test — the manifest is the
 * load-bearing seam between the pure definition and the content-addressed
 * package, so it must never load in an invalid state.
 */
export const humanDirectorApprovalManifest: ProcessModuleManifest = (() => {
  const manifest: ProcessModuleManifest = {
    manifestFormatVersion: HUMAN_DIRECTOR_MANIFEST_FORMAT_VERSION,
    definition: humanDirectorApprovalModule,
    resourceIndex: HUMAN_DIRECTOR_RESOURCE_INDEX,
    handlerRefs: HUMAN_DIRECTOR_HANDLER_REFS,
    inputContractRef: HUMAN_DIRECTOR_INPUT_CONTRACT_REF,
    outputContractRef: HUMAN_DIRECTOR_OUTPUT_CONTRACT_REF,
    runtimeCompatibilityRange:
      HUMAN_DIRECTOR_APPROVAL_RUNTIME_COMPATIBILITY_RANGE,
  };
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    const rendered = validation.errors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    throw new Error(
      `human-director-approval package manifest failed validation:\n${rendered}`,
    );
  }
  return manifest;
})();

/** Re-exported module key (`name@version`) for consumers on the same surface. */
export const HUMAN_DIRECTOR_MODULE_KEY = `${HUMAN_DIRECTOR_APPROVAL_MODULE_REF.name}@${HUMAN_DIRECTOR_APPROVAL_MODULE_REF.version}`;
