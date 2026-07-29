// @ts-check
/**
 * W8-A2 — Product (PRD) node package barrel.
 *
 * Public surface of the formalization Product node package. The central
 * manifest (W8-A1, `modules/formalization/package/manifest.ts`) imports from
 * here to stitch this node's protocol, resource index, and handler refs into
 * the module-wide `resourceIndex` / `handlerRefs` / node-protocol registry.
 *
 * Re-exports:
 *   - `productNodeProtocol`          — the NodeProtocolDefinition for
 *                                      `define-product-contract`.
 *   - `productNodeResources`         — package-relative ResourceIndexEntry[]
 *                                      (skills, templates, schemas) for this node.
 *   - `productNodeHandlerRefs`       — stable handler refs the downstream
 *                                      kernel resolver uses (bound by W8-A6).
 *   - `PRODUCT_NODE_ID`              — owning Flow node id (join key).
 *   - `PRODUCT_EXECUTION_PROFILE`    — execution profile binding the worker.
 *   - `PRODUCT_OUTPUT_SCHEMA`        — output schema id the LM node produces.
 *   - `PRODUCT_RESOURCE_IDS`         — stable resource logical-id keys.
 */

export {
  productNodeProtocol,
  productNodeResources,
  productNodeHandlerRefs,
  PRODUCT_NODE_ID,
  PRODUCT_EXECUTION_PROFILE,
  PRODUCT_OUTPUT_SCHEMA,
  PRODUCT_RESOURCE_IDS,
} from './node-protocol.mjs';

export { default } from './node-protocol.mjs';
