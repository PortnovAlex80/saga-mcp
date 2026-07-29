// @ts-check
/**
 * W9-A1 — Discovery node-subtree public surface (barrel).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a1.md`.
 *
 * This barrel is the SINGLE import surface the central manifest (W9-A1) and
 * the W9-A7/W9-A8 conformance tests consume. It re-exports the
 * NodeProtocolDefinitions, schema-id constants, resource paths and resource
 * index entries for the three LM-operated Discovery Flow nodes:
 *
 *   - `produce-proposal`   (entry LM node — investigate + submit typed proposal)
 *   - `normalize-semantic` (bounded D2 worker — transform ambiguous fields only)
 *   - `assess-readiness`   (advisory readiness classification — never routes)
 *
 * The diagnosis-advisor execution profile is ADVISORY-ONLY and has no flow
 * node (it runs as post-completion enrichment), so it carries no
 * NodeProtocolDefinition here — its resources are pinned by the central
 * manifest's `DISCOVERY_RESOURCE_INDEX` only.
 *
 * Anti-scope: this barrel does NOT register handlers, does NOT touch the
 * central manifest, and does NOT import from `src/` at runtime — the only
 * cross-cutting reference is the JSDoc `@type`/`@typedef` pointers to the SPI
 * shapes, which are erased at runtime and exist purely for editor checking.
 */

// Import the per-node modules once so the re-exports below and the aggregate
// constants share the same bindings (ESM `export ... from` re-exports do not
// create locally-referenceable bindings; explicit imports do).
import {
  PROPOSAL_NODE_ID,
  PROPOSAL_EXECUTION_PROFILE,
  PROPOSAL_OUTPUT_SCHEMA,
  PROPOSAL_RESOURCE_PATHS,
  PROPOSAL_RESOURCE_IDS,
  PROPOSAL_NODE_RESOURCES,
  PRODUCE_PROPOSAL_PROTOCOL,
} from './proposal/proposal-node-protocol.mjs';
import {
  NORMALIZATION_NODE_ID,
  NORMALIZATION_EXECUTION_PROFILE,
  NORMALIZATION_OUTPUT_SCHEMA,
  NORMALIZATION_RESOURCE_PATHS,
  NORMALIZATION_RESOURCE_IDS,
  NORMALIZATION_NODE_RESOURCES,
  NORMALIZE_SEMANTIC_PROTOCOL,
} from './normalization/normalization-node-protocol.mjs';
import {
  READINESS_NODE_ID,
  READINESS_EXECUTION_PROFILE,
  READINESS_OUTPUT_SCHEMA,
  READINESS_RESOURCE_PATHS,
  READINESS_RESOURCE_IDS,
  READINESS_NODE_RESOURCES,
  ASSESS_READINESS_PROTOCOL,
} from './readiness/readiness-node-protocol.mjs';

// Re-export every per-node binding so consumers import the full node-subtree
// surface from one path.
export {
  PROPOSAL_NODE_ID,
  PROPOSAL_EXECUTION_PROFILE,
  PROPOSAL_OUTPUT_SCHEMA,
  PROPOSAL_RESOURCE_PATHS,
  PROPOSAL_RESOURCE_IDS,
  PROPOSAL_NODE_RESOURCES,
  PRODUCE_PROPOSAL_PROTOCOL,
};
export {
  NORMALIZATION_NODE_ID,
  NORMALIZATION_EXECUTION_PROFILE,
  NORMALIZATION_OUTPUT_SCHEMA,
  NORMALIZATION_RESOURCE_PATHS,
  NORMALIZATION_RESOURCE_IDS,
  NORMALIZATION_NODE_RESOURCES,
  NORMALIZE_SEMANTIC_PROTOCOL,
};
export {
  READINESS_NODE_ID,
  READINESS_EXECUTION_PROFILE,
  READINESS_OUTPUT_SCHEMA,
  READINESS_RESOURCE_PATHS,
  READINESS_RESOURCE_IDS,
  READINESS_NODE_RESOURCES,
  ASSESS_READINESS_PROTOCOL,
};

/**
 * Every NodeProtocolDefinition owned by the Discovery node subtree. W9-A7/W9-A8
 * validate each one via `validateNodeProtocolDefinition`; the central manifest
 * pins the resources each references in `DISCOVERY_RESOURCE_INDEX`.
 *
 * @readonly
 * @returns {readonly import('../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition[]}
 */
export const DISCOVERY_NODE_PROTOCOLS = Object.freeze([
  PRODUCE_PROPOSAL_PROTOCOL,
  NORMALIZE_SEMANTIC_PROTOCOL,
  ASSESS_READINESS_PROTOCOL,
]);

/**
 * Every resource index entry owned by the Discovery node subtree (the union of
 * the three nodes' `*_NODE_RESOURCES` arrays). The central manifest's
 * `DISCOVERY_RESOURCE_INDEX` is the authoritative superset (it also pins the
 * diagnosis-advisor resources); this aggregate lets the package isolation
 * conformance test verify the closure independently of the central manifest.
 *
 * @readonly
 * @returns {readonly import('../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry[]}
 */
export const DISCOVERY_NODE_RESOURCES = Object.freeze([
  ...PROPOSAL_NODE_RESOURCES,
  ...NORMALIZATION_NODE_RESOURCES,
  ...READINESS_NODE_RESOURCES,
]);

/**
 * The owning flow node ids of every LM-operated Discovery node protocol.
 *
 * @readonly
 * @returns {readonly string[]}
 */
export const DISCOVERY_NODE_IDS = Object.freeze([
  PROPOSAL_NODE_ID,
  NORMALIZATION_NODE_ID,
  READINESS_NODE_ID,
]);
