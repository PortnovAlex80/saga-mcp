// @ts-check
/**
 * W8-A4 — Acceptance + reconciliation subtree public surface (barrel).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a4.md`.
 *
 * This barrel is the SINGLE import surface W8-A1 (formalization package
 * manifest) and W8-A8 (conformance tests) consume. It re-exports the
 * NodeProtocolDefinitions, the schema-id constants, and the resource index
 * for the acceptance contract pair (AC author + resolver) and the
 * reconciliation trio (reconcile + resolve + freeze-baseline).
 *
 * Anti-scope: this barrel does NOT register handlers, does NOT touch the
 * central manifest, and does NOT import from `src/` at runtime — the only
 * cross-cutting reference is the JSDoc `@type`/`@typedef` pointers to the SPI
 * shapes, which are erased at runtime and exist purely for editor checking.
 */

export {
  ACCEPTANCE_NODE_IDS,
  ACCEPTANCE_SCHEMA_IDS,
  ACCEPTANCE_RESOURCE_PATHS,
  DEFINE_ACCEPTANCE_CONTRACT_PROTOCOL,
  RESOLVE_ACCEPTANCE_CONTRACT_PROTOCOL,
  ACCEPTANCE_NODE_PROTOCOLS,
} from './acceptance-node-protocol.mjs';

export {
  RECONCILIATION_NODE_IDS,
  RECONCILIATION_SCHEMA_IDS,
  RECONCILIATION_RESOURCE_PATHS,
  RECONCILE_WHAT_PROTOCOL,
  RESOLVE_RECONCILIATION_PROTOCOL,
  FREEZE_ACCEPTANCE_BASELINE_PROTOCOL,
  RECONCILIATION_NODE_PROTOCOLS,
} from './reconciliation-node-protocol.mjs';

export {
  ACCEPTANCE_RESOURCE_INDEX,
  ACCEPTANCE_RESOURCE_LOGICAL_IDS,
} from './resource-index.mjs';

/**
 * Every NodeProtocolDefinition owned by the acceptance + reconciliation
 * subtree. W8-A1 imports this and submits each entry to the central
 * formalization manifest's protocol index; W8-A8 validates each one via
 * `validateNodeProtocolDefinition`.
 *
 * @readonly
 * @returns {readonly import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition[]}
 */
import { ACCEPTANCE_NODE_PROTOCOLS } from './acceptance-node-protocol.mjs';
import { RECONCILIATION_NODE_PROTOCOLS } from './reconciliation-node-protocol.mjs';

export const ACCEPTANCE_SUBTREE_NODE_PROTOCOLS = Object.freeze([
  ...ACCEPTANCE_NODE_PROTOCOLS,
  ...RECONCILIATION_NODE_PROTOCOLS,
]);
