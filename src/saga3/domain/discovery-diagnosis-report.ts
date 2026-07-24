/**
 * DiscoveryDiagnosisReport — the typed payload a D5 diagnosis LM worker emits
 * against a DiagnoseDiscoveryOutcome ControlIntent.
 *
 * Roadmap D5, §6. This is the SEMANTIC payload only: provenance is added by the
 * kernel, never by the worker. The report EXPLAINS an already-issued
 * DiscoveryOutcomeCertificate; it MUST NOT override the decision, the stage, or
 * any authoritative field (invariants I1, I2).
 *
 * The forbidden-fields contract (§6) is enforced by the validator: any payload
 * carrying one of `new_outcome`, `override_decision`, `approved`, `settled`,
 * `transition_stage`, or `new_certificate` is rejected outright — those field
 * names are authority-shaped and have no place in an advisory diagnosis.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../shared/discovery-canonical.js';
import type { DiagnosisDecision } from './discovery-diagnosis-case.js';

/** Schema version for the diagnosis report payload (D5 §6). */
export const DISCOVERY_DIAGNOSIS_REPORT_SCHEMA = 'saga3.discovery-diagnosis.v1';

/**
 * Field names a diagnosis payload is FORBIDDEN from carrying. Each is
 * authority-shaped: an advisory layer must never express a new outcome, a
 * decision override, an approval, a settlement, a stage transition, or a new
 * certificate. The validator rejects any payload that contains one (B14).
 */
export const FORBIDDEN_DIAGNOSIS_FIELDS: readonly string[] = [
  'new_outcome',
  'override_decision',
  'approved',
  'settled',
  'transition_stage',
  'new_certificate',
] as const;

/** Cause category (§6). */
export type DiagnosisCauseCategory =
  | 'missing_evidence'
  | 'blocking_gap'
  | 'conflicting_assessment'
  | 'low_confidence'
  | 'scope_problem'
  | 'unresolved_unknown'
  | 'policy_condition'
  | 'residual_risk';

export const DIAGNOSIS_CAUSE_CATEGORIES: readonly DiagnosisCauseCategory[] = [
  'missing_evidence', 'blocking_gap', 'conflicting_assessment', 'low_confidence',
  'scope_problem', 'unresolved_unknown', 'policy_condition', 'residual_risk',
] as const;

/** Cause severity (§6). */
export type DiagnosisSeverity = 'blocking' | 'material' | 'informational';

export const DIAGNOSIS_SEVERITIES: readonly DiagnosisSeverity[] = [
  'blocking', 'material', 'informational',
] as const;

/** Recommended action verb (§6). The diagnosis PROPOSES; it never DOES. */
export type DiagnosisAction =
  | 'collect_information'
  | 'resolve_conflict'
  | 'revise_scope'
  | 'repeat_discovery'
  | 'request_human_decision'
  | 'proceed_with_monitoring';

export const DIAGNOSIS_ACTIONS: readonly DiagnosisAction[] = [
  'collect_information', 'resolve_conflict', 'revise_scope', 'repeat_discovery',
  'request_human_decision', 'proceed_with_monitoring',
] as const;

/** The certificate target the report explains (must match the case exactly). */
export interface DiagnosisReportTarget {
  certificate_id: number;
  certificate_hash: string;
  settlement_input_hash: string;
  decision: DiagnosisDecision;
}

/**
 * A cause the diagnosis identified (§6 cause_analysis).
 *
 * `cited_condition_ids` are the trace condition_ids this cause explains. A cause
 * may cite PASSED conditions (GO/REJECT grounds — the decision is explained by
 * the supporting conditions that held) OR FAILED conditions (CLARIFY grounds —
 * the blocking conditions that prevented GO/REJECT). The validator decides, per
 * the diagnosed decision, whether the cited conditions are valid grounds. Every
 * cited id MUST exist in `case.policy_trace` AND have
 * `contributed_to_decision === true`.
 */
export interface DiagnosisCause {
  cause_id: string;
  category: DiagnosisCauseCategory;
  description: string;
  severity: DiagnosisSeverity;
  reason_codes: string[];
  cited_condition_ids: string[];
  source_refs: string[];
}

/** An information request that would resolve one or more causes (§6). */
export interface DiagnosisInformationRequest {
  request_id: string;
  question: string;
  resolves_cause_ids: string[];
  source_refs: string[];
}

/** A recommended next action (§6). Advisory only (I6). */
export interface DiagnosisRecommendedAction {
  action_id: string;
  action: DiagnosisAction;
  description: string;
  resolves_cause_ids: string[];
  source_refs: string[];
}

/** A residual risk that remains even under a GO decision (§6). */
export interface DiagnosisResidualRisk {
  risk: string;
  source_refs: string[];
}

/**
 * The typed diagnosis report payload. The worker PROPOSES this; only the kernel
 * may accept it (after validation). Provenance is added separately by the
 * kernel.
 */
export interface DiscoveryDiagnosisPayload {
  schema_version: typeof DISCOVERY_DIAGNOSIS_REPORT_SCHEMA;
  target: DiagnosisReportTarget;
  executive_summary: string;
  cause_analysis: DiagnosisCause[];
  information_requests: DiagnosisInformationRequest[];
  recommended_actions: DiagnosisRecommendedAction[];
  residual_risks: DiagnosisResidualRisk[];
  confidence: number;
}

/**
 * Deterministic SHA-256 over the canonical JSON of the report payload. The
 * idempotency key for a diagnosis report is (control_intent_id, content_hash);
 * two byte-identical reports under different executions collapse to one row
 * (invariant I7).
 */
export function hashDiagnosisReport(payload: DiscoveryDiagnosisPayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
