/**
 * workflow-kernel/domain/types.ts - the pure workflow-kernel domain types
 * (WP-05, plan phase EK-2).
 *
 * PURE: this module imports only from ./universe.js (pure data) and
 * ./universe.js only. No SQLite, no UI, no worker provider, no package name,
 * no workshop module name may appear here or anywhere under
 * src/workflow-kernel/domain/** (tests/workflow-kernel/model/purity.test.mjs
 * enforces this structurally).
 *
 * The typed vocabularies (command, event, obligation, wait, proof, evidence
 * kinds) come exclusively from the frozen EK-1 transition universe
 * (./universe.js). Adding a kind here without an approved complexity delta is
 * a universe widening and turns test:workflow-complexity red.
 */

import type {
  AggregateName,
  CommandDescriptor,
  CommandName,
  EvidenceKind,
  ObligationKind,
  ProofKind,
  WaitKind,
  WorkflowEventKind,
} from './universe.js';

/* ------------------------------------------------------------------ */
/* Identifiers, revisions, fences                                      */
/* ------------------------------------------------------------------ */

/** Opaque scoped instance id of one aggregate occurrence. */
export type InstanceId = string;

/** Exact idempotency key of one command application (durable). */
export type IdempotencyKey = string;

/** Exact reference to one immutable evidence fact. */
export type EvidenceRef = string;

/**
 * Aggregate revision, CAS-fenced: only the owning aggregate repository may
 * compare-and-set it (plan law "One authority"). Every mutating command
 * carries the expected revision; a mismatch is a typed refusal.
 */
export interface RevisionFence {
  readonly aggregate: AggregateName;
  readonly instanceId: InstanceId;
  readonly expectedRevision: number;
}

/* ------------------------------------------------------------------ */
/* Typed refusals (closed reason set)                                  */
/* ------------------------------------------------------------------ */

export type RefusalReason =
  | 'UNKNOWN_COMMAND'
  | 'COMMAND_NOT_OWNED_BY_AGGREGATE'
  | 'STALE_EXPECTED_REVISION'
  | 'ILLEGAL_TRANSITION'
  | 'DUPLICATE_IDEMPOTENCY_KEY'
  | 'MISSING_EVIDENCE'
  | 'FOREIGN_EVIDENCE_REF'
  | 'EMPTY_WORK_IS_NOT_A_PROOF'
  | 'WAIT_WITHOUT_WAKE_SOURCE'
  | 'ROLE_CONTRACT_DIGEST_MISMATCH'
  | 'ROLE_CONTRACT_REF_MISMATCH'
  | 'PROTOCOL_ROLE_UNIVERSE_VIOLATION'
  | 'ATTEMPT_RERESOLVED_MANIFEST'
  | 'DEAD_WAKE_SOURCE'
  | 'NONTERMINAL_DEAD_END'
  | 'UNIVERSE_VIOLATION';

/** A typed refusal with an exact reason (never a silent fallback). */
export interface TypedRefusal {
  readonly refused: true;
  readonly reason: RefusalReason;
  readonly detail: string;
}

/* ------------------------------------------------------------------ */
/* Canonical role contract (EK-1 frozen shape)                         */
/* ------------------------------------------------------------------ */

/** The only two Workplace protocol roles (plan "Canonical role contract"). */
export type ProtocolRole = 'author' | 'reviewer';

/**
 * Semantic profiles are NOT kernel roles: planner, implementer, reviewer and
 * certifier select a content-addressed contract slot, never a transition
 * owner (mutation k: a semantic profile treated as a kernel role).
 */
export type SemanticProfile = 'planner' | 'implementer' | 'reviewer' | 'certifier';

/**
 * The exact reference/digest pair WorkIntent and ActivityAttempt pin and
 * every consumer (dispatcher, runner, tracker) transports without
 * re-resolution. This is the pair WP-17 compiles INTO.
 */
export interface CanonicalRoleContractReference {
  /** Content address of the contract artifact ("sha256:" + 64 hex). */
  readonly roleContractRef: string;
  /** Slot fingerprint over the canonical JSON of the contract. */
  readonly roleContractDigest: string;
}

/**
 * The full CanonicalRoleContract value (the 16 plan-named fields, 22 physical
 * properties once the "+digest" companions are expanded). Field set is frozen
 * by docs/refactoring/event-kernel/specs/canonical-role-contract.schema.json;
 * adding a field reopens EK-1.
 */
