/**
 * Durable record types for the D5 advisory diagnosis layer.
 *
 * These mirror the D3 readiness-records + D4 settlement-records shape (roadmap
 * D5 persistence): a control intent binds an immutable certificate TARGET
 * (certificate_id + certificate_hash + diagnosis contract version) to a bounded
 * diagnosis worker task; a report row retains the worker's typed payload,
 * content hash, status, and separate provenance. The diagnosis is ADVISORY — it
 * never mutates the D4 settlement, certificate, proposal, or readiness rows
 * (invariant I6). Provenance lineages are separate: a diagnosis execution
 * identity never lands in a product Proposal row.
 */

/**
 * Lifecycle of a DiagnoseDiscoveryOutcome ControlIntent. Mirrors the D3 state
 * machine: open → executing → concluded on clean completion; interruption/
 * timeout → paused; restart reuses the same row (invariant I7).
 */
export type DiagnosisControlStatus =
  | 'open'
  | 'executing'
  | 'paused'
  | 'concluded'
  | 'cancelled';

/**
 * Lifecycle of a diagnosis report row. The worker PROPOSES a submission; only
 * the deterministic kernel may mark it accepted_by_kernel (after validation).
 * rejected_by_kernel records an invalid attempt without overwriting any
 * previously accepted report (invariants I4, I5, §14).
 */
export type DiagnosisReportStatus =
  | 'submitted'
  | 'accepted_by_kernel'
  | 'rejected_by_kernel';

/** Durable control intent row for one immutable certificate target. */
export interface DiagnosisControlIntentRecord {
  id: number;
  epic_id: number;
  kind: string; // 'DiagnoseDiscoveryOutcome'
  certificate_id: number;
  certificate_hash: string;
  settlement_input_hash: string;
  diagnosis_case: string; // canonical JSON of the immutable DiagnosisCase
  diagnosis_case_hash: string; // SHA-256 over the case (captured_at excluded)
  diagnosis_contract_version: string; // saga3.discovery-diagnosis.v1
  authority_intent_id: number;
  projected_task_id: number | null;
  status: DiagnosisControlStatus;
  created_at: string;
  updated_at: string;
}

/** What the engine/service sees when ensuring a diagnosis control intent. */
export interface DiagnosisControlExecution {
  controlIntentId: number;
  certificateId: number;
  certificateHash: string;
  settlementInputHash: string;
  controlStatus: DiagnosisControlStatus;
  authorityIntentId: number;
  authorityIntentStatus: 'open' | 'executing' | 'paused' | 'concluded' | 'cancelled';
  taskId: number;
  diagnosisCase: string; // canonical JSON text (the immutable case)
  diagnosisCaseHash: string;
}

/** Durable report row. */
export interface DiagnosisReportRecord {
  id: number;
  control_intent_id: number;
  certificate_id: number;
  certificate_hash: string;
  task_id: number;
  execution_id: string;
  schema_version: string;
  payload: unknown; // parsed DiscoveryDiagnosisPayload
  content_hash: string; // hashDiagnosisReport(payload)
  status: DiagnosisReportStatus;
  validation_errors: string[]; // durable rejection reasons when rejected_by_kernel
  provenance: unknown; // worker execution provenance
  created_at: string;
}
