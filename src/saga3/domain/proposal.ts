/**
 * Proposal — a typed, non-authoritative output of an LM product-worker
 * execution against a WorkIntent.
 *
 * Roadmap §7.3 + §6.4 settlement. The worker submits ONLY the semantic payload;
 * the infrastructure (proposal_submit handler) records runtime provenance
 * (model, provider, effort, worker identity, execution identity, snapshot hash,
 * timestamps, terminal execution status) automatically. The worker must never
 * hand-author provenance.
 *
 * Proposals are Saga 3 protocol entities — they live in saga3_proposals, NOT in
 * the existing artifacts table. The `kind` + `schema_version` discriminate the
 * payload shape; in D1 only kind='discovery' is supported, but the envelope is
 * generic so later stages reuse the same table.
 */

export type ProposalStatus = 'submitted' | 'superseded' | 'rejected_by_kernel';

/**
 * Generic Proposal envelope stored in saga3_proposals. `payload` is the
 * worker-supplied semantic content as a parsed object; the repository also
 * keeps the raw JSON string for content-hash reproducibility.
 */
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

/** Runtime provenance captured automatically by proposal_submit. The worker
 * never supplies these — they are read from the worker_executions fence and the
 * model route. Kept on the proposal row's metadata so the settlement policy
 * (D4) and certificate (D4) can cite it. */
export interface ProposalProvenance {
  model: string | null;
  provider: string;
  effort: string | null;
  worker_id: string;
  execution_id: string;
  submitted_at: string;
}

/** Fields the proposal_submit handler receives from the worker. */
export interface SubmitProposal {
  intent_id: number;
  task_id: number;
  execution_id: string;
  kind: string;
  schema_version: string;
  payload: unknown;
}

/** Result returned by proposal_submit to the worker. */
export interface SubmittedProposalResult {
  proposal_id: number;
  content_hash: string;
  status: ProposalStatus;
}

/**
 * A validated Proposal with its provenance and the WorkIntent it answers.
 * Returned by the repository read path so the engine and (later) settlement
 * have everything they need without re-querying.
 */
export interface ProposalRecord extends Proposal {
  provenance: ProposalProvenance | null;
}