export interface CanonicalRoleContract extends CanonicalRoleContractReference {
  readonly schemaVersion: 'ek.canonical-role-contract.ek1.v1';
  readonly protocolRole: ProtocolRole;
  readonly semanticProfileRef: string;
  readonly protocolSkillRef: string;
  readonly protocolSkillDigest: string;
  readonly semanticSkillRef: string;
  readonly semanticSkillDigest: string;
  readonly executorRoutePolicyRef: string;
  readonly executorRoutePolicyDigest: string;
  readonly allowedCapabilityRefs: readonly string[];
  readonly allowedToolRefs: readonly string[];
  readonly inputProductContracts: readonly string[];
  readonly outputProductContracts: readonly string[];
  readonly evidenceObligations: readonly ObligationKind[];
  readonly completionCommandSchemaRef: string;
  readonly completionCommandSchemaDigest: string;
  readonly trackerProjectionProfileRef: string;
  readonly trackerProjectionProfileDigest: string;
  readonly promptBudgetProfileRef: string;
  readonly promptBudgetProfileDigest: string;
  readonly contractDigest: string;
}

/** Immutable pinned binding value installed per launch kind. */
export type CanonicalRoleContractBinding = CanonicalRoleContractReference;

/**
 * Immutable launch intent: binds WorkItem, Workplace expected revision, input
 * evidence, completion command and the exact role-contract pin. The Workplace
 * reducer alone owns the author/reviewer transitions over these intents.
 */
export interface WorkIntent {
  readonly intentRef: EvidenceRef;
  readonly workItemRef: EvidenceRef;
  readonly workplaceInstanceId: InstanceId;
  readonly workplaceExpectedRevision: number;
  readonly completionCommand: CommandName;
  readonly protocolRole: ProtocolRole;
  readonly roleContract: CanonicalRoleContractReference;
  readonly inputEvidenceRefs: readonly EvidenceRef[];
}

/* ------------------------------------------------------------------ */
/* PromptAssemblyReceipt reference (the type WP-18 produces)           */
/* ------------------------------------------------------------------ */

/**
 * Immutable per-provider-request admission receipt reference. Records
 * `admitted` or `refused` - NEVER `sent` (send/outcome evidence is separate).
 * Receipts are evidence attached to ActivityAttempt; the counters are the
 * CAS-fenced attempt state, never derived from receipts.
 */
export interface PromptAssemblyReceiptReference {
  readonly receiptRef: string;
  readonly admission: 'admitted' | 'refused';
  readonly requestOrdinal: number;
  readonly expectedContextRevision: number;
  readonly digest: string;
}

/* ------------------------------------------------------------------ */
/* Workflow records (the relations the kernel owns)                    */
/* ------------------------------------------------------------------ */

/** Append-only immutable receipt emitted by the owning aggregate. */
export interface WorkflowEventRecord {
  readonly kind: WorkflowEventKind;
  readonly sourceOwner: AggregateName;
  readonly sourceInstanceId: InstanceId;
  /** Revision of the source aggregate at commit (post-increment). */
  readonly sourceRevision: number;
  readonly transition: CommandName;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sequence: number;
}

/**
 * Durable target command with expected revision, evidence and completion
 * state. Fan-out creates one explicit obligation per target-owner edge;
 * fan-in checks exact predecessor evidence (plan law "Durable handoff").
 */
export interface ObligationRecord {
  readonly kind: ObligationKind;
  readonly source: CommandName;
  readonly sourceInstanceId: InstanceId;
  readonly target: CommandName;
  readonly targetAggregate: AggregateName;
  /** null: completing the obligation instantiates a fresh target aggregate. */
  readonly targetInstanceId: InstanceId | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly state: 'open' | 'completed';
  readonly idempotencyKey: IdempotencyKey;
  readonly completionEvidenceRef?: EvidenceRef;
}

/**
 * Nonterminal wait reason plus its EXACT durable wake source(s). A wait
 * without any wake source is unconstructible (mutation d).
 */
export interface WaitRecord {
  readonly kind: WaitKind;
  readonly ownerAggregate: AggregateName;
  readonly ownerInstanceId: InstanceId;
  readonly wakeCommands: readonly CommandName[];
  readonly wakeObligationKinds: readonly ObligationKind[];
  readonly deadWakeConversion?: ObligationKind;
  readonly state: 'pending' | 'discharged' | 'converted';
  readonly dischargeEvidenceRef?: EvidenceRef;
}

