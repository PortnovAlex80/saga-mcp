import type { CreateWorkIntent, WorkIntent, WorkIntentStatus } from '../domain/work-intent.js';
import type { ProposalRecord } from '../domain/proposal.js';
import type { ControlIntentStatus, RawDiscoverySubmissionRecord } from '../domain/discovery-normalization-records.js';
import type {
  ReadinessAssessmentRecord,
  ReadinessControlExecution,
  ReadinessControlStatus,
} from '../domain/discovery-readiness-records.js';
import type {
  OutcomeCertificateRecord,
  SettlementRecord,
} from '../domain/discovery-settlement-records.js';

/**
 * Runtime-persistence boundary for the Saga 3 Discovery Edition engine.
 *
 * The engine must NOT call `getDb()` or `.prepare(...)` directly — Phase B
 * isolated Saga 2's pump the same way, and the D1 correction restores that
 * boundary for Saga 3. Every read/write the engine needs (epic objective,
 * WorkIntent lifecycle, projected board task, task status, latest proposal)
 * is expressed here as a narrow method. The SQLite adapter
 * (sqlite-saga3-discovery-runtime.ts) is the only implementation; the engine
 * depends on this interface so it stays pure orchestration logic and is
 * replaceable / testable with a fake.
 *
 * CAS semantics: setIntentStatus(expected, next) performs
 * `UPDATE ... WHERE status=expected` and returns whether it applied. This
 * makes the open → executing → concluded transition race-free across engine
 * restarts.
 */
export type PrepareIntentForExecutionResult =
  | { state: 'ready'; intentStatus: 'open' | 'paused'; taskStatus: string }
  | { state: 'active'; intentStatus: 'executing'; taskStatus: string; detail: string }
  | { state: 'blocked'; intentStatus: 'paused'; taskStatus: 'blocked'; detail: string }
  | { state: 'done'; intentStatus: WorkIntentStatus; taskStatus: 'done' };

export interface Saga3DiscoveryRuntimePersistence {
  /** Read the epic's name + description (the discovery objective source). */
  readEpicObjective(epicId: number): { name: string; description: string | null } | null;

  /** Open WorkIntent of the given kind for the episode, if any. */
  readOpenIntent(epicId: number, kind: string): WorkIntent | null;

  /** Create a new WorkIntent (status starts 'open'). */
  createIntent(command: CreateWorkIntent): WorkIntent;

  /** Link the projected board task id onto the intent (idempotent). */
  setProjectedTask(intentId: number, taskId: number): void;

  /**
   * Compare-and-set intent status. Returns true iff a row was updated
   * (i.e. the prior status matched `expected`). Use this for the
   * open → executing → concluded transitions so a stale/restarted engine
   * cannot overwrite a concurrent transition.
   */
  setIntentStatus(intentId: number, expected: WorkIntentStatus, next: WorkIntentStatus): boolean;

  /**
   * Idempotently ensure the projected discovery board task exists and return
   * its id. If a task with the generation_key already exists, return that id
   * without re-inserting. Otherwise create it (todo, discovery.work,
   * saga-discovery-worker, tracker_only) and return the new id.
   */
  ensureProjectedTask(input: EnsureProjectedTask): number;

  /** Current task status ('todo' | 'in_progress' | 'done' | ...), or null if gone. */
  readTaskState(taskId: number): string | null;

  /** Recover stale assignment/fence and prepare an existing intent/task for restart. */
  prepareIntentForExecution(intentId: number, taskId: number): PrepareIntentForExecutionResult;

  /**
   * Read the WorkIntent bound to a board task via `tasks.metadata.work_intent_id`,
   * or null if the task has no work_intent_id (legacy Saga 2 task) or the
   * referenced intent no longer exists. Used at claim time to freeze the
   * immutable execution authority snapshot (D1.1).
   */
  readWorkIntentForTask(taskId: number): WorkIntent | null;

  /** Latest submitted canonical proposal answering the intent, or null if none. */
  readLatestProposal(intentId: number): ProposalRecord | null;
  /** Latest immutable raw response for the product WorkIntent. */
  readLatestRawSubmission(intentId: number): RawDiscoverySubmissionRecord | null;
  /** Idempotently create/reuse the D2 ControlIntent, authority WorkIntent and task. */
  ensureNormalizationControl(input: EnsureNormalizationControl): NormalizationControlExecution;
  /** Compare-and-set ControlIntent lifecycle. */
  setControlIntentStatus(controlIntentId: number, expected: ControlIntentStatus, next: ControlIntentStatus): boolean;

