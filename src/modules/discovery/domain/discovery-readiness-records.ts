/**
 * Durable record types for the D3 readiness advisor.
 *
 * These mirror the D2 normalization record shape (roadmap D3 persistence):
 * a control intent binds an immutable Proposal version to a bounded advisor
 * task; an assessment row retains the advisor's typed payload, content hash,
 * status, and separate provenance. The product Proposal provenance and the
 * readiness-advisor provenance are SEPARATE lineages — an advisor execution
 * identity never lands in a product Proposal row.
 */
import type { ProposalProvenance } from './proposal.js';
import type {
  OverallReadiness,
  RecommendedNextAction,
} from './discovery-readiness-assessment.js';

/**
 * Lifecycle of an AssessDiscoveryReadiness ControlIntent. Mirrors the D2
 * control-intent state machine: open → executing → concluded on clean
 * completion; interruption/timeout → paused; restart reuses the same row.
 */
export type ReadinessControlStatus =
  | 'open'
  | 'executing'
  | 'paused'
  | 'concluded'
  | 'cancelled';

/**
 * Lifecycle of a readiness assessment row. The advisor PROPOSES a submission;
 * only the deterministic kernel may mark it accepted_by_kernel (after
 * validation). rejected_by_kernel records an invalid attempt without
 * overwriting any previously accepted assessment.
 */
export type ReadinessAssessmentStatus =
  | 'submitted'
  | 'accepted_by_kernel'
  | 'rejected_by_kernel';

/** Durable control intent row for one immutable Proposal version. */
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

/** What the engine/app sees when ensuring a readiness control intent. */
export interface ReadinessControlExecution {
  controlIntentId: number;
  proposalId: number;
  proposalContentHash: string;
  controlStatus: ReadinessControlStatus;
  authorityIntentId: number;
  authorityIntentStatus: 'open' | 'executing' | 'paused' | 'concluded' | 'cancelled';
  taskId: number;
}

/** Durable assessment row. */
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
  /** Durable rejection reasons when status='rejected_by_kernel' (P0). */
  validation_errors: string[];
  provenance: ProposalProvenance | null;
  created_at: string;
}
