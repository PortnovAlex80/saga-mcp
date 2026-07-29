/**
 * W9-A6 — Delivery package-local contributions barrel.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6 owns the Delivery contributions + external-effects /
 *       human-approval / idempotency / ports / receipts subtrees).
 *
 * This is the single import surface for the Delivery package's contributions
 * subdirectory. Every contribution category the package declares — tool
 * contributions, acceptance capabilities, output contracts, recovery policies,
 * and the Delivery-specific external-effects / human-approval / idempotency /
 * ports / receipts subtrees — is re-exported here so the manifest builder
 * (W9-A5) and downstream consumers can import the full set from one path:
 *
 *   import {
 *     DELIVERY_TOOL_CONTRIBUTIONS,
 *     DELIVERY_CAPABILITY_REQUIREMENTS,
 *     DELIVERY_GUARD_BINDINGS,
 *     DELIVERY_INPUT_CONTRACT,
 *     DELIVERY_OUTPUT_CONTRACT,
 *     DELIVERY_DECLARED_OUTCOMES,
 *     DELIVERY_RECOVERY_POLICY_BINDINGS,
 *     DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS,
 *     DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS,
 *     DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS,
 *     DELIVERY_PORT_CONTRIBUTIONS,
 *     DELIVERY_RECEIPT_TYPES,
 *   } from './contributions/index.js';
 *
 * All contributions are PURE DATA: readonly constants typed by the Wave 1 SPI
 * (`domain/spi/*`) or by the package-local contribution types declared in the
 * sibling files. No behavior, no factories, no persistence. The dependency-
 * direction ratchet permits module files to import the pure domain SPI; this
 * barrel introduces no new architectural edges beyond each sibling file's own
 * domain-SPI imports. The idempotency and ports subtrees import nothing
 * outside their own declarations.
 *
 * ── Ownership ─────────────────────────────────────────────────────────────
 *
 * W9-A6 owns this `contributions/` subdirectory exclusively. The sibling lane
 * (W9-A5) owns the rest of `package/` (manifest.ts + index.ts + the flow-node
 * protocols under nodes/ + the resources). Per the task: W9-A6 does NOT edit
 * the central manifest. The contributions live as a pure-data subtree that
 * W9-A5 reconciles into the manifest in a later reconciliation step — exactly
 * the W9-A2 / W8-A7 pattern (plan §0.1.4: one writer per path per wave).
 */

// Tool contributions — MCP tool declarations (preflight/approve/publish-deploy/
// observe/settle/record).
export {
  DELIVERY_TOOL_NAMESPACE,
  DELIVERY_TOOL_RESOURCE_IDS,
  DELIVERY_PREFLIGHT_RELEASE_CONTRIBUTION,
  DELIVERY_APPROVE_RELEASE_CONTRIBUTION,
  DELIVERY_PUBLISH_DEPLOY_CONTRIBUTION,
  DELIVERY_OBSERVE_RELEASE_CONTRIBUTION,
  DELIVERY_SETTLE_DELIVERY_CONTRIBUTION,
  DELIVERY_RECORD_RELEASE_CONTRIBUTION,
  DELIVERY_TOOL_CONTRIBUTIONS,
} from './tool-contributions.js';

// Acceptance capabilities — capability requirements + package-level guards.
export {
  DELIVERY_CAP_MANAGED_PRODUCTION_LEDGER,
  DELIVERY_CAP_RUNTIME_PERSISTENCE,
  DELIVERY_CAP_PREFLIGHT_POLICY,
  DELIVERY_CAP_SETTLEMENT_POLICY,
  DELIVERY_CAP_OUTPUT_REPOSITORY,
  DELIVERY_CAP_TRUSTED_PROVIDER_REGISTRY,
  DELIVERY_CAP_APPROVAL_INBOX,
  DELIVERY_CAPABILITY_REQUIREMENTS,
  DELIVERY_GUARD_AUTHORITY_FENCE,
  DELIVERY_GUARD_MANAGED_PRODUCTION,
  DELIVERY_GUARD_NODE_ALLOWED_TOOLS,
  DELIVERY_GUARD_EXPLICIT_OPERATOR_AUTHORIZATION,
  DELIVERY_GUARD_APPROVAL_BINDS_EXACT_INPUT,
  DELIVERY_GUARD_NO_DEFAULT_PROVIDER,
  DELIVERY_GUARD_NO_FORCE_OR_BYPASS,
  DELIVERY_GUARD_PUSH_IS_NOT_RELEASE,
  DELIVERY_GUARD_CANDIDATE_IMMUTABLE,
  DELIVERY_GUARD_MODULE_DOES_NOT_ROUTE,
  DELIVERY_GUARD_BINDINGS,
} from './acceptance-capabilities.js';

