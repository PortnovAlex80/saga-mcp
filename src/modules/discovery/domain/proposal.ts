/**
 * Proposal — a typed, non-authoritative output of one product-worker execution
 * against a WorkIntent.
 *
 * The worker submits semantic payload only. Infrastructure records truthful
 * runtime provenance automatically; a replay-backed execution must never be
 * journaled as though the selected inference route actually produced bytes.
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
  /** Actual inference model that produced the payload; null for replay. */
  model: string | null;
  /** Actual inference provider that produced the payload; null for replay. */
  provider: string | null;
  /** Actual inference effort; null for replay. */
  effort: string | null;
  worker_id: string;
  execution_id: string;
  submitted_at: string;
  /** Physical source of worker production. Not a Factory mode. */
  production_source?: 'inference' | 'replay';
  /** Exact certified capsule used when production_source='replay'. */
  capsule_ref?: string | null;
}

/**
 * Provenance of the product Proposal.
 *
 * For an LM-normalized Proposal the top-level identity remains the ORIGINAL
 * product-worker execution that owns Proposal.task_id. Transformation lineage
 * is additive: `normalizer` identifies the separate control execution and
 * `normalization_proposal_id` links its non-authoritative transform proposal.
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
