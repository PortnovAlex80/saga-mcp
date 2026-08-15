/**
 * W9-A1 — Discovery package export surface.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a1.md`.
 *
 * Single import surface for the Product Discovery Process Module package.
 * Wave 9 applies the Wave 8 Formalization migration pattern to Discovery
 * (WAVE9-PRODUCTION-MIGRATION-SPEC §1): downstream code (the installer, the
 * content-addressed package store, the composition root) imports the central
 * manifest + its declared resources/handlers/contracts from here so Discovery
 * runs through pinned package resources with no global lookup
 * (WAVE9-PRODUCTION-MIGRATION-SPEC §2).
 *
 *   import {
 *     discoveryPackageManifest,
 *     DISCOVERY_RESOURCE_INDEX,
 *     DISCOVERY_HANDLER_REFS,
 *   } from '../package/index.js';
 *
 * Lane ownership: A1 owns this `package/` directory (manifest.ts + index.ts)
 * exclusively. Other W9 Discovery lanes (A2) submit entries to A1 for
 * reconciliation into the manifest; they do not add exports here directly.
 */

export {
  // Central manifest (validated at module load).
  discoveryPackageManifest,
  // Manifest identity + format constants.
  DISCOVERY_MANIFEST_FORMAT_VERSION,
  DISCOVERY_RUNTIME_COMPATIBILITY_RANGE,
  // Module identity.
  DISCOVERY_MODULE_KEY,
  DISCOVERY_PROCESS_MODULE_REF,
  // Handler identities pinned by the manifest.
  DISCOVERY_HANDLER_IDS,
  // Declared package surface.
  DISCOVERY_RESOURCE_INDEX,
  DISCOVERY_HANDLER_REFS,
  DISCOVERY_INPUT_CONTRACT_REF,
  DISCOVERY_OUTPUT_CONTRACT_REF,
  // Contract schema ids.
  DISCOVERY_CASE_SCHEMA,
  DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
} from './manifest.js';
