// @ts-check
/**
 * W9-A3 — Verification (acceptance-verification workset) node package barrel.
 *
 * Public surface of the development Verification node package. The central
 * manifest (this lane, `modules/development/package/manifest.mjs`) imports from
 * here to stitch this node's protocol, resource index, and handler refs into
 * the module-wide `resourceIndex` / `handlerRefs` / node-protocol registry.
 *
 * Re-exports:
 *   - `verificationNodeProtocol`        — the NodeProtocolDefinition for
 *                                         `verify-acceptance-workset`.
 *   - `verificationNodeResources`       — package-relative ResourceIndexEntry[]
 *                                         (skills, templates, schemas).
 *   - `verificationNodeHandlerRefs`     — stable handler refs the downstream
 *                                         settlement kernel uses (bound by W9-A4).
 *   - `VERIFICATION_NODE_ID`            — owning Flow node id (join key).
 *   - `VERIFICATION_ADAPTER_ID`         — external adapter id driving the workset.
 *   - `VERIFICATION_OUTPUT_SCHEMA`      — output schema id the node produces.
 *   - `VERIFICATION_RESOURCE_IDS`       — stable resource logical-id keys.
 */

export {
  verificationNodeProtocol,
  verificationNodeResources,
  verificationNodeHandlerRefs,
  VERIFICATION_NODE_ID,
  VERIFICATION_ADAPTER_ID,
  VERIFICATION_OUTPUT_SCHEMA,
  VERIFICATION_RESOURCE_IDS,
} from './node-protocol.mjs';

export { default } from './node-protocol.mjs';
