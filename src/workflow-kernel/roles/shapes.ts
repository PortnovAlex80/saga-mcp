/**
 * workflow-kernel/roles/shapes.ts - TypeScript mirrors of the frozen
 * canonical-role-contract.schema.json $defs (WP-17).
 *
 * The schema document itself is the single source of truth and is loaded at
 * runtime from docs/refactoring/event-kernel/specs/ (see ./frozen-docs.js);
 * these interfaces only give the compiler a typed view of the values it
 * validates. When a value deviates from the frozen shape the SCHEMA
 * validation rejects it - these types never widen the frozen law.
 *
 * Kernel-source discipline: no bare workshop-name literal, no role-binding
 * stem file name, and no legacy resolution vocabulary may appear here (the
 * EK-2 complexity checker and the WP-17 structural tests scan this tree).
 *
 * PURITY: type-only module (imports a domain type-only symbol); no runtime
 * imports at all.
 */

import type { ProtocolRole } from '../domain/types.js';

/* ------------------------------------------------------------------ */
/* Manifest rows ($defs/ContractSlot, ManifestBinding,                */
/* OperatorContractBinding, Manifest)                                  */
/* ------------------------------------------------------------------ */

/** $defs/ContractSlot: the content-addressed slot one manifest row binds. */
export interface ContractSlot {
  readonly roleContractRef: string;
  readonly contractDigest: string;
}

/**
 * $defs/ManifestBinding: one Workplace launch-kind row
 * (`<workshop>.<cellKind>.<protocolRole>`; the workshop enum is enforced by
 * the frozen schema, not repeated as kernel-source literals).
 */
export interface ManifestBindingRow {
  readonly launchKind: string;
  readonly bindingClass: 'workplace';
  readonly workshop: string;
  readonly cellKind: 'implementation' | 'planning';
  readonly protocolRole: ProtocolRole;
  readonly semanticProfile: 'planner' | 'implementer' | 'reviewer';
  readonly slot: ContractSlot;
}

/**
 * $defs/OperatorContractBinding: the single non-Workplace launch kind (the
 * D4 certifier binding). protocolRole is deliberately absent per D4.
 */
export interface OperatorContractBindingRow {
  readonly launchKind: 'lifecycle.certification.certifier';
  readonly bindingClass: 'lifecycleOperator';
  readonly ownerAggregate: 'LifecycleRun';
  readonly ownedCommand: 'lifecycleRun.verifyTerminalClaims';
  readonly semanticProfile: 'certifier';
  readonly protocolRoleExemption: 'D4: verifier is not an author/reviewer kernel role';
  readonly operatorContractShapeRef: '#/$defs/CertifierOperatorContract';
  readonly slot: ContractSlot;
}

/** The installed role-contract manifest document ($defs/Manifest). */
export interface RoleContractManifestDocument {
  readonly schemaVersion: 'ek.role-contract-manifest.ek1.v1';
  readonly bindings: readonly ManifestBindingRow[];
  readonly operatorContracts: readonly OperatorContractBindingRow[];
  readonly [keyword: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Referenced artifact shapes                                          */
/* ------------------------------------------------------------------ */

/** $defs/SemanticProfileArtifact: declares which frozen profile a contract instantiates. */
export interface SemanticProfileArtifact {
  readonly schemaVersion: 'ek.semantic-profile.ek1.v1';
  readonly profileId: 'planner' | 'implementer' | 'reviewer' | 'certifier';
  readonly definitionSummary: string;
}

/** $defs/SkillArtifact: cognition instructions only - never policy. */
export interface SkillArtifact {
  readonly schemaVersion: 'ek.skill-artifact.ek1.v1';
  readonly skillId: string;
  readonly instructions: string;
}

/** $defs/ExecutorRoutePolicyTable: one declarative eligibility rule. */
export interface ExecutorRoutePolicyRule {
  readonly when: {
    readonly launchKind?: string;
    readonly protocolRole?: ProtocolRole;
    readonly semanticProfile?: 'planner' | 'implementer' | 'reviewer' | 'certifier';
  };
  readonly route: {
    readonly transportKind: 'opencode';
    readonly provider: string;
    readonly model: string;
    readonly effort?: string | null;
  };
}

/** $defs/ExecutorRoutePolicyTable: the sole provider/model selection authority. */
export interface ExecutorRoutePolicyTable {
  readonly schemaVersion: 'ek.executor-route-policy.ek1.v1';
  readonly tableId: string;
  readonly rules: readonly ExecutorRoutePolicyRule[];
}

/** $defs/TrackerProjectionProfile: presentation rules only. */
export interface TrackerProjectionProfile {
  readonly schemaVersion: 'ek.tracker-projection-profile.ek1.v1';
  readonly profileId: string;
  readonly display: {
    readonly label: string;
    readonly boardColumn: 'todo' | 'in-progress' | 'review' | 'repair' | 'waiting' | 'terminal';
    readonly detailSections?: readonly string[];
  };
}

/**
 * $defs/CompletionCommandSchema: a draft 2020-12 JSON Schema for the
 * completion command payload (schema keywords beyond the two frozen ones
 * are the payload's business, so the index signature is open here - the
 * frozen $def deliberately allows them).
 */
export interface CompletionCommandSchemaArtifact {
  readonly $schema: 'https://json-schema.org/draft/2020-12/schema';
  readonly type: 'object';
  readonly [keyword: string]: unknown;
}

/**
 * $defs/CertifierOperatorContract: the pinned, content-addressed operator
 * contract of the certifier semantic profile (frozen protocol decision D4).
 * Resolved by its owning obligation, never through a Workplace protocol role.
 */
export interface CertifierOperatorContract {
  readonly schemaVersion: 'ek.certifier-operator-contract.ek1.v1';
  readonly operatorContractRef: string;
  readonly ownedCommand: 'lifecycleRun.verifyTerminalClaims';
  readonly ownerAggregate: 'LifecycleRun';
  readonly executableVerifierRefs: readonly string[];
  readonly inputProductContracts: readonly string[];
  readonly outputProductContracts: readonly string[];
  readonly evidenceObligations: readonly string[];
  readonly contractDigest: string;
}

/** The exact reference/digest pin of an operator contract (same discipline). */
export interface CertifierOperatorContractReference {
  readonly operatorContractRef: string;
  readonly operatorContractDigest: string;
}
