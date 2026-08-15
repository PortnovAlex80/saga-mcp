/**
 * W9-A4 — Development package-local contributions barrel.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.6 (W9-A4 owns the Development child execution/provenance/port/
 *       handler/product contribution subtrees).
 *
 * This is the single import surface for the Development package's contributions
 * subdirectory. Every contribution category the package declares — tool
 * contributions, acceptance capabilities, output contracts, and reviewer
 * skills — is re-exported here so the
 * manifest builder (W9-A3) and downstream consumers can import the full set
 * from one path:
 *
 *   import {
 *     DEVELOPMENT_TOOL_CONTRIBUTIONS,
 *     DEVELOPMENT_CAPABILITY_REQUIREMENTS,
 *     DEVELOPMENT_GUARD_BINDINGS,
 *     DEVELOPMENT_INPUT_CONTRACT,
 *     DEVELOPMENT_OUTPUT_CONTRACT,
 *     DEVELOPMENT_DECLARED_OUTCOMES,
 *     DEVELOPMENT_SKILL_RESOURCE_INDEX_ENTRIES,
 *   } from './contributions/index.js';
 *
 * All contributions are PURE DATA: readonly constants typed by the Wave 1 SPI
 * (`domain/spi/*`). No behavior, no factories, no persistence. The dependency-
 * direction ratchet permits module files to import the pure domain SPI; this
 * barrel introduces no new architectural edges beyond each sibling file's own
 * domain-SPI imports.
 *
 * Ownership: W9-A4 owns this `contributions/` subdirectory exclusively. The
 * sibling lane (W9-A3) owns the rest of `package/`. If a sibling lane needs a
 * contribution not declared here, it stops and escalates rather than editing
 * this directory (plan §0.1.4: one writer per path per wave).
 */

// Tool contributions — MCP tool declarations (planner submit / verifier
// evidence / planner worker_done / verifier worker_done).
export {
  DEVELOPMENT_TOOL_NAMESPACE,
  DEVELOPMENT_TOOL_RESOURCE_IDS,
  DEVELOPMENT_PROCESS_NODE_SUBMIT_CONTRIBUTION,
  DEVELOPMENT_VERIFICATION_RECORD_CONTRIBUTION,
  DEVELOPMENT_PLANNER_WORKER_DONE_CONTRIBUTION,
  DEVELOPMENT_VERIFIER_WORKER_DONE_CONTRIBUTION,
  DEVELOPMENT_TOOL_CONTRIBUTIONS,
} from './tool-contributions.js';

// Acceptance capabilities — capability requirements + package-level guards.
export {
  DEVELOPMENT_CAP_MANAGED_PRODUCTION_LEDGER,
  DEVELOPMENT_CAP_TASK_GRAPH_PERSISTENCE,
  DEVELOPMENT_CAP_EXTERNAL_WORKSET_EXECUTION,
  DEVELOPMENT_CAP_CANDIDATE_FREEZER,
  DEVELOPMENT_CAP_SETTLEMENT_STATE,
  DEVELOPMENT_CAP_OUTPUT_REPOSITORY,
  DEVELOPMENT_CAP_LM_NODE_EXECUTION_PERSISTENCE,
  DEVELOPMENT_CAPABILITY_REQUIREMENTS,
  DEVELOPMENT_GUARD_AUTHORITY_FENCE,
  DEVELOPMENT_GUARD_MANAGED_PRODUCTION,
  DEVELOPMENT_GUARD_NODE_ALLOWED_TOOLS,
  DEVELOPMENT_GUARD_EXECUTION_ID_FENCE,
  DEVELOPMENT_GUARD_EVIDENCE_PINS_CANDIDATE,
  DEVELOPMENT_GUARD_CANDIDATE_IMMUTABLE,
  DEVELOPMENT_GUARD_BINDINGS,
} from './acceptance-capabilities.js';

// Output contracts — input/output/bundle/certificate contract refs + outcomes.
export {
  DEVELOPMENT_INPUT_CONTRACT,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_CONTRACT,
  DEVELOPMENT_TASK_GRAPH_CONTRACT,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_CONTRACT,
  DEVELOPMENT_INTEGRATED_CANDIDATE_CONTRACT,
  DEVELOPMENT_ACCEPTANCE_VERIFICATION_CONTRACT,
  DEVELOPMENT_SETTLEMENT_INPUT_CONTRACT,
  DEVELOPMENT_OUTPUT_CONTRACT,
  DEVELOPMENT_CERTIFICATE_CONTRACT,
  DEVELOPMENT_CERTIFICATE_GENERIC_CONTRACT,
  DEVELOPMENT_NODE_OUTPUT_CONTRACTS,
  DEVELOPMENT_DECLARED_OUTCOMES,
  DEVELOPMENT_OUTCOME_CODES,
  type DevelopmentDeclaredOutcome,
} from './output-contracts.js';

// Reviewer skills — pinned reviewer/author skill resource references.
export {
  DEVELOPMENT_PLANNING_REVIEWER_SKILL,
  DEVELOPMENT_PLANNER_SKILL,
  DEVELOPMENT_VERIFIER_SKILL,
  DEVELOPMENT_PROTOCOL_SKILL,
  DEVELOPMENT_SKILL_RESOURCES,
  DEVELOPMENT_SKILL_RESOURCE_INDEX_ENTRIES,
  type DevelopmentSkillResource,
} from './reviewer-skills.js';

// Recovery policies — REMOVED (Wave 6 cutover). The per-verifier
// `*_RECOVERY_POLICY_BINDINGS` + `*_RECOVERY_TRIGGERS` constants and this
// barrel's re-exports were dead code: consumed ONLY by the dead
// `UniversalRecoveryEngine` SPI (`application/recovery-engine.ts`, also
// deleted) and by tests of that SPI. Production recovery routing is
// `flow.recovery[]` executed by `generic-flow-executor.reconcileRecoveryCheckpoint`
// through the `RecoveryCaseRepository` port.
