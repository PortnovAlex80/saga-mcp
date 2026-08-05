/**
 * Workplace domain barrel — target v4 Production Cell / OTK contracts.
 *
 * Pure domain only. Files under `domain/workplace/` import only from siblings
 * here and from `domain/spi/` (pure types). No imports from SQLite, MCP,
 * db.ts, application/behavioral, persistence, composition, modules, or
 * infrastructure — enforced by `tests/architecture/dependency-direction.test.mjs`
 * (Rule 5: domain never depends outward) and the new
 * `tests/architecture/workplace-domain-purity.test.mjs` ratchet added by this
 * step.
 *
 * Target contracts: Conveyor Mental Model v4 §«Four entities, one primary»,
 * §«Two-channel state», §«CandidateSet», §«The three layers of a universal
 * quality gate», §«The repair mechanic». Normative acceptance:
 * FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-04, REG-05, REG-09, REG-12, REG-14,
 * REG-15, REG-16, REG-17, REG-18, REG-19, REG-28.
 *
 * These are TARGET contracts. Step 1.1 defines them; later steps (2.x, 3.x)
 * build the coordinator, repositories and projection that consume them. The
 * legacy `domain/recovery.ts` RecoveryIssue stays in use until step 3.A.3
 * generalises the gate and reconciles the two.
 */

// REG-05 — Workplace identity.
export {
  DEFAULT_WORK_KEY,
  asWorkplaceRef,
  serializeWorkplaceRef,
  workplaceRefEquals,
} from './workplace-ref.js';
export type { WorkplaceRef } from './workplace-ref.js';

// REG-28 — Two-channel state (Kanban phase + machine loop + role + reason).
export {
  KANBAN_PHASES,
  LOOP_STATES,
  TERMINAL_REASONS,
  isAllowedPhaseLoopPair,
  assertAllowedPhaseLoopPair,
  isRoleCompatibleWithPhase,
  terminalReasonForPhase,
  phaseForTerminalReason,
  assertValidWorkplaceState,
  initialWorkplaceState,
} from './workplace-state.js';
export type {
  KanbanPhase,
  LoopState,
  NextRole,
  TerminalReason,
  WorkplaceState,
} from './workplace-state.js';

// REG-12 — CandidateSet (sealed handoff to OTK).
export {
  candidateSetSealKey,
  computeCandidateSetRef,
  assertValidCandidateSet,
} from './candidate-set.js';
export type {
  CandidateSet,
  CandidateMember,
  CandidateMemberOrigin,
  CandidateSetRole,
} from './candidate-set.js';

// REG-09 — ExecutionReservation (durable launch authority).
export {
  executionReservationRef,
  assertValidExecutionReservation,
} from './execution-reservation.js';
export type {
  ExecutionReservation,
  ExecutionReservationState,
} from './execution-reservation.js';

// REG-14/15/16/17/18 — Universal quality gate.
export {
  assertValidGateDecision,
} from './gate.js';
export type {
  CheckOutcome,
  CheckRef,
  CheckPlanEntry,
  CheckPlan,
  CheckProvider,
  CheckReceipt,
  GatePhase,
  GateRun,
  GateVerdict,
  RepairTargetRole,
  AcceptedOutputBinding,
  GateDecision,
} from './gate.js';

// REG-19 — Target RecoveryIssue (defect sheet with exact references).
export {
  assertValidTargetRecoveryIssue,
} from './recovery-issue-target.js';
export type {
  TargetRecoveryIssue,
  RecoveryFindingEntry,
} from './recovery-issue-target.js';

// REG-04 — ProductionCellDefinition (declarative Production Cell).
export {
  assertValidProductionCellDefinition,
} from './production-cell-definition.js';
export type {
  ProductionCellDefinition,
  ProductionCellMaterialization,
  ProductContract,
  CellRoleProfile,
  CellGate,
  CellReview,
  CellRecoveryPolicy,
} from './production-cell-definition.js';

// REG-04/05/13 — ProductionCellTransitionReducer (pure transition logic).
export { reduceWorkplaceEvent } from './production-cell-reducer.js';
export type { ProductionCellEvent } from './production-cell-reducer.js';
