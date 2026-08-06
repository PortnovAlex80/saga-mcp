/**
 * W9-A2 — Discovery package-local contributions barrel.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 *       adapter subtree).
 *
 * This is the single import surface for the Discovery package's contributions
 * subdirectory. Every contribution category the package declares — tool
 * contributions, acceptance capabilities, output contracts, reviewer skills,
 * the manifest builder (W9-A1) and downstream consumers can import the full
 * set from one path:
 *
 *   import {
 *     DISCOVERY_TOOL_CONTRIBUTIONS,
 *     DISCOVERY_CAPABILITY_REQUIREMENTS,
 *     DISCOVERY_GUARD_BINDINGS,
 *     DISCOVERY_INPUT_CONTRACT,
 *     DISCOVERY_OUTPUT_CONTRACT,
 *     DISCOVERY_DECLARED_OUTCOMES,
 *     DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES,
 *     DISCOVERY_RECOVERY_POLICY_BINDINGS,
 *     createDiscoveryPackageHandlerAdapter,
 *   } from './contributions/index.js';
 *
 * All contributions are PURE DATA: readonly constants typed by the Wave 1 SPI
 * (`domain/spi/*`). No behavior, no factories, no persistence. The dependency-
 * direction ratchet permits module files to import the pure domain SPI; this
 * barrel introduces no new architectural edges beyond each sibling file's own
 * a sibling module (`../../discovery-installation.js`) — that import is
 * intra-module (discovery → discovery), permitted by Rule 1.
 *
 * Ownership: W9-A2 owns this `contributions/` subdirectory exclusively. The
 * sibling lane (W9-A1) owns the rest of `package/`. If a sibling lane needs a
 * contribution not declared here, it stops and escalates rather than editing
 * this directory (plan §0.1.4: one writer per path per wave).
 */

// Tool contributions — MCP tool declarations (proposal/normalization/readiness/
// diagnosis/brief/worker_done).
export {
  DISCOVERY_TOOL_NAMESPACE,
  DISCOVERY_TOOL_RESOURCE_IDS,
  DISCOVERY_PROPOSAL_SUBMIT_CONTRIBUTION,
  DISCOVERY_NORMALIZATION_GET_CONTRIBUTION,
  DISCOVERY_NORMALIZATION_SUBMIT_CONTRIBUTION,
  DISCOVERY_READINESS_GET_CONTRIBUTION,
  DISCOVERY_READINESS_SUBMIT_CONTRIBUTION,
  DISCOVERY_DIAGNOSIS_GET_CONTRIBUTION,
  DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION,
  DISCOVERY_BRIEF_ARTIFACT_CREATE_CONTRIBUTION,
  DISCOVERY_WORKER_DONE_CONTRIBUTION,
  DISCOVERY_TOOL_CONTRIBUTIONS,
} from './tool-contributions.js';

// Acceptance capabilities — capability requirements + package-level guards.
export {
  DISCOVERY_CAP_MANAGED_PRODUCTION_LEDGER,
  DISCOVERY_CAP_RUNTIME_PERSISTENCE,
  DISCOVERY_CAP_SETTLEMENT_POLICY_REPOSITORY,
  DISCOVERY_CAP_OUTCOME_CERTIFICATE_ISSUER,
  DISCOVERY_CAP_LM_NODE_EXECUTION_PERSISTENCE,
  DISCOVERY_CAPABILITY_REQUIREMENTS,
  DISCOVERY_GUARD_AUTHORITY_FENCE,
  DISCOVERY_GUARD_MANAGED_PRODUCTION,
  DISCOVERY_GUARD_NODE_ALLOWED_TOOLS,
  DISCOVERY_GUARD_EXECUTION_ID_FENCE,
  DISCOVERY_GUARD_DIAGNOSIS_ADVISORY,
  DISCOVERY_GUARD_BINDINGS,
} from './acceptance-capabilities.js';

// Output contracts — input/output/bundle/certificate contract refs + outcomes.
export {
  DISCOVERY_INPUT_CONTRACT,
  DISCOVERY_PROPOSAL_BUNDLE_CONTRACT,
  DISCOVERY_NORMALIZATION_BUNDLE_CONTRACT,
  DISCOVERY_READINESS_BUNDLE_CONTRACT,
  DISCOVERY_DIAGNOSIS_BUNDLE_CONTRACT,
  DISCOVERY_BRIEF_BUNDLE_CONTRACT,
  DISCOVERY_SETTLEMENT_INPUT_CONTRACT,
  DISCOVERY_OUTPUT_CONTRACT,
  DISCOVERY_CERTIFICATE_CONTRACT,
  DISCOVERY_NODE_OUTPUT_CONTRACTS,
  DISCOVERY_DECLARED_OUTCOMES,
  DISCOVERY_OUTCOME_CODES,
  type DiscoveryDeclaredOutcome,
} from './output-contracts.js';

// Reviewer skills — pinned reviewer/author skill resource references.
export {
  DISCOVERY_READINESS_ADVISOR_REVIEWER_SKILL,
  DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL,
  DISCOVERY_WORKER_SKILL,
  DISCOVERY_NORMALIZER_SKILL,
  DISCOVERY_PROTOCOL_SKILL,
  DISCOVERY_KICKSTART_REVIEWER_SKILL,
  DISCOVERY_SKILL_RESOURCES,
  DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES,
  type DiscoverySkillResource,
} from './reviewer-skills.js';

// Recovery policies — REMOVED (Wave 6 cutover). The per-verifier
// `*_RECOVERY_POLICY_BINDINGS` + `*_RECOVERY_TRIGGERS` constants and this
// barrel's re-exports were dead code: consumed ONLY by the dead
// `UniversalRecoveryEngine` SPI (`application/recovery-engine.ts`, also
// deleted) and by tests of that SPI. Production recovery routing is
// `flow.recovery[]` executed by `generic-flow-executor.reconcileRecoveryCheckpoint`
// through the `RecoveryCaseRepository` port.

// port (mirrors W8-A6's formalization handler adapter).
export {
  DISCOVERY_PACKAGE_HANDLER_IDS,
  DiscoveryBriefProvisioningPort,
  DiscoveryBriefProvisioningContext,
  DiscoveryBriefProvisioningOutcome,
  DiscoveryPackagePorts,
  DiscoveryPackageHandlerAdapterOptions,
  FakeDiscoveryBriefProvisioningRecord,
  portInjectedEnsureDiscoveryBrief,
  createDiscoveryPackageHandlerAdapter,
  createFakeDiscoveryBriefProvisioningPort,
} from './handler-adapter.js';
