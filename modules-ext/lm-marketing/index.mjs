// @ts-check
/**
 * W10-A1 — lm-marketing package export surface.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a1.md`.
 *
 * Single import surface for the Marketing LM Process Module package. An
 * installer or composition root imports the central manifest + its declared
 * resources/handlers/contracts and the NodeProtocol from here:
 *
 *   import {
 *     marketingPackageManifest,
 *     marketingResourceIndex,
 *     marketingHandlerRefs,
 *     marketingDraftCampaignNodeProtocol,
 *   } from '@saga-modules-ext/lm-marketing';
 *
 * The barrel re-exports PURE DATA only — no behavior, no factories, no
 * persistence. Every value is a frozen, canonically-serializable constant
 * validated against the public process-module SPI at load time.
 *
 * §0.13.10 import-list proof: every re-exported module below imports ONLY the
 * public process-module SPI (`domain/spi/*`) from the compiled `dist/` runtime
 * surface. None imports `src/index.ts`, `modules/catalog.ts`, `tracker-view/`,
 * the composition root, or any existing built-in module.
 */

export {
  // Module identity.
  LM_MARKETING_MODULE_KEY,
  LM_MARKETING_MODULE_REF,
  // Schema identifiers.
  LM_MARKETING_INPUT_SCHEMA,
  LM_MARKETING_OUTPUT_SCHEMA,
  LM_MARKETING_WORK_INTENT_SCHEMA,
  // Flow + profile identity.
  LM_MARKETING_FLOW_NODE_ID,
  LM_MARKETING_EXECUTION_PROFILE_ID,
  // Definition + profile.
  lmMarketingModule,
  marketingAuthorProfile,
  marketingResourcePaths,
} from './definition.mjs';

export {
  // Central manifest (validated at module load).
  marketingPackageManifest,
  validateMarketingPackageManifest,
  // Manifest identity + format constants.
  LM_MARKETING_MANIFEST_FORMAT_VERSION,
  LM_MARKETING_RUNTIME_COMPATIBILITY_RANGE,
} from './manifest.mjs';

export {
  // Declared package surface.
  marketingResourceIndex,
  marketingHandlerRefs,
  marketingInputContractRef,
  marketingOutputContractRef,
  MARKETING_HANDLER_IDS,
} from './contributions.mjs';

export {
  // NodeProtocol for the draft-campaign LM node.
  marketingDraftCampaignNodeProtocol,
  validateMarketingDraftCampaignNodeProtocol,
  MARKETING_AUTHOR_EXECUTION_PROFILE_ID,
  MARKETING_OUTPUT_SCHEMA,
} from './node-protocol.mjs';
