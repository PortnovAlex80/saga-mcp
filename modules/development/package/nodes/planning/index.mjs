// @ts-check
/**
 * W9-A3 — Planning (task-graph planner) node package barrel.
 *
 * Public surface of the development Planning node package. The central
 * manifest (this lane, `modules/development/package/manifest.mjs`) imports from
 * here to stitch this node's protocol, resource index, and handler refs into
 * the module-wide `resourceIndex` / `handlerRefs` / node-protocol registry.
 *
 * Re-exports:
 *   - `planningNodeProtocol`        — the NodeProtocolDefinition for
 *                                     `plan-task-graph`.
 *   - `planningNodeResources`       — package-relative ResourceIndexEntry[]
 *                                     (skills, templates, schemas) for this node.
 *   - `planningNodeHandlerRefs`     — stable handler refs the downstream kernel
 *                                     resolver uses (bound by W9-A4).
 *   - `PLANNING_NODE_ID`            — owning Flow node id (join key).
 *   - `PLANNING_EXECUTION_PROFILE`  — execution profile binding the worker.
 *   - `PLANNING_OUTPUT_SCHEMA`      — output schema id the LM node produces.
 *   - `PLANNING_RESOURCE_IDS`       — stable resource logical-id keys.
 */

export {
  planningNodeProtocol,
  planningNodeResources,
  planningNodeHandlerRefs,
  PLANNING_NODE_ID,
  PLANNING_EXECUTION_PROFILE,
  PLANNING_OUTPUT_SCHEMA,
  PLANNING_RESOURCE_IDS,
} from './node-protocol.mjs';

export { default } from './node-protocol.mjs';