// Output contracts — input/output/bundle/certificate contract refs + outcomes.
export {
  DELIVERY_INPUT_CONTRACT,
  DELIVERY_PREFLIGHT_BUNDLE_CONTRACT,
  DELIVERY_APPROVAL_BUNDLE_CONTRACT,
  DELIVERY_PUBLICATION_BUNDLE_CONTRACT,
  DELIVERY_OBSERVATION_BUNDLE_CONTRACT,
  DELIVERY_SETTLEMENT_INPUT_CONTRACT,
  DELIVERY_RELEASE_RECORD_CONTRACT,
  DELIVERY_OUTPUT_CONTRACT,
  DELIVERY_CERTIFICATE_CONTRACT,
  DELIVERY_NODE_OUTPUT_CONTRACTS,
  DELIVERY_DECLARED_OUTCOMES,
  DELIVERY_OUTCOME_CODES,
  type DeliveryDeclaredOutcome,
} from './output-contracts.js';

// Recovery policies — per-verifier-node recovery action maps.
export {
  DELIVERY_RECOVERY_TRIGGERS,
  DELIVERY_RECOVERY_PREFLIGHT,
  DELIVERY_RECOVERY_APPROVAL,
  DELIVERY_RECOVERY_PUBLICATION,
  DELIVERY_RECOVERY_OBSERVATION,
  DELIVERY_RECOVERY_SETTLEMENT,
  DELIVERY_RECOVERY_POLICY_BINDINGS,
} from './recovery-policies.js';

// External-effects contribution subtree — publish-deploy / observe-release
// adapter declarations + external-receipt evidence + action-kind coverage.
export {
  DELIVERY_RELEASE_ACTION_KINDS,
  type DeliveryReleaseActionKind,
  DELIVERY_EXTERNAL_RECEIPT_EVIDENCE,
  type ExternalEffectAdapterContribution,
  DELIVERY_PUBLISH_DEPLOY_ADAPTER_CONTRIBUTION,
  DELIVERY_OBSERVE_RELEASE_ADAPTER_CONTRIBUTION,
  DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS,
} from './external-effects.js';

// Human-approval contribution subtree — approve-release adapter declaration +
// human-receipt evidence + approval-status vocabulary.
export {
  DELIVERY_APPROVAL_STATUSES,
  type DeliveryApprovalStatus,
  DELIVERY_HUMAN_RECEIPT_EVIDENCE,
  type HumanApprovalAdapterContribution,
  DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION,
  DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS,
} from './human-approval.js';

// Idempotency contribution subtree — cross-run action-key strategy +
// idempotent tool ids + action-key identity fields.
export {
  DELIVERY_IDEMPOTENT_TOOL_IDS,
  DELIVERY_ACTION_KEY_IDENTITY_FIELDS,
  DELIVERY_ACTION_KEY_PREFIX,
  type IdempotencyStrategyContribution,
  DELIVERY_IDEMPOTENCY_STRATEGY,
  DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS,
} from './idempotency.js';

// Ports contribution subtree — module-local port declarations (preflight /
// approval / publication / observation / settlement / output-repository /
// preflight-policy / settlement-policy).
export {
  type ModulePortContribution,
  DELIVERY_PREFLIGHT_STATE_PORT_CONTRIBUTION,
  DELIVERY_APPROVAL_PORT_CONTRIBUTION,
  DELIVERY_PUBLICATION_PORT_CONTRIBUTION,
  DELIVERY_OBSERVATION_PORT_CONTRIBUTION,
  DELIVERY_SETTLEMENT_STATE_PORT_CONTRIBUTION,
  DELIVERY_OUTPUT_REPOSITORY_PORT_CONTRIBUTION,
  DELIVERY_PREFLIGHT_POLICY_PORT_CONTRIBUTION,
  DELIVERY_SETTLEMENT_POLICY_PORT_CONTRIBUTION,
  DELIVERY_PORT_CONTRIBUTIONS,
} from './ports.js';

// Receipts contribution subtree — durable action-receipt / action-observation
// declarations + status / outcome vocabularies.
export {
  DELIVERY_RECEIPT_STATUS_VALUES,
  DELIVERY_OBSERVATION_OUTCOME_VALUES,
  type ReceiptTypeContribution,
  DELIVERY_ACTION_RECEIPT_CONTRIBUTION,
  DELIVERY_ACTION_OBSERVATION_CONTRIBUTION,
  DELIVERY_RECEIPT_TYPES,
} from './receipts.js';
