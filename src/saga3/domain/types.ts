/**
 * Saga 3 — Domain types.
 *
 * The authoritative vocabulary for the entire system. Every module imports
 * from here. Nothing in domain/ imports from outside saga3/.
 *
 * Three levels (plan §2):
 *   Level 1: Normative intent (what must be true)
 *   Level 2: Deterministic control (what is admissible)
 *   Level 3: Productive execution (what workers produce)
 */

// ---------------------------------------------------------------------------
// Condition status — the only three values a condition can hold
// ---------------------------------------------------------------------------

export const CONDITION_STATUS = ['True', 'False', 'Unknown'] as const;
export type ConditionStatus = (typeof CONDITION_STATUS)[number];

// ---------------------------------------------------------------------------
// Terminal outcomes — cause-based, mutually exclusive
// ---------------------------------------------------------------------------

export const TERMINAL_OUTCOMES = [
  'SUCCEEDED',
  'SUCCEEDED_DEGRADED',
  'INFEASIBLE',
  'UNDERSPECIFIED_CONSTITUTION',
  'POLICY_CONFLICT',
  'VERIFICATION_IMPOSSIBLE',
  'EXTERNAL_STATE_UNKNOWN',
  'RESOURCE_EXHAUSTED',
  'FAILED_UNRECOVERABLE',
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * Frozen precedence (plan §2). Highest first.
 * Success is evaluated only when no negative predicate is active.
 */
export const TERMINAL_PRECEDENCE: readonly TerminalOutcome[] = [
  'EXTERNAL_STATE_UNKNOWN',
  'POLICY_CONFLICT',
  'INFEASIBLE',
  'UNDERSPECIFIED_CONSTITUTION',
  'VERIFICATION_IMPOSSIBLE',
  'RESOURCE_EXHAUSTED',
  'FAILED_UNRECOVERABLE',
];

export const SUCCESS_OUTCOMES: readonly TerminalOutcome[] = [
  'SUCCEEDED',
  'SUCCEEDED_DEGRADED',
];

// ---------------------------------------------------------------------------
// Level 1: Normative intent
// ---------------------------------------------------------------------------

/** Immutable root of authority. */
export interface PlatformPolicy {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly permittedDefaults: Readonly<Record<string, unknown>>;
  readonly budgetCeilings: Readonly<Record<string, number>>;
  readonly prohibitedActions: readonly string[];
}

/** Versioned product mission + obligations. */
export interface ProductConstitution {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly mission: string;
  readonly targetUsers: readonly string[];
  readonly obligations: readonly Obligation[];
}

/** A stable obligation with a criticality and an oracle requirement. */
export interface Obligation {
  readonly id: string;           // stable, never reused after freeze
  readonly description: string;
  readonly criticality: 'blocker' | 'important' | 'optional';
  readonly oracleRequirement: string;
  readonly degradationProfiles: readonly string[];
}

/** Versioned delivery authority. */
export interface GovernancePolicy {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  readonly conditionContracts: readonly ConditionContract[];
  readonly actionContracts: readonly ActionContract[];
  readonly degradationProfiles: readonly DegradationProfile[];
  readonly terminalPredicates: readonly TerminalPredicate[];
}

/**
 * A scoped condition: "this obligation at this scope must be True".
 * The controller materializes ConditionInstance rows from these contracts.
 */
export interface ConditionContract {
  readonly conditionType: string;      // e.g. ImplementationComplete, VerificationCurrent
  readonly obligationId: string;
  readonly scopeType: string;          // episode | component | obligation
  readonly scopeId: string;
  readonly oracleRequired: string;
  readonly dependsOn: readonly string[];  // other conditionType ids
  readonly aggregation?: 'all_true' | 'any_true';
}

/** An action that addresses a condition deficit. */
export interface ActionContract {
  readonly actionKind: string;
  readonly targetCondition: string;
  readonly skillId: string;            // which Skill can do this
  readonly prerequisites: readonly string[];  // conditionType ids that must be True
}

/** A frozen degradation profile. */
export interface DegradationProfile {
  readonly profileId: string;
  readonly activationPredicate: string;
  readonly alternateMandatoryConditions: readonly string[];
  readonly lostObligations: readonly string[];
}

/** A terminal predicate with its cause expression. */
export interface TerminalPredicate {
  readonly outcome: TerminalOutcome;
  readonly causeExpression: string;
}

/** Immutable binding of a frozen episode. */
export interface EpisodeSpec {
  readonly id: string;
  readonly generation: number;
  readonly platformPolicyHash: string;
  readonly constitutionHash: string;
  readonly governanceHash: string;
  readonly sourceBaseline: string | null;
  readonly environmentBaseline: string | null;
  readonly sealed: boolean;
}

// ---------------------------------------------------------------------------
// Level 2: Deterministic control
// ---------------------------------------------------------------------------

/** A live scoped condition instance. */
export interface ConditionInstance {
  readonly episodeSpecId: string;
  readonly conditionType: string;
  readonly obligationId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  status: ConditionStatus;
  readonly projectionVersion: number;  // CAS optimistic concurrency
  observedGeneration: number | null;
  sourceFingerprint: string | null;
  invalidationReason: string | null;
}

/**
 * A controller intent to address one condition deficit.
 * Deterministic uniqueness key prevents duplication.
 */
export interface WorkIntent {
  readonly id: string;
  readonly episodeSpecId: string;
  readonly generation: number;
  readonly targetCondition: string;
  readonly targetObligation: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly strategyId: string;
  readonly origin: 'normal' | 'recovery';
  readonly parentIncidentId: string | null;
  readonly skillId: string;
  readonly prerequisites: readonly string[];
  readonly readScopes: readonly string[];
  readonly writeScopes: readonly string[];
  readonly conflictKeys: readonly string[];
  readonly budgetReservation: number | null;
  readonly status: WorkIntentStatus;
}

export type WorkIntentStatus =
  | 'materialized'
  | 'admitted'
  | 'assigned'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** A worker assignment derived from an admitted WorkIntent. */
export interface WorkerAssignment {
  readonly id: string;
  readonly workIntentId: string;
  readonly skillId: string;
  readonly workerId: string | null;
  readonly executionId: string | null;
  readonly leaseEpoch: number;
  readonly state: AssignmentState;
}

export type AssignmentState =
  | 'pending'
  | 'running'
  | 'submitted'
  | 'verified'
  | 'failed'
  | 'lost';

/** Evidence with controller-attached provenance. */
export interface EvidenceRecord {
  readonly id: string;
  readonly episodeSpecId: string;
  readonly conditionType: string;
  readonly obligationId: string;
  readonly generation: number;
  readonly sourceFingerprint: string;
  readonly environmentFingerprint: string;
  readonly oracleId: string;
  readonly oracleVersion: string;
  readonly trustClass: TrustClass;
  readonly verdict: EvidenceVerdict;
  readonly rawDigest: string;
  readonly observedAt: number;
  readonly freshnessMaxAgeMs: number;
}

export type TrustClass = 'deterministic' | 'authoritative' | 'advisory';
export type EvidenceVerdict = 'passed' | 'failed' | 'unknown' | 'error';

/** A typed incident with a stable fingerprint. */
export interface ControlIncident {
  readonly id: string;
  readonly episodeSpecId: string;
  readonly failureClass: string;
  readonly fingerprint: string;
  readonly occurrence: number;
  state: 'open' | 'recovering' | 'resolved' | 'terminal';
  readonly currentRung: string | null;
  readonly terminalOutcome: TerminalOutcome | null;
}

/** An immutable outcome certificate. */
export interface OutcomeCertificate {
  readonly episodeSpecId: string;
  readonly outcome: TerminalOutcome;
  readonly causalReason: string;
  readonly generation: number;
  readonly sourceFingerprint: string | null;
  readonly satisfiedConditions: readonly string[];
  readonly unresolvedConditions: readonly string[];
  readonly certifiedAt: number;
}

// ---------------------------------------------------------------------------
// Level 3: Productive execution
// ---------------------------------------------------------------------------

/** Skill capability — what a worker role can do. */
export interface SkillCapability {
  readonly skillId: string;
  readonly role: string;
  readonly actionKinds: readonly string[];
  readonly producesArtifacts: readonly string[];
  readonly executionMode: 'git_change' | 'tracker_only' | 'read_only_evidence';
}

/** A worker output — what the worker returns after doing the work. */
export interface WorkerOutput {
  readonly assignmentId: string;
  readonly workIntentId: string;
  readonly result: 'completed' | 'failed' | 'ambiguous';
  readonly artifacts: readonly ArtifactOutput[];
  readonly observations: readonly ObservationOutput[];
  readonly summary: string;
}

/** An artifact produced by a worker. */
export interface ArtifactOutput {
  readonly kind: string;       // e.g. 'prd', 'uc', 'code', 'test'
  readonly path: string;       // relative to repository root
  readonly content: string;    // the actual content
  readonly digest: string;     // sha256 of content
}

/** An observation produced by a worker or oracle. */
export interface ObservationOutput {
  readonly oracleId: string;
  readonly oracleVersion: string;
  readonly command: string;
  readonly verdict: EvidenceVerdict;
  readonly rawDigest: string;
  readonly stdout: string;
  readonly exitCode: number;
}

// ---------------------------------------------------------------------------
// Reconcile step result — the one-step controller API
// ---------------------------------------------------------------------------

export type StepResult =
  | { readonly kind: 'did_work'; readonly decisionId: string }
  | { readonly kind: 'waiting_until'; readonly at: number }
  | { readonly kind: 'quiescent' }
  | { readonly kind: 'terminal'; readonly outcome: TerminalOutcome; readonly certificate?: OutcomeCertificate };

// ---------------------------------------------------------------------------
// Failure taxonomy + recovery rungs
// ---------------------------------------------------------------------------

export const FAILURE_CLASSES = [
  'transient_provider',
  'lost_worker',
  'ambiguous_effect',
  'environment',
  'deterministic_product',
  'oracle_defect',
  'specification_conflict',
  'unobservable_mandatory',
  'merge_coordination',
  'state_corruption',
  'budget_exhaustion',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const RECOVERY_RUNGS = [
  'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9',
] as const;
export type RecoveryRung = (typeof RECOVERY_RUNGS)[number];