/** Terminalization has an exact proof; an empty queue is never a proof. */
export interface ProofRecord {
  readonly id: ProofKind;
  readonly scope: string;
  readonly ownerAggregate: AggregateName;
  readonly ownerInstanceId: InstanceId;
  readonly evidenceClosure: readonly EvidenceRef[];
  /** D3: lifecycle/run cancellation and unreachable proofs name member dispositions. */
  readonly memberDispositions?: readonly MemberDisposition[];
}

/** One named member disposition inside a D3 cancellation/unreachable proof. */
export interface MemberDisposition {
  readonly memberRef: string;
  readonly disposition: 'cancelled' | 'unreachable';
}

/** Immutable evidence fact of one declared kind (ADR-053 chain included). */
export interface EvidenceFact {
  readonly kind: EvidenceKind;
  readonly ref: EvidenceRef;
  readonly producer: string;
  readonly payloadDigest?: string;
}

/* ------------------------------------------------------------------ */
/* Aggregate heads                                                     */
/* ------------------------------------------------------------------ */

/** Mutable head of one aggregate instance; CAS-fenced revision. */
export interface AggregateHead {
  readonly aggregate: AggregateName;
  readonly instanceId: InstanceId;
  readonly revision: number;
  readonly status: string;
  readonly terminal?: ProofKind;
}

/* ------------------------------------------------------------------ */
/* Command application                                                 */
/* ------------------------------------------------------------------ */

/** Gate verdict set of the frozen universe (R1: five verdicts). */
export type GateVerdict =
  | 'accepted'
  | 'repair'
  | 'upstream-repair'
  | 'human-wait'
  | 'terminal-reject';

/** Effect outcome set of the frozen universe (D2: seven outcomes). */
export type EffectOutcome =
  | 'success'
  | 'already-applied'
  | 'retryable'
  | 'unknown'
  | 'human-wait'
  | 'policy-terminal'
  | 'repair';

/** Terminal outcomes expressible as proofs. */
export type TerminalOutcome = 'success' | 'truthful-failure' | 'cancellation' | 'unreachable';

/** Lifecycle routing targets of lifecycleRun.routeOutcome. */
export type StageRoute =
  | 'initial-discovery'
  | 'solution-formalization'
  | 'solution-development'
  | 'delivery-release'
  | 'verify-terminal-claims';

/**
 * One command application. Closed typed fields only - there is no free-form
 * payload, metadata or extension bag (plan law "Canonical role contract";
 * the same no-arbitrary-metadata rule governs kernel commands).
 */
export interface CommandInput {
  readonly command: CommandName;
  readonly instanceId: InstanceId;
  readonly expectedRevision: number;
  readonly idempotencyKey: IdempotencyKey;
  /** Exact evidence references the command consumes. */
  readonly evidenceRefs?: readonly EvidenceRef[];
  /** Role-contract pin (workplace.admitWorkIntent and attempt creation only). */
  readonly rolePin?: CanonicalRoleContractReference;
  /** Protocol role for Workplace role transitions (author/reviewer only). */
  readonly protocolRole?: ProtocolRole;
  /** The exact WorkIntent an attempt is created from (never a manifest). */
  readonly workIntentRef?: EvidenceRef;
  readonly gateVerdict?: GateVerdict;
  readonly effectOutcome?: EffectOutcome;
  readonly terminalOutcome?: TerminalOutcome;
  readonly stageRoute?: StageRoute;
}

/**
 * Write-time progress witness: every nonterminal result commits at least one
 * runnable obligation, one typed wait with a live wake source, or the
 * committed transition itself moves a cursor with a legal successor edge.
 */
export type ProgressWitness =
  | { readonly kind: 'runnable-obligation'; readonly obligationKind: ObligationKind }
  | { readonly kind: 'typed-wait'; readonly waitKind: WaitKind }
  | { readonly kind: 'committed-transition'; readonly nextStatus: string };

