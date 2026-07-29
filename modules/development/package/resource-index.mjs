// @ts-check
/**
 * W9-A3 — Central Development package resource index.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a3.md`.
 * Plan: §0.12.5 + §0.12.10 — this lane owns the central Development manifest;
 * the planning/verification node subtrees submit their resource declarations
 * here and this file stitches them into the module-wide `resourceIndex`.
 *
 * Each entry mirrors `ResourceIndexEntry` from
 * `src/process-modules/domain/spi/resource-index.ts`:
 *   - `logicalId`  stable, module-namespaced id (unique within the package).
 *   - `path`       PACKAGE-RELATIVE POSIX path under the Development package
 *                  root (`modules/development/package/`). Node subtrees declare
 *                  node-relative paths; this index prefixes them with
 *                  `nodes/<name>/` so every path resolves under the package root.
 *   - `kind`       one of the frozen `RESOURCE_KINDS`.
 *   - `digest`     the documented placeholder `'pending@wave-2'` until the Wave
 *                  2 content-addressed installer computes the real hash.
 *
 * Pure data only (plan §3.5). The manifest imports
 * `DEVELOPMENT_PACKAGE_RESOURCE_INDEX` and surfaces it as the manifest
 * `resourceIndex`, enforcing `logicalId` uniqueness across the whole package.
 *
 * Anti-scope: W9-A4 owns the contributions subtree
 * (`modules/development/package/contributions/`); it contributes handler
 * adapters, not package resources, so it does not extend this index.
 */

import { planningNodeResources } from './nodes/planning/node-protocol.mjs';
import { verificationNodeResources } from './nodes/verification/node-protocol.mjs';

/**
 * On-disk node subtree directory names (under `nodes/`). These are the
 * physical package directories, distinct from the Flow node ids
 * (`plan-task-graph`, `verify-acceptance-workset`): a node id names the Flow
 * node; the directory names the package subtree that owns it. Kept explicit so
 * the path-prefix step cannot drift if a node id is later renamed.
 */
const PLANNING_NODE_DIR = 'planning';
const VERIFICATION_NODE_DIR = 'verification';

/**
 * @typedef {import('../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 */

/**
 * Prefix a node subtree's node-relative resource paths with its package-relative
 * node directory (`nodes/<node-dir>/`). The Wave 2 installer resolves every
 * path under the package root and rejects absolute / traversal paths
 * (plan §5.3 / §13.17), so each entry MUST land under `nodes/`.
 *
 * @param {string} nodeDir   package-relative node directory, e.g. `planning`.
 * @param {readonly ResourceIndexEntry[]} nodeResources  node-relative entries.
 * @returns {readonly ResourceIndexEntry[]}
 */
function prefixWithNodeDir(nodeDir, nodeResources) {
  return Object.freeze(
    nodeResources.map((entry) =>
      Object.freeze({
        logicalId: entry.logicalId,
        path: `nodes/${nodeDir}/${entry.path}`,
        kind: entry.kind,
        digest: entry.digest,
      }),
    ),
  );
}

/**
 * The package-wide resource index: every package-local resource the Development
 * planning + verification node protocols reference. Every protocol step
 * `resources[]` logicalId MUST appear here exactly once — the W9-A8 package
 * isolation conformance test asserts that closure (no protocol references an
 * undeclared resource, no declared resource is unreferenced).
 *
 * `digest` uses the documented `'pending@wave-2'` placeholder for every entry:
 * Wave 2's content-addressed installer replaces it with the real `sha256Hex`
 * of the on-disk bytes at install time.
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const DEVELOPMENT_PACKAGE_RESOURCE_INDEX = Object.freeze([
  ...prefixWithNodeDir(PLANNING_NODE_DIR, planningNodeResources),
  ...prefixWithNodeDir(VERIFICATION_NODE_DIR, verificationNodeResources),
]);

/**
 * The set of logicalIds in this package, exported for the W9-A8 conformance
 * test (uniqueness-within-package check) and for early cross-node collision
 * detection.
 *
 * @readonly
 * @returns {readonly string[]}
 */
export const DEVELOPMENT_PACKAGE_RESOURCE_LOGICAL_IDS = Object.freeze(
  DEVELOPMENT_PACKAGE_RESOURCE_INDEX.map((entry) => entry.logicalId),
);

// Node protocol definitions are pure frozen data; importing them eagerly at
// module load is safe. Importing from each node-protocol source keeps the join
// key (owningFlowNodeId) authoritative in exactly one place.
import { planningNodeProtocol } from './nodes/planning/node-protocol.mjs';
import { verificationNodeProtocol } from './nodes/verification/node-protocol.mjs';

/**
 * Node-protocol registry: the Development package's NodeProtocolDefinitions.
 * The composition root (Wave 11) surfaces these to the runtime; this lane
 * declares them, W9-A4 binds handler adapters behind the handler refs each
 * node declares.
 *
 * @type {readonly import('../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition[]}
 */
export const DEVELOPMENT_NODE_PROTOCOLS = Object.freeze([
  planningNodeProtocol,
  verificationNodeProtocol,
]);
