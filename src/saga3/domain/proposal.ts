/**
 * Proposal — a typed, non-authoritative output of an LM product-worker
 * execution against a WorkIntent.
 *
 * Roadmap §7.3 + §6.4 settlement. The worker submits ONLY the semantic payload;
 * the infrastructure (proposal_submit handler) records runtime provenance
 * automatically. The worker must never hand-author provenance.
 */

export type ProposalStatus = 'submitted' | 'superseded' | 'rejected_by_kernel';

export interface Proposal {
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
}

/** Runtime provenance captured automatically from the immutable execution
 * context. D2 adds optional transformation lineage for proposals produced by a
 * normalization control worker; product workers never populate these fields. */
export interface ProposalProvenance {
  model: string | null;
  provider: string;
  effort: string | null;
  worker_id: string;
  execution_id: string;
  submitted_at: string;
  normalization_mode?: 'deterministic' | 'lm_transformation';
  source_submission_id?: number;
  normalization_proposal_id?: number;
}

export interface SubmitProposal {
  intent_id: number;
  task_id: number;
  execution_id: string;
  kind: string;
  schema_version: string;
  payload: unknown;
}

export interface SubmittedProposalResult {
  proposal_id: number;
  content_hash: string;
  status: ProposalStatus;
}

export interface ProposalRecord extends Proposal {
  provenance: ProposalProvenance | null;
}
