/**
 * Public barrel for the lifecycle domain oracle.
 *
 * Pure TS only. Importing from SQLite, Node, tools, or tracker-view from this
 * module is a Slice 7 architecture-test violation. Slice 0 exposes only the
 * types and pure functions; Slice 1+ wires them to the command bus.
 *
 * Source: blueprint §6 (domain model), §7 (commands), §8 (events/effects),
 *         §9 (reducer contract), §11 (transition table).
 */

export type {
  Brand,
  CommandId,
  ExecutionId,
  IntegrationId,
  HumanRequestId,
} from './ids.js';

export {
  asCommandId,
  asExecutionId,
  asIntegrationId,
  asHumanRequestId,
} from './ids.js';

export type {
  WorkPhase,
  ManagedTaskState,
  InvariantCode,
  InvariantViolation,
  DecodedState,
} from './state.js';

export { assertNever } from './state.js';

export type {
  CommandActor,
  CommandEnvelope,
  LifecycleCommand,
  ResultFor,
  ReserveWorkItem,
  RegisterWorkerProcess,
  ReportImplementationCompleted,
  SubmitReviewVerdict,
  ParkForHuman,
  RecordHumanAnswer,
  RequestExecutionStop,
  ObserveProcessExited,
  ObserveProcessLost,
  ReserveIntegrationAttempt,
  ObserveIntegrationMerged,
  ObserveIntegrationConflict,
  ReconcileDependencies,
  AdminOverrideLifecycle,
} from './commands.js';

export type {
  DomainEvent,
  WorkItemCreated,
  WorkAttemptReserved,
  WorkAttemptStarted,
  WorkAttemptSucceeded,
  WorkAttemptLost,
  ExecutionReserved,
  ExecutionStarted,
  ImplementationCompleted,
  ReviewItemCreated,
  ReviewApproved,
  ReviewChangesRequested,
  ImplementationItemCreated,
  HumanInputRequested,
  HumanInputProvided,
  IntegrationRequested,
  IntegrationStarted,
  IntegrationObservedMerged,
  IntegrationObservedConflict,
  ExecutionStopRequested,
  ExecutionExited,
  ExecutionLost,
  TaskReleased,
  DependencyBlocked,
  DependencyUnblocked,
  AdminOverrideApplied,
} from './events.js';

export type { EffectIntent } from './effects.js';

export type {
  TaskRow,
  ExecutionRow,
  IntegrationRow,
  HumanRequestRow,
  TaskSnapshot,
} from './decode.js';

export { decodeManagedState } from './decode.js';

export type {
  Decision,
  DomainRejection,
  DomainRejectionCode,
  DecideResult,
  LifecycleFacts,
} from './evolve.js';

export { decide, evolve, PERMISSIVE_FACTS } from './evolve.js';

export type {
  InvariantOk,
  InvariantViolationReport,
  InvariantCheck,
} from './invariants.js';

export { compositeInvariants } from './invariants.js';
