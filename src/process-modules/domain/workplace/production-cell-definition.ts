/**
 * ProductionCellDefinition — the declarative shape of one Production Cell.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-04 (Производственная
 * ячейка — ProductionCellDefinition) + Conveyor Mental Model v4 §«Declarative
 * Production Cell definition».
 *
 * A normal cell is completely described by DATA (v4 §«Declarative Production
 * Cell definition»): input selectors, materialization, author profile,
 * product contracts, author/final gates, optional review, recovery policy,
 * transitions. The runtime materializes this declaration into a Workplace and
 * drives the same loop for every workshop. A standard new workshop supplies
 * only manifest + Flow/cell declarations + schemas + skills + capability
 * presets + CheckPlan/decision/recovery policies — NO SQL table, NO
 * product-specific submit/read tool, NO MCP handler, NO dispatcher, NO
 * status machine (REG-03-AC-04, E2E-13).
 *
 * # Fan-out
 *
 * A singleton cell uses `materialization.sourceBinding = undefined` (absent)
 * and the runtime uses `DEFAULT_WORK_KEY`. A fan-out cell references an
 * accepted upstream binding; the accepted source binding seals the instance
 * set, and each stable item produces one deterministic workKey/Workplace
 * (REG-04-AC-03). The Flow node completes only when its declared completion
 * policy is satisfied across those Workplaces (REG-04-AC-05).
 *
 * # Review
 *
 * Without a reviewer, the author gate is declared `gatePhase=final` (or
 * aliases the same final plan); the runtime never invents a second review
 * step (v4 §«Declarative Production Cell definition»).
 *
 * # Pure domain
 *
 * Imports only sibling pure types. No SQLite, MCP, db.ts, clock, or
 * application/behavioral code.
 */

import type {
  CheckPlan,
  GatePhase,
  RepairTargetRole,
} from './index.js';

/**
 * How fan-out instances of one cell definition are materialized.
 *
 * - `sourceBinding` absent → singleton (one Workplace with DEFAULT_WORK_KEY).
 * - `sourceBinding` present → fan-out: the runtime reads the accepted upstream
 *   binding and materializes one Workplace per stable item id.
 *
 * REG-04-AC-03: the workKey is derived from the accepted binding + stable item
 * id, NEVER from array index, worker or attempt identity.
 */
export interface ProductionCellMaterialization {
  /** Absent for singleton; a binding name for fan-out. */
  readonly sourceBinding?: string;
  /**
   * Optional selector for the workKey. When absent the runtime derives
   * `workKey` from the stable item id.
   */
  readonly workKeySelector?: string;
  /**
   * Optional item field containing stable ids of sibling workplaces that must
   * reach terminal/accepted before this workplace may be admitted. This is a
   * generic fan-out DAG mechanism; the runtime does not interpret product
   * semantics.
   */
  readonly dependencySelector?: string;
  /** Normally `all` — the Flow node completes when every instance is terminal. */
  readonly completionPolicy: 'all' | 'any' | 'quorum';
  /** Required when completionPolicy='quorum': minimum successful instances. */
  readonly quorum?: number;
  readonly taskProvenance?: {
    readonly sourceArtifactIdsSelector: string;
    readonly verificationTargetArtifactIdSelector?: string;
  };
}

/**
 * A product contract this cell's author/reviewer produces.
 *
 * `binding` is the named output slot downstream selectors read.
 * `schemaRef`/`mediaType`/`cardinality` declare the contract the gate
 * validates. REG-11: every product has a schema, durable reference and
 * content digest.
 */
export interface ProductContract {
  readonly binding: string;
  readonly schemaRef: string;
  readonly mediaType: string;
  /** '1' for exactly one, '0..1' optional, '1..n' many (cardinality string). */
  readonly cardinality: string;
  /** Fail closed when the worker did not publish an exact typed submission. */
  readonly productSource?: 'typed-submission' | 'managed-production';
}

/**
 * The author (or reviewer) execution profile reference.
 *
 * `skillRef` names the execution profile/skill resource (REG-25).
 * `capabilityPreset` names a CLOSED platform-owned capability preset (e.g.
 * `text-author`, `text-reviewer`, `sandbox-code-author`); modules select a
 * preset but cannot inject raw tool names or handlers (REG-03-AC-03,
 * REG-25-AC-02).
 */
export interface CellRoleProfile {
  readonly skillRef: string;
  readonly capabilityPreset: string;
}

/**
 * One quality gate of the cell. A cell has an author gate and (optionally) a
 * final gate; when no reviewer is declared, the author gate IS the final gate
 * (gatePhase=final).
 */
