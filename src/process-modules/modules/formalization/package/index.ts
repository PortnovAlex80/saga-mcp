/**
 * W8-A1 — Formalization package export surface.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a1.md`.
 *
 * Single import surface for the Formalization Process Module package. Wave 8
 * is the first production module migration: downstream code (the installer,
 * the content-addressed package store, the composition root) imports the
 * central manifest + its declared resources/handlers/contracts from here so
 * Formalization runs through pinned package resources with no global lookup
 * (WAVE8-FORMALIZATION-SPEC §2).
 *
 *   import {
 *     formalizationPackageManifest,
 *     FORMALIZATION_RESOURCE_INDEX,
 *     FORMALIZATION_HANDLER_REFS,
 *   } from '../package/index.js';
 *
 * Lane ownership: A1 owns this `package/` directory (manifest.ts + index.ts)
 * exclusively. Other W8 lanes submit entries to A1 for reconciliation into the
 * manifest; they do not add exports here directly.
 */

export {
  // Central manifest (validated at module load).
  formalizationPackageManifest,
  // Manifest identity + format constants.
  FORMALIZATION_MANIFEST_FORMAT_VERSION,
  FORMALIZATION_RUNTIME_COMPATIBILITY_RANGE,
  // Declared package surface.
  FORMALIZATION_RESOURCE_INDEX,
  FORMALIZATION_HANDLER_REFS,
  FORMALIZATION_INPUT_CONTRACT_REF,
  FORMALIZATION_OUTPUT_CONTRACT_REF,
  // Re-exported module key (name@version).
  FORMALIZATION_MODULE_KEY,
} from './manifest.js';
