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
  /** Exact executable payload decoder frozen into each projected WorkIntent. */
  readonly payloadContract?: {
    readonly contractId: string;
    readonly version: string;
    readonly contractDigest: string;
  };
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
  /** Exact executable verdict decoder frozen into reviewer WorkIntents. */
  readonly payloadContract?: {
    readonly contractId: string;
    readonly version: string;
    readonly contractDigest: string;
  };
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
  for (const contract of cell.productContracts) {
    requireNonEmpty(contract.binding, 'productContracts.binding');
    requireNonEmpty(contract.schemaRef, 'productContracts.schemaRef');
    if (contract.payloadContract) {
      requireNonEmpty(
        contract.payloadContract.contractId,
        'productContracts.payloadContract.contractId',
      );
      requireNonEmpty(
        contract.payloadContract.version,
        'productContracts.payloadContract.version',
      );
      if (!/^[a-f0-9]{64}$/.test(contract.payloadContract.contractDigest)) {
        throw new Error(
          'ProductionCellDefinition.productContracts.payloadContract.contractDigest '
          + 'must be a lowercase SHA-256 digest',
        );
      }
    }
  }
  requireNonEmpty(cell.author.skillRef, 'author.skillRef');
  requireNonEmpty(cell.author.capabilityPreset, 'author.capabilityPreset');
  requireNonEmpty(cell.authorGate.gateId, 'authorGate.gateId');
  // Install-time conformance (the "desync firewall"): a check-plan entry that
  // declares a cell-product subject MUST target a schema this cell actually
  // produces (author gate: one of productContracts.schemaRef; final gate: the
  // review verdict schema). A mismatch means the entry format and the cell
  // product drifted — the exact bug class that rejected every managed
  // SourceChangeCandidate because an inherited gate still expected a
  // git-diff implementation result. Fail the module LOAD, not the conveyor.
  assertCheckPlanSubjectConformance(
    cell,
    'author-products',
    cell.authorGate.checkPlan,
    cell.productContracts.map(contract => contract.schemaRef),
  );
  if (cell.review) {
    assertCheckPlanSubjectConformance(
      cell,
      'review-verdict',
      cell.review.finalGate.checkPlan,
      [cell.review.verdictSchemaRef],
    );
  }
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
    if (cell.review.payloadContract) {
      requireNonEmpty(cell.review.payloadContract.contractId, 'review.payloadContract.contractId');
      requireNonEmpty(cell.review.payloadContract.version, 'review.payloadContract.version');
      if (!/^[a-f0-9]{64}$/.test(cell.review.payloadContract.contractDigest)) {
        throw new Error(
          'ProductionCellDefinition.review.payloadContract.contractDigest '
          + 'must be a lowercase SHA-256 digest',
        );
      }
    }
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

/**
 * Desync firewall — see assertValidProductionCellDefinition. Every check-plan
 * entry that declares `subjectScope:'cell-product'` must name a schema in
 * `allowed` (the cell's product schemas for the author gate, the review
 * verdict schema for the final gate). Entries declaring an `upstream` or no
 * subject scope are not locally cross-checkable and pass through.
 */
function assertCheckPlanSubjectConformance(
  cell: ProductionCellDefinition,
  gate: 'author-products' | 'review-verdict',
  checkPlan: CheckPlan,
  allowed: readonly string[],
): void {
  for (const entry of checkPlan.entries) {
    if (entry.subjectScope !== 'cell-product') continue;
    const expected = entry.expectedSubjectSchemaRef;
    if (typeof expected !== 'string' || expected === '') {
      throw new Error(
        `ProductionCellDefinition '${cell.id}' ${gate} gate: entry `
        + `'${entry.check.providerId}' declares subjectScope 'cell-product' `
        + `without expectedSubjectSchemaRef`,
      );
    }
    if (!allowed.includes(expected)) {
      throw new Error(
        `CELL_CHECK_PLAN_SUBJECT_MISMATCH: ProductionCellDefinition '${cell.id}' `
        + `${gate} gate entry '${entry.check.providerId}' expects subject `
        + `'${expected}', but the cell produces [${allowed.join(', ')}]. `
        + `The check plan and the cell product contract have drifted — `
        + `this module cannot be installed.`,
      );
    }
  }
}
