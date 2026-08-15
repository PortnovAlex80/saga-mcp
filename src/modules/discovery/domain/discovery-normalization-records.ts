import type { ProposalProvenance } from './proposal.js';

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

export interface DiscoveryNormalizationControlProjection {
  control_intent_id: number;
  authority_intent_id: number;
  authority_intent_status: 'open' | 'executing' | 'paused' | 'concluded' | 'cancelled';
  task_id: number;
  task_status: string;
  source_submission_id: number;
  status: ControlIntentStatus;
}

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
