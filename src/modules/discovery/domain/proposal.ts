/**
 * Proposal — a typed, non-authoritative output of an LM product-worker
 * execution against a WorkIntent.
 *
 * Roadmap §7.3 + §6.4 settlement. The worker submits ONLY the semantic payload;
 * the infrastructure records runtime provenance automatically. The worker must
 * never hand-author provenance.
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

/** One immutable execution identity captured by the kernel. */
export interface ExecutionProvenance {
  model: string | null;
  provider: string;
  effort: string | null;
  worker_id: string;
  execution_id: string;
  submitted_at: string;
}

/**
 * Provenance of the product Proposal.
 *
 * For an LM-normalized Proposal the top-level identity remains the ORIGINAL
 * product-worker execution that owns Proposal.task_id. Transformation lineage
 * is additive: `normalizer` identifies the separate control execution and
 * `normalization_proposal_id` links its non-authoritative transform proposal.
 * This preserves the invariant Proposal.task_id ↔ Proposal.execution_id.
 */
export interface ProposalProvenance extends ExecutionProvenance {
  normalization_mode?: 'deterministic' | 'lm_transformation';
  source_submission_id?: number;
  normalization_proposal_id?: number;
  normalizer?: ExecutionProvenance;
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
