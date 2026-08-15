/**
 * W8-A7 — Formalization package-local contributions barrel.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
 *
 * This is the single import surface for the Formalization package's
 * contributions subdirectory. Every contribution category the package declares
 * — tool contributions, acceptance capabilities, output contracts, reviewer
 * skills, and recovery policies — is re-exported here so the manifest builder
 * (W8-A1) and downstream consumers can import the full set from one path:
 *
 *   import {
 *     FORMALIZATION_TOOL_CONTRIBUTIONS,
 *     FORMALIZATION_CAPABILITY_REQUIREMENTS,
 *     FORMALIZATION_GUARD_BINDINGS,
 *     FORMALIZATION_INPUT_CONTRACT,
 *     FORMALIZATION_OUTPUT_CONTRACT,
 *     FORMALIZATION_DECLARED_OUTCOMES,
 *     FORMALIZATION_SKILL_RESOURCE_INDEX_ENTRIES,
 *     FORMALIZATION_RECOVERY_POLICY_BINDINGS,
 *   } from './contributions/index.js';
 *
 * All contributions are PURE DATA: readonly constants typed by the Wave 1 SPI
 * (`domain/spi/*`). No behavior, no factories, no persistence. The dependency-
 * direction ratchet permits module files to import the pure domain SPI; this
 * barrel introduces no new architectural edges beyond each sibling file's own
 * domain-SPI imports.
 *
 * Ownership: W8-A7 owns this `contributions/` subdirectory exclusively. The
 * sibling lanes (W8-A1..A6) own the rest of `package/`. If a sibling lane
 * needs a contribution not declared here, it stops and escalates rather than
 * editing this directory (plan §0.1.4: one writer per path per wave).
 */

// Tool contributions — MCP tool declarations (artifact/trace/worker-done).
export {
  FORMALIZATION_TOOL_NAMESPACE,
  FORMALIZATION_TOOL_RESOURCE_IDS,
  FORMALIZATION_ARTIFACT_CREATE_CONTRIBUTION,
  FORMALIZATION_ARTIFACT_UPDATE_CONTRIBUTION,
  FORMALIZATION_TRACE_ADD_CONTRIBUTION,
  FORMALIZATION_WORKER_DONE_CONTRIBUTION,
  FORMALIZATION_TOOL_CONTRIBUTIONS,
} from './tool-contributions.js';

// Acceptance capabilities — capability requirements + package-level guards.
export {
  FORMALIZATION_CAP_MANAGED_PRODUCTION_LEDGER,
  FORMALIZATION_CAP_ARTIFACT_GRAPH_READER,
  FORMALIZATION_CAP_BASELINE_FREEZER,
  FORMALIZATION_CAP_SOLUTION_CONTRACT_REPOSITORY,
  FORMALIZATION_CAP_TRACEABILITY_POLICY,
  FORMALIZATION_CAPABILITY_REQUIREMENTS,
  FORMALIZATION_GUARD_AUTHORITY_FENCE,
  FORMALIZATION_GUARD_MANAGED_PRODUCTION,
  FORMALIZATION_GUARD_NODE_ALLOWED_TOOLS,
  FORMALIZATION_GUARD_EXECUTION_ID_FENCE,
  FORMALIZATION_GUARD_BASELINE_IMMUTABLE,
  FORMALIZATION_GUARD_BINDINGS,
} from './acceptance-capabilities.js';

// Output contracts — input/output/bundle/certificate contract refs + outcomes.
export {
  FORMALIZATION_INPUT_CONTRACT,
  FORMALIZATION_PRODUCT_BUNDLE_CONTRACT,
  FORMALIZATION_USE_CASE_BUNDLE_CONTRACT,
  FORMALIZATION_ACCEPTANCE_BUNDLE_CONTRACT,
  FORMALIZATION_RECONCILIATION_CONTRACT,
  FORMALIZATION_ACCEPTANCE_BASELINE_CONTRACT,
  FORMALIZATION_ARCHITECTURE_BUNDLE_CONTRACT,
  FORMALIZATION_SETTLEMENT_INPUT_CONTRACT,
  FORMALIZATION_OUTPUT_CONTRACT,
  FORMALIZATION_CERTIFICATE_CONTRACT,
  FORMALIZATION_NODE_OUTPUT_CONTRACTS,
  FORMALIZATION_DECLARED_OUTCOMES,
  FORMALIZATION_OUTCOME_CODES,
  type FormalizationDeclaredOutcome,
} from './output-contracts.js';

// Reviewer skills — pinned reviewer/author skill resource references.
export {
  FORMALIZATION_REQUIREMENTS_REVIEWER_SKILL,
  FORMALIZATION_ARCHITECTURE_REVIEWER_SKILL,
  FORMALIZATION_PRODUCT_SKILL,
  FORMALIZATION_ANALYST_SKILL,
  FORMALIZATION_ARCHITECT_SKILL,
  FORMALIZATION_RECONCILER_SKILL,
  FORMALIZATION_PROTOCOL_SKILL,
  FORMALIZATION_SKILL_RESOURCES,
  FORMALIZATION_SKILL_RESOURCE_INDEX_ENTRIES,
  type FormalizationSkillResource,
} from './reviewer-skills.js';

// Recovery policies — REMOVED (Wave 6 cutover). The per-verifier
// `*_RECOVERY_POLICY_BINDINGS` + `*_RECOVERY_TRIGGERS` constants and this
// barrel's re-exports were dead code: consumed ONLY by the dead
// `UniversalRecoveryEngine` SPI (`application/recovery-engine.ts`, also
// deleted) and by tests of that SPI. Production recovery routing is
// `flow.recovery[]` executed by `generic-flow-executor.reconcileRecoveryCheckpoint`
// through the `RecoveryCaseRepository` port.
