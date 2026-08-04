/**
 * Pure SPI barrel (W1-A8, plan §0.4.5, §14.2.6).
 *
 * This is the single import surface for the new pure-SPI layer introduced by
 * Wave 1 (plan §1, WAVE1-PURE-SPI-SPEC.md). Every Wave 1 lane adds types to a
 * sibling file under `domain/spi/`; this file re-exports all of them so that
 * downstream code (and Wave 1 conformance tests) can import from a single path:
 *
 *   import {
 *     ProcessModuleManifest,
 *     LifecycleScenarioManifest,
 *     validateProcessModuleManifest,
 *     ...
 *   } from '../domain/spi/index.js';
 *
 * Pure-SPI layer rules (plan §3.5, dependency-direction ratchet W0-A1):
 *   - Files under `domain/spi/` import only from sibling `domain/spi/*.ts`
 *     (via this barrel or relative paths), from `domain/*.ts` (existing pure
 *     domain), from `application/node-executor.ts` (type-only), and from
 *     `shared/canonical-json.ts` (frozen primitives). No imports from
 *     application (behavioral), persistence, composition, modules, or
 *     infrastructure. This keeps `domain/` pure per plan §3.16.
 *
 * Ownership: W1-A8 OWNS this `index.ts` file exclusively. The sibling
 * `domain/spi/*.ts` files are owned by lanes A1..A7. If a sibling file's
 * export name differs from the spec, STOP and escalate (do NOT add a divergent
 * alias here — the integrator reconciles after cherry-picking all lanes).
 *
 * Plan ref: §0.4.5, §0.4.11, §1 (frozen layout table), §3.5, §14.2.6.
 */

// INTEGRATION NOTE (integrator, Wave 1 cherry-pick): ValidationResult and
// ValidationError are structurally identical across module-manifest.ts,
// node-protocol.ts, production-envelope.ts, and scenario-manifest.ts (each lane
// defined its own copy in isolation). To avoid `export *` re-export collisions
// (TS2308), we re-export them ONCE from production-envelope.ts (the A6 center)
// and pull the lane-specific symbols from the other three files by name.
export {
  type ValidationError,
  type ValidationResult,
} from './production-envelope.js';

// W1-A1 — canonical serialization validator (functions: isCanonicalSerializable,
// assertCanonicalSerializable, canonicalJsonOrThrow; class CanonicalSerializationError).
export * from './canonical-serialization.js';

// W1-A5 — ContractRef + ContractSchemaRegistry port + InMemoryContractSchemaRegistry
// (ContractRef, ContractSchemaRegistry, ContractSchemaCodec,
// InMemoryContractSchemaRegistry, computeContractRefDigest).
export * from './contract-ref.js';
export * from './contract-schema-registry.js';

// W1-A2 — ProcessModuleManifest + ResourceIndex + validator
// (ProcessModuleManifest, ResourceIndexEntry, ResourceKind, HandlerRef,
// validateProcessModuleManifest; ValidationResult/ValidationError come from
// production-envelope.ts above to avoid re-export collisions).
export * from './resource-index.js';
export {
  type ProcessModuleManifest,
  type HandlerRef,
  validateProcessModuleManifest,
} from './module-manifest.js';

// W1-A3 — LifecycleScenarioManifest (the one genuinely new aggregate) + validator
// (LifecycleScenarioManifest, ScenarioStageBinding, ModuleSelector,
// ScenarioPolicies, TransitionBudgets, ReentryBudgets,
// validateLifecycleScenarioManifest, isSafeMappingPath).
export {
  type LifecycleScenarioManifest,
  type ScenarioStageBinding,
  type ModuleSelector,
  type ScenarioPolicies,
  type ScenarioPolicyDeclaration,
  type TransitionBudgets,
  type ReentryBudgets,
  validateLifecycleScenarioManifest,
  isSafeMappingPath,
} from './scenario-manifest.js';

// W1-A4 — NodeProtocolDefinition + ExecutionContextEnvelope + flow-condition ratchet
// (NodeProtocolDefinition, ProtocolStep, ProtocolStepTransition,
// EvidenceRequirement, RetrySemanticsKind, ExecutionContextEnvelope,
// PackageRef, NodeRef, isSupportedFlowCondition, validateNodeProtocolDefinition).
export {
  type RetrySemanticsKind,
  type EvidenceCategory,
  type EvidenceRequirement,
  type ProtocolStep,
  type ProtocolStepTransition,
  type NodeProtocolDefinition,
  validateNodeProtocolDefinition,
  isSupportedFlowCondition,
} from './node-protocol.js';
export * from './execution-envelope.js';

// W1-A6 — production envelope, completion, recovery/tool/assistance definitions,
// driver-neutral receipt.
// (ProductRef, LineageRef, NodeProductionEnvelope, ProcessModuleOutputEnvelope,
// ModuleCompletion, RecoveryAction, RecoveryPolicyBinding + re-exports
// RecoveryIssue/RecoveryFeedback/RecoveryFinding/RecoverySubjectRef,
// ModuleToolContribution, CapabilityRequirement, GuardBinding,
// AgentAssistanceDefinition, AssistanceEvent, AssistanceBlock, AssistanceBudgets,
// DriverNeutralExecutionReceipt, and their validators).
export * from './production-envelope.js';
export * from './module-completion.js';
export * from './recovery-definitions.js';
export * from './tool-contribution.js';
export * from './agent-assistance.js';
export * from './execution-receipt.js';

// W1-A7 — ProcessModuleDefinition → ProcessModuleManifest adapter.
// Pure adapter that wraps a definition into a manifest envelope. Used by
// describePackage, extensibility tests, and the SPI conformance suite.
export { adaptLegacyProcessModule, LEGACY_MANIFEST_FORMAT_VERSION } from './legacy-adapter.js';
