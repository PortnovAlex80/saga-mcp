/**
 * ProductionCellDefinition — declarative definition of one universal factory
 * cell. Product meaning lives in packages; worker/gate/recovery mechanics live
 * in the runtime.
 */

import type {
  CheckPlan,
  GatePhase,
  RepairTargetRole,
} from './index.js';

export interface ProductionCellMaterialization {
  readonly sourceBinding?: string;
  readonly workKeySelector?: string;
  readonly dependencySelector?: string;
  readonly completionPolicy: 'all' | 'any' | 'quorum';
  readonly quorum?: number;
  readonly taskProvenance?: {
    readonly sourceArtifactIdsSelector: string;
    readonly verificationTargetArtifactIdSelector?: string;
  };
}

export interface ProductContract {
  readonly binding: string;
  readonly schemaRef: string;
  readonly mediaType: string;
  readonly cardinality: string;
  readonly productSource?: 'typed-submission' | 'managed-production';
}

export interface CellRoleProfile {
  readonly skillRef: string;
  readonly capabilityPreset: string;
}

export interface CellGate {
  readonly gateId: string;
  readonly gatePhase: GatePhase;
  readonly checkPlan: CheckPlan;
}

export interface CellReview {
  readonly reviewer: CellRoleProfile;
  readonly verdictSchemaRef: string;
  readonly finalGate: CellGate;
}

export interface CellRecoveryPolicy {
  readonly maxAttempts: number;
  readonly onExhausted: 'fail' | 'pause';
}

export interface ProductionCellDefinition {
  readonly id: string;
  readonly inputSelectors: readonly string[];
  readonly materialization: ProductionCellMaterialization;
  readonly author: CellRoleProfile;
  readonly productContracts: readonly ProductContract[];
  readonly authorGate: CellGate;
  readonly review?: CellReview;
  readonly recovery: CellRecoveryPolicy;
  /**
   * Opaque package-registered capability invoked only after final acceptance.
   * The runtime never switches on concrete effect names such as Git or SRS.
   */
  readonly postAcceptanceEffect?: string;
  readonly transitions: {
    readonly accepted: string;
    readonly humanRequired: string;
    readonly failed: string;
  };
}

export function assertValidProductionCellDefinition(
  cell: ProductionCellDefinition,
): void {
  requireNonEmpty(cell.id, 'id');
  if (cell.inputSelectors.length === 0) {
    throw new Error('ProductionCellDefinition.inputSelectors must be non-empty');
  }
  if (cell.productContracts.length === 0) {
    throw new Error('ProductionCellDefinition.productContracts must be non-empty');
  }
  requireNonEmpty(cell.author.skillRef, 'author.skillRef');
  requireNonEmpty(cell.author.capabilityPreset, 'author.capabilityPreset');
  requireNonEmpty(cell.authorGate.gateId, 'authorGate.gateId');
  if (cell.review) {
    if (cell.authorGate.gatePhase !== 'author') {
      throw new Error(
        `ProductionCellDefinition '${cell.id}': authorGate.gatePhase must be 'author' when review is declared`,
      );
    }
    if (cell.review.finalGate.gatePhase !== 'final') {
      throw new Error(
        `ProductionCellDefinition '${cell.id}': review.finalGate.gatePhase must be 'final'`,
      );
    }
    requireNonEmpty(cell.review.reviewer.skillRef, 'review.reviewer.skillRef');
    requireNonEmpty(
      cell.review.reviewer.capabilityPreset,
      'review.reviewer.capabilityPreset',
    );
    requireNonEmpty(cell.review.verdictSchemaRef, 'review.verdictSchemaRef');
  } else if (cell.authorGate.gatePhase !== 'final') {
    throw new Error(
      `ProductionCellDefinition '${cell.id}': authorGate.gatePhase must be 'final' when review is absent`,
    );
  }
  if (!Number.isInteger(cell.recovery.maxAttempts) || cell.recovery.maxAttempts < 1) {
    throw new Error(
      `ProductionCellDefinition '${cell.id}': recovery.maxAttempts must be a positive integer`,
    );
  }
  if (cell.recovery.onExhausted !== 'fail' && cell.recovery.onExhausted !== 'pause') {
    throw new Error(
      `ProductionCellDefinition '${cell.id}': recovery.onExhausted must be 'fail' or 'pause'`,
    );
  }
  if (cell.postAcceptanceEffect !== undefined) {
    requireNonEmpty(cell.postAcceptanceEffect, 'postAcceptanceEffect');
  }
  requireNonEmpty(cell.transitions.accepted, 'transitions.accepted');
  requireNonEmpty(cell.transitions.humanRequired, 'transitions.humanRequired');
  requireNonEmpty(cell.transitions.failed, 'transitions.failed');
  if (
    cell.materialization.completionPolicy === 'quorum'
    && (!Number.isInteger(cell.materialization.quorum)
      || (cell.materialization.quorum ?? 0) < 1)
  ) {
    throw new Error(
      `ProductionCellDefinition '${cell.id}': completionPolicy='quorum' requires a positive integer quorum`,
    );
  }
  if (cell.materialization.taskProvenance) {
    requireNonEmpty(
      cell.materialization.taskProvenance.sourceArtifactIdsSelector,
      'materialization.taskProvenance.sourceArtifactIdsSelector',
    );
    if (cell.materialization.taskProvenance.verificationTargetArtifactIdSelector !== undefined) {
      requireNonEmpty(
        cell.materialization.taskProvenance.verificationTargetArtifactIdSelector,
        'materialization.taskProvenance.verificationTargetArtifactIdSelector',
      );
    }
  }
}

export type { RepairTargetRole };

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ProductionCellDefinition.${label} must be a non-empty string`);
  }
}
