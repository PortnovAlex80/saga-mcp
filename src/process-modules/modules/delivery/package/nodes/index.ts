/**
 * W9-A5 — Barrel index for the Delivery flow-node protocols.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`
 *       lane W9-A5.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a5.md`.
 * Plan: §0.12.
 *
 * Single import surface for the delivery flow-node protocols. The package
 * index (../index.js) re-exports from here; W9-A8 conformance tests import
 * from here. Other W9 delivery lanes (A6) MUST NOT import across lane
 * subtrees; they submit manifest entries to A5 instead.
 *
 * Exports:
 *   - `PREFLIGHT_RELEASE_NODE_PROTOCOL`   — kernel `preflight-release`.
 *   - `APPROVE_RELEASE_NODE_PROTOCOL`     — human `approve-release`.
 *   - `PUBLISH_DEPLOY_NODE_PROTOCOL`      — external `publish-deploy`.
 *   - `OBSERVE_RELEASE_NODE_PROTOCOL`     — external `observe-release`.
 *   - `SETTLE_DELIVERY_NODE_PROTOCOL`     — kernel `settle-delivery`.
 *   - `DELIVERY_NODE_PROTOCOLS`           — all five (frozen).
 *   - `DELIVERY_NODE_FLOW_IDS`            — owning Flow node ids (frozen).
 *   - `validateDeliveryLaneProtocols()`   — structural self-check.
 */

export {
  PREFLIGHT_RELEASE_NODE_PROTOCOL,
  APPROVE_RELEASE_NODE_PROTOCOL,
  PUBLISH_DEPLOY_NODE_PROTOCOL,
  OBSERVE_RELEASE_NODE_PROTOCOL,
  SETTLE_DELIVERY_NODE_PROTOCOL,
  DELIVERY_NODE_PROTOCOLS,
  DELIVERY_NODE_FLOW_IDS,
  validateDeliveryLaneProtocols,
  validateNodeProtocolDefinition,
} from './delivery-node-protocols.js';