export interface CellGate {
  readonly gateId: string;
  readonly gatePhase: GatePhase;
  /** The CheckPlan this gate runs over the sealed CandidateSet. */
  readonly checkPlan: CheckPlan;
}

/**
 * Optional reviewer phase. When present, the author gate's `accepted` verdict
 * does NOT finish the cell — it pins the author CandidateSet for the reviewer,
 * and the final gate accepts only after the reviewer CandidateSet passes.
 */
export interface CellReview {
  readonly reviewer: CellRoleProfile;
  /** Schema of the reviewer's verdict product. */
  readonly verdictSchemaRef: string;
  /** The final gate that accepts the author set WITH reviewer evidence. */
  readonly finalGate: CellGate;
}

/**
 * Recovery policy for the cell.
 *
 * `maxAttempts` bounds the repair rounds per role. `onExhausted` declares the
 * terminal outcome when the budget is spent: `fail` (explicit terminal
 * failure) or `pause` (human_required, blocks the line).
 */
export interface CellRecoveryPolicy {
  readonly maxAttempts: number;
  readonly onExhausted: 'fail' | 'pause';
}

/**
 * The full declarative Production Cell.
 *
 * REG-04. One first-class FlowNode definition carries this. The runtime
 * materializes one (or many, for fan-out) Workplace from it and drives the
 * same loop for every workshop.
 */
export interface ProductionCellDefinition {
  readonly id: string;
  /** How the cell selects its exact input ProductRefs. */
  readonly inputSelectors: readonly string[];
  readonly materialization: ProductionCellMaterialization;
  /** The author execution profile + capability preset. */
  readonly author: CellRoleProfile;
  /** Product contracts the author produces. */
  readonly productContracts: readonly ProductContract[];
  /** The author gate (runs over the sealed author CandidateSet). */
  readonly authorGate: CellGate;
  /** Optional reviewer phase. Absent → author gate is final. */
  readonly review?: CellReview;
  /** Recovery policy (repair rounds budget). */
  readonly recovery: CellRecoveryPolicy;
  /** Optional runtime-owned effect after final acceptance and before completion. */
  readonly postAcceptanceEffect?: 'git-integration';
  /**
   * Typed Flow transitions emitted by the cell's final outcome. Keys are the
   * final GateDecision verdict; values are the Flow node id to transition to.
   */
  readonly transitions: {
    readonly accepted: string;
    readonly humanRequired: string;
    readonly failed: string;
  };
}

/**
 * Validate the cross-field rules of a ProductionCellDefinition (REG-04).
 *
 * Pure. Throws on any violation. Rules:
 *   - id is non-empty.
 *   - inputSelectors non-empty (a cell must read at least one input).
 *   - productContracts non-empty (a cell must produce at least one product).
 *   - authorGate.checkPlan is present.
 *   - when `review` is absent, authorGate.gatePhase MUST be 'final' (the
 *     runtime never invents a second review step — v4 §«Declarative Production
 *     Cell definition»).
 *   - when `review` is present, review.finalGate.gatePhase MUST be 'final'
 *     and authorGate.gatePhase MUST be 'author'.
 *   - recovery.maxAttempts >= 1.
 *   - transitions cover all three non-repair terminal outcomes.
 */
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
    // With review: author gate is 'author', review.finalGate is 'final'.
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
  } else {
    // Without review: author gate IS final.
    if (cell.authorGate.gatePhase !== 'final') {
      throw new Error(
        `ProductionCellDefinition '${cell.id}': authorGate.gatePhase must be 'final' when review is absent (the runtime never invents a review step)`,
      );
    }
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
  requireNonEmpty(cell.transitions.accepted, 'transitions.accepted');
  requireNonEmpty(cell.transitions.humanRequired, 'transitions.humanRequired');
  requireNonEmpty(cell.transitions.failed, 'transitions.failed');
  // Quorum requires a threshold.
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
    requireNonEmpty(cell.materialization.taskProvenance.sourceArtifactIdsSelector,
      'materialization.taskProvenance.sourceArtifactIdsSelector');
    if (cell.materialization.taskProvenance.verificationTargetArtifactIdSelector !== undefined) {
      requireNonEmpty(cell.materialization.taskProvenance.verificationTargetArtifactIdSelector,
        'materialization.taskProvenance.verificationTargetArtifactIdSelector');
    }
  }
}

// Re-export the role type so callers importing the cell definition also get
// the gate role type without a second hop.
export type { RepairTargetRole };

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ProductionCellDefinition.${label} must be a non-empty string`);
  }
}
