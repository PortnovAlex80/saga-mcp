/**
 * W9-A5 — Delivery package export surface.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a5.md`.
 *
 * Single import surface for the Delivery/Release Process Module package. Wave
 * 9 migrates Delivery to run through pinned package resources: downstream code
 * (the installer, the content-addressed package store, the composition root)
 * imports the central manifest + its declared resources/handlers/contracts
 * from here so Delivery runs through pinned package resources with no global
 * lookup (WAVE9-PRODUCTION-MIGRATION-SPEC §2 — the same kit Formalization
 * passed in Wave 8).
 *
 *   import {
 *     deliveryPackageManifest,
 *     DELIVERY_RESOURCE_INDEX,
 *     DELIVERY_HANDLER_REFS,
 *   } from '../package/index.js';
 *
 * Lane ownership: A5 owns this `package/` directory (manifest.ts + index.ts +
 * the flow-node protocols under nodes/) exclusively. Other W9 delivery lanes
 * (A6) submit entries to A5 for reconciliation into the manifest; they do not
 * add exports here directly.
 */

export {
  // Central manifest (validated at module load).
  deliveryPackageManifest,
  // Manifest identity + format constants.
  DELIVERY_MANIFEST_FORMAT_VERSION,
  DELIVERY_RUNTIME_COMPATIBILITY_RANGE,
  DELIVERY_MODULE_KEY,
  // Declared package surface.
  DELIVERY_RESOURCE_INDEX,
  DELIVERY_HANDLER_REFS,
  DELIVERY_KERNEL_HANDLER_REFS,
  DELIVERY_HUMAN_ADAPTER_REFS,
  DELIVERY_INPUT_CONTRACT_REF,
  DELIVERY_OUTPUT_CONTRACT_REF,
} from './manifest.js';

export {
  // Flow-node protocols (one per delivery flow node).
  PREFLIGHT_RELEASE_NODE_PROTOCOL,
  APPROVE_RELEASE_NODE_PROTOCOL,
  PUBLISH_DEPLOY_NODE_PROTOCOL,
  OBSERVE_RELEASE_NODE_PROTOCOL,
  SETTLE_DELIVERY_NODE_PROTOCOL,
  DELIVERY_NODE_PROTOCOLS,
  DELIVERY_NODE_FLOW_IDS,
  validateDeliveryLaneProtocols,
} from './nodes/index.js';