/** Evidence the commit appends (facts, receipts, proofs' closures). */
export interface CommitPlan {
  readonly descriptor: CommandDescriptor;
  readonly nextStatus: string;
  readonly terminal: boolean;
  readonly issuedProofs: readonly {
    readonly id: ProofKind;
    readonly evidenceClosure: readonly EvidenceRef[];
    readonly memberDispositions?: readonly MemberDisposition[];
  }[];
  readonly recordedEvidence: readonly EvidenceFact[];
  readonly createdObligationTargets: readonly {
    readonly kind: ObligationKind;
    readonly target: CommandName;
    readonly evidenceRefs: readonly EvidenceRef[];
  }[];
  readonly createdWaitKinds: readonly WaitKind[];
  readonly progressWitness: ProgressWitness;
}

/** Idempotent replay of an already-committed key returns the recorded outcome. */
export interface IdempotentReplay {
  readonly replayed: true;
  readonly idempotencyKey: IdempotencyKey;
  readonly originalEventSequence: number;
}

export type CommandOutcome =
  | TypedRefusal
  | IdempotentReplay
  | {
      readonly committed: true;
      /** null for the eventless transport boundary command (universe-faithful). */
      readonly event: WorkflowEventRecord | null;
      readonly nextRevision: number;
      readonly plan: CommitPlan;
      readonly obligations: readonly ObligationRecord[];
      readonly waits: readonly WaitRecord[];
      readonly proofs: readonly ProofRecord[];
      readonly evidence: readonly EvidenceFact[];
    };

/* ------------------------------------------------------------------ */
/* Reducer shape                                                       */
/* ------------------------------------------------------------------ */

/** One legality edge: which statuses the command is legal from. */
export interface TransitionRule {
  readonly command: CommandName;
  /** Empty array = creation command (the instance must not exist yet). */
  readonly fromStatuses: readonly string[];
  /** Target status; the sentinel '*' preserves the current status (observation). */
  readonly toStatus: string;
  readonly terminal: boolean;
  /** Optional discriminator over the typed input fields (verdict/outcome/route). */
  readonly applies?: (input: CommandInput) => boolean;
  /**
   * Obligation kinds this edge creates (a subset of the command's declared
   * universe list; default: all declared kinds). Routing-style commands
   * create exactly the edge-matching obligation, never all branches at once.
   */
  readonly obligations?: readonly ObligationKind[];
}

/**
 * Read-only query context a guard may inspect: the immutable evidence facts,
 * the issued terminal proofs, the open obligations and the pending waits of
 * the world being reduced. Guards never mutate anything.
 */
export interface GuardContext {
  readonly evidence: ReadonlyMap<EvidenceRef, EvidenceFact>;
  readonly proofs: readonly ProofRecord[];
  readonly openObligations: readonly ObligationRecord[];
  readonly pendingWaits: readonly WaitRecord[];
  /** Admitted WorkIntents by reference (the attempt-creation pin source). */
  readonly workIntents: ReadonlyMap<EvidenceRef, WorkIntent>;
  /** All aggregate heads of the world being reduced (read-only). */
  readonly heads: readonly AggregateHead[];
}

/**
 * Evidence/role guard evaluated after the status edge match, before commit.
 * Returns a typed refusal or the exact evidence/proof kinds the command
 * requires to exist before the commit (same-transaction facts are appended
 * by the engine per the frozen proof closures).
 */
export type CommandGuard = (
  input: CommandInput,
  head: AggregateHead | undefined,
  ctx: GuardContext,
) => TypedRefusal | GuardResult;

/** What a passing guard declares for the commit. */
export interface GuardResult {
  readonly requiredEvidenceKinds: readonly (EvidenceKind | ProofKind)[];
  /** D3: dispositions the issued cancellation/unreachable proofs must name. */
  readonly memberDispositions?: readonly MemberDisposition[];
}

/**
 * One aggregate reducer: the sole owner of its commands' transition
 * legality. "Two owners for one fact" is structurally impossible - the
 * registry (./reducers/index.ts) refuses a command owned by two reducers.
 */
export interface AggregateReducer {
  readonly aggregate: AggregateName;
  readonly ownedCommands: readonly CommandName[];
  readonly initialStatus: string;
  readonly statuses: readonly string[];
  readonly terminalStatuses: readonly string[];
  readonly transitions: readonly TransitionRule[];
  readonly guards: Readonly<Partial<Record<CommandName, CommandGuard>>>;
  /**
   * True only for the stateless replaceable transport boundary: it owns no
   * mutable state, so its self-loop command is its own progress witness
   * (every provider send is an idempotent boundary transaction).
   */
  readonly statelessBoundary?: boolean;
}
