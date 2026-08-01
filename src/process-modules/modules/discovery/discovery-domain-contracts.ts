/**
 * Discovery domain contracts — the schema-id constants, intent-kind constants,
 * and durable record/type interfaces the Discovery Process Module consumes.
 *
 * CONVEYOR Wave 7 (saga3 cross-tree leak elimination). Previously the discovery
 * module imported these definitions from `src/saga3/domain/**` and
 * `src/saga3/persistence/saga3-discovery-runtime-port.ts`. That crossed the
 * Pack/Core boundary the wrong way: `src/saga3/**` is the LEGACY inbound adapter
 * layer, and a Process Module package must not reach outside
 * `src/process-modules/`. The definitions are mirrored here BYTE-IDENTICAL
 * (same schema-id string values, same field shapes) so discovery certificates,
 * settlement hashes, and content hashes stay stable. The saga3 layer keeps its
 * own copies and may re-import from here (saga3 is allowed to depend inward).
 *
 * INVARIANT: the schema-id string constants (e.g.
 * `'saga3.discovery-proposal.v1'`) MUST stay byte-identical — discovery
 * certificates and hashes depend on them. Do NOT rename the schema strings.
 */

// ---------------------------------------------------------------------------
// Schema-id constants (byte-identical to the saga3 originals).
// ---------------------------------------------------------------------------

/** Schema version for the discovery proposal payload. */
export const DISCOVERY_PROPOSAL_SCHEMA = 'saga3.discovery-proposal.v1';

/** Schema version for the readiness assessment payload. */
export const DISCOVERY_READINESS_ASSESSMENT_SCHEMA =
  'saga3.discovery-readiness-assessment.v1';

/** Schema version for the diagnosis report payload (D5). */
export const DISCOVERY_DIAGNOSIS_REPORT_SCHEMA = 'saga3.discovery-diagnosis.v1';

/** Schema version for the normalization proposal payload (D2). */
export const DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA =
  'saga3.discovery-normalization-proposal.v1';

/** Schema version for the outcome certificate payload (D4). */
export const DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA =
  'saga3.discovery-outcome-certificate.v1';

/** Schema version for the settlement input snapshot (D4). */
export const DISCOVERY_SETTLEMENT_INPUT_SCHEMA =
  'saga3.discovery-settlement-input.v1';

/**
 * Sentinel hash for the readiness slice when no assessment is present. Stored
 * in the idempotency key (and the settlement row) so that a proposal settled
 * with NO assessment is a distinct idempotency target from one settled WITH an
 * assessment — but two "no assessment" settlements for the same proposal +
 * policy collapse to the same row.
 */
export const NO_READINESS_HASH = 'none';

// ---------------------------------------------------------------------------
// WorkIntent kinds + schema (byte-identical to saga3/domain/work-intent.ts).
// ---------------------------------------------------------------------------

/** Schema version for the discovery WorkIntent envelope. */
export const DISCOVERY_WORK_INTENT_SCHEMA = 'saga3.work-intent.discovery.v1';

/** Kind value for discovery product work. */
export const DISCOVERY_INTENT_KIND = 'discovery';

/** Kind used by the bounded D2 cognitive normalization worker. */
export const DISCOVERY_NORMALIZATION_INTENT_KIND = 'discovery.normalize';

/** Kind used by the bounded D3 shadow readiness-advisor worker. */
export const DISCOVERY_READINESS_INTENT_KIND = 'discovery.assess';

/** Kind used by the bounded D5 advisory diagnosis worker. */
export const DISCOVERY_DIAGNOSIS_INTENT_KIND = 'discovery.diagnose';

/** Lifecycle of a WorkIntent. */
export type WorkIntentStatus =
  | 'open'
  | 'executing'
  | 'paused'
  | 'concluded'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Discovery proposal payload (mirrors saga3/domain/discovery-proposal.ts).
// ---------------------------------------------------------------------------

export type DiscoveryOutcome =
  | 'go'
  | 'clarify'
  | 'reject'
  | 'defer'
  | 'inconclusive'
  | 'failed';

