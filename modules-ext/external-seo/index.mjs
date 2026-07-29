// @ts-check
/**
 * W10-A2 — External SEO/Analytics package export surface.
 *
 * Single import surface for the installable External-node package. Downstream
 * consumers (the Wave 2 installer, the composition root, the W10-A8 proof test)
 * import the validated manifest, node protocols, adapter contribution, and
 * registration helper from here.
 *
 *   import { externalSeoPackage } from '<repo>/modules-ext/external-seo/index.mjs';
 *   externalSeoPackage.manifest                // validated ProcessModuleManifest
 *   externalSeoPackage.nodeProtocols           // validated NodeProtocolDefinition[]
 *   externalSeoPackage.adapters                // Record<adapterId, ExternalAdapter>
 *   externalSeoPackage.registerAdapters(reg)   // bind adapters onto a registry
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a2.md`.
 */

import {
  externalSeoManifest,
  EXTERNAL_SEO_RESOURCE_INDEX,
  EXTERNAL_SEO_HANDLER_REFS,
  EXTERNAL_SEO_ADAPTER_REF,
  EXTERNAL_SEO_ADAPTERS,
  EXTERNAL_SEO_INPUT_CONTRACT_REF,
  EXTERNAL_SEO_OUTPUT_CONTRACT_REF,
  EXTERNAL_SEO_MANIFEST_FORMAT_VERSION,
  EXTERNAL_SEO_RUNTIME_COMPATIBILITY_RANGE,
  registerExternalSeoAdapters,
} from './manifest.mjs';
import {
  EXTERNAL_SEO_MODULE_REF,
  EXTERNAL_SEO_MODULE_KEY,
  EXTERNAL_SEO_INPUT_SCHEMA,
  EXTERNAL_SEO_OUTPUT_SCHEMA,
  SEO_RANKING_ADAPTER_REF,
} from './definition.mjs';
import { externalSeoNodeProtocols } from './node-protocols.mjs';
import { buildRankingSnapshot } from './adapter.mjs';

/**
 * The frozen package descriptor. Everything an installer or composition root
 * needs to install + dispatch this module, with no reference to any built-in
 * module, the catalog, or the composition root.
 */
export const externalSeoPackage = Object.freeze({
  /** Canonical `name@version` identity. */
  moduleKey: EXTERNAL_SEO_MODULE_KEY,
  /** Module identity reference. */
  moduleRef: EXTERNAL_SEO_MODULE_REF,
  /** Validated central manifest (the object an installer persists). */
  manifest: externalSeoManifest,
  /** Validated NodeProtocolDefinitions, one per external flow node. */
  nodeProtocols: externalSeoNodeProtocols,
  /** Content-addressed resource index. */
  resourceIndex: EXTERNAL_SEO_RESOURCE_INDEX,
  /** Adapter / handler references declared by the flow nodes. */
  handlerRefs: EXTERNAL_SEO_HANDLER_REFS,
  /** The shipped adapter implementations keyed by versioned registry id. */
  adapters: EXTERNAL_SEO_ADAPTERS,
  /** Input contract schema id. */
  inputSchema: EXTERNAL_SEO_INPUT_SCHEMA,
  /** Output contract schema id. */
  outputSchema: EXTERNAL_SEO_OUTPUT_SCHEMA,
  /** Input contract reference. */
  inputContractRef: EXTERNAL_SEO_INPUT_CONTRACT_REF,
  /** Output contract reference. */
  outputContractRef: EXTERNAL_SEO_OUTPUT_CONTRACT_REF,
  /** Manifest format version. */
  manifestFormatVersion: EXTERNAL_SEO_MANIFEST_FORMAT_VERSION,
  /** Runtime compatibility range. */
  runtimeCompatibilityRange: EXTERNAL_SEO_RUNTIME_COMPATIBILITY_RANGE,
  /** The versioned adapter id the fetch-ranking node pins. */
  adapterRef: SEO_RANKING_ADAPTER_REF,
  /** Adapter reference envelope (logicalId / version / digest). */
  adapterRefEnvelope: EXTERNAL_SEO_ADAPTER_REF,
  /** Register shipped adapters onto an ExternalAdapterRegistry. */
  registerAdapters: registerExternalSeoAdapters,
});

export {
  externalSeoManifest,
  externalSeoNodeProtocols,
  EXTERNAL_SEO_RESOURCE_INDEX,
  EXTERNAL_SEO_HANDLER_REFS,
  EXTERNAL_SEO_ADAPTER_REF,
  EXTERNAL_SEO_ADAPTERS,
  registerExternalSeoAdapters,
  EXTERNAL_SEO_INPUT_CONTRACT_REF,
  EXTERNAL_SEO_OUTPUT_CONTRACT_REF,
  EXTERNAL_SEO_MANIFEST_FORMAT_VERSION,
  EXTERNAL_SEO_RUNTIME_COMPATIBILITY_RANGE,
  EXTERNAL_SEO_MODULE_REF,
  EXTERNAL_SEO_MODULE_KEY,
  EXTERNAL_SEO_INPUT_SCHEMA,
  EXTERNAL_SEO_OUTPUT_SCHEMA,
  SEO_RANKING_ADAPTER_REF,
  buildRankingSnapshot,
};

export default externalSeoPackage;