  /**
   * D3: Idempotently create/reuse the AssessDiscoveryReadiness ControlIntent,
   * its bounded authority WorkIntent, and the projected advisor task for one
   * immutable Proposal version. A changed content hash is a new target.
   */
  ensureReadinessControl(input: EnsureReadinessControl): ReadinessControlExecution;
  /** D3: Compare-and-set readiness ControlIntent lifecycle. */
  setReadinessControlStatus(controlIntentId: number, expected: ReadinessControlStatus, next: ReadinessControlStatus): boolean;
  /** D3: Latest assessment (any status) for one readiness ControlIntent. */
  readLatestReadinessAssessment(controlIntentId: number): ReadinessAssessmentRecord | null;

  /**
   * D4: Read the canonical Proposal by id with the full lineage columns the
   * settlement input snapshot needs (source_submission_id,
   * normalization_proposal_id) and the epic_id (joined via the WorkIntent).
   * Returns null if the proposal does not exist. The settlement service
   * re-validates the payload and recomputes the content hash itself.
   */
  readProposalForSettlement(proposalId: number): SettlementProposalRecord | null;

  /**
   * D4: Latest ACCEPTED readiness assessment for one Proposal, or null if none.
   * The settlement snapshot only ever consumes an accepted_by_kernel assessment;
   * a missing/failed readiness state is represented by a 'missing'/'failed'
   * snapshot readiness status, not by reading a non-accepted row.
   */
  readAcceptedReadinessAssessmentForProposal(proposalId: number): ReadinessAssessmentRecord | null;

  /** D4: Find an existing settlement by its immutable input key (any status). */
  findSettlementByInputKey(key: SettlementInputKey): SettlementRecord | null;

  /** D4: Idempotent insert of a settlement row (status 'computed'). */
  insertSettlement(input: InsertSettlementPort): { record: SettlementRecord; replayed: boolean };

  /** D4: Mark a settlement as having an issued certificate (CAS). */
  markSettlementCertificateIssued(settlementId: number): boolean;

  /** D4: Mark a settlement failed (no certificate could be issued). */
  markSettlementFailed(settlementId: number): void;

  /** D4: Insert the immutable outcome certificate (write-once). */
  insertCertificate(input: InsertCertificatePort): { record: OutcomeCertificateRecord; replayed: boolean };

  /** D4: Read the certificate for a settlement, if any. */
  readCertificateForSettlement(settlementId: number): OutcomeCertificateRecord | null;
}

/**
 * D4: the proposal slice the settlement snapshot captures. The full typed
 * payload is parsed/validated by the settlement service; this is the durable
 * read result. Named ...Record to avoid clashing with the domain snapshot's
 * SettlementProposalInput (different shape: this carries intent_id, the
 * snapshot carries source_intent_id).
 */
export interface SettlementProposalRecord {
  id: number;
  epic_id: number;
  intent_id: number;
  content_hash: string;
  payload: unknown;
  source_submission_id: number | null;
  normalization_proposal_id: number | null;
}

/** D4: the immutable input key for a settlement. */
export interface SettlementInputKey {
  proposalId: number;
  proposalContentHash: string;
  readinessAssessmentHash: string;
  policyVersion: string;
  policyHash: string;
}

/** D4: port-level insert input for a settlement row. */
export interface InsertSettlementPort {
  epicId: number;
  key: SettlementInputKey;
  readinessAssessmentId: number | null;
  inputSnapshot: unknown;
  decision: 'go' | 'clarify' | 'reject';
  reasonCodes: string[];
  rationale: string;
}

/** D4: port-level insert input for a certificate row. */
export interface InsertCertificatePort {
  settlementId: number;
  epicId: number;
  proposalId: number;
  proposalContentHash: string;
  readinessAssessmentId: number | null;
  readinessAssessmentHash: string;
  policyVersion: string;
  policyHash: string;
  decision: 'go' | 'clarify' | 'reject';
  reasonCodes: string[];
  inputHash: string;
  certificatePayload: unknown;
}

export interface EnsureProjectedTask {
  epicId: number;
  projectId: number;
  intentId: number;
  objective: string;
  taskKind: string;
  executionSkill: string;
  /** generation_key (UNIQUE per epic) for idempotency. */
  generationKey: string;
  metadata?: Record<string, unknown>;
}


export interface EnsureNormalizationControl {
  epicId: number;
  projectId: number;
  sourceSubmissionId: number;
  objective: string;
}

export interface NormalizationControlExecution {
  controlIntentId: number;
  sourceSubmissionId: number;
  controlStatus: ControlIntentStatus;
  authorityIntentId: number;
  authorityIntentStatus: WorkIntentStatus;
  taskId: number;
}

export interface EnsureReadinessControl {
  epicId: number;
  projectId: number;
  proposalId: number;
  proposalContentHash: string;
  sourceIntentId: number;
  objective: string;
}