export interface DiscoveryProposalPayload {
  problem_statement: string;
  observed_context: string;
  stakeholders_or_actors: string[];
  assumptions: string[];
  unknowns: string[];
  risks: string[];
  candidate_scope: string;
  evidence_refs: string[];
  recommended_outcome: DiscoveryOutcome;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Readiness assessment (mirrors saga3/domain/discovery-readiness-assessment.ts).
// ---------------------------------------------------------------------------

export type OverallReadiness =
  | 'ready'
  | 'conditionally_ready'
  | 'not_ready'
  | 'inconclusive';

export type RecommendedNextAction =
  | 'proceed_to_settlement'
  | 'request_clarification'
  | 'repeat_discovery'
  | 'defer'
  | 'reject'
  | 'manual_review';

/**
 * The readiness verdict projected into the shadow section of a run result.
 * Read-only visibility — it never feeds back into the authoritative outcome.
 */
export interface ReadinessShadowResult {
  status: 'completed' | 'not_run' | 'failed' | 'paused';
  authority: 'shadow_advisor' | 'none';
  assessmentId: number | null;
  assessmentHash: string | null;
  overallReadiness: OverallReadiness | null;
  recommendedNextAction: RecommendedNextAction | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Diagnosis (mirrors saga3/domain/discovery-diagnosis-report.ts — target type).
// ---------------------------------------------------------------------------

export type DiagnosisDecision = 'go' | 'clarify' | 'reject';

// ---------------------------------------------------------------------------
// Provenance (mirrors saga3/domain/proposal.ts — record shape only).
// ---------------------------------------------------------------------------

export interface ExecutionProvenance {
  model: string | null;
  provider: string;
  effort: string | null;
  worker_id: string;
  execution_id: string;
  submitted_at: string;
}

export interface ProposalProvenance extends ExecutionProvenance {
  normalization_mode?: 'deterministic' | 'lm_transformation';
  source_submission_id?: number;
  normalization_proposal_id?: number;
  normalizer?: ExecutionProvenance;
}

// ---------------------------------------------------------------------------
// D1/D2 normalization records (mirror saga3/domain/discovery-normalization-records.ts).
// ---------------------------------------------------------------------------

export type RawDiscoverySubmissionStatus =
  | 'accepted_deterministically'
  | 'normalization_required'
  | 'rejected_syntax';

export interface RawDiscoverySubmissionRecord {
  id: number;
  intent_id: number;
  task_id: number;
  execution_id: string;
  kind: string;
  schema_version: string;
  raw_payload: string;
  raw_hash: string;
  parsed_payload: unknown | null;
  status: RawDiscoverySubmissionStatus;
  normalization_trace: string[];
  validation_errors: string[];
  alias_conflicts: string[];
  allowed_evidence_refs: string[];
  provenance: ProposalProvenance | null;
  created_at: string;
}

export type ControlIntentStatus =
  | 'open'
  | 'executing'
  | 'paused'
  | 'concluded'
  | 'cancelled';

export interface DiscoveryNormalizationProposalRecord {
  id: number;
  control_intent_id: number;
  source_submission_id: number;
  task_id: number;
  execution_id: string;
  payload: unknown;
  content_hash: string;
  status: 'submitted' | 'accepted_by_kernel' | 'rejected_by_kernel';
  provenance: ProposalProvenance | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// D3 readiness records (mirror saga3/domain/discovery-readiness-records.ts).
// ---------------------------------------------------------------------------

export type ReadinessControlStatus =
  | 'open'
  | 'executing'
  | 'paused'
  | 'concluded'
  | 'cancelled';

export type ReadinessAssessmentStatus =
  | 'submitted'
  | 'accepted_by_kernel'
  | 'rejected_by_kernel';

export interface ReadinessAssessmentRecord {
  id: number;
  control_intent_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  task_id: number;
  execution_id: string;
  payload: unknown;
  content_hash: string;
  status: ReadinessAssessmentStatus;
  overall_readiness: OverallReadiness | null;
  recommended_next_action: RecommendedNextAction | null;
  validation_errors: string[];
  provenance: ProposalProvenance | null;
  created_at: string;
}

export interface ReadinessControlExecution {
  controlIntentId: number;
  proposalId: number;
  proposalContentHash: string;
  controlStatus: ReadinessControlStatus;
  authorityIntentId: number;
  authorityIntentStatus: 'open' | 'executing' | 'paused' | 'concluded' | 'cancelled';
  taskId: number;
}

// ---------------------------------------------------------------------------
// D4 settlement records (mirror saga3/domain/discovery-settlement-records.ts).
// ---------------------------------------------------------------------------

export type SettlementStatus = 'computed' | 'certificate_issued' | 'failed';

export type SettlementDecision = 'go' | 'clarify' | 'reject';

export type DiscoverySettlementReasonCode =
  // GO
  | 'GO_READY_AND_GROUNDED'
  // CLARIFY (fail-closed bucket)
  | 'CLARIFY_WORKER_REQUESTED'
  | 'CLARIFY_READINESS_MISSING'
  | 'CLARIFY_READINESS_FAILED'
  | 'CLARIFY_READINESS_PAUSED'
  | 'CLARIFY_READINESS_INCONCLUSIVE'
  | 'CLARIFY_CONDITIONALLY_READY'
  | 'CLARIFY_BLOCKING_GAPS'
  | 'CLARIFY_EVIDENCE_INSUFFICIENT'
  | 'CLARIFY_LOW_CONFIDENCE'
  | 'CLARIFY_WORKER_ADVISOR_CONFLICT'
  | 'CLARIFY_MANUAL_REVIEW_RECOMMENDED'
  | 'CLARIFY_REPEAT_DISCOVERY_RECOMMENDED'
  | 'CLARIFY_POLICY_FALLBACK'
  // REJECT
  | 'REJECT_WORKER_AND_ADVISOR_AGREE';

export interface SettlementRecord {
  id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  readiness_assessment_id: number | null;
  readiness_assessment_hash: string;
  policy_version: string;
  policy_hash: string;
  input_snapshot: string;
  input_hash: string;
  decision: SettlementDecision;
  reason_codes: DiscoverySettlementReasonCode[];
  rationale: string;
  status: SettlementStatus;
  created_at: string;
}

export interface OutcomeCertificateRecord {
  id: number;
  settlement_id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  readiness_assessment_id: number | null;
  readiness_assessment_hash: string;
  policy_version: string;
  policy_hash: string;
  decision: SettlementDecision;
  reason_codes: DiscoverySettlementReasonCode[];
  input_hash: string;
  certificate_payload: string;
  certificate_hash: string;
  issued_at: string;
}

// ---------------------------------------------------------------------------
// Settlement input key (mirrors saga3-discovery-runtime-port.ts).
// ---------------------------------------------------------------------------

export interface SettlementInputKey {
  proposalId: number;
  proposalContentHash: string;
  readinessTarget: string;
  policyVersion: string;
  policyHash: string;
}

export interface SettlementProposalRecord {
  id: number;
  epic_id: number;
  project_id: number;
  intent_id: number;
  task_id: number;
  execution_id: string;
  kind: string;
  schema_version: string;
  status: string;
  content_hash: string;
  payload: unknown;
  source_submission_id: number | null;
  normalization_proposal_id: number | null;
}

// ---------------------------------------------------------------------------
// WorkIntent + CreateWorkIntent (mirror saga3/domain/work-intent.ts).
// ---------------------------------------------------------------------------

export interface AuthorityScope {
  snapshot_ref: string;
  scope: string;
  allowed_tools: string[];
  enforcement: 'advisory' | 'runtime';
}

export interface WorkIntent {
  id: number;
  epic_id: number;
  kind: string;
  objective: string;
  authority_scope: AuthorityScope;
  output_schema: string;
  token_budget: number;
  retry_budget: number;
  projected_task_id: number | null;
  status: WorkIntentStatus;
  created_at: string;
}

export interface CreateWorkIntent {
  epic_id: number;
  kind: string;
  objective: string;
  authority_scope: AuthorityScope;
  output_schema: string;
  token_budget: number;
  retry_budget: number;
}

export type ProposalStatus = 'submitted' | 'superseded' | 'rejected_by_kernel';

export interface ProposalRecord {
  id: number;
  intent_id: number;
  task_id: number;
  execution_id: string;
  kind: string;
  schema_version: string;
  payload: unknown;
  content_hash: string;
  status: ProposalStatus;
  created_at: string;
  provenance: ProposalProvenance | null;
}

// ---------------------------------------------------------------------------
// Diagnosis records (mirror saga3/domain/discovery-diagnosis-records.ts).
// ---------------------------------------------------------------------------

export type DiagnosisControlStatus =
  | 'open'
  | 'executing'
  | 'paused'
  | 'concluded'
  | 'cancelled';

export type DiagnosisReportStatus =
  | 'submitted'
  | 'accepted_by_kernel'
  | 'rejected_by_kernel';

export interface DiagnosisControlIntentRecord {
  id: number;
  epic_id: number;
  kind: string;
  certificate_id: number;
  certificate_hash: string;
  settlement_input_hash: string;
  diagnosis_case: string;
  diagnosis_case_hash: string;
  diagnosis_contract_version: string;
  authority_intent_id: number;
  projected_task_id: number | null;
  status: DiagnosisControlStatus;
  created_at: string;
  updated_at: string;
}

export interface DiagnosisControlExecution {
  controlIntentId: number;
  certificateId: number;
  certificateHash: string;
  settlementInputHash: string;
  controlStatus: DiagnosisControlStatus;
  authorityIntentId: number;
  authorityIntentStatus: 'open' | 'executing' | 'paused' | 'concluded' | 'cancelled';
  taskId: number;
  diagnosisCase: string;
  diagnosisCaseHash: string;
}

export interface DiagnosisReportRecord {
  id: number;
  control_intent_id: number;
  certificate_id: number;
  certificate_hash: string;
  task_id: number;
  execution_id: string;
  schema_version: string;
  payload: unknown;
  content_hash: string;
  status: DiagnosisReportStatus;
  validation_errors: string[];
  provenance: unknown;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Ensure* input shapes (mirror saga3-discovery-runtime-port.ts).
// ---------------------------------------------------------------------------

export interface EnsureProjectedTask {
  epicId: number;
  projectId: number;
  intentId: number;
  objective: string;
  taskKind: string;
  executionSkill: string;
  reviewSkill?: string | null;
  generationKey: string;
  metadata?: Record<string, unknown>;
  workflowStage?: string;
  executionMode?: string;
  titlePrefix?: string;
  priority?: string;
}

export interface EnsureNodeExecutionPlan {
  intent: CreateWorkIntent;
  task: Omit<EnsureProjectedTask, 'intentId'>;
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

export interface EnsureDiagnosisControl {
  epicId: number;
  projectId: number;
  certificateId: number;
  certificateHash: string;
  settlementId: number;
  settlementInputHash: string;
  sourceIntentId: number;
  objective: string;
  diagnosisCase: string;
  diagnosisCaseHash: string;
  diagnosisContractVersion: string;
}

export interface SubmitDiagnosisReportInput {
  controlIntentId: number;
  executionId: string;
  payload: unknown;
  provenance: unknown;
}

export interface IssueCertificateAtomicallyInput {
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
  expectedCertificateHash: string;
  issuedAt: string;
  inputSnapshotText: string;
  rationale: string;
}

export interface InsertSettlementPort {
  epicId: number;
  key: SettlementInputKey;
  readinessAssessmentId: number | null;
  inputSnapshot: unknown;
  decision: 'go' | 'clarify' | 'reject';
  reasonCodes: string[];
  rationale: string;
}

export type PrepareIntentForExecutionResult =
  | { state: 'ready'; intentStatus: 'open' | 'paused'; taskStatus: string }
  | { state: 'active'; intentStatus: 'executing'; taskStatus: string; detail: string }
  | { state: 'blocked'; intentStatus: 'paused'; taskStatus: 'blocked'; detail: string }
  | { state: 'done'; intentStatus: WorkIntentStatus; taskStatus: 'done' };

export interface ReadinessControlIntentRecord {
  id: number;
  epic_id: number;
  kind: string;
  proposal_id: number;
  proposal_content_hash: string;
  source_intent_id: number;
  authority_intent_id: number;
  projected_task_id: number | null;
  status: ReadinessControlStatus;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// DiscoveryRuntimePersistencePort — the runtime-persistence boundary the
// Discovery Process Module speaks. Structurally compatible with the legacy
// `Saga3DiscoveryRuntimePersistence` (src/saga3/persistence/
// saga3-discovery-runtime-port.ts): the concrete saga3 SQLite adapter satisfies
// this interface, so the composition root can pass it in unchanged.
//
// This port is the module's INWARD-FACING contract (hexagonal). The module
// owns it; the adapter implements it. Previously the module imported the
// interface from saga3 — a cross-tree leak. Now the module owns the port and
// the saga3 layer is allowed to depend inward (it is a legacy inbound adapter).
// ---------------------------------------------------------------------------

export interface DiscoveryRuntimePersistencePort {
  readEpicObjective(epicId: number): { name: string; description: string | null } | null;
  readOpenIntent(epicId: number, kind: string): WorkIntent | null;
  readConcludedIntentWithProposal(epicId: number, kind: string): WorkIntent | null;
  createIntent(command: CreateWorkIntent): WorkIntent;
  ensureNodeExecutionPlan(input: EnsureNodeExecutionPlan): {
    intentId: number;
    taskId: number;
    replayed: boolean;
  };
  setProjectedTask(intentId: number, taskId: number): void;
  bindProjectedTaskProcessContext(input: {
    taskId: number;
    processRunId: number;
    nodeId: string;
    moduleRef: string;
    processInputHash: string;
    nodeInput: unknown;
    nodeInputHash: string;
    projectRepositoryId?: number | null;
    managedReviewBudget?: number | null;
    recoveryFeedback?: unknown;
  }): void;
  setIntentStatus(intentId: number, expected: WorkIntentStatus, next: WorkIntentStatus): boolean;
  ensureProjectedTask(input: EnsureProjectedTask): number;
  readTaskState(taskId: number): string | null;
  readCurrentExecutionId(taskId: number): string | null;
  readLatestExecutionId(taskId: number): string | null;
  readLatestManagedProductionExecutionId(
    taskId: number,
    processRunId: number,
    nodeId: string,
  ): string | null;
  readTaskProjectRepositoryId(taskId: number): number | null;
  prepareIntentForExecution(intentId: number, taskId: number): PrepareIntentForExecutionResult;
  readWorkIntentForTask(taskId: number): WorkIntent | null;
  readLatestProposal(intentId: number): ProposalRecord | null;
  readProposalForExecution(intentId: number, taskId: number, executionId: string): ProposalRecord | null;
  readLatestProposalByEpic(epicId: number): ProposalRecord | null;
  readLatestAcceptedReadinessForEpic(epicId: number): {
    assessment_id: number;
    content_hash: string;
    payload: unknown;
  } | null;
  readLatestRawSubmission(intentId: number): RawDiscoverySubmissionRecord | null;
  readRawSubmission(submissionId: number): RawDiscoverySubmissionRecord | null;
  readRawSubmissionForExecution(
    intentId: number,
    taskId: number,
    executionId: string,
  ): RawDiscoverySubmissionRecord | null;
  ensureNormalizationControl(input: EnsureNormalizationControl): NormalizationControlExecution;
  readLatestNormalizationProposal(controlIntentId: number): DiscoveryNormalizationProposalRecord | null;
  readNormalizationProposalForExecution(
    controlIntentId: number,
    taskId: number,
    executionId: string,
  ): DiscoveryNormalizationProposalRecord | null;
  setControlIntentStatus(controlIntentId: number, expected: ControlIntentStatus, next: ControlIntentStatus): boolean;
  ensureReadinessControl(input: EnsureReadinessControl): ReadinessControlExecution;
  setReadinessControlStatus(controlIntentId: number, expected: ReadinessControlStatus, next: ReadinessControlStatus): boolean;
  readLatestReadinessAssessment(controlIntentId: number): ReadinessAssessmentRecord | null;
  readReadinessAssessmentForExecution(
    controlIntentId: number,
    taskId: number,
    executionId: string,
  ): ReadinessAssessmentRecord | null;
  readReadinessControlForProposal(proposalId: number, proposalContentHash: string): ReadinessControlIntentRecord | null;
  readWorkIntent(intentId: number): WorkIntent | null;
  readProposalForSettlement(proposalId: number): SettlementProposalRecord | null;
  readReadinessAssessment(assessmentId: number): ReadinessAssessmentRecord | null;
  findSettlementByInputKey(key: SettlementInputKey): SettlementRecord | null;
  insertSettlement(input: InsertSettlementPort): { record: SettlementRecord; replayed: boolean };
  markSettlementFailed(settlementId: number): void;
  readCertificateForSettlement(settlementId: number): OutcomeCertificateRecord | null;
  readOutcomeCertificate(certificateId: number): OutcomeCertificateRecord | null;
  readSettlement(settlementId: number): SettlementRecord | null;
  issueCertificateAtomically(input: IssueCertificateAtomicallyInput): {
    record: OutcomeCertificateRecord;
    inserted: boolean;
  };
  reconcileExistingCertificate(input: IssueCertificateAtomicallyInput): OutcomeCertificateRecord;
  ensureDiagnosisControl(input: EnsureDiagnosisControl): DiagnosisControlExecution;
  setDiagnosisControlStatus(controlIntentId: number, expected: DiagnosisControlStatus, next: DiagnosisControlStatus): boolean;
  readDiagnosisControlForTarget(certificateId: number, certificateHash: string): DiagnosisControlIntentRecord | null;
  readDiagnosisControl(controlIntentId: number): DiagnosisControlIntentRecord | null;
  readAcceptedDiagnosisReport(controlIntentId: number): DiagnosisReportRecord | null;
  readLatestDiagnosisReport(controlIntentId: number): DiagnosisReportRecord | null;
  submitDiagnosisReportAtomically(input: SubmitDiagnosisReportInput): {
    record: DiagnosisReportRecord;
    inserted: boolean;
    replayed: boolean;
  };
}

// ---------------------------------------------------------------------------
// DiscoverySettlementPort — the application-layer settlement service contract.
//
// The discovery module's settlement handler needs to run the deterministic D4
// settlement policy + issue the authoritative certificate. That logic lives in
// the legacy saga3 application layer (`Saga3DiscoverySettlementService`). The
// module declares THIS port; the composition root injects a concrete
// implementation (today the saga3 service). When `settlementService` is omitted
// from DiscoveryInstallationDeps, the module falls back to a lazy legacy
// bridge (see discovery-installation.ts) so existing callers that only pass
// `runtimePersistence` keep working.
// ---------------------------------------------------------------------------

export interface SettleRequest {
  projectId: number;
  epicId: number;
  proposalId: number;
  proposalHash: string;
  readiness: ReadinessShadowResult;
}

export type DiscoverySettlementResult =
  | {
      status: 'issued';
      settlementId: number;
      certificateId: number;
      certificateHash: string;
      policyVersion: string;
      policyHash: string;
      decision: 'go' | 'clarify' | 'reject';
      reasonCodes: DiscoverySettlementReasonCode[];
      error: null;
    }
  | {
      status: 'failed';
      settlementId: number | null;
      certificateId: null;
      certificateHash: null;
      policyVersion: null;
      policyHash: null;
      decision: null;
      reasonCodes: DiscoverySettlementReasonCode[];
      error: string;
    };

export interface DiscoverySettlementPort {
  settle(request: SettleRequest): Promise<DiscoverySettlementResult>;
}
